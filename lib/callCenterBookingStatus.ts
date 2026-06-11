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
  createStaffAssignmentNotification,
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

  const body = (await req.json().catch(() => ({}))) as {
    reason?: string;
    forceComplete?: boolean;
    // Confirm-only: let the agent assign staff at the same time. Mirrors the
    // admin panel's confirm dialog + mobile app's `_showConfirmationWithDetailsDialog`.
    staffId?: string; // Single-service convenience
    staffName?: string;
    staffAssignments?: Record<string, { staffId?: string; staffName?: string }>; // Keyed by service id
    skipStaffValidation?: boolean; // Allow "Any Staff" / unassigned confirm (discouraged)
  };

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

  /** Staff uids that should receive an assignment notification after a
   *  successful confirm. Populated inside the `confirm` branch below. */
  let staffIdsToNotify: string[] = [];

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

    // Merge in any staff assignments supplied by the agent. This mirrors the
    // admin panel + mobile "confirm" dialog, where the operator picks a staff
    // member per service before the booking can flip to Confirmed.
    const staffAssignments =
      body.staffAssignments && typeof body.staffAssignments === "object"
        ? body.staffAssignments
        : {};
    const topLevelStaffId = String(body.staffId || "").trim();
    const topLevelStaffName = String(body.staffName || "").trim();

    const missingStaffForServices: string[] = [];
    const staffNotifyIds = new Set<string>();

    const mergedServices = services.map((s) => {
      const id = String(s.id ?? s.serviceId ?? "");
      const override = id && staffAssignments[id] ? staffAssignments[id] : null;

      let finalStaffId = String(s.staffId ?? "").trim();
      let finalStaffName = String(s.staffName ?? "").trim();

      if (override && override.staffId) {
        finalStaffId = String(override.staffId).trim();
        if (override.staffName) {
          finalStaffName = String(override.staffName).trim();
        }
      } else if (
        !finalStaffId &&
        services.length === 1 &&
        topLevelStaffId
      ) {
        // Single-service booking: accept top-level staffId/staffName.
        finalStaffId = topLevelStaffId;
        if (topLevelStaffName) finalStaffName = topLevelStaffName;
      }

      const looksUnassigned =
        !finalStaffId ||
        finalStaffId === "null" ||
        /^any( staff| available)?$/i.test(finalStaffName);

      if (looksUnassigned && !body.skipStaffValidation) {
        const label = String(s.name ?? `service ${id || "#?"}`);
        missingStaffForServices.push(label);
      }

      if (finalStaffId && finalStaffId !== "null") {
        staffNotifyIds.add(finalStaffId);
      }

      return {
        ...s,
        ...(finalStaffId ? { staffId: finalStaffId } : {}),
        ...(finalStaffName ? { staffName: finalStaffName } : {}),
        approvalStatus: "accepted",
      };
    });

    // Legacy single-service bookings (no `services[]` array) — validate the
    // top-level staffId so they can't be confirmed empty.
    if (
      services.length === 0 &&
      !body.skipStaffValidation &&
      !topLevelStaffId &&
      !String(data.staffId ?? "").trim()
    ) {
      missingStaffForServices.push(
        String(data.serviceName ?? "service"),
      );
    }

    if (missingStaffForServices.length > 0) {
      return NextResponse.json(
        {
          error:
            "Staff must be assigned to every service before confirming. Pass `staffAssignments` in the body, or set `skipStaffValidation: true` to override.",
          missingStaffForServices,
          hint:
            'Body shape: { "staffAssignments": { "<serviceId>": { "staffId": "X", "staffName": "Y" } } } — or for a single-service booking { "staffId": "X", "staffName": "Y" }.',
        },
        { status: 400, headers: CORS_HEADERS },
      );
    }

    updateData.services = mergedServices;

    // Legacy single-service bookings may carry top-level staff fields. Keep
    // them in sync so downstream listeners (mobile card, email template) see
    // the newly-assigned staff even if they don't walk the services array.
    if (services.length === 0 && topLevelStaffId) {
      updateData.staffId = topLevelStaffId;
      if (topLevelStaffName) updateData.staffName = topLevelStaffName;
      staffNotifyIds.add(topLevelStaffId);
    } else if (services.length === 1) {
      const only = mergedServices[0] as Record<string, unknown>;
      if (only.staffId) {
        updateData.staffId = only.staffId;
        if (only.staffName) updateData.staffName = only.staffName;
      }
    } else if (services.length > 1) {
      // Multi-service: clear the top-level fields to avoid the admin panel
      // showing a single "assigned staff" label on a booking with per-service
      // staff. (Same behaviour as the admin panel's confirm path.)
      updateData.staffId = FieldValue.delete();
      updateData.staffName = FieldValue.delete();
    }

    updateData.confirmedBy = performerUid;
    updateData.confirmedByName = performerName;
    updateData.confirmedByRole = performerRole;
    updateData.confirmedAt = FieldValue.serverTimestamp();
    updateData.confirmedVia = "call_center";

    // Stash the staff-to-notify set outside of `updateData` so it doesn't end
    // up persisted to Firestore (see the post-update block below).
    staffIdsToNotify = Array.from(staffNotifyIds);
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
    // Prefer the merged services (with newly-assigned staff) from the update
    // payload so notifications and emails reflect the freshly-picked staff.
    const services = Array.isArray(updateData.services)
      ? (updateData.services as Record<string, unknown>[])
      : Array.isArray(data.services)
        ? (data.services as Record<string, unknown>[])
        : [];
    const staffName =
      ((updateData.staffName as string | undefined) ||
        (data.staffName as string | undefined)) ||
      (services.find((s) => s.staffName)?.staffName as string | undefined) ||
      null;

    // Fan-out staff assignment notifications for newly-confirmed bookings so
    // each assigned staff member sees the job in their mobile inbox (matches
    // the admin panel's confirm flow).
    if (nextStatus === "Confirmed" && staffIdsToNotify.length > 0) {
      await Promise.all(
        staffIdsToNotify.map(async (staffUid) => {
          try {
            const matched = services.find(
              (s) => String(s.staffId ?? "") === staffUid,
            );
            await createStaffAssignmentNotification({
              bookingId,
              bookingCode: data.bookingCode as string | undefined,
              staffUid,
              staffName:
                (matched?.staffName as string | undefined) ||
                staffName ||
                undefined,
              clientName,
              clientPhone: data.clientPhone as string | undefined,
              serviceName:
                (matched?.name as string | undefined) ||
                (data.serviceName as string | undefined),
              services: services.map((s) => ({
                name: (s.name as string) || "Service",
                staffName: (s.staffName as string | undefined) || undefined,
                staffId: (s.staffId as string | undefined) || undefined,
              })),
              branchName: data.branchName as string | undefined,
              bookingDate: ((data.date as string | undefined) ?? "").toString(),
              bookingTime: ((data.time as string | undefined) ?? "").toString(),
              duration: data.duration as number | undefined,
              price: data.price as number | undefined,
              ownerUid,
            });
          } catch (e) {
            console.error(
              "[call-center/status] staff assignment notification failed:",
              e,
            );
          }
        }),
      );
    }

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
        // bookingDate / bookingTime are required `string` on the notification
        // helper. Legacy docs may omit them so fall back to empty strings so
        // the build stays type-safe without changing runtime behaviour.
        bookingDate: ((data.date as string | undefined) ?? "").toString(),
        bookingTime: ((data.time as string | undefined) ?? "").toString(),
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
          customerPhone: data.clientPhone as string | undefined,
          duration: data.duration as number | undefined,
          price: data.price as number | undefined,
          serviceName: data.serviceName as string | undefined,
          services: services.map((s) => ({
            name: (s.name as string) || "Service",
            staffName: (s.staffName as string | undefined) || undefined,
            time:
              (s.time as string | undefined) ||
              (data.time as string | undefined) ||
              undefined,
            duration:
              (s.duration as number | undefined) ||
              (data.duration as number | undefined) ||
              undefined,
            price: s.price as number | undefined,
          })),
          staffName: staffName || undefined,
          ...(nextStatus === "Completed"
            ? {
                additionalIssues:
                  (data.additionalIssues as
                    | Array<{
                        id?: string;
                        issueTitle?: string;
                        status?: string;
                        price?: number | null;
                        customerResponse?: string | null;
                      }>
                    | null
                    | undefined) || null,
              }
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
