export type BillingCycle = "weekly" | "monthly";

export function normalizeBillingCycle(raw: unknown): BillingCycle {
  return raw === "weekly" ? "weekly" : "monthly";
}

export function validityDaysForCycle(cycle: BillingCycle): number {
  return cycle === "weekly" ? 5 : 28;
}

/** Resolve validity days from stored plan doc (backward compatible). */
export function planValidityDays(plan: {
  billingCycle?: unknown;
  validityDays?: unknown;
}): number {
  const vd = plan.validityDays;
  if (typeof vd === "number" && Number.isFinite(vd) && vd > 0) {
    return Math.round(vd);
  }
  return validityDaysForCycle(normalizeBillingCycle(plan.billingCycle));
}

export function planBillingCycle(plan: {
  billingCycle?: unknown;
  validityDays?: unknown;
}): BillingCycle {
  const vd = plan.validityDays;
  if (vd === 5) return "weekly";
  if (vd === 28) return "monthly";
  return normalizeBillingCycle(plan.billingCycle);
}

export function billingCycleCardLabel(plan: {
  billingCycle?: unknown;
  validityDays?: unknown;
}): string {
  const d = planValidityDays(plan);
  return d === 5 ? `Weekly • ${d}-day renewal` : `Monthly • ${d}-day renewal`;
}
