import type { Firestore } from "firebase-admin/firestore";
import { FieldValue } from "firebase-admin/firestore";

/** Strip spaces/dashes and uppercase — same plate should dedupe across "ABF 3344" vs "abf-3344". */
export function normalizeVehicleRego(raw: string): string {
  return raw.replace(/[\s-]/g, "").toUpperCase();
}

/** Trim + uppercase + strip internal spaces (VINs are sometimes spaced). */
export function normalizeVehicleVin(raw: string): string {
  return raw.replace(/\s/g, "").toUpperCase();
}

const MIN_VIN_LEN_FOR_MATCH = 5;

/** Normalized rego + vin from any vehicle subdoc shape (call-center, book-now, legacy). */
export function regoVinFromVehicleData(d: Record<string, unknown>): {
  rego: string;
  vin: string;
} {
  const regoRaw = String(
    d.rego ?? d.registrationNumber ?? d.vehicleNumber ?? ""
  ).trim();
  const vinRaw = String(d.vin ?? d.vinChassis ?? "").trim();
  return {
    rego: regoRaw ? normalizeVehicleRego(regoRaw) : "",
    vin: vinRaw ? normalizeVehicleVin(vinRaw) : "",
  };
}

/** True when two stored / incoming payloads describe the same car (same plate or same VIN). */
export function isSameCustomerVehicle(
  a: Record<string, unknown>,
  b: Record<string, unknown>
): boolean {
  const A = regoVinFromVehicleData(a);
  const B = regoVinFromVehicleData(b);
  if (A.rego && B.rego && A.rego === B.rego) return true;
  if (
    A.vin.length >= MIN_VIN_LEN_FOR_MATCH &&
    B.vin.length >= MIN_VIN_LEN_FOR_MATCH &&
    A.vin === B.vin
  ) {
    return true;
  }
  return false;
}

/** Merge non-empty fields from `incoming` into `existing` (Firestore vehicle doc). */
export function mergeVehicleFirestoreFields(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...existing };
  for (const [key, val] of Object.entries(incoming)) {
    if (val === undefined || val === null) continue;
    if (typeof val === "string" && val.trim() === "") continue;
    out[key] = val;
  }
  return out;
}

/**
 * Collapse duplicate vehicle rows (same rego or same VIN). Keeps the first occurrence;
 * merges missing display fields from later duplicates for richer UI.
 */
export function dedupeVehiclesByIdentity<
  T extends Record<string, unknown> & { id: string }
>(rows: T[]): T[] {
  const byKey = new Map<string, T>();
  for (const row of rows) {
    const { rego, vin } = regoVinFromVehicleData(row);
    const key = rego ? `r:${rego}` : vin.length >= MIN_VIN_LEN_FOR_MATCH ? `v:${vin}` : `id:${row.id}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { ...row });
      continue;
    }
    const merged = { ...prev } as T;
    for (const k of Object.keys(row)) {
      if (k === "id") continue;
      const a = merged[k];
      const b = row[k];
      const aEmpty =
        a === undefined ||
        a === null ||
        (typeof a === "string" && String(a).trim() === "");
      if (aEmpty && b !== undefined && b !== null && String(b).trim() !== "") {
        (merged as Record<string, unknown>)[k] = b;
      }
    }
    byKey.set(key, merged);
  }
  return Array.from(byKey.values());
}

/** Parse string/number fields from JSON body. */
function str(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" && !Number.isNaN(v)) return String(v);
  return "";
}

/**
 * Build Firestore payload for `customers/{cid}/vehicles` from API request body.
 * Accepts rego | registrationNumber | vehicleNumber; optional book-now aliases (vinChassis, etc.).
 */
export function parseVehicleDetailsBody(body: Record<string, unknown>): {
  ok: true;
  payload: Record<string, unknown>;
} | { ok: false; error: string } {
  const nested =
    body.vehicleDetails && typeof body.vehicleDetails === "object" && body.vehicleDetails !== null
      ? (body.vehicleDetails as Record<string, unknown>)
      : {};

  const { vehicleDetails: _vd, ownerUid: _ou, ...topLevel } = body;
  const merged: Record<string, unknown> = { ...nested, ...topLevel };

  const rego =
    str(merged, "rego") ||
    str(merged, "registrationNumber") ||
    str(merged, "vehicleNumber");

  if (!rego) {
    return {
      ok: false,
      error:
        "Provide rego, registrationNumber, or vehicleNumber (and optional make, model, year, colour, vin, vinChassis, engineNumber, bodyType, mileage, notes). You may nest fields under vehicleDetails.",
    };
  }

  const vin = str(merged, "vin") || str(merged, "vinChassis");
  const vinChassis = str(merged, "vinChassis") || str(merged, "vin");

  const payload: Record<string, unknown> = {
    rego,
    registrationNumber: str(merged, "registrationNumber") || rego,
    vehicleNumber: rego,
    make: str(merged, "make"),
    model: str(merged, "model"),
    year: str(merged, "year"),
    colour: str(merged, "colour"),
    bodyType: str(merged, "bodyType"),
    engineNumber: str(merged, "engineNumber"),
    mileage: str(merged, "mileage"),
    notes: str(merged, "notes"),
    vin: vin || vinChassis,
    vinChassis: vinChassis || vin,
  };

  return { ok: true, payload };
}

/**
 * Normalize a vehicle document from `customers/{id}/vehicles/{vehicleId}` for call-center APIs.
 * Merges field name variants used by book-now vs call-center POST.
 */
export function mapCustomerVehicleDoc(
  docId: string,
  d: Record<string, unknown>
): Record<string, unknown> {
  const rego =
    (d.rego as string) ||
    (d.registrationNumber as string) ||
    (d.vehicleNumber as string) ||
    "";
  const vin =
    (d.vin as string) || (d.vinChassis as string) || "";
  return {
    id: docId,
    rego,
    registrationNumber: (d.registrationNumber as string) || rego,
    make: String(d.make ?? ""),
    model: String(d.model ?? ""),
    year: d.year != null ? String(d.year) : "",
    colour: String(d.colour ?? ""),
    vin,
    vinChassis: String(d.vinChassis ?? d.vin ?? ""),
    engineNumber: String(d.engineNumber ?? ""),
    bodyType: String(d.bodyType ?? ""),
    mileage: d.mileage != null ? String(d.mileage) : "",
    notes: String((d.notes as string) ?? ""),
    createdAt: d.createdAt ?? null,
    updatedAt: d.updatedAt ?? null,
  };
}

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
  vehicleColour?: string | null;
  vehicleVinChassis?: string | null;
  vehicleEngineNumber?: string | null;
};

/**
 * Add the vehicle captured on a new booking to the customer's `vehicles`
 * subcollection so it shows up in "My Vehicles" on the booking engine and in
 * the customer profile. Dedupes against existing vehicles by rego / VIN using
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

  const payload: Record<string, unknown> = {
    rego: rego || null,
    registrationNumber: rego || null,
    vehicleNumber: rego || null,
    make: trimOrNull(vehicle.vehicleMake),
    model: trimOrNull(vehicle.vehicleModel),
    year: trimOrNull(vehicle.vehicleYear),
    mileage: trimOrNull(vehicle.vehicleMileage),
    bodyType: trimOrNull(vehicle.vehicleBodyType),
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

/** Vehicle-related fields sometimes stored on the parent customer document. */
export function vehicleDetailsFromCustomerDoc(cust: Record<string, unknown>): {
  make: string;
  model: string;
  year: string;
  colour: string;
  vin: string;
  engineNumber: string;
  bodyType: string;
  mileage: string;
} {
  const nested = cust["vehicleDetails"];
  const v =
    nested && typeof nested === "object" && nested !== null
      ? (nested as Record<string, unknown>)
      : {};

  return {
    make: String(v["make"] ?? cust["vehicleMake"] ?? ""),
    model: String(v["model"] ?? cust["vehicleModel"] ?? ""),
    year: String(v["year"] ?? cust["vehicleYear"] ?? ""),
    colour: String(v["colour"] ?? cust["vehicleColour"] ?? ""),
    vin: String(
      v["vin"] ??
        v["vinChassis"] ??
        cust["vehicleVin"] ??
        cust["vehicleVinChassis"] ??
        ""
    ),
    engineNumber: String(v["engineNumber"] ?? cust["vehicleEngineNumber"] ?? ""),
    bodyType: String(v["bodyType"] ?? cust["vehicleBodyType"] ?? ""),
    mileage: String(v["mileage"] ?? cust["vehicleMileage"] ?? ""),
  };
}
