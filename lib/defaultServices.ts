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
import { templateChecklistForFirestore, type ChecklistItem } from "@/lib/services";

export type DefaultServiceInput = {
  name: string;
  checklist: ChecklistItem[];
};

const COLLECTION = "default_services";

export async function createDefaultService(
  adminUid: string,
  data: DefaultServiceInput
) {
  const { checklist, ...rest } = data;
  const ref = await addDoc(collection(db, COLLECTION), {
    ...rest,
    checklist: templateChecklistForFirestore(checklist),
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
  const { checklist, ...rest } = data;
  const payload: Record<string, unknown> = {
    ...rest,
    updatedAt: serverTimestamp(),
  };
  if (checklist !== undefined) {
    payload.checklist = templateChecklistForFirestore(checklist);
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
