import { db } from "@/lib/firebase";
import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  Timestamp,
  updateDoc,
  where,
} from "firebase/firestore";
import { validateCheckInLocation, formatDistance } from "./geolocation";

// Check-in record type
export type StaffCheckInRecord = {
  id?: string;
  staffId: string;
  staffName: string;
  staffRole?: string;
  branchId: string;
  branchName: string;
  ownerUid: string;
  
  // Timestamps
  checkInTime: Timestamp | Date;
  checkOutTime?: Timestamp | Date | null;
  
  // Location data (staff's location at check-in)
  staffLatitude: number;
  staffLongitude: number;
  
  // Branch location (for audit)
  branchLatitude: number;
  branchLongitude: number;
  
  // Validation results
  distanceFromBranch: number; // in meters
  isWithinRadius: boolean;
  allowedRadius: number; // in meters
  
  // Status
  status: "checked_in" | "checked_out" | "auto_checked_out";
  
  // Auto check-out fields (if applicable)
  autoCheckOutReason?: string;
  autoCheckOutDistance?: number;
  autoCheckOutLocation?: {
    latitude: number;
    longitude: number;
  };
  
  // Notes
  note?: string;
  
  // Break periods
  breakPeriods?: Array<{
    startTime?: Timestamp | Date | null;
    endTime?: Timestamp | Date | null;
  }>;
  
  // Metadata
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
};

export type CheckInInput = {
  staffId: string;
  staffName: string;
  staffRole?: string;
  branchId: string;
  staffLatitude: number;
  staffLongitude: number;
};

export type CheckInResult = {
  success: boolean;
  message: string;
  checkInId?: string;
  distanceFromBranch?: number;
  isWithinRadius?: boolean;
};

/**
 * Perform staff check-in with location validation
 */
export async function performStaffCheckIn(
  ownerUid: string,
  input: CheckInInput
): Promise<CheckInResult> {
  try {
    // 1. Get branch data
    const branchRef = doc(db, "branches", input.branchId);
    const branchSnap = await getDoc(branchRef);
    
    if (!branchSnap.exists()) {
      return { success: false, message: "Branch not found" };
    }
    
    const branchData = branchSnap.data();
    const branchName = branchData.name || "Unknown Branch";
    
    // 2. Check if branch has location data
    if (!branchData.location?.latitude || !branchData.location?.longitude) {
      return { 
        success: false, 
        message: "Branch location not configured. Please contact your administrator." 
      };
    }
    
    const branchLat = branchData.location.latitude;
    const branchLon = branchData.location.longitude;
    const allowedRadius = branchData.allowedCheckInRadius || 100; // Default 100m
    
    // 3. Validate location using Haversine formula
    const validation = validateCheckInLocation(
      input.staffLatitude,
      input.staffLongitude,
      branchLat,
      branchLon,
      allowedRadius
    );
    
    // 4. Check if staff already has an active check-in
    const activeCheckInQuery = query(
      collection(db, "staff_check_ins"),
      where("staffId", "==", input.staffId),
      where("status", "==", "checked_in")
    );
    const activeCheckIns = await getDocs(activeCheckInQuery);
    
    if (!activeCheckIns.empty) {
      return { 
        success: false, 
        message: "You already have an active check-in. Please check out first.",
        isWithinRadius: validation.isWithinRadius,
        distanceFromBranch: validation.distanceMeters
      };
    }
    
    // 5. If not within radius, reject the check-in
    if (!validation.isWithinRadius) {
      return {
        success: false,
        message: `You are ${formatDistance(validation.distanceMeters)} away from ${branchName}. You must be within ${formatDistance(allowedRadius)} to check in.`,
        isWithinRadius: false,
        distanceFromBranch: validation.distanceMeters
      };
    }
    
    // 6. Create check-in record
    const checkInRecord: Omit<StaffCheckInRecord, "id"> = {
      staffId: input.staffId,
      staffName: input.staffName,
      staffRole: input.staffRole,
      branchId: input.branchId,
      branchName,
      ownerUid,
      checkInTime: serverTimestamp() as Timestamp,
      checkOutTime: null,
      staffLatitude: input.staffLatitude,
      staffLongitude: input.staffLongitude,
      branchLatitude: branchLat,
      branchLongitude: branchLon,
      distanceFromBranch: validation.distanceMeters,
      isWithinRadius: true,
      allowedRadius,
      status: "checked_in",
      createdAt: serverTimestamp() as Timestamp,
      updatedAt: serverTimestamp() as Timestamp,
    };
    
    const docRef = await addDoc(collection(db, "staff_check_ins"), checkInRecord);
    
    return {
      success: true,
      message: `Successfully checked in at ${branchName}`,
      checkInId: docRef.id,
      isWithinRadius: true,
      distanceFromBranch: validation.distanceMeters
    };
    
  } catch (error) {
    console.error("Check-in error:", error);
    return { 
      success: false, 
      message: "Failed to check in. Please try again." 
    };
  }
}

/**
 * Perform staff check-out
 */
export async function performStaffCheckOut(
  checkInId: string
): Promise<{ success: boolean; message: string }> {
  try {
    const checkInRef = doc(db, "staff_check_ins", checkInId);
    
    await updateDoc(checkInRef, {
      checkOutTime: serverTimestamp(),
      status: "checked_out",
      updatedAt: serverTimestamp(),
    });
    
    return { success: true, message: "Successfully checked out" };
  } catch (error) {
    console.error("Check-out error:", error);
    return { success: false, message: "Failed to check out. Please try again." };
  }
}

/**
 * Get active check-in for a staff member
 */
export async function getActiveCheckIn(
  staffId: string
): Promise<StaffCheckInRecord | null> {
  try {
    const q = query(
      collection(db, "staff_check_ins"),
      where("staffId", "==", staffId),
      where("status", "==", "checked_in")
    );
    
    const snapshot = await getDocs(q);
    
    if (snapshot.empty) return null;
    
    const doc = snapshot.docs[0];
    return { id: doc.id, ...doc.data() } as StaffCheckInRecord;
  } catch (error) {
    console.error("Error getting active check-in:", error);
    return null;
  }
}

/**
 * Subscribe to check-in records for a branch
 */
export function subscribeToCheckInsForBranch(
  branchId: string,
  date: Date,
  onChange: (records: StaffCheckInRecord[]) => void
) {
  const startOfDay = new Date(date);
  startOfDay.setHours(0, 0, 0, 0);
  
  const endOfDay = new Date(date);
  endOfDay.setHours(23, 59, 59, 999);
  
  const q = query(
    collection(db, "staff_check_ins"),
    where("branchId", "==", branchId),
    where("checkInTime", ">=", Timestamp.fromDate(startOfDay)),
    where("checkInTime", "<=", Timestamp.fromDate(endOfDay)),
    orderBy("checkInTime", "desc")
  );
  
  return onSnapshot(
    q, 
    (snapshot) => {
      const records = snapshot.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
      })) as StaffCheckInRecord[];
      onChange(records);
    },
    (error) => {
      console.error("Error subscribing to check-ins for branch:", error);
      onChange([]);
    }
  );
}

/**
 * Subscribe to check-in records for an owner (all branches)
 */
export function subscribeToCheckInsForOwner(
  ownerUid: string,
  date: Date,
  onChange: (records: StaffCheckInRecord[]) => void
) {
  // Create fresh Date objects to avoid mutating the input
  const startOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
  const endOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
  
  console.log("[subscribeToCheckInsForOwner] Starting subscription for owner:", ownerUid);
  console.log("[subscribeToCheckInsForOwner] Date range:", startOfDay.toISOString(), "to", endOfDay.toISOString());
  
  const q = query(
    collection(db, "staff_check_ins"),
    where("ownerUid", "==", ownerUid),
    where("checkInTime", ">=", Timestamp.fromDate(startOfDay)),
    where("checkInTime", "<=", Timestamp.fromDate(endOfDay)),
    orderBy("checkInTime", "desc")
  );
  
  let hasReceivedInitialData = false;
  
  return onSnapshot(
    q, 
    (snapshot) => {
      hasReceivedInitialData = true;
      const records = snapshot.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
      })) as StaffCheckInRecord[];
      console.log("[subscribeToCheckInsForOwner] Received", records.length, "check-ins");
      onChange(records);
    },
    (error) => {
      console.error("[subscribeToCheckInsForOwner] Error:", error);
      // Only send empty array if we haven't received initial data yet
      // This prevents clearing existing data on transient network errors
      if (!hasReceivedInitialData) {
        console.log("[subscribeToCheckInsForOwner] No initial data received, returning empty array");
        onChange([]);
      } else {
        console.log("[subscribeToCheckInsForOwner] Keeping existing data despite error");
      }
    }
  );
}

/**
 * Auto check-out when staff exceeds branch radius
 * This function checks if the staff member is still within the allowed radius
 * and automatically checks them out if they've exceeded it
 */
export async function autoCheckOutIfExceededRadius(
  checkInId: string,
  currentLatitude: number,
  currentLongitude: number
): Promise<boolean> {
  try {
    const checkInRef = doc(db, "staff_check_ins", checkInId);
    const checkInSnap = await getDoc(checkInRef);
    
    if (!checkInSnap.exists()) {
      return false;
    }
    
    const checkInData = checkInSnap.data();
    
    // Only process if still checked in
    if (checkInData.status !== "checked_in") {
      return false;
    }
    
    // Get branch location and radius
    const branchId = checkInData.branchId;
    const branchRef = doc(db, "branches", branchId);
    const branchSnap = await getDoc(branchRef);
    
    if (!branchSnap.exists()) {
      return false;
    }
    
    const branchData = branchSnap.data();
    
    if (!branchData.location?.latitude || !branchData.location?.longitude) {
      return false;
    }
    
    const branchLat = branchData.location.latitude;
    const branchLon = branchData.location.longitude;
    const allowedRadius = branchData.allowedCheckInRadius || 100;
    
    // Calculate current distance from branch
    const validation = validateCheckInLocation(
      currentLatitude,
      currentLongitude,
      branchLat,
      branchLon,
      allowedRadius
    );
    
    // If outside radius, auto check-out
    if (!validation.isWithinRadius) {
      // Calculate hours worked
      let hoursWorked = "0h 0m";
      if (checkInData.checkInTime) {
        const checkInTime = checkInData.checkInTime.toDate();
        const now = new Date();
        const diffMs = now.getTime() - checkInTime.getTime();
        const hours = Math.floor(diffMs / (1000 * 60 * 60));
        const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
        hoursWorked = `${hours}h ${minutes}m`;
      }
      
      // Update check-in record with auto check-out
      await updateDoc(checkInRef, {
        checkOutTime: serverTimestamp(),
        status: "auto_checked_out",
        updatedAt: serverTimestamp(),
        autoCheckOutReason: "Exceeded branch radius",
        autoCheckOutDistance: validation.distanceMeters,
        autoCheckOutLocation: {
          latitude: currentLatitude,
          longitude: currentLongitude,
        },
      });
      
      return true;
    }
    
    return false;
  } catch (error) {
    console.error("Error in auto check-out:", error);
    return false;
  }
}

/**
 * Get check-in statistics for a date range
 */
export async function getCheckInStats(
  ownerUid: string,
  startDate: Date,
  endDate: Date
): Promise<{
  totalCheckIns: number;
  uniqueStaff: number;
  averageDistance: number;
  onTimePercentage: number;
}> {
  try {
    const q = query(
      collection(db, "staff_check_ins"),
      where("ownerUid", "==", ownerUid),
      where("checkInTime", ">=", Timestamp.fromDate(startDate)),
      where("checkInTime", "<=", Timestamp.fromDate(endDate))
    );
    
    const snapshot = await getDocs(q);
    const records = snapshot.docs.map((doc) => doc.data() as StaffCheckInRecord);
    
    const uniqueStaffIds = new Set(records.map((r) => r.staffId));
    const totalDistance = records.reduce((sum, r) => sum + r.distanceFromBranch, 0);
    const withinRadius = records.filter((r) => r.isWithinRadius).length;
    
    return {
      totalCheckIns: records.length,
      uniqueStaff: uniqueStaffIds.size,
      averageDistance: records.length > 0 ? Math.round(totalDistance / records.length) : 0,
      onTimePercentage: records.length > 0 ? Math.round((withinRadius / records.length) * 100) : 0,
    };
  } catch (error) {
    console.error("Error getting check-in stats:", error);
    return {
      totalCheckIns: 0,
      uniqueStaff: 0,
      averageDistance: 0,
      onTimePercentage: 0,
    };
  }
}
