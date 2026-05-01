import { NextRequest, NextResponse } from "next/server";
import { CORS_HEADERS, verifyCallCenterAuth } from "@/lib/callCenterAuth";
import {
  agentSendMessage,
  loadAgentProfile,
  sanitizeMessage,
} from "@/lib/supportChat";

export const runtime = "nodejs";

export async function OPTIONS() {
  return NextResponse.json({}, { headers: CORS_HEADERS });
}

/**
 * POST /api/support-chat/agent/conversations/{conversationId}/messages
 * Body: `{ "message": string }`
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
  let body: { message?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400, headers: CORS_HEADERS },
    );
  }
  try {
    const text = sanitizeMessage(body.message);
    const agent = await loadAgentProfile(auth.user.uid);
    const out = await agentSendMessage({ agent, conversationId, text });
    return NextResponse.json({ ok: true, ...out }, { headers: CORS_HEADERS });
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
