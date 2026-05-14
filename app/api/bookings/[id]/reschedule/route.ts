import { NextRequest, NextResponse } from "next/server";
import { adminAuth, adminDb } from "@/lib/firebaseAdmin";
import { FieldValue } from "firebase-admin/firestore";
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
import {
  collectStaffIdsOnApprovedLeaveForDate,
  parseBookingYmd,
} from "@/lib/leaveBookingAssignment";
import {
  checkRateLimit,
  getClientIdentifier,
  RateLimiters,
  getRateLimitHeaders,
} from "@/lib/rateLimiterDistributed";

export const runtime = "nodejs";

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
 * PATCH /api/bookings/[id]/reschedule
 *
 * Amend the date and/or time of an existing booking or booking request. Only
 * `workshop_owner` and `branch_admin` are permitted. The booking must not be
 * `Completed` / `Canceled`, and must not already be in-progress — i.e. a staff
 * member has already tapped "Start" and recorded mileage. Once the job is
 * physically underway the schedule is considered committed; the admin must
 * cancel it if they need to move it.
 *
 * Body:
 *   {
 *     newDate: "YYYY-MM-DD",
 *     newTime: "HH:mm",
 *     newPickupTime?: "HH:mm", // optional customer pick-up slot
 *     reason?: string,         // optional audit / notification context
 *     // Optional staff reassignment alongside the reschedule.
 *     // Single-service bookings: `newStaffId` + `newStaffName`.
 *     // Multi-service bookings: `staffAssignments` keyed by service id.
 *     newStaffId?: string,
 *     newStaffName?: string,
 *     staffAssignments?: Record<string, { staffId: string; staffName?: string }>
 *   }
 */
export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    // Rate-limit (shares the status-update bucket — this is a low-volume action)
    const clientId = getClientIdentifier(req);
    const rl = await checkRateLimit(clientId, RateLimiters.statusUpdate);
    if (!rl.success) {
      return NextResponse.json(
        { error: "Too many requests. Please try again later.", retryAfter: rl.retryAfter },
        { status: 429, headers: getRateLimitHeaders(rl) },
      );
    }

    const { id } = await context.params;

    // ── Auth ──────────────────────────────────────────────────────────────
    const authHeader = req.headers.get("authorization") || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let callerUid: string;
    try {
      const decoded = await adminAuth().verifyIdToken(token);
      callerUid = decoded.uid;
    } catch (err) {
      console.error("Token verification failed:", err);
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // ── Body ──────────────────────────────────────────────────────────────
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
    const staffAssignments = (body.staffAssignments && typeof body.staffAssignments === "object")
      ? body.staffAssignments
      : {};

    if (!isValidDate(newDate)) {
      return NextResponse.json(
        { error: "`newDate` must be a valid YYYY-MM-DD date." },
        { status: 400 },
      );
    }
    if (!isValidTime(newTime)) {
      return NextResponse.json(
        { error: "`newTime` must be a valid HH:mm time." },
        { status: 400 },
      );
    }
    if (newPickupTime && !isValidTime(newPickupTime)) {
      return NextResponse.json(
        { error: "`newPickupTime` must be a valid HH:mm time." },
        { status: 400 },
      );
    }
    if (newPickupTime && newPickupTime <= newTime) {
      return NextResponse.json(
        { error: "Pick-up time must be after the drop-off time." },
        { status: 400 },
      );
    }

    // ── Role gate ─────────────────────────────────────────────────────────
    const db = adminDb();
    const userDoc = await db.doc(`users/${callerUid}`).get();
    const userData = userDoc.data() || {};
    const userRole = (userData?.role || "").toString();

    if (!["workshop_owner", "branch_admin"].includes(userRole)) {
      return NextResponse.json(
        { error: "Only workshop owners and branch admins can reschedule bookings." },
        { status: 403 },
      );
    }

    const ownerUid =
      userRole === "workshop_owner" ? callerUid : (userData?.ownerUid || callerUid);

    // Cannot reassign to staff on approved leave on the new date
    try {
      const bookingDay = parseBookingYmd(newDate);
      if (bookingDay) {
        const leaveSnap = await db
          .collection("leave_requests")
          .where("ownerUid", "==", ownerUid)
          .where("status", "==", "approved")
          .get();
        const blocked = collectStaffIdsOnApprovedLeaveForDate(
          leaveSnap.docs.map((d) => ({
            data: () => d.data() as Record<string, unknown>,
          })),
          bookingDay,
        );
        const isBad = (sid: string) =>
          sid.trim().length > 0 && blocked.has(sid.trim());
        if (isBad(newStaffId)) {
          return NextResponse.json(
            {
              error:
                "Cannot assign staff who is on approved leave on that date.",
            },
            { status: 400 },
          );
        }
        for (const v of Object.values(staffAssignments)) {
          const sid = (v?.staffId || "").trim();
          if (isBad(sid)) {
            return NextResponse.json(
              {
                error:
                  "Cannot assign staff who is on approved leave on that date.",
              },
              { status: 400 },
            );
          }
        }
      }
    } catch (e) {
      console.warn("Reschedule leave check skipped:", e);
    }

    // ── Locate booking (either collection) ────────────────────────────────
    let ref = db.doc(`bookings/${id}`);
    let snap = await ref.get();
    let isBookingRequest = false;
    if (!snap.exists) {
      ref = db.doc(`bookingRequests/${id}`);
      snap = await ref.get();
      isBookingRequest = true;
    }
    if (!snap.exists) {
      return NextResponse.json({ error: "Booking not found" }, { status: 404 });
    }

    const data = snap.data() as any;
    if (data.ownerUid !== ownerUid) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // ── Guard against terminal statuses ───────────────────────────────────
    const currentStatus = normalizeBookingStatus(data.status || "Pending");
    if (currentStatus === "Completed" || currentStatus === "Canceled") {
      return NextResponse.json(
        {
          error: `Cannot reschedule a ${currentStatus.toLowerCase()} booking.`,
        },
        { status: 400 },
      );
    }

    // ── Guard against in-progress jobs ────────────────────────────────────
    // When staff tap "Start" on the appointment they record `mileage` on the
    // booking doc. After that point the job is physically underway (the
    // vehicle is on the ramp / in the bay) so we don't allow the slot to be
    // moved — the admin must cancel the booking if they need to reschedule.
    const existingMileage = (data.mileage ?? "").toString().trim();
    if (existingMileage !== "") {
      return NextResponse.json(
        {
          error:
            "This booking has already been started by staff and can no longer be rescheduled.",
        },
        { status: 409 },
      );
    }

    // Branch-admins may only reschedule bookings in their assigned branch
    // (workshop_owner can reschedule anywhere they own).
    if (userRole === "branch_admin") {
      const adminBranchId = (userData?.branchId || "").toString();
      const bookingBranchId = (data.branchId || "").toString();
      if (adminBranchId && bookingBranchId && adminBranchId !== bookingBranchId) {
        return NextResponse.json(
          { error: "Branch admins can only reschedule bookings in their branch." },
          { status: 403 },
        );
      }
    }

    // Previous slot snapshot — used for history, audit log, and notifications
    const prevDate: string | null = data.date || null;
    const prevTime: string | null = data.time || null;
    const prevPickupTime: string | null = data.pickupTime || null;
    const prevStaffId: string | null = data.staffId || null;
    const prevStaffName: string | null = data.staffName || null;
    const effectiveNewPickupTime = newPickupTime || prevPickupTime || "";

    // Detect staff changes (either booking-level single-service, or per-service)
    const existingServices: any[] = Array.isArray(data.services) ? data.services : [];
    const hasMultiServices = existingServices.length > 0;
    const staffChanged =
      (!hasMultiServices && newStaffId && newStaffId !== (prevStaffId || "")) ||
      (hasMultiServices &&
        Object.entries(staffAssignments).some(([sid, v]) => {
          const svc = existingServices.find((s) => String(s?.id) === String(sid));
          const nextId = (v?.staffId || "").trim();
          return nextId && svc && String(svc.staffId || "") !== nextId;
        }));

    const noChange =
      prevDate === newDate &&
      prevTime === newTime &&
      (prevPickupTime || "") === (newPickupTime || prevPickupTime || "") &&
      !staffChanged;
    if (noChange) {
      return NextResponse.json(
        { error: "The new date, time and staff are the same as the current booking." },
        { status: 400 },
      );
    }

    // ── Build update ──────────────────────────────────────────────────────
    const performerName =
      (userData?.name || userData?.displayName || "Admin").toString();
    const nowIso = new Date().toISOString();

    const historyEntry = {
      previousDate: prevDate,
      previousTime: prevTime,
      previousPickupTime: prevPickupTime,
      newDate,
      newTime,
      newPickupTime: newPickupTime || null,
      reason: reason || null,
      performedByUid: callerUid,
      performedByName: performerName,
      performedByRole: userRole,
      performedAt: nowIso,
    };

    const updateData: Record<string, any> = {
      date: newDate,
      time: newTime,
      updatedAt: FieldValue.serverTimestamp(),
      lastRescheduledAt: FieldValue.serverTimestamp(),
      lastRescheduledByUid: callerUid,
      lastRescheduledByName: performerName,
      lastRescheduledByRole: userRole,
      rescheduleHistory: FieldValue.arrayUnion(historyEntry),
    };

    if (newPickupTime) {
      updateData.pickupTime = newPickupTime;
    }

    // Track staff changes so we can deliver the right notification to each
    // technician after the update:
    //   • staffToNotify     → newly assigned staff (gets reassignment card)
    //   • staffUnassigned   → staff that was replaced (gets removal card)
    //   • staffStillAssigned→ staff that remain assigned (gets reschedule card)
    const staffToNotify: Array<{ uid: string; name: string; serviceName?: string }> = [];
    const staffUnassigned: Array<{
      uid: string;
      name: string;
      serviceName?: string;
      replacedByStaffName?: string;
    }> = [];
    const staffStillAssigned: Array<{ uid: string; name: string; serviceName?: string }> = [];

    // If this booking has per-service entries, anchor each to the new start
    // time and apply any per-service staff reassignment. When an admin assigns
    // a new staff member to a service the approval flips back to "accepted"
    // (owner/admin authority — same semantics as the dedicated reassign route).
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
        // No staff change — collect the current assignee so we can tell them
        // about the new date/time (skipped when the service has no assignee).
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
      // Single-service booking whose staff hasn't changed — notify them.
      staffStillAssigned.push({
        uid: prevStaffId,
        name: (prevStaffName || "Staff").toString(),
      });
    }

    await ref.update(updateData);

    // ── Side-effects (best-effort; never fail the request) ────────────────
    const bookingCode: string | undefined = data.bookingCode;
    const clientName: string =
      data.client || data.clientName || "Customer";
    const branchName: string | undefined = data.branchName;
    const finalServiceName: string | undefined = data.serviceName;

    // Resolve the post-update services array (with any staff changes applied).
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
        bookingId: id,
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
        rescheduledByUid: callerUid,
        rescheduledByName: performerName,
        rescheduledByRole: userRole,
        createdAt: FieldValue.serverTimestamp(),
      });
    } catch (e) {
      console.error("Failed to write booking activity:", e);
    }

    // Audit log
    try {
      await logBookingRescheduledServer(
        ownerUid,
        id,
        bookingCode,
        clientName,
        { uid: callerUid, name: performerName, role: userRole },
        { date: prevDate, time: prevTime },
        { date: newDate, time: newTime },
        reason,
        branchName,
      );
    } catch (e) {
      console.error("Failed to write audit log:", e);
    }

    // Customer notification — shows the NEW date/time/pick-up and (optionally)
    // the previous slot + reason so the customer sees the reschedule details
    // in their in-app inbox immediately.
    try {
      await createCustomerBookingRescheduledNotification({
        bookingId: id,
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
      console.error("Failed to send customer reschedule notification:", e);
    }

    // Notify any newly assigned staff (same message pattern as the dedicated
    // reassign endpoint) so their inbox reflects the reassignment promptly.
    if (staffToNotify.length > 0) {
      try {
        for (const s of staffToNotify) {
          const staffServices = postUpdateServices.filter(
            (svc: any) => String(svc?.staffId || "") === s.uid,
          );
          await createStaffAssignmentNotification({
            bookingId: id,
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
            branchName: branchName,
            bookingDate: newDate,
            bookingTime: newTime,
            duration: data.duration,
            price: data.price,
            ownerUid,
            isReassignment: true,
          });
        }
      } catch (e) {
        console.error("Failed to send staff reassignment notifications:", e);
      }
    }

    // Notify staff who were replaced (their booking is no longer theirs).
    // De-duplicate on `uid` so a technician losing multiple services on the
    // same booking only gets a single removal card.
    if (staffUnassigned.length > 0) {
      try {
        const seenUnassigned = new Set<string>();
        for (const s of staffUnassigned) {
          if (seenUnassigned.has(s.uid)) continue;
          seenUnassigned.add(s.uid);
          await createStaffUnassignedNotification({
            bookingId: id,
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
        console.error("Failed to send staff unassigned notifications:", e);
      }
    }

    // Notify staff that remain assigned about the reschedule so their
    // schedule and push inbox reflect the new slot. Skip anyone we've
    // already pinged via the "reassigned" or "unassigned" branches to avoid
    // duplicate cards.
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
            bookingId: id,
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
        console.error("Failed to send staff reschedule notifications:", e);
      }
    }

    // Cross-role audit notification so both the owner and branch admin see the
    // reschedule on their admin panel + mobile inbox regardless of who did it.
    //   • Owner reschedules → notify branch admin(s) of that branch.
    //   • Branch admin reschedules → notify the workshop owner.
    //   • Other roles (super admin / call center) → notify both sides.
    try {
      const bookingBranchId: string | undefined = (data.branchId || "").toString() || undefined;
      const notifyBranchAdmins = async () => {
        if (!bookingBranchId) return;
        const branchAdminUids = await getBranchAdminUids(db, bookingBranchId, ownerUid);
        for (const branchAdminUid of branchAdminUids) {
          if (branchAdminUid === callerUid) continue; // don't notify the performer
          await createBookingRescheduledAuditNotification({
            bookingId: id,
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
            performerUid: callerUid,
            performerName,
            performerRole: userRole,
          });
        }
      };
      const notifyOwner = async () => {
        if (ownerUid === callerUid) return; // owner is the performer
        await createBookingRescheduledAuditNotification({
          bookingId: id,
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
          performerUid: callerUid,
          performerName,
          performerRole: userRole,
        });
      };

      if (userRole === "workshop_owner") {
        await notifyBranchAdmins();
      } else if (userRole === "branch_admin") {
        await notifyOwner();
      } else {
        // Fallback — alert both sides if another role gains reschedule access.
        await Promise.all([notifyBranchAdmins(), notifyOwner()]);
      }
    } catch (e) {
      console.error("Failed to send cross-role reschedule notifications:", e);
    }

    // Email the customer with the new booking details (always attempted on a
    // successful reschedule — this is distinct from the status-change email
    // dedupe because reschedules can happen multiple times).
    try {
      const emailServices = postUpdateServices.length > 0
        ? postUpdateServices.map((s: any) => ({
            name: s?.name,
            staffName: s?.staffName,
            time: s?.time,
            duration: s?.duration,
            price: s?.price,
          }))
        : undefined;
      await sendBookingRescheduledEmail({
        bookingId: id,
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
      console.error("Failed to send reschedule email:", e);
    }

    return NextResponse.json({
      ok: true,
      collection: isBookingRequest ? "bookingRequests" : "bookings",
      bookingId: id,
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
    });
  } catch (err: any) {
    console.error("Error in PATCH /api/bookings/[id]/reschedule:", err);
    const message =
      process.env.NODE_ENV === "production"
        ? "Internal error"
        : err?.message || "Internal error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
