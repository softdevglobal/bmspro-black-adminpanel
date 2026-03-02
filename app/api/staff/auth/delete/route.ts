import { NextRequest, NextResponse } from "next/server";
import { adminAuth, adminDb } from "@/lib/firebaseAdmin";
import { logStaffDeletedServer } from "@/lib/auditLogServer";
import { verifyAdminAuth, STAFF_MANAGEMENT_ROLES, canManageStaff } from "@/lib/authHelpers";
import { checkRateLimit, getClientIdentifier, RateLimiters, getRateLimitHeaders } from "@/lib/rateLimiterDistributed";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    // Security: Distributed rate limiting to prevent abuse
    const clientId = getClientIdentifier(req);
    const rateLimitResult = await checkRateLimit(clientId, RateLimiters.staffAuth);
    
    if (!rateLimitResult.success) {
      return NextResponse.json(
        { 
          error: "Too many requests. Please try again later.",
          retryAfter: rateLimitResult.retryAfter,
        },
        { 
          status: 429,
          headers: getRateLimitHeaders(rateLimitResult),
        }
      );
    }

    // Security: Verify authentication - owners, branch admins, and super admins can delete
    const authResult = await verifyAdminAuth(req, STAFF_MANAGEMENT_ROLES);
    if (!authResult.success) {
      return NextResponse.json(
        { error: authResult.error },
        { status: authResult.status }
      );
    }

    const { userData } = authResult;
    if (!userData) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json();
    const { uid, email, staffName } = body;
    
    const auth = adminAuth();
    let targetUid = uid as string | undefined;
    
    // Try to find user by email if UID not provided or empty
    if ((!targetUid || targetUid === "null" || targetUid === "undefined") && email) {
      const user = await auth.getUserByEmail(String(email).trim().toLowerCase()).catch(() => null);
      targetUid = user?.uid;
    }
    
    if (!targetUid || targetUid === "null" || targetUid === "undefined") {
      // If no auth user found, that's OK – they may never have had an auth account
      return NextResponse.json({ ok: true, message: "No auth user found – nothing to delete" }, { status: 200 });
    }

    // Security: Prevent users from deleting themselves
    if (targetUid === userData.uid) {
      return NextResponse.json(
        { error: "You cannot delete your own account" },
        { status: 400 }
      );
    }

    // Security: Super admins can delete any user; others must own the staff
    if (!userData.isSuperAdmin) {
      const canManage = await canManageStaff(userData.ownerUid, targetUid);
      if (!canManage.allowed) {
        return NextResponse.json(
          { error: canManage.error || "You can only delete staff from your own workshop" },
          { status: 403 }
        );
      }
    }

    // Get staff data before deletion for audit log
    let staffDisplayName = staffName || "Unknown Staff";
    
    try {
      const db = adminDb();
      const userDoc = await db.doc(`users/${targetUid}`).get();
      const staffData = userDoc.data();
      if (staffData) {
        staffDisplayName = staffData.name || staffData.displayName || staffDisplayName;
      }
    } catch (e) {
      // Continue with provided data
    }

    // Delete the user from Firebase Auth
    try {
      await auth.deleteUser(targetUid);
    } catch (authErr: any) {
      // If user doesn't exist in Auth, that's fine – continue with success
      if (authErr?.code === "auth/user-not-found") {
        console.log(`Auth user ${targetUid} not found – already deleted or never existed`);
      } else {
        throw authErr; // Re-throw real errors
      }
    }

    // Create audit log with verified performer data
    try {
      await logStaffDeletedServer(
        userData.ownerUid, // Use verified ownerUid
        targetUid,
        staffDisplayName,
        {
          uid: userData.uid, // Use authenticated user's UID
          name: userData.name || "Admin",
          role: userData.role,
        }
      );
    } catch (auditError) {
      console.error("Failed to create audit log for staff deletion:", auditError);
    }

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err: any) {
    console.error("API Error:", err);
    const message = process.env.NODE_ENV === "production"
      ? "Failed to delete auth user"
      : err?.message || "Failed to delete auth user";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
