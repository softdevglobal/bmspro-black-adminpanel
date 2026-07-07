import { NextRequest, NextResponse } from "next/server";
import { isZeptoMailConfigured, sendEmail } from "@/lib/email";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { to, sender } = body as { to?: string; sender?: "system" | "request" };

    if (!to) {
      return NextResponse.json({ error: "Missing 'to' email address" }, { status: 400 });
    }

    const mailbox = sender === "request" ? "request" : "system";

    const result = await sendEmail({
      sender: mailbox,
      to,
      subject: "Test Email from BMS Pro Black",
      htmlBody: `
        <h1>Test Email</h1>
        <p>This is a test email to verify ZeptoMail is working correctly.</p>
        <p>If you received this, your email configuration is working!</p>
        <p><strong>Mailbox:</strong> ${mailbox}</p>
        <p><strong>ZeptoMail configured:</strong> ${isZeptoMailConfigured() ? "Yes" : "No"}</p>
      `,
    });

    if (!result.ok) {
      return NextResponse.json(
        {
          success: false,
          error: result.code
            ? `${result.code}: ${result.message}`
            : result.message,
          code: result.code,
        },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      message: `Test email sent to ${to}`,
      sender: mailbox,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[TEST EMAIL] Error:", error);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({
    message:
      "Send POST request with { to: 'email@example.com', sender?: 'system' | 'request' } to test email",
    zeptoMailConfigured: isZeptoMailConfigured(),
  });
}
