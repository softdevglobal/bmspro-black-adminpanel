import { NextRequest, NextResponse } from "next/server";
import { verifyCallCenterAuth, CORS_HEADERS, canAccessWorkshop } from "@/lib/callCenterAuth";
import { getCcRoomOrNull, serializeCcRoom, assertRoomParticipant } from "@/lib/ccDirectChat";

export const runtime = "nodejs";

export async function OPTIONS() {
  return NextResponse.json({}, { headers: CORS_HEADERS });
}

/** GET /api/call-center/chats/[chatId] */
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ chatId: string }> }
) {
  const gate = await verifyCallCenterAuth(req);
  if (!gate.success || !gate.user) {
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
  try {
    assertRoomParticipant(room, gate.user.uid);
  } catch {
    return NextResponse.json({ error: "Forbidden" }, { status: 403, headers: CORS_HEADERS });
  }

  if (!canAccessWorkshop(gate.user, String(room.workshopOwnerUid || ""))) {
    return NextResponse.json(
      { error: "Agent is not assigned to this workshop" },
      { status: 403, headers: CORS_HEADERS }
    );
  }

  return NextResponse.json({ chat: serializeCcRoom(chatId, room) }, { headers: CORS_HEADERS });
}
