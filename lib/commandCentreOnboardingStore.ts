import { randomUUID } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { adminAuth, adminDb } from "./firebaseAdmin";
import { BlackSetupError, createBlackBusinessProvisioner, type BlackSetupResult } from "./commandCentreOnboarding";

export const provisionCommandCentreWorkshop = createBlackBusinessProvisioner({
  async verifyOwner(uid) {
    const user = await adminAuth().getUser(uid);
    return { uid: user.uid, email: user.email, emailVerified: user.emailVerified, disabled: user.disabled };
  },
  async reserve(setup) {
    const db = adminDb(), ref = db.doc(`onboarding_requests/${setup.requestId}`), planRef = db.doc(`subscription_plans/${setup.planId}`);
    return db.runTransaction(async transaction => {
      const [checkpoint, owner, plan] = await transaction.getAll(ref, db.doc(`users/${setup.ownerUid}`), planRef);
      const previous = checkpoint.data();
      if (previous && (previous.configurationHash !== setup.configurationHash || previous.ownerUid !== setup.ownerUid))
        throw new BlackSetupError(409, "REQUEST_CONFLICT", "This request ID belongs to a different approved setup.");
      if (previous?.status === "TEST_MODE") return { result: previous.result as BlackSetupResult };
      if (previous?.leaseUntil > Date.now()) throw new BlackSetupError(409, "IN_PROGRESS", "This setup is already being provisioned.");
      const planData = plan.data();
      if (!plan.exists || planData?.active === false || planData?.hidden === true || planData?.name !== setup.planName)
        throw new BlackSetupError(400, "INVALID_SETUP", "Choose an available subscription plan.");
      if (owner.exists && owner.data()?.onboardingRequestId !== setup.requestId)
        throw new BlackSetupError(409, "EXISTING_ACCOUNT", "An account already exists. Link and review it instead of creating a duplicate workshop.");
      const emailMatches = await transaction.get(db.collection("users").where("email", "==", setup.ownerEmail));
      if (emailMatches.docs.some(doc => doc.id !== setup.ownerUid)) throw new BlackSetupError(409, "EXISTING_ACCOUNT", "The owner email already belongs to another account.");
      if (setup.business.abn) {
        const matches = await transaction.get(db.collection("users").where("abn", "==", setup.business.abn));
        if (matches.docs.some(doc => doc.id !== setup.ownerUid)) throw new BlackSetupError(409, "EXISTING_BUSINESS", "A business with this ABN already exists. Obtain authorization to link it.");
        const registry = db.doc(`onboarding_business_identifiers/abn-${setup.business.abn}`);
        const identifier = await transaction.get(registry);
        if (identifier.exists && identifier.data()?.ownerUid !== setup.ownerUid) throw new BlackSetupError(409, "EXISTING_BUSINESS", "This ABN has a pending business setup.");
        transaction.set(registry, { ownerUid: setup.ownerUid, requestId: setup.requestId });
      }
      const leaseId = randomUUID();
      transaction.set(ref, { configurationHash: setup.configurationHash, ownerUid: setup.ownerUid, status: "PROVISIONING",
        leaseId, leaseUntil: Date.now() + 120000, approval: setup.approval,
        plannedResources: { ownerUid: setup.ownerUid, branchId: setup.branchId, planId: setup.planId, serviceIds: setup.services.map(service => service.id), staffIds: setup.staff.map(member => member.id) },
        updatedAt: FieldValue.serverTimestamp() });
      return { leaseId };
    });
  },
  async ensureStaff(member) {
    const auth = adminAuth();
    try {
      const existing = await auth.getUserByEmail(member.email);
      if (existing.uid !== member.id || !existing.disabled) throw new BlackSetupError(409, "STAFF_ACCOUNT_CONFLICT", "A staff email already has an account. Obtain authorization to link it.");
      return;
    } catch (error) {
      if ((error as { code?: string }).code !== "auth/user-not-found") throw error;
    }
    try { await auth.createUser({ uid: member.id, email: member.email, displayName: member.name, disabled: true, emailVerified: false }); }
    catch (error) {
      if (!["auth/uid-already-exists", "auth/email-already-exists"].includes((error as { code: string }).code)) throw error;
      const existing = await auth.getUserByEmail(member.email);
      if (existing.uid !== member.id || !existing.disabled) throw new BlackSetupError(409, "STAFF_ACCOUNT_CONFLICT", "Staff account conflict requires operator review.");
    }
  },
  async commit(setup, leaseId, documents) {
    const db = adminDb(), ref = db.doc(`onboarding_requests/${setup.requestId}`);
    return db.runTransaction(async transaction => {
      const [checkpoint, ...existing] = await transaction.getAll(ref, ...documents.map(document => db.doc(document.path)));
      if (checkpoint.data()?.leaseId !== leaseId) throw new BlackSetupError(409, "LEASE_CHANGED", "Provisioning ownership changed; reconcile its checkpoint.");
      for (const document of existing) {
        if (document.exists && (document.data()?.onboardingRequestId !== setup.requestId || document.data()?.onboardingConfigHash !== setup.configurationHash))
          throw new BlackSetupError(409, "RESOURCE_CONFLICT", "An unrelated resource exists. Setup will not overwrite it.");
      }
      documents.forEach((document, index) => {
        if (!existing[index].exists) transaction.create(db.doc(document.path), { ...document.data, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
      });
      const result: BlackSetupResult = { status: "TEST_MODE", ownerUid: setup.ownerUid, branchId: setup.branchId,
        serviceIds: setup.services.map(service => service.id), staffIds: setup.staff.map(member => member.id), created: true };
      transaction.update(ref, { status: "TEST_MODE", result, leaseUntil: 0, updatedAt: FieldValue.serverTimestamp() });
      transaction.set(db.doc(`onboarding_audit/${setup.requestId}`), { ownerUid: setup.ownerUid, configurationHash: setup.configurationHash,
        approval: setup.approval, result, action: "workshop_prepared_for_testing", createdAt: FieldValue.serverTimestamp() });
      return result;
    });
  },
  async recordFailure(setup, leaseId) {
    const db = adminDb(), ref = db.doc(`onboarding_requests/${setup.requestId}`);
    await db.runTransaction(async transaction => {
      const checkpoint = await transaction.get(ref);
      if (checkpoint.data()?.leaseId === leaseId && checkpoint.data()?.status === "PROVISIONING")
        transaction.update(ref, { status: "NEEDS_REVIEW", leaseUntil: 0, updatedAt: FieldValue.serverTimestamp() });
    });
  },
});
