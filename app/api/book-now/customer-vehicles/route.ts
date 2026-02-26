import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";
import { FieldValue } from "firebase-admin/firestore";

export const runtime = "nodejs";

type VehicleInput = {
  registrationNumber?: string;
  make?: string;
  model?: string;
  year?: string;
  mileage?: string;
  bodyType?: string;
  colour?: string;
  vinChassis?: string;
  engineNumber?: string;
};

/**
 * GET /api/book-now/customer-vehicles?customerId=xxx&slug=yyy
 * List vehicles for a customer (scoped to workshop by slug)
 */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const customerId = searchParams.get("customerId");
    const slug = searchParams.get("slug");

    if (!customerId || !slug) {
      return NextResponse.json({ error: "customerId and slug are required" }, { status: 400 });
    }

    const db = adminDb();

    // Resolve ownerUid from slug
    const usersSnap = await db.collection("users").where("slug", "==", slug).where("role", "==", "workshop_owner").limit(1).get();
    if (usersSnap.empty) {
      return NextResponse.json({ error: "Workshop not found" }, { status: 404 });
    }
    const ownerUid = usersSnap.docs[0].id;

    // Verify customer belongs to this workshop
    const customerDoc = await db.collection("customers").doc(customerId).get();
    if (!customerDoc.exists) {
      return NextResponse.json({ error: "Customer not found" }, { status: 404 });
    }
    const customerData = customerDoc.data();
    if (customerData?.ownerUid !== ownerUid) {
      return NextResponse.json({ error: "Customer not found for this workshop" }, { status: 403 });
    }

    const vehiclesSnap = await db.collection("customers").doc(customerId).collection("vehicles").orderBy("createdAt", "desc").get();
    const vehicles = vehiclesSnap.docs.map((d) => {
      const data = d.data();
      return {
        id: d.id,
        registrationNumber: data.registrationNumber || data.vehicleNumber || "",
        make: data.make || "",
        model: data.model || "",
        year: data.year || "",
        mileage: data.mileage || "",
        bodyType: data.bodyType || "",
        colour: data.colour || "",
        vinChassis: data.vinChassis || "",
        engineNumber: data.engineNumber || "",
        createdAt: data.createdAt,
      };
    });

    return NextResponse.json({ vehicles });
  } catch (e) {
    console.error("Error listing customer vehicles:", e);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

/**
 * POST /api/book-now/customer-vehicles
 * Add a new vehicle for a customer
 * Body: { customerId, slug, registrationNumber?, bodyType?, colour?, vinChassis?, engineNumber? }
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { customerId: string; slug: string } & VehicleInput;
    const { customerId, slug, registrationNumber, make, model, year, mileage, bodyType, colour, vinChassis, engineNumber } = body;

    if (!customerId || !slug) {
      return NextResponse.json({ error: "customerId and slug are required" }, { status: 400 });
    }

    const db = adminDb();

    // Resolve ownerUid from slug
    const usersSnap = await db.collection("users").where("slug", "==", slug).where("role", "==", "workshop_owner").limit(1).get();
    if (usersSnap.empty) {
      return NextResponse.json({ error: "Workshop not found" }, { status: 404 });
    }
    const ownerUid = usersSnap.docs[0].id;

    // Verify customer belongs to this workshop
    const customerDoc = await db.collection("customers").doc(customerId).get();
    if (!customerDoc.exists) {
      return NextResponse.json({ error: "Customer not found" }, { status: 404 });
    }
    const customerData = customerDoc.data();
    if (customerData?.ownerUid !== ownerUid) {
      return NextResponse.json({ error: "Customer not found for this workshop" }, { status: 403 });
    }

    const vehicleData = {
      registrationNumber: (registrationNumber || "").trim() || null,
      make: (make || "").trim() || null,
      model: (model || "").trim() || null,
      year: (year || "").trim() || null,
      mileage: (mileage || "").trim() || null,
      bodyType: (bodyType || "").trim() || null,
      colour: (colour || "").trim() || null,
      vinChassis: (vinChassis || "").trim() || null,
      engineNumber: (engineNumber || "").trim() || null,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };

    const ref = await db.collection("customers").doc(customerId).collection("vehicles").add(vehicleData);

    return NextResponse.json({
      id: ref.id,
      ...vehicleData,
      createdAt: new Date().toISOString(),
    });
  } catch (e) {
    console.error("Error adding customer vehicle:", e);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
