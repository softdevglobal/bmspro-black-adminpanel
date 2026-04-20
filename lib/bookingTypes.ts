import { isChecklistSection, type ChecklistSection } from "./services";

export type BookingStatus = 
  | "Pending" 
  | "AwaitingStaffApproval" 
  | "PartiallyApproved"  // Some services accepted, waiting for others
  | "StaffRejected" 
  | "Confirmed" 
  | "Completed" 
  | "Canceled";

export const BOOKING_STATUSES: BookingStatus[] = [
  "Pending", 
  "AwaitingStaffApproval", 
  "PartiallyApproved",
  "StaffRejected", 
  "Confirmed", 
  "Completed", 
  "Canceled"
];

// Per-service approval status for multi-service bookings
export type ServiceApprovalStatus = "pending" | "accepted" | "rejected" | "needs_assignment";

// Per-service completion status for tracking when staff finishes their work
export type ServiceCompletionStatus = "pending" | "completed";

// Service structure with approval and completion tracking
export interface BookingService {
  id: string | number;
  name?: string;
  price?: number;
  duration?: number;
  time?: string; // Time in branch's local timezone (HH:mm)
  timeUtc?: string; // Time stored in UTC ISO format
  staffId?: string | null;
  staffName?: string | null;
  // Per-service approval tracking
  approvalStatus?: ServiceApprovalStatus;
  acceptedAt?: any; // Firestore timestamp
  rejectedAt?: any; // Firestore timestamp
  rejectionReason?: string;
  respondedByStaffUid?: string;
  respondedByStaffName?: string;
  // Per-service completion tracking (for staff to mark their work as done)
  completionStatus?: ServiceCompletionStatus;
  completedAt?: any; // Firestore timestamp or ISO string
  completedByStaffUid?: string;
  completedByStaffName?: string;
  /** Owner-chosen vehicle-area ordering at booking time (e.g. interior → engine_bay → …). Snapshotted so old bookings keep their display order even if the service is edited later. Falls back to DEFAULT_AREA_ORDER when absent. */
  areaOrder?: ChecklistSection[];
}

export function normalizeBookingStatus(value: string | null | undefined): BookingStatus {
  const v = String(value || "").toLowerCase().replace(/[_\s-]/g, "");
  if (v === "pending") return "Pending";
  if (v === "awaitingstaffapproval") return "AwaitingStaffApproval";
  if (v === "partiallyapproved") return "PartiallyApproved";
  if (v === "staffrejected") return "StaffRejected";
  if (v === "confirmed") return "Confirmed";
  if (v === "completed") return "Completed";
  // Accept both spellings, store as single-L "Canceled" for consistency with existing data
  if (v === "canceled" || v === "cancelled") return "Canceled";
  return "Pending";
}

export function canTransitionStatus(current: BookingStatus, next: BookingStatus): boolean {
  // Booking workflow with partial staff assignment support:
  // 
  // Scenario A: ALL services have specific staff assigned
  //   → Status: AwaitingStaffApproval
  //   → All assigned staff members receive notifications
  //   → No admin action needed initially
  // 
  // Scenario B: SOME services have staff, SOME have "Any Available"
  //   → Status: AwaitingStaffApproval (assigned staff can respond)
  //   → Assigned staff receive notifications
  //   → Admin also gets notification to assign staff for remaining services
  //   → Services with staff have approvalStatus: "pending"
  //   → Services without staff have approvalStatus: "needs_assignment"
  // 
  // Scenario C: ALL services have "Any Available" (no staff assigned)
  //   → Status: Pending (goes to admin first)
  //   → Admin assigns staff to all services
  //   → Pending -> AwaitingStaffApproval (admin confirms, sends to staff)
  //   → Pending -> Canceled (admin cancels)
  // 
  // Staff approval flow:
  //   AwaitingStaffApproval -> PartiallyApproved (some staff accept, waiting for others)
  //   AwaitingStaffApproval -> Confirmed (all staff accept - single service or all services)
  //   AwaitingStaffApproval -> StaffRejected (any staff rejects when there's a rejected service to handle)
  //   AwaitingStaffApproval -> Canceled (admin cancels)
  // 
  // Partial approval flow:
  //   PartiallyApproved -> Confirmed (remaining staff accept)
  //   PartiallyApproved -> StaffRejected (any staff rejects - needs admin reassignment)
  //   PartiallyApproved -> Canceled (admin cancels)
  // 
  // Staff rejection flow (admin handles):
  //   StaffRejected -> AwaitingStaffApproval (admin reassigns rejected service to new staff)
  //   StaffRejected -> PartiallyApproved (admin reassigns and some are still accepted)
  //   StaffRejected -> Canceled (admin cancels after rejection)
  // 
  // Completion flow:
  //   Confirmed -> Completed (booking completed)
  //   Confirmed -> Canceled (admin cancels confirmed booking)
  
  if (current === "Pending" && next === "AwaitingStaffApproval") return true;
  if (current === "Pending" && next === "Confirmed") return true; // Owner/admin confirms with staff assigned (no staff approval)
  if (current === "Pending" && next === "Canceled") return true;
  if (current === "AwaitingStaffApproval" && next === "PartiallyApproved") return true;
  if (current === "AwaitingStaffApproval" && next === "Confirmed") return true;
  if (current === "AwaitingStaffApproval" && next === "StaffRejected") return true;
  if (current === "AwaitingStaffApproval" && next === "Canceled") return true;
  if (current === "PartiallyApproved" && next === "Confirmed") return true;
  if (current === "PartiallyApproved" && next === "StaffRejected") return true;
  if (current === "PartiallyApproved" && next === "Canceled") return true;
  if (current === "StaffRejected" && next === "AwaitingStaffApproval") return true;
  if (current === "StaffRejected" && next === "PartiallyApproved") return true;
  if (current === "StaffRejected" && next === "Canceled") return true;
  if (current === "Confirmed" && next === "Completed") return true;
  if (current === "Confirmed" && next === "Canceled") return true;
  return false;
}

/**
 * Get human-readable status label
 */
export function getStatusLabel(status: BookingStatus): string {
  switch (status) {
    case "Pending": return "Pending";
    case "AwaitingStaffApproval": return "Awaiting Staff";
    case "PartiallyApproved": return "Partially Approved";
    case "StaffRejected": return "Staff Rejected";
    case "Confirmed": return "Confirmed";
    case "Completed": return "Completed";
    case "Canceled": return "Canceled";
    default: return status;
  }
}

/**
 * Get status color classes for UI
 */
export function getStatusColor(status: BookingStatus): { bg: string; text: string; border: string } {
  switch (status) {
    case "Pending":
      return { bg: "bg-amber-50", text: "text-amber-700", border: "border-amber-200" };
    case "AwaitingStaffApproval":
      return { bg: "bg-blue-50", text: "text-blue-700", border: "border-blue-200" };
    case "PartiallyApproved":
      return { bg: "bg-cyan-50", text: "text-cyan-700", border: "border-cyan-200" };
    case "StaffRejected":
      return { bg: "bg-orange-50", text: "text-orange-700", border: "border-orange-200" };
    case "Confirmed":
      return { bg: "bg-emerald-50", text: "text-emerald-700", border: "border-emerald-200" };
    case "Completed":
      return { bg: "bg-indigo-50", text: "text-indigo-700", border: "border-indigo-200" };
    case "Canceled":
      return { bg: "bg-rose-50", text: "text-rose-700", border: "border-rose-200" };
    default:
      return { bg: "bg-slate-50", text: "text-slate-700", border: "border-slate-200" };
  }
}

/**
 * Get color for service approval status
 */
export function getServiceApprovalColor(status: ServiceApprovalStatus): { bg: string; text: string; border: string } {
  switch (status) {
    case "pending":
      return { bg: "bg-amber-50", text: "text-amber-700", border: "border-amber-200" };
    case "accepted":
      return { bg: "bg-emerald-50", text: "text-emerald-700", border: "border-emerald-200" };
    case "rejected":
      return { bg: "bg-rose-50", text: "text-rose-700", border: "border-rose-200" };
    case "needs_assignment":
      return { bg: "bg-purple-50", text: "text-purple-700", border: "border-purple-200" };
    default:
      return { bg: "bg-slate-50", text: "text-slate-700", border: "border-slate-200" };
  }
}

/**
 * Get human-readable label for service approval status
 */
export function getServiceApprovalLabel(status: ServiceApprovalStatus | undefined): string {
  switch (status) {
    case "pending":
      return "Awaiting Staff";
    case "accepted":
      return "Accepted";
    case "rejected":
      return "Rejected";
    case "needs_assignment":
      return "Not Assigned Yet";
    default:
      return "Unknown";
  }
}

/**
 * Helper to determine booking status based on service approvals
 */
export function calculateBookingStatusFromServices(services: BookingService[]): BookingStatus {
  if (!services || services.length === 0) return "AwaitingStaffApproval";
  
  const statuses = services.map(s => s.approvalStatus || "pending");
  const allAccepted = statuses.every(s => s === "accepted");
  const anyRejected = statuses.some(s => s === "rejected");
  const anyAccepted = statuses.some(s => s === "accepted");
  const allNeedsAssignment = statuses.every(s => s === "needs_assignment");
  const anyNeedsAssignment = statuses.some(s => s === "needs_assignment");
  
  // If all services need assignment, booking should be Pending
  if (allNeedsAssignment) return "Pending";
  
  // If all services are accepted, booking is confirmed
  if (allAccepted) return "Confirmed";
  
  // If any rejected, needs admin action
  if (anyRejected) return "StaffRejected";
  
  // If some accepted and some still pending/needs_assignment
  if (anyAccepted) return "PartiallyApproved";
  
  // Otherwise awaiting staff approval (mix of pending and needs_assignment)
  return "AwaitingStaffApproval";
}

/**
 * Check if all services in a booking are completed
 * Returns true if all services have completionStatus === "completed"
 */
export function areAllServicesCompleted(services: BookingService[]): boolean {
  if (!services || services.length === 0) return false;
  return services.every(s => s.completionStatus === "completed");
}

/**
 * Get completion progress for a booking
 * Returns { completed: number, total: number, percentage: number }
 */
export function getServiceCompletionProgress(services: BookingService[]): { completed: number; total: number; percentage: number } {
  if (!services || services.length === 0) return { completed: 0, total: 0, percentage: 0 };
  
  const total = services.length;
  const completed = services.filter(s => s.completionStatus === "completed").length;
  const percentage = Math.round((completed / total) * 100);
  
  return { completed, total, percentage };
}

/**
 * Get color for service completion status
 */
export function getServiceCompletionColor(status: ServiceCompletionStatus | undefined): { bg: string; text: string; border: string } {
  switch (status) {
    case "completed":
      return { bg: "bg-emerald-50", text: "text-emerald-700", border: "border-emerald-200" };
    case "pending":
    default:
      return { bg: "bg-amber-50", text: "text-amber-700", border: "border-amber-200" };
  }
}

/**
 * Check if a booking status should block time slots (i.e., is an active booking)
 * Returns true if the booking is active and should block slots
 * Returns false if the booking is inactive (cancelled, completed, rejected) and should NOT block slots
 */
export function shouldBlockSlots(status: string | null | undefined): boolean {
  if (!status) return true; // No status = assume active (block slots)
  const normalized = normalizeBookingStatus(status);
  // These statuses should NOT block slots (booking is inactive)
  const inactiveStatuses: BookingStatus[] = ['Canceled', 'Completed', 'StaffRejected'];
  return !inactiveStatuses.includes(normalized);
}

/**
 * Check if a booking counts toward the daily booking limit.
 * Daily limit is a capacity/regulation rule: cancelled bookings free up a slot,
 * but completed bookings do NOT (they used that day's capacity).
 * Returns true if the booking counts toward the limit.
 */
export function countsTowardDailyLimit(status: string | null | undefined): boolean {
  if (!status) return true;
  const normalized = normalizeBookingStatus(status);
  // Only cancelled and staff-rejected don't count (slot was never used)
  const excludeFromLimit: BookingStatus[] = ['Canceled', 'StaffRejected'];
  return !excludeFromLimit.includes(normalized);
}

// ─── Staff Task Management ───────────────────────────────────────────────────

/** A single task within a booking (copied from service checklist at booking creation) */
export interface BookingTask {
  id: string;                    // Unique task ID e.g. "task_0"
  serviceId?: string;            // Which service this task belongs to
  serviceName?: string;          // Service name for display
  name: string;                  // Task name (from checklist)
  description: string;           // Task description (from checklist)
  /** Which part of the vehicle this task applies to (interior/engine_bay/underbody/exterior). Snapshotted from the service checklist at booking creation so existing bookings keep their grouping even if the service is edited later. */
  section?: ChecklistSection;
  done: boolean;                 // Completion status
  imageUrl: string;              // Photo uploaded by staff after task completion
  staffNote: string;             // Description of work done by staff
  completedAt?: string | null;   // ISO timestamp when completed
  completedByStaffUid?: string | null;
  completedByStaffName?: string | null;
}

/** Additional issue found during technician inspection - requires owner/admin to set price */
export interface AdditionalIssue {
  id: string;
  issueTitle: string;
  description: string;
  recommendedRepair: string;
  partsRequired: string;
  labourTimeHours: number;
  imageUrl?: string | null;        // Photo of the issue (technician uploads)
  price?: number | null;           // Set by owner/branch admin
  priceSetAt?: string | null;     // ISO timestamp
  priceSetByUid?: string | null;
  priceSetByName?: string | null;
  status: "pending" | "approved" | "rejected";
  reportedAt: string;             // ISO timestamp
  reportedByStaffUid: string;
  reportedByStaffName: string;
  serviceId?: string | null;      // Which service this was found during
  customerResponse?: "accept" | "reject" | null;  // Customer's decision when status is approved
  customerRespondedAt?: string | null;
  customerRespondedBy?: string | null;            // customerId/email
  // Completion (when customer accepted - technician must complete with image + description before booking completion)
  completionStatus?: "pending" | "completed";
  completionImageUrl?: string | null;
  completionNote?: string | null;
  completedAt?: string | null;
  completedByStaffUid?: string | null;
  completedByStaffName?: string | null;
}

/** Final submission after all tasks are completed */
export interface BookingFinalSubmission {
  description: string;           // Overall description
  imageUrl: string;              // Final image
  submittedAt?: string | null;   // ISO timestamp
  submittedByStaffUid?: string | null;
  submittedByStaffName?: string | null;
}

/**
 * Get task completion progress for a booking
 * Returns { completed: number, total: number, percentage: number }
 */
export function getTaskProgress(tasks: BookingTask[]): { completed: number; total: number; percentage: number } {
  if (!tasks || tasks.length === 0) return { completed: 0, total: 0, percentage: 0 };
  const total = tasks.length;
  const completed = tasks.filter(t => t.done).length;
  const percentage = Math.round((completed / total) * 100);
  return { completed, total, percentage };
}

/**
 * Check if all tasks in a booking are completed
 */
export function areAllTasksCompleted(tasks: BookingTask[]): boolean {
  if (!tasks || tasks.length === 0) return false;
  return tasks.every(t => t.done);
}

/**
 * Normalize raw task data from Firestore into BookingTask[]
 */
export function normalizeTasks(raw: any[]): BookingTask[] {
  if (!raw || !Array.isArray(raw)) return [];
  return raw.map((t, idx) => ({
    id: t.id || `task_${idx}`,
    serviceId: t.serviceId || "",
    serviceName: t.serviceName || "",
    name: t.name || "",
    description: t.description || "",
    section: isChecklistSection(t.section) ? t.section : undefined,
    done: !!t.done,
    imageUrl: t.imageUrl || "",
    staffNote: t.staffNote || "",
    completedAt: t.completedAt || null,
    completedByStaffUid: t.completedByStaffUid || null,
    completedByStaffName: t.completedByStaffName || null,
  }));
}

/**
 * Normalize final submission data from Firestore
 */
export function normalizeFinalSubmission(raw: any): BookingFinalSubmission | null {
  if (!raw) return null;
  return {
    description: raw.description || "",
    imageUrl: raw.imageUrl || "",
    submittedAt: raw.submittedAt || null,
    submittedByStaffUid: raw.submittedByStaffUid || null,
    submittedByStaffName: raw.submittedByStaffName || null,
  };
}