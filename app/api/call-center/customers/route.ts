import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";
import {
  verifyCallCenterOrTenantAdminAuth,
  canAccessWorkshopForAuth,
  getTenantId,
  CORS_HEADERS,
} from "@/lib/callCenterAuth";

export const runtime = "nodejs";

export async function OPTIONS() {
  return NextResponse.json({}, { headers: CORS_HEADERS });
}

/**
 * GET /api/call-center/customers?ownerUid=X&q=searchTerm
 *
 * Search customers by phone number, email, or name within a workshop's scope.
 * The `q` parameter is matched against phone, email, and name fields.
 * Optionally pass `searchBy=phone|email|name` to restrict matching.
 *
 * Returns: array of matched customers with basic info.
 */
export async function GET(req: NextRequest) {
  const gate = await verifyCallCenterOrTenantAdminAuth(req);
  if (!gate.success) {
    return NextResponse.json(
      { error: gate.error },
      { status: gate.status || 401, headers: CORS_HEADERS }
    );
  }

  const ownerUid = getTenantId(req);
  if (!ownerUid) {
    return NextResponse.json(
      { error: "Missing ownerUid or X-Tenant-Id header" },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  if (!canAccessWorkshopForAuth(gate.auth, ownerUid)) {
    return NextResponse.json(
      { error: "Access denied to this workshop" },
      { status: 403, headers: CORS_HEADERS }
    );
  }

  const q = (req.nextUrl.searchParams.get("q") || "").trim().toLowerCase();
  const searchBy = req.nextUrl.searchParams.get("searchBy"); // phone | email | name

  if (!q) {
    return NextResponse.json(
      { error: "Missing search query 'q'" },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  try {
    const db = adminDb();

    // Fetch customers for this workshop
    const custSnap = await db
      .collection("customers")
      .where("ownerUid", "==", ownerUid)
      .get();

    const results: any[] = [];
    const normalizedQ = q.replace(/[\s\-\(\)]/g, "");

    for (const doc of custSnap.docs) {
      const d = doc.data();
      const name = (d.name || d.client || "").toString().toLowerCase();
      const email = (d.email || "").toString().toLowerCase();
      const phone = (d.phone || d.clientPhone || "").toString().replace(/[\s\-\(\)]/g, "");

      let matched = false;

      if (!searchBy || searchBy === "phone") {
        if (phone && phone.includes(normalizedQ)) matched = true;
      }
      if (!searchBy || searchBy === "email") {
        if (email && email.includes(q)) matched = true;
      }
      if (!searchBy || searchBy === "name") {
        if (name && name.includes(q)) matched = true;
      }

      if (matched) {
        results.push({
          id: doc.id,
          name: d.name || d.client || "",
          email: d.email || "",
          phone: d.phone || d.clientPhone || "",
          vehicleNumber: d.vehicleNumber || d.vehicleRego || "",
          createdAt: d.createdAt || null,
        });
      }

      if (results.length >= 50) break;
    }

    // Also search bookings for customers not in the customers collection
    if (results.length < 50) {
      const bookingSnap = await db
        .collection("bookings")
        .where("ownerUid", "==", ownerUid)
        .get();

      const existingKeys = new Set(
        results.map((r) =>
          (r.email || r.phone || r.name).toLowerCase()
        )
      );

      for (const doc of bookingSnap.docs) {
        const d = doc.data();
        const clientName = (d.client || d.clientName || "").toString().toLowerCase();
        const clientEmail = (d.clientEmail || "").toString().toLowerCase();
        const clientPhone = (d.clientPhone || "").toString().replace(/[\s\-\(\)]/g, "");

        const key = (clientEmail || clientPhone || clientName).toLowerCase();
        if (existingKeys.has(key)) continue;

        let matched = false;
        if (!searchBy || searchBy === "phone") {
          if (clientPhone && clientPhone.includes(normalizedQ)) matched = true;
        }
        if (!searchBy || searchBy === "email") {
          if (clientEmail && clientEmail.includes(q)) matched = true;
        }
        if (!searchBy || searchBy === "name") {
          if (clientName && clientName.includes(q)) matched = true;
        }

        if (matched) {
          existingKeys.add(key);
          results.push({
            id: null,
            name: d.client || d.clientName || "",
            email: d.clientEmail || "",
            phone: d.clientPhone || "",
            vehicleNumber: d.vehicleNumber || "",
            createdAt: d.createdAt || null,
            source: "booking",
          });
        }

        if (results.length >= 50) break;
      }
    }

    return NextResponse.json(
      { customers: results, total: results.length },
      { headers: CORS_HEADERS }
    );
  } catch (error: any) {
    console.error("[call-center/customers GET] Error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}

/**
 * POST /api/call-center/customers
 *
 * Create a new customer record for a workshop.
 *
 * Body: {
 *   ownerUid: string,
 *   name: string,
 *   email?: string,
 *   phone?: string,
 *   vehicleNumber?: string,
 *   vehicleDetails?: { make, model, year, colour, vin, engineNumber },
 *   notes?: string,
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
    const actor =
      gate.auth.kind === "agent"
        ? { uid: gate.auth.user.uid, name: gate.auth.user.name }
        : { uid: gate.auth.uid, name: gate.auth.name };
    const createdByRole =
      gate.auth.kind === "agent" ? "call_center_agent" : gate.auth.role;

    const body = await req.json();
    const {
      ownerUid,
      name,
      email,
      phone,
      vehicleNumber,
      vehicleDetails,
      notes,
    } = body;

    if (!ownerUid) {
      return NextResponse.json(
        { error: "Missing ownerUid" },
        { status: 400, headers: CORS_HEADERS }
      );
    }

    if (!canAccessWorkshopForAuth(gate.auth, ownerUid)) {
      return NextResponse.json(
        { error: "Access denied to this workshop" },
        { status: 403, headers: CORS_HEADERS }
      );
    }

    if (!name || typeof name !== "string") {
      return NextResponse.json(
        { error: "Customer name is required" },
        { status: 400, headers: CORS_HEADERS }
      );
    }

    const db = adminDb();

    // Duplicate check by email or phone
    if (email || phone) {
      const custSnap = await db
        .collection("customers")
        .where("ownerUid", "==", ownerUid)
        .get();

      for (const doc of custSnap.docs) {
        const d = doc.data();
        if (
          email &&
          (d.email || "").toString().toLowerCase() === email.toLowerCase()
        ) {
          return NextResponse.json(
            {
              error: "Customer with this email already exists",
              existingCustomerId: doc.id,
            },
            { status: 409, headers: CORS_HEADERS }
          );
        }
        const existingPhone = (d.phone || d.clientPhone || "")
          .toString()
          .replace(/[\s\-\(\)]/g, "");
        const newPhone = (phone || "").replace(/[\s\-\(\)]/g, "");
        if (newPhone && existingPhone === newPhone) {
          return NextResponse.json(
            {
              error: "Customer with this phone already exists",
              existingCustomerId: doc.id,
            },
            { status: 409, headers: CORS_HEADERS }
          );
        }
      }
    }

    const now = new Date();
    const customerData: Record<string, any> = {
      ownerUid,
      name: name.trim(),
      client: name.trim(),
      email: email?.trim() || "",
      phone: phone?.trim() || "",
      vehicleNumber: vehicleNumber?.trim() || "",
      notes: notes?.trim() || "",
      createdAt: now,
      updatedAt: now,
      createdBy: actor.uid,
      createdByRole,
    };

    const customerRef = await db.collection("customers").add(customerData);

    // If vehicle details provided, create a vehicle sub-document
    if (vehicleDetails && vehicleNumber) {
      await db
        .collection("customers")
        .doc(customerRef.id)
        .collection("vehicles")
        .add({
          rego: vehicleNumber.trim(),
          make: vehicleDetails.make || "",
          model: vehicleDetails.model || "",
          year: vehicleDetails.year || "",
          colour: vehicleDetails.colour || "",
          vin: vehicleDetails.vin || "",
          engineNumber: vehicleDetails.engineNumber || "",
          bodyType: vehicleDetails.bodyType || "",
          createdAt: now,
        });
    }

    return NextResponse.json(
      {
        success: true,
        customerId: customerRef.id,
        name: name.trim(),
      },
      { status: 201, headers: CORS_HEADERS }
    );
  } catch (error: any) {
    console.error("[call-center/customers POST] Error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
