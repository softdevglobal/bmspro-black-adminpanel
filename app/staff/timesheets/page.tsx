"use client";
import React, { useState, useEffect, useMemo } from "react";
import Sidebar from "@/components/Sidebar";
import { useRouter } from "next/navigation";
import { auth, db } from "@/lib/firebase";
import { onAuthStateChanged } from "firebase/auth";
import { doc, getDoc, Timestamp, collection, query, where, getDocs, orderBy } from "firebase/firestore";
import { subscribeSalonStaffForOwner } from "@/lib/salonStaff";
import { StaffCheckInRecord } from "@/lib/staffCheckIn";

interface StaffMember {
  id: string;
  name: string;
  role?: string;
  branchName?: string;
  systemRole?: string;
  authUid?: string;
  uid?: string;
}

// Extended check-in record for display with day-wise split times
interface DisplayCheckInRecord extends StaffCheckInRecord {
  effectiveStartTime: Date;
  effectiveEndTime: Date | null;
  isSplitEntry?: boolean; // Flag to indicate this is a split entry
}

interface DayWorkHours {
  date: Date;
  checkIns: DisplayCheckInRecord[];
  totalHours: number;
  totalMinutes: number;
}

interface StaffWorkSummary {
  staffId: string;
  staffName: string;
  staffRole?: string;
  branchName?: string;
  systemRole?: string;
  days: DayWorkHours[];
  totalHours: number;
  totalMinutes: number;
}

const toDate = (value: Date | Timestamp): Date => {
  return value instanceof Timestamp ? value.toDate() : value;
};

const formatDate = (date: Date) => {
  return date.toLocaleDateString("en-AU", { 
    weekday: "short", 
    day: "numeric", 
    month: "short"
  });
};

const formatTime = (date: Date | Timestamp) => {
  return toDate(date).toLocaleTimeString("en-AU", { 
    hour: "2-digit", 
    minute: "2-digit",
    hour12: true 
  });
};

const calculateDuration = (checkIn: Date | Timestamp, checkOut?: Date | Timestamp | null, breakPeriods?: any[]): { hours: number; minutes: number } => {
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
  return { hours: hours > 0 ? hours : 0, minutes: minutes > 0 ? minutes : 0 };
};

const formatDuration = (hours: number, minutes: number): string => {
  if (hours === 0 && minutes === 0) return "0m";
  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
};

// Helper to format duration from milliseconds
const formatDurationFromMs = (milliseconds: number): string => {
  const totalMinutes = Math.floor(milliseconds / (1000 * 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return formatDuration(hours, minutes);
};

// Helper to get date key (YYYY-MM-DD)
const getDateKey = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

// Helper to get start of day (midnight)
const getStartOfDay = (date: Date): Date => {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  return start;
};

// Helper to get end of day (23:59:59.999)
const getEndOfDay = (date: Date): Date => {
  const end = new Date(date);
  end.setHours(23, 59, 59, 999);
  return end;
};

// Helper type for split check-in entries
interface SplitCheckInEntry {
  dateKey: string;
  checkIn: StaffCheckInRecord;
  effectiveStartTime: Date;
  effectiveEndTime: Date | null;
  breakPeriods: Array<{
    startTime?: Date | Timestamp | null;
    endTime?: Date | Timestamp | null;
  }>;
}

/**
 * Split a check-in session that spans across midnight into day-wise entries
 * Returns an array of split entries, one for each day the session spans
 */
const splitCheckInByDays = (checkIn: StaffCheckInRecord): SplitCheckInEntry[] => {
  const checkInTime = toDate(checkIn.checkInTime);
  const checkOutTime = checkIn.checkOutTime ? toDate(checkIn.checkOutTime) : new Date();
  
  const result: SplitCheckInEntry[] = [];
  const breakPeriods = (checkIn as any).breakPeriods || [];
  
  // Get the date key for check-in date
  const checkInDateKey = getDateKey(checkInTime);
  const checkOutDateKey = getDateKey(checkOutTime);
  
  // If check-in and check-out are on the same day, no splitting needed
  if (checkInDateKey === checkOutDateKey) {
    result.push({
      dateKey: checkInDateKey,
      checkIn: checkIn,
      effectiveStartTime: checkInTime,
      effectiveEndTime: checkOutTime,
      breakPeriods: breakPeriods
    });
    return result;
  }
  
  // Session spans across multiple days - split it
  let currentDate = new Date(checkInTime);
  currentDate.setHours(0, 0, 0, 0);
  const checkOutDate = new Date(checkOutTime);
  checkOutDate.setHours(0, 0, 0, 0);
  
  while (currentDate <= checkOutDate) {
    const dateKey = getDateKey(currentDate);
    const dayStart = getStartOfDay(currentDate);
    const dayEnd = getEndOfDay(currentDate);
    
    // Determine effective start and end times for this day
    // For the first day, start from checkInTime; for subsequent days, start from dayStart
    const isFirstDay = getDateKey(currentDate) === checkInDateKey;
    const isLastDay = getDateKey(currentDate) === checkOutDateKey;
    
    // Create new Date objects to avoid reference issues
    const effectiveStartTime = new Date(isFirstDay ? checkInTime : dayStart);
    const effectiveEndTime = new Date(isLastDay ? checkOutTime : dayEnd);
    
    // Split break periods that fall within this day
    const dayBreakPeriods = breakPeriods.map((bp: any) => {
      if (!bp.startTime) return null;
      
      const breakStart = toDate(bp.startTime);
      const breakEnd = bp.endTime ? toDate(bp.endTime) : new Date();
      
      // Check if break overlaps with this day segment
      if (breakStart < effectiveEndTime && breakEnd > effectiveStartTime) {
        // Clip break to this day's boundaries
        const clippedStart = breakStart < effectiveStartTime ? effectiveStartTime : breakStart;
        const clippedEnd = breakEnd > effectiveEndTime ? effectiveEndTime : breakEnd;
        
        // Only include if there's actual overlap (clippedStart < clippedEnd)
        if (clippedStart < clippedEnd) {
          return {
            startTime: clippedStart,
            endTime: clippedEnd
          };
        }
      }
      
      // Break doesn't overlap with this day
      return null;
    }).filter((bp: any) => bp !== null);
    
    result.push({
      dateKey: dateKey,
      checkIn: checkIn,
      effectiveStartTime: effectiveStartTime,
      effectiveEndTime: effectiveEndTime,
      breakPeriods: dayBreakPeriods
    });
    
    // Move to next day
    currentDate.setDate(currentDate.getDate() + 1);
    currentDate.setHours(0, 0, 0, 0);
  }
  
  return result;
};

/**
 * Calculate duration for a split check-in entry using effective times
 */
const calculateDurationForSplitEntry = (entry: SplitCheckInEntry): { hours: number; minutes: number } => {
  const start = entry.effectiveStartTime;
  const end = entry.effectiveEndTime || new Date();
  const totalDiff = end.getTime() - start.getTime();
  
  // Calculate break time for this day segment
  let totalBreakMs = 0;
  if (entry.breakPeriods && Array.isArray(entry.breakPeriods)) {
    for (const breakPeriod of entry.breakPeriods) {
      if (breakPeriod.startTime && breakPeriod.endTime) {
        const breakStart = toDate(breakPeriod.startTime);
        const breakEnd = toDate(breakPeriod.endTime);
        totalBreakMs += breakEnd.getTime() - breakStart.getTime();
      } else if (breakPeriod.startTime && !breakPeriod.endTime) {
        // Active break - calculate from start to end of this segment
        const breakStart = toDate(breakPeriod.startTime);
        totalBreakMs += end.getTime() - breakStart.getTime();
      }
    }
  }
  
  // Subtract break time from total time
  const workingMs = totalDiff - totalBreakMs;
  const hours = Math.floor(workingMs / (1000 * 60 * 60));
  const minutes = Math.floor((workingMs % (1000 * 60 * 60)) / (1000 * 60));
  return { hours: hours > 0 ? hours : 0, minutes: minutes > 0 ? minutes : 0 };
};

export default function TimesheetsPage() {
  const router = useRouter();
  const [ownerUid, setOwnerUid] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [staffMembers, setStaffMembers] = useState<StaffMember[]>([]);
  const [workSummaries, setWorkSummaries] = useState<StaffWorkSummary[]>([]);
  const [mobileOpen, setMobileOpen] = useState(false);
  
  // Filter states
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedRole, setSelectedRole] = useState<string>("all");
  const [selectedBranch, setSelectedBranch] = useState<string>("all");
  const [minHours, setMinHours] = useState<string>("0");
  const [sortBy, setSortBy] = useState<"name" | "hours">("hours");

  // Calculate week range (Monday to Sunday) - memoized to prevent infinite loops
  const weekRange = useMemo(() => {
    const dateCopy = new Date(selectedDate);
    const day = dateCopy.getDay();
    const diff = dateCopy.getDate() - day + (day === 0 ? -6 : 1); // Adjust when day is Sunday
    const monday = new Date(dateCopy);
    monday.setDate(diff);
    monday.setHours(0, 0, 0, 0);
    
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    sunday.setHours(23, 59, 59, 999);
    
    return { start: monday, end: sunday };
  }, [selectedDate]);

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

  // Subscribe to staff members
  useEffect(() => {
    if (!ownerUid) return;
    
    const unsub = subscribeSalonStaffForOwner(ownerUid, (staffList) => {
      setStaffMembers(staffList.map(s => {
        // subscribeSalonStaffForOwner already provides authUid and uid
        const authUid = (s as any).authUid || (s as any).uid || s.id;
        const uid = (s as any).uid || (s as any).authUid || s.id;
        
        return {
          id: s.id,
          name: s.name || s.displayName || "Unknown",
          role: s.role || s.staffRole,
          branchName: s.branchName,
          systemRole: s.systemRole || s.role,
          authUid: authUid,
          uid: uid
        };
      }));
    });
    
    return () => unsub();
  }, [ownerUid]);

  // Fetch work hours for the week
  useEffect(() => {
    if (!ownerUid || staffMembers.length === 0) {
      setWorkSummaries([]);
      return;
    }

    const fetchWorkHours = async () => {
      try {
        // Query ALL check-ins for the owner (no date filter - avoids index requirement)
        // Then filter by date in memory
        const allCheckIns: StaffCheckInRecord[] = [];
        
        console.log(`\n=== FETCHING CHECK-INS ===`);
        console.log(`Owner UID: ${ownerUid}`);
        console.log(`Week range: ${weekRange.start.toISOString()} to ${weekRange.end.toISOString()}`);
        
        try {
          // Query by ownerUid only (this should work without an index)
          const ownerQuery = query(
            collection(db, "staff_check_ins"),
            where("ownerUid", "==", ownerUid)
          );
          
          const ownerSnapshot = await getDocs(ownerQuery);
          console.log(`Total check-ins for owner: ${ownerSnapshot.docs.length}`);
          
          // Filter check-ins by week range in memory
          const weekStartTime = weekRange.start.getTime();
          const weekEndTime = weekRange.end.getTime();
          
          ownerSnapshot.docs.forEach(doc => {
            const data = doc.data();
            const checkInTime = data.checkInTime;
            
            // Convert Firestore Timestamp to Date if needed
            let checkInDate: Date;
            if (checkInTime?.toDate) {
              checkInDate = checkInTime.toDate();
            } else if (checkInTime instanceof Date) {
              checkInDate = checkInTime;
            } else if (checkInTime instanceof Timestamp) {
              checkInDate = checkInTime.toDate();
            } else {
              return; // Skip invalid timestamps
            }
            
            const checkInTimeMs = checkInDate.getTime();
            
            // Check if check-in is within the week range
            if (checkInTimeMs >= weekStartTime && checkInTimeMs <= weekEndTime) {
              allCheckIns.push({
                id: doc.id,
                ...data,
                checkInTime: checkInTime,
                checkOutTime: data.checkOutTime,
                breakPeriods: data.breakPeriods || []
              } as StaffCheckInRecord);
            }
          });
          
          console.log(`Check-ins within week range: ${allCheckIns.length}`);
          
          if (allCheckIns.length > 0) {
            console.log('Check-ins found:');
          allCheckIns.forEach((ci, idx) => {
            const checkInDate = toDate(ci.checkInTime);
            const breakPeriods = (ci as any).breakPeriods || [];
            const duration = calculateDuration(ci.checkInTime, ci.checkOutTime, breakPeriods);
            console.log(`  ${idx + 1}. ${ci.staffName} (${ci.staffId})`);
            console.log(`     Date: ${checkInDate.toISOString().split('T')[0]}`);
            console.log(`     Time: ${formatTime(ci.checkInTime)} to ${ci.checkOutTime ? formatTime(ci.checkOutTime) : 'Active'}`);
            console.log(`     Duration: ${formatDuration(duration.hours, duration.minutes)}`);
          });
          }
        } catch (queryError: any) {
          console.error('Failed to query check-ins:', queryError);
          if (queryError.code === 'permission-denied') {
            console.error('  Permission denied. Check Firestore security rules.');
          } else if (queryError.code === 'failed-precondition') {
            console.error('  Index required. This should not happen with ownerUid-only query.');
          }
          throw queryError;
        }

        // Sort all check-ins by time
        allCheckIns.sort((a, b) => {
          const timeA = toDate(a.checkInTime).getTime();
          const timeB = toDate(b.checkInTime).getTime();
          return timeA - timeB;
        });
        
        console.log(`\nSorted ${allCheckIns.length} check-ins by time`);

        // Debug: Log total check-ins found
        console.log(`=== TIMESHEET DEBUG ===`);
        console.log(`Week range: ${weekRange.start.toISOString()} to ${weekRange.end.toISOString()}`);
        console.log(`Total check-ins found for week: ${allCheckIns.length}`);
        if (allCheckIns.length > 0) {
          console.log('All check-ins:');
          allCheckIns.forEach((ci, idx) => {
            const checkInDate = toDate(ci.checkInTime);
            const breakPeriods = (ci as any).breakPeriods || [];
            const duration = calculateDuration(ci.checkInTime, ci.checkOutTime, breakPeriods);
            console.log(`  ${idx + 1}. ${ci.staffName} (staffId: ${ci.staffId})`);
            console.log(`     Date: ${checkInDate.toISOString().split('T')[0]}`);
            console.log(`     Time: ${formatTime(ci.checkInTime)} to ${ci.checkOutTime ? formatTime(ci.checkOutTime) : 'Active'}`);
            console.log(`     Duration: ${formatDuration(duration.hours, duration.minutes)}`);
            console.log(`     Status: ${ci.status}`);
          });
        } else {
          console.warn('⚠️ NO CHECK-INS FOUND! Check:');
          console.warn('  1. Owner UID:', ownerUid);
          console.warn('  2. Week range dates');
          console.warn('  3. Firestore query permissions');
        }

        // Create a map of staff by all possible IDs (id, authUid, uid)
        // This allows us to match check-ins to staff regardless of which ID is used
        const staffByIdMap = new Map<string, StaffMember>();
        staffMembers.forEach(staff => {
          // Map by document ID
          staffByIdMap.set(staff.id, staff);
          // Map by authUid if available
          if (staff.authUid) {
            staffByIdMap.set(staff.authUid, staff);
          }
          // Map by uid if available
          if (staff.uid && staff.uid !== staff.authUid) {
            staffByIdMap.set(staff.uid, staff);
          }
        });

        // Group check-ins by staff member
        // Check-ins use staffId which is typically the Firebase Auth UID
        const checkInsByStaff = new Map<string, StaffCheckInRecord[]>();
        const unmatchedCheckIns: StaffCheckInRecord[] = [];
        
        allCheckIns.forEach(checkIn => {
          let matched = false;
          
          // Try direct lookup by staffId
          let staff = staffByIdMap.get(checkIn.staffId);
          
          if (!staff) {
            // Try finding staff by name (case-insensitive)
            const staffByName = staffMembers.find(s => {
              const staffName = (s.name || "").toLowerCase().trim();
              const checkInName = (checkIn.staffName || "").toLowerCase().trim();
              return staffName === checkInName && staffName !== "";
            });
            
            if (staffByName) {
              staff = staffByName;
              console.log(`✓ Matched by name: ${checkIn.staffName} (check-in staffId: ${checkIn.staffId} -> staff.id: ${staff.id})`);
            }
          } else {
            console.log(`✓ Matched by ID: ${checkIn.staffName} (staffId: ${checkIn.staffId} -> staff.id: ${staff.id})`);
          }
          
          if (staff) {
            // Use staff.id as the key to group by staff member
            if (!checkInsByStaff.has(staff.id)) {
              checkInsByStaff.set(staff.id, []);
            }
            checkInsByStaff.get(staff.id)!.push(checkIn);
            matched = true;
          } else {
            unmatchedCheckIns.push(checkIn);
            console.warn(`✗ No match for check-in: ${checkIn.staffName} (staffId: ${checkIn.staffId})`);
            console.warn(`  Available staff:`, staffMembers.map(s => ({ name: s.name, id: s.id, authUid: s.authUid })));
          }
        });
        
        // Log unmatched check-ins
        if (unmatchedCheckIns.length > 0) {
          console.warn(`Found ${unmatchedCheckIns.length} unmatched check-ins. Staff IDs in check-ins:`, 
            [...new Set(unmatchedCheckIns.map(ci => ci.staffId))]);
        }

        // Debug: Log matching info
        console.log('\n=== STAFF MATCHING DEBUG ===');
        console.log('Staff members:', staffMembers.map(s => ({
          name: s.name,
          id: s.id,
          authUid: s.authUid,
          uid: s.uid
        })));
        const uniqueCheckInStaffIds = [...new Set(allCheckIns.map(ci => ci.staffId))];
        console.log('Check-in staffIds from DB:', uniqueCheckInStaffIds);
        console.log('Staff ID map keys:', Array.from(staffByIdMap.keys()));
        console.log('Matched check-ins per staff:', Array.from(checkInsByStaff.entries()).map(([id, cis]) => {
          const staff = staffMembers.find(s => s.id === id);
          return {
            staffId: id,
            staffName: staff?.name || 'Unknown',
            checkInCount: cis.length,
            checkIns: cis.map(ci => ({
              date: toDate(ci.checkInTime).toISOString().split('T')[0],
              time: `${formatTime(ci.checkInTime)} - ${ci.checkOutTime ? formatTime(ci.checkOutTime) : 'Active'}`
            }))
          };
        }));

        // Also create summaries for unmatched check-ins (staff not in list but has check-ins)
        const unmatchedStaffMap = new Map<string, { name: string; role?: string; branchName?: string }>();
        unmatchedCheckIns.forEach(checkIn => {
          if (!unmatchedStaffMap.has(checkIn.staffId)) {
            unmatchedStaffMap.set(checkIn.staffId, {
              name: checkIn.staffName,
              role: checkIn.staffRole,
              branchName: checkIn.branchName
            });
          }
        });

        const summaries: StaffWorkSummary[] = [];

        // Process ALL staff members (even if they have no check-ins)
        // This ensures we show all staff in the table
        for (const staff of staffMembers) {
          // Get check-ins for this staff member
          const checkIns = checkInsByStaff.get(staff.id) || [];
          
          // Debug logging
          console.log(`\n=== Processing ${staff.name} ===`);
          console.log(`  Staff ID: ${staff.id}`);
          console.log(`  Auth UID: ${staff.authUid}`);
          console.log(`  UID: ${staff.uid}`);
          console.log(`  Check-ins found: ${checkIns.length}`);
          
          // If no check-ins found, still create a summary with zeros
          // This ensures the staff member appears in the table
          
          if (checkIns.length > 0) {
            checkIns.forEach((ci, idx) => {
              const breakPeriods = (ci as any).breakPeriods || [];
              const duration = calculateDuration(ci.checkInTime, ci.checkOutTime, breakPeriods);
              const checkInDate = toDate(ci.checkInTime);
              console.log(`  Check-in ${idx + 1}:`);
              console.log(`    Date: ${checkInDate.toISOString().split('T')[0]}`);
              console.log(`    Time: ${formatTime(ci.checkInTime)} to ${ci.checkOutTime ? formatTime(ci.checkOutTime) : 'Active'}`);
              console.log(`    Duration: ${formatDuration(duration.hours, duration.minutes)}`);
              console.log(`    Raw: hours=${duration.hours}, minutes=${duration.minutes}`);
            });
          } else {
            console.log(`  ⚠️ No check-ins matched for ${staff.name}`);
            console.log(`  Looking for staffId: ${staff.id}, ${staff.authUid}, ${staff.uid}`);
          }

          // Group check-ins by date (with day-wise splitting for cross-day sessions)
          const daysMap = new Map<string, DisplayCheckInRecord[]>();
          
          checkIns.forEach(checkIn => {
            // Split check-in into day-wise entries if it spans across midnight
            const splitEntries = splitCheckInByDays(checkIn);
            
            splitEntries.forEach(entry => {
              if (!daysMap.has(entry.dateKey)) {
                daysMap.set(entry.dateKey, []);
              }
              
              // Create display record with effective times
              // Create a new object to avoid any reference issues with the original checkIn
              const displayRecord: DisplayCheckInRecord = {
                ...checkIn,
                // Override with effective times for this day segment
                checkInTime: entry.effectiveStartTime,
                checkOutTime: entry.effectiveEndTime,
                effectiveStartTime: entry.effectiveStartTime,
                effectiveEndTime: entry.effectiveEndTime,
                breakPeriods: entry.breakPeriods,
                isSplitEntry: splitEntries.length > 1
              };
              
              daysMap.get(entry.dateKey)!.push(displayRecord);
            });
          });

          // Calculate hours for each day
          const days: DayWorkHours[] = [];
          let totalHours = 0;
          let totalMinutes = 0;

          // Generate all 7 days of the week
          for (let i = 0; i < 7; i++) {
            const date = new Date(weekRange.start);
            date.setDate(weekRange.start.getDate() + i);
            // Use local date components to match check-in date extraction
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            const dateKey = `${year}-${month}-${day}`; // YYYY-MM-DD
            
            const dayCheckIns = daysMap.get(dateKey) || [];
            let dayHours = 0;
            let dayMinutes = 0;

            dayCheckIns.forEach(checkIn => {
              // Calculate duration for all check-ins (excluding breaks)
              // If checkOutTime exists, use it; otherwise use current time for active check-ins
              const breakPeriods = (checkIn as any).breakPeriods || [];
              const duration = calculateDuration(checkIn.checkInTime, checkIn.checkOutTime, breakPeriods);
              dayHours += duration.hours;
              dayMinutes += duration.minutes;
              
              // Debug log for each check-in
              console.log(`  Day ${i} - ${staff.name}: ${formatTime(checkIn.checkInTime)} to ${checkIn.checkOutTime ? formatTime(checkIn.checkOutTime) : 'Active'} = ${formatDuration(duration.hours, duration.minutes)}`);
            });

            // Convert minutes to hours if >= 60
            if (dayMinutes >= 60) {
              dayHours += Math.floor(dayMinutes / 60);
              dayMinutes = dayMinutes % 60;
            }

            totalHours += dayHours;
            totalMinutes += dayMinutes;

            days.push({
              date: new Date(date),
              checkIns: dayCheckIns,
              totalHours: dayHours,
              totalMinutes: dayMinutes
            });
          }

          // Convert total minutes to hours
          if (totalMinutes >= 60) {
            totalHours += Math.floor(totalMinutes / 60);
            totalMinutes = totalMinutes % 60;
          }

          // Debug: Log summary for this staff member
          console.log(`\n=== Summary for ${staff.name} ===`);
          console.log(`  Total hours: ${totalHours}, Total minutes: ${totalMinutes}`);
          console.log(`  Formatted: ${formatDuration(totalHours, totalMinutes)}`);
          console.log(`  Days with check-ins: ${days.filter(d => d.checkIns.length > 0).length}`);
          days.forEach((day, idx) => {
            if (day.checkIns.length > 0) {
              console.log(`    ${formatDate(day.date)}: ${formatDuration(day.totalHours, day.totalMinutes)} (${day.checkIns.length} check-ins)`);
            }
          });

          // Always create summary, even if no check-ins (so staff appears in table)
          const summary: StaffWorkSummary = {
            staffId: staff.id,
            staffName: staff.name,
            staffRole: staff.role,
            branchName: staff.branchName,
            systemRole: staff.systemRole,
            days,
            totalHours,
            totalMinutes
          };
          
          console.log(`  Final summary: ${formatDuration(summary.totalHours, summary.totalMinutes)}`);
          summaries.push(summary);
        }
        
        console.log(`\n=== FINAL SUMMARIES ===`);
        console.log(`Total summaries created: ${summaries.length}`);
        summaries.forEach(s => {
          if (s.totalHours > 0 || s.totalMinutes > 0) {
            console.log(`  ${s.staffName}: ${formatDuration(s.totalHours, s.totalMinutes)}`);
          }
        });

        // Process unmatched check-ins (create entries for staff not in staff list)
        for (const [staffId, staffInfo] of unmatchedStaffMap.entries()) {
          const unmatchedCheckInsForStaff = unmatchedCheckIns.filter(ci => ci.staffId === staffId);
          
          if (unmatchedCheckInsForStaff.length > 0) {
            // Group check-ins by date (with day-wise splitting for cross-day sessions)
            const daysMap = new Map<string, DisplayCheckInRecord[]>();
            unmatchedCheckInsForStaff.forEach(checkIn => {
              // Split check-in into day-wise entries if it spans across midnight
              const splitEntries = splitCheckInByDays(checkIn);
              
              splitEntries.forEach(entry => {
                if (!daysMap.has(entry.dateKey)) {
                  daysMap.set(entry.dateKey, []);
                }
                
                // Create display record with effective times
                const displayRecord: DisplayCheckInRecord = {
                  ...checkIn,
                  checkInTime: entry.effectiveStartTime,
                  checkOutTime: entry.effectiveEndTime,
                  effectiveStartTime: entry.effectiveStartTime,
                  effectiveEndTime: entry.effectiveEndTime,
                  breakPeriods: entry.breakPeriods,
                  isSplitEntry: splitEntries.length > 1
                };
                
                daysMap.get(entry.dateKey)!.push(displayRecord);
              });
            });

            // Calculate hours for each day
            const days: DayWorkHours[] = [];
            let totalHours = 0;
            let totalMinutes = 0;

            for (let i = 0; i < 7; i++) {
              const date = new Date(weekRange.start);
              date.setDate(weekRange.start.getDate() + i);
              // Use local date components to match check-in date extraction
              const year = date.getFullYear();
              const month = String(date.getMonth() + 1).padStart(2, '0');
              const day = String(date.getDate()).padStart(2, '0');
              const dateKey = `${year}-${month}-${day}`; // YYYY-MM-DD
              
              const dayCheckIns = daysMap.get(dateKey) || [];
              let dayHours = 0;
              let dayMinutes = 0;

              dayCheckIns.forEach(checkIn => {
                if (checkIn.checkOutTime || checkIn.status === "checked_in") {
                  const breakPeriods = (checkIn as any).breakPeriods || [];
                  const duration = calculateDuration(checkIn.checkInTime, checkIn.checkOutTime, breakPeriods);
                  dayHours += duration.hours;
                  dayMinutes += duration.minutes;
                }
              });

              if (dayMinutes >= 60) {
                dayHours += Math.floor(dayMinutes / 60);
                dayMinutes = dayMinutes % 60;
              }

              totalHours += dayHours;
              totalMinutes += dayMinutes;

              days.push({
                date: new Date(date),
                checkIns: dayCheckIns,
                totalHours: dayHours,
                totalMinutes: dayMinutes
              });
            }

            if (totalMinutes >= 60) {
              totalHours += Math.floor(totalMinutes / 60);
              totalMinutes = totalMinutes % 60;
            }

            summaries.push({
              staffId: staffId,
              staffName: staffInfo.name,
              staffRole: staffInfo.role,
              branchName: staffInfo.branchName,
              systemRole: undefined,
              days,
              totalHours,
              totalMinutes
            });
            
            console.log(`Created summary for unmatched staff: ${staffInfo.name} (${unmatchedCheckInsForStaff.length} check-ins)`);
          }
        }

        // Sort by total hours (descending)
        summaries.sort((a, b) => {
          const aTotal = a.totalHours * 60 + a.totalMinutes;
          const bTotal = b.totalHours * 60 + b.totalMinutes;
          return bTotal - aTotal;
        });

        console.log(`\n=== SETTING WORK SUMMARIES ===`);
        console.log(`Total summaries to set: ${summaries.length}`);
        summaries.forEach((s, idx) => {
          console.log(`  ${idx + 1}. ${s.staffName}: ${formatDuration(s.totalHours, s.totalMinutes)} (${s.totalHours}h ${s.totalMinutes}m)`);
          console.log(`     Days with data: ${s.days.filter(d => d.checkIns.length > 0).length}`);
        });

        setWorkSummaries(summaries);
        console.log('✅ Work summaries state updated');
      } catch (error) {
        console.error("Error fetching work hours:", error);
        setWorkSummaries([]);
      }
    };

    fetchWorkHours();
  }, [ownerUid, staffMembers, weekRange.start.getTime(), weekRange.end.getTime()]);

  // Date navigation
  const goToPreviousWeek = () => {
    const newDate = new Date(selectedDate);
    newDate.setDate(newDate.getDate() - 7);
    setSelectedDate(newDate);
  };

  const goToNextWeek = () => {
    const newDate = new Date(selectedDate);
    newDate.setDate(newDate.getDate() + 7);
    setSelectedDate(newDate);
  };

  const goToThisWeek = () => {
    setSelectedDate(new Date());
  };

  const weekDays = [];
  for (let i = 0; i < 7; i++) {
    const date = new Date(weekRange.start);
    date.setDate(weekRange.start.getDate() + i);
    weekDays.push(date);
  }

  // Get unique roles and branches for filter dropdowns
  const uniqueRoles = useMemo(() => {
    const roles = new Set<string>();
    workSummaries.forEach(s => {
      if (s.staffRole) roles.add(s.staffRole);
      if (s.systemRole === "salon_branch_admin") roles.add("Branch Admin");
    });
    return Array.from(roles).sort();
  }, [workSummaries]);

  const uniqueBranches = useMemo(() => {
    const branches = new Set<string>();
    workSummaries.forEach(s => {
      if (s.branchName) branches.add(s.branchName);
    });
    return Array.from(branches).sort();
  }, [workSummaries]);

  // Filter and sort work summaries
  const filteredSummaries = useMemo(() => {
    let filtered = [...workSummaries];

    // Filter by search query (staff name)
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase().trim();
      filtered = filtered.filter(s => 
        s.staffName.toLowerCase().includes(query)
      );
    }

    // Filter by role
    if (selectedRole !== "all") {
      filtered = filtered.filter(s => {
        if (selectedRole === "Branch Admin") {
          return s.systemRole === "salon_branch_admin";
        }
        return s.staffRole === selectedRole;
      });
    }

    // Filter by branch
    if (selectedBranch !== "all") {
      filtered = filtered.filter(s => s.branchName === selectedBranch);
    }

    // Filter by minimum hours
    const minHoursNum = parseFloat(minHours) || 0;
    if (minHoursNum > 0) {
      filtered = filtered.filter(s => {
        const totalMinutes = s.totalHours * 60 + s.totalMinutes;
        const minMinutes = minHoursNum * 60;
        return totalMinutes >= minMinutes;
      });
    }

    // Sort
    filtered.sort((a, b) => {
      if (sortBy === "name") {
        return a.staffName.localeCompare(b.staffName);
      } else {
        // Sort by hours (descending)
        const aTotal = a.totalHours * 60 + a.totalMinutes;
        const bTotal = b.totalHours * 60 + b.totalMinutes;
        return bTotal - aTotal;
      }
    });

    return filtered;
  }, [workSummaries, searchQuery, selectedRole, selectedBranch, minHours, sortBy]);

  return (
    <div className="flex h-screen overflow-hidden bg-slate-50 font-inter text-slate-800">
      <Sidebar />

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <main className="flex-1 overflow-auto">
          
          {/* Mobile Toggle */}
          <div className="md:hidden p-4 bg-white border-b border-slate-200 flex items-center justify-between shrink-0">
            <h2 className="font-bold text-lg text-slate-800">Timesheets</h2>
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
                    <i className="fas fa-clock" />
                  </div>
                  <div>
                    <h1 className="text-2xl font-bold">Staff Timesheets</h1>
                    <p className="text-sm text-white/80 mt-1">View daily work hours for all staff members</p>
                  </div>
                </div>
              </div>
            </div>

            {/* Loading State */}
            {loading && (
              <div className="flex items-center justify-center py-20">
                <div className="flex flex-col items-center gap-4">
                  <div className="w-12 h-12 border-4 border-pink-500 border-t-transparent rounded-full animate-spin" />
                  <span className="text-slate-600">Loading timesheets...</span>
                </div>
              </div>
            )}

            {/* Main Content - only show after loading */}
            {!loading && (
              <>
                {/* Week Navigation */}
                <div className="bg-white rounded-xl border border-slate-200 p-4 mb-6 shadow-sm">
                  <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={goToPreviousWeek}
                        className="p-2 rounded-lg border border-slate-200 hover:bg-slate-50 text-slate-600"
                      >
                        <i className="fas fa-chevron-left" />
                      </button>
                      <div className="px-4 py-2 bg-slate-50 rounded-lg border border-slate-200 font-medium text-slate-700 min-w-[250px] text-center">
                        {formatDate(weekRange.start)} - {formatDate(weekRange.end)}
                      </div>
                      <button
                        onClick={goToNextWeek}
                        className="p-2 rounded-lg border border-slate-200 hover:bg-slate-50 text-slate-600"
                      >
                        <i className="fas fa-chevron-right" />
                      </button>
                      <button
                        onClick={goToThisWeek}
                        className="px-3 py-2 rounded-lg bg-pink-50 text-pink-600 font-medium hover:bg-pink-100 text-sm"
                      >
                        This Week
                      </button>
                    </div>

                    {/* Summary Stats */}
                    <div className="flex items-center gap-4 text-sm">
                      <div className="text-slate-600">
                        <span className="font-semibold">{filteredSummaries.length}</span> Staff Members
                        {filteredSummaries.length !== workSummaries.length && (
                          <span className="text-slate-400"> / {workSummaries.length}</span>
                        )}
                      </div>
                      <div className="text-slate-600">
                        Total Hours: <span className="font-semibold text-pink-600">
                          {formatDuration(
                            filteredSummaries.reduce((sum, s) => sum + s.totalHours, 0),
                            filteredSummaries.reduce((sum, s) => sum + s.totalMinutes, 0)
                          )}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Filter Section */}
                <div className="bg-white rounded-xl border border-slate-200 p-4 mb-6 shadow-sm">
                  <div className="flex flex-col gap-4">
                    <div className="flex items-center gap-2">
                      <i className="fas fa-filter text-pink-600" />
                      <h3 className="font-semibold text-slate-800">Quick Filters</h3>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
                      {/* Search by Name */}
                      <div className="relative">
                        <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                          <i className="fas fa-search text-slate-400" />
                        </div>
                        <input
                          type="text"
                          placeholder="Search staff name..."
                          value={searchQuery}
                          onChange={(e) => setSearchQuery(e.target.value)}
                          className="w-full pl-10 pr-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-pink-500 focus:border-transparent"
                        />
                      </div>

                      {/* Filter by Role */}
                      <div className="relative">
                        <select
                          value={selectedRole}
                          onChange={(e) => setSelectedRole(e.target.value)}
                          className="w-full px-3 pr-8 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-pink-500 focus:border-transparent bg-white appearance-none"
                        >
                          <option value="all">All Roles</option>
                          {uniqueRoles.map(role => (
                            <option key={role} value={role}>{role}</option>
                          ))}
                        </select>
                        <div className="absolute inset-y-0 right-0 pr-2.5 flex items-center pointer-events-none">
                          <i className="fas fa-chevron-down text-slate-400 text-xs" />
                        </div>
                      </div>

                      {/* Filter by Branch */}
                      <div className="relative">
                        <select
                          value={selectedBranch}
                          onChange={(e) => setSelectedBranch(e.target.value)}
                          className="w-full px-3 pr-8 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-pink-500 focus:border-transparent bg-white appearance-none"
                        >
                          <option value="all">All Branches</option>
                          {uniqueBranches.map(branch => (
                            <option key={branch} value={branch}>{branch}</option>
                          ))}
                        </select>
                        <div className="absolute inset-y-0 right-0 pr-2.5 flex items-center pointer-events-none">
                          <i className="fas fa-chevron-down text-slate-400 text-xs" />
                        </div>
                      </div>

                      {/* Minimum Hours */}
                      <div className="relative">
                        <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                          <i className="fas fa-clock text-slate-400 text-xs" />
                        </div>
                        <input
                          type="number"
                          placeholder="Min hours"
                          value={minHours}
                          onChange={(e) => setMinHours(e.target.value)}
                          min="0"
                          step="0.5"
                          className="w-full pl-10 pr-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-pink-500 focus:border-transparent"
                        />
                      </div>

                      {/* Sort By */}
                      <div className="relative">
                        <select
                          value={sortBy}
                          onChange={(e) => setSortBy(e.target.value as "name" | "hours")}
                          className="w-full px-3 pr-8 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-pink-500 focus:border-transparent bg-white appearance-none"
                        >
                          <option value="hours">Sort by Hours</option>
                          <option value="name">Sort by Name</option>
                        </select>
                        <div className="absolute inset-y-0 right-0 pr-2.5 flex items-center pointer-events-none">
                          <i className="fas fa-chevron-down text-slate-400 text-xs" />
                        </div>
                      </div>
                    </div>

                    {/* Clear Filters Button */}
                    {(searchQuery || selectedRole !== "all" || selectedBranch !== "all" || minHours !== "0") && (
                      <button
                        onClick={() => {
                          setSearchQuery("");
                          setSelectedRole("all");
                          setSelectedBranch("all");
                          setMinHours("0");
                        }}
                        className="self-start px-3 py-1.5 text-xs font-medium text-pink-600 hover:text-pink-700 hover:bg-pink-50 rounded-lg transition"
                      >
                        <i className="fas fa-times mr-1" />
                        Clear Filters
                      </button>
                    )}
                  </div>
                </div>

                {/* Timesheet Table */}
                <div className="bg-white rounded-xl border border-slate-200 overflow-hidden shadow-sm">
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead className="bg-slate-50 border-b border-slate-200">
                        <tr>
                          <th className="px-4 py-3 text-left text-xs font-bold text-slate-500 uppercase tracking-wider sticky left-0 bg-slate-50 z-10">
                            Staff Member
                          </th>
                          {weekDays.map((day, idx) => (
                            <th key={idx} className="px-3 py-3 text-center text-xs font-bold text-slate-500 uppercase tracking-wider min-w-[120px]">
                              <div>{formatDate(day)}</div>
                            </th>
                          ))}
                          <th className="px-4 py-3 text-center text-xs font-bold text-slate-500 uppercase tracking-wider min-w-[100px]">
                            Total
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {filteredSummaries.length === 0 ? (
                          <tr>
                            <td colSpan={9} className="px-4 py-12 text-center text-slate-400">
                              <i className="fas fa-filter text-3xl mb-3 opacity-50" />
                              <p>
                                {workSummaries.length === 0 
                                  ? "No timesheet data for this week"
                                  : "No staff members match the current filters"}
                              </p>
                              {(searchQuery || selectedRole !== "all" || selectedBranch !== "all" || minHours !== "0") && (
                                <button
                                  onClick={() => {
                                    setSearchQuery("");
                                    setSelectedRole("all");
                                    setSelectedBranch("all");
                                    setMinHours("0");
                                  }}
                                  className="mt-3 px-4 py-2 text-sm font-medium text-pink-600 hover:text-pink-700 hover:bg-pink-50 rounded-lg transition"
                                >
                                  Clear Filters
                                </button>
                              )}
                            </td>
                          </tr>
                        ) : (
                          filteredSummaries.map((summary) => (
                            <tr key={summary.staffId} className="hover:bg-slate-50 transition">
                              <td className="px-4 py-3 sticky left-0 bg-white z-10">
                                <div className="flex flex-col">
                                  <div className="font-semibold text-slate-800 flex items-center gap-2 flex-wrap">
                                    <span className="break-words">{summary.staffName}</span>
                                    {summary.systemRole === "salon_branch_admin" && (
                                      <span className="px-1.5 sm:px-2 py-0.5 bg-purple-100 text-purple-700 text-[9px] sm:text-[10px] font-bold rounded-full whitespace-nowrap shrink-0">
                                        Branch Admin
                                      </span>
                                    )}
                                  </div>
                                  <div className="text-[10px] sm:text-xs text-slate-500 break-words mt-2">
                                    {summary.systemRole === "salon_branch_admin" 
                                      ? "Branch Admin" 
                                      : summary.staffRole || "Staff"}
                                    {summary.branchName && ` • ${summary.branchName}`}
                                  </div>
                                </div>
                              </td>
                              {summary.days.map((day, dayIdx) => (
                                <td key={dayIdx} className="px-3 py-3 text-center">
                                  {day.checkIns.length > 0 ? (
                                    <div className="space-y-1">
                                      {day.checkIns.map((checkIn, ciIdx) => {
                                        const breakPeriods = (checkIn as any).breakPeriods || [];
                                        const duration = calculateDuration(checkIn.checkInTime, checkIn.checkOutTime, breakPeriods);
                                        return (
                                          <div key={ciIdx} className="text-xs">
                                            <div className="font-medium text-slate-800 flex items-center justify-center gap-1.5 flex-wrap">
                                              <span>
                                                {formatTime(checkIn.checkInTime)}
                                                {checkIn.checkOutTime ? (
                                                  <> - {formatTime(checkIn.checkOutTime)}</>
                                                ) : (
                                                  <span className="text-green-600 ml-1">
                                                    <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse inline-block mr-1" />
                                                    Active
                                                  </span>
                                                )}
                                              </span>
                                              <span className="font-semibold text-pink-600">
                                                ({formatDuration(duration.hours, duration.minutes)})
                                              </span>
                                            </div>
                                          </div>
                                        );
                                      })}
                                      {day.checkIns.length > 1 && (
                                        <div className="font-semibold text-pink-600 text-sm pt-1 border-t border-slate-100 mt-1">
                                          Total: {formatDuration(day.totalHours, day.totalMinutes)}
                                        </div>
                                      )}
                                    </div>
                                  ) : (
                                    <span className="text-slate-300">-</span>
                                  )}
                                </td>
                              ))}
                              <td className="px-4 py-3 text-center">
                                <div className="font-bold text-pink-600 text-base">
                                  {formatDuration(summary.totalHours, summary.totalMinutes)}
                                </div>
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Summary Cards */}
                {filteredSummaries.length > 0 && (
                  <div className="mt-6 grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-full bg-blue-100 flex items-center justify-center">
                          <i className="fas fa-users text-blue-600" />
                        </div>
                        <div>
                          <div className="text-2xl font-bold text-slate-800">{filteredSummaries.length}</div>
                          <div className="text-xs text-slate-500">
                            Staff Members
                            {filteredSummaries.length !== workSummaries.length && (
                              <span className="text-slate-400"> (filtered)</span>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                    
                    <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-full bg-green-100 flex items-center justify-center">
                          <i className="fas fa-clock text-green-600" />
                        </div>
                        <div>
                          <div className="text-2xl font-bold text-slate-800">
                            {formatDuration(
                              filteredSummaries.reduce((sum, s) => sum + s.totalHours, 0),
                              filteredSummaries.reduce((sum, s) => sum + s.totalMinutes, 0)
                            )}
                          </div>
                          <div className="text-xs text-slate-500">Total Hours</div>
                        </div>
                      </div>
                    </div>
                    
                    <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-full bg-purple-100 flex items-center justify-center">
                          <i className="fas fa-calendar-week text-purple-600" />
                        </div>
                        <div>
                          <div className="text-2xl font-bold text-slate-800">
                            {filteredSummaries.filter(s => s.totalHours > 0 || s.totalMinutes > 0).length}
                          </div>
                          <div className="text-xs text-slate-500">Active This Week</div>
                        </div>
                      </div>
                    </div>
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
