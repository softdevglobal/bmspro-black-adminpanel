import { NextRequest, NextResponse } from "next/server";
import { adminAuth, adminDb } from "@/lib/firebaseAdmin";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { email, code } = body;
    
    if (!email || !email.trim() || !code || !code.trim()) {
      return NextResponse.json(
        { error: "Email and code are required" },
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
    
    // Validate code format (6 digits)
    if (!/^\d{6}$/.test(code.trim())) {
      return NextResponse.json(
        { error: "Invalid code format. Code must be 6 digits." },
        { status: 400 }
      );
    }
    
    try {
      // Get user from Firebase Auth
      const auth = adminAuth();
      const user = await auth.getUserByEmail(email.trim().toLowerCase());
      
      // Check reset code in Firestore
      const db = adminDb();
      const codeDoc = await db.collection("passwordResetCodes").doc(user.uid).get();
      
      if (!codeDoc.exists) {
        return NextResponse.json(
          { error: "Invalid or expired code. Please request a new one." },
          { status: 400 }
        );
      }
      
      const codeData = codeDoc.data();
      
      // Check if code has been used
      if (codeData?.used === true) {
        return NextResponse.json(
          { error: "This code has already been used. Please request a new one." },
          { status: 400 }
        );
      }
      
      // Check if code matches
      if (codeData?.code !== code.trim()) {
        return NextResponse.json(
          { error: "Invalid code. Please check and try again." },
          { status: 400 }
        );
      }
      
      // Check if code has expired
      const expiresAt = codeData?.expiresAt?.toDate?.();
      if (expiresAt && expiresAt < new Date()) {
        // Delete expired code
        await db.collection("passwordResetCodes").doc(user.uid).delete();
        return NextResponse.json(
          { error: "Code has expired. Please request a new one." },
          { status: 400 }
        );
      }
      
      // Verify email matches
      if (codeData?.email?.toLowerCase() !== email.trim().toLowerCase()) {
        return NextResponse.json(
          { error: "Email does not match the code." },
          { status: 400 }
        );
      }
      
      // Code is valid - return success
      return NextResponse.json({
        success: true,
        message: "Code verified successfully",
        userId: user.uid,
      });
    } catch (error: any) {
      if (error?.code === "auth/user-not-found") {
        return NextResponse.json(
          { error: "Invalid email address." },
          { status: 400 }
        );
      }
      
      console.error("[API] Error verifying reset code:", error);
      return NextResponse.json(
        {
          success: false,
          error: "Failed to verify code. Please try again.",
        },
        { status: 500 }
      );
    }
  } catch (error: any) {
    console.error("[API] Error verifying reset code:", error);
    return NextResponse.json(
      {
        success: false,
        error: error?.message || "Failed to verify code",
      },
      { status: 500 }
    );
  }
}
