"use client";
import React, { useEffect, useState, Suspense } from "react";
import Sidebar from "@/components/Sidebar";
import { useRouter, useSearchParams } from "next/navigation";
import { onAuthStateChanged } from "firebase/auth";
import Script from "next/script";
import { subscribeServicesForOwner } from "@/lib/services";
import { subscribeSalonStaffForOwner } from "@/lib/salonStaff";
import { subscribeBranchesForOwner } from "@/lib/branches";
import { createBooking } from "@/lib/bookings";
import { collection, onSnapshot, query, where } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { shouldBlockSlots } from "@/lib/bookingTypes";
import { getCurrentDateTimeInTimezone } from "@/lib/timezone";

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
  const [bkNotes, setBkNotes] = useState<string>("");
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
  const [servicesList, setServicesList] = useState<Array<{ id: string | number; name: string; price?: number; duration?: number; icon?: string; branches?: string[]; staffIds?: string[]; imageUrl?: string }>>([]);
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

          if (role === "salon_owner") {
            setOwnerUid(user.uid);
            setUserRole(role);
          } else if (role === "salon_branch_admin") {
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
          tbody.innerHTML = '<tr><td colspan="4" class="p-4 text-center text-slate-400">No bookings found.</td></tr>';
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
              const svcStaff = svc.staffName || "Any Staff";
              return `<div class="flex items-center gap-2 py-1 px-2 rounded-lg bg-slate-50 border border-slate-100 mb-1">
                <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-white border border-slate-200 shadow-sm">
                  <i class="fas fa-spa text-pink-500" style="font-size:10px"></i>
                  <span class="text-xs font-semibold text-slate-800">${svcName}</span>
                </span>
                <i class="fas fa-user text-slate-400" style="font-size:9px"></i>
                <span class="text-xs font-medium text-slate-600">${svcStaff}</span>
              </div>`;
            }).join("");
          } else {
            const serviceName = String(b.serviceName || (service ? service.name : "Unknown Service"));
            let staffName = "Unassigned";
            if (b.staffName && b.staffName !== "Any Available" && b.staffName !== "Any Staff") {
              staffName = b.staffName;
            } else if (staff) {
              staffName = staff.name;
            }
            servicesHtml = `<div class="flex items-center gap-2 py-1 px-2 rounded-lg bg-slate-50 border border-slate-100">
              <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-white border border-slate-200 shadow-sm">
                <i class="fas fa-spa text-pink-500" style="font-size:10px"></i>
                <span class="text-xs font-semibold text-slate-800">${serviceName}</span>
              </span>
              <i class="fas fa-user text-slate-400" style="font-size:9px"></i>
              <span class="text-xs font-medium text-slate-600">${staffName}</span>
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
            <tr class="hover:bg-slate-50 transition">
              <td class="p-4 pl-6">
                <span class="font-bold text-slate-800">${b.client}</span>
                <div class="mt-1.5">${servicesHtml}</div>
              </td>
              <td class="p-4">
                <span class="font-medium text-slate-700">${b.time} - ${endTime}</span>
              </td>
              <td class="p-4 text-center">
                <span class="inline-block px-3 py-1 text-xs font-semibold rounded-full ${statusClass}">
                  ${b.status}
                </span>
                <div class="mt-1">${statusActions}</div>
              </td>
              <td class="p-4 text-right pr-6 font-bold text-slate-800">$${b.price}</td>
            </tr>
          `;
        });
      },
      updateBookingStatus: async function (id: string, newStatus: string) {
        const booking = this.data.bookings.find((b: any) => b.id === id);
        
        // If confirming, check if staff assignment is needed
        if (newStatus === "Confirmed" && booking) {
          const hasMultipleServices = Array.isArray(booking.services) && booking.services.length > 0;
          
          if (hasMultipleServices) {
            // Check if any service needs staff assignment
            const needsStaffAssignment = booking.services.some((s: any) => 
              !s.staffId || s.staffId === "null" || s.staffName === "Any Available" || s.staffName === "Any Staff"
            );
            
            if (needsStaffAssignment) {
              // Trigger staff assignment modal via React state
              const event = new CustomEvent("openStaffAssignModal", { detail: booking });
              window.dispatchEvent(event);
              return;
            }
          } else {
            // Single service booking - check if needs staff assignment
            if (!booking.staffId || booking.staffId === "null" || booking.staffName === "Any Available" || booking.staffName === "Any Staff") {
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
            body: JSON.stringify({ status: newStatus }),
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
          slotsContainer.innerHTML = '<p class="col-span-4 text-center text-slate-400 text-xs py-2">Select Service, Staff, and a valid Date to see available slots.</p>';
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

        const interval = 15;
        let currentTime = Math.floor(startHour) * 60 + ((startHour % 1) * 60);
        const maxTime = Math.floor(endHour) * 60 + ((endHour % 1) * 60);
        
        // Check if date is today to filter past times
        const today = new Date();
        const isToday = date === today.toISOString().split('T')[0];
        const currentMinutes = isToday ? (today.getHours() * 60 + today.getMinutes()) : -1;
        
        // Get all bookings for this date (excluding cancelled, completed, rejected)
        // Use centralized helper to ensure consistency
        // NOTE: When a booking is cancelled, its status changes to "Canceled" and shouldBlockSlots returns false,
        // so it's automatically excluded from relevantBookings, making the slot available again in real-time
        const allDateBookings = this.data.bookings.filter((b: any) => {
          return b.date === date && shouldBlockSlots(b.status);
        });
        
        // Helper to check if a staff ID represents "any staff"
        const isAnyStaff = (sid: any): boolean => {
          if (!sid) return true; // null, undefined
          const str = String(sid).trim();
          return str === "" || str === "any" || str === "null" || str.toLowerCase() === "any available" || str.toLowerCase() === "any staff";
        };
        
        const isAnyStaffSelected = isAnyStaff(staffId);
        
        // Get selected service ID for eligible staff computation
        const selectedServiceId = serviceSelect?.value || "";
        
        // For "Any Staff" bookings, get all eligible staff IDs for this service+branch
        const eligibleStaffIds: string[] = (() => {
          if (!isAnyStaffSelected || !selectedServiceId) return [];
          
          const serviceData = this.data.services.find((s: any) => String(s.id) === String(selectedServiceId));
          const svcStaffIds: string[] = (serviceData?.staffIds ?? []).map(String);
          const svcHasStaffAssigned = svcStaffIds.length > 0;
          
          const selBranchName = selectedBranch?.name;
          
          return (this.data.staff || []).filter((st: any) => {
            if (st.status && st.status !== "Active") return false;
            if (svcHasStaffAssigned && !svcStaffIds.includes(String(st.id))) return false;
            // Check branch assignment
            if (branchId) {
              if (dayOfWeek && st.weeklySchedule && typeof st.weeklySchedule === 'object') {
                const daySchedule = st.weeklySchedule[dayOfWeek];
                if (!daySchedule) return false;
                if (daySchedule.branchId !== branchId && daySchedule.branchName !== selBranchName) return false;
              } else {
                if (String(st.branchId || "") !== branchId && String(st.branch || "") !== selBranchName) return false;
              }
            }
            return true;
          }).map((st: any) => st.id);
        })();
        
        // Helper function to check if a booking involves a specific staff member
        const bookingInvolvesStaff = (booking: any, targetStaffId: string): boolean => {
          // Check root-level staffId
          if (booking.staffId === targetStaffId) return true;
          
          // Check services array for multi-service bookings
          if (Array.isArray(booking.services)) {
            for (const svc of booking.services) {
              if (svc && svc.staffId === targetStaffId) {
                return true;
              }
            }
          }
          
          return false;
        };
        
        // Filter bookings to only those relevant
        const relevantBookings = (() => {
          if (isAnyStaffSelected) {
            if (eligibleStaffIds.length === 0) return allDateBookings;
            return allDateBookings.filter((b: any) =>
              eligibleStaffIds.some((sid: string) => bookingInvolvesStaff(b, sid))
            );
          }
          if (!staffId) return [];
          return allDateBookings.filter((b: any) => bookingInvolvesStaff(b, staffId));
        })();
        
        // Helper: Check if a specific staff member has a conflicting booking at a given time slot
        const ttm = this.timeToMinutes.bind(this);
        const isStaffOccupiedAtSlot = (slotStartMin: number, targetStaffId: string): boolean => {
          const newServiceEndMin = slotStartMin + duration;
          
          for (const booking of relevantBookings) {
            if (Array.isArray(booking.services) && booking.services.length > 0) {
              for (const svc of booking.services) {
                if (svc && svc.staffId === targetStaffId && svc.time) {
                  const svcStartMin = ttm(svc.time);
                  const svcDuration = svc.duration || 60;
                  const svcEndMin = svcStartMin + svcDuration;
                  if (slotStartMin < svcEndMin && svcStartMin < newServiceEndMin) {
                    return true;
                  }
                }
              }
            } else {
              if (booking.staffId === targetStaffId && booking.time) {
                const bStartMin = ttm(booking.time);
                const bEndMin = bStartMin + (booking.duration || 60);
                if (slotStartMin < bEndMin && bStartMin < newServiceEndMin) {
                  return true;
                }
              }
            }
          }
          return false;
        };
        
        // Helper to check if a slot time is occupied by any booking for this staff
        const isSlotOccupied = (slotMinutes: number): boolean => {
          if (isAnyStaffSelected) {
            // "Any Staff" mode: slot is occupied only if ALL eligible staff members are booked
            if (eligibleStaffIds.length === 0) return false;
            return eligibleStaffIds.every((sid: string) => isStaffOccupiedAtSlot(slotMinutes, sid));
          }
          
          // Specific staff selected - check bookings involving this staff
          if (!staffId) return false;
          const newServiceEndMin = slotMinutes + duration;
          
          for (const booking of relevantBookings) {
            // Check if booking has individual services (multi-service booking)
            if (Array.isArray(booking.services) && booking.services.length > 0) {
              for (const svc of booking.services) {
                if (!svc || !svc.time) continue;
                
                // Check if this service involves our staff
                const svcStaffId = svc.staffId || booking.staffId || null;
                if (svcStaffId && svcStaffId !== "any" && svcStaffId !== "" && svcStaffId !== staffId) {
                  continue; // Different staff, skip
                }
                
                const svcStartMin = ttm(svc.time);
                const svcDuration = svc.duration || booking.duration || 60;
                const svcEndMin = svcStartMin + svcDuration;
                // Check for overlap
                if (slotMinutes < svcEndMin && svcStartMin < newServiceEndMin) {
                  return true;
                }
              }
            } else {
              // Single service booking - check main staffId
              if (!booking.time) continue;
              
              const bookingStaffId = booking.staffId || null;
              if (bookingStaffId && bookingStaffId !== "any" && bookingStaffId !== "" && bookingStaffId !== staffId) {
                continue; // Different staff, skip
              }
              
              const bStartMin = ttm(booking.time);
              const bDuration = booking.duration || 60;
              const bEndMin = bStartMin + bDuration;
              // Check for overlap
              if (slotMinutes < bEndMin && bStartMin < newServiceEndMin) {
                return true;
              }
            }
          }
          return false;
        };
        
        const formatTime = (minutes: number) => {
          const h = Math.floor(minutes / 60) % 24;
          const m = minutes % 60;
          return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
        };
        
        while (currentTime < maxTime) {
          // Check if slot + duration fits before closing time
          const slotEndTime = currentTime + duration;
          if (slotEndTime > maxTime) {
            break; // Stop if slot doesn't fit
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
        const color = type === "error" ? "border-red-500" : "border-pink-500";
        const icon = type === "error" ? "fa-solid fa-circle-xmark text-red-500" : "fa-solid fa-circle-check text-pink-500";
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
          if (slots) slots.innerHTML = '<p class="col-span-4 text-center text-slate-400 text-xs py-2">Select Service and Staff to see available slots.</p>';
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
    
    if (userRole === "salon_branch_admin" && userBranchId) {
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
    
    if (userRole === "salon_branch_admin" && userBranchId) {
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
      if (userRole === "salon_branch_admin" && userBranchId) {
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
          .map((s) => ({
          id: (s as any).id,
          name: String((s as any).name || "Service"),
          price: typeof (s as any).price === "number" ? (s as any).price : undefined,
          duration: typeof (s as any).duration === "number" ? (s as any).duration : undefined,
          imageUrl: (s as any).imageUrl || (s as any).image || undefined,
          icon: String((s as any).icon || "fa-solid fa-star"),
          branches: Array.isArray((s as any).branches) ? (s as any).branches.map(String) : undefined,
          staffIds: Array.isArray((s as any).staffIds) ? (s as any).staffIds.map(String) : undefined,
        }))
      );
    });
    const unsubStaff = subscribeSalonStaffForOwner(ownerUid, (rows) => {
      // Branch admin should only see staff from their branch
      let filteredStaff = rows;
      if (userRole === "salon_branch_admin" && userBranchId) {
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
          if (s.staffId && s.staffId !== "null" && s.staffName !== "Any Available" && s.staffName !== "Any Staff") {
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
              
              // CRITICAL: Filter by service qualification
              if (qualifiedStaffIds.length > 0) {
                filtered = filtered.filter((s: any) => qualifiedStaffIds.includes(String(s.id)));
              }
              
              // Filter by branch and day (check weeklySchedule)
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

            // CRITICAL: Filter by service qualification
            if (qualifiedStaffIds.length > 0) {
              filtered = filtered.filter((s: any) => qualifiedStaffIds.includes(String(s.id)));
            }

            // Filter by branch and day (check weeklySchedule)
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

  const resetWizard = () => {
    setBkStep(1);
    setBkBranchId(null);
    setBkSelectedServices([]);
    setBkServiceTimes({});
    setBkServiceStaff({});
    const t = new Date();
    setBkMonthYear({ month: t.getMonth(), year: t.getFullYear() });
    setBkDate(null);
    setBkClientName("");
    setBkClientEmail("");
    setBkClientPhone("");
    setBkNotes("");
  };
  const openBookingWizard = () => {
    resetWizard();
    // Auto-select branch for branch admins
    if (userRole === "salon_branch_admin" && userBranchId) {
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
    
    // For "Any Staff" bookings, get all eligible staff IDs for this service+branch.
    // A slot is only blocked when ALL eligible staff are occupied at that time.
    const eligibleStaffIds: string[] = (() => {
      if (!isAnyStaffSelected || !forServiceId) return [];
      
      const service = servicesList.find((s) => String(s.id) === String(forServiceId)) ||
        (app ? app.data.services.find((s: any) => String(s.id) === String(forServiceId)) : null);
      const svcStaffIds: string[] = ((service as any)?.staffIds ?? []).map(String);
      const svcHasStaffAssigned = svcStaffIds.length > 0;
      
      const selBranch = branches.find((b: any) => b.id === bkBranchId) || app?.data.branches?.find((b: any) => b.id === bkBranchId);
      const selBranchName = selBranch?.name;
      const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
      const selDayName = bkDate ? days[bkDate.getDay()] : null;
      
      return staffList.filter(st => {
        // Filter out suspended staff
        if (st.status === "Suspended" || st.status === "suspended") return false;
        // If service has specific staff assigned, ONLY include those
        if (svcHasStaffAssigned && !svcStaffIds.includes(String(st.id))) return false;
        // Check branch assignment
        if (bkBranchId) {
          if (selDayName && st.weeklySchedule) {
            const daySchedule = st.weeklySchedule[selDayName];
            if (!daySchedule) return false; // Staff is off this day
            if (daySchedule.branchId !== bkBranchId && daySchedule.branchName !== selBranchName) return false;
          } else {
            if (String(st.branchId || "") !== bkBranchId && String((st as any).branch || "") !== selBranchName) return false;
          }
        }
        return true;
      }).map(st => st.id);
    })();
    
    // Get all bookings for this date (excluding cancelled, completed, rejected)
    // Use centralized helper to ensure consistency
    // NOTE: When a booking is cancelled, its status changes to "Canceled" and shouldBlockSlots returns false,
    // so it's automatically excluded from relevantBookings, making the slot available again in real-time
    const allDateBookings = app ? app.data.bookings.filter((b: any) => {
      return b.date === dateStr && shouldBlockSlots(b.status);
    }) : [];
    
    // Helper function to check if a booking involves a specific staff member
    const bookingInvolvesStaff = (booking: any, targetStaffId: string): boolean => {
      // Check root-level staffId
      if (booking.staffId === targetStaffId) return true;
      
      // Check services array for multi-service bookings
      if (Array.isArray(booking.services)) {
        for (const svc of booking.services) {
          if (svc && svc.staffId === targetStaffId) {
            return true;
          }
        }
      }
      
      return false;
    };
    
    // Filter bookings to only those relevant to the selected staff (or all eligible staff for "Any Staff")
    const relevantBookings = (() => {
      if (isAnyStaffSelected) {
        // "Any Staff" mode: get ALL active bookings involving ANY eligible staff member
        // so we can check if all staff are occupied at a given time
        if (eligibleStaffIds.length === 0) return allDateBookings; // fallback: use all bookings
        return allDateBookings.filter((b: any) =>
          eligibleStaffIds.some(sid => bookingInvolvesStaff(b, sid))
        );
      }
      // Specific staff mode: only bookings involving the selected staff
      if (!staffIdForService) return [];
      return allDateBookings.filter((b: any) => bookingInvolvesStaff(b, staffIdForService));
    })();
    
    // Helper: Check if a specific staff member has a conflicting booking at a given time slot
    const isStaffOccupiedAtSlot = (slotStartMin: number, targetStaffId: string): boolean => {
      const newServiceEndMin = slotStartMin + serviceDuration;
      
      for (const booking of relevantBookings) {
        if (Array.isArray(booking.services) && booking.services.length > 0) {
          for (const svc of booking.services) {
            if (svc && svc.staffId === targetStaffId && svc.time) {
              const svcStartMin = timeToMinutes(svc.time);
              const svcDuration = svc.duration || 60;
              const svcEndMin = svcStartMin + svcDuration;
              if (slotStartMin < svcEndMin && svcStartMin < newServiceEndMin) {
                return true;
              }
            }
          }
        } else {
          if (booking.staffId === targetStaffId && booking.time) {
            const bStartMin = timeToMinutes(booking.time);
            const bEndMin = bStartMin + (booking.duration || 60);
            if (slotStartMin < bEndMin && bStartMin < newServiceEndMin) {
              return true;
            }
          }
        }
      }
      
      return false;
    };
    
    // Check if a specific slot time is occupied by any booking for the selected staff
    // Also checks if the NEW service would OVERLAP with any existing booking
    const isSlotOccupied = (slotMinutes: number): { occupied: boolean; reason?: string } => {
      if (isAnyStaffSelected) {
        // "Any Staff" mode: slot is occupied only if ALL eligible staff members are booked
        // If at least one staff member is free, the slot remains available
        if (eligibleStaffIds.length === 0) return { occupied: false };
        
        const allStaffOccupied = eligibleStaffIds.every(sid => isStaffOccupiedAtSlot(slotMinutes, sid));
        if (allStaffOccupied) {
          return { occupied: true, reason: 'all_staff_booked' };
        }
        return { occupied: false };
      }
      
      // Specific staff mode (existing logic)
      if (!staffIdForService) return { occupied: false };
      
      // Calculate when this new service would END
      const newServiceEndMin = slotMinutes + serviceDuration;
      
      for (const booking of relevantBookings) {
        // Check if booking has individual services (multi-service booking)
        if (Array.isArray(booking.services) && booking.services.length > 0) {
          for (const svc of booking.services) {
            if (!svc || !svc.time) continue;
            
            // Check if this service involves our staff
            const svcStaffId = svc.staffId || booking.staffId || null;
            if (svcStaffId && svcStaffId !== "any" && svcStaffId !== "" && svcStaffId !== staffIdForService) {
              continue; // Different staff, skip
            }
            
            const svcStartMin = timeToMinutes(svc.time);
            const svcDuration = svc.duration || booking.duration || 60;
            const svcEndMin = svcStartMin + svcDuration;
            
            // Check for ANY overlap between the new service and existing service
            if (slotMinutes < svcEndMin && svcStartMin < newServiceEndMin) {
              if (slotMinutes >= svcStartMin && slotMinutes < svcEndMin) {
                return { occupied: true, reason: 'booked' };
              } else {
                return { occupied: true, reason: 'insufficient_time' };
              }
            }
          }
        } else {
          // Single service booking
          if (!booking.time) continue;
          
          const bookingStaffId = booking.staffId || null;
          if (bookingStaffId && bookingStaffId !== "any" && bookingStaffId !== "" && bookingStaffId !== staffIdForService) {
            continue; // Different staff, skip
          }
          
          const bStartMin = timeToMinutes(booking.time);
          const bDuration = booking.duration || 60;
          const bEndMin = bStartMin + bDuration;
          
          if (slotMinutes < bEndMin && bStartMin < newServiceEndMin) {
            if (slotMinutes >= bStartMin && slotMinutes < bEndMin) {
              return { occupied: true, reason: 'booked' };
            } else {
              return { occupied: true, reason: 'insufficient_time' };
            }
          }
        }
      }
      return { occupied: false };
    };
    
    // Check if a slot is blocked by OTHER services in the CURRENT booking session (same staff)
    // Also checks if the NEW service would OVERLAP with other selected services
    const isSlotBlockedByCurrentSelection = (slotMinutes: number): { blocked: boolean; reason?: string } => {
      if (!forServiceId) return { blocked: false };
      
      if (isAnyStaffSelected) {
        // "Any Staff" mode: check if enough free staff remain after accounting for
        // existing bookings AND other services selected in the current booking session
        if (eligibleStaffIds.length === 0) return { blocked: false };
        
        const newServiceEndMin = slotMinutes + serviceDuration;
        
        // Count how many eligible staff are already occupied by existing bookings
        const occupiedByExisting = eligibleStaffIds.filter(sid => isStaffOccupiedAtSlot(slotMinutes, sid)).length;
        
        // Count how many other services in this session overlap with this slot
        // and could consume from the same staff pool
        let overlappingCurrentServices = 0;
        for (const otherServiceId of bkSelectedServices) {
          if (String(otherServiceId) === String(forServiceId)) continue;
          
          const otherTime = bkServiceTimes[String(otherServiceId)];
          if (!otherTime) continue;
          
          const otherStaffId = bkServiceStaff[String(otherServiceId)];
          const otherIsAnyStaff = !otherStaffId || otherStaffId === "any";
          
          // Only count if the other service competes for the same staff pool
          if (!otherIsAnyStaff && !eligibleStaffIds.includes(otherStaffId)) continue;
          
          const otherService = servicesList.find((s) => String(s.id) === String(otherServiceId)) ||
            (app ? app.data.services.find((s: any) => String(s.id) === String(otherServiceId)) : null);
          const otherDuration = Number((otherService as any)?.duration) || 60;
          
          const otherStartMin = timeToMinutes(otherTime);
          const otherEndMin = otherStartMin + otherDuration;
          
          // Check for overlap
          if (slotMinutes < otherEndMin && otherStartMin < newServiceEndMin) {
            overlappingCurrentServices++;
          }
        }
        
        // Free staff = total eligible - occupied by existing bookings
        const freeStaff = eligibleStaffIds.length - occupiedByExisting;
        
        // We need at least one free staff for this service
        // (overlappingCurrentServices already consume free staff slots)
        if (freeStaff <= overlappingCurrentServices) {
          return { blocked: true, reason: 'all_staff_booked' };
        }
        
        return { blocked: false };
      }
      
      // Specific staff mode (existing logic)
      if (!staffIdForService) return { blocked: false };
      
      // Calculate when this new service would END
      const newServiceEndMin = slotMinutes + serviceDuration;
      
      for (const otherServiceId of bkSelectedServices) {
        if (String(otherServiceId) === String(forServiceId)) continue;
        
        const otherStaffId = bkServiceStaff[String(otherServiceId)];
        if (otherStaffId !== staffIdForService) continue;
        
        const otherTime = bkServiceTimes[String(otherServiceId)];
        if (!otherTime) continue;
        
        const otherService = servicesList.find((s) => String(s.id) === String(otherServiceId)) ||
          (app ? app.data.services.find((s: any) => String(s.id) === String(otherServiceId)) : null);
        const otherDuration = Number((otherService as any)?.duration) || 60;
        
        const otherStartMin = timeToMinutes(otherTime);
        const otherEndMin = otherStartMin + otherDuration;
        
        // Check for ANY overlap between the new service and the other selected service
        if (slotMinutes < otherEndMin && otherStartMin < newServiceEndMin) {
          if (slotMinutes >= otherStartMin && slotMinutes < otherEndMin) {
            return { blocked: true, reason: 'selected' };
          } else {
            return { blocked: true, reason: 'insufficient_time_selected' };
          }
        }
      }
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

    // Calculate the latest possible slot start time
    // The service must finish by closing time, so: slotStart + duration <= endTime
    const startMinutes = Math.floor(startHour) * 60 + Math.round((startHour % 1) * 60);
    const endMinutes = Math.floor(endHour) * 60 + Math.round((endHour % 1) * 60);
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
    
    const interval = 15;
    const slots: Array<{ time: string; available: boolean; reason?: string }> = [];
    const format = (minutes: number) => {
      const h = Math.floor(minutes / 60) % 24;
      const m = minutes % 60;
      return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
    };
    
    // Generate all slots within branch hours
    for (let current = startMinutes; current < endMinutes; current += interval) {
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
  const handleConfirmBooking = () => {
    const app = appRef();
    if (bkSelectedServices.length === 0 || !bkBranchId || !bkDate) return;
    
    // Validate all services have times
    if (Object.keys(bkServiceTimes).length !== bkSelectedServices.length) {
      app?.showToast("Please select a time for each service.", "error");
      return;
    }

    setSubmittingBooking(true);
    
    const selectedServiceObjects = bkSelectedServices.map(id => 
      servicesList.find((s) => String(s.id) === String(id)) ||
      (app ? app.data.services.find((s: any) => String(s.id) === String(id)) : null)
    ).filter(Boolean);

    const serviceName = selectedServiceObjects.map(s => s?.name || "").join(", ");
    const serviceIds = selectedServiceObjects.map(s => s?.id).join(",");
    const totalPrice = selectedServiceObjects.reduce((sum, s) => sum + (Number(s?.price) || 0), 0);
    const totalDuration = selectedServiceObjects.reduce((sum, s) => sum + (Number(s?.duration) || 0), 0);
    
    // Use first service time as main booking time
    const firstServiceId = bkSelectedServices[0];
    const mainTime = bkServiceTimes[String(firstServiceId)];
    
    const selectedBranch = branches.find((b: any) => String(b.id) === String(bkBranchId));
    const branchName = selectedBranch?.name || "";
    const branchTimezone = selectedBranch?.timezone || "Australia/Sydney"; // Default to Australia/Sydney if not set
    
    // Determine main staff info
    const uniqueStaffIds = new Set(Object.values(bkServiceStaff).filter(Boolean));
    let mainStaffId: string | null = null;
    let mainStaffName = "Any Available";
    
    if (uniqueStaffIds.size === 1) {
      const sid = Array.from(uniqueStaffIds)[0];
      mainStaffId = sid;
      mainStaffName = staffList.find(st => st.id === sid)?.name || "Any Available";
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
      duration: totalDuration,
      status: "Pending",
      price: totalPrice,
      clientEmail: bkClientEmail?.trim() || undefined,
      clientPhone: bkClientPhone?.trim() || undefined,
      notes: bkNotes?.trim() || undefined,
      services: selectedServiceObjects.map(s => {
        const sId = String(s?.id);
        const stId = bkServiceStaff[sId];
        const stName = stId ? staffList.find(st => st.id === stId)?.name : "Any Available";
        return {
          id: s?.id,
          name: s?.name,
          price: s?.price,
          duration: s?.duration,
          time: bkServiceTimes[sId],
          staffId: stId || null,
          staffName: stName
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
          <main className="flex-1 overflow-auto p-4 sm:p-6 lg:p-8 bg-slate-50">
            <div className="md:hidden mb-4">
              <button
                className="inline-flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-slate-700 shadow-sm hover:bg-slate-50"
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
                <div className="rounded-2xl bg-gradient-to-r from-pink-500 via-fuchsia-600 to-indigo-600 text-white p-6 shadow-sm">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-xl bg-white/20 flex items-center justify-center">
                          <i className="fas fa-calendar-check" />
                        </div>
                        <h1 className="text-2xl font-bold">Today&apos;s Bookings</h1>
                      </div>
                      <p className="text-sm text-white/80 mt-2">
                        Today’s schedule, availability, and status.
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              <section id="view-bookings" className="view-section active">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-6">
                  <h2 className="text-2xl font-bold text-slate-800">Today&apos;s Bookings</h2>
                  <button
                    onClick={openBookingWizard}
                    className="w-full sm:w-auto px-4 py-2 bg-pink-600 text-white rounded-lg text-sm hover:bg-pink-700 font-medium shadow-md shadow-pink-200 transition"
                  >
                    <i className="fas fa-plus mr-2" /> New Booking
                  </button>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                  <div className="lg:col-span-2 bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
                    <table className="w-full text-left text-sm text-slate-600">
                      <thead className="bg-slate-50 text-slate-800 font-semibold border-b border-slate-100">
                        <tr>
                          <th className="p-4 pl-6">Client &amp; Service</th>
                          <th className="p-4">Time &amp; Staff</th>
                          <th className="p-4 text-center">Status</th>
                          <th className="p-4 text-right pr-6">Value</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100" id="bookings-table-body" />
                    </table>
                  </div>
                  <div className="space-y-6">
                    <div className="bg-slate-900 text-white rounded-2xl shadow-sm p-6">
                      <h3 className="font-bold mb-4 flex justify-between items-center">
                        Today&apos;s Summary
                        <i className="fas fa-chart-line text-pink-500" />
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
                    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6">
                      <h3 className="font-bold mb-4 text-slate-800">Booking Status Mix</h3>
                      <div className="h-40">
                        <canvas id="statusChart" />
                      </div>
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

      {/* Booking Modal - New Multi-step Wizard */}
      <div id="modal-booking" className="modal-backdrop">
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl mx-4 sm:mx-0 max-h-[92vh] flex flex-col">
          {/* Fixed Header */}
          <div className="bg-gradient-to-r from-pink-500 to-fuchsia-600 text-white p-4 sm:p-5 flex justify-between items-center rounded-t-2xl shrink-0">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-white/20 flex items-center justify-center">
                <i className="fas fa-calendar-check" />
              </div>
              <h3 className="font-bold text-lg">Book an Appointment</h3>
            </div>
            <button onClick={() => appRef()?.closeModal("booking")} className="text-white/80 hover:text-white transition w-8 h-8 rounded-lg hover:bg-white/10 flex items-center justify-center">
              <i className="fas fa-xmark text-xl" />
            </button>
          </div>

          {/* Fixed Stepper */}
          <div className="px-4 sm:px-6 pt-4 sm:pt-5 pb-4 bg-slate-50 border-b border-slate-200 shrink-0">
            <div className="flex items-center justify-between max-w-xl mx-auto">
              {[
                { num: 1, label: "Branch & Service" },
                { num: 2, label: "Date, Time & Staff" },
                { num: 3, label: "Confirm Details" }
              ].map((step, i) => (
                <div key={step.num} className="flex-1 flex items-center">
                  <div className="flex flex-col items-center gap-1">
                    <div className={`w-10 h-10 sm:w-12 sm:h-12 rounded-full flex items-center justify-center text-sm font-bold transition-all ${bkStep >= step.num ? "bg-gradient-to-br from-pink-600 to-purple-600 text-white shadow-lg" : "bg-white border-2 border-slate-300 text-slate-500"}`}>
                      {bkStep > step.num ? <i className="fas fa-check" /> : step.num}
                    </div>
                    <span className="text-[10px] text-slate-600 font-semibold hidden sm:block text-center whitespace-nowrap">{step.label}</span>
                  </div>
                  {i < 2 && <div className={`h-1 flex-1 mx-1 sm:mx-2 rounded transition-all ${bkStep > step.num ? "bg-gradient-to-r from-pink-500 to-purple-500" : "bg-slate-300"}`} />}
                </div>
              ))}
            </div>
          </div>

          {/* Scrollable Content */}
          <div className="flex-1 overflow-y-auto p-4 sm:p-6 custom-scrollbar">
            {/* Step 1 - Branch & Service (Combined) */}
            {bkStep === 1 && (
              <div className="space-y-6">
                {/* Branch Selection */}
                <div>
                  <div className="font-bold text-slate-700 mb-3 flex items-center gap-2">
                    <i className="fas fa-map-marker-alt text-pink-600" />
                    Select Location
                    {userRole === "salon_branch_admin" && <span className="text-xs font-normal text-slate-500">(Your assigned branch)</span>}
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {branches.map((br: any) => {
                      const selected = bkBranchId === br.id;
                      const isBranchAdmin = userRole === "salon_branch_admin";
                      return (
                        <button
                          key={br.id}
                          onClick={() => !isBranchAdmin && (setBkBranchId(br.id), setBkSelectedServices([]), setBkServiceStaff({}), setBkDate(null), setBkServiceTimes({}))}
                          disabled={isBranchAdmin}
                          className={`text-left border rounded-lg p-3 transition ${isBranchAdmin ? "cursor-not-allowed" : "hover:shadow-md cursor-pointer"} ${selected ? "border-pink-400 bg-pink-50 shadow-md" : "border-slate-200 bg-white"}`}
                        >
                          <div className="flex items-center gap-2.5">
                            <div className={`w-10 h-10 rounded-lg ${selected ? "bg-pink-100" : "bg-slate-100"} flex items-center justify-center shrink-0`}>
                              <i className={`fas fa-store ${selected ? "text-pink-600" : "text-slate-400"}`} />
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="font-semibold text-slate-800 truncate text-sm">{br.name}</div>
                              <div className="text-xs text-slate-500 truncate">{br.address}</div>
                            </div>
                            {selected && <i className="fas fa-check-circle text-pink-600 shrink-0" />}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Service Selection */}
                <div className={!bkBranchId ? "opacity-50 pointer-events-none" : ""}>
                  <div className="font-bold text-slate-700 mb-3 flex items-center gap-2">
                    <i className="fas fa-concierge-bell text-purple-600" />
                    Select Service {!bkBranchId && <span className="text-xs font-normal text-slate-500">(Select branch first)</span>}
                  </div>
                  {!bkBranchId ? (
                    <div className="bg-slate-50 border-2 border-dashed border-slate-300 rounded-lg p-8 text-center">
                      <i className="fas fa-map-marker-alt text-4xl text-slate-300 mb-2 block" />
                      <p className="text-slate-500 font-medium text-sm">Select a branch first</p>
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                      {servicesList
                        .filter((srv: any) => {
                          // Filter services by selected branch
                          // Service must have at least one branch assigned, and selected branch must be in the list
                          if (!srv.branches || srv.branches.length === 0) return false; // Not available if no branches assigned
                          return srv.branches.includes(bkBranchId);
                        })
                        .map((srv: any) => {
                        const isSelected = bkSelectedServices.includes(srv.id);
                        return (
                          <button
                            key={srv.id}
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
                            className={`text-left border rounded-lg p-3 hover:shadow-md transition ${isSelected ? "border-purple-400 bg-purple-50 shadow-md" : "border-slate-200 bg-white"}`}
                          >
                            <div className="flex items-center gap-2.5">
                              <div className={`w-10 h-10 rounded-lg ${isSelected ? "bg-purple-100" : "bg-slate-100"} flex items-center justify-center shrink-0 overflow-hidden`}>
                                {srv.imageUrl ? (
                                  <img src={srv.imageUrl} alt={srv.name} className="w-full h-full object-cover" />
                                ) : (
                                  <i className={`fas fa-cut ${isSelected ? "text-purple-600" : "text-slate-400"}`} />
                                )}
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="font-semibold text-slate-800 truncate text-sm">{srv.name}</div>
                                <div className="text-xs text-slate-500">{srv.duration} min • ${srv.price}</div>
                              </div>
                              {isSelected && <i className="fas fa-check-circle text-purple-600 shrink-0" />}
                            </div>
                          </button>
                        );
                      })}
                      {servicesList.filter((srv: any) => srv.branches && srv.branches.length > 0 && srv.branches.includes(bkBranchId)).length === 0 && (
                        <div className="col-span-full bg-slate-50 border-2 border-dashed border-slate-300 rounded-lg p-8 text-center">
                          <i className="fas fa-concierge-bell text-4xl text-slate-300 mb-2 block" />
                          <p className="text-slate-500 font-medium text-sm">No services available at this branch</p>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Navigation */}
                <div className="flex justify-end pt-2 border-t border-slate-200">
                  <button
                    disabled={!bkBranchId || bkSelectedServices.length === 0}
                    onClick={() => setBkStep(2)}
                    className={`px-5 py-2 rounded-lg text-white font-semibold ${bkBranchId && bkSelectedServices.length > 0 ? "bg-gradient-to-r from-pink-600 to-purple-600 hover:shadow-lg" : "bg-slate-300 cursor-not-allowed"}`}
                  >
                    Continue to Date & Time
                  </button>
                </div>
              </div>
            )}

            {/* Step 2 - Date, Time & Staff */}
            {bkStep === 2 && (
              <div className="space-y-6">
                {/* Date Selection */}
                <div className="bg-white p-4 rounded-xl border border-slate-200">
                  <div className="flex items-center justify-between mb-4">
                    <div className="font-bold text-slate-700 text-sm flex items-center gap-2">
                      <i className="fas fa-calendar text-pink-600"></i>
                      Select Date
                    </div>
                    <div className="flex items-center gap-1">
                      <button onClick={goPrevMonth} className="w-7 h-7 rounded bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs">
                        <i className="fas fa-chevron-left" />
                      </button>
                      <div className="text-xs font-semibold text-slate-800 px-2">{monthName}</div>
                      <button onClick={goNextMonth} className="w-7 h-7 rounded bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs">
                        <i className="fas fa-chevron-right" />
                      </button>
                    </div>
                  </div>
                  <div className="rounded-lg border border-slate-200 overflow-hidden">
                    <div className="grid grid-cols-7 text-[10px] font-semibold bg-slate-50 text-slate-600">
                      {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
                        <div key={i} className="px-1 py-1.5 text-center">
                          {d}
                        </div>
                      ))}
                    </div>
                    <div className="grid grid-cols-7">
                      {buildMonthCells().map((c, idx) => {
                        const isSelected =
                          c.date && bkDate && bkDate.getFullYear() === c.date.getFullYear() && bkDate.getMonth() === c.date.getMonth() && bkDate.getDate() === c.date.getDate();
                        
                        // Use branch timezone to determine "today" and past dates
                        const selectedBranch = branches.find((b) => b.id === bkBranchId);
                        const branchTimezone = selectedBranch?.timezone || 'Australia/Sydney';
                        const branchCurrentDate = getCurrentDateTimeInTimezone(branchTimezone).date;
                        
                        // Compare cell date with branch's current date
                        let isPast = false;
                        if (c.date) {
                          const cellDateStr = formatLocalYmd(c.date);
                          isPast = cellDateStr < branchCurrentDate;
                        }
                        
                        const baseClickable = c.date && !isPast ? "cursor-pointer hover:bg-slate-50" : "bg-slate-50/40 cursor-not-allowed opacity-60";
                        return (
                          <div
                            key={idx}
                            className={`h-10 border border-slate-100 p-1 text-xs flex items-center justify-center ${baseClickable} ${isSelected ? "bg-pink-50 ring-2 ring-pink-500 font-bold" : ""}`}
                            onClick={() => c.date && !isPast && (setBkDate(c.date), setBkServiceTimes({}))}
                          >
                            <span className={`text-slate-700 ${!c.date ? "opacity-0" : ""}`}>{c.label}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>

                {/* Services Configuration */}
                <div className={!bkDate ? "opacity-50 pointer-events-none" : ""}>
                  <div className="font-bold text-slate-700 mb-3 flex items-center gap-2 text-sm">
                    <i className="fas fa-clock text-purple-600" />
                    Select Staff & Time for Each Service
                  </div>
                  
                  {/* Branch Timezone Indicator */}
                  {bkBranchId && (() => {
                    const selectedBranch = branches.find((b) => b.id === bkBranchId);
                    const branchTimezone = selectedBranch?.timezone || 'Australia/Sydney';
                    
                    // Get timezone display name
                    const tzLabel = branchTimezone.split('/').pop()?.replace(/_/g, ' ') || branchTimezone;
                    
                    return (
                      <div className="mb-4 p-3 bg-gradient-to-r from-blue-50 to-indigo-50 rounded-lg border border-blue-200">
                        <div className="flex items-center justify-between flex-wrap gap-2">
                          <div className="flex items-center gap-2">
                            <i className="fas fa-globe text-blue-600"></i>
                            <span className="text-xs font-medium text-blue-800">
                              Branch Time Zone: <span className="font-bold">{tzLabel}</span>
                            </span>
                          </div>
                          <div className="flex items-center gap-2 bg-white px-3 py-1 rounded-full border border-blue-200">
                            <i className="fas fa-clock text-blue-500 text-xs"></i>
                            <span className="text-xs font-bold text-blue-700">
                              Current Time: {branchCurrentTime.time || '--:--'}
                            </span>
                          </div>
                        </div>
                        <p className="text-[10px] text-blue-600 mt-2">
                          <i className="fas fa-info-circle mr-1"></i>
                          Times shown are in the branch's local timezone. Past slots are automatically hidden.
                        </p>
                      </div>
                    );
                  })()}
                  
                  {!bkDate ? (
                    <div className="text-center text-slate-400 text-xs py-8 bg-slate-50 rounded-lg border border-slate-200 border-dashed">
                      <i className="fas fa-calendar-day text-2xl mb-2 block text-slate-300" />
                      Select a date above to continue
                    </div>
                  ) : bkSelectedServices.length === 0 ? (
                    <div className="text-center text-slate-400 text-xs py-8 bg-slate-50 rounded-lg border border-slate-200 border-dashed">
                      Select services in previous step
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 gap-4">
                      {bkSelectedServices.map((serviceId) => {
                        const service = servicesList.find((s) => String(s.id) === String(serviceId));
                        if (!service) return null;
                        
                        const slots = computeSlots(serviceId);
                        const selectedTime = bkServiceTimes[String(serviceId)];
                        const selectedStaffId = bkServiceStaff[String(serviceId)];
                        
                        // Inline staff filtering - STRICT: only show staff who can perform this service AT this branch
                        const selectedBranchName = branches.find((b: any) => b.id === bkBranchId)?.name;
                        
                        // Get day of week from selected date
                        const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
                        const selectedDayName = bkDate ? dayNames[bkDate.getDay()] : null;
                        
                        // Check if service has specific staff assigned
                        const serviceStaffIds: string[] = (service?.staffIds ?? []).map(String);
                        const serviceHasStaffAssigned = serviceStaffIds.length > 0;
                        
                        // Helper function to check if staff works at selected branch
                        const staffWorksAtBranch = (st: typeof staffList[0]): boolean => {
                           if (!bkBranchId) return true; // No branch selected = show all
                           
                           // Check weekly schedule first (day-specific branch assignment)
                           if (selectedDayName && st.weeklySchedule) {
                              const daySchedule = st.weeklySchedule[selectedDayName];
                              if (!daySchedule) return false; // Staff is off this day
                              // Check if scheduled at selected branch
                              return daySchedule.branchId === bkBranchId || daySchedule.branchName === selectedBranchName;
                           }
                           
                           // Fall back to home branch check
                           const staffBranchId = String(st.branchId || "");
                           const staffBranchName = String(st.branch || "");
                           
                           // Staff MUST have a branch assignment matching the selected branch
                           return staffBranchId === bkBranchId || staffBranchName === selectedBranchName;
                        };
                        
                        // FILTER: Staff must be non-suspended + work at branch + (if service has staffIds, be in that list)
                        let availableStaffForService = staffList.filter(st => {
                           // 1. Filter out suspended staff
                           if (st.status === "Suspended" || st.status === "suspended") return false;
                           
                           // 2. If service has specific staff assigned, ONLY show those
                           if (serviceHasStaffAssigned) {
                              if (!serviceStaffIds.includes(String(st.id))) return false;
                           }
                           
                           // 3. Staff must work at the selected branch (mandatory)
                           if (!staffWorksAtBranch(st)) return false;
                           
                           return true;
                        });
                        
                        // Debug log
                        console.log('[Booking] Staff filtering:', {
                           serviceName: service.name,
                           serviceHasStaffAssigned,
                           serviceStaffIds,
                           selectedDay: selectedDayName,
                           selectedBranch: { id: bkBranchId, name: selectedBranchName },
                           allStaffCount: staffList.length,
                           allStaffNames: staffList.map(s => `${s.name} (branch: ${s.branchId || 'none'})`),
                           filteredCount: availableStaffForService.length,
                           filteredNames: availableStaffForService.map(s => s.name),
                        });
                        
                        return (
                          <div key={String(serviceId)} className="bg-white rounded-xl border border-purple-100 shadow-sm p-4">
                            <div className="flex items-center justify-between mb-3">
                              <div className="font-bold text-slate-800 text-sm flex items-center gap-2">
                                <div className="w-6 h-6 rounded-full bg-purple-100 flex items-center justify-center text-purple-600 text-xs">
                                  <i className="fas fa-cut"></i>
                                </div>
                                {service.name}
                              </div>
                              <span className="text-[10px] bg-purple-50 px-2 py-1 rounded text-purple-700 font-medium">
                                {service.duration} min
                              </span>
                            </div>

                            {/* Staff Selector */}
                            <div className="mb-3">
                              <label className="text-[10px] font-bold text-slate-400 uppercase mb-1 block">Stylist</label>
                              <div className="flex flex-wrap gap-2">
                                <button
                                  onClick={() => {
                                    const newStaff = { ...bkServiceStaff };
                                    delete newStaff[String(serviceId)];
                                    setBkServiceStaff(newStaff);
                                    // Reset time
                                    const newTimes = { ...bkServiceTimes };
                                    delete newTimes[String(serviceId)];
                                    setBkServiceTimes(newTimes);
                                  }}
                                  className={`px-3 py-1.5 rounded-lg border text-xs font-medium flex items-center gap-1.5 ${
                                    !selectedStaffId 
                                      ? "bg-indigo-50 border-indigo-200 text-indigo-700" 
                                      : "bg-white border-slate-200 text-slate-600 hover:border-indigo-200"
                                  }`}
                                >
                                  <i className="fas fa-random flex-shrink-0"></i> <span>Any</span>
                                </button>
                                {availableStaffForService.map(st => (
                                  <button
                                    key={st.id}
                                    onClick={() => {
                                      setBkServiceStaff({ ...bkServiceStaff, [String(serviceId)]: st.id });
                                      // Reset time
                                      const newTimes = { ...bkServiceTimes };
                                      delete newTimes[String(serviceId)];
                                      setBkServiceTimes(newTimes);
                                    }}
                                    className={`px-3 py-1.5 rounded-lg border text-xs font-medium flex items-center gap-1.5 ${
                                      selectedStaffId === st.id
                                        ? "bg-indigo-50 border-indigo-200 text-indigo-700" 
                                        : "bg-white border-slate-200 text-slate-600 hover:border-indigo-200"
                                    }`}
                                  >
                                    {/* Avatar */}
                                    <div className="w-4 h-4 rounded-full bg-slate-200 overflow-hidden flex-shrink-0">
                                       {st.avatar ? <img src={`https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(st.avatar)}`} className="w-full h-full object-cover" alt="" /> : null}
                                    </div>
                                    <span>{st.name}</span>
                                  </button>
                                ))}
                              </div>
                            </div>

                            {/* Time Selector */}
                            <div>
                              <label className="text-[10px] font-bold text-slate-400 uppercase mb-1 block">Time Slot</label>
                              <div className="grid grid-cols-4 sm:grid-cols-6 gap-1.5">
                                {slots.length === 0 ? (
                                  <div className="col-span-full text-center text-slate-400 text-[10px] py-2 italic">
                                    No slots available
                                  </div>
                                ) : (
                                  slots.map((slot) => {
                                    const isSelected = selectedTime === slot.time;
                                    const isDisabled = !slot.available;
                                    const isBookedByOther = slot.reason === 'booked';
                                    const isSelectedForOtherService = slot.reason === 'selected';
                                    const isInsufficientTime = slot.reason === 'insufficient_time' || slot.reason === 'insufficient_time_selected';
                                    const isClosesBeforeFinish = slot.reason === 'closes_before_finish';
                                    
                                    // Determine tooltip message
                                    let tooltipMessage = 'Available';
                                    if (isDisabled) {
                                      if (isClosesBeforeFinish) {
                                        tooltipMessage = (slot as any).message || 'Service would end after branch closing time';
                                      } else if (isInsufficientTime) {
                                        tooltipMessage = 'Not enough time - service would overlap with next booking';
                                      } else if (isBookedByOther) {
                                        tooltipMessage = 'Already booked';
                                      } else if (isSelectedForOtherService) {
                                        tooltipMessage = 'Selected for another service';
                                      }
                                    }
                                    
                                    return (
                                      <button
                                        key={slot.time}
                                        onClick={() => {
                                          if (!isDisabled) {
                                            setBkServiceTimes({ ...bkServiceTimes, [String(serviceId)]: slot.time });
                                          }
                                        }}
                                        disabled={isDisabled}
                                        title={tooltipMessage}
                                        className={`py-1.5 rounded text-[10px] font-bold transition-all relative group ${
                                          isSelected 
                                            ? "bg-gradient-to-r from-pink-600 to-purple-600 text-white shadow-sm" 
                                            : isClosesBeforeFinish
                                              ? "bg-orange-50 text-orange-400 border border-orange-200 cursor-not-allowed"
                                              : isInsufficientTime
                                                ? "bg-yellow-50 text-yellow-600 border border-yellow-300 cursor-not-allowed"
                                                : isBookedByOther
                                                  ? "bg-red-50 text-red-400 border border-red-200 cursor-not-allowed line-through"
                                                  : isSelectedForOtherService
                                                    ? "bg-amber-50 text-amber-500 border border-amber-200 cursor-not-allowed"
                                                    : "bg-white text-slate-700 border border-purple-100 hover:border-pink-300"
                                        }`}
                                      >
                                        {slot.time}
                                        {(isClosesBeforeFinish || isInsufficientTime) && (
                                          <span className="absolute -top-1 -right-1 w-3 h-3 bg-orange-500 rounded-full flex items-center justify-center">
                                            <span className="text-white text-[8px]">!</span>
                                          </span>
                                        )}
                                      </button>
                                    );
                                  })
                                )}
                              </div>
                              {/* Show legend for unavailable slot reasons */}
                              {slots.some(s => s.reason === 'closes_before_finish' || s.reason === 'insufficient_time') && (
                                <div className="mt-2 text-[9px] text-slate-500 flex flex-wrap gap-3">
                                  <span className="flex items-center gap-1">
                                    <span className="w-2 h-2 rounded bg-orange-300"></span>
                                    Closes before service ends
                                  </span>
                                  <span className="flex items-center gap-1">
                                    <span className="w-2 h-2 rounded bg-yellow-300"></span>
                                    Overlaps with next booking
                                  </span>
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Navigation */}
                <div className="flex justify-between pt-3 border-t border-slate-200">
                  <button onClick={() => setBkStep(1)} className="px-5 py-2 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 font-medium">
                    Back
                  </button>
                  <button
                    disabled={!bkDate || Object.keys(bkServiceTimes).length !== bkSelectedServices.length}
                    onClick={() => setBkStep(3)}
                    className={`px-5 py-2 rounded-lg text-white font-semibold ${bkDate && Object.keys(bkServiceTimes).length === bkSelectedServices.length ? "bg-pink-600 hover:bg-pink-700" : "bg-slate-300 cursor-not-allowed"}`}
                  >
                    Continue to Details
                  </button>
                </div>
              </div>
            )}

            {/* Step 3 - Customer Details + Summary */}
            {bkStep === 3 && (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* Customer Details Form */}
                <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6">
                  <div className="font-bold text-slate-700 mb-4">Your Details</div>
                  <div className="space-y-4">
              <div>
                      <label className="block text-xs font-medium text-slate-500 mb-1">Full Name <span className="text-pink-500">*</span></label>
                      <input
                        type="text"
                        value={bkClientName}
                        onChange={(e) => setBkClientName(e.target.value)}
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-pink-500"
                        placeholder="John Doe"
                        required
                      />
                </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-500 mb-1">Email Address <span className="text-pink-500">*</span></label>
                      <input
                        type="email"
                        value={bkClientEmail}
                        onChange={(e) => setBkClientEmail(e.target.value)}
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-pink-500"
                        placeholder="john@example.com"
                        required
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-500 mb-1">Phone Number <span className="text-pink-500">*</span></label>
                      <input
                        type="tel"
                        value={bkClientPhone}
                        onChange={(e) => setBkClientPhone(e.target.value)}
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-pink-500"
                        placeholder="+1 555 000 1111"
                        required
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-500 mb-1">Additional Notes (Optional)</label>
                      <textarea
                        value={bkNotes}
                        onChange={(e) => setBkNotes(e.target.value)}
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-pink-500"
                        placeholder="Any special requests or information…"
                        rows={4}
                      />
                    </div>
                  </div>
                </div>

                {/* Booking Summary */}
                <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6">
                  <div className="font-bold text-slate-700 mb-4">Booking Summary</div>
                  <div className="bg-pink-50 rounded-xl border border-pink-100 p-4 space-y-3 text-sm">
                    <div className="flex justify-between"><span className="text-slate-500">Branch</span><span className="font-semibold text-slate-800">{branches.find((b: any) => b.id === bkBranchId)?.name || "-"}</span></div>
                    
                    <div className="border-t border-pink-100 pt-2 mt-2">
                      <span className="text-slate-500 block mb-2">Services ({bkSelectedServices.length})</span>
                      <div className="space-y-2">
                        {bkSelectedServices.map(id => {
                          const s = servicesList.find((srv: any) => String(srv.id) === String(id));
                          const stId = bkServiceStaff[String(id)];
                          const stName = stId ? staffList.find(st => st.id === stId)?.name : "Any Staff";
                          return (
                            <div key={id} className="bg-white/60 p-2 rounded border border-pink-100">
                              <div className="flex justify-between">
                                <span className="font-semibold text-slate-800">{s?.name || "-"}</span>
                                <span className="font-bold text-pink-600">${s?.price || 0}</span>
                              </div>
                              <div className="flex justify-between text-xs text-slate-500 mt-1">
                                <span className="flex items-center gap-2">
                                   <span>{bkServiceTimes[String(id)]}</span>
                                   <span className="text-slate-400">•</span>
                                   <span><i className="fas fa-user mr-1"></i> {stName}</span>
                                </span>
                                <span>{s?.duration} min</span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    <div className="flex justify-between"><span className="text-slate-500">Date</span><span className="font-semibold text-slate-800">{bkDate ? bkDate.toLocaleDateString() : "-"}</span></div>
                    
                    <div className="flex justify-between border-t-2 border-pink-200 pt-2 mt-2">
                      <span className="text-slate-700 font-bold">Total Price</span>
                      <span className="font-black text-pink-600 text-lg">
                        ${bkSelectedServices.reduce((sum: number, id) => {
                          const s = servicesList.find((srv: any) => String(srv.id) === String(id));
                          return sum + (Number(s?.price) || 0);
                        }, 0)}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="lg:col-span-2 mt-1 flex justify-between">
                  <button disabled={submittingBooking} onClick={() => setBkStep(2)} className={`px-5 py-2 rounded-lg border border-slate-300 ${submittingBooking ? "text-slate-400 cursor-not-allowed" : "text-slate-700 hover:bg-slate-50"} font-medium`}>
                    Back
                  </button>
                  <button
                    disabled={!bkBranchId || bkSelectedServices.length === 0 || !bkDate || Object.keys(bkServiceTimes).length !== bkSelectedServices.length || !bkClientName.trim() || !bkClientEmail.trim() || !bkClientPhone.trim() || submittingBooking}
                    onClick={handleConfirmBooking}
                    className={`px-5 py-2 rounded-lg text-white font-semibold ${bkBranchId && bkSelectedServices.length > 0 && bkDate && Object.keys(bkServiceTimes).length === bkSelectedServices.length && bkClientName.trim() && bkClientEmail.trim() && bkClientPhone.trim() && !submittingBooking ? "bg-pink-600 hover:bg-pink-700" : "bg-slate-300 cursor-not-allowed"}`}
                  >
                    {submittingBooking ? <span className="inline-flex items-center"><i className="fas fa-spinner animate-spin mr-2" /> Confirming…</span> : "Confirm Booking"}
                  </button>
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
              <div className="mb-6 p-4 bg-slate-50 rounded-lg">
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-10 h-10 rounded-full bg-gradient-to-br from-pink-500 to-fuchsia-600 text-white flex items-center justify-center text-sm font-bold">
                    {(bookingToConfirm.client || "?").split(" ").map((s: string) => s[0]).slice(0,2).join("")}
                  </div>
                  <div>
                    <p className="font-semibold text-slate-900">{bookingToConfirm.client}</p>
                    <p className="text-xs text-slate-500">{bookingToConfirm.serviceName || "Service"}</p>
                  </div>
                </div>
                <div className="flex items-center gap-4 text-xs text-slate-600">
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
                    <span className="ml-3 text-slate-600">Loading staff...</span>
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
                          const needsAssignment = !service.staffId || service.staffId === "null" || service.staffName === "Any Available" || service.staffName === "Any Staff";
                          
                          return (
                            <div key={String(service.id)} className="border-2 border-purple-200 rounded-xl p-4 bg-purple-50/50">
                              <div className="mb-3 flex items-center gap-2">
                                <i className="fas fa-spa text-purple-600"></i>
                                <h4 className="font-bold text-slate-800">{service.name}</h4>
                                <span className="text-xs text-slate-500 ml-auto">{service.duration} min</span>
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
                      /* Single Service */
                      <>
                        <label className="block text-sm font-semibold text-slate-700 mb-3">
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
                                    : "border-slate-200 hover:border-emerald-300 hover:bg-slate-50"
                                }`}
                              >
                                <div className="flex items-center gap-3">
                                  <div className={`w-10 h-10 rounded-full overflow-hidden flex-shrink-0 border-2 ${
                                    selectedStaffId === staff.id ? "border-emerald-500" : "border-slate-200"
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
                onClick={() => {
                  setStaffAssignModalOpen(false);
                  setBookingToConfirm(null);
                  setSelectedStaffId("");
                  setSelectedStaffPerService({});
                  setAvailableStaffForModal([]);
                  setAvailableStaffPerServiceForModal({});
                }}
                disabled={confirmingBooking}
                className="px-4 py-2.5 rounded-lg text-slate-700 hover:bg-slate-200 font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-sm"
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

      {/* Minimal CSS for modal, toasts, status badges, and time slots */}
      <style>{`
        .view-section.active { display: block; }
        .modal-backdrop { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(15,23,42,0.6); backdrop-filter: blur(4px); z-index: 50; align-items: center; justify-content: center; }
        .modal-backdrop.open { display: flex; }
        .toast { background: #1e293b; color: white; padding: 12px 24px; border-radius: 8px; margin-top: 10px; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1); display: flex; align-items: center; gap: 12px; border-left: 4px solid #ec4899; }
        .status-Confirmed { background-color: #dcfce7; color: #15803d; }
        .status-Pending { background-color: #fef9c3; color: #a16207; }
        .status-Canceled { background-color: #fee2e2; color: #b91c1c; }
        .status-Completed { background-color: #e0f2fe; color: #075985; }
      `}</style>
    </>
  );
}

// Main export wrapped in Suspense for useSearchParams
export default function BookingsPage() {
  return (
    <Suspense fallback={
      <div className="flex h-screen items-center justify-center bg-slate-50">
        <div className="flex flex-col items-center gap-3">
          <i className="fas fa-circle-notch fa-spin text-4xl text-pink-500" />
          <p className="text-slate-500 font-medium">Loading bookings...</p>
        </div>
      </div>
    }>
      <BookingsPageContent />
    </Suspense>
  );
}
