import { db } from "@/lib/firebase";
import {
  addDoc,
  arrayRemove,
  arrayUnion,
  collection,
  deleteDoc,
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

/** Group key for previews: fixed section order, then legacy rows without a section. */
export type ChecklistSectionGroupKey = ChecklistSection | "unset";

/** Group checklist items by vehicle area (Interior → Engine Bay → Underbody → Exterior), then unset. */
export function groupChecklistItemsBySection(
  items: ChecklistItem[]
): { key: ChecklistSectionGroupKey; items: ChecklistItem[] }[] {
  const buckets = new Map<ChecklistSection, ChecklistItem[]>();
  for (const s of CHECKLIST_SECTIONS) buckets.set(s, []);
  const unset: ChecklistItem[] = [];
  for (const item of items) {
    if (isChecklistSection(item.section)) {
      buckets.get(item.section)!.push(item);
    } else {
      unset.push(item);
    }
  }
  const out: { key: ChecklistSectionGroupKey; items: ChecklistItem[] }[] = [];
  for (const s of CHECKLIST_SECTIONS) {
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

/** Area groups with a single global 1-based task index (customer-facing lists). */
export function groupChecklistItemsWithGlobalNumbers(
  items: ChecklistItem[]
): { key: ChecklistSectionGroupKey; items: { item: ChecklistItem; num: number }[] }[] {
  let n = 0;
  return groupChecklistItemsBySection(items).map((group) => ({
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

export type ServiceInput = {
  name: string;
  description?: string;
  price: number;
  duration: number; // minutes
  icon?: string;
  imageUrl?: string;
  reviews?: number;
  branches: string[]; // branchIds
  staffIds: string[]; // staff ids
  checklist?: ChecklistItem[]; // structured service checklist/todo items
  completionImageUrl?: string; // upcoming: overall service completion photo
  sourceTemplateId?: string; // ID of default_service template this was cloned from
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

export async function createServiceForOwner(ownerUid: string, data: ServiceInput, branchNames?: string[]) {
  const { checklist, ...rest } = data;
  const ref = await addDoc(collection(db, "services"), {
    ownerUid,
    ...rest,
    checklist: templateChecklistForFirestore(checklist),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  // Add service ID to all selected branches
  if (data.branches && data.branches.length > 0) {
    await Promise.all(
      data.branches.map((branchId) => addServiceToBranch(branchId, ref.id))
    );
  }

  // Audit log
  try {
    const performer = await getCurrentUserForAudit();
    if (performer) {
      await logServiceCreated(
        ownerUid,
        ref.id,
        data.name,
        data.price,
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

  // Build change description for audit log
  const changes: string[] = [];
  if (data.name && data.name !== currentData?.name) changes.push(`Name: ${currentData?.name} → ${data.name}`);
  if (data.price !== undefined && data.price !== currentData?.price) changes.push(`Price: $${currentData?.price} → $${data.price}`);
  if (data.duration !== undefined && data.duration !== currentData?.duration) changes.push(`Duration: ${currentData?.duration}min → ${data.duration}min`);
  if (branchesToAdd.length > 0) changes.push(`Added to ${branchesToAdd.length} branch(es)`);
  if (branchesToRemove.length > 0) changes.push(`Removed from ${branchesToRemove.length} branch(es)`);

  const { checklist, ...rest } = data;
  const updatePayload: Record<string, unknown> = {
    ...rest,
    updatedAt: serverTimestamp(),
  };
  if (checklist !== undefined) {
    updatePayload.checklist = templateChecklistForFirestore(checklist);
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


