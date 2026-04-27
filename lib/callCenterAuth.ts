import { NextRequest } from "next/server";
import { adminAuth, adminDb } from "@/lib/firebaseAdmin";
import {
  verifyAdminAuth,
  getFirebaseIdTokenFromRequest,
  missingFirebaseTokenMessage,
} from "@/lib/authHelpers";

/** `agent` is the canonical non-admin role; `call_center_agent` kept for legacy Firestore docs. */
export const CALL_CENTER_ROLES = ["agent", "call_center_agent", "call_center_admin"];

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Tenant-Id",
};

export { CORS_HEADERS };

export interface CallCenterUser {
  uid: string;
  role: string;
  email: string;
  name: string;
  assignedWorkshops: string[];
  isCCAdmin: boolean;
}

/** Call center agent JWT, or BMS staff JWT (same Firebase project) scoped to tenant. */
export type CallCenterRequestAuth =
  | { kind: "agent"; user: CallCenterUser }
  | {
      kind: "tenant_admin";
      uid: string;
      role: string;
      email: string;
      name: string;
      ownerUid: string;
      isSuperAdmin: boolean;
    };

export function callCenterRequesterUid(auth: CallCenterRequestAuth): string {
  return auth.kind === "agent" ? auth.user.uid : auth.uid;
}

/** Normalize Firestore assigned workshop ids (trim, legacy snake_case, `{ ownerUid }` items). */
function normalizeAssignedWorkshopIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const arr = raw;
  const out: string[] = [];
  for (const item of arr) {
    if (typeof item === "string") {
      const s = item.trim();
      if (s) out.push(s);
    } else if (
      item &&
      typeof item === "object" &&
      "ownerUid" in item &&
      typeof (item as { ownerUid: unknown }).ownerUid === "string"
    ) {
      const s = (item as { ownerUid: string }).ownerUid.trim();
      if (s) out.push(s);
    }
  }
  return [...new Set(out)];
}

interface CCAuthResult {
  success: boolean;
  error?: string;
  status?: number;
  user?: CallCenterUser;
}

/**
 * Verify that the request comes from an authenticated call center agent.
 * Reads from `call_center_agents` Firestore collection.
 * Returns the agent's profile including assigned workshop list.
 */
export async function verifyCallCenterAuth(req: NextRequest): Promise<CCAuthResult> {
  try {
    const idToken = getFirebaseIdTokenFromRequest(req);
    if (!idToken) {
      return { success: false, error: missingFirebaseTokenMessage(), status: 401 };
    }

    let decodedToken;
    try {
      decodedToken = await adminAuth().verifyIdToken(idToken);
    } catch {
      return { success: false, error: "Invalid or expired token", status: 401 };
    }

    const uid = decodedToken.uid;
    const db = adminDb();

    const agentDoc = await db.doc(`call_center_agents/${uid}`).get();

    if (!agentDoc.exists) {
      return { success: false, error: "Not a registered call center agent", status: 403 };
    }

    const data = agentDoc.data()!;

    if (data.suspended) {
      return { success: false, error: "Agent account suspended", status: 403 };
    }

    const role = (data.role || "agent").toString();
    if (!CALL_CENTER_ROLES.includes(role)) {
      return { success: false, error: "Invalid call center role", status: 403 };
    }

    const assignedWorkshops = normalizeAssignedWorkshopIds([
      ...(Array.isArray(data.assignedWorkshops) ? data.assignedWorkshops : []),
      ...(Array.isArray(data.assigned_workshops) ? data.assigned_workshops : []),
    ]);

    return {
      success: true,
      user: {
        uid,
        role,
        email: data.email || decodedToken.email || "",
        name: data.displayName || data.name || "",
        assignedWorkshops,
        isCCAdmin: role === "call_center_admin",
      },
    };
  } catch (error: any) {
    console.error("[verifyCallCenterAuth] Error:", error);
    return { success: false, error: "Authentication failed", status: 500 };
  }
}

/**
 * Check if an agent has access to a specific workshop (ownerUid).
 * CC admins can access all workshops; agents need explicit assignment.
 */
export function canAccessWorkshop(user: CallCenterUser, ownerUid: string): boolean {
  if (user.isCCAdmin) return true;
  const id = ownerUid.trim();
  return user.assignedWorkshops.includes(id);
}

/**
 * Accept call center agents, or BMS staff using the normal admin ID token
 * (workshop owner / branch admin / super admin). Fixes Postman/tests that
 * sign in as workshop owner but are not in `call_center_agents`.
 */
export async function verifyCallCenterOrTenantAdminAuth(
  req: NextRequest
): Promise<
  { success: false; error: string; status?: number } | { success: true; auth: CallCenterRequestAuth }
> {
  const cc = await verifyCallCenterAuth(req);
  if (cc.success && cc.user) {
    return { success: true, auth: { kind: "agent", user: cc.user } };
  }

  const admin = await verifyAdminAuth(req, ["super_admin", "workshop_owner", "branch_admin"]);
  if (admin.success && admin.userData) {
    const u = admin.userData;
    return {
      success: true,
      auth: {
        kind: "tenant_admin",
        uid: u.uid,
        role: u.role,
        email: u.email,
        name: u.name,
        ownerUid: u.ownerUid,
        isSuperAdmin: u.isSuperAdmin,
      },
    };
  }

  const status =
    cc.status === 401 || admin.status === 401 ? 401 : cc.status || admin.status || 401;
  const error =
    cc.error === "Not a registered call center agent"
      ? "Not a call center agent: add Firestore doc call_center_agents/{uid} for this Firebase user, or sign in as BMS staff (workshop_owner, branch_admin, super_admin) with a users/ doc"
      : cc.status === 401
        ? cc.error || "Unauthorized"
        : admin.error || cc.error || "Unauthorized";

  return { success: false, error, status };
}

export function canAccessWorkshopForAuth(auth: CallCenterRequestAuth, workshopOwnerUid: string): boolean {
  const id = workshopOwnerUid.trim();
  if (auth.kind === "agent") {
    return canAccessWorkshop(auth.user, id);
  }
  if (auth.isSuperAdmin) return true;
  if (auth.role === "workshop_owner" && auth.uid === id) return true;
  if (auth.role === "branch_admin" && auth.ownerUid === id) return true;
  return false;
}

const participantIdList = (room: { participantIds?: unknown }): string[] =>
  Array.isArray(room.participantIds) ? room.participantIds.map((x) => String(x)) : [];

/**
 * List/read CC direct chats: the agent or tenant in the thread, or BMS staff for that workshop.
 * Unclaimed queue requests (`queueStatus === "pending"`) are visible to agents who can access that workshop.
 */
export function canAccessCcDirectChatRoom(
  auth: CallCenterRequestAuth,
  room: { workshopOwnerUid?: unknown; participantIds?: unknown; queueStatus?: unknown },
  requesterUid: string
): boolean {
  if (participantIdList(room).includes(requesterUid)) return true;
  if (auth.kind === "agent") {
    if (String(room.queueStatus ?? "") !== "pending") return false;
    const w = String(room.workshopOwnerUid ?? "").trim();
    if (!w) return false;
    if (auth.user.isCCAdmin) return true;
    return canAccessWorkshop(auth.user, w);
  }
  const w = String(room.workshopOwnerUid ?? "").trim();
  if (!w) return false;
  return canAccessWorkshopForAuth(auth, w);
}

/**
 * Post messages / mark read: only the two thread participants.
 */
export function isParticipantInCcDirectChatRoom(
  room: { participantIds?: unknown },
  requesterUid: string
): boolean {
  return participantIdList(room).includes(requesterUid);
}

/**
 * Who may POST reviewed/called tracking on customer notifications.
 * Call center agents (verified via `call_center_agents`) may update any such row — same operational
 * model as handling customer comms across assigned tenants; workshop list still scopes GET feeds.
 * BMS staff (workshop owner / branch admin / super admin) stays limited to their workshop / super.
 */
export function canActOnCustomerNotificationTracking(
  auth: CallCenterRequestAuth,
  workshopOwnerUid: string
): boolean {
  if (auth.kind === "agent") return true;
  return canAccessWorkshopForAuth(auth, workshopOwnerUid);
}

/** Scope for GET /api/call-center/workshops list. */
export function workshopListScopeForAuth(
  auth: CallCenterRequestAuth
): { mode: "all" } | { mode: "ids"; ids: string[] } {
  if (auth.kind === "agent") {
    if (auth.user.isCCAdmin) return { mode: "all" };
    return { mode: "ids", ids: auth.user.assignedWorkshops };
  }
  if (auth.isSuperAdmin) return { mode: "all" };
  if (auth.role === "workshop_owner") return { mode: "ids", ids: [auth.uid] };
  if (auth.role === "branch_admin") return { mode: "ids", ids: [auth.ownerUid] };
  return { mode: "ids", ids: [] };
}

/**
 * Get the ownerUid from request — either from X-Tenant-Id header or query param.
 */
export function getTenantId(req: NextRequest): string | null {
  return (
    req.headers.get("x-tenant-id") ||
    req.nextUrl.searchParams.get("ownerUid") ||
    req.nextUrl.searchParams.get("tenantId") ||
    null
  );
}
