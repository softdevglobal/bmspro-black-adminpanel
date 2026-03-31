import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";
import {
  verifyCallCenterAuth,
  canAccessWorkshop,
  getTenantId,
  CORS_HEADERS,
} from "@/lib/callCenterAuth";

export const runtime = "nodejs";

export async function OPTIONS() {
  return NextResponse.json({}, { headers: CORS_HEADERS });
}

/**
 * GET /api/call-center/customers/[customerId]/vehicles?ownerUid=X
 *
 * List all registered vehicles for a customer.
 */
export async function GET(
  req: NextRequest,
  context: { params: Promise<{ customerId: string }> }
) {
  const auth = await verifyCallCenterAuth(req);
  if (!auth.success || !auth.user) {
    return NextResponse.json(
      { error: auth.error },
      { status: auth.status || 401, headers: CORS_HEADERS }
    );
  }

  const { customerId } = await context.params;
  const ownerUid = getTenantId(req);

  if (!ownerUid) {
    return NextResponse.json(
      { error: "Missing ownerUid" },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  if (!canAccessWorkshop(auth.user, ownerUid)) {
    return NextResponse.json(
      { error: "Access denied" },
      { status: 403, headers: CORS_HEADERS }
    );
  }

  try {
    const db = adminDb();

    // Verify customer belongs to this workshop
    const custDoc = await db.doc(`customers/${customerId}`).get();
    if (!custDoc.exists || custDoc.data()?.ownerUid !== ownerUid) {
      return NextResponse.json(
        { error: "Customer not found in this workshop" },
        { status: 404, headers: CORS_HEADERS }
      );
    }

    const vehiclesSnap = await db
      .collection(`customers/${customerId}/vehicles`)
      .get();

    const vehicles = vehiclesSnap.docs.map((doc) => {
      const d = doc.data();
      return {
        id: doc.id,
        rego: d.rego || d.vehicleNumber || "",
        make: d.make || "",
        model: d.model || "",
        year: d.year || "",
        colour: d.colour || "",
        vin: d.vin || "",
        engineNumber: d.engineNumber || "",
        bodyType: d.bodyType || "",
      };
    });

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
  const auth = await verifyCallCenterAuth(req);
  if (!auth.success || !auth.user) {
    return NextResponse.json(
      { error: auth.error },
      { status: auth.status || 401, headers: CORS_HEADERS }
    );
  }

  const { customerId } = await context.params;

  try {
    const body = await req.json();
    const ownerUid = body.ownerUid || getTenantId(req);

    if (!ownerUid) {
      return NextResponse.json(
        { error: "Missing ownerUid" },
        { status: 400, headers: CORS_HEADERS }
      );
    }

    if (!canAccessWorkshop(auth.user, ownerUid)) {
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

    const db = adminDb();

    const custDoc = await db.doc(`customers/${customerId}`).get();
    if (!custDoc.exists || custDoc.data()?.ownerUid !== ownerUid) {
      return NextResponse.json(
        { error: "Customer not found" },
        { status: 404, headers: CORS_HEADERS }
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
      createdBy: auth.user.uid,
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
