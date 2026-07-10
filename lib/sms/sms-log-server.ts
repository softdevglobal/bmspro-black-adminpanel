import "server-only";

import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebaseAdmin";
import {
  SMS_LOGS_COLLECTION,
  type AppendSmsLogInput,
  type SmsLogEntry,
} from "@/lib/sms/sms-log-types";

function toDate(value: unknown): Date | null {
  if (value instanceof Timestamp) return value.toDate();
  if (value instanceof Date) return value;
  return null;
}

function mapLogDoc(id: string, data: FirebaseFirestore.DocumentData): SmsLogEntry {
  const ownerUid =
    typeof data.ownerUid === "string"
      ? data.ownerUid
      : typeof data.businessId === "string"
        ? data.businessId
        : null;

  return {
    id,
    ownerUid,
    businessId: ownerUid,
    senderName: String(data.senderName ?? "System"),
    receiverPhone: String(data.receiverPhone ?? ""),
    receiverName: data.receiverName != null ? String(data.receiverName) : null,
    message: String(data.message ?? ""),
    status: data.status === "sent" || data.status === "failed" ? data.status : "skipped",
    statusDetail: String(data.statusDetail ?? ""),
    source: String(data.source ?? "unknown"),
    createdAt: toDate(data.createdAt),
  };
}

export async function appendSmsLog(input: AppendSmsLogInput): Promise<void> {
  try {
    const ownerUid = input.ownerUid ?? input.businessId ?? null;
    await adminDb()
      .collection(SMS_LOGS_COLLECTION)
      .add({
        ownerUid,
        businessId: ownerUid,
        senderName: input.senderName ?? "System",
        receiverPhone: input.receiverPhone,
        receiverName: input.receiverName ?? null,
        message: input.message,
        status: input.status,
        statusDetail: input.statusDetail,
        source: input.source,
        createdAt: FieldValue.serverTimestamp(),
      });
  } catch (error) {
    console.error("[SMS] Failed to append sms log:", error);
  }
}

export async function listSmsLogs(limit = 200): Promise<SmsLogEntry[]> {
  try {
    const snap = await adminDb()
      .collection(SMS_LOGS_COLLECTION)
      .orderBy("createdAt", "desc")
      .limit(limit)
      .get();

    return snap.docs.map((doc) => mapLogDoc(doc.id, doc.data()));
  } catch (error) {
    console.warn("[SMS] listSmsLogs fallback (no index):", error);
    const snap = await adminDb().collection(SMS_LOGS_COLLECTION).limit(limit * 3).get();
    return snap.docs
      .map((doc) => mapLogDoc(doc.id, doc.data()))
      .sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0))
      .slice(0, limit);
  }
}

export async function listSmsLogsForBusiness(
  ownerUid: string,
  limit = 100,
): Promise<SmsLogEntry[]> {
  try {
    const snap = await adminDb()
      .collection(SMS_LOGS_COLLECTION)
      .where("ownerUid", "==", ownerUid)
      .orderBy("createdAt", "desc")
      .limit(limit)
      .get();

    return snap.docs.map((doc) => mapLogDoc(doc.id, doc.data()));
  } catch (error) {
    console.warn("[SMS] listSmsLogsForBusiness fallback (no index):", error);
    const snap = await adminDb()
      .collection(SMS_LOGS_COLLECTION)
      .where("ownerUid", "==", ownerUid)
      .limit(limit * 3)
      .get();
    return snap.docs
      .map((doc) => mapLogDoc(doc.id, doc.data()))
      .sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0))
      .slice(0, limit);
  }
}
