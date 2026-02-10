import { NextRequest } from "next/server";
import { adminAuth, adminDb } from "./firebaseAdmin";
import { DecodedIdToken } from "firebase-admin/auth";

/**
 * Result of authentication verification
 */
export type AuthResult = {
  success: true;
  user: DecodedIdToken;
  userData: {
    uid: string;
    role: string;
    ownerUid: string;
    name?: string;
    email?: string;
    branchId?: string;
    billingStatus?: string;
  };
} | {
  success: false;
  error: string;
  status: number;
  billingBlocked?: boolean;
  redirectTo?: string;
};

/**
 * Allowed roles for admin panel access
 */
export const ADMIN_ROLES = ["salon_owner", "salon_branch_admin", "salon_admin", "super_admin"];
export const OWNER_ROLES = ["salon_owner", "super_admin"];
export const STAFF_MANAGEMENT_ROLES = ["salon_owner", "salon_branch_admin", "super_admin"];

/**
 * Check if a route is a billing route (should be accessible even when suspended)
 */
function isBillingRoute(pathname: string): boolean {
  const billingRoutes = [
    "/api/billing/",
    "/api/stripe/",
    "/subscription",
    "/billing",
  ];
  return billingRoutes.some(route => pathname.startsWith(route));
}

/**
 * Verify Firebase ID token and get user data with role and ownerUid
 * Also checks billing status and blocks suspended/cancelled accounts (except billing routes)
 * 
 * @param req - NextRequest object
 * @param allowedRoles - Optional array of roles that are allowed (if not provided, all authenticated users are allowed)
 * @param skipBillingCheck - If true, skip billing status check (for billing routes)
 * @returns AuthResult with user data or error details
 */
export async function verifyAdminAuth(
  req: NextRequest,
  allowedRoles?: string[],
  skipBillingCheck: boolean = false
): Promise<AuthResult> {
  const authHeader = req.headers.get("authorization");
  
  if (!authHeader) {
    return {
      success: false,
      error: "Authorization header is required",
      status: 401,
    };
  }
  
  if (!authHeader.startsWith("Bearer ")) {
    return {
      success: false,
      error: "Invalid authorization format. Use 'Bearer <token>'",
      status: 401,
    };
  }
  
  const token = authHeader.slice(7);
  
  if (!token) {
    return {
      success: false,
      error: "Token is required",
      status: 401,
    };
  }
  
  try {
    const decodedToken = await adminAuth().verifyIdToken(token);
    
    // Check super_admins collection first
    const superAdminDoc = await adminDb().doc(`super_admins/${decodedToken.uid}`).get();
    
    let userData: any;
    let userRole: string;
    
    if (superAdminDoc.exists) {
      // User is a super_admin
      userData = superAdminDoc.data()!;
      userRole = "super_admin";
    } else {
      // Get user data from users collection
      const userDoc = await adminDb().doc(`users/${decodedToken.uid}`).get();
      
      if (!userDoc.exists) {
        return {
          success: false,
          error: "User not found in database",
          status: 403,
        };
      }
      
      userData = userDoc.data()!;
      userRole = (userData.role || userData.systemRole || "").toString().toLowerCase();
    }
    
    // Determine ownerUid based on role
    let ownerUid: string;
    if (userRole === "salon_owner" || userRole === "super_admin") {
      ownerUid = decodedToken.uid;
    } else if (userData.ownerUid) {
      ownerUid = userData.ownerUid;
    } else {
      return {
        success: false,
        error: "User has no associated salon owner",
        status: 403,
      };
    }
    
    // Check if user has an allowed role
    if (allowedRoles && allowedRoles.length > 0) {
      const hasAllowedRole = allowedRoles.some(
        role => userRole === role.toLowerCase()
      );
      
      if (!hasAllowedRole) {
        return {
          success: false,
          error: `Access denied. Required roles: ${allowedRoles.join(", ")}`,
          status: 403,
        };
      }
    }

    // Check billing status (skip for super_admin and billing routes)
    if (!skipBillingCheck && userRole !== "super_admin") {
      const billingStatus = userData.billing_status || userData.subscriptionStatus || "active";
      const pathname = req.nextUrl.pathname;

      // Block suspended or cancelled accounts (except billing routes)
      if ((billingStatus === "suspended" || billingStatus === "cancelled") && !isBillingRoute(pathname)) {
        return {
          success: false,
          error: "Account suspended. Please update your payment method to continue.",
          status: 403,
          billingBlocked: true,
          redirectTo: "/subscription",
        };
      }

      // Block trial_expired accounts (except billing/subscription routes)
      if ((billingStatus === "trial_expired" || userData.accountStatus === "trial_expired") && !isBillingRoute(pathname)) {
        return {
          success: false,
          error: "Your free trial has expired. Please subscribe to continue using the platform.",
          status: 403,
          billingBlocked: true,
          redirectTo: "/subscription",
        };
      }

      // Allow past_due accounts but they'll see banners in UI
      // (We don't block them, just show warnings)
    }
    
    return {
      success: true,
      user: decodedToken,
      userData: {
        uid: decodedToken.uid,
        role: userRole,
        ownerUid,
        name: userData.name || userData.displayName,
        email: userData.email || decodedToken.email,
        branchId: userData.branchId,
        billingStatus: userData.billing_status || userData.subscriptionStatus,
      },
    };
  } catch (error: any) {
    console.error("Token verification failed:", error?.code || error?.message);
    
    if (error?.code === "auth/id-token-expired") {
      return {
        success: false,
        error: "Token expired. Please sign in again.",
        status: 401,
      };
    }
    
    if (error?.code === "auth/id-token-revoked") {
      return {
        success: false,
        error: "Token has been revoked. Please sign in again.",
        status: 401,
      };
    }
    
    if (error?.code === "auth/argument-error") {
      return {
        success: false,
        error: "Invalid token format",
        status: 401,
      };
    }
    
    return {
      success: false,
      error: "Invalid or expired token",
      status: 401,
    };
  }
}

/**
 * Verify that a resource belongs to the authenticated user's tenant
 * 
 * @param resourceOwnerUid - The ownerUid of the resource being accessed
 * @param authUserOwnerUid - The ownerUid derived from the authenticated user
 * @returns true if the resource belongs to the user's tenant
 */
export function verifyTenantAccess(
  resourceOwnerUid: string | undefined | null,
  authUserOwnerUid: string
): boolean {
  if (!resourceOwnerUid) return false;
  return resourceOwnerUid === authUserOwnerUid;
}

/**
 * Check if user can manage a specific staff member
 * (Used for operations like suspend, delete, update)
 */
export async function canManageStaff(
  managerOwnerUid: string,
  targetStaffUid: string
): Promise<{ allowed: boolean; error?: string }> {
  try {
    const staffDoc = await adminDb().doc(`users/${targetStaffUid}`).get();
    
    if (!staffDoc.exists) {
      return { allowed: false, error: "Staff member not found" };
    }
    
    const staffData = staffDoc.data()!;
    const staffOwnerUid = staffData.ownerUid;
    
    // Staff must belong to the same salon/owner
    if (staffOwnerUid !== managerOwnerUid) {
      return { allowed: false, error: "You can only manage staff in your own salon" };
    }
    
    return { allowed: true };
  } catch (error) {
    console.error("Error checking staff management permission:", error);
    return { allowed: false, error: "Failed to verify permissions" };
  }
}
