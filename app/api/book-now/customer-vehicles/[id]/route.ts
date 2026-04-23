import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";
import { FieldValue } from "firebase-admin/firestore";
import type { Firestore } from "firebase-admin/firestore";
import { normalizeVehicleType } from "@/lib/callCenterCustomerVehicles";

export const runtime = "nodejs";

type VehicleInput = {
  registrationNumber?: string;
  make?: string;
  model?: string;
  year?: string;
  mileage?: string;
  bodyType?: string;
  /** Canonical size class used for vehicle-type pricing. */
  vehicleType?: string;
  colour?: string;
  vinChassis?: string;
  engineNumber?: string;
};

async function verifyCustomerVehicle(db: Firestore, customerId: string, vehicleId: string, slug: string) {
  const usersSnap = await db.collection("users").where("slug", "==", slug).where("role", "==", "workshop_owner").limit(1).get();
  if (usersSnap.empty) return { error: "Workshop not found", status: 404 as const };
  const ownerUid = usersSnap.docs[0].id;

  const customerDoc = await db.collection("customers").doc(customerId).get();
  if (!customerDoc.exists) return { error: "Customer not found", status: 404 as const };
  const customerData = customerDoc.data();
  if (customerData?.ownerUid !== ownerUid) return { error: "Customer not found for this workshop", status: 403 as const };

  const vehicleRef = db.collection("customers").doc(customerId).collection("vehicles").doc(vehicleId);
  const vehicleSnap = await vehicleRef.get();
  if (!vehicleSnap.exists) return { error: "Vehicle not found", status: 404 as const };

  return { vehicleRef };
}

/**
 * PATCH /api/book-now/customer-vehicles/[id]
 * Update a vehicle
 * Body: { customerId, slug, registrationNumber?, bodyType?, colour?, vinChassis?, engineNumber? }
 */
export async function PATCH(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { id: vehicleId } = await context.params;
    const body = (await req.json()) as { customerId: string; slug: string } & VehicleInput;
    const { customerId, slug, registrationNumber, make, model, year, mileage, bodyType, vehicleType, colour, vinChassis, engineNumber } = body;

    if (!customerId || !slug || !vehicleId) {
      return NextResponse.json({ error: "customerId, slug, and vehicle id are required" }, { status: 400 });
    }

    const db = adminDb();
    const result = await verifyCustomerVehicle(db, customerId, vehicleId, slug);
    if ("error" in result) return NextResponse.json({ error: result.error }, { status: result.status });

    const { vehicleRef } = result;
    const updates: Record<string, any> = {
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (registrationNumber !== undefined) updates.registrationNumber = (registrationNumber || "").trim() || null;
    if (make !== undefined) updates.make = (make || "").trim() || null;
    if (model !== undefined) updates.model = (model || "").trim() || null;
    if (year !== undefined) updates.year = (year || "").trim() || null;
    if (mileage !== undefined) updates.mileage = (mileage || "").trim() || null;
    if (bodyType !== undefined) updates.bodyType = (bodyType || "").trim() || null;
    if (vehicleType !== undefined) updates.vehicleType = normalizeVehicleType(vehicleType) || null;
    if (colour !== undefined) updates.colour = (colour || "").trim() || null;
    if (vinChassis !== undefined) updates.vinChassis = (vinChassis || "").trim() || null;
    if (engineNumber !== undefined) updates.engineNumber = (engineNumber || "").trim() || null;

    await vehicleRef.update(updates);
    const updated = await vehicleRef.get();
    const data = updated.data();
    return NextResponse.json({
      id: vehicleId,
      registrationNumber: data?.registrationNumber || "",
      make: data?.make || "",
      model: data?.model || "",
      year: data?.year || "",
      mileage: data?.mileage || "",
      bodyType: data?.bodyType || "",
      vehicleType: normalizeVehicleType(data?.vehicleType) || "",
      colour: data?.colour || "",
      vinChassis: data?.vinChassis || "",
      engineNumber: data?.engineNumber || "",
    });
  } catch (e) {
    console.error("Error updating vehicle:", e);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

/**
 * DELETE /api/book-now/customer-vehicles/[id]
 * Delete a vehicle
 * Query: customerId, slug
 */
export async function DELETE(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { id: vehicleId } = await context.params;
    const { searchParams } = new URL(req.url);
    const customerId = searchParams.get("customerId");
    const slug = searchParams.get("slug");

    if (!customerId || !slug || !vehicleId) {
      return NextResponse.json({ error: "customerId, slug, and vehicle id are required" }, { status: 400 });
    }

    const db = adminDb();
    const result = await verifyCustomerVehicle(db, customerId, vehicleId, slug);
    if ("error" in result) return NextResponse.json({ error: result.error }, { status: result.status });

    const { vehicleRef } = result;
    await vehicleRef.delete();
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("Error deleting vehicle:", e);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
