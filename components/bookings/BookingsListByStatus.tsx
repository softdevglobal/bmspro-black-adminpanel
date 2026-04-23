"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { auth, db } from "@/lib/firebase";
import { collection, getDocs, onSnapshot, query, where } from "firebase/firestore";
import type { BookingStatus } from "@/lib/bookingTypes";
import { normalizeBookingStatus, getStatusLabel, getStatusColor } from "@/lib/bookingTypes";
import {
  type ChecklistSection,
  CHECKLIST_SECTION_LABELS,
  DEFAULT_AREA_ORDER,
  isChecklistSection,
  normalizeAreaOrder,
  VEHICLE_TYPE_LABELS,
  VEHICLE_TYPE_ICONS,
  isVehicleType,
  type VehicleType,
} from "@/lib/services";
import Sidebar from "@/components/Sidebar";
import { updateBookingStatus } from "@/lib/bookings";
import BookingsExportModal from "./BookingsExportModal";
import BookingJobReportPdfViewer from "./BookingJobReportPdfViewer";
import { bookingJobReportPdfFilename } from "@/lib/bookingPdfFilename";
import {
  type TaskCondition,
  isTaskCondition,
  taskConditionOption,
} from "@/lib/taskCondition";

/** Firestore may store mileageRecordedAt as an ISO string or a Timestamp. */
function parseMileageRecordedAt(value: unknown): Date | null {
  if (value == null) return null;
  if (typeof value === "string") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === "object" && value !== null && typeof (value as { toDate?: () => Date }).toDate === "function") {
    const d = (value as { toDate: () => Date }).toDate();
    return d instanceof Date && !Number.isNaN(d.getTime()) ? d : null;
  }
  return null;
}

/**
 * Reschedule / reassign: only staff who work at this branch on the given date
 * (weekly per-day `branchId` when present, else home `branchId`).
 */
function filterStaffToBookingBranchForDate(
  staffRows: any[],
  branchId: string | null | undefined,
  dateYmd: string
): any[] {
  const bid = (branchId || "").toString().trim();
  if (!bid) return staffRows;
  if (!dateYmd || !/^\d{4}-\d{2}-\d{2}$/.test(dateYmd)) {
    return staffRows.filter((s: any) => (s.branchId || "").toString() === bid);
  }
  const bookingDate = new Date(`${dateYmd}T12:00:00`);
  const daysOfWeek = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ];
  const dayName = daysOfWeek[bookingDate.getDay()];
  return staffRows.filter((s: any) => {
    if (s.weeklySchedule && typeof s.weeklySchedule === "object") {
      const daySchedule = s.weeklySchedule[dayName];
      if (daySchedule && daySchedule.branchId) {
        return (daySchedule.branchId || "").toString() === bid;
      }
      if (daySchedule === null || daySchedule === undefined) {
        return false;
      }
    }
    return (s.branchId || "").toString() === bid;
  });
}

type ServiceApprovalStatus = "pending" | "accepted" | "rejected" | "needs_assignment";
type ServiceCompletionStatus = "pending" | "completed";

type ServiceRow = {
  id: string | number;
  serviceId?: string | number;
  name?: string;
  price?: number;
  duration?: number;
  time?: string;
  /** Canonical size class the price/duration were resolved against (when booking used type-wise pricing). */
  vehicleType?: VehicleType | null;
  staffId?: string | null;
  staffName?: string | null;
  staffAuthUid?: string | null; // Firebase Auth UID for the assigned staff
  // Per-service approval tracking
  approvalStatus?: ServiceApprovalStatus;
  acceptedAt?: any;
  rejectedAt?: any;
  rejectionReason?: string;
  respondedByStaffUid?: string;
  respondedByStaffName?: string;
  // Per-service completion tracking
  completionStatus?: ServiceCompletionStatus;
  completedAt?: any;
  completedByStaffUid?: string;
  completedByStaffName?: string;
  // Owner's customised area ordering snapshotted at booking creation.
  areaOrder?: ChecklistSection[];
};

type Row = {
  id: string;
  client: string;
  serviceId?: string | null;
  serviceName?: string | null;
  staffId?: string | null;
  staffName?: string | null;
  branchId?: string | null;
  branchName?: string | null;
  date: string;
  time: string;
  pickupTime?: string | null;
  duration: number;
  price: number;
  clientEmail?: string | null;
  clientPhone?: string | null;
  vehicleNumber?: string | null;
  vehicleMake?: string | null;
  vehicleModel?: string | null;
  vehicleBodyType?: string | null;
  /** Canonical vehicle size class used for per-type pricing (small_car | sedan_wagon | suv | ute_van_4wd | performance_large). */
  vehicleType?: VehicleType | null;
  vehicleColour?: string | null;
  vehicleVinChassis?: string | null;
  vehicleEngineNumber?: string | null;
  vehicleMileage?: string | null;  // Customer-added at booking
  mileage?: string | null;         // Staff-recorded when starting job
  mileageRecordedByStaffName?: string | null;
  mileageRecordedAt?: string | null; // ISO string (normalized from Firestore)
  fuelLevel?: string | null;       // Staff-recorded at vehicle check-in
  existingDamageNotes?: string | null;
  existingDamageImages?: string[] | null;
  notes?: string | null;
  status?: string | null;
  bookingCode?: string | null;
  bookingSource?: string | null;
  // Rejection info (for StaffRejected bookings)
  rejectionReason?: string | null;
  rejectedByStaffName?: string | null;
  rejectedByStaffUid?: string | null;
  // Multi-rejection info
  lastRejectedByStaffName?: string | null;
  lastRejectionReason?: string | null;
  services?: ServiceRow[] | null;
  // Task management
  tasks?: TaskRow[] | null;
  taskProgress?: number;
  finalSubmission?: {
    description: string;
    imageUrl: string;
    submittedAt?: string | null;
    submittedByStaffName?: string | null;
  } | null;
  // Additional issues (technician-reported, owner/admin sets price)
  additionalIssues?: AdditionalIssueRow[] | null;
};

type AdditionalIssueRow = {
  id: string;
  issueTitle: string;
  description?: string | null;
  recommendedRepair?: string | null;
  partsRequired?: string | null;
  labourTimeHours?: number | null;
  price?: number | null;
  priceSetAt?: string | null;
  priceSetByName?: string | null;
  status?: "pending" | "approved" | "rejected";
  customerResponse?: "accept" | "reject" | null;
  reportedAt?: string | null;
  reportedByStaffName?: string | null;
  serviceId?: string | null;
  imageUrl?: string | null;
  completionStatus?: string | null;
  completionImageUrl?: string | null;
  completionNote?: string | null;
  completedByStaffName?: string | null;
};

type TaskRow = {
  id: string;
  serviceId?: string;
  serviceName?: string;
  name: string;
  description: string;
  /** Vehicle area this task belongs to. Snapshotted from service checklist at booking creation. */
  section?: ChecklistSection;
  done: boolean;
  imageUrl: string;
  staffNote: string;
  /** Post-completion condition flag chosen by the staff member. */
  condition?: TaskCondition;
  completedAt?: string | null;
  completedByStaffUid?: string | null;
  completedByStaffName?: string | null;
};

function useBookingsByStatus(statuses: BookingStatus | BookingStatus[]) {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  // Normalize to array
  const statusArray = Array.isArray(statuses) ? statuses : [statuses];

  useEffect(() => {
    let unsub: (() => void) | null = null;
    let cancelled = false;
    setLoading(true);
    setError(null);

    const ensureAuth = async () => {
      const user = auth.currentUser;
      if (user?.uid) return user.uid;
      return new Promise<string>((resolve, reject) => {
        let off: (() => void) | null = null;
        const timeout = setTimeout(() => {
          if (off) off();
          reject(new Error("Authentication timeout"));
        }, 10000); // 10 second timeout
        off = auth.onAuthStateChanged((u) => {
          if (u?.uid) {
            clearTimeout(timeout);
            if (off) off();
            resolve(u.uid);
          }
        });
      });
    };

    (async () => {
      try {
        const userId = await ensureAuth();
        if (cancelled) return;
      
      // Get user data to check role and branch
      const { getDoc, doc: firestoreDoc } = await import("firebase/firestore");
      const userSnap = await getDoc(firestoreDoc(db, "users", userId));
      const userData = userSnap.data();
      const userRole = (userData?.role || "").toString();
      const ownerUid = userRole === "workshop_owner" ? userId : (userData?.ownerUid || userId);
      const userBranchId = userData?.branchId;
      
      // Build query constraints
      const constraints = [where("ownerUid", "==", ownerUid)];
      
      // Branch admin should only see bookings for their branch
      if (userRole === "branch_admin" && userBranchId) {
        constraints.push(where("branchId", "==", userBranchId));
      }
      
      // Query only "bookings" collection (booking engine now saves directly to bookings)
      const q = query(collection(db, "bookings"), ...constraints);
      unsub = onSnapshot(q, (snap) => {
        if (cancelled) return;
        
        let next: Row[] = [];
        snap.forEach((docSnap) => {
          const d = docSnap.data() as any;
          const normalizedStatus = normalizeBookingStatus(d?.status || null);
          // Check if status is in the array of statuses we're looking for
          if (statusArray.includes(normalizedStatus)) {
            next.push({
              id: docSnap.id,
              client: String(d.client || ""),
              serviceId: d.serviceId || null,
              serviceName: d.serviceName || null,
              staffId: d.staffId || null,
              staffName: d.staffName || null,
              branchId: d.branchId || null,
              branchName: d.branchName || null,
              date: String(d.date || ""),
              time: String(d.time || ""),
              pickupTime: d.pickupTime || null,
              duration: Number(d.duration || 0),
              price: Number(d.price || 0),
              clientEmail: d.clientEmail || null,
              clientPhone: d.clientPhone || null,
              vehicleNumber: d.vehicleNumber || null,
              vehicleMake: d.vehicleMake || null,
              vehicleModel: d.vehicleModel || null,
              vehicleBodyType: d.vehicleBodyType || null,
              vehicleType: isVehicleType(d.vehicleType) ? (d.vehicleType as VehicleType) : null,
              vehicleColour: d.vehicleColour || null,
              vehicleVinChassis: d.vehicleVinChassis || null,
              vehicleEngineNumber: d.vehicleEngineNumber || null,
              vehicleMileage: d.vehicleMileage || null,
              mileage: d.mileage || null,
              mileageRecordedByStaffName: d.mileageRecordedByStaffName || null,
              mileageRecordedAt: (() => {
                const dt = parseMileageRecordedAt(d.mileageRecordedAt);
                return dt ? dt.toISOString() : null;
              })(),
              fuelLevel: d.fuelLevel || null,
              existingDamageNotes: d.existingDamageNotes || null,
              existingDamageImages: Array.isArray(d.existingDamageImages) ? d.existingDamageImages : null,
              notes: d.notes || null,
              status: normalizedStatus,
              bookingCode: d.bookingCode || null,
              bookingSource: d.bookingSource || null,
              // Rejection info
              rejectionReason: d.rejectionReason || null,
              rejectedByStaffName: d.rejectedByStaffName || null,
              rejectedByStaffUid: d.rejectedByStaffUid || null,
              // Multi-rejection info
              lastRejectedByStaffName: d.lastRejectedByStaffName || null,
              lastRejectionReason: d.lastRejectionReason || null,
              services: d.services?.map((s: any) => ({
                id: s.id,
                name: s.name,
                price: s.price,
                duration: s.duration,
                time: s.time,
                vehicleType: isVehicleType(s.vehicleType) ? (s.vehicleType as VehicleType) : null,
                staffId: s.staffId,
                staffName: s.staffName,
                approvalStatus: s.approvalStatus || "pending",
                acceptedAt: s.acceptedAt,
                rejectedAt: s.rejectedAt,
                rejectionReason: s.rejectionReason,
                respondedByStaffUid: s.respondedByStaffUid,
                respondedByStaffName: s.respondedByStaffName,
                // Service completion tracking
                completionStatus: s.completionStatus || "pending",
                completedAt: s.completedAt,
                completedByStaffUid: s.completedByStaffUid,
                completedByStaffName: s.completedByStaffName,
                // Owner's vehicle-area ordering snapshotted at booking creation.
                areaOrder: Array.isArray(s.areaOrder)
                  ? (s.areaOrder.filter(isChecklistSection) as ChecklistSection[])
                  : undefined,
              })) || null,
              // Task management
              tasks: Array.isArray(d.tasks) ? d.tasks.map((t: any) => ({
                id: t.id || "",
                serviceId: t.serviceId || "",
                serviceName: t.serviceName || "",
                name: t.name || "",
                description: t.description || "",
                section: isChecklistSection(t.section) ? t.section : undefined,
                done: !!t.done,
                imageUrl: t.imageUrl || "",
                staffNote: t.staffNote || "",
                condition: isTaskCondition(t.condition) ? t.condition : undefined,
                completedAt: t.completedAt || null,
                completedByStaffUid: t.completedByStaffUid || null,
                completedByStaffName: t.completedByStaffName || null,
              })) : null,
              taskProgress: typeof d.taskProgress === "number" ? d.taskProgress : 0,
              finalSubmission: d.finalSubmission || null,
              additionalIssues: Array.isArray(d.additionalIssues) ? d.additionalIssues.map((i: any) => ({
                id: i.id || "",
                issueTitle: i.issueTitle || "",
                description: i.description || null,
                recommendedRepair: i.recommendedRepair || null,
                partsRequired: i.partsRequired || null,
                labourTimeHours: i.labourTimeHours ?? null,
                imageUrl: i.imageUrl || null,
                price: i.price ?? null,
                priceSetAt: i.priceSetAt || null,
                priceSetByName: i.priceSetByName || null,
                status: i.status || "pending",
                reportedAt: i.reportedAt || null,
                reportedByStaffName: i.reportedByStaffName || null,
                serviceId: i.serviceId || null,
                customerResponse: i.customerResponse || null,
                completionStatus: i.completionStatus || null,
                completionImageUrl: i.completionImageUrl || null,
                completionNote: i.completionNote || null,
                completedByStaffName: i.completedByStaffName || null,
              })) : null,
            });
          }
        });
        // Sort by date asc, then time asc (upcoming bookings first - soonest at top)
        next = next.sort((a, b) => {
          if (a.date === b.date) {
            return a.time < b.time ? -1 : a.time > b.time ? 1 : 0;
          }
          return a.date < b.date ? -1 : 1;
        });
        setRows(next);
        setLoading(false);
      }, (e) => {
        if (cancelled) return;
        if (e?.code === "permission-denied") {
          console.warn("Permission denied for bookings query. User may not be authenticated.");
          setError("Permission denied. Please check your authentication.");
          setRows([]);
        } else {
          setError(e?.message || "Failed to load bookings");
        }
        setLoading(false);
      });
      } catch (authError: any) {
        if (cancelled) return;
        console.error("Authentication error:", authError);
        setError("Authentication failed. Please log in again.");
        setLoading(false);
        setRows([]);
      }
    })();

    return () => {
      cancelled = true;
      if (unsub) unsub();
    };
  }, [statusArray.join(",")]);

  return { rows, loading, error };
}

/** Format labour hours as creative minutes display (e.g. 0.5 → "30 min", 1.5 → "90 min") */
function formatLabourMinutes(hours: number | null | undefined): string | null {
  if (hours == null) return null;
  const mins = Math.round(hours * 60);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export default function BookingsListByStatus({ status, title, showStaffColumn = true, showExportButton = false, openBookingId: openBookingIdProp }: { status: BookingStatus | BookingStatus[]; title: string; showStaffColumn?: boolean; showExportButton?: boolean; openBookingId?: string }) {
  const searchParams = useSearchParams();
  const openFromUrl = searchParams.get("open") || searchParams.get("highlight");
  const openBookingId = openBookingIdProp ?? openFromUrl ?? undefined;
  const { rows, loading, error } = useBookingsByStatus(status);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [updatingState, setUpdatingState] = useState<Record<string, string | null>>({});
  
  // Check if a booking has services that need staff assignment
  const hasServicesNeedingAssignment = (row: Row): boolean => {
    if (!row.services || row.services.length === 0) return false;
    return row.services.some(s => 
      s.approvalStatus === "needs_assignment" || 
      (!s.staffId && s.approvalStatus !== "accepted" && s.approvalStatus !== "rejected")
    );
  };

  // Once staff tap "Start" on the appointment they record `mileage` on the
  // booking doc — at that point the job is physically in progress and we
  // don't allow the slot to be moved.
  const isJobInProgress = (row?: Row): boolean => {
    if (!row) return false;
    return ((row.mileage ?? "") as string).toString().trim() !== "";
  };

  // Get allowed actions per row based on the row's actual status.
  // `Reschedule` is allowed for any non-terminal status on bookings that have
  // not been started by staff yet (i.e. no mileage recorded). Once the job is
  // in progress the admin must cancel the booking to change its time.
  const getAllowedActions = (rowStatus: BookingStatus | string | null | undefined, row?: Row): ReadonlyArray<"Confirm" | "Cancel" | "Complete" | "Reassign" | "AssignStaff" | "Reschedule"> => {
    const normalizedStatus = normalizeBookingStatus(rowStatus ?? null);
    const jobInProgress = isJobInProgress(row);
    let actions: Array<"Confirm" | "Cancel" | "Complete" | "Reassign" | "AssignStaff" | "Reschedule"> = [];
    if (normalizedStatus === "Pending") {
      actions = ["Confirm", "Reschedule", "Cancel"];
    } else if (normalizedStatus === "AwaitingStaffApproval") {
      actions = row && hasServicesNeedingAssignment(row)
        ? ["AssignStaff", "Reschedule", "Cancel"]
        : ["Reschedule", "Cancel"];
    } else if (normalizedStatus === "PartiallyApproved") {
      actions = row && hasServicesNeedingAssignment(row)
        ? ["AssignStaff", "Reschedule", "Cancel"]
        : ["Reschedule", "Cancel"];
    } else if (normalizedStatus === "StaffRejected") {
      actions = ["Reassign", "Reschedule", "Cancel"];
    } else if (normalizedStatus === "Confirmed") {
      actions = ["Complete", "Reschedule", "Cancel"];
    } else {
      return [];
    }
    if (jobInProgress) {
      actions = actions.filter((a) => a !== "Reschedule");
    }
    return actions;
  };
  
  // For preview panel - use the first status or check if any status allows actions
  const allowedActions = useMemo<ReadonlyArray<"Confirm" | "Cancel" | "Complete" | "Reassign" | "Reschedule">>(() => {
    const statusArray = Array.isArray(status) ? status : [status];
    if (statusArray.includes("Pending")) return ["Confirm", "Reschedule", "Cancel"];
    if (statusArray.includes("AwaitingStaffApproval")) return ["Reschedule", "Cancel"];
    if (statusArray.includes("PartiallyApproved")) return ["Reschedule", "Cancel"];
    if (statusArray.includes("StaffRejected")) return ["Reassign", "Reschedule", "Cancel"];
    if (statusArray.includes("Confirmed")) return ["Complete", "Reschedule", "Cancel"];
    return [];
  }, [status]);
  const [previewRow, setPreviewRow] = useState<Row | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [lightboxImage, setLightboxImage] = useState<{ url: string; title: string } | null>(null);
  const [mileageEditValue, setMileageEditValue] = useState("");
  const [mileageSaving, setMileageSaving] = useState(false);

  // Additional issue price modal
  const [issuePriceModal, setIssuePriceModal] = useState<{ bookingId: string; issue: AdditionalIssueRow } | null>(null);
  const [issuePriceValue, setIssuePriceValue] = useState("");
  const [issuePriceSaving, setIssuePriceSaving] = useState(false);

  // Customer-response modal (owner/branch admin records the customer's
  // decision on an additional-work quote after calling the customer).
  const [customerResponseModal, setCustomerResponseModal] = useState<{
    bookingId: string;
    issue: AdditionalIssueRow;
    action: "accept" | "reject";
  } | null>(null);
  const [customerResponseSaving, setCustomerResponseSaving] = useState(false);

  // Staff assignment modal state
  const [staffAssignModalOpen, setStaffAssignModalOpen] = useState(false);
  const [bookingToConfirm, setBookingToConfirm] = useState<Row | null>(null);
  const [selectedStaffId, setSelectedStaffId] = useState<string>("");
  const [selectedStaffPerService, setSelectedStaffPerService] = useState<Record<string, string>>({});
  const [availableStaff, setAvailableStaff] = useState<Array<{ id: string; name: string; branchId?: string; avatar?: string }>>([]);
  const [availableStaffPerService, setAvailableStaffPerService] = useState<Record<string, Array<{ id: string; name: string; branchId?: string; avatar?: string }>>>({});
  const [loadingStaff, setLoadingStaff] = useState(false);
  const [serviceQualifiedStaffIds, setServiceQualifiedStaffIds] = useState<string[]>([]);
  const [currentServiceQualifiedStaffIds, setCurrentServiceQualifiedStaffIds] = useState<Record<string, string[]>>({});

  // Reassign modal state (for StaffRejected bookings)
  const [reassignModalOpen, setReassignModalOpen] = useState(false);
  const [bookingToReassign, setBookingToReassign] = useState<Row | null>(null);

  // ─── Reschedule (date/time amendment) modal state ──────────────────────
  // Owner / branch admin can change the date & time of any booking that is
  // not yet Completed or Canceled. The server enforces the real role gate
  // and writes a `rescheduleHistory` audit trail on the booking doc.
  const [rescheduleModalOpen, setRescheduleModalOpen] = useState(false);
  const [bookingToReschedule, setBookingToReschedule] = useState<Row | null>(null);
  const [rescheduleNewDate, setRescheduleNewDate] = useState<string>("");
  const [rescheduleNewTime, setRescheduleNewTime] = useState<string>("");
  const [rescheduleNewPickupTime, setRescheduleNewPickupTime] = useState<string>("");
  const [rescheduleCalendarMonth, setRescheduleCalendarMonth] = useState<{ year: number; month: number }>(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() };
  });
  type BranchDayHours = { open?: string; close?: string; closed?: boolean };
  type BranchLite = {
    id: string;
    name?: string;
    timezone?: string;
    hours?:
      | string
      | Record<string, BranchDayHours | undefined>;
  };
  const [rescheduleBranch, setRescheduleBranch] = useState<BranchLite | null>(null);
  const [rescheduleBranchLoading, setRescheduleBranchLoading] = useState(false);
  // Ticks every minute so the "branch current time" chip stays fresh.
  const [rescheduleNowTick, setRescheduleNowTick] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!rescheduleModalOpen) return;
    const id = window.setInterval(() => setRescheduleNowTick(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, [rescheduleModalOpen]);
  const [rescheduleReason, setRescheduleReason] = useState<string>("");
  const [rescheduleSaving, setRescheduleSaving] = useState(false);
  const [rescheduleError, setRescheduleError] = useState<string | null>(null);
  // Staff reassignment inside the reschedule modal. Either `rescheduleStaffId`
  // (single-service booking) or `rescheduleStaffByService` (keyed by service
  // id) is used depending on the booking shape. Values are compared against
  // the booking's original assignments to decide whether to send staff
  // overrides to the API on save.
  type ReschedStaffOption = { id: string; name: string; branchId?: string; avatar?: string };
  /** Full user rows (for branch + weeklySchedule filter when date changes). */
  const [rescheduleStaffRaw, setRescheduleStaffRaw] = useState<any[]>([]);
  const [rescheduleStaffOptions, setRescheduleStaffOptions] = useState<ReschedStaffOption[]>([]);
  const [rescheduleStaffLoading, setRescheduleStaffLoading] = useState(false);
  const [rescheduleStaffId, setRescheduleStaffId] = useState<string>("");
  const [rescheduleStaffByService, setRescheduleStaffByService] = useState<Record<string, string>>({});

  // Export modal
  const [exportModalOpen, setExportModalOpen] = useState(false);

  // Fallback area-order cache for older bookings whose service snapshots were
  // written before we started snapshotting `areaOrder`. When we open a booking
  // preview, any task whose matching service entry lacks `areaOrder` triggers
  // a lookup on the live `services/{id}` document so the checklist still shows
  // in the owner's customised order rather than the default.
  const [serviceAreaOrderFallback, setServiceAreaOrderFallback] = useState<Record<string, ChecklistSection[]>>({});

  useEffect(() => {
    if (!rescheduleModalOpen) return;
    if (!rescheduleStaffRaw.length) {
      setRescheduleStaffOptions([]);
      return;
    }
    const row = bookingToReschedule;
    if (!row) return;
    const dateEff = (rescheduleNewDate || row.date || "").trim();
    const pool = filterStaffToBookingBranchForDate(
      rescheduleStaffRaw,
      row.branchId,
      dateEff
    );
    setRescheduleStaffOptions(
      pool.map((s: any) => ({
        id: String(s._rescheduleId || s.id),
        name: String(s.name || s.displayName || "Unknown"),
        branchId: s.branchId,
        avatar: s.avatar,
      }))
    );
  }, [
    rescheduleModalOpen,
    bookingToReschedule,
    rescheduleNewDate,
    rescheduleStaffRaw,
  ]);

  // Sync mileage edit value when preview row changes
  useEffect(() => {
    if (previewRow?.mileage) {
      const val = String(previewRow.mileage).replace(/\s*km\s*$/i, "").trim();
      setMileageEditValue(val);
    } else {
      setMileageEditValue("");
    }
  }, [previewRow?.id, previewRow?.mileage]);

  // Lazily fetch the live `areaOrder` for any service referenced by the open
  // preview whose service snapshot lacks it. Runs once per preview open and
  // only for services not already in the fallback cache — cheap and bounded.
  useEffect(() => {
    if (!previewRow || !previewRow.tasks || previewRow.tasks.length === 0) return;
    const services = previewRow.services || [];
    const idsNeeded = new Set<string>();
    for (const task of previewRow.tasks) {
      const svcId = task.serviceId ? String(task.serviceId) : "";
      if (!svcId) continue;
      const snapshot = services.find(
        (s) => String(s.id || s.serviceId || "") === svcId,
      );
      if (snapshot?.areaOrder && snapshot.areaOrder.length > 0) continue;
      if (serviceAreaOrderFallback[svcId]) continue;
      idsNeeded.add(svcId);
    }
    if (idsNeeded.size === 0) return;
    let cancelled = false;
    (async () => {
      try {
        const { getDoc, doc: firestoreDoc } = await import("firebase/firestore");
        const results: Record<string, ChecklistSection[]> = {};
        await Promise.all(
          Array.from(idsNeeded).map(async (id) => {
            try {
              const snap = await getDoc(firestoreDoc(db, "services", id));
              if (snap.exists()) {
                const raw = (snap.data() as any)?.areaOrder;
                if (Array.isArray(raw)) {
                  results[id] = normalizeAreaOrder(raw);
                }
              }
            } catch {}
          }),
        );
        if (!cancelled && Object.keys(results).length > 0) {
          setServiceAreaOrderFallback((prev) => ({ ...prev, ...results }));
        }
      } catch {}
    })();
    return () => {
      cancelled = true;
    };
  }, [previewRow, serviceAreaOrderFallback]);

  // Open preview for a specific booking when openBookingId is in the URL (e.g. from notification click)
  useEffect(() => {
    if (!openBookingId || loading || !rows.length) return;
    const row = rows.find((r) => r.id === openBookingId || String(r.id).startsWith(openBookingId) || openBookingId.startsWith(String(r.id)));
    if (row) {
      setPreviewRow(row);
      setPreviewOpen(true);
    }
  }, [openBookingId, loading, rows]);

  // Combined effect: Fetch services and staff together to ensure proper filtering
  useEffect(() => {
    if (!staffAssignModalOpen || !bookingToConfirm) return;

    let unsubServices: (() => void) | null = null;
    let unsubStaff: (() => void) | null = null;
    
    const fetchData = async () => {
      setLoadingStaff(true);
      try {
        const userId = auth.currentUser?.uid;
        if (!userId) return;

        const { getDoc, doc: firestoreDoc } = await import("firebase/firestore");
        const userSnap = await getDoc(firestoreDoc(db, "users", userId));
        const userData = userSnap.data();
        const userRole = (userData?.role || "").toString();
        const ownerUid = userRole === "workshop_owner" ? userId : (userData?.ownerUid || userId);

        const { subscribeServicesForOwner } = await import("@/lib/services");
        const { subscribeSalonStaffForOwner } = await import("@/lib/salonStaff");

        // Fetch staff on approved leave for the booking date (exclude from assignable list - like mobile app)
        const staffIdsOnLeave = new Set<string>();
        if (bookingToConfirm.date) {
          try {
            const leaveSnap = await getDocs(
              query(
                collection(db, "leave_requests"),
                where("ownerUid", "==", ownerUid),
                where("status", "==", "approved")
              )
            );
            const bookingDateOnly = new Date(bookingToConfirm.date);
            bookingDateOnly.setHours(0, 0, 0, 0);
            for (const docSnap of leaveSnap.docs) {
              const d = docSnap.data();
              const staffId = (d.staffId ?? "").toString();
              if (!staffId) continue;
              const start = d.startDate;
              const end = d.endDate ?? start;
              if (!start || !end) continue;
              const startDate = start?.toDate ? start.toDate() : new Date(start);
              const endDate = end?.toDate ? end.toDate() : new Date(end);
              const startOnly = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
              const endOnly = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());
              if (bookingDateOnly >= startOnly && bookingDateOnly <= endOnly) {
                staffIdsOnLeave.add(staffId);
              }
            }
          } catch {
            // leave_requests may not exist; ignore
          }
        }

        // Track loaded data
        let servicesData: any[] = [];
        let staffData: any[] = [];

        const isStaffOnLeave = (s: any) =>
          staffIdsOnLeave.has(String(s.id)) || staffIdsOnLeave.has(String(s.authUid ?? ""));

        const processData = () => {
          if (servicesData.length === 0 || staffData.length === 0) return;

          const hasMultipleServices = Array.isArray(bookingToConfirm.services) && bookingToConfirm.services.length > 0;
          
          if (hasMultipleServices) {
            // Filter staff for each service
            const staffPerService: Record<string, Array<{ id: string; name: string; branchId?: string; avatar?: string }>> = {};
            
            bookingToConfirm.services!.forEach(bookingService => {
              // Use consistent key format
              const serviceKey = String(bookingService.id || bookingService.serviceId || bookingService.name);
              
              // Find service details by ID first, then by name fallback
              let service = servicesData.find((s: any) => String(s.id) === String(bookingService.id || bookingService.serviceId));
              // Fallback: find by name if ID lookup fails
              if (!service && bookingService.name) {
                service = servicesData.find((s: any) => 
                  s.name?.toLowerCase() === bookingService.name?.toLowerCase()
                );
              }
              const qualifiedStaffIds = (service && Array.isArray(service.staffIds)) ? service.staffIds.map(String) : [];
              
              // Start with active staff
              let filtered = staffData.filter((s: any) => s.status === "Active");
              
              // Filter by service qualification (only if service has specific staff assigned)
              if (qualifiedStaffIds.length > 0) {
                filtered = filtered.filter((s: any) => qualifiedStaffIds.includes(String(s.id)));
              }
              
              // Filter by branch and day (staff must work at this branch ON the booking date - like mobile app)
              if (bookingToConfirm.branchId && bookingToConfirm.date) {
                const bookingDate = new Date(bookingToConfirm.date);
                const daysOfWeek = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
                const dayName = daysOfWeek[bookingDate.getDay()];
                filtered = filtered.filter((s: any) => {
                  if (s.weeklySchedule && typeof s.weeklySchedule === "object") {
                    const daySchedule = s.weeklySchedule[dayName];
                    if (daySchedule && daySchedule.branchId) {
                      return daySchedule.branchId === bookingToConfirm.branchId;
                    }
                    if (daySchedule === null || daySchedule === undefined) {
                      return false; // Staff is off this day
                    }
                  }
                  return s.branchId === bookingToConfirm.branchId;
                });
              } else if (bookingToConfirm.branchId) {
                filtered = filtered.filter((s: any) => s.branchId === bookingToConfirm.branchId);
              }
              // Exclude staff on approved leave on the booking date
              filtered = filtered.filter((s: any) => !isStaffOnLeave(s));
              
              staffPerService[serviceKey] = filtered.map((s: any) => ({
                id: String(s.id),
                name: String(s.name || s.displayName || "Staff"),
                branchId: s.branchId,
                avatar: s.avatar || s.name || s.displayName || "Staff",
              }));
            });
            
            setAvailableStaffPerService(staffPerService);
          } else {
            // Single service - find by ID first, then by name fallback
            let service = servicesData.find((s: any) => String(s.id) === String(bookingToConfirm.serviceId));
            // Fallback: find by name if ID lookup fails
            if (!service && bookingToConfirm.serviceName) {
              service = servicesData.find((s: any) => 
                s.name?.toLowerCase() === bookingToConfirm.serviceName?.toLowerCase()
              );
            }
            const qualifiedStaffIds = (service && Array.isArray(service.staffIds)) ? service.staffIds.map(String) : [];
            
            let filtered = staffData.filter((s: any) => s.status === "Active");

            // Filter by service qualification (only if service has specific staff assigned)
            if (qualifiedStaffIds.length > 0) {
              filtered = filtered.filter((s: any) => qualifiedStaffIds.includes(String(s.id)));
            }

            // Filter by branch and day (staff must work at this branch ON the booking date - like mobile app)
            if (bookingToConfirm.branchId && bookingToConfirm.date) {
              const bookingDate = new Date(bookingToConfirm.date);
              const daysOfWeek = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
              const dayName = daysOfWeek[bookingDate.getDay()];
              filtered = filtered.filter((s: any) => {
                if (s.weeklySchedule && typeof s.weeklySchedule === "object") {
                  const daySchedule = s.weeklySchedule[dayName];
                  if (daySchedule && daySchedule.branchId) {
                    return daySchedule.branchId === bookingToConfirm.branchId;
                  }
                  if (daySchedule === null || daySchedule === undefined) {
                    return false; // Staff is off this day
                  }
                }
                return s.branchId === bookingToConfirm.branchId;
              });
            } else if (bookingToConfirm.branchId) {
              filtered = filtered.filter((s: any) => s.branchId === bookingToConfirm.branchId);
            }
            // Exclude staff on approved leave on the booking date
            filtered = filtered.filter((s: any) => !isStaffOnLeave(s));

            setAvailableStaff(
              filtered.map((s: any) => ({
                id: String(s.id),
                name: String(s.name || s.displayName || "Staff"),
                branchId: s.branchId,
                avatar: s.avatar || s.name || s.displayName || "Staff",
              }))
            );
          }
          
          setLoadingStaff(false);
        };

        // Subscribe to services
        unsubServices = subscribeServicesForOwner(ownerUid, (services) => {
          servicesData = services;
          processData();
        });

        // Subscribe to staff
        unsubStaff = subscribeSalonStaffForOwner(ownerUid, (staff) => {
          staffData = staff;
          processData();
        });

      } catch (err) {
        console.error("Error fetching data:", err);
        setLoadingStaff(false);
      }
    };

    fetchData();

    return () => {
      if (unsubServices) unsubServices();
      if (unsubStaff) unsubStaff();
    };
  }, [staffAssignModalOpen, bookingToConfirm]);

  // Effect for reassign modal - reuses the same staff fetching logic
  useEffect(() => {
    if (!reassignModalOpen || !bookingToReassign) return;

    let unsubServices: (() => void) | null = null;
    let unsubStaff: (() => void) | null = null;
    
    const fetchData = async () => {
      setLoadingStaff(true);
      try {
        const userId = auth.currentUser?.uid;
        if (!userId) return;

        const { getDoc, doc: firestoreDoc } = await import("firebase/firestore");
        const userSnap = await getDoc(firestoreDoc(db, "users", userId));
        const userData = userSnap.data();
        const userRole = (userData?.role || "").toString();
        const ownerUid = userRole === "workshop_owner" ? userId : (userData?.ownerUid || userId);

        const { subscribeServicesForOwner } = await import("@/lib/services");
        const { subscribeSalonStaffForOwner } = await import("@/lib/salonStaff");

        // Fetch staff on approved leave for the booking date (exclude from assignable list - like mobile app)
        const staffIdsOnLeave = new Set<string>();
        if (bookingToReassign.date) {
          try {
            const leaveSnap = await getDocs(
              query(
                collection(db, "leave_requests"),
                where("ownerUid", "==", ownerUid),
                where("status", "==", "approved")
              )
            );
            const bookingDateOnly = new Date(bookingToReassign.date);
            bookingDateOnly.setHours(0, 0, 0, 0);
            for (const docSnap of leaveSnap.docs) {
              const d = docSnap.data();
              const staffId = (d.staffId ?? "").toString();
              if (!staffId) continue;
              const start = d.startDate;
              const end = d.endDate ?? start;
              if (!start || !end) continue;
              const startDate = start?.toDate ? start.toDate() : new Date(start);
              const endDate = end?.toDate ? end.toDate() : new Date(end);
              const startOnly = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
              const endOnly = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());
              if (bookingDateOnly >= startOnly && bookingDateOnly <= endOnly) {
                staffIdsOnLeave.add(staffId);
              }
            }
          } catch {
            // leave_requests may not exist; ignore
          }
        }

        let servicesData: any[] = [];
        let staffData: any[] = [];

        const isStaffOnLeave = (s: any) =>
          staffIdsOnLeave.has(String(s.id)) || staffIdsOnLeave.has(String(s.authUid ?? ""));

        const processData = () => {
          if (servicesData.length === 0 || staffData.length === 0) return;

          const hasMultipleServices = Array.isArray(bookingToReassign.services) && bookingToReassign.services.length > 0;
          
          if (hasMultipleServices) {
            const staffPerService: Record<string, Array<{ id: string; name: string; branchId?: string; avatar?: string }>> = {};
            
            // Process services that need assignment: rejected, needs_assignment, or no staff assigned
            bookingToReassign.services!
              .filter(bs => 
                bs.approvalStatus === "rejected" || 
                bs.approvalStatus === "needs_assignment" ||
                !bs.staffId ||
                bs.staffName === "Any Available" ||
                bs.staffName === "Any Staff" ||
                bs.staffName === "Not Assigned Yet"
              )
              .forEach(bookingService => {
              // Use consistent key format (same as assign staff modal)
              const serviceKey = String(bookingService.id || bookingService.serviceId || bookingService.name);
              
              // Find service details - try matching by id, serviceId, or name (same as assign staff modal)
              const serviceId = bookingService.id || bookingService.serviceId;
              const service = servicesData.find((s: any) => 
                String(s.id) === String(serviceId) || 
                String(s.name).toLowerCase() === String(bookingService.name || '').toLowerCase()
              );
              
              const qualifiedStaffIds = (service && Array.isArray(service.staffIds)) ? service.staffIds.map(String) : [];
              
              let filtered = staffData.filter((s: any) => s.status === "Active");
              
              // Exclude the staff member who rejected this specific service (only for rejected services)
              if (bookingService.approvalStatus === "rejected") {
                const rejectorUids: string[] = [];
                if (bookingService.respondedByStaffUid) rejectorUids.push(bookingService.respondedByStaffUid);
                if (bookingService.staffId) rejectorUids.push(bookingService.staffId);
                if (bookingService.staffAuthUid) rejectorUids.push(bookingService.staffAuthUid);
                if (bookingToReassign.rejectedByStaffUid) rejectorUids.push(bookingToReassign.rejectedByStaffUid);
                
                if (rejectorUids.length > 0) {
                  filtered = filtered.filter((s: any) => !rejectorUids.includes(s.id) && !rejectorUids.includes(s.authUid));
                }
              }
              
              // CRITICAL: Filter by service qualification (same as assign staff modal)
              if (qualifiedStaffIds.length > 0) {
                filtered = filtered.filter((s: any) => qualifiedStaffIds.includes(String(s.id)));
              }
              
              // Filter by branch and day (check weeklySchedule) - same strict logic as assign staff modal
              if (bookingToReassign.branchId && bookingToReassign.date) {
                const bookingDate = new Date(bookingToReassign.date);
                const daysOfWeek = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
                const dayName = daysOfWeek[bookingDate.getDay()];
                
                filtered = filtered.filter((s: any) => {
                  if (s.weeklySchedule && typeof s.weeklySchedule === 'object') {
                    const daySchedule = s.weeklySchedule[dayName];
                    if (daySchedule && daySchedule.branchId) {
                      return daySchedule.branchId === bookingToReassign.branchId;
                    }
                    if (daySchedule === null || daySchedule === undefined) {
                      return false;
                    }
                  }
                  return s.branchId === bookingToReassign.branchId;
                });
              }
              // Exclude staff on approved leave on the booking date
              filtered = filtered.filter((s: any) => !isStaffOnLeave(s));
              
              staffPerService[serviceKey] = filtered.map((s: any) => ({
                id: String(s.id),
                name: String(s.name || s.displayName || "Staff"),
                branchId: s.branchId,
                avatar: s.avatar || s.name || s.displayName || "Staff",
              }));
            });
            
            setAvailableStaffPerService(staffPerService);
          } else {
            // Single service - try matching by id or name (same as assign staff modal)
            const service = servicesData.find((s: any) => 
              String(s.id) === String(bookingToReassign.serviceId) ||
              String(s.name).toLowerCase() === String(bookingToReassign.serviceName || '').toLowerCase()
            );
            const qualifiedStaffIds = (service && Array.isArray(service.staffIds)) ? service.staffIds.map(String) : [];
            
            let filtered = staffData.filter((s: any) => s.status === "Active");

            // Exclude the staff member who rejected
            if (bookingToReassign.rejectedByStaffUid) {
              filtered = filtered.filter((s: any) => s.id !== bookingToReassign.rejectedByStaffUid);
            }
            
            // CRITICAL: Filter by service qualification (same as assign staff modal)
            if (qualifiedStaffIds.length > 0) {
              filtered = filtered.filter((s: any) => qualifiedStaffIds.includes(String(s.id)));
            }

            // Filter by branch and day (check weeklySchedule) - same strict logic as assign staff modal
            if (bookingToReassign.branchId && bookingToReassign.date) {
              const bookingDate = new Date(bookingToReassign.date);
              const daysOfWeek = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
              const dayName = daysOfWeek[bookingDate.getDay()];

              filtered = filtered.filter((s: any) => {
                if (s.weeklySchedule && typeof s.weeklySchedule === 'object') {
                  const daySchedule = s.weeklySchedule[dayName];
                  if (daySchedule && daySchedule.branchId) {
                    return daySchedule.branchId === bookingToReassign.branchId;
                  }
                  if (daySchedule === null || daySchedule === undefined) {
                    return false;
                  }
                }
                return s.branchId === bookingToReassign.branchId;
              });
            }
            // Exclude staff on approved leave on the booking date
            filtered = filtered.filter((s: any) => !isStaffOnLeave(s));

            setAvailableStaff(
              filtered.map((s: any) => ({
                id: String(s.id),
                name: String(s.name || s.displayName || "Staff"),
                branchId: s.branchId,
                avatar: s.avatar || s.name || s.displayName || "Staff",
              }))
            );
          }
          
          setLoadingStaff(false);
        };

        unsubServices = subscribeServicesForOwner(ownerUid, (services) => {
          servicesData = services;
          processData();
        });

        unsubStaff = subscribeSalonStaffForOwner(ownerUid, (staff) => {
          staffData = staff;
          processData();
        });

      } catch (err) {
        console.error("Error fetching data for reassignment:", err);
        setLoadingStaff(false);
      }
    };

    fetchData();

    return () => {
      if (unsubServices) unsubServices();
      if (unsubStaff) unsubStaff();
    };
  }, [reassignModalOpen, bookingToReassign]);

  const handleConfirmClick = (row: Row) => {
    // Check if booking has multiple services array
    const hasMultipleServices = Array.isArray(row.services) && row.services.length > 0;
    
    if (hasMultipleServices) {
      // Check if any service needs staff assignment
      const needsStaffAssignment = row.services!.some(s => 
        !s.staffId || s.staffId === "null" || s.staffName === "Any Available" || s.staffName === "Any Staff" || s.staffName === "Not Assigned Yet"
      );
      
      if (needsStaffAssignment) {
        // Open multi-service staff assignment modal
        setBookingToConfirm(row);
        
        // Pre-fill staff assignments from existing data
        const initialStaffSelection: Record<string, string> = {};
        row.services!.forEach(s => {
          // Use consistent key format: id || serviceId || name
          const serviceKey = String(s.id || s.serviceId || s.name);
          if (s.staffId && s.staffId !== "null") {
            initialStaffSelection[serviceKey] = s.staffId;
          }
        });
        setSelectedStaffPerService(initialStaffSelection);
        
        setStaffAssignModalOpen(true);
      } else {
        // All services have staff assigned
        onAction(row.id, "Confirm");
      }
    } else {
      // Single service booking - check if needs staff assignment
      if (!row.staffId || row.staffId === "null" || row.staffName === "Any Available" || row.staffName === "Any Staff" || row.staffName === "Not Assigned Yet") {
        // Open staff assignment modal
        setBookingToConfirm(row);
        setSelectedStaffId("");
        setSelectedStaffPerService({});
        setStaffAssignModalOpen(true);
      } else {
        // Directly confirm without staff assignment
        onAction(row.id, "Confirm");
      }
    }
  };

  const confirmWithStaffAssignment = async () => {
    if (!bookingToConfirm) return;

    // Check if this is a multi-service booking
    const hasMultipleServices = Array.isArray(bookingToConfirm.services) && bookingToConfirm.services.length > 0;

    if (hasMultipleServices) {
      // Validate all services have staff assigned
      const allAssigned = bookingToConfirm.services!.every(s => {
        const serviceKey = String(s.id || s.serviceId || s.name);
        return selectedStaffPerService[serviceKey];
      });
      
      if (!allAssigned) {
        alert("Please assign staff to all services");
        return;
      }
    } else {
      // Single service - must have staff selected
      if (!selectedStaffId) return;
    }

    try {
      setUpdatingState((prev) => ({ ...prev, [bookingToConfirm.id]: "Confirm" }));
      
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

      if (hasMultipleServices) {
        // Update services array with selected staff
        const updatedServices = bookingToConfirm.services!.map(service => {
          const serviceKey = String(service.id || service.serviceId || service.name);
          const staffId = selectedStaffPerService[serviceKey];
          if (staffId) {
            const staff = availableStaffPerService[serviceKey]?.find(s => s.id === staffId);
            return {
              ...service,
              staffId: staffId,
              staffAuthUid: (staff as any)?.authUid || (staff as any)?.uid || staffId, // Store auth UID for Flutter app
              staffName: staff?.name || "Staff"
            };
          }
          return service;
        });

        // CALL API instead of direct update to trigger notifications
        // We only send services array, API handles removal of top-level staff fields
        const res = await fetch(`/api/bookings/${encodeURIComponent(bookingToConfirm.id)}/status`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ 
            status: "Confirmed",
            services: updatedServices
          }),
        });

        const json = await res.json().catch(() => ({})) as any;
        if (!res.ok && !json?.devNoop) {
          throw new Error(json?.error || "Failed to confirm booking");
        }

        // If dev no-op or unauthorized in dev, perform client-side update
        if (json?.devNoop) {
          const { updateDoc, doc: firestoreDoc, serverTimestamp, deleteField } = await import("firebase/firestore");
          await updateDoc(firestoreDoc(db, "bookings", bookingToConfirm.id), {
            services: updatedServices,
            staffId: deleteField(),
            staffName: deleteField(),
            status: "Confirmed",
            updatedAt: serverTimestamp(),
          } as any);
        }
      } else {
        // Single service - use API endpoint
        const selectedStaff = availableStaff.find(s => s.id === selectedStaffId);
        
        const res = await fetch(`/api/bookings/${encodeURIComponent(bookingToConfirm.id)}/status`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ 
            status: "Confirmed",
            staffId: selectedStaffId,
            staffName: selectedStaff?.name || "Staff"
          }),
        });

        const json = await res.json().catch(() => ({})) as any;
        if (!res.ok && !json?.devNoop) {
          throw new Error(json?.error || "Failed to confirm booking");
        }

        // If dev no-op, perform client-side update
        if (json?.devNoop) {
          const { updateDoc, doc: firestoreDoc, serverTimestamp } = await import("firebase/firestore");
          await updateDoc(firestoreDoc(db, "bookings", bookingToConfirm.id), {
            staffId: selectedStaffId,
            staffName: selectedStaff?.name || "Staff",
            status: "Confirmed",
            updatedAt: serverTimestamp(),
          } as any);
        }
      }

      // Close modal
      setStaffAssignModalOpen(false);
      setBookingToConfirm(null);
      setSelectedStaffId("");
      setSelectedStaffPerService({});
    } catch (e: any) {
      console.error("Error confirming booking:", e);
      alert(e?.message || "Failed to confirm booking");
    } finally {
      setUpdatingState((prev) => {
        const next = { ...prev };
        delete next[bookingToConfirm!.id];
        return next;
      });
    }
  };

  // Handle reassign click for StaffRejected bookings
  const handleReassignClick = (row: Row) => {
    setBookingToReassign(row);
    setSelectedStaffId("");
    setSelectedStaffPerService({});
    setReassignModalOpen(true);
  };

  // Confirm reassignment to new staff
  const confirmReassignment = async () => {
    if (!bookingToReassign) return;

    const hasMultipleServices = Array.isArray(bookingToReassign.services) && bookingToReassign.services.length > 0;

    if (hasMultipleServices) {
      // Only check services that need assignment: rejected, needs_assignment, or no staff
      const servicesToReassign = bookingToReassign.services!.filter(s => 
        s.approvalStatus === "rejected" || 
        s.approvalStatus === "needs_assignment" ||
        !s.staffId ||
        s.staffName === "Any Available" ||
        s.staffName === "Any Staff"
      );
      
      const allAssigned = servicesToReassign.every(s => {
        const serviceKey = String(s.id || s.serviceId || s.name);
        return selectedStaffPerService[serviceKey];
      });
      if (!allAssigned && servicesToReassign.length > 0) {
        alert("Please assign staff to all services that need assignment");
        return;
      }
    } else {
      if (!selectedStaffId) return;
    }

    try {
      setUpdatingState((prev) => ({ ...prev, [bookingToReassign.id]: "Reassign" }));
      
      let token: string | null = null;
      try {
        if (auth.currentUser) {
          token = await auth.currentUser.getIdToken(true);
        } else {
          const user = await new Promise<any>((resolve) => {
            const unsubscribe = auth.onAuthStateChanged((u) => {
              unsubscribe();
              resolve(u);
            });
          });
          if (user) {
            token = await user.getIdToken(true);
          } else {
            token = typeof window !== "undefined" ? localStorage.getItem("idToken") : null;
          }
        }
      } catch (err) {
        console.error("Error getting token:", err);
      }

      let requestBody: any = {};

      if (hasMultipleServices) {
        // Only update rejected/pending services, keep accepted ones as-is
        const updatedServices = bookingToReassign.services!.map(service => {
          // Keep accepted services unchanged
          if (service.approvalStatus === "accepted") {
            return service;
          }
          
          // Update rejected/pending services with new staff
          const serviceKey = String(service.id || service.serviceId || service.name);
          const staffId = selectedStaffPerService[serviceKey];
          if (staffId) {
            const staff = availableStaffPerService[serviceKey]?.find(s => s.id === staffId);
            return {
              ...service,
              staffId: staffId,
              staffAuthUid: (staff as any)?.authUid || (staff as any)?.uid || staffId, // Store auth UID for Flutter app
              staffName: staff?.name || "Staff",
              approvalStatus: "pending", // Reset to pending for new staff
              rejectionReason: null, // Clear rejection reason
              rejectedAt: null,
              respondedByStaffUid: null,
              respondedByStaffName: null,
            };
          }
          return service;
        });
        requestBody.services = updatedServices;
      } else {
        const selectedStaff = availableStaff.find(s => s.id === selectedStaffId);
        requestBody.staffId = selectedStaffId;
        requestBody.staffName = selectedStaff?.name || "Staff";
      }

      const res = await fetch(`/api/bookings/${encodeURIComponent(bookingToReassign.id)}/reassign`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(requestBody),
      });

      const json = await res.json().catch(() => ({})) as any;
      if (!res.ok) {
        throw new Error(json?.error || "Failed to reassign booking");
      }

      // Close modal
      setReassignModalOpen(false);
      setBookingToReassign(null);
      setSelectedStaffId("");
      setSelectedStaffPerService({});
    } catch (e: any) {
      console.error("Error reassigning booking:", e);
      alert(e?.message || "Failed to reassign booking");
    } finally {
      setUpdatingState((prev) => {
        const next = { ...prev };
        delete next[bookingToReassign!.id];
        return next;
      });
    }
  };

  // ─── Reschedule handlers ───────────────────────────────────────────────
  const handleRescheduleClick = (row: Row) => {
    setBookingToReschedule(row);
    setRescheduleNewDate(row.date || "");
    setRescheduleNewTime(row.time || "");
    setRescheduleNewPickupTime(row.pickupTime || "");
    setRescheduleReason("");
    setRescheduleError(null);
    setRescheduleBranch(null);
    // Seed the staff pickers from the row's existing assignments. These stay
    // in sync with the API expectations: single-service bookings use the
    // top-level `staffId`; multi-service bookings use per-service entries.
    setRescheduleStaffId((row.staffId || "").toString());
    const byService: Record<string, string> = {};
    if (Array.isArray(row.services)) {
      for (const svc of row.services) {
        if (svc && svc.id !== undefined && svc.id !== null) {
          byService[String(svc.id)] = (svc.staffId || "").toString();
        }
      }
    }
    setRescheduleStaffByService(byService);
    setRescheduleStaffRaw([]);
    setRescheduleStaffOptions([]);
    // Point the calendar at the booking's current month (or today if unknown).
    const [yStr, mStr] = (row.date || "").split("-");
    const y = Number(yStr);
    const m = Number(mStr);
    if (y && m >= 1 && m <= 12) {
      setRescheduleCalendarMonth({ year: y, month: m - 1 });
    } else {
      const now = new Date();
      setRescheduleCalendarMonth({ year: now.getFullYear(), month: now.getMonth() });
    }
    setRescheduleModalOpen(true);

    // Fire-and-forget: fetch the booking's branch so slot constraints can
    // reflect that branch's hours + timezone. Non-blocking — the modal still
    // works without it (just without time-window filtering).
    if (row.branchId) {
      (async () => {
        setRescheduleBranchLoading(true);
        try {
          const { getDoc, doc: firestoreDoc } = await import("firebase/firestore");
          const snap = await getDoc(firestoreDoc(db, "branches", row.branchId as string));
          if (snap.exists()) {
            const d = snap.data() as any;
            setRescheduleBranch({
              id: snap.id,
              name: d.name,
              timezone: d.timezone,
              hours: d.hours,
            });
          }
        } catch (err) {
          console.error("Failed to load branch for reschedule modal:", err);
        } finally {
          setRescheduleBranchLoading(false);
        }
      })();
    }

    // Load staff for the owner (filtered to the booking's branch when possible)
    // so the admin can reassign staff alongside the reschedule.
    (async () => {
      setRescheduleStaffLoading(true);
      try {
        const userId = auth.currentUser?.uid;
        if (!userId) return;
        const { getDoc, doc: firestoreDoc } = await import("firebase/firestore");
        const userSnap = await getDoc(firestoreDoc(db, "users", userId));
        const userData = userSnap.data() as any;
        const userRole = (userData?.role || "").toString();
        const ownerUid = userRole === "workshop_owner" ? userId : (userData?.ownerUid || userId);

        const { collection, getDocs, query, where } = await import("firebase/firestore");
        const snap = await getDocs(
          query(collection(db, "users"), where("ownerUid", "==", ownerUid)),
        );
        const raw: any[] = [];
        snap.forEach((d) => {
          const data = d.data() as any;
          const systemRole = (data?.role || "").toString();
          if (!["staff", "branch_admin"].includes(systemRole)) return;
          const st = (data?.status || "Active").toString();
          if (st === "Suspended" || st === "suspended") return;
          // Prefer Firebase Auth UID if the user doc tracks it separately;
          // this must match what the booking's `staffId` uses.
          const staffId = (data?.authUid || data?.uid || d.id).toString();
          raw.push({
            _rescheduleId: staffId,
            id: staffId,
            name: (data?.displayName || data?.name || "Unknown").toString(),
            displayName: data?.displayName,
            branchId: data?.branchId,
            avatar: data?.avatar,
            weeklySchedule: data?.weeklySchedule,
            status: data?.status,
          });
        });
        raw.sort((a, b) => a.name.localeCompare(b.name));
        setRescheduleStaffRaw(raw);
      } catch (err) {
        console.error("Failed to load staff for reschedule modal:", err);
      } finally {
        setRescheduleStaffLoading(false);
      }
    })();
  };

  const closeRescheduleModal = () => {
    if (rescheduleSaving) return;
    setRescheduleModalOpen(false);
    setBookingToReschedule(null);
    setRescheduleNewDate("");
    setRescheduleNewTime("");
    setRescheduleNewPickupTime("");
    setRescheduleReason("");
    setRescheduleError(null);
    setRescheduleBranch(null);
    setRescheduleStaffId("");
    setRescheduleStaffByService({});
    setRescheduleStaffRaw([]);
    setRescheduleStaffOptions([]);
  };

  const confirmReschedule = async () => {
    if (!bookingToReschedule) return;

    const newDate = rescheduleNewDate.trim();
    const newTime = rescheduleNewTime.trim();
    const newPickupTime = rescheduleNewPickupTime.trim();
    if (!newDate || !newTime) {
      setRescheduleError("Please pick both a date and a drop-off time.");
      return;
    }
    if (newPickupTime && newPickupTime <= newTime) {
      setRescheduleError("Pick-up time must be after the drop-off time.");
      return;
    }

    // Compute staff changes vs. the booking's current state.
    const hasServices = Array.isArray(bookingToReschedule.services) && bookingToReschedule.services.length > 0;
    const origStaffId = (bookingToReschedule.staffId || "").toString();
    let newStaffId = "";
    let newStaffName = "";
    const staffAssignments: Record<string, { staffId: string; staffName?: string }> = {};
    if (hasServices) {
      for (const svc of bookingToReschedule.services!) {
        const sid = String(svc.id);
        const prev = (svc.staffId || "").toString();
        const next = (rescheduleStaffByService[sid] || "").toString();
        if (next && next !== prev) {
          const picked = rescheduleStaffOptions.find((s) => s.id === next);
          staffAssignments[sid] = {
            staffId: next,
            staffName: picked?.name || svc.staffName || "Staff",
          };
        }
      }
    } else if (rescheduleStaffId && rescheduleStaffId !== origStaffId) {
      newStaffId = rescheduleStaffId;
      const picked = rescheduleStaffOptions.find((s) => s.id === newStaffId);
      newStaffName = picked?.name || bookingToReschedule.staffName || "Staff";
    }
    const staffChanged = !!newStaffId || Object.keys(staffAssignments).length > 0;

    if (
      bookingToReschedule.date === newDate &&
      bookingToReschedule.time === newTime &&
      (bookingToReschedule.pickupTime || "") === newPickupTime &&
      !staffChanged
    ) {
      setRescheduleError("Nothing has changed — update the date, time, or staff.");
      return;
    }

    try {
      setRescheduleSaving(true);
      setRescheduleError(null);
      setUpdatingState((prev) => ({
        ...prev,
        [bookingToReschedule.id]: "Reschedule",
      }));

      // Obtain a fresh ID token (mirrors the reassign flow above)
      let token: string | null = null;
      try {
        if (auth.currentUser) {
          token = await auth.currentUser.getIdToken(true);
        } else {
          const user = await new Promise<any>((resolve) => {
            const unsubscribe = auth.onAuthStateChanged((u) => {
              unsubscribe();
              resolve(u);
            });
          });
          if (user) token = await user.getIdToken(true);
        }
      } catch (tokenErr) {
        console.error("Failed to obtain auth token for reschedule:", tokenErr);
      }

      const res = await fetch(
        `/api/bookings/${encodeURIComponent(bookingToReschedule.id)}/reschedule`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({
            newDate,
            newTime,
            newPickupTime: newPickupTime || undefined,
            reason: rescheduleReason.trim() || undefined,
            newStaffId: newStaffId || undefined,
            newStaffName: newStaffName || undefined,
            staffAssignments: Object.keys(staffAssignments).length > 0 ? staffAssignments : undefined,
          }),
        },
      );

      const json = (await res.json().catch(() => ({}))) as any;
      if (!res.ok) {
        throw new Error(json?.error || "Failed to reschedule booking");
      }

      setRescheduleModalOpen(false);
      setBookingToReschedule(null);
      setRescheduleNewDate("");
      setRescheduleNewTime("");
      setRescheduleNewPickupTime("");
      setRescheduleReason("");
    } catch (e: any) {
      console.error("Error rescheduling booking:", e);
      setRescheduleError(e?.message || "Failed to reschedule booking");
    } finally {
      setRescheduleSaving(false);
      setUpdatingState((prev) => {
        const next = { ...prev };
        if (bookingToReschedule) delete next[bookingToReschedule.id];
        return next;
      });
    }
  };

  const onAction = async (rowId: string, action: "Confirm" | "Cancel" | "Complete") => {
    try {
      // Prevent actions on cancelled bookings
      const row = rows.find((r) => r.id === rowId);
      if (row && normalizeBookingStatus(row.status ?? null) === "Canceled" && action !== "Cancel") {
        alert("This booking has been cancelled and cannot be updated.");
        return;
      }

      // Block completion if additional issues are pending admin/customer decisions
      if (action === "Complete" && row) {
        const issues = Array.isArray(row.additionalIssues) ? row.additionalIssues : [];
        const pendingAdmin = issues.filter((i) => (i.status || "pending") === "pending").length;
        const pendingCustomer = issues.filter((i) => i.status === "approved" && !i.customerResponse).length;
        if (pendingAdmin > 0 || pendingCustomer > 0) {
          setPendingIssuesAlert({ pendingAdmin, pendingCustomer });
          return;
        }
      }

      // Check for incomplete tasks before completing — show styled modal
      if (action === "Complete" && row) {
        const tasks = Array.isArray(row.tasks) ? row.tasks : [];
        if (tasks.length > 0) {
          const completedTasks = tasks.filter((t) => t.done).length;
          if (completedTasks < tasks.length) {
            setForceCompleteConfirm({ rowId, completedTasks, totalTasks: tasks.length });
            return;
          }
        }
      }

      setUpdatingState((prev) => ({ ...prev, [rowId]: action }));
      const next: BookingStatus =
        action === "Confirm" ? "Confirmed" :
        action === "Cancel" ? "Canceled" :
        "Completed";
      await updateBookingStatus(rowId, next);
    } catch (e: any) {
      // eslint-disable-next-line no-alert
      alert(e?.message || "Failed to update status");
    } finally {
      setUpdatingState((prev) => {
        const next = { ...prev };
        delete next[rowId];
        return next;
      });
    }
  };

  const openPreview = (row: Row) => {
    setPreviewRow(row);
    setPreviewOpen(true);
  };
  const closePreview = () => setPreviewOpen(false);

  /** Same-origin iframe preview (see BookingJobReportPdfViewer). */
  const [pdfPreview, setPdfPreview] = useState<{
    bookingId: string;
    filename: string;
  } | null>(null);

  const [forceCompleteConfirm, setForceCompleteConfirm] = useState<{
    rowId: string;
    completedTasks: number;
    totalTasks: number;
  } | null>(null);

  const [pendingIssuesAlert, setPendingIssuesAlert] = useState<{
    pendingAdmin: number;
    pendingCustomer: number;
  } | null>(null);

  const handleForceComplete = async () => {
    if (!forceCompleteConfirm) return;
    const { rowId } = forceCompleteConfirm;
    setForceCompleteConfirm(null);
    try {
      setUpdatingState((prev) => ({ ...prev, [rowId]: "Complete" }));
      await updateBookingStatus(rowId, "Completed", { forceComplete: true });
    } catch (e: any) {
      alert(e?.message || "Failed to update status");
    } finally {
      setUpdatingState((prev) => {
        const next = { ...prev };
        delete next[rowId];
        return next;
      });
    }
  };

  const closePdfPreview = () => setPdfPreview(null);

  const openJobReportPdfPreview = (bookingId: string, bookingCode?: string | null) => {
    setPdfPreview({
      bookingId,
      filename: bookingJobReportPdfFilename(bookingCode, bookingId),
    });
  };

  const downloadPdfFromPreview = async () => {
    if (!pdfPreview) return;
    const user = auth.currentUser;
    if (!user) return;
    try {
      const token = await user.getIdToken();
      const u = new URL(`/api/bookings/${encodeURIComponent(pdfPreview.bookingId)}/pdf`, window.location.origin);
      u.searchParams.set("download", "1");
      u.searchParams.set("token", token);
      const a = document.createElement("a");
      a.href = u.toString();
      a.download = pdfPreview.filename;
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (e) {
      console.error(e);
      // eslint-disable-next-line no-alert
      alert("Could not start download.");
    }
  };

  const printPdfFromPreview = async () => {
    if (!pdfPreview) return;
    const user = auth.currentUser;
    if (!user) return;
    try {
      const token = await user.getIdToken();
      const u = new URL(`/api/bookings/${encodeURIComponent(pdfPreview.bookingId)}/pdf`, window.location.origin);
      u.searchParams.set("inline", "1");
      u.searchParams.set("token", token);
      const w = window.open(u.toString(), "_blank", "noopener,noreferrer");
      if (w) {
        w.addEventListener("load", () => {
          window.setTimeout(() => {
            try {
              w.print();
            } catch {
              /* user can print from the tab */
            }
          }, 300);
        });
      }
    } catch (e) {
      console.error(e);
      // eslint-disable-next-line no-alert
      alert("Could not open print view.");
    }
  };

  const handleSaveMileage = async () => {
    if (!previewRow) return;
    const digits = mileageEditValue.replace(/\D/g, "");
    const mileage = digits ? `${digits} km` : null;
    try {
      setMileageSaving(true);
      const user = auth.currentUser;
      if (!user) return;
      const token = await user.getIdToken();
      const res = await fetch(`/api/bookings/${previewRow.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ mileage }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error || "Failed to save mileage");
      }
      setPreviewRow((prev) => (prev ? { ...prev, mileage: mileage || undefined } : null));
    } catch (e: any) {
      // eslint-disable-next-line no-alert
      alert(e?.message || "Failed to save mileage");
    } finally {
      setMileageSaving(false);
    }
  };

  const handleSetIssuePrice = async (action: "approve" | "reject") => {
    if (!issuePriceModal) return;
    if (action === "approve") {
      const price = parseFloat(issuePriceValue);
      if (isNaN(price) || price < 0) {
        alert("Please enter a valid price");
        return;
      }
    }
    try {
      setIssuePriceSaving(true);
      const user = auth.currentUser;
      if (!user) return;
      const token = await user.getIdToken();
      const body = action === "approve"
        ? { price: parseFloat(issuePriceValue), status: "approved" as const }
        : { status: "rejected" as const };
      const res = await fetch(`/api/bookings/${issuePriceModal.bookingId}/additional-issues/${issuePriceModal.issue.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error || (action === "approve" ? "Failed to set price" : "Failed to reject"));
      }
      const data = await res.json().catch(() => ({}));
      const updatedIssue = data?.issue;
      setPreviewRow((prev) => {
        if (!prev?.additionalIssues) return prev;
        const updated = prev.additionalIssues.map((i) =>
          i.id === issuePriceModal.issue.id
            ? {
                ...i,
                price: updatedIssue?.price ?? i.price,
                status: (updatedIssue?.status ?? (action === "approve" ? "approved" : "rejected")) as "approved" | "rejected",
                priceSetByName: user?.displayName || "Admin",
              }
            : i
        );
        return { ...prev, additionalIssues: updated };
      });
      setIssuePriceModal(null);
      setIssuePriceValue("");
    } catch (e: any) {
      alert(e?.message || "Failed");
    } finally {
      setIssuePriceSaving(false);
    }
  };

  const handleRecordCustomerResponse = async () => {
    if (!customerResponseModal) return;
    const { bookingId, issue, action } = customerResponseModal;
    try {
      setCustomerResponseSaving(true);
      const user = auth.currentUser;
      if (!user) return;
      const token = await user.getIdToken();
      const res = await fetch(
        `/api/bookings/${bookingId}/additional-issues/${issue.id}/customer-response`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ action }),
        }
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error || "Failed to record customer response");
      }
      const data = await res.json().catch(() => ({}));
      const updatedIssue = data?.issue;
      setPreviewRow((prev) => {
        if (!prev?.additionalIssues) return prev;
        const updated = prev.additionalIssues.map((i) =>
          i.id === issue.id
            ? {
                ...i,
                customerResponse:
                  (updatedIssue?.customerResponse as "accept" | "reject") ||
                  action,
              }
            : i
        );
        return { ...prev, additionalIssues: updated };
      });
      setCustomerResponseModal(null);
    } catch (e: any) {
      alert(e?.message || "Failed to record customer response");
    } finally {
      setCustomerResponseSaving(false);
    }
  };

  return (
    <div className="flex h-screen overflow-hidden bg-white">
      {/* Mobile Sidebar Overlay */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-[100] md:hidden">
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setSidebarOpen(false)} />
          <div className="relative h-full w-64 bg-neutral-900 shadow-2xl">
            <Sidebar mobile onClose={() => setSidebarOpen(false)} />
          </div>
        </div>
      )}
      
      {/* Desktop Sidebar */}
      <Sidebar />
      
      <div className="flex-1 flex flex-col overflow-hidden">
        <main className="flex-1 overflow-auto p-4 sm:p-6 lg:p-8 bg-neutral-50">
          <div className="max-w-7xl mx-auto">
            <div className="mb-8">
              <div className="relative rounded-2xl bg-neutral-900 text-white p-6 shadow-sm overflow-hidden">
                {/* Decorative elements */}
                <div className="absolute top-0 right-0 w-32 h-32 bg-white/5 rounded-full -translate-y-1/2 translate-x-1/2" />
                <div className="absolute bottom-0 left-1/3 w-20 h-20 bg-white/5 rounded-full translate-y-1/2" />
                <div className="absolute top-3 right-20 text-white/10 text-3xl"><i className="fas fa-gear" /></div>
                <div className="absolute bottom-2 right-40 text-white/10 text-xl"><i className="fas fa-wrench" /></div>

                <div className="relative flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    {/* Mobile Menu Button */}
                    <button 
                      onClick={() => setSidebarOpen(true)}
                      className="md:hidden p-2 -ml-2 hover:bg-white/20 rounded-lg transition-colors"
                    >
                      <i className="fas fa-bars text-xl"></i>
                    </button>
                    <div className="w-11 h-11 rounded-xl bg-amber-500/20 flex items-center justify-center border border-amber-500/30">
                      <i className="fas fa-calendar-check text-amber-400" />
                    </div>
                    <div>
                      <h1 className="text-xl sm:text-2xl font-bold">{title}</h1>
                      <p className="text-neutral-400 text-xs mt-0.5">Manage your workshop bookings</p>
                    </div>
                  </div>
                  {showExportButton && (
                    <button
                      onClick={() => setExportModalOpen(true)}
                      className="shrink-0 px-4 py-2 rounded-lg bg-white/20 hover:bg-white/30 text-white text-sm font-medium flex items-center gap-2 border border-white/30 transition"
                    >
                      <i className="fas fa-file-csv" />
                      Export CSV
                    </button>
                  )}
                </div>
              </div>
            </div>

            <BookingsExportModal open={exportModalOpen} onClose={() => setExportModalOpen(false)} />

            {/* Right-side preview slide-over */}
            <div
              className={`fixed inset-0 z-50 ${previewOpen ? "pointer-events-auto" : "pointer-events-none"}`}
              aria-hidden={!previewOpen}
            >
              <div
                onClick={closePreview}
                className={`absolute inset-0 bg-black/50 transition-opacity duration-200 ${previewOpen ? "opacity-100" : "opacity-0"}`}
              />
              <aside
                className={`absolute top-0 h-full right-0 w-[92vw] sm:w-[30rem] bg-white shadow-2xl border-l border-neutral-200 transform transition-transform duration-200 ${previewOpen ? "translate-x-0" : "translate-x-full"}`}
              >
                <div className="flex h-full flex-col">
                  <div className="p-0 border-b border-neutral-200">
                    <div className="relative bg-neutral-900 p-5 text-white flex items-center justify-between overflow-hidden">
                      <div className="absolute top-0 right-0 w-24 h-24 bg-white/5 rounded-full -translate-y-1/2 translate-x-1/2" />
                      <div className="absolute top-2 right-16 text-white/10 text-xl"><i className="fas fa-gear" /></div>
                      <div className="relative flex items-center gap-3">
                        <div className="w-10 h-10 rounded-xl bg-amber-500/20 flex items-center justify-center border border-amber-500/30">
                          <i className="fas fa-eye text-amber-400" />
                        </div>
                        <h3 className="text-lg font-semibold">Booking Preview</h3>
                      </div>
                      <button onClick={closePreview} className="relative text-white/80 hover:text-white">
                        <i className="fas fa-times" />
                      </button>
                    </div>
                  </div>
                  <div className="flex-1 p-5 space-y-4 overflow-y-auto">
                  {!previewRow && <div className="text-neutral-500 text-sm">No booking selected.</div>}
                  {previewRow && (
                    <div className="space-y-4 text-sm">
                      <div className="flex items-center gap-3">
                        <div className="w-12 h-12 rounded-full bg-neutral-900 text-white flex items-center justify-center text-sm font-bold shadow-md">
                          {(previewRow.client || "?").split(" ").map(s => s[0]).slice(0,2).join("")}
                        </div>
                        <div className="flex-1">
                          <p className="font-semibold text-neutral-900">{previewRow.client}</p>
                          <div className="flex flex-wrap gap-2 mt-1">
                            {previewRow.clientEmail && <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-neutral-100 text-neutral-700"><i className="fas fa-envelope" />{previewRow.clientEmail}</span>}
                            {previewRow.clientPhone && <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-neutral-100 text-neutral-700"><i className="fas fa-phone" />{previewRow.clientPhone}</span>}
                          </div>
                        </div>
                      </div>

                      {/* Vehicle Details Section - Creative Card */}
                      <div className="relative overflow-hidden rounded-2xl border border-neutral-200 bg-gradient-to-br from-slate-50 via-white to-neutral-50 shadow-sm">
                        {/* Decorative accent */}
                        <div className="absolute top-0 right-0 w-32 h-32 -translate-y-1/2 translate-x-1/2 rounded-full bg-gradient-to-br from-amber-100/60 to-orange-100/40 blur-2xl" />
                        <div className="absolute bottom-0 left-0 w-24 h-24 -translate-y-1/2 -translate-x-1/2 rounded-full bg-gradient-to-tr from-blue-50/80 to-transparent blur-xl" />
                        
                        <div className="relative">
                          {/* Header with vehicle identity */}
                          <div className="flex items-center gap-4 p-4 pb-3 border-b border-neutral-100/80">
                            <div className="flex-shrink-0 w-14 h-14 rounded-xl bg-gradient-to-br from-amber-500/20 to-orange-500/20 flex items-center justify-center border border-amber-200/50">
                              <i className="fas fa-car-side text-2xl text-amber-600/90" />
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-[10px] font-bold text-amber-600/90 uppercase tracking-widest">Vehicle Information</p>
                              <p className="mt-0.5 font-bold text-neutral-900 text-lg truncate">
                                {(previewRow.vehicleMake || previewRow.vehicleModel)
                                  ? [previewRow.vehicleMake, previewRow.vehicleModel].filter(Boolean).join(" ")
                                  : "Vehicle Details"}
                              </p>
                              {(previewRow.vehicleNumber || previewRow.vehicleType || previewRow.vehicleBodyType) && (
                                <div className="flex flex-wrap gap-1.5 mt-1.5">
                                  {previewRow.vehicleNumber && (
                                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-neutral-800 text-white text-xs font-mono font-semibold">
                                      <i className="fas fa-id-card text-[9px] opacity-80" />
                                      {previewRow.vehicleNumber}
                                    </span>
                                  )}
                                  {previewRow.vehicleType && isVehicleType(previewRow.vehicleType) && (
                                    <span
                                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-amber-100 text-amber-800 text-xs font-semibold"
                                      title="Vehicle size class used for pricing"
                                    >
                                      <i className={`${VEHICLE_TYPE_ICONS[previewRow.vehicleType]} text-[9px]`} />
                                      {VEHICLE_TYPE_LABELS[previewRow.vehicleType]}
                                    </span>
                                  )}
                                  {!previewRow.vehicleType && previewRow.vehicleBodyType && (
                                    <span className="inline-flex items-center px-2 py-0.5 rounded-lg bg-amber-100 text-amber-800 text-xs font-semibold">
                                      {previewRow.vehicleBodyType}
                                    </span>
                                  )}
                                </div>
                              )}
                            </div>
                          </div>
                          
                          {/* Details grid - vehicle info only (no staff-recorded) */}
                          <div className="p-4 pt-3">
                            <div className="grid grid-cols-2 gap-3">
                              {[
                                { label: "Make", value: previewRow.vehicleMake, icon: "fa-industry" },
                                { label: "Model", value: previewRow.vehicleModel, icon: "fa-tag" },
                                {
                                  label: "Vehicle Type",
                                  value: previewRow.vehicleType && isVehicleType(previewRow.vehicleType)
                                    ? VEHICLE_TYPE_LABELS[previewRow.vehicleType]
                                    : previewRow.vehicleBodyType,
                                  icon: previewRow.vehicleType && isVehicleType(previewRow.vehicleType)
                                    ? VEHICLE_TYPE_ICONS[previewRow.vehicleType].replace(/^fas /, "")
                                    : "fa-shapes",
                                },
                                { label: "Colour", value: previewRow.vehicleColour, icon: "fa-palette" },
                                { label: "Registration", value: previewRow.vehicleNumber, icon: "fa-id-card" },
                                { label: "VIN / Chassis", value: previewRow.vehicleVinChassis, icon: "fa-barcode" },
                                { label: "Engine No.", value: previewRow.vehicleEngineNumber, icon: "fa-gears" },
                                { label: "Customer Mileage", value: previewRow.vehicleMileage, icon: "fa-gauge-high" },
                              ].filter(({ value }) => value).map(({ label, value, icon }) => (
                                <div key={label} className="flex items-center gap-3 rounded-lg bg-white/70 backdrop-blur-sm py-2.5 px-3 border border-neutral-100">
                                  <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-neutral-100 flex items-center justify-center">
                                    <i className={`fas ${icon} text-[10px] text-neutral-500`} />
                                  </div>
                                  <div className="flex-1 min-w-0">
                                    <p className="text-[10px] font-semibold text-neutral-400 uppercase tracking-wide">{label}</p>
                                    <p className="text-sm font-semibold text-neutral-800 truncate">{value || "N/A"}</p>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* Vehicle Check-In (Staff Recorded) - separate section */}
                      {(previewRow.mileage || previewRow.fuelLevel || previewRow.existingDamageNotes || (previewRow.existingDamageImages && previewRow.existingDamageImages.length > 0)) && (
                        <div className="relative overflow-hidden rounded-2xl border border-emerald-200/80 bg-gradient-to-br from-emerald-50/80 via-white to-teal-50/50 shadow-sm">
                          <div className="absolute top-0 right-0 w-24 h-24 -translate-y-1/2 translate-x-1/2 rounded-full bg-emerald-100/50 blur-xl" />
                          <div className="relative p-4">
                            <div className="flex items-center gap-3 mb-4">
                              <div className="flex-shrink-0 w-10 h-10 rounded-xl bg-emerald-500/20 flex items-center justify-center border border-emerald-300/50">
                                <i className="fas fa-clipboard-check text-emerald-600" />
                              </div>
                              <div className="min-w-0 flex-1">
                                <p className="text-[10px] font-bold text-emerald-600 uppercase tracking-widest">Vehicle Check-In</p>
                                {(() => {
                                  const by = previewRow.mileageRecordedByStaffName?.trim();
                                  const at = previewRow.mileageRecordedAt
                                    ? parseMileageRecordedAt(previewRow.mileageRecordedAt)
                                    : null;
                                  const atLabel =
                                    at &&
                                    at.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
                                  if (by && atLabel) {
                                    return (
                                      <p className="text-sm text-neutral-700 mt-0.5">
                                        Recorded by <span className="font-semibold text-neutral-900">{by}</span>
                                        <span className="text-neutral-400 font-normal"> · </span>
                                        <span className="font-normal">{atLabel}</span>
                                      </p>
                                    );
                                  }
                                  if (by) {
                                    return (
                                      <p className="text-sm text-neutral-700 mt-0.5">
                                        Recorded by <span className="font-semibold text-neutral-900">{by}</span>
                                      </p>
                                    );
                                  }
                                  return (
                                    <p className="text-sm text-neutral-600 mt-0.5">
                                      Staff check-in at drop-off (who recorded is not on file).
                                    </p>
                                  );
                                })()}
                              </div>
                            </div>
                            <div className="space-y-3">
                              {previewRow.mileage && (
                                <div className="flex items-center gap-3 rounded-lg bg-white/80 py-2.5 px-3 border border-emerald-100">
                                  <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-emerald-100 flex items-center justify-center">
                                    <i className="fas fa-user-check text-[10px] text-emerald-600" />
                                  </div>
                                  <div className="flex-1 min-w-0">
                                    <p className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wide">Mileage</p>
                                    <p className="text-sm font-semibold text-neutral-800">{previewRow.mileage}</p>
                                  </div>
                                </div>
                              )}
                              {previewRow.fuelLevel && (
                                <div className="flex items-center gap-3 rounded-lg bg-white/80 py-2.5 px-3 border border-emerald-100">
                                  <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-emerald-100 flex items-center justify-center">
                                    <i className="fas fa-gas-pump text-[10px] text-emerald-600" />
                                  </div>
                                  <div className="flex-1 min-w-0">
                                    <p className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wide">Fuel Level</p>
                                    <p className="text-sm font-semibold text-neutral-800">
                                      {({ Full: "4/4", "3/4": "3/4", "1/2": "2/4", "1/4": "1/4", Empty: "0/4" } as Record<string, string>)[previewRow.fuelLevel] ?? previewRow.fuelLevel}
                                    </p>
                                  </div>
                                </div>
                              )}
                              {previewRow.existingDamageNotes && (
                                <div className="flex items-start gap-3 rounded-lg bg-white/80 py-2.5 px-3 border border-emerald-100">
                                  <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-amber-100 flex items-center justify-center mt-0.5">
                                    <i className="fas fa-exclamation-triangle text-[10px] text-amber-600" />
                                  </div>
                                  <div className="flex-1 min-w-0">
                                    <p className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wide">Existing Damage</p>
                                    <p className="text-sm font-semibold text-neutral-800">{previewRow.existingDamageNotes}</p>
                                  </div>
                                </div>
                              )}
                              {/* Damage Photos - always show when in Vehicle Check-In section */}
                              <div className="rounded-lg bg-white/80 p-3 border border-emerald-100">
                                <p className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wide mb-2 flex items-center gap-1.5">
                                  <i className="fas fa-camera text-amber-500" />
                                  Damage Photos
                                  {previewRow.existingDamageImages && previewRow.existingDamageImages.length > 0 && (
                                    <span className="text-neutral-400 font-normal">({previewRow.existingDamageImages.length})</span>
                                  )}
                                </p>
                                {previewRow.existingDamageImages && previewRow.existingDamageImages.length > 0 ? (
                                  <div className="flex flex-wrap gap-3">
                                    {previewRow.existingDamageImages.map((url, idx) => (
                                      <button
                                        key={idx}
                                        type="button"
                                        onClick={() => setLightboxImage({ url, title: `Damage photo ${idx + 1}` })}
                                        className="group relative block w-36 h-36 rounded-lg overflow-hidden border-2 border-neutral-200 hover:border-emerald-400 transition-colors shrink-0 bg-neutral-100 cursor-pointer focus:outline-none focus:ring-2 focus:ring-emerald-400/50"
                                      >
                                        <img
                                          src={url}
                                          alt={`Damage photo ${idx + 1}`}
                                          className="w-full h-full object-cover"
                                          loading="lazy"
                                          referrerPolicy="no-referrer"
                                          onError={(e) => {
                                            (e.target as HTMLImageElement).style.display = "none";
                                            const parent = (e.target as HTMLImageElement).parentElement;
                                            const fallback = parent?.querySelector(".damage-img-fallback");
                                            if (fallback) (fallback as HTMLElement).style.display = "flex";
                                          }}
                                        />
                                        <div
                                          className="damage-img-fallback absolute inset-0 hidden items-center justify-center text-neutral-400 text-xs bg-neutral-100"
                                          style={{ display: "none" }}
                                        >
                                          <i className="fas fa-image" />
                                        </div>
                                        <div className="absolute inset-0 flex items-center justify-center bg-black/0 group-hover:bg-black/30 transition-colors">
                                          <i className="fas fa-expand text-white/0 group-hover:text-white/90 text-xl drop-shadow-lg transition-all" />
                                        </div>
                                      </button>
                                    ))}
                                  </div>
                                ) : (
                                  <p className="text-xs text-neutral-400 italic">No photos attached</p>
                                )}
                              </div>
                            </div>
                          </div>
                        </div>
                      )}

                      {/* Additional Issues (Technician-reported, owner/admin sets price) */}
                      {previewRow.additionalIssues && previewRow.additionalIssues.length > 0 && (
                        <div className="relative overflow-hidden rounded-2xl border border-amber-200/80 bg-gradient-to-br from-amber-50/80 via-white to-orange-50/50 shadow-sm">
                          <div className="absolute top-0 right-0 w-24 h-24 -translate-y-1/2 translate-x-1/2 rounded-full bg-amber-100/50 blur-xl" />
                          <div className="relative p-4">
                            <div className="flex items-center gap-3 mb-4">
                              <div className="flex-shrink-0 w-10 h-10 rounded-xl bg-amber-500/20 flex items-center justify-center border border-amber-300/50">
                                <i className="fas fa-exclamation-triangle text-amber-600" />
                              </div>
                              <div>
                                <p className="text-[10px] font-bold text-amber-600 uppercase tracking-widest">Additional Issues Found</p>
                                <p className="text-sm font-semibold text-neutral-800">Technician-reported – set price to notify customer</p>
                              </div>
                            </div>
                            <div className="space-y-3">
                              {previewRow.additionalIssues.map((issue) => {
                                const isCompleted = (issue.completionStatus || "").toLowerCase() === "completed";
                                const bookingCompleted = String(previewRow.status || "").toLowerCase() === "completed";
                                const hasCompletionImage = !!(issue.completionImageUrl && issue.completionImageUrl.trim());
                                const hasReportImage = !!(issue.imageUrl && issue.imageUrl.trim());
                                return (
                                <div
                                  key={issue.id}
                                  className={`rounded-xl border p-3 ${
                                    issue.status === "approved"
                                      ? "bg-emerald-50/80 border-emerald-200"
                                      : issue.status === "rejected"
                                      ? "bg-rose-50/80 border-rose-200"
                                      : "bg-amber-50/80 border-amber-200"
                                  }`}
                                >
                                  <div className="flex items-start justify-between gap-2">
                                    <div className="flex-1 min-w-0">
                                      <p className="font-semibold text-neutral-800">{issue.issueTitle}</p>
                                      {issue.description && (
                                        <p className="text-sm text-neutral-600 mt-1">{issue.description}</p>
                                      )}
                                      {issue.recommendedRepair && (
                                        <p className="text-xs text-neutral-500 mt-1">Repair: {issue.recommendedRepair}</p>
                                      )}
                                      {issue.partsRequired && (
                                        <p className="text-xs text-neutral-500">Parts: {issue.partsRequired}</p>
                                      )}
                                      {formatLabourMinutes(issue.labourTimeHours) && (
                                        <div className="inline-flex items-center gap-1.5 mt-1.5 px-2.5 py-1 rounded-lg bg-slate-100 border border-slate-200">
                                          <i className="fas fa-clock text-[10px] text-amber-600" />
                                          <span className="text-xs font-semibold text-neutral-700">{formatLabourMinutes(issue.labourTimeHours)}</span>
                                        </div>
                                      )}
                                      {issue.reportedByStaffName && (
                                        <p className="text-[10px] text-neutral-400 mt-1">— {issue.reportedByStaffName}</p>
                                      )}
                                      {hasReportImage && (
                                        <div className="mt-2">
                                          <img
                                            src={issue.imageUrl!}
                                            alt={`Report: ${issue.issueTitle}`}
                                            className="w-full h-auto max-h-[180px] rounded-lg border border-amber-200 object-cover cursor-pointer hover:opacity-80 hover:shadow transition-all"
                                            onClick={() => setLightboxImage({ url: issue.imageUrl!, title: `Report: ${issue.issueTitle}` })}
                                          />
                                          <p className="text-[10px] text-amber-600 mt-0.5 flex items-center gap-1 cursor-pointer hover:text-amber-700"
                                            onClick={() => setLightboxImage({ url: issue.imageUrl!, title: `Report: ${issue.issueTitle}` })}
                                          >
                                            <i className="fas fa-expand text-[9px]" /> Click to view full size
                                          </p>
                                        </div>
                                      )}
                                    </div>
                                    <div className="flex-shrink-0 text-right">
                                      {issue.status === "rejected" ? (
                                        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold bg-rose-100 text-rose-700 border border-rose-200">
                                          <i className="fas fa-times-circle" /> Rejected
                                        </span>
                                      ) : issue.price != null ? (
                                        <div className="flex flex-col items-end gap-1">
                                          <p className="font-bold text-emerald-700">${Number(issue.price).toFixed(2)}</p>
                                          {issue.priceSetByName && (
                                            <p className="text-[10px] text-neutral-500">by {issue.priceSetByName}</p>
                                          )}
                                          {issue.status === "approved" && (() => {
                                            const cr = (issue.customerResponse || "").toString().toLowerCase();
                                            if (cr === "accept" || cr === "accepted") {
                                              return (
                                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[10px] font-semibold bg-emerald-100 text-emerald-700 border border-emerald-200">
                                                  <i className="fas fa-check-circle" /> Accepted
                                                </span>
                                              );
                                            }
                                            if (cr === "reject" || cr === "rejected") {
                                              return (
                                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[10px] font-semibold bg-amber-100 text-amber-700 border border-amber-200">
                                                  <i className="fas fa-times-circle" /> Customer Rejected
                                                </span>
                                              );
                                            }
                                            return (
                                              <>
                                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[10px] font-semibold bg-amber-50 text-amber-700 border border-amber-200">
                                                  <i className="fas fa-clock" /> Awaiting Customer
                                                </span>
                                                {!isCompleted && !bookingCompleted && (
                                                  <div className="flex flex-col gap-1 mt-1">
                                                    <p className="text-[9px] text-neutral-500 italic">
                                                      Called the customer? Record their response:
                                                    </p>
                                                    <div className="flex gap-1">
                                                      <button
                                                        type="button"
                                                        onClick={() =>
                                                          setCustomerResponseModal({
                                                            bookingId: previewRow.id,
                                                            issue,
                                                            action: "accept",
                                                          })
                                                        }
                                                        className="px-2 py-1 text-[10px] font-semibold rounded-md bg-emerald-600 text-white hover:bg-emerald-700 transition-colors inline-flex items-center gap-1"
                                                        title="Customer accepted the quote on the phone"
                                                      >
                                                        <i className="fas fa-check text-[9px]" /> Accepted
                                                      </button>
                                                      <button
                                                        type="button"
                                                        onClick={() =>
                                                          setCustomerResponseModal({
                                                            bookingId: previewRow.id,
                                                            issue,
                                                            action: "reject",
                                                          })
                                                        }
                                                        className="px-2 py-1 text-[10px] font-semibold rounded-md bg-rose-600 text-white hover:bg-rose-700 transition-colors inline-flex items-center gap-1"
                                                        title="Customer declined the quote on the phone"
                                                      >
                                                        <i className="fas fa-times text-[9px]" /> Declined
                                                      </button>
                                                    </div>
                                                  </div>
                                                )}
                                              </>
                                            );
                                          })()}
                                        </div>
                                      ) : (
                                        <div className="flex flex-col items-end gap-1">
                                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[10px] font-semibold bg-amber-50 text-amber-700 border border-amber-200">
                                            <i className="fas fa-hourglass-half" /> Pending
                                          </span>
                                          {!isCompleted && !bookingCompleted ? (
                                            <button
                                              type="button"
                                              onClick={() => {
                                                setIssuePriceModal({ bookingId: previewRow.id, issue });
                                                setIssuePriceValue("");
                                              }}
                                              className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-amber-500 text-white hover:bg-amber-600 transition-colors"
                                            >
                                              Set Price
                                            </button>
                                          ) : (
                                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[10px] font-semibold bg-neutral-100 text-neutral-600 border border-neutral-200">
                                              <i className="fas fa-lock" /> Locked after completion
                                            </span>
                                          )}
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                  {/* Work completed – show completion image when done */}
                                  {isCompleted && (hasCompletionImage || issue.completionNote) && (
                                    <div className="mt-3 pt-3 border-t border-emerald-200/60">
                                      <p className="text-[10px] font-bold text-emerald-700 uppercase tracking-wide mb-2 flex items-center gap-1.5">
                                        <i className="fas fa-check-circle text-emerald-600" />
                                        Work completed
                                        {issue.completedByStaffName && (
                                          <span className="font-normal text-emerald-600/80">by {issue.completedByStaffName}</span>
                                        )}
                                      </p>
                                      {issue.completionNote && (
                                        <p className="text-sm text-neutral-700 mb-2">{issue.completionNote}</p>
                                      )}
                                      {hasCompletionImage && (
                                        <div>
                                          <img
                                            src={issue.completionImageUrl!}
                                            alt={`Completion for ${issue.issueTitle}`}
                                            className="w-full h-auto max-h-[240px] rounded-lg border border-emerald-200 object-cover cursor-pointer hover:opacity-80 hover:shadow-lg transition-all"
                                            onClick={() => setLightboxImage({ url: issue.completionImageUrl!, title: `Work completed: ${issue.issueTitle}` })}
                                          />
                                          <p className="text-[10px] text-emerald-500 mt-1 flex items-center gap-1 cursor-pointer hover:text-emerald-600 transition"
                                            onClick={() => setLightboxImage({ url: issue.completionImageUrl!, title: `Work completed: ${issue.issueTitle}` })}
                                          >
                                            <i className="fas fa-expand text-[9px]" /> Click to view full size
                                          </p>
                                        </div>
                                      )}
                                    </div>
                                  )}
                                </div>
                              );})}
                            </div>
                          </div>
                        </div>
                      )}
                      
                      <div className="rounded-xl border border-neutral-200 p-3 bg-neutral-50/50">
                        <div className="flex items-center justify-between">
                          <span className="text-neutral-500 text-xs uppercase tracking-wide">Booking Code</span>
                          <span className="font-mono font-bold text-neutral-800">{previewRow.bookingCode || previewRow.id.substring(0, 8)}</span>
                        </div>
                        {previewRow.bookingSource && (
                          <div className="flex items-center justify-between mt-2 pt-2 border-t border-neutral-200">
                            <span className="text-neutral-500 text-xs uppercase tracking-wide">Source</span>
                            <span className={`text-xs font-semibold px-2 py-1 rounded-full ${
                              previewRow.bookingSource === "booking_engine" 
                                ? "bg-blue-100 text-blue-700" 
                                : previewRow.bookingSource.includes("Branch Admin")
                                ? "bg-emerald-100 text-emerald-700"
                                : previewRow.bookingSource.includes("Owner")
                                ? "bg-purple-100 text-purple-700"
                                : previewRow.bookingSource.includes("Staff")
                                ? "bg-amber-100 text-amber-700"
                                : "bg-neutral-100 text-neutral-700"
                            }`}>
                              {previewRow.bookingSource === "booking_engine" 
                                ? "Booking Engine" 
                                : previewRow.bookingSource === "AdminBooking"
                                ? "Admin Panel"
                                : previewRow.bookingSource}
                            </span>
                          </div>
                        )}
                      </div>

                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <h4 className="text-xs font-bold text-neutral-400 uppercase tracking-wider">Services</h4>
                          {previewRow.services && previewRow.services.length > 1 && (
                            <span className="text-[10px] bg-neutral-100 text-neutral-500 px-2 py-0.5 rounded-full">
                              {previewRow.services.length} items
                            </span>
                          )}
                        </div>
                        <div className="space-y-2">
                          {(previewRow.services && previewRow.services.length > 0 ? previewRow.services : [{
                            id: 'main',
                            name: previewRow.serviceName,
                            staffName: previewRow.staffName,
                            time: previewRow.time,
                            duration: previewRow.duration,
                            price: previewRow.price,
                            approvalStatus: undefined,
                            completionStatus: undefined
                          }]).map((svc, idx) => {
                            // Determine approval status badge colors
                            const approvalStatus = ((svc as any).approvalStatus || "pending") as "pending" | "accepted" | "rejected" | "needs_assignment";
                            const completionStatus = ((svc as any).completionStatus || "pending") as "pending" | "completed";
                            const badgeMap = {
                              pending: { bg: "bg-amber-100", text: "text-amber-700", icon: "fa-clock", label: "Pending", border: "border-amber-200" },
                              accepted: { bg: "bg-emerald-100", text: "text-emerald-700", icon: "fa-check", label: "Accepted", border: "border-emerald-200" },
                              rejected: { bg: "bg-rose-100", text: "text-rose-700", icon: "fa-times", label: "Rejected", border: "border-rose-200" },
                              needs_assignment: { bg: "bg-purple-100", text: "text-purple-700", icon: "fa-user-plus", label: "Not Assigned Yet", border: "border-purple-200" },
                            };
                            const completionBadgeMap = {
                              pending: { bg: "bg-blue-100", text: "text-blue-700", icon: "fa-hourglass-half", label: "In Progress", border: "border-blue-200" },
                              completed: { bg: "bg-indigo-100", text: "text-indigo-700", icon: "fa-check-circle", label: "Done", border: "border-indigo-200" },
                            };
                            const approvalBadge = badgeMap[approvalStatus as keyof typeof badgeMap] || badgeMap.pending;
                            const completionBadge = completionBadgeMap[completionStatus] || completionBadgeMap.pending;
                            
                            // Determine border color based on status
                            const isConfirmed = previewRow.status === "Confirmed";
                            const isServiceCompleted = completionStatus === "completed";

                            return (
                            <div key={idx} className={`group relative overflow-hidden rounded-xl border bg-white p-3 shadow-sm hover:shadow-md transition-all duration-200 ${
                              approvalStatus === "rejected" ? "border-rose-200 hover:border-rose-300" : 
                              approvalStatus === "needs_assignment" ? "border-purple-200 hover:border-purple-300" :
                              isConfirmed && isServiceCompleted ? "border-indigo-200 hover:border-indigo-300" :
                              approvalStatus === "accepted" ? "border-emerald-200 hover:border-emerald-300" : 
                              "border-neutral-200 hover:border-neutral-300"
                            }`}>
                              <div className={`absolute left-0 top-0 bottom-0 w-1 ${
                                approvalStatus === "rejected" ? "bg-gradient-to-b from-rose-500 to-red-500" :
                                approvalStatus === "needs_assignment" ? "bg-gradient-to-b from-purple-500 to-violet-500" :
                                isConfirmed && isServiceCompleted ? "bg-gradient-to-b from-indigo-500 to-purple-500" :
                                approvalStatus === "accepted" ? "bg-gradient-to-b from-emerald-500 to-green-500" :
                                "bg-gradient-to-b from-neutral-700 to-neutral-900 opacity-0 group-hover:opacity-100"
                              } transition-opacity`} />
                              <div className="flex justify-between items-start mb-1.5">
                                <div className="font-bold text-neutral-800 text-sm flex items-center gap-2">
                                   <div className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 ${
                                     approvalStatus === "rejected" ? "bg-rose-50 text-rose-500" :
                                     isConfirmed && isServiceCompleted ? "bg-indigo-50 text-indigo-500" :
                                     approvalStatus === "accepted" ? "bg-emerald-50 text-emerald-500" :
                                     "bg-neutral-100 text-neutral-600"
                                   }`}>
                                     <i className={`fas ${isServiceCompleted ? "fa-check-circle" : "fa-magic"} text-[10px]`} />
                                   </div>
                                   {svc.name || "Service"}
                                </div>
                                <div className="flex items-center gap-2">
                                  {/* Show approval status badge for multi-service bookings during approval workflow */}
                                  {previewRow.services && previewRow.services.length > 0 && (previewRow.status === "AwaitingStaffApproval" || previewRow.status === "PartiallyApproved" || previewRow.status === "StaffRejected" || previewRow.status === "Pending") && (
                                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold ${approvalBadge.bg} ${approvalBadge.text}`}>
                                      <i className={`fas ${approvalBadge.icon} text-[8px]`} />
                                      {approvalBadge.label}
                                    </span>
                                  )}
                                  {/* Show completion status badge for ALL confirmed bookings */}
                                  {previewRow.status === "Confirmed" && (
                                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold ${completionBadge.bg} ${completionBadge.text}`}>
                                      <i className={`fas ${completionBadge.icon} text-[8px]`} />
                                      {completionBadge.label}
                                    </span>
                                  )}
                                  {svc.price !== undefined && <div className="font-bold text-neutral-900 text-sm">${svc.price}</div>}
                                </div>
                              </div>
                              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-neutral-500 pl-7">
                                 <div className="flex items-center gap-1.5 bg-neutral-50 px-2 py-1 rounded-md">
                                    <i className="far fa-clock text-neutral-400" />
                                    <span className="font-medium text-neutral-700">{svc.time || previewRow.time}</span>
                                    {svc.duration && <span className="text-neutral-400">({svc.duration}m)</span>}
                                 </div>
                                 <div className="flex items-center gap-1.5 bg-neutral-50 px-2 py-1 rounded-md">
                                    <i className="far fa-user text-purple-400" />
                                    <span className="font-medium text-neutral-700">{svc.staffName || previewRow.staffName || "Not Assigned Yet"}</span>
                                 </div>
                                 {(() => {
                                    // Show which vehicle-type tier this service was priced against (per-service → booking-level fallback).
                                    const svcVehicleType = ((svc as any).vehicleType as VehicleType | null | undefined) || previewRow.vehicleType || null;
                                    if (!svcVehicleType || !isVehicleType(svcVehicleType)) return null;
                                    return (
                                      <div
                                        className="flex items-center gap-1.5 bg-amber-50 border border-amber-100 px-2 py-1 rounded-md"
                                        title="Priced for this vehicle type"
                                      >
                                        <i className={`${VEHICLE_TYPE_ICONS[svcVehicleType]} text-[10px] text-amber-600`} />
                                        <span className="font-semibold text-amber-800">{VEHICLE_TYPE_LABELS[svcVehicleType]}</span>
                                      </div>
                                    );
                                 })()}
                              </div>
                              {/* Show rejection reason if service was rejected */}
                              {approvalStatus === "rejected" && (svc as any).rejectionReason && (
                                <div className="mt-2 p-2 bg-rose-50 rounded-lg border border-rose-100 pl-7">
                                  <p className="text-xs text-rose-700 flex items-start gap-1.5">
                                    <i className="fas fa-exclamation-circle mt-0.5 shrink-0" />
                                    <span><strong>Rejected:</strong> {(svc as any).rejectionReason}</span>
                                  </p>
                                  {(svc as any).respondedByStaffName && (
                                    <p className="text-[10px] text-rose-500 mt-1 pl-5">
                                      by {(svc as any).respondedByStaffName}
                                    </p>
                                  )}
                                </div>
                              )}
                              {/* Show completion info if service was completed */}
                              {isConfirmed && isServiceCompleted && (svc as any).completedByStaffName && (
                                <div className="mt-2 p-2 bg-indigo-50 rounded-lg border border-indigo-100 pl-7">
                                  <p className="text-xs text-indigo-700 flex items-start gap-1.5">
                                    <i className="fas fa-check-circle mt-0.5 shrink-0" />
                                    <span>Completed by {(svc as any).completedByStaffName}</span>
                                  </p>
                                </div>
                              )}
                            </div>
                            );
                          })}
                        </div>
                      </div>

                      {/* ─── Task Progress & List ─────────────────────────── */}
                      {previewRow.tasks && previewRow.tasks.length > 0 && (() => {
                        const doneCount = previewRow.tasks.filter(t => !!t.done).length;
                        const totalCount = previewRow.tasks.length;
                        const pct =
                          totalCount > 0
                            ? Math.round((doneCount / totalCount) * 100)
                            : previewRow.taskProgress || 0;
                        const isComplete = totalCount > 0 && doneCount === totalCount;
                        // Group tasks by service, and within each service by vehicle area
                        // using the owner's snapshotted areaOrder (falling back to the
                        // default order for older bookings without that snapshot).
                        type ServiceGroup = {
                          label: string;
                          tasks: NonNullable<typeof previewRow.tasks>;
                          areaOrder: ChecklistSection[];
                          areaGroups: Array<{
                            key: ChecklistSection | "unset";
                            label: string;
                            tasks: NonNullable<typeof previewRow.tasks>;
                          }>;
                        };
                        const serviceTaskGroups: ServiceGroup[] = (() => {
                          const groups = new Map<string, ServiceGroup>();
                          for (const task of previewRow.tasks) {
                            const taskServiceId = task.serviceId ? String(task.serviceId) : "";
                            const taskServiceName = task.serviceName ? String(task.serviceName) : "";
                            let matchedServiceName = taskServiceName || "General";
                            let matchedAreaOrder: ChecklistSection[] = [...DEFAULT_AREA_ORDER];
                            let haveAreaOrder = false;

                            if (previewRow.services && previewRow.services.length > 0) {
                              const matchedService = previewRow.services.find((svc) => {
                                const svcId = String(svc.id || svc.serviceId || "");
                                const svcName = String(svc.name || "");
                                return (taskServiceId && svcId && taskServiceId === svcId) ||
                                  (taskServiceName && svcName && taskServiceName === svcName);
                              });
                              if (matchedService?.name) matchedServiceName = String(matchedService.name);
                              if (matchedService?.areaOrder && matchedService.areaOrder.length > 0) {
                                matchedAreaOrder = normalizeAreaOrder(matchedService.areaOrder);
                                haveAreaOrder = true;
                              }
                            }
                            // Fallback: use the live service's areaOrder when the booking
                            // snapshot was written before we started persisting it.
                            if (!haveAreaOrder && taskServiceId) {
                              const fallback = serviceAreaOrderFallback[taskServiceId];
                              if (fallback && fallback.length > 0) {
                                matchedAreaOrder = fallback;
                              }
                            }

                            const key = taskServiceId || matchedServiceName;
                            if (!groups.has(key)) {
                              groups.set(key, {
                                label: matchedServiceName,
                                tasks: [] as NonNullable<typeof previewRow.tasks>,
                                areaOrder: matchedAreaOrder,
                                areaGroups: [],
                              });
                            }
                            groups.get(key)!.tasks.push(task);
                          }
                          // Build area-wise sub-groups for each service group.
                          for (const group of groups.values()) {
                            const buckets = new Map<
                              ChecklistSection | "unset",
                              NonNullable<typeof previewRow.tasks>
                            >();
                            for (const t of group.tasks) {
                              const bucketKey: ChecklistSection | "unset" =
                                isChecklistSection(t.section) ? t.section : "unset";
                              if (!buckets.has(bucketKey)) buckets.set(bucketKey, [] as NonNullable<typeof previewRow.tasks>);
                              buckets.get(bucketKey)!.push(t);
                            }
                            const areaGroups: ServiceGroup["areaGroups"] = [];
                            for (const area of group.areaOrder) {
                              const tasks = buckets.get(area);
                              if (tasks && tasks.length > 0) {
                                areaGroups.push({ key: area, label: CHECKLIST_SECTION_LABELS[area], tasks });
                              }
                            }
                            const unset = buckets.get("unset");
                            if (unset && unset.length > 0) {
                              areaGroups.push({ key: "unset", label: "Other", tasks: unset });
                            }
                            group.areaGroups = areaGroups;
                          }
                          return Array.from(groups.values());
                        })();
                        return (
                        <div className="space-y-3">
                          {/* Creative progress widget */}
                          <div className={`relative rounded-2xl border p-4 transition-all duration-500 overflow-hidden ${
                            isComplete
                              ? "bg-gradient-to-br from-emerald-50 via-green-50 to-teal-50 border-emerald-200/80"
                              : "bg-gradient-to-br from-slate-50 via-white to-neutral-50 border-neutral-200/80"
                          }`}>
                            {/* Background glow */}
                            {isComplete && <div className="absolute top-0 right-0 w-28 h-28 bg-emerald-400/10 rounded-full blur-2xl -translate-y-8 translate-x-8" />}

                            {/* Top row: icon + title + circular gauge */}
                            <div className="flex items-center justify-between mb-3.5 relative z-10">
                              <div className="flex items-center gap-2.5">
                                <div className={`w-9 h-9 rounded-xl flex items-center justify-center shadow-md ${
                                  isComplete
                                    ? "bg-emerald-500 shadow-emerald-500/25"
                                    : pct > 50
                                    ? "bg-amber-500 shadow-amber-500/20"
                                    : "bg-neutral-900 shadow-neutral-900/15"
                                }`}>
                                  <i className={`fas ${isComplete ? "fa-check-double" : "fa-clipboard-list"} text-white text-xs`} />
                                </div>
                                <div>
                                  <h4 className="text-sm font-extrabold text-neutral-800 tracking-tight">Task Progress</h4>
                                  <p className="text-[10px] text-neutral-400 font-medium">
                                    {isComplete ? "All tasks completed" : `${totalCount - doneCount} task${totalCount - doneCount !== 1 ? "s" : ""} remaining`}
                                  </p>
                                </div>
                              </div>

                              {/* Circular percentage gauge */}
                              <div className="relative w-12 h-12">
                                <svg className="w-12 h-12 -rotate-90" viewBox="0 0 36 36">
                                  <circle cx="18" cy="18" r="14" fill="none" stroke={isComplete ? "#d1fae5" : "#f5f5f5"} strokeWidth="2.5" />
                                  <circle
                                    cx="18" cy="18" r="14" fill="none"
                                    stroke={isComplete ? "#10b981" : pct > 50 ? "#f59e0b" : "#3b82f6"}
                                    strokeWidth="2.5"
                                    strokeLinecap="round"
                                    strokeDasharray={`${pct * 0.88} 88`}
                                    className="transition-all duration-1000 ease-out"
                                  />
                                </svg>
                                <span className={`absolute inset-0 flex items-center justify-center text-[10px] font-black ${
                                  isComplete ? "text-emerald-600" : "text-neutral-700"
                                }`}>
                                  {pct}%
                                </span>
                              </div>
                            </div>

                            {/* Segmented progress — one strip per vehicle area (owner order),
                                each area sub-divided into one pip per task. Falls back to a flat
                                per-task bar when no task carries a `section`. */}
                            {(() => {
                              const hasAnySection = previewRow.tasks.some((t) => isChecklistSection(t.section));
                              if (!hasAnySection) {
                                return (
                                  <div className="flex items-center gap-1 relative z-10">
                                    {previewRow.tasks.map((task, i) => (
                                      <div key={task.id || i} className="flex-1">
                                        <div
                                          className={`h-2.5 rounded-full transition-all duration-500 ${
                                            task.done
                                              ? isComplete
                                                ? "bg-gradient-to-r from-emerald-400 to-emerald-500 shadow-sm shadow-emerald-500/20"
                                                : "bg-gradient-to-r from-amber-400 to-amber-500 shadow-sm shadow-amber-500/20"
                                              : "bg-neutral-200/80"
                                          }`}
                                        />
                                      </div>
                                    ))}
                                  </div>
                                );
                              }
                              // Derive area order from the booking's first service snapshot,
                              // then fall back to the live-service cache (for legacy bookings
                              // whose snapshots predate areaOrder), finally default order.
                              let resolvedOrder: ChecklistSection[] = [...DEFAULT_AREA_ORDER];
                              const firstSvc = previewRow.services?.[0];
                              if (firstSvc?.areaOrder && firstSvc.areaOrder.length > 0) {
                                resolvedOrder = normalizeAreaOrder(firstSvc.areaOrder);
                              } else {
                                const firstSvcId = firstSvc?.id
                                  ? String(firstSvc.id)
                                  : previewRow.tasks.find((t) => t.serviceId)?.serviceId;
                                if (firstSvcId) {
                                  const fb = serviceAreaOrderFallback[String(firstSvcId)];
                                  if (fb && fb.length > 0) resolvedOrder = fb;
                                }
                              }
                              const buckets = new Map<ChecklistSection, boolean[]>();
                              for (const a of resolvedOrder) buckets.set(a, []);
                              const otherDones: boolean[] = [];
                              for (const t of previewRow.tasks) {
                                if (isChecklistSection(t.section)) {
                                  buckets.get(t.section)!.push(!!t.done);
                                } else {
                                  otherDones.push(!!t.done);
                                }
                              }
                              type AreaSeg = { key: string; label: string; dones: boolean[] };
                              const segments: AreaSeg[] = [];
                              for (const a of resolvedOrder) {
                                segments.push({
                                  key: a,
                                  label: CHECKLIST_SECTION_LABELS[a],
                                  dones: buckets.get(a)!,
                                });
                              }
                              if (otherDones.length > 0) {
                                segments.push({ key: "other", label: "Other", dones: otherDones });
                              }
                              return (
                                <div className="flex items-stretch gap-1 sm:gap-1.5 relative z-10">
                                  {segments.map((seg) => {
                                    const segTotal = seg.dones.length;
                                    const segDone = seg.dones.filter(Boolean).length;
                                    const areaComplete = segTotal > 0 && segDone === segTotal;
                                    const pips = segTotal > 0 ? seg.dones : [false];
                                    return (
                                      <div
                                        key={seg.key}
                                        className="flex-1 flex flex-col gap-1 min-w-0"
                                        title={`${seg.label}: ${segDone}/${segTotal} tasks`}
                                      >
                                        <div className="h-2.5 flex items-stretch gap-[2px]">
                                          {pips.map((done, pi) => (
                                            <div
                                              key={pi}
                                              className={`flex-1 h-full rounded-full transition-all duration-500 ${
                                                segTotal === 0
                                                  ? "bg-neutral-200/80"
                                                  : done
                                                    ? areaComplete
                                                      ? "bg-gradient-to-r from-emerald-400 to-emerald-500 shadow-sm shadow-emerald-500/20"
                                                      : "bg-gradient-to-r from-amber-400 to-amber-500 shadow-sm shadow-amber-500/20"
                                                    : "bg-neutral-200/80"
                                              }`}
                                            />
                                          ))}
                                        </div>
                                        <span className="text-[7px] sm:text-[8px] font-bold text-neutral-400 truncate text-center leading-none px-0.5">
                                          {seg.label}
                                        </span>
                                      </div>
                                    );
                                  })}
                                </div>
                              );
                            })()}

                            {/* Bottom label */}
                            <div className="flex items-center justify-between mt-2.5 relative z-10">
                              <span className="text-[10px] font-bold text-neutral-500">
                                <span className={`text-xs ${isComplete ? "text-emerald-600" : "text-neutral-800"}`}>{doneCount}</span>
                                <span className="text-neutral-400">/{totalCount} tasks done</span>
                              </span>
                              {isComplete && (
                                <span className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-600 bg-emerald-100 px-2 py-0.5 rounded-full">
                                  <i className="fas fa-sparkles text-[8px]" />
                                  Complete
                                </span>
                              )}
                            </div>
                          </div>

                          {/* Task list (service-wise groups) */}
                          <div className="space-y-3">
                            {serviceTaskGroups.map((group, groupIdx) => {
                              const groupDone = group.tasks.filter((t) => t.done).length;
                              const groupTotal = group.tasks.length;
                              const groupComplete = groupTotal > 0 && groupDone === groupTotal;
                              return (
                                <div key={`${group.label}-${groupIdx}`} className="rounded-xl border border-neutral-200 bg-white overflow-hidden">
                                  <div className={`px-3 py-2 border-b flex items-center justify-between ${
                                    groupComplete ? "bg-emerald-50 border-emerald-200" : "bg-neutral-50 border-neutral-200"
                                  }`}>
                                    <div className="flex items-center gap-2 min-w-0">
                                      <i className={`fas fa-spa text-[11px] ${groupComplete ? "text-emerald-600" : "text-neutral-500"}`} />
                                      <h5 className={`text-xs font-bold truncate ${groupComplete ? "text-emerald-700" : "text-neutral-800"}`} title={group.label}>
                                        {group.label}
                                      </h5>
                                    </div>
                                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                                      groupComplete ? "bg-emerald-100 text-emerald-700" : "bg-blue-100 text-blue-700"
                                    }`}>
                                      {groupDone}/{groupTotal}
                                    </span>
                                  </div>
                                  <div className="p-3 space-y-4">
                                    {(() => {
                                      let taskNum = 0;
                                      return group.areaGroups.map((area, areaIdx) => {
                                        const areaDone = area.tasks.filter((t) => t.done).length;
                                        const areaTotal = area.tasks.length;
                                        return (
                                          <div key={`${area.key}-${areaIdx}`} className="space-y-2">
                                            {/* Area header */}
                                            <div className="flex items-center gap-2 px-1">
                                              <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                                              <h6 className="text-[11px] font-bold uppercase tracking-wide text-neutral-600">
                                                {area.label}
                                              </h6>
                                              <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-md ${
                                                areaTotal > 0 && areaDone === areaTotal
                                                  ? "bg-emerald-100 text-emerald-700"
                                                  : "bg-amber-100 text-amber-700"
                                              }`}>
                                                {areaDone}/{areaTotal}
                                              </span>
                                              <div className="flex-1 h-px bg-neutral-200" />
                                            </div>
                                            <div className="space-y-2">
                                              {area.tasks.map((task, idx) => {
                                                taskNum += 1;
                                                return (
                                                  <div key={task.id || `${groupIdx}-${areaIdx}-${idx}`} className={`rounded-xl border p-3 transition-all ${
                                                    task.done
                                                      ? "bg-emerald-50/50 border-emerald-200"
                                                      : "bg-white border-neutral-200"
                                                  }`}>
                                                    <div className="flex items-start gap-3">
                                                      <div className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 mt-0.5 ${
                                                        task.done ? "bg-emerald-500 text-white" : "bg-neutral-200 text-neutral-400"
                                                      }`}>
                                                        {task.done ? (
                                                          <i className="fas fa-check text-[10px]" />
                                                        ) : (
                                                          <span className="text-[10px] font-bold">{taskNum}</span>
                                                        )}
                                                      </div>
                                                      <div className="flex-1 min-w-0">
                                                        <div className="flex items-center justify-between">
                                                          <p className={`text-sm font-semibold ${task.done ? "text-emerald-700 line-through" : "text-neutral-800"}`}>
                                                            {task.name}
                                                          </p>
                                                          {task.done && (
                                                            <span className="text-[10px] font-semibold text-emerald-600 bg-emerald-100 px-2 py-0.5 rounded-full">Done</span>
                                                          )}
                                                        </div>
                                                        {task.description && (
                                                          <p className="text-xs text-neutral-500 mt-1">{task.description}</p>
                                                        )}
                                                        {/* Condition pill */}
                                                        {(() => {
                                                          const opt = taskConditionOption(task.condition);
                                                          if (!opt) return null;
                                                          return (
                                                            <div className="mt-2">
                                                              <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[10px] font-bold ${opt.badgeClass}`}>
                                                                <span className={`w-1.5 h-1.5 rounded-full ${opt.dotClass}`} />
                                                                {opt.label}
                                                              </span>
                                                            </div>
                                                          );
                                                        })()}
                                                        {/* Staff note */}
                                                        {task.staffNote && (
                                                          <div className="mt-2 p-2.5 bg-blue-50 rounded-lg border border-blue-100">
                                                            <p className="text-xs text-blue-700">
                                                              <i className="fas fa-comment-alt mr-1" />
                                                              {task.staffNote}
                                                            </p>
                                                            {task.completedByStaffName && (
                                                              <p className="text-[10px] text-blue-500 mt-0.5">— {task.completedByStaffName}</p>
                                                            )}
                                                          </div>
                                                        )}
                                                        {/* Task image */}
                                                        {task.imageUrl && (
                                                          <div className="mt-2">
                                                            <img
                                                              src={task.imageUrl}
                                                              alt={task.name}
                                                              className="w-full h-auto max-h-[280px] rounded-xl border border-neutral-200 object-cover cursor-pointer hover:opacity-80 hover:shadow-lg transition-all"
                                                              onClick={() => setLightboxImage({ url: task.imageUrl, title: task.name })}
                                                            />
                                                            <p className="text-[10px] text-neutral-400 mt-1 flex items-center gap-1 cursor-pointer hover:text-blue-500 transition"
                                                              onClick={() => setLightboxImage({ url: task.imageUrl, title: task.name })}
                                                            >
                                                              <i className="fas fa-expand text-[9px]" /> Click to view full size
                                                            </p>
                                                          </div>
                                                        )}
                                                      </div>
                                                    </div>
                                                  </div>
                                                );
                                              })}
                                            </div>
                                          </div>
                                        );
                                      });
                                    })()}
                                  </div>
                                </div>
                              );
                            })}
                          </div>

                          {/* Final Submission */}
                          {previewRow.finalSubmission && (
                            <div className="rounded-xl border border-indigo-200 bg-indigo-50/50 p-4">
                              <div className="flex items-center gap-2 mb-3">
                                <div className="w-7 h-7 rounded-full bg-indigo-500 text-white flex items-center justify-center">
                                  <i className="fas fa-flag-checkered text-[11px]" />
                                </div>
                                <h5 className="text-sm font-bold text-indigo-700">Final Submission</h5>
                                {previewRow.finalSubmission.submittedByStaffName && (
                                  <span className="text-[11px] text-indigo-500 ml-auto">
                                    by {previewRow.finalSubmission.submittedByStaffName}
                                  </span>
                                )}
                              </div>
                              {previewRow.finalSubmission.description && (
                                <p className="text-sm text-indigo-800 mb-3">{previewRow.finalSubmission.description}</p>
                              )}
                              {previewRow.finalSubmission.imageUrl && (
                                <div>
                                  <img
                                    src={previewRow.finalSubmission.imageUrl}
                                    alt="Final submission"
                                    className="w-full h-auto max-h-[300px] rounded-xl border border-indigo-200 object-cover cursor-pointer hover:opacity-80 hover:shadow-lg transition-all"
                                    onClick={() => setLightboxImage({ url: previewRow.finalSubmission!.imageUrl, title: "Final Submission" })}
                                  />
                                  <p className="text-[10px] text-indigo-400 mt-1 flex items-center gap-1 cursor-pointer hover:text-indigo-600 transition"
                                    onClick={() => setLightboxImage({ url: previewRow.finalSubmission!.imageUrl, title: "Final Submission" })}
                                  >
                                    <i className="fas fa-expand text-[9px]" /> Click to view full size
                                  </p>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                        );
                      })()}
                      
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <p className="text-neutral-400">Date & Time</p>
                          <p className="font-medium text-neutral-700 flex items-center gap-2">
                            <i className="fas fa-clock text-neutral-400" />
                            {previewRow.date} {previewRow.time}
                          </p>
                          {previewRow.pickupTime && (
                            <p className="text-xs text-emerald-600 font-medium mt-0.5 flex items-center gap-1">
                              <i className="fas fa-arrow-right-from-bracket text-[10px]" />
                              Pick-up: {previewRow.pickupTime}
                            </p>
                          )}
                        </div>
                        <div>
                          <p className="text-neutral-400">Duration</p>
                          <p className="font-medium text-neutral-700">{previewRow.duration} mins</p>
                        </div>
                      </div>
                      <div>
                        <p className="text-neutral-400">Branch</p>
                        <p className="font-medium text-neutral-700 flex items-center gap-2">
                          <i className="fas fa-store text-neutral-400" />
                          {previewRow.branchName || "-"}
                        </p>
                      </div>
                      <div>
                        <p className="text-neutral-400">Status</p>
                        <p className="inline-flex items-center gap-2 px-2 py-1 text-xs rounded-full bg-neutral-100 text-neutral-700">
                          <i className="fas fa-circle text-[8px] text-neutral-400" />
                          {previewRow.status || status}
                        </p>
                      </div>
                      <div>
                        <p className="text-neutral-400">Price</p>
                        <p className="font-semibold text-neutral-800 flex items-center gap-1"><i className="fas fa-dollar-sign text-neutral-400" />{previewRow.price}</p>
                      </div>
                      {previewRow.notes && (
                        <div>
                          <p className="text-neutral-400">Notes</p>
                          <p className="text-neutral-700 whitespace-pre-wrap">{previewRow.notes}</p>
                        </div>
                      )}
                      {previewRow.status === "Confirmed" && (
                        <div className="pt-2 border-t border-neutral-100">
                          <p className="text-neutral-400 text-xs mb-2">Add Mileage (optional)</p>
                          <div className="flex gap-2">
                            <input
                              type="text"
                              inputMode="numeric"
                              value={mileageEditValue}
                              onChange={(e) => setMileageEditValue(e.target.value.replace(/\D/g, ""))}
                              placeholder="e.g. 45000"
                              className="flex-1 border border-neutral-200 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-neutral-400 focus:border-neutral-500 outline-none"
                            />
                            <span className="self-center text-neutral-500 text-sm">km</span>
                            <button
                              onClick={handleSaveMileage}
                              disabled={mileageSaving}
                              className="px-3 py-2 rounded-lg text-sm font-semibold bg-neutral-800 text-white hover:bg-neutral-700 disabled:opacity-60"
                            >
                              {mileageSaving ? "Saving..." : "Save"}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                  </div>
                  <div className="shrink-0 border-t border-neutral-200 p-4 flex items-center justify-end gap-2 bg-white/90 backdrop-blur">
                    {previewRow && previewRow.status === "Completed" && (
                      <button
                        onClick={() => previewRow && openJobReportPdfPreview(previewRow.id, previewRow.bookingCode)}
                        className="px-4 py-2 rounded-full text-sm font-semibold inline-flex items-center gap-2 bg-gradient-to-r from-neutral-800 to-neutral-900 hover:from-neutral-900 hover:to-black text-white shadow-sm mr-auto"
                      >
                        <i className="fas fa-file-pdf" />
                        View job report PDF
                      </button>
                    )}
                    <button
                      onClick={closePreview}
                      className="px-3 py-1.5 rounded-full text-xs font-semibold bg-neutral-100 hover:bg-neutral-200 text-neutral-700"
                    >
                      Close
                    </button>
                    {previewRow && getAllowedActions(previewRow.status, previewRow).includes("Confirm") && (
                      <button
                        disabled={!!updatingState[previewRow.id]}
                        onClick={() => {
                          closePreview();
                          handleConfirmClick(previewRow);
                        }}
                        className={`px-4 py-2 rounded-full text-sm font-semibold inline-flex items-center gap-2 ${updatingState[previewRow.id] === "Confirm" ? "bg-emerald-300 text-white" : "bg-gradient-to-r from-emerald-500 to-green-600 hover:from-emerald-600 hover:to-green-700 text-white shadow-sm"}`}
                        aria-busy={!!updatingState[previewRow.id]}
                      >
                        {updatingState[previewRow.id] === "Confirm" ? <i className="fas fa-spinner fa-spin" /> : <i className="fas fa-check-circle" />}
                        {updatingState[previewRow.id] === "Confirm" ? "Confirming..." : "Confirm"}
                      </button>
                    )}
                    {previewRow && getAllowedActions(previewRow.status, previewRow).includes("Reassign") && (
                      <button
                        disabled={!!updatingState[previewRow.id]}
                        onClick={() => {
                          closePreview();
                          handleReassignClick(previewRow);
                        }}
                        className={`px-4 py-2 rounded-full text-sm font-semibold inline-flex items-center gap-2 ${updatingState[previewRow.id] === "Reassign" ? "bg-amber-300 text-white" : "bg-gradient-to-r from-amber-500 to-orange-600 hover:from-amber-600 hover:to-orange-700 text-white shadow-sm"}`}
                        aria-busy={!!updatingState[previewRow.id]}
                      >
                        {updatingState[previewRow.id] === "Reassign" ? <i className="fas fa-spinner fa-spin" /> : <i className="fas fa-user-plus" />}
                        {updatingState[previewRow.id] === "Reassign" ? "Reassigning..." : "Reassign"}
                      </button>
                    )}
                    {previewRow && getAllowedActions(previewRow.status, previewRow).includes("AssignStaff") && (
                      <button
                        disabled={!!updatingState[previewRow.id]}
                        onClick={() => {
                          closePreview();
                          handleReassignClick(previewRow);
                        }}
                        className={`px-4 py-2 rounded-full text-sm font-semibold inline-flex items-center gap-2 ${updatingState[previewRow.id] === "AssignStaff" ? "bg-purple-300 text-white" : "bg-gradient-to-r from-purple-500 to-violet-600 hover:from-purple-600 hover:to-violet-700 text-white shadow-sm"}`}
                        aria-busy={!!updatingState[previewRow.id]}
                      >
                        {updatingState[previewRow.id] === "AssignStaff" ? <i className="fas fa-spinner fa-spin" /> : <i className="fas fa-user-plus" />}
                        {updatingState[previewRow.id] === "AssignStaff" ? "Assigning..." : "Assign Staff"}
                      </button>
                    )}
                    {previewRow && getAllowedActions(previewRow.status, previewRow).includes("Complete") && (
                      <button
                        disabled={!!updatingState[previewRow.id]}
                        onClick={() => onAction(previewRow.id, "Complete")}
                        className={`px-4 py-2 rounded-full text-sm font-semibold inline-flex items-center gap-2 ${updatingState[previewRow.id] === "Complete" ? "bg-indigo-300 text-white" : "bg-gradient-to-r from-indigo-500 to-violet-600 hover:from-indigo-600 hover:to-violet-700 text-white shadow-sm"}`}
                        aria-busy={!!updatingState[previewRow.id]}
                      >
                        {updatingState[previewRow.id] === "Complete" ? <i className="fas fa-spinner fa-spin" /> : <i className="fas fa-flag-checkered" />}
                        {updatingState[previewRow.id] === "Complete" ? "Completing..." : "Complete"}
                      </button>
                    )}
                    {previewRow && getAllowedActions(previewRow.status, previewRow).includes("Reschedule") && (
                      <button
                        disabled={!!updatingState[previewRow.id]}
                        onClick={() => {
                          closePreview();
                          handleRescheduleClick(previewRow);
                        }}
                        className="px-4 py-2 rounded-full text-sm font-semibold inline-flex items-center gap-2 text-white shadow-sm transition"
                        style={{ backgroundColor: updatingState[previewRow.id] === "Reschedule" ? "#3b82f6" : "#1d4ed8" }}
                        onMouseEnter={(e) => {
                          if (updatingState[previewRow.id] !== "Reschedule") e.currentTarget.style.backgroundColor = "#1e40af";
                        }}
                        onMouseLeave={(e) => {
                          if (updatingState[previewRow.id] !== "Reschedule") e.currentTarget.style.backgroundColor = "#1d4ed8";
                        }}
                        aria-busy={!!updatingState[previewRow.id]}
                        title="Change booking date & time"
                      >
                        {updatingState[previewRow.id] === "Reschedule" ? <i className="fas fa-spinner fa-spin" /> : <i className="fas fa-calendar-days" />}
                        {updatingState[previewRow.id] === "Reschedule" ? "Rescheduling..." : "Reschedule"}
                      </button>
                    )}
                    {previewRow && getAllowedActions(previewRow.status, previewRow).includes("Cancel") && (
                      <button
                        disabled={!!updatingState[previewRow.id]}
                        onClick={() => onAction(previewRow.id, "Cancel")}
                        className={`px-4 py-2 rounded-full text-sm font-semibold inline-flex items-center gap-2 ${updatingState[previewRow.id] === "Cancel" ? "bg-rose-300 text-white" : "bg-gradient-to-r from-rose-500 to-red-600 hover:from-rose-600 hover:to-red-700 text-white shadow-sm"}`}
                        aria-busy={!!updatingState[previewRow.id]}
                      >
                        {updatingState[previewRow.id] === "Cancel" ? <i className="fas fa-spinner fa-spin" /> : <i className="fas fa-ban" />}
                        {updatingState[previewRow.id] === "Cancel" ? "Cancelling..." : "Cancel"}
                      </button>
                    )}
                  </div>
                </div>
              </aside>
            </div>

            {/* Footer now lives inside the aside for correct order */}

            {/* ═══ MOBILE CARD VIEW ═══ */}
            <div className="md:hidden space-y-3">
              {loading && (
                <div className="bg-white rounded-xl border border-neutral-200 p-6 text-center text-neutral-400 text-sm">Loading...</div>
              )}
              {!loading && rows.length === 0 && (
                <div className="bg-white rounded-xl border border-neutral-200 p-6 text-center text-neutral-500 text-sm">No bookings.</div>
              )}
              {!loading && rows.map((r) => {
                const initials = r.client.split(" ").filter(Boolean).slice(0, 2).map((s) => s[0]?.toUpperCase() || "").join("");
                const rowActions = getAllowedActions(r.status, r);
                const statusColor = getStatusColor(normalizeBookingStatus(r.status));
                const statusLabel = getStatusLabel(normalizeBookingStatus(r.status));
                return (
                  <div key={r.id} className="bg-white rounded-xl border border-neutral-200 shadow-sm overflow-hidden">
                    <div className="p-4">
                      {/* Top row: Avatar + Name + Status */}
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 flex-shrink-0 bg-neutral-900 text-white flex items-center justify-center text-sm font-bold shadow-sm" style={{ borderRadius: "50%" }}>
                          {initials || <i className="fas fa-user" />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="font-semibold text-neutral-800 truncate">{r.client}</div>
                          {r.bookingCode && <div className="text-[11px] text-neutral-400 font-mono">{r.bookingCode}</div>}
                        </div>
                        <span className={`px-2.5 py-1 rounded-full text-[10px] font-bold flex-shrink-0 ${statusColor}`}>{statusLabel}</span>
                      </div>

                      {/* Services */}
                      {r.services && r.services.length > 0 ? (
                        <div className="mt-3 space-y-1.5">
                          {r.services.map((svc, idx) => (
                            <div key={idx} className="flex items-center gap-2 py-1 px-2.5 rounded-lg bg-neutral-50 border border-neutral-100">
                              <i className="fas fa-spa text-[10px] text-neutral-500" />
                              <span
                                className="text-xs font-semibold text-neutral-700 truncate whitespace-nowrap inline-block w-[170px]"
                                title={svc.name || "Service"}
                              >
                                {svc.name || "Service"}
                              </span>
                              {showStaffColumn && (svc.staffName ? <span className="ml-auto text-[10px] text-purple-600 font-medium truncate"><i className="far fa-user text-[8px] mr-0.5" />{svc.staffName}</span> : <span className="ml-auto text-[10px] text-amber-600 font-medium"><i className="fas fa-user-plus text-[8px] mr-0.5" />Unassigned</span>)}
                            </div>
                          ))}
                        </div>
                      ) : r.serviceName && (
                        <div className="mt-3 flex items-center gap-2 py-1 px-2.5 rounded-lg bg-neutral-50 border border-neutral-100">
                          <i className="fas fa-spa text-[10px] text-neutral-500" />
                          <span
                            className="text-xs font-semibold text-neutral-700 truncate whitespace-nowrap inline-block w-[170px]"
                            title={r.serviceName}
                          >
                            {r.serviceName}
                          </span>
                          {showStaffColumn && r.staffName && !["Any Available", "Any Staff", "Not Assigned Yet"].includes(String(r.staffName)) && (
                            <span className="ml-auto text-[10px] text-purple-600 font-medium"><i className="far fa-user text-[8px] mr-0.5" />{r.staffName}</span>
                          )}
                        </div>
                      )}

                      {/* Vehicle (make, model, type) - 3 lines with labels */}
                      <div className="mt-2 rounded-lg bg-neutral-50 border border-neutral-100 px-3 py-2">
                        {[r.vehicleMake, r.vehicleModel, r.vehicleType, r.vehicleBodyType].filter(Boolean).length > 0 ? (
                          <div className="space-y-1.5">
                            <div className="flex items-center gap-2">
                              <div className="flex-1 min-w-0 flex items-baseline gap-2">
                                <span className="text-[9px] font-semibold text-neutral-400 uppercase shrink-0">Make</span>
                                <span className="text-[11px] font-semibold text-neutral-800 truncate">{r.vehicleMake || "N/A"}</span>
                              </div>
                            </div>
                            <div className="flex items-baseline gap-2 pl-4">
                              <span className="text-[9px] font-semibold text-neutral-400 uppercase w-10 shrink-0">Model</span>
                              <span className="text-[11px] text-neutral-700 truncate">{r.vehicleModel || "N/A"}</span>
                            </div>
                            <div className="flex items-baseline gap-2 pl-4">
                              <span className="text-[9px] font-semibold text-neutral-400 uppercase w-10 shrink-0">Type</span>
                              {r.vehicleType && isVehicleType(r.vehicleType) ? (
                                <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-800">
                                  <i className={`${VEHICLE_TYPE_ICONS[r.vehicleType]} text-[9px]`} />
                                  {VEHICLE_TYPE_LABELS[r.vehicleType]}
                                </span>
                              ) : (
                                <span className="text-[11px] text-neutral-600 truncate">{r.vehicleBodyType || "N/A"}</span>
                              )}
                            </div>
                          </div>
                        ) : (
                          <span className="text-[11px] text-neutral-400">N/A</span>
                        )}
                      </div>
                      {/* Customer notes - visible at a glance */}
                      {r.notes && r.notes.trim() && (
                        <div className="mt-2 rounded-lg bg-amber-50/80 border border-amber-100 px-3 py-2">
                          <div className="text-[9px] font-semibold text-amber-700 uppercase mb-0.5">Notes</div>
                          <p className="text-[11px] text-neutral-700 line-clamp-2" title={r.notes}>{r.notes}</p>
                        </div>
                      )}
                      {/* Info grid: Date, Branch, Price */}
                      <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                        <div className="bg-neutral-50 rounded-lg py-2 px-1">
                          <div className="text-[9px] text-neutral-400 font-semibold uppercase">Date</div>
                          <div className="text-xs font-bold text-neutral-700 mt-0.5">
                            {(() => { try { return new Date(r.date + "T12:00:00").toLocaleDateString("en-AU", { day: "numeric", month: "short" }); } catch { return r.date; } })()}
                          </div>
                        </div>
                        <div className="bg-neutral-50 rounded-lg py-2 px-1">
                          <div className="text-[9px] text-neutral-400 font-semibold uppercase">Time</div>
                          <div className="text-xs font-bold text-neutral-700 mt-0.5">{r.time}</div>
                          {r.pickupTime && <div className="text-[9px] text-emerald-600 font-medium mt-0.5"><i className="fas fa-arrow-right-from-bracket text-[7px] mr-0.5" />{r.pickupTime}</div>}
                        </div>
                        <div className="bg-neutral-50 rounded-lg py-2 px-1">
                          <div className="text-[9px] text-neutral-400 font-semibold uppercase">Price</div>
                          <div className="text-xs font-bold text-neutral-700 mt-0.5">${r.price}</div>
                        </div>
                      </div>
                      {r.branchName && (
                        <div className="mt-2 flex items-center gap-1.5 text-[11px] text-neutral-500">
                          <i className="fas fa-location-dot text-[9px] text-amber-500" />
                          <span className="font-medium">{r.branchName}</span>
                        </div>
                      )}
                    </div>

                    {/* Action buttons */}
                    {rowActions.length > 0 && (
                      <div className="border-t border-neutral-100 px-4 py-2.5 flex items-center gap-2 bg-neutral-50/50">
                        <button onClick={() => openPreview(r)} className="text-neutral-400 hover:text-neutral-700 transition h-8 w-8 rounded-full flex items-center justify-center" title="Preview">
                          <i className="fas fa-eye text-sm" />
                        </button>
                        {r.status === "Completed" && (
                          <button
                            onClick={() => openJobReportPdfPreview(r.id, r.bookingCode)}
                            className="text-neutral-400 hover:text-neutral-700 transition h-8 w-8 rounded-full flex items-center justify-center"
                            title="View job report PDF"
                          >
                            <i className="fas fa-file-pdf text-sm" />
                          </button>
                        )}
                        <div className="flex-1" />
                        {rowActions.includes("Confirm" as any) && (
                          <button disabled={!!updatingState[r.id]} onClick={() => handleConfirmClick(r)}
                            className={`px-3.5 py-1.5 rounded-full text-xs font-semibold transition inline-flex items-center gap-1.5 ${updatingState[r.id] === "Confirm" ? "bg-emerald-300 text-white" : "bg-gradient-to-r from-emerald-500 to-green-600 text-white shadow-sm"}`}>
                            <i className={`fas ${updatingState[r.id] === "Confirm" ? "fa-spinner fa-spin" : "fa-check-circle"}`} />
                            {updatingState[r.id] === "Confirm" ? "..." : "Confirm"}
                          </button>
                        )}
                        {rowActions.includes("Complete" as any) && (
                          <button disabled={!!updatingState[r.id]} onClick={() => onAction(r.id, "Complete")}
                            className={`px-3.5 py-1.5 rounded-full text-xs font-semibold transition inline-flex items-center gap-1.5 ${updatingState[r.id] === "Complete" ? "bg-indigo-300 text-white" : "bg-gradient-to-r from-indigo-500 to-violet-600 text-white shadow-sm"}`}>
                            <i className={`fas ${updatingState[r.id] === "Complete" ? "fa-spinner fa-spin" : "fa-flag-checkered"}`} />
                            {updatingState[r.id] === "Complete" ? "..." : "Complete"}
                          </button>
                        )}
                        {rowActions.includes("Reassign" as any) && (
                          <button disabled={!!updatingState[r.id]} onClick={() => handleReassignClick(r)}
                            className={`px-3.5 py-1.5 rounded-full text-xs font-semibold transition inline-flex items-center gap-1.5 ${updatingState[r.id] === "Reassign" ? "bg-amber-300 text-white" : "bg-gradient-to-r from-amber-500 to-orange-600 text-white shadow-sm"}`}>
                            <i className={`fas ${updatingState[r.id] === "Reassign" ? "fa-spinner fa-spin" : "fa-user-plus"}`} />
                            {updatingState[r.id] === "Reassign" ? "..." : "Reassign"}
                          </button>
                        )}
                        {rowActions.includes("AssignStaff" as any) && (
                          <button disabled={!!updatingState[r.id]} onClick={() => handleReassignClick(r)}
                            className={`px-3.5 py-1.5 rounded-full text-xs font-semibold transition inline-flex items-center gap-1.5 ${updatingState[r.id] === "AssignStaff" ? "bg-purple-300 text-white" : "bg-gradient-to-r from-purple-500 to-violet-600 text-white shadow-sm"}`}>
                            <i className={`fas ${updatingState[r.id] === "AssignStaff" ? "fa-spinner fa-spin" : "fa-user-plus"}`} />
                            {updatingState[r.id] === "AssignStaff" ? "..." : "Assign"}
                          </button>
                        )}
                        {rowActions.includes("Reschedule" as any) && (
                          <button disabled={!!updatingState[r.id]} onClick={() => handleRescheduleClick(r)}
                            className="px-3.5 py-1.5 rounded-full text-xs font-semibold transition inline-flex items-center gap-1.5 text-white shadow-sm"
                            style={{ backgroundColor: updatingState[r.id] === "Reschedule" ? "#3b82f6" : "#1d4ed8" }}
                            onMouseEnter={(e) => {
                              if (updatingState[r.id] !== "Reschedule") e.currentTarget.style.backgroundColor = "#1e40af";
                            }}
                            onMouseLeave={(e) => {
                              if (updatingState[r.id] !== "Reschedule") e.currentTarget.style.backgroundColor = "#1d4ed8";
                            }}>
                            <i className={`fas ${updatingState[r.id] === "Reschedule" ? "fa-spinner fa-spin" : "fa-calendar-days"}`} />
                            {updatingState[r.id] === "Reschedule" ? "..." : "Reschedule"}
                          </button>
                        )}
                        {rowActions.includes("Cancel" as any) && (
                          <button disabled={!!updatingState[r.id]} onClick={() => onAction(r.id, "Cancel")}
                            className={`px-3.5 py-1.5 rounded-full text-xs font-semibold transition inline-flex items-center gap-1.5 ${updatingState[r.id] === "Cancel" ? "bg-rose-300 text-white" : "bg-gradient-to-r from-rose-500 to-red-600 text-white shadow-sm"}`}>
                            <i className={`fas ${updatingState[r.id] === "Cancel" ? "fa-spinner fa-spin" : "fa-ban"}`} />
                            {updatingState[r.id] === "Cancel" ? "..." : "Cancel"}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* ═══ DESKTOP TABLE VIEW ═══ */}
            <div className="hidden md:block bg-white rounded-2xl border border-neutral-200 shadow-sm overflow-hidden">
              <div className="relative overflow-x-auto">
                <table className="min-w-[820px] w-full text-left text-sm text-neutral-600">
                  <thead className="bg-neutral-50/90 backdrop-blur text-neutral-800 font-semibold border-b border-neutral-100 sticky top-0 z-10">
                  <tr>
                    <th className="p-3 pl-4">Client &amp; Service</th>
                    <th className="p-3">Date &amp; Time</th>
                    <th className="p-3 min-w-[120px]">Vehicle</th>
                    <th className="p-3">Branch</th>
                    {showStaffColumn && <th className="p-3 min-w-[90px]">Staff</th>}
                    <th className="p-3 text-right pr-4">Price</th>
                    <th className="p-3 text-right pr-4">Actions</th>
                  </tr>
                  </thead>
                  <tbody>
                  {loading && (
                    <tr>
                      <td className="p-6 text-neutral-500" colSpan={showStaffColumn ? 7 : 6}>Loading...</td>
                    </tr>
                  )}
                  {!loading && error && (
                    <tr>
                      <td className="p-6 text-rose-600" colSpan={showStaffColumn ? 7 : 6}>{error}</td>
                    </tr>
                  )}
                  {!loading && rows.length === 0 && (
                    <tr>
                      <td className="p-6 text-neutral-500" colSpan={showStaffColumn ? 7 : 6}>No bookings.</td>
                    </tr>
                  )}
                  {!loading &&
                    rows.map((r) => {
                      const initials = r.client
                        .split(" ")
                        .filter(Boolean)
                        .slice(0, 2)
                        .map((s) => s[0]?.toUpperCase() || "")
                        .join("");
                      const rowActions = getAllowedActions(r.status, r);
                      const statusColor = getStatusColor(normalizeBookingStatus(r.status));
                      const statusLabel = getStatusLabel(normalizeBookingStatus(r.status));
                      return (
                      <tr key={r.id} className="hover:bg-neutral-50 transition">
                        <td className="p-3 pl-4 align-middle">
                          <div className="flex items-center gap-3">
                            <div className="w-10 h-10 flex-shrink-0 bg-neutral-900 text-white flex items-center justify-center text-sm font-bold shadow-sm" style={{ borderRadius: "50%" }}>
                              {initials || <i className="fas fa-user" />}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <div>
                                  <div className="font-semibold text-neutral-800">{r.client}</div>
                                  {r.bookingCode && (
                                    <div className="text-xs text-neutral-500 font-mono mt-0.5">{r.bookingCode}</div>
                                  )}
                                </div>
                                <button
                                  aria-label="Preview"
                                  title="Preview"
                                  onClick={() => openPreview(r)}
                                  className="sm:hidden text-neutral-400 hover:text-neutral-900 transition transform hover:scale-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 rounded-full h-7 w-7 inline-flex items-center justify-center"
                                >
                                  <i className="fas fa-eye text-[13px]" />
                                </button>
                              </div>
                              {/* Service List Display */}
                              <div className="mt-1.5 space-y-1.5">
                              {r.services && r.services.length > 0 ? (
                                <>
                                  {r.services.map((svc, idx) => {
                                    // Determine approval status badge
                                    const approvalStatus = (svc.approvalStatus || "pending") as "pending" | "accepted" | "rejected" | "needs_assignment";
                                    const tableBadgeMap = {
                                      pending: { bg: "bg-amber-100", text: "text-amber-700", icon: "fa-clock", label: "Pending" },
                                      accepted: { bg: "bg-emerald-100", text: "text-emerald-700", icon: "fa-check", label: "Accepted" },
                                      rejected: { bg: "bg-rose-100", text: "text-rose-700", icon: "fa-times", label: "Rejected" },
                                      needs_assignment: { bg: "bg-purple-100", text: "text-purple-700", icon: "fa-user-plus", label: "Not Assigned Yet" },
                                    };
                                    const approvalBadge = tableBadgeMap[approvalStatus] || tableBadgeMap.pending;
                                    const serviceKey = String(svc.id || svc.serviceId || svc.name || "");
                                    const serviceTasks = (r.tasks || []).filter((t) => {
                                      if (!t) return false;
                                      if (t.serviceId && serviceKey) return String(t.serviceId) === serviceKey;
                                      if (t.serviceName && svc.name) return String(t.serviceName) === String(svc.name);
                                      return false;
                                    });
                                    const serviceDone = serviceTasks.filter((t) => t.done).length;
                                    const serviceTotal = serviceTasks.length;
                                    
                                    return (
                                      <div key={idx} className="flex items-center justify-between py-1 px-2 rounded-lg bg-neutral-50 border border-neutral-100">
                                        <div className="flex items-center gap-2 min-w-0 flex-1">
                                          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-white border border-neutral-200 shadow-sm w-[150px] min-w-0">
                                            <i className="fas fa-spa text-[10px] text-neutral-600" />
                                            <span
                                              className="text-xs font-semibold text-neutral-800 truncate whitespace-nowrap"
                                              title={svc.name || "Service"}
                                            >
                                              {svc.name || "Service"}
                                            </span>
                                          </span>
                                          {serviceTotal > 0 && (
                                            <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-blue-50 text-blue-700 border border-blue-200 shrink-0">
                                              {serviceDone}/{serviceTotal}
                                            </span>
                                          )}
                                        </div>
                                        {/* Show approval status badge for multi-service bookings or pending with needs_assignment */}
                                        {(r.status === "AwaitingStaffApproval" || r.status === "PartiallyApproved" || r.status === "StaffRejected" || r.status === "Pending") && (
                                          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold shrink-0 ml-2 ${approvalBadge.bg} ${approvalBadge.text}`}>
                                            <i className={`fas ${approvalBadge.icon} text-[8px]`} />
                                            {approvalBadge.label}
                                          </span>
                                        )}
                                      </div>
                                    );
                                  })}
                                </>
                              ) : (
                                <div className="flex items-center gap-2 py-1 px-2 rounded-lg bg-neutral-50 border border-neutral-100">
                                  <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-white border border-neutral-200 shadow-sm w-[150px] min-w-0">
                                    <i className="fas fa-spa text-[10px] text-neutral-600" />
                                    <span
                                      className="text-xs font-semibold text-neutral-800 truncate whitespace-nowrap"
                                      title={r.serviceName || "Service"}
                                    >
                                      {r.serviceName || "Service"}
                                    </span>
                                  </span>
                                  {r.tasks && r.tasks.length > 0 && (
                                    <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-blue-50 text-blue-700 border border-blue-200 shrink-0">
                                      {r.tasks.filter((t) => t.done).length}/{r.tasks.length}
                                    </span>
                                  )}
                                </div>
                              )}
                            </div>
                            </div>
                          </div>
                        </td>
                        <td className="p-3 align-middle">
                          <div className="flex flex-col gap-1 font-medium text-neutral-700 text-sm whitespace-nowrap">
                            <i className="far fa-calendar text-neutral-400 text-[11px]" />
                            {(() => { try { return new Date(r.date + "T12:00:00").toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short", year: "numeric" }); } catch { return r.date; } })()}
                          </div>
                          <div className="flex items-center gap-3 mt-1">
                            <span className="inline-flex items-center gap-1 text-xs text-neutral-600 bg-neutral-100 px-2 py-0.5 rounded-md font-medium">
                              <i className="fas fa-arrow-right-to-bracket text-[9px] text-amber-500" />
                              {r.time}
                            </span>
                            {r.pickupTime && (
                              <span className="inline-flex items-center gap-1 text-xs text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-md font-medium">
                                <i className="fas fa-arrow-right-from-bracket text-[9px] text-emerald-500" />
                                {r.pickupTime}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="p-3 align-middle">
                          <div className="min-w-[110px] max-w-[140px] rounded-lg bg-neutral-50 border border-neutral-100 px-2 py-1.5">
                            {[r.vehicleMake, r.vehicleModel, r.vehicleType, r.vehicleBodyType].filter(Boolean).length > 0 ? (
                              <div className="space-y-1.5 text-[11px]">
                                <div className="flex items-baseline gap-1.5">
                                  <span className="text-[9px] font-semibold text-neutral-400 uppercase w-12 shrink-0">Make</span>
                                  <span className="font-semibold text-neutral-800 truncate" title={r.vehicleMake || "N/A"}>{r.vehicleMake || "N/A"}</span>
                                </div>
                                <div className="flex items-baseline gap-1.5">
                                  <span className="text-[9px] font-semibold text-neutral-400 uppercase w-12 shrink-0">Model</span>
                                  <span className="text-neutral-700 truncate" title={r.vehicleModel || "N/A"}>{r.vehicleModel || "N/A"}</span>
                                </div>
                                <div className="flex items-baseline gap-1.5">
                                  <span className="text-[9px] font-semibold text-neutral-400 uppercase w-12 shrink-0">Type</span>
                                  {r.vehicleType && isVehicleType(r.vehicleType) ? (
                                    <span
                                      className="inline-flex items-center gap-1 font-semibold text-amber-800 truncate"
                                      title={VEHICLE_TYPE_LABELS[r.vehicleType]}
                                    >
                                      <i className={`${VEHICLE_TYPE_ICONS[r.vehicleType]} text-[9px]`} />
                                      <span className="truncate">{VEHICLE_TYPE_LABELS[r.vehicleType]}</span>
                                    </span>
                                  ) : (
                                    <span className="text-neutral-600 truncate" title={r.vehicleBodyType || "N/A"}>{r.vehicleBodyType || "N/A"}</span>
                                  )}
                                </div>
                              </div>
                            ) : (
                              <span className="text-[11px] text-neutral-400">N/A</span>
                            )}
                          </div>
                        </td>
                        <td className="p-3 align-middle">{r.branchName || "-"}</td>
                        {showStaffColumn && (
                        <td className="p-3 align-middle">
                          {(() => {
                            const staffNames = r.services && r.services.length > 0
                              ? [...new Set(r.services.map(s => s.staffName).filter(Boolean).filter(n => !["Any Available", "Any Staff", "Not Assigned Yet"].includes(String(n))))]
                              : (r.staffName && !["Any Available", "Any Staff", "Not Assigned Yet"].includes(String(r.staffName))) ? [r.staffName] : [];
                            return staffNames.length > 0 ? (
                              <div className="max-w-[120px] space-y-0.5" title={staffNames.join(", ")}>
                                {staffNames.map((name, idx) => (
                                  <div key={`${r.id}-staff-${idx}`} className="flex items-center gap-1 text-xs font-medium text-neutral-700 truncate">
                                    <i className="fas fa-user text-neutral-400 text-[9px] shrink-0" />
                                    <span className="truncate">{String(name)}</span>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <span className="text-neutral-400 text-sm">—</span>
                            );
                          })()}
                        </td>
                        )}
                        <td className="p-3 align-middle text-right pr-4">
                          <span className="inline-flex items-center gap-1 font-bold text-neutral-800">
                            <i className="fas fa-dollar-sign text-neutral-400" />
                            {r.price}
                          </span>
                        </td>
                        <td className="p-3 align-middle text-right pr-4">
                          <div className="inline-flex items-center gap-2 justify-end bg-neutral-100/60 rounded-full px-2 py-1">
                            {/* Status Badge */}
                            <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${statusColor}`}>
                              {statusLabel}
                            </span>
                            <button
                              aria-label="Preview"
                              title="Preview"
                              onClick={() => openPreview(r)}
                              className="hidden sm:inline-flex text-neutral-400 hover:text-neutral-900 transition transform hover:scale-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 rounded-full h-8 w-8 items-center justify-center"
                            >
                              <i className="fas fa-eye" />
                            </button>
                            {r.status === "Completed" && (
                              <button
                                aria-label="View job report PDF"
                                title="View job report PDF"
                                onClick={() => openJobReportPdfPreview(r.id, r.bookingCode)}
                                className="hidden sm:inline-flex text-neutral-400 hover:text-neutral-900 transition transform hover:scale-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 rounded-full h-8 w-8 items-center justify-center"
                              >
                                <i className="fas fa-file-pdf" />
                              </button>
                            )}
                            {rowActions.length > 0 && (
                              <>
                              {rowActions.includes("Confirm" as any) && (
                                <button
                                  disabled={!!updatingState[r.id]}
                                  onClick={() => handleConfirmClick(r)}
                                  className={`px-3 py-1.5 rounded-full text-xs font-semibold transition inline-flex items-center gap-1 ${updatingState[r.id] === "Confirm" ? "bg-emerald-300 text-white" : "bg-gradient-to-r from-emerald-500 to-green-600 hover:from-emerald-600 hover:to-green-700 text-white shadow-sm"}`}
                                  aria-busy={!!updatingState[r.id]}
                                >
                                  {updatingState[r.id] === "Confirm" ? <i className="fas fa-spinner fa-spin" /> : <i className="fas fa-check-circle" />}
                                  {updatingState[r.id] === "Confirm" ? "Confirming..." : "Confirm"}
                                </button>
                              )}
                              {rowActions.includes("Complete" as any) && (
                                <button
                                  disabled={!!updatingState[r.id]}
                                  onClick={() => onAction(r.id, "Complete")}
                                  className={`px-3 py-1.5 rounded-full text-xs font-semibold transition inline-flex items-center gap-1 ${updatingState[r.id] === "Complete" ? "bg-indigo-300 text-white" : "bg-gradient-to-r from-indigo-500 to-violet-600 hover:from-indigo-600 hover:to-violet-700 text-white shadow-sm"}`}
                                  aria-busy={!!updatingState[r.id]}
                                >
                                  {updatingState[r.id] === "Complete" ? <i className="fas fa-spinner fa-spin" /> : <i className="fas fa-flag-checkered" />}
                                  {updatingState[r.id] === "Complete" ? "Completing..." : "Complete"}
                                </button>
                              )}
                              {rowActions.includes("Reassign" as any) && (
                                <button
                                  disabled={!!updatingState[r.id]}
                                  onClick={() => handleReassignClick(r)}
                                  className={`px-3 py-1.5 rounded-full text-xs font-semibold transition inline-flex items-center gap-1 ${updatingState[r.id] === "Reassign" ? "bg-amber-300 text-white" : "bg-gradient-to-r from-amber-500 to-orange-600 hover:from-amber-600 hover:to-orange-700 text-white shadow-sm"}`}
                                  aria-busy={!!updatingState[r.id]}
                                >
                                  {updatingState[r.id] === "Reassign" ? <i className="fas fa-spinner fa-spin" /> : <i className="fas fa-user-plus" />}
                                  {updatingState[r.id] === "Reassign" ? "Reassigning..." : "Reassign"}
                                </button>
                              )}
                              {rowActions.includes("AssignStaff" as any) && (
                                <button
                                  disabled={!!updatingState[r.id]}
                                  onClick={() => handleReassignClick(r)}
                                  className={`px-3 py-1.5 rounded-full text-xs font-semibold transition inline-flex items-center gap-1 ${updatingState[r.id] === "AssignStaff" ? "bg-purple-300 text-white" : "bg-gradient-to-r from-purple-500 to-violet-600 hover:from-purple-600 hover:to-violet-700 text-white shadow-sm"}`}
                                  aria-busy={!!updatingState[r.id]}
                                >
                                  {updatingState[r.id] === "AssignStaff" ? <i className="fas fa-spinner fa-spin" /> : <i className="fas fa-user-plus" />}
                                  {updatingState[r.id] === "AssignStaff" ? "Assigning..." : "Assign Staff"}
                                </button>
                              )}
                              {rowActions.includes("Reschedule" as any) && (
                                // Icon-only on desktop (solid, dark blue so
                                // the button reads clearly on white rows).
                                // Mobile card and the preview side-panel keep
                                // the full "Reschedule" label.
                                <button
                                  disabled={!!updatingState[r.id]}
                                  onClick={() => handleRescheduleClick(r)}
                                  aria-label="Reschedule booking"
                                  title="Reschedule — change date & time"
                                  className="h-8 w-8 rounded-full inline-flex items-center justify-center transition shadow-sm text-white"
                                  style={{ backgroundColor: updatingState[r.id] === "Reschedule" ? "#3b82f6" : "#1d4ed8" }}
                                  onMouseEnter={(e) => {
                                    if (updatingState[r.id] !== "Reschedule") e.currentTarget.style.backgroundColor = "#1e40af";
                                  }}
                                  onMouseLeave={(e) => {
                                    if (updatingState[r.id] !== "Reschedule") e.currentTarget.style.backgroundColor = "#1d4ed8";
                                  }}
                                  aria-busy={!!updatingState[r.id]}
                                >
                                  <i className={`fas ${updatingState[r.id] === "Reschedule" ? "fa-spinner fa-spin" : "fa-calendar-days"} text-[13px]`} />
                                </button>
                              )}
                              {rowActions.includes("Cancel" as any) && (
                                // Icon-only on desktop to match Reschedule and
                                // keep the actions column compact. Mobile and
                                // preview side-panel keep the full label.
                                <button
                                  disabled={!!updatingState[r.id]}
                                  onClick={() => onAction(r.id, "Cancel")}
                                  aria-label="Cancel booking"
                                  title="Cancel booking"
                                  className={`h-8 w-8 rounded-full inline-flex items-center justify-center transition shadow-sm ${updatingState[r.id] === "Cancel" ? "bg-rose-400 text-white" : "bg-rose-600 hover:bg-rose-700 text-white"}`}
                                  aria-busy={!!updatingState[r.id]}
                                >
                                  <i className={`fas ${updatingState[r.id] === "Cancel" ? "fa-spinner fa-spin" : "fa-ban"} text-[13px]`} />
                                </button>
                              )}
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    )})}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </main>
      </div>

      {/* Staff Assignment Modal */}
      {staffAssignModalOpen && bookingToConfirm && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-fade-in"
            onClick={(e) => {
              if (!updatingState[bookingToConfirm.id]) {
                setStaffAssignModalOpen(false);
              }
            }}
          />

          {/* Modal */}
          <div 
            className="relative bg-white rounded-2xl shadow-2xl max-w-md w-full animate-scale-in overflow-hidden max-h-[90vh] flex flex-col z-10"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="bg-gradient-to-r from-emerald-500 to-green-600 p-4 shrink-0">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-white/20 backdrop-blur-sm rounded-xl flex items-center justify-center">
                  <i className="fas fa-user-plus text-white text-base"></i>
                </div>
                <div>
                  <h3 className="text-lg font-bold text-white">Assign Staff Member</h3>
                  <p className="text-white/80 text-xs">Select a staff member to confirm booking</p>
                </div>
              </div>
            </div>

            {/* Content */}
            <div className="p-4 overflow-y-auto flex-1">
              {/* Booking Details */}
              <div className="mb-4 p-3 bg-neutral-50 rounded-lg">
                <div className="flex items-center gap-2.5 mb-2.5">
                  <div className="w-9 h-9 rounded-full bg-neutral-900 text-white flex items-center justify-center text-xs font-bold">
                    {(bookingToConfirm.client || "?").split(" ").map(s => s[0]).slice(0,2).join("")}
                  </div>
                  <div>
                    <p className="font-semibold text-sm text-neutral-900">{bookingToConfirm.client}</p>
                    <p className="text-[11px] text-neutral-500 truncate max-w-[210px]">{bookingToConfirm.serviceName || "Service"}</p>
                  </div>
                </div>
                <div className="flex items-center gap-4 text-xs text-neutral-600">
                  <span><i className="far fa-calendar mr-1"></i>{bookingToConfirm.date}</span>
                  <span><i className="far fa-clock mr-1"></i>{bookingToConfirm.time}</span>
                  {bookingToConfirm.branchName && <span><i className="fas fa-store mr-1"></i>{bookingToConfirm.branchName}</span>}
                </div>
                {bookingToConfirm.notes && bookingToConfirm.notes.trim() && (
                  <div className="mt-2.5 p-2.5 bg-amber-50 rounded-lg border border-amber-200">
                    <div className="flex items-start gap-2">
                      <i className="fas fa-sticky-note text-amber-600 mt-0.5"></i>
                      <div className="flex-1">
                        <p className="text-xs font-semibold text-amber-900 mb-1">Customer Notes:</p>
                        <p className="text-xs text-amber-800 whitespace-pre-wrap">{bookingToConfirm.notes}</p>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Staff Selection */}
              <div>
                {loadingStaff ? (
                  <div className="flex items-center justify-center py-8">
                    <div className="w-8 h-8 border-3 border-emerald-200 border-t-emerald-600 rounded-full animate-spin"></div>
                    <span className="ml-3 text-neutral-600">Loading staff...</span>
                  </div>
                ) : (
                  <>
                    {/* Multiple Services - Show staff selection for each */}
                    {Array.isArray(bookingToConfirm.services) && bookingToConfirm.services.length > 0 ? (
                      <div className="space-y-3 max-h-72 overflow-y-auto">
                        {bookingToConfirm.services
                          .map((service) => {
                            const serviceKey = String(service.id || service.serviceId || service.name);
                            const serviceStaff = availableStaffPerService[serviceKey] || [];
                            const selectedStaff = selectedStaffPerService[serviceKey];
                            
                            return (
                              <div key={serviceKey} className="border-2 border-purple-200 rounded-xl p-3 bg-purple-50/50">
                                <div className="mb-2 flex items-center gap-2">
                                  <i className="fas fa-spa text-purple-600"></i>
                                  <h4 className="font-bold text-neutral-800 text-sm truncate max-w-[190px]" title={service.name}>{service.name}</h4>
                                  <span className="text-xs text-neutral-500 ml-auto">{service.duration} min</span>
                                </div>
                                
                                {serviceStaff.length === 0 ? (
                                  <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-amber-800 text-xs">
                                    <i className="fas fa-exclamation-triangle mr-2"></i>
                                    No qualified staff available for this service
                                  </div>
                                ) : (
                                  <div className="space-y-1.5">
                                    {serviceStaff.map((staff) => (
                                      <button
                                        key={staff.id}
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setSelectedStaffPerService(prev => ({
                                            ...prev,
                                            [serviceKey]: staff.id
                                          }));
                                        }}
                                        className={`w-full text-left p-1.5 rounded-lg border-2 transition-all ${
                                          selectedStaff === staff.id
                                            ? "border-emerald-500 bg-emerald-50 shadow-sm"
                                            : "border-neutral-200 hover:border-emerald-300 hover:bg-white"
                                        }`}
                                      >
                                        <div className="flex items-center gap-2">
                                          <div className={`w-7 h-7 rounded-full overflow-hidden flex-shrink-0 border-2 ${
                                            selectedStaff === staff.id ? "border-emerald-500" : "border-neutral-200"
                                          }`}>
                                            <img
                                              src={`https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(staff.avatar || staff.name)}`}
                                              alt={staff.name}
                                              className="w-full h-full object-cover"
                                            />
                                          </div>
                                          <div className="flex-1">
                                            <p className={`font-semibold text-xs ${
                                              selectedStaff === staff.id ? "text-emerald-900" : "text-neutral-800"
                                            }`}>
                                              {staff.name}
                                            </p>
                                          </div>
                                          {selectedStaff === staff.id && (
                                            <i className="fas fa-check-circle text-emerald-500"></i>
                                          )}
                                        </div>
                                      </button>
                                    ))}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                      </div>
                    ) : (
                      /* Single Service - Original UI */
                      <>
                        <label className="block text-sm font-semibold text-neutral-700 mb-3">
                          <i className="fas fa-user-tie text-emerald-600 mr-2"></i>
                          Select Staff Member
                        </label>
                        {availableStaff.length === 0 ? (
                          <div className="p-4 bg-amber-50 border border-amber-200 rounded-lg text-amber-800 text-sm">
                            <i className="fas fa-exclamation-triangle mr-2"></i>
                            No available staff. Staff must work at this branch on the booking date and not be on leave.
                          </div>
                        ) : (
                          <div className="space-y-2 max-h-64 overflow-y-auto">
                            {availableStaff.map((staff) => (
                              <button
                                key={staff.id}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setSelectedStaffId(staff.id);
                                }}
                                className={`w-full text-left p-3 rounded-lg border-2 transition-all ${
                                  selectedStaffId === staff.id
                                    ? "border-emerald-500 bg-emerald-50 shadow-sm"
                                    : "border-neutral-200 hover:border-emerald-300 hover:bg-neutral-50"
                                }`}
                              >
                                <div className="flex items-center gap-3">
                                  <div className={`w-10 h-10 rounded-full overflow-hidden flex-shrink-0 border-2 ${
                                    selectedStaffId === staff.id
                                      ? "border-emerald-500"
                                      : "border-neutral-200"
                                  }`}>
                                    <img
                                      src={`https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(staff.avatar || staff.name)}`}
                                      alt={staff.name}
                                      className="w-full h-full object-cover"
                                    />
                                  </div>
                                  <div className="flex-1">
                                    <p className={`font-semibold ${
                                      selectedStaffId === staff.id ? "text-emerald-900" : "text-neutral-800"
                                    }`}>
                                      {staff.name}
                                    </p>
                                  </div>
                                  {selectedStaffId === staff.id && (
                                    <i className="fas fa-check-circle text-emerald-500 text-lg"></i>
                                  )}
                                </div>
                              </button>
                            ))}
                          </div>
                        )}
                      </>
                    )}
                  </>
                )}
              </div>
            </div>

            {/* Footer */}
            <div className="bg-neutral-50 px-4 py-3 flex gap-2.5 justify-end border-t border-neutral-200 shrink-0">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setStaffAssignModalOpen(false);
                }}
                disabled={!!updatingState[bookingToConfirm.id]}
                className="px-4 py-2.5 rounded-lg text-neutral-700 hover:bg-neutral-200 font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-sm"
              >
                Cancel
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  confirmWithStaffAssignment();
                }}
                disabled={(() => {
                  if (!!updatingState[bookingToConfirm.id]) return true;
                  
                  // Check if multi-service booking
                  const hasMultipleServices = Array.isArray(bookingToConfirm.services) && bookingToConfirm.services.length > 0;
                  
                  if (hasMultipleServices) {
                    // Check if all services have staff assigned
                    return !bookingToConfirm.services!.every(s => {
                      const serviceKey = String(s.id || s.serviceId || s.name);
                      return selectedStaffPerService[serviceKey];
                    });
                  } else {
                    // Single service
                    return !selectedStaffId;
                  }
                })()}
                className="px-5 py-2.5 rounded-lg bg-gradient-to-r from-emerald-500 to-green-600 hover:from-emerald-600 hover:to-green-700 text-white font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 text-sm shadow-lg shadow-emerald-200"
              >
                {updatingState[bookingToConfirm.id] === "Confirm" ? (
                  <>
                    <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
                    <span>Confirming...</span>
                  </>
                ) : (
                  <>
                    <i className="fas fa-check-circle"></i>
                    <span>Confirm Booking</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reassignment Modal for StaffRejected bookings */}
      {reassignModalOpen && bookingToReassign && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-fade-in"
            onClick={(e) => {
              if (!updatingState[bookingToReassign.id]) {
                setReassignModalOpen(false);
              }
            }}
          />

          {/* Modal */}
          <div 
            className="relative bg-white rounded-2xl shadow-2xl max-w-md w-full animate-scale-in overflow-hidden max-h-[90vh] flex flex-col z-10"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="bg-gradient-to-r from-amber-500 to-orange-600 p-5 shrink-0">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 bg-white/20 backdrop-blur-sm rounded-xl flex items-center justify-center">
                  <i className="fas fa-user-plus text-white text-xl"></i>
                </div>
                <div>
                  <h3 className="text-lg font-bold text-white">Reassign Booking</h3>
                  <p className="text-white/80 text-sm">Select a new staff member</p>
                </div>
              </div>
            </div>

            {/* Content - scrollable */}
            <div className="p-6 overflow-y-auto flex-1">
              {/* Rejection Info Alert */}
              {bookingToReassign.rejectionReason && (
                <div className="mb-4 p-4 bg-rose-50 border border-rose-200 rounded-lg">
                  <div className="flex items-start gap-3">
                    <div className="w-8 h-8 bg-rose-100 rounded-full flex items-center justify-center shrink-0">
                      <i className="fas fa-exclamation-circle text-rose-600 text-sm"></i>
                    </div>
                    <div>
                      <p className="font-semibold text-rose-800 text-sm">
                        Rejected by {bookingToReassign.rejectedByStaffName || "Staff"}
                      </p>
                      <p className="text-rose-700 text-sm mt-1">
                        "{bookingToReassign.rejectionReason}"
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* Booking Details */}
              <div className="mb-6 p-4 bg-neutral-50 rounded-lg">
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-10 h-10 rounded-full bg-neutral-900 text-white flex items-center justify-center text-sm font-bold">
                    {(bookingToReassign.client || "?").split(" ").map(s => s[0]).slice(0,2).join("")}
                  </div>
                  <div>
                    <p className="font-semibold text-neutral-900">{bookingToReassign.client}</p>
                    <p className="text-xs text-neutral-500">{bookingToReassign.serviceName || "Service"}</p>
                  </div>
                </div>
                <div className="flex items-center gap-4 text-xs text-neutral-600">
                  <span><i className="far fa-calendar mr-1"></i>{bookingToReassign.date}</span>
                  <span><i className="far fa-clock mr-1"></i>{bookingToReassign.time}</span>
                  {bookingToReassign.branchName && <span><i className="fas fa-store mr-1"></i>{bookingToReassign.branchName}</span>}
                </div>
                {bookingToReassign.notes && bookingToReassign.notes.trim() && (
                  <div className="mt-3 p-3 bg-amber-50 rounded-lg border border-amber-200">
                    <div className="flex items-start gap-2">
                      <i className="fas fa-sticky-note text-amber-600 mt-0.5"></i>
                      <div className="flex-1">
                        <p className="text-xs font-semibold text-amber-900 mb-1">Customer Notes:</p>
                        <p className="text-xs text-amber-800 whitespace-pre-wrap">{bookingToReassign.notes}</p>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Staff Selection */}
              <div>
                {loadingStaff ? (
                  <div className="flex items-center justify-center py-8">
                    <div className="w-8 h-8 border-3 border-amber-200 border-t-amber-600 rounded-full animate-spin"></div>
                    <span className="ml-3 text-neutral-600">Loading available staff...</span>
                  </div>
                ) : (
                  <>
                    {/* Multiple Services */}
                    {Array.isArray(bookingToReassign.services) && bookingToReassign.services.length > 0 ? (
                      <div className="space-y-4 max-h-64 overflow-y-auto">
                        {/* Show already assigned services (read-only info) */}
                        {bookingToReassign.services.filter(s => 
                          (s.approvalStatus === "pending" || s.approvalStatus === "accepted") && 
                          s.staffId && 
                          s.staffName && 
                          s.staffName !== "Any Available" && 
                          s.staffName !== "Any Staff" &&
                          s.staffName !== "Not Assigned Yet"
                        ).length > 0 && (
                          <div className="mb-4">
                            <p className="text-xs font-semibold text-neutral-500 uppercase tracking-wide mb-2">
                              <i className="fas fa-check-circle text-emerald-500 mr-1"></i>
                              Already Assigned (Customer Selected)
                            </p>
                            <div className="space-y-2">
                              {bookingToReassign.services.filter(s => 
                                (s.approvalStatus === "pending" || s.approvalStatus === "accepted") && 
                                s.staffId && 
                                s.staffName && 
                                s.staffName !== "Any Available" && 
                                s.staffName !== "Any Staff" &&
                                s.staffName !== "Not Assigned Yet"
                              ).map((service) => (
                                <div key={String(service.id || service.name)} className="flex items-center justify-between p-3 rounded-lg bg-emerald-50 border border-emerald-200">
                                  <div className="flex items-center gap-2">
                                    <i className="fas fa-spa text-emerald-600 text-sm"></i>
                                    <span className="font-medium text-neutral-800">{service.name}</span>
                                  </div>
                                  <div className="flex items-center gap-2">
                                    <span className="text-xs text-neutral-500">{service.staffName}</span>
                                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 text-xs font-semibold">
                                      <i className="fas fa-check text-[8px]"></i>
                                      {service.approvalStatus === "accepted" ? "Accepted" : "Awaiting"}
                                    </span>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                        
                        {/* Show rejected services or services needing assignment */}
                        {bookingToReassign.services.filter(s => 
                          s.approvalStatus === "rejected" || 
                          s.approvalStatus === "needs_assignment" ||
                          (!s.staffId || s.staffName === "Any Available" || s.staffName === "Any Staff" || s.staffName === "Not Assigned Yet")
                        ).length > 0 && (
                          <div>
                            <p className="text-xs font-semibold text-neutral-500 uppercase tracking-wide mb-2">
                              <i className="fas fa-user-plus text-amber-500 mr-1"></i>
                              Select New Staff For
                            </p>
                            {bookingToReassign.services
                              .filter(s => 
                                s.approvalStatus === "rejected" || 
                                s.approvalStatus === "needs_assignment" ||
                                (!s.staffId || s.staffName === "Any Available" || s.staffName === "Any Staff" || s.staffName === "Not Assigned Yet")
                              )
                              .map((service) => {
                                const serviceKey = String(service.id || service.serviceId || service.name);
                                const serviceStaff = availableStaffPerService[serviceKey] || [];
                                const selectedStaff = selectedStaffPerService[serviceKey];
                                
                                return (
                                  <div key={serviceKey} className="border-2 border-amber-200 rounded-xl p-4 bg-amber-50/50 mb-3">
                                    <div className="mb-3 flex items-center gap-2">
                                      <i className="fas fa-spa text-amber-600"></i>
                                      <h4 className="font-bold text-neutral-800">{service.name}</h4>
                                      <span className="text-xs text-neutral-500 ml-auto">{service.duration} min</span>
                                      {service.approvalStatus === "rejected" && (
                                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-rose-100 text-rose-700 text-xs font-semibold">
                                          <i className="fas fa-times text-[8px]"></i>
                                          Rejected
                                        </span>
                                      )}
                                      {(service.approvalStatus === "needs_assignment" || !service.staffId || service.staffName === "Any Available" || service.staffName === "Any Staff" || service.staffName === "Not Assigned Yet") && service.approvalStatus !== "rejected" && (
                                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-purple-100 text-purple-700 text-xs font-semibold">
                                          <i className="fas fa-user-clock text-[8px]"></i>
                                          Not Assigned Yet
                                        </span>
                                      )}
                                    </div>
                                    
                                    {serviceStaff.length === 0 ? (
                                      <div className="p-3 bg-rose-50 border border-rose-200 rounded-lg text-rose-800 text-xs">
                                        <i className="fas fa-exclamation-triangle mr-2"></i>
                                        No other qualified staff available
                                      </div>
                                    ) : (
                                      <div className="space-y-2">
                                        {serviceStaff.map((staff) => (
                                          <button
                                            key={staff.id}
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              setSelectedStaffPerService(prev => ({
                                                ...prev,
                                                [serviceKey]: staff.id
                                              }));
                                            }}
                                            className={`w-full text-left p-2 rounded-lg border-2 transition-all ${
                                              selectedStaff === staff.id
                                                ? "border-amber-500 bg-amber-50 shadow-sm"
                                                : "border-neutral-200 hover:border-amber-300 hover:bg-white"
                                            }`}
                                          >
                                            <div className="flex items-center gap-2">
                                              <div className={`w-8 h-8 rounded-full overflow-hidden flex-shrink-0 border-2 ${
                                                selectedStaff === staff.id ? "border-amber-500" : "border-neutral-200"
                                              }`}>
                                                <img
                                                  src={`https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(staff.avatar || staff.name)}`}
                                                  alt={staff.name}
                                                  className="w-full h-full object-cover"
                                                />
                                              </div>
                                              <div className="flex-1">
                                                <p className={`font-semibold text-sm ${
                                                  selectedStaff === staff.id ? "text-amber-900" : "text-neutral-800"
                                                }`}>
                                                  {staff.name}
                                                </p>
                                              </div>
                                              {selectedStaff === staff.id && (
                                                <i className="fas fa-check-circle text-amber-500"></i>
                                              )}
                                            </div>
                                          </button>
                                        ))}
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                          </div>
                        )}
                      </div>
                    ) : (
                      /* Single Service */
                      <>
                        <label className="block text-sm font-semibold text-neutral-700 mb-3">
                          <i className="fas fa-user-tie text-amber-600 mr-2"></i>
                          Select New Staff Member
                        </label>
                        {availableStaff.length === 0 ? (
                          <div className="p-4 bg-rose-50 border border-rose-200 rounded-lg text-rose-800 text-sm">
                            <i className="fas fa-exclamation-triangle mr-2"></i>
                            No other available staff members found for this booking.
                          </div>
                        ) : (
                          <div className="space-y-2 max-h-64 overflow-y-auto">
                            {availableStaff.map((staff) => (
                              <button
                                key={staff.id}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setSelectedStaffId(staff.id);
                                }}
                                className={`w-full text-left p-3 rounded-lg border-2 transition-all ${
                                  selectedStaffId === staff.id
                                    ? "border-amber-500 bg-amber-50 shadow-sm"
                                    : "border-neutral-200 hover:border-amber-300 hover:bg-neutral-50"
                                }`}
                              >
                                <div className="flex items-center gap-3">
                                  <div className={`w-10 h-10 rounded-full overflow-hidden flex-shrink-0 border-2 ${
                                    selectedStaffId === staff.id
                                      ? "border-amber-500"
                                      : "border-neutral-200"
                                  }`}>
                                    <img
                                      src={`https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(staff.avatar || staff.name)}`}
                                      alt={staff.name}
                                      className="w-full h-full object-cover"
                                    />
                                  </div>
                                  <div className="flex-1">
                                    <p className={`font-semibold ${
                                      selectedStaffId === staff.id ? "text-amber-900" : "text-neutral-800"
                                    }`}>
                                      {staff.name}
                                    </p>
                                  </div>
                                  {selectedStaffId === staff.id && (
                                    <i className="fas fa-check-circle text-amber-500 text-lg"></i>
                                  )}
                                </div>
                              </button>
                            ))}
                          </div>
                        )}
                      </>
                    )}
                  </>
                )}
              </div>
            </div>

            {/* Footer */}
            <div className="bg-neutral-50 px-6 py-4 flex gap-3 justify-end border-t border-neutral-200 shrink-0">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setReassignModalOpen(false);
                }}
                disabled={!!updatingState[bookingToReassign.id]}
                className="px-4 py-2.5 rounded-lg text-neutral-700 hover:bg-neutral-200 font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-sm"
              >
                Cancel
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  confirmReassignment();
                }}
                disabled={(() => {
                  if (!!updatingState[bookingToReassign.id]) return true;
                  
                  const hasMultipleServices = Array.isArray(bookingToReassign.services) && bookingToReassign.services.length > 0;
                  
                  if (hasMultipleServices) {
                    // Only check rejected/unassigned services - assigned services are customer-selected and cannot be reassigned
                    const servicesToReassign = bookingToReassign.services!.filter(s => 
                      s.approvalStatus === "rejected" || 
                      s.approvalStatus === "needs_assignment" ||
                      !s.approvalStatus ||
                      (!s.staffId || s.staffName === "Any Available" || s.staffName === "Any Staff" || s.staffName === "Not Assigned Yet")
                    );
                    
                    // If no services to reassign, allow button (edge case)
                    if (servicesToReassign.length === 0) return false;
                    
                    // All rejected/unassigned services must have staff selected
                    return !servicesToReassign.every(s => {
                      const serviceKey = String(s.id || s.serviceId || s.name);
                      return selectedStaffPerService[serviceKey];
                    });
                  } else {
                    return !selectedStaffId;
                  }
                })()}
                className="px-5 py-2.5 rounded-lg bg-gradient-to-r from-amber-500 to-orange-600 hover:from-amber-600 hover:to-orange-700 text-white font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 text-sm shadow-lg shadow-amber-200"
              >
                {updatingState[bookingToReassign.id] === "Reassign" ? (
                  <>
                    <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
                    <span>Reassigning...</span>
                  </>
                ) : (
                  <>
                    <i className="fas fa-user-plus"></i>
                    <span>Reassign Booking</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Reschedule Modal — owner / branch admin amend date & time ─── */}
      {rescheduleModalOpen && bookingToReschedule && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-fade-in"
            onClick={closeRescheduleModal}
          />

          <div
            className="relative bg-white rounded-2xl shadow-2xl max-w-2xl w-full animate-scale-in overflow-hidden max-h-[90vh] flex flex-col z-10"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="p-5 shrink-0" style={{ backgroundColor: "#1d4ed8" }}>
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 bg-white/20 backdrop-blur-sm rounded-xl flex items-center justify-center">
                  <i className="fas fa-calendar-days text-white text-xl" />
                </div>
                <div className="min-w-0">
                  <h3 className="text-lg font-bold text-white">Reschedule booking</h3>
                  <p className="text-white/80 text-sm truncate">
                    {bookingToReschedule.bookingCode || bookingToReschedule.client}
                  </p>
                </div>
              </div>
            </div>

            {/* Body */}
            <div className="p-6 overflow-y-auto flex-1 space-y-5">
              {/* Current slot */}
              <div className="bg-neutral-50 border border-neutral-200 rounded-xl p-4">
                <div className="text-[11px] uppercase tracking-wide font-bold text-neutral-500 mb-1.5">
                  Current date &amp; time
                </div>
                <div className="flex items-center gap-3 text-sm text-neutral-800 flex-wrap">
                  <i className="fas fa-clock text-neutral-400" />
                  <span className="font-semibold">
                    {bookingToReschedule.date || "—"}
                  </span>
                  <span className="text-neutral-400">·</span>
                  <span className="font-semibold inline-flex items-center gap-1">
                    <i className="fas fa-arrow-right-to-bracket text-[9px] text-amber-500" />
                    {bookingToReschedule.time || "—"}
                  </span>
                  {bookingToReschedule.pickupTime && (
                    <>
                      <span className="text-neutral-400">·</span>
                      <span className="font-semibold inline-flex items-center gap-1">
                        <i className="fas fa-arrow-right-from-bracket text-[9px] text-emerald-500" />
                        {bookingToReschedule.pickupTime}
                      </span>
                    </>
                  )}
                </div>
              </div>

              {/* Branch timezone card — mirrors the Book an Appointment modal. */}
              {rescheduleBranch && (() => {
                const tz = rescheduleBranch.timezone || "";
                const tzLabel = tz ? (tz.split("/").pop()?.replace(/_/g, " ") || tz) : "Local time";
                const now = new Date(rescheduleNowTick);
                const branchTimeStr = tz
                  ? new Intl.DateTimeFormat("en-GB", {
                      timeZone: tz,
                      hour: "2-digit",
                      minute: "2-digit",
                      hour12: false,
                    }).format(now)
                  : `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
                return (
                  <div className="bg-white rounded-2xl border border-neutral-200/80 p-4 shadow-sm">
                    <div className="flex items-center justify-between flex-wrap gap-2">
                      <div className="flex items-center gap-2.5">
                        <div className="w-8 h-8 rounded-lg bg-blue-100 flex items-center justify-center">
                          <i className="fas fa-globe text-blue-600 text-xs" />
                        </div>
                        <div>
                          <span className="text-xs font-bold text-neutral-800 block">
                            {rescheduleBranch.name || tzLabel}
                          </span>
                          <span className="text-[10px] text-neutral-400">
                            {tz ? `Branch timezone · ${tzLabel}` : "Branch timezone"}
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 bg-neutral-900 px-3 py-1.5 rounded-full">
                        <i className="fas fa-clock text-amber-400 text-[10px]" />
                        <span className="text-xs font-bold text-white">{branchTimeStr}</span>
                      </div>
                    </div>
                    <p className="text-[10px] text-neutral-400 mt-2 ml-[42px]">
                      Past time slots are automatically hidden based on branch local time.
                    </p>
                  </div>
                );
              })()}

              {/* New slot — calendar + time-slot grid styled like the booking engine */}
              <div className="space-y-3">
                <div className="text-[11px] uppercase tracking-wide font-bold text-neutral-500">
                  New date &amp; time
                </div>

                <div className="flex flex-col sm:flex-row gap-4">
                  {/* Calendar */}
                  <div className="flex-1 flex flex-col">
                    <label className="block text-[11px] font-bold text-neutral-400 uppercase tracking-wider mb-2">
                      Date <span className="text-red-400">*</span>
                    </label>
                    {(() => {
                      const { year, month } = rescheduleCalendarMonth;
                      const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
                      const dayNames = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
                      const firstDay = new Date(year, month, 1);
                      const lastDay = new Date(year, month + 1, 0);
                      const startDow = (firstDay.getDay() + 6) % 7;
                      const daysInMonth = lastDay.getDate();
                      const today = new Date();
                      const todayDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
                      const todayStr = `${todayDate.getFullYear()}-${String(todayDate.getMonth() + 1).padStart(2, "0")}-${String(todayDate.getDate()).padStart(2, "0")}`;

                      const prevMonth = () => setRescheduleCalendarMonth((p) => p.month === 0 ? { year: p.year - 1, month: 11 } : { year: p.year, month: p.month - 1 });
                      const nextMonth = () => setRescheduleCalendarMonth((p) => p.month === 11 ? { year: p.year + 1, month: 0 } : { year: p.year, month: p.month + 1 });
                      const canGoPrev = new Date(year, month, 1) > new Date(todayDate.getFullYear(), todayDate.getMonth(), 1);

                      const cells: (number | null)[] = [];
                      for (let i = 0; i < startDow; i++) cells.push(null);
                      for (let d = 1; d <= daysInMonth; d++) cells.push(d);
                      while (cells.length % 7 !== 0) cells.push(null);

                      return (
                        <div className="border-2 border-neutral-200 rounded-xl overflow-hidden bg-white flex-1 flex flex-col">
                          <div className="flex items-center justify-between px-3 py-2.5 bg-neutral-50 border-b border-neutral-100">
                            <button
                              type="button"
                              onClick={prevMonth}
                              disabled={!canGoPrev || rescheduleSaving}
                              className="w-7 h-7 rounded-lg flex items-center justify-center text-neutral-500 hover:bg-neutral-200 hover:text-neutral-700 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                            >
                              <i className="fas fa-chevron-left text-[10px]" />
                            </button>
                            <span className="text-xs font-bold text-neutral-800">
                              {monthNames[month]} {year}
                            </span>
                            <button
                              type="button"
                              onClick={nextMonth}
                              disabled={rescheduleSaving}
                              className="w-7 h-7 rounded-lg flex items-center justify-center text-neutral-500 hover:bg-neutral-200 hover:text-neutral-700 transition-all disabled:opacity-30"
                            >
                              <i className="fas fa-chevron-right text-[10px]" />
                            </button>
                          </div>
                          <div className="grid grid-cols-7 px-2 pt-2">
                            {dayNames.map((d) => (
                              <div key={d} className="text-center text-[10px] font-bold text-neutral-400 py-1">{d}</div>
                            ))}
                          </div>
                          <div className="grid grid-cols-7 px-2 pb-2 gap-y-0.5 flex-1">
                            {cells.map((day, i) => {
                              if (day === null) return <div key={`e-${i}`} />;
                              const cellDate = new Date(year, month, day);
                              cellDate.setHours(0, 0, 0, 0);
                              const dateStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
                              const isPast = cellDate < todayDate;
                              // Mark days the branch is closed (strike-through, non-selectable)
                              let isClosed = false;
                              if (rescheduleBranch?.hours && typeof rescheduleBranch.hours !== "string") {
                                let dayName: string;
                                try {
                                  dayName = new Intl.DateTimeFormat("en-US", {
                                    weekday: "long",
                                    timeZone: rescheduleBranch.timezone || undefined,
                                  }).format(new Date(`${dateStr}T12:00:00`));
                                } catch {
                                  dayName = new Intl.DateTimeFormat("en-US", { weekday: "long" }).format(new Date(`${dateStr}T12:00:00`));
                                }
                                const dh = rescheduleBranch.hours[dayName];
                                if (dh?.closed) isClosed = true;
                              }
                              const isDisabled = isPast || isClosed;
                              const isSelected = rescheduleNewDate === dateStr;
                              const isToday = dateStr === todayStr;
                              return (
                                <button
                                  key={dateStr}
                                  type="button"
                                  disabled={isDisabled || rescheduleSaving}
                                  onClick={() => setRescheduleNewDate(dateStr)}
                                  title={isClosed ? "Branch closed" : undefined}
                                  className={`w-full aspect-square rounded-lg flex items-center justify-center text-xs font-semibold transition-all
                                    ${isDisabled ? "text-neutral-300 cursor-not-allowed" : ""}
                                    ${isClosed && !isPast ? "line-through decoration-red-300" : ""}
                                    ${isSelected ? "bg-neutral-900 text-white shadow-md shadow-neutral-900/20" : ""}
                                    ${isToday && !isSelected && !isDisabled ? "bg-amber-100 text-amber-700 font-bold" : ""}
                                    ${!isDisabled && !isSelected && !isToday ? "text-neutral-700 hover:bg-neutral-100" : ""}
                                  `}
                                >
                                  {day}
                                </button>
                              );
                            })}
                          </div>
                          <div className="flex items-center justify-between px-3 py-2 border-t border-neutral-100 bg-neutral-50/50">
                            <button
                              type="button"
                              onClick={() => setRescheduleNewDate("")}
                              disabled={rescheduleSaving}
                              className="text-[10px] font-semibold text-neutral-400 hover:text-neutral-600 transition-colors disabled:opacity-50"
                            >
                              Clear
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setRescheduleCalendarMonth({ year: todayDate.getFullYear(), month: todayDate.getMonth() });
                                setRescheduleNewDate(todayStr);
                              }}
                              disabled={rescheduleSaving}
                              className="text-[10px] font-semibold text-amber-600 hover:text-amber-700 transition-colors disabled:opacity-50"
                            >
                              Today
                            </button>
                          </div>
                        </div>
                      );
                    })()}
                    {rescheduleNewDate && (
                      <div className="mt-2 flex items-center gap-2 px-1">
                        <i className="fas fa-calendar-check text-[10px] text-emerald-500" />
                        <span className="text-xs font-semibold text-neutral-700">{rescheduleNewDate}</span>
                      </div>
                    )}
                  </div>

                  {/* Drop-off time grid (branch-hours-aware) */}
                  <div className="flex-1 flex flex-col">
                    <label className="block text-[11px] font-bold text-neutral-400 uppercase tracking-wider mb-2">
                      <i className="fas fa-arrow-right-to-bracket text-[9px] text-amber-500 mr-1" />
                      Drop-off Time <span className="text-red-400">*</span>
                    </label>
                    {(() => {
                      // Resolve the booking's total service duration.
                      const row = bookingToReschedule!;
                      const totalDuration = (() => {
                        if (Array.isArray(row.services) && row.services.length > 0) {
                          return row.services.reduce((sum, s) => sum + (Number(s.duration) || 0), 0) || Number(row.duration || 0) || 60;
                        }
                        return Number(row.duration || 0) || 60;
                      })();

                      // Resolve branch hours for the selected date (if we have a branch loaded).
                      let branchDayHours: BranchDayHours | null = null;
                      let branchClosed = false;
                      if (rescheduleNewDate && rescheduleBranch?.hours && typeof rescheduleBranch.hours !== "string") {
                        let dayName: string;
                        try {
                          dayName = new Intl.DateTimeFormat("en-US", {
                            weekday: "long",
                            timeZone: rescheduleBranch.timezone || undefined,
                          }).format(new Date(`${rescheduleNewDate}T12:00:00`));
                        } catch {
                          dayName = new Intl.DateTimeFormat("en-US", { weekday: "long" }).format(new Date(`${rescheduleNewDate}T12:00:00`));
                        }
                        const dh = rescheduleBranch.hours[dayName];
                        if (dh?.closed) {
                          branchClosed = true;
                        } else if (dh?.open && dh?.close) {
                          branchDayHours = dh;
                        }
                      }

                      // Fallback range if branch hours aren't available.
                      const fallbackOpen = "07:00";
                      const fallbackClose = "19:30";
                      const openStr = branchDayHours?.open || fallbackOpen;
                      const closeStr = branchDayHours?.close || fallbackClose;

                      const toMinutes = (hhmm: string): number => {
                        const [h, m] = hhmm.split(":").map(Number);
                        return h * 60 + m;
                      };
                      const fmt = (mins: number): string => {
                        const h = Math.floor(mins / 60);
                        const m = mins % 60;
                        return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
                      };

                      // Current branch-local time (for filtering past slots if date == today).
                      const now = new Date(rescheduleNowTick);
                      const branchNowStr = rescheduleBranch?.timezone
                        ? new Intl.DateTimeFormat("en-CA", {
                            timeZone: rescheduleBranch.timezone,
                            year: "numeric",
                            month: "2-digit",
                            day: "2-digit",
                          }).format(now)
                        : `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
                      const branchNowHHmm = rescheduleBranch?.timezone
                        ? new Intl.DateTimeFormat("en-GB", {
                            timeZone: rescheduleBranch.timezone,
                            hour: "2-digit",
                            minute: "2-digit",
                            hour12: false,
                          }).format(now)
                        : `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
                      const isToday = rescheduleNewDate === branchNowStr;

                      // Drop-off window: branch open → min(11:00, close − totalDuration).
                      // Mirrors the booking engine's morning-drop-off / afternoon-pick-up model.
                      const DROPOFF_CUTOFF_MIN = toMinutes("11:00");
                      const openMin = toMinutes(openStr);
                      const closeMin = toMinutes(closeStr);
                      const lastDropoff = Math.min(DROPOFF_CUTOFF_MIN, closeMin - totalDuration);

                      const slots: string[] = [];
                      if (!branchClosed && lastDropoff >= openMin) {
                        for (let m = openMin; m <= lastDropoff; m += 30) {
                          slots.push(fmt(m));
                        }
                      }

                      return (
                        <div className="border-2 border-neutral-200 rounded-xl overflow-hidden bg-white flex-1 flex flex-col">
                          <div className="px-3 py-2.5 bg-neutral-50 border-b border-neutral-100">
                            <div className="flex items-center gap-2">
                              <i className="fas fa-clock text-[10px] text-amber-500" />
                              <span className="text-xs font-bold text-neutral-800">When does the customer drop off?</span>
                            </div>
                            {branchDayHours && (
                              <div className="flex items-center gap-1.5 mt-1">
                                <i className="fas fa-store text-[9px] text-neutral-300" />
                                <span className="text-[10px] font-medium text-neutral-400">
                                  Drop-off {branchDayHours.open} – 11:00 · service is {totalDuration} min
                                </span>
                              </div>
                            )}
                          </div>
                          <div className="grid grid-cols-4 gap-1.5 p-2.5 flex-1 overflow-y-auto max-h-[260px]" style={{ alignContent: "start" }}>
                            {!rescheduleNewDate ? (
                              <p className="col-span-4 text-center text-[11px] text-neutral-400 py-6">
                                Select a date first to see drop-off times.
                              </p>
                            ) : rescheduleBranchLoading && !rescheduleBranch ? (
                              <p className="col-span-4 text-center text-[11px] text-neutral-400 py-6">
                                Loading branch hours…
                              </p>
                            ) : branchClosed ? (
                              <p className="col-span-4 text-center text-[11px] text-rose-500 py-6">
                                Branch is closed on this day. Please pick another date.
                              </p>
                            ) : slots.length === 0 ? (
                              <p className="col-span-4 text-center text-[11px] text-neutral-400 py-6">
                                No drop-off slots fit within opening hours for this service duration.
                              </p>
                            ) : (
                              slots.map((t) => {
                                const isPast = isToday && t <= branchNowHHmm;
                                const isSelected = rescheduleNewTime === t;
                                return (
                                  <button
                                    key={t}
                                    type="button"
                                    disabled={isPast || rescheduleSaving}
                                    onClick={() => {
                                      setRescheduleNewTime(t);
                                      // If the current pick-up is now invalid (<= new drop-off), clear it.
                                      if (rescheduleNewPickupTime && rescheduleNewPickupTime <= t) {
                                        setRescheduleNewPickupTime("");
                                      }
                                    }}
                                    className={`relative rounded-lg text-[13px] font-semibold transition-all text-center flex items-center justify-center py-2 min-h-[40px]
                                      ${isPast
                                        ? "bg-neutral-100 text-neutral-300 cursor-not-allowed"
                                        : isSelected
                                          ? "bg-neutral-900 text-white shadow-md shadow-neutral-900/20"
                                          : "bg-amber-50 text-neutral-700 hover:bg-amber-100 hover:text-neutral-900 border border-amber-200/60"}
                                    `}
                                  >
                                    {t}
                                  </button>
                                );
                              })
                            )}
                          </div>
                        </div>
                      );
                    })()}
                    {rescheduleNewTime && (
                      <div className="mt-2 flex items-center gap-2 px-1">
                        <i className="fas fa-arrow-right-to-bracket text-[10px] text-emerald-500" />
                        <span className="text-xs font-semibold text-neutral-700">Drop-off: {rescheduleNewTime}</span>
                      </div>
                    )}
                  </div>
                </div>

                {/* Pick-up time grid (shown once a drop-off time is selected) */}
                {rescheduleNewTime && (() => {
                  const row = bookingToReschedule!;
                  const totalDuration = (() => {
                    if (Array.isArray(row.services) && row.services.length > 0) {
                      return row.services.reduce((sum, s) => sum + (Number(s.duration) || 0), 0) || Number(row.duration || 0) || 60;
                    }
                    return Number(row.duration || 0) || 60;
                  })();

                  let branchDayHours: BranchDayHours | null = null;
                  if (rescheduleNewDate && rescheduleBranch?.hours && typeof rescheduleBranch.hours !== "string") {
                    let dayName: string;
                    try {
                      dayName = new Intl.DateTimeFormat("en-US", {
                        weekday: "long",
                        timeZone: rescheduleBranch.timezone || undefined,
                      }).format(new Date(`${rescheduleNewDate}T12:00:00`));
                    } catch {
                      dayName = new Intl.DateTimeFormat("en-US", { weekday: "long" }).format(new Date(`${rescheduleNewDate}T12:00:00`));
                    }
                    const dh = rescheduleBranch.hours[dayName];
                    if (dh?.open && dh?.close && !dh?.closed) branchDayHours = dh;
                  }

                  const closeStr = branchDayHours?.close || "19:30";
                  const toMinutes = (hhmm: string): number => {
                    const [h, m] = hhmm.split(":").map(Number);
                    return h * 60 + m;
                  };
                  const fmt = (mins: number): string => {
                    const h = Math.floor(mins / 60);
                    const m = mins % 60;
                    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
                  };

                  const dropoffMin = toMinutes(rescheduleNewTime);
                  // Pick-up window: max(drop-off + duration, 14:00) → branch close.
                  const PICKUP_EARLIEST_MIN = toMinutes("14:00");
                  const earliestPickupMin = Math.max(dropoffMin + totalDuration, PICKUP_EARLIEST_MIN);
                  const earliestPickup = fmt(earliestPickupMin);
                  const closeMin = toMinutes(closeStr);

                  const pickupSlots: string[] = [];
                  for (let m = earliestPickupMin; m <= closeMin; m += 30) {
                    pickupSlots.push(fmt(m));
                  }

                  return (
                    <div className="mt-4 animate-[fadeSlideUp_0.3s_ease-out]">
                      <label className="block text-[11px] font-bold text-neutral-400 uppercase tracking-wider mb-2">
                        <i className="fas fa-arrow-right-from-bracket text-[9px] text-emerald-500 mr-1" />
                        Pick-up Time{" "}
                        <span className="ml-2 text-[10px] font-medium text-neutral-400 normal-case tracking-normal">
                          earliest: {earliestPickup} — from 14:00 · {totalDuration} min service
                        </span>
                      </label>
                      <div className="border-2 border-emerald-200 rounded-xl overflow-hidden bg-white">
                        <div className="px-3 py-2.5 bg-emerald-50 border-b border-emerald-100">
                          <div className="flex items-center gap-2">
                            <i className="fas fa-arrow-right-from-bracket text-[10px] text-emerald-600" />
                            <span className="text-xs font-bold text-emerald-800">When does the customer pick up?</span>
                          </div>
                          {branchDayHours && (
                            <div className="flex items-center gap-1.5 mt-1">
                              <i className="fas fa-store text-[9px] text-emerald-300" />
                              <span className="text-[10px] font-medium text-emerald-400">
                                Branch closes at {branchDayHours.close}
                              </span>
                            </div>
                          )}
                        </div>
                        {pickupSlots.length === 0 ? (
                          <div className="p-4 text-center">
                            <p className="text-[11px] text-neutral-400">
                              No pick-up times available for this drop-off time and service duration.
                            </p>
                          </div>
                        ) : (
                          <div className="grid grid-cols-4 sm:grid-cols-6 gap-1.5 p-2.5 max-h-[200px] overflow-y-auto" style={{ alignContent: "start" }}>
                            {pickupSlots.map((t) => (
                              <button
                                key={t}
                                type="button"
                                onClick={() => setRescheduleNewPickupTime(t)}
                                disabled={rescheduleSaving}
                                className={`h-9 rounded-lg text-xs font-semibold transition-all text-center
                                  ${rescheduleNewPickupTime === t
                                    ? "bg-emerald-600 text-white shadow-md shadow-emerald-600/20"
                                    : "bg-emerald-50 text-emerald-700 hover:bg-emerald-100 hover:text-emerald-800"}
                                `}
                              >
                                {t}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                      {rescheduleNewPickupTime && (
                        <div className="mt-2 flex items-center gap-2 px-1">
                          <i className="fas fa-arrow-right-from-bracket text-[10px] text-emerald-500" />
                          <span className="text-xs font-semibold text-neutral-700">Pick-up: {rescheduleNewPickupTime}</span>
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>

              {/* Staff reassignment (optional) */}
              {(() => {
                if (!bookingToReschedule) return null;
                const hasServices = Array.isArray(bookingToReschedule.services) && bookingToReschedule.services.length > 0;
                const options = rescheduleStaffOptions;
                const renderSelect = (
                  currentId: string,
                  value: string,
                  onChange: (next: string) => void,
                  currentName?: string | null,
                ) => {
                  const currentInOptions = !!currentId && options.some((s) => s.id === currentId);
                  return (
                    <select
                      value={value}
                      onChange={(e) => onChange(e.target.value)}
                      disabled={rescheduleSaving || rescheduleStaffLoading}
                      className="w-full px-3 py-2 rounded-lg border border-neutral-300 focus:border-sky-500 focus:ring-2 focus:ring-sky-500/20 outline-none text-sm bg-white disabled:opacity-60"
                    >
                      <option value="">
                        {rescheduleStaffLoading ? "Loading staff…" : "— Unassigned —"}
                      </option>
                      {currentId && !currentInOptions && (
                        <option value={currentId}>
                          {currentName || "Current staff"} (current)
                        </option>
                      )}
                      {options.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                          {s.id === currentId ? " (current)" : ""}
                        </option>
                      ))}
                    </select>
                  );
                };

                return (
                  <div className="rounded-xl border border-neutral-200 bg-white p-3">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-semibold text-neutral-700 inline-flex items-center gap-1.5">
                        <i className="fas fa-user-gear text-[11px] text-indigo-500" />
                        Assigned staff
                      </span>
                      <span className="text-[10px] text-neutral-400">
                        Reassigning will notify the new staff.
                      </span>
                    </div>

                    {hasServices ? (
                      <div className="flex flex-col gap-2">
                        {bookingToReschedule.services!.map((svc) => {
                          const sid = String(svc.id);
                          const currentId = (svc.staffId || "").toString();
                          const value = rescheduleStaffByService[sid] ?? currentId;
                          return (
                            <div key={sid} className="flex flex-col sm:flex-row sm:items-center gap-2">
                              <div className="sm:w-40 shrink-0">
                                <div className="text-xs font-semibold text-neutral-800 truncate">
                                  {svc.name || "Service"}
                                </div>
                                <div className="text-[10px] text-neutral-500 truncate">
                                  Currently: {svc.staffName || "Unassigned"}
                                </div>
                              </div>
                              <div className="flex-1">
                                {renderSelect(
                                  currentId,
                                  value,
                                  (next) =>
                                    setRescheduleStaffByService((prev) => ({
                                      ...prev,
                                      [sid]: next,
                                    })),
                                  svc.staffName,
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                        <div className="sm:w-40 shrink-0">
                          <div className="text-xs font-semibold text-neutral-800 truncate">
                            {bookingToReschedule.serviceName || "Service"}
                          </div>
                          <div className="text-[10px] text-neutral-500 truncate">
                            Currently: {bookingToReschedule.staffName || "Unassigned"}
                          </div>
                        </div>
                        <div className="flex-1">
                          {renderSelect(
                            (bookingToReschedule.staffId || "").toString(),
                            rescheduleStaffId,
                            setRescheduleStaffId,
                            bookingToReschedule.staffName,
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* Reason (optional) */}
              <label className="block">
                <span className="text-xs font-semibold text-neutral-700 mb-1.5 block">
                  Reason{" "}
                  <span className="font-normal text-neutral-400">(optional)</span>
                </span>
                <textarea
                  rows={3}
                  value={rescheduleReason}
                  onChange={(e) => setRescheduleReason(e.target.value)}
                  placeholder="e.g. Customer requested a later slot, staff unavailable, etc."
                  disabled={rescheduleSaving}
                  className="w-full px-3 py-2 rounded-lg border border-neutral-300 focus:border-sky-500 focus:ring-2 focus:ring-sky-500/20 outline-none text-sm resize-none disabled:opacity-60"
                />
              </label>

              {/* Info banner */}
              <div className="bg-sky-50 border border-sky-200 rounded-lg p-3 text-xs text-sky-800 flex gap-2">
                <i className="fas fa-info-circle mt-0.5" />
                <div>
                  The customer will be emailed the new date &amp; time
                  (and any staff change), the rescheduling will appear in
                  their app, and the amendment is recorded in the audit log.
                </div>
              </div>

              {rescheduleError && (
                <div className="bg-rose-50 border border-rose-200 rounded-lg p-3 text-xs text-rose-800 flex gap-2">
                  <i className="fas fa-triangle-exclamation mt-0.5" />
                  <div>{rescheduleError}</div>
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="border-t border-neutral-100 p-4 flex items-center gap-3 bg-neutral-50/60 shrink-0">
              <button
                onClick={closeRescheduleModal}
                disabled={rescheduleSaving}
                className="flex-1 px-4 py-2.5 rounded-xl text-sm font-semibold text-neutral-700 bg-white border border-neutral-200 hover:bg-neutral-50 transition disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                onClick={confirmReschedule}
                disabled={rescheduleSaving}
                className="flex-1 px-4 py-2.5 rounded-xl text-sm font-semibold text-white shadow-sm transition disabled:opacity-60 inline-flex items-center justify-center gap-2"
                style={{ backgroundColor: "#1d4ed8" }}
                onMouseEnter={(e) => {
                  if (!rescheduleSaving) e.currentTarget.style.backgroundColor = "#1e40af";
                }}
                onMouseLeave={(e) => {
                  if (!rescheduleSaving) e.currentTarget.style.backgroundColor = "#1d4ed8";
                }}
              >
                {rescheduleSaving ? (
                  <>
                    <i className="fas fa-spinner fa-spin" />
                    Saving...
                  </>
                ) : (
                  <>
                    <i className="fas fa-calendar-check" />
                    Save new date &amp; time
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Pending Additional Issues Alert Modal ────────────────── */}
      {pendingIssuesAlert && (
        <div className="fixed inset-0 z-[9998] flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in">
          <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full mx-4 overflow-hidden animate-scale-in">
            <div className="bg-gradient-to-r from-red-500 to-rose-500 px-6 py-4 flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-white/20 flex items-center justify-center">
                <i className="fas fa-hand text-white" />
              </div>
              <h3 className="text-white font-semibold">Cannot Complete Booking</h3>
            </div>
            <div className="px-6 py-5">
              <p className="text-neutral-600 text-sm leading-relaxed mb-4">
                This booking has pending additional work requests that need decisions before it can be completed.
              </p>
              <div className="space-y-2">
                {pendingIssuesAlert.pendingAdmin > 0 && (
                  <div className="flex items-center gap-3 p-3 bg-amber-50 rounded-xl border border-amber-100">
                    <div className="w-8 h-8 rounded-lg bg-amber-100 flex items-center justify-center flex-shrink-0">
                      <i className="fas fa-user-shield text-amber-600 text-xs" />
                    </div>
                    <div>
                      <div className="text-sm font-semibold text-amber-800">{pendingIssuesAlert.pendingAdmin} pending admin approval</div>
                      <div className="text-xs text-amber-600">Admin needs to approve or reject</div>
                    </div>
                  </div>
                )}
                {pendingIssuesAlert.pendingCustomer > 0 && (
                  <div className="flex items-center gap-3 p-3 bg-blue-50 rounded-xl border border-blue-100">
                    <div className="w-8 h-8 rounded-lg bg-blue-100 flex items-center justify-center flex-shrink-0">
                      <i className="fas fa-user text-blue-600 text-xs" />
                    </div>
                    <div>
                      <div className="text-sm font-semibold text-blue-800">{pendingIssuesAlert.pendingCustomer} awaiting customer response</div>
                      <div className="text-xs text-blue-600">Customer needs to accept or reject</div>
                    </div>
                  </div>
                )}
              </div>
              <p className="text-neutral-500 text-xs mt-4 leading-relaxed">
                Staff should contact the admin to get a decision on pending requests before completing the booking.
              </p>
            </div>
            <div className="px-6 pb-5 flex items-center justify-end">
              <button
                onClick={() => setPendingIssuesAlert(null)}
                className="px-5 py-2 rounded-full text-sm font-semibold bg-neutral-900 hover:bg-black text-white shadow-sm transition"
              >
                Understood
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Force Complete Confirmation Modal ─────────────────────── */}
      {forceCompleteConfirm && (
        <div className="fixed inset-0 z-[9998] flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in">
          <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full mx-4 overflow-hidden animate-scale-in">
            <div className="bg-gradient-to-r from-orange-500 to-amber-500 px-6 py-4 flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-white/20 flex items-center justify-center">
                <i className="fas fa-exclamation-triangle text-white" />
              </div>
              <h3 className="text-white font-semibold">Incomplete Tasks</h3>
            </div>
            <div className="px-6 py-5">
              <div className="flex items-center gap-3 mb-4 p-3 bg-orange-50 rounded-xl border border-orange-100">
                <div className="text-2xl font-bold text-orange-600">
                  {forceCompleteConfirm.completedTasks}/{forceCompleteConfirm.totalTasks}
                </div>
                <div className="text-sm text-orange-700">tasks completed by staff</div>
              </div>
              <p className="text-neutral-600 text-sm leading-relaxed">
                Staff has not completed all assigned tasks. Are you sure the staff failed to complete the remaining tasks and you want to mark this service as complete?
              </p>
            </div>
            <div className="px-6 pb-5 flex items-center justify-end gap-3">
              <button
                onClick={() => setForceCompleteConfirm(null)}
                className="px-4 py-2 rounded-full text-sm font-semibold bg-neutral-100 hover:bg-neutral-200 text-neutral-700 transition"
              >
                Cancel
              </button>
              <button
                onClick={handleForceComplete}
                className="px-5 py-2 rounded-full text-sm font-semibold bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-600 hover:to-amber-600 text-white shadow-sm transition inline-flex items-center gap-2"
              >
                <i className="fas fa-check text-xs" />
                Yes, Complete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Job report PDF preview (download / print) ─────────────── */}
      {pdfPreview && (
        <div className="fixed inset-0 z-[9998] flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in p-3 sm:p-4">
          <div
            className="bg-white rounded-2xl shadow-2xl w-full max-w-5xl h-[min(92vh,880px)] flex flex-col overflow-hidden animate-scale-in"
            role="dialog"
            aria-modal="true"
            aria-labelledby="pdf-preview-title"
          >
            <div className="shrink-0 bg-neutral-900 px-4 py-3 sm:px-5 sm:py-3.5 flex flex-wrap items-center gap-2 sm:gap-3 border-b border-neutral-800">
              <div className="w-9 h-9 rounded-xl bg-white/10 flex items-center justify-center shrink-0">
                <i className="fas fa-file-pdf text-white text-sm" />
              </div>
              <h3 id="pdf-preview-title" className="text-white font-semibold text-sm sm:text-base flex-1 min-w-0 truncate pr-2">
                Job report — {pdfPreview.filename}
              </h3>
              <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto sm:justify-end">
                <button
                  type="button"
                  onClick={downloadPdfFromPreview}
                  className="px-3 py-2 rounded-full text-xs sm:text-sm font-semibold bg-white/15 hover:bg-white/25 text-white transition inline-flex items-center gap-2"
                >
                  <i className="fas fa-download text-[10px]" />
                  Download
                </button>
                <button
                  type="button"
                  onClick={printPdfFromPreview}
                  className="px-3 py-2 rounded-full text-xs sm:text-sm font-semibold bg-white/15 hover:bg-white/25 text-white transition inline-flex items-center gap-2"
                >
                  <i className="fas fa-print text-[10px]" />
                  Print
                </button>
                <button
                  type="button"
                  onClick={closePdfPreview}
                  aria-label="Close"
                  className="h-9 w-9 shrink-0 rounded-full bg-white text-neutral-900 hover:bg-neutral-100 transition inline-flex items-center justify-center"
                >
                  <i className="fas fa-times text-sm" />
                </button>
              </div>
            </div>
            <div className="flex min-h-0 flex-1 flex-col bg-neutral-100">
              <BookingJobReportPdfViewer
                bookingId={pdfPreview.bookingId}
                filename={pdfPreview.filename}
                className="min-h-0 flex-1"
              />
            </div>
          </div>
        </div>
      )}

      {/* ─── Image Lightbox Modal ──────────────────────────────────── */}
      {lightboxImage && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 backdrop-blur-sm animate-fade-in"
          onClick={() => setLightboxImage(null)}
        >
          <div
            className="relative max-w-[90vw] max-h-[90vh] animate-scale-in"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Close button */}
            <button
              onClick={() => setLightboxImage(null)}
              className="absolute -top-3 -right-3 z-10 w-8 h-8 bg-white rounded-full shadow-lg flex items-center justify-center hover:bg-red-50 transition group"
            >
              <i className="fas fa-times text-neutral-500 group-hover:text-red-500 text-sm" />
            </button>

            {/* Title */}
            <div className="bg-white rounded-t-2xl px-5 py-3 border-b border-neutral-100">
              <h3 className="text-sm font-bold text-neutral-800 flex items-center gap-2">
                <i className="fas fa-image text-blue-500 text-xs" />
                {lightboxImage.title}
              </h3>
            </div>

            {/* Image */}
            <div className="bg-white p-3 rounded-b-2xl shadow-2xl">
              <img
                src={lightboxImage.url}
                alt={lightboxImage.title}
                className="max-w-full max-h-[75vh] rounded-xl object-contain mx-auto"
              />
            </div>

            {/* Open in new tab link */}
            <div className="flex justify-center mt-3">
              <a
                href={lightboxImage.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-white/80 hover:text-white flex items-center gap-1.5 bg-white/10 hover:bg-white/20 px-3 py-1.5 rounded-full transition"
              >
                <i className="fas fa-external-link-alt text-[10px]" />
                Open in new tab
              </a>
            </div>
          </div>
        </div>
      )}

      {/* ─── Set Price / Reject Additional Issue Modal ───────────────── */}
      {issuePriceModal && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          onClick={() => { setIssuePriceModal(null); setIssuePriceValue(""); }}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl max-w-lg w-full overflow-hidden animate-scale-in"
            onClick={(e) => e.stopPropagation()}
          >
            {(() => {
              const isRejected = issuePriceModal.issue.status === "rejected";
              return (
              <>
            {/* Header */}
            <div className={`px-6 py-5 ${isRejected ? "bg-gradient-to-r from-rose-500 to-red-500" : "bg-gradient-to-r from-amber-500 to-orange-500"}`}>
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-xl bg-white/20 flex items-center justify-center">
                  <i className={`fas ${isRejected ? "fa-times-circle" : "fa-tools"} text-white text-xl`} />
                </div>
                <div>
                  <h3 className="text-lg font-bold text-white">Additional Work Request</h3>
                  <p className="text-amber-100 text-sm">{isRejected ? "This issue has been rejected" : "Set price or reject this issue"}</p>
                </div>
              </div>
            </div>

            {/* Issue details */}
            <div className="p-6 space-y-4">
              <div className={`rounded-xl border p-4 ${isRejected ? "bg-rose-50 border-rose-200" : "bg-amber-50 border-amber-200"}`}>
                <p className="font-semibold text-neutral-800 text-base">{issuePriceModal.issue.issueTitle}</p>
                {issuePriceModal.issue.description && (
                  <p className="text-sm text-neutral-600 mt-2">{issuePriceModal.issue.description}</p>
                )}
                {issuePriceModal.issue.recommendedRepair && (
                  <p className="text-xs text-neutral-500 mt-1">Repair: {issuePriceModal.issue.recommendedRepair}</p>
                )}
                {issuePriceModal.issue.partsRequired && (
                  <p className="text-xs text-neutral-500">Parts: {issuePriceModal.issue.partsRequired}</p>
                )}
                {formatLabourMinutes(issuePriceModal.issue.labourTimeHours) && (
                  <div className="inline-flex items-center gap-2 mt-2 px-3 py-1.5 rounded-lg bg-amber-100/80 border border-amber-200">
                    <i className="fas fa-clock text-amber-600" />
                    <span className="text-sm font-semibold text-amber-900">{formatLabourMinutes(issuePriceModal.issue.labourTimeHours)}</span>
                  </div>
                )}
                {issuePriceModal.issue.reportedByStaffName && (
                  <p className="text-xs text-amber-700 mt-2 font-medium">Reported by {issuePriceModal.issue.reportedByStaffName}</p>
                )}
              </div>

              {!isRejected && (
              <div>
                <label className="block text-sm font-semibold text-neutral-700 mb-2">Price (when approving)</label>
                <div className="flex items-center border-2 border-neutral-200 rounded-xl focus-within:ring-2 focus-within:ring-amber-500 focus-within:border-amber-500">
                  <span className="pl-4 text-base font-medium text-neutral-500">$</span>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder="150.00"
                    value={issuePriceValue}
                    onChange={(e) => setIssuePriceValue(e.target.value)}
                    className="flex-1 py-3 pr-4 border-0 bg-transparent pl-1 text-base focus:ring-0 focus:outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                  />
                </div>
              </div>
              )}
            </div>

            {/* Actions */}
            <div className="px-6 pb-6 flex flex-col sm:flex-row gap-2">
              <button
                type="button"
                onClick={() => { setIssuePriceModal(null); setIssuePriceValue(""); }}
                className="flex-1 py-2 rounded-lg border border-neutral-200 text-neutral-700 text-sm font-medium hover:bg-neutral-50 transition-colors"
              >
                {isRejected ? "Close" : "Cancel"}
              </button>
              {!isRejected && (
                <>
              <button
                type="button"
                onClick={() => handleSetIssuePrice("reject")}
                disabled={issuePriceSaving}
                className="flex-1 py-2 rounded-lg border border-rose-300 bg-rose-50 text-rose-700 text-sm font-medium hover:bg-rose-100 disabled:opacity-50 transition-colors"
              >
                {issuePriceSaving ? "..." : "Reject"}
              </button>
              <button
                type="button"
                onClick={() => handleSetIssuePrice("approve")}
                disabled={issuePriceSaving || !issuePriceValue.trim()}
                className="flex-1 py-2 rounded-lg bg-amber-500 text-white text-sm font-medium hover:bg-amber-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-md shadow-amber-500/20"
              >
                {issuePriceSaving ? "Saving..." : "Approve & Set Price"}
              </button>
                </>
              )}
            </div>
          </>
              );
            })()}
          </div>
        </div>
      )}

      {/* ─── Record Customer Response Modal (owner / branch admin called customer) ─── */}
      {customerResponseModal && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          onClick={() => !customerResponseSaving && setCustomerResponseModal(null)}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl max-w-md w-full overflow-hidden animate-scale-in"
            onClick={(e) => e.stopPropagation()}
          >
            {(() => {
              const isAccept = customerResponseModal.action === "accept";
              const issue = customerResponseModal.issue;
              const priceStr =
                issue.price != null ? `$${Number(issue.price).toFixed(2)}` : "";
              return (
                <>
                  <div
                    className={`px-6 py-5 ${
                      isAccept
                        ? "bg-gradient-to-r from-emerald-500 to-green-600"
                        : "bg-gradient-to-r from-rose-500 to-red-600"
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-12 h-12 rounded-xl bg-white/20 flex items-center justify-center">
                        <i
                          className={`fas ${
                            isAccept ? "fa-check-circle" : "fa-times-circle"
                          } text-white text-xl`}
                        />
                      </div>
                      <div>
                        <h3 className="text-lg font-bold text-white">
                          {isAccept
                            ? "Mark as Customer Accepted"
                            : "Mark as Customer Declined"}
                        </h3>
                        <p className="text-white/90 text-sm">
                          Record the response you took over the phone
                        </p>
                      </div>
                    </div>
                  </div>

                  <div className="p-6 space-y-4">
                    <div
                      className={`rounded-xl border p-4 ${
                        isAccept
                          ? "bg-emerald-50 border-emerald-200"
                          : "bg-rose-50 border-rose-200"
                      }`}
                    >
                      <p className="font-semibold text-neutral-800 text-base">
                        {issue.issueTitle}
                      </p>
                      {priceStr && (
                        <p
                          className={`text-sm font-bold mt-1 ${
                            isAccept ? "text-emerald-700" : "text-rose-700"
                          }`}
                        >
                          Quoted price: {priceStr}
                        </p>
                      )}
                      {issue.description && (
                        <p className="text-xs text-neutral-600 mt-2">
                          {issue.description}
                        </p>
                      )}
                    </div>

                    <div className="rounded-lg bg-neutral-50 border border-neutral-200 p-3">
                      <p className="text-xs text-neutral-700 leading-relaxed">
                        <i className="fas fa-info-circle text-neutral-500 mr-1.5" />
                        By confirming, you are recording that the customer
                        <strong>
                          {isAccept ? " accepted " : " declined "}
                        </strong>
                        the additional-work quote during a phone conversation.
                        The reporting technician and team will be notified.
                      </p>
                    </div>
                  </div>

                  <div className="px-6 pb-6 flex flex-col sm:flex-row gap-2">
                    <button
                      type="button"
                      onClick={() => setCustomerResponseModal(null)}
                      disabled={customerResponseSaving}
                      className="flex-1 py-2 rounded-lg border border-neutral-200 text-neutral-700 text-sm font-medium hover:bg-neutral-50 transition-colors disabled:opacity-50"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={handleRecordCustomerResponse}
                      disabled={customerResponseSaving}
                      className={`flex-1 py-2 rounded-lg text-white text-sm font-semibold transition-colors shadow-md disabled:opacity-50 disabled:cursor-not-allowed ${
                        isAccept
                          ? "bg-emerald-600 hover:bg-emerald-700 shadow-emerald-500/20"
                          : "bg-rose-600 hover:bg-rose-700 shadow-rose-500/20"
                      }`}
                    >
                      {customerResponseSaving
                        ? "Saving..."
                        : isAccept
                          ? "Confirm – Customer Accepted"
                          : "Confirm – Customer Declined"}
                    </button>
                  </div>
                </>
              );
            })()}
          </div>
        </div>
      )}

      <style jsx>{`
        @keyframes fade-in {
          from {
            opacity: 0;
          }
          to {
            opacity: 1;
          }
        }
        @keyframes scale-in {
          from {
            opacity: 0;
            transform: scale(0.95);
          }
          to {
            opacity: 1;
            transform: scale(1);
          }
        }
        .animate-fade-in {
          animation: fade-in 0.2s ease-out;
        }
        .animate-scale-in {
          animation: scale-in 0.2s ease-out;
        }
      `}</style>
    </div>
  );
}