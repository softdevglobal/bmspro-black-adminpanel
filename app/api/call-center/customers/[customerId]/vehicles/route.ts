import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";
import {
  verifyCallCenterOrTenantAdminAuth,
  canAccessWorkshopForAuth,
  getTenantId,
  CORS_HEADERS,
} from "@/lib/callCenterAuth";
import {
  mapCustomerVehicleDoc,
  parseVehicleDetailsBody,
  isSameCustomerVehicle,
  mergeVehicleFirestoreFields,
  dedupeVehiclesByIdentity,
} from "@/lib/callCenterCustomerVehicles";

export const runtime = "nodejs";

export async function OPTIONS() {
  return NextResponse.json({}, { headers: CORS_HEADERS });
}

/**
 * GET /api/call-center/customers/[customerId]/vehicles
 *
 * List all registered vehicles for a customer.
 * Tenant optional: `ownerUid` / `X-Tenant-Id` — if omitted, resolved from the customer document.
 */
export async function GET(
  req: NextRequest,
  context: { params: Promise<{ customerId: string }> }
) {
  const gate = await verifyCallCenterOrTenantAdminAuth(req);
  if (!gate.success) {
    return NextResponse.json(
      { error: gate.error },
      { status: gate.status || 401, headers: CORS_HEADERS }
    );
  }

  const { customerId } = await context.params;

  try {
    const db = adminDb();

    const custDoc = await db.doc(`customers/${customerId}`).get();
    if (!custDoc.exists) {
      return NextResponse.json(
        { error: "Customer not found in this workshop" },
        { status: 404, headers: CORS_HEADERS }
      );
    }

    const customerOwnerUid = (custDoc.data()?.ownerUid as string) || "";
    const tenantFromRequest = getTenantId(req);
    if (tenantFromRequest && tenantFromRequest !== customerOwnerUid) {
      return NextResponse.json(
        { error: "Customer does not belong to this tenant" },
        { status: 403, headers: CORS_HEADERS }
      );
    }

    if (!customerOwnerUid || !canAccessWorkshopForAuth(gate.auth, customerOwnerUid)) {
      return NextResponse.json(
        { error: "Access denied" },
        { status: 403, headers: CORS_HEADERS }
      );
    }

    const vehiclesSnap = await db
      .collection(`customers/${customerId}/vehicles`)
      .get();

    const vehicles = dedupeVehiclesByIdentity(
      vehiclesSnap.docs.map((doc) =>
        mapCustomerVehicleDoc(doc.id, doc.data() as Record<string, unknown>)
      ) as (Record<string, unknown> & { id: string })[]
    );

    return NextResponse.json({ vehicles }, { headers: CORS_HEADERS });
  } catch (error: any) {
    console.error("[call-center/customers/vehicles] Error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}

/**
 * POST /api/call-center/customers/[customerId]/vehicles
 *
 * Add a vehicle. Body must include **rego** or **registrationNumber** or **vehicleNumber**.
 * Optional: make, model, year, colour, bodyType, engineNumber, vin, vinChassis, mileage, notes,
 * or nest under **vehicleDetails: { ... }**. Response includes full **vehicle** object.
 */
export async function POST(
  req: NextRequest,
  context: { params: Promise<{ customerId: string }> }
) {
  const gate = await verifyCallCenterOrTenantAdminAuth(req);
  if (!gate.success) {
    return NextResponse.json(
      { error: gate.error },
      { status: gate.status || 401, headers: CORS_HEADERS }
    );
  }

  const { customerId } = await context.params;

  try {
    const actor =
      gate.auth.kind === "agent"
        ? { uid: gate.auth.user.uid, name: gate.auth.user.name }
        : { uid: gate.auth.uid, name: gate.auth.name };

    const body = await req.json();
    const db = adminDb();

    const custDoc = await db.doc(`customers/${customerId}`).get();
    if (!custDoc.exists) {
      return NextResponse.json(
        { error: "Customer not found" },
        { status: 404, headers: CORS_HEADERS }
      );
    }

    const customerOwnerUid = (custDoc.data()?.ownerUid as string) || "";
    const tenantFromRequest = getTenantId(req);

    if (body.ownerUid && body.ownerUid !== customerOwnerUid) {
      return NextResponse.json(
        { error: "Customer does not belong to this tenant" },
        { status: 403, headers: CORS_HEADERS }
      );
    }

    if (tenantFromRequest && tenantFromRequest !== customerOwnerUid) {
      return NextResponse.json(
        { error: "Customer does not belong to this tenant" },
        { status: 403, headers: CORS_HEADERS }
      );
    }

    if (!customerOwnerUid || !canAccessWorkshopForAuth(gate.auth, customerOwnerUid)) {
      return NextResponse.json(
        { error: "Access denied" },
        { status: 403, headers: CORS_HEADERS }
      );
    }

    const parsed = parseVehicleDetailsBody(body as Record<string, unknown>);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400, headers: CORS_HEADERS });
    }

    const now = new Date();
    const col = db.collection(`customers/${customerId}/vehicles`);
    const existingSnap = await col.get();

    let matchId: string | null = null;
    let matchData: Record<string, unknown> | null = null;
    for (const doc of existingSnap.docs) {
      const data = doc.data() as Record<string, unknown>;
      if (isSameCustomerVehicle(data, parsed.payload as Record<string, unknown>)) {
        matchId = doc.id;
        matchData = data;
        break;
      }
    }

    if (matchId && matchData) {
      const merged = mergeVehicleFirestoreFields(matchData, {
        ...parsed.payload,
        updatedAt: now,
      });
      if (!merged.createdAt) merged.createdAt = matchData.createdAt ?? now;
      if (!merged.createdBy) merged.createdBy = matchData.createdBy ?? actor.uid;
      await col.doc(matchId).set(merged, { merge: true });
      const saved = await col.doc(matchId).get();
      const vehicle = mapCustomerVehicleDoc(
        matchId,
        saved.data() as Record<string, unknown>
      );
      return NextResponse.json(
        {
          success: true,
          vehicleId: matchId,
          vehicle,
          updatedExisting: true,
        },
        { status: 200, headers: CORS_HEADERS }
      );
    }

    const vehicleData = {
      ...parsed.payload,
      createdAt: now,
      updatedAt: now,
      createdBy: actor.uid,
    };

    const ref = await col.add(vehicleData);

    const saved = await ref.get();
    const vehicle = mapCustomerVehicleDoc(
      ref.id,
      saved.data() as Record<string, unknown>
    );

    return NextResponse.json(
      { success: true, vehicleId: ref.id, vehicle, updatedExisting: false },
      { status: 201, headers: CORS_HEADERS }
    );
  } catch (error: any) {
    console.error("[call-center/customers/vehicles POST] Error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
