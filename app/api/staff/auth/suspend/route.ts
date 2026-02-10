import { NextRequest, NextResponse } from "next/server";
import { adminAuth, adminDb } from "@/lib/firebaseAdmin";
import { logStaffSuspendedServer } from "@/lib/auditLogServer";
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

    // Security: Verify authentication - only salon owners/branch admins can suspend staff
    const authResult = await verifyAdminAuth(req, STAFF_MANAGEMENT_ROLES);
    if (!authResult.success) {
      return NextResponse.json(
        { error: authResult.error },
        { status: authResult.status }
      );
    }

    const { userData } = authResult;
    
    const body = await req.json();
    const { uid, disabled } = body;

    if (!uid) {
      return NextResponse.json({ error: "Missing uid" }, { status: 400 });
    }

    // Security: Verify the staff member belongs to the same salon as the requester
    const canManage = await canManageStaff(userData.ownerUid, uid);
    if (!canManage.allowed) {
      return NextResponse.json(
        { error: canManage.error || "You can only suspend staff from your own salon" },
        { status: 403 }
      );
    }

    // Security: Prevent users from suspending themselves
    if (uid === userData.uid) {
      return NextResponse.json(
        { error: "You cannot suspend your own account" },
        { status: 400 }
      );
    }

    // Update the user's disabled status in Firebase Auth
    await adminAuth().updateUser(uid, {
      disabled: Boolean(disabled),
    });

    // Create audit log with verified performer data
    try {
      const db = adminDb();
      const userDoc = await db.doc(`users/${uid}`).get();
      const staffData = userDoc.data();
      const staffName = staffData?.name || staffData?.displayName || "Unknown Staff";

      await logStaffSuspendedServer(
        userData.ownerUid, // Use verified ownerUid
        uid,
        staffName,
        {
          uid: userData.uid, // Use authenticated user's UID
          name: userData.name || "Admin",
          role: userData.role,
        },
        Boolean(disabled)
      );
    } catch (auditError) {
      console.error("Failed to create audit log for staff suspension:", auditError);
    }

    return NextResponse.json({ 
      success: true, 
      uid,
      disabled: Boolean(disabled),
      message: disabled ? "User account suspended" : "User account reactivated"
    });
  } catch (error: any) {
    console.error("Error updating user status:", error);
    
    if (error.code === "auth/user-not-found") {
      return NextResponse.json({ 
        error: "User not found in auth system",
        code: error.code 
      }, { status: 404 });
    }
    
    const message = process.env.NODE_ENV === "production"
      ? "Failed to update user status"
      : error.message || "Failed to update user status";
    return NextResponse.json({ 
      error: message,
      code: error.code 
    }, { status: 500 });
  }
}
