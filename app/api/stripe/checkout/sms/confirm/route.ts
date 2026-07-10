import { NextRequest, NextResponse } from "next/server";
import { verifyAdminAuth } from "@/lib/authHelpers";
import { confirmCheckoutSessionForBusiness } from "@/lib/stripe/fulfill";

export const runtime = "nodejs";

/**
 * Fallback fulfillment when Stripe webhooks are not configured (e.g. local dev).
 * Idempotent — safe to call after webhook already fulfilled the session.
 */
export async function POST(req: NextRequest) {
  const auth = await verifyAdminAuth(req, ["workshop_owner"]);
  if (!auth.success || !auth.userData) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status ?? 401 });
  }

  try {
    const body = await req.json();
    const sessionId = String(body.sessionId ?? "").trim();
    if (!sessionId) {
      return NextResponse.json({ ok: false, error: "sessionId is required" }, { status: 400 });
    }

    const result = await confirmCheckoutSessionForBusiness(sessionId, auth.userData.ownerUid);
    return NextResponse.json({
      ok: true,
      fulfilled: result.fulfilled,
      balance: {
        limit: result.balance.limit,
        used: result.balance.used,
        remaining: result.balance.remaining,
        unlimited: result.balance.unlimited,
        isLow: result.balance.isLow,
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to confirm SMS checkout";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
