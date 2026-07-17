import type { DocumentData } from "firebase-admin/firestore";

/** Same blocklist as `lib/notifications` mirror — not shown as customer inbox. */
export const NOT_CUSTOMER_INBOX_NOTIFICATION_TYPES = new Set([
  "staff_assignment",
  "staff_reassignment",
  "additional_issue_accepted",
  "additional_issue_rejected",
  "additional_issue_customer_rejected",
  "staff_rejected",
  "additional_issue_found",
  "staff_booking_created",
  "booking_needs_assignment",
  "booking_engine_new_booking",
]);

export const LEGACY_BOOKING_TYPES_FOR_FULL_SCAN = [
  "booking_confirmed",
  "booking_completed",
  "booking_canceled",
  "booking_status_changed",
] as const;

/** Customer inbox types in `notifications` (not only booking lifecycle). */
export const LEGACY_CUSTOMER_EXTRA_TYPES_FOR_FULL_SCAN = [
  "estimate_reply",
  "additional_issue_quote",
  "quotation_sent",
  "invoice_sent",
] as const;

export const BOOKING_CUSTOMER_NOTIFICATION_TYPES = new Set<string>(LEGACY_BOOKING_TYPES_FOR_FULL_SCAN);

/** Types that target customers and may use email (no Firebase `customerUid`) on `notifications` rows. */
export const CUSTOMER_INBOX_TYPES_EMAIL_OK = new Set([
  "estimate_reply",
  "additional_issue_quote",
  "quotation_sent",
  "invoice_sent",
]);

export function isCustomerFacingNotificationsDoc(d: DocumentData): boolean {
  const t = String(d.type || "");
  if (t && NOT_CUSTOMER_INBOX_NOTIFICATION_TYPES.has(t)) return false;

  const uid = d.customerUid;
  if (typeof uid === "string" && uid.trim()) return true;

  if (BOOKING_CUSTOMER_NOTIFICATION_TYPES.has(t)) {
    const em =
      (typeof d.customerEmail === "string" && d.customerEmail.trim()) ||
      (typeof d.clientEmail === "string" && d.clientEmail.trim());
    const phone =
      (typeof d.clientPhone === "string" && d.clientPhone.trim()) ||
      (typeof d.customerPhone === "string" && d.customerPhone.trim());
    /** Phone-only / walk-in bookings still get lifecycle rows in `notifications`. */
    if (em || phone) return true;
  }

  if (t && CUSTOMER_INBOX_TYPES_EMAIL_OK.has(t)) {
    const em =
      (typeof d.customerEmail === "string" && d.customerEmail.trim()) ||
      (typeof d.clientEmail === "string" && d.clientEmail.trim());
    if (em) return true;
  }

  return false;
}
