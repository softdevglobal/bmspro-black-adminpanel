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
