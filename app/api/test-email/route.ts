import { NextRequest, NextResponse } from "next/server";
import sgMail from "@sendgrid/mail";

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || "booking@bmspros.com.au";

if (SENDGRID_API_KEY) {
  sgMail.setApiKey(SENDGRID_API_KEY);
}

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { to } = body;
    
    if (!to) {
      return NextResponse.json({ error: "Missing 'to' email address" }, { status: 400 });
    }
    
    const msg = {
      to: to,
      from: FROM_EMAIL,
      subject: "Test Email from BMS Pro",
      html: `
        <h1>Test Email</h1>
        <p>This is a test email to verify SendGrid is working correctly.</p>
        <p>If you received this, your email configuration is working!</p>
        <p><strong>From:</strong> ${FROM_EMAIL}</p>
        <p><strong>API Key configured:</strong> ${SENDGRID_API_KEY ? "Yes" : "No"}</p>
      `,
    };
    
    console.log(`[TEST EMAIL] Sending test email to ${to} from ${FROM_EMAIL}`);
    
    await sgMail.send(msg);
    
    return NextResponse.json({ 
      success: true, 
      message: `Test email sent to ${to}`,
      from: FROM_EMAIL,
    });
  } catch (error: any) {
    console.error("[TEST EMAIL] Error:", error);
    return NextResponse.json({ 
      success: false, 
      error: error?.response?.body?.errors?.[0]?.message || error?.message || "Unknown error",
      details: error?.response?.body,
    }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  return NextResponse.json({ 
    message: "Send POST request with { to: 'email@example.com' } to test email",
    fromEmail: FROM_EMAIL,
    apiKeyConfigured: !!SENDGRID_API_KEY,
  });
}
