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
  const ownerEmail = email(business.ownerEmail), ownerName = text(business.ownerName), tradingName = text(business.tradingName);
  if (typeof business.gstRegistered !== "boolean") fail("The business GST registration choice is required.");
  const address = text(business.address), timezone = text(business.timezone), ownerPhone = text(business.ownerPhone, 30);
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }); } catch { fail("Invalid workshop timezone."); }
  const branchName = text(config.branchName), capacity = integer(config.capacity, 1, 100), bookingLimitPerDay = integer(config.bookingLimitPerDay, 1, 1000);
  if (config.bookingPolicy !== "staff_approval_required") fail("Bookings must require staff approval.");
  const hours: Record<string, { open?: string; close?: string; closed: boolean }> = Object.fromEntries(days.map(day => [day, { closed: true }]));
  const openDays = new Set<number>();
  for (const value of list(config.businessHours, 7)) {
    const row = object(value), day = integer(row.day, 0, 6), open = text(row.opens, 5), close = text(row.closes, 5);
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(open) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(close) || open >= close || openDays.has(day)) fail("Invalid business hours.");
    openDays.add(day); hours[days[day]] = { open, close, closed: false };
  }
  const services = list(config.services).map((value, index) => {
    const row = object(value), name = text(row.name), pricing = object(row.vehicleTypePricing);
    if (typeof row.gstInclusive !== "boolean") fail("Confirm whether the service price includes GST.");
    if (!Object.keys(pricing).length || Object.keys(pricing).some(key => !vehicleTypes.has(key))) fail("Approved vehicle-category pricing is required.");
    const vehicleTypePricing = Object.fromEntries(Object.entries(pricing).map(([key, value]) => {
      const price = object(value);
      if (typeof price.price !== "number" || !Number.isFinite(price.price) || price.price < 0 || price.price > 1000000) fail("Invalid service price.");
      return [key, { price: price.price, duration: integer(price.duration, 1, 1440) }];
    }));
    return { id: resourceId(requestId, "service", String(index)), name, priceBasis: text(row.priceBasis), gstInclusive: row.gstInclusive, vehicleTypePricing };
  });
  if (new Set(services.map(service => service.name.toLowerCase())).size !== services.length) fail("Use unique service names.");
  const staff = list(config.staff).map(value => {
    const row = object(value), staffEmail = email(row.email), name = text(row.name);
    const workingDays = list(row.workingDays, 7).map(day => integer(day, 0, 6));
    if (new Set(workingDays).size !== workingDays.length || workingDays.some(day => !openDays.has(day))) fail("Staff working days must match branch hours.");
    const serviceNames = list(row.serviceNames).map(value => text(value));
    if (serviceNames.some(name => !services.some(service => service.name === name))) fail("Staff service assignments must use approved services.");
    return { id: resourceId(requestId, "staff", staffEmail), email: staffEmail, name, workingDays, serviceNames, skills: list(row.skills, 30).map(value => text(value)) };
  });
  if (new Set(staff.map(member => member.email)).size !== staff.length || staff.some(member => member.email === ownerEmail)) fail("Staff require distinct email addresses.");
  if (services.some(service => !staff.some(member => member.serviceNames.includes(service.name)))) fail("Assign staff to each service.");
  if (business.abn !== undefined && !/^\d{11}$/.test(String(business.abn))) fail("Invalid ABN.");
  text(config.cancellationPolicy, 2000); text(config.receptionistName);
  const escalation = object(config.escalation); text(escalation.name); text(escalation.phone, 30);
  return { requestId, configurationHash: hash, ownerUid, ownerEmail, ownerName, tradingName, business, config, approval,
    address, timezone, ownerPhone, branchName, capacity, bookingLimitPerDay, hours, services, staff,
    branchId: resourceId(requestId, "branch", "primary") };
}
export type BlackSetup = ReturnType<typeof parseBlackSetup>;
export type BlackSetupResult = { status: "TEST_MODE"; ownerUid: string; branchId: string; serviceIds: string[]; staffIds: string[]; created: boolean };
export type BlackSetupDocuments = Array<{ path: string; data: Record<string, unknown> }>;

export function buildBlackSetupDocuments(setup: BlackSetup): BlackSetupDocuments {
  const s = setup;
  const meta = { onboardingRequestId: s.requestId, onboardingConfigHash: s.configurationHash, onboardingStatus: "test_mode" };
  const slug = `${s.tradingName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "workshop"}-${s.requestId}`;
  const staffIds = s.staff.map(member => member.id), serviceIds = s.services.map(service => service.id);
  const docs: BlackSetupDocuments = [
    { path: `users/${s.ownerUid}`, data: { ...meta, uid: s.ownerUid, role: "workshop_owner", email: s.ownerEmail,
      displayName: s.ownerName, name: s.tradingName, workshopName: s.tradingName, slug, provider: "password",
      contactPhone: s.ownerPhone, locationText: s.address, timezone: s.timezone, abn: s.business.abn ?? null,
      legalName: s.business.legalName ?? null, gstRegistered: s.business.gstRegistered,
      website: s.business.website ?? null,
      branchNames: [s.branchName], currentBranchCount: 1, currentStaffCount: s.staff.length,
      branchLimit: 0, staffLimit: 0, planId: null, plan: null, plan_key: null,
      status: "Pending Payment", accountStatus: "pending_payment", subscriptionStatus: "pending", billing_status: "pending",
      paymentDetailsRequired: true, signupSource: "command_centre_ai", hasFreeTrial: false } },
    { path: `branches/${s.branchId}`, data: { ...meta, ownerUid: s.ownerUid, name: s.branchName, address: s.address,
      phone: s.ownerPhone, email: s.ownerEmail, timezone: s.timezone, hours: s.hours, capacity: s.capacity,
      bookingLimitPerDay: s.bookingLimitPerDay, status: "Pending", staffIds, serviceIds,
      staffByDay: Object.fromEntries(days.map((day, index) => [day, s.staff.filter(member => member.workingDays.includes(index)).map(member => member.id)])) } },
    { path: `workshop_knowledge/${s.ownerUid}`, data: { ...meta, ownerUid: s.ownerUid, branchId: s.branchId, version: 1,
      faqs: s.config.faqs ?? [], cancellationPolicy: s.config.cancellationPolicy, escalation: s.config.escalation,
      terms: s.config.terms, bookingPolicy: s.config.bookingPolicy, approval: s.approval } },
    { path: `ai_receptionist_setups/${s.ownerUid}`, data: { ...meta, ownerUid: s.ownerUid, branchId: s.branchId,
      name: s.config.receptionistName, status: "draft", active: false, knowledgeVersion: 1,
      bookingPolicy: "staff_approval_required", requestedPhone: s.config.did ?? null, phoneVerified: false } },
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
    if (owner.uid !== setup.ownerUid || !owner.emailVerified || owner.disabled || owner.email?.toLowerCase() !== setup.ownerEmail)
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
