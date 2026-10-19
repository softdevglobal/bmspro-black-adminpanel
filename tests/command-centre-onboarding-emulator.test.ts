import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { provisionCommandCentreWorkshop } from "../lib/commandCentreOnboardingStore";
import { setupConfigurationHash } from "../lib/commandCentreOnboarding";

if (process.env.FIRESTORE_EMULATOR_HOST !== "127.0.0.1:8187" || process.env.FIREBASE_AUTH_EMULATOR_HOST !== "127.0.0.1:9098")
  throw new Error("Run only against the isolated demo-ai-bookings emulators.");
const app = initializeApp({ projectId: "demo-ai-bookings" });
const db = getFirestore(app), auth = getAuth(app);
test.after(async () => { await db.terminate(); await deleteApp(app); });

async function fixture() {
  const id = randomUUID();
  const owner = await auth.createUser({ email: `owner-${id}@example.test`, emailVerified: true });
  const config = {
    setupMode: "new_business", product: "black", branchName: "Main", capacity: 2, bookingLimitPerDay: 8,
    business: { tradingName: "Emulator Workshop", ownerName: "Owner", ownerEmail: owner.email, ownerPhone: "+61400000000", address: "1 Test Street", timezone: "Australia/Sydney", gstRegistered: true },
    services: [{ name: "Oil service", durationMinutes: 60, priceBasis: "AUD 120 including GST", gstInclusive: true, vehicleTypePricing: { small_car: { price: 120, duration: 60 } } }],
    businessHours: [{ day: 1, opens: "09:00", closes: "17:00" }],
    staff: [{ name: "Mechanic", email: `staff-${id}@example.test`, skills: ["Oil service"], workingDays: [1], serviceNames: ["Oil service"] }],
    receptionistName: "Workshop AI", bookingPolicy: "staff_approval_required", cancellationPolicy: "Contact staff.",
    escalation: { name: "Owner", phone: "+61400000000", afterHoursAction: "callback" },
    terms: { version: "test-1", billingSummary: "Approved test terms", privacySummary: "Approved test notice", recording: "disabled", retentionDays: 0, marketingEnabled: false },
  };
  const hash = setupConfigurationHash(config);
  return { schemaVersion: 1, requestId: id, configuration: config, configurationHash: hash,
    approval: { ownerUid: owner.uid, configurationHash: hash, reviewedVersion: 2, termsVersion: "test-1", approvedAt: new Date().toISOString() } };
}
test("real Auth/Firestore provisioning creates one workshop and leaves staff disabled and billing pending", async () => {
  const input = await fixture();
  const result = await provisionCommandCentreWorkshop(input);
  assert.equal(result.status, "TEST_MODE");
  assert.equal((await db.doc(`users/${result.ownerUid}`).get()).data()?.role, "workshop_owner");
  assert.equal((await db.doc(`users/${result.ownerUid}`).get()).data()?.accountStatus, "pending_payment");
  assert.equal((await auth.getUser(result.staffIds[0])).disabled, true);
  assert.equal((await db.doc(`branches/${result.branchId}`).get()).data()?.status, "Pending");
  assert.equal((await db.doc(`services/${result.serviceIds[0]}`).get()).data()?.ownerUid, result.ownerUid);
  const retry = await provisionCommandCentreWorkshop(input);
  assert.equal(retry.created, false);
  assert.equal(retry.branchId, result.branchId);
  assert.equal((await db.collection("branches").where("ownerUid", "==", result.ownerUid).get()).size, 1);
  assert.equal((await db.doc(`onboarding_requests/${input.requestId}`).get()).data()?.status, "TEST_MODE");
  assert.equal((await db.doc(`onboarding_audit/${input.requestId}`).get()).data()?.configurationHash, input.configurationHash);
});
test("existing owners cannot be overwritten by a new-business provisioning request", async () => {
  const input = await fixture();
  await db.doc(`users/${input.approval.ownerUid}`).set({ role: "workshop_owner", name: "Existing business", email: input.configuration.business.ownerEmail });
  await assert.rejects(provisionCommandCentreWorkshop(input), /account already exists/i);
  assert.equal((await db.doc(`users/${input.approval.ownerUid}`).get()).data()?.name, "Existing business");
});
test("an unrelated staff email produces a recoverable checkpoint without taking over its Auth identity", async () => {
  const input = await fixture();
  const unrelated = await auth.createUser({ email: input.configuration.staff[0].email, disabled: false });
  await assert.rejects(provisionCommandCentreWorkshop(input), /staff email already has an account/i);
  assert.equal((await auth.getUser(unrelated.uid)).disabled, false);
  assert.equal((await db.doc(`users/${input.approval.ownerUid}`).get()).exists, false);
  assert.equal((await db.doc(`onboarding_requests/${input.requestId}`).get()).data()?.status, "NEEDS_REVIEW");
});
