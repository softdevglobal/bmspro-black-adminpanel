import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";
import {
  verifyCallCenterOrTenantAdminAuth,
  canAccessWorkshopForAuth,
  getTenantId,
  CORS_HEADERS,
} from "@/lib/callCenterAuth";
import { mapCustomerVehicleDoc } from "@/lib/callCenterCustomerVehicles";

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

    const vehicles = vehiclesSnap.docs.map((doc) =>
      mapCustomerVehicleDoc(doc.id, doc.data() as Record<string, unknown>)
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
 * POST /api/call-center/customers/[customerId]/vehicles?ownerUid=X
 *
 * Add a vehicle to a customer's profile.
 * Body: { rego, make?, model?, year?, colour?, vin?, engineNumber?, bodyType? }
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

    if (!body.rego || typeof body.rego !== "string") {
      return NextResponse.json(
        { error: "Vehicle registration (rego) is required" },
        { status: 400, headers: CORS_HEADERS }
      );
    }

    const vehicleData = {
      rego: body.rego.trim(),
      make: body.make?.trim() || "",
      model: body.model?.trim() || "",
      year: body.year?.toString().trim() || "",
      colour: body.colour?.trim() || "",
      vin: body.vin?.trim() || "",
      engineNumber: body.engineNumber?.trim() || "",
      bodyType: body.bodyType?.trim() || "",
      createdAt: new Date(),
      createdBy: actor.uid,
    };

    const ref = await db
      .collection(`customers/${customerId}/vehicles`)
      .add(vehicleData);

    return NextResponse.json(
      { success: true, vehicleId: ref.id },
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
