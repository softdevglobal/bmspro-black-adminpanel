/**
 * Pure vehicle identity / merge / parsing helpers that are safe to import from
 * BOTH client and server code (no firebase-admin imports live in this file).
 *
 * The server-only write helper `upsertCustomerVehicleFromBooking` lives in
 * `callCenterCustomerVehiclesServer.ts` so it never gets pulled into the
 * browser bundle through transitive imports.
 */

import { isVehicleType, type VehicleType } from "./services";

/** Coerce free-form input into a canonical VehicleType size class (small_car, suv, etc.)
 * so the wrong values never get persisted to Firestore. Returns "" when not valid. */
export function normalizeVehicleType(raw: unknown): VehicleType | "" {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  return isVehicleType(trimmed) ? (trimmed as VehicleType) : "";
}

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

  const vehicleType = normalizeVehicleType(merged.vehicleType);

  const payload: Record<string, unknown> = {
    rego,
    registrationNumber: str(merged, "registrationNumber") || rego,
    vehicleNumber: rego,
    make: str(merged, "make"),
    model: str(merged, "model"),
    year: str(merged, "year"),
    colour: str(merged, "colour"),
    bodyType: str(merged, "bodyType"),
    vehicleType,
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
    vehicleType: normalizeVehicleType(d.vehicleType),
    mileage: d.mileage != null ? String(d.mileage) : "",
    notes: String((d.notes as string) ?? ""),
    createdAt: d.createdAt ?? null,
    updatedAt: d.updatedAt ?? null,
  };
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
