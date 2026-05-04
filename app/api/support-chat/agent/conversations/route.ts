import { NextRequest, NextResponse } from "next/server";
import {
  CORS_HEADERS,
  verifyCallCenterAgentOrSuperAdmin,
} from "@/lib/callCenterAuth";
import {
  listSupportAgentConversationBuckets,
  listSupportSuperAdminBuckets,
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
 * **super_admin**: same Bearer token as BMS super admin (`super_admins/{uid}` or `users/` role `super_admin`).
 * `queue`/`mine` aggregate all workshops (`mine` = recent non-waiting threads for oversight).
 *
 * After another agent claims a chat, it drops out of everyone's queue here and appears only under that agent's `mine`.
 */
export async function GET(req: NextRequest) {
  const viewerGate = await verifyCallCenterAgentOrSuperAdmin(req);
  if (!viewerGate.ok) {
    return NextResponse.json(
      { error: viewerGate.error },
      { status: viewerGate.status, headers: CORS_HEADERS },
    );
  }

  const queueLimitRaw = req.nextUrl.searchParams.get("queueLimit");
  const mineLimitRaw = req.nextUrl.searchParams.get("mineLimit");
  const queueLimit = queueLimitRaw ? parseInt(queueLimitRaw, 10) : 30;
  const mineLimit = mineLimitRaw ? parseInt(mineLimitRaw, 10) : 30;
  const ql = Number.isFinite(queueLimit) ? queueLimit : 30;
  const ml = Number.isFinite(mineLimit) ? mineLimit : 30;

  try {
    if (viewerGate.viewer.kind === "super_admin") {
      const { queue, mine } = await listSupportSuperAdminBuckets({
        queueLimit: ql,
        mineLimit: ml,
      });

      return NextResponse.json(
        {
          queue: queue.map((c) => supportConversationToJson(c)),
          mine: mine.map((c) => supportConversationToJson(c)),
        },
        { headers: CORS_HEADERS },
      );
    }

    await loadAgentProfile(viewerGate.viewer.user.uid);
    const { queue, mine } = await listSupportAgentConversationBuckets({
      agentUid: viewerGate.viewer.user.uid,
      isCCAdmin: viewerGate.viewer.user.isCCAdmin,
      assignedWorkshops: viewerGate.viewer.user.assignedWorkshops,
      queueLimit: ql,
      mineLimit: ml,
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
    const status =
      typeof e === "object" && e !== null && "status" in e ? Number((e as { status: number }).status) : undefined;
    return NextResponse.json(
      { error: msg },
      { status: Number.isFinite(status) ? Number(status) : 500, headers: CORS_HEADERS },
    );
  }
}
