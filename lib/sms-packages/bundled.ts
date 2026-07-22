import type { SmsPackage, SmsPackageSnapshot } from "@/lib/sms-packages/types";

/** Minimal plan shape needed to resolve a bundled SMS package. */
export type PlanWithSmsPackageId = {
  smsPackageId?: string | null;
};

export function smsPackageSnapshot(pkg: SmsPackage): SmsPackageSnapshot {
  return {
    id: pkg.id,
    name: pkg.name,
    price: pkg.price,
    priceLabel: pkg.priceLabel,
    messageQuota: pkg.messageQuota,
    plan_key: pkg.plan_key ?? null,
  };
}

/**
 * First grant (onboarding / new tenant) for a plan’s bundled SMS package.
 * Writes onto users/{ownerUid} — does not invent a businesses collection.
 */
export function buildTenantSmsFields(
  pkg: SmsPackage,
  options?: { subscriptionValidityDays?: number; now?: Date },
): Record<string, unknown> {
  const now = options?.now ?? new Date();
  const validityDays =
    typeof options?.subscriptionValidityDays === "number" &&
    options.subscriptionValidityDays > 0
      ? options.subscriptionValidityDays
      : 28;
  const periodEnd = new Date(now.getTime() + validityDays * 24 * 60 * 60 * 1000);
  const snapshot = smsPackageSnapshot(pkg);

  return {
    smsPackageId: pkg.id,
    smsPackage: snapshot,
    smsMessageLimit: pkg.messageQuota,
    smsMessagesUsed: 0,
    smsBundleQuota: pkg.messageQuota,
    smsBundleRenewsWithPlan: true,
    smsBundleGrantedAt: now,
    smsBundleRenewedAt: now,
    smsBundlePeriodEnd: periodEnd,
  };
}

/**
 * Renewal / plan-change SMS fields.
 * Preserves purchased top-ups above the previous bundle; resets usage to 0.
 */
export function buildTenantSmsRenewalFields(
  pkg: SmsPackage,
  tenantData: Record<string, unknown> | undefined | null,
  options?: { periodEndMs?: number | null; now?: Date },
): Record<string, unknown> {
  const now = options?.now ?? new Date();
  const snapshot = smsPackageSnapshot(pkg);

  const previousBundleRaw = tenantData?.smsBundleQuota;
  const previousBundle =
    typeof previousBundleRaw === "number"
      ? previousBundleRaw
      : 0;

  const currentLimit =
    typeof tenantData?.smsMessageLimit === "number" ? tenantData.smsMessageLimit : 0;

  let purchasedExtra = 0;
  if (previousBundle >= 0 && currentLimit >= 0) {
    purchasedExtra = Math.max(0, currentLimit - previousBundle);
  }

  const newBundleQuota = pkg.messageQuota;
  const newLimit =
    newBundleQuota < 0
      ? -1
      : currentLimit < 0
        ? -1
        : newBundleQuota + purchasedExtra;

  const periodEnd =
    typeof options?.periodEndMs === "number" && Number.isFinite(options.periodEndMs)
      ? new Date(options.periodEndMs)
      : null;

  const fields: Record<string, unknown> = {
    smsPackageId: pkg.id,
    smsPackage: snapshot,
    smsMessageLimit: newLimit,
    smsMessagesUsed: 0,
    smsBundleQuota: newBundleQuota,
    smsBundleRenewsWithPlan: true,
    smsBundleRenewedAt: now,
  };

  if (periodEnd) {
    fields.smsBundlePeriodEnd = periodEnd;
  }

  if (tenantData?.smsBundleGrantedAt == null) {
    fields.smsBundleGrantedAt = now;
  }

  return fields;
}
