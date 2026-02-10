import { NextRequest, NextResponse } from "next/server";
import { adminAuth, adminDb } from "@/lib/firebaseAdmin";
import { verifyAdminAuth, STAFF_MANAGEMENT_ROLES, verifyTenantAccess } from "@/lib/authHelpers";
import { checkRateLimit, getClientIdentifier, RateLimiters, getRateLimitHeaders } from "@/lib/rateLimiterDistributed";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    // Security: Distributed rate limiting to prevent staff auth spam
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

    // Security: Verify authentication - only salon owners/branch admins can create staff
    const authResult = await verifyAdminAuth(req, STAFF_MANAGEMENT_ROLES);
    if (!authResult.success) {
      return NextResponse.json(
        { error: authResult.error },
        { status: authResult.status }
      );
    }

    const { userData } = authResult;
    
    const body = await req.json();
    const { email, displayName, password, ownerUid } = body;

    if (!email || typeof email !== "string") {
      return NextResponse.json({ error: "Email is required" }, { status: 400 });
    }

    // Security: Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return NextResponse.json({ error: "Invalid email format" }, { status: 400 });
    }

    // Validate password: if provided, must be at least 6 characters
    if (password && typeof password === "string" && password.length < 6) {
      return NextResponse.json({ error: "Password must be at least 6 characters long" }, { status: 400 });
    }

    // Security: If ownerUid is provided, verify it matches the authenticated user's ownerUid
    // This prevents creating staff for other salons
    if (ownerUid && !verifyTenantAccess(ownerUid, userData.ownerUid)) {
      return NextResponse.json(
        { error: "You can only create staff for your own salon" },
        { status: 403 }
      );
    }

    const auth = adminAuth();
    let uid: string;

    try {
      // Check if user already exists
      const existingUser = await auth.getUserByEmail(email.trim().toLowerCase());
      uid = existingUser.uid;
      
      // Security: Verify the existing user belongs to the same salon
      const existingUserDoc = await adminDb().doc(`users/${uid}`).get();
      if (existingUserDoc.exists) {
        const existingUserData = existingUserDoc.data();
        // If user has an ownerUid and it doesn't match, deny
        if (existingUserData?.ownerUid && existingUserData.ownerUid !== userData.ownerUid) {
          return NextResponse.json(
            { error: "This email is already associated with another salon" },
            { status: 403 }
          );
        }
      }
      
      // If user exists, update password if provided, and ensure account is enabled
      const updateData: any = {
        disabled: false,
        displayName: displayName || existingUser.displayName,
        emailVerified: false,
      };
      if (password && password.length >= 6) {
        updateData.password = password;
      }
      
      await auth.updateUser(uid, updateData);

    } catch (error: any) {
      if (error.code === "auth/user-not-found") {
        // Create new user
        // Password is required for new staff accounts and must be at least 6 characters
        if (!password || typeof password !== "string" || password.length < 6) {
          return NextResponse.json({ 
            error: "Password is required and must be at least 6 characters long when creating a new staff member" 
          }, { status: 400 });
        }
        
        try {
          const user = await auth.createUser({
            email: email.trim().toLowerCase(),
            displayName: displayName || "",
            password: password, // Password is required and validated above
            emailVerified: false,
            disabled: false,
          });
          uid = user.uid;
          
          // Revoke all existing sessions to prevent auto-login
          try {
            await auth.revokeRefreshTokens(uid);
          } catch (revokeError) {
            console.log("No existing tokens to revoke for new user");
          }
        } catch (createError: any) {
          console.error("Error creating user:", createError);
          return NextResponse.json({ 
            error: createError.message || "Failed to create user", 
            code: createError.code 
          }, { status: 400 });
        }
      } else {
        console.error("Error fetching user:", error);
        if (error.code?.startsWith("auth/")) {
           return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
        }
        throw error;
      }
    }
    
    // Revoke existing sessions
    try {
      await auth.revokeRefreshTokens(uid);
    } catch (revokeError) {
      console.log("Could not revoke tokens (may not exist)");
    }

    // Return the created staff's ownerUid so the client knows which salon they belong to
    return NextResponse.json({ 
      uid, 
      ownerUid: userData.ownerUid,
      createdBy: userData.uid,
    }, { status: 200 });
  } catch (err: any) {
    console.error("API Error:", err);
    const msg = process.env.NODE_ENV === "production" 
      ? "Internal Server Error" 
      : err?.message || "Internal Server Error";
    const hint = "Check Firebase Admin credentials in your .env (FIREBASE_SERVICE_ACCOUNT or FIREBASE_ADMIN_* vars).";
    return NextResponse.json({ error: msg, hint }, { status: 500 });
  }
}
