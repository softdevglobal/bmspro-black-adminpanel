import { NextRequest, NextResponse } from "next/server";
import { verifyCallCenterAuth, CORS_HEADERS } from "@/lib/callCenterAuth";
import { getCcRoomOrNull, markCcDirectChatRead, assertRoomParticipant } from "@/lib/ccDirectChat";

export const runtime = "nodejs";

export async function OPTIONS() {
  return NextResponse.json({}, { headers: CORS_HEADERS });
}

export async function POST(
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

  try {
    const out = await markCcDirectChatRead(chatId, gate.user.uid);
    return NextResponse.json(out, { headers: CORS_HEADERS });
  } catch (e: unknown) {
    const status = typeof e === "object" && e !== null && "status" in e ? Number((e as { status: number }).status) : 500;
    const msg = e instanceof Error ? e.message : "Server error";
    return NextResponse.json(
      { error: msg },
      { status: Number.isFinite(status) ? status : 500, headers: CORS_HEADERS }
    );
  }
}
