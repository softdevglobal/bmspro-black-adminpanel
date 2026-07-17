import { NextRequest, NextResponse } from "next/server";
import { verifyAdminAuth } from "@/lib/authHelpers";
import { createSmsCheckoutSession } from "@/lib/stripe/fulfill";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const auth = await verifyAdminAuth(req, ["workshop_owner"]);
  if (!auth.success || !auth.userData) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status ?? 401 });
  }

  try {
    const body = await req.json();
    const packageId = String(body.packageId ?? "").trim();
    if (!packageId) {
      return NextResponse.json({ ok: false, error: "packageId is required" }, { status: 400 });
    }

    const origin = req.nextUrl.origin;
    const session = await createSmsCheckoutSession({
      ownerUid: auth.userData.ownerUid,
      packageId,
      successUrl:
        body.successUrl ||
        `${origin}/sms?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: body.cancelUrl || `${origin}/sms?checkout=cancelled`,
      customerEmail: auth.userData.email,
    });

    return NextResponse.json({ ok: true, url: session.url, sessionId: session.sessionId });
  } catch (error: unknown) {
    console.error("[STRIPE SMS CHECKOUT] Failed to create session:", error);
    const message = error instanceof Error ? error.message : "Failed to start SMS checkout";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
