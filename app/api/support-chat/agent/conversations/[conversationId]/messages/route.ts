import { NextRequest, NextResponse } from "next/server";
import {
  CORS_HEADERS,
  verifyCallCenterAgentOrSuperAdmin,
  verifyCallCenterAuth,
} from "@/lib/callCenterAuth";
import {
  agentSendMessage,
  listSupportMessagesForAgent,
  loadAgentProfile,
  sanitizeMessage,
} from "@/lib/supportChat";

export const runtime = "nodejs";

export async function OPTIONS() {
  return NextResponse.json({}, { headers: CORS_HEADERS });
}

/**
 * GET /api/support-chat/agent/conversations/{conversationId}/messages?limit=40&before=<messageId>
 * Newest-first; `before` returns older messages after that cursor.
 *
 * **`super_admin`:** same Bearer as BMS super admin — full read across all support threads (oversight).
 */
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ conversationId: string }> },
) {
  const viewerGate = await verifyCallCenterAgentOrSuperAdmin(req);
  if (!viewerGate.ok) {
    return NextResponse.json(
      { error: viewerGate.error },
      { status: viewerGate.status, headers: CORS_HEADERS },
    );
  }
  const { conversationId } = await ctx.params;

  try {
    if (viewerGate.viewer.kind === "agent") {
      await loadAgentProfile(viewerGate.viewer.user.uid);
    }
  } catch (e: unknown) {
    const status =
      typeof e === "object" && e !== null && "status" in e ? Number((e as { status: number }).status) : 403;
    const msg = e instanceof Error ? e.message : "Forbidden";
    return NextResponse.json(
      { error: msg },
      { status: Number.isFinite(status) ? status : 403, headers: CORS_HEADERS },
    );
  }

  const limitRaw = req.nextUrl.searchParams.get("limit");
  const before = req.nextUrl.searchParams.get("before")?.trim() || null;
  const limit = limitRaw ? parseInt(limitRaw, 10) : 40;
  const viewerIsSuperAdmin = viewerGate.viewer.kind === "super_admin";
  const agentUid =
    viewerGate.viewer.kind === "super_admin"
      ? viewerGate.viewer.uid
      : viewerGate.viewer.user.uid;
  const isCCAdmin =
    viewerGate.viewer.kind === "super_admin" ? false : viewerGate.viewer.user.isCCAdmin;
  const assignedWorkshops =
    viewerGate.viewer.kind === "super_admin" ? [] : viewerGate.viewer.user.assignedWorkshops;

  try {
    const out = await listSupportMessagesForAgent({
      conversationId,
      agentUid,
      isCCAdmin,
      assignedWorkshops,
      viewerIsSuperAdmin,
      limit: Number.isFinite(limit) ? limit : 40,
      beforeMessageId: before,
    });
    return NextResponse.json(
      { messages: out.messages, nextBefore: out.nextBefore },
      { headers: CORS_HEADERS },
    );
  } catch (e: unknown) {
    const status =
      typeof e === "object" && e !== null && "status" in e ? Number((e as { status: number }).status) : 500;
    const msg = e instanceof Error ? e.message : "Server error";
    return NextResponse.json(
      { error: msg },
      { status: Number.isFinite(status) ? status : 500, headers: CORS_HEADERS },
    );
  }
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
