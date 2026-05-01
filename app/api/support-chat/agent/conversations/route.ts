import { NextRequest, NextResponse } from "next/server";
import { CORS_HEADERS, verifyCallCenterAuth } from "@/lib/callCenterAuth";
import {
  listSupportAgentConversationBuckets,
  loadAgentProfile,
  supportConversationToJson,
} from "@/lib/supportChat";

export const runtime = "nodejs";

export async function OPTIONS() {
  return NextResponse.json({}, { headers: CORS_HEADERS });
}

/**
 * GET /api/support-chat/agent/conversations
 * Query: queueLimit (default 30), mineLimit (default 30)
 *
 * - `queue`: status=waiting — only threads in your workshop scope (assignedWorkshops; empty ⇒ all workshops).
 * - `mine`: assigned to your agent UID (claimed / closed history).
 *
 * After another agent claims a chat, it drops out of everyone's queue here and appears only under that agent's `mine`.
 */
export async function GET(req: NextRequest) {
  const auth = await verifyCallCenterAuth(req);
  if (!auth.success || !auth.user) {
    return NextResponse.json(
      { error: auth.error },
      { status: auth.status || 401, headers: CORS_HEADERS },
    );
  }

  try {
    await loadAgentProfile(auth.user.uid);
  } catch (e: unknown) {
    const status =
      typeof e === "object" && e !== null && "status" in e ? Number((e as { status: number }).status) : 403;
    const msg = e instanceof Error ? e.message : "Forbidden";
    return NextResponse.json(
      { error: msg },
      { status: Number.isFinite(status) ? status : 403, headers: CORS_HEADERS },
    );
  }

  const queueLimitRaw = req.nextUrl.searchParams.get("queueLimit");
  const mineLimitRaw = req.nextUrl.searchParams.get("mineLimit");
  const queueLimit = queueLimitRaw ? parseInt(queueLimitRaw, 10) : 30;
  const mineLimit = mineLimitRaw ? parseInt(mineLimitRaw, 10) : 30;

  try {
    const { queue, mine } = await listSupportAgentConversationBuckets({
      agentUid: auth.user.uid,
      isCCAdmin: auth.user.isCCAdmin,
      assignedWorkshops: auth.user.assignedWorkshops,
      queueLimit: Number.isFinite(queueLimit) ? queueLimit : 30,
      mineLimit: Number.isFinite(mineLimit) ? mineLimit : 30,
    });

    return NextResponse.json(
      {
        queue: queue.map((c) => supportConversationToJson(c)),
        mine: mine.map((c) => supportConversationToJson(c)),
      },
      { headers: CORS_HEADERS },
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Server error";
    return NextResponse.json(
      { error: msg },
      { status: 500, headers: CORS_HEADERS },
    );
  }
}
