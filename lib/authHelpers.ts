import { NextRequest } from "next/server";
import { adminAuth, adminDb } from "@/lib/firebaseAdmin";

// ==================== SERVER-SIDE AUTH HELPERS (for API routes only) ====================

export const ADMIN_ROLES = ["salon_owner", "salon_branch_admin", "super_admin"];

export const STAFF_MANAGEMENT_ROLES = ["salon_owner", "salon_branch_admin"];

interface AuthResult {
  success: boolean;
  error?: string;
  status?: number;
  userData?: {
    uid: string;
    role: string;
    email: string;
    name: string;
    ownerUid: string;
    isSuperAdmin: boolean;
  };
}

/**
 * Verify that the request comes from an authenticated admin user.
 * Uses Firebase Admin SDK (server-side, bypasses Firestore rules).
 */
export async function verifyAdminAuth(
  req: NextRequest,
  allowedRoles?: string[],
  allowAllAdmins?: boolean
): Promise<AuthResult> {
  try {
    const authHeader = req.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return { success: false, error: "Missing authorization header", status: 401 };
    }

    const idToken = authHeader.split("Bearer ")[1];
    if (!idToken) {
      return { success: false, error: "Missing token", status: 401 };
    }

    const auth = adminAuth();
    let decodedToken;
    try {
      decodedToken = await auth.verifyIdToken(idToken);
    } catch {
      return { success: false, error: "Invalid or expired token", status: 401 };
    }

    const uid = decodedToken.uid;
    const db = adminDb();

    // Check super_admins collection first
    const superAdminDoc = await db.doc(`super_admins/${uid}`).get();
    
    if (superAdminDoc.exists) {
      const data = superAdminDoc.data();
      return {
        success: true,
        userData: {
          uid,
          role: "super_admin",
          email: data?.email || decodedToken.email || "",
          name: data?.displayName || "",
          ownerUid: uid,
          isSuperAdmin: true,
        },
      };
    }

    // Check users collection
    const userDoc = await db.doc(`users/${uid}`).get();
    
    if (!userDoc.exists) {
      return { success: false, error: "User not found", status: 404 };
    }

    const userData = userDoc.data();
    const role = (userData?.role || "").toString().toLowerCase();
    const name = userData?.displayName || userData?.name || "";
    const email = userData?.email || decodedToken.email || "";
    const ownerUid = userData?.ownerUid || uid;

    if (userData?.suspended) {
      return { success: false, error: "Account suspended", status: 403 };
    }

    const roles = allowAllAdmins ? ADMIN_ROLES : (allowedRoles || ADMIN_ROLES);
    if (!roles.includes(role)) {
      return { success: false, error: "Insufficient permissions", status: 403 };
    }

    return {
      success: true,
      userData: {
        uid,
        role,
        email,
        name,
        ownerUid,
        isSuperAdmin: false,
      },
    };
  } catch (error: any) {
    console.error("[verifyAdminAuth] Error:", error);
    return { success: false, error: "Authentication failed", status: 500 };
  }
}

/**
 * Verify that the requesting user has access to a specific tenant/owner's data.
 */
export async function verifyTenantAccess(
  requestingUserUid: string,
  requestingUserRole: string,
  requestingUserOwnerUid: string,
  targetOwnerUid: string
): Promise<{ allowed: boolean; error?: string }> {
  if (requestingUserRole === "super_admin") {
    return { allowed: true };
  }

  if (requestingUserRole === "salon_owner") {
    if (requestingUserUid === targetOwnerUid) {
      return { allowed: true };
    }
    return { allowed: false, error: "Access denied to this tenant's data" };
  }

  if (requestingUserRole === "salon_branch_admin") {
    if (requestingUserOwnerUid === targetOwnerUid) {
      return { allowed: true };
    }
    return { allowed: false, error: "Access denied to this tenant's data" };
  }

  return { allowed: false, error: "Insufficient role" };
}

/**
 * Verify that the requesting user can manage a specific staff member.
 */
export async function canManageStaff(
  ownerUid: string,
  staffUid: string
): Promise<{ allowed: boolean; error?: string }> {
  try {
    const db = adminDb();
    const staffDoc = await db.doc(`users/${staffUid}`).get();
    
    if (!staffDoc.exists) {
      return { allowed: false, error: "Staff member not found" };
    }

    const staffData = staffDoc.data();
    const staffOwnerUid = staffData?.ownerUid;

    if (staffOwnerUid !== ownerUid) {
      return { allowed: false, error: "Staff member does not belong to your salon" };
    }

    return { allowed: true };
  } catch (error) {
    console.error("[canManageStaff] Error:", error);
    return { allowed: false, error: "Failed to verify staff ownership" };
  }
}
