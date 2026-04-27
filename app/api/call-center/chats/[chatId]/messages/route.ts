import { NextRequest, NextResponse } from "next/server";
import {
  verifyCallCenterOrTenantAdminAuth,
  canAccessCcDirectChatRoom,
  isParticipantInCcDirectChatRoom,
  callCenterRequesterUid,
  CORS_HEADERS,
} from "@/lib/callCenterAuth";
import {
  appendCcDirectMessage,
  getCcRoomOrNull,
  listCcMessages,
} from "@/lib/ccDirectChat";

export const runtime = "nodejs";

export async function OPTIONS() {
  return NextResponse.json({}, { headers: CORS_HEADERS });
}

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

  const preenacted = !isParticipantInCcDirectChatRoom(room, requesterUid);

  const limitRaw = req.nextUrl.searchParams.get("limit");
  const before = req.nextUrl.searchParams.get("before")?.trim() || null;
  const limit = limitRaw ? parseInt(limitRaw, 10) : 40;

  const result = await listCcMessages(
    chatId,
    requesterUid,
    Number.isFinite(limit) ? limit : 40,
    before,
    preenacted ? { roomReadGatePreenacted: true } : undefined
  );
  if (!result) {
    return NextResponse.json({ error: "Chat not found" }, { status: 404, headers: CORS_HEADERS });
  }
  return NextResponse.json({ messages: result.messages }, { headers: CORS_HEADERS });
}

export async function POST(
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
  if (!isParticipantInCcDirectChatRoom(room, requesterUid)) {
    return NextResponse.json(
      { error: "Only the assigned agent or workshop user can post in this thread" },
      { status: 403, headers: CORS_HEADERS }
    );
  }

  let body: { text?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400, headers: CORS_HEADERS });
  }
  const text = typeof body.text === "string" ? body.text : "";
  const senderRole =
    gate.auth.kind === "agent"
      ? String(gate.auth.user.role || "agent")
      : String(gate.auth.role || "workshop");

  try {
    const out = await appendCcDirectMessage({
      chatId,
      senderUid: requesterUid,
      senderRole,
      text,
    });
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
