import { db } from "@/lib/firebase";
import {
  addDoc,
  arrayRemove,
  arrayUnion,
  collection,
  deleteDoc,
  deleteField,
  doc,
  DocumentData,
  getDoc,
  onSnapshot,
  query,
  serverTimestamp,
  updateDoc,
  where,
} from "firebase/firestore";
import { 
  getCurrentUserForAudit, 
  logServiceCreated, 
  logServiceUpdated, 
  logServiceDeleted 
} from "@/lib/auditLog";

/** Which part of the vehicle a checklist task applies to. */
export type ChecklistSection = "interior" | "engine_bay" | "underbody" | "exterior";

export const CHECKLIST_SECTIONS: ChecklistSection[] = [
  "interior",
  "engine_bay",
  "underbody",
  "exterior",
];

export const CHECKLIST_SECTION_LABELS: Record<ChecklistSection, string> = {
  interior: "Interior",
  engine_bay: "Engine Bay",
  underbody: "Underbody",
  exterior: "Exterior",
};

export function isChecklistSection(value: unknown): value is ChecklistSection {
  return (
    typeof value === "string" &&
    (CHECKLIST_SECTIONS as readonly string[]).includes(value)
  );
}

/** Default ordering of area groups when an owner hasn't customised it. */
export const DEFAULT_AREA_ORDER: ChecklistSection[] = [...CHECKLIST_SECTIONS];

/**
 * Normalise an owner-customised area order read from Firestore.
 * - Keeps only valid `ChecklistSection` entries and dedupes.
 * - Appends any missing areas (in canonical order) so all four are always covered.
 */
export function normalizeAreaOrder(raw: unknown): ChecklistSection[] {
  const seen = new Set<ChecklistSection>();
  const out: ChecklistSection[] = [];
  if (Array.isArray(raw)) {
    for (const v of raw) {
      if (isChecklistSection(v) && !seen.has(v)) {
        seen.add(v);
        out.push(v);
      }
    }
  }
  for (const s of DEFAULT_AREA_ORDER) {
    if (!seen.has(s)) {
      out.push(s);
      seen.add(s);
    }
  }
  return out;
}

/** Group key for previews: fixed section order, then legacy rows without a section. */
export type ChecklistSectionGroupKey = ChecklistSection | "unset";

/** Group checklist items by vehicle area. Area order defaults to Interior → Engine Bay → Underbody → Exterior, but callers can pass a custom (owner-defined) order. Items without a section are grouped last under `unset`. */
export function groupChecklistItemsBySection(
  items: ChecklistItem[],
  order: ChecklistSection[] = DEFAULT_AREA_ORDER
): { key: ChecklistSectionGroupKey; items: ChecklistItem[] }[] {
  const effectiveOrder = normalizeAreaOrder(order);
  const buckets = new Map<ChecklistSection, ChecklistItem[]>();
  for (const s of effectiveOrder) buckets.set(s, []);
  const unset: ChecklistItem[] = [];
  for (const item of items) {
    if (isChecklistSection(item.section)) {
      buckets.get(item.section)!.push(item);
    } else {
      unset.push(item);
    }
  }
  const out: { key: ChecklistSectionGroupKey; items: ChecklistItem[] }[] = [];
  for (const s of effectiveOrder) {
    const arr = buckets.get(s)!;
    if (arr.length > 0) out.push({ key: s, items: arr });
  }
  if (unset.length > 0) out.push({ key: "unset", items: unset });
  return out;
}

/** Default section when older Firestore docs don't have one. */
export const DEFAULT_CHECKLIST_SECTION: ChecklistSection = "interior";

export type ChecklistItem = {
  name: string;
  description: string;
  done: boolean;
  /** Which part of the vehicle this task applies to. Omitted on legacy docs until the user picks one in the UI. */
  section?: ChecklistSection;
  /** Only on booking `tasks` (staff completion photos). Not stored on service templates. */
  imageUrl?: string;
};

/** Area groups with a single global 1-based task index (customer-facing lists). Honors a custom area order if provided. */
export function groupChecklistItemsWithGlobalNumbers(
  items: ChecklistItem[],
  order: ChecklistSection[] = DEFAULT_AREA_ORDER
): { key: ChecklistSectionGroupKey; items: { item: ChecklistItem; num: number }[] }[] {
  let n = 0;
  return groupChecklistItemsBySection(items, order).map((group) => ({
    key: group.key,
    items: group.items.map((item) => ({ item, num: ++n })),
  }));
}

/** Service checklist rows in Firestore: name, description, done, section (no per-task images). */
export type ServiceTemplateChecklistItem = {
  name: string;
  description: string;
  done: boolean;
  /** Only persisted when the user explicitly picked an area; missing on legacy docs. */
  section?: ChecklistSection;
};

export function templateChecklistForFirestore(
  items: ChecklistItem[] | undefined
): ServiceTemplateChecklistItem[] {
  if (!items?.length) return [];
  return items
    .filter((item) => item.name.trim() !== "")
    .map((item) => {
      const base: ServiceTemplateChecklistItem = {
        name: item.name.trim(),
        description: (item.description || "").trim(),
        done: !!item.done,
      };
      if (isChecklistSection(item.section)) base.section = item.section;
      return base;
    });
}

export const normalizeChecklist = (raw: any[]): ChecklistItem[] =>
  (raw || []).map((item) => {
    if (typeof item === "string") {
      return {
        name: item,
        description: "",
        done: false,
      };
    }
    const rawSection = (item as any)?.section;
    return {
      name: item.name || "",
      description: item.description || "",
      done: !!item.done,
      ...(isChecklistSection(rawSection) ? { section: rawSection } : {}),
    };
  });

/**
 * Vehicle categories used for size-based pricing + timing on workshop-owner
 * services. Ordered light → heavy so pickers render consistently everywhere
 * (admin services form, booking flow, customer quotation emails, etc.).
 *
 * NOT applied to super-admin `default_services` templates — those stay as
 * single-price / single-duration records that owners can clone and then
 * customise per vehicle type.
 */
export type VehicleType =
  | "small_car"
  | "sedan_wagon"
  | "suv"
  | "ute_van_4wd"
  | "performance_large";

export const VEHICLE_TYPES: VehicleType[] = [
  "small_car",
  "sedan_wagon",
  "suv",
  "ute_van_4wd",
  "performance_large",
];

export const VEHICLE_TYPE_LABELS: Record<VehicleType, string> = {
  small_car: "Small Car",
  sedan_wagon: "Sedan / Wagon",
  suv: "SUV",
  ute_van_4wd: "4WD / Ute / Van",
  performance_large: "Performance / Large",
};

export const VEHICLE_TYPE_ICONS: Record<VehicleType, string> = {
  small_car: "fas fa-car",
  sedan_wagon: "fas fa-car-side",
  suv: "fas fa-car-rear",
  ute_van_4wd: "fas fa-truck-pickup",
  performance_large: "fas fa-rocket",
};

export function isVehicleType(value: unknown): value is VehicleType {
  return (
    typeof value === "string" &&
    (VEHICLE_TYPES as readonly string[]).includes(value)
  );
}

/** Per-vehicle-type override: both price and duration MUST be set together. */
export type VehicleTypePricing = {
  price: number;
  duration: number;
};

/**
 * Sparse map of {vehicleType → { price, duration }}. Only the vehicle types
 * the owner opted into are keys. Missing keys mean "service doesn't apply to
 * this vehicle type", and callers should fall back to the base
 * `price`/`duration` fields on the service doc.
 */
export type VehicleTypePricingMap = Partial<
  Record<VehicleType, VehicleTypePricing>
>;

/**
 * Normalise a raw Firestore value into a clean
 * `{ vehicleTypes, vehicleTypePricing }` pair for UI consumption.
 *
 * - Drops unknown keys, non-numeric prices/durations, and negative values.
 * - `vehicleTypes` is returned in canonical (`VEHICLE_TYPES`) order to keep
 *   pickers and chips visually stable regardless of write order.
 * - Safe to call on legacy docs that have neither field → returns empty set.
 */
export function normalizeVehicleTypePricing(raw: unknown): {
  vehicleTypes: VehicleType[];
  vehicleTypePricing: VehicleTypePricingMap;
} {
  const pricing: VehicleTypePricingMap = {};
  if (raw && typeof raw === "object") {
    const src = raw as Record<string, unknown>;
    for (const vt of VEHICLE_TYPES) {
      const entry = src[vt];
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      const priceNum = Number(e.price);
      const durationNum = Number(e.duration);
      if (
        !Number.isFinite(priceNum) ||
        priceNum < 0 ||
        !Number.isFinite(durationNum) ||
        durationNum <= 0
      ) {
        continue;
      }
      pricing[vt] = {
        price: Math.round(priceNum * 100) / 100,
        duration: Math.round(durationNum),
      };
    }
  }
  return {
    vehicleTypes: VEHICLE_TYPES.filter((vt) => !!pricing[vt]),
    vehicleTypePricing: pricing,
  };
}

/**
 * Compute the headline/"starting from" price + duration for a service from
 * its vehicle-type pricing map (the cheapest tier, with the shortest
 * duration).
 *
 * Returns `null` when the map is empty — callers should then look at the
 * legacy flat `price`/`duration` fields (only present on super-admin
 * `default_services` templates; workshop-owner services no longer persist
 * them).
 */
export function minPricingFromVehicleTypePricing(
  vehicleTypePricing: VehicleTypePricingMap | null | undefined,
): { price: number; duration: number } | null {
  if (!vehicleTypePricing) return null;
  const entries = Object.values(vehicleTypePricing).filter(
    (e): e is VehicleTypePricing => !!e,
  );
  if (entries.length === 0) return null;
  const minPrice = Math.min(...entries.map((e) => e.price));
  const minDuration = Math.min(...entries.map((e) => e.duration));
  return { price: minPrice, duration: minDuration };
}

/**
 * Pick the price/duration that apply to a specific vehicle type.
 *
 * Resolution order:
 *   1. Exact `vehicleTypePricing[vehicleType]` match (workshop-owner services)
 *   2. Cheapest tier in `vehicleTypePricing` when no vehicle type supplied
 *      or the supplied type isn't configured
 *   3. Legacy flat `service.price` / `service.duration` fields (only set on
 *      super-admin `default_services` and pre-migration clones)
 *
 * Returns `{ price: 0, duration: 0, matchedVehicleType: null }` if none of
 * the above resolve — callers can treat that as "service isn't priced yet".
 */
export function resolveServicePricingForVehicleType(
  service: {
    price?: number | null;
    duration?: number | null;
    vehicleTypePricing?: VehicleTypePricingMap | null;
  },
  vehicleType?: VehicleType | null,
): { price: number; duration: number; matchedVehicleType: VehicleType | null } {
  const pricing = service.vehicleTypePricing || {};
  if (vehicleType && isVehicleType(vehicleType) && pricing[vehicleType]) {
    const p = pricing[vehicleType]!;
    return { price: p.price, duration: p.duration, matchedVehicleType: vehicleType };
  }
  const min = minPricingFromVehicleTypePricing(pricing);
  if (min) {
    return { price: min.price, duration: min.duration, matchedVehicleType: null };
  }
  return {
    price: Number(service.price ?? 0) || 0,
    duration: Number(service.duration ?? 0) || 0,
    matchedVehicleType: null,
  };
}

export type ServiceInput = {
  name: string;
  description?: string;
  /**
   * Legacy flat price. Workshop-owner services no longer persist this —
   * pricing lives entirely in `vehicleTypePricing`. Still accepted as an
   * input for super-admin default_services and any imports that haven't
   * been migrated to vehicle-type pricing.
   */
  price?: number;
  /** Legacy flat duration (minutes). See `price` note above. */
  duration?: number;
  icon?: string;
  imageUrl?: string;
  reviews?: number;
  branches: string[]; // branchIds
  staffIds: string[]; // staff ids
  checklist?: ChecklistItem[]; // structured service checklist/todo items
  /** Owner-defined order for area groups in previews/customer-facing views. */
  areaOrder?: ChecklistSection[];
  completionImageUrl?: string; // upcoming: overall service completion photo
  sourceTemplateId?: string; // ID of default_service template this was cloned from
  /**
   * Vehicle types this service is offered for. Empty array means the service
   * is offered for any vehicle (legacy behaviour) and uses the base
   * `price`/`duration`. Non-empty array REQUIRES a matching entry in
   * `vehicleTypePricing` for every type.
   */
  vehicleTypes?: VehicleType[];
  /** Per-vehicle-type price + duration overrides. See `VehicleTypePricingMap`. */
  vehicleTypePricing?: VehicleTypePricingMap;
};

/**
 * Add service ID to a branch's serviceIds array
 */
async function addServiceToBranch(branchId: string, serviceId: string) {
  const branchRef = doc(db, "branches", branchId);
  await updateDoc(branchRef, {
    serviceIds: arrayUnion(serviceId),
    updatedAt: serverTimestamp(),
  });
}

/**
 * Remove service ID from a branch's serviceIds array
 */
async function removeServiceFromBranch(branchId: string, serviceId: string) {
  const branchRef = doc(db, "branches", branchId);
  await updateDoc(branchRef, {
    serviceIds: arrayRemove(serviceId),
    updatedAt: serverTimestamp(),
  });
}

/**
 * Keep only vehicle-type entries for types the owner actually ticked, and
 * reject malformed rows so we never persist `{ price: NaN, duration: -1 }`.
 */
function sanitizeVehicleTypePricingForWrite(
  vehicleTypes: VehicleType[] | undefined,
  vehicleTypePricing: VehicleTypePricingMap | undefined,
): { vehicleTypes: VehicleType[]; vehicleTypePricing: VehicleTypePricingMap } {
  const selected = Array.isArray(vehicleTypes)
    ? VEHICLE_TYPES.filter((vt) => vehicleTypes.includes(vt))
    : [];
  const out: VehicleTypePricingMap = {};
  if (selected.length > 0 && vehicleTypePricing) {
    for (const vt of selected) {
      const entry = vehicleTypePricing[vt];
      if (!entry) continue;
      const priceNum = Number(entry.price);
      const durationNum = Number(entry.duration);
      if (
        Number.isFinite(priceNum) &&
        priceNum >= 0 &&
        Number.isFinite(durationNum) &&
        durationNum > 0
      ) {
        out[vt] = {
          price: Math.round(priceNum * 100) / 100,
          duration: Math.round(durationNum),
        };
      }
    }
  }
  // Keep `vehicleTypes` in sync with pricing entries we actually kept, so the
  // persisted arrays can never disagree.
  return {
    vehicleTypes: selected.filter((vt) => !!out[vt]),
    vehicleTypePricing: out,
  };
}

export async function createServiceForOwner(ownerUid: string, data: ServiceInput, branchNames?: string[]) {
  const {
    checklist,
    areaOrder,
    vehicleTypes,
    vehicleTypePricing,
    price: _legacyPrice,
    duration: _legacyDuration,
    ...rest
  } = data;
  const vt = sanitizeVehicleTypePricingForWrite(vehicleTypes, vehicleTypePricing);

  // Workshop-owner services now price purely per vehicle type — the flat
  // `price` / `duration` fields are intentionally NOT written to the doc.
  // Readers derive the "starting from" price at render time via
  // `minPricingFromVehicleTypePricing`. For legacy callers that still pass
  // flat values without any vehicle-type pricing (e.g. super-admin
  // default_services clones before migration), fall back to persisting the
  // flat fields so those services don't show $0 until someone re-saves.
  const payload: Record<string, unknown> = {
    ownerUid,
    ...rest,
    checklist: templateChecklistForFirestore(checklist),
    areaOrder: normalizeAreaOrder(areaOrder),
    vehicleTypes: vt.vehicleTypes,
    vehicleTypePricing: vt.vehicleTypePricing,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
  if (vt.vehicleTypes.length === 0) {
    if (_legacyPrice !== undefined) payload.price = _legacyPrice;
    if (_legacyDuration !== undefined) payload.duration = _legacyDuration;
  }

  const ref = await addDoc(collection(db, "services"), payload);

  // Add service ID to all selected branches
  if (data.branches && data.branches.length > 0) {
    await Promise.all(
      data.branches.map((branchId) => addServiceToBranch(branchId, ref.id))
    );
  }

  // Audit log — log the headline (cheapest) price when vehicle-type pricing
  // is set, otherwise the legacy flat price. Keeps the audit feed readable
  // without inventing a "$0" entry for vehicle-type services.
  try {
    const performer = await getCurrentUserForAudit();
    if (performer) {
      const min = minPricingFromVehicleTypePricing(vt.vehicleTypePricing);
      const auditPrice = min?.price ?? data.price ?? 0;
      await logServiceCreated(
        ownerUid,
        ref.id,
        data.name,
        auditPrice,
        performer,
        branchNames
      );
    }
  } catch (e) {
    console.error("Failed to create audit log for service creation:", e);
  }

  return ref.id;
}

export async function updateService(serviceId: string, data: Partial<ServiceInput>, ownerUid?: string) {
  // Get current service data to compare branches
  const serviceRef = doc(db, "services", serviceId);
  const serviceSnap = await getDoc(serviceRef);
  const currentData = serviceSnap.data();
  const oldBranches: string[] = currentData?.branches || [];
  const newBranches: string[] = data.branches || [];

  // Find branches to add and remove
  const branchesToAdd = newBranches.filter((b) => !oldBranches.includes(b));
  const branchesToRemove = oldBranches.filter((b) => !newBranches.includes(b));

  // Build change description for audit log. For vehicle-type services we
  // describe the headline (cheapest) price instead of the old flat field
  // so the feed stays meaningful post-migration.
  const changes: string[] = [];
  if (data.name && data.name !== currentData?.name) changes.push(`Name: ${currentData?.name} → ${data.name}`);
  const newMin = minPricingFromVehicleTypePricing(
    data.vehicleTypePricing ?? null,
  );
  const oldMin = minPricingFromVehicleTypePricing(
    currentData?.vehicleTypePricing as VehicleTypePricingMap | null | undefined,
  );
  if (newMin && (!oldMin || newMin.price !== oldMin.price)) {
    const oldLabel = oldMin ? `$${oldMin.price}` : `$${currentData?.price ?? 0}`;
    changes.push(`Starting price: ${oldLabel} → $${newMin.price}`);
  }
  if (newMin && (!oldMin || newMin.duration !== oldMin.duration)) {
    const oldLabel = oldMin
      ? `${oldMin.duration}min`
      : `${currentData?.duration ?? 0}min`;
    changes.push(`Starting duration: ${oldLabel} → ${newMin.duration}min`);
  }
  if (!newMin) {
    if (
      data.price !== undefined &&
      data.price !== currentData?.price
    ) {
      changes.push(`Price: $${currentData?.price} → $${data.price}`);
    }
    if (
      data.duration !== undefined &&
      data.duration !== currentData?.duration
    ) {
      changes.push(
        `Duration: ${currentData?.duration}min → ${data.duration}min`,
      );
    }
  }
  if (branchesToAdd.length > 0) changes.push(`Added to ${branchesToAdd.length} branch(es)`);
  if (branchesToRemove.length > 0) changes.push(`Removed from ${branchesToRemove.length} branch(es)`);

  const {
    checklist,
    areaOrder,
    vehicleTypes,
    vehicleTypePricing,
    price: _legacyPrice,
    duration: _legacyDuration,
    ...rest
  } = data;
  const updatePayload: Record<string, unknown> = {
    ...rest,
    updatedAt: serverTimestamp(),
  };
  if (checklist !== undefined) {
    updatePayload.checklist = templateChecklistForFirestore(checklist);
  }
  if (areaOrder !== undefined) {
    updatePayload.areaOrder = normalizeAreaOrder(areaOrder);
  }
  // `vehicleTypes` and `vehicleTypePricing` are always written as a pair —
  // updating one without the other would leave the doc in an inconsistent
  // state (e.g. a type ticked on but no price). The form always submits
  // both, so we only touch Firestore if at least one was provided.
  if (vehicleTypes !== undefined || vehicleTypePricing !== undefined) {
    const vt = sanitizeVehicleTypePricingForWrite(
      vehicleTypes,
      vehicleTypePricing,
    );
    updatePayload.vehicleTypes = vt.vehicleTypes;
    updatePayload.vehicleTypePricing = vt.vehicleTypePricing;
    // Whenever vehicle-type pricing is being saved, scrub the old flat
    // `price`/`duration` fields off the doc. They used to be kept as a
    // fallback for legacy readers, but pricing now lives exclusively in
    // `vehicleTypePricing` for workshop-owner services. `deleteField()`
    // removes the key entirely so existing docs get cleaned up on the
    // next save and stop showing stale numbers in Firestore.
    if (vt.vehicleTypes.length > 0) {
      if (currentData?.price !== undefined) {
        updatePayload.price = deleteField();
      }
      if (currentData?.duration !== undefined) {
        updatePayload.duration = deleteField();
      }
    } else {
      // No vehicle types selected → fall back to legacy flat fields if the
      // caller passed them. Preserves super-admin default_services flow.
      if (_legacyPrice !== undefined) updatePayload.price = _legacyPrice;
      if (_legacyDuration !== undefined) updatePayload.duration = _legacyDuration;
    }
  } else {
    // No vehicle-type pricing in this patch → legacy update path.
    if (_legacyPrice !== undefined) updatePayload.price = _legacyPrice;
    if (_legacyDuration !== undefined) updatePayload.duration = _legacyDuration;
  }
  await updateDoc(serviceRef, updatePayload as DocumentData);

  // Update branch documents
  await Promise.all([
    ...branchesToAdd.map((branchId) => addServiceToBranch(branchId, serviceId)),
    ...branchesToRemove.map((branchId) => removeServiceFromBranch(branchId, serviceId)),
  ]);

  // Audit log
  try {
    const performer = await getCurrentUserForAudit();
    if (performer) {
      await logServiceUpdated(
        ownerUid || currentData?.ownerUid || "",
        serviceId,
        data.name || currentData?.name || "Unknown Service",
        performer,
        changes.length > 0 ? changes.join(", ") : "Minor updates"
      );
    }
  } catch (e) {
    console.error("Failed to create audit log for service update:", e);
  }
}

export async function deleteService(serviceId: string, ownerUid?: string) {
  // Get the service to find which branches have this service
  const serviceRef = doc(db, "services", serviceId);
  const serviceSnap = await getDoc(serviceRef);
  const serviceData = serviceSnap.data();
  const branches: string[] = serviceData?.branches || [];
  const serviceName = serviceData?.name || "Unknown Service";
  const serviceOwnerUid = ownerUid || serviceData?.ownerUid || "";

  // Remove service ID from all branches
  if (branches.length > 0) {
    await Promise.all(
      branches.map((branchId) => removeServiceFromBranch(branchId, serviceId))
    );
  }

  // Delete the service document
  await deleteDoc(serviceRef);

  // Audit log
  try {
    const performer = await getCurrentUserForAudit();
    if (performer) {
      await logServiceDeleted(
        serviceOwnerUid,
        serviceId,
        serviceName,
        performer
      );
    }
  } catch (e) {
    console.error("Failed to create audit log for service deletion:", e);
  }
}

export function subscribeServicesForOwner(
  ownerUid: string,
  onChange: (rows: Array<{ id: string } & DocumentData>) => void
) {
  const q = query(collection(db, "services"), where("ownerUid", "==", ownerUid));
  return onSnapshot(
    q,
    (snap) => {
      onChange(snap.docs.map((d) => ({ id: d.id, ...(d.data() as DocumentData) })));
    },
    (error) => {
      if (error.code === "permission-denied") {
        console.warn("Permission denied for services query. User may not be authenticated.");
        onChange([]);
      } else {
        console.error("Error in services snapshot:", error);
        onChange([]);
      }
    }
  );
}


