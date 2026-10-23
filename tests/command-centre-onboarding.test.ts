import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { BlackSetupError, createBlackBusinessProvisioner, parseBlackSetup, setupConfigurationHash, buildBlackSetupDocuments,
  type BlackSetupDependencies, type BlackSetupResult } from "../lib/commandCentreOnboarding";

function payload() {
  const configuration = {
    setupMode: "new_business", product: "black", branchName: "Main Workshop", capacity: 2, bookingLimitPerDay: 8,
    business: { tradingName: "Example Mechanics", ownerName: "Owner", ownerEmail: "owner@example.test", ownerPhone: "+61400000000", address: "1 Example Street", timezone: "Australia/Sydney", gstRegistered: true },
    services: [{ name: "Oil service", durationMinutes: 60, priceBasis: "AUD 120 including GST for a small car", gstInclusive: true, vehicleTypePricing: { small_car: { price: 120, duration: 60 } } }],
    businessHours: [{ day: 1, opens: "09:00", closes: "17:00" }],
    staff: [{ name: "Mechanic A", email: "mechanic-a@example.test", skills: ["Oil service"], workingDays: [1], serviceNames: ["Oil service"] }],
    receptionistName: "Workshop AI", bookingPolicy: "staff_approval_required", cancellationPolicy: "Call staff to review changes.",
    escalation: { name: "Owner", phone: "+61400000000", afterHoursAction: "callback" },
    terms: { version: "approved-pilot-1", billingSummary: "Approved pilot billing rules", privacySummary: "Approved pilot notice", recording: "disabled", retentionDays: 0, marketingEnabled: false },
  };
  const configurationHash = setupConfigurationHash(configuration);
  return { schemaVersion: 1, requestId: randomUUID(), configuration, configurationHash,
    approval: { ownerUid: "verified-owner", configurationHash, reviewedVersion: 2, termsVersion: configuration.terms.version, approvedAt: new Date().toISOString() } };
}
test("business-only onboarding provisions without requiring or creating an AI receptionist setup", () => {
  const original = payload();
  const { receptionistName: _name, bookingPolicy: _policy, cancellationPolicy: _cancellation, escalation: _escalation, ...configuration } = original.configuration;
  const configurationHash = setupConfigurationHash(configuration);
  const input = { ...original, configuration, configurationHash, approval: { ...original.approval, configurationHash } };
  const documents = buildBlackSetupDocuments(parseBlackSetup(input));
  assert.ok(documents.some(document => document.path.startsWith("branches/")));
  assert.equal(documents.some(document => document.path.startsWith("ai_receptionist_setups/")), false);
  assert.equal(documents.find(document => document.path.startsWith("workshop_knowledge/"))?.data.bookingPolicy, "staff_approval_required");
});

function rehash(input: ReturnType<typeof payload>) {
  input.configurationHash = setupConfigurationHash(input.configuration);
  input.approval.configurationHash = input.configurationHash;
  return input;
}
function fixture() {
  const results = new Map<string, BlackSetupResult>();
  const checkpoints = new Map<string, { hash: string; lease: string | null }>();
  const identities = new Set<string>();
  const documents = new Map<string, Record<string, unknown>>();
  let verified = true, failStaff = false;
  let createdIdentities = 0;
  const deps: BlackSetupDependencies = {
    verifyOwner: async uid => ({ uid, email: "owner@example.test", emailVerified: verified, disabled: false }),
    reserve: async setup => {
      const current = checkpoints.get(setup.requestId);
      if (current && current.hash !== setup.configurationHash) throw new BlackSetupError(409, "REQUEST_CONFLICT", "Changed setup");
      if (results.has(setup.requestId)) return { result: results.get(setup.requestId)! };
      if (current?.lease) throw new BlackSetupError(409, "IN_PROGRESS", "Already provisioning");
      const leaseId = randomUUID(); checkpoints.set(setup.requestId, { hash: setup.configurationHash, lease: leaseId });
      return { leaseId };
    },
    ensureStaff: async member => {
      if (failStaff && member.email === "mechanic-b@example.test") throw new Error("Simulated Auth outage");
      if (!identities.has(member.id)) { identities.add(member.id); createdIdentities++; }
    },
    commit: async (setup, _lease, rows) => {
      for (const row of rows) documents.set(row.path, row.data);
      const result: BlackSetupResult = { status: "TEST_MODE", ownerUid: setup.ownerUid, branchId: setup.branchId, serviceIds: setup.services.map(s => s.id), staffIds: setup.staff.map(s => s.id), created: true };
      results.set(setup.requestId, result); checkpoints.get(setup.requestId)!.lease = null;
      return result;
    },
    recordFailure: async setup => { checkpoints.get(setup.requestId)!.lease = null; },
  };
  return { provision: createBlackBusinessProvisioner(deps), deps, documents, identities, checkpoints,
    createdIdentities: () => createdIdentities, setVerified: (value: boolean) => { verified = value; }, setStaffFailure: (value: boolean) => { failStaff = value; } };
}

test("approved setup maps to Black owner, branch, vehicle pricing, staff schedules and knowledge schemas", async () => {
  const f = fixture(), input = payload();
  const result = await f.provision(input);
  const owner = f.documents.get("users/verified-owner")!;
  assert.equal(owner.role, "workshop_owner");
  assert.equal(owner.name, input.configuration.business.tradingName);
  assert.equal(owner.accountStatus, "pending_payment");
  assert.equal(owner.planId, null);
  assert.equal(result.status, "TEST_MODE");
  const branch = f.documents.get(`branches/${result.branchId}`)!;
  assert.equal(branch.status, "Pending");
  assert.equal(branch.capacity, 2);
  assert.equal(branch.bookingLimitPerDay, 8);
  assert.deepEqual((branch.hours as Record<string, unknown>).Monday, { open: "09:00", close: "17:00", closed: false });
  const service = f.documents.get(`services/${result.serviceIds[0]}`)!;
  assert.deepEqual(service.vehicleTypePricing, { small_car: { price: 120, duration: 60 } });
  assert.equal("price" in service, false);
  assert.deepEqual(service.branches, [result.branchId]);
  const staff = f.documents.get(`users/${result.staffIds[0]}`)!;
  assert.equal(staff.suspended, true);
  assert.equal(staff.invitationStatus, "pending");
  assert.deepEqual((staff.weeklySchedule as Record<string, unknown>).Monday, { branchId: result.branchId, branchName: "Main Workshop" });
  assert.equal(f.documents.get("ai_receptionist_setups/verified-owner")?.active, false);
  assert.equal(f.documents.get("workshop_knowledge/verified-owner")?.bookingPolicy, "staff_approval_required");
});

test("retries return stable IDs without creating another workshop or staff identity", async () => {
  const f = fixture(), input = payload();
  const first = await f.provision(input), second = await f.provision(input);
  assert.equal(second.created, false);
  assert.equal(first.branchId, second.branchId);
  assert.deepEqual(first.staffIds, second.staffIds);
  assert.equal(f.createdIdentities(), 1);
  assert.equal(f.documents.size, 6);
});

test("concurrent duplicate provisioning is claimed once", async () => {
  const f = fixture(), input = payload();
  const results = await Promise.allSettled([f.provision(input), f.provision(input)]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(f.createdIdentities(), 1);
});

test("unverified email and a different authenticated owner cannot create resources", async () => {
  const f = fixture(), input = payload();
  f.setVerified(false);
  await assert.rejects(f.provision(input), error => error instanceof BlackSetupError && error.code === "OWNER_VERIFICATION_REQUIRED");
  f.setVerified(true); input.configuration.business.ownerEmail = "other@example.test"; rehash(input);
  await assert.rejects(f.provision(input), error => error instanceof BlackSetupError && error.code === "OWNER_VERIFICATION_REQUIRED");
  assert.equal(f.checkpoints.size, 0);
  assert.equal(f.documents.size, 0);
});

test("a changed configuration cannot reuse previous owner approval", () => {
  const input = payload(); input.configuration.capacity = 10;
  assert.throws(() => parseBlackSetup(input), error => error instanceof BlackSetupError && error.code === "INVALID_SETUP");
});

test("approved setup validates prices, schedules, staff identity and schema version independently", () => {
  const modifications: Array<(input: ReturnType<typeof payload>) => void> = [
    input => { input.schemaVersion = 2; },
    input => { input.configuration.services[0].vehicleTypePricing.small_car.price = -1; },
    input => { input.configuration.staff[0].email = input.configuration.business.ownerEmail; },
    input => { input.configuration.staff[0].workingDays = [0]; },
    input => { input.configuration.staff[0].serviceNames = ["Unapproved repair"]; },
    input => { input.configuration.businessHours[0].closes = "08:00"; },
  ];
  for (const modify of modifications) { const input = payload(); modify(input); assert.throws(() => parseBlackSetup(rehash(input)), BlackSetupError); }
});

test("partial staff Auth failure retains stable checkpoints and resumes without duplicate identities", async () => {
  const f = fixture(), input = payload();
  input.configuration.staff.push({ ...input.configuration.staff[0], name: "Mechanic B", email: "mechanic-b@example.test" }); rehash(input);
  f.setStaffFailure(true);
  await assert.rejects(f.provision(input), error => error instanceof BlackSetupError && error.code === "SETUP_PENDING_RECONCILIATION");
  assert.equal(f.documents.size, 0);
  assert.equal(f.identities.size, 1);
  f.setStaffFailure(false);
  const result = await f.provision(input);
  assert.equal(result.staffIds.length, 2);
  assert.equal(f.createdIdentities(), 2);
});

test("a previously reserved request rejects another approved configuration", async () => {
  const f = fixture(), input = payload();
  await f.provision(input);
  input.configuration.branchName = "Different branch"; rehash(input);
  await assert.rejects(f.provision(input), error => error instanceof BlackSetupError && error.code === "REQUEST_CONFLICT");
});
