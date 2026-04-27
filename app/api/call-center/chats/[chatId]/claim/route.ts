import { NextRequest, NextResponse } from "next/server";
import { verifyCallCenterAuth, CORS_HEADERS } from "@/lib/callCenterAuth";
import { claimCcQueueChat } from "@/lib/ccDirectChat";

export const runtime = "nodejs";

export async function OPTIONS() {
  return NextResponse.json({}, { headers: CORS_HEADERS });
}

/**
 * POST /api/call-center/chats/[chatId]/claim
 * Call center agent claims an unassigned queue thread; becomes the peer for 1:1 chat.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ chatId: string }> }) {
  const auth = await verifyCallCenterAuth(req);
  if (!auth.success || !auth.user) {
    return NextResponse.json(
      { error: auth.error || "Unauthorized" },
      { status: auth.status || 401, headers: CORS_HEADERS }
    );
  }

  const { chatId } = await ctx.params;
  const agentUid = auth.user.uid;

  const canAccessWorkshop = (workshopOwnerUid: string) => {
    if (auth.user!.isCCAdmin) return true;
    return auth.user!.assignedWorkshops.map((x) => x.trim()).includes(workshopOwnerUid.trim());
  };

  try {
    await claimCcQueueChat(chatId, agentUid, canAccessWorkshop);
    return NextResponse.json({ ok: true, chatId }, { headers: CORS_HEADERS });
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
