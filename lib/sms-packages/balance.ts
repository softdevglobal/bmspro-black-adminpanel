export const SMS_LOW_BALANCE_THRESHOLD = 10;

/** Tenant SMS fields live on users/{ownerUid} (mirrored to owners/{ownerUid}). */
export type BusinessSmsBalance = {
  ownerUid: string;
  limit: number;
  used: number;
  remaining: number | null;
  unlimited: boolean;
  isLow: boolean;
  smsPackageId: string | null;
  smsPackage: {
    id: string;
    name: string;
    price: number;
    priceLabel: string;
    messageQuota: number;
    plan_key?: string | null;
  } | null;
};

export function parseBusinessSmsFields(
  ownerUid: string,
  data: Record<string, unknown> | undefined | null,
): BusinessSmsBalance {
  const limit = typeof data?.smsMessageLimit === "number" ? data.smsMessageLimit : 0;
  const used = typeof data?.smsMessagesUsed === "number" ? data.smsMessagesUsed : 0;
  const unlimited = limit < 0;
  const remaining = unlimited ? null : Math.max(0, limit - used);
  const pkg = data?.smsPackage as Record<string, unknown> | undefined;

  return {
    ownerUid,
    limit,
    used,
    remaining,
    unlimited,
    isLow: !unlimited && remaining !== null && remaining < SMS_LOW_BALANCE_THRESHOLD,
    smsPackageId: typeof data?.smsPackageId === "string" ? data.smsPackageId : null,
    smsPackage: pkg
      ? {
          id: String(pkg.id ?? ""),
          name: String(pkg.name ?? ""),
          price: Number(pkg.price ?? 0),
          priceLabel: String(pkg.priceLabel ?? ""),
          messageQuota: Number(pkg.messageQuota ?? 0),
          plan_key: pkg.plan_key != null ? String(pkg.plan_key) : null,
        }
      : null,
  };
}
