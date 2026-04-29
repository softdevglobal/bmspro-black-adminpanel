import { db } from "@/lib/firebase";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  DocumentData,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
} from "firebase/firestore";
import {
  normalizeAreaOrder,
  templateChecklistForFirestore,
  type ChecklistItem,
  type ChecklistSection,
} from "@/lib/services";

export type DefaultServiceInput = {
  name: string;
  checklist: ChecklistItem[];
  /** Owner-defined order for area groups in previews/customer-facing views. */
  areaOrder?: ChecklistSection[];
};

const COLLECTION = "default_services";

export async function createDefaultService(
  adminUid: string,
  data: DefaultServiceInput
) {
  const { checklist, areaOrder, ...rest } = data;
  const ref = await addDoc(collection(db, COLLECTION), {
    ...rest,
    checklist: templateChecklistForFirestore(checklist),
    areaOrder: normalizeAreaOrder(areaOrder),
    createdBy: adminUid,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return ref.id;
}

export async function updateDefaultService(
  serviceId: string,
  data: Partial<DefaultServiceInput>
) {
  const ref = doc(db, COLLECTION, serviceId);
  const { checklist, areaOrder, ...rest } = data;
  const payload: Record<string, unknown> = {
    ...rest,
    updatedAt: serverTimestamp(),
  };
  if (checklist !== undefined) {
    payload.checklist = templateChecklistForFirestore(checklist);
  }
  if (areaOrder !== undefined) {
    payload.areaOrder = normalizeAreaOrder(areaOrder);
  }
  await updateDoc(ref, payload as DocumentData);
}

export async function deleteDefaultService(serviceId: string) {
  await deleteDoc(doc(db, COLLECTION, serviceId));
}

export function subscribeDefaultServices(
  onChange: (rows: Array<{ id: string } & DocumentData>) => void
) {
  const q = query(collection(db, COLLECTION), orderBy("createdAt", "desc"));
  return onSnapshot(
    q,
    (snap) => {
      onChange(
        snap.docs.map((d) => ({ id: d.id, ...(d.data() as DocumentData) }))
      );
    },
    (error) => {
      console.error("Error in default_services snapshot:", error);
      onChange([]);
    }
  );
}
