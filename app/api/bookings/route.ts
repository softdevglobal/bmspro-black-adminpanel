import { NextRequest, NextResponse } from "next/server";
import { adminAuth, adminDb, adminMessaging } from "@/lib/firebaseAdmin";
import { FieldValue, Firestore, FieldPath } from "firebase-admin/firestore";
import { Message } from "firebase-admin/messaging";
import { normalizeBookingStatus } from "@/lib/bookingTypes";
import { generateBookingCode } from "@/lib/bookings";
import { checkRateLimit, getClientIdentifier, RateLimiters, getRateLimitHeaders } from "@/lib/rateLimiterDistributed";
import { logBookingCreatedServer } from "@/lib/auditLogServer";
import { apnsAlertConfig, normalizeFcmData } from "@/lib/fcmIosHelpers";
import { createStaffAssignmentNotification, createOwnerNotification, getBranchAdminUids, createBranchAdminNotification } from "@/lib/notifications";
import { sendBookingRequestReceivedEmail, sendBookingEmail, sendCustomerWelcomeEmail } from "@/lib/emailService";
import {
  resolveCustomerForStaffBooking,
  resolveBookingEngineUrl,
  getCanonicalCustomerContact,
} from "@/lib/customerAccount";
import { upsertCustomerVehicleFromBooking } from "@/lib/callCenterCustomerVehiclesServer";
import {
  isVehicleType,
  normalizeVehicleTypePricing,
  resolveServicePricingForVehicleType,
  type VehicleType,
} from "@/lib/services";
import {
  collectStaffIdsOnApprovedLeaveForDate,
  parseBookingYmd,
} from "@/lib/leaveBookingAssignment";

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
        s.staffName.toLowerCase().includes("not assigned yet") ||
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
    staffName.toLowerCase().includes("not assigned yet") ||
    staffName.toLowerCase() === "any"
  ));
  return hasAnyStaffId || hasAnyStaffName;
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
      data: normalizeFcmData({ ...(data ?? {}), title, body }),
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
      apns: apnsAlertConfig(title, body),
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
  vehicleNumber?: string;
  vehicleMake?: string;
  vehicleModel?: string;
  vehicleBodyType?: string;
  /** Canonical vehicle size class used for per-type pricing (small_car | sedan_wagon | suv | ute_van_4wd | performance_large). */
  vehicleType?: string;
  vehicleColour?: string;
  vehicleVinChassis?: string;
  vehicleEngineNumber?: string;
  vehicleMileage?: string;  // Customer-provided mileage at booking
  notes?: string;
  serviceId: string | number;
  serviceName?: string;
  staffId: string;
  staffName?: string;
  branchId: string;
  branchName?: string;
  branchTimezone?: string; // IANA timezone for the branch
  date: string; // YYYY-MM-DD in branch's local timezone
  time: string; // HH:mm in branch's local timezone (drop-off time)
  pickupTime?: string | null; // HH:mm in branch's local timezone (pick-up time)
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
        if ((userRole === "branch_admin" || userRole === "staff") && userData.ownerUid) {
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
      "clientEmail",
      "clientPhone",
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
        const label =
          key === "clientEmail" ? "Customer email"
          : key === "clientPhone" ? "Customer phone"
          : key === "client" ? "Customer name"
          : String(key);
        return NextResponse.json(
          { error: `${label} is required`, field: key },
          { status: 400 }
        );
      }
    }

    // Validate email format (email is now required for customer account creation)
    const emailValue = String(body.clientEmail).trim();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(emailValue)) {
      return NextResponse.json(
        { error: "Customer email must be a valid email address", field: "clientEmail" },
        { status: 400 }
      );
    }

    // Validate phone looks like a phone number (digits, spaces, +, -, parens only; at least 6 digits)
    const phoneValue = String(body.clientPhone).trim();
    const phoneDigits = phoneValue.replace(/\D/g, "");
    if (phoneDigits.length < 6 || !/^[+\d][\d\s\-()]+$/.test(phoneValue)) {
      return NextResponse.json(
        { error: "Customer phone must be a valid phone number", field: "clientPhone" },
        { status: 400 }
      );
    }

    // Australian booking rule: drop-off by 11 AM, pick-up 2 PM – 5 PM
    const bookingTime = String(body.time);
    const bookingPickupTime = body.pickupTime ? String(body.pickupTime) : null;

    if (bookingTime > "11:00") {
      return NextResponse.json(
        { error: "Drop-off time must be by 11:00 AM." },
        { status: 400 }
      );
    }
    if (bookingPickupTime && (bookingPickupTime < "14:00" || bookingPickupTime > "17:00")) {
      return NextResponse.json(
        { error: "Pick-up time must be between 2:00 PM and 5:00 PM." },
        { status: 400 }
      );
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
        
        if (userRole === "branch_admin") {
          bookingSource = `Branch Admin Booking - ${userBranchName || "Unknown Branch"}`;
        } else if (userRole === "workshop_owner") {
          bookingSource = "Workshop Owner Booking";
        } else if (userRole === "staff") {
          // For staff bookings, show the staff member's name instead of branch
          bookingSource = `Staff Booking - ${userName}`;
        }
      }
    } catch (roleError) {
      console.error("Failed to get user role for booking source:", roleError);
    }

    const db = adminDb();

    // Staff-wise slot validation has been intentionally removed.
    //
    // Previously this route enforced two caps:
    //   1. "Any Staff" services: rejected with 409 "Time slot fully booked"
    //      once all eligible staff for the service/branch were occupied
    //      (i.e. the "2 staff = max 2 bookings" behaviour).
    //   2. Specific-staff services: rejected with 409 "Time slot already
    //      booked" when that same staff member had an overlapping booking.
    //
    // Per product decision, staff assignment is now handled manually by the
    // workshop and double-booking the same staff is allowed at this layer —
    // only the branch's `bookingLimitPerDay` and opening-hours restrict
    // bookings. The validation block below has been removed accordingly.

    const bookingCode = generateBookingCode();
    
    // Determine if this is a staff-created booking (auto-confirm)
    let finalStatus = normalizeBookingStatus(body.status || "Pending");
    let processedServices = body.services || null;

    // Do not persist assignments to staff on approved leave for this date
    try {
      const dateStr = String(body.date ?? "").trim();
      const bookingDay = dateStr ? parseBookingYmd(dateStr) : null;
      if (bookingDay) {
        const leaveSnap = await adminDb()
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
        const isBlockedStaff = (sid: unknown): boolean => {
          if (sid == null) return false;
          const s = String(sid).trim();
          if (!s || s.toLowerCase() === "null" || s.toLowerCase().includes("any")) {
            return false;
          }
          return blocked.has(s);
        };
        if (processedServices && Array.isArray(processedServices)) {
          for (const svc of processedServices) {
            if (isBlockedStaff((svc as { staffId?: string }).staffId)) {
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
        if (isBlockedStaff(body.staffId)) {
          return NextResponse.json(
            {
              error:
                "Cannot assign staff who is on approved leave on that date.",
            },
            { status: 400 },
          );
        }
      }
    } catch (leaveCheckErr) {
      console.warn("Leave assignment check skipped:", leaveCheckErr);
    }
    
    // Check if user is staff, workshop_owner, or branch_admin for auto-confirmation logic
    try {
      const currentUserDoc = await adminDb().doc(`users/${currentUserId}`).get();
      const currentUserData = currentUserDoc.data();
      if (currentUserData) {
        const userRole = currentUserData.role || currentUserData.systemRole;
        
        if (userRole === "staff") {
          // Auto-confirm staff bookings (all services accepted immediately)
          finalStatus = "Confirmed";
          
          // Mark services as accepted if services array exists
          if (processedServices && Array.isArray(processedServices) && processedServices.length > 0) {
            processedServices = processedServices.map((service: any) => ({
              ...service,
              approvalStatus: "accepted",
            }));
          }
        } else if (userRole === "workshop_owner" || userRole === "branch_admin") {
          // For workshop_owner and branch_admin: Owner/branch admin holds authority.
          // When staff is assigned, auto-confirm without staff approval.
          // Services with staff -> accepted; services without staff -> needs_assignment
          
          if (processedServices && Array.isArray(processedServices) && processedServices.length > 0) {
            processedServices = processedServices.map((service: any) => {
              const hasStaff = service.staffId && service.staffId !== "null" && 
                               !String(service.staffId).toLowerCase().includes("any");
              return {
                ...service,
                // Services with valid staff get "accepted" (auto-confirmed by owner/admin authority)
                // Services without staff (Any Available) get "needs_assignment" status
                approvalStatus: hasStaff ? "accepted" : "needs_assignment",
              };
            });
            
            const hasAnyAssignedStaff = processedServices.some((s: any) => s.approvalStatus === "accepted");
            const hasAnyNeedsAssignment = processedServices.some((s: any) => s.approvalStatus === "needs_assignment");
            
            // All services have staff assigned -> Confirmed (auto-confirm, no staff approval needed)
            // Any service needs assignment -> Pending (until owner/admin assigns staff)
            if (hasAnyAssignedStaff && !hasAnyNeedsAssignment) {
              finalStatus = "Confirmed";
            } else {
              finalStatus = "Pending";
            }
          } else if (body.staffId && body.staffId !== "null" && 
                     !String(body.staffId).toLowerCase().includes("any")) {
            // Single service booking with staff assigned - auto-confirm
            finalStatus = "Confirmed";
          } else {
            // Single service booking without staff - Pending until assigned
            finalStatus = "Pending";
          }
        }
      }
    } catch (roleError) {
      console.error("Failed to check user role for auto-confirmation:", roleError);
    }
    
    // ─── Build tasks array from service checklists ───────────────────────────
    let bookingTasks: any[] = [];
    // Owner-customised area order per service (snapshotted so bookings keep
    // their area grouping even if the service is later edited).
    const areaOrderByServiceId: Record<string, string[]> = {};
    try {
      // Collect unique service IDs from the booking
      const serviceIds: string[] = [];
      if (processedServices && Array.isArray(processedServices)) {
        for (const svc of processedServices) {
          if (svc.id) serviceIds.push(String(svc.id));
        }
      } else if (body.serviceId) {
        // Single service or comma-separated IDs
        const ids = String(body.serviceId).split(",").map((s: string) => s.trim()).filter(Boolean);
        serviceIds.push(...ids);
      }

      // Fetch each service doc and copy its checklist items as tasks
      let taskIndex = 0;
      for (const svcId of serviceIds) {
        const svcDoc = await adminDb().collection("services").doc(svcId).get();
        if (!svcDoc.exists) continue;
        const svcData = svcDoc.data();
        const checklist = svcData?.checklist;
        if (Array.isArray(svcData?.areaOrder)) {
          areaOrderByServiceId[svcId] = (svcData!.areaOrder as unknown[]).filter(
            (v) =>
              v === "interior" ||
              v === "engine_bay" ||
              v === "underbody" ||
              v === "exterior"
          ) as string[];
        }
        if (!Array.isArray(checklist) || checklist.length === 0) continue;

        const svcName = svcData?.name || "";
        for (const item of checklist) {
          const rawSection =
            typeof item === "string" ? undefined : (item as any)?.section;
          const section =
            rawSection === "interior" ||
            rawSection === "engine_bay" ||
            rawSection === "underbody" ||
            rawSection === "exterior"
              ? rawSection
              : "interior";
          bookingTasks.push({
            id: `task_${taskIndex++}`,
            serviceId: svcId,
            serviceName: svcName,
            name: typeof item === "string" ? item : (item.name || ""),
            description: typeof item === "string" ? "" : (item.description || ""),
            section,
            done: false,
            imageUrl: "",
            staffNote: "",
            completedAt: null,
            completedByStaffUid: null,
            completedByStaffName: null,
          });
        }
      }
      // Attach the per-service areaOrder snapshot to each service entry so the
      // booking preview and staff-assignment UIs can render tasks area-wise.
      if (processedServices && Array.isArray(processedServices)) {
        processedServices = processedServices.map((svc: any) => {
          const order = svc?.id ? areaOrderByServiceId[String(svc.id)] : undefined;
          return order && order.length > 0 ? { ...svc, areaOrder: order } : svc;
        });
      }
    } catch (taskError) {
      console.error("Failed to build tasks from service checklists:", taskError);
      // Non-blocking: proceed without tasks
    }

    // ─── Apply per-vehicle-type pricing resolution ─────────────────────────
    // When the caller supplies a canonical `vehicleType` (size class), re-
    // resolve each service's price/duration from its `vehicleTypePricing`
    // map so admin-panel / mobile-app bookings use the same tiered pricing
    // that the customer booking engine uses. Legacy services without a
    // per-type map fall through to the client-supplied flat price.
    const resolvedVehicleType: VehicleType | null =
      body.vehicleType && isVehicleType(body.vehicleType)
        ? (body.vehicleType as VehicleType)
        : null;
    let totalPriceOverride: number | null = null;
    let totalDurationOverride: number | null = null;
    if (
      resolvedVehicleType &&
      processedServices &&
      Array.isArray(processedServices) &&
      processedServices.length > 0
    ) {
      const rePriced: any[] = [];
      for (const svc of processedServices) {
        const idStr = svc?.id != null ? String(svc.id).trim() : "";
        let resolvedPrice: number | null = null;
        let resolvedDuration: number | null = null;
        if (idStr) {
          try {
            const svcDoc = await adminDb().collection("services").doc(idStr).get();
            if (svcDoc.exists) {
              const svcData = svcDoc.data();
              const typePricing = normalizeVehicleTypePricing(svcData?.vehicleTypePricing);
              const pricing = resolveServicePricingForVehicleType(
                {
                  price: typeof svcData?.price === "number" ? svcData.price : undefined,
                  duration: typeof svcData?.duration === "number" ? svcData.duration : undefined,
                  vehicleTypePricing: typePricing.vehicleTypePricing,
                },
                resolvedVehicleType,
              );
              if (pricing) {
                resolvedPrice = pricing.price;
                resolvedDuration = pricing.duration;
              }
            }
          } catch (err) {
            console.warn(`[BOOKING] Failed to resolve per-type pricing for service ${idStr}:`, err);
          }
        }
        rePriced.push({
          ...svc,
          ...(resolvedPrice != null ? { price: resolvedPrice } : {}),
          ...(resolvedDuration != null ? { duration: resolvedDuration } : {}),
          vehicleType: resolvedVehicleType,
        });
      }
      processedServices = rePriced;
      totalPriceOverride = rePriced.reduce((sum, s) => sum + (Number(s.price) || 0), 0);
      totalDurationOverride = rePriced.reduce((sum, s) => sum + (Number(s.duration) || 0), 0);
    }

    // ─── Resolve / provision customer account BEFORE saving the booking ────
    // When an admin, owner, or staff member creates a booking, look up the
    // customer in the `customers` collection (scoped to this workshop). If a
    // customer already exists for that email, the booking is linked to that
    // existing account — NO new account is created and NO welcome email is
    // sent. If no customer exists yet, a new one is provisioned with the
    // default password ("000000") and a welcome email is queued to be sent
    // after the booking is successfully saved.
    let resolvedCustomerId: string | null = null;
    let newCustomerWelcome: {
      email: string;
      password: string;
      name: string;
    } | null = null;
    let ensureResult: Awaited<ReturnType<typeof resolveCustomerForStaffBooking>> = null;
    try {
      ensureResult = await resolveCustomerForStaffBooking(db, {
        ownerUid,
        email: body.clientEmail,
        phone: body.clientPhone,
        name: body.client ? String(body.client) : null,
      });
      if (ensureResult) {
        resolvedCustomerId = ensureResult.customerId;
        if (ensureResult.created && ensureResult.defaultPassword) {
          newCustomerWelcome = {
            email: ensureResult.email,
            password: ensureResult.defaultPassword,
            name: String(body.client || "").trim(),
          };
          console.log(
            `[BOOKING] Auto-created customer account ${ensureResult.customerId} for ${ensureResult.email} (workshop ${ownerUid})`
          );
        } else {
          console.log(
            `[BOOKING] Linking booking to existing customer account ${ensureResult.customerId} for ${ensureResult.email || "(phone match)"} (workshop ${ownerUid}) — skipping welcome email`
          );
        }
      }
    } catch (customerAccountErr: any) {
      console.error(
        `[BOOKING] ❌ Exception during customer account resolution — proceeding without linked customerId:`,
        customerAccountErr?.message || customerAccountErr
      );
    }

    const accountCreatedThisBooking = ensureResult?.created === true;
    let clientForBooking = String(body.client ?? "").trim() || "Walk-in";
    let emailForBooking = emailValue;
    let phoneForBooking = phoneValue;
    let canonicalCustomerForResponse:
      | { name: string; email: string; phone: string }
      | undefined;

    if (resolvedCustomerId && !accountCreatedThisBooking) {
      try {
        const canon = await getCanonicalCustomerContact(db, resolvedCustomerId, ownerUid);
        if (canon) {
          if (canon.name) clientForBooking = canon.name;
          if (canon.email) emailForBooking = canon.email;
          if (canon.phone) phoneForBooking = canon.phone;
          canonicalCustomerForResponse = {
            name: clientForBooking,
            email: emailForBooking,
            phone: phoneForBooking,
          };
        }
      } catch (canonErr) {
        console.warn("[BOOKING] Could not load canonical customer contact:", canonErr);
      }
    }

    const payload: any = {
      ownerUid,
      client: clientForBooking,
      clientEmail: emailForBooking || null,
      clientPhone: phoneForBooking || null,
      customerId: resolvedCustomerId,
      vehicleNumber: body.vehicleNumber || null,
      vehicleMake: body.vehicleMake || null,
      vehicleModel: body.vehicleModel || null,
      vehicleBodyType: body.vehicleBodyType || null,
      vehicleType: resolvedVehicleType, // canonical size class; null for legacy-priced bookings
      vehicleColour: body.vehicleColour || null,
      vehicleVinChassis: body.vehicleVinChassis || null,
      vehicleEngineNumber: body.vehicleEngineNumber || null,
      vehicleMileage: body.vehicleMileage || null,
      notes: body.notes || null,
      serviceId: typeof body.serviceId === "number" ? body.serviceId : String(body.serviceId),
      serviceName: serviceName,
      staffId: body.staffId ? String(body.staffId) : null,
      staffName: staffName,
      branchId: String(body.branchId),
      branchName: branchName,
      branchTimezone: branchTimezone, // Store branch timezone
      date: String(body.date), // YYYY-MM-DD in branch's local timezone (for backward compatibility)
      time: String(body.time), // HH:mm in branch's local timezone - drop-off time
      pickupTime: body.pickupTime || null, // HH:mm in branch's local timezone - pick-up time
      dateTimeUtc: body.dateTimeUtc || null, // UTC ISO string for consistent storage
      duration: totalDurationOverride != null ? totalDurationOverride : Number(body.duration) || 0,
      status: finalStatus,
      price: totalPriceOverride != null ? totalPriceOverride : Number(body.price) || 0,
      services: processedServices,
      bookingSource: bookingSource,
      bookingCode: bookingCode,
      // Task management fields
      tasks: bookingTasks.length > 0 ? bookingTasks : [],
      taskProgress: 0,
      finalSubmission: null,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };

    try {
      const ref = await adminDb().collection("bookings").add(payload);

      // ─── Persist the vehicle into the customer's "My Vehicles" list ────
      // When we resolved/created a customer account above, also save the
      // vehicle captured on this booking to `customers/{id}/vehicles` so it
      // shows up on the Booking Engine's "My Vehicles" tab and in future
      // bookings. Dedupes by rego / VIN — existing vehicles are merged, not
      // duplicated. Best-effort: failures must never break booking creation.
      if (resolvedCustomerId) {
        try {
          const vehicleResult = await upsertCustomerVehicleFromBooking(
            adminDb(),
            {
              customerId: resolvedCustomerId,
              ownerUid,
              createdByUid: currentUserId || null,
              vehicle: {
                vehicleNumber: body.vehicleNumber,
                vehicleMake: body.vehicleMake,
                vehicleModel: body.vehicleModel,
                vehicleBodyType: body.vehicleBodyType,
                vehicleType: resolvedVehicleType || null,
                vehicleColour: body.vehicleColour,
                vehicleVinChassis: body.vehicleVinChassis,
                vehicleEngineNumber: body.vehicleEngineNumber,
                vehicleMileage: body.vehicleMileage,
              },
            },
          );
          if (vehicleResult.saved) {
            console.log(
              `[BOOKING] ✅ Vehicle ${vehicleResult.vehicleId} ${
                vehicleResult.updatedExisting ? "merged into existing" : "added to"
              } customer ${resolvedCustomerId} from booking ${ref.id}`,
            );
          } else {
            console.log(
              `[BOOKING] ℹ️ Skipped vehicle upsert for booking ${ref.id} — reason: ${vehicleResult.reason}`,
            );
          }
        } catch (vehicleErr: any) {
          console.error(
            `[BOOKING] ❌ Exception persisting vehicle for booking ${ref.id}:`,
            vehicleErr?.message || vehicleErr,
          );
        }
      }

      // Create booking activity log for new booking
      try {
        await adminDb().collection("bookingActivities").add({
          ownerUid: ownerUid,
          bookingId: ref.id,
          bookingCode: bookingCode,
          activityType: "booking_created",
          clientName: clientForBooking,
          serviceName: serviceName,
          branchName: branchName,
          staffName: staffName,
          price: Number(body.price) || 0,
          date: String(body.date),
          time: String(body.time),
          pickupTime: body.pickupTime || null,
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
          clientForBooking,
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
            clientEmail: emailForBooking || undefined,
            clientPhone: phoneForBooking || undefined,
          }
        );
      } catch (auditError) {
        console.error("Failed to create audit log for booking creation:", auditError);
        // Don't fail the request if audit log creation fails
      }
      
      // Send email to customer when booking is created (Request Received)
      // IMPORTANT: Always send email for new bookings, regardless of status
      // For "Confirmed" status (owner/admin with staff assigned), send "Confirmed" email
      // For "Confirmed" status (staff bookings), send "Confirmed" email
      // For "Pending" status, send "Pending" email
      try {
        const customerEmail: string | null =
          emailForBooking && emailForBooking.length > 0 ? emailForBooking : null;
        
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
          clientForBooking,
          bookingCode,
          finalStatus,
          hasEmail: !!customerEmail,
          userRole: userRole,
        });
        
        // Determine email status based on booking status
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
            customerName: clientForBooking,
            status: emailStatus,
            ownerUid,
            branchName: branchName || null,
            bookingDate: String(body.date),
            bookingTime: body.pickupTime ? `Drop-off: ${String(body.time)}, Pick-up: ${body.pickupTime}` : String(body.time),
            duration: totalDurationOverride != null ? totalDurationOverride : Number(body.duration) || null,
            price: totalPriceOverride != null ? totalPriceOverride : Number(body.price) || null,
            vehicleType: resolvedVehicleType,
            vehicleNumber: body.vehicleNumber || null,
            vehicleMake: body.vehicleMake || null,
            vehicleModel: body.vehicleModel || null,
            serviceName: serviceName || null,
            services: processedServices?.map((s: any) => ({
              name: s.name || "Service",
              staffName: s.staffName || null,
              time: s.time || String(body.time),
              duration: s.duration || Number(body.duration) || null,
              price: typeof s.price === "number" ? s.price : undefined,
              vehicleType: s.vehicleType || resolvedVehicleType || undefined,
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
            client: clientForBooking,
            clientEmail: emailForBooking,
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

      // ─── Welcome email for NEWLY-created customer accounts ───────────────
      // The customer account lookup happened before the booking was saved, so
      // `resolvedCustomerId` is already on the booking doc. Here we only need
      // to send the welcome email when a brand-new account was provisioned.
      // Existing accounts get no email — they were already linked via
      // `customerId` on the booking payload above.
      if (newCustomerWelcome) {
        try {
          let workshopName = "Workshop";
          let bookingEngineUrl = process.env.NEXT_PUBLIC_APP_URL || "https://black.bmspros.com.au";
          try {
            const ownerDoc = await db.doc(`users/${ownerUid}`).get();
            const ownerData = ownerDoc.exists ? ownerDoc.data() || {} : {};
            workshopName =
              (ownerData.workshopName as string) ||
              (ownerData.salonName as string) ||
              (ownerData.businessName as string) ||
              (ownerData.name as string) ||
              (ownerData.displayName as string) ||
              "Workshop";
            bookingEngineUrl = resolveBookingEngineUrl(ownerData);
          } catch (ownerLookupErr) {
            console.warn(
              `[BOOKING] Could not resolve workshop metadata for welcome email (owner ${ownerUid}):`,
              ownerLookupErr
            );
          }

          const welcomeResult = await sendCustomerWelcomeEmail({
            customerEmail: newCustomerWelcome.email,
            password: newCustomerWelcome.password,
            customerName: newCustomerWelcome.name,
            workshopName,
            bookingEngineUrl,
          });

          if (welcomeResult.success) {
            console.log(
              `[BOOKING] ✅ Welcome email sent to new customer ${newCustomerWelcome.email} for booking ${ref.id}`
            );
          } else {
            console.error(
              `[BOOKING] ❌ Welcome email failed for new customer ${newCustomerWelcome.email} on booking ${ref.id}:`,
              welcomeResult.error
            );
          }
        } catch (welcomeErr: any) {
          console.error(
            `[BOOKING] ❌ Exception sending welcome email for booking ${ref.id}:`,
            welcomeErr?.message || welcomeErr
          );
          // Non-blocking — the booking is already saved.
        }
      }

      // Send notifications to assigned staff members (informational - booking confirmed, no approval needed)
      if (finalStatus === "Confirmed") {
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
              clientName: clientForBooking,
              clientPhone: phoneForBooking || undefined,
              serviceName: serviceName || undefined,
              services: processedServices?.map((s: any) => ({
                name: s.name || "Service",
                staffName: s.staffName || undefined,
                staffId: s.staffId || undefined,
              })),
              branchName: branchName || undefined,
              bookingDate: String(body.date),
              bookingTime: body.pickupTime ? `Drop-off: ${String(body.time)}, Pick-up: ${body.pickupTime}` : String(body.time),
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
            clientName: clientForBooking,
            serviceName: serviceName || undefined,
            services: processedServices?.map((s: any) => ({
              name: s.name || "Service",
              staffName: s.staffName || undefined,
              staffId: s.staffId || undefined,
            })),
            branchName: branchName || undefined,
            branchId: String(body.branchId),
            bookingDate: String(body.date),
            bookingTime: body.pickupTime ? `Drop-off: ${String(body.time)}, Pick-up: ${body.pickupTime}` : String(body.time),
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
                clientName: clientForBooking,
                serviceName: serviceName || undefined,
                services: processedServices?.map((s: any) => ({
                  name: s.name || "Service",
                  staffName: s.staffName || "Needs Assignment",
                  staffId: s.staffId || undefined,
                })),
                branchName: branchName || undefined,
                branchId: String(body.branchId), // CRITICAL: Must be a string, not null
                bookingDate: String(body.date),
                bookingTime: body.pickupTime ? `Drop-off: ${String(body.time)}, Pick-up: ${body.pickupTime}` : String(body.time),
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
                  const pushMessage = notificationData?.message || `New booking from ${clientForBooking} for ${serviceList} on ${body.date} at ${body.time}. Please assign staff.`;
                  
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
                  message: `New booking from ${clientForBooking} for ${serviceList} on ${body.date} at ${body.time}. Please assign staff.`,
                  status: finalStatus,
                  ownerUid: ownerUid,
                  branchAdminUid: branchAdminUid, // CRITICAL: Must match user.uid for mobile app query
                  targetAdminUid: branchAdminUid, // Also set for mobile app queries
                  branchId: String(body.branchId), // CRITICAL: Must be set for branch filtering
                  clientName: clientForBooking,
                  clientPhone: phoneForBooking || null,
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
        // Notify branch admins for ALL branch bookings (including assigned-staff bookings)
        try {
          const branchAdminUids = await getBranchAdminUids(db, String(body.branchId), ownerUid);
          const serviceList = processedServices && Array.isArray(processedServices) && processedServices.length > 0
            ? processedServices.map(s => s.name || "Service").join(", ")
            : serviceName || "Service";
          for (const branchAdminUid of branchAdminUids) {
            if (branchAdminUid === ownerUid) continue;
            await createBranchAdminNotification({
              bookingId: ref.id,
              bookingCode: bookingCode,
              branchAdminUid,
              ownerUid,
              clientName: clientForBooking,
              serviceName: serviceName || undefined,
              services: processedServices?.map((s: any) => ({
                name: s.name || "Service",
                staffName: s.staffName || undefined,
                staffId: s.staffId || undefined,
              })),
              branchName: branchName || undefined,
              branchId: String(body.branchId),
              bookingDate: String(body.date),
              bookingTime: body.pickupTime ? `Drop-off: ${String(body.time)}, Pick-up: ${body.pickupTime}` : String(body.time),
              status: finalStatus,
              type: "branch_booking_created",
            });
          }
          if (branchAdminUids.length > 0) {
            console.log(`✅ Booking ${bookingCode}: Notified ${branchAdminUids.length} branch admin(s) for assigned-staff booking`);
          }
        } catch (branchAdminNotifError) {
          console.error("❌ Failed to send branch admin notifications for assigned-staff booking:", branchAdminNotifError);
        }
      }
      
      return NextResponse.json({
        id: ref.id,
        ...(canonicalCustomerForResponse
          ? { canonicalCustomer: canonicalCustomerForResponse }
          : {}),
      });
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


