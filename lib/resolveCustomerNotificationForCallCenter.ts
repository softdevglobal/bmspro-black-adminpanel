import type { DocumentData, DocumentReference } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebaseAdmin";
import { isCustomerFacingNotificationsDoc } from "@/lib/callCenterCustomerInboxFilters";
import { CALL_CENTER_OPS_NOTIFICATION_TYPES } from "@/lib/callCenterNotificationFeedExtras";

const OPS_TRACKABLE = new Set<string>(CALL_CENTER_OPS_NOTIFICATION_TYPES);

/** Docs the call-center GET feed can show from `notifications`; POST reviewed/called must accept the same ids. */
function isCallCenterTrackableNotificationsDoc(d: DocumentData): boolean {
  if (isCustomerFacingNotificationsDoc(d)) return true;
  const t = String(d.type || "");
  return OPS_TRACKABLE.has(t);
}

export type ResolvedCallCenterNotification = {
  ref: DocumentReference;
  collectionId: "customer_notifications" | "notifications";
  ownerUid: string;
};

export type ResolveCustomerNotificationFailure =
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "not_customer_facing" }
  | { ok: false; reason: "missing_owner" };

/**
 * Resolve a notification id to a Firestore ref agents may update for call-center tracking.
 * Tries `customer_notifications` first, then customer-facing rows in `notifications`.
 */
export async function resolveCustomerNotificationForCallCenter(
  notificationId: string
): Promise<{ ok: true; doc: ResolvedCallCenterNotification } | ResolveCustomerNotificationFailure> {
  const id = String(notificationId || "").trim();
  if (!id) return { ok: false, reason: "not_found" };

  const db = adminDb();

  const cn = await db.collection("customer_notifications").doc(id).get();
  if (cn.exists) {
    const d = cn.data()!;
    const ownerUid = String(d.ownerUid || "").trim();
    if (!ownerUid) return { ok: false, reason: "missing_owner" };
    return {
      ok: true,
      doc: { ref: cn.ref, collectionId: "customer_notifications", ownerUid },
    };
  }

  const n = await db.collection("notifications").doc(id).get();
  if (!n.exists) return { ok: false, reason: "not_found" };

  const d = n.data()!;
  if (!isCallCenterTrackableNotificationsDoc(d)) {
    return { ok: false, reason: "not_customer_facing" };
  }
  const ownerUid = String(d.ownerUid || "").trim();
  if (!ownerUid) return { ok: false, reason: "missing_owner" };

  return {
    ok: true,
    doc: { ref: n.ref, collectionId: "notifications", ownerUid },
  };
}
