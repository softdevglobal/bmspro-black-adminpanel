import { NextRequest, NextResponse } from "next/server";
import {
  verifyCallCenterOrTenantAdminAuth,
  isParticipantInCcDirectChatRoom,
  callCenterRequesterUid,
  CORS_HEADERS,
} from "@/lib/callCenterAuth";
import { closeCcDirectSession, getCcRoomOrNull } from "@/lib/ccDirectChat";

export const runtime = "nodejs";

export async function OPTIONS() {
  return NextResponse.json({}, { headers: CORS_HEADERS });
}

/**
 * POST /api/call-center/chats/:chatId/close
 *
 * Ends the current session on this thread (same doc + history). Agent or workshop participant;
 * `call_center_admin` may close any assigned thread.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ chatId: string }> }) {
  const gate = await verifyCallCenterOrTenantAdminAuth(req);
  if (!gate.success) {
    return NextResponse.json(
      { error: gate.error },
      { status: gate.status || 401, headers: CORS_HEADERS }
    );
  }

  const { chatId } = await ctx.params;
  const room = await getCcRoomOrNull(chatId);
  if (!room) {
    return NextResponse.json({ error: "Chat not found" }, { status: 404, headers: CORS_HEADERS });
  }

  const requesterUid = callCenterRequesterUid(gate.auth);
  const isCcAdmin = gate.auth.kind === "agent" && gate.auth.user.isCCAdmin;
  if (!isCcAdmin && !isParticipantInCcDirectChatRoom(room, requesterUid)) {
    return NextResponse.json(
      { error: "Only a thread participant or call center admin can end this chat" },
      { status: 403, headers: CORS_HEADERS }
    );
  }

  try {
    await closeCcDirectSession(chatId, requesterUid, { isCallCenterAdmin: isCcAdmin });
    return NextResponse.json({ ok: true }, { headers: CORS_HEADERS });
  } catch (e: unknown) {
    const status =
      typeof e === "object" && e !== null && "status" in e ? Number((e as { status: number }).status) : 500;
    const msg = e instanceof Error ? e.message : "Server error";
    return NextResponse.json(
      { error: msg },
      { status: Number.isFinite(status) ? status : 500, headers: CORS_HEADERS }
    );
  }
}
