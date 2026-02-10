"use client";
import React, { useEffect, useMemo, useState } from "react";
import Sidebar from "@/components/Sidebar";
import { useParams, useRouter } from "next/navigation";
import { auth, db } from "@/lib/firebase";
import { onAuthStateChanged } from "firebase/auth";
import { collection, doc, getDoc, onSnapshot, query, where } from "firebase/firestore";
import { subscribeServicesForOwner } from "@/lib/services";
import { subscribeSalonStaffForOwner } from "@/lib/salonStaff";

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

type StaffByDay = {
  Monday?: string[];
  Tuesday?: string[];
  Wednesday?: string[];
  Thursday?: string[];
  Friday?: string[];
  Saturday?: string[];
  Sunday?: string[];
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

type Branch = {
  id: string;
  name: string;
  address: string;
  revenue?: number;
  phone?: string;
  email?: string;
  staffIds?: string[];
  staffByDay?: StaffByDay;
  serviceIds?: string[];
  hours?: string | HoursMap;
  capacity?: number;
  manager?: string;
  status?: "Active" | "Pending" | "Closed";
  adminStaffId?: string;
};

// Analytics Tab Component
function AnalyticsTab({ 
  branchBookings, 
  serviceCount, 
  allServices,
  branchId 
}: { 
  branchBookings: any[]; 
  serviceCount: number;
  allServices: Array<{ id: string; name: string; branches?: string[] }>;
  branchId: string;
}) {
  const [period, setPeriod] = useState<"daily" | "weekly" | "monthly">("weekly");

  // Calculate date ranges based on period
  const getDateRange = () => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    
    if (period === "daily") {
      return { start: today, end: today };
    } else if (period === "weekly") {
      const dayOfWeek = today.getDay();
      const monday = new Date(today);
      monday.setDate(today.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
      const sunday = new Date(monday);
      sunday.setDate(monday.getDate() + 6);
      return { start: monday, end: sunday };
    } else {
      // Monthly
      const firstDay = new Date(today.getFullYear(), today.getMonth(), 1);
      const lastDay = new Date(today.getFullYear(), today.getMonth() + 1, 0);
      return { start: firstDay, end: lastDay };
    }
  };

  const dateRange = getDateRange();

  // Filter bookings by period
  const filteredBookings = useMemo(() => {
    return branchBookings.filter((b) => {
      if (!b.date) return false;
      // Parse date string as local date to avoid timezone shifts
      const [year, month, day] = b.date.split('-').map(Number);
      const bookingDate = new Date(year, month - 1, day);
      return bookingDate >= dateRange.start && bookingDate <= dateRange.end;
    });
  }, [branchBookings, dateRange.start, dateRange.end]);

  // Calculate total revenue from filtered bookings (only completed bookings)
  const totalRevenue = useMemo(() => {
    return filteredBookings
      .filter(b => b.status === "Completed")
      .reduce((sum, b) => {
        const price = Number(b.price || b.totalPrice || 0);
        return sum + price;
      }, 0);
  }, [filteredBookings]);

  // Calculate completed bookings revenue
  const completedRevenue = useMemo(() => {
    return filteredBookings
      .filter(b => b.status === "Completed")
      .reduce((sum, b) => sum + Number(b.price || b.totalPrice || 0), 0);
  }, [filteredBookings]);

  // Count bookings by status
  const bookingsByStatus = useMemo(() => {
    const counts = { Pending: 0, Confirmed: 0, Completed: 0, Cancelled: 0 };
    filteredBookings.forEach((b) => {
      const status = b.status || "Pending";
      if (counts[status as keyof typeof counts] !== undefined) {
        counts[status as keyof typeof counts]++;
      }
    });
    return counts;
  }, [filteredBookings]);

  // Calculate appointments by day of week
  const appointmentsByDay = useMemo(() => {
    const days = { Mon: 0, Tue: 0, Wed: 0, Thu: 0, Fri: 0, Sat: 0, Sun: 0 };
    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    
    filteredBookings.forEach((b) => {
      if (!b.date) return;
      // Parse date string as local date to avoid timezone shifts
      const [year, month, day] = b.date.split('-').map(Number);
      const date = new Date(year, month - 1, day);
      const dayName = dayNames[date.getDay()] as keyof typeof days;
      days[dayName]++;
    });
    
    return days;
  }, [filteredBookings]);

  // Get max appointments for scaling
  const maxAppointments = Math.max(...Object.values(appointmentsByDay), 1);

  // Calculate top services from bookings
  const topServices = useMemo(() => {
    const serviceCounts: Record<string, { name: string; count: number; revenue: number }> = {};
    
    filteredBookings.forEach((b) => {
      // Handle multi-service bookings
      if (Array.isArray(b.services) && b.services.length > 0) {
        b.services.forEach((s: any) => {
          const serviceId = s.serviceId || s.id;
          const serviceName = s.serviceName || s.name || "Unknown Service";
          const servicePrice = Number(s.price || 0);
          
          if (!serviceCounts[serviceId]) {
            serviceCounts[serviceId] = { name: serviceName, count: 0, revenue: 0 };
          }
          serviceCounts[serviceId].count++;
          serviceCounts[serviceId].revenue += servicePrice;
        });
      } else {
        // Single service booking
        const serviceId = b.serviceId || "unknown";
        const serviceName = b.serviceName || "Unknown Service";
        const servicePrice = Number(b.price || 0);
        
        if (!serviceCounts[serviceId]) {
          serviceCounts[serviceId] = { name: serviceName, count: 0, revenue: 0 };
        }
        serviceCounts[serviceId].count++;
        serviceCounts[serviceId].revenue += servicePrice;
      }
    });
    
    // Sort by count and take top 5
    return Object.entries(serviceCounts)
      .map(([id, data]) => ({ id, ...data }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
  }, [filteredBookings]);

  const totalServiceBookings = topServices.reduce((sum, s) => sum + s.count, 0) || 1;

  const periodLabels = {
    daily: "Today",
    weekly: "This Week",
    monthly: "This Month"
  };

  const colors = ["bg-pink-500", "bg-purple-500", "bg-indigo-500", "bg-blue-500", "bg-emerald-500"];

  return (
    <div className="space-y-6">
      {/* Header with Period Selector */}
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-50 pb-4 mb-4">
          <div>
            <h3 className="font-bold text-lg text-slate-800">Branch Performance</h3>
            <p className="text-xs text-slate-500 mt-1">{periodLabels[period]} Analytics</p>
          </div>
          <div className="flex items-center gap-2 bg-slate-50 p-1 rounded-lg border border-slate-200">
            {(["daily", "weekly", "monthly"] as const).map((p) => (
              <button
                key={p}
                onClick={() => setPeriod(p)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition ${
                  period === p 
                    ? "bg-white shadow-sm text-slate-800" 
                    : "text-slate-500 hover:text-slate-800"
                }`}
              >
                {p.charAt(0).toUpperCase() + p.slice(1)}
              </button>
            ))}
          </div>
        </div>
        
        {/* Stats Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="bg-gradient-to-br from-emerald-50 to-green-50 p-5 rounded-xl border border-emerald-100">
            <div className="flex justify-between items-start">
              <div>
                <p className="text-xs text-emerald-600 font-medium">Total Revenue</p>
                <h4 className="text-2xl font-bold text-emerald-700 mt-1">${totalRevenue.toLocaleString()}</h4>
                <p className="text-xs text-emerald-500 mt-1">
                  ${completedRevenue.toLocaleString()} completed
                </p>
              </div>
              <div className="w-10 h-10 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center">
                <i className="fas fa-dollar-sign" />
              </div>
            </div>
          </div>
          
          <div className="bg-gradient-to-br from-blue-50 to-indigo-50 p-5 rounded-xl border border-blue-100">
            <div className="flex justify-between items-start">
              <div>
                <p className="text-xs text-blue-600 font-medium">Total Appointments</p>
                <h4 className="text-2xl font-bold text-blue-700 mt-1">{filteredBookings.length}</h4>
                <p className="text-xs text-blue-500 mt-1">
                  {bookingsByStatus.Completed} completed
                </p>
              </div>
              <div className="w-10 h-10 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center">
                <i className="fas fa-calendar-check" />
              </div>
            </div>
          </div>
          
          <div className="bg-gradient-to-br from-amber-50 to-yellow-50 p-5 rounded-xl border border-amber-100">
            <div className="flex justify-between items-start">
              <div>
                <p className="text-xs text-amber-600 font-medium">Pending</p>
                <h4 className="text-2xl font-bold text-amber-700 mt-1">{bookingsByStatus.Pending}</h4>
                <p className="text-xs text-amber-500 mt-1">
                  {bookingsByStatus.Confirmed} confirmed
                </p>
              </div>
              <div className="w-10 h-10 rounded-full bg-amber-100 text-amber-600 flex items-center justify-center">
                <i className="fas fa-clock" />
              </div>
            </div>
          </div>
          
          <div className="bg-gradient-to-br from-pink-50 to-rose-50 p-5 rounded-xl border border-pink-100">
            <div className="flex justify-between items-start">
              <div>
                <p className="text-xs text-pink-600 font-medium">Active Services</p>
                <h4 className="text-2xl font-bold text-pink-700 mt-1">{serviceCount}</h4>
                <p className="text-xs text-pink-500 mt-1">
                  At this branch
                </p>
              </div>
              <div className="w-10 h-10 rounded-full bg-pink-100 text-pink-600 flex items-center justify-center">
                <i className="fas fa-tags" />
              </div>
            </div>
          </div>
        </div>
      </div>
      
      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Appointments by Day Chart */}
        <div className="lg:col-span-2 bg-white rounded-2xl shadow-sm border border-slate-100 p-6">
          <h4 className="font-bold text-slate-800 mb-6">Appointments by Day ({periodLabels[period]})</h4>
          <div className="flex items-end gap-2 sm:gap-4 h-48 border-b border-slate-200 pb-2">
            {(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const).map((day, i) => {
              const count = appointmentsByDay[day];
              const heightPercent = maxAppointments > 0 ? (count / maxAppointments) * 100 : 0;
              const isHighest = count === maxAppointments && count > 0;
              
              return (
                <div key={day} className="flex-1 flex flex-col items-center gap-1">
                  <span className="text-xs font-semibold text-slate-600">{count}</span>
                  <div 
                    className={`w-full rounded-t transition-all duration-500 ${
                      isHighest 
                        ? "bg-pink-500 shadow-lg shadow-pink-200" 
                        : count > 0 
                          ? "bg-pink-300 hover:bg-pink-400" 
                          : "bg-slate-100"
                    }`} 
                    style={{ height: `${Math.max(heightPercent, 4)}%` }} 
                  />
                </div>
              );
            })}
          </div>
          <div className="flex justify-between text-xs text-slate-400 mt-2 px-1">
            <span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span><span>Sun</span>
          </div>
          
          {filteredBookings.length === 0 && (
            <div className="text-center py-8 text-slate-400">
              <i className="fas fa-chart-bar text-3xl mb-2" />
              <p className="text-sm">No appointments {periodLabels[period].toLowerCase()}</p>
            </div>
          )}
        </div>
        
        {/* Top Services */}
        <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6">
          <h4 className="font-bold text-slate-800 mb-4">Top Services</h4>
          {topServices.length === 0 ? (
            <div className="text-center py-8 text-slate-400">
              <i className="fas fa-tags text-3xl mb-2" />
              <p className="text-sm">No service data yet</p>
            </div>
          ) : (
            <div className="space-y-4">
              {topServices.map((service, idx) => {
                const percentage = Math.round((service.count / totalServiceBookings) * 100);
                return (
                  <div key={service.id}>
                    <div className="flex justify-between text-sm mb-1">
                      <span className="text-slate-600 truncate flex-1">{service.name}</span>
                      <span className="font-semibold text-slate-800 ml-2">{service.count} ({percentage}%)</span>
                    </div>
                    <div className="h-2 w-full bg-slate-100 rounded-full overflow-hidden">
                      <div 
                        className={`h-full ${colors[idx % colors.length]} transition-all duration-500`} 
                        style={{ width: `${percentage}%` }} 
                      />
                    </div>
                    <p className="text-xs text-slate-400 mt-1">${service.revenue.toLocaleString()} revenue</p>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
      
      {/* Booking Status Overview */}
      <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6">
        <h4 className="font-bold text-slate-800 mb-4">Booking Status Overview</h4>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div className="text-center p-4 rounded-xl bg-amber-50 border border-amber-100">
            <div className="text-3xl font-bold text-amber-600">{bookingsByStatus.Pending}</div>
            <div className="text-xs text-amber-500 mt-1 font-medium">Pending</div>
          </div>
          <div className="text-center p-4 rounded-xl bg-blue-50 border border-blue-100">
            <div className="text-3xl font-bold text-blue-600">{bookingsByStatus.Confirmed}</div>
            <div className="text-xs text-blue-500 mt-1 font-medium">Confirmed</div>
          </div>
          <div className="text-center p-4 rounded-xl bg-emerald-50 border border-emerald-100">
            <div className="text-3xl font-bold text-emerald-600">{bookingsByStatus.Completed}</div>
            <div className="text-xs text-emerald-500 mt-1 font-medium">Completed</div>
          </div>
          <div className="text-center p-4 rounded-xl bg-rose-50 border border-rose-100">
            <div className="text-3xl font-bold text-rose-600">{bookingsByStatus.Cancelled}</div>
            <div className="text-xs text-rose-500 mt-1 font-medium">Cancelled</div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Helper function to format date as YYYY-MM-DD in local time (avoids timezone shifts)
const formatLocalDate = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

// Schedule Tab Component
function ScheduleTab({
  branch,
  branchBookings,
  allStaff,
  monthYear,
  selectedDate,
  setSelectedDate,
  goPrevMonth,
  goNextMonth,
  monthName,
  getHoursForWeekday,
}: {
  branch: Branch;
  branchBookings: any[];
  allStaff: Array<{ id: string; name: string; status?: string; staffRole?: string; weeklySchedule?: WeeklySchedule }>;
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

  // Get bookings for the selected date
  const selectedDateStr = formatLocalDate(selectedDate);
  const dayBookings = branchBookings.filter((b) => b.date === selectedDateStr);
  
  // Sort by time
  const sortedBookings = [...dayBookings].sort((a, b) => {
    const aTime = a.time || "00:00";
    const bTime = b.time || "00:00";
    return aTime.localeCompare(bTime);
  });

  // Get staff working on selected day
  const selectedDayName = DAYS[selectedDate.getDay()];
  const workingStaff = allStaff.filter((st) => {
    const schedule = st.weeklySchedule || {};
    const daySchedule = schedule[selectedDayName as keyof typeof schedule];
    return daySchedule && daySchedule.branchId === branch.id;
  });

  // Get hours for selected day
  const selectedDayHours = getHoursForWeekday(selectedDate.getDay());
  const isClosed = selectedDayHours?.closed;
  const openTime = selectedDayHours?.open || "—";
  const closeTime = selectedDayHours?.close || "—";

  // Count bookings per day for the calendar
  const bookingsPerDay = useMemo(() => {
    const counts: Record<string, number> = {};
    branchBookings.forEach((b) => {
      if (b.date) {
        counts[b.date] = (counts[b.date] || 0) + 1;
      }
    });
    return counts;
  }, [branchBookings]);

  // Calculate total bookings for the displayed month
  const totalBookingsForMonth = useMemo(() => {
    const firstDay = new Date(monthYear.year, monthYear.month, 1);
    const lastDay = new Date(monthYear.year, monthYear.month + 1, 0);
    const firstDayStr = formatLocalDate(firstDay);
    const lastDayStr = formatLocalDate(lastDay);
    
    return branchBookings.filter((b) => {
      if (!b.date) return false;
      return b.date >= firstDayStr && b.date <= lastDayStr;
    }).length;
  }, [branchBookings, monthYear.year, monthYear.month]);

  // Build calendar cells
  const buildMonthCells = () => {
    const firstDayWeekIdx = new Date(monthYear.year, monthYear.month, 1).getDay();
    const numDays = new Date(monthYear.year, monthYear.month + 1, 0).getDate();
    const cells: Array<{ label?: number; date?: Date; dateStr?: string; closed?: boolean; bookingCount?: number }> = [];
    
    for (let i = 0; i < firstDayWeekIdx; i++) cells.push({});
    
    for (let d = 1; d <= numDays; d++) {
      const dt = new Date(monthYear.year, monthYear.month, d);
      const dateStr = formatLocalDate(dt);
      const h = getHoursForWeekday(dt.getDay());
      const closed = Boolean(h?.closed);
      const bookingCount = bookingsPerDay[dateStr] || 0;
      cells.push({ label: d, date: dt, dateStr, closed, bookingCount });
    }
    
    while (cells.length % 7 !== 0) cells.push({});
    return cells;
  };

  // Calculate daily stats (only completed bookings for revenue)
  const dayRevenue = sortedBookings
    .filter(b => b.status === "Completed")
    .reduce((sum, b) => sum + Number(b.price || b.totalPrice || 0), 0);
  const completedCount = sortedBookings.filter(b => b.status === "Completed").length;
  const pendingCount = sortedBookings.filter(b => b.status === "Pending").length;
  const confirmedCount = sortedBookings.filter(b => b.status === "Confirmed").length;

  const isToday = selectedDate.toDateString() === new Date().toDateString();

  return (
    <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
      {/* Calendar - Left Side */}
      <div className="lg:col-span-2 bg-white rounded-2xl border border-slate-200 shadow-sm p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <div className="text-sm font-bold text-slate-700">Branch Schedule</div>
            <p className="text-xs text-slate-500 mt-1">Click a date to view details</p>
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
            <span>Open</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-2 h-2 rounded-full bg-rose-400" />
            <span>Closed</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-4 h-4 rounded bg-pink-100 text-pink-600 text-[10px] flex items-center justify-center font-bold">{totalBookingsForMonth}</div>
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
                          {isTodayCell && <span className="ml-1 text-[9px] text-pink-500">Today</span>}
                        </span>
                        <span
                          className={`w-2 h-2 rounded-full ${c.closed ? "bg-rose-400" : "bg-emerald-400"}`}
                          title={c.closed ? "Closed" : "Open"}
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

      {/* Day Details - Right Side */}
      <div className="lg:col-span-3 space-y-4">
        {/* Date Header Card */}
        <div className={`rounded-2xl p-5 ${isClosed ? "bg-rose-50 border border-rose-200" : "bg-gradient-to-r from-pink-500 to-purple-600 text-white"}`}>
          <div className="flex items-center justify-between">
            <div>
              <div className={`text-lg font-bold ${isClosed ? "text-rose-700" : ""}`}>
                {selectedDate.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
                {isToday && <span className="ml-2 text-xs bg-white/20 px-2 py-0.5 rounded-full">Today</span>}
              </div>
              <div className={`text-sm mt-1 ${isClosed ? "text-rose-600" : "text-white/80"}`}>
                {isClosed ? (
                  <span className="flex items-center gap-2">
                    <i className="fas fa-door-closed" /> Branch Closed
                  </span>
                ) : (
                  <span className="flex items-center gap-2">
                    <i className="fas fa-clock" /> {openTime} - {closeTime}
                  </span>
                )}
              </div>
            </div>
            <div className={`text-right ${isClosed ? "text-rose-600" : ""}`}>
              <div className="text-2xl font-bold">{sortedBookings.length}</div>
              <div className={`text-xs ${isClosed ? "" : "text-white/80"}`}>Appointments</div>
            </div>
          </div>
        </div>

        {/* Quick Stats */}
        {!isClosed && (
          <div className="grid grid-cols-4 gap-3">
            <div className="bg-white rounded-xl border border-slate-200 p-3 text-center">
              <div className="text-xl font-bold text-emerald-600">${dayRevenue}</div>
              <div className="text-xs text-slate-500">Revenue</div>
            </div>
            <div className="bg-white rounded-xl border border-slate-200 p-3 text-center">
              <div className="text-xl font-bold text-amber-600">{pendingCount}</div>
              <div className="text-xs text-slate-500">Pending</div>
            </div>
            <div className="bg-white rounded-xl border border-slate-200 p-3 text-center">
              <div className="text-xl font-bold text-blue-600">{confirmedCount}</div>
              <div className="text-xs text-slate-500">Confirmed</div>
            </div>
            <div className="bg-white rounded-xl border border-slate-200 p-3 text-center">
              <div className="text-xl font-bold text-emerald-600">{completedCount}</div>
              <div className="text-xs text-slate-500">Completed</div>
            </div>
          </div>
        )}

        {/* Working Staff */}
        {!isClosed && (
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="text-sm font-bold text-slate-700 flex items-center gap-2">
                <i className="fas fa-users text-indigo-500" />
                Staff Working Today
              </div>
              <span className="text-xs text-slate-500">{workingStaff.length} staff</span>
            </div>
            {workingStaff.length === 0 ? (
              <div className="text-sm text-slate-400 py-2">No staff scheduled for this day</div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {workingStaff.map((st) => (
                  <div key={st.id} className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-indigo-50 border border-indigo-100">
                    <div className="w-6 h-6 rounded-full bg-indigo-200 text-indigo-700 text-xs flex items-center justify-center font-semibold">
                      {st.name.substring(0, 2).toUpperCase()}
                    </div>
                    <span className="text-sm font-medium text-indigo-700">{st.name}</span>
                    {st.staffRole && <span className="text-xs text-indigo-500">• {st.staffRole}</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Appointments List */}
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="text-sm font-bold text-slate-700 flex items-center gap-2">
              <i className="fas fa-calendar-check text-pink-500" />
              Appointments
            </div>
          </div>
          
          {isClosed ? (
            <div className="text-center py-8 text-slate-400">
              <i className="fas fa-door-closed text-3xl mb-2" />
              <p className="text-sm">Branch is closed on this day</p>
            </div>
          ) : sortedBookings.length === 0 ? (
            <div className="text-center py-8 text-slate-400">
              <i className="fas fa-calendar-xmark text-3xl mb-2" />
              <p className="text-sm">No appointments scheduled</p>
            </div>
          ) : (
            <div className="space-y-3 max-h-[400px] overflow-y-auto pr-1">
              {sortedBookings.map((b, idx) => {
                const statusColors: Record<string, string> = {
                  Pending: "bg-amber-50 border-amber-200 text-amber-700",
                  Confirmed: "bg-blue-50 border-blue-200 text-blue-700",
                  Completed: "bg-emerald-50 border-emerald-200 text-emerald-700",
                  Cancelled: "bg-rose-50 border-rose-200 text-rose-700",
                };
                const statusColor = statusColors[b.status] || "bg-slate-50 border-slate-200 text-slate-700";
                
                // Get staff name
                let staffName = "—";
                if (Array.isArray(b.services) && b.services.length > 0) {
                  const names = b.services
                    .map((s: any) => s.staffName)
                    .filter((n: string) => n && n !== "Any Available" && n !== "Any Staff");
                  if (names.length > 0) staffName = [...new Set(names)].join(", ");
                } else if (b.staffName && b.staffName !== "Any Available" && b.staffName !== "Any Staff") {
                  staffName = b.staffName;
                }

                return (
                  <div key={b.id || idx} className="border border-slate-200 rounded-xl p-4 hover:shadow-md transition bg-white">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex items-start gap-3">
                        {/* Time */}
                        <div className="text-center shrink-0">
                          <div className="text-lg font-bold text-slate-800">{b.time || "—"}</div>
                          <div className="text-xs text-slate-400">
                            {b.duration ? `${b.duration} min` : "—"}
                          </div>
                        </div>
                        
                        {/* Divider */}
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
                          <div className="flex items-center gap-3 text-xs text-slate-500 mt-2">
                            <span className="flex items-center gap-1">
                              <i className="fas fa-user" />
                              {staffName}
                            </span>
                            <span className="flex items-center gap-1 font-semibold text-slate-700">
                              <i className="fas fa-dollar-sign" />
                              {Number(b.price || 0).toFixed(0)}
                            </span>
                          </div>
                        </div>
                      </div>
                      
                      {/* Status Badge */}
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

export default function BranchDetailsPage() {
  const router = useRouter();
  const params = useParams() as { id?: string | string[] };
  const branchId = Array.isArray(params?.id) ? params.id[0] : params?.id;

  const [mobileOpen, setMobileOpen] = useState(false);
  const [ownerUid, setOwnerUid] = useState<string | null>(null);
  const [branch, setBranch] = useState<Branch | null>(null);
  const [loading, setLoading] = useState(true);
  const [userRole, setUserRole] = useState<string | null>(null);
  const [currentUserUid, setCurrentUserUid] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<
    "overview" | "analytics" | "appointments" | "services" | "staff" | "customers" | "schedule"
  >("overview");
  const [allServices, setAllServices] = useState<Array<{ id: string; name: string; icon?: string; price?: number; duration?: number; branches?: string[]; imageUrl?: string }>>([]);
  const [allStaff, setAllStaff] = useState<Array<{ id: string; name: string; status?: string; branch?: string; staffRole?: string; weeklySchedule?: WeeklySchedule }>>([]);
  const [branchBookings, setBranchBookings] = useState<Array<any>>([]);
  const [monthYear, setMonthYear] = useState<{ month: number; year: number }>(() => {
    const t = new Date();
    return { month: t.getMonth(), year: t.getFullYear() };
  });
  const [selectedDate, setSelectedDate] = useState<Date>(() => new Date());

  // auth + role guard
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        router.replace("/login");
        return;
      }
      try {
        const snap = await getDoc(doc(db, "users", user.uid));
        const role = (snap.data()?.role || "").toString();
        setUserRole(role);
        setCurrentUserUid(user.uid);
        
        if (role === "salon_owner") {
          setOwnerUid(user.uid);
        } else if (role === "salon_branch_admin") {
          setOwnerUid(snap.data()?.ownerUid || null);
        } else {
          router.replace("/dashboard");
          return;
        }
      } catch {
        router.replace("/login");
      }
    });
    return () => unsub();
  }, [router]);

  // subscribe to the specific branch
  useEffect(() => {
    if (!ownerUid || !branchId) return;
    setLoading(true);
    const unsub = onSnapshot(
      doc(db, "branches", branchId),
      (d) => {
        if (!d.exists()) {
          setBranch(null);
          setLoading(false);
          return;
        }
        const data = d.data() as any;
        
        // Check if branch admin is trying to access a branch they don't manage
        if (userRole === "salon_branch_admin" && currentUserUid) {
          const branchAdminId = data.adminStaffId;
          if (branchAdminId !== currentUserUid) {
            // Redirect to branches page if they try to access unauthorized branch
            router.push("/branches");
            return;
          }
        }
        
        const b: Branch = {
          id: d.id,
          name: String(data.name || ""),
          address: String(data.address || ""),
          revenue: Number(data.revenue || 0),
          phone: data.phone,
          email: data.email,
          hours: data.hours as any,
          capacity: data.capacity,
          manager: data.manager,
          status: (data.status as any) || "Active",
          staffIds: Array.isArray(data.staffIds) ? data.staffIds.map(String) : [],
          staffByDay: data.staffByDay as StaffByDay | undefined,
          serviceIds: Array.isArray(data.serviceIds) ? data.serviceIds.map(String) : [],
          adminStaffId: data.adminStaffId || undefined,
        };
        setBranch(b);
        setLoading(false);
      },
      (error) => {
        if (error.code === "permission-denied") {
          console.warn("Permission denied for branch query.");
          router.replace("/login");
        } else {
          console.error("Error in branch snapshot:", error);
          setLoading(false);
        }
      }
    );
    return () => unsub();
  }, [ownerUid, branchId, userRole, currentUserUid, router]);

  // subscribe to bookings for this branch
  useEffect(() => {
    if (!ownerUid || !branchId) return;
    const q = query(collection(db, "bookings"), where("ownerUid", "==", ownerUid), where("branchId", "==", branchId));
    const unsub = onSnapshot(
      q,
      (snap) => {
        const rows: any[] = [];
        snap.forEach((d) => {
          const b = d.data() as any;
          rows.push({ id: d.id, ...b });
        });
        // show most recent first by createdAt if exists
        rows.sort((a, b) => {
          const ams = a.createdAt?.toMillis ? a.createdAt.toMillis() : 0;
          const bms = b.createdAt?.toMillis ? b.createdAt.toMillis() : 0;
          return bms - ams;
        });
        setBranchBookings(rows);
      },
      (error) => {
        if (error.code === "permission-denied") {
          console.warn("Permission denied for branch bookings query.");
          setBranchBookings([]);
        } else {
          console.error("Error in branch bookings snapshot:", error);
          setBranchBookings([]);
        }
      }
    );
    return () => unsub();
  }, [ownerUid, branchId]);

  // subscribe to owner's services and staff to populate tabs (filtered by ids on render)
  useEffect(() => {
    if (!ownerUid) return;
    const unsubServices = subscribeServicesForOwner(ownerUid, (rows) => {
      setAllServices(
        rows.map((s: any) => ({
          id: String(s.id),
          name: String(s.name || "Service"),
          icon: String(s.icon || "fa-scissors"),
          price: typeof s.price === "number" ? s.price : undefined,
          duration: typeof s.duration === "number" ? s.duration : undefined,
          branches: Array.isArray(s.branches) ? s.branches.map(String) : undefined,
          imageUrl: s.imageUrl || undefined,
        }))
      );
    });
    const unsubStaff = subscribeSalonStaffForOwner(ownerUid, (rows) => {
      setAllStaff(
        rows.map((s: any) => ({
          id: String(s.id),
          name: String(s.name || s.displayName || "Staff"),
          status: s.status,
          branch: s.branchName,
          staffRole: s.staffRole || s.role || "Staff",
          weeklySchedule: s.weeklySchedule || {},
        }))
      );
    });
    return () => {
      unsubServices();
      unsubStaff();
    };
  }, [ownerUid]);

  const headerTitle = useMemo(() => (branch ? branch.name : "Branch"), [branch]);
  const monthName = useMemo(() => {
    return new Date(monthYear.year, monthYear.month, 1).toLocaleString(undefined, { month: "long", year: "numeric" });
  }, [monthYear]);

  const serviceCount = (branch?.serviceIds || []).length;
  
  // Count staff who work at this branch (based on weeklySchedule)
  const staffCount = useMemo(() => {
    if (!branch) return 0;
    return allStaff.filter((st) => {
      const schedule = st.weeklySchedule || {};
      return Object.values(schedule).some(
        (day) => day && day.branchId === branch.id
      );
    }).length;
  }, [allStaff, branch]);

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
    // JS: 0=Sun..6=Sat. Our map uses "Monday"... names
    const mapKey: (keyof HoursMap)[] = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const key = mapKey[weekdayIndex];
    return (branch?.hours as any)?.[key] as HoursDay | undefined;
  };

  const getSelectedDateText = () => {
    const w = selectedDate.toLocaleDateString(undefined, { weekday: "long" });
    const h = getHoursForWeekday(selectedDate.getDay());
    if (!h) return `${w}: —`;
    if (h.closed) return `${w}: Closed`;
    if (h.open && h.close) return `${w}: ${h.open} - ${h.close}`;
    return `${w}: —`;
  };

  const buildMonthCells = () => {
    const firstDayWeekIdx = new Date(monthYear.year, monthYear.month, 1).getDay(); // 0=Sun
    const numDays = new Date(monthYear.year, monthYear.month + 1, 0).getDate();
    const cells: Array<{ label?: number; date?: Date; closed?: boolean }> = [];
    for (let i = 0; i < firstDayWeekIdx; i++) cells.push({});
    for (let d = 1; d <= numDays; d++) {
      const dt = new Date(monthYear.year, monthYear.month, d);
      const h = getHoursForWeekday(dt.getDay());
      const closed = Boolean(h?.closed);
      cells.push({ label: d, date: dt, closed });
    }
    // fill to complete rows of 7
    while (cells.length % 7 !== 0) cells.push({});
    return cells;
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

          {/* Only show back button for salon owners */}
          {userRole === "salon_owner" && (
          <div className="mb-3">
            <button
              onClick={() => {
                try {
                  if (typeof window !== "undefined" && window.history.length > 1) router.back();
                  else router.push("/branches");
                } catch {
                  router.push("/branches");
                }
              }}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-slate-700 hover:bg-slate-50 shadow-sm"
            >
              <i className="fas fa-arrow-left" />
              Back to Branches
            </button>
          </div>
          )}

          <div className="mb-8">
            <div className="rounded-2xl bg-gradient-to-r from-pink-500 via-fuchsia-600 to-indigo-600 text-white p-6 shadow-sm">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-white/20 flex items-center justify-center">
                      <i className="fas fa-building" />
                    </div>
                    <h1 className="text-2xl font-bold truncate">{headerTitle}</h1>
                  </div>
                  {branch && <p className="text-sm text-white/80 mt-2 truncate">{branch.address}</p>}
                </div>
                {branch?.status && (
                  <div
                    className={`shrink-0 inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-semibold ${
                      branch.status === "Active"
                        ? "bg-emerald-100 text-emerald-800"
                        : branch.status === "Pending"
                        ? "bg-amber-100 text-amber-800"
                        : "bg-rose-100 text-rose-800"
                    }`}
                  >
                    <i className="fas fa-circle" />
                    {branch.status}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Stats */}
          {branch && (
            <div className="max-w-7xl mx-auto grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
              <div className="bg-white border border-slate-200 rounded-2xl p-4 shadow-sm">
                <div className="flex items-center justify-between">
                  <div className="text-xs text-slate-500">Services</div>
                  <div className="w-8 h-8 rounded-lg bg-pink-100 text-pink-600 flex items-center justify-center">
                    <i className="fas fa-scissors" />
                  </div>
                </div>
                <div className="mt-2 text-2xl font-bold text-slate-800">{(branch.serviceIds || []).length}</div>
              </div>
              <div className="bg-white border border-slate-200 rounded-2xl p-4 shadow-sm">
                <div className="flex items-center justify-between">
                  <div className="text-xs text-slate-500">Staff</div>
                  <div className="w-8 h-8 rounded-lg bg-indigo-100 text-indigo-600 flex items-center justify-center">
                    <i className="fas fa-users" />
                  </div>
                </div>
                <div className="mt-2 text-2xl font-bold text-slate-800">{staffCount}</div>
              </div>
              <div className="bg-white border border-slate-200 rounded-2xl p-4 shadow-sm">
                <div className="flex items-center justify-between">
                  <div className="text-xs text-slate-500">Capacity</div>
                  <div className="w-8 h-8 rounded-lg bg-emerald-100 text-emerald-600 flex items-center justify-center">
                    <i className="fas fa-chair" />
                  </div>
                </div>
                <div className="mt-2 text-2xl font-bold text-slate-800">{branch.capacity ?? "—"}</div>
              </div>
              <div className="bg-white border border-slate-200 rounded-2xl p-4 shadow-sm">
                <div className="flex items-center justify-between">
                  <div className="text-xs text-slate-500">Status</div>
                  <div className="w-8 h-8 rounded-lg bg-slate-100 text-slate-600 flex items-center justify-center">
                    <i className="fas fa-signal" />
                  </div>
                </div>
                <div className="mt-2 text-2xl font-bold text-slate-800">{branch.status || "—"}</div>
              </div>
            </div>
          )}

          {/* Tabs */}
          <div className="max-w-7xl mx-auto">
            <div className="rounded-2xl bg-white border border-slate-200 p-1 mb-6 shadow-sm flex flex-wrap">
              {[
                { key: "overview", label: "Overview", icon: "fa-compass" },
                { key: "analytics", label: "Branch Analytics", icon: "fa-chart-pie" },
                { key: "appointments", label: "Appointments", icon: "fa-calendar-check" },
                { key: "services", label: `Services (${serviceCount})`, icon: "fa-scissors" },
                { key: "staff", label: `Staff (${staffCount})`, icon: "fa-users" },
                { key: "customers", label: "Customers", icon: "fa-user-group" },
                { key: "schedule", label: "Schedule", icon: "fa-calendar-days" },
              ].map((t: any) => (
                <button
                  key={t.key}
                  onClick={() => setActiveTab(t.key)}
                  className={`px-4 py-2.5 rounded-xl text-sm font-medium transition mr-1 mb-1 ${activeTab === t.key ? "bg-slate-900 text-white shadow" : "text-slate-600 hover:bg-slate-100"}`}
                >
                  <i className={`fas ${t.icon} mr-2`} />
                  {t.label}
                </button>
              ))}
            </div>

            {loading ? (
              <div className="text-slate-500">Loading branch…</div>
            ) : !branch ? (
              <div className="text-rose-600">Branch not found.</div>
            ) : (
              <>
                {activeTab === "overview" && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    {/* Contact */}
                    <div className="rounded-2xl border border-pink-100 shadow-sm overflow-hidden bg-gradient-to-br from-pink-50 to-rose-50">
                      <div className="px-6 py-4 bg-gradient-to-r from-pink-500 to-fuchsia-600 text-white flex items-center gap-2">
                        <div className="w-8 h-8 rounded-lg bg-white/20 flex items-center justify-center">
                          <i className="fas fa-address-book" />
                        </div>
                        <div className="text-sm font-semibold">Contact</div>
                      </div>
                      <div className="p-6 text-sm text-slate-700">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                          {branch.phone && (
                            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white border border-pink-100">
                              <i className="fas fa-phone text-pink-600" /> {branch.phone}
                            </div>
                          )}
                          {branch.email && (
                            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white border border-pink-100 truncate">
                              <i className="fas fa-envelope text-pink-600" /> {branch.email}
                            </div>
                          )}
                          {branch.manager && (
                            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white border border-pink-100">
                              <i className="fas fa-user-tie text-pink-600" /> {branch.manager}
                            </div>
                          )}
                          {typeof branch.capacity !== "undefined" && branch.capacity !== null && (
                            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white border border-pink-100">
                              <i className="fas fa-chair text-pink-600" /> Capacity: {String(branch.capacity)}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Hours */}
                    <div className="rounded-2xl border border-indigo-100 shadow-sm overflow-hidden bg-white">
                      <div className="px-6 py-4 bg-gradient-to-r from-indigo-500 to-purple-600 text-white flex items-center gap-2">
                        <div className="w-8 h-8 rounded-lg bg-white/20 flex items-center justify-center">
                          <i className="fas fa-clock" />
                        </div>
                        <div className="text-sm font-semibold">Operating Hours</div>
                      </div>
                      <div className="max-h-80 overflow-y-auto">
                        {["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].map((day) => {
                          const d = day as keyof HoursMap;
                          const row = (branch.hours as any)?.[d] as HoursDay | undefined;
                          const text = row
                            ? row.closed
                              ? "Closed"
                              : row.open && row.close
                              ? `${row.open} - ${row.close}`
                              : "—"
                            : "—";
                          const isClosed = row?.closed;
                          return (
                            <div key={day} className="flex items-center justify-between px-4 py-2 text-sm border-b last:border-b-0 border-slate-200 bg-white">
                              <span className="text-slate-700">{day}</span>
                              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs ${isClosed ? "bg-rose-50 text-rose-700" : "bg-emerald-50 text-emerald-700"}`}>
                                <i className="fas fa-circle" />
                                {text}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                )}

                {activeTab === "overview" && (
                  <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 pb-2 mt-6">
                    {/* Upcoming Appointments */}
                    <div className="lg:col-span-2 bg-white rounded-2xl shadow-sm border border-slate-100 flex flex-col">
                      <div className="px-6 py-5 border-b border-slate-100 flex justify-between items-center">
                        <h3 className="font-bold text-slate-800 flex items-center gap-2">
                          <i className="fa-regular fa-calendar-check text-blue-500" /> Upcoming Appointments
                        </h3>
                        <button
                          onClick={() => setActiveTab("appointments")}
                          className="text-xs text-blue-600 hover:text-blue-700 font-medium"
                        >
                          View All
                        </button>
                      </div>
                      <div className="p-4 overflow-x-auto">
                        <table className="w-full text-sm text-left">
                          <thead className="text-xs text-slate-400 uppercase bg-slate-50/50">
                            <tr>
                              <th className="px-4 py-3 rounded-l-lg">Time</th>
                              <th className="px-4 py-3">Customer</th>
                              <th className="px-4 py-3">Service</th>
                              <th className="px-4 py-3">Staff</th>
                              <th className="px-4 py-3 rounded-r-lg">Status</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-50">
                            {[...branchBookings]
                              .filter((b) => {
                                const today = formatLocalDate(new Date());
                                return String(b.date || "") === today;
                              })
                              .sort((a, b) => {
                                const aD = new Date(`${a.date || ""}T${(a.time || "00:00")}:00`);
                                const bD = new Date(`${b.date || ""}T${(b.time || "00:00")}:00`);
                                return aD.getTime() - bD.getTime();
                              })
                              .slice(0, 3)
                              .map((b, i) => (
                                <tr key={b.id || i} className="hover:bg-slate-50 transition-colors">
                                  <td className="px-4 py-3 font-semibold text-slate-700">{b.time || "-"}</td>
                                  <td className="px-4 py-3">
                                    <div className="flex items-center gap-2">
                                      <div className="w-6 h-6 rounded-full bg-pink-100 text-pink-600 text-xs flex items-center justify-center">
                                        {(b.client || "U").toString().slice(0, 1).toUpperCase()}
                                      </div>
                                      <span className="text-slate-800 font-medium">{b.client || "Unknown"}</span>
                                    </div>
                                  </td>
                                  <td className="px-4 py-3 text-slate-500">{b.serviceName || String(b.serviceId || "")}</td>
                                  <td className="px-4 py-3 text-slate-500">
                                    {(() => {
                                      if (Array.isArray(b.services) && b.services.length > 0) {
                                        const staffNames = b.services
                                          .map((s: any) => s.staffName)
                                          .filter((name: string) => name && name !== "Any Available" && name !== "Any Staff");
                                        if (staffNames.length > 0) {
                                          const uniqueNames = [...new Set(staffNames)];
                                          return uniqueNames.join(", ");
                                        }
                                      }
                                      if (b.staffName && b.staffName !== "Any Available" && b.staffName !== "Any Staff") {
                                        return b.staffName;
                                      }
                                      return "—";
                                    })()}
                                  </td>
                                  <td className="px-4 py-3">
                                    <span
                                      className={`px-2 py-1 rounded-md text-xs font-medium ${
                                        b.status === "Confirmed"
                                          ? "bg-green-100 text-green-700"
                                          : b.status === "Pending"
                                          ? "bg-yellow-100 text-yellow-700"
                                          : b.status === "Completed"
                                          ? "bg-blue-100 text-blue-700"
                                          : "bg-slate-100 text-slate-600"
                                      }`}
                                    >
                                      {b.status || "-"}
                                    </span>
                                  </td>
                                </tr>
                              ))}
                            {branchBookings.filter((b) => String(b.date || "") === new Date().toISOString().slice(0,10)).length === 0 && (
                              <tr>
                                <td className="px-4 py-6 text-slate-400" colSpan={5}>
                                  No bookings today.
                                </td>
                              </tr>
                            )}
                          </tbody>
                        </table>
                      </div>
                    </div>

                    {/* New Customers */}
                    <div className="bg-white rounded-2xl shadow-sm border border-slate-100 flex flex-col">
                      <div className="px-6 py-5 border-b border-slate-100 flex justify-between items-center">
                        <h3 className="font-bold text-slate-800 flex items-center gap-2">
                          <i className="fa-solid fa-users text-orange-500" /> New Customers
                        </h3>
                        <button
                          onClick={() => setActiveTab("customers")}
                          className="text-xs text-orange-600 hover:text-orange-700 font-medium"
                        >
                          View All
                        </button>
                      </div>
                      <div className="p-4 space-y-4">
                        {Array.from(
                          new Map(
                            [...branchBookings]
                              .filter((b) => String(b.date || "") === formatLocalDate(new Date()))
                              .sort((a, b) => {
                                const ams = a.createdAt?.toMillis ? a.createdAt.toMillis() : 0;
                                const bms = b.createdAt?.toMillis ? b.createdAt.toMillis() : 0;
                                return bms - ams;
                              })
                              .map((b: any) => [String(b.client || ""), { name: b.client, meta: b.clientEmail || b.clientPhone }])
                          ).values()
                        )
                          .slice(0, 3)
                          .map((c: any, idx: number) => (
                            <div key={idx} className="flex items-center gap-3">
                              <div className="w-10 h-10 rounded-full bg-slate-100 border border-slate-200 flex items-center justify-center text-slate-600">
                                {(c.name || "U").toString().slice(0, 1).toUpperCase()}
                              </div>
                              <div className="flex-1">
                                <h4 className="text-sm font-semibold text-slate-800">{c.name || "Unknown"}</h4>
                                <p className="text-xs text-slate-500 truncate">{c.meta || ""}</p>
                              </div>
                              <button className="text-slate-400 hover:text-pink-500">
                                <i className="fa-solid fa-message" />
                              </button>
                            </div>
                          ))}
                        {branchBookings.filter((b) => String(b.date || "") === new Date().toISOString().slice(0,10)).length === 0 && (
                          <div className="text-sm text-slate-500">No customers today.</div>
                        )}
                        <button
                          onClick={() => setActiveTab("customers")}
                          className="w-full mt-2 py-2 text-xs font-medium text-slate-500 bg-slate-50 hover:bg-slate-100 rounded-lg transition-colors border border-dashed border-slate-200"
                        >
                          + Add New Customer manually
                        </button>
                      </div>
                    </div>
                  </div>
                )}
                {activeTab === "analytics" && (
                  <AnalyticsTab 
                    branchBookings={branchBookings} 
                    serviceCount={serviceCount}
                    allServices={allServices}
                    branchId={branch.id}
                  />
                )}

                {activeTab === "appointments" && (
                  <div className="space-y-4">
                    <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                      <div>
                        <h2 className="text-2xl font-bold text-slate-800">Booking Management</h2>
                        <p className="text-sm text-slate-500">Manage, track and schedule all branch appointments.</p>
                      </div>
                    </div>
                    <div className="bg-white rounded-xl shadow-sm border border-slate-100 overflow-hidden">
                      <div className="overflow-x-auto">
                        <table className="w-full text-left border-collapse">
                          <thead>
                            <tr className="bg-slate-50/80 border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500 font-semibold">
                              <th className="p-4">Customer</th>
                              <th className="p-4">Service</th>
                              <th className="p-4">Date & Time</th>
                              <th className="p-4">Staff</th>
                              <th className="p-4">Total</th>
                              <th className="p-4">Status</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100 text-sm">
                            {branchBookings.map((b) => (
                              <tr key={b.id} className="hover:bg-slate-50 transition-colors">
                                <td className="p-4">
                                  <div className="font-semibold text-slate-800">{b.client || "—"}</div>
                                  {b.clientPhone && <div className="text-xs text-slate-400">{b.clientPhone}</div>}
                                </td>
                                <td className="p-4">
                                  <div className="font-medium text-slate-700">{b.serviceName || String(b.serviceId)}</div>
                                  {b.duration && <div className="text-xs text-slate-400">⏱ {b.duration} mins</div>}
                                </td>
                                <td className="p-4">
                                  <div className="font-medium text-slate-700">{b.date}</div>
                                  <div className="text-xs text-slate-500">{b.time}</div>
                                </td>
                                <td className="p-4">
                                  {(() => {
                                    if (Array.isArray(b.services) && b.services.length > 0) {
                                      const staffNames = b.services
                                        .map((s: any) => s.staffName)
                                        .filter((name: string) => name && name !== "Any Available" && name !== "Any Staff");
                                      if (staffNames.length > 0) {
                                        const uniqueNames = [...new Set(staffNames)];
                                        return uniqueNames.join(", ");
                                      }
                                    }
                                    if (b.staffName && b.staffName !== "Any Available" && b.staffName !== "Any Staff") {
                                      return b.staffName;
                                    }
                                    return "—";
                                  })()}
                                </td>
                                <td className="p-4 font-semibold text-slate-700">${Number(b.price || 0).toFixed(0)}</td>
                                <td className="p-4">
                                  <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${
                                      b.status === "Confirmed"
                                        ? "bg-green-50 text-green-600 border border-green-100"
                                        : b.status === "Pending"
                                        ? "bg-yellow-50 text-yellow-600 border border-yellow-100"
                                        : b.status === "Completed"
                                        ? "bg-blue-50 text-blue-600 border border-blue-100"
                                        : "bg-slate-100 text-slate-600 border border-slate-200"
                                    }`}>
                                    <span className="w-1.5 h-1.5 rounded-full bg-current" />
                                    {b.status || "—"}
                                  </span>
                                </td>
                              </tr>
                            ))}
                            {branchBookings.length === 0 && (
                              <tr>
                                <td className="p-4 text-slate-400" colSpan={6}>No appointments found for this branch.</td>
                              </tr>
                            )}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>
                )}

                {activeTab === "services" && (
                  <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6">
                    <div className="text-sm font-bold text-slate-700 mb-4">Services available at this branch</div>
                    {(branch.serviceIds || []).length === 0 ? (
                      <div className="text-sm text-slate-400">No services assigned.</div>
                    ) : (
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
                        {allServices
                          .filter((s) => {
                            // Prefer canonical service.branches; fallback to legacy branch.serviceIds
                            if (Array.isArray(s.branches)) return s.branches.includes(branch.id);
                            return (branch.serviceIds || []).includes(s.id);
                          })
                          .map((s) => (
                            <div 
                              key={s.id} 
                              className="group bg-white rounded-2xl border border-slate-100 overflow-hidden hover:shadow-xl hover:border-pink-200 transition-all duration-300 hover:-translate-y-1"
                            >
                              {/* Service Image */}
                              <div className="relative h-40 bg-gradient-to-br from-pink-100 via-purple-50 to-indigo-100 overflow-hidden">
                                {s.imageUrl ? (
                                  <img 
                                    src={s.imageUrl} 
                                    alt={s.name}
                                    className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-500"
                                  />
                                ) : (
                                  <div className="absolute inset-0 flex items-center justify-center">
                                    <div className="w-16 h-16 rounded-2xl bg-white/60 backdrop-blur-sm flex items-center justify-center shadow-lg">
                                      <i className={`fas ${s.icon || "fa-scissors"} text-2xl text-pink-500`} />
                                </div>
                                  </div>
                                )}
                                {/* Price Badge */}
                                {typeof s.price === "number" && (
                                  <div className="absolute top-3 right-3 px-3 py-1.5 bg-gradient-to-r from-pink-500 to-purple-600 text-white text-sm font-bold rounded-full shadow-lg">
                                    ${s.price}
                                </div>
                                )}
                              </div>
                              
                              {/* Service Info */}
                              <div className="p-4">
                                <h3 className="font-bold text-slate-800 text-base mb-2 truncate group-hover:text-pink-600 transition-colors">
                                  {s.name}
                                </h3>
                                <div className="flex items-center gap-2 flex-wrap">
                                  {typeof s.duration === "number" && (
                                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-indigo-50 text-indigo-600 text-xs font-medium">
                                      <i className="fas fa-clock" />
                                      {s.duration} mins
                                    </span>
                                  )}
                                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-emerald-50 text-emerald-600 text-xs font-medium">
                                    <i className="fas fa-check-circle" />
                                    Available
                                  </span>
                                </div>
                              </div>
                            </div>
                          ))}
                      </div>
                    )}
                  </div>
                )}

                {activeTab === "staff" && (
                  <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6">
                    <div className="flex items-center justify-between mb-4">
                      <div className="text-sm font-bold text-slate-700">Staff assigned to this branch</div>
                      <div className="flex items-center gap-3 text-xs text-slate-500">
                        <div className="flex items-center gap-1">
                          <div className="w-2 h-2 rounded-full bg-emerald-500" />
                          <span>Working Day</span>
                        </div>
                        <div className="flex items-center gap-1">
                          <div className="w-2 h-2 rounded-full bg-slate-300" />
                          <span>Off Day</span>
                        </div>
                      </div>
                    </div>
                    {(() => {
                      // Get staff who work at this branch (check weeklySchedule for branchId match)
                      const branchStaff = allStaff.filter((st) => {
                        // Check if any day in their schedule is for this branch
                        const schedule = st.weeklySchedule || {};
                        return Object.values(schedule).some(
                          (day) => day && day.branchId === branch.id
                        );
                      });

                      if (branchStaff.length === 0) {
                        return <div className="text-sm text-slate-400">No staff assigned.</div>;
                      }

                      const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;
                      const SHORT_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

                      // Sort: admin first, then others
                      const sortedStaff = [...branchStaff].sort((a, b) => {
                        const aIsAdmin = a.id === branch.adminStaffId;
                        const bIsAdmin = b.id === branch.adminStaffId;
                        if (aIsAdmin && !bIsAdmin) return -1;
                        if (!aIsAdmin && bIsAdmin) return 1;
                        return 0;
                      });

                      return (
                        <div className="space-y-3">
                          {sortedStaff.map((st) => {
                            const schedule = st.weeklySchedule || {};
                            const isAdmin = st.id === branch.adminStaffId;
                            const statusColor =
                              st.status === "Active" ? "bg-emerald-100 text-emerald-700" : st.status === "Suspended" ? "bg-rose-100 text-rose-700" : "bg-slate-100 text-slate-600";
                            
                            // Get days this staff works at THIS branch
                            const workingDays = DAYS.filter(
                              (day) => schedule[day]?.branchId === branch.id
                            );

                            return (
                              <div 
                                key={st.id} 
                                className={`rounded-xl p-4 hover:shadow-md transition ${
                                  isAdmin 
                                    ? "bg-gradient-to-r from-violet-50 to-purple-50 border-2 border-violet-300 shadow-sm" 
                                    : "bg-white border border-slate-200"
                                }`}
                              >
                                {/* Admin badge */}
                                {isAdmin && (
                                  <div className="mb-3">
                                    <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-gradient-to-r from-violet-500 to-purple-600 text-white text-xs font-semibold">
                                      <i className="fas fa-crown" />
                                      Branch Admin
                                    </div>
                                  </div>
                                )}
                                <div className="flex flex-col sm:flex-row sm:items-center gap-4">
                                  {/* Staff info */}
                                  <div className="flex items-center gap-3 min-w-[200px]">
                                    <div className={`w-10 h-10 rounded-full flex items-center justify-center font-semibold text-sm ${
                                      isAdmin 
                                        ? "bg-gradient-to-br from-violet-500 to-purple-600 text-white" 
                                        : "bg-gradient-to-br from-pink-100 to-purple-100 text-pink-600"
                                    }`}>
                                      {st.name.substring(0, 2).toUpperCase()}
                                    </div>
                                    <div className="min-w-0 flex-1">
                                      <div className={`text-sm font-semibold truncate ${isAdmin ? "text-violet-700" : "text-slate-800"}`}>
                                        {st.name}
                                      </div>
                                      <div className="text-xs text-slate-500 truncate">{st.staffRole}</div>
                                    </div>
                                  </div>

                                  {/* Weekly schedule pills */}
                                  <div className="flex-1">
                                    <div className="flex flex-wrap gap-1.5">
                                      {DAYS.map((day, idx) => {
                                        const isWorking = schedule[day]?.branchId === branch.id;
                                        return (
                                          <div
                                            key={day}
                                            className={`px-2 py-1 rounded-md text-xs font-medium transition ${
                                              isWorking
                                                ? "bg-emerald-100 text-emerald-700 border border-emerald-200"
                                                : "bg-slate-50 text-slate-400 border border-slate-100"
                                            }`}
                                            title={isWorking ? `Works here on ${day}` : `Off on ${day}`}
                                          >
                                            {SHORT_DAYS[idx]}
                                          </div>
                                        );
                                      })}
                                    </div>
                                  </div>

                                  {/* Status badge */}
                                  <div className="flex items-center gap-2">
                                    <span className="text-xs text-slate-500">
                                      {workingDays.length} day{workingDays.length !== 1 ? "s" : ""}/week
                                    </span>
                                    {st.status && (
                                      <div className={`inline-flex text-xs px-2 py-0.5 rounded-full ${statusColor}`}>
                                        {st.status}
                                      </div>
                                    )}
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      );
                    })()}
                  </div>
                )}

                {activeTab === "customers" && (
                  <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6">
                    <div className="px-0 pb-4 flex justify-between items-center border-b border-slate-100 mb-4">
                      <h3 className="font-bold text-slate-800">Recent Customers</h3>
                    </div>
                    <div className="space-y-3">
                      {Array.from(
                        new Map(
                          branchBookings.map((b: any) => [String(b.client || ""), { name: b.client, email: b.clientEmail, phone: b.clientPhone }])
                        ).values()
                      ).map((c: any, idx) => (
                        <div key={idx} className="flex items-center gap-3 p-3 rounded-xl border border-slate-100 hover:bg-slate-50 transition">
                          <div className="w-10 h-10 rounded-full bg-pink-100 text-pink-600 flex items-center justify-center font-bold text-sm">
                            {(c.name || "U").toString().slice(0, 1).toUpperCase()}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-semibold text-slate-800 truncate">{c.name || "Unknown"}</div>
                            <div className="flex flex-wrap items-center gap-3 mt-1">
                              {c.email && (
                                <span className="inline-flex items-center gap-1.5 text-xs text-slate-500">
                                  <i className="fas fa-envelope text-slate-400"></i>
                                  <span className="truncate">{c.email}</span>
                                </span>
                              )}
                              {c.phone && (
                                <span className="inline-flex items-center gap-1.5 text-xs text-slate-500">
                                  <i className="fas fa-phone text-slate-400"></i>
                                  <span>{c.phone}</span>
                                </span>
                              )}
                              {!c.email && !c.phone && (
                                <span className="text-xs text-slate-400">No contact info</span>
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
                      {branchBookings.length === 0 && <div className="text-sm text-slate-500">No recent customers.</div>}
                    </div>
                  </div>
                )}

                {activeTab === "schedule" && (
                  <ScheduleTab
                    branch={branch}
                    branchBookings={branchBookings}
                    allStaff={allStaff}
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
          </div>
        </main>
      </div>
    </div>
  );
}


