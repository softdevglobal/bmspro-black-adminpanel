import { NextRequest, NextResponse } from "next/server";
import { verifyAdminAuth } from "@/lib/authHelpers";
import {
  ensureCcDirectChat,
  ensureCcQueueRequest,
  listCcChatsForTenantUser,
  serializeCcRoom,
  getCcRoomOrNull,
  assertWorkshopUserOwnsRoom,
  attachDetailsToCcChats,
} from "@/lib/ccDirectChat";
import { reopenClosedSupportConversationForUserAgentPair } from "@/lib/supportChat";

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

  let body: { agentUid?: string; queue?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const agentUid = typeof body.agentUid === "string" ? body.agentUid.trim() : "";
  const useQueue = body.queue === true || (!agentUid && body.queue !== false);

  if (!agentUid && !useQueue) {
    return NextResponse.json(
      { error: "Send { queue: true } for the shared queue, or { agentUid } to message a specific agent." },
      { status: 400 }
    );
  }

  try {
    const { chatId, created } = useQueue
      ? await ensureCcQueueRequest({
          workshopOwnerUid: auth.userData.ownerUid,
          tenantUserUid: auth.userData.uid,
          tenantRole: auth.userData.role,
        })
      : await ensureCcDirectChat({
          workshopOwnerUid: auth.userData.ownerUid,
          tenantUserUid: auth.userData.uid,
          tenantRole: auth.userData.role,
          agentUid: agentUid!,
        });

    const isWorkshopOwner =
      auth.userData.role === "workshop_owner" && auth.userData.uid === auth.userData.ownerUid;
    let supportConversationId: string | null = null;
    let supportConversationReopened = false;
    if (!useQueue && isWorkshopOwner) {
      const reopen = await reopenClosedSupportConversationForUserAgentPair({
        userId: auth.userData.uid,
        agentId: agentUid!,
      });
      supportConversationId = reopen.conversationId;
      supportConversationReopened = reopen.reopened;
    }

    const room = await getCcRoomOrNull(chatId);
    if (!room) {
      return NextResponse.json({ error: "Failed to load chat" }, { status: 500 });
    }
    assertWorkshopUserOwnsRoom(room, auth.userData.uid, auth.userData.ownerUid);
    const [chat] = await attachDetailsToCcChats([serializeCcRoom(chatId, room)], { includeWorkshopUser: false });
    return NextResponse.json({
      chat,
      created,
      ...(supportConversationId != null
        ? {
            supportConversationId,
            supportConversationReopened,
          }
        : {}),
    });
  } catch (e: unknown) {
    const status = typeof e === "object" && e !== null && "status" in e ? Number((e as { status: number }).status) : 500;
    const msg = e instanceof Error ? e.message : "Server error";
    return NextResponse.json({ error: msg }, { status: Number.isFinite(status) ? status : 500 });
  }
}
