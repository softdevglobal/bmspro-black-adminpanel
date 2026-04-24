"use client";
import React, { useEffect, useState, useMemo, useCallback, Suspense } from "react";
import Sidebar from "@/components/Sidebar";
import { useRouter, useSearchParams } from "next/navigation";
import { onAuthStateChanged } from "firebase/auth";
import Script from "next/script";
import {
  subscribeServicesForOwner,
  VEHICLE_TYPES,
  VEHICLE_TYPE_LABELS,
  VEHICLE_TYPE_ICONS,
  isVehicleType,
  normalizeVehicleTypePricing,
  resolveServicePricingForVehicleType,
  minPricingFromVehicleTypePricing,
  type VehicleType,
  type VehicleTypePricingMap,
} from "@/lib/services";
import { subscribeSalonStaffForOwner } from "@/lib/salonStaff";
import { subscribeBranchesForOwner } from "@/lib/branches";
import { createBooking } from "@/lib/bookings";
import { collection, onSnapshot, query, where } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { shouldBlockSlots } from "@/lib/bookingTypes";
import { getCurrentDateTimeInTimezone } from "@/lib/timezone";
import BookingsExportButton from "@/components/bookings/BookingsExportButton";
import BookingsImportButton from "@/components/bookings/BookingsImportButton";

// Wrapper component to handle search params with Suspense
function BookingsPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [chartReady, setChartReady] = useState(false);
  const [autoOpenHandled, setAutoOpenHandled] = useState(false);
  const [bookingsUpdateKey, setBookingsUpdateKey] = useState(0); // Force re-render when bookings update

  // Booking wizard state
  const [bkStep, setBkStep] = useState<1 | 2 | 3>(1);
  const [bkBranchId, setBkBranchId] = useState<string | null>(null);
  const [bkSelectedServices, setBkSelectedServices] = useState<Array<number | string>>([]);
  const [bkServiceTimes, setBkServiceTimes] = useState<Record<string, string>>({});
  const [bkServiceStaff, setBkServiceStaff] = useState<Record<string, string>>({});
  const [bkMonthYear, setBkMonthYear] = useState<{ month: number; year: number }>(() => {
    const t = new Date();
    return { month: t.getMonth(), year: t.getFullYear() };
  });
  const [bkDate, setBkDate] = useState<Date | null>(null);
  const [bkClientName, setBkClientName] = useState<string>("");
  const [bkClientEmail, setBkClientEmail] = useState<string>("");
  const [bkClientPhone, setBkClientPhone] = useState<string>("");
  const [bkVehicleNumber, setBkVehicleNumber] = useState<string>("");
  /** Canonical vehicle size class that drives per-type pricing for the booking. */
  const [bkVehicleType, setBkVehicleType] = useState<VehicleType | null>(null);
  const [bkVehicleBodyType, setBkVehicleBodyType] = useState<string>("");
  const [bkVehicleColour, setBkVehicleColour] = useState<string>("");
  const [bkVehicleVinChassis, setBkVehicleVinChassis] = useState<string>("");
  const [bkVehicleEngineNumber, setBkVehicleEngineNumber] = useState<string>("");
  const [bkVehicleMileage, setBkVehicleMileage] = useState<string>("");
  const [bkNotes, setBkNotes] = useState<string>("");
  const [bkPickupTime, setBkPickupTime] = useState<string>("");
  const [submittingBooking, setSubmittingBooking] = useState<boolean>(false);
  
  // Branch timezone time - refreshes every minute to keep time slots accurate
  const [branchCurrentTime, setBranchCurrentTime] = useState<{ date: string; time: string }>({ date: '', time: '' });

  // Staff assignment modal state for confirming bookings
  const [staffAssignModalOpen, setStaffAssignModalOpen] = useState(false);
  const [bookingToConfirm, setBookingToConfirm] = useState<any>(null);
  const [selectedStaffId, setSelectedStaffId] = useState<string>("");
  const [selectedStaffPerService, setSelectedStaffPerService] = useState<Record<string, string>>({});
  const [confirmingBooking, setConfirmingBooking] = useState(false);
  const [availableStaffForModal, setAvailableStaffForModal] = useState<Array<{ id: string; name: string; branchId?: string; avatar?: string }>>([]);
  const [availableStaffPerServiceForModal, setAvailableStaffPerServiceForModal] = useState<Record<string, Array<{ id: string; name: string; branchId?: string; avatar?: string }>>>({});
  const [loadingStaffForModal, setLoadingStaffForModal] = useState(false);

  // Real data from Firestore
  const [ownerUid, setOwnerUid] = useState<string | null>(null);
  const [userBranchId, setUserBranchId] = useState<string | null>(null);
  const [userRole, setUserRole] = useState<string | null>(null);
  const [branches, setBranches] = useState<Array<{ id: string; name: string; address?: string; hours?: any; timezone?: string }>>([]);
  const [servicesList, setServicesList] = useState<Array<{
    id: string | number;
    name: string;
    price?: number;
    duration?: number;
    icon?: string;
    branches?: string[];
    staffIds?: string[];
    imageUrl?: string;
    /** Canonical size classes this service is offered for. */
    vehicleTypes?: VehicleType[];
    /** Per-vehicle-type price/duration overrides. */
    vehicleTypePricing?: VehicleTypePricingMap;
  }>>([]);
  const [staffList, setStaffList] = useState<Array<{ id: string; name: string; role?: string; status?: string; avatar?: string; branchId?: string; branch?: string; weeklySchedule?: Record<string, { branchId: string; branchName: string } | null> | null }>>([]);

  useEffect(() => {
    (async () => {
      const { auth } = await import("@/lib/firebase");
      const unsub = onAuthStateChanged(auth, async (user) => {
        if (!user) {
          router.replace("/login");
          return;
        }
        try {
          const token = await user.getIdToken();
          if (typeof window !== "undefined") localStorage.setItem("idToken", token);
          
          // Resolve ownerUid based on role
          const { getDoc, doc } = await import("firebase/firestore");
          const snap = await getDoc(doc(db, "users", user.uid));
          const userData = snap.data();
          const role = (userData?.role || "").toString();

          if (role === "workshop_owner") {
            setOwnerUid(user.uid);
            setUserRole(role);
          } else if (role === "branch_admin") {
            // Allow branch admin to access bookings - but only for their branch
            setOwnerUid(userData?.ownerUid || user.uid);
            setUserBranchId(userData?.branchId || null);
            setUserRole(role);
          } else {
            setOwnerUid(user.uid);
            setUserRole(role);
          }

        } catch {
          router.replace("/login");
        }
        // use authenticated user id as ownerUid
      });
      return () => unsub();
    })();
  }, [router]);

  // Expose the booking app logic to window so JSX handlers can call it
  useEffect(() => {
    if (typeof window === "undefined") return;
    const w = window as any;

    // Guard multiple registrations
    if (w.app && w.app.__initialized) return;

    const app = {
      __initialized: false,
      defaults: {
        bookings: [], // Initialize with empty array - real data comes from Firestore
        services: [],
        staff: [],
        branches: []
      },
      data: {} as any,
      charts: {} as any,
      init: function () {
        if (this.__initialized) return;
        this.__initialized = true;
        const today = new Date().toISOString().split("T")[0];
        this.loadData();
        // If realtime cache exists (from Firestore listener), seed with it so we show real data immediately
        try {
          const cached = (window as any).__todayBookingsCache;
          if (Array.isArray(cached)) {
            this.data.bookings = cached;
          }
        } catch {}
        const dateInput = document.getElementById("booking-date-input") as HTMLInputElement | null;
        if (dateInput) dateInput.value = today;
        this.renderBookings();
        this.initCharts();
        this.updateAnalytics();
        this.populateSelects();
        const serviceSel = document.getElementById("booking-service-select");
        const staffSel = document.getElementById("booking-staff-select");
        const dateSel = document.getElementById("booking-date-input");
        serviceSel?.addEventListener("change", () => this.generateTimeSlots());
        staffSel?.addEventListener("change", () => this.generateTimeSlots());
        dateSel?.addEventListener("change", () => this.generateTimeSlots());
      },
      loadData: function () {
        // Initialize with empty data structure
        // Real data will come from Firestore listener
        this.data = {
          bookings: [],
          services: [],
          staff: [],
          branches: []
        };
      },
      saveData: function () {
        // No longer saving to localStorage - data comes from Firestore
        this.renderBookings();
        this.updateAnalytics();
        this.updateCharts();
      },
      resetData: function () {
        // No longer needed - data comes from Firestore
          location.reload();
      },
      router: function (_viewId: string) {},
      updateAnalytics: function () {
        const today = new Date().toISOString().split("T")[0];
        const todayBookings = this.data.bookings.filter((b: any) => b.date === today);
        const confirmedBookings = todayBookings.filter((b: any) => b.status === "Confirmed");
        const totalRevenue = confirmedBookings.reduce((sum: number, b: any) => sum + b.price, 0);
        const totalDuration = todayBookings.reduce((sum: number, b: any) => sum + b.duration, 0);
        const avgDuration = todayBookings.length > 0 ? Math.round(totalDuration / todayBookings.length) : 0;
        const revEl = document.getElementById("analytics-revenue");
        const cntEl = document.getElementById("analytics-confirmed-count");
        const avgEl = document.getElementById("analytics-avg-duration");
        if (revEl) revEl.textContent = `$${totalRevenue.toLocaleString()}`;
        if (cntEl) cntEl.textContent = String(confirmedBookings.length);
        if (avgEl) avgEl.textContent = `${avgDuration} mins`;
      },
      renderBookings: function () {
        const tbody = document.getElementById("bookings-table-body");
        if (!tbody) return;
        tbody.innerHTML = "";
        const today = new Date().toISOString().split("T")[0];
        let rows = this.data.bookings.filter((b: any) => b.date === today);

        // If there are no bookings for today, fall back to upcoming (any status)
        if (rows.length === 0) {
          const now = new Date(today).getTime();
          rows = this.data.bookings
            .filter((b: any) => {
              const t = new Date(String(b.date || today)).getTime();
              return isFinite(t) && t >= now;
            })
            .sort((a: any, b: any) => {
              const ad = new Date(a.date).getTime();
              const bd = new Date(b.date).getTime();
              if (ad === bd) return a.time > b.time ? 1 : -1;
              return ad > bd ? 1 : -1;
            })
            .slice(0, 10);
        }

        if (rows.length === 0) {
          tbody.innerHTML = '<tr><td colspan="4" class="p-4 text-center text-neutral-400">No bookings found.</td></tr>';
          return;
        }

        rows.sort((a: any, b: any) => (a.time > b.time ? 1 : -1));
        rows.forEach((b: any) => {
          const service = this.data.services.find((s: any) => s.id === b.serviceId);
          const staff = this.data.staff.find((s: any) => s.id === b.staffId);
          
          // Build service-staff display HTML - each service on its own line
          let servicesHtml = "";
          if (Array.isArray(b.services) && b.services.length > 0) {
            servicesHtml = b.services.map((svc: any) => {
              const svcName = svc.name || svc.serviceName || "Service";
              const svcStaff = svc.staffName || "Not Assigned Yet";
              return `<div class="flex items-center gap-2 py-1 px-2 rounded-lg bg-neutral-50 border border-neutral-100 mb-1">
                <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-white border border-neutral-200 shadow-sm">
                  <i class="fas fa-wrench text-neutral-600" style="font-size:10px"></i>
                  <span class="text-xs font-semibold text-neutral-800">${svcName}</span>
                </span>
                <i class="fas fa-user text-neutral-400" style="font-size:9px"></i>
                <span class="text-xs font-medium text-neutral-600">${svcStaff}</span>
              </div>`;
            }).join("");
          } else {
            const serviceName = String(b.serviceName || (service ? service.name : "Unknown Service"));
            let staffName = "Unassigned";
            if (b.staffName && b.staffName !== "Any Available" && b.staffName !== "Any Staff" && b.staffName !== "Not Assigned Yet") {
              staffName = b.staffName;
            } else if (staff) {
              staffName = staff.name;
            }
            servicesHtml = `<div class="flex items-center gap-2 py-1 px-2 rounded-lg bg-neutral-50 border border-neutral-100">
              <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-white border border-neutral-200 shadow-sm">
                <i class="fas fa-wrench text-neutral-600" style="font-size:10px"></i>
                <span class="text-xs font-semibold text-neutral-800">${serviceName}</span>
              </span>
              <i class="fas fa-user text-neutral-400" style="font-size:9px"></i>
              <span class="text-xs font-medium text-neutral-600">${staffName}</span>
            </div>`;
          }
          
          const endTime = this.calculateEndTime(b.time, b.duration);
          const statusClass = `status-${b.status}`;
          const statusActions =
            b.status === "Confirmed"
              ? `<div class="flex gap-2 justify-center">
                   <button onclick="app.updateBookingStatus('${b.id}', 'Completed')" class="group flex items-center gap-1.5 px-3 py-1 rounded-full bg-blue-50 text-blue-600 border border-blue-100 hover:border-blue-500 hover:bg-gradient-to-r hover:from-blue-500 hover:to-indigo-500 hover:text-white transition-all duration-300 shadow-sm hover:shadow-blue-200 hover:shadow-md transform hover:-translate-y-0.5">
                     <i class="fas fa-check text-[10px]"></i> <span class="text-xs font-bold">Complete</span>
                   </button>
                   <button onclick="app.updateBookingStatus('${b.id}', 'Canceled')" class="group flex items-center gap-1.5 px-3 py-1 rounded-full bg-rose-50 text-rose-600 border border-rose-100 hover:border-rose-500 hover:bg-gradient-to-r hover:from-rose-500 hover:to-red-500 hover:text-white transition-all duration-300 shadow-sm hover:shadow-rose-200 hover:shadow-md transform hover:-translate-y-0.5">
                     <i class="fas fa-times text-[10px]"></i> <span class="text-xs font-bold">Cancel</span>
                   </button>
                 </div>`
              : b.status === "Pending"
              ? `<div class="flex gap-2 justify-center">
                   <button onclick="app.updateBookingStatus('${b.id}', 'Confirmed')" class="group flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-50 text-emerald-600 border border-emerald-100 hover:border-emerald-500 hover:bg-gradient-to-r hover:from-emerald-500 hover:to-green-500 hover:text-white transition-all duration-300 shadow-sm hover:shadow-emerald-200 hover:shadow-md transform hover:-translate-y-0.5">
                     <i class="fas fa-check text-[10px]"></i> <span class="text-xs font-bold">Confirm</span>
                   </button>
                   <button onclick="app.updateBookingStatus('${b.id}', 'Canceled')" class="group flex items-center gap-1.5 px-3 py-1 rounded-full bg-rose-50 text-rose-600 border border-rose-100 hover:border-rose-500 hover:bg-gradient-to-r hover:from-rose-500 hover:to-red-500 hover:text-white transition-all duration-300 shadow-sm hover:shadow-rose-200 hover:shadow-md transform hover:-translate-y-0.5">
                     <i class="fas fa-times text-[10px]"></i> <span class="text-xs font-bold">Cancel</span>
                   </button>
                 </div>`
              : "";
          tbody.innerHTML += `
            <tr class="hover:bg-neutral-50 transition">
              <td class="p-4 pl-6">
                <span class="font-bold text-neutral-800">${b.client}</span>
                <div class="mt-1.5">${servicesHtml}</div>
              </td>
              <td class="p-4">
                <span class="font-medium text-neutral-700">${b.time} - ${endTime}</span>
                ${b.pickupTime ? `<div class="text-[10px] text-emerald-600 font-medium mt-0.5"><i class="fas fa-arrow-right-from-bracket mr-1"></i>Pick-up: ${b.pickupTime}</div>` : ""}
              </td>
              <td class="p-4 text-center">
                <span class="inline-block px-3 py-1 text-xs font-semibold rounded-full ${statusClass}">
                  ${b.status}
                </span>
                <div class="mt-1">${statusActions}</div>
              </td>
              <td class="p-4 text-right pr-6 font-bold text-neutral-800">$${b.price}</td>
            </tr>
          `;
        });
      },
      updateBookingStatus: async function (id: string, newStatus: string) {
        const booking = this.data.bookings.find((b: any) => b.id === id);
        
        // Prevent actions on cancelled bookings
        if (booking && (booking.status === "Canceled" || booking.status === "Cancelled" || booking.status === "cancelled" || booking.status === "canceled") && newStatus !== "Canceled") {
          alert("This booking has been cancelled and cannot be updated.");
          return;
        }

        // Block completion if additional issues are pending admin/customer decisions
        if (booking && newStatus === "Completed") {
          const issues = Array.isArray(booking.additionalIssues) ? booking.additionalIssues : [];
          const pendingAdmin = issues.filter((i: any) => (i.status || "pending") === "pending").length;
          const pendingCustomer = issues.filter((i: any) => i.status === "approved" && !i.customerResponse).length;
          if (pendingAdmin > 0 || pendingCustomer > 0) {
            await new Promise<void>((resolve) => {
              const overlay = document.createElement("div");
              overlay.style.cssText = "position:fixed;inset:0;z-index:9998;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.5);backdrop-filter:blur(4px)";
              let detailsHtml = "";
              if (pendingAdmin > 0) {
                detailsHtml += `<div style="display:flex;align-items:center;gap:0.75rem;padding:0.75rem;background:#fffbeb;border-radius:0.75rem;border:1px solid #fde68a;margin-bottom:0.5rem">
                  <div style="width:2rem;height:2rem;border-radius:0.5rem;background:#fef3c7;display:flex;align-items:center;justify-content:center;flex-shrink:0"><i class="fas fa-user-shield" style="color:#d97706;font-size:0.7rem"></i></div>
                  <div><div style="font-size:0.875rem;font-weight:600;color:#92400e">${pendingAdmin} pending admin approval</div><div style="font-size:0.75rem;color:#b45309">Admin needs to approve or reject</div></div>
                </div>`;
              }
              if (pendingCustomer > 0) {
                detailsHtml += `<div style="display:flex;align-items:center;gap:0.75rem;padding:0.75rem;background:#eff6ff;border-radius:0.75rem;border:1px solid #bfdbfe;margin-bottom:0.5rem">
                  <div style="width:2rem;height:2rem;border-radius:0.5rem;background:#dbeafe;display:flex;align-items:center;justify-content:center;flex-shrink:0"><i class="fas fa-user" style="color:#2563eb;font-size:0.7rem"></i></div>
                  <div><div style="font-size:0.875rem;font-weight:600;color:#1e40af">${pendingCustomer} awaiting customer response</div><div style="font-size:0.75rem;color:#2563eb">Customer needs to accept or reject</div></div>
                </div>`;
              }
              overlay.innerHTML = `
                <div style="background:#fff;border-radius:1rem;box-shadow:0 25px 50px -12px rgba(0,0,0,0.25);max-width:28rem;width:calc(100% - 2rem);overflow:hidden;animation:scaleIn .2s ease-out">
                  <div style="background:linear-gradient(to right,#ef4444,#f43f5e);padding:1rem 1.5rem;display:flex;align-items:center;gap:0.75rem">
                    <div style="width:2.5rem;height:2.5rem;border-radius:0.75rem;background:rgba(255,255,255,0.2);display:flex;align-items:center;justify-content:center"><i class="fas fa-hand" style="color:#fff"></i></div>
                    <h3 style="color:#fff;font-weight:600;font-size:1rem;margin:0">Cannot Complete Booking</h3>
                  </div>
                  <div style="padding:1.25rem 1.5rem">
                    <p style="color:#525252;font-size:0.875rem;line-height:1.6;margin:0 0 1rem 0">This booking has pending additional work requests that need decisions before it can be completed.</p>
                    ${detailsHtml}
                    <p style="color:#737373;font-size:0.75rem;line-height:1.6;margin:1rem 0 0 0">Staff should contact the admin to get a decision on pending requests before completing the booking.</p>
                  </div>
                  <div style="padding:0 1.5rem 1.25rem;display:flex;justify-content:flex-end">
                    <button id="pi-ok" style="padding:0.5rem 1.25rem;border-radius:9999px;font-size:0.875rem;font-weight:600;background:#171717;color:#fff;border:none;cursor:pointer">Understood</button>
                  </div>
                </div>`;
              document.body.appendChild(overlay);
              overlay.querySelector("#pi-ok")!.addEventListener("click", () => { overlay.remove(); resolve(); });
              overlay.addEventListener("click", (e) => { if (e.target === overlay) { overlay.remove(); resolve(); } });
            });
            return;
          }
        }

        // Check for incomplete tasks before completing — show styled modal
        let forceComplete = false;
        if (booking && newStatus === "Completed") {
          const tasks = Array.isArray(booking.tasks) ? booking.tasks : [];
          if (tasks.length > 0) {
            const completedTasks = tasks.filter((t: any) => {
              if (!t || typeof t !== "object") return false;
              if (t.done === true) return true;
              const status = String(t.status || t.completionStatus || "").toLowerCase();
              return status === "completed" || status === "done";
            }).length;
            if (completedTasks < tasks.length) {
              const confirmed = await new Promise<boolean>((resolve) => {
                const overlay = document.createElement("div");
                overlay.style.cssText = "position:fixed;inset:0;z-index:9998;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.5);backdrop-filter:blur(4px)";
                overlay.innerHTML = `
                  <div style="background:#fff;border-radius:1rem;box-shadow:0 25px 50px -12px rgba(0,0,0,0.25);max-width:28rem;width:calc(100% - 2rem);overflow:hidden;animation:scaleIn .2s ease-out">
                    <div style="background:linear-gradient(to right,#f97316,#f59e0b);padding:1rem 1.5rem;display:flex;align-items:center;gap:0.75rem">
                      <div style="width:2.5rem;height:2.5rem;border-radius:0.75rem;background:rgba(255,255,255,0.2);display:flex;align-items:center;justify-content:center">
                        <i class="fas fa-exclamation-triangle" style="color:#fff"></i>
                      </div>
                      <h3 style="color:#fff;font-weight:600;font-size:1rem;margin:0">Incomplete Tasks</h3>
                    </div>
                    <div style="padding:1.25rem 1.5rem">
                      <div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:1rem;padding:0.75rem;background:#fff7ed;border-radius:0.75rem;border:1px solid #fed7aa">
                        <div style="font-size:1.5rem;font-weight:700;color:#ea580c">${completedTasks}/${tasks.length}</div>
                        <div style="font-size:0.875rem;color:#c2410c">tasks completed by staff</div>
                      </div>
                      <p style="color:#525252;font-size:0.875rem;line-height:1.6;margin:0">Staff has not completed all assigned tasks. Are you sure the staff failed to complete the remaining tasks and you want to mark this service as complete?</p>
                    </div>
                    <div style="padding:0 1.5rem 1.25rem;display:flex;align-items:center;justify-content:flex-end;gap:0.75rem">
                      <button id="fc-cancel" style="padding:0.5rem 1rem;border-radius:9999px;font-size:0.875rem;font-weight:600;background:#f5f5f5;color:#404040;border:none;cursor:pointer">Cancel</button>
                      <button id="fc-confirm" style="padding:0.5rem 1.25rem;border-radius:9999px;font-size:0.875rem;font-weight:600;background:linear-gradient(to right,#f97316,#f59e0b);color:#fff;border:none;cursor:pointer;display:inline-flex;align-items:center;gap:0.5rem;box-shadow:0 1px 2px rgba(0,0,0,0.1)">
                        <i class="fas fa-check" style="font-size:0.7rem"></i> Yes, Complete
                      </button>
                    </div>
                  </div>`;
                document.body.appendChild(overlay);
                overlay.querySelector("#fc-cancel")!.addEventListener("click", () => { overlay.remove(); resolve(false); });
                overlay.querySelector("#fc-confirm")!.addEventListener("click", () => { overlay.remove(); resolve(true); });
                overlay.addEventListener("click", (e) => { if (e.target === overlay) { overlay.remove(); resolve(false); } });
              });
              if (!confirmed) return;
              forceComplete = true;
            }
          }
        }
        
        // If confirming, check if staff assignment is needed
        if (newStatus === "Confirmed" && booking) {
          const hasMultipleServices = Array.isArray(booking.services) && booking.services.length > 0;
          
          if (hasMultipleServices) {
            // Check if any service needs staff assignment
            const needsStaffAssignment = booking.services.some((s: any) => 
              !s.staffId || s.staffId === "null" || s.staffName === "Any Available" || s.staffName === "Any Staff" || s.staffName === "Not Assigned Yet"
            );
            
            if (needsStaffAssignment) {
              // Trigger staff assignment modal via React state
              const event = new CustomEvent("openStaffAssignModal", { detail: booking });
              window.dispatchEvent(event);
              return;
            }
          } else {
            // Single service booking - check if needs staff assignment
            if (!booking.staffId || booking.staffId === "null" || booking.staffName === "Any Available" || booking.staffName === "Any Staff" || booking.staffName === "Not Assigned Yet") {
              // Trigger staff assignment modal via React state
              const event = new CustomEvent("openStaffAssignModal", { detail: booking });
              window.dispatchEvent(event);
              return;
            }
          }
        }
        
        try {
          // Use the API endpoint to update status (triggers notifications and activity log)
          const { auth } = await import("@/lib/firebase");
          let token: string | null = null;
          try {
            if (auth.currentUser) {
              token = await auth.currentUser.getIdToken(true);
            }
          } catch (e) {
            console.error("Error getting token:", e);
          }
          
          const res = await fetch(`/api/bookings/${encodeURIComponent(id)}/status`, {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: JSON.stringify({ status: newStatus, ...(forceComplete ? { forceComplete: true } : {}) }),
          });
          
          const json = await res.json().catch(() => ({})) as any;
          if (!res.ok && !json?.devNoop) {
            throw new Error(json?.error || "Failed to update booking status");
          }
          
          // If dev no-op, also update locally
          if (json?.devNoop) {
          const { doc, updateDoc } = await import("firebase/firestore");
          const { db } = await import("@/lib/firebase");
          const bookingRef = doc(db, "bookings", id);
          await updateDoc(bookingRef, { status: newStatus });
          }

          // Optimistically update local state (though Firestore listener will also catch it)
          if (booking) {
            booking.status = newStatus;
            this.saveData();
          }
          this.showToast(`Booking status updated to ${newStatus}.`);
        } catch (error) {
          console.error("Error updating booking:", error);
          this.showToast("Failed to update booking status.", "error");
        }
      },
      calculateEndTime: function (startTime: string, duration: number) {
        const [startH, startM] = startTime.split(":").map(Number);
        const totalMinutes = startH * 60 + startM + duration;
        const endH = Math.floor(totalMinutes / 60) % 24;
        const endM = totalMinutes % 60;
        const pad = (num: number) => num.toString().padStart(2, "0");
        return `${pad(endH)}:${pad(endM)}`;
      },
      populateSelects: function () {
        const serviceSelect = document.getElementById("booking-service-select") as HTMLSelectElement | null;
        const staffSelect = document.getElementById("booking-staff-select") as HTMLSelectElement | null;
        const branchSelect = document.getElementById("booking-branch-select") as HTMLSelectElement | null;
        if (!serviceSelect || !staffSelect || !branchSelect) return;
        serviceSelect.innerHTML = '<option value="" disabled selected>Select Service</option>';
        this.data.services.forEach((s: any) => {
          serviceSelect.innerHTML += `<option value="${s.id}" data-duration="${s.duration}" data-price="${s.price}">${s.name} ($${s.price})</option>`;
        });
        staffSelect.innerHTML = '<option value="" disabled selected>Select Staff</option>';
        this.data.staff.filter((s: any) => s.status === "Active").forEach((s: any) => {
          staffSelect.innerHTML += `<option value="${s.id}">${s.name} (${s.role})</option>`;
        });
        branchSelect.innerHTML = '<option value="" disabled selected>Select Branch</option>';
        this.data.branches.forEach((b: any) => {
          branchSelect.innerHTML += `<option value="${b.id}">${b.name}</option>`;
        });
      },
      generateTimeSlots: function () {
        const staffId = (document.getElementById("booking-staff-select") as HTMLSelectElement | null)?.value || "";
        const serviceSelect = document.getElementById("booking-service-select") as HTMLSelectElement | null;
        const selectedOption = serviceSelect && serviceSelect.options[serviceSelect.selectedIndex];
        const date = (document.getElementById("booking-date-input") as HTMLInputElement | null)?.value || "";
        const duration = selectedOption ? parseInt(selectedOption.getAttribute("data-duration") || "0") : 0;
        const branchId = (document.getElementById("booking-branch-select") as HTMLSelectElement | null)?.value || "";
        const slotsContainer = document.getElementById("time-slots-container") as HTMLDivElement | null;
        const timeInput = document.getElementById("booking-time-input") as HTMLInputElement | null;
        const durationLabel = document.getElementById("service-duration-label") as HTMLSpanElement | null;
        if (!slotsContainer || !timeInput || !durationLabel) return;
        slotsContainer.innerHTML = "";
        timeInput.value = "";
        durationLabel.innerText = String(duration);
        if (!staffId || duration === 0 || !date) {
          slotsContainer.innerHTML = '<p class="col-span-4 text-center text-neutral-400 text-xs py-2">Select Service, Staff, and a valid Date to see available slots.</p>';
          const eet = document.getElementById("estimated-end-time");
          if (eet) eet.textContent = "--";
          return;
        }

        // Get branch hours for the selected date
        const selectedBranch = this.data.branches?.find((b: any) => b.id === branchId);
        const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
        const selectedDate = new Date(date);
        const dayOfWeek = dayNames[selectedDate.getDay()];
        
        // Get branch hours for this day
        let startHour = 9; // Default fallback
        let endHour = 17; // Default fallback
        let isClosed = false;
        
        if (selectedBranch?.hours && typeof selectedBranch.hours === 'object') {
          const dayHours = selectedBranch.hours[dayOfWeek as keyof typeof selectedBranch.hours];
          if (dayHours) {
            if (dayHours.closed) {
              isClosed = true;
            } else {
              if (dayHours.open) {
                const [openH, openM] = dayHours.open.split(':').map(Number);
                startHour = openH + (openM || 0) / 60;
              }
              if (dayHours.close) {
                const [closeH, closeM] = dayHours.close.split(':').map(Number);
                endHour = closeH + (closeM || 0) / 60;
              }
            }
          }
        }

        if (isClosed) {
          slotsContainer.innerHTML = '<p class="col-span-4 text-center text-red-500 text-xs py-2">Branch is closed on this day.</p>';
          const eet = document.getElementById("estimated-end-time");
          if (eet) eet.textContent = "--";
          return;
        }

        const interval = 30;
        let currentTime = Math.floor(startHour) * 60 + ((startHour % 1) * 60);
        const branchMaxTime = Math.floor(endHour) * 60 + ((endHour % 1) * 60);
        const DROPOFF_CUTOFF_LEGACY = 11 * 60 + 1; // cap drop-off at 11:00 AM (inclusive)
        const maxTime = Math.min(branchMaxTime, DROPOFF_CUTOFF_LEGACY);
        
        // Check if date is today to filter past times
        const today = new Date();
        const isToday = date === today.toISOString().split('T')[0];
        const currentMinutes = isToday ? (today.getHours() * 60 + today.getMinutes()) : -1;
        
        // Staff-wise slot capacity has been intentionally removed — see the
        // React slot-builder above for the full explanation. This legacy
        // helper now always treats every slot as free so bookings are only
        // gated by branch hours / daily limit.
        const isSlotOccupied = (_slotMinutes: number): boolean => false;
        
        const formatTime = (minutes: number) => {
          const h = Math.floor(minutes / 60) % 24;
          const m = minutes % 60;
          return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
        };
        
        while (currentTime < maxTime) {
          // Check if slot + duration fits before branch closing time
          const slotEndTime = currentTime + duration;
          if (slotEndTime > branchMaxTime) {
            break;
          }

          // Skip past times if date is today
          if (isToday && currentTime <= currentMinutes) {
            currentTime += interval;
            continue;
          }

          const slotStartTime = formatTime(currentTime);
          const isOccupied = isSlotOccupied(currentTime);
          
          const slotElement = document.createElement("div");
          (slotElement as any).dataset.time = slotStartTime;
          slotElement.innerText = `${slotStartTime}`;
          
          if (isOccupied) {
            // Blocked slot - show in red, not clickable
            slotElement.className = "time-slot time-slot-blocked text-sm bg-red-50 text-red-400 border border-red-200 cursor-not-allowed line-through opacity-70";
            slotElement.title = "Already booked";
          } else {
            // Available slot
            slotElement.className = "time-slot text-sm";
            slotElement.onclick = (e: any) => {
              document.querySelectorAll(".time-slot").forEach((s) => s.classList.remove("selected"));
              e.target.classList.add("selected");
              timeInput.value = e.target.dataset.time;
              const eet = document.getElementById("estimated-end-time");
              if (eet) eet.textContent = this.calculateEndTime(e.target.dataset.time, duration);
            };
          }
          
          slotsContainer.appendChild(slotElement);
          currentTime += interval;
        }
        
        // Check if ALL slots are blocked
        const availableSlots = slotsContainer.querySelectorAll(".time-slot:not(.time-slot-blocked)");
        if (availableSlots.length === 0) {
          slotsContainer.innerHTML = '<p class="col-span-4 text-center text-red-500 text-xs py-2">No available slots for this staff on this date.</p>';
        }
      },
      timeToMinutes: function (time: string) {
        const [h, m] = time.split(":").map(Number);
        return h * 60 + m;
      },
      handleBookingSubmit: function (e: React.FormEvent<HTMLFormElement>) {
        e.preventDefault();
        const formData = new FormData(e.target as HTMLFormElement);
        const serviceId = parseInt(String(formData.get("serviceId")));
        const service = this.data.services.find((s: any) => s.id === serviceId);
        if (!service) {
          this.showToast("Invalid service selected!", "error");
          return;
        }
        if (!formData.get("time")) {
          this.showToast("Please select an available time slot.", "error");
          return;
        }
        const newBooking = {
          id: Date.now(),
          client: String(formData.get("client")),
          serviceId: serviceId,
          staffId: String(formData.get("staffId")),
          branchId: String(formData.get("branchId")),
          date: String(formData.get("date")),
          time: String(formData.get("time")),
          duration: service.duration,
          status: "Confirmed",
          price: service.price
        };
        this.data.bookings.push(newBooking);
        this.saveData();
        this.closeModal("booking");
        (e.target as HTMLFormElement).reset();
        this.showToast("New Booking Confirmed!");
      },
      initCharts: function () {
        const ctx = document.getElementById("statusChart") as HTMLCanvasElement | null;
        // Guard when Chart is not loaded or canvas missing
        if (!ctx || !(window as any).Chart) return;
        const confirmed = this.data.bookings.filter((b: any) => b.status === "Confirmed").length;
        const pending = this.data.bookings.filter((b: any) => b.status === "Pending").length;
        const canceled = this.data.bookings.filter((b: any) => b.status === "Canceled").length;
        const completed = this.data.bookings.filter((b: any) => b.status === "Completed").length;
        this.charts.status = new (window as any).Chart(ctx, {
          type: "doughnut",
          data: {
            labels: ["Confirmed", "Pending", "Canceled", "Completed"],
            datasets: [
              {
                data: [confirmed, pending, canceled, completed],
                backgroundColor: ["#10b981", "#f59e0b", "#ef4444", "#3b82f6"],
                hoverBackgroundColor: ["#059669", "#d97706", "#dc2626", "#2563eb"],
                borderWidth: 1
              }
            ]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: "70%",
            plugins: {
              legend: {
                position: "right",
                labels: { font: { family: "Inter, sans-serif", size: 10 } }
              }
            }
          }
        });
      },
      updateCharts: function () {
        if (this.charts.status) {
          const confirmed = this.data.bookings.filter((b: any) => b.status === "Confirmed").length;
          const pending = this.data.bookings.filter((b: any) => b.status === "Pending").length;
          const canceled = this.data.bookings.filter((b: any) => b.status === "Canceled").length;
          const completed = this.data.bookings.filter((b: any) => b.status === "Completed").length;
          this.charts.status.data.datasets[0].data = [confirmed, pending, canceled, completed];
          this.charts.status.update();
        }
      },
      showToast: function (msg: string, type: "success" | "error" = "success") {
        const container = document.getElementById("toast-container");
        if (!container) return;
        const color = type === "error" ? "border-red-500" : "border-neutral-900";
        const icon = type === "error" ? "fa-solid fa-circle-xmark text-red-500" : "fa-solid fa-circle-check text-neutral-900";
        const toast = document.createElement("div");
        toast.className = `toast border-l-4 ${color}`;
        toast.innerHTML = `<i class="${icon}"></i> <span>${msg}</span>`;
        container.appendChild(toast);
        setTimeout(() => toast.remove(), 3000);
      },
      openModal: function (type: string) {
        const el = document.getElementById(`modal-${type}`);
        el?.classList.add("open");
        if (type === "booking") {
          const timeInput = document.getElementById("booking-time-input") as HTMLInputElement | null;
          const slots = document.getElementById("time-slots-container");
          const eet = document.getElementById("estimated-end-time");
          if (timeInput) timeInput.value = "";
          if (slots) slots.innerHTML = '<p class="col-span-4 text-center text-neutral-400 text-xs py-2">Select Service and Staff to see available slots.</p>';
          if (eet) eet.textContent = "--";
        }
      },
      closeModal: function (type: string) {
        const el = document.getElementById(`modal-${type}`);
        el?.classList.remove("open");
      }
    };

    w.app = app;

    // Initialize as soon as mounted; charts will be skipped until chartReady
    app.init();
  }, []);

  // Once Chart.js loads, initialize charts if app is ready
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!chartReady) return;
    const w = window as any;
    if (w.app && typeof w.app.initCharts === "function") {
      w.app.initCharts();
      w.app.updateCharts();
    }
  }, [chartReady]);

  // Helpers for wizard
  const appRef = () => (typeof window !== "undefined" ? (window as any).app : null);

  // Subscribe to today's bookings from Firestore and feed the booking table
  useEffect(() => {
    if (!ownerUid) return;
    const todayStr = new Date().toISOString().split("T")[0];
    
    // Branch admin should only see bookings for their branch
    const constraints = [
      where("ownerUid", "==", ownerUid),
      where("date", "==", todayStr)
    ];
    
    if (userRole === "branch_admin" && userBranchId) {
      constraints.push(where("branchId", "==", userBranchId));
    }
    
    const q = query(collection(db, "bookings"), ...constraints);
    const unsub = onSnapshot(
      q,
      (snap) => {
        const list: any[] = [];
        snap.forEach((d) => {
          const b = d.data() as any;
          list.push({
            id: d.id,
            client: String(b.client || ""),
            serviceId: b.serviceId,
            serviceName: String(b.serviceName || ""),
            staffId: String(b.staffId || ""),
            staffName: String(b.staffName || ""),
            branchId: String(b.branchId || ""),
            date: String(b.date || todayStr),
            time: String(b.time || ""),
            duration: Number(b.duration || 0),
            status: String(b.status || "Confirmed"),
            price: Number(b.price || 0),
            services: b.services || null, // Include services array for multi-service bookings
          });
        });
        try {
          const wapp = appRef();
          // cache latest list so init can seed even if app isn't ready yet
          (window as any).__todayBookingsCache = list;
          if (!wapp) return; // will update on next callback tick when app is ready
          wapp.data = wapp.data || {};
          wapp.data.bookings = list;
          // refresh UI pieces
          if (typeof wapp.updateAnalytics === "function") wapp.updateAnalytics();
          if (typeof wapp.updateCharts === "function") wapp.updateCharts();
          if (typeof wapp.renderBookings === "function") wapp.renderBookings();
        } catch {}
      },
      (error) => {
        // Handle permission errors properly instead of silently ignoring
        if (error.code === "permission-denied") {
          console.warn("Permission denied for bookings query. User may not be authenticated.");
          // Optionally redirect to login if not authenticated
          const { auth } = require("@/lib/firebase");
          if (!auth.currentUser) {
            router.replace("/login");
          }
        } else {
          console.error("Error in bookings snapshot:", error);
        }
        // Don't crash the app, just log the error
      }
    );
    return () => unsub();
  }, [ownerUid, userRole, userBranchId, router]);

  // Subscribe to bookings for selected date in booking wizard (for slot availability checking)
  useEffect(() => {
    if (!ownerUid || !bkDate) return;
    
    const dateStr = formatLocalYmd(bkDate);
    
    // Branch admin should only see bookings for their branch
    const constraints = [
      where("ownerUid", "==", ownerUid),
      where("date", "==", dateStr)
    ];
    
    if (userRole === "branch_admin" && userBranchId) {
      constraints.push(where("branchId", "==", userBranchId));
    }
    
    let bookingsList: any[] = [];
    let bookingRequestsList: any[] = [];
    
    const mergeAndUpdate = () => {
      try {
        const wapp = appRef();
        if (!wapp) return;
        wapp.data = wapp.data || {};
        
        // Merge bookings and bookingRequests for selected date with existing bookings
        // Remove old bookings for this date first, then add new ones
        const existingBookings = (wapp.data.bookings || []).filter((b: any) => b.date !== dateStr);
        wapp.data.bookings = [...existingBookings, ...bookingsList, ...bookingRequestsList];
        
        // Trigger re-render to update slot availability
        setBookingsUpdateKey(prev => prev + 1);
      } catch (error) {
        console.error("Error updating bookings for selected date:", error);
      }
    };
    
    // Subscribe to bookings collection
    const q1 = query(collection(db, "bookings"), ...constraints);
    const unsub1 = onSnapshot(
      q1,
      (snap) => {
        bookingsList = [];
        snap.forEach((d) => {
          const b = d.data() as any;
          bookingsList.push({
            id: d.id,
            client: String(b.client || ""),
            serviceId: b.serviceId,
            serviceName: String(b.serviceName || ""),
            staffId: String(b.staffId || ""),
            staffName: String(b.staffName || ""),
            branchId: String(b.branchId || ""),
            date: String(b.date || dateStr),
            time: String(b.time || ""),
            duration: Number(b.duration || 0),
            status: String(b.status || "Confirmed"),
            price: Number(b.price || 0),
            services: b.services || null, // Include services array for multi-service bookings
          });
        });
        mergeAndUpdate();
      },
      (error) => {
        if (error.code === "permission-denied") {
          console.warn("Permission denied for bookings query for selected date.");
        } else {
          console.error("Error in bookings snapshot for selected date:", error);
        }
        bookingsList = [];
        mergeAndUpdate();
      }
    );
    
    // Also subscribe to bookingRequests collection (for pending bookings from booking engine)
    const q2 = query(collection(db, "bookingRequests"), ...constraints);
    const unsub2 = onSnapshot(
      q2,
      (snap) => {
        bookingRequestsList = [];
        snap.forEach((d) => {
          const b = d.data() as any;
          bookingRequestsList.push({
            id: d.id,
            client: String(b.client || ""),
            serviceId: b.serviceId,
            serviceName: String(b.serviceName || ""),
            staffId: String(b.staffId || ""),
            staffName: String(b.staffName || ""),
            branchId: String(b.branchId || ""),
            date: String(b.date || dateStr),
            time: String(b.time || ""),
            duration: Number(b.duration || 0),
            status: String(b.status || "Pending"),
            price: Number(b.price || 0),
            services: b.services || null, // Include services array for multi-service bookings
          });
        });
        mergeAndUpdate();
      },
      (error) => {
        // Silently ignore permission errors for bookingRequests (customers may not have access)
        if (error.code !== "permission-denied") {
          console.error("Error in bookingRequests snapshot for selected date:", error);
        }
        bookingRequestsList = [];
        mergeAndUpdate();
      }
    );
    
    return () => {
      unsub1();
      unsub2();
    };
  }, [ownerUid, userRole, userBranchId, bkDate]);

  // Subscribe to Firestore data for wizard choices
  useEffect(() => {
    if (!ownerUid) return;
    const unsubBranches = subscribeBranchesForOwner(ownerUid, (rows) => {
      // Branch admin should only see their own branch
      let filteredBranches = rows;
      if (userRole === "branch_admin" && userBranchId) {
        filteredBranches = rows.filter((r) => String(r.id) === String(userBranchId));
      }
      setBranches(filteredBranches.map((r) => ({ 
        id: String(r.id), 
        name: String(r.name || ""), 
        address: (r as any).address, 
        hours: (r as any).hours,
        timezone: (r as any).timezone // Include timezone for proper time slot calculation
      })));
    });
    const unsubServices = subscribeServicesForOwner(ownerUid, (rows) => {
      setServicesList(
        rows
          .filter(Boolean)
          .map((s) => {
            const raw = s as any;
            const typePricing = normalizeVehicleTypePricing(raw.vehicleTypePricing);
            return {
              id: raw.id,
              name: String(raw.name || "Service"),
              price: typeof raw.price === "number" ? raw.price : undefined,
              duration: typeof raw.duration === "number" ? raw.duration : undefined,
              imageUrl: raw.imageUrl || raw.image || undefined,
              icon: String(raw.icon || "fa-solid fa-star"),
              branches: Array.isArray(raw.branches) ? raw.branches.map(String) : undefined,
              staffIds: Array.isArray(raw.staffIds) ? raw.staffIds.map(String) : undefined,
              vehicleTypes: typePricing.vehicleTypes,
              vehicleTypePricing: typePricing.vehicleTypePricing,
            };
          })
      );
    });
    const unsubStaff = subscribeSalonStaffForOwner(ownerUid, (rows) => {
      // Branch admin should only see staff from their branch
      let filteredStaff = rows;
      if (userRole === "branch_admin" && userBranchId) {
        filteredStaff = rows.filter((r: any) => String(r.branchId) === String(userBranchId));
      }
      
      const mappedStaff = filteredStaff.map((r: any) => ({
        id: String(r.id),
        name: String(r.name || r.displayName || "Staff"),
        role: r.staffRole || r.role,
        status: r.status || "Active", // Default to Active if not set
        avatar: r.avatar || r.name || r.displayName,
        branchId: r.branchId ? String(r.branchId) : undefined,
        branch: r.branchName ? String(r.branchName) : undefined,
        weeklySchedule: r.weeklySchedule || null, // Include weekly schedule for day-based filtering
      }));
      
      console.log('[Booking] Loaded staff:', mappedStaff.length, mappedStaff);
      setStaffList(mappedStaff);
    });
    return () => {
      unsubBranches();
      unsubServices();
      unsubStaff();
    };
  }, [ownerUid, userRole, userBranchId]);

  // Update branch current time every minute for accurate slot availability
  useEffect(() => {
    if (!bkBranchId) return;
    
    const selectedBranch = branches.find((b) => b.id === bkBranchId);
    const branchTimezone = selectedBranch?.timezone || 'Australia/Sydney';
    
    // Update immediately
    const updateTime = () => {
      const branchTime = getCurrentDateTimeInTimezone(branchTimezone);
      setBranchCurrentTime({ date: branchTime.date, time: branchTime.time });
    };
    
    updateTime();
    
    // Update every minute
    const interval = setInterval(updateTime, 60000);
    
    return () => clearInterval(interval);
  }, [bkBranchId, branches]);

  // Listen for staff assignment modal event from app.updateBookingStatus
  useEffect(() => {
    const handleOpenStaffAssignModal = (e: CustomEvent) => {
      const booking = e.detail;
      setBookingToConfirm(booking);
      setSelectedStaffId("");
      
      // Pre-fill staff assignments for services that already have staff
      const initialStaffSelection: Record<string, string> = {};
      if (Array.isArray(booking.services) && booking.services.length > 0) {
        booking.services.forEach((s: any) => {
          // Use consistent key format: id || serviceId || name
          const serviceKey = String(s.id || s.serviceId || s.name);
          if (s.staffId && s.staffId !== "null" && s.staffName !== "Any Available" && s.staffName !== "Any Staff" && s.staffName !== "Not Assigned Yet") {
            initialStaffSelection[serviceKey] = s.staffId;
          }
        });
      }
      setSelectedStaffPerService(initialStaffSelection);
      setStaffAssignModalOpen(true);
    };
    
    window.addEventListener("openStaffAssignModal" as any, handleOpenStaffAssignModal);
    return () => {
      window.removeEventListener("openStaffAssignModal" as any, handleOpenStaffAssignModal);
    };
  }, []);

  // Fetch staff data when staff assignment modal opens (same logic as BookingsListByStatus)
  useEffect(() => {
    if (!staffAssignModalOpen || !bookingToConfirm || !ownerUid) return;

    let unsubServices: (() => void) | null = null;
    let unsubStaff: (() => void) | null = null;
    
    const fetchData = async () => {
      setLoadingStaffForModal(true);
      try {
        // Track loaded data
        let servicesData: any[] = [];
        let staffData: any[] = [];

        const processData = () => {
          // Only require staff data; services may be empty if not configured
          if (staffData.length === 0) return;

          const hasMultipleServices = Array.isArray(bookingToConfirm.services) && bookingToConfirm.services.length > 0;
          
          if (hasMultipleServices) {
            // Filter staff for each service
            const staffPerService: Record<string, Array<{ id: string; name: string; branchId?: string; avatar?: string }>> = {};
            
            bookingToConfirm.services.forEach((bookingService: any) => {
              // Find service details - try matching by id, serviceId, or name
              const serviceId = bookingService.id || bookingService.serviceId;
              const service = servicesData.find((s: any) => 
                String(s.id) === String(serviceId) || 
                String(s.name).toLowerCase() === String(bookingService.name || '').toLowerCase()
              );
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
              
              // Use the same key format as the UI (bookingService.id || bookingService.serviceId)
              const keyId = bookingService.id || bookingService.serviceId || bookingService.name;
              staffPerService[String(keyId)] = filtered.map((s: any) => ({
                id: String(s.id),
                name: String(s.name || s.displayName || "Staff"),
                branchId: s.branchId,
                avatar: s.avatar || s.name || s.displayName || "Staff",
              }));
            });
            
            setAvailableStaffPerServiceForModal(staffPerService);
          } else {
            // Single service - try matching by id or name
            const service = servicesData.find((s: any) => 
              String(s.id) === String(bookingToConfirm.serviceId) ||
              String(s.name).toLowerCase() === String(bookingToConfirm.serviceName || '').toLowerCase()
            );
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

            setAvailableStaffForModal(
              filtered.map((s: any) => ({
                id: String(s.id),
                name: String(s.name || s.displayName || "Staff"),
                branchId: s.branchId,
                avatar: s.avatar || s.name || s.displayName || "Staff",
              }))
            );
          }
          
          setLoadingStaffForModal(false);
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
        console.error("Error fetching staff data:", err);
        setLoadingStaffForModal(false);
      }
    };

    fetchData();

    return () => {
      if (unsubServices) unsubServices();
      if (unsubStaff) unsubStaff();
    };
  }, [staffAssignModalOpen, bookingToConfirm, ownerUid]);

  // Confirm booking with staff assignment
  const confirmWithStaffAssignment = async () => {
    if (!bookingToConfirm) return;
    
    const hasMultipleServices = Array.isArray(bookingToConfirm.services) && bookingToConfirm.services.length > 0;
    
    if (hasMultipleServices) {
      // Validate ALL services have staff assigned (selected in modal)
      const allAssigned = bookingToConfirm.services.every((s: any) => {
        const serviceKey = String(s.id || s.serviceId || s.name);
        return selectedStaffPerService[serviceKey];
      });
      if (!allAssigned) {
        appRef()?.showToast("Please assign staff to all services", "error");
        return;
      }
    } else {
      if (!selectedStaffId) {
        appRef()?.showToast("Please select a staff member", "error");
        return;
      }
    }
    
    setConfirmingBooking(true);
    
    try {
      const { auth } = await import("@/lib/firebase");
      let token: string | null = null;
      try {
        if (auth.currentUser) {
          token = await auth.currentUser.getIdToken(true);
        }
      } catch (e) {
        console.error("Error getting token:", e);
      }
      
      if (hasMultipleServices) {
        // Update services array with selected staff
        const updatedServices = bookingToConfirm.services.map((service: any) => {
          const serviceKey = String(service.id || service.serviceId || service.name);
          const staffId = selectedStaffPerService[serviceKey];
          if (staffId) {
            const serviceStaffList = availableStaffPerServiceForModal[serviceKey] || [];
            const staff = serviceStaffList.find(s => s.id === staffId) || staffList.find(s => s.id === staffId);
            return {
              ...service,
              staffId: staffId,
              staffAuthUid: (staff as any)?.authUid || (staff as any)?.uid || staffId, // Store auth UID for Flutter app
              staffName: staff?.name || "Staff"
            };
          }
          return service;
        });
        
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
        
        if (json?.devNoop) {
          const { updateDoc, doc, serverTimestamp, deleteField } = await import("firebase/firestore");
          await updateDoc(doc(db, "bookings", bookingToConfirm.id), {
            services: updatedServices,
            staffId: deleteField(),
            staffName: deleteField(),
            status: "Confirmed",
            updatedAt: serverTimestamp(),
          } as any);
        }
      } else {
        // Single service
        const selectedStaff = availableStaffForModal.find(s => s.id === selectedStaffId) || staffList.find(s => s.id === selectedStaffId);
        
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
        
        if (json?.devNoop) {
          const { updateDoc, doc, serverTimestamp } = await import("firebase/firestore");
          await updateDoc(doc(db, "bookings", bookingToConfirm.id), {
            staffId: selectedStaffId,
            staffName: selectedStaff?.name || "Staff",
            status: "Confirmed",
            updatedAt: serverTimestamp(),
          } as any);
        }
      }
      
      // Close modal and show success
      setStaffAssignModalOpen(false);
      setBookingToConfirm(null);
      setSelectedStaffId("");
      setSelectedStaffPerService({});
      setAvailableStaffForModal([]);
      setAvailableStaffPerServiceForModal({});
      appRef()?.showToast("Booking confirmed successfully!");
    } catch (e: any) {
      console.error("Error confirming booking:", e);
      appRef()?.showToast(e?.message || "Failed to confirm booking", "error");
    } finally {
      setConfirmingBooking(false);
    }
  };

  /**
   * Resolve the displayable price / duration for a service given the current
   * `bkVehicleType` selection:
   *   - If a vehicle type is selected and the service has a matching tier,
   *     return that tier's price/duration.
   *   - Otherwise return the service's cheapest tier ("starting from").
   *   - Falls back to the legacy flat price/duration if no tiered pricing is
   *     configured (e.g. default super-admin services).
   */
  const resolveServiceDisplayPricing = useCallback(
    (svc: { price?: number; duration?: number; vehicleTypePricing?: VehicleTypePricingMap | null }) => {
      if (!svc) return { price: undefined as number | undefined, duration: undefined as number | undefined, isStartingFrom: false };
      if (bkVehicleType) {
        const resolved = resolveServicePricingForVehicleType(
          { price: svc.price, duration: svc.duration, vehicleTypePricing: svc.vehicleTypePricing },
          bkVehicleType,
        );
        if (resolved) return { price: resolved.price, duration: resolved.duration, isStartingFrom: false };
      }
      const min = minPricingFromVehicleTypePricing(svc.vehicleTypePricing || null);
      if (min) return { price: min.price, duration: min.duration, isStartingFrom: true };
      return { price: svc.price, duration: svc.duration, isStartingFrom: false };
    },
    [bkVehicleType],
  );

  /**
   * Filter a services list by the currently-selected branch and vehicle type.
   * Services without any pricing configured for the picked type are excluded
   * (matches the booking-engine behaviour the user requested).
   */
  const availableServicesForWizard = useMemo(() => {
    return servicesList.filter((srv) => {
      if (!srv.branches || srv.branches.length === 0) return false;
      if (bkBranchId && !srv.branches.includes(bkBranchId)) return false;
      if (bkVehicleType) {
        const tier = srv.vehicleTypePricing?.[bkVehicleType];
        const hasTier = tier && typeof tier.price === "number" && typeof tier.duration === "number";
        const hasLegacyFlatPrice = typeof srv.price === "number" && typeof srv.duration === "number" && (!srv.vehicleTypes || srv.vehicleTypes.length === 0);
        if (!hasTier && !hasLegacyFlatPrice) return false;
      }
      return true;
    });
  }, [servicesList, bkBranchId, bkVehicleType]);

  const resetWizard = () => {
    setBkStep(1);
    setBkBranchId(null);
    setBkSelectedServices([]);
    setBkServiceTimes({});
    setBkServiceStaff({});
    setBkPickupTime("");
    const t = new Date();
    setBkMonthYear({ month: t.getMonth(), year: t.getFullYear() });
    setBkDate(null);
    setBkClientName("");
    setBkClientEmail("");
    setBkClientPhone("");
    setBkVehicleNumber("");
    setBkVehicleType(null);
    setBkVehicleBodyType("");
    setBkVehicleColour("");
    setBkVehicleVinChassis("");
    setBkVehicleEngineNumber("");
    setBkVehicleMileage("");
    setBkNotes("");
  };
  const openBookingWizard = () => {
    resetWizard();
    // Auto-select branch for branch admins
    if (userRole === "branch_admin" && userBranchId) {
      setBkBranchId(userBranchId);
    }
    appRef()?.openModal("booking");
  };

  // Auto-open booking wizard when ?create=true is in URL
  useEffect(() => {
    if (autoOpenHandled) return;
    if (!ownerUid) return; // Wait for auth
    
    const shouldCreate = searchParams?.get("create") === "true";
    if (shouldCreate) {
      // Small delay to ensure modal system is ready
      const timer = setTimeout(() => {
        openBookingWizard();
        setAutoOpenHandled(true);
        // Clear the query param from URL without refresh
        router.replace("/bookings/dashboard", { scroll: false });
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [searchParams, ownerUid, autoOpenHandled, router]);
  const monthName = new Date(bkMonthYear.year, bkMonthYear.month, 1).toLocaleString(undefined, {
    month: "long",
    year: "numeric",
  });
  const goPrevMonth = () =>
    setBkMonthYear(({ month, year }) => {
      const nm = month - 1;
      return nm < 0 ? { month: 11, year: year - 1 } : { month: nm, year };
    });
  const goNextMonth = () =>
    setBkMonthYear(({ month, year }) => {
      const nm = month + 1;
      return nm > 11 ? { month: 0, year: year + 1 } : { month: nm, year };
    });
  const buildMonthCells = () => {
    const firstDayWeekIdx = new Date(bkMonthYear.year, bkMonthYear.month, 1).getDay();
    const numDays = new Date(bkMonthYear.year, bkMonthYear.month + 1, 0).getDate();
    const cells: Array<{ label?: number; date?: Date }> = [];
    for (let i = 0; i < firstDayWeekIdx; i++) cells.push({});
    for (let d = 1; d <= numDays; d++) cells.push({ label: d, date: new Date(bkMonthYear.year, bkMonthYear.month, d) });
    while (cells.length % 7 !== 0) cells.push({});
    return cells;
  };
  const calculateEndTime = (startTime: string, duration: number) => {
    const [startH, startM] = startTime.split(":").map(Number);
    const totalMinutes = startH * 60 + startM + duration;
    const endH = Math.floor(totalMinutes / 60) % 24;
    const endM = totalMinutes % 60;
    const pad = (num: number) => num.toString().padStart(2, "0");
    return `${pad(endH)}:${pad(endM)}`;
  };
  const formatLocalYmd = (d: Date) => {
    const y = d.getFullYear();
    const m = (d.getMonth() + 1).toString().padStart(2, "0");
    const day = d.getDate().toString().padStart(2, "0");
    return `${y}-${m}-${day}`;
  };
  /** Calendar date for `d` as it appears in `timeZone` (for comparing to branch "today"). */
  const formatYmdInTimezone = (d: Date, timeZone: string) => {
    try {
      return new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(d);
    } catch {
      return formatLocalYmd(d);
    }
  };
  const parseHhmmToMinutes = (time: string): number | null => {
    const parts = String(time).trim().split(":");
    if (parts.length < 2) return null;
    const h = Number(parts[0]);
    const m = Number(parts[1]);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
    return h * 60 + m;
  };
  const timeToMinutes = (time: string) => {
    const [h, m] = time.split(":").map(Number);
    return h * 60 + m;
  };
  const computeSlots = (forServiceId?: number | string): Array<{ time: string; available: boolean; reason?: string }> => {
    const app = appRef();
    // Only need date to show time slots
    if (!bkDate) return [];
    
    // Use bookingsUpdateKey to ensure we recalculate when bookings change
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _ = bookingsUpdateKey;
    
    // Get the staff member selected for this service
    const staffIdForService = forServiceId ? bkServiceStaff[String(forServiceId)] : null;
    const isAnyStaffSelected = !staffIdForService || staffIdForService === "any";
    const dateStr = formatLocalYmd(bkDate);
    
    // Staff-wise slot capacity has been intentionally removed.
    //
    // Previously, "Any Staff" services were blocked once all eligible staff
    // for the service/branch were occupied at a time (the "2 staff = max 2
    // bookings" cap), and specific-staff services were blocked when that
    // same staff had an overlapping booking or was being double-booked
    // within the current booking session. Both checks have been removed —
    // staff assignment is now handled manually by owner/branch admin and
    // only the branch's daily booking limit + opening hours restrict slots.
    //
    // The two helpers below are retained as no-ops so the existing callers
    // in the slot-building loop compile unchanged.
    const isSlotOccupied = (_slotMinutes: number): { occupied: boolean; reason?: string } => {
      return { occupied: false };
    };

    const isSlotBlockedByCurrentSelection = (_slotMinutes: number): { blocked: boolean; reason?: string } => {
      return { blocked: false };
    };

    // Get branch hours for the selected date
    const selectedBranch = branches.find((b: any) => b.id === bkBranchId) || app?.data.branches?.find((b: any) => b.id === bkBranchId);
    const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const dayOfWeek = dayNames[bkDate.getDay()];
    
    // Get branch hours for this day
    let startHour = 9; // Default fallback
    let endHour = 17; // Default fallback
    let isClosed = false;
    
    if (selectedBranch?.hours && typeof selectedBranch.hours === 'object' && !Array.isArray(selectedBranch.hours)) {
      const dayHours = (selectedBranch.hours as any)[dayOfWeek];
      if (dayHours) {
        if (dayHours.closed) {
          isClosed = true;
        } else {
          if (dayHours.open) {
            const [openH, openM] = dayHours.open.split(':').map(Number);
            startHour = openH + (openM || 0) / 60;
          }
          if (dayHours.close) {
            const [closeH, closeM] = dayHours.close.split(':').map(Number);
            endHour = closeH + (closeM || 0) / 60;
          }
        }
      }
    }

    if (isClosed) {
      return []; // Return empty slots if branch is closed
    }

    // Get service duration
    let serviceDuration = 60;
    if (forServiceId) {
      const service = servicesList.find((s) => String(s.id) === String(forServiceId)) ||
        (app ? app.data.services.find((s: any) => String(s.id) === String(forServiceId)) : null);
      serviceDuration = Number((service as any)?.duration) || 60;
    }

    // Australian booking rule: drop-off by 11 AM
    const DROPOFF_CUTOFF_MINS = 11 * 60; // 660 = 11:00 AM
    const startMinutes = Math.floor(startHour) * 60 + Math.round((startHour % 1) * 60);
    const endMinutes = Math.floor(endHour) * 60 + Math.round((endHour % 1) * 60);
    const dropoffEndMinutes = Math.min(endMinutes, DROPOFF_CUTOFF_MINS + 1); // cap drop-off loop at 11:00
    const latestSlotStart = endMinutes - serviceDuration;
    
    // Get the branch's timezone (default to Australia/Sydney if not set)
    const branchTimezone = selectedBranch?.timezone || 'Australia/Sydney';
    
    // Get current date and time in the BRANCH's timezone (not user's local time)
    // This ensures that if user is in Sri Lanka but branch is in Perth,
    // we use Perth's current time to determine which slots have passed
    const branchNow = getCurrentDateTimeInTimezone(branchTimezone);
    const branchTodayDate = branchNow.date; // YYYY-MM-DD in branch timezone
    const branchNowTime = branchNow.time; // HH:mm in branch timezone
    
    // Check if selected date is today IN THE BRANCH'S TIMEZONE
    const selectedDateStr = formatLocalYmd(bkDate);
    const isToday = selectedDateStr === branchTodayDate;
    
    // Calculate current minutes based on branch's local time
    const currentMinutes = isToday 
      ? parseInt(branchNowTime.split(':')[0]) * 60 + parseInt(branchNowTime.split(':')[1])
      : -1;
    
    const interval = 30;
    const slots: Array<{ time: string; available: boolean; reason?: string }> = [];
    const format = (minutes: number) => {
      const h = Math.floor(minutes / 60) % 24;
      const m = minutes % 60;
      return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
    };
    
    // Generate drop-off slots (capped at 11:00 AM)
    for (let current = startMinutes; current < dropoffEndMinutes; current += interval) {
      // Skip past times if date is today
      if (isToday && current <= currentMinutes) {
        continue;
      }
      
      const timeStr = format(current);
      
      // Check if service would extend past closing time
      if (current + serviceDuration > endMinutes) {
        const closeTimeStr = format(endMinutes);
        slots.push({ 
          time: timeStr, 
          available: false, 
          reason: 'closes_before_finish',
          message: `Service ends after closing time (${closeTimeStr})`
        } as any);
        continue;
      }
      
      const occupiedResult = isSlotOccupied(current);
      const blockedResult = isSlotBlockedByCurrentSelection(current);
      
      if (occupiedResult.occupied) {
        slots.push({ time: timeStr, available: false, reason: occupiedResult.reason || 'booked' });
      } else if (blockedResult.blocked) {
        slots.push({ time: timeStr, available: false, reason: blockedResult.reason || 'selected' });
      } else {
        slots.push({ time: timeStr, available: true });
      }
    }
    return slots;
  };

  // ─── Pick-up time logic (same as booking engine) ───
  // Total duration of all selected services (wizard pricing + same fallback as drop-off slot builder)
  const bkTotalServiceDuration = bkSelectedServices.reduce((sum: number, id) => {
    const s = servicesList.find((srv) => String(srv.id) === String(id));
    const pr = resolveServiceDisplayPricing(s || {});
    let d = Number(pr.duration);
    if (!Number.isFinite(d) || d < 0) d = Number(s?.duration) || 60;
    return sum + d;
  }, 0);

  // Get branch day hours for the selected date (weekday in branch TZ, not browser local)
  const bkBranchDayHours = (() => {
    if (!bkDate || !bkBranchId) return null;
    const selectedBranch = branches.find((b) => b.id === bkBranchId);
    if (!selectedBranch?.hours || typeof selectedBranch.hours !== "object" || Array.isArray(selectedBranch.hours)) return null;
    const branchTz = selectedBranch?.timezone || "Australia/Sydney";
    let dayOfWeek: string;
    try {
      dayOfWeek = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: branchTz }).format(bkDate);
    } catch {
      const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
      dayOfWeek = dayNames[bkDate.getDay()];
    }
    const dayHours = (selectedBranch.hours as any)[dayOfWeek];
    if (!dayHours || dayHours.closed) return null;
    return { open: dayHours.open || "09:00", close: dayHours.close || "17:00" };
  })();

  // Earliest allowed pick-up time = latest (drop-off + duration) across services; duration matches wizard pricing with computeSlots fallback
  const bkEarliestPickupTime = (() => {
    if (bkSelectedServices.length === 0) return null;
    if (Object.keys(bkServiceTimes).length !== bkSelectedServices.length) return null;
    let latestEndMin: number | null = null;
    for (const serviceId of bkSelectedServices) {
      const t = bkServiceTimes[String(serviceId)];
      if (t == null || String(t).trim() === "") return null;
      const dropMin = parseHhmmToMinutes(String(t));
      if (dropMin === null) return null;
      const s = servicesList.find((srv) => String(srv.id) === String(serviceId));
      const pr = resolveServiceDisplayPricing(s || {});
      let dur = Number(pr.duration);
      if (!Number.isFinite(dur) || dur < 0) dur = Number(s?.duration) || 60;
      const endMin = dropMin + dur;
      if (!Number.isFinite(endMin)) return null;
      if (latestEndMin === null || endMin > latestEndMin) latestEndMin = endMin;
    }
    if (latestEndMin === null || !Number.isFinite(latestEndMin)) return null;
    const pH = Math.floor(latestEndMin / 60);
    const pM = latestEndMin % 60;
    if (pH > 23) return null;
    return `${pH.toString().padStart(2, "0")}:${pM.toString().padStart(2, "0")}`;
  })();

  // Pick-up time slots: 2 PM – branch close, >= earliest pick-up time, not past for today (today = branch calendar date)
  const bkPickupTimeSlots = (() => {
    if (!bkEarliestPickupTime) return [];
    const hhmmToMins = (t: string) => {
      const v = parseHhmmToMinutes(t);
      return v === null ? NaN : v;
    };
    const PICKUP_START_MINS = 14 * 60; // 14:00
    const fallbackEnd = 17 * 60;
    let pickupEndMins = bkBranchDayHours ? hhmmToMins(bkBranchDayHours.close) : fallbackEnd;
    if (!Number.isFinite(pickupEndMins) || pickupEndMins < PICKUP_START_MINS) pickupEndMins = fallbackEnd;
    const earliestMins = hhmmToMins(bkEarliestPickupTime);
    if (!Number.isFinite(earliestMins)) return [];
    const slots: string[] = [];
    for (let mins = PICKUP_START_MINS; mins <= pickupEndMins; mins += 30) {
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      slots.push(`${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`);
    }
    let filtered = slots.filter((t) => hhmmToMins(t) >= earliestMins);
    if (bkDate && bkBranchId) {
      const selectedBranch = branches.find((b) => b.id === bkBranchId);
      const branchTimezone = selectedBranch?.timezone || "Australia/Sydney";
      const branchNow = getCurrentDateTimeInTimezone(branchTimezone);
      const selectedDateStr = formatYmdInTimezone(bkDate, branchTimezone);
      if (selectedDateStr === branchNow.date) {
        const nowM = hhmmToMins(branchNow.time);
        if (Number.isFinite(nowM)) {
          filtered = filtered.filter((t) => hhmmToMins(t) > nowM);
        }
      }
    }
    return filtered;
  })();

  // Clear pick-up time when drop-off times change or become invalid
  // Using a separate handler since we can't use useEffect inside computations
  const prevEarliestRef = React.useRef<string | null>(null);
  if (prevEarliestRef.current !== bkEarliestPickupTime) {
    prevEarliestRef.current = bkEarliestPickupTime;
    if (bkPickupTime && bkEarliestPickupTime && bkPickupTime < bkEarliestPickupTime) {
      // Defer state update
      setTimeout(() => setBkPickupTime(""), 0);
    }
  }
  // Clear pickup time if all service times are cleared
  if (bkPickupTime && Object.keys(bkServiceTimes).length === 0) {
    setTimeout(() => setBkPickupTime(""), 0);
  }

  // Helper: check if a date is a closed day
  const isBranchClosedOnDate = (d: Date): boolean => {
    if (!bkBranchId) return false;
    const selectedBranch = branches.find((b) => b.id === bkBranchId);
    if (!selectedBranch?.hours || typeof selectedBranch.hours !== "object" || Array.isArray(selectedBranch.hours)) return false;
    const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const dayOfWeek = dayNames[d.getDay()];
    const dayHours = (selectedBranch.hours as any)[dayOfWeek];
    return dayHours?.closed === true;
  };

  const handleConfirmBooking = () => {
    const app = appRef();
    if (bkSelectedServices.length === 0 || !bkBranchId || !bkDate) return;
    
    // Validate all services have times
    if (Object.keys(bkServiceTimes).length !== bkSelectedServices.length) {
      app?.showToast("Please select a time for each service.", "error");
      return;
    }

    // Validate pick-up time is selected
    if (!bkPickupTime) {
      app?.showToast("Please select a pick-up time.", "error");
      return;
    }

    setSubmittingBooking(true);
    
    const selectedServiceObjects = bkSelectedServices.map(id => 
      servicesList.find((s) => String(s.id) === String(id)) ||
      (app ? app.data.services.find((s: any) => String(s.id) === String(id)) : null)
    ).filter(Boolean);

    // Resolve per-service price & duration against the selected vehicle type so
    // the admin-created booking picks up the same tier-based pricing as the
    // booking engine. The API re-resolves this server-side, but sending the
    // resolved values here keeps the UI totals consistent with what gets
    // written to Firestore.
    const resolvedSelectedServices = selectedServiceObjects.map((s) => {
      if (!s) return s;
      const pricing = resolveServiceDisplayPricing(s);
      return {
        ...s,
        resolvedPrice: typeof pricing.price === "number" ? pricing.price : Number(s.price) || 0,
        resolvedDuration: typeof pricing.duration === "number" ? pricing.duration : Number(s.duration) || 0,
      };
    });

    const serviceName = resolvedSelectedServices.map(s => s?.name || "").join(", ");
    const serviceIds = resolvedSelectedServices.map(s => s?.id).join(",");
    const totalPrice = resolvedSelectedServices.reduce((sum, s: any) => sum + (Number(s?.resolvedPrice) || 0), 0);
    const totalDuration = resolvedSelectedServices.reduce((sum, s: any) => sum + (Number(s?.resolvedDuration) || 0), 0);
    
    // Use first service time as main booking time
    const firstServiceId = bkSelectedServices[0];
    const mainTime = bkServiceTimes[String(firstServiceId)];
    
    const selectedBranch = branches.find((b: any) => String(b.id) === String(bkBranchId));
    const branchName = selectedBranch?.name || "";
    const branchTimezone = selectedBranch?.timezone || "Australia/Sydney"; // Default to Australia/Sydney if not set
    
    // Determine main staff info
    const uniqueStaffIds = new Set(Object.values(bkServiceStaff).filter(Boolean));
    let mainStaffId: string | null = null;
    let mainStaffName = "Not Assigned Yet";
    
    if (uniqueStaffIds.size === 1) {
      const sid = Array.from(uniqueStaffIds)[0];
      mainStaffId = sid;
      mainStaffName = staffList.find(st => st.id === sid)?.name || "Not Assigned Yet";
    } else if (uniqueStaffIds.size > 1) {
      mainStaffName = "Multiple Staff";
    }

    const client = bkClientName?.trim() || "Walk-in";
    
    const newBooking = {
      id: Date.now(),
      client,
      serviceId: serviceIds, // Comma separated IDs
      serviceName,
      staffId: mainStaffId,
      staffName: mainStaffName,
      branchId: bkBranchId,
      branchName,
      date: formatLocalYmd(bkDate),
      time: mainTime,
      pickupTime: bkPickupTime || null,
      duration: totalDuration,
      status: "Pending",
      price: totalPrice,
      clientEmail: bkClientEmail?.trim() || undefined,
      clientPhone: bkClientPhone?.trim() || undefined,
      vehicleNumber: bkVehicleNumber?.trim() || undefined,
      vehicleType: bkVehicleType || undefined,
      vehicleBodyType: bkVehicleBodyType?.trim() || undefined,
      vehicleColour: bkVehicleColour?.trim() || undefined,
      vehicleVinChassis: bkVehicleVinChassis?.trim() || undefined,
      vehicleEngineNumber: bkVehicleEngineNumber?.trim() || undefined,
      vehicleMileage: bkVehicleMileage?.trim() || undefined,
      notes: bkNotes?.trim() || undefined,
      services: resolvedSelectedServices.map((s: any) => {
        const sId = String(s?.id);
        const stId = bkServiceStaff[sId];
        const stName = stId ? staffList.find(st => st.id === stId)?.name : "Not Assigned Yet";
        return {
          id: s?.id,
          name: s?.name,
          price: s?.resolvedPrice,
          duration: s?.resolvedDuration,
          time: bkServiceTimes[sId],
          staffId: stId || null,
          staffName: stName,
          vehicleType: bkVehicleType || undefined,
        };
      })
    };
    
    // Persist to backend - Firestore listener will update the UI automatically
    (async () => {
      try {
        await createBooking({
          client: newBooking.client,
          clientEmail: newBooking.clientEmail,
          clientPhone: newBooking.clientPhone,
          vehicleNumber: newBooking.vehicleNumber,
          vehicleType: newBooking.vehicleType,
          vehicleBodyType: newBooking.vehicleBodyType,
          vehicleColour: newBooking.vehicleColour,
          vehicleVinChassis: newBooking.vehicleVinChassis,
          vehicleEngineNumber: newBooking.vehicleEngineNumber,
          vehicleMileage: newBooking.vehicleMileage,
          notes: newBooking.notes,
          serviceId: newBooking.serviceId,
          serviceName: newBooking.serviceName,
          staffId: newBooking.staffId,
          staffName: newBooking.staffName,
          branchId: newBooking.branchId,
          branchName: newBooking.branchName,
          branchTimezone: branchTimezone, // Include branch timezone for proper conversion
          date: newBooking.date,
          time: newBooking.time,
          pickupTime: newBooking.pickupTime, // Pick-up time
          duration: newBooking.duration,
          status: newBooking.status as any,
          price: newBooking.price,
          services: newBooking.services, // Pass detailed services array
        } as any); // Type assertion needed until we update lib
        
        // Don't add locally - Firestore listener will handle it to avoid duplicates
        if (app) {
          app.closeModal("booking");
          app.showToast("New Booking Created!");
        }
      } catch (error: any) {
        console.error("Error creating booking:", error);
        if (app) {
          app.closeModal("booking");
          
          // Check if it's a conflict error (409) or contains booking conflict message
          let errorMessage = "Failed to create booking";
          
          if (error.status === 409 || (error.message && error.message.includes("already booked"))) {
            errorMessage = error.details || "This time slot has already been booked. Please select a different time.";
          } else if (error.message && error.message.includes("conflicts")) {
            errorMessage = error.message;
          } else if (error.details) {
            errorMessage = error.details;
          } else if (error.message) {
            errorMessage = error.message;
          }
          
          app.showToast(errorMessage, "error");
        }
      } finally {
        setSubmittingBooking(false);
        resetWizard();
      }
    })();
  };

  return (
    <>
      <Script
        src="https://cdn.jsdelivr.net/npm/chart.js"
        strategy="afterInteractive"
        onLoad={() => setChartReady(true)}
      />
      <div id="app" className="flex h-screen overflow-hidden bg-white">
        <Sidebar />
        <div className="flex-1 flex flex-col overflow-hidden">
          <main className="flex-1 overflow-auto p-4 sm:p-6 lg:p-8 bg-neutral-50">
            <div className="md:hidden mb-4">
              <button
                className="inline-flex items-center gap-2 rounded-lg border border-neutral-200 px-3 py-2 text-neutral-700 shadow-sm hover:bg-neutral-50"
                onClick={() => setMobileOpen(true)}
              >
                <i className="fas fa-bars" />
                Menu
              </button>
            </div>

            {mobileOpen && (
              <div className="fixed inset-0 z-50 md:hidden">
                <div className="absolute inset-0 bg-black/40" onClick={() => setMobileOpen(false)} />
                <div className="absolute left-0 top-0 bottom-0">
                  <Sidebar mobile onClose={() => setMobileOpen(false)} />
                </div>
              </div>
            )}

            <div className="max-w-7xl mx-auto">
              <div className="mb-8">
                <div className="relative rounded-2xl bg-neutral-900 text-white p-8 shadow-lg overflow-hidden">
                  <div className="absolute inset-0 overflow-hidden">
                    <div className="absolute -top-6 -right-6 w-36 h-36 rounded-full bg-amber-500/10" />
                    <div className="absolute -bottom-10 -left-10 w-44 h-44 rounded-full bg-amber-500/5" />
                    <i className="fas fa-gear absolute -right-3 -bottom-3 text-[90px] text-white/[0.03] rotate-12" />
                  </div>
                  <div className="relative flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-xl bg-amber-500/20 border border-amber-500/30 flex items-center justify-center">
                          <i className="fas fa-calendar-check text-amber-400" />
                        </div>
                        <h1 className="text-2xl font-bold tracking-tight">Today&apos;s Bookings</h1>
                      </div>
                      <p className="text-neutral-400 mt-2">
                        Today's schedule, availability, and status.
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              <section id="view-bookings" className="view-section active">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-6">
                  <h2 className="text-2xl font-bold text-neutral-800">Today&apos;s Bookings</h2>
                  <button
                    onClick={openBookingWizard}
                    className="w-full sm:w-auto px-4 py-2 bg-neutral-900 text-white rounded-lg text-sm hover:bg-neutral-800 font-medium shadow-md transition"
                  >
                    <i className="fas fa-plus mr-2" /> New Booking
                  </button>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                  <div className="lg:col-span-2 bg-white rounded-2xl border border-neutral-200 shadow-sm overflow-hidden">
                    <table className="w-full text-left text-sm text-neutral-600">
                      <thead className="bg-neutral-50 text-neutral-800 font-semibold border-b border-neutral-100">
                        <tr>
                          <th className="p-4 pl-6">Client &amp; Service</th>
                          <th className="p-4">Time &amp; Staff</th>
                          <th className="p-4 text-center">Status</th>
                          <th className="p-4 text-right pr-6">Value</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-neutral-100" id="bookings-table-body" />
                    </table>
                  </div>
                  <div className="space-y-6">
                    <div className="bg-neutral-900 text-white rounded-2xl shadow-sm p-6">
                      <h3 className="font-bold mb-4 flex justify-between items-center">
                        Today&apos;s Summary
                        <i className="fas fa-chart-line text-amber-400" />
                      </h3>
                      <div className="space-y-4">
                        <div className="bg-white/10 p-3 rounded-lg flex justify-between">
                          <span>Confirmed Value</span>
                          <span className="font-bold text-green-400" id="analytics-revenue">$0</span>
                        </div>
                        <div className="bg-white/10 p-3 rounded-lg flex justify-between">
                          <span>Confirmed Bookings</span>
                          <span className="font-bold" id="analytics-confirmed-count">0</span>
                        </div>
                        <div className="bg-white/10 p-3 rounded-lg flex justify-between">
                          <span>Avg Service Duration</span>
                          <span className="font-bold" id="analytics-avg-duration">0 mins</span>
                        </div>
                      </div>
                    </div>
                    <div className="bg-white rounded-2xl border border-neutral-200 shadow-sm p-6">
                      <h3 className="font-bold mb-4 text-neutral-800">Booking Status Mix</h3>
                      <div className="h-40">
                        <canvas id="statusChart" />
                      </div>
                    </div>
                  </div>
                </div>

                {/* Full-width Booking Data Export & Import section */}
                <div className="mt-8 w-full bg-neutral-900 text-white rounded-2xl shadow-sm p-6">
                  <h3 className="font-bold mb-2">Booking Data Export & Import</h3>
                  <p className="text-sm text-neutral-400 mb-4">Export bookings to CSV or import from CSV. For export, choose which statuses to include.</p>
                  <div className="flex gap-4">
                    <div className="flex-1 min-w-0">
                      <BookingsExportButton />
                    </div>
                    <div className="flex-1 min-w-0">
                      <BookingsImportButton />
                    </div>
                  </div>
                </div>
              </section>
            </div>
          </main>
        </div>
      </div>

      {/* Toasts */}
      <div id="toast-container" className="fixed bottom-5 right-5 z-50" />

      {/* Booking Modal - Creative Multi-step Wizard */}
      <div id="modal-booking" className="modal-backdrop">
        <div className="bg-white rounded-3xl shadow-2xl w-full max-w-3xl mx-4 sm:mx-0 h-[88vh] flex flex-col overflow-hidden relative">
          
          {/* Decorative Header with Gradient */}
          <div className="relative overflow-hidden shrink-0">
            <div className="absolute inset-0 bg-gradient-to-br from-neutral-900 via-neutral-800 to-neutral-900" />
            <div className="absolute inset-0 opacity-10">
              <svg className="w-full h-full" xmlns="http://www.w3.org/2000/svg">
                <defs>
                  <pattern id="admin-grid" width="40" height="40" patternUnits="userSpaceOnUse">
                    <path d="M 40 0 L 0 0 0 40" fill="none" stroke="white" strokeWidth="0.5" />
                  </pattern>
                </defs>
                <rect width="100%" height="100%" fill="url(#admin-grid)" />
              </svg>
            </div>
            <div className="absolute top-0 right-0 w-64 h-64 bg-amber-500/10 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2" />
            <div className="absolute bottom-0 left-0 w-48 h-48 bg-emerald-500/10 rounded-full blur-3xl translate-y-1/2 -translate-x-1/4" />
            
            <div className="relative z-10 p-4 sm:p-5">
              <div className="flex justify-between items-start">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center shadow-lg shadow-amber-500/25">
                    <i className="fas fa-calendar-check text-white text-lg" />
                  </div>
                  <div>
                    <h3 className="text-xl font-black text-white tracking-tight">Book an Appointment</h3>
                    <p className="text-neutral-400 text-xs mt-0.5 font-medium">
                      {bkStep === 1 ? "Choose location & services" : bkStep === 2 ? "Select date, time & staff" : "Review & confirm booking"}
                    </p>
                  </div>
                </div>
                <button onClick={() => appRef()?.closeModal("booking")} className="w-9 h-9 rounded-xl bg-white/10 hover:bg-white/20 text-white/60 hover:text-white flex items-center justify-center transition-all group">
                  <i className="fas fa-xmark text-sm group-hover:rotate-90 transition-transform duration-300" />
                </button>
              </div>

            </div>
          </div>

          {/* Progress Bar - Booking Engine Style */}
          <div className="px-4 sm:px-5 py-2.5 bg-white border-b border-neutral-200/80">
            <div className="flex items-center">
              {[
                { n: 1, label: "Location", icon: "fa-location-dot" },
                { n: 2, label: "Schedule", icon: "fa-clock" },
                { n: 3, label: "Confirm", icon: "fa-check-circle" },
              ].map((s, i) => (
                <React.Fragment key={s.n}>
                  {i > 0 && (
                    <div className="flex-1 mx-2 sm:mx-3 h-[3px] rounded-full bg-neutral-200 relative overflow-hidden">
                      <div
                        className="absolute inset-y-0 left-0 bg-amber-500 rounded-full transition-all duration-700 ease-out"
                        style={{ width: bkStep > s.n - 1 ? "100%" : "0%" }}
                      />
                    </div>
                  )}
                  <button
                    onClick={() => { if (s.n < bkStep) setBkStep(s.n as 1 | 2 | 3); }}
                    disabled={s.n > bkStep}
                    className="flex items-center gap-2 group"
                  >
                    <div className={`relative w-9 h-9 rounded-xl flex items-center justify-center text-xs font-bold transition-all duration-500 ${
                      bkStep > s.n
                        ? "bg-amber-500 text-white shadow-lg shadow-amber-500/25"
                        : bkStep === s.n
                        ? "bg-neutral-900 text-white shadow-lg shadow-neutral-900/15 scale-105"
                        : "bg-neutral-200 text-neutral-400"
                    }`}>
                      {bkStep > s.n ? (
                        <i className="fas fa-check text-[10px]" />
                      ) : (
                        <i className={`fas ${s.icon} text-[11px]`} />
                      )}
                      {bkStep === s.n && (
                        <div className="absolute inset-0 rounded-xl border-2 border-neutral-700/40 animate-pulse" />
                      )}
                    </div>
                    <span className={`text-xs font-semibold hidden sm:block transition-colors duration-300 ${
                      bkStep >= s.n ? "text-neutral-900" : "text-neutral-400"
                    }`}>
                      {s.label}
                    </span>
                  </button>
                </React.Fragment>
              ))}
            </div>
          </div>

          {/* Scrollable Content */}
          <div className="flex-1 overflow-y-auto p-4 sm:p-5 bg-neutral-50/50 custom-scrollbar">
            {/* Step 1 - Branch & Service (Combined) */}
            {bkStep === 1 && (
              <div className="animate-[fadeSlideUp_0.5s_ease-out]">
                {/* Branch Selection */}
                <div className="mb-3">
                  <div className="flex items-end justify-between mb-2.5">
                    <div>
                      <h3 className="text-base sm:text-lg font-bold text-neutral-900 tracking-tight">Choose a location</h3>
                      <p className="text-neutral-500 text-[11px] leading-snug mt-0.5">
                        {userRole === "branch_admin" ? "Your assigned branch is pre-selected" : "Select the workshop branch"}
                      </p>
                    </div>
                    <span className="text-[10px] text-neutral-400 font-semibold bg-neutral-100 px-2.5 py-1 rounded-full hidden sm:block">
                      {branches.length} location{branches.length !== 1 ? "s" : ""}
                    </span>
                  </div>

                  {branches.length === 0 ? (
                    <div className="text-center py-12 bg-white rounded-2xl border border-neutral-200/80 shadow-sm">
                      <div className="w-16 h-16 bg-neutral-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
                        <i className="fas fa-store text-xl text-neutral-300" />
                      </div>
                      <p className="text-neutral-500 font-medium text-sm">No locations available</p>
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {branches.map((br: any, idx: number) => {
                        const selected = bkBranchId === br.id;
                        const isBranchAdmin = userRole === "branch_admin";
                        return (
                          <button
                            key={br.id}
                            onClick={() => !isBranchAdmin && (setBkBranchId(br.id), setBkSelectedServices([]), setBkServiceStaff({}), setBkDate(null), setBkServiceTimes({}))}
                            disabled={isBranchAdmin}
                            className={`text-left rounded-2xl border-2 p-3 transition-all duration-300 group ${
                              isBranchAdmin ? "cursor-not-allowed" : "cursor-pointer"
                            } ${selected
                              ? "border-neutral-900 bg-white shadow-xl shadow-neutral-900/[0.08]"
                              : "border-neutral-200/80 bg-white hover:border-neutral-300 hover:shadow-lg hover:shadow-neutral-900/[0.03]"
                            }`}
                            style={{ animation: `fadeSlideUp 0.4s ease-out ${idx * 80}ms both` }}
                          >
                            <div className="flex items-stretch">
                              <div className={`w-1.5 flex-shrink-0 rounded-full transition-all duration-300 mr-3 ${selected ? "bg-amber-500" : "bg-transparent group-hover:bg-neutral-200"}`} />
                              <div className="flex items-center gap-3 flex-1 min-w-0">
                                <div className={`w-11 h-11 rounded-xl flex items-center justify-center shrink-0 transition-all duration-300 ${
                                  selected ? "bg-neutral-900 shadow-md shadow-neutral-900/20" : "bg-neutral-100 group-hover:bg-neutral-200"
                                }`}>
                                  {selected ? (
                                    <i className="fas fa-check text-white text-xs" />
                                  ) : (
                                    <i className="fas fa-store text-neutral-400 text-sm" />
                                  )}
                                </div>
                                <div className="flex-1 min-w-0">
                                  <div className="font-bold text-neutral-900 truncate text-sm">{br.name}</div>
                                  <div className="text-xs text-neutral-400 truncate mt-0.5">{br.address}</div>
                                </div>
                              </div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Vehicle Type Selection — drives per-type pricing for services below */}
                <div className={`mt-3 mb-3 transition-all duration-300 ${!bkBranchId ? "opacity-40 pointer-events-none" : ""}`}>
                  <div className="mb-1.5">
                    <h3 className="text-base sm:text-lg font-bold text-neutral-900 tracking-tight flex items-center gap-2">
                      <i className="fas fa-car text-amber-500 text-sm" />
                      Vehicle type
                    </h3>
                    <p className="text-neutral-500 text-[11px] leading-snug mt-0.5">
                      Choose the size class so we can show you the right price for each service.
                    </p>
                  </div>
                  <div className="space-y-1.5">
                    <div className="grid grid-cols-3 gap-1.5">
                      {VEHICLE_TYPES.slice(0, 3).map((vt) => {
                        const active = bkVehicleType === vt;
                        return (
                          <button
                            key={vt}
                            type="button"
                            title={VEHICLE_TYPE_LABELS[vt]}
                            onClick={() => {
                              if (bkVehicleType === vt) return;
                              setBkVehicleType(vt);
                              setBkSelectedServices((prev) =>
                                prev.filter((id) => {
                                  const s = servicesList.find((x) => String(x.id) === String(id));
                                  if (!s) return false;
                                  const tier = s.vehicleTypePricing?.[vt];
                                  if (tier) return true;
                                  return (!s.vehicleTypes || s.vehicleTypes.length === 0) && typeof s.price === "number";
                                }),
                              );
                              setBkServiceTimes({});
                              setBkDate(null);
                            }}
                          className={`rounded-xl border-2 p-1.5 text-left transition-all h-full min-h-0 flex items-center ${
                            active
                              ? "border-neutral-900 bg-white shadow-xl shadow-neutral-900/[0.08]"
                              : "border-neutral-200/80 bg-white hover:border-neutral-300"
                          }`}
                          aria-pressed={active}
                        >
                          <div className="w-full min-h-0 flex items-center gap-1.5">
                            <div
                              className={`w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 transition-all ${
                                active ? "bg-neutral-900 text-white" : "bg-neutral-100 text-neutral-500"
                              }`}
                            >
                              <i className={`${VEHICLE_TYPE_ICONS[vt]} text-[10px]`} />
                            </div>
                            <p className="flex-1 min-w-0 text-xs font-bold text-neutral-900 leading-tight break-words text-balance text-left">
                              {VEHICLE_TYPE_LABELS[vt]}
                            </p>
                            {active && (
                              <i className="fas fa-check text-amber-500 text-[10px] flex-shrink-0" aria-hidden />
                            )}
                          </div>
                        </button>
                        );
                      })}
                    </div>
                    <div className="flex justify-center">
                      <div className="grid grid-cols-2 gap-1.5 w-2/3 min-w-0 max-w-full">
                        {VEHICLE_TYPES.slice(3, 5).map((vt) => {
                          const active = bkVehicleType === vt;
                          return (
                            <button
                              key={vt}
                              type="button"
                              title={VEHICLE_TYPE_LABELS[vt]}
                              onClick={() => {
                                if (bkVehicleType === vt) return;
                                setBkVehicleType(vt);
                                setBkSelectedServices((prev) =>
                                  prev.filter((id) => {
                                    const s = servicesList.find((x) => String(x.id) === String(id));
                                    if (!s) return false;
                                    const tier = s.vehicleTypePricing?.[vt];
                                    if (tier) return true;
                                    return (!s.vehicleTypes || s.vehicleTypes.length === 0) && typeof s.price === "number";
                                  }),
                                );
                                setBkServiceTimes({});
                                setBkDate(null);
                              }}
                              className={`rounded-xl border-2 p-1.5 text-left transition-all h-full min-h-0 flex items-center ${
                                active
                                  ? "border-neutral-900 bg-white shadow-xl shadow-neutral-900/[0.08]"
                                  : "border-neutral-200/80 bg-white hover:border-neutral-300"
                              }`}
                              aria-pressed={active}
                            >
                              <div className="w-full min-h-0 flex items-center gap-1.5">
                                <div
                                  className={`w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 transition-all ${
                                    active ? "bg-neutral-900 text-white" : "bg-neutral-100 text-neutral-500"
                                  }`}
                                >
                                  <i className={`${VEHICLE_TYPE_ICONS[vt]} text-[10px]`} />
                                </div>
                                <p className="flex-1 min-w-0 text-xs font-bold text-neutral-900 leading-tight break-words text-balance text-left">
                                  {VEHICLE_TYPE_LABELS[vt]}
                                </p>
                                {active && (
                                  <i className="fas fa-check text-amber-500 text-[10px] flex-shrink-0" aria-hidden />
                                )}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Service Selection */}
                <div className={`transition-all duration-300 ${!bkBranchId || !bkVehicleType ? "opacity-40 pointer-events-none" : ""}`}>
                  <div className="flex items-start sm:items-center justify-between mb-2 gap-1.5 flex-col sm:flex-row">
                    <div>
                      {bkBranchId && (
                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                          <span className="inline-flex items-center gap-1.5 bg-neutral-900 text-white text-[10px] font-semibold px-2.5 py-0.5 rounded-full">
                            <i className="fas fa-location-dot text-amber-400 text-[8px]" />
                            {branches.find((b: any) => b.id === bkBranchId)?.name}
                          </span>
                          {bkVehicleType && (
                            <span className="inline-flex items-center gap-1.5 bg-amber-100 text-amber-800 text-[10px] font-semibold px-2.5 py-0.5 rounded-full">
                              <i className={`${VEHICLE_TYPE_ICONS[bkVehicleType]} text-[8px]`} />
                              {VEHICLE_TYPE_LABELS[bkVehicleType]}
                            </span>
                          )}
                        </div>
                      )}
                      <h3 className="text-base sm:text-lg font-bold text-neutral-900 tracking-tight">Pick your services</h3>
                      <p className="text-neutral-500 text-[11px] leading-snug mt-0.5">
                        {bkVehicleType
                          ? `Prices shown are for ${VEHICLE_TYPE_LABELS[bkVehicleType]}.`
                          : "Select a vehicle type to see prices."}
                      </p>
                    </div>
                    {bkSelectedServices.length > 0 && (
                      <div className="bg-amber-50 border border-amber-200/50 rounded-xl px-3 py-1.5 flex items-center gap-2">
                        <span className="w-5 h-5 rounded-full bg-amber-500 text-white text-[9px] font-bold flex items-center justify-center">{bkSelectedServices.length}</span>
                        <span className="text-xs font-semibold text-amber-800">selected</span>
                      </div>
                    )}
                  </div>

                  {!bkBranchId ? (
                    <div className="text-center py-7 bg-white rounded-2xl border border-neutral-200/80 shadow-sm">
                      <div className="w-14 h-14 bg-neutral-100 rounded-xl flex items-center justify-center mx-auto mb-3 relative">
                        <i className="fas fa-wrench text-lg text-neutral-300" />
                        <div className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full bg-amber-100 flex items-center justify-center border-2 border-white">
                          <i className="fas fa-arrow-up text-amber-600 text-[7px]" />
                        </div>
                      </div>
                      <p className="text-neutral-500 font-medium text-sm">Select a branch first</p>
                      <p className="text-neutral-400 text-xs mt-0.5">Choose a location above to see available services</p>
                    </div>
                  ) : !bkVehicleType ? (
                    <div className="text-center py-7 bg-white rounded-2xl border border-neutral-200/80 shadow-sm">
                      <div className="w-14 h-14 bg-neutral-100 rounded-xl flex items-center justify-center mx-auto mb-3 relative">
                        <i className="fas fa-car text-lg text-neutral-300" />
                        <div className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full bg-amber-100 flex items-center justify-center border-2 border-white">
                          <i className="fas fa-arrow-up text-amber-600 text-[7px]" />
                        </div>
                      </div>
                      <p className="text-neutral-500 font-medium text-sm">Choose a vehicle type</p>
                      <p className="text-neutral-400 text-xs mt-0.5">Prices and eligible services depend on the vehicle size class.</p>
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                      {availableServicesForWizard.map((srv: any, idx: number) => {
                        const isSelected = bkSelectedServices.includes(srv.id);
                        const displayPricing = resolveServiceDisplayPricing(srv);
                        return (
                          <div
                            key={srv.id}
                            className={`rounded-2xl border-2 transition-all duration-300 overflow-hidden ${
                              isSelected
                                ? "border-neutral-900 bg-white shadow-xl shadow-neutral-900/[0.08]"
                                : "border-neutral-200/80 bg-white hover:border-neutral-300 hover:shadow-lg hover:shadow-neutral-900/[0.03]"
                            }`}
                            style={{ animation: `fadeSlideUp 0.4s ease-out ${idx * 60}ms both` }}
                          >
                            <button
                              onClick={() => {
                                if (isSelected) {
                                  setBkSelectedServices(bkSelectedServices.filter(id => id !== srv.id));
                                  const newTimes = { ...bkServiceTimes };
                                  delete newTimes[String(srv.id)];
                                  setBkServiceTimes(newTimes);
                                } else {
                                  setBkSelectedServices([...bkSelectedServices, srv.id]);
                                }
                                setBkDate(null);
                              }}
                              className="w-full text-left group"
                            >
                              <div className="flex items-stretch">
                                <div className={`w-1.5 flex-shrink-0 transition-all duration-300 ${isSelected ? "bg-amber-500" : "bg-transparent group-hover:bg-neutral-200"}`} />
                                <div className="flex items-center gap-2.5 p-2.5 sm:p-3 flex-1 min-w-0">
                                  <div className={`w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0 transition-all duration-300 ${
                                    isSelected
                                      ? "bg-neutral-900 shadow-md shadow-neutral-900/20 scale-105"
                                      : "bg-neutral-100 group-hover:bg-neutral-200"
                                  }`}>
                                    {isSelected ? (
                                      <i className="fas fa-check text-white text-[10px]" />
                                    ) : (
                                      <i className="fas fa-plus text-neutral-400 text-[10px]" />
                                    )}
                                  </div>
                                  {srv.imageUrl ? (
                                    <img src={srv.imageUrl} alt={srv.name} className="w-12 h-12 rounded-xl object-cover flex-shrink-0 border border-neutral-100" />
                                  ) : (
                                    <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-neutral-100 to-neutral-50 flex items-center justify-center flex-shrink-0">
                                      <i className="fas fa-wrench text-neutral-300 text-sm" />
                                    </div>
                                  )}
                                  <div className="flex-1 min-w-0">
                                    <h4 className="font-bold text-neutral-900 text-sm truncate">{srv.name}</h4>
                                    <div className="flex items-center gap-3 mt-0.5 flex-wrap">
                                      {typeof displayPricing.duration === "number" && (
                                        <span className="text-[10px] text-neutral-400 flex items-center gap-1">
                                          <i className="far fa-clock text-[8px]" />
                                          {displayPricing.duration} min
                                        </span>
                                      )}
                                      {typeof displayPricing.price === "number" && (
                                        <>
                                          <span className="text-[10px] text-neutral-400">•</span>
                                          <span className="text-xs font-bold text-neutral-700">
                                            {displayPricing.isStartingFrom ? "from " : ""}${displayPricing.price}
                                          </span>
                                        </>
                                      )}
                                      {bkVehicleType && (
                                        <span className="inline-flex items-center gap-1 bg-amber-50 border border-amber-100 text-amber-700 text-[9px] font-semibold px-1.5 py-0.5 rounded-md">
                                          <i className={`${VEHICLE_TYPE_ICONS[bkVehicleType]} text-[8px]`} />
                                          {VEHICLE_TYPE_LABELS[bkVehicleType]}
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                </div>
                              </div>
                            </button>
                          </div>
                        );
                      })}
                      {availableServicesForWizard.length === 0 && (
                        <div className="text-center py-12 bg-white rounded-2xl border border-neutral-200/80 shadow-sm">
                          <div className="w-16 h-16 bg-neutral-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
                            <i className="fas fa-wrench text-xl text-neutral-300" />
                          </div>
                          <p className="text-neutral-500 font-medium text-sm">No services available</p>
                          <p className="text-neutral-400 text-xs mt-1">This branch doesn&apos;t have services listed yet.</p>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Summary Footer + Navigation */}
                {bkSelectedServices.length > 0 && (
                  <div className="mt-3 bg-neutral-900 rounded-2xl p-3 text-white relative overflow-hidden">
                    <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/[0.03] to-transparent" />
                    <div className="relative z-10 flex items-center justify-between">
                      <div>
                        <p className="text-neutral-400 text-[10px] font-medium">
                          {bkSelectedServices.length} service{bkSelectedServices.length > 1 ? "s" : ""} · {bkSelectedServices.reduce((sum: number, id) => {
                            const s = servicesList.find((srv: any) => String(srv.id) === String(id));
                            if (!s) return sum;
                            const { duration } = resolveServiceDisplayPricing(s);
                            return sum + (Number(duration) || 0);
                          }, 0)} min
                          {bkVehicleType && (
                            <span className="ml-2 inline-flex items-center gap-1 bg-amber-500/20 text-amber-200 px-1.5 py-0.5 rounded-md text-[9px] font-semibold">
                              <i className={`${VEHICLE_TYPE_ICONS[bkVehicleType]} text-[8px]`} />
                              {VEHICLE_TYPE_LABELS[bkVehicleType]}
                            </span>
                          )}
                        </p>
                        <p className="text-xl font-extrabold tracking-tight mt-0.5">
                          ${bkSelectedServices.reduce((sum: number, id) => {
                            const s = servicesList.find((srv: any) => String(srv.id) === String(id));
                            if (!s) return sum;
                            const { price } = resolveServiceDisplayPricing(s);
                            return sum + (Number(price) || 0);
                          }, 0)}
                        </p>
                      </div>
                      <button
                        disabled={!bkBranchId || !bkVehicleType || bkSelectedServices.length === 0}
                        onClick={() => setBkStep(2)}
                        className="group bg-amber-500 hover:bg-amber-400 text-neutral-900 font-bold px-4 py-2 rounded-lg transition-all text-sm active:scale-[0.97] shadow-lg shadow-amber-500/25 flex items-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed"
                      >
                        Continue
                        <i className="fas fa-arrow-right text-xs group-hover:translate-x-1 transition-transform" />
                      </button>
                    </div>
                  </div>
                )}
                {bkSelectedServices.length === 0 && (
                  <div className="flex justify-end pt-2 mt-2 border-t border-neutral-200/50">
                    <button
                      disabled
                      className="px-4 py-2 rounded-lg bg-neutral-200 text-neutral-400 text-sm font-semibold cursor-not-allowed"
                    >
                      Continue to Date & Time
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Step 2 - Date, Time & Staff */}
            {bkStep === 2 && (
              <div className="animate-[fadeSlideUp_0.4s_ease-out]">
                <div className="flex items-start sm:items-center justify-between mb-5 gap-2 flex-col sm:flex-row">
                  <div>
                    <div className="flex items-center gap-2 mb-1.5">
                      <button onClick={() => setBkStep(1)} className="w-8 h-8 rounded-xl bg-neutral-100 hover:bg-neutral-200 flex items-center justify-center transition group">
                        <i className="fas fa-arrow-left text-[10px] text-neutral-500 group-hover:-translate-x-0.5 transition-transform" />
                      </button>
                      <span className="inline-flex items-center gap-1.5 bg-neutral-900 text-white text-[10px] font-semibold px-2.5 py-0.5 rounded-full">
                        <i className="fas fa-location-dot text-amber-400 text-[8px]" />
                        {branches.find((b: any) => b.id === bkBranchId)?.name}
                      </span>
                      <span className="inline-flex items-center gap-1 bg-amber-50 border border-amber-200/50 text-amber-700 text-[10px] font-semibold px-2 py-0.5 rounded-full">
                        {bkSelectedServices.length} service{bkSelectedServices.length > 1 ? "s" : ""}
                      </span>
                    </div>
                    <h3 className="text-lg sm:text-xl font-bold text-neutral-900 tracking-tight">Schedule your visit</h3>
                    <p className="text-neutral-500 text-xs mt-0.5">Choose a date, assign staff, and set drop-off & pick-up times</p>
                  </div>
                </div>

                {/* Date & Time Section - Booking Engine Style */}
                <div className="bg-white rounded-2xl border border-neutral-200/80 p-4 sm:p-5 shadow-sm mb-5">
                  <h4 className="font-bold text-neutral-900 mb-4 flex items-center gap-2.5 text-sm">
                    <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center shadow-md shadow-amber-500/10">
                      <i className="fas fa-calendar text-white text-xs" />
                    </div>
                    When would you like to book?
                  </h4>

                  {/* Calendar */}
                  <div className="border-2 border-neutral-200 rounded-xl overflow-hidden bg-white">
                    <div className="px-3 py-2.5 bg-neutral-50 border-b border-neutral-100 flex items-center justify-between">
                      <span className="text-xs font-bold text-neutral-800">{monthName}</span>
                      <div className="flex items-center gap-1">
                        <button onClick={goPrevMonth} className="w-7 h-7 rounded-lg bg-white hover:bg-neutral-100 text-neutral-600 text-xs border border-neutral-200 flex items-center justify-center transition">
                          <i className="fas fa-chevron-left text-[9px]" />
                        </button>
                        <button onClick={goNextMonth} className="w-7 h-7 rounded-lg bg-white hover:bg-neutral-100 text-neutral-600 text-xs border border-neutral-200 flex items-center justify-center transition">
                          <i className="fas fa-chevron-right text-[9px]" />
                        </button>
                      </div>
                    </div>
                    <div className="grid grid-cols-7 text-[10px] font-bold bg-neutral-50/50 text-neutral-400 uppercase tracking-wider">
                      {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((d, i) => (
                        <div key={i} className="px-1 py-2 text-center">{d}</div>
                      ))}
                    </div>
                    <div className="grid grid-cols-7">
                      {buildMonthCells().map((c, idx) => {
                        const isSelected =
                          c.date && bkDate && bkDate.getFullYear() === c.date.getFullYear() && bkDate.getMonth() === c.date.getMonth() && bkDate.getDate() === c.date.getDate();
                        
                        const selectedBranch = branches.find((b) => b.id === bkBranchId);
                        const branchTimezone = selectedBranch?.timezone || 'Australia/Sydney';
                        const branchCurrentDate = getCurrentDateTimeInTimezone(branchTimezone).date;
                        
                        let isPast = false;
                        const isClosed = c.date ? isBranchClosedOnDate(c.date) : false;
                        if (c.date) {
                          const cellDateStr = formatLocalYmd(c.date);
                          isPast = cellDateStr < branchCurrentDate;
                        }

                        // Check if today
                        let isToday = false;
                        if (c.date) {
                          const cellDateStr = formatLocalYmd(c.date);
                          isToday = cellDateStr === branchCurrentDate;
                        }
                        
                        const isDisabledDay = isPast || isClosed;
                        return (
                          <div
                            key={idx}
                            className={`h-10 p-0.5 flex items-center justify-center text-xs transition-all cursor-pointer
                              ${!c.date ? "cursor-default" : ""}
                              ${isDisabledDay ? "cursor-not-allowed" : ""}
                              ${isSelected ? "relative" : ""}
                            `}
                            onClick={() => c.date && !isDisabledDay && (setBkDate(c.date), setBkServiceTimes({}), setBkPickupTime(""))}
                            title={isClosed && c.date ? "Branch closed" : undefined}
                          >
                            {c.date ? (
                              <span className={`w-8 h-8 rounded-lg flex items-center justify-center font-semibold transition-all
                                ${isSelected
                                  ? "bg-neutral-900 text-white shadow-md shadow-neutral-900/20 font-bold"
                                  : isToday
                                  ? "bg-amber-50 text-amber-700 border border-amber-200 font-bold"
                                  : isPast
                                  ? "text-neutral-300"
                                  : isClosed
                                  ? "text-red-300 line-through"
                                  : "text-neutral-700 hover:bg-neutral-100"
                                }
                              `}>
                                {c.label}
                              </span>
                            ) : (
                              <span className="opacity-0">{c.label}</span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {bkDate && (
                    <div className="mt-3 flex items-center gap-2 px-1">
                      <i className="fas fa-calendar-check text-[10px] text-emerald-500" />
                      <span className="text-xs font-semibold text-neutral-700">{bkDate.toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}</span>
                    </div>
                  )}
                </div>

                {/* Staff & Time for Each Service */}
                <div className={`transition-all duration-300 ${!bkDate ? "opacity-40 pointer-events-none" : ""}`}>
                  {/* Branch Timezone Indicator */}
                  {bkBranchId && (() => {
                    const selectedBranch = branches.find((b) => b.id === bkBranchId);
                    const branchTimezone = selectedBranch?.timezone || 'Australia/Sydney';
                    const tzLabel = branchTimezone.split('/').pop()?.replace(/_/g, ' ') || branchTimezone;
                    
                    return (
                      <div className="mb-4 bg-white rounded-2xl border border-neutral-200/80 p-4 shadow-sm">
                        <div className="flex items-center justify-between flex-wrap gap-2">
                          <div className="flex items-center gap-2.5">
                            <div className="w-8 h-8 rounded-lg bg-blue-100 flex items-center justify-center">
                              <i className="fas fa-globe text-blue-600 text-xs"></i>
                            </div>
                            <div>
                              <span className="text-xs font-bold text-neutral-800 block">
                                {tzLabel}
                              </span>
                              <span className="text-[10px] text-neutral-400">Branch timezone</span>
                            </div>
                          </div>
                          <div className="flex items-center gap-2 bg-neutral-900 px-3 py-1.5 rounded-full">
                            <i className="fas fa-clock text-amber-400 text-[10px]"></i>
                            <span className="text-xs font-bold text-white">
                              {branchCurrentTime.time || '--:--'}
                            </span>
                          </div>
                        </div>
                        <p className="text-[10px] text-neutral-400 mt-2 ml-[42px]">
                          Past time slots are automatically hidden based on branch local time.
                        </p>
                      </div>
                    );
                  })()}

                  <h4 className="font-bold text-neutral-900 mb-3 flex items-center gap-2.5 text-sm">
                    <div className="w-9 h-9 rounded-xl bg-neutral-900 flex items-center justify-center shadow-md shadow-neutral-900/10">
                      <i className="fas fa-clock text-white text-xs" />
                    </div>
                    Drop-off Time
                  </h4>
                  
                  {!bkDate ? (
                    <div className="text-center py-12 bg-white rounded-2xl border border-neutral-200/80 shadow-sm">
                      <div className="w-16 h-16 bg-neutral-100 rounded-2xl flex items-center justify-center mx-auto mb-4 relative">
                        <i className="fas fa-calendar-day text-xl text-neutral-300" />
                        <div className="absolute -bottom-1 -right-1 w-6 h-6 rounded-full bg-amber-100 flex items-center justify-center border-2 border-white">
                          <i className="fas fa-arrow-up text-amber-600 text-[8px]" />
                        </div>
                      </div>
                      <p className="text-neutral-500 font-medium text-sm">Select a date first</p>
                      <p className="text-neutral-400 text-xs mt-1">Choose a date above to see available time slots</p>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {bkSelectedServices.map((serviceId, sIdx) => {
                        const service = servicesList.find((s) => String(s.id) === String(serviceId));
                        if (!service) return null;

                        const svcPricing = resolveServiceDisplayPricing(service);
                        const slots = computeSlots(serviceId);
                        const selectedTime = bkServiceTimes[String(serviceId)];
                        
                        return (
                          <div
                            key={String(serviceId)}
                            className={`rounded-2xl border-2 overflow-hidden transition-all duration-300 ${
                              selectedTime
                                ? "border-neutral-900 bg-white shadow-xl shadow-neutral-900/[0.08]"
                                : "border-neutral-200/80 bg-white hover:shadow-lg"
                            }`}
                            style={{ animation: `fadeSlideUp 0.4s ease-out ${sIdx * 80}ms both` }}
                          >
                            <div className="flex items-stretch">
                              <div className={`w-1.5 flex-shrink-0 transition-all duration-300 ${selectedTime ? "bg-amber-500" : "bg-neutral-200"}`} />
                              <div className="flex-1 p-4">
                                <div className="flex items-center justify-between mb-3">
                                  <div className="flex items-center gap-2.5">
                                    {service.imageUrl ? (
                                      <img src={service.imageUrl} alt={service.name} className="w-10 h-10 rounded-xl object-cover border border-neutral-100" />
                                    ) : (
                                      <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-neutral-100 to-neutral-50 flex items-center justify-center">
                                        <i className="fas fa-wrench text-neutral-300 text-sm" />
                                      </div>
                                    )}
                                    <div>
                                      <h5 className="font-bold text-neutral-900 text-sm">{service.name}</h5>
                                      <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                                        {typeof svcPricing.duration === "number" && (
                                          <span className="text-[10px] text-neutral-400 flex items-center gap-1">
                                            <i className="far fa-clock text-[8px]" /> {svcPricing.duration} min
                                          </span>
                                        )}
                                        {typeof svcPricing.price === "number" && (
                                          <>
                                            <span className="text-[10px] text-neutral-400">•</span>
                                            <span className="text-xs font-bold text-neutral-700">
                                              {svcPricing.isStartingFrom ? "from " : ""}${svcPricing.price}
                                            </span>
                                          </>
                                        )}
                                        {bkVehicleType && (
                                          <span className="inline-flex items-center gap-1 bg-amber-50 border border-amber-100 text-amber-700 text-[9px] font-semibold px-1.5 py-0.5 rounded-md">
                                            <i className={`${VEHICLE_TYPE_ICONS[bkVehicleType]} text-[8px]`} />
                                            {VEHICLE_TYPE_LABELS[bkVehicleType]}
                                          </span>
                                        )}
                                      </div>
                                    </div>
                                  </div>
                                  {selectedTime && (
                                    <span className="bg-neutral-900 text-white text-[10px] font-bold px-2.5 py-1 rounded-full flex items-center gap-1.5">
                                      <i className="fas fa-check text-[8px]" /> {selectedTime}
                                    </span>
                                  )}
                                </div>

                                {/* Time Selector */}
                                <div>
                                  <label className="text-[10px] font-bold text-neutral-400 uppercase tracking-wider mb-1.5 block">
                                    <i className="fas fa-arrow-right-to-bracket text-[8px] text-amber-500 mr-1" />
                                    Drop-off Time
                                  </label>
                                  <div className="grid grid-cols-4 sm:grid-cols-6 gap-1.5" style={{ alignContent: "start" }}>
                                    {slots.length === 0 ? (
                                      <div className="col-span-full text-center text-neutral-400 text-[10px] py-4 italic">
                                        No time slots available for this date
                                      </div>
                                    ) : (
                                      slots.map((slot) => {
                                        const isSlotSelected = selectedTime === slot.time;
                                        const isDisabled = !slot.available;
                                        const isBookedByOther = slot.reason === 'booked';
                                        const isSelectedForOtherService = slot.reason === 'selected';
                                        const isInsufficientTime = slot.reason === 'insufficient_time' || slot.reason === 'insufficient_time_selected';
                                        const isClosesBeforeFinish = slot.reason === 'closes_before_finish';
                                        
                                        let tooltipMessage = 'Available';
                                        if (isDisabled) {
                                          if (isClosesBeforeFinish) tooltipMessage = (slot as any).message || 'Service ends after closing';
                                          else if (isInsufficientTime) tooltipMessage = 'Overlaps with another booking';
                                          else if (isBookedByOther) tooltipMessage = 'Already booked';
                                          else if (isSelectedForOtherService) tooltipMessage = 'Selected for another service';
                                        }
                                        
                                        return (
                                          <button
                                            key={slot.time}
                                            onClick={() => {
                                              if (!isDisabled) setBkServiceTimes({ ...bkServiceTimes, [String(serviceId)]: slot.time });
                                            }}
                                            disabled={isDisabled}
                                            title={tooltipMessage}
                                            className={`h-9 rounded-lg text-[10px] font-bold transition-all relative ${
                                              isSlotSelected 
                                                ? "bg-neutral-900 text-white shadow-md shadow-neutral-900/20" 
                                                : isClosesBeforeFinish
                                                  ? "bg-orange-50 text-orange-400 border border-orange-200 cursor-not-allowed"
                                                  : isInsufficientTime
                                                    ? "bg-yellow-50 text-yellow-500 border border-yellow-200 cursor-not-allowed"
                                                    : isBookedByOther
                                                      ? "bg-red-50 text-red-400 border border-red-200 cursor-not-allowed line-through"
                                                      : isSelectedForOtherService
                                                        ? "bg-amber-50 text-amber-500 border border-amber-200 cursor-not-allowed"
                                                        : "bg-neutral-50 text-neutral-600 hover:bg-neutral-100 hover:text-neutral-800"
                                            }`}
                                          >
                                            {slot.time}
                                            {(isClosesBeforeFinish || isInsufficientTime) && (
                                              <span className="absolute -top-1 -right-1 w-3 h-3 bg-orange-500 rounded-full flex items-center justify-center">
                                                <span className="text-white text-[7px]">!</span>
                                              </span>
                                            )}
                                          </button>
                                        );
                                      })
                                    )}
                                  </div>
                                  {slots.some(s => s.reason === 'closes_before_finish' || s.reason === 'insufficient_time') && (
                                    <div className="mt-2 text-[9px] text-neutral-400 flex flex-wrap gap-3">
                                      <span className="flex items-center gap-1">
                                        <span className="w-2 h-2 rounded bg-orange-300"></span>
                                        Closes before service ends
                                      </span>
                                      <span className="flex items-center gap-1">
                                        <span className="w-2 h-2 rounded bg-yellow-300"></span>
                                        Overlaps with booking
                                      </span>
                                    </div>
                                  )}
                                </div>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Pick-up Time Section */}
                {bkDate && Object.keys(bkServiceTimes).length === bkSelectedServices.length && bkSelectedServices.length > 0 && (
                  <div className="bg-white rounded-2xl border border-neutral-200/80 p-4 sm:p-5 shadow-sm mt-5 animate-[fadeSlideUp_0.3s_ease-out]">
                    <h4 className="font-bold text-neutral-900 mb-3 flex items-center gap-2.5 text-sm">
                      <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-emerald-400 to-green-500 flex items-center justify-center shadow-md shadow-emerald-500/10">
                        <i className="fas fa-arrow-right-from-bracket text-white text-xs" />
                      </div>
                      When does the customer pick up?
                      {bkEarliestPickupTime && (
                        <span className="ml-auto text-[10px] font-medium text-neutral-400 normal-case tracking-normal">
                          earliest: {bkEarliestPickupTime} — {bkTotalServiceDuration} min service
                        </span>
                      )}
                    </h4>

                    <div className="border-2 border-emerald-200 rounded-xl overflow-hidden bg-white">
                      <div className="px-3 py-2.5 bg-emerald-50 border-b border-emerald-100">
                        <div className="flex items-center gap-2">
                          <i className="fas fa-arrow-right-from-bracket text-[10px] text-emerald-600" />
                          <span className="text-xs font-bold text-emerald-800">Select pick-up time</span>
                        </div>
                        {bkBranchDayHours && (
                          <div className="flex items-center gap-1.5 mt-1">
                            <i className="fas fa-store text-[9px] text-emerald-300" />
                            <span className="text-[10px] font-medium text-emerald-400">
                              Branch closes at {bkBranchDayHours.close}
                            </span>
                          </div>
                        )}
                      </div>

                      {bkPickupTimeSlots.length === 0 ? (
                        <div className="p-4 text-center">
                          <p className="text-[11px] text-neutral-400">No pick-up times available for this drop-off time and service duration.</p>
                        </div>
                      ) : (
                        <div className="grid grid-cols-4 sm:grid-cols-6 gap-1.5 p-2.5 max-h-[200px] overflow-y-auto" style={{ alignContent: "start" }}>
                          {bkPickupTimeSlots.map((t) => (
                            <button
                              key={t}
                              type="button"
                              onClick={() => setBkPickupTime(t)}
                              className={`h-9 rounded-lg text-xs font-semibold transition-all text-center ${
                                bkPickupTime === t
                                  ? "bg-emerald-600 text-white shadow-md shadow-emerald-600/20"
                                  : "bg-emerald-50 text-emerald-700 hover:bg-emerald-100 hover:text-emerald-800"
                              }`}
                            >
                              {t}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>

                    {bkPickupTime && (
                      <div className="mt-3 flex items-center gap-2 px-1">
                        <i className="fas fa-arrow-right-from-bracket text-[10px] text-emerald-500" />
                        <span className="text-xs font-semibold text-neutral-700">Pick-up: {bkPickupTime}</span>
                      </div>
                    )}
                  </div>
                )}

                {/* Summary Footer + Navigation */}
                {bkDate && Object.keys(bkServiceTimes).length === bkSelectedServices.length && bkPickupTime && bkSelectedServices.length > 0 ? (
                  <div className="mt-6 bg-neutral-900 rounded-2xl p-4 text-white relative overflow-hidden">
                    <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/[0.03] to-transparent" />
                    <div className="relative z-10 flex items-center justify-between">
                      <div>
                        <p className="text-neutral-400 text-[10px] font-medium">
                          Drop-off: {Object.values(bkServiceTimes)[0]} · Pick-up: {bkPickupTime}
                        </p>
                        <p className="text-sm font-bold mt-0.5">
                          {bkDate.toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" })} · {bkSelectedServices.length} service{bkSelectedServices.length > 1 ? "s" : ""}
                        </p>
                      </div>
                      <button
                        onClick={() => setBkStep(3)}
                        className="group bg-amber-500 hover:bg-amber-400 text-neutral-900 font-bold px-5 py-2.5 rounded-xl transition-all text-sm active:scale-[0.97] shadow-lg shadow-amber-500/25 flex items-center gap-2"
                      >
                        Continue
                        <i className="fas fa-arrow-right text-xs group-hover:translate-x-1 transition-transform" />
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex justify-between pt-4 mt-5 border-t border-neutral-200/50">
                    <button onClick={() => setBkStep(1)} className="px-4 py-2 rounded-xl border border-neutral-200 text-neutral-600 hover:bg-neutral-50 font-medium text-sm transition group flex items-center gap-2">
                      <i className="fas fa-arrow-left text-[10px] group-hover:-translate-x-0.5 transition-transform" />
                      Back
                    </button>
                    <button
                      disabled
                      className="px-5 py-2.5 rounded-xl bg-neutral-200 text-neutral-400 text-sm font-semibold cursor-not-allowed"
                    >
                      Continue to Details
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Step 3 - Customer Details + Summary */}
            {bkStep === 3 && (
              <div className="animate-[fadeSlideUp_0.4s_ease-out]">
                <div className="flex items-center gap-2 mb-5">
                  <button onClick={() => setBkStep(2)} className="w-8 h-8 rounded-xl bg-neutral-100 hover:bg-neutral-200 flex items-center justify-center transition group">
                    <i className="fas fa-arrow-left text-[10px] text-neutral-500 group-hover:-translate-x-0.5 transition-transform" />
                  </button>
                  <div>
                    <h3 className="text-lg sm:text-xl font-bold text-neutral-900 tracking-tight">Complete the booking</h3>
                    <p className="text-neutral-500 text-xs mt-0.5">Fill in customer details and review the summary</p>
                  </div>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-5 gap-5">
                  {/* Left Column - Customer Form */}
                  <div className="lg:col-span-3 space-y-4">
                    {/* Customer Info Card */}
                    <div className="bg-white rounded-2xl border border-neutral-200/80 p-5 shadow-sm hover:shadow-md transition-shadow">
                      <h4 className="font-bold text-neutral-900 mb-4 flex items-center gap-2.5 text-sm">
                        <div className="w-9 h-9 rounded-xl bg-neutral-900 flex items-center justify-center shadow-md shadow-neutral-900/10">
                          <i className="fas fa-user text-white text-xs" />
                        </div>
                        Customer information
                      </h4>
                      <div className="space-y-4">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <div>
                            <label className="block text-[11px] font-bold text-neutral-400 uppercase tracking-wider mb-1.5">Full Name <span className="text-red-400">*</span></label>
                            <input
                              type="text"
                              value={bkClientName}
                              onChange={(e) => setBkClientName(e.target.value)}
                              className="w-full border-2 border-neutral-200 hover:border-neutral-300 rounded-xl px-4 py-2.5 text-sm focus:ring-0 focus:border-neutral-900 transition-all outline-none bg-neutral-50/50 placeholder:text-neutral-300 font-medium"
                              placeholder="John Smith"
                              required
                            />
                          </div>
                          <div>
                            <label className="block text-[11px] font-bold text-neutral-400 uppercase tracking-wider mb-1.5">Phone <span className="text-red-400">*</span></label>
                            <input
                              type="tel"
                              value={bkClientPhone}
                              onChange={(e) => setBkClientPhone(e.target.value)}
                              className="w-full border-2 border-neutral-200 hover:border-neutral-300 rounded-xl px-4 py-2.5 text-sm focus:ring-0 focus:border-neutral-900 transition-all outline-none bg-neutral-50/50 placeholder:text-neutral-300 font-medium"
                              placeholder="0412 345 678"
                              required
                            />
                          </div>
                        </div>
                        <div>
                          <label className="block text-[11px] font-bold text-neutral-400 uppercase tracking-wider mb-1.5">Email <span className="text-red-400">*</span></label>
                          <input
                            type="email"
                            value={bkClientEmail}
                            onChange={(e) => setBkClientEmail(e.target.value)}
                            className="w-full border-2 border-neutral-200 hover:border-neutral-300 rounded-xl px-4 py-2.5 text-sm focus:ring-0 focus:border-neutral-900 transition-all outline-none bg-neutral-50/50 placeholder:text-neutral-300 font-medium"
                            placeholder="john@example.com"
                            required
                          />
                        </div>
                        {/* Vehicle details block */}
                        <div className="space-y-3 rounded-xl border-2 border-neutral-200/80 p-4 bg-neutral-50/30">
                          <h5 className="text-[11px] font-bold text-neutral-400 uppercase tracking-wider flex items-center gap-2">
                            <i className="fas fa-car" />
                            Vehicle details
                          </h5>
                          <div>
                            <label className="block text-[11px] font-bold text-neutral-400 uppercase tracking-wider mb-1.5">Registration number <span className="text-red-400">*</span></label>
                            <input
                              type="text"
                              value={bkVehicleNumber}
                              onChange={(e) => setBkVehicleNumber(e.target.value)}
                              className="w-full border-2 border-neutral-200 hover:border-neutral-300 rounded-xl px-4 py-2.5 text-sm focus:ring-0 focus:border-neutral-900 transition-all outline-none bg-white placeholder:text-neutral-300 font-medium"
                              placeholder="e.g. ABC 123" required
                            />
                          </div>
                          {bkVehicleType && (
                            <div className="flex items-start gap-2 bg-amber-50 border border-amber-100 rounded-xl px-3 py-2">
                              <div className="w-8 h-8 rounded-lg bg-amber-100 flex items-center justify-center flex-shrink-0">
                                <i className={`${VEHICLE_TYPE_ICONS[bkVehicleType]} text-amber-700 text-sm`} />
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="text-[10px] font-bold text-amber-700 uppercase tracking-wider">Type (pricing class)</div>
                                <div className="text-sm font-bold text-amber-900 leading-snug break-words text-balance">
                                  {VEHICLE_TYPE_LABELS[bkVehicleType]}
                                </div>
                              </div>
                              <button
                                type="button"
                                onClick={() => setBkStep(1)}
                                className="text-[11px] font-semibold text-amber-700 hover:text-amber-900 underline"
                              >
                                Change
                              </button>
                            </div>
                          )}
                          <div>
                            <label className="block text-[11px] font-bold text-neutral-400 uppercase tracking-wider mb-1.5">Colour <span className="text-neutral-300 text-[10px] font-normal lowercase">(optional)</span></label>
                            <input type="text" value={bkVehicleColour} onChange={(e) => setBkVehicleColour(e.target.value)} placeholder="e.g. White, Black"
                              className="w-full border-2 border-neutral-200 hover:border-neutral-300 rounded-xl px-4 py-2.5 text-sm focus:ring-0 focus:border-neutral-900 outline-none bg-white placeholder:text-neutral-300 font-medium" />
                          </div>
                          <div>
                            <label className="block text-[11px] font-bold text-neutral-400 uppercase tracking-wider mb-1.5">VIN / Chassis <span className="text-neutral-300 text-[10px] font-normal lowercase">(optional)</span></label>
                            <input type="text" value={bkVehicleVinChassis} onChange={(e) => setBkVehicleVinChassis(e.target.value)} placeholder="e.g. 1HGBH41JXMN109186"
                              className="w-full border-2 border-neutral-200 hover:border-neutral-300 rounded-xl px-4 py-2.5 text-sm focus:ring-0 focus:border-neutral-900 outline-none bg-white placeholder:text-neutral-300 font-medium" />
                          </div>
                          <div>
                            <label className="block text-[11px] font-bold text-neutral-400 uppercase tracking-wider mb-1.5">Engine number <span className="text-neutral-300 text-[10px] font-normal lowercase">(optional)</span></label>
                            <input type="text" value={bkVehicleEngineNumber} onChange={(e) => setBkVehicleEngineNumber(e.target.value)} placeholder="e.g. ABC123456"
                              className="w-full border-2 border-neutral-200 hover:border-neutral-300 rounded-xl px-4 py-2.5 text-sm focus:ring-0 focus:border-neutral-900 outline-none bg-white placeholder:text-neutral-300 font-medium" />
                          </div>
                          <div>
                            <label className="block text-[11px] font-bold text-neutral-400 uppercase tracking-wider mb-1.5">Customer Mileage <span className="text-neutral-300 text-[10px] font-normal lowercase">(optional)</span></label>
                            <input type="text" value={bkVehicleMileage} onChange={(e) => setBkVehicleMileage(e.target.value)} placeholder="e.g. 45000 km"
                              className="w-full border-2 border-neutral-200 hover:border-neutral-300 rounded-xl px-4 py-2.5 text-sm focus:ring-0 focus:border-neutral-900 outline-none bg-white placeholder:text-neutral-300 font-medium" />
                          </div>
                        </div>
                        <div>
                          <label className="block text-[11px] font-bold text-neutral-400 uppercase tracking-wider mb-1.5">Additional Notes <span className="text-neutral-300 text-[10px] font-normal lowercase">(optional)</span></label>
                          <textarea
                            value={bkNotes}
                            onChange={(e) => setBkNotes(e.target.value)}
                            className="w-full border-2 border-neutral-200 hover:border-neutral-300 rounded-xl px-4 py-2.5 text-sm focus:ring-0 focus:border-neutral-900 transition-all outline-none bg-neutral-50/50 placeholder:text-neutral-300 font-medium resize-none"
                            placeholder="Any special requests or information…"
                            rows={3}
                          />
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Right Column - Booking Summary */}
                  <div className="lg:col-span-2">
                    <div className="bg-white rounded-2xl border border-neutral-200/80 p-5 shadow-sm hover:shadow-md transition-shadow sticky top-4">
                      <h4 className="font-bold text-neutral-900 mb-4 flex items-center gap-2.5 text-sm">
                        <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center shadow-md shadow-amber-500/10">
                          <i className="fas fa-receipt text-white text-xs" />
                        </div>
                        Booking summary
                      </h4>

                      <div className="space-y-3">
                        {/* Branch */}
                        <div className="flex items-center gap-2.5 pb-3 border-b border-neutral-100">
                          <div className="w-8 h-8 rounded-lg bg-neutral-100 flex items-center justify-center">
                            <i className="fas fa-store text-neutral-500 text-[10px]" />
                          </div>
                          <div>
                            <p className="text-[10px] text-neutral-400 font-medium">Branch</p>
                            <p className="text-sm font-bold text-neutral-900">{branches.find((b: any) => b.id === bkBranchId)?.name || "-"}</p>
                          </div>
                        </div>

                        {/* Date & Times */}
                        <div className="flex items-center gap-2.5 pb-3 border-b border-neutral-100">
                          <div className="w-8 h-8 rounded-lg bg-neutral-100 flex items-center justify-center">
                            <i className="fas fa-calendar text-neutral-500 text-[10px]" />
                          </div>
                          <div className="flex-1">
                            <p className="text-[10px] text-neutral-400 font-medium">Date</p>
                            <p className="text-sm font-bold text-neutral-900">{bkDate ? bkDate.toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "long" }) : "-"}</p>
                          </div>
                        </div>

                        {bkPickupTime && (
                          <div className="bg-emerald-50 rounded-xl p-3 border border-emerald-200/50">
                            <div className="flex items-center justify-between mb-1.5">
                              <span className="text-[10px] text-emerald-700 font-bold flex items-center gap-1.5">
                                <i className="fas fa-arrow-right-to-bracket text-[8px]" /> Drop-off
                              </span>
                              <span className="text-xs font-bold text-neutral-900">{Object.values(bkServiceTimes)[0] || "-"}</span>
                            </div>
                            <div className="flex items-center justify-between">
                              <span className="text-[10px] text-emerald-700 font-bold flex items-center gap-1.5">
                                <i className="fas fa-arrow-right-from-bracket text-[8px]" /> Pick-up
                              </span>
                              <span className="text-xs font-bold text-emerald-700">{bkPickupTime}</span>
                            </div>
                          </div>
                        )}

                        {/* Services */}
                        <div className="pt-1">
                          <p className="text-[10px] text-neutral-400 font-bold uppercase tracking-wider mb-2">
                            Services ({bkSelectedServices.length})
                          </p>
                          <div className="space-y-2">
                            {bkSelectedServices.map(id => {
                              const s = servicesList.find((srv: any) => String(srv.id) === String(id));
                              return (
                                <div key={id} className="bg-neutral-50 rounded-lg p-2.5 border border-neutral-100">
                                  <div className="flex justify-between items-start">
                                    <div className="flex-1 min-w-0">
                                      <p className="text-xs font-bold text-neutral-900 truncate">{s?.name || "-"}</p>
                                      <div className="flex items-center gap-2 mt-0.5">
                                        <span className="text-[10px] text-neutral-400">{bkServiceTimes[String(id)]}</span>
                                      </div>
                                    </div>
                                    <span className="text-sm font-black text-neutral-900 ml-2">${s?.price || 0}</span>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>

                        {/* Total */}
                        <div className="flex justify-between items-center pt-3 border-t-2 border-neutral-200 mt-2">
                          <span className="text-sm font-bold text-neutral-700">Total</span>
                          <span className="text-xl font-black text-neutral-900">
                            ${bkSelectedServices.reduce((sum: number, id) => {
                              const s = servicesList.find((srv: any) => String(srv.id) === String(id));
                              return sum + (Number(s?.price) || 0);
                            }, 0)}
                          </span>
                        </div>
                      </div>

                      {/* Confirm Button */}
                      <button
                        disabled={!bkBranchId || bkSelectedServices.length === 0 || !bkDate || Object.keys(bkServiceTimes).length !== bkSelectedServices.length || !bkPickupTime || !bkClientName.trim() || !bkClientEmail.trim() || !bkClientPhone.trim() || !bkVehicleNumber.trim() || submittingBooking}
                        onClick={handleConfirmBooking}
                        className={`w-full mt-4 py-3 rounded-xl font-bold text-sm transition-all active:scale-[0.98] flex items-center justify-center gap-2 ${
                            bkBranchId && bkSelectedServices.length > 0 && bkDate && Object.keys(bkServiceTimes).length === bkSelectedServices.length && bkPickupTime && bkClientName.trim() && bkClientEmail.trim() && bkClientPhone.trim() && bkVehicleNumber.trim() && !submittingBooking
                            ? "bg-neutral-900 text-white hover:bg-neutral-800 shadow-lg shadow-neutral-900/20"
                            : "bg-neutral-200 text-neutral-400 cursor-not-allowed"
                        }`}
                      >
                        {submittingBooking ? (
                          <>
                            <i className="fas fa-circle-notch animate-spin text-xs" />
                            Confirming booking…
                          </>
                        ) : (
                          <>
                            <i className="fas fa-check text-xs" />
                            Confirm Booking
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Staff Assignment Modal for Confirming Bookings */}
      {staffAssignModalOpen && bookingToConfirm && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => {
              if (!confirmingBooking) {
                setStaffAssignModalOpen(false);
                setBookingToConfirm(null);
                setSelectedStaffId("");
                setSelectedStaffPerService({});
                setAvailableStaffForModal([]);
                setAvailableStaffPerServiceForModal({});
              }
            }}
          />

          {/* Modal */}
          <div className="relative bg-white rounded-2xl shadow-2xl max-w-md w-full overflow-hidden">
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
                    {(bookingToConfirm.client || "?").split(" ").map((s: string) => s[0]).slice(0,2).join("")}
                  </div>
                  <div>
                    <p className="font-semibold text-neutral-900">{bookingToConfirm.client}</p>
                    <p className="text-xs text-neutral-500">{bookingToConfirm.serviceName || "Service"}</p>
                  </div>
                </div>
                <div className="flex items-center gap-4 text-xs text-neutral-600">
                  <span><i className="far fa-calendar mr-1"></i>{bookingToConfirm.date}</span>
                  <span><i className="far fa-clock mr-1"></i>{bookingToConfirm.time}</span>
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
                {loadingStaffForModal ? (
                  <div className="flex items-center justify-center py-8">
                    <div className="w-8 h-8 border-3 border-emerald-200 border-t-emerald-600 rounded-full animate-spin"></div>
                    <span className="ml-3 text-neutral-600">Loading staff...</span>
                  </div>
                ) : (
                  <>
                    {/* Multiple Services - show staff selection for each service */}
                    {Array.isArray(bookingToConfirm.services) && bookingToConfirm.services.length > 0 ? (
                      <div className="space-y-4 max-h-96 overflow-y-auto">
                        {bookingToConfirm.services.map((service: any) => {
                          const serviceKey = String(service.id || service.serviceId || service.name);
                          const serviceStaff = availableStaffPerServiceForModal[serviceKey] || [];
                          const selectedStaff = selectedStaffPerService[serviceKey];
                          const needsAssignment = !service.staffId || service.staffId === "null" || service.staffName === "Any Available" || service.staffName === "Any Staff" || service.staffName === "Not Assigned Yet";
                          
                          return (
                            <div key={String(service.id)} className="border-2 border-purple-200 rounded-xl p-4 bg-purple-50/50">
                              <div className="mb-3 flex items-center gap-2">
                                <i className="fas fa-spa text-purple-600"></i>
                                <h4 className="font-bold text-neutral-800">{service.name}</h4>
                                <span className="text-xs text-neutral-500 ml-auto">{service.duration} min</span>
                                {!needsAssignment && (
                                  <span className="text-xs bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded-full">
                                    <i className="fas fa-check mr-1"></i>Assigned
                                  </span>
                                )}
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
                                      onClick={() => setSelectedStaffPerService(prev => ({
                                        ...prev,
                                        [serviceKey]: staff.id
                                      }))}
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
                      /* Single Service */
                      <>
                        <label className="block text-sm font-semibold text-neutral-700 mb-3">
                          <i className="fas fa-user-tie text-emerald-600 mr-2"></i>
                          Select Staff Member
                        </label>
                        {availableStaffForModal.length === 0 ? (
                          <div className="p-4 bg-amber-50 border border-amber-200 rounded-lg text-amber-800 text-sm">
                            <i className="fas fa-exclamation-triangle mr-2"></i>
                            No available staff members found for this service/branch.
                          </div>
                        ) : (
                          <div className="space-y-2 max-h-64 overflow-y-auto">
                            {availableStaffForModal.map((staff) => (
                              <button
                                key={staff.id}
                                onClick={() => setSelectedStaffId(staff.id)}
                                className={`w-full text-left p-3 rounded-lg border-2 transition-all ${
                                  selectedStaffId === staff.id
                                    ? "border-emerald-500 bg-emerald-50 shadow-sm"
                                    : "border-neutral-200 hover:border-emerald-300 hover:bg-neutral-50"
                                }`}
                              >
                                <div className="flex items-center gap-3">
                                  <div className={`w-10 h-10 rounded-full overflow-hidden flex-shrink-0 border-2 ${
                                    selectedStaffId === staff.id ? "border-emerald-500" : "border-neutral-200"
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
                onClick={() => {
                  setStaffAssignModalOpen(false);
                  setBookingToConfirm(null);
                  setSelectedStaffId("");
                  setSelectedStaffPerService({});
                  setAvailableStaffForModal([]);
                  setAvailableStaffPerServiceForModal({});
                }}
                disabled={confirmingBooking}
                className="px-4 py-2.5 rounded-lg text-neutral-700 hover:bg-neutral-200 font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-sm"
              >
                Cancel
              </button>
              <button
                onClick={confirmWithStaffAssignment}
                disabled={(() => {
                  if (confirmingBooking || loadingStaffForModal) return true;
                  
                  const hasMultipleServices = Array.isArray(bookingToConfirm.services) && bookingToConfirm.services.length > 0;
                  
                  if (hasMultipleServices) {
                    // Check all services have staff selected
                    return !bookingToConfirm.services.every((s: any) => {
                      const serviceKey = String(s.id || s.serviceId || s.name);
                      return selectedStaffPerService[serviceKey];
                    });
                  } else {
                    return !selectedStaffId;
                  }
                })()}
                className="px-5 py-2.5 rounded-lg bg-gradient-to-r from-emerald-500 to-green-600 hover:from-emerald-600 hover:to-green-700 text-white font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 text-sm shadow-lg shadow-emerald-200"
              >
                {confirmingBooking ? (
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

      {/* Minimal CSS for modal, toasts, status badges, time slots, and animations */}
      <style>{`
        .view-section.active { display: block; }
        .modal-backdrop { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(15,23,42,0.65); backdrop-filter: blur(8px); z-index: 50; align-items: center; justify-content: center; }
        .modal-backdrop.open { display: flex; animation: modalFadeIn 0.3s ease-out; }
        .modal-backdrop.open > div { animation: modalSlideUp 0.4s cubic-bezier(0.16, 1, 0.3, 1); }
        .toast { background: #1e293b; color: white; padding: 12px 24px; border-radius: 8px; margin-top: 10px; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1); display: flex; align-items: center; gap: 12px; border-left: 4px solid #ec4899; }
        .status-Confirmed { background-color: #dcfce7; color: #15803d; }
        .status-Pending { background-color: #fef9c3; color: #a16207; }
        .status-Canceled { background-color: #fee2e2; color: #b91c1c; }
        .status-Completed { background-color: #e0f2fe; color: #075985; }
        @keyframes fadeSlideUp { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes modalFadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes modalSlideUp { from { opacity: 0; transform: translateY(20px) scale(0.97); } to { opacity: 1; transform: translateY(0) scale(1); } }
        .custom-scrollbar::-webkit-scrollbar { width: 6px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #d4d4d4; border-radius: 8px; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: #a3a3a3; }
      `}</style>
    </>
  );
}

// Main export wrapped in Suspense for useSearchParams
export default function BookingsPage() {
  return (
    <Suspense fallback={
      <div className="flex h-screen items-center justify-center bg-neutral-50">
        <div className="flex flex-col items-center gap-3">
          <i className="fas fa-circle-notch fa-spin text-4xl text-neutral-900" />
          <p className="text-neutral-500 font-medium">Loading bookings...</p>
        </div>
      </div>
    }>
      <BookingsPageContent />
    </Suspense>
  );
}
