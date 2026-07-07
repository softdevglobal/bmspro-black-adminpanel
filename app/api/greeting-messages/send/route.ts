import { NextRequest, NextResponse } from "next/server";
import { verifyAdminAuth } from "@/lib/authHelpers";
import { sendGreetingMessages } from "@/lib/greetingMessages/server";
import { isValidGreetingAudience } from "@/lib/greetingMessages/types";

export const runtime = "nodejs";

/**
 * POST /api/greeting-messages/send
 *
 * Send a custom SMS to customers and/or staff via TextBee.
 *
 * Body: { message: string, audience: "customers" | "staff" | "both" }
 */
export async function POST(req: NextRequest) {
  const auth = await verifyAdminAuth(req, ["workshop_owner"]);
  if (!auth.success || !auth.userData) {
    return NextResponse.json(
      { ok: false, error: auth.error },
      { status: auth.status || 401 },
    );
  }

  let body: { message?: unknown; audience?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  const message = typeof body.message === "string" ? body.message.trim() : "";
  const audience = body.audience;

  if (!message) {
    return NextResponse.json({ ok: false, error: "Message is required" }, { status: 400 });
  }
  if (!isValidGreetingAudience(audience)) {
    return NextResponse.json(
      { ok: false, error: "Invalid audience. Use customers, staff, or both." },
      { status: 400 },
    );
  }

  try {
    const result = await sendGreetingMessages({
      ownerUid: auth.userData.uid,
      audience,
      message,
      performedBy: auth.userData.uid,
      performedByName: auth.userData.name || auth.userData.email,
    });

    return NextResponse.json({ ok: true, ...result });
  } catch (error: unknown) {
    console.error("[greeting-messages/send] Error:", error);
    const msg = error instanceof Error ? error.message : "Failed to send custom SMS";
    const status = msg.includes("not configured") ? 503 : 500;
    return NextResponse.json({ ok: false, error: msg }, { status });
  }
}
