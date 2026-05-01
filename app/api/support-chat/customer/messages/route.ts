import { NextRequest, NextResponse } from "next/server";
import { adminAuth } from "@/lib/firebaseAdmin";
import { CORS_HEADERS } from "@/lib/callCenterAuth";
import {
  getFirebaseIdTokenFromRequest,
  missingFirebaseTokenMessage,
} from "@/lib/authHelpers";
import {
  customerSendMessage,
  loadCustomerProfile,
  sanitizeMessage,
} from "@/lib/supportChat";

export const runtime = "nodejs";

export async function OPTIONS() {
  return NextResponse.json({}, { headers: CORS_HEADERS });
}

/**
 * POST /api/support-chat/customer/messages
 * Body: `{ "message": string }`
 *
 * Creates a new `waiting` conversation if the user has none active (latest is `closed` or
 * doesn't exist), otherwise appends to the existing one. Returns `{ conversationId, messageId,
 * created }` so the mobile UI can immediately attach its messages listener.
 */
export async function POST(req: NextRequest) {
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

  let body: { message?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400, headers: CORS_HEADERS },
    );
  }

  try {
    const text = sanitizeMessage(body.message);
    const customer = await loadCustomerProfile(uid);
    const out = await customerSendMessage({ customer, text });
    return NextResponse.json(out, { headers: CORS_HEADERS });
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
