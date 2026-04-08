import { NextRequest, NextResponse } from "next/server";
import { verifyAdminAuth } from "@/lib/authHelpers";
import {
  adminDeleteCallCenterAgent,
  adminUpdateCallCenterAgent,
  canAdminViewAgent,
  serializeCallCenterAgent,
} from "@/lib/callCenterAgentsCrud";
import { CORS_HEADERS } from "@/lib/callCenterAuth";
import { adminDb } from "@/lib/firebaseAdmin";

export const runtime = "nodejs";

export async function OPTIONS() {
  return NextResponse.json({}, { headers: CORS_HEADERS });
}

/**
 * GET /api/call-center/agents/[agentId]
 *
 * Get one agent by Firebase UID (document id).
 */
export async function GET(
  req: NextRequest,
  context: { params: Promise<{ agentId: string }> }
) {
  const gate = await verifyAdminAuth(req, ["super_admin", "workshop_owner"]);
  if (!gate.success || !gate.userData) {
    return NextResponse.json(
      { error: gate.error },
      { status: gate.status || 401, headers: CORS_HEADERS }
    );
  }

  const { agentId } = await context.params;
  const id = String(agentId || "").trim();
  if (!id) {
    return NextResponse.json({ error: "Missing agentId" }, { status: 400, headers: CORS_HEADERS });
  }

  try {
    const doc = await adminDb().doc(`call_center_agents/${id}`).get();
    if (!doc.exists) {
      return NextResponse.json({ error: "Agent not found" }, { status: 404, headers: CORS_HEADERS });
    }
    const data = doc.data()!;
    if (!canAdminViewAgent(gate.userData, data)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403, headers: CORS_HEADERS });
    }
    return NextResponse.json(
      { agent: serializeCallCenterAgent(doc.id, data) },
      { headers: CORS_HEADERS }
    );
  } catch (e: any) {
    console.error("[call-center/agents/[agentId] GET]", e);
    return NextResponse.json(
      { error: e?.message || "Failed to load agent" },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}

/**
 * PATCH /api/call-center/agents/[agentId]
 *
 * Update agent (workshops, suspended, role, name). Same fields as `PATCH /api/call-center/auth`.
 */
export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ agentId: string }> }
) {
  const gate = await verifyAdminAuth(req, ["super_admin", "workshop_owner"]);
  if (!gate.success || !gate.userData) {
    return NextResponse.json(
      { error: gate.error },
      { status: gate.status || 401, headers: CORS_HEADERS }
    );
  }

  const { agentId } = await context.params;
  const id = String(agentId || "").trim();

  try {
    const body = await req.json();
    const result = await adminUpdateCallCenterAgent(id, body, gate.userData);
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error },
        { status: result.status, headers: CORS_HEADERS }
      );
    }
    return NextResponse.json({ success: true, agent: result.agent }, { headers: CORS_HEADERS });
  } catch (e: any) {
    console.error("[call-center/agents/[agentId] PATCH]", e);
    return NextResponse.json(
      { error: e?.message || "Failed to update agent" },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}

/**
 * DELETE /api/call-center/agents/[agentId]
 *
 * Deletes `call_center_agents/{agentId}` and the Firebase Auth user.
 * Workshop owners may delete only agents assigned **solely** to their workshop.
 */
export async function DELETE(
  req: NextRequest,
  context: { params: Promise<{ agentId: string }> }
) {
  const gate = await verifyAdminAuth(req, ["super_admin", "workshop_owner"]);
  if (!gate.success || !gate.userData) {
    return NextResponse.json(
      { error: gate.error },
      { status: gate.status || 401, headers: CORS_HEADERS }
    );
  }

  const { agentId } = await context.params;
  const id = String(agentId || "").trim();

  try {
    const result = await adminDeleteCallCenterAgent(id, gate.userData);
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error },
        { status: result.status, headers: CORS_HEADERS }
      );
    }
    return NextResponse.json(
      {
        success: true,
        deleted: id,
        ...(result.warning ? { warning: result.warning } : {}),
      },
      { headers: CORS_HEADERS }
    );
  } catch (e: any) {
    console.error("[call-center/agents/[agentId] DELETE]", e);
    return NextResponse.json(
      { error: e?.message || "Failed to delete agent" },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
