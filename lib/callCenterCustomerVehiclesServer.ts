import type { Firestore } from "firebase-admin/firestore";
import { FieldValue } from "firebase-admin/firestore";

import {
  isSameCustomerVehicle,
  mergeVehicleFirestoreFields,
  normalizeVehicleType,
} from "./callCenterCustomerVehicles";

/**
 * Vehicle fields as captured on a booking document (admin panel, mobile app,
 * and call-center all share this shape). Provided as an input type for
 * `upsertCustomerVehicleFromBooking` so callers can spread the booking payload
 * directly without re-mapping keys.
 */
export type BookingVehicleInput = {
  vehicleNumber?: string | null;
  vehicleMake?: string | null;
  vehicleModel?: string | null;
  vehicleYear?: string | null;
  vehicleMileage?: string | null;
  vehicleBodyType?: string | null;
  /** Canonical vehicle size class used for per-type pricing. */
  vehicleType?: string | null;
  vehicleColour?: string | null;
  vehicleVinChassis?: string | null;
  vehicleEngineNumber?: string | null;
};

/**
 * Add the vehicle captured on a new booking to the customer's `vehicles`
 * subcollection so it shows up in "My Vehicles" on the booking engine and in
 * the customer profile. Dedupes against existing vehicles using rego and/or
 * VIN plus vehicle size class (`vehicleType`) — see `isSameCustomerVehicle`.
 * the same identity rules as the rest of the system, and merges missing
 * fields into any matching existing record.
 *
 * Returns `{ saved: false }` (non-throwing) when:
 *   • No customerId (customer resolution failed upstream).
 *   • No rego AND no VIN on the booking (nothing to identify the vehicle by).
 *   • Customer doc missing or belongs to a different workshop.
 *
 * Callers should treat this as a best-effort side-effect — never block the
 * booking response if it fails.
 *
 * NOTE: This module imports `firebase-admin/firestore` and MUST only ever be
 * imported from server-side code (API routes, server actions). Client
 * components should import pure helpers from `./callCenterCustomerVehicles`
 * instead.
 */
export async function upsertCustomerVehicleFromBooking(
  db: Firestore,
  args: {
    customerId: string | null | undefined;
    ownerUid: string;
    createdByUid?: string | null;
    vehicle: BookingVehicleInput;
  },
): Promise<{
  saved: boolean;
  vehicleId?: string;
  updatedExisting?: boolean;
  reason?:
    | "no_customer_id"
    | "no_identifier"
    | "customer_not_found"
    | "owner_mismatch";
}> {
  const { customerId, ownerUid, createdByUid, vehicle } = args;
  if (!customerId) return { saved: false, reason: "no_customer_id" };

  const rego = String(vehicle.vehicleNumber ?? "").trim();
  const vin = String(vehicle.vehicleVinChassis ?? "").trim();
  if (!rego && !vin) {
    return { saved: false, reason: "no_identifier" };
  }

  const custSnap = await db.doc(`customers/${customerId}`).get();
  if (!custSnap.exists) return { saved: false, reason: "customer_not_found" };
  if ((custSnap.data()?.ownerUid as string | undefined) !== ownerUid) {
    return { saved: false, reason: "owner_mismatch" };
  }

  const trimOrNull = (v: string | null | undefined): string | null => {
    const s = String(v ?? "").trim();
    return s.length > 0 ? s : null;
  };

  const normalizedType = normalizeVehicleType(vehicle.vehicleType);
  const payload: Record<string, unknown> = {
    rego: rego || null,
    registrationNumber: rego || null,
    vehicleNumber: rego || null,
    make: trimOrNull(vehicle.vehicleMake),
    model: trimOrNull(vehicle.vehicleModel),
    year: trimOrNull(vehicle.vehicleYear),
    mileage: trimOrNull(vehicle.vehicleMileage),
    bodyType: trimOrNull(vehicle.vehicleBodyType),
    vehicleType: normalizedType || null,
    colour: trimOrNull(vehicle.vehicleColour),
    vin: vin || null,
    vinChassis: vin || null,
    engineNumber: trimOrNull(vehicle.vehicleEngineNumber),
    updatedAt: FieldValue.serverTimestamp(),
  };

  const incomingForMatch: Record<string, unknown> = {
    registrationNumber: rego,
    vehicleNumber: rego,
    vinChassis: vin,
    vin,
    vehicleType: normalizedType || null,
  };

  const col = db.collection(`customers/${customerId}/vehicles`);
  const existingSnap = await col.get();
  for (const doc of existingSnap.docs) {
    const data = doc.data() as Record<string, unknown>;
    if (isSameCustomerVehicle(data, incomingForMatch)) {
      const merged = mergeVehicleFirestoreFields(data, payload);
      merged.updatedAt = FieldValue.serverTimestamp();
      if (!merged.createdAt) {
        merged.createdAt = data.createdAt ?? FieldValue.serverTimestamp();
      }
      if (!merged.createdBy && createdByUid) {
        merged.createdBy = data.createdBy ?? createdByUid;
      }
      await col.doc(doc.id).set(merged, { merge: true });
      return { saved: true, vehicleId: doc.id, updatedExisting: true };
    }
  }

  const toAdd: Record<string, unknown> = {
    ...payload,
    createdAt: FieldValue.serverTimestamp(),
    createdBy: createdByUid ?? null,
  };
  const ref = await col.add(toAdd);
  return { saved: true, vehicleId: ref.id, updatedExisting: false };
}
