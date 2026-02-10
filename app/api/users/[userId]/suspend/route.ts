import { NextRequest, NextResponse } from "next/server";
import { adminAuth, adminDb } from "@/lib/firebaseAdmin";
import { FieldValue } from "firebase-admin/firestore";
import { checkRateLimit, getClientIdentifier, RateLimiters, getRateLimitHeaders } from "@/lib/rateLimiterDistributed";

export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ userId: string }> }
) {
  try {
    // Security: Distributed rate limiting to prevent suspension spam
    const clientId = getClientIdentifier(req);
    const rateLimitResult = await checkRateLimit(clientId, RateLimiters.staffAuth);
    
    if (!rateLimitResult.success) {
      return NextResponse.json(
        { 
          error: "Too many requests. Please try again later.",
          retryAfter: rateLimitResult.retryAfter,
        },
        { status: 429, headers: getRateLimitHeaders(rateLimitResult) }
      );
    }

    const { userId } = await context.params;
    const authHeader = req.headers.get("authorization") || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const decoded = await adminAuth().verifyIdToken(token);
    const requesterUid = decoded.uid;

    // Ensure requester is super_admin
    const requesterSnap = await adminDb().doc(`users/${requesterUid}`).get();
    if (!requesterSnap.exists) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    const requesterRole = (requesterSnap.data()?.role || "").toString();
    if (requesterRole !== "super_admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    // Accept body JSON, query param, or toggle if omitted
    const body = await req.json().catch(() => ({} as any));
    let suspended: boolean | undefined = body?.suspended;

    const targetId = userId;
    if (!targetId || targetId === "undefined" || targetId === "null") {
      return NextResponse.json({ error: "Invalid userId" }, { status: 400 });
    }
    const targetRef = adminDb().doc(`users/${targetId}`);

    if (typeof suspended !== "boolean") {
      // try query param
      const url = new URL(req.url);
      const qp = url.searchParams.get("suspended");
      if (qp === "true") suspended = true;
      else if (qp === "false") suspended = false;
    }

    if (typeof suspended !== "boolean") {
      // fallback: toggle based on current value
      const current = await targetRef.get();
      const currSusp = Boolean(current.data()?.suspended);
      suspended = !currSusp;
    }

    const status = suspended ? "Suspended" : "Active";

    await targetRef.set(
      {
        suspended,
        status,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return NextResponse.json({ ok: true, suspended, status });
  } catch (e: any) {
    console.error("Suspend API error:", e);
    // Surface the message during development to help diagnose env/token issues
    const message = process.env.NODE_ENV === "production" ? "Internal error" : (e?.message || "Internal error");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}


