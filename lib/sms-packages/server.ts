import "server-only";

import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebaseAdmin";
import { parseBusinessSmsFields } from "@/lib/sms-packages/balance";
import {
  SMS_PACKAGES_COLLECTION,
  type CreateSmsPackageInput,
  type SmsPackage,
  type UpdateSmsPackageInput,
} from "@/lib/sms-packages/types";

function toDate(value: unknown): Date | null {
  if (value instanceof Timestamp) return value.toDate();
  if (value instanceof Date) return value;
  return null;
}

function mapPackage(id: string, data: FirebaseFirestore.DocumentData): SmsPackage {
  return {
    id,
    name: String(data.name ?? ""),
    price: Number(data.price ?? 0),
    priceLabel: String(data.priceLabel ?? ""),
    messageQuota: Number(data.messageQuota ?? 0),
    description: data.description != null ? String(data.description) : undefined,
    features: Array.isArray(data.features) ? data.features.map(String) : [],
    active: data.active !== false,
    hidden: data.hidden === true,
    popular: data.popular === true,
    color: data.color != null ? String(data.color) : undefined,
    icon: data.icon != null ? String(data.icon) : undefined,
    stripePriceId: data.stripePriceId != null ? String(data.stripePriceId) : null,
    stripeProductId: data.stripeProductId != null ? String(data.stripeProductId) : null,
    plan_key: data.plan_key != null ? String(data.plan_key) : null,
    createdAt: toDate(data.createdAt),
    updatedAt: toDate(data.updatedAt),
  };
}

async function mirrorOwnerFields(ownerUid: string, update: Record<string, unknown>): Promise<void> {
  const ownerRef = adminDb().collection("owners").doc(ownerUid);
  const ownerDoc = await ownerRef.get();
  if (ownerDoc.exists) {
    await ownerRef.update(update);
  }
}

export async function getBusinessSmsBalance(ownerUid: string) {
  const snap = await adminDb().collection("users").doc(ownerUid).get();
  if (!snap.exists) {
    throw new Error("Tenant not found");
  }
  return parseBusinessSmsFields(ownerUid, snap.data());
}

export async function listSmsPackages(options?: {
  includeInactive?: boolean;
  publicOnly?: boolean;
}): Promise<SmsPackage[]> {
  let docs: FirebaseFirestore.QueryDocumentSnapshot[];
  try {
    const snap = await adminDb()
      .collection(SMS_PACKAGES_COLLECTION)
      .orderBy("price", "asc")
      .get();
    docs = snap.docs;
  } catch (error) {
    console.warn("[SMS] listSmsPackages fallback (no price index):", error);
    const snap = await adminDb().collection(SMS_PACKAGES_COLLECTION).get();
    docs = snap.docs.sort(
      (a, b) => Number(a.data().price ?? 0) - Number(b.data().price ?? 0),
    );
  }

  return docs
    .map((doc) => mapPackage(doc.id, doc.data()))
    .filter((pkg) => {
      if (options?.publicOnly) {
        return pkg.active && !pkg.hidden;
      }
      if (!options?.includeInactive) {
        return pkg.active;
      }
      return true;
    });
}

export async function getSmsPackage(packageId: string): Promise<SmsPackage | null> {
  const snap = await adminDb().collection(SMS_PACKAGES_COLLECTION).doc(packageId).get();
  if (!snap.exists) return null;
  return mapPackage(snap.id, snap.data()!);
}

export async function createSmsPackage(input: CreateSmsPackageInput): Promise<SmsPackage> {
  const db = adminDb();
  const ref = db.collection(SMS_PACKAGES_COLLECTION).doc();
  const payload = {
    name: input.name.trim(),
    price: Number(input.price),
    priceLabel: input.priceLabel.trim(),
    messageQuota: Number(input.messageQuota),
    description: input.description?.trim() ?? "",
    features: Array.isArray(input.features) ? input.features : [],
    active: input.active !== false,
    hidden: input.hidden === true,
    popular: input.popular === true,
    color: input.color ?? "blue",
    icon: input.icon ?? "fa-comment-sms",
    plan_key: input.plan_key?.trim() ?? null,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  await ref.set(payload);
  const created = await ref.get();
  return mapPackage(created.id, created.data()!);
}

export async function updateSmsPackage(
  packageId: string,
  input: Omit<UpdateSmsPackageInput, "id">,
): Promise<SmsPackage> {
  const ref = adminDb().collection(SMS_PACKAGES_COLLECTION).doc(packageId);
  const existing = await ref.get();
  if (!existing.exists) {
    throw new Error("SMS package not found");
  }

  const update: Record<string, unknown> = {
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (input.name != null) update.name = input.name.trim();
  if (input.price != null) update.price = Number(input.price);
  if (input.priceLabel != null) update.priceLabel = input.priceLabel.trim();
  if (input.messageQuota != null) update.messageQuota = Number(input.messageQuota);
  if (input.description != null) update.description = input.description.trim();
  if (input.features != null) update.features = input.features;
  if (input.active != null) update.active = input.active;
  if (input.hidden != null) update.hidden = input.hidden;
  if (input.popular != null) update.popular = input.popular;
  if (input.color != null) update.color = input.color;
  if (input.icon != null) update.icon = input.icon;
  if (input.plan_key != null) update.plan_key = input.plan_key.trim();

  await ref.update(update);
  const updated = await ref.get();
  return mapPackage(updated.id, updated.data()!);
}

export async function deleteSmsPackage(packageId: string): Promise<void> {
  await adminDb().collection(SMS_PACKAGES_COLLECTION).doc(packageId).delete();
}

export async function countTenantsBySmsPackage(): Promise<Record<string, number>> {
  const snap = await adminDb().collection("users").where("role", "==", "workshop_owner").get();
  const counts: Record<string, number> = {};
  for (const doc of snap.docs) {
    const packageId = doc.data()?.smsPackageId;
    if (typeof packageId === "string" && packageId) {
      counts[packageId] = (counts[packageId] ?? 0) + 1;
    }
  }
  return counts;
}

export async function purchaseSmsPackageForBusiness(
  ownerUid: string,
  packageId: string,
): Promise<{ balance: ReturnType<typeof parseBusinessSmsFields> extends infer T ? T : never }> {
  const pkg = await getSmsPackage(packageId);
  if (!pkg) {
    throw new Error("SMS package not found");
  }
  if (!pkg.active) {
    throw new Error("SMS package is not active");
  }

  const userRef = adminDb().collection("users").doc(ownerUid);
  const userSnap = await userRef.get();
  if (!userSnap.exists) {
    throw new Error("Tenant not found");
  }

  const currentLimit =
    typeof userSnap.data()?.smsMessageLimit === "number" ? userSnap.data()!.smsMessageLimit : 0;
  const quota = pkg.messageQuota;
  const nextLimit = quota < 0 ? -1 : currentLimit < 0 ? currentLimit : currentLimit + quota;

  const snapshot = {
    id: pkg.id,
    name: pkg.name,
    price: pkg.price,
    priceLabel: pkg.priceLabel,
    messageQuota: pkg.messageQuota,
    plan_key: pkg.plan_key ?? null,
  };

  const update = {
    smsMessageLimit: nextLimit,
    smsPackageId: pkg.id,
    smsPackage: snapshot,
    updatedAt: FieldValue.serverTimestamp(),
  };

  await userRef.update(update);
  await mirrorOwnerFields(ownerUid, update);

  const balance = parseBusinessSmsFields(ownerUid, {
    ...userSnap.data(),
    smsMessageLimit: nextLimit,
    smsPackageId: pkg.id,
    smsPackage: snapshot,
  });

  return { balance };
}

export async function listTenantSmsUsage(): Promise<
  Array<{
    ownerUid: string;
    name: string;
    email: string;
    balance: ReturnType<typeof parseBusinessSmsFields>;
  }>
> {
  const snap = await adminDb().collection("users").where("role", "==", "workshop_owner").get();
  return snap.docs.map((doc) => {
    const data = doc.data();
    return {
      ownerUid: doc.id,
      name: String(data.workshopName || data.salonName || data.name || data.displayName || "Workshop"),
      email: String(data.email ?? ""),
      balance: parseBusinessSmsFields(doc.id, data),
    };
  });
}

export function isStripeConfiguredForSms(): boolean {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  return !!key && key.length > 0;
}

export function isDirectSmsTopUpAllowed(): boolean {
  return !isStripeConfiguredForSms();
}
