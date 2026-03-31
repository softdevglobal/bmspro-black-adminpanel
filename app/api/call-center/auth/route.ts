import { NextRequest, NextResponse } from "next/server";
import { adminAuth, adminDb } from "@/lib/firebaseAdmin";
import { verifyAdminAuth } from "@/lib/authHelpers";
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
    const { email, password, name, role, assignedWorkshops } = body;

    if (!email || !password || !name) {
      return NextResponse.json(
        { error: "Missing required fields: email, password, name" },
        { status: 400, headers: CORS_HEADERS }
      );
    }

    if (password.length < 6) {
      return NextResponse.json(
        { error: "Password must be at least 6 characters" },
        { status: 400, headers: CORS_HEADERS }
      );
    }

    const agentRole = role === "call_center_admin" ? "call_center_admin" : "call_center_agent";

    // Workshop owners can only assign their own workshop
    let workshops: string[] = [];
    if (adminAuthResult.userData.role === "workshop_owner") {
      workshops = [adminAuthResult.userData.uid];
    } else if (Array.isArray(assignedWorkshops)) {
      workshops = assignedWorkshops;
    }

    const auth = adminAuth();
    const db = adminDb();

    // Create Firebase Auth user
    let uid: string;
    try {
      const userRecord = await auth.createUser({
        email: email.trim().toLowerCase(),
        password,
        displayName: name.trim(),
        emailVerified: false,
        disabled: false,
      });
      uid = userRecord.uid;
    } catch (e: any) {
      if (e.code === "auth/email-already-exists") {
        return NextResponse.json(
          { error: "An account with this email already exists" },
          { status: 409, headers: CORS_HEADERS }
        );
      }
      throw e;
    }

    // Create agent doc in call_center_agents collection
    const now = new Date();
    await db.doc(`call_center_agents/${uid}`).set({
      email: email.trim().toLowerCase(),
      displayName: name.trim(),
      name: name.trim(),
      role: agentRole,
      assignedWorkshops: workshops,
      suspended: false,
      createdAt: now,
      updatedAt: now,
      createdBy: adminAuthResult.userData.uid,
      createdByRole: adminAuthResult.userData.role,
    });

    return NextResponse.json(
      {
        success: true,
        uid,
        email: email.trim().toLowerCase(),
        name: name.trim(),
        role: agentRole,
        assignedWorkshops: workshops,
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

    const db = adminDb();

    const agentDoc = await db.doc(`call_center_agents/${agentUid}`).get();
    if (!agentDoc.exists) {
      return NextResponse.json(
        { error: "Agent not found" },
        { status: 404, headers: CORS_HEADERS }
      );
    }

    const updates: Record<string, any> = { updatedAt: new Date() };

    if (assignedWorkshops !== undefined && Array.isArray(assignedWorkshops)) {
      if (adminAuthResult.userData.role === "workshop_owner") {
        // Workshop owners can only add/remove their own uid
        const existing = agentDoc.data()?.assignedWorkshops || [];
        const ownerUid = adminAuthResult.userData.uid;
        if (assignedWorkshops.includes(ownerUid)) {
          updates.assignedWorkshops = [...new Set([...existing, ownerUid])];
        } else {
          updates.assignedWorkshops = existing.filter(
            (id: string) => id !== ownerUid
          );
        }
      } else {
        updates.assignedWorkshops = assignedWorkshops;
      }
    }

    if (suspended !== undefined) {
      updates.suspended = Boolean(suspended);
    }

    if (role && ["call_center_agent", "call_center_admin"].includes(role)) {
      updates.role = role;
    }

    if (name && typeof name === "string") {
      updates.displayName = name.trim();
      updates.name = name.trim();
    }

    await db.doc(`call_center_agents/${agentUid}`).update(updates);

    return NextResponse.json(
      { success: true, agentUid, updates: Object.keys(updates) },
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
