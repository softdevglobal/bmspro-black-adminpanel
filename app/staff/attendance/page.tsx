"use client";
import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import Sidebar from "@/components/Sidebar";
import { useRouter } from "next/navigation";
import { auth, db } from "@/lib/firebase";
import { onAuthStateChanged } from "firebase/auth";
import { doc, getDoc, Timestamp } from "firebase/firestore";
import { subscribeBranchesForOwner, BranchLocation } from "@/lib/branches";
import { subscribeToCheckInsForOwner, StaffCheckInRecord } from "@/lib/staffCheckIn";
import { formatDistance } from "@/lib/geolocation";
import dynamic from "next/dynamic";

// Helper to get date string in YYYY-MM-DD format (stable for dependency comparison)
const getDateString = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

// Helper to parse date string back to Date
const parseDateString = (dateStr: string): Date => {
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(year, month - 1, day);
};

// Dynamically import map component to avoid SSR issues
const CheckInsMapView = dynamic(
  () => import("@/components/staff/CheckInsMapView"),
  { 
    ssr: false, 
    loading: () => (
      <div className="w-full h-full flex items-center justify-center bg-slate-100">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-4 border-pink-500 border-t-transparent rounded-full animate-spin" />
          <span className="text-sm text-slate-500">Loading map...</span>
        </div>
      </div>
    )
  }
);

interface Branch {
  id: string;
  name: string;
  location?: BranchLocation;
  allowedCheckInRadius?: number;
}

export default function AttendancePage() {
  const router = useRouter();
  const [ownerUid, setOwnerUid] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Use date string for stable dependency comparison (prevents unnecessary re-subscriptions)
  const [selectedDateStr, setSelectedDateStr] = useState(() => getDateString(new Date()));
  const [selectedBranchId, setSelectedBranchId] = useState<string>("all");
  const [checkIns, setCheckIns] = useState<StaffCheckInRecord[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [selectedCheckIn, setSelectedCheckIn] = useState<StaffCheckInRecord | null>(null);
  const [activeView, setActiveView] = useState<"dashboard" | "timesheets">("dashboard");
  const [mobileOpen, setMobileOpen] = useState(false);
  
  // Track if component is mounted to prevent state updates after unmount
  const isMountedRef = useRef(true);
  
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);
  
  // Memoized selectedDate object derived from the date string
  const selectedDate = useMemo(() => parseDateString(selectedDateStr), [selectedDateStr]);

  // Auth check
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        router.push("/login");
        return;
      }
      
      // Get owner UID
      const staffDoc = await getDoc(doc(db, "salon_staff", user.uid));
      if (staffDoc.exists()) {
        const data = staffDoc.data();
        setOwnerUid(data.ownerUid || user.uid);
      } else {
        setOwnerUid(user.uid);
      }
      setLoading(false);
    });
    return () => unsub();
  }, [router]);

  // Subscribe to branches
  useEffect(() => {
    if (!ownerUid) return;
    
    const unsub = subscribeBranchesForOwner(ownerUid, (branchList) => {
      setBranches(branchList.map(b => ({
        id: b.id,
        name: b.name,
        location: b.location,
        allowedCheckInRadius: b.allowedCheckInRadius
      })));
    });
    
    return () => unsub();
  }, [ownerUid]);

  // Subscribe to check-ins for selected date
  // Using selectedDateStr (string) as dependency for stable comparison
  useEffect(() => {
    if (!ownerUid) return;
    
    // Parse date from string for the subscription
    const dateForQuery = parseDateString(selectedDateStr);
    
    console.log("[AttendancePage] Subscribing to check-ins for:", selectedDateStr, "ownerUid:", ownerUid);
    
    const unsub = subscribeToCheckInsForOwner(ownerUid, dateForQuery, (records) => {
      // Only update state if component is still mounted
      if (isMountedRef.current) {
        console.log("[AttendancePage] Received check-ins:", records.length);
        setCheckIns(records);
      }
    });
    
    return () => {
      console.log("[AttendancePage] Cleaning up check-ins subscription");
      unsub();
    };
  }, [ownerUid, selectedDateStr]);

  // Computed values
  const activeCheckIns = checkIns.filter(c => c.status === "checked_in");
  const completedCheckIns = checkIns.filter(c => c.status === "checked_out" || c.status === "auto_checked_out");
  const outsideRadiusCheckIns = checkIns.filter(c => !c.isWithinRadius);

  // Filter check-ins by selected branch
  const filteredCheckIns = selectedBranchId === "all" 
    ? checkIns 
    : checkIns.filter(c => c.branchId === selectedBranchId);

  // Date navigation
  const goToPreviousDay = useCallback(() => {
    const currentDate = parseDateString(selectedDateStr);
    currentDate.setDate(currentDate.getDate() - 1);
    setSelectedDateStr(getDateString(currentDate));
  }, [selectedDateStr]);

  const goToNextDay = useCallback(() => {
    const currentDate = parseDateString(selectedDateStr);
    currentDate.setDate(currentDate.getDate() + 1);
    setSelectedDateStr(getDateString(currentDate));
  }, [selectedDateStr]);

  const goToToday = useCallback(() => {
    setSelectedDateStr(getDateString(new Date()));
  }, []);

  const formatDate = (date: Date) => {
    return date.toLocaleDateString("en-AU", { 
      weekday: "long", 
      day: "numeric", 
      month: "long", 
      year: "numeric" 
    });
  };

  const toDate = (value: Date | Timestamp): Date => {
    return value instanceof Timestamp ? value.toDate() : value;
  };

  const formatTime = (date: Date | Timestamp) => {
    return toDate(date).toLocaleTimeString("en-AU", { 
      hour: "2-digit", 
      minute: "2-digit",
      hour12: true 
    });
  };

  const calculateDuration = (checkIn: Date | Timestamp, checkOut?: Date | Timestamp | null, breakPeriods?: any[]) => {
    const start = toDate(checkIn);
    const end = checkOut ? toDate(checkOut) : new Date();
    const totalDiff = end.getTime() - start.getTime();
    
    // Calculate total break time
    let totalBreakMs = 0;
    if (breakPeriods && Array.isArray(breakPeriods)) {
      for (const breakPeriod of breakPeriods) {
        if (breakPeriod.startTime && breakPeriod.endTime) {
          const breakStart = toDate(breakPeriod.startTime);
          const breakEnd = toDate(breakPeriod.endTime);
          totalBreakMs += breakEnd.getTime() - breakStart.getTime();
        } else if (breakPeriod.startTime && !breakPeriod.endTime) {
          // Active break - calculate from start to now
          const breakStart = toDate(breakPeriod.startTime);
          totalBreakMs += end.getTime() - breakStart.getTime();
        }
      }
    }
    
    // Subtract break time from total time
    const workingMs = totalDiff - totalBreakMs;
    const hours = Math.floor(workingMs / (1000 * 60 * 60));
    const minutes = Math.floor((workingMs % (1000 * 60 * 60)) / (1000 * 60));
    return `${hours > 0 ? hours : 0}h ${minutes > 0 ? minutes : 0}m`;
  };

  return (
    <div className="flex h-screen overflow-hidden bg-slate-50 font-inter text-slate-800">
      <Sidebar />

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <main className="flex-1 overflow-auto">
          
          {/* Mobile Toggle */}
          <div className="md:hidden p-4 bg-white border-b border-slate-200 flex items-center justify-between shrink-0">
            <h2 className="font-bold text-lg text-slate-800">Attendance</h2>
            <button
              className="inline-flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-slate-700 shadow-sm hover:bg-slate-50"
              onClick={() => setMobileOpen(true)}
            >
              <i className="fas fa-bars" />
            </button>
          </div>

          {mobileOpen && (
            <div className="fixed inset-0 z-50 md:hidden">
              <div
                className="absolute inset-0 bg-black/40"
                onClick={() => setMobileOpen(false)}
              />
              <div className="absolute left-0 top-0 bottom-0">
                <Sidebar mobile onClose={() => setMobileOpen(false)} />
              </div>
            </div>
          )}

          {/* Page Content */}
          <div className="p-4 sm:p-6 lg:p-8">
            
            {/* Header Card */}
            <div className="mb-6">
              <div className="rounded-2xl bg-gradient-to-r from-pink-500 via-fuchsia-600 to-indigo-600 text-white p-6 shadow-sm">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-white/20 flex items-center justify-center">
                    <i className="fas fa-calendar-check" />
                  </div>
                  <div>
                    <h1 className="text-2xl font-bold">Staff Attendance</h1>
                    <p className="text-sm text-white/80 mt-1">Monitor staff attendance with real-time geofencing</p>
                  </div>
                </div>
              </div>
            </div>

            {/* Loading State */}
            {loading && (
              <div className="flex items-center justify-center py-20">
                <div className="flex flex-col items-center gap-4">
                  <div className="w-12 h-12 border-4 border-pink-500 border-t-transparent rounded-full animate-spin" />
                  <span className="text-slate-600">Loading attendance data...</span>
                </div>
              </div>
            )}

            {/* Main Content - only show after loading */}
            {!loading && (
            <>
            {/* Stats Cards */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
              <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-blue-100 flex items-center justify-center">
                    <i className="fas fa-clock text-blue-600" />
                  </div>
                  <div>
                    <div className="text-2xl font-bold text-slate-800">{activeCheckIns.length}</div>
                    <div className="text-xs text-slate-500">Currently Active</div>
                  </div>
                </div>
              </div>
              
              <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-green-100 flex items-center justify-center">
                    <i className="fas fa-check-circle text-green-600" />
                  </div>
                  <div>
                    <div className="text-2xl font-bold text-slate-800">{completedCheckIns.length}</div>
                    <div className="text-xs text-slate-500">Completed Today</div>
                  </div>
                </div>
              </div>
              
              <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-purple-100 flex items-center justify-center">
                    <i className="fas fa-users text-purple-600" />
                  </div>
                  <div>
                    <div className="text-2xl font-bold text-slate-800">{checkIns.length}</div>
                    <div className="text-xs text-slate-500">Total Check-ins</div>
                  </div>
                </div>
              </div>
              
              <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center">
                    <i className="fas fa-exclamation-triangle text-red-600" />
                  </div>
                  <div>
                    <div className="text-2xl font-bold text-slate-800">{outsideRadiusCheckIns.length}</div>
                    <div className="text-xs text-slate-500">Outside Radius</div>
                  </div>
                </div>
              </div>
            </div>

            {/* Date Navigation & Filters */}
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
              <div className="flex items-center gap-2">
                <button
                  onClick={goToPreviousDay}
                  className="p-2 rounded-lg border border-slate-200 hover:bg-slate-50 text-slate-600"
                >
                  <i className="fas fa-chevron-left" />
                </button>
                <div className="px-4 py-2 bg-white rounded-lg border border-slate-200 font-medium text-slate-700 min-w-[200px] text-center">
                  {formatDate(selectedDate)}
                </div>
                <button
                  onClick={goToNextDay}
                  className="p-2 rounded-lg border border-slate-200 hover:bg-slate-50 text-slate-600"
                >
                  <i className="fas fa-chevron-right" />
                </button>
                <button
                  onClick={goToToday}
                  className="px-3 py-2 rounded-lg bg-pink-50 text-pink-600 font-medium hover:bg-pink-100 text-sm"
                >
                  Today
                </button>
              </div>

              <div className="flex items-center gap-3">
                {/* Branch Filter */}
                <select
                  value={selectedBranchId}
                  onChange={(e) => setSelectedBranchId(e.target.value)}
                  className="px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm focus:ring-pink-500 outline-none"
                >
                  <option value="all">All Branches</option>
                  {branches.map(branch => (
                    <option key={branch.id} value={branch.id}>{branch.name}</option>
                  ))}
                </select>

                {/* View Toggle */}
                <div className="bg-white border border-slate-200 p-1 rounded-lg flex">
                  <button 
                    onClick={() => setActiveView('dashboard')}
                    className={`px-3 py-1.5 text-sm font-medium rounded-md transition flex items-center gap-2 ${activeView === 'dashboard' ? 'bg-pink-50 text-pink-600' : 'text-slate-500 hover:text-slate-700'}`}
                  >
                    <i className="fas fa-map" /> Map
                  </button>
                  <button 
                    onClick={() => setActiveView('timesheets')}
                    className={`px-3 py-1.5 text-sm font-medium rounded-md transition flex items-center gap-2 ${activeView === 'timesheets' ? 'bg-pink-50 text-pink-600' : 'text-slate-500 hover:text-slate-700'}`}
                  >
                    <i className="fas fa-list" /> List
                  </button>
                </div>
              </div>
            </div>

            {/* Main Content Area */}
            <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm">
              
              {/* Map View */}
              {activeView === 'dashboard' && (
                <div className="flex flex-col lg:flex-row" style={{ height: 'calc(100vh - 280px)', minHeight: '500px' }}>
                  {/* Staff List Sidebar */}
                  <div className="w-full lg:w-80 border-b lg:border-b-0 lg:border-r border-slate-200 bg-white flex flex-col lg:h-full">
                    <div className="p-4 bg-slate-50 border-b border-slate-200 font-semibold text-xs text-slate-500 uppercase flex items-center justify-between shrink-0">
                      <span>Check-ins ({filteredCheckIns.length})</span>
                      <span className="flex items-center gap-2 text-green-600">
                        <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                        {activeCheckIns.length} Active
                      </span>
                    </div>
                    <div className="overflow-y-auto flex-1 lg:h-0">
                      {filteredCheckIns.length === 0 ? (
                        <div className="p-8 text-center text-slate-400">
                          <i className="fas fa-map-marker-alt text-3xl mb-3 opacity-50" />
                          <p>No check-ins for this date</p>
                        </div>
                      ) : (
                        filteredCheckIns.map((checkIn) => (
                          <div 
                            key={checkIn.id}
                            onClick={() => setSelectedCheckIn(checkIn)}
                            className={`p-4 border-b border-slate-100 cursor-pointer transition ${
                              selectedCheckIn?.id === checkIn.id 
                                ? 'bg-pink-50 border-l-4 border-l-pink-500' 
                                : !checkIn.isWithinRadius 
                                  ? 'bg-red-50/50 hover:bg-red-50 border-l-4 border-l-red-400' 
                                  : 'hover:bg-slate-50'
                            }`}
                          >
                            <div className="flex justify-between items-start mb-2">
                              <div className="flex items-center gap-3">
                                <div className={`w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm ${
                                  checkIn.status === 'checked_in' 
                                    ? 'bg-green-100 text-green-700' 
                                    : 'bg-slate-100 text-slate-600'
                                }`}>
                                  {checkIn.staffName.split(' ').map(n => n[0]).join('')}
                                </div>
                                <div>
                                  <h4 className="font-semibold text-slate-800">{checkIn.staffName}</h4>
                                  <p className="text-xs text-slate-500">{checkIn.branchName}</p>
                                </div>
                              </div>
                              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                                checkIn.status === 'checked_in'
                                  ? 'bg-green-100 text-green-700'
                                  : 'bg-slate-100 text-slate-600'
                              }`}>
                                {checkIn.status === 'checked_in' ? 'ACTIVE' : 'DONE'}
                              </span>
                            </div>
                            
                            <div className="flex items-center gap-4 text-xs text-slate-500">
                              <span className="flex items-center gap-1">
                                <i className="fas fa-sign-in-alt" />
                                {formatTime(checkIn.checkInTime)}
                              </span>
                              {checkIn.checkOutTime && (
                                <span className="flex items-center gap-1">
                                  <i className="fas fa-sign-out-alt" />
                                  {formatTime(checkIn.checkOutTime)}
                                </span>
                              )}
                            </div>
                            
                            {!checkIn.isWithinRadius && (
                              <div className="mt-2 text-xs text-red-600 font-medium flex items-center gap-1">
                                <i className="fas fa-exclamation-triangle" />
                                {formatDistance(checkIn.distanceFromBranch)} away from branch
                              </div>
                            )}
                          </div>
                        ))
                      )}
                    </div>
                  </div>

                  {/* Map Area */}
                  <div className="flex-1 relative w-full h-full lg:h-auto">
                    <CheckInsMapView
                      checkIns={filteredCheckIns}
                      branches={branches}
                      selectedBranchId={selectedBranchId === "all" ? null : selectedBranchId}
                      onSelectCheckIn={setSelectedCheckIn}
                    />
                  </div>
                </div>
              )}

              {/* List View */}
              {activeView === 'timesheets' && (
                <div className="flex flex-col">
                  {filteredCheckIns.length === 0 ? (
                    <div className="p-12 text-center text-slate-400">
                      <i className="fas fa-clipboard-list text-4xl mb-4 opacity-50" />
                      <p className="text-lg font-medium">No check-ins for this date</p>
                      <p className="text-sm">Staff check-in records will appear here</p>
                    </div>
                  ) : (
                    <div className="p-6 space-y-4 bg-slate-50">
                      {filteredCheckIns.map((checkIn) => {
                        const breakPeriods = (checkIn as any).breakPeriods || [];
                        const duration = calculateDuration(
                          checkIn.checkInTime, 
                          checkIn.checkOutTime,
                          breakPeriods
                        );
                        return (
                        <div 
                          key={checkIn.id} 
                          className={`bg-white rounded-xl shadow-sm border overflow-hidden ${
                            !checkIn.isWithinRadius ? 'border-red-200' : 'border-slate-200'
                          }`}
                        >
                          {/* Card Header */}
                          <div className={`px-6 py-4 border-b flex justify-between items-center ${
                            !checkIn.isWithinRadius ? 'bg-red-50 border-red-100' : 'bg-slate-50 border-slate-100'
                          }`}>
                            <div className="flex items-center gap-3">
                              <div className={`w-10 h-10 rounded-full flex items-center justify-center font-bold ${
                                checkIn.status === 'checked_in'
                                  ? 'bg-green-100 text-green-700 border border-green-200'
                                  : 'bg-slate-200 text-slate-600'
                              }`}>
                                {checkIn.staffName.split(' ').map(n => n[0]).join('')}
                              </div>
                              <div>
                                <h3 className="font-bold text-slate-800">{checkIn.staffName}</h3>
                                <div className="text-xs text-slate-500">
                                  {checkIn.branchName} • {checkIn.staffRole || 'Staff'}
                                </div>
                              </div>
                            </div>
                            <div className="flex items-center gap-2">
                              {!checkIn.isWithinRadius && (
                                <span className="bg-red-100 text-red-700 text-xs font-bold px-2 py-1 rounded flex items-center gap-1">
                                  <i className="fas fa-exclamation-triangle" /> Location Alert
                                </span>
                              )}
                              <span className={`text-xs font-bold px-2 py-1 rounded ${
                                checkIn.status === 'checked_in'
                                  ? 'bg-green-500 text-white'
                                  : 'bg-slate-200 text-slate-600'
                              }`}>
                                {checkIn.status === 'checked_in' ? 'Currently Working' : 'Shift Complete'}
                              </span>
                            </div>
                          </div>

                          {/* Card Body */}
                          <div className="p-6">
                            {/* Time Bar */}
                            <div className="flex items-center mb-6">
                              <div className="w-16 text-xs font-bold text-slate-400 uppercase tracking-wider">Shift</div>
                              <div className="flex-1 h-8 bg-slate-100 rounded relative overflow-hidden flex items-center">
                                <div 
                                  className={`absolute h-full ${checkIn.status === 'checked_in' ? 'bg-green-500' : 'bg-pink-500'}`} 
                                  style={{ left: '0%', width: '100%' }}
                                />
                              </div>
                              <div className="w-20 text-right text-sm font-bold text-slate-800 ml-4">
                                {(() => {
                                  const breakPeriods = (checkIn as any).breakPeriods || [];
                                  return calculateDuration(checkIn.checkInTime, checkIn.checkOutTime, breakPeriods);
                                })()}
                              </div>
                            </div>

                            {/* Details Grid */}
                            <div className={`rounded-lg border p-4 ${
                              !checkIn.isWithinRadius ? 'bg-red-50 border-red-200' : 'bg-slate-50 border-slate-200'
                            }`}>
                              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-xs">
                                <div>
                                  <div className={`uppercase font-semibold mb-1 flex items-center gap-1 ${
                                    !checkIn.isWithinRadius ? 'text-red-700' : 'text-slate-400'
                                  }`}>
                                    {!checkIn.isWithinRadius && <i className="fas fa-exclamation-triangle" />} Clock In
                                  </div>
                                  <div className={`text-lg font-bold ${!checkIn.isWithinRadius ? 'text-red-700' : 'text-slate-800'}`}>
                                    {formatTime(checkIn.checkInTime)}
                                  </div>
                                  <div className={`mt-1 flex items-center gap-1 bg-white border rounded px-1.5 py-1 font-mono w-fit text-[10px] ${
                                    !checkIn.isWithinRadius ? 'text-red-700 border-red-200' : 'text-slate-500 border-slate-200'
                                  }`}>
                                    <i className="fas fa-map-pin" /> {checkIn.staffLatitude.toFixed(4)}, {checkIn.staffLongitude.toFixed(4)}
                                  </div>
                                  {!checkIn.isWithinRadius && (
                                    <div className="text-[10px] text-red-600 mt-1 font-medium">
                                      {formatDistance(checkIn.distanceFromBranch)} from branch
                                    </div>
                                  )}
                                </div>
                                
                                <div>
                                  <div className="text-slate-400 uppercase font-semibold mb-1">Distance</div>
                                  <div className={`text-lg font-bold ${
                                    checkIn.isWithinRadius ? 'text-green-600' : 'text-red-600'
                                  }`}>
                                    {formatDistance(checkIn.distanceFromBranch)}
                                  </div>
                                  <div className="text-[10px] text-slate-500 mt-1">
                                    Allowed: {formatDistance(checkIn.allowedRadius)}
                                  </div>
                                </div>
                                
                                <div>
                                  <div className="text-slate-400 uppercase font-semibold mb-1">Status</div>
                                  <div className={`text-lg font-medium ${
                                    checkIn.isWithinRadius ? 'text-green-600' : 'text-red-600'
                                  }`}>
                                    {checkIn.isWithinRadius ? '✓ Within Range' : '✗ Outside Range'}
                                  </div>
                                </div>
                                
                                <div>
                                  <div className="text-slate-400 uppercase font-semibold mb-1">Clock Out</div>
                                  {checkIn.checkOutTime ? (
                                    <>
                                      <div className="text-lg font-bold text-slate-800">
                                        {formatTime(checkIn.checkOutTime)}
                                      </div>
                                    </>
                                  ) : (
                                    <div className="text-lg font-medium text-green-600 flex items-center gap-1">
                                      <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                                      In Progress
                                    </div>
                                  )}
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Branches Quick View */}
            <div className="mt-6">
              <h3 className="text-lg font-bold text-slate-800 mb-4 flex items-center gap-2">
                <i className="fas fa-store text-pink-500" /> Branches
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {branches.map(branch => (
                  <div 
                    key={branch.id}
                    className={`bg-white rounded-xl border p-4 shadow-sm cursor-pointer transition hover:shadow-md ${
                      selectedBranchId === branch.id ? 'border-pink-300 ring-2 ring-pink-100' : 'border-slate-200'
                    }`}
                    onClick={() => setSelectedBranchId(selectedBranchId === branch.id ? "all" : branch.id)}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${
                          branch.location ? 'bg-green-100' : 'bg-amber-100'
                        }`}>
                          <i className={`fas fa-map-marker-alt ${branch.location ? 'text-green-600' : 'text-amber-600'}`} />
                        </div>
                        <div>
                          <h4 className="font-semibold text-slate-800">{branch.name}</h4>
                          <p className="text-xs text-slate-500">
                            {branch.location 
                              ? `Radius: ${branch.allowedCheckInRadius || 100}m` 
                              : 'No location set'}
                          </p>
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-lg font-bold text-slate-800">
                          {checkIns.filter(c => c.branchId === branch.id && c.status === 'checked_in').length}
                        </div>
                        <div className="text-xs text-slate-500">Active</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            </>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
