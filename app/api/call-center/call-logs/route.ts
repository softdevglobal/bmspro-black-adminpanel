import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";
import {
  verifyCallCenterOrTenantAdminAuth,
  canAccessWorkshopForAuth,
  CORS_HEADERS,
} from "@/lib/callCenterAuth";

export const runtime = "nodejs";

export async function OPTIONS() {
  return NextResponse.json({}, { headers: CORS_HEADERS });
}

/**
 * POST /api/call-center/call-logs
 *
 * Record a call log entry in BMS so the workshop owner can see call history.
 * This links the call center's call records to BMS bookings and customers.
 *
 * Body: {
 *   ownerUid: string,           // Workshop this call was for
 *   branchId?: string,          // Specific branch if known
 *   callerPhone: string,        // Incoming caller phone number
 *   callerName?: string,        // Caller name (if identified)
 *   customerId?: string,        // BMS customer ID (if matched)
 *   bookingId?: string,         // Related booking (if applicable)
 *   direction: "inbound" | "outbound",
 *   purpose: "booking" | "progress_check" | "extra_work_approval" | "general_inquiry" | "complaint" | "other",
 *   duration?: number,          // Call duration in seconds
 *   notes?: string,             // Agent notes about the call
 *   outcome?: string,           // e.g., "booking_created", "info_provided", "callback_scheduled", "extra_work_accepted"
 *   callCenterCallId?: string,  // ID from the call center's own Supabase (for cross-referencing)
 * }
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
    const {
      ownerUid,
      branchId,
      callerPhone,
      callerName,
      customerId,
      bookingId,
      direction,
      purpose,
      duration,
      notes,
      outcome,
      callCenterCallId,
    } = body;

    if (!ownerUid) {
      return NextResponse.json(
        { error: "Missing ownerUid" },
        { status: 400, headers: CORS_HEADERS }
      );
    }

    if (!canAccessWorkshopForAuth(gate.auth, ownerUid)) {
      return NextResponse.json(
        { error: "Access denied" },
        { status: 403, headers: CORS_HEADERS }
      );
    }

    if (!callerPhone) {
      return NextResponse.json(
        { error: "Missing callerPhone" },
        { status: 400, headers: CORS_HEADERS }
      );
    }

    if (!direction || !["inbound", "outbound"].includes(direction)) {
      return NextResponse.json(
        { error: "direction must be 'inbound' or 'outbound'" },
        { status: 400, headers: CORS_HEADERS }
      );
    }

    const db = adminDb();

    const actor =
      gate.auth.kind === "agent"
        ? { uid: gate.auth.user.uid, name: gate.auth.user.name }
        : { uid: gate.auth.uid, name: gate.auth.name };

    const logData = {
      ownerUid,
      branchId: branchId || null,
      callerPhone,
      callerName: callerName || null,
      customerId: customerId || null,
      bookingId: bookingId || null,
      direction,
      purpose: purpose || "general_inquiry",
      duration: typeof duration === "number" ? duration : null,
      notes: notes?.trim() || "",
      outcome: outcome || null,
      callCenterCallId: callCenterCallId || null,
      agentUid: actor.uid,
      agentName: actor.name,
      createdAt: new Date(),
    };

    const ref = await db.collection("call_logs").add(logData);

    return NextResponse.json(
      {
        success: true,
        callLogId: ref.id,
      },
      { status: 201, headers: CORS_HEADERS }
    );
  } catch (error: any) {
    console.error("[call-center/call-logs POST] Error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}

/**
 * GET /api/call-center/call-logs?ownerUid=X&customerId=Y&bookingId=Z&limit=25
 *
 * Retrieve call history. Useful for agents to see previous interactions.
 */
export async function GET(req: NextRequest) {
  const gate = await verifyCallCenterOrTenantAdminAuth(req);
  if (!gate.success) {
    return NextResponse.json(
      { error: gate.error },
      { status: gate.status || 401, headers: CORS_HEADERS }
    );
  }

  const ownerUid = req.nextUrl.searchParams.get("ownerUid");
  const customerId = req.nextUrl.searchParams.get("customerId");
  const bookingId = req.nextUrl.searchParams.get("bookingId");
  const limit = Math.min(
    parseInt(req.nextUrl.searchParams.get("limit") || "25", 10),
    100
  );

  if (!ownerUid) {
    return NextResponse.json(
      { error: "Missing ownerUid" },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  if (!canAccessWorkshopForAuth(gate.auth, ownerUid)) {
    return NextResponse.json(
      { error: "Access denied" },
      { status: 403, headers: CORS_HEADERS }
    );
  }

  try {
    const db = adminDb();

    let query: FirebaseFirestore.Query = db
      .collection("call_logs")
      .where("ownerUid", "==", ownerUid);

    if (customerId) {
      query = query.where("customerId", "==", customerId);
    }

    if (bookingId) {
      query = query.where("bookingId", "==", bookingId);
    }

    query = query.orderBy("createdAt", "desc").limit(limit);

    const snap = await query.get();

    const logs = snap.docs.map((doc) => {
      const d = doc.data();
      return {
        id: doc.id,
        callerPhone: d.callerPhone || "",
        callerName: d.callerName || "",
        customerId: d.customerId || null,
        bookingId: d.bookingId || null,
        direction: d.direction || "",
        purpose: d.purpose || "",
        duration: d.duration || null,
        notes: d.notes || "",
        outcome: d.outcome || null,
        agentName: d.agentName || "",
        createdAt: d.createdAt || null,
      };
    });

    return NextResponse.json(
      { callLogs: logs, total: logs.length },
      { headers: CORS_HEADERS }
    );
  } catch (error: any) {
    console.error("[call-center/call-logs GET] Error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
