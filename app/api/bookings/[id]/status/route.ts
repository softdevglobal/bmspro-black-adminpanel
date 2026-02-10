import { NextRequest, NextResponse } from "next/server";
import { adminAuth, adminDb } from "@/lib/firebaseAdmin";
import { FieldValue } from "firebase-admin/firestore";
import { canTransitionStatus, normalizeBookingStatus } from "@/lib/bookingTypes";
import { 
  createNotification, 
  getNotificationContent, 
  createStaffAssignmentNotification,
  createCustomerConfirmationNotification,
  createCustomerCancellationNotification,
  createCustomerReschedulingNotification
} from "@/lib/notifications";
import { 
  logBookingStatusChangedServer, 
  logBookingSentToStaffServer,
  logBookingReassignedServer 
} from "@/lib/auditLogServer";
import { checkRateLimit, getClientIdentifier, RateLimiters, getRateLimitHeaders } from "@/lib/rateLimiterDistributed";
import { sendBookingStatusChangeEmail } from "@/lib/emailService";

// Helper to get activity type from status
function getActivityType(status: string): string {
  const s = status.toLowerCase().replace(/[_\s-]/g, "");
  if (s === "awaitingstaffapproval") return "booking_sent_to_staff";
  if (s === "partiallyapproved") return "booking_partially_approved";
  if (s === "staffrejected") return "booking_staff_rejected";
  if (s === "confirmed") return "booking_confirmed";
  if (s === "completed") return "booking_completed";
  if (s === "cancelled" || s === "canceled") return "booking_cancelled";
  if (s === "pending") return "booking_created";
  return "booking_updated";
}

export const runtime = "nodejs";

export async function PATCH(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    // Security: Distributed rate limiting to prevent status update spam
    const clientId = getClientIdentifier(req);
    const rateLimitResult = await checkRateLimit(clientId, RateLimiters.statusUpdate);
    
    if (!rateLimitResult.success) {
      return NextResponse.json(
        { 
          error: "Too many requests. Please try again later.",
          retryAfter: rateLimitResult.retryAfter,
        },
        { status: 429, headers: getRateLimitHeaders(rateLimitResult) }
      );
    }

    const { id } = await context.params;
    const authHeader = req.headers.get("authorization") || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) {
      if (process.env.NODE_ENV !== "production") {
        // Allow client-side fallback in development
        return NextResponse.json({ ok: true, devNoop: true });
      }
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let callerUid: string;
    try {
      const decoded = await adminAuth().verifyIdToken(token);
      callerUid = decoded.uid;
    } catch (verifyError: any) {
      console.error("Token verification failed:", verifyError);
      
      // Detailed error info for debugging Vercel issues
      const errorDetails = {
        code: verifyError?.code,
        message: verifyError?.message,
        stack: process.env.NODE_ENV !== "production" ? verifyError?.stack : undefined,
      };

      if (process.env.NODE_ENV !== "production") {
        console.log("Falling back to devNoop due to verification failure in dev");
        return NextResponse.json({ ok: true, devNoop: true });
      }
      
      return NextResponse.json({ 
        error: "Unauthorized: Token verification failed", 
        details: errorDetails,
        hint: "Check server logs for Firebase Admin initialization status." 
      }, { status: 401 });
    }

    const body = (await req.json().catch(() => ({}))) as { 
      status?: string; 
      staffId?: string;
      staffName?: string;
      services?: any[];
      rejectionReason?: string; // For staff rejecting a booking
      isReassignment?: boolean; // Flag for admin reassigning after rejection
      previousStatus?: string; // Previous status from client (for mobile app that updates Firestore first)
    };
    
    // Handle the "Confirmed" status from old admin panel - map to new workflow
    let requestedStatusRaw = body?.status || "";
    
    // Check if this is an admin trying to "confirm" from Pending
    // In the new workflow, this should go to AwaitingStaffApproval
    // We'll detect this case and handle it properly
    
    const requestedStatus = normalizeBookingStatus(requestedStatusRaw);

    const db = adminDb();
    
    // Get user role to determine permissions
    const userDoc = await db.doc(`users/${callerUid}`).get();
    const userData = userDoc.data();
    const userRole = (userData?.role || "").toString();
    const ownerUid = userRole === "salon_owner" ? callerUid : (userData?.ownerUid || callerUid);
    
    // Try to find booking in "bookings" collection first
    let ref = db.doc(`bookings/${id}`);
    let snap = await ref.get();
    let isBookingRequest = false;
    
    // If not found, try "bookingRequests" collection
    if (!snap.exists) {
      ref = db.doc(`bookingRequests/${id}`);
      snap = await ref.get();
      isBookingRequest = true;
    }
    
    if (!snap.exists) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const data = snap.data() as any;
    if (!data || data.ownerUid !== ownerUid) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const currentStatus = normalizeBookingStatus(data.status || "Pending");
    
    // Use previousStatus from request body if provided (for mobile app that updates Firestore first)
    // Otherwise use currentStatus from Firestore
    const effectivePreviousStatus = body.previousStatus 
      ? normalizeBookingStatus(body.previousStatus) 
      : currentStatus;
    
    // Handle the transition from Pending -> "Confirmed" in admin panel
    // In new workflow, this actually means Pending -> AwaitingStaffApproval
    let actualNextStatus = requestedStatus;
    let isAdminConfirmingPending = false;
    
    if (currentStatus === "Pending" && requestedStatus === "Confirmed") {
      // Admin is trying to confirm a pending booking
      // In the new workflow, this should go to AwaitingStaffApproval
      actualNextStatus = "AwaitingStaffApproval" as any;
      isAdminConfirmingPending = true;
    }
    
    // For staff accepting from AwaitingStaffApproval -> Confirmed
    const isStaffAccepting = currentStatus === "AwaitingStaffApproval" && requestedStatus === "Confirmed";
    
    // For staff rejecting from AwaitingStaffApproval -> StaffRejected
    const isStaffRejecting = currentStatus === "AwaitingStaffApproval" && requestedStatus === "StaffRejected";
    
    // For admin reassigning after rejection: StaffRejected -> AwaitingStaffApproval
    const isAdminReassigning = currentStatus === "StaffRejected" && requestedStatus === "AwaitingStaffApproval";

    // Allow same-status updates when only services are being updated (for staff assignment)
    // Check if we're only updating services without changing status
    const hasServicesUpdate = body.services && Array.isArray(body.services) && body.services.length > 0;
    const statusIsSame = currentStatus === actualNextStatus;
    const isOnlyUpdatingServices = hasServicesUpdate && statusIsSame;

    // Check if this is a mobile app call where Firestore was already updated
    // Mobile app updates Firestore first, then calls API to send email
    // In this case, previousStatus will be provided and different from currentStatus
    const isMobileAppEmailTrigger = body.previousStatus && 
      normalizeBookingStatus(body.previousStatus) !== currentStatus &&
      statusIsSame;

    // If we're only updating services and status is the same, allow it
    // Or if this is a mobile app email trigger (status already updated in Firestore)
    // Otherwise, check if the transition is valid
    if (isOnlyUpdatingServices) {
      // Allow same-status update when only services are being updated
      console.log(`Allowing same-status update: ${currentStatus} -> ${actualNextStatus} (services only)`);
    } else if (isMobileAppEmailTrigger) {
      // Allow same-status update when mobile app already updated Firestore and is just triggering email
      console.log(`Allowing same-status update: ${currentStatus} -> ${actualNextStatus} (mobile app email trigger, previousStatus was ${body.previousStatus})`);
    } else if (!canTransitionStatus(currentStatus, actualNextStatus)) {
      return NextResponse.json({ error: `Invalid transition ${currentStatus} -> ${actualNextStatus}` }, { status: 400 });
    }

    // Prepare update data
    const updateData: any = {
      updatedAt: FieldValue.serverTimestamp(),
    };
    
    // Only update status if it's actually changing
    if (currentStatus !== actualNextStatus) {
      updateData.status = actualNextStatus;
    }

    // Add services update if provided (for multi-service staff assignment)
    if (body.services && Array.isArray(body.services) && body.services.length > 0) {
      // Initialize approvalStatus to "pending" for each service when sending to staff
      if (isAdminConfirmingPending || actualNextStatus === "AwaitingStaffApproval") {
        updateData.services = body.services.map((service: any) => {
          // Create a clean service object without undefined values (Firestore doesn't accept undefined)
          const cleanService: any = {
            ...service,
            approvalStatus: "pending", // Initialize approval status
          };
          // Remove any previous response data
          delete cleanService.acceptedAt;
          delete cleanService.rejectedAt;
          delete cleanService.rejectionReason;
          delete cleanService.respondedByStaffUid;
          delete cleanService.respondedByStaffName;
          return cleanService;
        });
      } else {
        updateData.services = body.services;
      }
      
      // If we have services, we don't need top-level staff info
      if (!isBookingRequest) {
        updateData.staffId = FieldValue.delete();
        updateData.staffName = FieldValue.delete();
      }
    } else if (body.staffId) {
      // Only set top-level staff if no services array update (legacy support)
      updateData.staffId = body.staffId;
      updateData.staffName = body.staffName || "Staff";
    }

    // Store rejection reason if staff is rejecting
    if (isStaffRejecting && body.rejectionReason) {
      updateData.rejectionReason = body.rejectionReason;
      updateData.rejectedByStaffUid = callerUid;
      updateData.rejectedByStaffName = userData?.name || userData?.displayName || "Staff";
    }

    // Clear rejection info if being reassigned
    if (isAdminReassigning) {
      updateData.rejectionReason = FieldValue.delete();
      updateData.rejectedByStaffUid = FieldValue.delete();
      updateData.rejectedByStaffName = FieldValue.delete();
    }

    // If admin is sending to staff for approval (from booking request or pending), move to bookings if needed
    if (isBookingRequest && (isAdminConfirmingPending || actualNextStatus === "AwaitingStaffApproval")) {
      // Create in bookings collection
      const bookingData = {
        ...data,
        ...updateData,
        createdAt: data.createdAt || FieldValue.serverTimestamp(),
      };
      
      // Explicitly remove top-level staff fields for new booking document if services exist
      if (body.services && Array.isArray(body.services) && body.services.length > 0) {
        delete bookingData.staffId;
        delete bookingData.staffName;
      }
      
      await db.collection("bookings").add(bookingData);
      
      // Delete from bookingRequests
      await ref.delete();
    } else {
      // Just update the booking
      await ref.update(updateData);
    }

    // Create booking activity log entry
    try {
      const activityData = {
        ownerUid: ownerUid,
        bookingId: id,
        bookingCode: data.bookingCode || null,
        activityType: getActivityType(actualNextStatus),
        clientName: data.client || data.clientName || "Unknown",
        serviceName: data.serviceName || null,
        branchName: data.branchName || null,
        staffName: body.staffName || data.staffName || null,
        price: data.price || null,
        date: data.date || null,
        time: data.time || null,
        previousStatus: currentStatus,
        newStatus: actualNextStatus,
        createdAt: FieldValue.serverTimestamp(),
        ...(isStaffRejecting && body.rejectionReason ? { rejectionReason: body.rejectionReason } : {}),
      };
      await db.collection("bookingActivities").add(activityData);
    } catch (activityError) {
      console.error("Failed to create booking activity:", activityError);
    }

    // Create audit log entry
    try {
      const clientName = data.client || data.clientName || "Customer";
      const performer = {
        uid: callerUid,
        name: userData?.name || userData?.displayName || "User",
        role: userRole,
      };

      if (isAdminConfirmingPending) {
        // Admin sending to staff for approval
        const staffNames = body.services?.map((s: any) => s.staffName).filter(Boolean) || [];
        await logBookingSentToStaffServer(
          ownerUid,
          id,
          data.bookingCode,
          clientName,
          performer,
          staffNames.length > 0 ? staffNames : [body.staffName || "Staff"],
          data.branchName
        );
      } else if (isAdminReassigning) {
        // Admin reassigning after rejection
        const staffNames = body.services?.map((s: any) => s.staffName).filter(Boolean) || [];
        await logBookingReassignedServer(
          ownerUid,
          id,
          data.bookingCode,
          clientName,
          performer,
          staffNames.join(", ") || body.staffName,
          data.branchName
        );
      } else {
        // General status change
        await logBookingStatusChangedServer(
          ownerUid,
          id,
          data.bookingCode,
          clientName,
          currentStatus,
          actualNextStatus,
          performer,
          isStaffRejecting && body.rejectionReason ? `Rejection reason: ${body.rejectionReason}` : undefined,
          data.branchName
        );
      }
    } catch (auditError) {
      console.error("Failed to create audit log:", auditError);
    }

    // === NEW NOTIFICATION WORKFLOW ===
    try {
      const finalServices = body.services || data.services || null;
      const finalStaffName = body.staffName || data.staffName || null;
      const finalServiceName = data.serviceName || null;
      const finalBookingDate = data.date || null;
      const finalBookingTime = data.time || null;
      const clientName = data.client || data.clientName || "Customer";

      // CASE 1: Admin confirms pending booking -> Send notification to STAFF (not customer)
      if (isAdminConfirmingPending || isAdminReassigning) {
        // Collect all unique staff UIDs that need to be notified
        const staffToNotify: Array<{ uid: string; name: string }> = [];
        
        if (finalServices && Array.isArray(finalServices) && finalServices.length > 0) {
          // Multi-service booking - notify each staff member
          for (const svc of finalServices) {
            if (svc.staffId && svc.staffId !== "null") {
              const existing = staffToNotify.find(s => s.uid === svc.staffId);
              if (!existing) {
                staffToNotify.push({ uid: svc.staffId, name: svc.staffName || "Staff" });
              }
            }
          }
        } else if (body.staffId) {
          // Single staff assignment
          staffToNotify.push({ uid: body.staffId, name: body.staffName || "Staff" });
        } else if (data.staffId) {
          // Use existing staff assignment
          staffToNotify.push({ uid: data.staffId, name: data.staffName || "Staff" });
        }
        
        // Send notification to each assigned staff member
        for (const staff of staffToNotify) {
          await createStaffAssignmentNotification({
            bookingId: id,
            bookingCode: data.bookingCode,
            staffUid: staff.uid,
            staffName: staff.name,
            clientName: clientName,
            clientPhone: data.clientPhone,
            serviceName: finalServiceName,
            services: finalServices?.map((s: any) => ({
              name: s.name || "Service",
              staffName: s.staffName,
              staffId: s.staffId,
            })),
            branchName: data.branchName,
            bookingDate: finalBookingDate,
            bookingTime: finalBookingTime,
            duration: data.duration,
            price: data.price,
            ownerUid: ownerUid,
            isReassignment: isAdminReassigning,
          });
        }
        
        console.log(`Sent staff assignment notifications to ${staffToNotify.length} staff member(s)`);
      }
      
      // CASE 2: Staff accepts booking -> Send confirmation notification to CUSTOMER
      else if (isStaffAccepting) {
        await createCustomerConfirmationNotification({
          bookingId: id,
          bookingCode: data.bookingCode,
          customerUid: data.customerUid,
          customerEmail: data.clientEmail,
          customerPhone: data.clientPhone,
          clientName: clientName,
          staffName: finalStaffName,
          serviceName: finalServiceName,
          services: finalServices?.map((s: any) => ({
            name: s.name || "Service",
            staffName: s.staffName,
          })),
          branchName: data.branchName,
          bookingDate: finalBookingDate,
          bookingTime: finalBookingTime,
          ownerUid: ownerUid,
        });
        
        console.log("Sent customer confirmation notification");
      }
      
      // Send email when status changes to Confirmed (regardless of transition path)
      // Use effectivePreviousStatus to handle cases where mobile app updates Firestore first
      if (actualNextStatus === "Confirmed" && effectivePreviousStatus !== "Confirmed") {
        try {
          console.log(`[EMAIL] Sending confirmation email for booking ${id}`);
          await sendBookingStatusChangeEmail(
            id,
            actualNextStatus,
            data.clientEmail,
            clientName,
            ownerUid,
            {
              bookingCode: data.bookingCode,
              branchName: data.branchName,
              bookingDate: finalBookingDate,
              bookingTime: finalBookingTime,
              duration: data.duration,
              price: data.price,
              serviceName: finalServiceName,
              services: finalServices?.map((s: any) => ({
                name: s.name || "Service",
                staffName: s.staffName || null,
                time: s.time || finalBookingTime || null,
                duration: s.duration || data.duration || null,
              })),
              staffName: finalStaffName,
            }
          );
          console.log(`[EMAIL] ✅ Confirmation email sent successfully for booking ${id}`);
        } catch (emailError) {
          console.error(`[EMAIL] ❌ Failed to send booking confirmation email for ${id}:`, emailError);
          // Don't fail the request if email sending fails
        }
      }
      
      // CASE 3: Staff rejects booking -> Send notification to ADMIN
      else if (isStaffRejecting) {
        const { createAdminRejectionNotification } = await import("@/lib/notifications");
        
        await createAdminRejectionNotification({
          bookingId: id,
          bookingCode: data.bookingCode,
          ownerUid: ownerUid,
          rejectedByStaffUid: callerUid,
          rejectedByStaffName: userData?.name || userData?.displayName || "Staff",
          rejectionReason: body.rejectionReason || "No reason provided",
          clientName: clientName,
          serviceName: finalServiceName,
          services: finalServices?.map((s: any) => ({
            name: s.name || "Service",
            staffName: s.staffName,
            staffId: s.staffId,
          })),
          branchName: data.branchName,
          bookingDate: finalBookingDate,
          bookingTime: finalBookingTime,
        });
        
        console.log("Sent admin rejection notification");
      }
      
      // CASE 4: Booking canceled -> Send cancellation notification to CUSTOMER
      else if (actualNextStatus === "Canceled") {
        await createCustomerCancellationNotification({
          bookingId: id,
          bookingCode: data.bookingCode,
          customerUid: data.customerUid,
          customerEmail: data.clientEmail,
          customerPhone: data.clientPhone,
          clientName: clientName,
          staffName: finalStaffName,
          serviceName: finalServiceName,
          services: finalServices?.map((s: any) => ({
            name: s.name || "Service",
            staffName: s.staffName || "Any Available"
          })),
          branchName: data.branchName,
          bookingDate: finalBookingDate,
          bookingTime: finalBookingTime,
          ownerUid: ownerUid,
        });
        
        console.log("Sent customer cancellation notification");
      }
      
      // Send email when status changes to Canceled (regardless of transition path)
      // Use effectivePreviousStatus to handle cases where mobile app updates Firestore first
      // Check if requestedStatus is Canceled OR if current status in Firestore is Canceled but previousStatus was different
      const isRequestingCancel = requestedStatus === "Canceled";
      const isAlreadyCanceled = currentStatus === "Canceled";
      const wasNotCanceledBefore = effectivePreviousStatus !== "Canceled";
      const shouldSendCancellationEmail = isRequestingCancel && wasNotCanceledBefore;
      
      if (shouldSendCancellationEmail) {
        try {
          console.log(`[EMAIL] Sending cancellation email for booking ${id}`);
          console.log(`[EMAIL] Debug: isRequestingCancel=${isRequestingCancel}, isAlreadyCanceled=${isAlreadyCanceled}, wasNotCanceledBefore=${wasNotCanceledBefore}`);
          console.log(`[EMAIL] Debug: actualNextStatus=${actualNextStatus}, requestedStatus=${requestedStatus}, effectivePreviousStatus=${effectivePreviousStatus}, currentStatus=${currentStatus}, body.previousStatus=${body.previousStatus}`);
          await sendBookingStatusChangeEmail(
            id,
            "Canceled", // Always use "Canceled" for email
            data.clientEmail,
            clientName,
            ownerUid,
            {
              bookingCode: data.bookingCode,
              branchName: data.branchName,
              bookingDate: finalBookingDate,
              bookingTime: finalBookingTime,
              duration: data.duration,
              price: data.price,
              serviceName: finalServiceName,
              services: finalServices?.map((s: any) => ({
                name: s.name || "Service",
                staffName: s.staffName || null,
                time: s.time || finalBookingTime || null,
                duration: s.duration || data.duration || null,
              })),
              staffName: finalStaffName,
            }
          );
          console.log(`[EMAIL] ✅ Cancellation email sent successfully for booking ${id}`);
        } catch (emailError) {
          console.error(`[EMAIL] ❌ Failed to send booking cancellation email for ${id}:`, emailError);
          // Don't fail the request if email sending fails
        }
      } else {
        console.log(`[EMAIL] Skipping cancellation email for booking ${id}: actualNextStatus=${actualNextStatus}, requestedStatus=${requestedStatus}, effectivePreviousStatus=${effectivePreviousStatus}, currentStatus=${currentStatus}`);
      }
      
      // CASE 5: Booking completed -> Send completion notification to CUSTOMER
      if (actualNextStatus === "Completed") {
        const notificationContent = getNotificationContent(
          actualNextStatus, 
          data.bookingCode,
          finalStaffName,
          finalServiceName,
          finalBookingDate,
          finalBookingTime,
          finalServices?.map((s: any) => ({
            name: s.name || "Service",
            staffName: s.staffName || "Any Available"
          }))
        );
        
        const notificationData: any = {
          bookingId: id,
          type: notificationContent.type,
          title: notificationContent.title,
          message: notificationContent.message,
          status: actualNextStatus,
          ownerUid: ownerUid,
        };
        
        if (data.customerUid) notificationData.customerUid = data.customerUid;
        if (data.clientEmail) notificationData.customerEmail = data.clientEmail;
        if (data.clientPhone) notificationData.customerPhone = data.clientPhone;
        if (data.bookingCode) notificationData.bookingCode = data.bookingCode;
        if (finalStaffName) notificationData.staffName = finalStaffName;
        if (finalServiceName) notificationData.serviceName = finalServiceName;
        if (data.branchName) notificationData.branchName = data.branchName;
        if (finalBookingDate) notificationData.bookingDate = finalBookingDate;
        if (finalBookingTime) notificationData.bookingTime = finalBookingTime;
        
        if (finalServices && Array.isArray(finalServices) && finalServices.length > 0) {
          notificationData.services = finalServices.map((s: any) => ({
            name: s.name || "Service",
            staffName: s.staffName || "Any Available"
          }));
        }
        
        await createNotification(notificationData);
        
        console.log("Sent customer completion notification");
      }
      
      // Send email when status changes to Completed (regardless of transition path)
      // Use effectivePreviousStatus to handle cases where mobile app updates Firestore first
      if (actualNextStatus === "Completed" && effectivePreviousStatus !== "Completed") {
        try {
          console.log(`[EMAIL] Sending completion email for booking ${id}`);
          await sendBookingStatusChangeEmail(
            id,
            actualNextStatus,
            data.clientEmail,
            clientName,
            ownerUid,
            {
              bookingCode: data.bookingCode,
              branchName: data.branchName,
              bookingDate: finalBookingDate,
              bookingTime: finalBookingTime,
              duration: data.duration,
              price: data.price,
              serviceName: finalServiceName,
              services: finalServices?.map((s: any) => ({
                name: s.name || "Service",
                staffName: s.staffName || null,
                time: s.time || finalBookingTime || null,
                duration: s.duration || data.duration || null,
              })),
              staffName: finalStaffName,
            }
          );
          console.log(`[EMAIL] ✅ Completion email sent successfully for booking ${id}`);
        } catch (emailError) {
          console.error(`[EMAIL] ❌ Failed to send booking completion email for ${id}:`, emailError);
          // Don't fail the request if email sending fails
        }
      }
    } catch (notifError) {
      console.error("Failed to create notification:", notifError);
      // Don't fail the request if notification creation fails
    }

    return NextResponse.json({ ok: true, status: actualNextStatus });
  } catch (e: any) {
    console.error("Error in PATCH /api/bookings/[id]/status:", e);
    const message = process.env.NODE_ENV === "production" ? "Internal error" : e?.message || "Internal error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}


