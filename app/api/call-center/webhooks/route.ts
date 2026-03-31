import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";
import {
  verifyCallCenterAuth,
  CORS_HEADERS,
} from "@/lib/callCenterAuth";

export const runtime = "nodejs";

export async function OPTIONS() {
  return NextResponse.json({}, { headers: CORS_HEADERS });
}

/**
 * GET /api/call-center/webhooks
 *
 * List all registered webhook endpoints for the call center.
 * Only call_center_admin can view.
 */
export async function GET(req: NextRequest) {
  const auth = await verifyCallCenterAuth(req);
  if (!auth.success || !auth.user) {
    return NextResponse.json(
      { error: auth.error },
      { status: auth.status || 401, headers: CORS_HEADERS }
    );
  }

  if (!auth.user.isCCAdmin) {
    return NextResponse.json(
      { error: "Only call center admins can manage webhooks" },
      { status: 403, headers: CORS_HEADERS }
    );
  }

  try {
    const db = adminDb();
    const snap = await db.collection("cc_webhooks").get();

    const webhooks = snap.docs.map((doc) => {
      const d = doc.data();
      return {
        id: doc.id,
        url: d.url || "",
        events: d.events || [],
        active: d.active !== false,
        createdAt: d.createdAt || null,
        description: d.description || "",
      };
    });

    return NextResponse.json({ webhooks }, { headers: CORS_HEADERS });
  } catch (error: any) {
    console.error("[call-center/webhooks GET] Error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}

/**
 * POST /api/call-center/webhooks
 *
 * Register a webhook URL so the call center dashboard receives
 * real-time push notifications from BMS when events happen.
 *
 * Events the call center can subscribe to:
 * - booking.status_changed     → When a booking status changes (e.g., Confirmed → Completed)
 * - booking.additional_issue   → When a technician reports new extra work
 * - booking.issue_priced       → When workshop admin sets price on extra work (ready for customer call)
 * - booking.completed          → When a booking is marked as completed
 * - booking.canceled           → When a booking is canceled
 *
 * Body: {
 *   url: "https://your-call-center-app.com/webhooks/bms",
 *   events: ["booking.additional_issue", "booking.issue_priced", "booking.status_changed"],
 *   secret: "your_webhook_secret",   // Used to sign payloads (HMAC-SHA256)
 *   description?: "Production webhook for call center dashboard"
 * }
 *
 * Only call_center_admin can register webhooks.
 *
 * Webhook Payload Format (POST to your URL):
 * {
 *   "event": "booking.issue_priced",
 *   "timestamp": "2026-03-31T10:00:00Z",
 *   "data": {
 *     "bookingId": "abc123",
 *     "bookingCode": "CC-M3X7K",
 *     "ownerUid": "ownerUid_abc123",
 *     "workshopName": "ABC Mechanical",
 *     "clientName": "Sarah Mendis",
 *     "clientPhone": "+61400111222",
 *     // Event-specific fields...
 *     "issue": {
 *       "id": "issue_001",
 *       "issueTitle": "Worn Brake Pads",
 *       "price": 180,
 *       "status": "approved"
 *     }
 *   },
 *   "signature": "hmac_sha256_hex_of_payload"
 * }
 */
export async function POST(req: NextRequest) {
  const auth = await verifyCallCenterAuth(req);
  if (!auth.success || !auth.user) {
    return NextResponse.json(
      { error: auth.error },
      { status: auth.status || 401, headers: CORS_HEADERS }
    );
  }

  if (!auth.user.isCCAdmin) {
    return NextResponse.json(
      { error: "Only call center admins can register webhooks" },
      { status: 403, headers: CORS_HEADERS }
    );
  }

  try {
    const body = await req.json();
    const { url, events, secret, description } = body;

    if (!url || typeof url !== "string" || !url.startsWith("https://")) {
      return NextResponse.json(
        { error: "A valid HTTPS webhook URL is required" },
        { status: 400, headers: CORS_HEADERS }
      );
    }

    const validEvents = [
      "booking.status_changed",
      "booking.additional_issue",
      "booking.issue_priced",
      "booking.completed",
      "booking.canceled",
    ];

    if (!events || !Array.isArray(events) || events.length === 0) {
      return NextResponse.json(
        { error: `events must be an array. Valid events: ${validEvents.join(", ")}` },
        { status: 400, headers: CORS_HEADERS }
      );
    }

    const invalidEvents = events.filter((e: string) => !validEvents.includes(e));
    if (invalidEvents.length > 0) {
      return NextResponse.json(
        { error: `Invalid events: ${invalidEvents.join(", ")}. Valid: ${validEvents.join(", ")}` },
        { status: 400, headers: CORS_HEADERS }
      );
    }

    const db = adminDb();

    const webhookData = {
      url,
      events,
      secret: secret || null,
      description: description || "",
      active: true,
      createdAt: new Date(),
      createdBy: auth.user.uid,
    };

    const ref = await db.collection("cc_webhooks").add(webhookData);

    return NextResponse.json(
      {
        success: true,
        webhookId: ref.id,
        url,
        events,
        message: "Webhook registered. BMS will POST to your URL when subscribed events occur.",
      },
      { status: 201, headers: CORS_HEADERS }
    );
  } catch (error: any) {
    console.error("[call-center/webhooks POST] Error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}

/**
 * DELETE /api/call-center/webhooks?id=webhookId
 *
 * Remove a webhook registration.
 */
export async function DELETE(req: NextRequest) {
  const auth = await verifyCallCenterAuth(req);
  if (!auth.success || !auth.user) {
    return NextResponse.json(
      { error: auth.error },
      { status: auth.status || 401, headers: CORS_HEADERS }
    );
  }

  if (!auth.user.isCCAdmin) {
    return NextResponse.json(
      { error: "Only call center admins can manage webhooks" },
      { status: 403, headers: CORS_HEADERS }
    );
  }

  const webhookId = req.nextUrl.searchParams.get("id");
  if (!webhookId) {
    return NextResponse.json(
      { error: "Missing webhook id" },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  try {
    const db = adminDb();
    const doc = await db.doc(`cc_webhooks/${webhookId}`).get();
    if (!doc.exists) {
      return NextResponse.json(
        { error: "Webhook not found" },
        { status: 404, headers: CORS_HEADERS }
      );
    }

    await db.doc(`cc_webhooks/${webhookId}`).delete();

    return NextResponse.json(
      { success: true, deleted: webhookId },
      { headers: CORS_HEADERS }
    );
  } catch (error: any) {
    console.error("[call-center/webhooks DELETE] Error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
