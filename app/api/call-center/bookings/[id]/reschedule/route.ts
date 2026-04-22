import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebaseAdmin";
import {
  verifyCallCenterOrTenantAdminAuth,
  canAccessWorkshopForAuth,
  CORS_HEADERS,
} from "@/lib/callCenterAuth";
import { normalizeBookingStatus } from "@/lib/bookingTypes";
import {
  createBookingRescheduledAuditNotification,
  createCustomerBookingRescheduledNotification,
  createStaffAssignmentNotification,
  createStaffBookingRescheduledNotification,
  createStaffUnassignedNotification,
  getBranchAdminUids,
} from "@/lib/notifications";
import { logBookingRescheduledServer } from "@/lib/auditLogServer";
import { sendBookingRescheduledEmail } from "@/lib/emailService";

export const runtime = "nodejs";

export async function OPTIONS() {
  return NextResponse.json({}, { headers: CORS_HEADERS });
}

// ─── Helpers ────────────────────────────────────────────────────────────────
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function isValidDate(s: unknown): s is string {
  if (typeof s !== "string" || !DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime());
}
function isValidTime(s: unknown): s is string {
  return typeof s === "string" && TIME_RE.test(s);
}

/**
 * Resolve a bookings/bookingRequests doc by either Firestore id or human
 * `bookingCode` (e.g. `BK-2026-032612-2452`).
 */
async function findBookingByIdOrCode(
  db: FirebaseFirestore.Firestore,
  segment: string,
): Promise<{
  ref: FirebaseFirestore.DocumentReference;
  snap: FirebaseFirestore.DocumentSnapshot;
  isBookingRequest: boolean;
} | null> {
  // Try bookings/{id} first, then bookingRequests/{id}.
  let ref = db.doc(`bookings/${segment}`);
  let snap = await ref.get();
  if (snap.exists) return { ref, snap, isBookingRequest: false };

  ref = db.doc(`bookingRequests/${segment}`);
  snap = await ref.get();
  if (snap.exists) return { ref, snap, isBookingRequest: true };

  // Fall back to bookingCode lookup in both collections.
  const byCodeBookings = await db
    .collection("bookings")
    .where("bookingCode", "==", segment)
    .limit(2)
    .get();
  if (!byCodeBookings.empty) {
    if (byCodeBookings.size > 1) throw new Error("DUPLICATE_BOOKING_CODE");
    const d = byCodeBookings.docs[0];
    return { ref: d.ref, snap: d, isBookingRequest: false };
  }

  const byCodeReq = await db
    .collection("bookingRequests")
    .where("bookingCode", "==", segment)
    .limit(2)
    .get();
  if (!byCodeReq.empty) {
    if (byCodeReq.size > 1) throw new Error("DUPLICATE_BOOKING_CODE");
    const d = byCodeReq.docs[0];
    return { ref: d.ref, snap: d, isBookingRequest: true };
  }

  return null;
}

/**
 * PATCH /api/call-center/bookings/[id]/reschedule
 *
 * Reschedule an existing booking or booking request on behalf of the workshop.
 * `[id]` may be the Firestore document id or the human `bookingCode` (e.g.
 * `BK-2026-032612-2452`). Mirrors the admin panel / mobile reschedule flow:
 * writes reschedule history, fires customer + staff + owner / branch-admin
 * audit notifications, and sends the customer reschedule email.
 *
 * Guards:
 *   • Booking must not be `Completed` / `Canceled`.
 *   • Booking must not already be in-progress (i.e. staff has tapped "Start"
 *     and recorded `mileage`) — returns `409`. Once the job is physically
 *     underway the agent must cancel instead of rescheduling.
 *
 * Body:
 *   {
 *     newDate: "YYYY-MM-DD",           // required
 *     newTime: "HH:mm",                // required (24-hour)
 *     newPickupTime?: "HH:mm",         // optional pick-up slot, must be after newTime
 *     reason?: string,                 // optional — shown in audit + notifications
 *     // Optional staff reassignment alongside the reschedule:
 *     //   Single-service: `newStaffId` + `newStaffName`.
 *     //   Multi-service:  `staffAssignments` keyed by service id (from services[].id).
 *     newStaffId?: string,
 *     newStaffName?: string,
 *     staffAssignments?: Record<string, { staffId: string; staffName?: string }>
 *   }
 *
 * Auth: `Authorization: Bearer <agent-JWT>` plus `X-Tenant-Id: <workshopOwnerUid>`
 * (or BMS workshop owner / branch-admin JWT with access to that workshop).
 */
export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const gate = await verifyCallCenterOrTenantAdminAuth(req);
  if (!gate.success) {
    return NextResponse.json(
      { error: gate.error },
      { status: gate.status || 401, headers: CORS_HEADERS },
    );
  }

  const { id: rawId } = await context.params;
  const segment = decodeURIComponent(rawId || "").trim();
  if (!segment) {
    return NextResponse.json(
      { error: "Missing booking id" },
      { status: 400, headers: CORS_HEADERS },
    );
  }

  // ── Body ──────────────────────────────────────────────────────────────────
  const body = (await req.json().catch(() => ({}))) as {
    newDate?: string;
    newTime?: string;
    newPickupTime?: string;
    reason?: string;
    newStaffId?: string;
    newStaffName?: string;
    staffAssignments?: Record<string, { staffId?: string; staffName?: string }>;
  };

  const newDate = (body.newDate || "").trim();
  const newTime = (body.newTime || "").trim();
  const newPickupTime = (body.newPickupTime || "").trim();
  const reason = (body.reason || "").trim();
  const newStaffId = (body.newStaffId || "").trim();
  const newStaffName = (body.newStaffName || "").trim();
  const staffAssignments =
    body.staffAssignments && typeof body.staffAssignments === "object"
      ? body.staffAssignments
      : {};

  if (!isValidDate(newDate)) {
    return NextResponse.json(
      { error: "`newDate` must be a valid YYYY-MM-DD date." },
      { status: 400, headers: CORS_HEADERS },
    );
  }
  if (!isValidTime(newTime)) {
    return NextResponse.json(
      { error: "`newTime` must be a valid HH:mm time." },
      { status: 400, headers: CORS_HEADERS },
    );
  }
  if (newPickupTime && !isValidTime(newPickupTime)) {
    return NextResponse.json(
      { error: "`newPickupTime` must be a valid HH:mm time." },
      { status: 400, headers: CORS_HEADERS },
    );
  }
  if (newPickupTime && newPickupTime <= newTime) {
    return NextResponse.json(
      { error: "Pick-up time must be after the drop-off time." },
      { status: 400, headers: CORS_HEADERS },
    );
  }

  // ── Locate booking ────────────────────────────────────────────────────────
  const db = adminDb();
  let found;
  try {
    found = await findBookingByIdOrCode(db, segment);
  } catch (e) {
    if (e instanceof Error && e.message === "DUPLICATE_BOOKING_CODE") {
      return NextResponse.json(
        { error: "Multiple bookings match this booking code" },
        { status: 409, headers: CORS_HEADERS },
      );
    }
    throw e;
  }
  if (!found) {
    return NextResponse.json(
      { error: "Booking not found" },
      { status: 404, headers: CORS_HEADERS },
    );
  }
  const { ref, snap, isBookingRequest } = found;
  const bookingId = snap.id;
  const data = snap.data() as Record<string, any>;

  const ownerUid = String(data.ownerUid ?? "").trim();
  if (!ownerUid) {
    return NextResponse.json(
      { error: "Booking is missing owner information" },
      { status: 422, headers: CORS_HEADERS },
    );
  }

  if (!canAccessWorkshopForAuth(gate.auth, ownerUid)) {
    return NextResponse.json(
      { error: "Access denied for this workshop" },
      { status: 403, headers: CORS_HEADERS },
    );
  }

  // ── Guard against terminal statuses ─────────────────────────────────────
  const currentStatus = normalizeBookingStatus(data.status || "Pending");
  if (currentStatus === "Completed" || currentStatus === "Canceled") {
    return NextResponse.json(
      {
        error: `Cannot reschedule a ${currentStatus.toLowerCase()} booking.`,
      },
      { status: 400, headers: CORS_HEADERS },
    );
  }

  // ── Guard against in-progress jobs ──────────────────────────────────────
  // When staff tap "Start" on the appointment they record `mileage` on the
  // booking. After that point the job is physically underway so the slot is
  // considered committed — the agent must cancel instead.
  const existingMileage = (data.mileage ?? "").toString().trim();
  if (existingMileage !== "") {
    return NextResponse.json(
      {
        error:
          "This booking has already been started by staff and can no longer be rescheduled.",
      },
      { status: 409, headers: CORS_HEADERS },
    );
  }

  // ── Snapshot previous slot for audit + notifications ────────────────────
  const prevDate: string | null = data.date || null;
  const prevTime: string | null = data.time || null;
  const prevPickupTime: string | null = data.pickupTime || null;
  const prevStaffId: string | null = data.staffId || null;
  const prevStaffName: string | null = data.staffName || null;
  const effectiveNewPickupTime = newPickupTime || prevPickupTime || "";

  const existingServices: any[] = Array.isArray(data.services)
    ? data.services
    : [];
  const hasMultiServices = existingServices.length > 0;
  const staffChanged =
    (!hasMultiServices && !!newStaffId && newStaffId !== (prevStaffId || "")) ||
    (hasMultiServices &&
      Object.entries(staffAssignments).some(([sid, v]) => {
        const svc = existingServices.find((s) => String(s?.id) === String(sid));
        const nextId = (v?.staffId || "").trim();
        return !!nextId && svc && String(svc.staffId || "") !== nextId;
      }));

  const noChange =
    prevDate === newDate &&
    prevTime === newTime &&
    (prevPickupTime || "") === (newPickupTime || prevPickupTime || "") &&
    !staffChanged;
  if (noChange) {
    return NextResponse.json(
      { error: "The new date, time and staff are the same as the current booking." },
      { status: 400, headers: CORS_HEADERS },
    );
  }

  // ── Performer (agent vs BMS staff) ──────────────────────────────────────
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

  // ── Build update ────────────────────────────────────────────────────────
  const nowIso = new Date().toISOString();
  const historyEntry = {
    previousDate: prevDate,
    previousTime: prevTime,
    previousPickupTime: prevPickupTime,
    newDate,
    newTime,
    newPickupTime: newPickupTime || null,
    reason: reason || null,
    performedByUid: performerUid,
    performedByName: performerName,
    performedByRole: performerRole,
    performedAt: nowIso,
    source: "call_center",
  };

  const updateData: Record<string, any> = {
    date: newDate,
    time: newTime,
    updatedAt: FieldValue.serverTimestamp(),
    lastRescheduledAt: FieldValue.serverTimestamp(),
    lastRescheduledByUid: performerUid,
    lastRescheduledByName: performerName,
    lastRescheduledByRole: performerRole,
    lastRescheduledVia: "call_center",
    rescheduleHistory: FieldValue.arrayUnion(historyEntry),
  };
  if (newPickupTime) {
    updateData.pickupTime = newPickupTime;
  }

  // Staff tracking — identical semantics to the admin reschedule route.
  const staffToNotify: Array<{ uid: string; name: string; serviceName?: string }> = [];
  const staffUnassigned: Array<{
    uid: string;
    name: string;
    serviceName?: string;
    replacedByStaffName?: string;
  }> = [];
  const staffStillAssigned: Array<{
    uid: string;
    name: string;
    serviceName?: string;
  }> = [];

  if (hasMultiServices) {
    updateData.services = existingServices.map((svc: any) => {
      const sid = String(svc?.id ?? "");
      const override = sid ? staffAssignments[sid] : undefined;
      const nextStaffId = (override?.staffId || "").trim();
      const nextStaffName = (override?.staffName || "").trim();
      const prevSvcStaffId = String(svc?.staffId || "");
      const prevSvcStaffName = String(svc?.staffName || "");

      if (nextStaffId && nextStaffId !== prevSvcStaffId) {
        const reassigned: any = {
          ...svc,
          time: newTime,
          staffId: nextStaffId,
          staffName: nextStaffName || svc?.staffName || "Staff",
          approvalStatus: "accepted",
        };
        delete reassigned.acceptedAt;
        delete reassigned.rejectedAt;
        delete reassigned.rejectionReason;
        delete reassigned.respondedByStaffUid;
        delete reassigned.respondedByStaffName;
        staffToNotify.push({
          uid: nextStaffId,
          name: nextStaffName || "Staff",
          serviceName: svc?.name || undefined,
        });
        if (prevSvcStaffId) {
          staffUnassigned.push({
            uid: prevSvcStaffId,
            name: prevSvcStaffName || "Staff",
            serviceName: svc?.name || undefined,
            replacedByStaffName: nextStaffName || undefined,
          });
        }
        return reassigned;
      }
      if (prevSvcStaffId) {
        staffStillAssigned.push({
          uid: prevSvcStaffId,
          name: prevSvcStaffName || "Staff",
          serviceName: svc?.name || undefined,
        });
      }
      return { ...svc, time: newTime };
    });
  } else if (newStaffId && newStaffId !== (prevStaffId || "")) {
    updateData.staffId = newStaffId;
    updateData.staffName = newStaffName || "Staff";
    staffToNotify.push({ uid: newStaffId, name: newStaffName || "Staff" });
    if (prevStaffId) {
      staffUnassigned.push({
        uid: prevStaffId,
        name: (prevStaffName || "Staff").toString(),
        replacedByStaffName: newStaffName || undefined,
      });
    }
  } else if (prevStaffId) {
    staffStillAssigned.push({
      uid: prevStaffId,
      name: (prevStaffName || "Staff").toString(),
    });
  }

  await ref.update(updateData);

  // ── Side-effects (best-effort; never fail the request) ──────────────────
  const bookingCode: string | undefined = data.bookingCode;
  const clientName: string = data.client || data.clientName || "Customer";
  const branchName: string | undefined = data.branchName;
  const finalServiceName: string | undefined = data.serviceName;

  const postUpdateServices: any[] = Array.isArray(updateData.services)
    ? updateData.services
    : existingServices;
  const finalServices: Array<{ name: string; staffName?: string }> | undefined =
    postUpdateServices.length > 0
      ? postUpdateServices.map((s: any) => ({
          name: (s?.name ?? "Service").toString(),
          staffName: s?.staffName ? String(s.staffName) : undefined,
        }))
      : undefined;
  const primaryStaffName: string | undefined =
    (updateData.staffName as string | undefined) ?? data.staffName;
  const primaryStaffId: string | undefined =
    (updateData.staffId as string | undefined) ?? data.staffId;

  // Activity feed
  try {
    await db.collection("bookingActivities").add({
      ownerUid,
      bookingId,
      bookingCode: bookingCode || null,
      activityType: "booking_rescheduled",
      clientName,
      serviceName: finalServiceName || null,
      branchName: branchName || null,
      staffName: primaryStaffName || null,
      price: data.price || null,
      date: newDate,
      time: newTime,
      previousDate: prevDate,
      previousTime: prevTime,
      previousStatus: currentStatus,
      newStatus: currentStatus,
      reason: reason || null,
      rescheduledByUid: performerUid,
      rescheduledByName: performerName,
      rescheduledByRole: performerRole,
      source: "call_center",
      createdAt: FieldValue.serverTimestamp(),
    });
  } catch (e) {
    console.error("[call-center/reschedule] activity write failed:", e);
  }

  // Audit log
  try {
    await logBookingRescheduledServer(
      ownerUid,
      bookingId,
      bookingCode,
      clientName,
      { uid: performerUid, name: performerName, role: performerRole },
      { date: prevDate, time: prevTime },
      { date: newDate, time: newTime },
      reason,
      branchName,
    );
  } catch (e) {
    console.error("[call-center/reschedule] audit log failed:", e);
  }

  // Customer notification
  try {
    await createCustomerBookingRescheduledNotification({
      bookingId,
      bookingCode,
      customerUid: data.customerUid,
      customerEmail: data.clientEmail,
      customerPhone: data.clientPhone,
      clientName,
      staffName: primaryStaffName || undefined,
      serviceName: finalServiceName || undefined,
      services: finalServices,
      branchName: branchName || undefined,
      previousDate: prevDate,
      previousTime: prevTime,
      previousPickupTime: prevPickupTime,
      bookingDate: newDate,
      bookingTime: newTime,
      pickupTime: effectiveNewPickupTime || null,
      reason: reason || null,
      ownerUid,
    });
  } catch (e) {
    console.error("[call-center/reschedule] customer notif failed:", e);
  }

  // Notify newly assigned staff (reassignment card).
  if (staffToNotify.length > 0) {
    try {
      for (const s of staffToNotify) {
        const staffServices = postUpdateServices.filter(
          (svc: any) => String(svc?.staffId || "") === s.uid,
        );
        await createStaffAssignmentNotification({
          bookingId,
          bookingCode,
          staffUid: s.uid,
          staffName: s.name,
          clientName,
          clientPhone: data.clientPhone,
          serviceName: s.serviceName || finalServiceName,
          services:
            staffServices.length > 0
              ? staffServices.map((svc: any) => ({
                  name: svc?.name || "Service",
                  staffName: svc?.staffName,
                  staffId: svc?.staffId,
                }))
              : undefined,
          branchName,
          bookingDate: newDate,
          bookingTime: newTime,
          duration: data.duration,
          price: data.price,
          ownerUid,
          isReassignment: true,
        });
      }
    } catch (e) {
      console.error("[call-center/reschedule] staff reassignment notif failed:", e);
    }
  }

  // Notify staff that were replaced.
  if (staffUnassigned.length > 0) {
    try {
      const seen = new Set<string>();
      for (const s of staffUnassigned) {
        if (seen.has(s.uid)) continue;
        seen.add(s.uid);
        await createStaffUnassignedNotification({
          bookingId,
          bookingCode,
          staffUid: s.uid,
          staffName: s.name,
          clientName,
          clientPhone: data.clientPhone,
          serviceName: s.serviceName || finalServiceName,
          services: finalServices?.map((svc) => ({
            name: svc.name || "Service",
            staffName: svc.staffName || undefined,
          })),
          branchName,
          bookingDate: newDate,
          bookingTime: newTime,
          reason: reason || null,
          replacedByStaffName: s.replacedByStaffName || null,
          ownerUid,
        });
      }
    } catch (e) {
      console.error("[call-center/reschedule] staff unassigned notif failed:", e);
    }
  }

  // Notify staff that remain assigned.
  const alreadyNotified = new Set<string>([
    ...staffToNotify.map((s) => s.uid),
    ...staffUnassigned.map((s) => s.uid),
  ]);
  const dateOrTimeChanged =
    prevDate !== newDate ||
    prevTime !== newTime ||
    (prevPickupTime || "") !== (effectiveNewPickupTime || "");
  if (dateOrTimeChanged && staffStillAssigned.length > 0) {
    try {
      const seenSame = new Set<string>();
      for (const s of staffStillAssigned) {
        if (alreadyNotified.has(s.uid) || seenSame.has(s.uid)) continue;
        seenSame.add(s.uid);
        const staffServices = postUpdateServices.filter(
          (svc: any) => String(svc?.staffId || "") === s.uid,
        );
        await createStaffBookingRescheduledNotification({
          bookingId,
          bookingCode,
          staffUid: s.uid,
          staffName: s.name,
          clientName,
          clientPhone: data.clientPhone,
          serviceName: s.serviceName || finalServiceName,
          services:
            staffServices.length > 0
              ? staffServices.map((svc: any) => ({
                  name: svc?.name || "Service",
                  staffName: svc?.staffName,
                  staffId: svc?.staffId,
                }))
              : undefined,
          branchName,
          previousDate: prevDate,
          previousTime: prevTime,
          previousPickupTime: prevPickupTime,
          bookingDate: newDate,
          bookingTime: newTime,
          pickupTime: effectiveNewPickupTime || null,
          reason: reason || null,
          duration: data.duration,
          price: data.price,
          ownerUid,
        });
      }
    } catch (e) {
      console.error("[call-center/reschedule] staff reschedule notif failed:", e);
    }
  }

  // Cross-role audit notification — call-center agents aren't the owner or
  // branch admin, so we always notify BOTH sides so they can see the change
  // on their admin panel + mobile inbox.
  try {
    const bookingBranchId: string | undefined =
      (data.branchId || "").toString() || undefined;

    // Owner.
    try {
      await createBookingRescheduledAuditNotification({
        bookingId,
        bookingCode,
        ownerUid,
        audience: "owner",
        targetOwnerUid: ownerUid,
        branchId: bookingBranchId,
        clientName,
        serviceName: finalServiceName,
        services: finalServices?.map((svc) => ({
          name: svc.name || "Service",
          staffName: svc.staffName || undefined,
        })),
        branchName,
        previousDate: prevDate,
        previousTime: prevTime,
        previousPickupTime: prevPickupTime,
        bookingDate: newDate,
        bookingTime: newTime,
        pickupTime: effectiveNewPickupTime || null,
        reason: reason || null,
        performerUid,
        performerName,
        performerRole,
      });
    } catch (e) {
      console.error("[call-center/reschedule] owner audit notif failed:", e);
    }

    // Branch admin(s).
    if (bookingBranchId) {
      const branchAdminUids = await getBranchAdminUids(
        db,
        bookingBranchId,
        ownerUid,
      );
      for (const branchAdminUid of branchAdminUids) {
        try {
          await createBookingRescheduledAuditNotification({
            bookingId,
            bookingCode,
            ownerUid,
            audience: "branch_admin",
            branchAdminUid,
            branchId: bookingBranchId,
            clientName,
            serviceName: finalServiceName,
            services: finalServices?.map((svc) => ({
              name: svc.name || "Service",
              staffName: svc.staffName || undefined,
            })),
            branchName,
            previousDate: prevDate,
            previousTime: prevTime,
            previousPickupTime: prevPickupTime,
            bookingDate: newDate,
            bookingTime: newTime,
            pickupTime: effectiveNewPickupTime || null,
            reason: reason || null,
            performerUid,
            performerName,
            performerRole,
          });
        } catch (e) {
          console.error(
            "[call-center/reschedule] branch admin audit notif failed:",
            e,
          );
        }
      }
    }
  } catch (e) {
    console.error("[call-center/reschedule] cross-role audit failed:", e);
  }

  // Customer email with the new details.
  try {
    const emailServices =
      postUpdateServices.length > 0
        ? postUpdateServices.map((s: any) => ({
            name: s?.name,
            staffName: s?.staffName,
            time: s?.time,
            duration: s?.duration,
            price: s?.price,
          }))
        : undefined;
    await sendBookingRescheduledEmail({
      bookingId,
      bookingCode: bookingCode || null,
      customerEmail: data.clientEmail,
      customerName: clientName,
      ownerUid,
      branchName: branchName || null,
      previousDate: prevDate,
      previousTime: prevTime,
      previousPickupTime: prevPickupTime,
      newDate,
      newTime,
      newPickupTime: effectiveNewPickupTime || null,
      reason: reason || null,
      serviceName: finalServiceName || null,
      services: emailServices,
      staffName: primaryStaffName || null,
      duration: data.duration || null,
      price: data.price || null,
    });
  } catch (e) {
    console.error("[call-center/reschedule] customer email failed:", e);
  }

  return NextResponse.json(
    {
      ok: true,
      collection: isBookingRequest ? "bookingRequests" : "bookings",
      bookingId,
      bookingCode: bookingCode || null,
      date: newDate,
      time: newTime,
      pickupTime: effectiveNewPickupTime || null,
      staffId: primaryStaffId || null,
      staffName: primaryStaffName || null,
      services: postUpdateServices.length > 0 ? postUpdateServices : null,
      previous: {
        date: prevDate,
        time: prevTime,
        pickupTime: prevPickupTime,
        staffId: prevStaffId,
        staffName: prevStaffName,
      },
    },
    { headers: CORS_HEADERS },
  );
}
