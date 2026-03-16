"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { auth, db } from "@/lib/firebase";
import { collection, onSnapshot, query, where } from "firebase/firestore";
import type { BookingStatus } from "@/lib/bookingTypes";
import { normalizeBookingStatus, getStatusLabel, getStatusColor } from "@/lib/bookingTypes";
import Sidebar from "@/components/Sidebar";
import { updateBookingStatus } from "@/lib/bookings";
import BookingsExportModal from "./BookingsExportModal";

type ServiceApprovalStatus = "pending" | "accepted" | "rejected" | "needs_assignment";
type ServiceCompletionStatus = "pending" | "completed";

type ServiceRow = {
  id: string | number;
  serviceId?: string | number;
  name?: string;
  price?: number;
  duration?: number;
  time?: string;
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
  vehicleColour?: string | null;
  vehicleVinChassis?: string | null;
  vehicleEngineNumber?: string | null;
  vehicleMileage?: string | null;  // Customer-added at booking
  mileage?: string | null;         // Staff-recorded when starting job
  mileageRecordedByStaffName?: string | null;
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
  done: boolean;
  imageUrl: string;
  staffNote: string;
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
              vehicleColour: d.vehicleColour || null,
              vehicleVinChassis: d.vehicleVinChassis || null,
              vehicleEngineNumber: d.vehicleEngineNumber || null,
              vehicleMileage: d.vehicleMileage || null,
              mileage: d.mileage || null,
              mileageRecordedByStaffName: d.mileageRecordedByStaffName || null,
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
              })) || null,
              // Task management
              tasks: Array.isArray(d.tasks) ? d.tasks.map((t: any) => ({
                id: t.id || "",
                serviceId: t.serviceId || "",
                serviceName: t.serviceName || "",
                name: t.name || "",
                description: t.description || "",
                done: !!t.done,
                imageUrl: t.imageUrl || "",
                staffNote: t.staffNote || "",
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

  // Get allowed actions per row based on the row's actual status
  const getAllowedActions = (rowStatus: BookingStatus | string | null | undefined, row?: Row): ReadonlyArray<"Confirm" | "Cancel" | "Complete" | "Reassign" | "AssignStaff"> => {
    const normalizedStatus = normalizeBookingStatus(rowStatus ?? null);
    if (normalizedStatus === "Pending") return ["Confirm", "Cancel"];
    if (normalizedStatus === "AwaitingStaffApproval") {
      // If some services need staff assignment, show AssignStaff action
      if (row && hasServicesNeedingAssignment(row)) {
        return ["AssignStaff", "Cancel"];
      }
      return ["Cancel"]; // Admin can only cancel, waiting for staff action
    }
    if (normalizedStatus === "PartiallyApproved") {
      // If some services need staff assignment, show AssignStaff action
      if (row && hasServicesNeedingAssignment(row)) {
        return ["AssignStaff", "Cancel"];
      }
      return ["Cancel"]; // Waiting for remaining staff to respond
    }
    if (normalizedStatus === "StaffRejected") return ["Reassign", "Cancel"]; // Admin must reassign rejected service(s) or cancel
    if (normalizedStatus === "Confirmed") return ["Complete", "Cancel"];
    return [];
  };
  
  // For preview panel - use the first status or check if any status allows actions
  const allowedActions = useMemo<ReadonlyArray<"Confirm" | "Cancel" | "Complete" | "Reassign">>(() => {
    const statusArray = Array.isArray(status) ? status : [status];
    if (statusArray.includes("Pending")) return ["Confirm", "Cancel"];
    if (statusArray.includes("AwaitingStaffApproval")) return ["Cancel"];
    if (statusArray.includes("PartiallyApproved")) return ["Cancel"];
    if (statusArray.includes("StaffRejected")) return ["Reassign", "Cancel"];
    if (statusArray.includes("Confirmed")) return ["Complete", "Cancel"];
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

  // Export modal
  const [exportModalOpen, setExportModalOpen] = useState(false);

  // Sync mileage edit value when preview row changes
  useEffect(() => {
    if (previewRow?.mileage) {
      const val = String(previewRow.mileage).replace(/\s*km\s*$/i, "").trim();
      setMileageEditValue(val);
    } else {
      setMileageEditValue("");
    }
  }, [previewRow?.id, previewRow?.mileage]);

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

        // Track loaded data
        let servicesData: any[] = [];
        let staffData: any[] = [];

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
              
              // Filter by branch association (staff who work at this branch on ANY day)
              if (bookingToConfirm.branchId) {
                filtered = filtered.filter((s: any) => {
                  // Check home branch
                  if (s.branchId === bookingToConfirm.branchId) return true;
                  // Check if staff has ANY day scheduled at this branch
                  if (s.weeklySchedule && typeof s.weeklySchedule === 'object') {
                    return Object.values(s.weeklySchedule).some(
                      (day: any) => day && day.branchId === bookingToConfirm.branchId
                    );
                  }
                  return false;
                });
              }
              
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

            // Filter by branch association (staff who work at this branch on ANY day)
            if (bookingToConfirm.branchId) {
              filtered = filtered.filter((s: any) => {
                // Check home branch
                if (s.branchId === bookingToConfirm.branchId) return true;
                // Check if staff has ANY day scheduled at this branch
                if (s.weeklySchedule && typeof s.weeklySchedule === 'object') {
                  return Object.values(s.weeklySchedule).some(
                    (day: any) => day && day.branchId === bookingToConfirm.branchId
                  );
                }
                return false;
              });
            }

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

        let servicesData: any[] = [];
        let staffData: any[] = [];

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

  const onAction = async (rowId: string, action: "Confirm" | "Cancel" | "Complete") => {
    try {
      // Prevent actions on cancelled bookings
      const row = rows.find((r) => r.id === rowId);
      if (row && normalizeBookingStatus(row.status ?? null) === "Canceled" && action !== "Cancel") {
        alert("This booking has been cancelled and cannot be updated.");
        return;
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

  const [downloadingPdf, setDownloadingPdf] = useState<string | null>(null);
  const [pdfConfirmBookingId, setPdfConfirmBookingId] = useState<string | null>(null);

  const handleDownloadPDF = (bookingId: string) => {
    setPdfConfirmBookingId(bookingId);
  };

  const confirmDownloadPDF = async () => {
    const bookingId = pdfConfirmBookingId;
    setPdfConfirmBookingId(null);
    if (!bookingId) return;
    try {
      setDownloadingPdf(bookingId);
      const user = auth.currentUser;
      if (!user) return;
      const token = await user.getIdToken();
      const res = await fetch(`/api/bookings/${bookingId}/pdf`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        let message = `Failed to download PDF (${res.status})`;
        try {
          const errorJson = await res.json();
          if (errorJson?.error) message = `${message}: ${errorJson.error}`;
        } catch {
          /* ignore */
        }
        throw new Error(message);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const disposition = res.headers.get("Content-Disposition");
      const match = disposition?.match(/filename="?([^"]+)"?/);
      a.download = match?.[1] || `Job-Report-${bookingId}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("PDF download error:", err);
      // eslint-disable-next-line no-alert
      alert(err instanceof Error ? err.message : "Failed to download PDF");
    } finally {
      setDownloadingPdf(null);
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
                              {(previewRow.vehicleNumber || previewRow.vehicleBodyType) && (
                                <div className="flex flex-wrap gap-1.5 mt-1.5">
                                  {previewRow.vehicleNumber && (
                                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-neutral-800 text-white text-xs font-mono font-semibold">
                                      <i className="fas fa-id-card text-[9px] opacity-80" />
                                      {previewRow.vehicleNumber}
                                    </span>
                                  )}
                                  {previewRow.vehicleBodyType && (
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
                                { label: "Body Type", value: previewRow.vehicleBodyType, icon: "fa-shapes" },
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
                              <div>
                                <p className="text-[10px] font-bold text-emerald-600 uppercase tracking-widest">Vehicle Check-In</p>
                                <p className="text-sm font-semibold text-neutral-800">Recorded by staff at drop-off</p>
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
                                    {previewRow.mileageRecordedByStaffName && (
                                      <p className="text-[10px] text-neutral-500 mt-0.5">by {previewRow.mileageRecordedByStaffName}</p>
                                    )}
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
                                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[10px] font-semibold bg-amber-50 text-amber-700 border border-amber-200">
                                                <i className="fas fa-clock" /> Awaiting Customer
                                              </span>
                                            );
                                          })()}
                                        </div>
                                      ) : (
                                        <div className="flex flex-col items-end gap-1">
                                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[10px] font-semibold bg-amber-50 text-amber-700 border border-amber-200">
                                            <i className="fas fa-hourglass-half" /> Pending
                                          </span>
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
                        const doneCount = previewRow.tasks.filter(t => t.done).length;
                        const totalCount = previewRow.tasks.length;
                        const pct = previewRow.taskProgress || 0;
                        const isComplete = pct === 100;
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

                            {/* Segmented progress steps */}
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

                          {/* Task list */}
                          <div className="space-y-3">
                            {previewRow.tasks.map((task, idx) => (
                              <div key={task.id || idx} className={`rounded-xl border p-4 transition-all ${
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
                                      <span className="text-[10px] font-bold">{idx + 1}</span>
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
                                    {task.serviceName && (
                                      <p className="text-[11px] text-neutral-400 mt-1">
                                        <i className="fas fa-magic mr-1 text-[9px]" />{task.serviceName}
                                      </p>
                                    )}
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
                            ))}
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
                        onClick={() => previewRow && handleDownloadPDF(previewRow.id)}
                        disabled={downloadingPdf === previewRow?.id}
                        className="px-4 py-2 rounded-full text-sm font-semibold inline-flex items-center gap-2 bg-gradient-to-r from-neutral-800 to-neutral-900 hover:from-neutral-900 hover:to-black text-white shadow-sm disabled:opacity-60 mr-auto"
                      >
                        {downloadingPdf === previewRow?.id ? <i className="fas fa-spinner fa-spin" /> : <i className="fas fa-file-pdf" />}
                        {downloadingPdf === previewRow?.id ? "Generating..." : "Download Job Report"}
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
                              <span className="text-xs font-semibold text-neutral-700 truncate">{svc.name || "Service"}</span>
                              {showStaffColumn && (svc.staffName ? <span className="ml-auto text-[10px] text-purple-600 font-medium truncate"><i className="far fa-user text-[8px] mr-0.5" />{svc.staffName}</span> : <span className="ml-auto text-[10px] text-amber-600 font-medium"><i className="fas fa-user-plus text-[8px] mr-0.5" />Unassigned</span>)}
                            </div>
                          ))}
                        </div>
                      ) : r.serviceName && (
                        <div className="mt-3 flex items-center gap-2 py-1 px-2.5 rounded-lg bg-neutral-50 border border-neutral-100">
                          <i className="fas fa-spa text-[10px] text-neutral-500" />
                          <span className="text-xs font-semibold text-neutral-700">{r.serviceName}</span>
                          {showStaffColumn && r.staffName && !["Any Available", "Any Staff", "Not Assigned Yet"].includes(String(r.staffName)) && (
                            <span className="ml-auto text-[10px] text-purple-600 font-medium"><i className="far fa-user text-[8px] mr-0.5" />{r.staffName}</span>
                          )}
                        </div>
                      )}

                      {/* Vehicle (make, model, body type) - 3 lines with labels */}
                      <div className="mt-2 rounded-lg bg-neutral-50 border border-neutral-100 px-3 py-2">
                        {[r.vehicleMake, r.vehicleModel, r.vehicleBodyType].filter(Boolean).length > 0 ? (
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
                              <span className="text-[9px] font-semibold text-neutral-400 uppercase w-10 shrink-0">Body</span>
                              <span className="text-[11px] text-neutral-600 truncate">{r.vehicleBodyType || "N/A"}</span>
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
                            onClick={() => handleDownloadPDF(r.id)}
                            disabled={downloadingPdf === r.id}
                            className="text-neutral-400 hover:text-neutral-700 transition h-8 w-8 rounded-full flex items-center justify-center disabled:opacity-50"
                            title="Download Job Report PDF"
                          >
                            <i className={`fas ${downloadingPdf === r.id ? "fa-spinner fa-spin" : "fa-file-pdf"} text-sm`} />
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
                <table className="min-w-[900px] w-full text-left text-sm text-neutral-600">
                  <thead className="bg-neutral-50/90 backdrop-blur text-neutral-800 font-semibold border-b border-neutral-100 sticky top-0 z-10">
                  <tr>
                    <th className="p-4 pl-6">Client &amp; Service</th>
                    <th className="p-4">Date &amp; Time</th>
                    <th className="p-4 min-w-[150px]">Vehicle</th>
                    <th className="p-4">Branch</th>
                    {showStaffColumn && <th className="p-4 min-w-[100px]">Staff</th>}
                    <th className="p-4 text-right pr-6">Price</th>
                    <th className="p-4 text-right pr-6">Actions</th>
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
                        <td className="p-4 pl-6 align-middle">
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
                                    
                                    return (
                                      <div key={idx} className="flex items-center justify-between py-1 px-2 rounded-lg bg-neutral-50 border border-neutral-100">
                                        <div className="flex items-center gap-2 min-w-0">
                                          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-white border border-neutral-200 shadow-sm">
                                            <i className="fas fa-spa text-[10px] text-neutral-600" />
                                            <span className="text-xs font-semibold text-neutral-800">{svc.name || "Service"}</span>
                                          </span>
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
                                  <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-white border border-neutral-200 shadow-sm">
                                    <i className="fas fa-spa text-[10px] text-neutral-600" />
                                    <span className="text-xs font-semibold text-neutral-800">{r.serviceName || "Service"}</span>
                                  </span>
                                </div>
                              )}
                            </div>
                            {/* Task progress mini bar - only show after confirmation */}
                            {r.status !== "Pending" && r.status !== "AwaitingStaffApproval" && r.status !== "PartiallyApproved" && r.status !== "StaffRejected" && r.tasks && r.tasks.length > 0 && (() => {
                              const done = r.tasks.filter(t => t.done).length;
                              const total = r.tasks.length;
                              const pct = r.taskProgress || 0;
                              const isComplete = pct === 100;
                              return (
                              <div className="mt-1.5 px-2">
                                <div className="flex items-center gap-1.5">
                                  {/* Segmented mini dots */}
                                  <div className="flex-1 flex items-center gap-0.5">
                                    {r.tasks.map((task, ti) => (
                                      <div key={task.id || ti} className="flex-1">
                                        <div className={`h-1.5 rounded-full transition-all duration-500 ${
                                          task.done
                                            ? isComplete
                                              ? "bg-emerald-500"
                                              : "bg-amber-500"
                                            : "bg-neutral-200"
                                        }`} />
                                      </div>
                                    ))}
                                  </div>
                                  {/* Mini circular gauge */}
                                  <div className="relative w-5 h-5 shrink-0">
                                    <svg className="w-5 h-5 -rotate-90" viewBox="0 0 20 20">
                                      <circle cx="10" cy="10" r="7" fill="none" stroke="#f5f5f5" strokeWidth="2" />
                                      <circle
                                        cx="10" cy="10" r="7" fill="none"
                                        stroke={isComplete ? "#10b981" : pct > 50 ? "#f59e0b" : "#3b82f6"}
                                        strokeWidth="2"
                                        strokeLinecap="round"
                                        strokeDasharray={`${pct * 0.44} 44`}
                                        className="transition-all duration-700 ease-out"
                                      />
                                    </svg>
                                    {isComplete && (
                                      <span className="absolute inset-0 flex items-center justify-center">
                                        <i className="fas fa-check text-emerald-500 text-[5px]" />
                                      </span>
                                    )}
                                  </div>
                                  <span className={`text-[9px] font-bold shrink-0 ${isComplete ? "text-emerald-600" : "text-neutral-500"}`}>
                                    {done}/{total}
                                  </span>
                                </div>
                              </div>
                              );
                            })()}
                            </div>
                          </div>
                        </td>
                        <td className="p-4 align-middle">
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
                          <div className="min-w-[130px] max-w-[160px] rounded-lg bg-neutral-50 border border-neutral-100 px-2.5 py-2">
                            {[r.vehicleMake, r.vehicleModel, r.vehicleBodyType].filter(Boolean).length > 0 ? (
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
                                  <span className="text-[9px] font-semibold text-neutral-400 uppercase w-12 shrink-0">Body</span>
                                  <span className="text-neutral-600 truncate" title={r.vehicleBodyType || "N/A"}>{r.vehicleBodyType || "N/A"}</span>
                                </div>
                              </div>
                            ) : (
                              <span className="text-[11px] text-neutral-400">N/A</span>
                            )}
                          </div>
                        </td>
                        <td className="p-4 align-middle">{r.branchName || "-"}</td>
                        {showStaffColumn && (
                        <td className="p-4 align-middle">
                          {(() => {
                            const staffNames = r.services && r.services.length > 0
                              ? [...new Set(r.services.map(s => s.staffName).filter(Boolean).filter(n => !["Any Available", "Any Staff", "Not Assigned Yet"].includes(String(n))))]
                              : (r.staffName && !["Any Available", "Any Staff", "Not Assigned Yet"].includes(String(r.staffName))) ? [r.staffName] : [];
                            return staffNames.length > 0 ? (
                              <span className="inline-flex items-center gap-1 text-sm font-medium text-neutral-700" title={staffNames.join(", ")}>
                                <i className="fas fa-user text-neutral-400 text-[10px]" />
                                {staffNames.join(", ")}
                              </span>
                            ) : (
                              <span className="text-neutral-400 text-sm">—</span>
                            );
                          })()}
                        </td>
                        )}
                        <td className="p-4 align-middle text-right pr-6">
                          <span className="inline-flex items-center gap-1 font-bold text-neutral-800">
                            <i className="fas fa-dollar-sign text-neutral-400" />
                            {r.price}
                          </span>
                        </td>
                        <td className="p-4 align-middle text-right pr-6">
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
                                aria-label="Download Job Report"
                                title="Download Job Report PDF"
                                onClick={() => handleDownloadPDF(r.id)}
                                disabled={downloadingPdf === r.id}
                                className="hidden sm:inline-flex text-neutral-400 hover:text-neutral-900 transition transform hover:scale-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 rounded-full h-8 w-8 items-center justify-center disabled:opacity-50"
                              >
                                <i className={`fas ${downloadingPdf === r.id ? "fa-spinner fa-spin" : "fa-file-pdf"}`} />
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
                              {rowActions.includes("Cancel" as any) && (
                                <button
                                  disabled={!!updatingState[r.id]}
                                  onClick={() => onAction(r.id, "Cancel")}
                                  className={`px-3 py-1.5 rounded-full text-xs font-semibold transition inline-flex items-center gap-1 ${updatingState[r.id] === "Cancel" ? "bg-rose-300 text-white" : "bg-gradient-to-r from-rose-500 to-red-600 hover:from-rose-600 hover:to-red-700 text-white shadow-sm"}`}
                                  aria-busy={!!updatingState[r.id]}
                                >
                                  {updatingState[r.id] === "Cancel" ? <i className="fas fa-spinner fa-spin" /> : <i className="fas fa-ban" />}
                                  {updatingState[r.id] === "Cancel" ? "Cancelling..." : "Cancel"}
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
            className="relative bg-white rounded-2xl shadow-2xl max-w-md w-full animate-scale-in overflow-hidden z-10"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="bg-gradient-to-r from-emerald-500 to-green-600 p-5">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 bg-white/20 backdrop-blur-sm rounded-xl flex items-center justify-center">
                  <i className="fas fa-user-plus text-white text-xl"></i>
                </div>
                <div>
                  <h3 className="text-lg font-bold text-white">Assign Staff Member</h3>
                  <p className="text-white/80 text-sm">Select a staff member to confirm booking</p>
                </div>
              </div>
            </div>

            {/* Content */}
            <div className="p-6">
              {/* Booking Details */}
              <div className="mb-6 p-4 bg-neutral-50 rounded-lg">
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-10 h-10 rounded-full bg-neutral-900 text-white flex items-center justify-center text-sm font-bold">
                    {(bookingToConfirm.client || "?").split(" ").map(s => s[0]).slice(0,2).join("")}
                  </div>
                  <div>
                    <p className="font-semibold text-neutral-900">{bookingToConfirm.client}</p>
                    <p className="text-xs text-neutral-500">{bookingToConfirm.serviceName || "Service"}</p>
                  </div>
                </div>
                <div className="flex items-center gap-4 text-xs text-neutral-600">
                  <span><i className="far fa-calendar mr-1"></i>{bookingToConfirm.date}</span>
                  <span><i className="far fa-clock mr-1"></i>{bookingToConfirm.time}</span>
                  {bookingToConfirm.branchName && <span><i className="fas fa-store mr-1"></i>{bookingToConfirm.branchName}</span>}
                </div>
                {bookingToConfirm.notes && bookingToConfirm.notes.trim() && (
                  <div className="mt-3 p-3 bg-amber-50 rounded-lg border border-amber-200">
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
                      <div className="space-y-4 max-h-96 overflow-y-auto">
                        {bookingToConfirm.services
                          .map((service) => {
                            const serviceKey = String(service.id || service.serviceId || service.name);
                            const serviceStaff = availableStaffPerService[serviceKey] || [];
                            const selectedStaff = selectedStaffPerService[serviceKey];
                            
                            return (
                              <div key={serviceKey} className="border-2 border-purple-200 rounded-xl p-4 bg-purple-50/50">
                                <div className="mb-3 flex items-center gap-2">
                                  <i className="fas fa-spa text-purple-600"></i>
                                  <h4 className="font-bold text-neutral-800">{service.name}</h4>
                                  <span className="text-xs text-neutral-500 ml-auto">{service.duration} min</span>
                                </div>
                                
                                {serviceStaff.length === 0 ? (
                                  <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-amber-800 text-xs">
                                    <i className="fas fa-exclamation-triangle mr-2"></i>
                                    No qualified staff available for this service
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
                                            ? "border-emerald-500 bg-emerald-50 shadow-sm"
                                            : "border-neutral-200 hover:border-emerald-300 hover:bg-white"
                                        }`}
                                      >
                                        <div className="flex items-center gap-2">
                                          <div className={`w-8 h-8 rounded-full overflow-hidden flex-shrink-0 border-2 ${
                                            selectedStaff === staff.id ? "border-emerald-500" : "border-neutral-200"
                                          }`}>
                                            <img
                                              src={`https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(staff.avatar || staff.name)}`}
                                              alt={staff.name}
                                              className="w-full h-full object-cover"
                                            />
                                          </div>
                                          <div className="flex-1">
                                            <p className={`font-semibold text-sm ${
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
                            No available staff members found for this branch.
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
            <div className="bg-neutral-50 px-6 py-4 flex gap-3 justify-end border-t border-neutral-200">
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

      {/* ─── PDF Download Confirmation Modal ────────────────────────── */}
      {pdfConfirmBookingId && (
        <div className="fixed inset-0 z-[9998] flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in">
          <div className="bg-white rounded-2xl shadow-2xl max-w-sm w-full mx-4 overflow-hidden animate-scale-in">
            <div className="bg-neutral-900 px-6 py-4 flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-white/10 flex items-center justify-center">
                <i className="fas fa-file-pdf text-white" />
              </div>
              <h3 className="text-white font-semibold">Download Job Report</h3>
            </div>
            <div className="px-6 py-5">
              <p className="text-neutral-600 text-sm leading-relaxed">
                Do you want to download the complete job task report as a PDF? This includes all booking details, services, and task information.
              </p>
            </div>
            <div className="px-6 pb-5 flex items-center justify-end gap-3">
              <button
                onClick={() => setPdfConfirmBookingId(null)}
                className="px-4 py-2 rounded-full text-sm font-semibold bg-neutral-100 hover:bg-neutral-200 text-neutral-700 transition"
              >
                Cancel
              </button>
              <button
                onClick={confirmDownloadPDF}
                className="px-5 py-2 rounded-full text-sm font-semibold bg-neutral-900 hover:bg-black text-white shadow-sm transition inline-flex items-center gap-2"
              >
                <i className="fas fa-download text-xs" />
                Download PDF
              </button>
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