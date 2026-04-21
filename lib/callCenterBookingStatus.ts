import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebaseAdmin";
import {
  verifyCallCenterOrTenantAdminAuth,
  canAccessWorkshopForAuth,
  CORS_HEADERS,
} from "@/lib/callCenterAuth";
import {
  canTransitionStatus,
  normalizeBookingStatus,
  type BookingStatus,
} from "@/lib/bookingTypes";
import { logBookingStatusChangedServer } from "@/lib/auditLogServer";
import {
  createCustomerConfirmationNotification,
  createCustomerCancellationNotification,
  createNotification,
  getNotificationContent,
  notifyOwnerBookingCompletedOnce,
} from "@/lib/notifications";
import { sendBookingStatusChangeEmail } from "@/lib/emailService";

/** Action verbs exposed to the call-center API. */
export type CallCenterBookingAction = "confirm" | "cancel" | "complete";

const ACTION_TO_STATUS: Record<CallCenterBookingAction, BookingStatus> = {
  confirm: "Confirmed",
  cancel: "Canceled",
  complete: "Completed",
};

function activityTypeForStatus(status: BookingStatus): string {
  switch (status) {
    case "Confirmed":
      return "booking_confirmed";
    case "Canceled":
      return "booking_cancelled";
    case "Completed":
      return "booking_completed";
    default:
      return "booking_updated";
  }
}

function taskCompletionSummary(data: unknown): {
  total: number;
  completed: number;
  incomplete: number;
} {
  const tasks = Array.isArray((data as { tasks?: unknown }).tasks)
    ? ((data as { tasks: unknown[] }).tasks as unknown[])
    : [];
  if (tasks.length === 0) return { total: 0, completed: 0, incomplete: 0 };
  const completed = tasks.filter((t) => {
    if (!t || typeof t !== "object") return false;
    const r = t as Record<string, unknown>;
    if (r.done === true) return true;
    const s = String(r.status ?? r.completionStatus ?? "").toLowerCase();
    return s === "completed" || s === "done";
  }).length;
  return { total: tasks.length, completed, incomplete: Math.max(tasks.length - completed, 0) };
}

/**
 * Resolve a bookings-collection doc by either Firestore id or human
 * `bookingCode` (e.g. `BK-2026-032612-2452` / `CC-XXXXXX`).
 */
async function findBookingByIdOrCode(
  db: FirebaseFirestore.Firestore,
  segment: string
): Promise<FirebaseFirestore.DocumentSnapshot | null> {
  const direct = await db.doc(`bookings/${segment}`).get();
  if (direct.exists) return direct;
  const byCode = await db
    .collection("bookings")
    .where("bookingCode", "==", segment)
    .limit(2)
    .get();
  if (byCode.empty) return null;
  if (byCode.size > 1) {
    throw new Error("DUPLICATE_BOOKING_CODE");
  }
  return byCode.docs[0];
}

/** Shared implementation for `POST /api/call-center/bookings/[id]/{confirm,cancel,complete}`. */
export async function handleCallCenterBookingStatusChange(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
  action: CallCenterBookingAction
): Promise<NextResponse> {
  const gate = await verifyCallCenterOrTenantAdminAuth(req);
  if (!gate.success) {
    return NextResponse.json(
      { error: gate.error },
      { status: gate.status || 401, headers: CORS_HEADERS }
    );
  }

  const { id: rawId } = await context.params;
  const segment = decodeURIComponent(rawId || "").trim();
  if (!segment) {
    return NextResponse.json(
      { error: "Missing booking id" },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  const body = (await req
    .json()
    .catch(() => ({}))) as { reason?: string; forceComplete?: boolean };

  const db = adminDb();

  let bookingSnap: FirebaseFirestore.DocumentSnapshot | null;
  try {
    bookingSnap = await findBookingByIdOrCode(db, segment);
  } catch (e) {
    if (e instanceof Error && e.message === "DUPLICATE_BOOKING_CODE") {
      return NextResponse.json(
        { error: "Multiple bookings match this booking code" },
        { status: 409, headers: CORS_HEADERS }
      );
    }
    throw e;
  }

  if (!bookingSnap || !bookingSnap.exists) {
    return NextResponse.json(
      { error: "Booking not found" },
      { status: 404, headers: CORS_HEADERS }
    );
  }

  const bookingId = bookingSnap.id;
  const data = bookingSnap.data() as Record<string, unknown>;

  const ownerUid = String(data.ownerUid ?? "").trim();
  if (!ownerUid) {
    return NextResponse.json(
      { error: "Booking is missing owner information" },
      { status: 422, headers: CORS_HEADERS }
    );
  }

  if (!canAccessWorkshopForAuth(gate.auth, ownerUid)) {
    return NextResponse.json(
      { error: "Access denied for this workshop" },
      { status: 403, headers: CORS_HEADERS }
    );
  }

  const currentStatus = normalizeBookingStatus(
    (data.status as string | undefined) ?? "Pending"
  );
  const nextStatus = ACTION_TO_STATUS[action];

  if (currentStatus === nextStatus) {
    return NextResponse.json(
      {
        error: `Booking is already ${nextStatus}`,
        currentStatus,
      },
      { status: 409, headers: CORS_HEADERS }
    );
  }

  if (!canTransitionStatus(currentStatus, nextStatus)) {
    return NextResponse.json(
      {
        error: `Cannot ${action} a booking that is currently ${currentStatus}`,
        currentStatus,
        targetStatus: nextStatus,
      },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  // Completion guard: require every task done unless forceComplete is set,
  // and block while additional-issue decisions are still outstanding.
  if (action === "complete") {
    const ts = taskCompletionSummary(data);
    if (ts.total > 0 && ts.incomplete > 0 && !body.forceComplete) {
      return NextResponse.json(
        {
          error: "Cannot complete booking until all tasks are marked done.",
          details: {
            completedTasks: ts.completed,
            totalTasks: ts.total,
            remainingTasks: ts.incomplete,
          },
          hint: "Re-send with { \"forceComplete\": true } to override.",
        },
        { status: 400, headers: CORS_HEADERS }
      );
    }
    const issues = Array.isArray(data.additionalIssues)
      ? (data.additionalIssues as Record<string, unknown>[])
      : [];
    const pendingAdmin = issues.filter((i) => (i.status || "pending") === "pending");
    const pendingCustomer = issues.filter(
      (i) => i.status === "approved" && !i.customerResponse
    );
    if (pendingAdmin.length > 0 || pendingCustomer.length > 0) {
      return NextResponse.json(
        {
          error: "Cannot complete booking while additional work requests are pending.",
          details: {
            pendingAdminDecision: pendingAdmin.length,
            pendingCustomerDecision: pendingCustomer.length,
          },
        },
        { status: 400, headers: CORS_HEADERS }
      );
    }
  }

  // Build update payload.
  const updateData: Record<string, unknown> = {
    status: nextStatus,
    updatedAt: FieldValue.serverTimestamp(),
  };

  const performerUid =
    gate.auth.kind === "agent" ? gate.auth.user.uid : gate.auth.uid;
  const performerName =
    gate.auth.kind === "agent"
      ? gate.auth.user.name || "Call Center Agent"
      : gate.auth.name || "BMS Staff";
  const performerRole =
    gate.auth.kind === "agent"
      ? gate.auth.user.role || "agent"
      : gate.auth.role;

  if (action === "confirm") {
    // Owner/admin authority — mark every service as accepted so the booking
    // flows into the Confirmed lane cleanly without staff approval round-trips.
    const services = Array.isArray(data.services)
      ? (data.services as Record<string, unknown>[])
      : [];
    updateData.services = services.map((s) => ({
      ...s,
      approvalStatus: "accepted",
    }));
    updateData.confirmedBy = performerUid;
    updateData.confirmedByName = performerName;
    updateData.confirmedByRole = performerRole;
    updateData.confirmedAt = FieldValue.serverTimestamp();
    updateData.confirmedVia = "call_center";
  } else if (action === "cancel") {
    updateData.canceledBy = performerUid;
    updateData.canceledByName = performerName;
    updateData.canceledByRole = performerRole;
    updateData.canceledAt = FieldValue.serverTimestamp();
    updateData.canceledVia = "call_center";
    if (typeof body.reason === "string" && body.reason.trim()) {
      updateData.cancelReason = body.reason.trim();
    }
  } else if (action === "complete") {
    // Recalculate total to include accepted additional-issue prices.
    const services = Array.isArray(data.services)
      ? (data.services as Record<string, unknown>[])
      : [];
    const servicesSubtotal =
      services.length > 0
        ? services.reduce((sum, s) => sum + (Number(s.price) || 0), 0)
        : Number(data.price) || 0;
    const acceptedIssues = (
      Array.isArray(data.additionalIssues)
        ? (data.additionalIssues as Record<string, unknown>[])
        : []
    ).filter(
      (i) =>
        i.status === "approved" &&
        i.price != null &&
        (i.customerResponse === "accept" || i.customerResponse === "accepted")
    );
    const additionalTotal = acceptedIssues.reduce(
      (sum, i) => sum + (Number(i.price) || 0),
      0
    );
    if (additionalTotal > 0) updateData.price = servicesSubtotal + additionalTotal;
    updateData.completedBy = performerUid;
    updateData.completedByName = performerName;
    updateData.completedByRole = performerRole;
    updateData.completedAt = FieldValue.serverTimestamp();
    updateData.completedVia = "call_center";
  }

  await db.doc(`bookings/${bookingId}`).update(updateData);

  // Activity log (same shape used by the workshop admin panel).
  try {
    await db.collection("bookingActivities").add({
      ownerUid,
      bookingId,
      bookingCode: data.bookingCode || null,
      activityType: activityTypeForStatus(nextStatus),
      clientName: data.client || data.clientName || "Unknown",
      serviceName: data.serviceName || null,
      branchName: data.branchName || null,
      staffName: data.staffName || null,
      price: data.price || null,
      date: data.date || null,
      time: data.time || null,
      previousStatus: currentStatus,
      newStatus: nextStatus,
      performedBy: performerUid,
      performedByName: performerName,
      performedByRole: performerRole,
      source: "call_center",
      createdAt: FieldValue.serverTimestamp(),
      ...(action === "cancel" && typeof body.reason === "string" && body.reason.trim()
        ? { cancelReason: body.reason.trim() }
        : {}),
    });
  } catch (e) {
    console.error("[call-center/status] bookingActivities write failed:", e);
  }

  // Audit log.
  try {
    await logBookingStatusChangedServer(
      ownerUid,
      bookingId,
      (data.bookingCode as string | undefined) || undefined,
      String(data.client || data.clientName || "Customer"),
      currentStatus,
      nextStatus,
      { uid: performerUid, name: performerName, role: performerRole },
      action === "cancel" && body.reason ? `Cancel reason: ${body.reason}` : undefined,
      (data.branchName as string | undefined) || undefined
    );
  } catch (e) {
    console.error("[call-center/status] audit log failed:", e);
  }

  // Customer notifications + email (same paths the in-app flows use).
  try {
    const clientName = String(data.client || data.clientName || "Customer");
    const services = Array.isArray(data.services)
      ? (data.services as Record<string, unknown>[])
      : [];
    const staffName =
      (data.staffName as string | undefined) ||
      (services.find((s) => s.staffName)?.staffName as string | undefined) ||
      null;

    if (nextStatus === "Confirmed") {
      await createCustomerConfirmationNotification({
        bookingId,
        bookingCode: data.bookingCode as string | undefined,
        customerUid: data.customerUid as string | undefined,
        customerEmail: data.clientEmail as string | undefined,
        customerPhone: data.clientPhone as string | undefined,
        clientName,
        staffName: staffName || undefined,
        serviceName: data.serviceName as string | undefined,
        services: services.map((s) => ({
          name: (s.name as string) || "Service",
          staffName: (s.staffName as string | undefined) || undefined,
        })),
        branchName: data.branchName as string | undefined,
        bookingDate: data.date as string | undefined,
        bookingTime: data.time as string | undefined,
        ownerUid,
      });
    } else if (nextStatus === "Canceled") {
      await createCustomerCancellationNotification({
        bookingId,
        bookingCode: data.bookingCode as string | undefined,
        customerUid: data.customerUid as string | undefined,
        customerEmail: data.clientEmail as string | undefined,
        customerPhone: data.clientPhone as string | undefined,
        clientName,
        staffName: staffName || undefined,
        serviceName: data.serviceName as string | undefined,
        services: services.map((s) => ({
          name: (s.name as string) || "Service",
          staffName: (s.staffName as string) || "Not Assigned Yet",
        })),
        branchName: data.branchName as string | undefined,
        bookingDate: data.date as string | undefined,
        bookingTime: data.time as string | undefined,
        ownerUid,
      });
    } else if (nextStatus === "Completed") {
      const nc = getNotificationContent(
        nextStatus,
        data.bookingCode as string | undefined,
        staffName || undefined,
        data.serviceName as string | undefined,
        data.date as string | undefined,
        data.time as string | undefined,
        services.map((s) => ({
          name: (s.name as string) || "Service",
          staffName: (s.staffName as string) || "Not Assigned Yet",
        }))
      );
      await createNotification({
        bookingId,
        type: nc.type,
        title: nc.title,
        message: nc.message,
        status: nextStatus,
        ownerUid,
        ...(data.customerUid ? { customerUid: data.customerUid as string } : {}),
        ...(data.clientEmail ? { customerEmail: data.clientEmail as string } : {}),
        ...(data.clientPhone ? { customerPhone: data.clientPhone as string } : {}),
        ...(data.bookingCode ? { bookingCode: data.bookingCode as string } : {}),
        clientName,
        ...(staffName ? { staffName } : {}),
        ...(data.serviceName ? { serviceName: data.serviceName as string } : {}),
        ...(data.branchName ? { branchName: data.branchName as string } : {}),
        ...(data.date ? { bookingDate: data.date as string } : {}),
        ...(data.time ? { bookingTime: data.time as string } : {}),
        services: services.map((s) => ({
          name: (s.name as string) || "Service",
          staffName: (s.staffName as string) || "Not Assigned Yet",
        })),
      });
      await notifyOwnerBookingCompletedOnce({
        bookingId,
        bookingCode: data.bookingCode as string | undefined,
        ownerUid,
        staffName: staffName || undefined,
        clientName,
        serviceName: data.serviceName as string | undefined,
        branchName: data.branchName as string | undefined,
        bookingDate: data.date as string | undefined,
        bookingTime: data.time as string | undefined,
      });
    }

    try {
      await sendBookingStatusChangeEmail(
        bookingId,
        nextStatus,
        (data.clientEmail as string | undefined) || undefined,
        clientName,
        ownerUid,
        {
          bookingCode: data.bookingCode as string | undefined,
          branchName: data.branchName as string | undefined,
          bookingDate: data.date as string | undefined,
          bookingTime: data.time as string | undefined,
          duration: data.duration as number | undefined,
          price: data.price as number | undefined,
          serviceName: data.serviceName as string | undefined,
          services: services.map((s) => ({
            name: (s.name as string) || "Service",
            staffName: (s.staffName as string | undefined) || null,
            time: (s.time as string | undefined) || (data.time as string | undefined) || null,
            duration:
              (s.duration as number | undefined) ||
              (data.duration as number | undefined) ||
              null,
            price: s.price as number | undefined,
          })),
          staffName: staffName || undefined,
          ...(nextStatus === "Completed"
            ? { additionalIssues: data.additionalIssues || null }
            : {}),
        }
      );
    } catch (emailError) {
      console.error(
        `[call-center/status] Failed to send ${nextStatus} email for ${bookingId}:`,
        emailError
      );
    }
  } catch (notifErr) {
    console.error("[call-center/status] notifications failed:", notifErr);
  }

  return NextResponse.json(
    {
      success: true,
      bookingId,
      bookingCode: (data.bookingCode as string | undefined) || null,
      previousStatus: currentStatus,
      status: nextStatus,
      action,
    },
    { headers: CORS_HEADERS }
  );
}
