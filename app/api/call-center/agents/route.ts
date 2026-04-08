import { NextRequest, NextResponse } from "next/server";
import { verifyAdminAuth } from "@/lib/authHelpers";
import {
  adminCreateCallCenterAgent,
  listCallCenterAgentsForAdmin,
} from "@/lib/callCenterAgentsCrud";
import { CORS_HEADERS } from "@/lib/callCenterAuth";

export const runtime = "nodejs";

export async function OPTIONS() {
  return NextResponse.json({}, { headers: CORS_HEADERS });
}

/**
 * GET /api/call-center/agents
 *
 * List call center agents. **Super admin**: all agents. **Workshop owner**: agents with
 * `assignedWorkshops` containing their `ownerUid`.
 *
 * Auth: BMS admin (super_admin or workshop_owner).
 */
export async function GET(req: NextRequest) {
  const gate = await verifyAdminAuth(req, ["super_admin", "workshop_owner"]);
  if (!gate.success || !gate.userData) {
    return NextResponse.json(
      { error: gate.error },
      { status: gate.status || 401, headers: CORS_HEADERS }
    );
  }

  try {
    const agents = await listCallCenterAgentsForAdmin(gate.userData);
    return NextResponse.json({ agents, count: agents.length }, { headers: CORS_HEADERS });
  } catch (e: any) {
    console.error("[call-center/agents GET]", e);
    return NextResponse.json(
      { error: e?.message || "Failed to list agents" },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}

/**
 * POST /api/call-center/agents
 *
 * Create a call center agent (Firebase Auth user + `call_center_agents/{uid}`).
 * Same body as `POST /api/call-center/auth`.
 *
 * Body: { email, password, name, role?, assignedWorkshops? }
 */
export async function POST(req: NextRequest) {
  const gate = await verifyAdminAuth(req, ["super_admin", "workshop_owner"]);
  if (!gate.success || !gate.userData) {
    return NextResponse.json(
      { error: gate.error },
      { status: gate.status || 401, headers: CORS_HEADERS }
    );
  }

  try {
    const body = await req.json();
    const result = await adminCreateCallCenterAgent(body, gate.userData);
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error },
        { status: result.status, headers: CORS_HEADERS }
      );
    }
    return NextResponse.json(
      { success: true, agent: result.agent },
      { status: 201, headers: CORS_HEADERS }
    );
  } catch (e: any) {
    console.error("[call-center/agents POST]", e);
    return NextResponse.json(
      { error: e?.message || "Failed to create agent" },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
