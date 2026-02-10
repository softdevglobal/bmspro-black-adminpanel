import { NextRequest, NextResponse } from "next/server";
import { adminAuth, adminDb } from "@/lib/firebaseAdmin";
import { sendPasswordResetEmail } from "@/lib/emailService";
import { FieldValue } from "firebase-admin/firestore";

export const runtime = "nodejs";

// Generate a 6-digit verification code
function generateResetCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { email } = body;
    
    if (!email || !email.trim()) {
      return NextResponse.json(
        { error: "Email is required" },
        { status: 400 }
      );
    }
    
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email.trim())) {
      return NextResponse.json(
        { error: "Invalid email address" },
        { status: 400 }
      );
    }
    
    try {
      // Check if user exists in Firebase Auth
      const auth = adminAuth();
      const user = await auth.getUserByEmail(email.trim().toLowerCase());
      
      // Verify the user is a salon owner (only salon owners can use forgot password)
      const db = adminDb();
      const userDoc = await db.doc(`users/${user.uid}`).get();
      
      if (!userDoc.exists) {
        // User doesn't exist in users collection - don't reveal this, just return success
        return NextResponse.json({
          success: true,
          message: "If an account exists with this email, a password reset code has been sent.",
        });
      }
      
      const userData = userDoc.data();
      const userRole = (userData?.role || "").toString().toLowerCase();
      
      // Only allow salon_owner, salon_branch_admin, and super_admin to reset password
      const allowedRoles = ["salon_owner", "salon_branch_admin", "super_admin"];
      if (!allowedRoles.includes(userRole)) {
        // Don't reveal the account exists but isn't allowed - return success anyway
        return NextResponse.json({
          success: true,
          message: "If an account exists with this email, a password reset code has been sent.",
        });
      }
      
      // Generate 6-digit reset code
      const resetCode = generateResetCode();
      const expirationTime = new Date();
      expirationTime.setMinutes(expirationTime.getMinutes() + 15); // Code expires in 15 minutes
      
      // Store the reset code in Firestore
      await db.collection("passwordResetCodes").doc(user.uid).set({
        email: email.trim().toLowerCase(),
        code: resetCode,
        expiresAt: expirationTime,
        createdAt: FieldValue.serverTimestamp(),
        used: false,
      });
      
      // Get user name for email
      const userName = userData?.name || userData?.displayName || email.trim().toLowerCase();
      
      // Send password reset email with code
      await sendPasswordResetEmail(email.trim().toLowerCase(), userName, resetCode);
      
      return NextResponse.json({
        success: true,
        message: "If an account exists with this email, a password reset code has been sent.",
      });
    } catch (error: any) {
      // Don't reveal if user doesn't exist - return success anyway for security
      if (error?.code === "auth/user-not-found") {
        return NextResponse.json({
          success: true,
          message: "If an account exists with this email, a password reset code has been sent.",
        });
      }
      
      console.error("[API] Error in forgot password:", error);
      return NextResponse.json(
        {
          success: false,
          error: "Failed to process password reset request. Please try again later.",
        },
        { status: 500 }
      );
    }
  } catch (error: any) {
    console.error("[API] Error in forgot password:", error);
    return NextResponse.json(
      {
        success: false,
        error: error?.message || "Failed to process password reset request",
      },
      { status: 500 }
    );
  }
}
