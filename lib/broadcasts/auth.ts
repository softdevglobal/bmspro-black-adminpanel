import "server-only";

import { adminAuth, adminDb } from "@/lib/firebaseAdmin";
import { getFirebaseIdTokenFromRequest } from "@/lib/authHelpers";

const BUSINESS_MEMBER_ROLES = new Set([
  "owner",
  "admin",
  "staff",
  "business_owner",
  "workshop_owner",
  "branch_admin",
]);

export async function requireSuperAdmin(req: Request): Promise<
  | { ok: true; uid: string; email: string | undefined }
  | { ok: false; status: number; error: string }
> {
  const token = getFirebaseIdTokenFromRequest(req as import("next/server").NextRequest);
  if (!token) {
    return { ok: false, status: 401, error: "Missing authorization header." };
  }

  try {
    const decoded = await adminAuth().verifyIdToken(token);
    const isSuperAdmin =
      decoded.superAdmin === true || decoded.role === "super_admin";

    if (!isSuperAdmin) {
      const snap = await adminDb().collection("super_admins").doc(decoded.uid).get();
      if (!snap.exists) {
        return { ok: false, status: 403, error: "Super admin access required." };
      }
    }

    return { ok: true, uid: decoded.uid, email: decoded.email };
  } catch {
    return { ok: false, status: 401, error: "Invalid or expired session." };
  }
}

export type BusinessMemberAuth = {
  ok: true;
  uid: string;
  email: string | undefined;
  role: string;
};

export async function requireBusinessMember(req: Request): Promise<
  BusinessMemberAuth | { ok: false; status: number; error: string }
> {
  const token = getFirebaseIdTokenFromRequest(req as import("next/server").NextRequest);
  if (!token) {
    return { ok: false, status: 401, error: "Missing authorization header." };
  }

  try {
    const decoded = await adminAuth().verifyIdToken(token);
    const db = adminDb();
    const uid = decoded.uid;

    const superAdminDoc = await db.doc(`super_admins/${uid}`).get();
    if (superAdminDoc.exists) {
      return {
        ok: false,
        status: 403,
        error: "Business member access required.",
      };
    }

    const userDoc = await db.doc(`users/${uid}`).get();
    if (!userDoc.exists) {
      return {
        ok: false,
        status: 403,
        error: "Business member access required.",
      };
    }

    const data = userDoc.data() ?? {};
    if (data.suspended) {
      return { ok: false, status: 403, error: "Account suspended" };
    }

    let role = String(data.role || data.systemRole || "").toLowerCase();
    if (role === "business_owner") role = "owner";

    if (!BUSINESS_MEMBER_ROLES.has(role)) {
      return {
        ok: false,
        status: 403,
        error: "Business member access required.",
      };
    }

    return {
      ok: true,
      uid,
      email: decoded.email,
      role,
    };
  } catch {
    return { ok: false, status: 401, error: "Invalid or expired session." };
  }
}
