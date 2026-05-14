import { NextRequest, NextResponse } from "next/server";
import { CORS_HEADERS, verifyCallCenterAuth } from "@/lib/callCenterAuth";
import { agentCloseConversation, loadAgentProfile } from "@/lib/supportChat";

export const runtime = "nodejs";

export async function OPTIONS() {
  return NextResponse.json({}, { headers: CORS_HEADERS });
}

/**
 * POST /api/support-chat/agent/conversations/{conversationId}/close
 * Body (optional): `{ "farewellMessage"?: string }`
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
  let body: { farewellMessage?: unknown } = {};
  try {
    body = (await req.json()) || {};
  } catch {
    body = {};
  }
  const farewellMessage =
    typeof body.farewellMessage === "string" ? body.farewellMessage : undefined;
  try {
    const agent = await loadAgentProfile(auth.user.uid);
    const conversation = await agentCloseConversation({
      agent,
      conversationId,
      farewellMessage,
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
