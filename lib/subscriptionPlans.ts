export type BillingCycle = "weekly" | "monthly";

export function normalizeBillingCycle(raw: unknown): BillingCycle {
  return raw === "weekly" ? "weekly" : "monthly";
}

export function validityDaysForCycle(cycle: BillingCycle): number {
  return cycle === "weekly" ? 7 : 28;
}

/** Resolve validity days from stored plan doc (backward compatible). */
export function planValidityDays(plan: {
  billingCycle?: unknown;
  validityDays?: unknown;
}): number {
  const vd = plan.validityDays;
  if (typeof vd === "number" && Number.isFinite(vd) && vd > 0) {
    const rounded = Math.round(vd);
    // Older weekly plans used 5-day cycles; treat as a full 7-day week everywhere (Stripe, labels).
    if (rounded === 5 && planBillingCycle({ ...plan, validityDays: rounded }) === "weekly") {
      return 7;
    }
    return rounded;
  }
  return validityDaysForCycle(normalizeBillingCycle(plan.billingCycle));
}

export function planBillingCycle(plan: {
  billingCycle?: unknown;
  validityDays?: unknown;
}): BillingCycle {
  const vd = plan.validityDays;
  // Legacy weekly used 5-day cycles; new weekly is 7 days.
  if (vd === 5 || vd === 7) return "weekly";
  if (vd === 28) return "monthly";
  return normalizeBillingCycle(plan.billingCycle);
}

export function billingCycleCardLabel(plan: {
  billingCycle?: unknown;
  validityDays?: unknown;
}): string {
  const cycle = planBillingCycle(plan);
  const d = planValidityDays(plan);
  return cycle === "weekly" ? `Weekly • ${d}-day renewal` : `Monthly • ${d}-day renewal`;
}
