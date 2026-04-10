import { NextRequest, NextResponse } from "next/server";
import { adminAuth, adminDb } from "@/lib/firebaseAdmin";
import { createNotification, type NotificationType } from "@/lib/notifications";
import { checkRateLimit, getClientIdentifier, RateLimiters, getRateLimitHeaders } from "@/lib/rateLimiterDistributed";

export const runtime = "nodejs";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders });
}

type AttendanceEvent = "clock_in" | "clock_out" | "break_start" | "break_end";

export async function POST(req: NextRequest) {
  try {
    const clientId = getClientIdentifier(req);
    const rateLimitResult = await checkRateLimit(clientId, RateLimiters.statusUpdate);
    if (!rateLimitResult.success) {
      return NextResponse.json(
        { error: "Too many requests.", retryAfter: rateLimitResult.retryAfter },
        { status: 429, headers: { ...corsHeaders, ...getRateLimitHeaders(rateLimitResult) } }
      );
    }

    const authHeader = req.headers.get("authorization") || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders });
    }

    let staffUid: string;
    try {
      const decoded = await adminAuth().verifyIdToken(token);
      staffUid = decoded.uid;
    } catch {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders });
    }

    const body = (await req.json().catch(() => ({}))) as {
      event?: AttendanceEvent;
      checkInId?: string;
    };

    const event = body.event;
    const checkInId = String(body.checkInId || "").trim();
    if (!event || !checkInId) {
      return NextResponse.json({ error: "event and checkInId are required" }, { status: 400, headers: corsHeaders });
    }

    const allowed: AttendanceEvent[] = ["clock_in", "clock_out", "break_start", "break_end"];
    if (!allowed.includes(event)) {
      return NextResponse.json({ error: "Invalid event" }, { status: 400, headers: corsHeaders });
    }

    const db = adminDb();
    const snap = await db.collection("staff_check_ins").doc(checkInId).get();
    if (!snap.exists) {
      return NextResponse.json({ error: "Check-in not found" }, { status: 404, headers: corsHeaders });
    }

    const d = snap.data() as Record<string, any>;
    if (d.staffId !== staffUid) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403, headers: corsHeaders });
    }

    const ownerUid = String(d.ownerUid || "").trim();
    if (!ownerUid) {
      return NextResponse.json({ error: "Invalid check-in data" }, { status: 400, headers: corsHeaders });
    }

    const staffName = String(d.staffName || "Staff").trim() || "Staff";
    const branchName = String(d.branchName || "").trim();

    let type: NotificationType;
    let title: string;
    let message: string;

    const branchSuffix = branchName ? ` · ${branchName}` : "";

    switch (event) {
      case "clock_in":
        type = "staff_clocked_in";
        title = "Staff clocked on";
        message = `${staffName} clocked on${branchSuffix}.`;
        break;
      case "clock_out": {
        const st = String(d.status || "");
        const auto = st === "auto_checked_out";
        const suspicious = st === "suspicious_check_out" || d.checkOutSuspicious === true;
        type = "staff_clocked_out";
        if (auto) {
          title = "Staff auto clocked off";
          message = `${staffName} was automatically clocked off (left branch area)${branchSuffix}.`;
        } else if (suspicious) {
          title = "Staff clocked off (flagged)";
          message = `${staffName} clocked off away from branch${branchSuffix}.`;
        } else {
          title = "Staff clocked off";
          message = `${staffName} clocked off${branchSuffix}.`;
        }
        break;
      }
      case "break_start":
        type = "staff_break_started";
        title = "Break started";
        message = `${staffName} started a break${branchSuffix}.`;
        break;
      case "break_end":
        type = "staff_break_ended";
        title = "Break ended";
        message = `${staffName} ended a break${branchSuffix}.`;
        break;
      default:
        return NextResponse.json({ error: "Invalid event" }, { status: 400, headers: corsHeaders });
    }

    await createNotification({
      bookingId: checkInId,
      type,
      title,
      message,
      status: "Confirmed",
      ownerUid,
      targetOwnerUid: ownerUid,
      staffName,
      branchName: branchName || undefined,
      branchId: d.branchId ? String(d.branchId) : undefined,
    } as Parameters<typeof createNotification>[0]);

    return NextResponse.json({ ok: true }, { headers: corsHeaders });
  } catch (e: unknown) {
    console.error("attendance-notify:", e);
    const message =
      process.env.NODE_ENV === "production" ? "Internal error" : e instanceof Error ? e.message : "Internal error";
    return NextResponse.json({ error: message }, { status: 500, headers: corsHeaders });
  }
}
