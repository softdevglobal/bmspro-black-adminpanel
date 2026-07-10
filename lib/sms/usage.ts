import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebaseAdmin";
import { parseBusinessSmsFields } from "@/lib/sms-packages/balance";

export type ConsumeSmsCreditsResult =
  | { ok: true; unlimited: boolean }
  | { ok: false; reason: "quota_exceeded" | "tenant_not_found" };

async function mirrorOwnerSmsFields(
  ownerUid: string,
  update: Record<string, unknown>,
): Promise<void> {
  const db = adminDb();
  const ownerRef = db.collection("owners").doc(ownerUid);
  const ownerDoc = await ownerRef.get();
  if (ownerDoc.exists) {
    await ownerRef.update(update);
  }
}

export async function tryConsumeSmsCredits(
  ownerUid: string,
  count: number,
): Promise<ConsumeSmsCreditsResult> {
  if (!ownerUid || count <= 0) {
    return { ok: true, unlimited: false };
  }

  const db = adminDb();
  const userRef = db.collection("users").doc(ownerUid);

  return db.runTransaction<ConsumeSmsCreditsResult>(async (tx) => {
    const snap = await tx.get(userRef);
    if (!snap.exists) {
      return { ok: false, reason: "tenant_not_found" };
    }

    const balance = parseBusinessSmsFields(ownerUid, snap.data());
    if (balance.unlimited) {
      return { ok: true, unlimited: true };
    }

    const remaining = balance.remaining ?? 0;
    if (remaining < count) {
      return { ok: false, reason: "quota_exceeded" };
    }

    const update = {
      smsMessagesUsed: FieldValue.increment(count),
      updatedAt: FieldValue.serverTimestamp(),
    };
    tx.update(userRef, update);
    return { ok: true, unlimited: false };
  }).then(async (result) => {
    if (result.ok) {
      await mirrorOwnerSmsFields(ownerUid, {
        smsMessagesUsed: FieldValue.increment(count),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    return result;
  });
}

export async function releaseSmsCredits(ownerUid: string, count: number): Promise<void> {
  if (!ownerUid || count <= 0) return;

  const db = adminDb();
  const userRef = db.collection("users").doc(ownerUid);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    if (!snap.exists) return;

    const used =
      typeof snap.data()?.smsMessagesUsed === "number" ? snap.data()!.smsMessagesUsed : 0;
    const nextUsed = Math.max(0, used - count);
    tx.update(userRef, {
      smsMessagesUsed: nextUsed,
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  const snap = await userRef.get();
  const used =
    typeof snap.data()?.smsMessagesUsed === "number" ? snap.data()!.smsMessagesUsed : 0;
  await mirrorOwnerSmsFields(ownerUid, {
    smsMessagesUsed: used,
    updatedAt: FieldValue.serverTimestamp(),
  });
}
