import { NextRequest, NextResponse } from "next/server";
import {
  verifyCallCenterOrTenantAdminAuth,
  canAccessCcDirectChatRoom,
  callCenterRequesterUid,
  CORS_HEADERS,
} from "@/lib/callCenterAuth";
import {
  getCcRoomOrNull,
  serializeCcRoom,
  attachDetailsToCcChats,
} from "@/lib/ccDirectChat";

export const runtime = "nodejs";

export async function OPTIONS() {
  return NextResponse.json({}, { headers: CORS_HEADERS });
}

/** GET /api/call-center/chats/[chatId] */
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ chatId: string }> }
) {
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
  if (!canAccessCcDirectChatRoom(gate.auth, room, requesterUid)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403, headers: CORS_HEADERS });
  }

  const [chat] = await attachDetailsToCcChats([serializeCcRoom(chatId, room)], { includeWorkshopUser: true });
  return NextResponse.json({ chat }, { headers: CORS_HEADERS });
}
