import { apnsAlertConfig, normalizeFcmData } from "@/lib/fcmIosHelpers";
import { adminDb, adminMessaging } from "@/lib/firebaseAdmin";
import { FieldValue, Firestore } from "firebase-admin/firestore";
import type { BookingStatus } from "./bookingTypes";
import { Message } from "firebase-admin/messaging";

// Customer-facing notification types
export type CustomerNotificationType = 
  | "booking_confirmed" 
  | "booking_completed" 
  | "booking_canceled" 
  | "booking_status_changed";

// Staff-facing notification types
export type StaffNotificationType = 
  | "staff_assignment"      // Staff receives new booking to review
  | "staff_reassignment"    // Staff receives reassigned booking
  | "staff_booking_rescheduled" // Staff's existing booking was rescheduled (date/time/pickup changed)
  | "staff_unassigned"      // Staff was removed from a booking (reassigned to someone else)
  | "additional_issue_accepted"   // Customer accepted additional work - staff can proceed
  | "additional_issue_rejected"   // Admin rejected additional work - staff sees it in app
  | "additional_issue_customer_rejected";  // Customer declined additional work - staff sees it in app

// Admin-facing notification types
// NOTE: staff_accepted is NOT sent to admin panel (per business logic).
// Admins only receive notifications for:
// 1. New bookings (booking_engine_new_booking, staff_booking_created, booking_needs_assignment)
// 2. Staff rejections (staff_rejected) - admin needs to reassign or cancel
// 3. Additional issues (additional_issue_found) - technician found extra work needed
export type AdminNotificationType = 
  | "staff_rejected"        // Staff rejected a booking - admin needs to reassign
  | "booking_rescheduled"   // Booking was rescheduled by owner / branch admin — audit copy for the other role
  | "additional_issue_found"; // Technician reported additional vehicle issue - needs pricing

// Owner-facing notification types (for staff-created bookings, etc.)
export type OwnerNotificationType =
  | "staff_booking_created"       // Staff created a booking
  | "booking_needs_assignment"    // Booking needs staff assignment
  | "booking_engine_new_booking"  // New booking from booking engine
  | "booking_rescheduled"        // Owner audit copy when a branch admin reschedules
  | "additional_issue_found"     // Technician reported additional vehicle issue - needs pricing
  | "owner_booking_completed"    // Staff/admin marked booking completed (workshop owner alert)
  | "staff_clocked_in"           // Staff clocked on
  | "staff_clocked_out"          // Staff clocked off (manual, suspicious, or auto)
  | "staff_break_started"        // Staff started a break
  | "staff_break_ended";         // Staff ended a break

export type NotificationType = CustomerNotificationType | StaffNotificationType | AdminNotificationType | OwnerNotificationType;

// Base notification interface
export interface BaseNotification {
  id?: string;
  bookingId: string;
  bookingCode?: string;
  type: NotificationType;
  title: string;
  message: string;
  status: BookingStatus;
  read: boolean;
  createdAt: any;
  ownerUid: string; // Salon owner UID
  // Additional booking details
  staffName?: string;
  serviceName?: string;
  branchName?: string;
  bookingDate?: string;
  bookingTime?: string;
  services?: Array<{ name: string; staffName?: string; staffId?: string }>;
}

// Customer notification
export interface CustomerNotification extends BaseNotification {
  customerUid?: string;
  customerEmail?: string;
  customerPhone?: string;
  clientName?: string;
}

// Staff notification
export interface StaffNotification extends BaseNotification {
  staffUid: string;        // The staff member receiving the notification
  staffEmail?: string;
  clientName?: string;
  clientPhone?: string;
  duration?: number;
  price?: number;
}

// Admin notification
export interface AdminNotification extends BaseNotification {
  targetAdminUid?: string;   // Specific admin to notify (optional, if null notify owner)
  rejectionReason?: string;  // For staff_rejected notifications
  rejectedByStaffUid?: string;
  rejectedByStaffName?: string;
  clientName?: string;
}

// Owner notification (for staff-created bookings, unassigned bookings, etc.)
export interface OwnerNotification extends BaseNotification {
  targetOwnerUid: string;    // The owner to notify
  creatorUid?: string;       // UID of person who created the booking
  creatorName?: string;      // Name of person who created the booking
  creatorRole?: string;      // Role of person who created the booking
  clientName?: string;
  branchId?: string;
}

export type Notification = CustomerNotification | StaffNotification | AdminNotification | OwnerNotification;

/**
 * Send push notification to a user's device
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
      // Duplicate title/body in `data` so iOS data/background paths and Dart handlers always have strings
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

    console.log(`📤 Sending FCM message - title: "${title}", body: "${body}", token: ${fcmToken.substring(0, 20)}...`);
    const response = await messaging.send(message);
    console.log(`✅ Push notification sent successfully - message ID: ${response}`);
  } catch (error: any) {
    // Don't throw error - push notification failure shouldn't break notification creation
    console.error(`❌ Error sending push notification:`, error);
    console.error(`❌ Error code: ${error?.code || "unknown"}`);
    console.error(`❌ Error message: ${error?.message || error}`);
    
    if (error.code === "messaging/invalid-registration-token" || 
        error.code === "messaging/registration-token-not-registered") {
      // Token is invalid, we might want to remove it from the user document
      console.log(`⚠️ Invalid FCM token detected (${error.code}), but continuing with notification creation`);
      console.log(`⚠️ User needs to re-open the mobile app to refresh their FCM token`);
    } else if (error.code === "messaging/registration-token-not-registered") {
      console.log(`⚠️ FCM token not registered - user may have uninstalled the app`);
    } else {
      console.log(`⚠️ Unknown FCM error - notification still created in Firestore`);
    }
  }
}

/**
 * Get FCM token for a user
 * Checks both users and salon_staff collections (mobile app saves to both)
 */
async function getUserFcmToken(userUid: string): Promise<string | null> {
  try {
    const db = adminDb();
    
    // Check users collection first
    const userDoc = await db.collection("users").doc(userUid).get();
    if (userDoc.exists) {
      const userData = userDoc.data();
      const fcmToken = userData?.fcmToken;
      if (fcmToken) {
        console.log(`📱 Found FCM token in users collection for user: ${userUid}`);
        return fcmToken;
      }
    }
    
    // Also check salon_staff collection (mobile app saves to both)
    const staffDoc = await db.collection("salon_staff").doc(userUid).get();
    if (staffDoc.exists) {
      const staffData = staffDoc.data();
      const fcmToken = staffData?.fcmToken;
      if (fcmToken) {
        console.log(`📱 Found FCM token in salon_staff collection for user: ${userUid}`);
        return fcmToken;
      }
    }

    const agentDoc = await db.collection("call_center_agents").doc(userUid).get();
    if (agentDoc.exists) {
      const agentData = agentDoc.data();
      const fcmToken = agentData?.fcmToken;
      if (fcmToken) {
        console.log(`📱 Found FCM token in call_center_agents for user: ${userUid}`);
        return fcmToken;
      }
    }
    
    console.log(`⚠️ No FCM token found for user: ${userUid} (checked users, salon_staff, call_center_agents)`);
    return null;
  } catch (error) {
    console.error(`❌ Error getting FCM token for user ${userUid}:`, error);
    return null;
  }
}

/**
 * Recursively strip undefined values from objects/arrays (Firestore rejects undefined)
 */
function stripUndefined<T>(obj: T): T {
  if (obj === undefined || obj === null) {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(item => stripUndefined(item)) as T;
  }
  if (typeof obj === "object") {
    const result: any = {};
    for (const [key, value] of Object.entries(obj)) {
      if (value !== undefined) {
        result[key] = stripUndefined(value);
      }
    }
    return result as T;
  }
  return obj;
}

/**
 * Single value to store on customer-facing notifications (`customerPhone` on `customer_notifications`
 * and normalized on `notifications` when the row targets the customer).
 * Order: explicit customerPhone → booking clientPhone → generic phone.
 */
export function resolveCustomerPhoneForStorage(source: Record<string, any>): string | null {
  const s =
    String(source?.customerPhone ?? "").trim() ||
    String(source?.clientPhone ?? "").trim() ||
    String(source?.phone ?? "").trim() ||
    String(source?.mobile ?? "").trim() ||
    String(source?.phoneNumber ?? "").trim() ||
    String(source?.contactNumber ?? "").trim();
  return s || null;
}

/** Best email for customer-facing rows (booking / issue snapshot). */
export function resolveCustomerEmailForStorage(source: Record<string, any>): string | null {
  const em =
    String(source?.clientEmail ?? "").trim() ||
    String(source?.customerEmail ?? "").trim();
  if (em && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) return em;
  const cid = String(source?.customerId ?? "").trim();
  if (cid && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cid)) return cid;
  return em || null;
}

/** Display name on customer-facing notification rows (`clientName` on `notifications`, `customerName` on inbox). */
export function resolveCustomerNameForStorage(source: Record<string, any>): string | null {
  const s =
    String(source?.clientName ?? "").trim() ||
    String(source?.client ?? "").trim() ||
    String(source?.customerName ?? "").trim() ||
    String(source?.name ?? "").trim();
  return s || null;
}

/**
 * Call-center agent workflow on customer-related notifications (`notifications` + `customer_notifications`).
 * Both default to false at creation; agents can update later (e.g. via admin API).
 */
export const CUSTOMER_NOTIFICATION_AGENT_TRACKING_DEFAULTS = {
  /** Call center agent has opened/reviewed this notification. */
  notificationReviewed: false,
  /** Call center agent has called the customer about this matter. */
  calledCustomer: false,
  /** Firebase UID of the agent/staff who last set `notificationReviewed` to true. */
  notificationReviewedByUid: null as string | null,
  /** Legacy / alias of display name for older clients. */
  notificationReviewedByName: null as string | null,
  /** Preferred label for call-center UI (from `call_center_agents.displayName` or `users.displayName`). */
  notificationReviewedByDisplayName: null as string | null,
  notificationReviewedByEmail: null as string | null,
  /** Firebase UID of the agent/staff who last set `calledCustomer` to true. */
  calledCustomerByUid: null as string | null,
  calledCustomerByName: null as string | null,
  calledCustomerByDisplayName: null as string | null,
  calledCustomerByEmail: null as string | null,
} as const;

/** Booking status messages that go to the customer (also mirrored to `customer_notifications` when possible). */
const CUSTOMER_LIFECYCLE_NOTIFICATION_TYPES = new Set<string>([
  "booking_confirmed",
  "booking_completed",
  "booking_canceled",
  "booking_status_changed",
]);

/**
 * Whether this `notifications` row is customer-related and should store call-center tracking fields.
 * Avoids attaching flags to staff/admin-only rows (e.g. `staff_assignment` with `clientPhone` only).
 */
function shouldAttachCallCenterAgentTracking(cleanData: Record<string, any>): boolean {
  const hasCustomerRecipient =
    Boolean(String(cleanData.customerUid || "").trim()) ||
    Boolean(String(cleanData.customerEmail || "").trim()) ||
    Boolean(String(cleanData.clientEmail || "").trim());

  const hasCustomerContact =
    hasCustomerRecipient || Boolean(String(cleanData.clientPhone || "").trim());

  const type = String(cleanData.type || "").trim();
  if (CUSTOMER_LIFECYCLE_NOTIFICATION_TYPES.has(type) && hasCustomerContact) {
    return true;
  }
  return hasCustomerRecipient;
}

/**
 * Staff / admin / owner-only notification types — never copy into the booking-engine
 * customer inbox (`customer_notifications`).
 */
const NOT_MIRROR_TO_CUSTOMER_INBOX = new Set<string>([
  "staff_assignment",
  "staff_reassignment",
  "staff_booking_rescheduled",
  "staff_unassigned",
  "additional_issue_accepted",
  "additional_issue_rejected",
  "additional_issue_customer_rejected",
  "staff_rejected",
  "booking_rescheduled",
  "additional_issue_found",
  "staff_booking_created",
  "booking_needs_assignment",
  "booking_engine_new_booking",
  "owner_booking_completed",
  "staff_clocked_in",
  "staff_clocked_out",
  "staff_break_started",
  "staff_break_ended",
]);

/**
 * Duplicate customer-targeted rows from `notifications` into `customer_notifications` so the
 * book-now app and call-center API see the same inbox as estimate replies / additional-work quotes.
 */
async function mirrorBookingEngineCustomerInbox(
  cleanData: Record<string, any>,
  _notificationsDocId: string
): Promise<void> {
  const customerKey =
    String(cleanData.customerUid || "").trim() ||
    String(cleanData.customerEmail || "").trim() ||
    String(cleanData.clientEmail || "").trim();
  const ownerUid = String(cleanData.ownerUid || "").trim();
  const type = String(cleanData.type || "").trim();
  if (!customerKey || !ownerUid) return;
  if (!type || NOT_MIRROR_TO_CUSTOMER_INBOX.has(type)) return;

  const db = adminDb();
  let workshopName = "Workshop";
  try {
    const od = await db.doc(`users/${ownerUid}`).get();
    const u = od.data();
    workshopName =
      String(u?.workshopName || u?.displayName || u?.name || "Workshop").trim() || "Workshop";
  } catch {
    /* ignore */
  }

  const payload: Record<string, any> = {
    customerId: customerKey,
    ownerUid,
    type,
    title: String(cleanData.title || ""),
    message: String(cleanData.message || ""),
    read: false,
    bookingId: cleanData.bookingId ?? null,
    bookingCode: cleanData.bookingCode ?? null,
    branchName: cleanData.branchName ?? null,
    staffName: cleanData.staffName ?? null,
    serviceName: cleanData.serviceName ?? null,
    bookingDate: cleanData.bookingDate ?? null,
    bookingTime: cleanData.bookingTime ?? null,
    estimateId: cleanData.estimateId ?? null,
    issueId: cleanData.issueId ?? null,
    issueTitle: cleanData.issueTitle ?? null,
    price: typeof cleanData.price === "number" ? cleanData.price : null,
    issueStatus: cleanData.issueStatus ?? null,
    issueDescription:
      typeof cleanData.issueDescription === "string" ? cleanData.issueDescription : null,
    customerPhone: resolveCustomerPhoneForStorage(cleanData),
    customerName: resolveCustomerNameForStorage(cleanData),
    ...CUSTOMER_NOTIFICATION_AGENT_TRACKING_DEFAULTS,
    workshopName,
    createdAt: FieldValue.serverTimestamp(),
  };

  await db.collection("customer_notifications").add(stripUndefined(payload));
}

/**
 * Whether a `notifications` row already exists for this booking + additional issue id.
 * Matches `issueId` (current) and legacy `additionalIssueId`.
 */
export async function additionalIssueFoundNotificationExists(
  db: Firestore,
  bookingId: string,
  issueId: string
): Promise<boolean> {
  const id = String(issueId || "").trim();
  const bid = String(bookingId || "").trim();
  if (!id || !bid) return false;
  const snap = await db
    .collection("notifications")
    .where("bookingId", "==", bid)
    .where("type", "==", "additional_issue_found")
    .limit(50)
    .get();
  return snap.docs.some((doc) => {
    const d = doc.data();
    const a = typeof d.issueId === "string" ? d.issueId.trim() : "";
    const b = typeof d.additionalIssueId === "string" ? d.additionalIssueId.trim() : "";
    return a === id || b === id;
  });
}

/**
 * Create a notification (generic)
 */
export async function createNotification(data: Omit<Notification, "id" | "createdAt" | "read">): Promise<string> {
  try {
    const db = adminDb();
    
    // Filter out undefined values to avoid Firestore errors (including nested e.g. services[0].staffId)
    const cleanData: any = {
      read: false,
      createdAt: FieldValue.serverTimestamp(),
    };
    
    // Add all defined values, recursively stripping undefined from nested objects/arrays
    Object.entries(data).forEach(([key, value]) => {
      if (value !== undefined) {
        cleanData[key] = stripUndefined(value);
      }
    });

    const targetsCustomerInApp = shouldAttachCallCenterAgentTracking(cleanData);
    if (targetsCustomerInApp) {
      const ph = resolveCustomerPhoneForStorage(cleanData);
      if (ph) cleanData.customerPhone = ph;
      const nm = resolveCustomerNameForStorage(cleanData);
      if (nm) {
        cleanData.clientName = nm;
        if (!String(cleanData.customerName || "").trim()) cleanData.customerName = nm;
      }
      Object.assign(cleanData, CUSTOMER_NOTIFICATION_AGENT_TRACKING_DEFAULTS);
    }
    
    // CRITICAL: Ensure branchAdminUid is explicitly set (don't allow null/undefined)
    // This is required for mobile app queries to work
    if ((data as any).branchAdminUid !== undefined && (data as any).branchAdminUid !== null) {
      cleanData.branchAdminUid = (data as any).branchAdminUid;
      console.log(`📤 createNotification: Setting branchAdminUid to: ${cleanData.branchAdminUid}`);
    }
    
    // CRITICAL: Ensure targetAdminUid is set if branchAdminUid is set
    if (cleanData.branchAdminUid && !cleanData.targetAdminUid) {
      cleanData.targetAdminUid = cleanData.branchAdminUid;
      console.log(`📤 createNotification: Setting targetAdminUid to match branchAdminUid: ${cleanData.targetAdminUid}`);
    }
    
    console.log(`📤 createNotification: Final notification data - branchAdminUid: ${cleanData.branchAdminUid || "NOT SET"}, targetAdminUid: ${cleanData.targetAdminUid || "NOT SET"}, type: ${cleanData.type || "unknown"}`);
    
    const ref = await db.collection("notifications").add(cleanData);

    try {
      await mirrorBookingEngineCustomerInbox(cleanData, ref.id);
    } catch (mirrorErr) {
      console.error("mirrorBookingEngineCustomerInbox failed:", mirrorErr);
    }
    
    // Send push notification if staffUid, targetAdminUid, targetOwnerUid, branchAdminUid, or customerUid is present
    const staffUid = (data as any).staffUid;
    const targetAdminUid = (data as any).targetAdminUid;
    const targetOwnerUid = (data as any).targetOwnerUid;
    const branchAdminUid = (data as any).branchAdminUid;
    const customerUid = (data as any).customerUid;
    
    // Determine who to send push notification to.
    // Staff assignment / reassignment must always target the technician, not branch admin
    // (some payloads may include multiple UIDs).
    const notificationTypeForPush = String(cleanData.type || "");
    const staffFirstTypes = new Set([
      "staff_assignment",
      "staff_reassignment",
      "staff_booking_rescheduled",
      "staff_unassigned",
      "booking_assigned",
      "booking_approval_request",
    ]);
    const userId =
      staffFirstTypes.has(notificationTypeForPush) && staffUid
        ? staffUid
        : branchAdminUid || targetAdminUid || staffUid || targetOwnerUid || customerUid;
    
    if (userId) {
      const notificationType = cleanData.type || "unknown";
      console.log(`📤 Creating notification type: ${notificationType}, targeting user: ${userId}`);
      console.log(`📤   - branchAdminUid: ${branchAdminUid || "none"}`);
      console.log(`📤   - targetAdminUid: ${targetAdminUid || "none"}`);
      console.log(`📤   - staffUid: ${staffUid || "none"}`);
      console.log(`📤   - targetOwnerUid: ${targetOwnerUid || "none"}`);
      console.log(`📤   - customerUid: ${customerUid || "none"}`);
      console.log(`📤   - Selected userId for push: ${userId}`);
      
      const fcmToken = await getUserFcmToken(userId);
      if (fcmToken) {
        console.log(`📱 FCM token found for user ${userId}, sending push notification...`);
        try {
          await sendPushNotification(
            fcmToken,
            cleanData.title,
            cleanData.message,
            {
              notificationId: ref.id,
              type: cleanData.type,
              bookingId: cleanData.bookingId ?? "",
              bookingCode: cleanData.bookingCode ?? "",
            }
          );
          console.log(`✅ Push notification sent successfully to user: ${userId} for notification type: ${notificationType}`);
        } catch (pushError: any) {
          console.error(`❌ Error sending push notification to user ${userId}:`, pushError);
          console.error(`❌ Push error details:`, pushError?.message || pushError);
          // Don't throw - notification is already created in Firestore
        }
      } else {
        console.log(`⚠️ No FCM token found for user: ${userId} (notification still created in Firestore with ID: ${ref.id})`);
        console.log(`⚠️ User ${userId} needs to have the mobile app open to receive notifications via Firestore listener`);
      }
    } else {
      console.log(`⚠️ No target user found for notification type: ${cleanData.type || "unknown"} (notification still created in Firestore with ID: ${ref.id})`);
      console.log(`⚠️ Notification fields - branchAdminUid: ${branchAdminUid || "none"}, targetAdminUid: ${targetAdminUid || "none"}, staffUid: ${staffUid || "none"}`);
    }
    
    return ref.id;
  } catch (error) {
    console.error("Error creating notification:", error);
    throw error;
  }
}

/**
 * Notify the workshop owner once per booking when it is marked completed.
 * Skips if an owner_booking_completed row already exists for this bookingId.
 */
export async function notifyOwnerBookingCompletedOnce(data: {
  bookingId: string;
  bookingCode?: string;
  ownerUid: string;
  staffName?: string;
  clientName?: string;
  serviceName?: string;
  branchName?: string;
  bookingDate?: string;
  bookingTime?: string;
}): Promise<void> {
  try {
    const db = adminDb();
    const snap = await db
      .collection("notifications")
      .where("bookingId", "==", data.bookingId)
      .limit(40)
      .get();
    if (snap.docs.some((d) => d.data().type === "owner_booking_completed")) {
      return;
    }

    const code = data.bookingCode ? ` ${data.bookingCode}` : "";
    const who = data.staffName?.trim()
      ? `${data.staffName.trim()} marked`
      : "A team member marked";

    await createNotification({
      bookingId: data.bookingId,
      bookingCode: data.bookingCode,
      type: "owner_booking_completed",
      title: "Booking completed",
      message: `${who} booking${code} as completed${data.branchName ? ` · ${data.branchName}` : ""}.`,
      status: "Completed",
      ownerUid: data.ownerUid,
      targetOwnerUid: data.ownerUid,
      staffName: data.staffName,
      clientName: data.clientName,
      serviceName: data.serviceName,
      branchName: data.branchName,
      bookingDate: data.bookingDate,
      bookingTime: data.bookingTime,
    } as Omit<Notification, "id" | "createdAt" | "read">);
  } catch (e) {
    console.error("notifyOwnerBookingCompletedOnce:", e);
  }
}

/**
 * Create a notification for staff member when booking is assigned to them
 */
export async function createStaffAssignmentNotification(data: {
  bookingId: string;
  bookingCode?: string;
  staffUid: string;
  staffName?: string;
  clientName: string;
  clientPhone?: string;
  serviceName?: string;
  services?: Array<{ name: string; staffName?: string; staffId?: string }>;
  branchName?: string;
  bookingDate: string;
  bookingTime: string;
  duration?: number;
  price?: number;
  ownerUid: string;
  isReassignment?: boolean;
}): Promise<string> {
  const isReassignment = data.isReassignment || false;
  const type: StaffNotificationType = isReassignment ? "staff_reassignment" : "staff_assignment";
  
  const serviceList = data.services && data.services.length > 0
    ? data.services.map(s => s.name).join(", ")
    : data.serviceName || "Service";

  const notificationData: Omit<StaffNotification, "id" | "createdAt" | "read"> = {
    bookingId: data.bookingId,
    bookingCode: data.bookingCode,
    type,
    title: isReassignment ? "Booking Reassigned to You" : "New Appointment Request",
    message: isReassignment
      ? `A booking for ${serviceList} with ${data.clientName} on ${data.bookingDate} at ${data.bookingTime} has been reassigned to you. Please review and accept or reject.`
      : `You have a new appointment request from ${data.clientName} for ${serviceList} on ${data.bookingDate} at ${data.bookingTime}. Please accept or reject this booking.`,
    status: "AwaitingStaffApproval",
    ownerUid: data.ownerUid,
    staffUid: data.staffUid,
    staffName: data.staffName,
    clientName: data.clientName,
    clientPhone: data.clientPhone,
    serviceName: data.serviceName,
    services: data.services,
    branchName: data.branchName,
    bookingDate: data.bookingDate,
    bookingTime: data.bookingTime,
    duration: data.duration,
    price: data.price,
  };

  return createNotification(notificationData);
}

/**
 * Notify a staff member whose booking has just been rescheduled (date/time/
 * pick-up changed) while they remain assigned. The message includes both the
 * new and previous slot so the technician can see exactly what shifted.
 */
export async function createStaffBookingRescheduledNotification(data: {
  bookingId: string;
  bookingCode?: string;
  staffUid: string;
  staffName?: string;
  clientName: string;
  clientPhone?: string;
  serviceName?: string;
  services?: Array<{ name: string; staffName?: string; staffId?: string }>;
  branchName?: string;
  previousDate?: string | null;
  previousTime?: string | null;
  previousPickupTime?: string | null;
  bookingDate: string;
  bookingTime: string;
  pickupTime?: string | null;
  reason?: string | null;
  duration?: number;
  price?: number;
  ownerUid: string;
}): Promise<string> {
  const serviceList = data.services && data.services.length > 0
    ? data.services.map((s) => s.name).join(", ")
    : data.serviceName || "Service";
  const newSlot = `${data.bookingDate} at ${data.bookingTime}`;
  const pickup = data.pickupTime ? ` (pick-up at ${data.pickupTime})` : "";
  const prev = data.previousDate && data.previousTime
    ? ` Previously on ${data.previousDate} at ${data.previousTime}${data.previousPickupTime ? ` (pick-up at ${data.previousPickupTime})` : ""}.`
    : "";
  const reasonPart = data.reason ? ` Reason: ${data.reason}.` : "";

  const notificationData: Omit<StaffNotification, "id" | "createdAt" | "read"> & {
    pickupTime?: string | null;
    previousDate?: string | null;
    previousTime?: string | null;
    previousPickupTime?: string | null;
    reason?: string | null;
  } = {
    bookingId: data.bookingId,
    bookingCode: data.bookingCode,
    type: "staff_booking_rescheduled",
    title: "Booking Rescheduled",
    message: `Your booking for ${serviceList} with ${data.clientName} has been rescheduled to ${newSlot}${pickup}.${prev}${reasonPart}`,
    status: "Confirmed",
    ownerUid: data.ownerUid,
    staffUid: data.staffUid,
    staffName: data.staffName,
    clientName: data.clientName,
    clientPhone: data.clientPhone,
    serviceName: data.serviceName,
    services: data.services,
    branchName: data.branchName,
    bookingDate: data.bookingDate,
    bookingTime: data.bookingTime,
    duration: data.duration,
    price: data.price,
    pickupTime: data.pickupTime ?? null,
    previousDate: data.previousDate ?? null,
    previousTime: data.previousTime ?? null,
    previousPickupTime: data.previousPickupTime ?? null,
    reason: data.reason ?? null,
  };

  return createNotification(notificationData as any);
}

/**
 * Notify a staff member whose booking assignment has been removed (i.e. an
 * admin reassigned the booking to a different technician). Counterpart to
 * `createStaffAssignmentNotification` — when a reassignment happens the new
 * staff receives "Booking Reassigned to You" and the old staff receives this
 * "Booking removed from your schedule" message.
 */
export async function createStaffUnassignedNotification(data: {
  bookingId: string;
  bookingCode?: string;
  staffUid: string;
  staffName?: string;
  clientName: string;
  clientPhone?: string;
  serviceName?: string;
  services?: Array<{ name: string; staffName?: string; staffId?: string }>;
  branchName?: string;
  bookingDate: string;
  bookingTime: string;
  reason?: string | null;
  replacedByStaffName?: string | null;
  ownerUid: string;
}): Promise<string> {
  const serviceList = data.services && data.services.length > 0
    ? data.services.map((s) => s.name).join(", ")
    : data.serviceName || "Service";
  const replacedBy = data.replacedByStaffName ? ` It has been reassigned to ${data.replacedByStaffName}.` : "";
  const reasonPart = data.reason ? ` Reason: ${data.reason}.` : "";

  const notificationData: Omit<StaffNotification, "id" | "createdAt" | "read"> & {
    replacedByStaffName?: string | null;
    reason?: string | null;
  } = {
    bookingId: data.bookingId,
    bookingCode: data.bookingCode,
    type: "staff_unassigned",
    title: "Booking Removed from Your Schedule",
    message: `The booking for ${serviceList} with ${data.clientName} on ${data.bookingDate} at ${data.bookingTime} is no longer assigned to you.${replacedBy}${reasonPart}`,
    status: "Canceled",
    ownerUid: data.ownerUid,
    staffUid: data.staffUid,
    staffName: data.staffName,
    clientName: data.clientName,
    clientPhone: data.clientPhone,
    serviceName: data.serviceName,
    services: data.services,
    branchName: data.branchName,
    bookingDate: data.bookingDate,
    bookingTime: data.bookingTime,
    replacedByStaffName: data.replacedByStaffName ?? null,
    reason: data.reason ?? null,
  };

  return createNotification(notificationData as any);
}

/**
 * Create a notification for admin when staff rejects a booking
 */
export async function createAdminRejectionNotification(data: {
  bookingId: string;
  bookingCode?: string;
  ownerUid: string;
  targetAdminUid?: string;
  rejectedByStaffUid: string;
  rejectedByStaffName: string;
  rejectionReason: string;
  clientName: string;
  serviceName?: string;
  services?: Array<{ name: string; staffName?: string; staffId?: string }>;
  branchName?: string;
  bookingDate: string;
  bookingTime: string;
}): Promise<string> {
  const serviceList = data.services && data.services.length > 0
    ? data.services.map(s => s.name).join(", ")
    : data.serviceName || "Service";

  const notificationData: Omit<AdminNotification, "id" | "createdAt" | "read"> = {
    bookingId: data.bookingId,
    bookingCode: data.bookingCode,
    type: "staff_rejected",
    title: "Booking Rejected by Staff",
    message: `${data.rejectedByStaffName} has rejected the booking for ${data.clientName} (${serviceList} on ${data.bookingDate} at ${data.bookingTime}). Reason: "${data.rejectionReason}". Please reassign to another staff member.`,
    status: "StaffRejected",
    ownerUid: data.ownerUid,
    targetAdminUid: data.targetAdminUid,
    rejectedByStaffUid: data.rejectedByStaffUid,
    rejectedByStaffName: data.rejectedByStaffName,
    rejectionReason: data.rejectionReason,
    clientName: data.clientName,
    serviceName: data.serviceName,
    services: data.services,
    branchName: data.branchName,
    bookingDate: data.bookingDate,
    bookingTime: data.bookingTime,
  };

  return createNotification(notificationData);
}

/**
 * Cross-role audit notification sent when a booking is rescheduled by an
 * owner or branch admin. A single call writes one notification targeting a
 * specific recipient (branch admin or owner). The reschedule route fans
 * this out to the "other role" so both panels/mobile inboxes stay in sync.
 */
export async function createBookingRescheduledAuditNotification(data: {
  bookingId: string;
  bookingCode?: string;
  ownerUid: string;
  /** Target audience for this notification */
  audience: "owner" | "branch_admin";
  /** Required when audience === "branch_admin" */
  branchAdminUid?: string;
  branchId?: string;
  /** Set when audience === "owner" (mirrors ownerUid but kept for clarity) */
  targetOwnerUid?: string;
  clientName: string;
  serviceName?: string;
  services?: Array<{ name: string; staffName?: string; staffId?: string }>;
  branchName?: string;
  previousDate?: string | null;
  previousTime?: string | null;
  previousPickupTime?: string | null;
  bookingDate: string;
  bookingTime: string;
  pickupTime?: string | null;
  reason?: string | null;
  /** Who performed the reschedule (for "rescheduled by …" copy) */
  performerUid?: string;
  performerName?: string;
  performerRole?: string;
}): Promise<string> {
  const serviceList = data.services && data.services.length > 0
    ? data.services.map((s) => s.name).join(", ")
    : data.serviceName || "Service";

  const performerLabel =
    data.performerRole === "workshop_owner"
      ? "Owner"
      : data.performerRole === "branch_admin"
        ? "Branch Admin"
        : data.performerRole === "agent" ||
            data.performerRole === "call_center_agent" ||
            data.performerRole === "call_center_admin"
          ? "Call Center"
          : data.performerRole === "super_admin"
            ? "Super Admin"
            : "Admin";
  const performerName = data.performerName?.trim() || performerLabel;
  const newSlot = `${data.bookingDate} at ${data.bookingTime}`;
  const pickup = data.pickupTime ? ` (pick-up at ${data.pickupTime})` : "";
  const prev = data.previousDate && data.previousTime
    ? ` Previously on ${data.previousDate} at ${data.previousTime}${data.previousPickupTime ? ` (pick-up at ${data.previousPickupTime})` : ""}.`
    : "";
  const reasonPart = data.reason ? ` Reason: ${data.reason}.` : "";
  const branchPart = data.branchName ? ` at ${data.branchName}` : "";

  const title = "Booking Rescheduled";
  const message = `${performerName} (${performerLabel}) rescheduled the booking for ${data.clientName} — ${serviceList}${branchPart} — to ${newSlot}${pickup}.${prev}${reasonPart}`;

  const notificationData: any = {
    bookingId: data.bookingId,
    bookingCode: data.bookingCode,
    type: "booking_rescheduled",
    title,
    message,
    status: "Confirmed",
    ownerUid: data.ownerUid,
    clientName: data.clientName,
    serviceName: data.serviceName,
    services: data.services,
    branchName: data.branchName,
    branchId: data.branchId || null,
    bookingDate: data.bookingDate,
    bookingTime: data.bookingTime,
    pickupTime: data.pickupTime ?? null,
    previousDate: data.previousDate ?? null,
    previousTime: data.previousTime ?? null,
    previousPickupTime: data.previousPickupTime ?? null,
    reason: data.reason ?? null,
    performerUid: data.performerUid || null,
    performerName: data.performerName || null,
    performerRole: data.performerRole || null,
    rescheduledByUid: data.performerUid || null,
    rescheduledByName: data.performerName || null,
    rescheduledByRole: data.performerRole || null,
  };

  if (data.audience === "branch_admin") {
    if (!data.branchAdminUid) {
      throw new Error("branchAdminUid is required when audience='branch_admin'");
    }
    notificationData.branchAdminUid = data.branchAdminUid;
    notificationData.targetAdminUid = data.branchAdminUid;
  } else {
    notificationData.targetOwnerUid = data.targetOwnerUid || data.ownerUid;
  }

  return createNotification(notificationData);
}

/**
 * Create a customer confirmation notification (only after staff accepts)
 */
export async function createCustomerConfirmationNotification(data: {
  bookingId: string;
  bookingCode?: string;
  customerUid?: string;
  customerEmail?: string;
  customerPhone?: string;
  clientName?: string;
  staffName?: string;
  serviceName?: string;
  services?: Array<{ name: string; staffName?: string }>;
  branchName?: string;
  bookingDate: string;
  bookingTime: string;
  ownerUid: string;
}): Promise<string> {
  const content = getNotificationContent(
    "Confirmed",
    data.bookingCode,
    data.staffName,
    data.serviceName,
    data.bookingDate,
    data.bookingTime,
    data.services
  );

  const notificationData: Omit<CustomerNotification, "id" | "createdAt" | "read"> = {
    bookingId: data.bookingId,
    bookingCode: data.bookingCode,
    type: content.type,
    title: content.title,
    message: content.message,
    status: "Confirmed",
    ownerUid: data.ownerUid,
    customerUid: data.customerUid,
    customerEmail: data.customerEmail,
    customerPhone: data.customerPhone,
    clientName: data.clientName,
    staffName: data.staffName,
    serviceName: data.serviceName,
    services: data.services,
    branchName: data.branchName,
    bookingDate: data.bookingDate,
    bookingTime: data.bookingTime,
  };

  return createNotification(notificationData);
}

/**
 * Get notification title and message based on status (for customer notifications)
 */
export function getNotificationContent(
  status: BookingStatus, 
  bookingCode?: string,
  staffName?: string,
  serviceName?: string,
  bookingDate?: string,
  bookingTime?: string,
  services?: Array<{ name: string; staffName?: string }>
): { title: string; message: string; type: CustomerNotificationType } {
  const code = bookingCode ? ` (${bookingCode})` : "";
  const datetime = bookingDate && bookingTime ? ` on ${bookingDate} at ${bookingTime}` : "";
  
  let serviceAndStaff = "";
  
  // Check if we have multiple services with specific staff
  if (services && services.length > 0) {
    // Format: " for Facial with John, Hair Cut with Jane"
    const parts = services.map(s => {
      const sName = s.name || "Service";
      const stName = s.staffName && s.staffName !== "Any Available" && s.staffName !== "Any Staff" && s.staffName !== "Not Assigned Yet" ? ` with ${s.staffName}` : "";
      return `${sName}${stName}`;
    });
    serviceAndStaff = ` for ${parts.join(", ")}`;
  } else {
    // Fallback to single service/staff logic
    const service = serviceName ? ` for ${serviceName}` : "";
    // Don't show staff name in the main message if it's "Multiple Staff" or "Any Available"
    const showStaff = staffName && staffName !== "Multiple Staff" && staffName !== "Any Available" && staffName !== "Any Staff" && staffName !== "Not Assigned Yet";
    const staff = showStaff ? ` with ${staffName}` : "";
    serviceAndStaff = `${service}${staff}`;
  }
  
  switch (status) {
    case "Pending":
      return {
        title: "Booking Request Received",
        message: `Your booking request${code}${serviceAndStaff} has been received successfully! We'll confirm your appointment soon.`,
        type: "booking_status_changed"
      };
    case "AwaitingStaffApproval":
      // Customer sees this as "processing" - don't reveal internal workflow
      return {
        title: "Booking Being Processed",
        message: `Your booking request${code}${serviceAndStaff}${datetime} is being processed. We'll notify you once it's confirmed.`,
        type: "booking_status_changed"
      };
    case "StaffRejected":
      // Customer sees this as "being rescheduled" - don't reveal staff rejection
      return {
        title: "Booking Being Rescheduled",
        message: `Your booking${code}${serviceAndStaff}${datetime} is being rescheduled. We'll notify you with updated details soon.`,
        type: "booking_status_changed"
      };
    case "Confirmed":
      return {
        title: "Booking Confirmed",
        message: `Your booking${code}${serviceAndStaff}${datetime} has been confirmed. We look forward to seeing you!`,
        type: "booking_confirmed"
      };
    case "Completed":
      return {
        title: "Booking Completed",
        message: `Your booking${code}${serviceAndStaff} has been completed. Thank you for visiting us!`,
        type: "booking_completed"
      };
    case "Canceled":
      return {
        title: "Booking Canceled",
        message: `Your booking${code}${serviceAndStaff}${datetime} has been canceled. Please contact us if you have any questions.`,
        type: "booking_canceled"
      };
    default:
      return {
        title: "Booking Status Updated",
        message: `Your booking${code} status has been updated to ${status}.`,
        type: "booking_status_changed"
      };
  }
}

/**
 * Create a customer notification for when the booking is completed
 * This is sent when all services in a booking are marked as completed by staff
 */
export async function createCustomerCompletionNotification(data: {
  bookingId: string;
  bookingCode?: string;
  customerUid?: string;
  customerEmail?: string;
  customerPhone?: string;
  clientName?: string;
  staffName?: string;
  serviceName?: string;
  services?: Array<{ name: string; staffName?: string }>;
  branchName?: string;
  bookingDate?: string;
  bookingTime?: string;
  ownerUid: string;
}): Promise<string> {
  const content = getNotificationContent(
    "Completed",
    data.bookingCode,
    data.staffName,
    data.serviceName,
    data.bookingDate,
    data.bookingTime,
    data.services
  );

  const notificationData: Omit<CustomerNotification, "id" | "createdAt" | "read"> = {
    bookingId: data.bookingId,
    bookingCode: data.bookingCode,
    type: content.type,
    title: content.title,
    message: content.message,
    status: "Completed",
    ownerUid: data.ownerUid,
    customerUid: data.customerUid,
    customerEmail: data.customerEmail,
    customerPhone: data.customerPhone,
    clientName: data.clientName,
    staffName: data.staffName,
    serviceName: data.serviceName,
    services: data.services,
    branchName: data.branchName,
    bookingDate: data.bookingDate,
    bookingTime: data.bookingTime,
  };

  return createNotification(notificationData);
}

/**
 * Create a customer notification for when the booking is being rescheduled
 * This is a customer-friendly way to inform them about reassignment
 * (without exposing internal workflow details like staff rejection)
 */
export async function createCustomerReschedulingNotification(data: {
  bookingId: string;
  bookingCode?: string;
  customerUid?: string;
  customerEmail?: string;
  customerPhone?: string;
  clientName?: string;
  staffName?: string;
  serviceName?: string;
  services?: Array<{ name: string; staffName?: string }>;
  branchName?: string;
  bookingDate: string;
  bookingTime: string;
  ownerUid: string;
}): Promise<string> {
  const content = getNotificationContent(
    "StaffRejected", // This will show as "Being Rescheduled" to customer
    data.bookingCode,
    data.staffName,
    data.serviceName,
    data.bookingDate,
    data.bookingTime,
    data.services
  );

  const notificationData: Omit<CustomerNotification, "id" | "createdAt" | "read"> = {
    bookingId: data.bookingId,
    bookingCode: data.bookingCode,
    type: content.type,
    title: content.title,
    message: content.message,
    status: "StaffRejected",
    ownerUid: data.ownerUid,
    customerUid: data.customerUid,
    customerEmail: data.customerEmail,
    customerPhone: data.customerPhone,
    clientName: data.clientName,
    staffName: data.staffName,
    serviceName: data.serviceName,
    services: data.services,
    branchName: data.branchName,
    bookingDate: data.bookingDate,
    bookingTime: data.bookingTime,
  };

  return createNotification(notificationData);
}

/**
 * Create a customer notification for when an owner/branch admin has just
 * *rescheduled* the booking (new date/time/pick-up time/staff). This is
 * distinct from `createCustomerReschedulingNotification` which is used for
 * the "being rescheduled" placeholder after a staff rejection — here the
 * new slot is already known, so the message includes the concrete details.
 */
export async function createCustomerBookingRescheduledNotification(data: {
  bookingId: string;
  bookingCode?: string;
  customerUid?: string;
  customerEmail?: string;
  customerPhone?: string;
  clientName?: string;
  staffName?: string;
  serviceName?: string;
  services?: Array<{ name: string; staffName?: string }>;
  branchName?: string;
  previousDate?: string | null;
  previousTime?: string | null;
  previousPickupTime?: string | null;
  bookingDate: string;
  bookingTime: string;
  pickupTime?: string | null;
  reason?: string | null;
  ownerUid: string;
}): Promise<string> {
  const code = data.bookingCode ? ` (${data.bookingCode})` : "";

  // Service / staff summary – mirrors the formatting used by getNotificationContent
  let serviceAndStaff = "";
  if (data.services && data.services.length > 0) {
    const parts = data.services.map((s) => {
      const sName = s.name || "Service";
      const skip = new Set(["Any Available", "Any Staff", "Not Assigned Yet", "Multiple Staff"]);
      const stName = s.staffName && !skip.has(s.staffName) ? ` with ${s.staffName}` : "";
      return `${sName}${stName}`;
    });
    serviceAndStaff = ` for ${parts.join(", ")}`;
  } else if (data.serviceName) {
    const skip = new Set(["Any Available", "Any Staff", "Not Assigned Yet", "Multiple Staff"]);
    const stName = data.staffName && !skip.has(data.staffName) ? ` with ${data.staffName}` : "";
    serviceAndStaff = ` for ${data.serviceName}${stName}`;
  }

  const newSlot = `${data.bookingDate} at ${data.bookingTime}`;
  const pickup = data.pickupTime ? ` (pick-up at ${data.pickupTime})` : "";
  const prev = data.previousDate && data.previousTime
    ? ` Previously on ${data.previousDate} at ${data.previousTime}${data.previousPickupTime ? ` (pick-up at ${data.previousPickupTime})` : ""}.`
    : "";
  const reasonPart = data.reason ? ` Reason: ${data.reason}.` : "";

  const title = "Booking Rescheduled";
  const message = `Your booking${code}${serviceAndStaff} has been rescheduled to ${newSlot}${pickup}.${prev}${reasonPart}`;

  const notificationData: Omit<CustomerNotification, "id" | "createdAt" | "read"> & {
    pickupTime?: string | null;
    previousDate?: string | null;
    previousTime?: string | null;
    previousPickupTime?: string | null;
    reason?: string | null;
  } = {
    bookingId: data.bookingId,
    bookingCode: data.bookingCode,
    type: "booking_status_changed",
    title,
    message,
    status: "Confirmed",
    ownerUid: data.ownerUid,
    customerUid: data.customerUid,
    customerEmail: data.customerEmail,
    customerPhone: data.customerPhone,
    clientName: data.clientName,
    staffName: data.staffName,
    serviceName: data.serviceName,
    services: data.services,
    branchName: data.branchName,
    bookingDate: data.bookingDate,
    bookingTime: data.bookingTime,
    pickupTime: data.pickupTime ?? null,
    previousDate: data.previousDate ?? null,
    previousTime: data.previousTime ?? null,
    previousPickupTime: data.previousPickupTime ?? null,
    reason: data.reason ?? null,
  };

  return createNotification(notificationData as any);
}

/**
 * Create a customer notification for when the booking is canceled
 */
export async function createCustomerCancellationNotification(data: {
  bookingId: string;
  bookingCode?: string;
  customerUid?: string;
  customerEmail?: string;
  customerPhone?: string;
  clientName?: string;
  staffName?: string;
  serviceName?: string;
  services?: Array<{ name: string; staffName?: string }>;
  branchName?: string;
  bookingDate?: string;
  bookingTime?: string;
  ownerUid: string;
}): Promise<string> {
  const content = getNotificationContent(
    "Canceled",
    data.bookingCode,
    data.staffName,
    data.serviceName,
    data.bookingDate,
    data.bookingTime,
    data.services
  );

  const notificationData: Omit<CustomerNotification, "id" | "createdAt" | "read"> = {
    bookingId: data.bookingId,
    bookingCode: data.bookingCode,
    type: content.type,
    title: content.title,
    message: content.message,
    status: "Canceled",
    ownerUid: data.ownerUid,
    customerUid: data.customerUid,
    customerEmail: data.customerEmail,
    customerPhone: data.customerPhone,
    clientName: data.clientName,
    staffName: data.staffName,
    serviceName: data.serviceName,
    services: data.services,
    branchName: data.branchName,
    bookingDate: data.bookingDate,
    bookingTime: data.bookingTime,
  };

  return createNotification(notificationData);
}

/**
 * Create a notification for staff when customer accepts an additional issue quote.
 * Staff can then proceed with the repair work.
 */
export async function createAdditionalIssueAcceptedNotification(data: {
  bookingId: string;
  bookingCode?: string;
  staffUid: string;
  staffName?: string;
  clientName: string;
  issueTitle: string;
  price?: number;
  serviceName?: string;
  branchName?: string;
  bookingDate?: string;
  bookingTime?: string;
  ownerUid: string;
}): Promise<string> {
  const priceStr = data.price != null ? `$${data.price.toFixed(2)}` : "";
  const notificationData: Omit<StaffNotification, "id" | "createdAt" | "read"> = {
    bookingId: data.bookingId,
    bookingCode: data.bookingCode,
    type: "additional_issue_accepted",
    title: "Customer Accepted Additional Work",
    message: `${data.clientName} accepted ${data.issueTitle}${priceStr ? ` (${priceStr})` : ""}. You can proceed with the repair.`,
    status: "Confirmed",
    ownerUid: data.ownerUid,
    staffUid: data.staffUid,
    staffName: data.staffName,
    clientName: data.clientName,
    serviceName: data.serviceName,
    branchName: data.branchName,
    bookingDate: data.bookingDate,
    bookingTime: data.bookingTime,
    price: data.price,
  };

  return createNotification(notificationData);
}

/**
 * Notify staff when admin rejects their additional issue.
 * Staff app will show the issue as rejected via Firestore listener; this notification prompts them to check.
 */
export async function createAdditionalIssueRejectedNotification(data: {
  bookingId: string;
  bookingCode?: string;
  staffUid: string;
  staffName?: string;
  clientName: string;
  issueTitle: string;
  serviceName?: string;
  branchName?: string;
  bookingDate?: string;
  bookingTime?: string;
  ownerUid: string;
}): Promise<string> {
  const notificationData: Omit<StaffNotification, "id" | "createdAt" | "read"> = {
    bookingId: data.bookingId,
    bookingCode: data.bookingCode,
    type: "additional_issue_rejected" as any,
    title: "Additional Work Not Approved",
    message: `Your additional work "${data.issueTitle}" for ${data.clientName} was not approved. Check the booking for details.`,
    status: "Confirmed",
    ownerUid: data.ownerUid,
    staffUid: data.staffUid,
    staffName: data.staffName,
    clientName: data.clientName,
    serviceName: data.serviceName,
    branchName: data.branchName,
    bookingDate: data.bookingDate,
    bookingTime: data.bookingTime,
  };

  return createNotification(notificationData);
}

/**
 * Notify staff when customer declines their additional issue quote.
 */
export async function createAdditionalIssueCustomerRejectedNotification(data: {
  bookingId: string;
  bookingCode?: string;
  staffUid: string;
  staffName?: string;
  clientName: string;
  issueTitle: string;
  serviceName?: string;
  branchName?: string;
  bookingDate?: string;
  bookingTime?: string;
  ownerUid: string;
}): Promise<string> {
  const notificationData: Omit<StaffNotification, "id" | "createdAt" | "read"> = {
    bookingId: data.bookingId,
    bookingCode: data.bookingCode,
    type: "additional_issue_customer_rejected" as any,
    title: "Customer Declined Additional Work",
    message: `${data.clientName} declined ${data.issueTitle}. Check the booking for details.`,
    status: "Confirmed",
    ownerUid: data.ownerUid,
    staffUid: data.staffUid,
    staffName: data.staffName,
    clientName: data.clientName,
    serviceName: data.serviceName,
    branchName: data.branchName,
    bookingDate: data.bookingDate,
    bookingTime: data.bookingTime,
  };

  return createNotification(notificationData);
}

/**
 * Get staff-facing notification content
 */
export function getStaffNotificationContent(
  type: StaffNotificationType,
  bookingCode?: string,
  clientName?: string,
  serviceName?: string,
  bookingDate?: string,
  bookingTime?: string,
  services?: Array<{ name: string; staffName?: string }>
): { title: string; message: string } {
  const code = bookingCode ? ` (${bookingCode})` : "";
  const datetime = bookingDate && bookingTime ? ` on ${bookingDate} at ${bookingTime}` : "";
  
  const serviceList = services && services.length > 0
    ? services.map(s => s.name).join(", ")
    : serviceName || "Service";
  
  switch (type) {
    case "staff_assignment":
      return {
        title: "New Appointment Request",
        message: `You have a new appointment request${code} from ${clientName || "a customer"} for ${serviceList}${datetime}. Please accept or reject.`
      };
    case "staff_reassignment":
      return {
        title: "Booking Reassigned to You",
        message: `A booking${code} for ${serviceList} with ${clientName || "a customer"}${datetime} has been reassigned to you. Please accept or reject.`
      };
    case "staff_booking_rescheduled":
      return {
        title: "Booking Rescheduled",
        message: `Your booking${code} for ${serviceList} with ${clientName || "a customer"} has been rescheduled${datetime}.`
      };
    case "staff_unassigned":
      return {
        title: "Booking Removed from Your Schedule",
        message: `The booking${code} for ${serviceList} with ${clientName || "a customer"}${datetime} is no longer assigned to you.`
      };
    default:
      return {
        title: "Booking Update",
        message: `There's an update to booking${code}.`
      };
  }
}

/**
 * Get admin-facing notification content for staff actions
 * NOTE: Only staff_rejected notifications are shown to admin
 * (staff_accepted is not shown per business logic - admin doesn't need to know)
 */
export function getAdminNotificationContent(
  type: AdminNotificationType,
  staffName: string,
  clientName?: string,
  serviceName?: string,
  bookingCode?: string,
  bookingDate?: string,
  bookingTime?: string,
  rejectionReason?: string
): { title: string; message: string } {
  const code = bookingCode ? ` (${bookingCode})` : "";
  const datetime = bookingDate && bookingTime ? ` on ${bookingDate} at ${bookingTime}` : "";
  
  switch (type) {
    case "staff_rejected":
      return {
        title: "Booking Rejected by Staff",
        message: `${staffName} has rejected the booking${code} for ${clientName || "customer"}${datetime}. Reason: "${rejectionReason || "Not specified"}". Please reassign to another staff member.`
      };
    default:
      return {
        title: "Staff Action",
        message: `${staffName} took action on booking${code}.`
      };
  }
}

/**
 * Create a notification for the salon owner when staff creates a booking
 */
export async function createOwnerNotification(data: {
  bookingId: string;
  bookingCode?: string;
  ownerUid: string;
  clientName: string;
  serviceName?: string;
  services?: Array<{ name: string; staffName?: string; staffId?: string }>;
  branchName?: string;
  branchId?: string;
  bookingDate: string;
  bookingTime: string;
  creatorUid?: string;
  creatorName?: string;
  creatorRole?: string;
  type: OwnerNotificationType;
  status?: BookingStatus;
}): Promise<string> {
  const serviceList = data.services && data.services.length > 0
    ? data.services.map(s => s.name).join(", ")
    : data.serviceName || "Service";

  let title: string;
  let message: string;

  switch (data.type) {
    case "staff_booking_created": {
      const roleLabel =
        data.creatorRole === "branch_admin"
          ? "Branch Admin"
          : data.creatorRole === "call_center_agent" ||
              data.creatorRole === "agent" ||
              data.creatorRole === "call_center_admin"
            ? "Call Center"
            : "Staff";
      title = `New Booking Created by ${roleLabel}`;
      message = `${data.creatorName || roleLabel} created a booking for ${data.clientName} - ${serviceList} at ${data.branchName || "Branch"} on ${data.bookingDate} at ${data.bookingTime}`;
      break;
    }
    case "booking_needs_assignment":
      title = "New Booking - Staff Assignment Required";
      message = data.branchName
        ? `New booking from ${data.clientName} for ${serviceList} at ${data.branchName} on ${data.bookingDate} at ${data.bookingTime}. Please assign staff.`
        : `New booking from ${data.clientName} for ${serviceList} on ${data.bookingDate} at ${data.bookingTime}. Please assign staff.`;
      break;
    case "booking_engine_new_booking":
      title = "New Online Booking";
      message = `${data.clientName} booked ${serviceList} at ${data.branchName || "Branch"} on ${data.bookingDate} at ${data.bookingTime}`;
      break;
    default:
      title = "New Booking Notification";
      message = `New booking for ${data.clientName} - ${serviceList} on ${data.bookingDate} at ${data.bookingTime}`;
  }

  const notificationData: Omit<OwnerNotification, "id" | "createdAt" | "read"> = {
    bookingId: data.bookingId,
    bookingCode: data.bookingCode,
    type: data.type,
    title,
    message,
    status: data.status || "Pending",
    ownerUid: data.ownerUid,
    targetOwnerUid: data.ownerUid, // Explicitly target the owner
    clientName: data.clientName,
    serviceName: data.serviceName,
    services: data.services,
    branchName: data.branchName,
    branchId: data.branchId, // Include branchId for branch admin filtering
    bookingDate: data.bookingDate,
    bookingTime: data.bookingTime,
    creatorUid: data.creatorUid,
    creatorName: data.creatorName,
    creatorRole: data.creatorRole,
  };

  return createNotification(notificationData);
}

/**
 * Get all branch admin UIDs for a branch.
 * Branch admins are stored in the users collection with role='branch_admin' and matching branchId.
 */
export async function getBranchAdminUids(db: Firestore, branchId: string, ownerUid: string): Promise<string[]> {
  try {
    const branchAdminQuery = await db.collection("users")
      .where("ownerUid", "==", ownerUid)
      .where("role", "in", ["branch_admin"])
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
 * Create a notification for branch admin when a booking is created for their branch
 */
export async function createBranchAdminNotification(data: {
  bookingId: string;
  bookingCode?: string;
  branchAdminUid: string;
  ownerUid: string;
  clientName: string;
  serviceName?: string;
  services?: Array<{ name: string; staffName?: string; staffId?: string }>;
  branchName?: string;
  branchId?: string;
  bookingDate: string;
  bookingTime: string;
  status?: BookingStatus;
  type?: "booking_engine_new_booking" | "booking_needs_assignment" | "branch_booking_created" | "additional_issue_found" | "additional_issue_customer_accepted" | "additional_issue_customer_rejected";
  title?: string;
  message?: string;
  /** Call center / dashboards — stored on `notifications` for additional work alerts */
  clientPhone?: string;
  customerPhone?: string;
  clientEmail?: string;
  customerEmail?: string;
  /** `additional_issue_found` — links notification to `bookings/{id}.additionalIssues[]` */
  issueId?: string;
  issueTitle?: string;
  price?: number | null;
  issueStatus?: string;
  issueDescription?: string;
}): Promise<string> {
  const serviceList = data.services && data.services.length > 0
    ? data.services.map(s => s.name).join(", ")
    : data.serviceName || "Service";

  const notificationType = data.type || "branch_booking_created";
  const title = data.title || (notificationType === "booking_needs_assignment" 
    ? "New Booking - Staff Assignment Required"
    : "New Booking for Your Branch");
  const message = data.message || (notificationType === "booking_needs_assignment"
    ? `New booking from ${data.clientName} for ${serviceList} on ${data.bookingDate} at ${data.bookingTime}. Please assign staff.`
    : `${data.clientName} booked ${serviceList} at ${data.branchName || "Your branch"} on ${data.bookingDate} at ${data.bookingTime}`);

  const notificationData: any = {
    bookingId: data.bookingId,
    bookingCode: data.bookingCode,
    type: notificationType,
    title,
    message,
    status: data.status || "Pending",
    ownerUid: data.ownerUid,
    branchAdminUid: data.branchAdminUid, // Target the branch admin - CRITICAL for mobile app queries
    targetAdminUid: data.branchAdminUid, // Also set targetAdminUid for mobile app queries
    branchId: data.branchId || null, // Include branchId for branch admin filtering - CRITICAL
    clientName: data.clientName,
    serviceName: data.serviceName,
    services: data.services,
    branchName: data.branchName,
    bookingDate: data.bookingDate,
    bookingTime: data.bookingTime,
  };

  const ph = String(data.customerPhone || data.clientPhone || "").trim();
  if (ph) {
    notificationData.customerPhone = ph;
    notificationData.clientPhone = ph;
  }
  const em = String(data.customerEmail || data.clientEmail || "").trim();
  if (em) {
    notificationData.customerEmail = em;
    notificationData.clientEmail = em;
  }

  if (data.issueId !== undefined && data.issueId !== null && String(data.issueId).trim()) {
    notificationData.issueId = String(data.issueId).trim();
  }
  if (data.issueTitle !== undefined && data.issueTitle != null && String(data.issueTitle).trim()) {
    notificationData.issueTitle = String(data.issueTitle).trim();
  }
  if (typeof data.price === "number" && Number.isFinite(data.price)) {
    notificationData.price = data.price;
  }
  if (data.issueStatus !== undefined && data.issueStatus != null && String(data.issueStatus).trim()) {
    notificationData.issueStatus = String(data.issueStatus).trim();
  }
  if (
    data.issueDescription !== undefined &&
    data.issueDescription != null &&
    String(data.issueDescription).trim()
  ) {
    notificationData.issueDescription = String(data.issueDescription).trim().slice(0, 2000);
  }

  // Ensure branchAdminUid is set (required for mobile app to receive notification)
  if (!notificationData.branchAdminUid) {
    console.error(`❌ createBranchAdminNotification: branchAdminUid is missing! This notification will not be received by the mobile app.`);
    throw new Error("branchAdminUid is required for branch admin notifications");
  }
  
  console.log(`📤 createBranchAdminNotification: Creating notification for branchAdminUid: ${notificationData.branchAdminUid}, branchId: ${notificationData.branchId}, type: ${notificationType}`);
  
  const notificationId = await createNotification(notificationData);
  
  // Verify the notification was created with correct fields
  try {
    const db = adminDb();
    const verifyDoc = await db.collection("notifications").doc(notificationId).get();
    if (verifyDoc.exists) {
      const verifyData = verifyDoc.data();
      console.log(`✅ createBranchAdminNotification: Verified notification ${notificationId}`);
      console.log(`   - branchAdminUid: ${verifyData?.branchAdminUid} (expected: ${data.branchAdminUid})`);
      console.log(`   - targetAdminUid: ${verifyData?.targetAdminUid} (expected: ${data.branchAdminUid})`);
      console.log(`   - branchId: ${verifyData?.branchId} (expected: ${data.branchId})`);
      console.log(`   - type: ${verifyData?.type}`);
      
      if (verifyData?.branchAdminUid !== data.branchAdminUid) {
        console.error(`❌ createBranchAdminNotification: CRITICAL - branchAdminUid mismatch!`);
      }
      if (!verifyData?.branchId || verifyData.branchId !== data.branchId) {
        console.error(`❌ createBranchAdminNotification: CRITICAL - branchId missing or incorrect!`);
      }
    } else {
      console.error(`❌ createBranchAdminNotification: Notification ${notificationId} was not found in Firestore!`);
    }
  } catch (verifyError) {
    console.error(`❌ createBranchAdminNotification: Error verifying notification:`, verifyError);
  }
  
  return notificationId;
}

/** Send FCM to a user's device using `users` / `salon_staff` token lookup. */
export async function sendPushToUserByUid(
  userUid: string,
  title: string,
  body: string,
  data?: Record<string, string>
): Promise<void> {
  const token = await getUserFcmToken(userUid);
  if (!token) {
    console.log(`⚠️ sendPushToUserByUid: no FCM token for ${userUid}`);
    return;
  }
  await sendPushNotification(token, title, body, data);
}

