import { NextRequest, NextResponse } from "next/server";
import { CORS_HEADERS, verifyCallCenterAuth } from "@/lib/callCenterAuth";
import { agentTransferConversation, loadAgentProfile } from "@/lib/supportChat";

export const runtime = "nodejs";

export async function OPTIONS() {
  return NextResponse.json({}, { headers: CORS_HEADERS });
}

/**
 * POST /api/support-chat/agent/conversations/{conversationId}/transfer
 * Body: `{ "toAgentUid": string }`. Caller must be a `call_center_admin`.
 */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ conversationId: string }> },
) {
  const auth = await verifyCallCenterAuth(req);
  if (!auth.success || !auth.user) {
    return NextResponse.json(
      { error: auth.error },
      { status: auth.status || 401, headers: CORS_HEADERS },
    );
  }
  const { conversationId } = await ctx.params;
  let body: { toAgentUid?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400, headers: CORS_HEADERS },
    );
  }
  const toAgentUid =
    typeof body.toAgentUid === "string" ? body.toAgentUid.trim() : "";
  if (!toAgentUid) {
    return NextResponse.json(
      { error: "toAgentUid is required" },
      { status: 400, headers: CORS_HEADERS },
    );
  }
  try {
    const caller = await loadAgentProfile(auth.user.uid);
    const conversation = await agentTransferConversation({
      caller,
      conversationId,
      toAgentUid,
    });
    return NextResponse.json({ ok: true, conversation }, { headers: CORS_HEADERS });
  } catch (e: unknown) {
    const status = typeof e === "object" && e !== null && "status" in e
      ? Number((e as { status: number }).status)
      : 500;
    const msg = e instanceof Error ? e.message : "Server error";
    return NextResponse.json(
      { error: msg },
      { status: Number.isFinite(status) ? status : 500, headers: CORS_HEADERS },
    );
  }
}
