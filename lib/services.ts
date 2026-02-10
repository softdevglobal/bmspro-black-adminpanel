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

export type ServiceInput = {
  name: string;
  price: number;
  duration: number; // minutes
  icon?: string;
  imageUrl?: string;
  reviews?: number;
  branches: string[]; // branchIds
  staffIds: string[]; // salon_staff ids
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
  const ref = await addDoc(collection(db, "services"), {
    ownerUid,
    ...data,
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

  // Update the service document
  await updateDoc(serviceRef, {
    ...data,
    updatedAt: serverTimestamp(),
  });

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


