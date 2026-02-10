import { User } from "firebase/auth";
import { db } from "@/lib/firebase";
import {
  addDoc,
  collection,
  DocumentData,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  deleteDoc,
  where,
} from "firebase/firestore";

export type AppUserRole = "super_admin" | "salon_owner" | "salon_staff" | "salon_branch_admin" | "pending";

/**
 * Ensure a Firestore user doc exists for the logged-in user.
 * - If an invitation exists for the same email, link the uid to that invite and mirror it to users/{uid}.
 * - Otherwise, create a new "pending" user document.
 */
export async function ensureUserDocument(user: User | null) {
  if (!user) return;
  const userRef = doc(db, "users", user.uid);
  const existing = await getDoc(userRef);
  if (existing.exists()) return;

  // Try to link with an existing invite (matched by email)
  if (user.email) {
    const q = query(collection(db, "users"), where("email", "==", user.email));
    const qs = await getDocs(q);
    if (!qs.empty) {
      const invited = qs.docs[0];
      // Migrate invited doc into canonical users/{uid} and remove the duplicate:
      // 1) Write canonical doc keyed by uid
      await setDoc(
        userRef,
        {
          ...invited.data(),
          uid: user.uid,
          displayName: user.displayName || "",
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
      // 2) Delete the old invited document to ensure only one row per user
      if (invited.ref.id !== user.uid) {
        try {
          await deleteDoc(invited.ref);
        } catch {
          // ignore cleanup failure
        }
      }
      return;
    }
  }

  // Create a new pending user
  await setDoc(userRef, {
    uid: user.uid,
    email: user.email || "",
    displayName: user.displayName || "",
    role: "pending" as AppUserRole,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    provider: user.providerData?.[0]?.providerId || "password",
  });
}

/**
 * Create or promote a user record by email to a specific role.
 * Used by super_admin to invite salon owners or promote roles.
 * (Auth account will be linked on first login via ensureUserDocument.)
 */
export async function upsertUserByEmail(email: string, role: Exclude<AppUserRole, "super_admin">, displayName?: string) {
  const q = query(collection(db, "users"), where("email", "==", email));
  const qs = await getDocs(q);
  if (!qs.empty) {
    await updateDoc(qs.docs[0].ref, {
      role,
      displayName: displayName || qs.docs[0].data().displayName || "",
      invitedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return;
  }
  await addDoc(collection(db, "users"), {
    email,
    displayName: displayName || "",
    role,
    invitedAt: serverTimestamp(),
    status: "invited",
  });
}

// -----------------------
// Salon staff helpers
// -----------------------

export type SalonStaffInput = {
  email: string;
  firstName: string;
  lastName: string;
  staffRole: string;
  state: string;
  fullTime?: boolean;
  username?: string | null;
  timezone?: string; // IANA timezone (e.g., 'Australia/Sydney')
  status?: "Active" | "Onboarding" | "Inactive";
  systemRole?: AppUserRole;
};

/**
 * Create a salon staff record for the current salon owner.
 * The Auth account will be provisioned later when the staff accepts the invite.
 */
export async function createSalonStaffForOwner(ownerUid: string, input: SalonStaffInput) {
  const displayName = `${input.firstName || ""} ${input.lastName || ""}`.trim();
  const docRef = await addDoc(collection(db, "users"), {
    // identity fields
    email: input.email.trim().toLowerCase(),
    displayName,
    firstName: input.firstName.trim(),
    lastName: input.lastName.trim(),
    username: input.username || null,
    // role/ownership
    role: (input.systemRole || "salon_staff") as AppUserRole,
    ownerUid,
    // employment fields
    staffRole: input.staffRole,
    state: input.state,
    fullTime: Boolean(input.fullTime),
    status: input.status || "Onboarding",
    // meta
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    invitedAt: serverTimestamp(),
    provider: "password",
  });
  return docRef.id;
}

/**
 * One-time fetch of all staff for an owner.
 */
export async function listSalonStaffForOwner(ownerUid: string) {
  const q = query(
    collection(db, "users"),
    where("role", "==", "salon_staff"),
    where("ownerUid", "==", ownerUid)
  );
  const qs = await getDocs(q);
  return qs.docs.map((d) => ({ id: d.id, ...(d.data() as DocumentData) }));
}

/**
 * Realtime subscription to salon staff for an owner.
 * Returns an unsubscribe function.
 */
export function subscribeSalonStaffForOwner(
  ownerUid: string,
  onChange: (rows: Array<{ id: string } & DocumentData>) => void
) {
  const q = query(
    collection(db, "users"),
    where("role", "==", "salon_staff"),
    where("ownerUid", "==", ownerUid)
  );
  return onSnapshot(
    q,
    (snap) => {
      onChange(snap.docs.map((d) => ({ id: d.id, ...(d.data() as DocumentData) })));
    },
    (error) => {
      if (error.code === "permission-denied") {
        console.warn("Permission denied for salon staff query. User may not be authenticated.");
        onChange([]);
      } else {
        console.error("Error in salon staff snapshot:", error);
        onChange([]);
      }
    }
  );
}
