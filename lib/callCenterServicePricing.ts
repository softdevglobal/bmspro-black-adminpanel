import {
  isVehicleType,
  minPricingFromVehicleTypePricing,
  normalizeVehicleTypePricing,
  VEHICLE_TYPES,
  type VehicleType,
  type VehicleTypePricingMap,
} from "@/lib/services";

/**
 * Service pricing fields for call center / BMS public APIs.
 * Matches the book-now workshop payload: headline `price`/`duration` are the
 * “starting from” values when `vehicleTypePricing` is set; exact quotes use
 * `vehicleType` + `vehicleTypePricing` (or alias `pricingByVehicleType`).
 */
export type CallCenterServicePricingFields = {
  price: number;
  duration: number;
  vehicleTypes: VehicleType[];
  vehicleTypePricing: VehicleTypePricingMap;
  /** Same object as `vehicleTypePricing` — for integrations that prefer a `pricingBy*` field name. */
  pricingByVehicleType: VehicleTypePricingMap;
};

function vehicleTypesInCanonicalOrder(types: Set<VehicleType>): VehicleType[] {
  return VEHICLE_TYPES.filter((t) => types.has(t));
}

/**
 * Maps a Firestore `services` document to normalized type-wise pricing.
 */
export function serializeCallCenterServicePricing(
  data: Record<string, unknown>
): CallCenterServicePricingFields {
  const normalized = normalizeVehicleTypePricing(data.vehicleTypePricing);
  const min = minPricingFromVehicleTypePricing(normalized.vehicleTypePricing);
  const flatPrice = Number(data.price ?? 0) || 0;
  const flatDuration = Number(data.duration ?? 0) || 0;

  const raw = data.vehicleTypes;
  let vehicleTypes = normalized.vehicleTypes;
  if (Array.isArray(raw) && raw.length > 0) {
    const fromDoc = new Set(
      raw.filter((x): x is VehicleType => isVehicleType(x))
    );
    if (fromDoc.size > 0) {
      const pricingKeys = new Set(
        Object.keys(normalized.vehicleTypePricing) as VehicleType[]
      );
      if (pricingKeys.size > 0) {
        vehicleTypes = vehicleTypesInCanonicalOrder(
          new Set(
            [...fromDoc].filter((t) => pricingKeys.has(t))
          )
        );
      } else {
        vehicleTypes = vehicleTypesInCanonicalOrder(fromDoc);
      }
    }
  }

  return {
    price: min ? min.price : flatPrice,
    duration: min ? min.duration : flatDuration,
    vehicleTypes,
    vehicleTypePricing: normalized.vehicleTypePricing,
    pricingByVehicleType: normalized.vehicleTypePricing,
  };
}
