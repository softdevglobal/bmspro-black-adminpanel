import { NextRequest, NextResponse } from "next/server";
import { adminAuth } from "@/lib/firebaseAdmin";
import { CORS_HEADERS } from "@/lib/callCenterAuth";
import {
  getFirebaseIdTokenFromRequest,
  missingFirebaseTokenMessage,
} from "@/lib/authHelpers";
import { loadCustomerProfile, markReadByCustomer } from "@/lib/supportChat";

export const runtime = "nodejs";

export async function OPTIONS() {
  return NextResponse.json({}, { headers: CORS_HEADERS });
}

/** POST /api/support-chat/customer/conversations/{conversationId}/read */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ conversationId: string }> },
) {
  const idToken = getFirebaseIdTokenFromRequest(req);
  if (!idToken) {
    return NextResponse.json(
      { error: missingFirebaseTokenMessage() },
      { status: 401, headers: CORS_HEADERS },
    );
  }

  let uid: string;
  try {
    const decoded = await adminAuth().verifyIdToken(idToken);
    uid = decoded.uid;
  } catch {
    return NextResponse.json(
      { error: "Invalid or expired token" },
      { status: 401, headers: CORS_HEADERS },
    );
  }

  const { conversationId } = await ctx.params;
  try {
    const customer = await loadCustomerProfile(uid);
    await markReadByCustomer({ customer, conversationId });
    return NextResponse.json({ ok: true }, { headers: CORS_HEADERS });
  } catch (e: unknown) {
    const status = typeof e === "object" && e !== null && "status" in e
      ? Number((e as { status: number }).status)
      : 500;
    const msg = e instanceof Error ? e.message : "Server error";
    return NextResponse.json(
      { error: msg },
      { status: Number.isFinite(status) ? status : 500, headers: CORS_HEADERS },
    );
  }
}
