import { NextRequest, NextResponse } from "next/server";
import { resolveNotificationActorSnapshot } from "@/lib/callCenterActorFromAuth";
import {
  verifyCallCenterOrTenantAdminAuth,
  canActOnCustomerNotificationTracking,
  CORS_HEADERS,
} from "@/lib/callCenterAuth";
import { mergeAndReadNotificationTracking } from "@/lib/callCenterNotificationTrackingWrite";
import { parseOptionalBooleanFlag } from "@/lib/parseCallCenterNotificationFlagBody";
import { resolveCustomerNotificationForCallCenter } from "@/lib/resolveCustomerNotificationForCallCenter";

export const runtime = "nodejs";

export async function OPTIONS() {
  return NextResponse.json({}, { headers: CORS_HEADERS });
}

/**
 * POST /api/call-center/customer-notifications/[notificationId]/called-customer
 *
 * Sets `calledCustomer` on the customer notification document
 * (`customer_notifications` or customer-facing `notifications`).
 *
 * Body (optional JSON): `{ "calledCustomer": true | false }`
 * - `true` — records the authenticated user as who called (`calledCustomerBy*` fields).
 * - `false` — clears those fields.
 * - Omit field or empty body — defaults to `true` (backward compatible).
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

  if (!canActOnCustomerNotificationTracking(gate.auth, resolved.doc.ownerUid)) {
    return NextResponse.json(
      { error: "Access denied to this workshop" },
      { status: 403, headers: CORS_HEADERS }
    );
  }

  const parsed = await parseOptionalBooleanFlag(req, "calledCustomer", true);
  if (!parsed.ok) {
    return NextResponse.json(
      { error: parsed.error },
      { status: parsed.status, headers: CORS_HEADERS }
    );
  }
  const calledCustomer = parsed.value;

  const actor = await resolveNotificationActorSnapshot(gate.auth);
  const update =
    calledCustomer === true
      ? {
          calledCustomer: true,
          calledCustomerByUid: actor.uid,
          calledCustomerByDisplayName: actor.displayName || null,
          calledCustomerByName: actor.displayName || null,
          calledCustomerByEmail: actor.email || null,
        }
      : {
          calledCustomer: false,
          calledCustomerByUid: null,
          calledCustomerByDisplayName: null,
          calledCustomerByName: null,
          calledCustomerByEmail: null,
        };

  try {
    const { projectId, data } = await mergeAndReadNotificationTracking(
      resolved.doc.ref,
      update as Record<string, unknown>
    );
    const stored = data?.calledCustomer === true;
    if (stored !== calledCustomer) {
      return NextResponse.json(
        {
          error: "Firestore did not persist calledCustomer as expected",
          firebaseProjectId: projectId ?? null,
          documentPath: `${resolved.doc.collectionId}/${notificationId.trim()}`,
          expected: calledCustomer,
          actual: data?.calledCustomer ?? null,
        },
        { status: 500, headers: CORS_HEADERS }
      );
    }
    return NextResponse.json(
      {
        success: true,
        notificationId: notificationId.trim(),
        collection: resolved.doc.collectionId,
        firebaseProjectId: projectId ?? null,
        documentPath: `${resolved.doc.collectionId}/${notificationId.trim()}`,
        calledCustomer,
        calledCustomerByUid: update.calledCustomerByUid,
        calledCustomerByName: update.calledCustomerByName,
        calledCustomerByDisplayName: update.calledCustomerByDisplayName,
        calledCustomerByEmail: update.calledCustomerByEmail,
        persistedFromFirestore: {
          calledCustomer: data?.calledCustomer === true,
          calledCustomerByUid: data?.calledCustomerByUid ?? null,
          calledCustomerByName: data?.calledCustomerByName ?? null,
          calledCustomerByDisplayName: data?.calledCustomerByDisplayName ?? null,
          calledCustomerByEmail: data?.calledCustomerByEmail ?? null,
        },
      },
      { headers: CORS_HEADERS }
    );
  } catch (e: any) {
    console.error("[call-center/called-customer POST]", e);
    return NextResponse.json(
      { error: e?.message || "Update failed" },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
