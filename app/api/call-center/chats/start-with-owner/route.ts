import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";
import { canAccessWorkshop, CORS_HEADERS, verifyCallCenterAuth } from "@/lib/callCenterAuth";
import {
  appendCcDirectMessage,
  attachDetailsToCcChats,
  ensureCcDirectChat,
  getCcRoomOrNull,
  serializeCcRoom,
} from "@/lib/ccDirectChat";

export const runtime = "nodejs";

export async function OPTIONS() {
  return NextResponse.json({}, { headers: CORS_HEADERS });
}

/**
 * POST /api/call-center/chats/start-with-owner
 *
 * Call center agent opens or reuses the deterministic 1:1 thread with the **workshop owner**
 * (tenant user = owner uid). Optional first message triggers FCM like any other agent message.
 *
 * Body: `{ "workshopOwnerUid": string, "text"?: string }`
 */
export async function POST(req: NextRequest) {
  const auth = await verifyCallCenterAuth(req);
  if (!auth.success || !auth.user) {
    return NextResponse.json(
      { error: auth.error },
      { status: auth.status || 401, headers: CORS_HEADERS }
    );
  }

  let body: { workshopOwnerUid?: unknown; text?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400, headers: CORS_HEADERS });
  }

  const workshopOwnerUid =
    typeof body.workshopOwnerUid === "string" ? body.workshopOwnerUid.trim() : "";
  const text = typeof body.text === "string" ? body.text : "";

  if (!workshopOwnerUid) {
    return NextResponse.json(
      { error: "workshopOwnerUid is required" },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  if (!canAccessWorkshop(auth.user, workshopOwnerUid)) {
    return NextResponse.json(
      { error: "You do not have access to this workshop" },
      { status: 403, headers: CORS_HEADERS }
    );
  }

  const ownerSnap = await adminDb().doc(`users/${workshopOwnerUid}`).get();
  if (!ownerSnap.exists) {
    return NextResponse.json({ error: "Workshop owner not found" }, { status: 404, headers: CORS_HEADERS });
  }
  const od = ownerSnap.data()!;
  const role = String(od.role || od.systemRole || "").toLowerCase();
  if (role !== "workshop_owner") {
    return NextResponse.json(
      { error: "UID is not a workshop_owner account" },
      { status: 400, headers: CORS_HEADERS }
    );
  }
  const acct = String(od.accountStatus || od.status || "").toLowerCase();
  if (acct === "suspended" || acct === "inactive") {
    return NextResponse.json(
      { error: "This workshop account is not active" },
      { status: 403, headers: CORS_HEADERS }
    );
  }

  try {
    const { chatId, created } = await ensureCcDirectChat({
      workshopOwnerUid,
      tenantUserUid: workshopOwnerUid,
      tenantRole: "workshop_owner",
      agentUid: auth.user.uid,
    });

    let messageId: string | undefined;
    if (text.trim()) {
      const sent = await appendCcDirectMessage({
        chatId,
        senderUid: auth.user.uid,
        senderRole: auth.user.role,
        text,
      });
      messageId = sent.messageId;
    }

    const room = await getCcRoomOrNull(chatId);
    if (!room) {
      return NextResponse.json({ error: "Failed to load chat" }, { status: 500, headers: CORS_HEADERS });
    }

    const [chat] = await attachDetailsToCcChats([serializeCcRoom(chatId, room)], {
      includeWorkshopUser: true,
    });

    return NextResponse.json({ chat, created, messageId }, { headers: CORS_HEADERS });
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
