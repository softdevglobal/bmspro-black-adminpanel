import { NextRequest, NextResponse } from "next/server";
import { verifyAdminAuth } from "@/lib/authHelpers";
import { closeCcDirectSession, getCcRoomOrNull, assertWorkshopUserOwnsRoom } from "@/lib/ccDirectChat";

export const runtime = "nodejs";

const WORKSHOP_CHAT_ROLES = ["workshop_owner", "branch_admin", "staff"] as const;

/**
 * POST /api/chats/cc/rooms/:chatId/close
 *
 * Workshop user ends the current CC direct session (same thread; new messages reopen it).
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ chatId: string }> }) {
  const auth = await verifyAdminAuth(req, [...WORKSHOP_CHAT_ROLES]);
  if (!auth.success || !auth.userData) {
    return NextResponse.json({ error: auth.error }, { status: auth.status || 401 });
  }

  const { chatId } = await ctx.params;
  const room = await getCcRoomOrNull(chatId);
  if (!room) {
    return NextResponse.json({ error: "Chat not found" }, { status: 404 });
  }
  try {
    assertWorkshopUserOwnsRoom(room, auth.userData.uid, auth.userData.ownerUid);
  } catch (e: unknown) {
    const status =
      typeof e === "object" && e !== null && "status" in e ? Number((e as { status: number }).status) : 403;
    return NextResponse.json({ error: e instanceof Error ? e.message : "Forbidden" }, { status });
  }

  try {
    await closeCcDirectSession(chatId, auth.userData.uid);
    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    const status =
      typeof e === "object" && e !== null && "status" in e ? Number((e as { status: number }).status) : 500;
    const msg = e instanceof Error ? e.message : "Server error";
    return NextResponse.json({ error: msg }, { status: Number.isFinite(status) ? status : 500 });
  }
}
