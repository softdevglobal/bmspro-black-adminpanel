import { adminDb } from "@/lib/firebaseAdmin";
import { FieldValue } from "firebase-admin/firestore";

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
 * Creates an audit log entry in Firestore (server-side version for API routes)
 * Also logs important salon activities to super admin audit logs for visibility
 */
export async function createAuditLogServer(input: AuditLogInput): Promise<string | null> {
  try {
    const db = adminDb();
    
    const logData: Record<string, any> = {
      ...input,
      timestamp: FieldValue.serverTimestamp(),
      createdAt: FieldValue.serverTimestamp(),
    };

    // Remove undefined values
    Object.keys(logData).forEach(key => {
      if (logData[key] === undefined) {
        delete logData[key];
      }
    });

    const ref = await db.collection("auditLogs").add(logData);

    // Also log important salon activities to super admin audit logs
    const importantEntityTypes = ["service", "branch", "staff", "booking", "settings"];
    const importantActionTypes = ["create", "update", "delete", "status_change"];
    
    if (importantEntityTypes.includes(input.entityType) && importantActionTypes.includes(input.actionType)) {
      try {
        // Fetch salon name for better context
        let salonName = "";
        try {
          const ownerDoc = await db.collection("users").doc(input.ownerUid).get();
          if (ownerDoc.exists) {
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

        const superAdminLogData: Record<string, any> = {
          action: `Salon Activity: ${actionDescription}`,
          actionType: input.actionType,
          entityType: "tenant",
          entityId: input.ownerUid,
          entityName: salonName || input.performedByName || input.ownerUid,
          performedBy: input.performedBy,
          performedByName: input.performedByName,
          performedByRole: input.performedByRole,
          details: `${input.entityType.charAt(0).toUpperCase() + input.entityType.slice(1)}: ${input.entityName || "N/A"}${input.details ? ` - ${input.details}` : ""}`,
          previousValue: input.previousValue,
          newValue: input.newValue,
          timestamp: FieldValue.serverTimestamp(),
          createdAt: FieldValue.serverTimestamp(),
          metadata: {
            originalEntityType: input.entityType,
            branchId: input.branchId,
            branchName: input.branchName,
            salonName: salonName || undefined,
          },
        };
        
        // Remove undefined values
        Object.keys(superAdminLogData).forEach(key => {
          if (superAdminLogData[key] === undefined) {
            delete superAdminLogData[key];
          }
        });
        
        // Clean up metadata
        if (superAdminLogData.metadata) {
          Object.keys(superAdminLogData.metadata).forEach(key => {
            if (superAdminLogData.metadata[key] === undefined) {
              delete superAdminLogData.metadata[key];
            }
          });
        }
        
        await db.collection("superAdminAuditLogs").add(superAdminLogData);
        console.log(`[Super Admin Audit] Logged ${input.entityType} ${input.actionType}:`, actionDescription);
      } catch (superAdminError) {
        console.warn("Failed to create super admin audit log:", superAdminError);
      }
    }

    return ref.id;
  } catch (error) {
    console.error("Failed to create audit log (server):", error);
    return null;
  }
}

// ==================== BOOKING AUDIT HELPERS (SERVER) ====================

export async function logBookingCreatedServer(
  ownerUid: string,
  bookingId: string,
  bookingCode: string | undefined,
  clientName: string,
  serviceName: string,
  branchName: string | undefined,
  staffName: string | undefined,
  performer: { uid: string; name: string; role: string },
  details?: {
    price?: number;
    duration?: number;
    date?: string;
    time?: string;
    notes?: string;
    bookingSource?: string;
    clientEmail?: string;
    clientPhone?: string;
  }
) {
  let detailsText = `Service: ${serviceName}`;
  if (staffName) detailsText += `, Staff: ${staffName}`;
  if (details?.price) detailsText += `, Price: $${details.price}`;
  if (details?.duration) detailsText += `, Duration: ${details.duration} mins`;
  if (details?.date && details?.time) detailsText += `, Date/Time: ${details.date} ${details.time}`;
  if (details?.notes && details.notes.trim()) detailsText += `, Notes: ${details.notes}`;
  if (details?.bookingSource) detailsText += `, Source: ${details.bookingSource}`;

  return createAuditLogServer({
    ownerUid,
    action: `Booking created for ${clientName}`,
    actionType: "create",
    entityType: "booking",
    entityId: bookingId,
    entityName: bookingCode || `Booking for ${clientName}`,
    performedBy: performer.uid,
    performedByName: performer.name,
    performedByRole: performer.role,
    details: detailsText,
    branchName,
    metadata: details ? {
      price: details.price,
      duration: details.duration,
      date: details.date,
      time: details.time,
      notes: details.notes,
      bookingSource: details.bookingSource,
      clientEmail: details.clientEmail,
      clientPhone: details.clientPhone,
    } : undefined,
  });
}

export async function logBookingStatusChangedServer(
  ownerUid: string,
  bookingId: string,
  bookingCode: string | undefined,
  clientName: string,
  previousStatus: string,
  newStatus: string,
  performer: { uid: string; name: string; role: string },
  details?: string,
  branchName?: string
) {
  return createAuditLogServer({
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
    branchName,
  });
}

export async function logBookingStaffResponseServer(
  ownerUid: string,
  bookingId: string,
  bookingCode: string | undefined,
  clientName: string,
  action: "accepted" | "rejected",
  performer: { uid: string; name: string; role: string },
  serviceName?: string,
  rejectionReason?: string,
  branchName?: string
) {
  const actionText = action === "accepted" ? "accepted" : "rejected";
  return createAuditLogServer({
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
    branchName,
  });
}

export async function logBookingReassignedServer(
  ownerUid: string,
  bookingId: string,
  bookingCode: string | undefined,
  clientName: string,
  performer: { uid: string; name: string; role: string },
  newStaffName?: string,
  branchName?: string
) {
  return createAuditLogServer({
    ownerUid,
    action: `Booking reassigned${newStaffName ? ` to ${newStaffName}` : ""}`,
    actionType: "update",
    entityType: "booking",
    entityId: bookingId,
    entityName: bookingCode || `Booking for ${clientName}`,
    performedBy: performer.uid,
    performedByName: performer.name,
    performedByRole: performer.role,
    details: newStaffName ? `New staff: ${newStaffName}` : undefined,
    branchName,
  });
}

export async function logBookingSentToStaffServer(
  ownerUid: string,
  bookingId: string,
  bookingCode: string | undefined,
  clientName: string,
  performer: { uid: string; name: string; role: string },
  staffNames: string[],
  branchName?: string
) {
  return createAuditLogServer({
    ownerUid,
    action: `Booking sent to staff for approval`,
    actionType: "status_change",
    entityType: "booking",
    entityId: bookingId,
    entityName: bookingCode || `Booking for ${clientName}`,
    performedBy: performer.uid,
    performedByName: performer.name,
    performedByRole: performer.role,
    previousValue: "Pending",
    newValue: "AwaitingStaffApproval",
    details: `Assigned to: ${staffNames.join(", ")}`,
    branchName,
  });
}

// ==================== STAFF MANAGEMENT AUDIT HELPERS (SERVER) ====================

export async function logStaffCreatedServer(
  ownerUid: string,
  staffId: string,
  staffName: string,
  staffRole: string,
  branchName: string,
  performer: { uid: string; name: string; role: string }
) {
  return createAuditLogServer({
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

export async function logStaffSuspendedServer(
  ownerUid: string,
  staffId: string,
  staffName: string,
  performer: { uid: string; name: string; role: string },
  suspended: boolean
) {
  return createAuditLogServer({
    ownerUid,
    action: `Staff member ${suspended ? "suspended" : "unsuspended"}: ${staffName}`,
    actionType: "status_change",
    entityType: "staff",
    entityId: staffId,
    entityName: staffName,
    performedBy: performer.uid,
    performedByName: performer.name,
    performedByRole: performer.role,
    newValue: suspended ? "Suspended" : "Active",
  });
}

export async function logStaffDeletedServer(
  ownerUid: string,
  staffId: string,
  staffName: string,
  performer: { uid: string; name: string; role: string }
) {
  return createAuditLogServer({
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

// ==================== SERVICE COMPLETION AUDIT HELPERS (SERVER) ====================

export async function logBookingServiceCompletedServer(
  ownerUid: string,
  bookingId: string,
  bookingCode: string | undefined,
  clientName: string,
  performer: { uid: string; name: string; role: string },
  serviceName?: string,
  allServicesCompleted?: boolean,
  branchName?: string
) {
  const actionText = allServicesCompleted 
    ? `Booking completed${serviceName ? `: ${serviceName}` : ""}`
    : `Service completed${serviceName ? `: ${serviceName}` : ""}`;
  
  return createAuditLogServer({
    ownerUid,
    action: actionText,
    actionType: "status_change",
    entityType: "booking",
    entityId: bookingId,
    entityName: bookingCode || `Booking for ${clientName}`,
    performedBy: performer.uid,
    performedByName: performer.name,
    performedByRole: performer.role,
    previousValue: allServicesCompleted ? "Confirmed" : "In Progress",
    newValue: allServicesCompleted ? "Completed" : "Service Completed",
    details: serviceName ? `Service: ${serviceName}` : undefined,
    branchName,
  });
}

