import { NextRequest, NextResponse } from "next/server";
import { adminAuth, adminDb, adminMessaging } from "@/lib/firebaseAdmin";
import { FieldValue, Firestore, FieldPath } from "firebase-admin/firestore";
import { Message } from "firebase-admin/messaging";
import { normalizeBookingStatus, shouldBlockSlots } from "@/lib/bookingTypes";
import { generateBookingCode } from "@/lib/bookings";
import { checkRateLimit, getClientIdentifier, RateLimiters, getRateLimitHeaders } from "@/lib/rateLimiterDistributed";
import { logBookingCreatedServer } from "@/lib/auditLogServer";
import { createStaffAssignmentNotification, createOwnerNotification } from "@/lib/notifications";
import { sendBookingRequestReceivedEmail, sendBookingEmail } from "@/lib/emailService";

export const runtime = "nodejs";

/**
 * Check if a staff ID represents "Any Staff" (unassigned)
 */
function isAnyStaff(staffId?: string | null): boolean {
  if (!staffId) return true; // null, undefined, or empty
  const str = String(staffId).trim().toLowerCase();
  return str === "" || str === "null" || str.includes("any");
}

/**
 * Get the day-of-week name for a date string (YYYY-MM-DD).
 * Uses noon to avoid timezone boundary issues.
 */
function getDayOfWeek(dateStr: string): string {
  const dateObj = new Date(dateStr + "T12:00:00");
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  return days[dateObj.getDay()];
}

/**
 * Check if a staff member is assigned to a branch on a given day,
 * considering weeklySchedule first, then falling back to primary branchId.
 */
function isStaffAssignedToBranch(staff: any, branchId: string, dayOfWeek: string): boolean {
  if (dayOfWeek && staff.weeklySchedule && typeof staff.weeklySchedule === "object") {
    const daySchedule = staff.weeklySchedule[dayOfWeek];
    if (daySchedule && daySchedule.branchId) {
      return daySchedule.branchId === branchId;
    }
    if (daySchedule === null || daySchedule === undefined) {
      return false;
    }
  }
  return staff.branchId === branchId;
}

/**
 * Check if a booking has "Any Staff" assignments
 */
function hasAnyStaffBooking(
  services?: Array<{ staffId?: string | null; staffName?: string | null }> | null,
  staffId?: string | null,
  staffName?: string | null
): boolean {
  // Check services array for multi-service bookings
  if (services && Array.isArray(services) && services.length > 0) {
    return services.some(s => {
      // Check both staffId and staffName for "Any Staff" indicators
      const hasAnyStaffId = isAnyStaff(s.staffId);
      const hasAnyStaffName = !!(s.staffName && (
        s.staffName.toLowerCase().includes("any available") ||
        s.staffName.toLowerCase().includes("any staff") ||
        s.staffName.toLowerCase() === "any"
      ));
      return hasAnyStaffId || hasAnyStaffName;
    });
  }
  // Single service booking - check both staffId and staffName
  const hasAnyStaffId = isAnyStaff(staffId);
  const hasAnyStaffName = !!(staffName && (
    staffName.toLowerCase().includes("any available") ||
    staffName.toLowerCase().includes("any staff") ||
    staffName.toLowerCase() === "any"
  ));
  return hasAnyStaffId || hasAnyStaffName;
}

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

/**
 * Get FCM token for a user
 */
async function getUserFcmToken(db: Firestore, userUid: string): Promise<string | null> {
  try {
    // Check users collection first
    const userDoc = await db.collection("users").doc(userUid).get();
    if (userDoc.exists) {
      const userData = userDoc.data();
      if (userData?.fcmToken) {
        return userData.fcmToken;
      }
    }
    
    // Also check salon_staff collection
    const staffDoc = await db.collection("salon_staff").doc(userUid).get();
    if (staffDoc.exists) {
      const staffData = staffDoc.data();
      if (staffData?.fcmToken) {
        return staffData.fcmToken;
      }
    }
    
    return null;
  } catch (error) {
    console.error("Error getting FCM token for user:", userUid, error);
    return null;
  }
}

/**
 * Send FCM push notification
 */
async function sendPushNotification(
  fcmToken: string,
  title: string,
  body: string,
  data?: Record<string, string>
): Promise<void> {
  try {
    const messaging = adminMessaging();
    
    const message: Message = {
      token: fcmToken,
      notification: {
        title,
        body,
      },
      data: data || {},
      android: {
        priority: "high",
        ttl: 86400000, // 24 hours in milliseconds
        notification: {
          sound: "default",
          channelId: "appointments",
          priority: "high",
          defaultSound: true,
          defaultVibrateTimings: true,
        },
      },
      apns: {
        headers: {
          "apns-priority": "10", // High priority for immediate delivery
          "apns-push-type": "alert",
        },
        payload: {
          aps: {
            alert: {
              title,
              body,
            },
            sound: "default",
            badge: 1,
            "content-available": 1, // Wake up app in background
            "mutable-content": 1,   // Allow notification modification
          },
        },
      },
    };

    await messaging.send(message);
    console.log("✅ Push notification sent successfully");
  } catch (error: any) {
    // Don't throw error - push notification failure shouldn't break notification creation
    console.error("⚠️ Error sending push notification:", error?.message || error);
    if (error?.code === "messaging/invalid-registration-token" || 
        error?.code === "messaging/registration-token-not-registered") {
      console.log("Invalid FCM token detected, but continuing with notification creation");
    }
  }
}

type CreateBookingInput = {
  client: string;
  clientEmail?: string;
  clientPhone?: string;
  notes?: string;
  serviceId: string | number;
  serviceName?: string;
  staffId: string;
  staffName?: string;
  branchId: string;
  branchName?: string;
  branchTimezone?: string; // IANA timezone for the branch
  date: string; // YYYY-MM-DD in branch's local timezone
  time: string; // HH:mm in branch's local timezone
  dateTimeUtc?: string; // ISO string in UTC for consistent storage
  duration: number;
  status?: string;
  price: number;
  services?: any[];
};

export async function POST(req: NextRequest) {
  try {
    // Security: Distributed rate limiting to prevent booking spam
    // Works across all serverless instances (Vercel, etc.)
    const clientId = getClientIdentifier(req);
    const rateLimitResult = await checkRateLimit(clientId, RateLimiters.booking);
    
    if (!rateLimitResult.success) {
      return NextResponse.json(
        { 
          error: "Too many booking requests. Please try again later.",
          retryAfter: rateLimitResult.retryAfter,
        },
        { 
          status: 429,
          headers: getRateLimitHeaders(rateLimitResult),
        }
      );
    }

    // Security: Limit request size to prevent DoS attacks (CVE-2025-55184)
    const contentLength = req.headers.get("content-length");
    if (contentLength && parseInt(contentLength) > 1024 * 1024) { // 1MB limit
      return NextResponse.json({ error: "Request too large" }, { status: 413 });
    }

    const authHeader = req.headers.get("authorization") || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    let ownerUid: string;
    let currentUserId: string;
    try {
      const decoded = await adminAuth().verifyIdToken(token);
      currentUserId = decoded.uid;
      
      // Check if user is a branch admin or staff - if so, use their ownerUid
      const userDoc = await adminDb().doc(`users/${currentUserId}`).get();
      const userData = userDoc.data();
      
      if (userData) {
        const userRole = userData.role || userData.systemRole;
        // For branch admins and staff, use their ownerUid field (the salon owner's UID)
        if ((userRole === "salon_branch_admin" || userRole === "salon_staff") && userData.ownerUid) {
          ownerUid = userData.ownerUid;
        } else {
          // For salon owners, use their own UID
          ownerUid = currentUserId;
        }
      } else {
        ownerUid = currentUserId;
      }
    } catch (e) {
      // In development, allow no-op response so the client-side fallback can persist
      if (process.env.NODE_ENV !== "production") {
        return NextResponse.json({ id: "DEV_LOCAL", devNoop: true });
      }
      throw e;
    }

    const body = (await req.json()) as Partial<CreateBookingInput>;

    // Basic validation
    const required: Array<keyof CreateBookingInput> = [
      "client",
      "serviceId",
      // "staffId", // Optional for multi-service bookings
      "branchId",
      "date",
      "time",
      "duration",
      "price",
    ];
    for (const key of required) {
      if ((body as any)?.[key] === undefined || (body as any)?.[key] === null || (String((body as any)[key]).trim() === "" && typeof (body as any)[key] !== "number")) {
        return NextResponse.json({ error: `Missing field: ${key}` }, { status: 400 });
      }
    }

    // Enrich names and timezone if not provided
    let serviceName = body.serviceName || null;
    let staffName = body.staffName || null;
    let branchName = body.branchName || null;
    let branchTimezone = body.branchTimezone || null;

    try {
      if (!serviceName && body.serviceId) {
        // If multiple services (string with comma), skip lookup or fetch first
        if (String(body.serviceId).includes(",")) {
          // already provided or will be null
        } else {
          const s = await adminDb().doc(`services/${String(body.serviceId)}`).get();
          serviceName = (s.data() as any)?.name || null;
        }
      }
    } catch {}
    try {
      if (!staffName && body.staffId) {
        const st = await adminDb().doc(`salon_staff/${String(body.staffId)}`).get();
        staffName = (st.data() as any)?.name || null;
      }
    } catch {}
    try {
      if ((!branchName || !branchTimezone) && body.branchId) {
        const b = await adminDb().doc(`branches/${String(body.branchId)}`).get();
        const branchData = b.data() as any;
        if (!branchName) branchName = branchData?.name || null;
        if (!branchTimezone) branchTimezone = branchData?.timezone || "Australia/Sydney"; // Default fallback
      }
    } catch {}

    // Determine booking source based on user role
    // We need to fetch the current user's data (not the owner) for the booking source
    let bookingSource = "AdminBooking";
    try {
      const currentUserDoc = await adminDb().doc(`users/${currentUserId}`).get();
      const currentUserData = currentUserDoc.data();
      if (currentUserData) {
        const userRole = currentUserData.role || currentUserData.systemRole;
        const userBranchName = currentUserData.branchName || branchName;
        const userName = currentUserData.displayName || currentUserData.name || "Staff";
        
        if (userRole === "salon_branch_admin") {
          bookingSource = `Branch Admin Booking - ${userBranchName || "Unknown Branch"}`;
        } else if (userRole === "salon_owner") {
          bookingSource = "Salon Owner Booking";
        } else if (userRole === "salon_staff") {
          // For staff bookings, show the staff member's name instead of branch
          bookingSource = `Staff Booking - ${userName}`;
        }
      }
    } catch (roleError) {
      console.error("Failed to get user role for booking source:", roleError);
    }

    // Validate that the requested time slots are not already booked
    const db = adminDb();
    const dateStr = String(body.date);
    
    // Helper function to check if two time ranges overlap
    const timeRangesOverlap = (
      start1: number, end1: number,
      start2: number, end2: number
    ): boolean => {
      // Overlap occurs if: start1 < end2 && start2 < end1
      return start1 < end2 && start2 < end1;
    };

    // Helper function to parse time string to minutes
    const timeToMinutes = (timeStr: string): number => {
      const parts = timeStr.split(':').map(Number);
      if (parts.length < 2) return 0;
      return parts[0] * 60 + parts[1];
    };

    // Use centralized helper to check if booking status should block slots
    const isActiveStatus = (status: string | undefined): boolean => {
      return shouldBlockSlots(status);
    };

    // Check for existing bookings that would conflict
    try {
      // Query bookings for the same date
      const bookingsQuery = db.collection("bookings")
        .where("ownerUid", "==", ownerUid)
        .where("date", "==", dateStr);
      
      const bookingRequestsQuery = db.collection("bookingRequests")
        .where("ownerUid", "==", ownerUid)
        .where("date", "==", dateStr);

      const [bookingsSnapshot, bookingRequestsSnapshot] = await Promise.all([
        bookingsQuery.get().catch(() => ({ docs: [] })),
        bookingRequestsQuery.get().catch(() => ({ docs: [] }))
      ]);

      // Combine results from both collections
      const allExistingBookings: Array<any> = [
        ...bookingsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })),
        ...bookingRequestsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }))
      ];

      // Check each service in the new booking request
      const servicesToCheck = body.services && Array.isArray(body.services) && body.services.length > 0
        ? body.services
        : [{
            id: body.serviceId,
            time: body.time,
            duration: body.duration,
            staffId: body.staffId || null
          }];

      // ----- Pre-fetch eligible staff for "Any Staff" services -----
      const hasAnyStaffService = servicesToCheck.some((s: any) => isAnyStaff(s.staffId || body.staffId));
      let eligibleStaffByService: Record<string, string[]> = {};

      if (hasAnyStaffService) {
        const dayOfWeek = getDayOfWeek(dateStr);

        const [staffSnapshot, servicesSnapshot] = await Promise.all([
          db.collection("users")
            .where("ownerUid", "==", ownerUid)
            .get()
            .catch(() => ({ docs: [] as any[] })),
          db.collection("services")
            .where("ownerUid", "==", ownerUid)
            .get()
            .catch(() => ({ docs: [] as any[] })),
        ]);

        const allStaff = (staffSnapshot.docs || []).map((d: any) => ({ id: d.id, ...d.data() }));
        const allServicesData = (servicesSnapshot.docs || []).map((d: any) => ({ id: d.id, ...d.data() }));

        for (const svc of servicesToCheck) {
          const svcStaffId = svc.staffId || body.staffId;
          if (!isAnyStaff(svcStaffId)) continue; // Skip specific staff services

          const serviceId = svc.id || svc.serviceId || body.serviceId;
          const serviceData = allServicesData.find((s: any) => String(s.id) === String(serviceId));

          const eligible = allStaff.filter((st: any) => {
            const role = (st.role || "").toString().toLowerCase();
            if (role !== "salon_staff" && role !== "salon_branch_admin") return false;
            if (st.status && st.status !== "Active") return false;

            // Check service capability
            if (serviceData?.staffIds && serviceData.staffIds.length > 0) {
              const canPerform = serviceData.staffIds.some((id: string) =>
                String(id) === st.id || String(id) === (st.uid || st.id)
              );
              if (!canPerform) return false;
            }

            // Check branch assignment (weeklySchedule + primary branchId)
            return isStaffAssignedToBranch(st, String(body.branchId), dayOfWeek);
          });

          eligibleStaffByService[String(serviceId)] = eligible.map((s: any) => s.id);
          console.log(`[ADMIN BOOKING] Service ${serviceId}: ${eligible.length} eligible staff [${eligible.map((s: any) => s.id).join(', ')}] (day=${dayOfWeek})`);
        }
      }

      for (const newService of servicesToCheck) {
        const newServiceTime = newService.time || body.time;
        const newServiceDuration = newService.duration || body.duration;
        const newServiceStaffId = newService.staffId || body.staffId || null;

        if (!newServiceTime) continue;

        const newStartMinutes = timeToMinutes(newServiceTime);
        const newEndMinutes = newStartMinutes + newServiceDuration;
        const newIsAnyStaff = isAnyStaff(newServiceStaffId);

        if (newIsAnyStaff) {
          // ── "Any Staff" mode ──
          // Only block if ALL eligible staff are occupied at this time.
          const serviceId = newService.id || newService.serviceId || body.serviceId;
          const eligibleIds = eligibleStaffByService[String(serviceId)] || [];

          if (eligibleIds.length === 0) {
            // No eligible staff data available – skip validation
            continue;
          }

          const bookedStaffIds = new Set<string>();
          let anyStaffBookingsOverlapping = 0;

          for (const existingBooking of allExistingBookings) {
            if (!isActiveStatus(existingBooking.status)) continue;

            if (existingBooking.services && Array.isArray(existingBooking.services) && existingBooking.services.length > 0) {
              for (const existingService of existingBooking.services) {
                if (!existingService.time) continue;
                const existingServiceStaffId = existingService.staffId || existingBooking.staffId || null;
                const existingStartMinutes = timeToMinutes(existingService.time);
                const existingDuration = existingService.duration || existingBooking.duration || 60;
                const existingEndMinutes = existingStartMinutes + existingDuration;

                if (!timeRangesOverlap(newStartMinutes, newEndMinutes, existingStartMinutes, existingEndMinutes)) continue;

                if (!isAnyStaff(existingServiceStaffId)) {
                  if (eligibleIds.includes(existingServiceStaffId!)) {
                    bookedStaffIds.add(existingServiceStaffId!);
                  }
                } else {
                  anyStaffBookingsOverlapping++;
                }
              }
            } else {
              if (!existingBooking.time) continue;
              const existingStaffId = existingBooking.staffId || null;
              const existingStartMinutes = timeToMinutes(existingBooking.time);
              const existingDuration = existingBooking.duration || 60;
              const existingEndMinutes = existingStartMinutes + existingDuration;

              if (!timeRangesOverlap(newStartMinutes, newEndMinutes, existingStartMinutes, existingEndMinutes)) continue;

              if (!isAnyStaff(existingStaffId)) {
                if (eligibleIds.includes(existingStaffId!)) {
                  bookedStaffIds.add(existingStaffId!);
                }
              } else {
                anyStaffBookingsOverlapping++;
              }
            }
          }

          const freeStaff = eligibleIds.length - bookedStaffIds.size - anyStaffBookingsOverlapping;
          if (freeStaff <= 0) {
            console.log(`[BOOKING CONFLICT] All ${eligibleIds.length} eligible staff are booked at ${newServiceTime} (${bookedStaffIds.size} specific + ${anyStaffBookingsOverlapping} any-staff)`);
            return NextResponse.json(
              {
                error: "Time slot fully booked",
                details: `All available staff members are booked at ${newServiceTime}. Please choose a different time.`,
              },
              { status: 409 }
            );
          }

          // This "Any Staff" service passed — at least one staff member is free
          continue;
        }

        // ── Specific staff mode ──
        // Check against all existing bookings for the same specific staff
        for (const existingBooking of allExistingBookings) {
          // Skip if booking is not active
          if (!isActiveStatus(existingBooking.status)) continue;

          // Check if this is a multi-service booking
          if (existingBooking.services && Array.isArray(existingBooking.services) && existingBooking.services.length > 0) {
            // Check each service in the existing booking
            for (const existingService of existingBooking.services) {
              if (!existingService.time) continue;
              
              const existingServiceStaffId = existingService.staffId || existingBooking.staffId || null;
              
              // Only conflict if same specific staff, or existing is "any staff" (could be assigned to our staff)
              if (!isAnyStaff(existingServiceStaffId) && newServiceStaffId !== existingServiceStaffId) continue;

              const existingStartMinutes = timeToMinutes(existingService.time);
              const existingDuration = existingService.duration || existingBooking.duration || 60;
              const existingEndMinutes = existingStartMinutes + existingDuration;

              // Check for overlap
              if (timeRangesOverlap(newStartMinutes, newEndMinutes, existingStartMinutes, existingEndMinutes)) {
                return NextResponse.json(
                  { 
                    error: "Time slot already booked",
                    details: `The selected time ${newServiceTime} conflicts with an existing booking. Please choose a different time.`
                  },
                  { status: 409 } // 409 Conflict
                );
              }
            }
          } else {
            // Single-service booking
            if (!existingBooking.time) continue;

            const existingStaffId = existingBooking.staffId || null;
            
            // Only conflict if same specific staff, or existing is "any staff"
            if (!isAnyStaff(existingStaffId) && newServiceStaffId !== existingStaffId) continue;

            const existingStartMinutes = timeToMinutes(existingBooking.time);
            const existingDuration = existingBooking.duration || 60;
            const existingEndMinutes = existingStartMinutes + existingDuration;

            // Check for overlap
            if (timeRangesOverlap(newStartMinutes, newEndMinutes, existingStartMinutes, existingEndMinutes)) {
              return NextResponse.json(
                { 
                  error: "Time slot already booked",
                  details: `The selected time ${newServiceTime} conflicts with an existing booking. Please choose a different time.`
                },
                { status: 409 } // 409 Conflict
              );
            }
          }
        }
      }
    } catch (validationError: any) {
      // Log the error but don't fail the booking if validation query fails
      // This is a safety check, so we'll proceed if we can't verify
      console.error("Error validating booking availability:", validationError);
      // In production, you might want to be more strict and reject the booking
      // For now, we'll proceed but log the error
    }

    const bookingCode = generateBookingCode();
    
    // Determine if this is a staff-created booking (auto-confirm)
    let finalStatus = normalizeBookingStatus(body.status || "Pending");
    let processedServices = body.services || null;
    
    // Check if user is staff, salon_owner, or salon_branch_admin for auto-confirmation logic
    try {
      const currentUserDoc = await adminDb().doc(`users/${currentUserId}`).get();
      const currentUserData = currentUserDoc.data();
      if (currentUserData) {
        const userRole = currentUserData.role || currentUserData.systemRole;
        
        if (userRole === "salon_staff") {
          // Auto-confirm staff bookings (all services accepted immediately)
          finalStatus = "Confirmed";
          
          // Mark services as accepted if services array exists
          if (processedServices && Array.isArray(processedServices) && processedServices.length > 0) {
            processedServices = processedServices.map((service: any) => ({
              ...service,
              approvalStatus: "accepted",
            }));
          }
        } else if (userRole === "salon_owner" || userRole === "salon_branch_admin") {
          // For salon_owner and salon_branch_admin: skip Pending status
          // If services have staff assigned, go directly to AwaitingStaffApproval
          // If all services need assignment, still go to AwaitingStaffApproval (not Pending)
          
          // Initialize services with approval status
          if (processedServices && Array.isArray(processedServices) && processedServices.length > 0) {
            processedServices = processedServices.map((service: any) => {
              const hasStaff = service.staffId && service.staffId !== "null" && 
                               !String(service.staffId).toLowerCase().includes("any");
              return {
                ...service,
                // Services with valid staff get "pending" approval status
                // Services without staff (Any Available) get "needs_assignment" status
                approvalStatus: hasStaff ? "pending" : "needs_assignment",
              };
            });
            
            // Check if any service has staff assigned
            const hasAnyAssignedStaff = processedServices.some((s: any) => 
              s.approvalStatus === "pending"
            );
            
            // Skip Pending status - go directly to AwaitingStaffApproval
            if (hasAnyAssignedStaff || processedServices.some((s: any) => s.approvalStatus === "needs_assignment")) {
              finalStatus = "AwaitingStaffApproval";
            }
          } else if (body.staffId && body.staffId !== "null" && 
                     !String(body.staffId).toLowerCase().includes("any")) {
            // Single service booking with staff assigned - skip Pending
            finalStatus = "AwaitingStaffApproval";
          } else {
            // Single service booking without staff - still skip Pending for owner/admin
            finalStatus = "AwaitingStaffApproval";
          }
        }
      }
    } catch (roleError) {
      console.error("Failed to check user role for auto-confirmation:", roleError);
    }
    
    const payload: any = {
      ownerUid,
      client: String(body.client),
      clientEmail: body.clientEmail || null,
      clientPhone: body.clientPhone || null,
      notes: body.notes || null,
      serviceId: typeof body.serviceId === "number" ? body.serviceId : String(body.serviceId),
      serviceName: serviceName,
      staffId: body.staffId ? String(body.staffId) : null,
      staffName: staffName,
      branchId: String(body.branchId),
      branchName: branchName,
      branchTimezone: branchTimezone, // Store branch timezone
      date: String(body.date), // YYYY-MM-DD in branch's local timezone (for backward compatibility)
      time: String(body.time), // HH:mm in branch's local timezone (for backward compatibility)
      dateTimeUtc: body.dateTimeUtc || null, // UTC ISO string for consistent storage
      duration: Number(body.duration) || 0,
      status: finalStatus,
      price: Number(body.price) || 0,
      services: processedServices,
      bookingSource: bookingSource,
      bookingCode: bookingCode,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };

    try {
      const ref = await adminDb().collection("bookings").add(payload);
      
      // Create booking activity log for new booking
      try {
        await adminDb().collection("bookingActivities").add({
          ownerUid: ownerUid,
          bookingId: ref.id,
          bookingCode: bookingCode,
          activityType: "booking_created",
          clientName: String(body.client),
          serviceName: serviceName,
          branchName: branchName,
          staffName: staffName,
          price: Number(body.price) || 0,
          date: String(body.date),
          time: String(body.time),
          previousStatus: null,
          newStatus: normalizeBookingStatus(body.status || "Pending"),
          createdAt: FieldValue.serverTimestamp(),
        });
      } catch (activityError) {
        console.error("Failed to create booking activity:", activityError);
        // Don't fail the request if activity creation fails
      }
      
      // Create audit log for booking creation
      try {
        // Get user info for audit log
        let performerName = "User";
        let performerRole = "unknown";
        try {
          const userDoc = await adminDb().doc(`users/${currentUserId}`).get();
          const userData = userDoc.data();
          if (userData) {
            performerName = userData.displayName || userData.name || "User";
            performerRole = userData.role || userData.systemRole || "unknown";
          }
        } catch (userError) {
          console.error("Failed to get user data for audit log:", userError);
        }
        
        await logBookingCreatedServer(
          ownerUid,
          ref.id,
          bookingCode,
          String(body.client),
          serviceName || "Service",
          branchName || undefined,
          staffName || undefined,
          {
            uid: currentUserId,
            name: performerName,
            role: performerRole,
          },
          {
            price: Number(body.price) || 0,
            duration: Number(body.duration) || 0,
            date: String(body.date),
            time: String(body.time),
            notes: body.notes || undefined,
            bookingSource: bookingSource,
            clientEmail: body.clientEmail || undefined,
            clientPhone: body.clientPhone || undefined,
          }
        );
      } catch (auditError) {
        console.error("Failed to create audit log for booking creation:", auditError);
        // Don't fail the request if audit log creation fails
      }
      
      // Send email to customer when booking is created (Request Received)
      // IMPORTANT: Always send email for new bookings, regardless of status
      // For "AwaitingStaffApproval" status (branch admin/owner bookings), send "Pending" email
      // For "Confirmed" status (staff bookings), send "Confirmed" email
      // For "Pending" status, send "Pending" email
      try {
        // Handle email field from various sources (mobile app might send it differently)
        let customerEmail: string | null = null;
        if (body.clientEmail) {
          const trimmed = String(body.clientEmail).trim();
          customerEmail = trimmed.length > 0 ? trimmed : null;
        }
        
        // Get user role for logging
        let userRole = 'unknown';
        try {
          const currentUserDoc = await adminDb().doc(`users/${currentUserId}`).get();
          const currentUserData = currentUserDoc.data();
          if (currentUserData) {
            userRole = currentUserData.role || currentUserData.systemRole || 'unknown';
          }
        } catch (e) {
          // Ignore error, use default
        }
        
        console.log(`[BOOKING] Attempting to send email for booking ${ref.id}`, {
          clientEmail: customerEmail,
          clientEmailRaw: body.clientEmail,
          clientEmailType: typeof body.clientEmail,
          client: body.client,
          bookingCode,
          finalStatus,
          hasEmail: !!customerEmail,
          userRole: userRole,
        });
        
        // Determine email status based on booking status
        // "AwaitingStaffApproval" should send a "Pending" email (booking is waiting for approval)
        // "Confirmed" should send a "Confirmed" email
        // "Pending" should send a "Pending" email
        let emailStatus: "Pending" | "Confirmed" = "Pending";
        if (finalStatus === "Confirmed") {
          emailStatus = "Confirmed";
        } else {
          // For "AwaitingStaffApproval" and "Pending", send "Pending" email
          emailStatus = "Pending";
        }
        
        // Use sendBookingEmail directly to send with the correct status
        // This ensures emails are sent for all statuses, including "AwaitingStaffApproval"
        // Only send email if customer email is provided and valid
        if (customerEmail && customerEmail.length > 0) {
          console.log(`[BOOKING] Sending ${emailStatus} email to ${customerEmail} for booking ${ref.id}`);
          
          const emailResult = await sendBookingEmail({
            bookingId: ref.id,
            bookingCode: bookingCode || undefined,
            customerEmail: customerEmail,
            customerName: String(body.client),
            status: emailStatus,
            ownerUid,
            branchName: branchName || null,
            bookingDate: String(body.date),
            bookingTime: String(body.time),
            duration: Number(body.duration) || null,
            price: Number(body.price) || null,
            serviceName: serviceName || null,
            services: processedServices?.map((s: any) => ({
              name: s.name || "Service",
              staffName: s.staffName || null,
              time: s.time || String(body.time),
              duration: s.duration || Number(body.duration) || null,
            })),
            staffName: staffName || null,
          });
          
          if (emailResult.success) {
            console.log(`[BOOKING] ✅ Email sending completed for booking ${ref.id} with status ${emailStatus}`);
          } else {
            console.error(`[BOOKING] ❌ Email sending failed for booking ${ref.id}:`, emailResult.error);
            console.error(`[BOOKING] Email error details:`, {
              bookingId: ref.id,
              bookingCode,
              customerEmail,
              emailStatus,
              error: emailResult.error,
            });
          }
        } else {
          console.warn(`[BOOKING] ⚠️ No customer email provided for booking ${ref.id}, skipping email`, {
            bookingId: ref.id,
            bookingCode,
            client: body.client,
            clientEmail: body.clientEmail,
          });
        }
      } catch (emailError: any) {
        console.error(`[BOOKING] ❌ Exception while sending booking email for ${ref.id}:`, emailError);
        console.error(`[BOOKING] Error details:`, {
          message: emailError?.message,
          stack: emailError?.stack,
          bookingId: ref.id,
          bookingCode,
          finalStatus,
        });
        // Don't fail the request if email sending fails
      }
      
      // Send notifications to assigned staff members if booking requires approval
      if (finalStatus === "AwaitingStaffApproval") {
        try {
          const staffToNotify: Array<{ uid: string; name: string }> = [];
          
          // Collect staff members to notify from services array
          if (processedServices && Array.isArray(processedServices) && processedServices.length > 0) {
            for (const svc of processedServices) {
              // Only notify staff who have actual assignments (not "Any Available")
              if (svc.staffId && svc.staffId !== "null" && 
                  !String(svc.staffId).toLowerCase().includes("any")) {
                const existing = staffToNotify.find(s => s.uid === svc.staffId);
                if (!existing) {
                  staffToNotify.push({ 
                    uid: svc.staffId, 
                    name: svc.staffName || "Staff" 
                  });
                }
              }
            }
          } else if (body.staffId && body.staffId !== "null" && 
                     !String(body.staffId).toLowerCase().includes("any")) {
            // Single staff assignment
            staffToNotify.push({ 
              uid: body.staffId, 
              name: body.staffName || "Staff" 
            });
          }
          
          // Send notification to each assigned staff member
          for (const staff of staffToNotify) {
            await createStaffAssignmentNotification({
              bookingId: ref.id,
              bookingCode: bookingCode,
              staffUid: staff.uid,
              staffName: staff.name,
              clientName: String(body.client),
              clientPhone: body.clientPhone || undefined,
              serviceName: serviceName || undefined,
              services: processedServices?.map((s: any) => ({
                name: s.name || "Service",
                staffName: s.staffName || undefined,
                staffId: s.staffId || undefined,
              })),
              branchName: branchName || undefined,
              bookingDate: String(body.date),
              bookingTime: String(body.time),
              duration: Number(body.duration) || 0,
              price: Number(body.price) || 0,
              ownerUid: ownerUid,
            });
          }
          
          if (staffToNotify.length > 0) {
            console.log(`✅ Sent staff assignment notifications to ${staffToNotify.length} staff member(s) for booking ${bookingCode}`);
          }
        } catch (notifError) {
          console.error("❌ Failed to send staff assignment notifications:", notifError);
          // Don't fail the request if notification sending fails
        }
      }
      
      // Send notifications to owner and branch admins for "Any Staff" bookings
      const hasAnyStaff = hasAnyStaffBooking(processedServices, body.staffId, body.staffName);
      console.log(`📋 Booking ${bookingCode}: Checking for Any Staff booking - hasAnyStaff: ${hasAnyStaff}, staffId: ${body.staffId}, staffName: ${body.staffName}, processedServices: ${JSON.stringify(processedServices?.map(s => ({ name: s.name, staffId: s.staffId, staffName: s.staffName })))}`);
      
      if (hasAnyStaff) {
        try {
          const serviceList = processedServices && Array.isArray(processedServices) && processedServices.length > 0
            ? processedServices.map(s => s.name || "Service").join(", ")
            : serviceName || "Service";
          
          console.log(`📋 Booking ${bookingCode}: Detected Any Staff booking - notifying owner and branch admins`);
          
          // Notify salon owner
          await createOwnerNotification({
            bookingId: ref.id,
            bookingCode: bookingCode,
            ownerUid: ownerUid,
            clientName: String(body.client),
            serviceName: serviceName || undefined,
            services: processedServices?.map((s: any) => ({
              name: s.name || "Service",
              staffName: s.staffName || undefined,
              staffId: s.staffId || undefined,
            })),
            branchName: branchName || undefined,
            branchId: String(body.branchId),
            bookingDate: String(body.date),
            bookingTime: String(body.time),
            type: "booking_needs_assignment",
            status: finalStatus,
          });
          console.log(`✅ Booking ${bookingCode}: Owner notified for "Any Staff" booking`);
          
          // Notify all branch admins for this branch
          console.log(`📋 Booking ${bookingCode}: Looking up branch admins for branchId: ${body.branchId}, ownerUid: ${ownerUid}`);
          const branchAdminUids = await getBranchAdminUids(db, String(body.branchId), ownerUid);
          console.log(`📋 Booking ${bookingCode}: Found ${branchAdminUids.length} branch admin(s): ${branchAdminUids.join(", ")}`);
          
          for (const branchAdminUid of branchAdminUids) {
            // Skip if branch admin is the owner
            if (branchAdminUid === ownerUid) {
              console.log(`⏭️ Booking ${bookingCode}: Skipping branch admin ${branchAdminUid} (is owner)`);
              continue;
            }
            
            console.log(`📋 Booking ${bookingCode}: Creating notification for branch admin ${branchAdminUid}`);
            console.log(`📋 Booking ${bookingCode}: Branch admin details - branchId: ${body.branchId}, ownerUid: ${ownerUid}`);
            
            // Use createBranchAdminNotification helper to ensure proper notification creation and push
            try {
              const { createBranchAdminNotification } = await import("@/lib/notifications");
              const notificationId = await createBranchAdminNotification({
                bookingId: ref.id,
                bookingCode: bookingCode,
                branchAdminUid: branchAdminUid,
                ownerUid: ownerUid,
                clientName: String(body.client),
                serviceName: serviceName || undefined,
                services: processedServices?.map((s: any) => ({
                  name: s.name || "Service",
                  staffName: s.staffName || "Needs Assignment",
                  staffId: s.staffId || undefined,
                })),
                branchName: branchName || undefined,
                branchId: String(body.branchId), // CRITICAL: Must be a string, not null
                bookingDate: String(body.date),
                bookingTime: String(body.time),
                status: finalStatus,
                type: "booking_needs_assignment", // Explicitly set type for "any-staff" bookings
              });
              
              console.log(`📋 Booking ${bookingCode}: createBranchAdminNotification called with branchAdminUid: ${branchAdminUid}, branchId: ${body.branchId}`);
              console.log(`✅ Booking ${bookingCode}: Branch admin ${branchAdminUid} notification created with ID: ${notificationId}`);
              
              // Verify the notification was created correctly by reading it back
              let notificationData: any = null;
              try {
                const verifyNotif = await db.collection("notifications").doc(notificationId).get();
                if (verifyNotif.exists) {
                  notificationData = verifyNotif.data();
                  console.log(`✅ Booking ${bookingCode}: Verified notification exists - branchAdminUid: ${notificationData?.branchAdminUid}, targetAdminUid: ${notificationData?.targetAdminUid}, branchId: ${notificationData?.branchId}, type: ${notificationData?.type}`);
                  
                  if (notificationData?.branchAdminUid !== branchAdminUid) {
                    console.error(`❌ Booking ${bookingCode}: WARNING - branchAdminUid mismatch! Expected: ${branchAdminUid}, Got: ${notificationData?.branchAdminUid}`);
                  }
                  if (!notificationData?.branchId || notificationData.branchId !== String(body.branchId)) {
                    console.error(`❌ Booking ${bookingCode}: WARNING - branchId missing or incorrect! Expected: ${body.branchId}, Got: ${notificationData?.branchId}`);
                  }
                  
                  // CRITICAL: Test if the notification can be queried by the mobile app's query
                  // This verifies the notification structure is correct for mobile app queries
                  try {
                    const testQuery = await db.collection("notifications")
                      .where("branchAdminUid", "==", branchAdminUid)
                      .limit(1)
                      .get();
                    
                    const foundNotification = testQuery.docs.find(doc => doc.id === notificationId);
                    if (!foundNotification) {
                      console.error(`❌ Booking ${bookingCode}: CRITICAL - Notification cannot be queried by branchAdminUid!`);
                      console.error(`❌ Booking ${bookingCode}: Query returned ${testQuery.docs.length} docs, but our notification (${notificationId}) was not found!`);
                      console.error(`❌ Booking ${bookingCode}: This means the mobile app will NOT receive this notification!`);
                      console.error(`❌ Booking ${bookingCode}: Notification branchAdminUid value: ${notificationData?.branchAdminUid}`);
                      console.error(`❌ Booking ${bookingCode}: Expected branchAdminUid: ${branchAdminUid}`);
                    } else {
                      console.log(`✅ Booking ${bookingCode}: Notification is queryable by mobile app (branchAdminUid query works)`);
                    }
                  } catch (queryError) {
                    console.error(`❌ Booking ${bookingCode}: Error testing notification query:`, queryError);
                  }
                } else {
                  console.error(`❌ Booking ${bookingCode}: Notification was not found in Firestore after creation!`);
                }
              } catch (verifyError) {
                console.error(`❌ Booking ${bookingCode}: Error verifying notification:`, verifyError);
              }
              
              // CRITICAL: Ensure push notification is sent directly
              // Even though createNotification should send it, we'll send it explicitly here to guarantee delivery
              try {
                console.log(`📱 Booking ${bookingCode}: Sending push notification to branch admin ${branchAdminUid}...`);
                const branchAdminFcmToken = await getUserFcmToken(db, branchAdminUid);
                
                if (branchAdminFcmToken) {
                  const pushTitle = notificationData?.title || "New Booking - Staff Assignment Required";
                  const pushMessage = notificationData?.message || `New booking from ${body.client} for ${serviceList} on ${body.date} at ${body.time}. Please assign staff.`;
                  
                  console.log(`📱 Booking ${bookingCode}: FCM token found (${branchAdminFcmToken.substring(0, 20)}...), sending push...`);
                  console.log(`📱 Booking ${bookingCode}: Push title: "${pushTitle}"`);
                  console.log(`📱 Booking ${bookingCode}: Push message: "${pushMessage}"`);
                  
                  await sendPushNotification(branchAdminFcmToken, pushTitle, pushMessage, {
                    notificationId: notificationId,
                    type: "booking_needs_assignment",
                    bookingId: ref.id,
                    bookingCode: bookingCode || "",
                    branchId: String(body.branchId),
                  });
                  
                  console.log(`✅ Booking ${bookingCode}: Push notification sent successfully to branch admin ${branchAdminUid}`);
                } else {
                  console.error(`❌ Booking ${bookingCode}: No FCM token found for branch admin ${branchAdminUid}`);
                  console.error(`❌ Booking ${bookingCode}: Branch admin ${branchAdminUid} needs to:`);
                  console.error(`   1. Open the mobile app`);
                  console.error(`   2. Grant notification permissions`);
                  console.error(`   3. The app will automatically save FCM token to Firestore`);
                  console.log(`⚠️ Booking ${bookingCode}: Notification is available in Firestore (ID: ${notificationId}) - mobile app will receive it via Firestore listener when app is open`);
                }
              } catch (pushError: any) {
                console.error(`❌ Booking ${bookingCode}: Error sending push notification to branch admin ${branchAdminUid}:`, pushError);
                console.error(`❌ Booking ${bookingCode}: Push error code: ${pushError?.code || "unknown"}`);
                console.error(`❌ Booking ${bookingCode}: Push error message: ${pushError?.message || pushError}`);
                console.log(`⚠️ Booking ${bookingCode}: Notification is still available in Firestore (ID: ${notificationId}) - mobile app will receive it via Firestore listener`);
              }
            } catch (branchAdminNotifError) {
              console.error(`❌ Booking ${bookingCode}: Failed to create branch admin notification:`, branchAdminNotifError);
              console.error(`❌ Booking ${bookingCode}: Error details:`, branchAdminNotifError);
              
              // Fallback: Create notification directly in Firestore if helper fails
              try {
                console.log(`📋 Booking ${bookingCode}: Attempting fallback notification creation for branch admin ${branchAdminUid}`);
                const fallbackNotification = {
                  bookingId: ref.id,
                  bookingCode: bookingCode,
                  type: "booking_needs_assignment",
                  title: "New Booking - Staff Assignment Required",
                  message: `New booking from ${body.client} for ${serviceList} on ${body.date} at ${body.time}. Please assign staff.`,
                  status: finalStatus,
                  ownerUid: ownerUid,
                  branchAdminUid: branchAdminUid, // CRITICAL: Must match user.uid for mobile app query
                  targetAdminUid: branchAdminUid, // Also set for mobile app queries
                  branchId: String(body.branchId), // CRITICAL: Must be set for branch filtering
                  clientName: String(body.client),
                  clientPhone: body.clientPhone || null,
                  serviceName: serviceName || null,
                  services: processedServices?.map((s: any) => ({
                    name: s.name || "Service",
                    staffName: s.staffName || "Needs Assignment",
                    staffId: s.staffId || null,
                  })) || null,
                  branchName: branchName || null,
                  bookingDate: String(body.date),
                  bookingTime: String(body.time),
                  read: false,
                  createdAt: FieldValue.serverTimestamp(),
                };
                
                const fallbackNotifRef = await db.collection("notifications").add(fallbackNotification);
                console.log(`✅ Booking ${bookingCode}: Fallback notification created with ID: ${fallbackNotifRef.id}`);
                
                // Send FCM push notification
                const branchAdminFcmToken = await getUserFcmToken(db, branchAdminUid);
                if (branchAdminFcmToken) {
                  await sendPushNotification(branchAdminFcmToken, fallbackNotification.title, fallbackNotification.message, {
                    notificationId: fallbackNotifRef.id,
                    type: "booking_needs_assignment",
                    bookingId: ref.id,
                    bookingCode: bookingCode || "",
                  });
                  console.log(`✅ Booking ${bookingCode}: FCM push sent to branch admin ${branchAdminUid} (fallback)`);
                } else {
                  console.log(`⚠️ Booking ${bookingCode}: No FCM token for branch admin ${branchAdminUid} (fallback)`);
                }
              } catch (fallbackError) {
                console.error(`❌ Booking ${bookingCode}: Fallback notification creation also failed:`, fallbackError);
              }
            }
            
            console.log(`✅ Booking ${bookingCode}: Branch admin ${branchAdminUid} notification process completed`);
          }
          
          if (branchAdminUids.length > 0) {
            console.log(`✅ Booking ${bookingCode}: Notified ${branchAdminUids.length} branch admin(s) for "Any Staff" booking`);
          } else {
            console.log(`⚠️ Booking ${bookingCode}: No branch admins found for branch ${body.branchId}`);
          }
        } catch (anyStaffNotifError) {
          console.error("❌ Failed to send owner/branch admin notifications for Any Staff booking:", anyStaffNotifError);
          console.error("❌ Error details:", anyStaffNotifError);
          // Don't fail the request if notification sending fails
        }
      } else {
        console.log(`ℹ️ Booking ${bookingCode}: No Any Staff detected - skipping owner/branch admin notification`);
      }
      
      return NextResponse.json({ id: ref.id });
    } catch (e) {
      if (process.env.NODE_ENV !== "production") {
        // Fall back silently in dev to let client persist
        return NextResponse.json({ id: "DEV_LOCAL", devNoop: true });
      }
      throw e;
    }
  } catch (e: any) {
    console.error("Create booking API error:", e);
    const message = process.env.NODE_ENV === "production" ? "Internal error" : e?.message || "Internal error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}


