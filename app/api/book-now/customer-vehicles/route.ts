import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";
import { FieldValue } from "firebase-admin/firestore";
import {
  dedupeVehiclesByIdentity,
  isSameCustomerVehicle,
  mergeVehicleFirestoreFields,
  normalizeVehicleType,
} from "@/lib/callCenterCustomerVehicles";

export const runtime = "nodejs";

type VehicleInput = {
  registrationNumber?: string;
  make?: string;
  model?: string;
  year?: string;
  mileage?: string;
  bodyType?: string;
  /** Canonical size class used for vehicle-type pricing (small_car | sedan_wagon | suv | ute_van_4wd | performance_large). */
  vehicleType?: string;
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

    const vehiclesSnap = await db
      .collection("customers")
      .doc(customerId)
      .collection("vehicles")
      .orderBy("createdAt", "desc")
      .get();
    const vehicles = dedupeVehiclesByIdentity(
      vehiclesSnap.docs.map((d) => {
        const data = d.data();
        return {
          id: d.id,
          registrationNumber: data.registrationNumber || data.vehicleNumber || "",
          make: data.make || "",
          model: data.model || "",
          year: data.year || "",
          mileage: data.mileage || "",
          bodyType: data.bodyType || "",
          vehicleType: normalizeVehicleType(data.vehicleType) || "",
          colour: data.colour || "",
          vinChassis: data.vinChassis || "",
          engineNumber: data.engineNumber || "",
          createdAt: data.createdAt,
        };
      }) as (Record<string, unknown> & { id: string })[]
    );

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
    const { customerId, slug, registrationNumber, make, model, year, mileage, bodyType, vehicleType, colour, vinChassis, engineNumber } = body;
    const normalizedType = normalizeVehicleType(vehicleType);

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

    const col = db.collection("customers").doc(customerId).collection("vehicles");
    const existingSnap = await col.get();

    const vehicleData: Record<string, unknown> = {
      registrationNumber: (registrationNumber || "").trim() || null,
      vehicleNumber: (registrationNumber || "").trim() || null,
      make: (make || "").trim() || null,
      model: (model || "").trim() || null,
      year: (year || "").trim() || null,
      mileage: (mileage || "").trim() || null,
      bodyType: (bodyType || "").trim() || null,
      vehicleType: normalizedType || null,
      colour: (colour || "").trim() || null,
      vinChassis: (vinChassis || "").trim() || null,
      vin: (vinChassis || "").trim() || null,
      engineNumber: (engineNumber || "").trim() || null,
      updatedAt: FieldValue.serverTimestamp(),
    };

    const incomingForMatch: Record<string, unknown> = {
      registrationNumber: (registrationNumber || "").trim(),
      vehicleNumber: (registrationNumber || "").trim(),
      vinChassis: (vinChassis || "").trim(),
      vin: (vinChassis || "").trim(),
    };

    let matchId: string | null = null;
    let matchData: Record<string, unknown> | null = null;
    for (const doc of existingSnap.docs) {
      const data = doc.data() as Record<string, unknown>;
      if (isSameCustomerVehicle(data, incomingForMatch)) {
        matchId = doc.id;
        matchData = data;
        break;
      }
    }

    if (matchId && matchData) {
      const merged = mergeVehicleFirestoreFields(matchData, vehicleData);
      merged.updatedAt = FieldValue.serverTimestamp();
      if (!merged.createdAt) merged.createdAt = matchData.createdAt ?? FieldValue.serverTimestamp();
      await col.doc(matchId).set(merged, { merge: true });
      const saved = (await col.doc(matchId).get()).data()!;
      return NextResponse.json({
        id: matchId,
        registrationNumber: saved.registrationNumber ?? saved.vehicleNumber ?? "",
        make: saved.make ?? "",
        model: saved.model ?? "",
        year: saved.year ?? "",
        mileage: saved.mileage ?? "",
        bodyType: saved.bodyType ?? "",
        vehicleType: normalizeVehicleType(saved.vehicleType) || "",
        colour: saved.colour ?? "",
        vinChassis: saved.vinChassis ?? "",
        engineNumber: saved.engineNumber ?? "",
        createdAt: saved.createdAt,
        updatedExisting: true,
      });
    }

    const toAdd = {
      ...vehicleData,
      createdAt: FieldValue.serverTimestamp(),
    };

    const ref = await col.add(toAdd);

    return NextResponse.json({
      id: ref.id,
      registrationNumber: (registrationNumber || "").trim(),
      make: (make || "").trim(),
      model: (model || "").trim(),
      year: (year || "").trim(),
      mileage: (mileage || "").trim(),
      bodyType: (bodyType || "").trim(),
      vehicleType: normalizedType || "",
      colour: (colour || "").trim(),
      vinChassis: (vinChassis || "").trim(),
      engineNumber: (engineNumber || "").trim(),
      createdAt: new Date().toISOString(),
      updatedExisting: false,
    });
  } catch (e) {
    console.error("Error adding customer vehicle:", e);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
