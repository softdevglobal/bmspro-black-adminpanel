import { createHash } from "node:crypto";

export class BlackSetupError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
const fail = (message: string): never => { throw new BlackSetupError(400, "INVALID_SETUP", message); };
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : fail("Expected a setup object.");
const text = (value: unknown, max = 500): string => typeof value === "string" && value.trim().length > 0 && value.length <= max ? value.trim() : fail("A required setup field is missing or invalid.");
const integer = (value: unknown, min: number, max: number): number => typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : fail("Invalid setup limit or schedule.");
const list = (value: unknown, max = 100): unknown[] => Array.isArray(value) && value.length > 0 && value.length <= max ? value : fail("Complete the setup lists before provisioning.");
const email = (value: unknown): string => { const v = text(value, 254).toLowerCase(); return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : fail("Invalid email address."); };
const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const vehicleTypes = new Set(["small_car", "sedan_wagon", "suv", "ute_van_4wd", "performance_large"]);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
export const setupConfigurationHash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
const resourceId = (requestId: string, kind: string, key: string) => `cc-${kind}-${createHash("sha256").update(`${requestId}:${key}`).digest("hex").slice(0, 36)}`;

export function parseBlackSetup(raw: unknown) {
  const input = object(raw), config = object(input.configuration), approval = object(input.approval);
  if (input.schemaVersion !== 1 || config.product !== "black" || config.setupMode !== "new_business") fail("Unsupported Black setup version or mode.");
  const requestId = text(input.requestId);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(requestId)) fail("Invalid provisioning request ID.");
  const hash = setupConfigurationHash(config);
  if (input.configurationHash !== hash || approval.configurationHash !== hash) fail("The approved configuration changed.");
  const terms = object(config.terms);
  if (text(terms.version) !== approval.termsVersion || terms.marketingEnabled !== false || !text(terms.billingSummary, 2000) || !text(terms.privacySummary, 2000)) fail("Approved terms are required.");
  if (!["disabled", "transcript_only", "audio_and_transcript"].includes(String(terms.recording))) fail("Invalid recording policy.");
  integer(terms.retentionDays, 0, 3650);
  integer(approval.reviewedVersion, 1, Number.MAX_SAFE_INTEGER);
  const approvedAt = text(approval.approvedAt);
  if (!Number.isFinite(Date.parse(approvedAt)) || Date.parse(approvedAt) > Date.now() + 300000) fail("Invalid owner approval time.");
  const ownerUid = text(approval.ownerUid, 128), business = object(config.business);
  if (approval.method !== undefined && (approval.method !== "phone_confirmation" || ownerUid !== `ai-owner-${requestId.replace(/-/g, "")}`))
    fail("Invalid account-creation confirmation.");
  const ownerEmail = email(business.ownerEmail), ownerName = text(business.ownerName);
  const tradingName = text(business.tradingName);
  const businessType = text(config.blackBusinessType, 40), planId = text(config.blackPlanId, 200), planName = text(config.blackPlanName, 200);
  if (!["auto_repair", "mechanic", "tire_service", "body_shop", "service_center", "detailing", "fleet", "other"].includes(businessType))
    fail("Choose a valid Black business type.");
  const address = typeof business.address === "string" ? business.address.trim() : "";
  const timezone = typeof business.timezone === "string" && business.timezone.trim() ? business.timezone.trim() : "Australia/Sydney";
  const ownerPhone = text(business.ownerPhone, 30);
  const businessStructure = text(business.businessStructure, 30);
  if (!["pty_ltd", "sole_trader", "partnership", "trust"].includes(businessStructure)) fail("Choose a valid business structure.");
  const state = text(business.state, 3);
  if (!["NSW", "VIC", "QLD", "WA", "SA", "TAS", "ACT", "NT"].includes(state)) fail("Choose a valid Australian state or territory.");
  const postcode = text(business.postcode, 4);
  if (!/^\d{4}$/.test(postcode)) fail("Enter a valid four-digit postcode.");
  if (typeof business.gstRegistered !== "boolean") fail("Confirm whether the business is registered for GST.");
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }); } catch { fail("Invalid workshop timezone."); }
  const branchName = "", capacity = 0, bookingLimitPerDay = 0;
  if (config.bookingPolicy !== undefined && config.bookingPolicy !== "staff_approval_required") fail("Bookings must require staff approval.");
  const hours: Record<string, { open?: string; close?: string; closed: boolean }> = Object.fromEntries(days.map(day => [day, { closed: true }]));
  // Phone onboarding creates only the pending owner account. The owner
  // completes the business profile and adds branches, services and staff later.
  const services: Array<{id: string; name: string; priceBasis: string; gstInclusive: boolean; vehicleTypePricing: Record<string, {price: number; duration: number}>}> = [];
  const staff: Array<{id: string; email: string; name: string; workingDays: number[]; serviceNames: string[]; skills: string[]}> = [];
  if (business.abn !== undefined && !/^\d{11}$/.test(String(business.abn))) fail("Invalid ABN.");
  if (config.cancellationPolicy !== undefined) text(config.cancellationPolicy, 2000);
  if (config.receptionistName !== undefined) text(config.receptionistName);
  if (config.escalation !== undefined) {
    const escalation = object(config.escalation); text(escalation.name); text(escalation.phone, 30);
  }
  return { requestId, configurationHash: hash, ownerUid, ownerEmail, ownerName, tradingName, businessType, planId, planName, business, config, approval,
    address, timezone, ownerPhone, branchName, capacity, bookingLimitPerDay, hours, services, staff,
    branchId: null as string | null };
}
export type BlackSetup = ReturnType<typeof parseBlackSetup>;
export type BlackSetupResult = { status: "TEST_MODE"; ownerUid: string; branchId: string | null; serviceIds: string[]; staffIds: string[]; created: boolean };
export type BlackSetupDocuments = Array<{ path: string; data: Record<string, unknown> }>;

export function buildBlackSetupDocuments(setup: BlackSetup): BlackSetupDocuments {
  const s = setup;
  const meta = { onboardingRequestId: s.requestId, onboardingConfigHash: s.configurationHash, onboardingStatus: "test_mode" };
  const staffIds = s.staff.map(member => member.id), serviceIds = s.services.map(service => service.id);
  const docs: BlackSetupDocuments = [
    { path: `users/${s.ownerUid}`, data: { ...meta, uid: s.ownerUid, role: "workshop_owner", email: s.ownerEmail,
      displayName: s.ownerName, name: s.tradingName, businessName: s.tradingName, workshopName: s.tradingName,
      provider: "password", businessType: s.businessType, abn: s.business.abn ?? null,
      businessStructure: s.business.businessStructure, gstRegistered: s.business.gstRegistered,
      state: s.business.state, postcode: s.business.postcode,
      address: s.address || null, locationText: s.address ? `${s.address} ${s.business.postcode}` : null,
      businessProfileComplete: false,
      contactPhone: s.ownerPhone || null, timezone: s.timezone,
      branchNames: [], currentBranchCount: 0, currentStaffCount: 0,
      branchLimit: 0, staffLimit: 0, planId: s.planId, plan: s.planName, plan_key: null,
      status: "Pending Payment", accountStatus: "pending_payment", subscriptionStatus: "pending", billing_status: "pending",
      paymentDetailsRequired: true, signupSource: "command_centre_ai", hasFreeTrial: false } },
  ];
  for (const member of s.staff) docs.push({ path: `users/${member.id}`, data: { ...meta, uid: member.id, authUid: member.id,
    ownerUid: s.ownerUid, email: member.email, displayName: member.name, name: member.name, role: "staff", systemRole: "staff",
    staffRole: "staff", branchId: s.branchId, branchName: s.branchName, timezone: s.timezone, skills: member.skills,
    status: "Suspended", suspended: true, provider: "password", invitationStatus: "pending",
    weeklySchedule: Object.fromEntries(days.map((day, index) => [day, member.workingDays.includes(index) ? { branchId: s.branchId, branchName: s.branchName } : null])) } });
  for (const service of s.services) docs.push({ path: `services/${service.id}`, data: { ...meta, ownerUid: s.ownerUid,
    name: service.name, description: service.priceBasis, gstInclusive: service.gstInclusive, vehicleTypes: Object.keys(service.vehicleTypePricing), vehicleTypePricing: service.vehicleTypePricing,
    branches: [s.branchId], staffIds: s.staff.filter(member => member.serviceNames.includes(service.name)).map(member => member.id), checklist: [] } });
  return docs;
}

export interface BlackSetupDependencies {
  verifyOwner(uid: string): Promise<{ uid: string; email: string | undefined; emailVerified: boolean; disabled: boolean }>;
  reserve(setup: BlackSetup): Promise<{ leaseId: string } | { result: BlackSetupResult }>;
  ensureStaff(member: BlackSetup["staff"][number], setup: BlackSetup): Promise<void>;
  commit(setup: BlackSetup, leaseId: string, documents: BlackSetupDocuments): Promise<BlackSetupResult>;
  recordFailure(setup: BlackSetup, leaseId: string): Promise<void>;
}
export function createBlackBusinessProvisioner(deps: BlackSetupDependencies) {
  return async (raw: unknown): Promise<BlackSetupResult> => {
    const setup = parseBlackSetup(raw);
    const owner = await deps.verifyOwner(setup.ownerUid);
    if (owner.uid !== setup.ownerUid || (!owner.emailVerified && setup.approval.method !== "phone_confirmation") || owner.disabled || owner.email?.toLowerCase() !== setup.ownerEmail)
      throw new BlackSetupError(403, "OWNER_VERIFICATION_REQUIRED", "Verify the approved owner's email before provisioning.");
    const reservation = await deps.reserve(setup);
    if ("result" in reservation) return { ...reservation.result, created: false };
    try {
      for (const member of setup.staff) await deps.ensureStaff(member, setup);
      return await deps.commit(setup, reservation.leaseId, buildBlackSetupDocuments(setup));
    } catch (error) {
      await deps.recordFailure(setup, reservation.leaseId).catch(() => undefined);
      if (error instanceof BlackSetupError) throw error;
      throw new BlackSetupError(503, "SETUP_PENDING_RECONCILIATION", "Setup did not finish. Its checkpoint records the planned resources; retry the same request after review.");
    }
  };
}
