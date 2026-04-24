import { NextRequest, NextResponse } from "next/server";
import { verifyAdminAuth } from "@/lib/authHelpers";
import {
  ensureCcDirectChat,
  listCcChatsForTenantUser,
  serializeCcRoom,
  getCcRoomOrNull,
  assertWorkshopUserOwnsRoom,
} from "@/lib/ccDirectChat";

export const runtime = "nodejs";

const WORKSHOP_CHAT_ROLES = ["workshop_owner", "branch_admin", "staff"] as const;

export async function GET(req: NextRequest) {
  const auth = await verifyAdminAuth(req, [...WORKSHOP_CHAT_ROLES]);
  if (!auth.success || !auth.userData) {
    return NextResponse.json({ error: auth.error }, { status: auth.status || 401 });
  }

  const limitRaw = req.nextUrl.searchParams.get("limit");
  const limit = limitRaw ? parseInt(limitRaw, 10) : 50;
  try {
    const rooms = await listCcChatsForTenantUser(auth.userData.uid, Number.isFinite(limit) ? limit : 50);
    return NextResponse.json({ chats: rooms });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Server error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await verifyAdminAuth(req, [...WORKSHOP_CHAT_ROLES]);
  if (!auth.success || !auth.userData) {
    return NextResponse.json({ error: auth.error }, { status: auth.status || 401 });
  }

  let body: { agentUid?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const agentUid = typeof body.agentUid === "string" ? body.agentUid.trim() : "";
  if (!agentUid) {
    return NextResponse.json({ error: "agentUid is required" }, { status: 400 });
  }

  try {
    const { chatId, created } = await ensureCcDirectChat({
      workshopOwnerUid: auth.userData.ownerUid,
      tenantUserUid: auth.userData.uid,
      tenantRole: auth.userData.role,
      agentUid,
    });
    const room = await getCcRoomOrNull(chatId);
    if (!room) {
      return NextResponse.json({ error: "Failed to load chat" }, { status: 500 });
    }
    assertWorkshopUserOwnsRoom(room, auth.userData.uid, auth.userData.ownerUid);
    return NextResponse.json({ chat: serializeCcRoom(chatId, room), created });
  } catch (e: unknown) {
    const status = typeof e === "object" && e !== null && "status" in e ? Number((e as { status: number }).status) : 500;
    const msg = e instanceof Error ? e.message : "Server error";
    return NextResponse.json({ error: msg }, { status: Number.isFinite(status) ? status : 500 });
  }
}
