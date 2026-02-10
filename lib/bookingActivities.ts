import { db } from "@/lib/firebase";
import { collection, addDoc, serverTimestamp, query, where, orderBy, limit, onSnapshot, DocumentData } from "firebase/firestore";

export type BookingActivityType = 
  | "booking_created"
  | "booking_confirmed"
  | "booking_completed"
  | "booking_cancelled"
  | "booking_rescheduled"
  | "staff_assigned";

export interface BookingActivity {
  id?: string;
  ownerUid: string;
  bookingId: string;
  bookingCode?: string;
  activityType: BookingActivityType;
  clientName: string;
  serviceName?: string;
  branchName?: string;
  staffName?: string;
  price?: number;
  date?: string;
  time?: string;
  previousStatus?: string;
  newStatus: string;
  createdAt?: any;
}

/**
 * Get activity type from status transition
 */
export function getActivityType(newStatus: string): BookingActivityType {
  const status = newStatus.toLowerCase();
  switch (status) {
    case "confirmed":
      return "booking_confirmed";
    case "completed":
      return "booking_completed";
    case "cancelled":
    case "canceled":
      return "booking_cancelled";
    default:
      return "booking_created";
  }
}

/**
 * Get human-readable activity message
 */
export function getActivityMessage(activityType: BookingActivityType, clientName: string): string {
  switch (activityType) {
    case "booking_created":
      return `New booking created for ${clientName}`;
    case "booking_confirmed":
      return `Booking confirmed for ${clientName}`;
    case "booking_completed":
      return `Booking completed for ${clientName}`;
    case "booking_cancelled":
      return `Booking cancelled for ${clientName}`;
    case "booking_rescheduled":
      return `Booking rescheduled for ${clientName}`;
    case "staff_assigned":
      return `Staff assigned for ${clientName}'s booking`;
    default:
      return `Booking updated for ${clientName}`;
  }
}

/**
 * Create a booking activity log entry (client-side)
 */
export async function createBookingActivity(activity: Omit<BookingActivity, "id" | "createdAt">): Promise<string> {
  const docRef = await addDoc(collection(db, "bookingActivities"), {
    ...activity,
    createdAt: serverTimestamp(),
  });
  return docRef.id;
}

/**
 * Subscribe to recent booking activities for an owner
 */
export function subscribeToBookingActivities(
  ownerUid: string,
  onChange: (activities: BookingActivity[]) => void,
  limitCount: number = 15
) {
  const q = query(
    collection(db, "bookingActivities"),
    where("ownerUid", "==", ownerUid),
    orderBy("createdAt", "desc"),
    limit(limitCount)
  );

  return onSnapshot(
    q,
    (snapshot) => {
      const activities = snapshot.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
      })) as BookingActivity[];
      onChange(activities);
    },
    (error) => {
      if (error.code === "permission-denied") {
        console.warn("Permission denied for booking activities query.");
        onChange([]);
      } else {
        console.error("Error in booking activities snapshot:", error);
        onChange([]);
      }
    }
  );
}

