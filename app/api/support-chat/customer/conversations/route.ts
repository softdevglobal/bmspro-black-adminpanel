import { NextRequest, NextResponse } from "next/server";
import { adminAuth } from "@/lib/firebaseAdmin";
import { CORS_HEADERS } from "@/lib/callCenterAuth";
import {
  getFirebaseIdTokenFromRequest,
  missingFirebaseTokenMessage,
} from "@/lib/authHelpers";
import {
  findLatestConversationForUser,
  loadCustomerProfile,
} from "@/lib/supportChat";

export const runtime = "nodejs";

export async function OPTIONS() {
  return NextResponse.json({}, { headers: CORS_HEADERS });
}

/**
 * GET /api/support-chat/customer/conversations
 * Returns the most recent conversation for the calling user (or `null`). Mobile app uses this
 * once on chat-screen open; subsequent updates come from the Firestore listener.
 */
export async function GET(req: NextRequest) {
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

  try {
    await loadCustomerProfile(uid); // throws on suspended / missing
    const convo = await findLatestConversationForUser(uid);
    return NextResponse.json(
      { conversation: convo },
      { headers: CORS_HEADERS },
    );
  } catch (e: unknown) {
    return errorResponse(e);
  }
}

function errorResponse(e: unknown) {
  const status = typeof e === "object" && e !== null && "status" in e
    ? Number((e as { status: number }).status)
    : 500;
  const msg = e instanceof Error ? e.message : "Server error";
  return NextResponse.json(
    { error: msg },
    { status: Number.isFinite(status) ? status : 500, headers: CORS_HEADERS },
  );
}
