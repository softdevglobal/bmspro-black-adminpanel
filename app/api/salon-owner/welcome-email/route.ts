import { NextRequest, NextResponse } from "next/server";
import { sendSalonOwnerWelcomeEmail, sendAdminSignupNotificationEmail } from "@/lib/emailService";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { 
      email, 
      password, 
      businessName, 
      planName, 
      planPrice, 
      paymentUrl, 
      trialDays,
      bookingEngineUrl,
      // Additional fields for admin notification
      businessType,
      state,
      phone,
      abn,
    } = body;
    
    if (!email || !password || !businessName) {
      return NextResponse.json(
        { error: "Missing required fields: email, password, and businessName are required" },
        { status: 400 }
      );
    }
    
    console.log(`[API] Sending welcome email to salon owner: ${email}`, { trialDays });
    
    // Send welcome email to the new salon owner
    const result = await sendSalonOwnerWelcomeEmail(
      email, 
      password, 
      businessName,
      planName,
      planPrice,
      paymentUrl,
      trialDays,
      bookingEngineUrl
    );
    
    if (!result.success) {
      return NextResponse.json(
        { error: result.error || "Failed to send welcome email" },
        { status: 500 }
      );
    }
    
    // Send notification email to admin about the new signup
    try {
      await sendAdminSignupNotificationEmail(
        businessName,
        email,
        planName,
        planPrice,
        businessType,
        state,
        phone,
        abn,
        trialDays
      );
      console.log(`[API] Admin notification sent for new signup: ${businessName}`);
    } catch (adminEmailError) {
      // Don't fail the whole request if admin email fails
      console.error("[API] Failed to send admin notification email:", adminEmailError);
    }
    
    return NextResponse.json({
      success: true,
      message: `Welcome email sent successfully to ${email}`,
    });
  } catch (error: any) {
    console.error("[API] Error sending welcome email:", error);
    return NextResponse.json(
      {
        success: false,
        error: error?.message || "Unknown error occurred",
      },
      { status: 500 }
    );
  }
}
