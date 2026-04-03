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
