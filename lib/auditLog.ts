import { db, auth } from "@/lib/firebase";
import { addDoc, collection, serverTimestamp, getDoc, doc } from "firebase/firestore";

export type AuditActionType = 
  | "create" 
  | "update" 
  | "delete" 
  | "status_change" 
  | "login" 
  | "logout" 
  | "other";

export type AuditEntityType = 
  | "booking" 
  | "service" 
  | "staff" 
  | "branch" 
  | "customer" 
  | "settings" 
  | "auth"
  | "user_profile"
  | "staff_check_in";

export interface AuditLogInput {
  ownerUid: string;
  action: string;
  actionType: AuditActionType;
  entityType: AuditEntityType;
  entityId?: string;
  entityName?: string;
  performedBy: string;
  performedByName?: string;
  performedByRole?: string;
  details?: string;
  previousValue?: string;
  newValue?: string;
  branchId?: string;
  branchName?: string;
  metadata?: Record<string, any>;
}

/**
 * Creates an audit log entry in Firestore
 * Also logs important actions to super admin audit logs for visibility
 */
export async function createAuditLog(input: AuditLogInput): Promise<string | null> {
  try {
    const logData = {
      ...input,
      timestamp: serverTimestamp(),
      createdAt: serverTimestamp(),
    };

    // Remove undefined values
    Object.keys(logData).forEach(key => {
      if ((logData as any)[key] === undefined) {
        delete (logData as any)[key];
      }
    });

    const ref = await addDoc(collection(db, "auditLogs"), logData);
    
    // Also log important salon activities to super admin audit logs
    // This allows super admins to see what salon owners are doing
    const importantEntityTypes = ["service", "branch", "staff", "booking", "settings"];
    const importantActionTypes = ["create", "update", "delete", "status_change"];
    
    if (importantEntityTypes.includes(input.entityType) && importantActionTypes.includes(input.actionType)) {
      try {
        // Fetch salon name for better context
        let salonName = "";
        try {
          const ownerDoc = await getDoc(doc(db, "users", input.ownerUid));
          if (ownerDoc.exists()) {
            const ownerData = ownerDoc.data();
            salonName = ownerData?.salonName || ownerData?.name || ownerData?.businessName || "";
          }
        } catch (e) {
          console.warn("Could not fetch salon name for super admin log");
        }

        // Create a more descriptive action message for branches
        let actionDescription = input.action;
        if (input.entityType === "branch") {
          const actionVerb = input.actionType === "create" ? "added" : 
                           input.actionType === "delete" ? "deleted" : 
                           input.actionType === "update" ? "updated" : "modified";
          actionDescription = `Branch ${actionVerb}: "${input.entityName || "N/A"}"`;
          if (salonName) {
            actionDescription += ` (Salon: ${salonName})`;
          }
        }

        const superAdminLogData = {
          action: `Salon Activity: ${actionDescription}`,
          actionType: input.actionType,
          entityType: "tenant" as const,
          entityId: input.ownerUid,
          entityName: salonName || input.performedByName || input.ownerUid,
          performedBy: input.performedBy,
          performedByName: input.performedByName,
          performedByRole: input.performedByRole,
          details: `${input.entityType.charAt(0).toUpperCase() + input.entityType.slice(1)}: ${input.entityName || "N/A"}${input.details ? ` - ${input.details}` : ""}`,
          previousValue: input.previousValue,
          newValue: input.newValue,
          timestamp: serverTimestamp(),
          createdAt: serverTimestamp(),
          metadata: {
            originalEntityType: input.entityType,
            branchId: input.branchId,
            branchName: input.branchName,
            salonName: salonName || undefined,
          },
        };
        
        // Remove undefined values
        Object.keys(superAdminLogData).forEach(key => {
          if ((superAdminLogData as any)[key] === undefined) {
            delete (superAdminLogData as any)[key];
          }
        });
        
        // Clean up metadata
        if (superAdminLogData.metadata) {
          Object.keys(superAdminLogData.metadata).forEach(key => {
            if ((superAdminLogData.metadata as any)[key] === undefined) {
              delete (superAdminLogData.metadata as any)[key];
            }
          });
        }
        
        await addDoc(collection(db, "superAdminAuditLogs"), superAdminLogData);
        console.log(`[Super Admin Audit] Logged ${input.entityType} ${input.actionType}:`, actionDescription);
      } catch (superAdminError) {
        console.warn("Failed to create super admin audit log:", superAdminError);
      }
    }
    
    return ref.id;
  } catch (error) {
    console.error("Failed to create audit log:", error);
    return null;
  }
}

/**
 * Get current user info for audit logging
 */
export async function getCurrentUserForAudit(): Promise<{
  uid: string;
  name: string;
  role: string;
} | null> {
  const user = auth.currentUser;
  if (!user) return null;

  // Try to get name from user object first
  let name = user.displayName || user.email || "Unknown";
  let role = "unknown";

  // Try to get more info from localStorage (cached during auth)
  if (typeof window !== "undefined") {
    const cachedName = localStorage.getItem("userName");
    const cachedRole = localStorage.getItem("role");
    if (cachedName) name = cachedName;
    if (cachedRole) role = cachedRole;
  }

  return {
    uid: user.uid,
    name,
    role,
  };
}

// ==================== BOOKING AUDIT HELPERS ====================

export async function logBookingCreated(
  ownerUid: string,
  bookingId: string,
  bookingCode: string | undefined,
  clientName: string,
  serviceName: string,
  branchName: string | undefined,
  staffName: string | undefined,
  performer: { uid: string; name: string; role: string }
) {
  return createAuditLog({
    ownerUid,
    action: `Booking created for ${clientName}`,
    actionType: "create",
    entityType: "booking",
    entityId: bookingId,
    entityName: bookingCode || bookingId,
    performedBy: performer.uid,
    performedByName: performer.name,
    performedByRole: performer.role,
    details: `Service: ${serviceName}${staffName ? `, Staff: ${staffName}` : ""}`,
    branchName,
  });
}

export async function logBookingStatusChanged(
  ownerUid: string,
  bookingId: string,
  bookingCode: string | undefined,
  clientName: string,
  previousStatus: string,
  newStatus: string,
  performer: { uid: string; name: string; role: string },
  details?: string
) {
  return createAuditLog({
    ownerUid,
    action: `Booking status changed: ${previousStatus} → ${newStatus}`,
    actionType: "status_change",
    entityType: "booking",
    entityId: bookingId,
    entityName: bookingCode || `Booking for ${clientName}`,
    performedBy: performer.uid,
    performedByName: performer.name,
    performedByRole: performer.role,
    previousValue: previousStatus,
    newValue: newStatus,
    details,
  });
}

export async function logBookingStaffResponse(
  ownerUid: string,
  bookingId: string,
  bookingCode: string | undefined,
  clientName: string,
  action: "accepted" | "rejected",
  performer: { uid: string; name: string; role: string },
  serviceName?: string,
  rejectionReason?: string
) {
  const actionText = action === "accepted" ? "accepted" : "rejected";
  return createAuditLog({
    ownerUid,
    action: `Staff ${actionText} booking${serviceName ? ` for service: ${serviceName}` : ""}`,
    actionType: "status_change",
    entityType: "booking",
    entityId: bookingId,
    entityName: bookingCode || `Booking for ${clientName}`,
    performedBy: performer.uid,
    performedByName: performer.name,
    performedByRole: performer.role,
    details: action === "rejected" && rejectionReason ? `Reason: ${rejectionReason}` : undefined,
  });
}

// ==================== SERVICE AUDIT HELPERS ====================

export async function logServiceCreated(
  ownerUid: string,
  serviceId: string,
  serviceName: string,
  price: number,
  performer: { uid: string; name: string; role: string },
  branchNames?: string[]
) {
  return createAuditLog({
    ownerUid,
    action: `Service created: ${serviceName}`,
    actionType: "create",
    entityType: "service",
    entityId: serviceId,
    entityName: serviceName,
    performedBy: performer.uid,
    performedByName: performer.name,
    performedByRole: performer.role,
    details: `Price: $${price}${branchNames?.length ? `, Branches: ${branchNames.join(", ")}` : ""}`,
  });
}

export async function logServiceUpdated(
  ownerUid: string,
  serviceId: string,
  serviceName: string,
  performer: { uid: string; name: string; role: string },
  changes?: string
) {
  return createAuditLog({
    ownerUid,
    action: `Service updated: ${serviceName}`,
    actionType: "update",
    entityType: "service",
    entityId: serviceId,
    entityName: serviceName,
    performedBy: performer.uid,
    performedByName: performer.name,
    performedByRole: performer.role,
    details: changes,
  });
}

export async function logServiceDeleted(
  ownerUid: string,
  serviceId: string,
  serviceName: string,
  performer: { uid: string; name: string; role: string }
) {
  return createAuditLog({
    ownerUid,
    action: `Service deleted: ${serviceName}`,
    actionType: "delete",
    entityType: "service",
    entityId: serviceId,
    entityName: serviceName,
    performedBy: performer.uid,
    performedByName: performer.name,
    performedByRole: performer.role,
  });
}

// ==================== BRANCH AUDIT HELPERS ====================

export async function logBranchCreated(
  ownerUid: string,
  branchId: string,
  branchName: string,
  address: string,
  performer: { uid: string; name: string; role: string }
) {
  return createAuditLog({
    ownerUid,
    action: `Branch created: ${branchName}`,
    actionType: "create",
    entityType: "branch",
    entityId: branchId,
    entityName: branchName,
    performedBy: performer.uid,
    performedByName: performer.name,
    performedByRole: performer.role,
    details: `Address: ${address}`,
    branchId,
    branchName,
  });
}

export async function logBranchUpdated(
  ownerUid: string,
  branchId: string,
  branchName: string,
  performer: { uid: string; name: string; role: string },
  changes?: string
) {
  return createAuditLog({
    ownerUid,
    action: `Branch updated: ${branchName}`,
    actionType: "update",
    entityType: "branch",
    entityId: branchId,
    entityName: branchName,
    performedBy: performer.uid,
    performedByName: performer.name,
    performedByRole: performer.role,
    details: changes,
    branchId,
    branchName,
  });
}

export async function logBranchDeleted(
  ownerUid: string,
  branchId: string,
  branchName: string,
  performer: { uid: string; name: string; role: string }
) {
  return createAuditLog({
    ownerUid,
    action: `Branch deleted: ${branchName}`,
    actionType: "delete",
    entityType: "branch",
    entityId: branchId,
    entityName: branchName,
    performedBy: performer.uid,
    performedByName: performer.name,
    performedByRole: performer.role,
  });
}

export async function logBranchAdminAssigned(
  ownerUid: string,
  branchId: string,
  branchName: string,
  adminId: string,
  adminName: string,
  performer: { uid: string; name: string; role: string }
) {
  return createAuditLog({
    ownerUid,
    action: `Branch admin assigned: ${adminName} to ${branchName}`,
    actionType: "update",
    entityType: "branch",
    entityId: branchId,
    entityName: branchName,
    performedBy: performer.uid,
    performedByName: performer.name,
    performedByRole: performer.role,
    details: `Admin: ${adminName} (${adminId})`,
    branchId,
    branchName,
  });
}

// ==================== STAFF AUDIT HELPERS ====================

export async function logStaffCreated(
  ownerUid: string,
  staffId: string,
  staffName: string,
  staffRole: string,
  branchName: string,
  performer: { uid: string; name: string; role: string }
) {
  return createAuditLog({
    ownerUid,
    action: `Staff member created: ${staffName}`,
    actionType: "create",
    entityType: "staff",
    entityId: staffId,
    entityName: staffName,
    performedBy: performer.uid,
    performedByName: performer.name,
    performedByRole: performer.role,
    details: `Role: ${staffRole}, Branch: ${branchName}`,
    branchName,
  });
}

export async function logStaffUpdated(
  ownerUid: string,
  staffId: string,
  staffName: string,
  performer: { uid: string; name: string; role: string },
  changes?: string
) {
  return createAuditLog({
    ownerUid,
    action: `Staff member updated: ${staffName}`,
    actionType: "update",
    entityType: "staff",
    entityId: staffId,
    entityName: staffName,
    performedBy: performer.uid,
    performedByName: performer.name,
    performedByRole: performer.role,
    details: changes,
  });
}

export async function logStaffDeleted(
  ownerUid: string,
  staffId: string,
  staffName: string,
  performer: { uid: string; name: string; role: string }
) {
  return createAuditLog({
    ownerUid,
    action: `Staff member deleted: ${staffName}`,
    actionType: "delete",
    entityType: "staff",
    entityId: staffId,
    entityName: staffName,
    performedBy: performer.uid,
    performedByName: performer.name,
    performedByRole: performer.role,
  });
}

export async function logStaffStatusChanged(
  ownerUid: string,
  staffId: string,
  staffName: string,
  previousStatus: string,
  newStatus: string,
  performer: { uid: string; name: string; role: string }
) {
  return createAuditLog({
    ownerUid,
    action: `Staff status changed: ${staffName} (${previousStatus} → ${newStatus})`,
    actionType: "status_change",
    entityType: "staff",
    entityId: staffId,
    entityName: staffName,
    performedBy: performer.uid,
    performedByName: performer.name,
    performedByRole: performer.role,
    previousValue: previousStatus,
    newValue: newStatus,
  });
}

export async function logStaffPromoted(
  ownerUid: string,
  staffId: string,
  staffName: string,
  newRole: string,
  performer: { uid: string; name: string; role: string }
) {
  return createAuditLog({
    ownerUid,
    action: `Staff promoted: ${staffName} to ${newRole}`,
    actionType: "update",
    entityType: "staff",
    entityId: staffId,
    entityName: staffName,
    performedBy: performer.uid,
    performedByName: performer.name,
    performedByRole: performer.role,
    newValue: newRole,
    details: `Promoted to ${newRole}`,
  });
}

export async function logStaffScheduleUpdated(
  ownerUid: string,
  staffId: string,
  staffName: string,
  performer: { uid: string; name: string; role: string },
  scheduleDetails?: string
) {
  return createAuditLog({
    ownerUid,
    action: `Staff schedule updated: ${staffName}`,
    actionType: "update",
    entityType: "staff",
    entityId: staffId,
    entityName: staffName,
    performedBy: performer.uid,
    performedByName: performer.name,
    performedByRole: performer.role,
    details: scheduleDetails,
  });
}

// ==================== USER PROFILE AUDIT HELPERS ====================

export async function logUserProfileUpdated(
  ownerUid: string,
  userId: string,
  userName: string,
  performer: { uid: string; name: string; role: string },
  changes?: string
) {
  return createAuditLog({
    ownerUid,
    action: `User profile updated: ${userName}`,
    actionType: "update",
    entityType: "user_profile",
    entityId: userId,
    entityName: userName,
    performedBy: performer.uid,
    performedByName: performer.name,
    performedByRole: performer.role,
    details: changes,
  });
}

export async function logProfilePictureChanged(
  ownerUid: string,
  userId: string,
  userName: string,
  performer: { uid: string; name: string; role: string },
  pictureType: "logo" | "avatar"
) {
  return createAuditLog({
    ownerUid,
    action: `Profile ${pictureType} changed: ${userName}`,
    actionType: "update",
    entityType: "user_profile",
    entityId: userId,
    entityName: userName,
    performedBy: performer.uid,
    performedByName: performer.name,
    performedByRole: performer.role,
    details: `User changed their profile ${pictureType}`,
  });
}

// ==================== SETTINGS AUDIT HELPERS ====================

export async function logSettingsUpdated(
  ownerUid: string,
  settingName: string,
  performer: { uid: string; name: string; role: string },
  previousValue?: string,
  newValue?: string
) {
  return createAuditLog({
    ownerUid,
    action: `Settings updated: ${settingName}`,
    actionType: "update",
    entityType: "settings",
    entityName: settingName,
    performedBy: performer.uid,
    performedByName: performer.name,
    performedByRole: performer.role,
    previousValue,
    newValue,
  });
}

// ==================== AUTH AUDIT HELPERS ====================

export async function logUserLogin(
  ownerUid: string,
  userId: string,
  userName: string,
  userRole: string
) {
  return createAuditLog({
    ownerUid,
    action: `User logged in: ${userName}`,
    actionType: "login",
    entityType: "auth",
    entityId: userId,
    entityName: userName,
    performedBy: userId,
    performedByName: userName,
    performedByRole: userRole,
  });
}

export async function logUserLogout(
  ownerUid: string,
  userId: string,
  userName: string,
  userRole: string
) {
  return createAuditLog({
    ownerUid,
    action: `User logged out: ${userName}`,
    actionType: "logout",
    entityType: "auth",
    entityId: userId,
    entityName: userName,
    performedBy: userId,
    performedByName: userName,
    performedByRole: userRole,
  });
}

export async function logPasswordChanged(
  ownerUid: string,
  userId: string,
  userName: string,
  userRole: string
) {
  return createAuditLog({
    ownerUid,
    action: `Password changed: ${userName}`,
    actionType: "update",
    entityType: "auth",
    entityId: userId,
    entityName: userName,
    performedBy: userId,
    performedByName: userName,
    performedByRole: userRole,
    details: "User changed their account password",
  });
}

// ==================== SUPER ADMIN AUDIT HELPERS ====================

export type SuperAdminAuditEntityType = 
  | "tenant"
  | "subscription"
  | "system"
  | "super_admin";

export interface SuperAdminAuditLogInput {
  action: string;
  actionType: AuditActionType;
  entityType: SuperAdminAuditEntityType;
  entityId?: string;
  entityName?: string;
  performedBy: string;
  performedByName?: string;
  details?: string;
  previousValue?: string;
  newValue?: string;
  metadata?: Record<string, any>;
}

/**
 * Creates a super admin audit log entry in Firestore
 */
export async function createSuperAdminAuditLog(input: SuperAdminAuditLogInput): Promise<string | null> {
  try {
    const logData = {
      ...input,
      timestamp: serverTimestamp(),
      createdAt: serverTimestamp(),
    };

    // Remove undefined values
    Object.keys(logData).forEach(key => {
      if ((logData as any)[key] === undefined) {
        delete (logData as any)[key];
      }
    });

    console.log("[Super Admin Audit] Creating log:", input.action);
    const ref = await addDoc(collection(db, "superAdminAuditLogs"), logData);
    console.log("[Super Admin Audit] Log created successfully:", ref.id);
    return ref.id;
  } catch (error) {
    console.error("[Super Admin Audit] Failed to create audit log:", error);
    return null;
  }
}

/**
 * Log salon owner activity to super admin audit logs
 * This is called automatically when salon owners make changes
 */
export async function logSalonActivityToSuperAdmin(
  ownerUid: string,
  ownerName: string,
  action: string,
  entityType: string,
  entityName?: string,
  details?: string
): Promise<string | null> {
  return createSuperAdminAuditLog({
    action: `Salon Activity: ${action}`,
    actionType: "update",
    entityType: "tenant",
    entityId: ownerUid,
    entityName: ownerName,
    performedBy: ownerUid,
    performedByName: ownerName,
    details: details || `${entityType}: ${entityName || "N/A"}`,
  });
}

// Tenant Onboarding
export async function logTenantOnboarded(
  tenantId: string,
  tenantName: string,
  tenantEmail: string,
  plan: string,
  performer: { uid: string; name: string }
) {
  return createSuperAdminAuditLog({
    action: `New tenant onboarded: ${tenantName}`,
    actionType: "create",
    entityType: "tenant",
    entityId: tenantId,
    entityName: tenantName,
    performedBy: performer.uid,
    performedByName: performer.name,
    details: `Email: ${tenantEmail}, Plan: ${plan}`,
    newValue: plan,
  });
}

// Tenant Plan Changed
export async function logTenantPlanChanged(
  tenantId: string,
  tenantName: string,
  previousPlan: string,
  newPlan: string,
  performer: { uid: string; name: string }
) {
  return createSuperAdminAuditLog({
    action: `Tenant plan changed: ${tenantName}`,
    actionType: "update",
    entityType: "subscription",
    entityId: tenantId,
    entityName: tenantName,
    performedBy: performer.uid,
    performedByName: performer.name,
    previousValue: previousPlan,
    newValue: newPlan,
    details: `Plan changed from ${previousPlan || "None"} to ${newPlan}`,
  });
}

// Tenant Details Updated
export async function logTenantDetailsUpdated(
  tenantId: string,
  tenantName: string,
  performer: { uid: string; name: string },
  changes?: string
) {
  return createSuperAdminAuditLog({
    action: `Tenant details updated: ${tenantName}`,
    actionType: "update",
    entityType: "tenant",
    entityId: tenantId,
    entityName: tenantName,
    performedBy: performer.uid,
    performedByName: performer.name,
    details: changes || "Tenant details were updated",
  });
}

// Tenant Suspended
export async function logTenantSuspended(
  tenantId: string,
  tenantName: string,
  performer: { uid: string; name: string }
) {
  return createSuperAdminAuditLog({
    action: `Tenant suspended: ${tenantName}`,
    actionType: "status_change",
    entityType: "tenant",
    entityId: tenantId,
    entityName: tenantName,
    performedBy: performer.uid,
    performedByName: performer.name,
    previousValue: "Active",
    newValue: "Suspended",
    details: "Tenant account has been suspended",
  });
}

// Tenant Unsuspended
export async function logTenantUnsuspended(
  tenantId: string,
  tenantName: string,
  performer: { uid: string; name: string }
) {
  return createSuperAdminAuditLog({
    action: `Tenant unsuspended: ${tenantName}`,
    actionType: "status_change",
    entityType: "tenant",
    entityId: tenantId,
    entityName: tenantName,
    performedBy: performer.uid,
    performedByName: performer.name,
    previousValue: "Suspended",
    newValue: "Active",
    details: "Tenant account has been reactivated",
  });
}

// Tenant Deleted
export async function logTenantDeleted(
  tenantId: string,
  tenantName: string,
  performer: { uid: string; name: string }
) {
  return createSuperAdminAuditLog({
    action: `Tenant deleted: ${tenantName}`,
    actionType: "delete",
    entityType: "tenant",
    entityId: tenantId,
    entityName: tenantName,
    performedBy: performer.uid,
    performedByName: performer.name,
    details: "Tenant account has been permanently deleted",
  });
}

// Super Admin Login
export async function logSuperAdminLogin(
  adminId: string,
  adminName: string
) {
  return createSuperAdminAuditLog({
    action: `Super Admin logged in: ${adminName}`,
    actionType: "login",
    entityType: "super_admin",
    entityId: adminId,
    entityName: adminName,
    performedBy: adminId,
    performedByName: adminName,
  });
}

// Super Admin Logout
export async function logSuperAdminLogout(
  adminId: string,
  adminName: string
) {
  return createSuperAdminAuditLog({
    action: `Super Admin logged out: ${adminName}`,
    actionType: "logout",
    entityType: "super_admin",
    entityId: adminId,
    entityName: adminName,
    performedBy: adminId,
    performedByName: adminName,
  });
}
