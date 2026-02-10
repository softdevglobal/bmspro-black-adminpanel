import { NextRequest, NextResponse } from "next/server";
import { adminAuth, adminDb } from "@/lib/firebaseAdmin";

export const runtime = "nodejs";

/**
 * One-time setup endpoint to create a super_admin user.
 * 
 * This should only be used when the database is empty and you need to create
 * the first super_admin account.
 * 
 * IMPORTANT: This endpoint should be disabled or restricted after initial setup!
 * 
 * Usage:
 * POST /api/setup/create-super-admin
 * Body: {
 *   email: "admin@example.com",
 *   password: "securePassword123",
 *   displayName: "Super Admin",
 *   secretKey: "YOUR_SECRET_KEY" // Set this in environment variable SETUP_SECRET_KEY
 * }
 * 
 * For production:
 * 1. Set SETUP_SECRET_KEY in your production environment variables
 * 2. Call this endpoint once to create the super_admin
 * 3. Consider disabling this endpoint after setup for security
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { email, password, displayName, secretKey } = body;

    // Validate secret key: accept SETUP_SECRET_KEY from env, or in development also accept dev-setup-key-allow (method 2, no .env change)
    const envSecretKey = process.env.SETUP_SECRET_KEY;
    const devKey = "dev-setup-key-allow";
    const validKey =
      secretKey &&
      (secretKey === envSecretKey || (process.env.NODE_ENV === "development" && secretKey === devKey));
    if (!validKey) {
      return NextResponse.json(
        {
          error: "Invalid secret key",
          hint: process.env.NODE_ENV === "development"
            ? "Use secretKey: 'dev-setup-key-allow' (method 2) or your SETUP_SECRET_KEY from .env"
            : "Set SETUP_SECRET_KEY in your environment"
        },
        { status: 403 }
      );
    }

    // Validate required fields
    if (!email || typeof email !== "string") {
      return NextResponse.json({ error: "Email is required" }, { status: 400 });
    }

    if (!password || typeof password !== "string" || password.length < 6) {
      return NextResponse.json(
        { error: "Password is required and must be at least 6 characters long" },
        { status: 400 }
      );
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return NextResponse.json({ error: "Invalid email format" }, { status: 400 });
    }

    const auth = adminAuth();
    const db = adminDb();
    let uid: string;

    try {
      // Check if user already exists in Firebase Auth
      const existingUser = await auth.getUserByEmail(email.trim().toLowerCase());
      uid = existingUser.uid;
      
      // Check if super_admin already exists in super_admins collection
      const existingSuperAdminDoc = await db.doc(`super_admins/${uid}`).get();
      if (existingSuperAdminDoc.exists) {
        return NextResponse.json(
          { 
            error: "Super admin already exists",
            uid,
            message: "A super admin with this email already exists"
          },
          { status: 409 }
        );
      }
      
      // Create super_admin document in super_admins collection
      await db.doc(`super_admins/${uid}`).set({
        uid,
        email: email.trim().toLowerCase(),
        displayName: displayName || existingUser.displayName || "Super Admin",
        role: "super_admin",
        createdAt: new Date(),
        updatedAt: new Date(),
        provider: "password",
      });
      
      // Update password
      await auth.updateUser(uid, {
        password: password,
        displayName: displayName || existingUser.displayName || "Super Admin",
        disabled: false,
      });
      
      return NextResponse.json({
        success: true,
        message: "Super admin created from existing Auth user",
        uid,
        email: email.trim().toLowerCase(),
      }, { status: 200 });

    } catch (error: any) {
      if (error.code === "auth/user-not-found") {
        // Create new user in Firebase Auth
        try {
          const user = await auth.createUser({
            email: email.trim().toLowerCase(),
            displayName: displayName || "Super Admin",
            password: password,
            emailVerified: false,
            disabled: false,
          });
          uid = user.uid;
          
          // Create super_admin document in super_admins collection
          await db.doc(`super_admins/${uid}`).set({
            uid,
            email: email.trim().toLowerCase(),
            displayName: displayName || "Super Admin",
            role: "super_admin",
            createdAt: new Date(),
            updatedAt: new Date(),
            provider: "password",
          });
          
          // Revoke all existing sessions to prevent auto-login
          try {
            await auth.revokeRefreshTokens(uid);
          } catch (revokeError) {
            console.log("No existing tokens to revoke for new user");
          }
          
          return NextResponse.json({
            success: true,
            message: "Super admin created successfully",
            uid,
            email: email.trim().toLowerCase(),
          }, { status: 201 });
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
          return NextResponse.json(
            { error: error.message, code: error.code },
            { status: 400 }
          );
        }
        throw error;
      }
    }
  } catch (err: any) {
    console.error("API Error:", err);
    const msg = process.env.NODE_ENV === "production"
      ? "Internal Server Error"
      : err?.message || "Internal Server Error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
