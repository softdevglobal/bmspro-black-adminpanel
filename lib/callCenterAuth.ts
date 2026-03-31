import { NextRequest } from "next/server";
import { adminAuth, adminDb } from "@/lib/firebaseAdmin";

export const CALL_CENTER_ROLES = ["call_center_agent", "call_center_admin"];

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
    const authHeader = req.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return { success: false, error: "Missing authorization header", status: 401 };
    }

    const idToken = authHeader.split("Bearer ")[1];
    if (!idToken) {
      return { success: false, error: "Missing token", status: 401 };
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

    const role = (data.role || "call_center_agent").toString();
    if (!CALL_CENTER_ROLES.includes(role)) {
      return { success: false, error: "Invalid call center role", status: 403 };
    }

    return {
      success: true,
      user: {
        uid,
        role,
        email: data.email || decodedToken.email || "",
        name: data.displayName || data.name || "",
        assignedWorkshops: Array.isArray(data.assignedWorkshops) ? data.assignedWorkshops : [],
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
  return user.assignedWorkshops.includes(ownerUid);
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
