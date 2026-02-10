import { auth, db } from "@/lib/firebase";
import { addDoc, collection, serverTimestamp, doc, updateDoc, getDoc } from "firebase/firestore";
import type { BookingStatus } from "./bookingTypes";
import { getCurrentUserForAudit, logBookingCreated, logBookingStatusChanged } from "@/lib/auditLog";
import { localToUTC } from "@/lib/timezone";

/**
 * Get the correct ownerUid for bookings
 * For salon owners, this is their own UID
 * For branch admins and staff, this is their ownerUid field
 */
async function getOwnerUidForBooking(): Promise<string | null> {
  const user = auth.currentUser;
  if (!user) return null;
  
  try {
    const userDoc = await getDoc(doc(db, "users", user.uid));
    const userData = userDoc.data();
    
    if (userData) {
      const userRole = userData.role || userData.systemRole;
      // For branch admins and staff, use their ownerUid field
      if ((userRole === "salon_branch_admin" || userRole === "salon_staff") && userData.ownerUid) {
        return userData.ownerUid;
      }
    }
    // For salon owners or if no special role, use their own UID
    return user.uid;
  } catch (e) {
    console.error("Error getting owner UID:", e);
    return user.uid;
  }
}

/**
 * Generate a readable booking code
 * Format: BK-YYYY-MMDDHH-NNNN (e.g., BK-2024-120215-1234)
 * Includes date/time components for better uniqueness
 */
export function generateBookingCode(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = (now.getMonth() + 1).toString().padStart(2, '0');
  const day = now.getDate().toString().padStart(2, '0');
  const hour = now.getHours().toString().padStart(2, '0');
  const dateTime = `${month}${day}${hour}`;
  // Generate a 4-digit random number
  const randomNum = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
  return `BK-${year}-${dateTime}-${randomNum}`;
}

export type BookingInput = {
  client: string;
  clientEmail?: string;
  clientPhone?: string;
  notes?: string;
  serviceId: string | number;
  serviceName?: string;
  staffId?: string | null; // Optional - allows booking without specific staff
  staffName?: string;
  branchId: string;
  branchName?: string;
  branchTimezone?: string; // IANA timezone of the branch
  date: string; // YYYY-MM-DD in branch's local timezone
  time: string; // HH:mm in branch's local timezone
  dateTimeUtc?: string; // UTC ISO string for storage
  duration: number; // minutes
  status?: BookingStatus;
  price: number;
  services?: any[];
};

export async function createBooking(input: BookingInput): Promise<{ id: string }> {
  const user = auth.currentUser;
  const token =
    (await user?.getIdToken().catch(() => null)) ||
    (typeof window !== "undefined" ? localStorage.getItem("idToken") : null);
  
  let bookingId: string = "";
  let bookingCode: string | undefined;
  
  // Convert local time to UTC if timezone is provided
  let dateTimeUtc: string | undefined;
  if (input.branchTimezone && input.date && input.time) {
    dateTimeUtc = localToUTC(input.date, input.time, input.branchTimezone);
  }
  
  try {
    const res = await fetch("/api/bookings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        ...input,
        dateTimeUtc, // Include UTC timestamp for consistent storage
        status: input.status || "Pending",
      }),
    });
    const json = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) {
      const error: any = new Error(json?.error || "Failed to create booking");
      error.status = res.status;
      error.details = json?.details;
      throw error;
    }
    // If API was a dev no-op, also persist from client
    if (json?.devNoop) {
      const newCode = generateBookingCode();
      // Get the correct ownerUid (salon owner's UID for branch admins/staff)
      const ownerUid = await getOwnerUidForBooking();
      const payload = {
        ownerUid: ownerUid,
        ...input,
        dateTimeUtc, // Store UTC timestamp
        bookingCode: newCode,
        status: input.status || "Pending",
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      };
      const ref = await addDoc(collection(db, "bookings"), payload as any);
      bookingId = ref.id;
      bookingCode = newCode;
    } else {
      bookingId = String(json?.id);
      bookingCode = json?.bookingCode;
    }
  } catch {
    // Fallback: write from client (requires Firestore rules allow authenticated writes)
    const newCode = generateBookingCode();
    // Get the correct ownerUid (salon owner's UID for branch admins/staff)
    const ownerUid = await getOwnerUidForBooking();
    const payload = {
      ownerUid: ownerUid,
      ...input,
      dateTimeUtc, // Store UTC timestamp
      bookingCode: newCode,
      status: input.status || "Pending",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };
    const ref = await addDoc(collection(db, "bookings"), payload as any);
    bookingId = ref.id;
    bookingCode = newCode;
  }

  // Audit log for booking creation
  try {
    const performer = await getCurrentUserForAudit();
    if (performer && user?.uid) {
      await logBookingCreated(
        user.uid,
        bookingId,
        bookingCode,
        input.client,
        input.serviceName || "Service",
        input.branchName,
        input.staffName,
        performer
      );
    }
  } catch (e) {
    console.error("Failed to create audit log for booking creation:", e);
  }

  return { id: bookingId };
}

export async function updateBookingStatus(bookingId: string, nextStatus: BookingStatus): Promise<void> {
  // Get fresh token with robust fallback
  let token: string | null = null;
  try {
    if (auth.currentUser) {
      token = await auth.currentUser.getIdToken(true);
    } else {
      // Wait for auth state to settle
      const user = await new Promise<any>((resolve) => {
        const unsubscribe = auth.onAuthStateChanged((u) => {
          unsubscribe();
          resolve(u);
        });
      });
      if (user) {
        token = await user.getIdToken(true);
      } else {
         // Fallback to stored token if available (less reliable but better than nothing)
         token = typeof window !== "undefined" ? localStorage.getItem("idToken") : null;
      }
    }
  } catch (err) {
    console.error("Error getting token:", err);
  }

  const res = await fetch(`/api/bookings/${encodeURIComponent(bookingId)}/status`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ status: nextStatus }),
  });
  const json = (await res.json().catch(() => ({}))) as any;
  if (!res.ok && !json?.devNoop) {
    throw new Error(json?.error || "Failed to update booking status");
  }
  // If dev no-op or unauthorized in dev, perform client-side update so UI reflects change
  if (json?.devNoop || (!res.ok && process.env.NODE_ENV !== "production")) {
    await updateDoc(doc(db, "bookings", bookingId), {
      status: nextStatus,
      updatedAt: serverTimestamp(),
    } as any);
  }
}

import { getDocs, query, where, onSnapshot, DocumentData } from "firebase/firestore";

/**
 * Fetch all bookings for a specific owner
 */
export async function fetchBookingsForOwner(ownerUid: string) {
  const q = query(collection(db, "bookings"), where("ownerUid", "==", ownerUid));
  const snapshot = await getDocs(q);
  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

/**
 * Subscribe to real-time bookings updates for an owner
 */
export function subscribeBookingsForOwner(
  ownerUid: string,
  onChange: (rows: Array<{ id: string } & DocumentData>) => void
) {
  const q = query(collection(db, "bookings"), where("ownerUid", "==", ownerUid));
  return onSnapshot(
    q,
    (snap) => {
      onChange(snap.docs.map((d) => ({ id: d.id, ...(d.data() as DocumentData) })));
    },
    (error) => {
      // Handle permission errors gracefully
      if (error.code === "permission-denied") {
        console.warn("Permission denied for bookings query. User may not be authenticated.");
        onChange([]); // Return empty array instead of crashing
      } else {
        console.error("Error in bookings snapshot:", error);
        onChange([]);
      }
    }
  );
}


