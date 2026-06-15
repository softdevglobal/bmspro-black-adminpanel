import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";
import {
  verifyCallCenterOrTenantAdminAuth,
  canAccessWorkshopForAuth,
  CORS_HEADERS,
} from "@/lib/callCenterAuth";
import { resolveAgentActivityActor } from "@/lib/callCenterActorFromAuth";

export const runtime = "nodejs";

/** Firestore collection for call-center agent activity records. */
const COLLECTION = "agent_activities";

export type AgentActivityRecord = {
  callId: string;
  agentName: string;
  agentUserId: string;
  agentEmail: string;
  agentRole: string;
  recordedByKind: "agent" | "tenant_admin";
  callerNumber: string;
  callerName: string;
  agentNote: string;
  didNumber: string;
  ownerId: string;
  ownerName: string;
  ownerTimezone: string;
  branchId: string;
  branchName: string;
  queueId: string;
  queueName: string;
  createdAt: Date;
  updatedAt: Date;
};

export type AgentActivityResponse = Omit<AgentActivityRecord, "createdAt" | "updatedAt"> & {
  id: string;
  createdAt: string | null;
  updatedAt: string | null;
};

function serializeAgentActivity(id: string, d: FirebaseFirestore.DocumentData): AgentActivityResponse {
  const toIso = (v: unknown): string | null => {
    if (!v) return null;
    if (v instanceof Date) return v.toISOString();
    if (typeof v === "object" && v !== null && "toDate" in v && typeof (v as { toDate: () => Date }).toDate === "function") {
      return (v as { toDate: () => Date }).toDate().toISOString();
    }
    if (typeof v === "string") return v;
    return null;
  };

  return {
    id,
    callId: String(d.callId ?? ""),
    agentName: String(d.agentName ?? ""),
    agentUserId: String(d.agentUserId ?? ""),
    agentEmail: String(d.agentEmail ?? ""),
    agentRole: String(d.agentRole ?? ""),
    recordedByKind:
      d.recordedByKind === "tenant_admin" ? "tenant_admin" : "agent",
    callerNumber: String(d.callerNumber ?? ""),
    callerName: String(d.callerName ?? ""),
    agentNote: String(d.agentNote ?? ""),
    didNumber: String(d.didNumber ?? ""),
    ownerId: String(d.ownerId ?? ""),
    ownerName: String(d.ownerName ?? ""),
    ownerTimezone: String(d.ownerTimezone ?? "Australia/Sydney"),
    branchId: String(d.branchId ?? ""),
    branchName: String(d.branchName ?? ""),
    queueId: String(d.queueId ?? ""),
    queueName: String(d.queueName ?? ""),
    createdAt: toIso(d.createdAt),
    updatedAt: toIso(d.updatedAt),
  };
}

function resolveOwnerId(bodyOrParams: {
  ownerId?: unknown;
  ownerUid?: unknown;
}): string {
  const raw = bodyOrParams.ownerId ?? bodyOrParams.ownerUid;
  return typeof raw === "string" ? raw.trim() : "";
}

function isFirestoreIndexError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: number | string; message?: string; details?: string };
  const code = e.code;
  const text = `${e.message || ""} ${e.details || ""}`.toLowerCase();
  return code === 9 || code === "failed-precondition" || text.includes("requires an index");
}

function createdAtMs(d: FirebaseFirestore.DocumentData): number {
  const v = d.createdAt;
  if (!v) return 0;
  if (v instanceof Date) return v.getTime();
  if (typeof v === "object" && v !== null && "toDate" in v && typeof (v as { toDate: () => Date }).toDate === "function") {
    return (v as { toDate: () => Date }).toDate().getTime();
  }
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? 0 : t;
  }
  return 0;
}

async function fetchAgentActivities(
  db: FirebaseFirestore.Firestore,
  filters: {
    ownerId: string;
    agentUserId: string;
    agentEmail: string;
    branchId: string;
    callId: string;
    limit: number;
  }
): Promise<FirebaseFirestore.QueryDocumentSnapshot[]> {
  const { ownerId, agentUserId, agentEmail, branchId, callId, limit } = filters;

  let query: FirebaseFirestore.Query = db
    .collection(COLLECTION)
    .where("ownerId", "==", ownerId);

  if (agentUserId) {
    query = query.where("agentUserId", "==", agentUserId);
  }
  if (branchId) {
    query = query.where("branchId", "==", branchId);
  }
  if (callId) {
    query = query.where("callId", "==", callId);
  }

  try {
    const snap = await query.orderBy("createdAt", "desc").limit(limit).get();
    let docs = snap.docs;
    if (agentEmail) {
      const emailLower = agentEmail.toLowerCase();
      docs = docs.filter(
        (doc) => String(doc.data().agentEmail || "").toLowerCase() === emailLower
      );
    }
    return docs;
  } catch (error: unknown) {
    if (!isFirestoreIndexError(error)) throw error;

    console.warn(
      "[call-center/agent-activities GET] Composite index missing; using in-memory sort. Deploy firestore.indexes.json or open the link in the server log."
    );

    const fallbackLimit = Math.min(Math.max(limit * 5, 100), 500);
    const snap = await db.collection(COLLECTION).where("ownerId", "==", ownerId).limit(fallbackLimit).get();

    return snap.docs
      .filter((doc) => {
        const d = doc.data();
        if (agentUserId && d.agentUserId !== agentUserId) return false;
        if (agentEmail && String(d.agentEmail || "").toLowerCase() !== agentEmail.toLowerCase()) {
          return false;
        }
        if (branchId && d.branchId !== branchId) return false;
        if (callId && d.callId !== callId) return false;
        return true;
      })
      .sort((a, b) => createdAtMs(b.data()) - createdAtMs(a.data()))
      .slice(0, limit);
  }
}

export async function OPTIONS() {
  return NextResponse.json({}, { headers: CORS_HEADERS });
}

/**
 * POST /api/call-center/agent-activities
 *
 * Typical agent flow (call center dashboard):
 *
 * Step 1 — Agent login (get Firebase ID token):
 *   POST http://localhost:3000/api/call-center/auth/login
 *   POST https://black.bmspros.com.au/api/call-center/auth/login
 *   Body: { "email": "agent@example.com", "password": "your-password" }
 *   Success: { "agent_id", "email", "idToken", "refreshToken", "expiresIn", ... }
 *   Requires Firestore `call_center_agents/{agent_id}` (or `users/{uid}` with call-center role).
 *
 * Step 2 — (optional) Verify agent profile + assigned workshops:
 *   GET http://localhost:3000/api/call-center/auth
 *   GET https://black.bmspros.com.au/api/call-center/auth
 *   Header: Authorization: Bearer <idToken from step 1>
 *
 * Step 3 — Record agent activity (this route, POST):
 *   POST http://localhost:3000/api/call-center/agent-activities
 *   POST https://black.bmspros.com.au/api/call-center/agent-activities
 *   Header: Authorization: Bearer <idToken from step 1>
 *
 * Step 4 — List agent activities (GET handler below):
 *   GET http://localhost:3000/api/call-center/agent-activities?ownerId=<firebase-owner-uid>
 *   GET https://black.bmspros.com.au/api/call-center/agent-activities?ownerId=<firebase-owner-uid>
 *   Header: Authorization: Bearer <idToken from step 1>
 *
 * Creates a document in Firestore collection `agent_activities`.
 *
 * Auth: Authorization: Bearer <Firebase ID token>
 *       Call center agent, workshop owner, branch admin, or super admin.
 *
 * Body (JSON) — call / workshop fields required; agent identity is taken from the Bearer token:
 * {
 *   "callId": "call-id",
 *   "callerNumber": "+61400000000",
 *   "callerName": "Caller Name",
 *   "agentNote": "Agent typed note",
 *   "didNumber": "0390000000",
 *   "ownerId": "firebase-owner-uid",
 *   "branchId": "branch-id",
 *   "branchName": "Branch Name",
 *   "queueId": "queue-id",
 *   "queueName": "Black Queue"
 * }
 *
 * Stored agent fields (from token + Firestore profile, not body): `agentUserId`, `agentName`,
 * `agentEmail`, `agentRole`, `recordedByKind`. Workshop name stored as `ownerName`.
 *
 * `ownerUid` is accepted as an alias for `ownerId` (same as other call-center routes).
 */
export async function POST(req: NextRequest) {
  const gate = await verifyCallCenterOrTenantAdminAuth(req);
  if (!gate.success) {
    return NextResponse.json(
      { error: gate.error },
      { status: gate.status || 401, headers: CORS_HEADERS }
    );
  }

  try {
    const body = await req.json();
    const ownerId = resolveOwnerId(body);

    if (!ownerId) {
      return NextResponse.json(
        { error: "Missing ownerId (workshop owner Firebase UID)" },
        { status: 400, headers: CORS_HEADERS }
      );
    }

    if (!canAccessWorkshopForAuth(gate.auth, ownerId)) {
      return NextResponse.json(
        { error: "Access denied for this workshop" },
        { status: 403, headers: CORS_HEADERS }
      );
    }

    const callId = typeof body.callId === "string" ? body.callId.trim() : "";
    const callerNumber = typeof body.callerNumber === "string" ? body.callerNumber.trim() : "";

    if (!callId) {
      return NextResponse.json(
        { error: "Missing callId" },
        { status: 400, headers: CORS_HEADERS }
      );
    }

    if (!callerNumber) {
      return NextResponse.json(
        { error: "Missing callerNumber" },
        { status: 400, headers: CORS_HEADERS }
      );
    }

    const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

    const db = adminDb();
    const actor = await resolveAgentActivityActor(gate.auth);

    let ownerName = "";
    let ownerTimezone = "Australia/Sydney";
    try {
      const ownerDoc = await db.doc(`users/${ownerId}`).get();
      if (ownerDoc.exists) {
        const od = ownerDoc.data();
        ownerName = String(od?.name || od?.displayName || "").trim();
        ownerTimezone = String(od?.timezone || "Australia/Sydney").trim() || "Australia/Sydney";
      }
    } catch {
      ownerName = "";
    }

    const now = new Date();
    const record: AgentActivityRecord = {
      callId,
      agentUserId: actor.uid,
      agentName: actor.displayName,
      agentEmail: actor.email,
      agentRole: actor.role,
      recordedByKind: actor.recordedByKind,
      callerNumber,
      callerName: str(body.callerName),
      agentNote: str(body.agentNote),
      didNumber: str(body.didNumber),
      ownerId,
      ownerName,
      ownerTimezone,
      branchId: str(body.branchId),
      branchName: str(body.branchName),
      queueId: str(body.queueId),
      queueName: str(body.queueName),
      createdAt: now,
      updatedAt: now,
    };

    const ref = await db.collection(COLLECTION).add(record);

    return NextResponse.json(
      {
        success: true,
        id: ref.id,
        activity: serializeAgentActivity(ref.id, record),
      },
      { status: 201, headers: CORS_HEADERS }
    );
  } catch (error: unknown) {
    console.error("[call-center/agent-activities POST] Error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}

/**
 * GET /api/call-center/agent-activities?ownerId=<firebase-owner-uid>&limit=25
 *
 * Step 4 of agent flow — see POST comment above for Step 1 (login) through Step 3 (record activity).
 *
 * Full URL (local):  http://localhost:3000/api/call-center/agent-activities?ownerId=<firebase-owner-uid>
 * Full URL (prod):   https://black.bmspros.com.au/api/call-center/agent-activities?ownerId=<firebase-owner-uid>
 * Header: Authorization: Bearer <idToken from Step 1 login>
 *
 * Optional query params:
 *   ownerId   (required) — workshop owner Firebase UID (`ownerUid` alias accepted)
 *   agentUserId — filter by agent Firebase UID
 *   agentEmail  — filter by agent email (case-insensitive; applied in memory when index missing)
 *   branchId    — filter by branch document id
 *   callId      — filter by external call id
 *   limit       — max rows (default 25, max 100)
 */
export async function GET(req: NextRequest) {
  const gate = await verifyCallCenterOrTenantAdminAuth(req);
  if (!gate.success) {
    return NextResponse.json(
      { error: gate.error },
      { status: 401, headers: CORS_HEADERS }
    );
  }

  const params = req.nextUrl.searchParams;
  const ownerId = resolveOwnerId({
    ownerId: params.get("ownerId"),
    ownerUid: params.get("ownerUid"),
  });
  const agentUserId = params.get("agentUserId")?.trim() || "";
  const agentEmail = params.get("agentEmail")?.trim() || "";
  const branchId = params.get("branchId")?.trim() || "";
  const callId = params.get("callId")?.trim() || "";
  const limit = Math.min(parseInt(params.get("limit") || "25", 10), 100);

  if (!ownerId) {
    return NextResponse.json(
      { error: "Missing ownerId query parameter" },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  if (!canAccessWorkshopForAuth(gate.auth, ownerId)) {
    return NextResponse.json(
      { error: "Access denied for this workshop" },
      { status: 403, headers: CORS_HEADERS }
    );
  }

  try {
    const db = adminDb();
    const docs = await fetchAgentActivities(db, {
      ownerId,
      agentUserId,
      agentEmail,
      branchId,
      callId,
      limit,
    });
    const activities = docs.map((doc) => serializeAgentActivity(doc.id, doc.data()));

    return NextResponse.json(
      {
        success: true,
        activities,
        total: activities.length,
      },
      { headers: CORS_HEADERS }
    );
  } catch (error: unknown) {
    console.error("[call-center/agent-activities GET] Error:", error);
    if (isFirestoreIndexError(error)) {
      return NextResponse.json(
        {
          error:
            "Firestore index required for agent_activities. Deploy firestore.indexes.json (firebase deploy --only firestore:indexes) or create the index from the Firebase console link in server logs.",
        },
        { status: 503, headers: CORS_HEADERS }
      );
    }
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
