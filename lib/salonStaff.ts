import { db } from "@/lib/firebase";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  DocumentData,
  getDoc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore";
import { 
  getCurrentUserForAudit, 
  logStaffCreated, 
  logStaffUpdated, 
  logStaffDeleted,
  logStaffStatusChanged,
  logStaffPromoted,
  logStaffScheduleUpdated
} from "@/lib/auditLog";

export type StaffStatus = "Active" | "Suspended";

export type StaffTraining = {
  ohs?: boolean;
  prod?: boolean;
  tool?: boolean;
};

export type WeeklySchedule = {
  Monday?: { branchId: string; branchName: string } | null;
  Tuesday?: { branchId: string; branchName: string } | null;
  Wednesday?: { branchId: string; branchName: string } | null;
  Thursday?: { branchId: string; branchName: string } | null;
  Friday?: { branchId: string; branchName: string } | null;
  Saturday?: { branchId: string; branchName: string } | null;
  Sunday?: { branchId: string; branchName: string } | null;
};

export type SalonStaffInput = {
  email?: string;
  name: string;
  role: string;
  branchId: string;
  branchName: string;
  timezone?: string; // IANA timezone (especially important for branch admins)
  status?: StaffStatus;
  avatar?: string;
  training?: StaffTraining;
  authUid?: string; // This should now be mandatory or strongly encouraged for 'users' model
  systemRole?: string;
  weeklySchedule?: WeeklySchedule;
  mobile?: string;
};

// Creates a staff member directly in the 'users' collection using the authUid as the document key 
export async function createSalonStaffForOwner(ownerUid: string, data: SalonStaffInput) {
  if (!data.authUid) {
    throw new Error("authUid is required to create a staff member in the users table.");
  }

  if (data.authUid === ownerUid) {
    throw new Error(
      "The salon owner's account cannot be onboarded as staff. Use another email address."
    );
  }

  const systemRole = data.systemRole || "staff";

  await setDoc(doc(db, "users", data.authUid), {
    uid: data.authUid,
    email: data.email || null,
    displayName: data.name,
    name: data.name, // Keep 'name' for compatibility with staff views
    role: systemRole,
    staffRole: data.role,

    ownerUid,
    branchId: data.branchId,
    branchName: data.branchName,
    timezone: data.timezone || null,
    status: data.status || "Active",
    avatar: data.avatar || data.name,
    training: data.training || { ohs: false, prod: false, tool: false },
    authUid: data.authUid,
    systemRole,
    weeklySchedule: data.weeklySchedule || null,
    mobile: data.mobile || null,

    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    provider: "password",
  });

  // Audit log for staff creation
  try {
    const performer = await getCurrentUserForAudit();
    if (performer) {
      await logStaffCreated(
        ownerUid,
        data.authUid,
        data.name,
        data.role,
        data.branchName,
        performer
      );
    }
  } catch (e) {
    console.error("Failed to create audit log for staff creation:", e);
  }

  return data.authUid;
}

export async function updateSalonStaff(staffId: string, data: Partial<SalonStaffInput>, ownerUid?: string) {
  // Get current staff data for audit log
  const staffRef = doc(db, "users", staffId);
  const staffSnap = await getDoc(staffRef);
  const currentData = staffSnap.data();

  const ownerKey = ownerUid ?? currentData?.ownerUid;
  if (
    ownerKey &&
    staffId === ownerKey &&
    currentData?.role === "workshop_owner"
  ) {
    throw new Error(
      "Salon owners cannot be updated from staff management. Use account settings instead."
    );
  }
  
  // Map staff-specific fields to user schema if necessary
  const updatePayload: any = { ...data, updatedAt: serverTimestamp() };
  
  if (data.name) updatePayload.displayName = data.name;
  if (data.role) updatePayload.staffRole = data.role; // Update job title
  if (data.systemRole !== undefined && data.systemRole !== null) {
    updatePayload.systemRole = data.systemRole;
    updatePayload.role = data.systemRole;
  }
  if (data.timezone !== undefined) updatePayload.timezone = data.timezone; // Update timezone
  if (data.branchId !== undefined) updatePayload.branchId = data.branchId; // Update branch assignment
  if (data.branchName !== undefined) updatePayload.branchName = data.branchName; // Update branch name

  // Build change description for audit log
  const changes: string[] = [];
  if (data.name && data.name !== currentData?.name) changes.push(`Name: ${currentData?.name} → ${data.name}`);
  if (data.role && data.role !== currentData?.staffRole) changes.push(`Role: ${currentData?.staffRole} → ${data.role}`);
  if (data.branchName && data.branchName !== currentData?.branchName) changes.push(`Branch: ${currentData?.branchName} → ${data.branchName}`);
  if (data.email && data.email !== currentData?.email) changes.push(`Email updated`);
  if (data.mobile && data.mobile !== currentData?.mobile) changes.push(`Mobile updated`);
  if (data.weeklySchedule) changes.push(`Schedule updated`);

  await updateDoc(staffRef, updatePayload);

  // Check if role is being changed TO branch admin (support both old and new role names)
  const wasBranchAdmin = currentData?.role === "branch_admin" || currentData?.systemRole === "branch_admin";
  const isNowBranchAdmin = data.systemRole === "branch_admin" || updatePayload.role === "branch_admin";
  const roleChangedToBranchAdmin = !wasBranchAdmin && isNowBranchAdmin;

  // Audit log for staff update
  try {
    const performer = await getCurrentUserForAudit();
    if (performer) {
      const staffOwnerUid = ownerUid || currentData?.ownerUid || "";
      const staffName = data.name || currentData?.name || currentData?.displayName || "Unknown Staff";
      
      if (data.weeklySchedule) {
        await logStaffScheduleUpdated(
          staffOwnerUid,
          staffId,
          staffName,
          performer,
          "Weekly schedule updated"
        );
      } else if (changes.length > 0) {
        await logStaffUpdated(
          staffOwnerUid,
          staffId,
          staffName,
          performer,
          changes.join(", ")
        );
      }
    }
  } catch (e) {
    console.error("Failed to create audit log for staff update:", e);
  }

  // Send branch admin assignment email if role changed to branch admin
  if (roleChangedToBranchAdmin) {
    const staffEmail = currentData?.email || "";
    const staffName = data.name || currentData?.name || currentData?.displayName || "Unknown Staff";
    const branchName = data.branchName || currentData?.branchName || "";
    const staffOwnerUid = ownerUid || currentData?.ownerUid || "";

    if (staffEmail && branchName) {
      try {
        // Get salon name
        let salonName: string | undefined;
        if (staffOwnerUid) {
          try {
            const ownerDoc = await getDoc(doc(db, "users", staffOwnerUid));
            if (ownerDoc.exists()) {
              const ownerData = ownerDoc.data();
              salonName = ownerData?.salonName || ownerData?.name || ownerData?.businessName || ownerData?.displayName;
            }
          } catch (e) {
            console.error("Failed to fetch salon name for branch admin email:", e);
          }
        }

        // Only import emailService on the server side
        if (typeof window === "undefined") {
          // Import server wrapper - webpack will handle client-side replacement
          const emailService = await import("@/lib/emailService.server");
          await emailService.sendBranchAdminAssignmentEmail(staffEmail, staffName, branchName, salonName);
        }
      } catch (emailError) {
        console.error("Failed to send branch admin assignment email:", emailError);
        // Don't block staff update if email fails
      }
    }
  }
}

export async function updateSalonStaffStatus(staffId: string, status: StaffStatus, ownerUid?: string) {
  // Get current staff data for audit log
  const staffRef = doc(db, "users", staffId);
  const staffSnap = await getDoc(staffRef);
  const currentData = staffSnap.data();
  const previousStatus = currentData?.status || "Unknown";
  const staffName = currentData?.name || currentData?.displayName || "Unknown Staff";
  const staffOwnerUid = ownerUid || currentData?.ownerUid || "";

  await updateDoc(staffRef, {
    status,
    updatedAt: serverTimestamp(),
  });

  // Audit log for status change
  try {
    const performer = await getCurrentUserForAudit();
    if (performer && staffOwnerUid) {
      await logStaffStatusChanged(
        staffOwnerUid,
        staffId,
        staffName,
        previousStatus,
        status,
        performer
      );
    }
  } catch (e) {
    console.error("Failed to create audit log for staff status change:", e);
  }
}

export async function deleteSalonStaff(staffId: string, ownerUid?: string) {
  // Get staff data before deleting for audit log
  const staffRef = doc(db, "users", staffId);
  const staffSnap = await getDoc(staffRef);
  const staffData = staffSnap.data();
  const staffName = staffData?.name || staffData?.displayName || "Unknown Staff";
  const staffOwnerUid = ownerUid || staffData?.ownerUid || "";

  if (
    staffData?.role === "workshop_owner" &&
    staffId === staffOwnerUid
  ) {
    throw new Error(
      "Cannot delete the salon owner account from staff management."
    );
  }

  await deleteDoc(staffRef);

  // Audit log for staff deletion
  try {
    const performer = await getCurrentUserForAudit();
    if (performer && staffOwnerUid) {
      await logStaffDeleted(
        staffOwnerUid,
        staffId,
        staffName,
        performer
      );
    }
  } catch (e) {
    console.error("Failed to create audit log for staff deletion:", e);
  }
}

export function subscribeSalonStaffForOwner(
  ownerUid: string,
  onChange: (rows: Array<{ id: string } & DocumentData>) => void
) {
  // Subscribe to staff & branch admins for this owner. Previously this
  // listened to the **entire** `users` collection scoped only by ownerUid
  // (including the workshop owner doc itself and legacy roles), then
  // filtered client-side. Filtering on `role` in the query removes that
  // overhead and avoids re-delivering the owner doc on owner-profile edits.
  // Legacy rows that only store role on `systemRole` will not be caught by
  // this query, so we still apply the client-side filter for compatibility.
  let q;
  try {
    q = query(
      collection(db, "users"),
      where("ownerUid", "==", ownerUid),
      where("role", "in", ["staff", "branch_admin"])
    );
  } catch {
    q = query(collection(db, "users"), where("ownerUid", "==", ownerUid));
  }

  return onSnapshot(
    q,
    (snap) => {
      const staffList = snap.docs
        .filter((d) => {
          const raw = d.data();
          const firebaseRole = typeof raw.role === "string" ? raw.role : "";
          if (firebaseRole === "workshop_owner") return false;
          const sr = typeof raw.systemRole === "string" ? raw.systemRole : "";
          return (
            ["staff", "branch_admin"].includes(firebaseRole) ||
            ["staff", "branch_admin"].includes(sr)
          );
        })
        .map((d) => {
          const data = d.data();
          const firebaseRole =
            typeof data.role === "string" ? data.role : "";
          const systemRoleForUi =
            typeof data.systemRole === "string" && data.systemRole
              ? data.systemRole
              : firebaseRole;
          return {
            id: d.id,
            ...data,
            authUid: data.authUid || data.uid || d.id,
            uid: data.uid || data.authUid || d.id,
            name: data.displayName || data.name || "Unknown",
            role: data.staffRole || "Staff",
            systemRole: systemRoleForUi,
          };
        });

      onChange(staffList);
    },
    (error) => {
      if (error.code === "permission-denied") {
        console.warn("Permission denied for staff query. User may not be authenticated.");
        onChange([]);
      } else {
        console.error("Error in staff snapshot:", error);
        onChange([]);
      }
    }
  );
}

type BranchHours = {
  Monday?: { open?: string; close?: string; closed?: boolean };
  Tuesday?: { open?: string; close?: string; closed?: boolean };
  Wednesday?: { open?: string; close?: string; closed?: boolean };
  Thursday?: { open?: string; close?: string; closed?: boolean };
  Friday?: { open?: string; close?: string; closed?: boolean };
  Saturday?: { open?: string; close?: string; closed?: boolean };
  Sunday?: { open?: string; close?: string; closed?: boolean };
};

type PromoteOptions = {
  branchId: string;
  branchName: string;
  branchHours?: string | BranchHours;
};

const DAYS_OF_WEEK = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;

export async function promoteStaffToBranchAdmin(staffId: string, options?: PromoteOptions): Promise<{ weeklySchedule: WeeklySchedule | null }> {
  const userRef = doc(db, "users", staffId);
  
  // Get current staff data for audit log
  const staffSnap = await getDoc(userRef);
  const staffData = staffSnap.data();
  const staffName = staffData?.name || staffData?.displayName || "Unknown Staff";
  const staffEmail = staffData?.email || "";
  const staffOwnerUid = staffData?.ownerUid || "";
  
  // Build the weekly schedule based on branch hours (work all days the branch is open)
  let weeklySchedule: WeeklySchedule | null = null;
  let branchName: string | undefined;
  
  if (options) {
    weeklySchedule = {};
    const { branchId, branchName: optBranchName, branchHours } = options;
    branchName = optBranchName;
    
    // If branchHours is an object, use it to determine open days
    if (branchHours && typeof branchHours === "object") {
      for (const day of DAYS_OF_WEEK) {
        const dayHours = branchHours[day];
        // If the day is not closed, assign the staff to work at this branch on that day
        if (dayHours && !dayHours.closed) {
          weeklySchedule[day] = { branchId, branchName };
        } else {
          weeklySchedule[day] = null; // Off day
        }
      }
    } else {
      // If no hours object, default to working all weekdays
      for (const day of DAYS_OF_WEEK) {
        if (day === "Sunday") {
          weeklySchedule[day] = null; // Default Sunday off
        } else {
          weeklySchedule[day] = { branchId, branchName };
        }
      }
    }
  }
  
  const updatePayload: Record<string, unknown> = {
    role: "branch_admin",
    systemRole: "branch_admin",
    updatedAt: serverTimestamp(),
  };
  
  // Update branch assignment and schedule if provided
  if (options) {
    updatePayload.branchId = options.branchId;
    updatePayload.branchName = options.branchName;
    if (weeklySchedule) {
      updatePayload.weeklySchedule = weeklySchedule;
    }
  }
  
  await updateDoc(userRef, updatePayload);

  // Audit log for promotion
  try {
    const performer = await getCurrentUserForAudit();
    if (performer && staffOwnerUid) {
      await logStaffPromoted(
        staffOwnerUid,
        staffId,
        staffName,
        "Branch Admin",
        performer
      );
    }
  } catch (e) {
    console.error("Failed to create audit log for staff promotion:", e);
  }
  
  // Send branch admin assignment email if staff has email
  // Try to get branch name from options or from branchId if not provided
  let finalBranchName = branchName;
  if (!finalBranchName && options?.branchId) {
    try {
      const branchDoc = await getDoc(doc(db, "branches", options.branchId));
      if (branchDoc.exists()) {
        const branchData = branchDoc.data();
        finalBranchName = branchData?.name || "Branch";
      }
    } catch (e) {
      console.error("Failed to fetch branch name for email:", e);
    }
  }

  if (staffEmail && finalBranchName) {
    // Only send email on server side
    if (typeof window === "undefined") {
      try {
        console.log(`[PROMOTE STAFF] Sending branch admin assignment email to ${staffEmail} for branch ${finalBranchName}`);
        // Get salon name
        let salonName: string | undefined;
        if (staffOwnerUid) {
          try {
            const ownerDoc = await getDoc(doc(db, "users", staffOwnerUid));
            if (ownerDoc.exists()) {
              const ownerData = ownerDoc.data();
              salonName = ownerData?.salonName || ownerData?.name || ownerData?.businessName || ownerData?.displayName;
            }
          } catch (e) {
            console.error("Failed to fetch salon name for branch admin email:", e);
          }
        }
        
        // Import server wrapper - only works on server side
        const emailService = await import("@/lib/emailService.server");
        const emailResult = await emailService.sendBranchAdminAssignmentEmail(staffEmail, staffName, finalBranchName, salonName);
        if (emailResult.success) {
          console.log(`[PROMOTE STAFF] ✅ Branch admin assignment email sent successfully to ${staffEmail}`);
        } else {
          console.error(`[PROMOTE STAFF] ❌ Failed to send email: ${emailResult.error}`);
        }
      } catch (emailError) {
        console.error("Failed to send branch admin assignment email:", emailError);
        // Don't block promotion if email fails
      }
    } else {
      console.log(`[PROMOTE STAFF] Skipping email send (client-side). Email will be sent via API route if needed.`);
    }
  } else {
    if (!staffEmail) {
      console.warn(`[PROMOTE STAFF] ⚠️ Cannot send email: Staff ${staffId} has no email address`);
    }
    if (!finalBranchName) {
      console.warn(`[PROMOTE STAFF] ⚠️ Cannot send email: Branch name not provided for staff ${staffId}`);
    }
  }
  
  return { weeklySchedule };
}

export async function demoteStaffFromBranchAdmin(staffId: string) {
  const userRef = doc(db, "users", staffId);
  
  // Get current staff data for audit log
  const staffSnap = await getDoc(userRef);
  const staffData = staffSnap.data();
  const staffName = staffData?.name || staffData?.displayName || "Unknown Staff";
  const staffOwnerUid = staffData?.ownerUid || "";
  
  await updateDoc(userRef, {
    role: "staff",
    systemRole: "staff",
    updatedAt: serverTimestamp(),
  });

  // Audit log for demotion
  try {
    const performer = await getCurrentUserForAudit();
    if (performer && staffOwnerUid) {
      await logStaffUpdated(
        staffOwnerUid,
        staffId,
        staffName,
        performer,
        "Demoted from Branch Admin to Staff"
      );
    }
  } catch (e) {
    console.error("Failed to create audit log for staff demotion:", e);
  }
}
