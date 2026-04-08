import { NextRequest, NextResponse } from "next/server";
import { resolveNotificationActorSnapshot } from "@/lib/callCenterActorFromAuth";
import {
  verifyCallCenterOrTenantAdminAuth,
  canAccessWorkshopForAuth,
  CORS_HEADERS,
} from "@/lib/callCenterAuth";
import { parseOptionalBooleanFlag } from "@/lib/parseCallCenterNotificationFlagBody";
import { resolveCustomerNotificationForCallCenter } from "@/lib/resolveCustomerNotificationForCallCenter";

export const runtime = "nodejs";

export async function OPTIONS() {
  return NextResponse.json({}, { headers: CORS_HEADERS });
}

/**
 * POST /api/call-center/customer-notifications/[notificationId]/notification-reviewed
 *
 * Sets `notificationReviewed` on the customer notification document
 * (`customer_notifications` or customer-facing `notifications`).
 *
 * Body (optional JSON): `{ "notificationReviewed": true | false }`
 * - `true` — sets reviewer UID, email, display name (`notificationReviewedByDisplayName` + `ByName`).
 * - `false` — clears reviewer fields.
 * - Omit field or send empty body — defaults to `true` (backward compatible).
 *
 * Auth: Bearer Firebase ID token (call center agent or BMS staff: workshop owner, branch admin, super admin).
 */
export async function POST(
  req: NextRequest,
  context: { params: Promise<{ notificationId: string }> }
) {
  const gate = await verifyCallCenterOrTenantAdminAuth(req);
  if (!gate.success) {
    return NextResponse.json(
      { error: gate.error },
      { status: gate.status || 401, headers: CORS_HEADERS }
    );
  }

  const { notificationId } = await context.params;
  const resolved = await resolveCustomerNotificationForCallCenter(notificationId);

  if (!resolved.ok) {
    if (resolved.reason === "not_customer_facing") {
      return NextResponse.json(
        {
          error:
            "This notification is not part of the customer inbox and cannot be updated with call-center tracking fields",
        },
        { status: 403, headers: CORS_HEADERS }
      );
    }
    if (resolved.reason === "missing_owner") {
      return NextResponse.json(
        { error: "Notification is missing workshop scope (ownerUid)" },
        { status: 422, headers: CORS_HEADERS }
      );
    }
    return NextResponse.json({ error: "Notification not found" }, { status: 404, headers: CORS_HEADERS });
  }

  if (!canAccessWorkshopForAuth(gate.auth, resolved.doc.ownerUid)) {
    return NextResponse.json(
      { error: "Access denied to this workshop" },
      { status: 403, headers: CORS_HEADERS }
    );
  }

  const parsed = await parseOptionalBooleanFlag(req, "notificationReviewed", true);
  if (!parsed.ok) {
    return NextResponse.json(
      { error: parsed.error },
      { status: parsed.status, headers: CORS_HEADERS }
    );
  }
  const notificationReviewed = parsed.value;

  const actor = await resolveNotificationActorSnapshot(gate.auth);
  const update =
    notificationReviewed === true
      ? {
          notificationReviewed: true,
          notificationReviewedByUid: actor.uid,
          notificationReviewedByDisplayName: actor.displayName || null,
          notificationReviewedByName: actor.displayName || null,
          notificationReviewedByEmail: actor.email || null,
        }
      : {
          notificationReviewed: false,
          notificationReviewedByUid: null,
          notificationReviewedByDisplayName: null,
          notificationReviewedByName: null,
          notificationReviewedByEmail: null,
        };

  try {
    await resolved.doc.ref.update(update);
    return NextResponse.json(
      {
        success: true,
        notificationId: notificationId.trim(),
        collection: resolved.doc.collectionId,
        notificationReviewed,
        notificationReviewedByUid: update.notificationReviewedByUid,
        notificationReviewedByName: update.notificationReviewedByName,
        notificationReviewedByDisplayName: update.notificationReviewedByDisplayName,
        notificationReviewedByEmail: update.notificationReviewedByEmail,
      },
      { headers: CORS_HEADERS }
    );
  } catch (e: any) {
    console.error("[call-center/notification-reviewed POST]", e);
    return NextResponse.json(
      { error: e?.message || "Update failed" },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
