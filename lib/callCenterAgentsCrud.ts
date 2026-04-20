import type { DocumentData } from "firebase-admin/firestore";
import { adminAuth, adminDb } from "@/lib/firebaseAdmin";

/** Matches `verifyAdminAuth` userData for workshop_owner / super_admin. */
export type BmsAdminUser = {
  uid: string;
  role: string;
  email: string;
  name: string;
  ownerUid: string;
  isSuperAdmin: boolean;
};

export type SerializedCallCenterAgent = {
  agent_id: string;
  uid: string;
  email: string;
  name: string;
  displayName: string;
  role: string;
  suspended: boolean;
  assignedWorkshops: string[];
  createdAt: string | null;
  updatedAt: string | null;
  createdBy: string | null;
  createdByRole: string | null;
};

export function serializeCallCenterAgent(
  docId: string,
  d: DocumentData
): SerializedCallCenterAgent {
  const ws = d.assignedWorkshops;
  const assignedWorkshops = Array.isArray(ws)
    ? ws.map((x: unknown) => String(x).trim()).filter(Boolean)
    : [];
  return {
    agent_id: docId,
    uid: docId,
    email: String(d.email || "").trim(),
    name: String(d.name || d.displayName || "").trim(),
    displayName: String(d.displayName || d.name || "").trim(),
    role: String(d.role || "agent"),
    suspended: d.suspended === true,
    assignedWorkshops,
    createdAt: d.createdAt?.toDate?.()?.toISOString() ?? null,
    updatedAt: d.updatedAt?.toDate?.()?.toISOString() ?? null,
    createdBy: d.createdBy != null ? String(d.createdBy) : null,
    createdByRole: d.createdByRole != null ? String(d.createdByRole) : null,
  };
}

export function canAdminViewAgent(admin: BmsAdminUser, agentData: DocumentData): boolean {
  if (admin.isSuperAdmin || admin.role === "super_admin") return true;
  if (admin.role === "workshop_owner") {
    const ws = agentData.assignedWorkshops;
    if (!Array.isArray(ws)) return false;
    return ws.includes(admin.uid);
  }
  return false;
}

/**
 * Workshop owners may delete only agents assigned solely to their workshop.
 * Super admins may delete any agent.
 */
export function canAdminDeleteAgent(admin: BmsAdminUser, agentData: DocumentData): boolean {
  if (admin.isSuperAdmin || admin.role === "super_admin") return true;
  if (admin.role === "workshop_owner") {
    const ws = agentData.assignedWorkshops;
    if (!Array.isArray(ws) || ws.length !== 1) return false;
    return ws[0] === admin.uid;
  }
  return false;
}

export async function listCallCenterAgentsForAdmin(
  admin: BmsAdminUser
): Promise<SerializedCallCenterAgent[]> {
  const db = adminDb();
  if (admin.isSuperAdmin || admin.role === "super_admin") {
    const snap = await db.collection("call_center_agents").get();
    return snap.docs.map((doc) => serializeCallCenterAgent(doc.id, doc.data()!));
  }
  if (admin.role === "workshop_owner") {
    const snap = await db
      .collection("call_center_agents")
      .where("assignedWorkshops", "array-contains", admin.uid)
      .get();
    return snap.docs.map((doc) => serializeCallCenterAgent(doc.id, doc.data()!));
  }
  return [];
}

type CreateBody = {
  email: string;
  password: string;
  name: string;
  role?: string;
  assignedWorkshops?: string[];
};

export async function adminCreateCallCenterAgent(
  body: CreateBody,
  admin: BmsAdminUser
): Promise<
  { ok: true; agent: SerializedCallCenterAgent } | { ok: false; status: number; error: string }
> {
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";

  if (!email || !password || !name) {
    return { ok: false, status: 400, error: "Missing required fields: email, password, name" };
  }
  if (password.length < 6) {
    return { ok: false, status: 400, error: "Password must be at least 6 characters" };
  }

  const agentRole =
    body.role === "call_center_admin"
      ? "call_center_admin"
      : body.role === "call_center_agent"
        ? "call_center_agent"
        : "agent";

  let workshops: string[] = [];
  if (admin.role === "workshop_owner") {
    workshops = [admin.uid];
  } else if (Array.isArray(body.assignedWorkshops)) {
    workshops = body.assignedWorkshops.map((x) => String(x).trim()).filter(Boolean);
  }

  const auth = adminAuth();
  const db = adminDb();

  let uid: string;
  try {
    const userRecord = await auth.createUser({
      email,
      password,
      displayName: name,
      emailVerified: false,
      disabled: false,
    });
    uid = userRecord.uid;
  } catch (e: any) {
    if (e.code === "auth/email-already-exists") {
      return { ok: false, status: 409, error: "An account with this email already exists" };
    }
    throw e;
  }

  const now = new Date();
  const firestoreData = {
    email,
    displayName: name,
    name,
    role: agentRole,
    assignedWorkshops: workshops,
    suspended: false,
    createdAt: now,
    updatedAt: now,
    createdBy: admin.uid,
    createdByRole: admin.role,
  };

  await db.doc(`call_center_agents/${uid}`).set(firestoreData);

  const snap = await db.doc(`call_center_agents/${uid}`).get();
  return {
    ok: true,
    agent: serializeCallCenterAgent(uid, snap.data()!),
  };
}

type UpdateBody = {
  assignedWorkshops?: string[];
  suspended?: boolean;
  role?: string;
  name?: string;
};

export async function adminUpdateCallCenterAgent(
  agentUid: string,
  body: UpdateBody,
  admin: BmsAdminUser
): Promise<
  | { ok: true; agent: SerializedCallCenterAgent }
  | { ok: false; status: number; error: string }
> {
  const id = String(agentUid || "").trim();
  if (!id) {
    return { ok: false, status: 400, error: "Missing agentUid" };
  }

  const db = adminDb();
  const ref = db.doc(`call_center_agents/${id}`);
  const agentDoc = await ref.get();
  if (!agentDoc.exists) {
    return { ok: false, status: 404, error: "Agent not found" };
  }

  const existing = agentDoc.data()!;
  if (!canAdminViewAgent(admin, existing)) {
    return { ok: false, status: 403, error: "Access denied" };
  }

  const updates: Record<string, unknown> = { updatedAt: new Date() };

  if (body.assignedWorkshops !== undefined && Array.isArray(body.assignedWorkshops)) {
    if (admin.role === "workshop_owner") {
      const existingWs: string[] = Array.isArray(existing.assignedWorkshops)
        ? existing.assignedWorkshops
        : [];
      const ownerUid = admin.uid;
      if (body.assignedWorkshops.includes(ownerUid)) {
        updates.assignedWorkshops = [...new Set([...existingWs, ownerUid])];
      } else {
        updates.assignedWorkshops = existingWs.filter((x: string) => x !== ownerUid);
      }
    } else {
      updates.assignedWorkshops = body.assignedWorkshops.map((x) => String(x).trim()).filter(Boolean);
    }
  }

  if (body.suspended !== undefined) {
    updates.suspended = Boolean(body.suspended);
  }

  if (body.role && ["agent", "call_center_agent", "call_center_admin"].includes(body.role)) {
    updates.role = body.role;
  }

  if (body.name && typeof body.name === "string") {
    const trimmed = body.name.trim();
    updates.displayName = trimmed;
    updates.name = trimmed;
    try {
      await adminAuth().updateUser(id, { displayName: trimmed });
    } catch (e) {
      console.warn("[adminUpdateCallCenterAgent] Auth displayName update:", e);
    }
  }

  await ref.update(updates as Record<string, any>);
  const fresh = await ref.get();
  return { ok: true, agent: serializeCallCenterAgent(id, fresh.data()!) };
}

export async function adminDeleteCallCenterAgent(
  agentUid: string,
  admin: BmsAdminUser
): Promise<
  | { ok: true; warning?: string }
  | { ok: false; status: number; error: string }
> {
  const id = String(agentUid || "").trim();
  if (!id) {
    return { ok: false, status: 400, error: "Missing agentUid" };
  }

  const db = adminDb();
  const ref = db.doc(`call_center_agents/${id}`);
  const agentDoc = await ref.get();
  if (!agentDoc.exists) {
    return { ok: false, status: 404, error: "Agent not found" };
  }

  const data = agentDoc.data()!;
  if (!canAdminDeleteAgent(admin, data)) {
    return {
      ok: false,
      status: 403,
      error:
        admin.role === "workshop_owner"
          ? "You can only delete agents assigned exclusively to your workshop. Remove other assignments first, or use a super admin."
          : "Access denied",
    };
  }

  await ref.delete();

  try {
    await adminAuth().deleteUser(id);
  } catch (e: any) {
    if (e.code !== "auth/user-not-found") {
      console.error("[adminDeleteCallCenterAgent] deleteUser:", e);
      return {
        ok: true,
        warning:
          "Agent removed from call center, but the Firebase Auth account could not be deleted. Remove it manually in the Firebase console if needed.",
      };
    }
  }

  return { ok: true };
}
