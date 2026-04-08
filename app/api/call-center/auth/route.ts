import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";
import { verifyAdminAuth } from "@/lib/authHelpers";
import {
  adminCreateCallCenterAgent,
  adminUpdateCallCenterAgent,
} from "@/lib/callCenterAgentsCrud";
import {
  verifyCallCenterAuth,
  CORS_HEADERS,
} from "@/lib/callCenterAuth";

export const runtime = "nodejs";

export async function OPTIONS() {
  return NextResponse.json({}, { headers: CORS_HEADERS });
}

/**
 * GET /api/call-center/auth
 *
 * Get current agent profile. Used by the dashboard on login.
 * Returns agent info and list of assigned workshops.
 */
export async function GET(req: NextRequest) {
  const auth = await verifyCallCenterAuth(req);
  if (!auth.success || !auth.user) {
    return NextResponse.json(
      { error: auth.error },
      { status: auth.status || 401, headers: CORS_HEADERS }
    );
  }

  const user = auth.user;

  try {
    const db = adminDb();

    // Enrich with workshop names
    const workshopNames: Record<string, string> = {};
    if (user.assignedWorkshops.length > 0) {
      const batches: string[][] = [];
      for (let i = 0; i < user.assignedWorkshops.length; i += 30) {
        batches.push(user.assignedWorkshops.slice(i, i + 30));
      }
      for (const batch of batches) {
        const snap = await db
          .collection("users")
          .where("__name__", "in", batch)
          .get();
        for (const doc of snap.docs) {
          workshopNames[doc.id] = doc.data().name || doc.data().displayName || "";
        }
      }
    }

    return NextResponse.json(
      {
        agent: {
          uid: user.uid,
          agent_id: user.uid,
          email: user.email,
          name: user.name,
          role: user.role,
          isCCAdmin: user.isCCAdmin,
          assignedWorkshops: user.assignedWorkshops.map((id) => ({
            ownerUid: id,
            name: workshopNames[id] || "",
          })),
        },
      },
      { headers: CORS_HEADERS }
    );
  } catch (error: any) {
    console.error("[call-center/auth GET] Error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}

/**
 * POST /api/call-center/auth
 *
 * Register a new call center agent.
 * Only super_admins or workshop_owners can create agents.
 *
 * Body: {
 *   email: string,
 *   password: string,
 *   name: string,
 *   role?: "call_center_agent" | "call_center_admin",
 *   assignedWorkshops: string[],  // array of ownerUids
 * }
 */
export async function POST(req: NextRequest) {
  // This endpoint requires BMS admin auth (super_admin or workshop_owner)
  const adminAuthResult = await verifyAdminAuth(req, [
    "super_admin",
    "workshop_owner",
  ]);

  if (!adminAuthResult.success || !adminAuthResult.userData) {
    return NextResponse.json(
      { error: adminAuthResult.error },
      { status: adminAuthResult.status || 401, headers: CORS_HEADERS }
    );
  }

  try {
    const body = await req.json();
    const result = await adminCreateCallCenterAgent(body, adminAuthResult.userData);
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error },
        { status: result.status, headers: CORS_HEADERS }
      );
    }
    const a = result.agent;
    return NextResponse.json(
      {
        success: true,
        uid: a.uid,
        agent_id: a.agent_id,
        email: a.email,
        name: a.name,
        role: a.role,
        assignedWorkshops: a.assignedWorkshops,
        agent: a,
      },
      { status: 201, headers: CORS_HEADERS }
    );
  } catch (error: any) {
    console.error("[call-center/auth POST] Error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}

/**
 * PATCH /api/call-center/auth
 *
 * Update an agent's profile (assign/unassign workshops, suspend, change role).
 * Only super_admins or workshop_owners can update agents.
 *
 * Body: {
 *   agentUid: string,
 *   assignedWorkshops?: string[],
 *   suspended?: boolean,
 *   role?: "call_center_agent" | "call_center_admin",
 *   name?: string,
 * }
 */
export async function PATCH(req: NextRequest) {
  const adminAuthResult = await verifyAdminAuth(req, [
    "super_admin",
    "workshop_owner",
  ]);

  if (!adminAuthResult.success || !adminAuthResult.userData) {
    return NextResponse.json(
      { error: adminAuthResult.error },
      { status: adminAuthResult.status || 401, headers: CORS_HEADERS }
    );
  }

  try {
    const body = await req.json();
    const { agentUid, assignedWorkshops, suspended, role, name } = body;

    if (!agentUid) {
      return NextResponse.json(
        { error: "Missing agentUid" },
        { status: 400, headers: CORS_HEADERS }
      );
    }

    const result = await adminUpdateCallCenterAgent(
      agentUid,
      { assignedWorkshops, suspended, role, name },
      adminAuthResult.userData
    );
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error },
        { status: result.status, headers: CORS_HEADERS }
      );
    }

    return NextResponse.json(
      { success: true, agentUid, agent: result.agent },
      { headers: CORS_HEADERS }
    );
  } catch (error: any) {
    console.error("[call-center/auth PATCH] Error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
