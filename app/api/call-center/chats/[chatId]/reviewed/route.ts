import { NextRequest, NextResponse } from "next/server";
import { verifyCallCenterAuth, CORS_HEADERS } from "@/lib/callCenterAuth";
import { getCcRoomOrNull, setCcChatsReviewed, attachDetailsToCcChats, serializeCcRoom } from "@/lib/ccDirectChat";

export const runtime = "nodejs";

export async function OPTIONS() {
  return NextResponse.json({}, { headers: CORS_HEADERS });
}

/**
 * PATCH /api/call-center/chats/[chatId]/reviewed
 * Body: `{ "chatsReviewed": true | false }` — any call center agent who is a participant may update.
 */
export async function PATCH(
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

  let body: { chatsReviewed?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400, headers: CORS_HEADERS });
  }
  const reviewed = body.chatsReviewed === true;

  try {
    await setCcChatsReviewed(chatId, gate.user.uid, reviewed, {
      isCallCenterAdmin: gate.user.isCCAdmin === true,
    });
    const fresh = await getCcRoomOrNull(chatId);
    if (!fresh) {
      return NextResponse.json({ error: "Chat not found" }, { status: 404, headers: CORS_HEADERS });
    }
    const [chat] = await attachDetailsToCcChats([serializeCcRoom(chatId, fresh)], { includeWorkshopUser: true });
    return NextResponse.json({ chat }, { headers: CORS_HEADERS });
  } catch (e: unknown) {
    const status =
      typeof e === "object" && e !== null && "status" in e ? Number((e as { status: number }).status) : 500;
    const msg = e instanceof Error ? e.message : "Server error";
    if (msg === "Forbidden" || status === 403) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403, headers: CORS_HEADERS });
    }
    return NextResponse.json(
      { error: msg },
      { status: Number.isFinite(status) ? status : 500, headers: CORS_HEADERS }
    );
  }
}
