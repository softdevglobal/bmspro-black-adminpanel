"use client";
import React, { useEffect, useMemo, useState } from "react";
import Sidebar from "@/components/Sidebar";
import { useParams, useRouter } from "next/navigation";
import { auth, db } from "@/lib/firebase";
import { onAuthStateChanged } from "firebase/auth";
import { collection, doc, getDoc, onSnapshot, query, where } from "firebase/firestore";

type StaffStatus = "Active" | "Suspended";
type StaffTraining = { ohs?: boolean; prod?: boolean; tool?: boolean };
type HoursDay = { open?: string; close?: string; closed?: boolean };
type HoursMap = {
  Monday?: HoursDay;
  Tuesday?: HoursDay;
  Wednesday?: HoursDay;
  Thursday?: HoursDay;
  Friday?: HoursDay;
  Saturday?: HoursDay;
  Sunday?: HoursDay;
};

type WeeklySchedule = {
  Monday?: { branchId: string; branchName: string } | null;
  Tuesday?: { branchId: string; branchName: string } | null;
  Wednesday?: { branchId: string; branchName: string } | null;
  Thursday?: { branchId: string; branchName: string } | null;
  Friday?: { branchId: string; branchName: string } | null;
  Saturday?: { branchId: string; branchName: string } | null;
  Sunday?: { branchId: string; branchName: string } | null;
};

type Staff = {
  id: string;
  name: string;
  role: string;
  email?: string | null;
  status: StaffStatus;
  avatar: string;
  branchId?: string;
  branchName?: string;
  training?: StaffTraining;
  weeklySchedule?: WeeklySchedule;
};

// Staff Schedule Tab Component
function StaffScheduleTab({
  staff,
  staffBookings,
  branchHours,
  monthYear,
  selectedDate,
  setSelectedDate,
  goPrevMonth,
  goNextMonth,
  monthName,
  getHoursForWeekday,
}: {
  staff: Staff;
  staffBookings: any[];
  branchHours: HoursMap | null;
  monthYear: { month: number; year: number };
  selectedDate: Date;
  setSelectedDate: (d: Date) => void;
  goPrevMonth: () => void;
  goNextMonth: () => void;
  monthName: string;
  getHoursForWeekday: (weekdayIndex: number) => HoursDay | undefined;
}) {
  const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
  const SHORT_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  // Get selected date string
  const selectedDateStr = selectedDate.toISOString().slice(0, 10);
  
  // Get bookings for selected date
  const dayBookings = staffBookings.filter((b) => b.date === selectedDateStr);
  const sortedBookings = [...dayBookings].sort((a, b) => {
    const aTime = a.time || "00:00";
    const bTime = b.time || "00:00";
    return aTime.localeCompare(bTime);
  });

  // Check if staff is working on selected day
  const selectedDayName = DAYS[selectedDate.getDay()] as keyof WeeklySchedule;
  const dayAssignment = staff.weeklySchedule?.[selectedDayName];
  const isWorkingDay = dayAssignment && dayAssignment.branchId;

  // Get branch hours for the day
  const dayHours = getHoursForWeekday(selectedDate.getDay());
  const branchOpen = dayHours?.open || "—";
  const branchClose = dayHours?.close || "—";

  // Count bookings per day for calendar
  const bookingsPerDay = useMemo(() => {
    const counts: Record<string, number> = {};
    staffBookings.forEach((b) => {
      if (b.date) counts[b.date] = (counts[b.date] || 0) + 1;
    });
    return counts;
  }, [staffBookings]);

  // Build calendar cells
  const buildMonthCells = () => {
    const firstDayWeekIdx = new Date(monthYear.year, monthYear.month, 1).getDay();
    const numDays = new Date(monthYear.year, monthYear.month + 1, 0).getDate();
    const cells: Array<{ label?: number; date?: Date; dateStr?: string; isWorking?: boolean; bookingCount?: number }> = [];
    
    for (let i = 0; i < firstDayWeekIdx; i++) cells.push({});
    
    for (let d = 1; d <= numDays; d++) {
      const dt = new Date(monthYear.year, monthYear.month, d);
      const dateStr = dt.toISOString().slice(0, 10);
      const dayName = DAYS[dt.getDay()] as keyof WeeklySchedule;
      const assignment = staff.weeklySchedule?.[dayName];
      const isWorking = Boolean(assignment?.branchId);
      const bookingCount = bookingsPerDay[dateStr] || 0;
      cells.push({ label: d, date: dt, dateStr, isWorking, bookingCount });
    }
    
    while (cells.length % 7 !== 0) cells.push({});
    return cells;
  };

  // Calculate daily stats (only completed bookings for revenue)
  const dayRevenue = sortedBookings
    .filter(b => b.status === "Completed")
    .reduce((sum, b) => sum + Number(b.price || 0), 0);
  const completedCount = sortedBookings.filter(b => b.status === "Completed").length;
  const isToday = selectedDate.toDateString() === new Date().toDateString();

  return (
    <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
      {/* Calendar - Left */}
      <div className="lg:col-span-2 bg-white rounded-2xl border border-slate-200 shadow-sm p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <div className="text-sm font-bold text-slate-700">Staff Calendar</div>
            <p className="text-xs text-slate-500 mt-1">Click a date to view appointments</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={goPrevMonth} className="w-8 h-8 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 transition">
              <i className="fas fa-chevron-left" />
            </button>
            <div className="text-sm font-semibold text-slate-800 px-3 min-w-[140px] text-center">{monthName}</div>
            <button onClick={goNextMonth} className="w-8 h-8 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 transition">
              <i className="fas fa-chevron-right" />
            </button>
          </div>
        </div>
        
        {/* Legend */}
        <div className="flex items-center gap-4 mb-3 text-xs text-slate-500">
          <div className="flex items-center gap-1">
            <div className="w-2 h-2 rounded-full bg-emerald-400" />
            <span>Working</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-2 h-2 rounded-full bg-slate-300" />
            <span>Off</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-4 h-4 rounded bg-pink-100 text-pink-600 text-[10px] flex items-center justify-center font-bold">3</div>
            <span>Bookings</span>
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 overflow-hidden">
          <div className="grid grid-cols-7 text-xs font-semibold bg-slate-50 text-slate-600">
            {SHORT_DAYS.map((d) => (
              <div key={d} className="px-2 py-2.5 text-center border-b border-slate-100">
                {d}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7">
            {buildMonthCells().map((c, idx) => {
              const isSelected = c.date && selectedDate.toDateString() === c.date.toDateString();
              const isPast = c.date && c.date < new Date(new Date().setHours(0, 0, 0, 0));
              const isTodayCell = c.date && c.date.toDateString() === new Date().toDateString();
              
              return (
                <div
                  key={idx}
                  className={`min-h-[70px] border-b border-r border-slate-100 p-1.5 text-sm transition-all cursor-pointer ${
                    !c.date ? "bg-slate-50/50" : ""
                  } ${isSelected ? "bg-pink-50 ring-2 ring-pink-400 ring-inset" : "hover:bg-slate-50"} ${
                    isPast && !isSelected ? "opacity-60" : ""
                  }`}
                  onClick={() => c.date && setSelectedDate(c.date)}
                >
                  {c.date && (
                    <>
                      <div className="flex items-start justify-between">
                        <span className={`text-xs font-medium ${
                          isSelected ? "text-pink-700" : isTodayCell ? "text-pink-600 font-bold" : "text-slate-700"
                        }`}>
                          {c.label}
                        </span>
                        <span
                          className={`w-2 h-2 rounded-full ${c.isWorking ? "bg-emerald-400" : "bg-slate-300"}`}
                          title={c.isWorking ? "Working" : "Off"}
                        />
                      </div>
                      {c.bookingCount! > 0 && (
                        <div className="mt-1">
                          <div className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-pink-100 text-pink-700 text-[10px] font-semibold">
                            <i className="fas fa-calendar-check" />
                            {c.bookingCount}
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Day Details - Right */}
      <div className="lg:col-span-3 space-y-4">
        {/* Date Header */}
        <div className={`rounded-2xl p-5 ${
          !isWorkingDay 
            ? "bg-slate-100 border border-slate-200" 
            : "bg-gradient-to-r from-pink-500 to-purple-600 text-white"
        }`}>
          <div className="flex items-center justify-between">
            <div>
              <div className={`text-lg font-bold ${!isWorkingDay ? "text-slate-700" : ""}`}>
                {selectedDate.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
                {isToday && <span className="ml-2 text-xs bg-white/20 px-2 py-0.5 rounded-full">Today</span>}
              </div>
              <div className={`text-sm mt-1 ${!isWorkingDay ? "text-slate-500" : "text-white/80"}`}>
                {isWorkingDay ? (
                  <span className="flex items-center gap-2">
                    <i className="fas fa-building" />
                    {dayAssignment?.branchName} • {branchOpen} - {branchClose}
                  </span>
                ) : (
                  <span className="flex items-center gap-2">
                    <i className="fas fa-moon" />
                    Day Off
                  </span>
                )}
              </div>
            </div>
            <div className={`text-right ${!isWorkingDay ? "text-slate-600" : ""}`}>
              <div className="text-2xl font-bold">{sortedBookings.length}</div>
              <div className={`text-xs ${!isWorkingDay ? "" : "text-white/80"}`}>Appointments</div>
            </div>
          </div>
        </div>

        {/* Quick Stats */}
        {isWorkingDay && (
          <div className="grid grid-cols-3 gap-3">
            <div className="bg-white rounded-xl border border-slate-200 p-3 text-center">
              <div className="text-xl font-bold text-emerald-600">${dayRevenue}</div>
              <div className="text-xs text-slate-500">Revenue</div>
            </div>
            <div className="bg-white rounded-xl border border-slate-200 p-3 text-center">
              <div className="text-xl font-bold text-blue-600">{sortedBookings.length}</div>
              <div className="text-xs text-slate-500">Bookings</div>
            </div>
            <div className="bg-white rounded-xl border border-slate-200 p-3 text-center">
              <div className="text-xl font-bold text-purple-600">{completedCount}</div>
              <div className="text-xs text-slate-500">Completed</div>
            </div>
          </div>
        )}

        {/* Appointments List */}
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4">
          <div className="text-sm font-bold text-slate-700 flex items-center gap-2 mb-3">
            <i className="fas fa-list-check text-pink-500" />
            Day's Appointments
          </div>
          
          {!isWorkingDay ? (
            <div className="text-center py-8 text-slate-400">
              <i className="fas fa-bed text-3xl mb-2" />
              <p className="text-sm">Staff is not scheduled to work on this day</p>
            </div>
          ) : sortedBookings.length === 0 ? (
            <div className="text-center py-8 text-slate-400">
              <i className="fas fa-calendar-xmark text-3xl mb-2" />
              <p className="text-sm">No appointments scheduled</p>
            </div>
          ) : (
            <div className="space-y-3 max-h-[350px] overflow-y-auto pr-1">
              {sortedBookings.map((b, idx) => {
                const statusColors: Record<string, string> = {
                  Pending: "bg-amber-50 border-amber-200 text-amber-700",
                  Confirmed: "bg-blue-50 border-blue-200 text-blue-700",
                  Completed: "bg-emerald-50 border-emerald-200 text-emerald-700",
                  Cancelled: "bg-rose-50 border-rose-200 text-rose-700",
                };
                const statusColor = statusColors[b.status] || "bg-slate-50 border-slate-200 text-slate-600";
                
                return (
                  <div key={b.id || idx} className="border border-slate-200 rounded-xl p-4 hover:shadow-md transition bg-white">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex items-start gap-3">
                        {/* Time */}
                        <div className="text-center shrink-0 w-14">
                          <div className="text-lg font-bold text-slate-800">{b.time || "—"}</div>
                          <div className="text-[10px] text-slate-400">{b.duration ? `${b.duration}min` : ""}</div>
                        </div>
                        
                        <div className="w-px h-12 bg-slate-200 shrink-0" />
                        
                        {/* Details */}
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <div className="w-8 h-8 rounded-full bg-pink-100 text-pink-600 flex items-center justify-center text-xs font-semibold">
                              {(b.client || "U").toString().slice(0, 1).toUpperCase()}
                            </div>
                            <div>
                              <div className="text-sm font-semibold text-slate-800">{b.client || "Unknown"}</div>
                              <div className="text-xs text-slate-500">{b.serviceName || "Service"}</div>
                            </div>
                          </div>
                          <div className="text-xs text-slate-600 mt-2 font-semibold">
                            ${Number(b.price || 0).toFixed(0)}
                          </div>
                        </div>
                      </div>
                      
                      {/* Status */}
                      <div className={`shrink-0 px-2.5 py-1 rounded-full text-xs font-medium border ${statusColor}`}>
                        {b.status || "Pending"}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function StaffPreviewPage() {
  const router = useRouter();
  const params = useParams() as { id?: string | string[] };
  const staffId = Array.isArray(params?.id) ? params.id[0] : params?.id;

  const [ownerUid, setOwnerUid] = useState<string | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [staff, setStaff] = useState<Staff | null>(null);
  const [branchHours, setBranchHours] = useState<HoursMap | null>(null);
  const [staffBookings, setStaffBookings] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<
    "overview" | "schedule" | "training" | "appointments" | "customers"
  >("overview");
  const [monthYear, setMonthYear] = useState<{ month: number; year: number }>(() => {
    const t = new Date();
    return { month: t.getMonth(), year: t.getFullYear() };
  });
  const [selectedDate, setSelectedDate] = useState<Date>(() => new Date());

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        router.replace("/login");
        return;
      }
      setOwnerUid(user.uid);
    });
    return () => unsub();
  }, [router]);

  // subscribe to staff doc
  useEffect(() => {
    if (!ownerUid || !staffId) return;
    setLoading(true);
    const unsub = onSnapshot(
      doc(db, "users", staffId),
      async (d) => {
        if (!d.exists()) {
          setStaff(null);
          setLoading(false);
          return;
        }
        const s = d.data() as any;
        const row: Staff = {
          id: d.id,
          name: String(s.displayName || s.name || ""),
          role: String(s.staffRole || s.role || ""),
          email: s.email || null,
          status: (s.status as StaffStatus) || "Active",
          avatar: String(s.avatar || s.name || s.displayName || ""),
          branchId: s.branchId || undefined,
          branchName: s.branchName || undefined,
        training: (s.training as StaffTraining) || {},
        weeklySchedule: (s.weeklySchedule as WeeklySchedule) || {},
      };
      setStaff(row);
      // fetch hours for their branch for schedule tab
      if (s.branchId) {
        try {
          const bsnap = await getDoc(doc(db, "branches", String(s.branchId)));
          setBranchHours((bsnap.data() as any)?.hours || null);
        } catch {
          setBranchHours(null);
        }
      } else {
        setBranchHours(null);
      }
      setLoading(false);
    },
    (error) => {
      if (error.code === "permission-denied") {
        console.warn("Permission denied for staff query.");
        setStaff(null);
        setLoading(false);
      } else {
        console.error("Error in staff snapshot:", error);
        setLoading(false);
      }
    }
    );
    return () => unsub();
  }, [ownerUid, staffId]);

  // Subscribe to bookings for this staff member
  useEffect(() => {
    if (!ownerUid || !staffId || !staff) return;
    
    // Query bookings where this staff is assigned
    const q = query(collection(db, "bookings"), where("ownerUid", "==", ownerUid));
    const unsub = onSnapshot(
      q,
      (snap) => {
        const allBookings: any[] = [];
        snap.forEach((d) => {
          const b = d.data() as any;
          allBookings.push({ id: d.id, ...b });
        });
        
        // Filter bookings where this staff member is assigned
        const filtered = allBookings.filter((b) => {
          // Check staffId field
          if (b.staffId === staffId) return true;
          
          // Check staffName field (match by name)
          if (b.staffName && staff.name && b.staffName.toLowerCase() === staff.name.toLowerCase()) return true;
          
          // Check services array for multi-service bookings
          if (Array.isArray(b.services)) {
            return b.services.some((s: any) => 
              s.staffId === staffId || 
              (s.staffName && staff.name && s.staffName.toLowerCase() === staff.name.toLowerCase())
            );
          }
          
          return false;
        });
        
        // Sort by date (most recent first)
        filtered.sort((a, b) => {
          const aDate = a.date || "";
          const bDate = b.date || "";
          return bDate.localeCompare(aDate);
        });
        
        setStaffBookings(filtered);
      },
      (error) => {
        console.error("Error fetching staff bookings:", error);
        setStaffBookings([]);
      }
    );
    
    return () => unsub();
  }, [ownerUid, staffId, staff]);

  const headerTitle = useMemo(() => (staff ? staff.name : "Staff"), [staff]);
  const monthName = useMemo(() => {
    return new Date(monthYear.year, monthYear.month, 1).toLocaleString(undefined, { month: "long", year: "numeric" });
  }, [monthYear]);

  const goPrevMonth = () =>
    setMonthYear(({ month, year }) => {
      const nm = month - 1;
      return nm < 0 ? { month: 11, year: year - 1 } : { month: nm, year };
    });
  const goNextMonth = () =>
    setMonthYear(({ month, year }) => {
      const nm = month + 1;
      return nm > 11 ? { month: 0, year: year + 1 } : { month: nm, year };
    });

  const getHoursForWeekday = (weekdayIndex: number): HoursDay | undefined => {
    const keys: (keyof HoursMap)[] = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const key = keys[weekdayIndex];
    return (branchHours as any)?.[key] as HoursDay | undefined;
  };

  const buildMonthCells = () => {
    const firstDayWeekIdx = new Date(monthYear.year, monthYear.month, 1).getDay();
    const numDays = new Date(monthYear.year, monthYear.month + 1, 0).getDate();
    const cells: Array<{ label?: number; date?: Date; off?: boolean }> = [];
    for (let i = 0; i < firstDayWeekIdx; i++) cells.push({});
    for (let d = 1; d <= numDays; d++) {
      const dt = new Date(monthYear.year, monthYear.month, d);
      const h = getHoursForWeekday(dt.getDay());
      const off = Boolean(h?.closed);
      cells.push({ label: d, date: dt, off });
    }
    while (cells.length % 7 !== 0) cells.push({});
    return cells;
  };

  const selectedDayText = () => {
    const w = selectedDate.toLocaleDateString(undefined, { weekday: "long" });
    const h = getHoursForWeekday(selectedDate.getDay());
    if (!h) return `${w}: —`;
    if (h.closed) return `${w}: Off`;
    if (h.open && h.close) return `${w}: ${h.open} - ${h.close}`;
    return `${w}: —`;
  };

  return (
    <div id="app" className="flex h-screen overflow-hidden bg-white">
      <Sidebar />
      <div className="flex-1 flex flex-col overflow-hidden">
        <main className="flex-1 overflow-auto p-4 sm:p-6 lg:p-8">
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

          {/* Back */}
          <div className="mb-3">
            <button
              onClick={() => {
                try {
                  if (typeof window !== "undefined" && window.history.length > 1) router.back();
                  else router.push("/staff");
                } catch {
                  router.push("/staff");
                }
              }}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-slate-700 hover:bg-slate-50 shadow-sm"
            >
              <i className="fas fa-arrow-left" />
              Back to Staff
            </button>
          </div>

          {/* Header */}
          <div className="mb-8">
            <div className="rounded-2xl bg-gradient-to-r from-pink-500 via-fuchsia-600 to-indigo-600 text-white p-6 shadow-sm">
              <div className="flex items-center gap-4">
                <img
                  src={`https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(staff?.avatar || "staff")}`}
                  alt="Avatar"
                  className="w-14 h-14 rounded-full bg-white/20"
                />
                <div className="min-w-0 flex-1">
                  <h1 className="text-2xl font-bold truncate">{headerTitle}</h1>
                  {staff && (
                    <p className="text-sm text-white/80 mt-1 truncate">
                      {staff.role} {staff.branchName ? `• ${staff.branchName}` : ""}
                    </p>
                  )}
                </div>
                {staff?.status && (
                  <div
                    className={`shrink-0 inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-semibold ${
                      staff.status === "Active" ? "bg-emerald-100 text-emerald-800" : "bg-rose-100 text-rose-800"
                    }`}
                  >
                    <i className="fas fa-circle" />
                    {staff.status}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Tabs */}
          <div className="max-w-7xl mx-auto">
            <div className="rounded-2xl bg-white border border-slate-200 p-1 mb-6 shadow-sm flex flex-wrap">
              {[
                { key: "overview", label: "Overview", icon: "fa-id-badge" },
                { key: "training", label: "Training", icon: "fa-graduation-cap" },
                { key: "schedule", label: "Schedule", icon: "fa-calendar-days" },
                { key: "appointments", label: "Appointments", icon: "fa-calendar-check" },
                { key: "customers", label: "Customers", icon: "fa-users" },
              ].map((t: any) => (
                <button
                  key={t.key}
                  onClick={() => setActiveTab(t.key)}
                  className={`px-4 py-2.5 rounded-xl text-sm font-medium transition mr-1 mb-1 ${
                    activeTab === t.key ? "bg-slate-900 text-white shadow" : "text-slate-600 hover:bg-slate-100"
                  }`}
                >
                  <i className={`fas ${t.icon} mr-2`} />
                  {t.label}
                </button>
              ))}
            </div>

            {loading ? (
              <div className="text-slate-500">Loading staff…</div>
            ) : !staff ? (
              <div className="text-rose-600">Staff member not found.</div>
            ) : (
              <>
                {activeTab === "overview" && (
                  <div className="space-y-6">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      <div className="rounded-2xl border border-pink-100 shadow-sm overflow-hidden bg-gradient-to-br from-pink-50 to-rose-50">
                        <div className="px-6 py-4 bg-gradient-to-r from-pink-500 to-fuchsia-600 text-white flex items-center gap-2">
                          <div className="w-8 h-8 rounded-lg bg-white/20 flex items-center justify-center">
                            <i className="fas fa-address-card" />
                          </div>
                          <div className="text-sm font-semibold">Contact</div>
                        </div>
                        <div className="p-6 text-sm text-slate-700">
                          <div className="flex flex-wrap gap-2">
                            {staff.email && (
                              <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white border border-pink-100 truncate">
                                <i className="fas fa-envelope text-pink-600" /> {staff.email}
                              </div>
                            )}
                            {staff.branchName && (
                              <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white border border-pink-100">
                                <i className="fas fa-store text-pink-600" /> {staff.branchName}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>

                      <div className="rounded-2xl border border-indigo-100 shadow-sm overflow-hidden bg-white">
                        <div className="px-6 py-4 bg-gradient-to-r from-indigo-500 to-purple-600 text-white flex items-center gap-2">
                          <div className="w-8 h-8 rounded-lg bg-white/20 flex items-center justify-center">
                            <i className="fas fa-shield-heart" />
                          </div>
                          <div className="text-sm font-semibold">Role & Status</div>
                        </div>
                        <div className="p-6 text-sm text-slate-700">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="px-3 py-1.5 rounded-full bg-slate-100">{staff.role}</span>
                            <span
                              className={`px-3 py-1.5 rounded-full text-xs ${
                                staff.status === "Active" ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"
                              }`}
                            >
                              {staff.status}
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Weekly Schedule Overview */}
                    {staff.weeklySchedule && Object.keys(staff.weeklySchedule).length > 0 && (
                      <div className="rounded-2xl border border-slate-200 shadow-sm overflow-hidden bg-white">
                        <div className="px-6 py-4 bg-gradient-to-r from-emerald-500 to-teal-600 text-white flex items-center gap-2">
                          <div className="w-8 h-8 rounded-lg bg-white/20 flex items-center justify-center">
                            <i className="fas fa-calendar-week" />
                          </div>
                          <div className="text-sm font-semibold">Weekly Schedule</div>
                        </div>
                        <div className="p-6">
                          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-7 gap-3">
                            {[
                              { key: "Monday" as keyof WeeklySchedule, label: "Mon", icon: "☀️" },
                              { key: "Tuesday" as keyof WeeklySchedule, label: "Tue", icon: "🌤️" },
                              { key: "Wednesday" as keyof WeeklySchedule, label: "Wed", icon: "🌻" },
                              { key: "Thursday" as keyof WeeklySchedule, label: "Thu", icon: "🌸" },
                              { key: "Friday" as keyof WeeklySchedule, label: "Fri", icon: "🎉" },
                              { key: "Saturday" as keyof WeeklySchedule, label: "Sat", icon: "🎨" },
                              { key: "Sunday" as keyof WeeklySchedule, label: "Sun", icon: "🌙" },
                            ].map((day) => {
                              const assignment = staff.weeklySchedule?.[day.key];
                              const isWorking = assignment && assignment.branchId;
                              return (
                                <div
                                  key={day.key}
                                  className={`rounded-lg border-2 p-3 text-center transition ${
                                    isWorking
                                      ? "border-emerald-200 bg-emerald-50"
                                      : "border-slate-200 bg-slate-50"
                                  }`}
                                >
                                  <div className="text-xl mb-1">{day.icon}</div>
                                  <div className="text-xs font-bold text-slate-700 mb-1">
                                    {day.label}
                                  </div>
                                  {isWorking ? (
                                    <div className="text-[10px] text-emerald-700 font-medium truncate">
                                      {assignment.branchName}
                                    </div>
                                  ) : (
                                    <div className="text-[10px] text-slate-400">Off</div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {activeTab === "training" && (
                  <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6">
                    <div className="text-sm font-bold text-slate-700 mb-4">Training Matrix</div>
                    <div className="flex gap-3">
                      <span className={`px-3 py-1.5 rounded-full text-xs ${staff.training?.ohs ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-600"}`}>
                        OHS
                      </span>
                      <span className={`px-3 py-1.5 rounded-full text-xs ${staff.training?.prod ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-600"}`}>
                        Product
                      </span>
                      <span className={`px-3 py-1.5 rounded-full text-xs ${staff.training?.tool ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-600"}`}>
                        Tools
                      </span>
                    </div>
                  </div>
                )}

                {activeTab === "schedule" && (
                  <>
                    {!staff.weeklySchedule || Object.keys(staff.weeklySchedule).length === 0 ? (
                      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 text-sm text-slate-500">
                        No schedule assigned. Set up a weekly schedule for this staff member.
                      </div>
                    ) : (
                      <StaffScheduleTab
                        staff={staff}
                        staffBookings={staffBookings}
                        branchHours={branchHours}
                        monthYear={monthYear}
                        selectedDate={selectedDate}
                        setSelectedDate={setSelectedDate}
                        goPrevMonth={goPrevMonth}
                        goNextMonth={goNextMonth}
                        monthName={monthName}
                        getHoursForWeekday={getHoursForWeekday}
                      />
                    )}
                  </>
                )}

                {activeTab === "appointments" && (
                  <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6">
                    <div className="flex items-center justify-between mb-4">
                      <div className="text-sm font-bold text-slate-700 flex items-center gap-2">
                        <i className="fas fa-calendar-check text-pink-500" />
                        Appointments
                      </div>
                      <div className="text-xs text-slate-500">
                        {staffBookings.length} total bookings
                      </div>
                    </div>
                    
                    {staffBookings.length === 0 ? (
                      <div className="text-center py-8 text-slate-400">
                        <i className="fas fa-calendar-xmark text-4xl mb-3" />
                        <p className="text-sm">No appointments found for this staff member</p>
                      </div>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-left border-collapse">
                          <thead>
                            <tr className="bg-slate-50/80 border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500 font-semibold">
                              <th className="p-3">Date & Time</th>
                              <th className="p-3">Customer</th>
                              <th className="p-3">Service</th>
                              <th className="p-3">Price</th>
                              <th className="p-3">Status</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100 text-sm">
                            {staffBookings.slice(0, 20).map((b, idx) => {
                              const statusColors: Record<string, string> = {
                                Pending: "bg-amber-50 text-amber-700 border-amber-200",
                                Confirmed: "bg-blue-50 text-blue-700 border-blue-200",
                                Completed: "bg-emerald-50 text-emerald-700 border-emerald-200",
                                Cancelled: "bg-rose-50 text-rose-700 border-rose-200",
                              };
                              const statusColor = statusColors[b.status] || "bg-slate-50 text-slate-600 border-slate-200";
                              
                              return (
                                <tr key={b.id || idx} className="hover:bg-slate-50 transition-colors">
                                  <td className="p-3">
                                    <div className="font-medium text-slate-800">{b.date || "—"}</div>
                                    <div className="text-xs text-slate-500">{b.time || "—"}</div>
                                  </td>
                                  <td className="p-3">
                                    <div className="flex items-center gap-2">
                                      <div className="w-7 h-7 rounded-full bg-pink-100 text-pink-600 flex items-center justify-center text-xs font-semibold">
                                        {(b.client || "U").toString().slice(0, 1).toUpperCase()}
                                      </div>
                                      <span className="text-slate-700">{b.client || "Unknown"}</span>
                                    </div>
                                  </td>
                                  <td className="p-3 text-slate-600">{b.serviceName || "Service"}</td>
                                  <td className="p-3 font-semibold text-slate-700">${Number(b.price || 0).toFixed(0)}</td>
                                  <td className="p-3">
                                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${statusColor}`}>
                                      <span className="w-1.5 h-1.5 rounded-full bg-current" />
                                      {b.status || "Pending"}
                                    </span>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                        {staffBookings.length > 20 && (
                          <div className="text-center py-3 text-xs text-slate-500">
                            Showing 20 of {staffBookings.length} appointments
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {activeTab === "customers" && (
                  <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6">
                    <div className="flex items-center justify-between mb-4">
                      <div className="text-sm font-bold text-slate-700 flex items-center gap-2">
                        <i className="fas fa-users text-indigo-500" />
                        Customers Served
                      </div>
                    </div>
                    
                    {(() => {
                      // Build unique customers from bookings
                      const customerMap = new Map<string, { name: string; email?: string; phone?: string; visits: number; lastVisit: string; totalSpent: number }>();
                      
                      staffBookings.forEach((b) => {
                        const clientName = b.client || "Unknown";
                        const key = clientName.toLowerCase();
                        
                        if (customerMap.has(key)) {
                          const existing = customerMap.get(key)!;
                          existing.visits++;
                          existing.totalSpent += Number(b.price || 0);
                          if (b.date && b.date > existing.lastVisit) {
                            existing.lastVisit = b.date;
                          }
                        } else {
                          customerMap.set(key, {
                            name: clientName,
                            email: b.clientEmail,
                            phone: b.clientPhone,
                            visits: 1,
                            lastVisit: b.date || "",
                            totalSpent: Number(b.price || 0),
                          });
                        }
                      });
                      
                      const customers = Array.from(customerMap.values()).sort((a, b) => b.visits - a.visits);
                      
                      if (customers.length === 0) {
                        return (
                          <div className="text-center py-8 text-slate-400">
                            <i className="fas fa-user-slash text-4xl mb-3" />
                            <p className="text-sm">No customers served yet</p>
                          </div>
                        );
                      }
                      
                      return (
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                          {customers.slice(0, 12).map((c, idx) => (
                            <div key={idx} className="border border-slate-200 rounded-xl p-4 hover:shadow-md transition bg-white">
                              <div className="flex items-start gap-3">
                                <div className="w-10 h-10 rounded-full bg-gradient-to-br from-pink-100 to-purple-100 text-pink-600 flex items-center justify-center font-semibold">
                                  {c.name.slice(0, 1).toUpperCase()}
                                </div>
                                <div className="flex-1 min-w-0">
                                  <div className="font-semibold text-slate-800 truncate">{c.name}</div>
                                  <div className="flex items-center gap-2 text-xs text-slate-500 mt-1">
                                    <span className="px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-600 font-medium">
                                      {c.visits} visit{c.visits !== 1 ? "s" : ""}
                                    </span>
                                    <span className="px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-600 font-medium">
                                      ${c.totalSpent.toFixed(0)}
                                    </span>
                                  </div>
                                  {c.lastVisit && (
                                    <div className="text-xs text-slate-400 mt-2">
                                      Last: {c.lastVisit}
                                    </div>
                                  )}
                                </div>
                              </div>
                              {(c.email || c.phone) && (
                                <div className="mt-3 pt-3 border-t border-slate-100 text-xs text-slate-500 space-y-1">
                                  {c.email && (
                                    <div className="flex items-center gap-2 truncate">
                                      <i className="fas fa-envelope text-slate-400" />
                                      {c.email}
                                    </div>
                                  )}
                                  {c.phone && (
                                    <div className="flex items-center gap-2">
                                      <i className="fas fa-phone text-slate-400" />
                                      {c.phone}
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      );
                    })()}
                  </div>
                )}
              </>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}


