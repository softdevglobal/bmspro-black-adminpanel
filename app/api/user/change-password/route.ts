import { NextRequest, NextResponse } from "next/server";
import { adminAuth } from "@/lib/firebaseAdmin";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { newPassword, uid } = body;
    
    // Get auth token from header
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return NextResponse.json(
        { error: "Unauthorized - Missing or invalid authorization token" },
        { status: 401 }
      );
    }
    
    if (!newPassword || !uid) {
      return NextResponse.json(
        { error: "Missing required fields: newPassword and uid are required" },
        { status: 400 }
      );
    }
    
    // Validate password strength
    const passwordErrors: string[] = [];
    
    if (newPassword.length < 8) {
      passwordErrors.push("at least 8 characters");
    }
    
    if (!/[A-Z]/.test(newPassword)) {
      passwordErrors.push("one uppercase letter");
    }
    
    if (!/[a-z]/.test(newPassword)) {
      passwordErrors.push("one lowercase letter");
    }
    
    if (!/[0-9]/.test(newPassword)) {
      passwordErrors.push("one number");
    }
    
    if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(newPassword)) {
      passwordErrors.push("one special character");
    }
    
    if (passwordErrors.length > 0) {
      return NextResponse.json(
        { error: `Password must contain: ${passwordErrors.join(", ")}` },
        { status: 400 }
      );
    }
    
    try {
      // Verify the token and get user
      const token = authHeader.replace("Bearer ", "");
      const decodedToken = await adminAuth().verifyIdToken(token);
      
      // Ensure the user is changing their own password
      if (decodedToken.uid !== uid) {
        return NextResponse.json(
          { error: "Unauthorized - You can only change your own password" },
          { status: 403 }
        );
      }
      
      // Update password using admin SDK
      await adminAuth().updateUser(uid, {
        password: newPassword,
      });
      
      return NextResponse.json({
        success: true,
        message: "Password changed successfully",
      });
    } catch (error: any) {
      if (error?.code === "auth/id-token-expired" || error?.code === "auth/id-token-revoked") {
        return NextResponse.json(
          { error: "Session expired. Please log in again." },
          { status: 401 }
        );
      }
      throw error;
    }
  } catch (error: any) {
    console.error("[API] Error changing password:", error);
    return NextResponse.json(
      {
        success: false,
        error: error?.message || "Failed to change password",
      },
      { status: 500 }
    );
  }
}
