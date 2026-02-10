import { NextRequest, NextResponse } from "next/server";
import { adminAuth, adminDb } from "@/lib/firebaseAdmin";
import { FieldValue } from "firebase-admin/firestore";
import { normalizeBookingStatus, type BookingService, type ServiceApprovalStatus } from "@/lib/bookingTypes";
import { 
  createCustomerConfirmationNotification, 
  createAdminRejectionNotification,
  createCustomerReschedulingNotification
} from "@/lib/notifications";
import { logBookingStaffResponseServer } from "@/lib/auditLogServer";
import { checkRateLimit, getClientIdentifier, RateLimiters, getRateLimitHeaders } from "@/lib/rateLimiterDistributed";
import { sendBookingStatusChangeEmail } from "@/lib/emailService";
import type { Firestore } from "firebase-admin/firestore";

export const runtime = "nodejs";

/**
 * Get all branch admin UIDs for a branch
 * Branch admins are stored in the users collection with role='salon_branch_admin' and matching branchId
 */
async function getBranchAdminUids(db: Firestore, branchId: string, ownerUid: string): Promise<string[]> {
  try {
    // Query users collection for branch admins
    // Branch admins have: role='salon_branch_admin', ownerUid matches, and branchId matches
    const branchAdminQuery = await db.collection("users")
      .where("ownerUid", "==", ownerUid)
      .where("role", "==", "salon_branch_admin")
      .where("branchId", "==", branchId)
      .get();
    
    const branchAdminUids = branchAdminQuery.docs.map(doc => doc.id);
    
    // Also check legacy adminStaffId in branch document (for backward compatibility)
    if (branchAdminUids.length === 0) {
      const branchDoc = await db.collection("branches").doc(branchId).get();
      if (branchDoc.exists) {
        const branchData = branchDoc.data();
        if (branchData?.adminStaffId) {
          return [branchData.adminStaffId];
        }
      }
    }
    
    return branchAdminUids;
  } catch (error) {
    console.error("Error getting branch admins:", error);
    return [];
  }
}

// CORS headers for mobile app
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// Handle CORS preflight requests
export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders });
}

/**
 * Calculate booking status based on service approval statuses
 */
function calculateBookingStatus(services: BookingService[]): string {
  if (!services || services.length === 0) return "AwaitingStaffApproval";
  
  const statuses = services.map(s => s.approvalStatus || "pending");
  const allAccepted = statuses.every(s => s === "accepted");
  const anyRejected = statuses.some(s => s === "rejected");
  const anyAccepted = statuses.some(s => s === "accepted");
  const allPending = statuses.every(s => s === "pending");
  
  if (allAccepted) return "Confirmed";
  if (anyRejected) return "StaffRejected";
  if (anyAccepted && !allPending) return "PartiallyApproved";
  return "AwaitingStaffApproval";
}

/**
 * Check if there are alternative staff members available for a rejected service
 * Returns true if alternative staff is available, false otherwise
 */
async function hasAlternativeStaffAvailable(
  db: ReturnType<typeof adminDb>,
  ownerUid: string,
  service: BookingService,
  rejectedStaffUid: string,
  branchId: string,
  bookingDate: string
): Promise<boolean> {
  try {
    // Get day of week from booking date
    const date = new Date(bookingDate);
    const daysOfWeek = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const dayName = daysOfWeek[date.getDay()];
    
    // Get all active staff for this owner
    const staffQuery = db.collection("users")
      .where("ownerUid", "==", ownerUid)
      .where("status", "==", "Active");
    
    const staffSnapshot = await staffQuery.get();
    
    if (staffSnapshot.empty) return false;
    
    // Get service definition to check staffIds restriction
    let serviceStaffIds: string[] = [];
    if (service.id) {
      try {
        const serviceDoc = await db.doc(`services/${service.id}`).get();
        const serviceData = serviceDoc.data();
        if (serviceData && Array.isArray(serviceData.staffIds)) {
          serviceStaffIds = serviceData.staffIds.map(String);
        }
      } catch (e) {
        // Service might not exist or be accessible, continue without restriction
        console.warn("Could not fetch service definition:", e);
      }
    }
    
    // Filter staff members
    const availableStaff = staffSnapshot.docs.filter(doc => {
      const staffData = doc.data();
      const staffUid = doc.id;
      
      // Exclude the staff member who rejected
      if (staffUid === rejectedStaffUid) return false;
      
      // Check if staff can perform this service (if service has staffIds restriction)
      if (serviceStaffIds.length > 0) {
        const canPerform = serviceStaffIds.some(id => 
          String(id) === staffUid || String(id) === (staffData.uid || staffData.authUid)
        );
        if (!canPerform) return false;
      }
      
      // Check if staff works at the booking branch
      if (branchId) {
        // Check weekly schedule first
        if (staffData.weeklySchedule && typeof staffData.weeklySchedule === 'object') {
          const daySchedule = staffData.weeklySchedule[dayName];
          if (daySchedule === null || daySchedule === undefined) {
            return false; // Not working on this day
          }
          if (daySchedule.branchId && daySchedule.branchId !== branchId) {
            return false; // Scheduled at different branch
          }
        }
        
        // Fallback to primary branchId
        if (!staffData.weeklySchedule && staffData.branchId !== branchId) {
          return false;
        }
      }
      
      return true;
    });
    
    return availableStaff.length > 0;
  } catch (error) {
    console.error("Error checking for alternative staff:", error);
    // If we can't determine, assume no alternative to be safe
    return false;
  }
}

/**
 * API endpoint for staff to accept or reject a booking assignment
 * Supports per-service accept/reject for multi-service bookings
 */
export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    // Security: Distributed rate limiting to prevent response spam
    const clientId = getClientIdentifier(req);
    const rateLimitResult = await checkRateLimit(clientId, RateLimiters.statusUpdate);
    
    if (!rateLimitResult.success) {
      return NextResponse.json(
        { 
          error: "Too many requests. Please try again later.",
          retryAfter: rateLimitResult.retryAfter,
        },
        { status: 429, headers: { ...corsHeaders, ...getRateLimitHeaders(rateLimitResult) } }
      );
    }

    const { id } = await context.params;
    const authHeader = req.headers.get("authorization") || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    
    if (!token) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders });
    }

    let staffUid: string;
    try {
      const decoded = await adminAuth().verifyIdToken(token);
      staffUid = decoded.uid;
    } catch (verifyError: any) {
      console.error("Token verification failed:", verifyError);
      return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders });
    }

    const body = (await req.json().catch(() => ({}))) as { 
      action: "accept" | "reject";
      rejectionReason?: string;
      serviceId?: string | number; // Optional: specify which service to accept/reject
    };

    if (!body.action || !["accept", "reject"].includes(body.action)) {
      return NextResponse.json({ error: "Invalid action. Must be 'accept' or 'reject'" }, { status: 400, headers: corsHeaders });
    }

    if (body.action === "reject" && !body.rejectionReason?.trim()) {
      return NextResponse.json({ error: "Rejection reason is required" }, { status: 400, headers: corsHeaders });
    }

    const db = adminDb();

    // Get staff user data
    const staffDoc = await db.doc(`users/${staffUid}`).get();
    const staffData = staffDoc.data();
    const staffName = staffData?.name || staffData?.displayName || "Staff";
    const ownerUid = staffData?.ownerUid || staffUid;

    // Find the booking
    const bookingRef = db.doc(`bookings/${id}`);
    const bookingSnap = await bookingRef.get();

    if (!bookingSnap.exists) {
      return NextResponse.json({ error: "Booking not found" }, { status: 404, headers: corsHeaders });
    }

    const bookingData = bookingSnap.data() as any;
    const currentStatus = normalizeBookingStatus(bookingData.status);

    // Verify booking is in a state that allows staff response
    const allowedStatuses = ["AwaitingStaffApproval", "PartiallyApproved"];
    if (!allowedStatuses.includes(currentStatus)) {
      return NextResponse.json({ 
        error: `Cannot ${body.action} booking. Current status is ${currentStatus}. Only bookings awaiting staff approval or partially approved can be responded to.` 
      }, { status: 400, headers: corsHeaders });
    }

    // Check if this is a multi-service booking
    const hasMultipleServices = bookingData.services && Array.isArray(bookingData.services) && bookingData.services.length > 0;
    
    const clientName = bookingData.client || bookingData.clientName || "Customer";
    const finalBookingDate = bookingData.date || null;
    const finalBookingTime = bookingData.time || null;

    if (hasMultipleServices) {
      // Multi-service booking - handle per-service accept/reject
      const services: BookingService[] = bookingData.services;
      
      // Find services assigned to this staff member (check both staffId and staffAuthUid)
      const staffServices = services.filter(s => 
        s.staffId === staffUid || (s as any).staffAuthUid === staffUid
      );
      
      if (staffServices.length === 0) {
        return NextResponse.json({ 
          error: "You are not assigned to any services in this booking" 
        }, { status: 403, headers: corsHeaders });
      }

      // If serviceId is provided, only respond to that specific service
      // Otherwise, respond to all services assigned to this staff
      let servicesToUpdate: BookingService[];
      
      if (body.serviceId !== undefined) {
        // Find the target service - first check in staffServices, then in all services by ID
        let targetService = staffServices.find(s => String(s.id) === String(body.serviceId));
        
        // If not found in staffServices, check if the service exists and is assigned to this staff
        if (!targetService) {
          const serviceById = services.find(s => String(s.id) === String(body.serviceId));
          if (serviceById && (serviceById.staffId === staffUid || (serviceById as any).staffAuthUid === staffUid)) {
            targetService = serviceById;
          }
        }
        
        if (!targetService) {
          return NextResponse.json({ 
            error: "You are not assigned to this service" 
          }, { status: 403, headers: corsHeaders });
        }
        servicesToUpdate = [targetService];
      } else {
        // Respond to all services assigned to this staff that are still pending
        servicesToUpdate = staffServices.filter(s => !s.approvalStatus || s.approvalStatus === "pending");
        
        if (servicesToUpdate.length === 0) {
          return NextResponse.json({ 
            error: "You have already responded to all your assigned services" 
          }, { status: 400, headers: corsHeaders });
        }
      }

      // Update the services array with the staff's response
      // Note: FieldValue.serverTimestamp() can't be used in arrays, so use Date for service fields
      const nowDate = new Date().toISOString();
      let updatedServices = services.map(service => {
        const shouldUpdate = servicesToUpdate.some(s => String(s.id) === String(service.id));
        
        if (shouldUpdate) {
          if (body.action === "accept") {
            return {
              ...service,
              approvalStatus: "accepted" as ServiceApprovalStatus,
              acceptedAt: nowDate,
              respondedByStaffUid: staffUid,
              respondedByStaffName: staffName,
            };
          } else {
            return {
              ...service,
              approvalStatus: "rejected" as ServiceApprovalStatus,
              rejectedAt: nowDate,
              rejectionReason: body.rejectionReason,
              respondedByStaffUid: staffUid,
              respondedByStaffName: staffName,
            };
          }
        }
        return service;
      });

      // If rejecting, check for alternative staff for each rejected service
      let shouldAutoCancel = false;
      if (body.action === "reject") {
        // Check each rejected service for alternative staff availability
        const rejectedServices = updatedServices.filter(s => s.approvalStatus === "rejected");
        
        for (const rejectedService of rejectedServices) {
          const hasAlternative = await hasAlternativeStaffAvailable(
            db,
            ownerUid,
            rejectedService,
            staffUid,
            bookingData.branchId || "",
            finalBookingDate || ""
          );
          
          if (!hasAlternative) {
            // No alternative staff available for this service - booking should be cancelled
            shouldAutoCancel = true;
            break; // One service without alternative is enough to cancel the booking
          }
        }
      }

      // Calculate new booking status based on all service approvals
      let newBookingStatus = calculateBookingStatus(updatedServices);
      
      // If no alternative staff is available, cancel the booking
      if (shouldAutoCancel) {
        newBookingStatus = "Canceled";
      }
      
      // Prepare update data
      const updateData: any = {
        services: updatedServices,
        status: newBookingStatus,
        updatedAt: FieldValue.serverTimestamp(),
      };

      // If all accepted, add acceptance metadata
      if (newBookingStatus === "Confirmed") {
        updateData.confirmedAt = FieldValue.serverTimestamp();
      }

      // If any rejected, add rejection metadata (for the most recent rejection)
      if (body.action === "reject") {
        updateData.lastRejectedByStaffUid = staffUid;
        updateData.lastRejectedByStaffName = staffName;
        updateData.lastRejectionReason = body.rejectionReason;
        updateData.lastRejectedAt = FieldValue.serverTimestamp();
      }

      // If auto-cancelled, add cancellation metadata
      if (shouldAutoCancel) {
        updateData.canceledAt = FieldValue.serverTimestamp();
        updateData.canceledReason = `Service rejected by ${staffName} and no alternative staff available`;
        updateData.canceledBy = "system";
      }

      await bookingRef.update(updateData);
      
      // IMPORTANT: Wait a moment to ensure database update is committed
      // This ensures the status change is reflected before we check for duplicates
      await new Promise(resolve => setTimeout(resolve, 200));
      
      // Verify the status was actually updated in the database
      const verifySnap = await bookingRef.get();
      const verifiedStatus = normalizeBookingStatus(verifySnap.data()?.status);
      console.log(`[EMAIL] Status verification - Original: ${currentStatus}, Calculated: ${newBookingStatus}, Verified in DB: ${verifiedStatus}`);

      // Create activity log
      try {
        const serviceNames = servicesToUpdate.map(s => s.name || "Service").join(", ");
        await db.collection("bookingActivities").add({
          ownerUid: ownerUid,
          bookingId: id,
          bookingCode: bookingData.bookingCode || null,
          activityType: body.action === "accept" ? "booking_service_accepted" : "booking_service_rejected",
          clientName: clientName,
          serviceName: serviceNames,
          branchName: bookingData.branchName || null,
          staffName: staffName,
          staffUid: staffUid,
          price: bookingData.price || null,
          date: finalBookingDate,
          time: finalBookingTime,
          previousStatus: currentStatus,
          newStatus: newBookingStatus,
          servicesUpdated: servicesToUpdate.map(s => ({ id: s.id, name: s.name })),
          ...(body.action === "reject" ? { rejectionReason: body.rejectionReason } : {}),
          createdAt: FieldValue.serverTimestamp(),
        });
      } catch (e) {
        console.error("Failed to create activity log:", e);
      }

      // Create audit log for staff response
      try {
        const serviceNames = servicesToUpdate.map(s => s.name || "Service").join(", ");
        const performer = {
          uid: staffUid,
          name: staffName,
          role: staffData?.role || "salon_staff",
        };
        await logBookingStaffResponseServer(
          ownerUid,
          id,
          bookingData.bookingCode,
          clientName,
          body.action === "accept" ? "accepted" : "rejected",
          performer,
          serviceNames,
          body.rejectionReason,
          bookingData.branchName
        );
      } catch (e) {
        console.error("Failed to create audit log:", e);
      }

      // Send notifications based on new status
      if (newBookingStatus === "Confirmed") {
        // All services accepted - send confirmation to customer
        try {
          await createCustomerConfirmationNotification({
            bookingId: id,
            bookingCode: bookingData.bookingCode,
            customerUid: bookingData.customerUid,
            customerEmail: bookingData.clientEmail,
            customerPhone: bookingData.clientPhone,
            clientName: clientName,
            staffName: staffName,
            serviceName: bookingData.serviceName,
            services: updatedServices.map((s: any) => ({
              name: s.name || "Service",
              staffName: s.staffName,
            })),
            branchName: bookingData.branchName,
            bookingDate: finalBookingDate,
            bookingTime: finalBookingTime,
            ownerUid: ownerUid,
          });
          console.log("Sent customer confirmation notification - all services accepted");
        } catch (e) {
          console.error("Failed to send customer notification:", e);
        }
      }
      
      // Send email when status changes to Confirmed (AFTER database update)
      // Check if this is a transition TO Confirmed (from AwaitingStaffApproval or PartiallyApproved)
      // Use verifiedStatus to ensure we're checking the actual database state
      // Note: currentStatus is already narrowed to "AwaitingStaffApproval" | "PartiallyApproved" by the check above,
      // so it can never be "Confirmed" - no need to check again
      const isTransitioningToConfirmed = 
        (newBookingStatus === "Confirmed" || verifiedStatus === "Confirmed") && 
        (currentStatus === "AwaitingStaffApproval" || currentStatus === "PartiallyApproved");
      
      if (isTransitioningToConfirmed) {
        // Verify customer email exists before attempting to send
        if (!bookingData.clientEmail || !bookingData.clientEmail.trim()) {
          console.error(`[EMAIL] ❌ Cannot send confirmation email - no customer email provided for booking ${id}`);
          console.error(`[EMAIL] Booking data:`, {
            bookingId: id,
            bookingCode: bookingData.bookingCode,
            client: bookingData.client,
            clientEmail: bookingData.clientEmail,
            clientEmailAlt: bookingData.customerEmail,
          });
        } else {
          try {
            console.log(`[EMAIL] ========================================`);
            console.log(`[EMAIL] Status transition detected: ${currentStatus} -> ${newBookingStatus} (verified: ${verifiedStatus})`);
            console.log(`[EMAIL] Booking ID: ${id}`);
            console.log(`[EMAIL] Booking Code: ${bookingData.bookingCode}`);
            console.log(`[EMAIL] Customer Name: ${clientName}`);
            console.log(`[EMAIL] Customer Email: ${bookingData.clientEmail}`);
            console.log(`[EMAIL] Owner UID: ${ownerUid}`);
            console.log(`[EMAIL] All services accepted - sending confirmation email`);
            console.log(`[EMAIL] Services count: ${updatedServices.length}`);
            console.log(`[EMAIL] ========================================`);
            
            await sendBookingStatusChangeEmail(
              id,
              "Confirmed",
              bookingData.clientEmail,
              clientName,
              ownerUid,
              {
                bookingCode: bookingData.bookingCode,
                branchName: bookingData.branchName,
                bookingDate: finalBookingDate,
                bookingTime: finalBookingTime,
                duration: bookingData.duration,
                price: bookingData.price,
                serviceName: bookingData.serviceName,
                services: updatedServices.map((s: any) => ({
                  name: s.name || "Service",
                  staffName: s.staffName || null,
                  time: s.time || finalBookingTime || null,
                  duration: s.duration || bookingData.duration || null,
                })),
                staffName: staffName,
              }
            );
            console.log(`[EMAIL] ✅ Confirmation email sent successfully for booking ${id}`);
          } catch (emailError) {
            console.error(`[EMAIL] ❌ Failed to send booking confirmation email for ${id}:`, emailError);
            console.error(`[EMAIL] Error details:`, {
              message: emailError instanceof Error ? emailError.message : String(emailError),
              stack: emailError instanceof Error ? emailError.stack : 'No stack trace',
              bookingId: id,
              customerEmail: bookingData.clientEmail,
            });
            // Don't fail the request if email sending fails
          }
        }
      } else if (newBookingStatus === "Confirmed") {
        console.log(`[EMAIL] ⚠️ Skipping email - status already Confirmed or invalid transition`);
        console.log(`[EMAIL] Current status: ${currentStatus}, New status: ${newBookingStatus}, Verified: ${verifiedStatus}`);
        console.log(`[EMAIL] Transition check:`, {
          newStatusIsConfirmed: newBookingStatus === "Confirmed",
          verifiedIsConfirmed: verifiedStatus === "Confirmed",
          currentIsAwaiting: currentStatus === "AwaitingStaffApproval",
          currentIsPartial: currentStatus === "PartiallyApproved",
          currentIsConfirmed: currentStatus === "Confirmed",
        });
      } else if (shouldAutoCancel) {
        // Booking was auto-cancelled due to no alternative staff
        // Notify admin about cancellation
        try {
          const rejectedServices = updatedServices.filter((s: any) => s.approvalStatus === "rejected");
          await db.collection("notifications").add({
            bookingId: id,
            bookingCode: bookingData.bookingCode,
            type: "booking_canceled",
            title: "Booking Auto-Cancelled",
            message: `Booking ${bookingData.bookingCode} was automatically cancelled because service(s) ${rejectedServices.map((s: any) => s.name || "Service").join(", ")} were rejected by ${staffName} and no alternative staff is available.`,
            status: "Canceled",
            ownerUid: ownerUid,
            targetRole: "admin",
            clientName: clientName,
            serviceName: servicesToUpdate.map(s => s.name).join(", "),
            services: rejectedServices.map((s: any) => ({
              name: s.name || "Service",
              staffName: s.staffName,
              staffId: s.staffId,
            })),
            branchName: bookingData.branchName,
            bookingDate: finalBookingDate,
            bookingTime: finalBookingTime,
            read: false,
            createdAt: FieldValue.serverTimestamp(),
          });
          console.log("Sent admin cancellation notification");
        } catch (e) {
          console.error("Failed to send admin notification:", e);
        }
        
        // Notify customer about cancellation
        try {
          await db.collection("notifications").add({
            customerUid: bookingData.customerUid,
            customerEmail: bookingData.clientEmail,
            customerPhone: bookingData.clientPhone,
            bookingId: id,
            bookingCode: bookingData.bookingCode,
            type: "booking_canceled",
            title: "Booking Cancelled",
            message: `Your booking ${bookingData.bookingCode} for ${servicesToUpdate.map(s => s.name || "Service").join(", ")} on ${finalBookingDate} at ${finalBookingTime} has been cancelled. We apologize for any inconvenience.`,
            status: "Canceled",
            ownerUid: ownerUid,
            clientName: clientName,
            serviceName: bookingData.serviceName,
            services: updatedServices.map((s: any) => ({
              name: s.name || "Service",
              staffName: s.staffName,
            })),
            branchName: bookingData.branchName,
            bookingDate: finalBookingDate,
            bookingTime: finalBookingTime,
            read: false,
            createdAt: FieldValue.serverTimestamp(),
          });
          console.log("Sent customer cancellation notification");
        } catch (e) {
          console.error("Failed to send customer notification:", e);
        }
      } else if (body.action === "reject") {
        // A service was rejected but alternative staff is available - notify admin for reassignment
        try {
          const rejectedServices = updatedServices.filter((s: any) => s.approvalStatus === "rejected");
          await createAdminRejectionNotification({
            bookingId: id,
            bookingCode: bookingData.bookingCode,
            ownerUid: ownerUid,
            rejectedByStaffUid: staffUid,
            rejectedByStaffName: staffName,
            rejectionReason: body.rejectionReason || "No reason provided",
            clientName: clientName,
            serviceName: servicesToUpdate.map(s => s.name).join(", "),
            services: rejectedServices.map((s: any) => ({
              name: s.name || "Service",
              staffName: s.staffName,
              staffId: s.staffId,
            })),
            branchName: bookingData.branchName,
            bookingDate: finalBookingDate,
            bookingTime: finalBookingTime,
          });
          console.log("Sent admin rejection notification for service(s)");
        } catch (e) {
          console.error("Failed to send admin notification:", e);
        }
        
        // Also notify branch admins of the rejection
        if (bookingData.branchId) {
          try {
            const branchAdminUids = await getBranchAdminUids(db, bookingData.branchId, ownerUid);
            const rejectedServices = updatedServices.filter((s: any) => s.approvalStatus === "rejected");
            const serviceList = rejectedServices.length > 0
              ? rejectedServices.map(s => s.name || "Service").join(", ")
              : servicesToUpdate.map(s => s.name).join(", ");
            
            for (const branchAdminUid of branchAdminUids) {
              // Skip if branch admin is the owner (already notified)
              if (branchAdminUid === ownerUid) continue;
              
              // Create rejection notification for branch admin (same as owner notification but with branchAdminUid)
              await db.collection("notifications").add({
                bookingId: id,
                bookingCode: bookingData.bookingCode,
                type: "staff_rejected",
                title: "Booking Rejected by Staff",
                message: `${staffName} has rejected the booking for ${clientName} (${serviceList} on ${finalBookingDate} at ${finalBookingTime}). Reason: "${body.rejectionReason || "No reason provided"}". Please reassign to another staff member.`,
                status: "StaffRejected",
                ownerUid: ownerUid,
                branchAdminUid: branchAdminUid, // Target the branch admin - CRITICAL for mobile app queries
                targetAdminUid: branchAdminUid, // Also set for mobile app queries
                branchId: bookingData.branchId, // Include branchId for branch admin filtering
                rejectedByStaffUid: staffUid,
                rejectedByStaffName: staffName,
                rejectionReason: body.rejectionReason || "No reason provided",
                clientName: clientName,
                serviceName: serviceList,
                services: rejectedServices.map((s: any) => ({
                  name: s.name || "Service",
                  staffName: s.staffName,
                  staffId: s.staffId,
                })),
                branchName: bookingData.branchName,
                bookingDate: finalBookingDate,
                bookingTime: finalBookingTime,
                read: false,
                createdAt: FieldValue.serverTimestamp(),
              });
              console.log(`Sent branch admin rejection notification to ${branchAdminUid}`);
            }
          } catch (e) {
            console.error("Failed to send branch admin notifications:", e);
          }
        }
        
        // Also notify customer that their booking is being rescheduled
        // (Customer-friendly notification without exposing staff rejection details)
        try {
          await createCustomerReschedulingNotification({
            bookingId: id,
            bookingCode: bookingData.bookingCode,
            customerUid: bookingData.customerUid,
            customerEmail: bookingData.clientEmail,
            customerPhone: bookingData.clientPhone,
            clientName: clientName,
            serviceName: bookingData.serviceName,
            services: updatedServices.map((s: any) => ({
              name: s.name || "Service",
              staffName: s.staffName,
            })),
            branchName: bookingData.branchName,
            bookingDate: finalBookingDate,
            bookingTime: finalBookingTime,
            ownerUid: ownerUid,
          });
          console.log("Sent customer rescheduling notification (multi-service)");
        } catch (e) {
          console.error("Failed to send customer notification:", e);
        }
      }

      // Determine response message
      let message = "";
      if (body.action === "accept") {
        if (newBookingStatus === "Confirmed") {
          message = "All services accepted! Booking is now confirmed. Customer has been notified.";
        } else {
          message = `Service(s) accepted. Waiting for other staff to respond. (${updatedServices.filter((s: any) => s.approvalStatus === "accepted").length}/${updatedServices.length} accepted)`;
        }
      } else {
        if (shouldAutoCancel) {
          message = "Service(s) rejected. No alternative staff available. Booking has been automatically cancelled.";
        } else {
          message = "Service(s) rejected. Admin has been notified for reassignment.";
        }
      }

      return NextResponse.json({ 
        ok: true, 
        status: newBookingStatus,
        message: message,
        servicesUpdated: servicesToUpdate.length,
        allServicesCount: services.length,
        acceptedCount: updatedServices.filter((s: any) => s.approvalStatus === "accepted").length,
        rejectedCount: updatedServices.filter((s: any) => s.approvalStatus === "rejected").length,
        pendingCount: updatedServices.filter((s: any) => !s.approvalStatus || s.approvalStatus === "pending").length,
      }, { headers: corsHeaders });

    } else {
      // Single service booking - original logic
      // Verify this staff member is assigned to this booking (check both staffId and staffAuthUid)
      const isAssignedToBooking = bookingData.staffId === staffUid || bookingData.staffAuthUid === staffUid;
      if (!isAssignedToBooking) {
      return NextResponse.json({ 
        error: "You are not assigned to this booking" 
      }, { status: 403, headers: corsHeaders });
    }

    const finalServiceName = bookingData.serviceName || null;

    if (body.action === "accept") {
      // Staff accepts the booking
      const updateData: any = {
        status: "Confirmed",
        updatedAt: FieldValue.serverTimestamp(),
        acceptedByStaffUid: staffUid,
        acceptedByStaffName: staffName,
        acceptedAt: FieldValue.serverTimestamp(),
      };

      await bookingRef.update(updateData);
      
      // IMPORTANT: Wait a moment to ensure database update is committed
      await new Promise(resolve => setTimeout(resolve, 100));

      // Create activity log
      try {
        await db.collection("bookingActivities").add({
          ownerUid: ownerUid,
          bookingId: id,
          bookingCode: bookingData.bookingCode || null,
          activityType: "booking_staff_accepted",
          clientName: clientName,
          serviceName: finalServiceName,
          branchName: bookingData.branchName || null,
          staffName: staffName,
          staffUid: staffUid,
          price: bookingData.price || null,
          date: finalBookingDate,
          time: finalBookingTime,
          previousStatus: currentStatus,
          newStatus: "Confirmed",
          createdAt: FieldValue.serverTimestamp(),
        });
      } catch (e) {
        console.error("Failed to create activity log:", e);
      }

      // Send confirmation notification to customer
      try {
        await createCustomerConfirmationNotification({
          bookingId: id,
          bookingCode: bookingData.bookingCode,
          customerUid: bookingData.customerUid,
          customerEmail: bookingData.clientEmail,
          customerPhone: bookingData.clientPhone,
          clientName: clientName,
          staffName: staffName,
          serviceName: finalServiceName,
          services: undefined,
          branchName: bookingData.branchName,
          bookingDate: finalBookingDate,
          bookingTime: finalBookingTime,
          ownerUid: ownerUid,
        });
        console.log("Sent customer confirmation notification");
      } catch (e) {
        console.error("Failed to send customer notification:", e);
      }
      
      // Send email when status changes to Confirmed (AFTER database update)
      if (currentStatus !== "Confirmed") {
        try {
          console.log(`[EMAIL] Status changed to Confirmed for booking ${id} (staff-response single service)`);
          console.log(`[EMAIL] Previous status: ${currentStatus}, New status: Confirmed`);
          await sendBookingStatusChangeEmail(
            id,
            "Confirmed",
            bookingData.clientEmail,
            clientName,
            ownerUid,
            {
              bookingCode: bookingData.bookingCode,
              branchName: bookingData.branchName,
              bookingDate: finalBookingDate,
              bookingTime: finalBookingTime,
              duration: bookingData.duration,
              price: bookingData.price,
              serviceName: finalServiceName,
              staffName: staffName,
            }
          );
          console.log(`[EMAIL] ✅ Confirmation email sent successfully for booking ${id}`);
        } catch (emailError) {
          console.error(`[EMAIL] ❌ Failed to send booking confirmation email for ${id}:`, emailError);
          console.error(`[EMAIL] Error stack:`, emailError instanceof Error ? emailError.stack : 'No stack trace');
          // Don't fail the request if email sending fails
        }
      } else {
        console.log(`[EMAIL] Skipping email - status already Confirmed`);
      }

      // Create audit log for staff acceptance (single service)
      try {
        const performer = {
          uid: staffUid,
          name: staffName,
          role: staffData?.role || "salon_staff",
        };
        await logBookingStaffResponseServer(
          ownerUid,
          id,
          bookingData.bookingCode,
          clientName,
          "accepted",
          performer,
          finalServiceName,
          undefined,
          bookingData.branchName
        );
      } catch (e) {
        console.error("Failed to create audit log:", e);
      }

      return NextResponse.json({ 
        ok: true, 
        status: "Confirmed",
        message: "Booking accepted. Customer has been notified."
      }, { headers: corsHeaders });

    } else {
      // Single service booking rejection - check for alternative staff
      let shouldAutoCancel = false;
      
      // Check if alternative staff is available for this service
      const serviceForCheck: BookingService = {
        id: bookingData.serviceId || "",
        name: finalServiceName || undefined,
        staffId: bookingData.staffId || undefined,
      };
      
      const hasAlternative = await hasAlternativeStaffAvailable(
        db,
        ownerUid,
        serviceForCheck,
        staffUid,
        bookingData.branchId || "",
        finalBookingDate || ""
      );
      
      if (!hasAlternative) {
        // No alternative staff available - cancel the booking
        shouldAutoCancel = true;
      }
      
      // Staff rejects the booking
      const finalStatus = shouldAutoCancel ? "Canceled" : "StaffRejected";
      const updateData: any = {
        status: finalStatus,
        updatedAt: FieldValue.serverTimestamp(),
        rejectedByStaffUid: staffUid,
        rejectedByStaffName: staffName,
        rejectionReason: body.rejectionReason,
        rejectedAt: FieldValue.serverTimestamp(),
      };

      // If auto-cancelled, add cancellation metadata
      if (shouldAutoCancel) {
        updateData.canceledAt = FieldValue.serverTimestamp();
        updateData.canceledReason = `Service rejected by ${staffName} and no alternative staff available`;
        updateData.canceledBy = "system";
      }

      await bookingRef.update(updateData);

      // Create activity log
      try {
        await db.collection("bookingActivities").add({
          ownerUid: ownerUid,
          bookingId: id,
          bookingCode: bookingData.bookingCode || null,
          activityType: shouldAutoCancel ? "booking_canceled" : "booking_staff_rejected",
          clientName: clientName,
          serviceName: finalServiceName,
          branchName: bookingData.branchName || null,
          staffName: staffName,
          staffUid: staffUid,
          price: bookingData.price || null,
          date: finalBookingDate,
          time: finalBookingTime,
          previousStatus: currentStatus,
          newStatus: finalStatus,
          rejectionReason: body.rejectionReason,
          ...(shouldAutoCancel ? { canceledReason: `No alternative staff available` } : {}),
          createdAt: FieldValue.serverTimestamp(),
        });
      } catch (e) {
        console.error("Failed to create activity log:", e);
      }

      // Send notifications based on whether booking was cancelled or just rejected
      if (shouldAutoCancel) {
        // Booking was auto-cancelled - notify admin and customer
        try {
          await db.collection("notifications").add({
            bookingId: id,
            bookingCode: bookingData.bookingCode,
            type: "booking_canceled",
            title: "Booking Auto-Cancelled",
            message: `Booking ${bookingData.bookingCode} was automatically cancelled because ${finalServiceName} was rejected by ${staffName} and no alternative staff is available.`,
            status: "Canceled",
            ownerUid: ownerUid,
            targetRole: "admin",
            clientName: clientName,
            serviceName: finalServiceName,
            branchName: bookingData.branchName,
            bookingDate: finalBookingDate,
            bookingTime: finalBookingTime,
            read: false,
            createdAt: FieldValue.serverTimestamp(),
          });
          console.log("Sent admin cancellation notification");
        } catch (e) {
          console.error("Failed to send admin notification:", e);
        }
        
        // Notify customer about cancellation
        try {
          await db.collection("notifications").add({
            customerUid: bookingData.customerUid,
            customerEmail: bookingData.clientEmail,
            customerPhone: bookingData.clientPhone,
            bookingId: id,
            bookingCode: bookingData.bookingCode,
            type: "booking_canceled",
            title: "Booking Cancelled",
            message: `Your booking ${bookingData.bookingCode} for ${finalServiceName} on ${finalBookingDate} at ${finalBookingTime} has been cancelled. We apologize for any inconvenience.`,
            status: "Canceled",
            ownerUid: ownerUid,
            clientName: clientName,
            serviceName: finalServiceName,
            branchName: bookingData.branchName,
            bookingDate: finalBookingDate,
            bookingTime: finalBookingTime,
            read: false,
            createdAt: FieldValue.serverTimestamp(),
          });
          console.log("Sent customer cancellation notification");
        } catch (e) {
          console.error("Failed to send customer notification:", e);
        }
      } else {
        // Service was rejected but alternative staff is available - notify admin for reassignment
        try {
          await createAdminRejectionNotification({
            bookingId: id,
            bookingCode: bookingData.bookingCode,
            ownerUid: ownerUid,
            rejectedByStaffUid: staffUid,
            rejectedByStaffName: staffName,
            rejectionReason: body.rejectionReason || "No reason provided",
            clientName: clientName,
            serviceName: finalServiceName,
            services: undefined,
            branchName: bookingData.branchName,
            bookingDate: finalBookingDate,
            bookingTime: finalBookingTime,
          });
          console.log("Sent admin rejection notification");
        } catch (e) {
          console.error("Failed to send admin notification:", e);
        }
        
        // Also notify branch admins of the rejection
        if (bookingData.branchId) {
          try {
            const branchAdminUids = await getBranchAdminUids(db, bookingData.branchId, ownerUid);
            
            for (const branchAdminUid of branchAdminUids) {
              // Skip if branch admin is the owner (already notified)
              if (branchAdminUid === ownerUid) continue;
              
              // Create rejection notification for branch admin (same as owner notification but with branchAdminUid)
              await db.collection("notifications").add({
                bookingId: id,
                bookingCode: bookingData.bookingCode,
                type: "staff_rejected",
                title: "Booking Rejected by Staff",
                message: `${staffName} has rejected the booking for ${clientName} (${finalServiceName} on ${finalBookingDate} at ${finalBookingTime}). Reason: "${body.rejectionReason || "No reason provided"}". Please reassign to another staff member.`,
                status: "StaffRejected",
                ownerUid: ownerUid,
                branchAdminUid: branchAdminUid, // Target the branch admin - CRITICAL for mobile app queries
                targetAdminUid: branchAdminUid, // Also set for mobile app queries
                branchId: bookingData.branchId, // Include branchId for branch admin filtering
                rejectedByStaffUid: staffUid,
                rejectedByStaffName: staffName,
                rejectionReason: body.rejectionReason || "No reason provided",
                clientName: clientName,
                serviceName: finalServiceName,
                branchName: bookingData.branchName,
                bookingDate: finalBookingDate,
                bookingTime: finalBookingTime,
                read: false,
                createdAt: FieldValue.serverTimestamp(),
              });
              console.log(`Sent branch admin rejection notification to ${branchAdminUid}`);
            }
          } catch (e) {
            console.error("Failed to send branch admin notifications:", e);
          }
        }
        
        // Also notify customer that their booking is being rescheduled
        // (Customer-friendly notification without exposing staff rejection details)
        try {
          await createCustomerReschedulingNotification({
            bookingId: id,
            bookingCode: bookingData.bookingCode,
            customerUid: bookingData.customerUid,
            customerEmail: bookingData.clientEmail,
            customerPhone: bookingData.clientPhone,
            clientName: clientName,
            serviceName: finalServiceName,
            branchName: bookingData.branchName,
            bookingDate: finalBookingDate,
            bookingTime: finalBookingTime,
            ownerUid: ownerUid,
          });
          console.log("Sent customer rescheduling notification (single service)");
        } catch (e) {
          console.error("Failed to send customer notification:", e);
        }
      }

      // Create audit log for staff rejection (single service)
      try {
        const performer = {
          uid: staffUid,
          name: staffName,
          role: staffData?.role || "salon_staff",
        };
        await logBookingStaffResponseServer(
          ownerUid,
          id,
          bookingData.bookingCode,
          clientName,
          "rejected",
          performer,
          finalServiceName,
          body.rejectionReason,
          bookingData.branchName
        );
      } catch (e) {
        console.error("Failed to create audit log:", e);
      }

      const responseMessage = shouldAutoCancel
        ? "Service rejected. No alternative staff available. Booking has been automatically cancelled."
        : "Booking rejected. Admin has been notified for reassignment.";
      
      return NextResponse.json({ 
        ok: true, 
        status: finalStatus,
        message: responseMessage
      }, { headers: corsHeaders });
      }
    }

  } catch (e: any) {
    console.error("Error in POST /api/bookings/[id]/staff-response:", e);
    const message = process.env.NODE_ENV === "production" ? "Internal error" : e?.message || "Internal error";
    return NextResponse.json({ error: message }, { status: 500, headers: corsHeaders });
  }
}
