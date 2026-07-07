import { NextRequest, NextResponse } from "next/server";
import { verifyAdminAuth } from "@/lib/authHelpers";
import { loadGreetingRecipients } from "@/lib/greetingMessages/server";
import {
  GREETING_AUDIENCE_LABELS,
  isValidGreetingAudience,
  type GreetingAudience,
} from "@/lib/greetingMessages/types";
import { isSmsConfigured } from "@/lib/smsService";

export const runtime = "nodejs";

/**
 * GET /api/greeting-messages/recipients?audience=customers|staff|both
 *
 * Preview how many recipients have a valid phone number for custom SMS.
 */
export async function GET(req: NextRequest) {
  const auth = await verifyAdminAuth(req, ["workshop_owner"]);
  if (!auth.success || !auth.userData) {
    return NextResponse.json(
      { ok: false, error: auth.error },
      { status: auth.status || 401 },
    );
  }

  const audienceParam = req.nextUrl.searchParams.get("audience") || "both";
  if (!isValidGreetingAudience(audienceParam)) {
    return NextResponse.json(
      { ok: false, error: "Invalid audience. Use customers, staff, or both." },
      { status: 400 },
    );
  }

  const audience = audienceParam as GreetingAudience;
  const ownerUid = auth.userData.uid;

  try {
    const recipients = await loadGreetingRecipients(ownerUid, audience);
    const customers = recipients.filter((r) => r.type === "customer").length;
    const staff = recipients.filter((r) => r.type === "staff").length;

    return NextResponse.json({
      ok: true,
      audience,
      audienceLabel: GREETING_AUDIENCE_LABELS[audience],
      total: recipients.length,
      customers,
      staff,
      smsConfigured: isSmsConfigured(),
    });
  } catch (error: unknown) {
    console.error("[greeting-messages/recipients] Error:", error);
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Failed to load recipients",
      },
      { status: 500 },
    );
  }
}
