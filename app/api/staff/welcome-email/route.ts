import { NextRequest, NextResponse } from "next/server";
import { sendStaffWelcomeEmail } from "@/lib/emailService";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { email, password, staffName, role, salonName, branchName } = body;
    
    if (!email || !password || !staffName || !role) {
      return NextResponse.json(
        { error: "Missing required fields: email, password, staffName, and role are required" },
        { status: 400 }
      );
    }
    
    // Validate role
    if (role !== "salon_staff" && role !== "salon_branch_admin") {
      return NextResponse.json(
        { error: "Invalid role. Must be 'salon_staff' or 'salon_branch_admin'" },
        { status: 400 }
      );
    }
    
    console.log(`[API] Sending welcome email to staff: ${email}`);
    
    const result = await sendStaffWelcomeEmail(
      email,
      password,
      staffName,
      role,
      salonName,
      branchName
    );
    
    if (!result.success) {
      return NextResponse.json(
        { error: result.error || "Failed to send welcome email" },
        { status: 500 }
      );
    }
    
    return NextResponse.json({
      success: true,
      message: `Welcome email sent successfully to ${email}`,
    });
  } catch (error: any) {
    console.error("[API] Error sending staff welcome email:", error);
    return NextResponse.json(
      {
        success: false,
        error: error?.message || "Unknown error occurred",
      },
      { status: 500 }
    );
  }
}
