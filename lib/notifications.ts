import { adminDb, adminMessaging } from "@/lib/firebaseAdmin";
import { FieldValue } from "firebase-admin/firestore";
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
  | "staff_reassignment";   // Staff receives reassigned booking

// Admin-facing notification types
// NOTE: staff_accepted is NOT sent to admin panel (per business logic).
// Admins only receive notifications for:
// 1. New bookings (booking_engine_new_booking, staff_booking_created, booking_needs_assignment)
// 2. Staff rejections (staff_rejected) - admin needs to reassign or cancel
export type AdminNotificationType = 
  | "staff_rejected";       // Staff rejected a booking - admin needs to reassign

// Owner-facing notification types (for staff-created bookings, etc.)
export type OwnerNotificationType =
  | "staff_booking_created"       // Staff created a booking
  | "booking_needs_assignment"    // Booking needs staff assignment
  | "booking_engine_new_booking"; // New booking from booking engine

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
    
    console.log(`⚠️ No FCM token found for user: ${userUid} (checked both users and salon_staff collections)`);
    return null;
  } catch (error) {
    console.error(`❌ Error getting FCM token for user ${userUid}:`, error);
    return null;
  }
}

/**
 * Create a notification (generic)
 */
export async function createNotification(data: Omit<Notification, "id" | "createdAt" | "read">): Promise<string> {
  try {
    const db = adminDb();
    
    // Filter out undefined values to avoid Firestore errors
    const cleanData: any = {
      read: false,
      createdAt: FieldValue.serverTimestamp(),
    };
    
    // Add all defined values
    Object.entries(data).forEach(([key, value]) => {
      if (value !== undefined) {
        cleanData[key] = value;
      }
    });
    
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
    
    // Send push notification if staffUid, targetAdminUid, targetOwnerUid, branchAdminUid, or customerUid is present
    const staffUid = (data as any).staffUid;
    const targetAdminUid = (data as any).targetAdminUid;
    const targetOwnerUid = (data as any).targetOwnerUid;
    const branchAdminUid = (data as any).branchAdminUid;
    const customerUid = (data as any).customerUid;
    
    // Determine who to send push notification to
    // Priority: branchAdminUid > targetAdminUid > staffUid > targetOwnerUid > customerUid
    const userId = branchAdminUid || targetAdminUid || staffUid || targetOwnerUid || customerUid;
    
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
              bookingId: cleanData.bookingId,
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
      const stName = s.staffName && s.staffName !== "Any Available" && s.staffName !== "Any Staff" ? ` with ${s.staffName}` : "";
      return `${sName}${stName}`;
    });
    serviceAndStaff = ` for ${parts.join(", ")}`;
  } else {
    // Fallback to single service/staff logic
    const service = serviceName ? ` for ${serviceName}` : "";
    // Don't show staff name in the main message if it's "Multiple Staff" or "Any Available"
    const showStaff = staffName && staffName !== "Multiple Staff" && staffName !== "Any Available" && staffName !== "Any Staff";
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
    case "staff_booking_created":
      const roleLabel = data.creatorRole === "salon_branch_admin" ? "Branch Admin" : "Staff";
      title = `New Booking Created by ${roleLabel}`;
      message = `${data.creatorName || "Staff"} created a booking for ${data.clientName} - ${serviceList} at ${data.branchName || "Branch"} on ${data.bookingDate} at ${data.bookingTime}`;
      break;
    case "booking_needs_assignment":
      title = "New Booking - Staff Assignment Required";
      message = `New booking from ${data.clientName} for ${serviceList} on ${data.bookingDate} at ${data.bookingTime}. Please assign staff.`;
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
  type?: "booking_engine_new_booking" | "booking_needs_assignment" | "branch_booking_created";
  title?: string;
  message?: string;
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

