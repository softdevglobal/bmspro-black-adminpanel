import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebaseAdmin";
import {
  buildTenantSmsFields,
  buildTenantSmsRenewalFields,
} from "@/lib/sms-packages/bundled";
import { resolveSmsPackageForPlan } from "@/lib/sms-packages/server";
import type { SmsPackage } from "@/lib/sms-packages/types";
import { planValidityDays } from "@/lib/subscriptionPlans";

export type PlanTenantSyncResult = {
  syncedCount: number;
  smsUpdatedCount: number;
  skippedSmsInactive: number;
  errors: string[];
};

function periodEndMsFromTenant(tenantData: Record<string, unknown>): number | null {
  for (const value of [tenantData.currentPeriodEnd, tenantData.smsBundlePeriodEnd]) {
    if (value instanceof Date) return value.getTime();
    if (typeof value === "object" && value !== null && "toDate" in value) {
      try {
        const d = (value as { toDate: () => Date }).toDate();
        if (d instanceof Date && !Number.isNaN(d.getTime())) return d.getTime();
      } catch {
        // ignore
      }
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return value > 1_000_000_000_000 ? value : value * 1000;
    }
  }
  return null;
}

function tenantHasBundledSmsHistory(tenantData: Record<string, unknown>): boolean {
  return (
    tenantData.smsBundleRenewsWithPlan === true ||
    typeof tenantData.smsBundleQuota === "number" ||
    typeof tenantData.smsMessageLimit === "number"
  );
}

/** True when a tenant's bundled SMS fields do not match the plan's active package. */
function tenantBundledSmsDrift(
  tenantData: Record<string, unknown>,
  bundledPkg: SmsPackage,
): boolean {
  const tenantPkgId =
    typeof tenantData.smsPackageId === "string" ? tenantData.smsPackageId.trim() : "";
  if (tenantPkgId !== bundledPkg.id) return true;
  if (tenantData.smsBundleRenewsWithPlan !== true) return true;

  const tenantBundleQuota =
    typeof tenantData.smsBundleQuota === "number" ? tenantData.smsBundleQuota : null;
  if (tenantBundleQuota !== bundledPkg.messageQuota) return true;

  const snapshot = tenantData.smsPackage;
  if (snapshot && typeof snapshot === "object") {
    const snap = snapshot as Record<string, unknown>;
    if (typeof snap.messageQuota === "number" && snap.messageQuota !== bundledPkg.messageQuota) {
      return true;
    }
    if (typeof snap.name === "string" && snap.name !== bundledPkg.name) {
      return true;
    }
  }

  return false;
}

async function mirrorOwnerIfExists(
  ownerUid: string,
  update: Record<string, unknown>,
): Promise<void> {
  const ownerRef = adminDb().collection("owners").doc(ownerUid);
  const ownerDoc = await ownerRef.get();
  if (ownerDoc.exists) {
    await ownerRef.update(update);
  }
}

/**
 * After a subscription plan catalog edit, push snapshot fields to every tenant on that plan.
 * Limits and labels always sync. Bundled SMS updates when applyBundledSms is true
 * (plan smsPackageId changed) or repairBundledSmsDrift finds tenants out of sync.
 */
export async function syncTenantsToSubscriptionPlan(
  planId: string,
  planData: Record<string, unknown>,
  options?: { applyBundledSms?: boolean; repairBundledSmsDrift?: boolean },
): Promise<PlanTenantSyncResult> {
  const result: PlanTenantSyncResult = {
    syncedCount: 0,
    smsUpdatedCount: 0,
    skippedSmsInactive: 0,
    errors: [],
  };

  const tenantsSnap = await adminDb()
    .collection("users")
    .where("role", "==", "workshop_owner")
    .where("planId", "==", planId)
    .get();

  if (tenantsSnap.empty) return result;

  const applyBundledSms = options?.applyBundledSms === true;
  const repairBundledSmsDrift = options?.repairBundledSmsDrift === true;
  const shouldResolveBundledPkg = applyBundledSms || repairBundledSmsDrift;
  const bundledPkg =
    shouldResolveBundledPkg && planData.smsPackageId
      ? await resolveSmsPackageForPlan(planData)
      : null;
  const validityDays = planValidityDays(planData);

  if (shouldResolveBundledPkg && planData.smsPackageId && !bundledPkg) {
    result.skippedSmsInactive = tenantsSnap.size;
  }

  for (const tenantDoc of tenantsSnap.docs) {
    const tenantData = tenantDoc.data() as Record<string, unknown>;
    const ownerUid = tenantDoc.id;

    const update: Record<string, unknown> = {
      updatedAt: FieldValue.serverTimestamp(),
    };

    if (typeof planData.name === "string" && planData.name.trim()) {
      update.plan = planData.name.trim();
    }
    if (typeof planData.priceLabel === "string" && planData.priceLabel.trim()) {
      update.price = planData.priceLabel.trim();
    }
    if (planData.plan_key !== undefined) {
      update.plan_key =
        planData.plan_key != null && String(planData.plan_key).trim()
          ? String(planData.plan_key).trim()
          : null;
    }
    if (typeof planData.branches === "number") {
      update.branchLimit = planData.branches;
    }
    if (typeof planData.staff === "number") {
      update.staffLimit = planData.staff;
    }

    if (bundledPkg) {
      const shouldUpdateBundledSms =
        applyBundledSms || (repairBundledSmsDrift && tenantBundledSmsDrift(tenantData, bundledPkg));

      if (shouldUpdateBundledSms) {
        const periodEndMs = periodEndMsFromTenant(tenantData);
        const smsFields = tenantHasBundledSmsHistory(tenantData)
          ? buildTenantSmsRenewalFields(bundledPkg, tenantData, { periodEndMs })
          : buildTenantSmsFields(bundledPkg, { subscriptionValidityDays: validityDays });

        if (smsFields) {
          Object.assign(update, smsFields);
          result.smsUpdatedCount += 1;
        }
      }
    }

    try {
      await adminDb().collection("users").doc(ownerUid).update(update);
      await mirrorOwnerIfExists(ownerUid, update);
      result.syncedCount += 1;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Failed to sync tenant";
      result.errors.push(`${ownerUid}: ${message}`);
      if (result.errors.length >= 10) break;
    }
  }

  return result;
}

/** Push bundled SMS updates to every subscription plan linked to an SMS package. */
export async function syncBundledSmsForSubscriptionPlans(
  smsPackageId: string,
): Promise<PlanTenantSyncResult> {
  const result: PlanTenantSyncResult = {
    syncedCount: 0,
    smsUpdatedCount: 0,
    skippedSmsInactive: 0,
    errors: [],
  };

  const plansSnap = await adminDb()
    .collection("subscription_plans")
    .where("smsPackageId", "==", smsPackageId)
    .get();

  for (const planDoc of plansSnap.docs) {
    const partial = await syncTenantsToSubscriptionPlan(
      planDoc.id,
      { id: planDoc.id, ...planDoc.data() },
      { repairBundledSmsDrift: true },
    );
    result.syncedCount += partial.syncedCount;
    result.smsUpdatedCount += partial.smsUpdatedCount;
    result.skippedSmsInactive += partial.skippedSmsInactive;
    result.errors.push(...partial.errors);
    if (result.errors.length >= 10) break;
  }

  return result;
}
