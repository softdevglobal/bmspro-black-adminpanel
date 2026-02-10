"use client";

import React, { useEffect, useMemo, useState } from "react";
import { auth, db } from "@/lib/firebase";
import { collection, onSnapshot, query, where } from "firebase/firestore";
import type { BookingStatus } from "@/lib/bookingTypes";
import { normalizeBookingStatus, getStatusLabel, getStatusColor } from "@/lib/bookingTypes";
import Sidebar from "@/components/Sidebar";
import { updateBookingStatus } from "@/lib/bookings";

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
  duration: number;
  price: number;
  clientEmail?: string | null;
  clientPhone?: string | null;
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
      const ownerUid = userRole === "salon_owner" ? userId : (userData?.ownerUid || userId);
      const userBranchId = userData?.branchId;
      
      // Build query constraints
      const constraints = [where("ownerUid", "==", ownerUid)];
      
      // Branch admin should only see bookings for their branch
      if (userRole === "salon_branch_admin" && userBranchId) {
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
              duration: Number(d.duration || 0),
              price: Number(d.price || 0),
              clientEmail: d.clientEmail || null,
              clientPhone: d.clientPhone || null,
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

export default function BookingsListByStatus({ status, title }: { status: BookingStatus | BookingStatus[]; title: string }) {
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
        const ownerUid = userRole === "salon_owner" ? userId : (userData?.ownerUid || userId);

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
              
              // CRITICAL: Filter by service qualification
              if (qualifiedStaffIds.length > 0) {
                filtered = filtered.filter((s: any) => qualifiedStaffIds.includes(String(s.id)));
              }
              
              // Filter by branch and day
              if (bookingToConfirm.branchId && bookingToConfirm.date) {
                const bookingDate = new Date(bookingToConfirm.date);
                const daysOfWeek = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
                const dayName = daysOfWeek[bookingDate.getDay()];
                
                filtered = filtered.filter((s: any) => {
                  if (s.weeklySchedule && typeof s.weeklySchedule === 'object') {
                    const daySchedule = s.weeklySchedule[dayName];
                    if (daySchedule && daySchedule.branchId) {
                      return daySchedule.branchId === bookingToConfirm.branchId;
                    }
                    if (daySchedule === null || daySchedule === undefined) {
                      return false;
                    }
                  }
                  return s.branchId === bookingToConfirm.branchId;
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

            // CRITICAL: Filter by service qualification
            if (qualifiedStaffIds.length > 0) {
              filtered = filtered.filter((s: any) => qualifiedStaffIds.includes(String(s.id)));
            }

            if (bookingToConfirm.branchId && bookingToConfirm.date) {
              const bookingDate = new Date(bookingToConfirm.date);
              const daysOfWeek = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
              const dayName = daysOfWeek[bookingDate.getDay()];

              filtered = filtered.filter((s: any) => {
                if (s.weeklySchedule && typeof s.weeklySchedule === 'object') {
                  const daySchedule = s.weeklySchedule[dayName];
                  if (daySchedule && daySchedule.branchId) {
                    return daySchedule.branchId === bookingToConfirm.branchId;
                  }
                  if (daySchedule === null || daySchedule === undefined) {
                    return false;
                  }
                }
                return s.branchId === bookingToConfirm.branchId;
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
        const ownerUid = userRole === "salon_owner" ? userId : (userData?.ownerUid || userId);

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
                bs.staffName === "Any Staff"
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
        !s.staffId || s.staffId === "null" || s.staffName === "Any Available" || s.staffName === "Any Staff"
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
      if (!row.staffId || row.staffId === "null" || row.staffName === "Any Available" || row.staffName === "Any Staff") {
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

  return (
    <div className="flex h-screen overflow-hidden bg-white">
      {/* Mobile Sidebar Overlay */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-[100] md:hidden">
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setSidebarOpen(false)} />
          <div className="relative h-full w-64 bg-slate-900 shadow-2xl">
            <Sidebar mobile onClose={() => setSidebarOpen(false)} />
          </div>
        </div>
      )}
      
      {/* Desktop Sidebar */}
      <Sidebar />
      
      <div className="flex-1 flex flex-col overflow-hidden">
        <main className="flex-1 overflow-auto p-4 sm:p-6 lg:p-8 bg-slate-50">
          <div className="max-w-7xl mx-auto">
            <div className="mb-8">
              <div className="rounded-2xl bg-gradient-to-r from-pink-500 via-fuchsia-600 to-indigo-600 text-white p-6 shadow-sm">
                <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                    {/* Mobile Menu Button */}
                    <button 
                      onClick={() => setSidebarOpen(true)}
                      className="md:hidden p-2 -ml-2 hover:bg-white/20 rounded-lg transition-colors"
                    >
                      <i className="fas fa-bars text-xl"></i>
                    </button>
                  <div className="w-10 h-10 rounded-xl bg-white/20 flex items-center justify-center">
                    <i className="fas fa-calendar-check" />
                    </div>
                    <h1 className="text-xl sm:text-2xl font-bold">{title}</h1>
                  </div>
                </div>
              </div>
            </div>

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
                className={`absolute top-0 h-full right-0 w-[92vw] sm:w-[30rem] bg-white shadow-2xl border-l border-slate-200 transform transition-transform duration-200 ${previewOpen ? "translate-x-0" : "translate-x-full"}`}
              >
                <div className="flex h-full flex-col">
                  <div className="p-0 border-b border-slate-200">
                    <div className="bg-gradient-to-r from-pink-500 via-fuchsia-600 to-indigo-600 p-5 text-white flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-xl bg-white/20 flex items-center justify-center">
                          <i className="fas fa-eye" />
                        </div>
                        <h3 className="text-lg font-semibold">Booking Preview</h3>
                      </div>
                      <button onClick={closePreview} className="text-white/80 hover:text-white">
                        <i className="fas fa-times" />
                      </button>
                    </div>
                  </div>
                  <div className="flex-1 p-5 space-y-4 overflow-y-auto">
                  {!previewRow && <div className="text-slate-500 text-sm">No booking selected.</div>}
                  {previewRow && (
                    <div className="space-y-4 text-sm">
                      <div className="flex items-center gap-3">
                        <div className="w-12 h-12 rounded-full bg-gradient-to-br from-pink-500 to-fuchsia-600 text-white flex items-center justify-center text-sm font-bold shadow-md">
                          {(previewRow.client || "?").split(" ").map(s => s[0]).slice(0,2).join("")}
                        </div>
                        <div className="flex-1">
                          <p className="font-semibold text-slate-900">{previewRow.client}</p>
                          <div className="flex flex-wrap gap-2 mt-1">
                            {previewRow.clientEmail && <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-slate-100 text-slate-700"><i className="fas fa-envelope" />{previewRow.clientEmail}</span>}
                            {previewRow.clientPhone && <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-slate-100 text-slate-700"><i className="fas fa-phone" />{previewRow.clientPhone}</span>}
                          </div>
                        </div>
                      </div>
                      
                      <div className="rounded-xl border border-slate-200 p-3 bg-slate-50/50">
                        <div className="flex items-center justify-between">
                          <span className="text-slate-500 text-xs uppercase tracking-wide">Booking Code</span>
                          <span className="font-mono font-bold text-slate-800">{previewRow.bookingCode || previewRow.id.substring(0, 8)}</span>
                        </div>
                        {previewRow.bookingSource && (
                          <div className="flex items-center justify-between mt-2 pt-2 border-t border-slate-200">
                            <span className="text-slate-500 text-xs uppercase tracking-wide">Source</span>
                            <span className={`text-xs font-semibold px-2 py-1 rounded-full ${
                              previewRow.bookingSource === "booking_engine" 
                                ? "bg-blue-100 text-blue-700" 
                                : previewRow.bookingSource.includes("Branch Admin")
                                ? "bg-emerald-100 text-emerald-700"
                                : previewRow.bookingSource.includes("Owner")
                                ? "bg-purple-100 text-purple-700"
                                : previewRow.bookingSource.includes("Staff")
                                ? "bg-amber-100 text-amber-700"
                                : "bg-slate-100 text-slate-700"
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
                          <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider">Services</h4>
                          {previewRow.services && previewRow.services.length > 1 && (
                            <span className="text-[10px] bg-slate-100 text-slate-500 px-2 py-0.5 rounded-full">
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
                              needs_assignment: { bg: "bg-purple-100", text: "text-purple-700", icon: "fa-user-plus", label: "Needs Staff", border: "border-purple-200" },
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
                              "border-slate-200 hover:border-pink-200"
                            }`}>
                              <div className={`absolute left-0 top-0 bottom-0 w-1 ${
                                approvalStatus === "rejected" ? "bg-gradient-to-b from-rose-500 to-red-500" :
                                approvalStatus === "needs_assignment" ? "bg-gradient-to-b from-purple-500 to-violet-500" :
                                isConfirmed && isServiceCompleted ? "bg-gradient-to-b from-indigo-500 to-purple-500" :
                                approvalStatus === "accepted" ? "bg-gradient-to-b from-emerald-500 to-green-500" :
                                "bg-gradient-to-b from-pink-500 to-purple-500 opacity-0 group-hover:opacity-100"
                              } transition-opacity`} />
                              <div className="flex justify-between items-start mb-1.5">
                                <div className="font-bold text-slate-800 text-sm flex items-center gap-2">
                                   <div className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 ${
                                     approvalStatus === "rejected" ? "bg-rose-50 text-rose-500" :
                                     isConfirmed && isServiceCompleted ? "bg-indigo-50 text-indigo-500" :
                                     approvalStatus === "accepted" ? "bg-emerald-50 text-emerald-500" :
                                     "bg-pink-50 text-pink-500"
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
                                  {svc.price !== undefined && <div className="font-bold text-slate-900 text-sm">${svc.price}</div>}
                                </div>
                              </div>
                              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-slate-500 pl-7">
                                 <div className="flex items-center gap-1.5 bg-slate-50 px-2 py-1 rounded-md">
                                    <i className="far fa-clock text-pink-400" />
                                    <span className="font-medium text-slate-700">{svc.time || previewRow.time}</span>
                                    {svc.duration && <span className="text-slate-400">({svc.duration}m)</span>}
                                 </div>
                                 <div className="flex items-center gap-1.5 bg-slate-50 px-2 py-1 rounded-md">
                                    <i className="far fa-user text-purple-400" />
                                    <span className="font-medium text-slate-700">{svc.staffName || previewRow.staffName || "Any Staff"}</span>
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
                      
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <p className="text-slate-400">Date & Time</p>
                          <p className="font-medium text-slate-700 flex items-center gap-2">
                            <i className="fas fa-clock text-slate-400" />
                            {previewRow.date} {previewRow.time}
                          </p>
                        </div>
                        <div>
                          <p className="text-slate-400">Duration</p>
                          <p className="font-medium text-slate-700">{previewRow.duration} mins</p>
                        </div>
                      </div>
                      <div>
                        <p className="text-slate-400">Branch</p>
                        <p className="font-medium text-slate-700 flex items-center gap-2">
                          <i className="fas fa-store text-slate-400" />
                          {previewRow.branchName || "-"}
                        </p>
                      </div>
                      <div>
                        <p className="text-slate-400">Status</p>
                        <p className="inline-flex items-center gap-2 px-2 py-1 text-xs rounded-full bg-slate-100 text-slate-700">
                          <i className="fas fa-circle text-[8px] text-slate-400" />
                          {previewRow.status || status}
                        </p>
                      </div>
                      <div>
                        <p className="text-slate-400">Price</p>
                        <p className="font-semibold text-slate-800 flex items-center gap-1"><i className="fas fa-dollar-sign text-slate-400" />{previewRow.price}</p>
                      </div>
                      {previewRow.notes && (
                        <div>
                          <p className="text-slate-400">Notes</p>
                          <p className="text-slate-700 whitespace-pre-wrap">{previewRow.notes}</p>
                        </div>
                      )}
                    </div>
                  )}
                  </div>
                  <div className="shrink-0 border-t border-slate-200 p-4 flex items-center justify-end gap-2 bg-white/90 backdrop-blur">
                    <button
                      onClick={closePreview}
                      className="px-3 py-1.5 rounded-full text-xs font-semibold bg-slate-100 hover:bg-slate-200 text-slate-700"
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

            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
              <div className="relative overflow-x-auto">
                <table className="min-w-[960px] w-full text-left text-sm text-slate-600">
                  <thead className="bg-slate-50/90 backdrop-blur text-slate-800 font-semibold border-b border-slate-100 sticky top-0 z-10">
                  <tr>
                    <th className="p-4 pl-6">Client &amp; Service</th>
                    <th className="p-4">Date &amp; Time</th>
                    <th className="p-4">Staff</th>
                    <th className="p-4">Branch</th>
                    <th className="p-4 text-right pr-6">Price</th>
                    <th className="p-4 text-right pr-6">Actions</th>
                  </tr>
                  </thead>
                  <tbody>
                  {loading && (
                    <tr>
                      <td className="p-6 text-slate-500" colSpan={5}>Loading...</td>
                    </tr>
                  )}
                  {!loading && error && (
                    <tr>
                      <td className="p-6 text-rose-600" colSpan={6}>{error}</td>
                    </tr>
                  )}
                  {!loading && rows.length === 0 && (
                    <tr>
                      <td className="p-6 text-slate-500" colSpan={6}>No bookings.</td>
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
                      <tr key={r.id} className="hover:bg-slate-50 transition">
                        <td className="p-4 pl-6">
                          <div className="flex items-center gap-3">
                            <div className="w-9 h-9 rounded-full bg-gradient-to-br from-pink-500 to-fuchsia-600 text-white flex items-center justify-center text-xs font-bold shadow-sm">
                              {initials || <i className="fas fa-user" />}
                            </div>
                            <div className="flex items-center gap-2">
                              <div>
                                <div className="font-semibold text-slate-800">{r.client}</div>
                                {r.bookingCode && (
                                  <div className="text-xs text-slate-500 font-mono mt-0.5">{r.bookingCode}</div>
                                )}
                              </div>
                              {/* Mobile-first preview trigger (visible before horizontal scroll) */}
                              <button
                                aria-label="Preview"
                                title="Preview"
                                onClick={() => openPreview(r)}
                                className="sm:hidden text-slate-400 hover:text-pink-600 transition transform hover:scale-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-pink-500 rounded-full h-7 w-7 inline-flex items-center justify-center"
                              >
                                <i className="fas fa-eye text-[13px]" />
                              </button>
                            </div>
                            {/* Service List Display - Each service on its own line */}
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
                                      needs_assignment: { bg: "bg-purple-100", text: "text-purple-700", icon: "fa-user-plus", label: "Needs Staff" },
                                    };
                                    const approvalBadge = tableBadgeMap[approvalStatus] || tableBadgeMap.pending;
                                    
                                    return (
                                      <div key={idx} className="flex items-center justify-between py-1 px-2 rounded-lg bg-slate-50 border border-slate-100">
                                        <div className="flex items-center gap-2 min-w-0">
                                          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-white border border-slate-200 shadow-sm">
                                            <i className="fas fa-spa text-[10px] text-pink-500" />
                                            <span className="text-xs font-semibold text-slate-800">{svc.name || "Service"}</span>
                                          </span>
                                          <i className="fas fa-user text-[9px] text-slate-400" />
                                          <span className="text-xs font-medium text-slate-600 truncate">{svc.staffName || "Any Staff"}</span>
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
                                <div className="flex items-center gap-2 py-1 px-2 rounded-lg bg-slate-50 border border-slate-100">
                                  <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-white border border-slate-200 shadow-sm">
                                    <i className="fas fa-spa text-[10px] text-pink-500" />
                                    <span className="text-xs font-semibold text-slate-800">{r.serviceName || "Service"}</span>
                                  </span>
                                </div>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="p-4">
                          <div className="font-medium text-slate-700">{r.date}</div>
                          <div className="text-xs text-slate-500">{r.time}</div>
                        </td>
                        {/* Staff Column - show all staff names in one line */}
                        <td className="p-4">
                          {(() => {
                            // Determine staff display from services
                            if (r.services && r.services.length > 0) {
                              const staffNames: string[] = [];
                              r.services.forEach((s: any) => {
                                const name = s.staffName;
                                if (name && name !== "Any Available" && name !== "Any Staff" && name !== "null") {
                                  if (!staffNames.includes(name)) {
                                    staffNames.push(name);
                                  }
                                }
                              });
                              
                              // Check if any service needs assignment
                              const hasUnassigned = r.services.some((s: any) => 
                                !s.staffId || s.staffName === "Any Available" || s.staffName === "Any Staff" || s.approvalStatus === "needs_assignment"
                              );
                              
                              if (staffNames.length === 0) {
                                return <span className="text-xs font-medium text-slate-500 italic">Any Available</span>;
                              } else {
                                return (
                                  <div className="flex flex-col">
                                    <span className="text-xs font-medium text-slate-700">{staffNames.join(", ")}</span>
                                    {hasUnassigned && (
                                      <span className="text-[10px] text-purple-600 font-medium">+ Needs Assignment</span>
                                    )}
                                  </div>
                                );
                              }
                            }
                            return <span>{r.staffName || "-"}</span>;
                          })()}
                        </td>
                        <td className="p-4">{r.branchName || "-"}</td>
                        <td className="p-4 text-right pr-6">
                          <span className="inline-flex items-center gap-1 font-bold text-slate-800">
                            <i className="fas fa-dollar-sign text-slate-400" />
                            {r.price}
                          </span>
                        </td>
                        <td className="p-4 text-right pr-6">
                          <div className="inline-flex items-center gap-2 justify-end bg-slate-100/60 rounded-full px-2 py-1">
                            {/* Status Badge */}
                            <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${statusColor}`}>
                              {statusLabel}
                            </span>
                            <button
                              aria-label="Preview"
                              title="Preview"
                              onClick={() => openPreview(r)}
                              className="hidden sm:inline-flex text-slate-400 hover:text-pink-600 transition transform hover:scale-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-pink-500 rounded-full h-8 w-8 items-center justify-center"
                            >
                              <i className="fas fa-eye" />
                            </button>
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
              <div className="mb-6 p-4 bg-slate-50 rounded-lg">
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-10 h-10 rounded-full bg-gradient-to-br from-pink-500 to-fuchsia-600 text-white flex items-center justify-center text-sm font-bold">
                    {(bookingToConfirm.client || "?").split(" ").map(s => s[0]).slice(0,2).join("")}
                  </div>
                  <div>
                    <p className="font-semibold text-slate-900">{bookingToConfirm.client}</p>
                    <p className="text-xs text-slate-500">{bookingToConfirm.serviceName || "Service"}</p>
                  </div>
                </div>
                <div className="flex items-center gap-4 text-xs text-slate-600">
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
                    <span className="ml-3 text-slate-600">Loading staff...</span>
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
                                  <h4 className="font-bold text-slate-800">{service.name}</h4>
                                  <span className="text-xs text-slate-500 ml-auto">{service.duration} min</span>
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
                                            : "border-slate-200 hover:border-emerald-300 hover:bg-white"
                                        }`}
                                      >
                                        <div className="flex items-center gap-2">
                                          <div className={`w-8 h-8 rounded-full overflow-hidden flex-shrink-0 border-2 ${
                                            selectedStaff === staff.id ? "border-emerald-500" : "border-slate-200"
                                          }`}>
                                            <img
                                              src={`https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(staff.avatar || staff.name)}`}
                                              alt={staff.name}
                                              className="w-full h-full object-cover"
                                            />
                                          </div>
                                          <div className="flex-1">
                                            <p className={`font-semibold text-sm ${
                                              selectedStaff === staff.id ? "text-emerald-900" : "text-slate-800"
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
                        <label className="block text-sm font-semibold text-slate-700 mb-3">
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
                                    : "border-slate-200 hover:border-emerald-300 hover:bg-slate-50"
                                }`}
                              >
                                <div className="flex items-center gap-3">
                                  <div className={`w-10 h-10 rounded-full overflow-hidden flex-shrink-0 border-2 ${
                                    selectedStaffId === staff.id
                                      ? "border-emerald-500"
                                      : "border-slate-200"
                                  }`}>
                                    <img
                                      src={`https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(staff.avatar || staff.name)}`}
                                      alt={staff.name}
                                      className="w-full h-full object-cover"
                                    />
                                  </div>
                                  <div className="flex-1">
                                    <p className={`font-semibold ${
                                      selectedStaffId === staff.id ? "text-emerald-900" : "text-slate-800"
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
            <div className="bg-slate-50 px-6 py-4 flex gap-3 justify-end border-t border-slate-200">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setStaffAssignModalOpen(false);
                }}
                disabled={!!updatingState[bookingToConfirm.id]}
                className="px-4 py-2.5 rounded-lg text-slate-700 hover:bg-slate-200 font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-sm"
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
              <div className="mb-6 p-4 bg-slate-50 rounded-lg">
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-10 h-10 rounded-full bg-gradient-to-br from-pink-500 to-fuchsia-600 text-white flex items-center justify-center text-sm font-bold">
                    {(bookingToReassign.client || "?").split(" ").map(s => s[0]).slice(0,2).join("")}
                  </div>
                  <div>
                    <p className="font-semibold text-slate-900">{bookingToReassign.client}</p>
                    <p className="text-xs text-slate-500">{bookingToReassign.serviceName || "Service"}</p>
                  </div>
                </div>
                <div className="flex items-center gap-4 text-xs text-slate-600">
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
                    <span className="ml-3 text-slate-600">Loading available staff...</span>
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
                          s.staffName !== "Any Staff"
                        ).length > 0 && (
                          <div className="mb-4">
                            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">
                              <i className="fas fa-check-circle text-emerald-500 mr-1"></i>
                              Already Assigned (Customer Selected)
                            </p>
                            <div className="space-y-2">
                              {bookingToReassign.services.filter(s => 
                                (s.approvalStatus === "pending" || s.approvalStatus === "accepted") && 
                                s.staffId && 
                                s.staffName && 
                                s.staffName !== "Any Available" && 
                                s.staffName !== "Any Staff"
                              ).map((service) => (
                                <div key={String(service.id || service.name)} className="flex items-center justify-between p-3 rounded-lg bg-emerald-50 border border-emerald-200">
                                  <div className="flex items-center gap-2">
                                    <i className="fas fa-spa text-emerald-600 text-sm"></i>
                                    <span className="font-medium text-slate-800">{service.name}</span>
                                  </div>
                                  <div className="flex items-center gap-2">
                                    <span className="text-xs text-slate-500">{service.staffName}</span>
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
                          (!s.staffId || s.staffName === "Any Available" || s.staffName === "Any Staff")
                        ).length > 0 && (
                          <div>
                            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">
                              <i className="fas fa-user-plus text-amber-500 mr-1"></i>
                              Select New Staff For
                            </p>
                            {bookingToReassign.services
                              .filter(s => 
                                s.approvalStatus === "rejected" || 
                                s.approvalStatus === "needs_assignment" ||
                                (!s.staffId || s.staffName === "Any Available" || s.staffName === "Any Staff")
                              )
                              .map((service) => {
                                const serviceKey = String(service.id || service.serviceId || service.name);
                                const serviceStaff = availableStaffPerService[serviceKey] || [];
                                const selectedStaff = selectedStaffPerService[serviceKey];
                                
                                return (
                                  <div key={serviceKey} className="border-2 border-amber-200 rounded-xl p-4 bg-amber-50/50 mb-3">
                                    <div className="mb-3 flex items-center gap-2">
                                      <i className="fas fa-spa text-amber-600"></i>
                                      <h4 className="font-bold text-slate-800">{service.name}</h4>
                                      <span className="text-xs text-slate-500 ml-auto">{service.duration} min</span>
                                      {service.approvalStatus === "rejected" && (
                                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-rose-100 text-rose-700 text-xs font-semibold">
                                          <i className="fas fa-times text-[8px]"></i>
                                          Rejected
                                        </span>
                                      )}
                                      {(service.approvalStatus === "needs_assignment" || !service.staffId || service.staffName === "Any Available" || service.staffName === "Any Staff") && service.approvalStatus !== "rejected" && (
                                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-purple-100 text-purple-700 text-xs font-semibold">
                                          <i className="fas fa-user-clock text-[8px]"></i>
                                          Needs Staff
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
                                                : "border-slate-200 hover:border-amber-300 hover:bg-white"
                                            }`}
                                          >
                                            <div className="flex items-center gap-2">
                                              <div className={`w-8 h-8 rounded-full overflow-hidden flex-shrink-0 border-2 ${
                                                selectedStaff === staff.id ? "border-amber-500" : "border-slate-200"
                                              }`}>
                                                <img
                                                  src={`https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(staff.avatar || staff.name)}`}
                                                  alt={staff.name}
                                                  className="w-full h-full object-cover"
                                                />
                                              </div>
                                              <div className="flex-1">
                                                <p className={`font-semibold text-sm ${
                                                  selectedStaff === staff.id ? "text-amber-900" : "text-slate-800"
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
                        <label className="block text-sm font-semibold text-slate-700 mb-3">
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
                                    : "border-slate-200 hover:border-amber-300 hover:bg-slate-50"
                                }`}
                              >
                                <div className="flex items-center gap-3">
                                  <div className={`w-10 h-10 rounded-full overflow-hidden flex-shrink-0 border-2 ${
                                    selectedStaffId === staff.id
                                      ? "border-amber-500"
                                      : "border-slate-200"
                                  }`}>
                                    <img
                                      src={`https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(staff.avatar || staff.name)}`}
                                      alt={staff.name}
                                      className="w-full h-full object-cover"
                                    />
                                  </div>
                                  <div className="flex-1">
                                    <p className={`font-semibold ${
                                      selectedStaffId === staff.id ? "text-amber-900" : "text-slate-800"
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
            <div className="bg-slate-50 px-6 py-4 flex gap-3 justify-end border-t border-slate-200 shrink-0">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setReassignModalOpen(false);
                }}
                disabled={!!updatingState[bookingToReassign.id]}
                className="px-4 py-2.5 rounded-lg text-slate-700 hover:bg-slate-200 font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-sm"
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
                      (!s.staffId || s.staffName === "Any Available" || s.staffName === "Any Staff")
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