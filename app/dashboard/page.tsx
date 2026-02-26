"use client";
import React, { useEffect, useRef, useState } from "react";
import Sidebar from "@/components/Sidebar";
import { useRouter } from "next/navigation";
import { onAuthStateChanged } from "firebase/auth";
import Script from "next/script";
import { collection, query, where, onSnapshot, getDocs } from "firebase/firestore";
import { useNotifications } from "@/components/NotificationProvider";
import { subscribeBranchesForOwner } from "@/lib/branches";

export default function DashboardPage() {
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [monthlyRevenue, setMonthlyRevenue] = useState<number>(0);
  const [totalBookings, setTotalBookings] = useState<number>(0);
  const [activeStaff, setActiveStaff] = useState<number>(0);
  const [activeServices, setActiveServices] = useState<number>(0);
  const [revenueData, setRevenueData] = useState<number[]>([]);
  const [revenueLabels, setRevenueLabels] = useState<string[]>([]);
  const [statusData, setStatusData] = useState({ confirmed: 0, pending: 0, completed: 0, canceled: 0 });
  const [ownerUid, setOwnerUid] = useState<string | null>(null);
  const [currentUserUid, setCurrentUserUid] = useState<string | null>(null);
  const [weeklyBookings, setWeeklyBookings] = useState<number>(0);
  const [revenueGrowth, setRevenueGrowth] = useState<number>(0);
  const [recentTenants, setRecentTenants] = useState<any[]>([]);
  const [recentActivities, setRecentActivities] = useState<any[]>([]);
  const [isSuperAdmin, setIsSuperAdmin] = useState<boolean>(false);
  const [isBranchAdmin, setIsBranchAdmin] = useState<boolean>(false);
  const [branchAdminBranchId, setBranchAdminBranchId] = useState<string>("");
  const [branchAdminBranchName, setBranchAdminBranchName] = useState<string>("");
  const [salonName, setSalonName] = useState<string>("");
  const [logoUrl, setLogoUrl] = useState<string>("");
  const [authLoading, setAuthLoading] = useState<boolean>(true);
  const [pendingUnassignedCount, setPendingUnassignedCount] = useState<number>(0);
  const [showCalendarOnly, setShowCalendarOnly] = useState<boolean>(false);
  
  // Today's Schedule state
  const [todayBookings, setTodayBookings] = useState<any[]>([]);
  const [allBranches, setAllBranches] = useState<string[]>([]);
  const [allStaff, setAllStaff] = useState<any[]>([]);
  const [selectedBranch, setSelectedBranch] = useState<string | null>(null);
  const [selectedStaffId, setSelectedStaffId] = useState<string | null>(null);
  const [scheduleViewMode, setScheduleViewMode] = useState<'time' | 'staff' | 'branch'>('time');

  // Weekly calendar state
  const [calWeekStart, setCalWeekStart] = useState<Date>(() => {
    const d = new Date(); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); d.setHours(0,0,0,0); return d;
  });
  const [calBookings, setCalBookings] = useState<any[]>([]);
  const [calStaffFilter, setCalStaffFilter] = useState<string>("all");
  const [calStaffList, setCalStaffList] = useState<{id:string;name:string}[]>([]);
  const [calBranchFilter, setCalBranchFilter] = useState<string>("all");
  const [calBranchList, setCalBranchList] = useState<{ value: string; label: string }[]>([]);
  const [calHoverTooltip, setCalHoverTooltip] = useState<{ data: any; rect: DOMRect } | null>(null);
  const calTooltipTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  
  // Use notification context from NotificationProvider
  const { notifications, unreadCount, markAsRead, markAllAsRead, deleteNotification, deleteAllNotifications } = useNotifications();
  const [notificationPanelOpen, setNotificationPanelOpen] = useState(false);
  const [showDeleteAllModal, setShowDeleteAllModal] = useState(false);
  
  const revCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const statusCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const chartsRef = useRef<{ revenue?: any; status?: any }>({});
  const builtRef = useRef(false);

  const normalizeDateKey = (value: any): string => {
    if (!value) return "";
    if (typeof value === "string") {
      const v = value.trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
      if (/^\d{4}\/\d{2}\/\d{2}$/.test(v)) return v.replace(/\//g, "-");
      if (/^\d{2}\/\d{2}\/\d{4}$/.test(v)) {
        const [dd, mm, yyyy] = v.split("/");
        return `${yyyy}-${mm}-${dd}`;
      }
      const parsed = new Date(v);
      if (!isNaN(parsed.getTime())) {
        return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, "0")}-${String(parsed.getDate()).padStart(2, "0")}`;
      }
      return "";
    }
    if (typeof value?.toDate === "function") {
      const d = value.toDate();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    }
    return "";
  };

  // Notification sound is now handled by NotificationProvider

  // Authentication
  useEffect(() => {
    (async () => {
      const { auth, db } = await import("@/lib/firebase");
      const { doc, getDoc } = await import("firebase/firestore");
      const unsub = onAuthStateChanged(auth, async (user) => {
        if (!user) {
          router.replace("/login");
          return;
        }
        try {
          const token = await user.getIdToken();
          if (typeof window !== "undefined") localStorage.setItem("idToken", token);
          setCurrentUserUid(user.uid);
          setOwnerUid(user.uid);
          
          // Check if user is super admin or branch admin
          // Check super_admins collection first
          const superAdminDoc = await getDoc(doc(db, "super_admins", user.uid));
          let userData: any;
          let role: string;
          
          if (superAdminDoc.exists()) {
            // Super admin should go to admin dashboard
            router.replace("/admin-dashboard");
            return;
          }
          
            const userDoc = await getDoc(doc(db, "users", user.uid));
            userData = userDoc.data();
            role = userData?.role || "";
          
          // For branch admin, store their branch info
          if (role === "branch_admin") {
            setIsBranchAdmin(true);
            setBranchAdminBranchId(userData?.branchId || "");
            setBranchAdminBranchName(userData?.branchName || "");
            // Set the owner UID to their salon owner's UID for data fetching
            if (userData?.ownerUid) {
              setOwnerUid(userData.ownerUid);
            }
          }
          
          setIsSuperAdmin(false);
          setSalonName(userData?.name || userData?.displayName || userData?.branchName || "");
          setLogoUrl(userData?.logoUrl || "");
          setAuthLoading(false);
        } catch {
          router.replace("/login");
        }
      });
      return () => unsub();
    })();
  }, [router]);

  // Fetch real data from Firestore
  useEffect(() => {
    if (!ownerUid || isSuperAdmin || authLoading) return; // Skip salon-specific data for super_admin

    let unsubBookings: (() => void) | undefined;
    let unsubStaff: (() => void) | undefined;
    let unsubServices: (() => void) | undefined;

    (async () => {
      const { db } = await import("@/lib/firebase");

      // Subscribe to bookings
      const bookingsQuery = query(collection(db, "bookings"), where("ownerUid", "==", ownerUid));
      unsubBookings = onSnapshot(
        bookingsQuery,
        (snapshot) => {
        let bookings = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        
        // For branch admins, filter bookings by their branch
        if (isBranchAdmin && branchAdminBranchName) {
          bookings = bookings.filter((b: any) => b.branchName === branchAdminBranchName);
        }
        
        // Total bookings
        setTotalBookings(bookings.length);

        // Calculate monthly revenue (current month)
        const now = new Date();
        const currentMonth = now.getMonth();
        const currentYear = now.getFullYear();
        
        const currentMonthRevenue = bookings
          .filter((b: any) => {
            if (!b.date) return false;
            // Only count completed bookings for revenue
            const status = (b.status || '').toString().toLowerCase();
            if (status !== 'completed') return false;
            const bookingDate = new Date(b.date);
            return bookingDate.getMonth() === currentMonth && bookingDate.getFullYear() === currentYear;
          })
          .reduce((sum: number, b: any) => sum + (Number(b.price) || 0), 0);
        
        setMonthlyRevenue(currentMonthRevenue);

        // Calculate previous month revenue for growth comparison
        const prevMonth = currentMonth === 0 ? 11 : currentMonth - 1;
        const prevYear = currentMonth === 0 ? currentYear - 1 : currentYear;
        const prevMonthRevenue = bookings
          .filter((b: any) => {
            if (!b.date) return false;
            // Only count completed bookings for revenue
            const status = (b.status || '').toString().toLowerCase();
            if (status !== 'completed') return false;
            const bookingDate = new Date(b.date);
            return bookingDate.getMonth() === prevMonth && bookingDate.getFullYear() === prevYear;
          })
          .reduce((sum: number, b: any) => sum + (Number(b.price) || 0), 0);

        // Calculate growth percentage
        if (prevMonthRevenue > 0) {
          const growth = ((currentMonthRevenue - prevMonthRevenue) / prevMonthRevenue) * 100;
          setRevenueGrowth(Math.round(growth));
        } else if (currentMonthRevenue > 0) {
          setRevenueGrowth(100);
        } else {
          setRevenueGrowth(0);
        }

        // Calculate weekly bookings (last 7 days)
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
        const weeklyCount = bookings.filter((b: any) => {
          if (!b.date) return false;
          const bookingDate = new Date(b.date);
          return bookingDate >= sevenDaysAgo;
        }).length;
        setWeeklyBookings(weeklyCount);

        // Calculate revenue trend for last 6 months
        const last6Months: { month: string; revenue: number }[] = [];
        for (let i = 5; i >= 0; i--) {
          const date = new Date(currentYear, currentMonth - i, 1);
          const monthStr = date.toLocaleDateString('en-US', { month: 'short' });
          const month = date.getMonth();
          const year = date.getFullYear();
          
          const monthRevenue = bookings
            .filter((b: any) => {
              if (!b.date) return false;
              // Only count completed bookings for revenue
              const status = (b.status || '').toString().toLowerCase();
              if (status !== 'completed') return false;
              const bookingDate = new Date(b.date);
              return bookingDate.getMonth() === month && bookingDate.getFullYear() === year;
            })
            .reduce((sum: number, b: any) => sum + (Number(b.price) || 0), 0);
          
          last6Months.push({ month: monthStr, revenue: monthRevenue });
        }
        
        setRevenueLabels(last6Months.map(m => m.month));
        setRevenueData(last6Months.map(m => m.revenue));

        // Calculate booking status breakdown
        const statusCount = {
          confirmed: 0,
          pending: 0,
          completed: 0,
          canceled: 0
        };
        
        bookings.forEach((b: any) => {
          const status = (b.status || '').toLowerCase();
          if (status === 'confirmed') statusCount.confirmed++;
          else if (status === 'pending') statusCount.pending++;
          else if (status === 'completed') statusCount.completed++;
          else if (status === 'canceled' || status === 'cancelled') statusCount.canceled++;
        });
        
        setStatusData(statusCount);

        // Count pending bookings that need staff assignment
        const isBookingUnassigned = (b: any) => {
          const check = (staffId: string | null | undefined, staffName: string | null | undefined) => {
            if (!staffId || String(staffId).trim() === "" || staffId === "null") return true;
            const sn = (staffName ?? "").toLowerCase();
            return sn.includes("any") || sn.includes("not assigned");
          };
          if (check(b.staffId, b.staffName)) return true;
          const services = b.services;
          if (Array.isArray(services)) {
            for (const s of services) {
              if (s && check(s.staffId, s.staffName)) return true;
            }
          }
          return check(b.staffId, b.staffName);
        };
        let pendingUnassigned = 0;
        const seenIds = new Set<string>();
        for (const b of bookings as any[]) {
          const status = (b.status || "").toString().toLowerCase().trim();
          const isPendingStatus = status === "pending" || status.includes("awaiting") || status.includes("partially") || status === "staffrejected";
          if (!isPendingStatus || seenIds.has(b.id)) continue;
          if (isBookingUnassigned(b)) {
            seenIds.add(b.id);
            pendingUnassigned++;
          }
        }
        setPendingUnassignedCount(pendingUnassigned);
      },
      (error) => {
        if (error.code === "permission-denied") {
          console.warn("Permission denied for bookings query.");
          setTotalBookings(0);
          setMonthlyRevenue(0);
          setRevenueGrowth(0);
          setWeeklyBookings(0);
          setRevenueData([]);
          setRevenueLabels([]);
          setStatusData({ confirmed: 0, pending: 0, completed: 0, canceled: 0 });
          setPendingUnassignedCount(0);
        } else {
          console.error("Error in bookings snapshot:", error);
        }
      }
      );

      // Subscribe to staff from users collection (staff have ownerUid set)
      const staffQuery = query(collection(db, "users"), where("ownerUid", "==", ownerUid));
      unsubStaff = onSnapshot(
        staffQuery,
        async (snapshot) => {
          let staff = snapshot.docs
            .map(doc => ({ id: doc.id, ...doc.data() }))
            .filter((s: any) => {
              // Only count staff and branch_admin roles
              const role = (s.role || "").toLowerCase();
              return role === "staff" || role === "branch_admin";
            });
          
          // For branch admins, get staff from the branch document's staffIds array
          if (isBranchAdmin && branchAdminBranchId) {
            try {
              const { doc: getDocRef, getDoc } = await import("firebase/firestore");
              const branchDoc = await getDoc(getDocRef(db, "branches", branchAdminBranchId));
              if (branchDoc.exists()) {
                const branchData = branchDoc.data();
                const branchStaffIds = branchData?.staffIds || [];
                // Filter staff to only those in this branch
                staff = staff.filter((s: any) => branchStaffIds.includes(s.id));
              }
            } catch (err) {
              console.error("Error fetching branch for staff filter:", err);
            }
          }
          
          // Count active staff (those with status "Active" or no status set)
          const activeCount = staff.filter((s: any) => 
            !s.status || s.status === "Active"
          ).length;
          setActiveStaff(activeCount);
        },
        (error) => {
          if (error.code === "permission-denied") {
            console.warn("Permission denied for staff query.");
            setActiveStaff(0);
          } else {
            console.error("Error in staff snapshot:", error);
          }
        }
      );

      // Subscribe to services
      const servicesQuery = query(collection(db, "services"), where("ownerUid", "==", ownerUid));
      unsubServices = onSnapshot(
        servicesQuery,
        (snapshot) => {
          let services = snapshot.docs.map(doc => doc.data());
          
          // For branch admins, filter services by their branch if services have branch info
          if (isBranchAdmin && branchAdminBranchId) {
            services = services.filter((s: any) => 
              !s.branchId || s.branchId === branchAdminBranchId || s.branchIds?.includes(branchAdminBranchId)
            );
          }
          
          setActiveServices(services.length);
        },
        (error) => {
          if (error.code === "permission-denied") {
            console.warn("Permission denied for services query.");
            setActiveServices(0);
          } else {
            console.error("Error in services snapshot:", error);
          }
        }
      );
    })();

    return () => {
      unsubBookings?.();
      unsubStaff?.();
      unsubServices?.();
    };
  }, [ownerUid, isSuperAdmin, isBranchAdmin, branchAdminBranchId, branchAdminBranchName, authLoading]);

  // Fetch super_admin specific data (aggregate across all tenants)
  useEffect(() => {
    if (!isSuperAdmin || authLoading) return;

    let unsubTenants: (() => void) | undefined;
    let unsubAllBookings: (() => void) | undefined;

    (async () => {
      const { db } = await import("@/lib/firebase");
      const { collection, query, where, onSnapshot } = await import("firebase/firestore");

      // Fetch all tenants (salon owners)
      const tenantsQuery = query(collection(db, "users"), where("role", "==", "workshop_owner"));
      unsubTenants = onSnapshot(
        tenantsQuery,
        async (snapshot) => {
          const tenants = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
          
          // Count active tenants
          const activeTenants = tenants.filter((t: any) => {
            const status = (t.status || "").toLowerCase();
            return status.includes("active") && !status.includes("suspend");
          }).length;
          
          // Set active staff count to active tenants count for super_admin
          setActiveStaff(activeTenants);
          
          // Set active services to total tenants count
          setActiveServices(tenants.length);
        },
        (error) => {
          if (error.code === "permission-denied") {
            console.warn("Permission denied for tenants query.");
            setActiveStaff(0);
            setActiveServices(0);
          } else {
            console.error("Error in tenants snapshot:", error);
          }
        }
      );

      // Fetch all bookings across all tenants for aggregate revenue
      const allBookingsQuery = query(collection(db, "bookings"));
      unsubAllBookings = onSnapshot(
        allBookingsQuery,
        (snapshot) => {
          const allBookings = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
          
          // Total bookings across all tenants
          setTotalBookings(allBookings.length);

          // Calculate monthly revenue (current month) across all tenants
          const now = new Date();
          const currentMonth = now.getMonth();
          const currentYear = now.getFullYear();
          
          const currentMonthRevenue = allBookings
            .filter((b: any) => {
              if (!b.date) return false;
              // Only count completed bookings for revenue
              const status = (b.status || '').toString().toLowerCase();
              if (status !== 'completed') return false;
              const bookingDate = new Date(b.date);
              return bookingDate.getMonth() === currentMonth && bookingDate.getFullYear() === currentYear;
            })
            .reduce((sum: number, b: any) => sum + (Number(b.price) || 0), 0);
          
          setMonthlyRevenue(currentMonthRevenue);

          // Calculate previous month revenue for growth comparison
          const prevMonth = currentMonth === 0 ? 11 : currentMonth - 1;
          const prevYear = currentMonth === 0 ? currentYear - 1 : currentYear;
          const prevMonthRevenue = allBookings
            .filter((b: any) => {
              if (!b.date) return false;
              // Only count completed bookings for revenue
              const status = (b.status || '').toString().toLowerCase();
              if (status !== 'completed') return false;
              const bookingDate = new Date(b.date);
              return bookingDate.getMonth() === prevMonth && bookingDate.getFullYear() === prevYear;
            })
            .reduce((sum: number, b: any) => sum + (Number(b.price) || 0), 0);

          // Calculate growth percentage
          if (prevMonthRevenue > 0) {
            const growth = ((currentMonthRevenue - prevMonthRevenue) / prevMonthRevenue) * 100;
            setRevenueGrowth(Math.round(growth));
          } else if (currentMonthRevenue > 0) {
            setRevenueGrowth(100);
          } else {
            setRevenueGrowth(0);
          }

          // Calculate weekly bookings (last 7 days)
          const sevenDaysAgo = new Date();
          sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
          const weeklyCount = allBookings.filter((b: any) => {
            if (!b.date) return false;
            const bookingDate = new Date(b.date);
            return bookingDate >= sevenDaysAgo;
          }).length;
          setWeeklyBookings(weeklyCount);

          // Calculate revenue trend for last 6 months
          const last6Months: { month: string; revenue: number }[] = [];
          for (let i = 5; i >= 0; i--) {
            const date = new Date(currentYear, currentMonth - i, 1);
            const monthStr = date.toLocaleDateString('en-US', { month: 'short' });
            const month = date.getMonth();
            const year = date.getFullYear();
            
            const monthRevenue = allBookings
              .filter((b: any) => {
                if (!b.date) return false;
                // Only count completed bookings for revenue
                const status = (b.status || '').toString().toLowerCase();
                if (status !== 'completed') return false;
                const bookingDate = new Date(b.date);
                return bookingDate.getMonth() === month && bookingDate.getFullYear() === year;
              })
              .reduce((sum: number, b: any) => sum + (Number(b.price) || 0), 0);
            
            last6Months.push({ month: monthStr, revenue: monthRevenue });
          }
          
          setRevenueLabels(last6Months.map(m => m.month));
          setRevenueData(last6Months.map(m => m.revenue));

          // Calculate booking status breakdown
          const statusCount = {
            confirmed: 0,
            pending: 0,
            completed: 0,
            canceled: 0
          };
          
          allBookings.forEach((b: any) => {
            const status = (b.status || '').toLowerCase();
            if (status === 'confirmed') statusCount.confirmed++;
            else if (status === 'pending') statusCount.pending++;
            else if (status === 'completed') statusCount.completed++;
            else if (status === 'canceled' || status === 'cancelled') statusCount.canceled++;
          });
          
          setStatusData(statusCount);
        },
        (error) => {
          if (error.code === "permission-denied") {
            console.warn("Permission denied for all bookings query.");
            setTotalBookings(0);
            setMonthlyRevenue(0);
            setRevenueGrowth(0);
            setWeeklyBookings(0);
            setRevenueData([]);
            setRevenueLabels([]);
            setStatusData({ confirmed: 0, pending: 0, completed: 0, canceled: 0 });
          } else {
            console.error("Error in all bookings snapshot:", error);
          }
        }
      );
    })();

    return () => {
      unsubTenants?.();
      unsubAllBookings?.();
    };
  }, [isSuperAdmin, authLoading]);

  // Fetch today's schedule
  useEffect(() => {
    if (!ownerUid || isSuperAdmin || authLoading) return;

    let unsubTodayBookings: (() => void) | undefined;

    (async () => {
      const { db } = await import("@/lib/firebase");

      // Get today's date string
      const now = new Date();
      const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

      // Subscribe to today's bookings
      const todayQuery = query(
        collection(db, "bookings"),
        where("ownerUid", "==", ownerUid),
        where("date", "==", todayStr)
      );

      unsubTodayBookings = onSnapshot(
        todayQuery,
        (snapshot) => {
          const bookings: any[] = [];
          const branchNames = new Set<string>();
          const staffMap = new Map<string, { id: string; name: string }>();

          snapshot.docs.forEach(doc => {
            const data = doc.data();
            const status = (data.status || '').toLowerCase();

            // Skip cancelled bookings
            if (status === 'cancelled' || status === 'canceled' || status === 'staffrejected') {
              return;
            }

            const booking = {
              id: doc.id,
              time: data.time || '09:00',
              client: data.client || data.clientName || 'Customer',
              clientPhone: data.clientPhone || '',
              serviceName: data.serviceName || '',
              branchName: data.branchName || '',
              staffName: data.staffName || '',
              staffId: data.staffId || '',
              status: data.status || 'Pending',
              price: data.price || 0,
              services: data.services || [],
            };

            bookings.push(booking);

            // Collect branch names
            if (booking.branchName) {
              branchNames.add(booking.branchName);
            }

            // Collect staff from top-level
            if (booking.staffId && booking.staffName && !booking.staffName.toLowerCase().includes('any')) {
              staffMap.set(booking.staffId, { id: booking.staffId, name: booking.staffName });
            }

            // Collect staff from services array
            if (Array.isArray(data.services)) {
              data.services.forEach((svc: any) => {
                if (svc?.staffId && svc?.staffName && !svc.staffName.toLowerCase().includes('any')) {
                  staffMap.set(svc.staffId, { id: svc.staffId, name: svc.staffName });
                }
              });
            }
          });

          // Sort bookings by time
          bookings.sort((a, b) => (a.time || '').localeCompare(b.time || ''));

          setTodayBookings(bookings);
          setAllBranches([...branchNames].sort());
          setAllStaff([...staffMap.values()].sort((a, b) => a.name.localeCompare(b.name)));
        },
        (error) => {
          console.error("Error fetching today's schedule:", error);
          setTodayBookings([]);
        }
      );
    })();

    return () => {
      unsubTodayBookings?.();
    };
  }, [ownerUid, isSuperAdmin, authLoading]);

  // Fetch all branches for calendar filter (from branches collection, not just from bookings)
  useEffect(() => {
    if (!ownerUid || isSuperAdmin || authLoading) return;
    const unsub = subscribeBranchesForOwner(
      ownerUid,
      (rows) => {
        const list = rows.map((r: any) => ({
          value: r.id,
          label: r.name || r.address || r.id || "Branch",
        }));
        setCalBranchList(list.sort((a: any, b: any) => a.label.localeCompare(b.label)));
      },
      isBranchAdmin ? "branch_admin" : undefined,
      isBranchAdmin && currentUserUid ? currentUserUid : undefined
    );
    return () => unsub?.();
  }, [ownerUid, isSuperAdmin, authLoading, isBranchAdmin, currentUserUid]);

  // Fetch weekly calendar bookings
  useEffect(() => {
    if (!ownerUid || isSuperAdmin || authLoading) return;
    let unsub: (() => void) | undefined;

    (async () => {
      const { db } = await import("@/lib/firebase");
      const constraints: any[] = [where("ownerUid", "==", ownerUid)];

      unsub = onSnapshot(
        query(collection(db, "bookings"), ...constraints),
        (snap) => {
          const bks: any[] = [];
          snap.docs.forEach((d) => {
            const data = d.data();
            const st = (data.status || "").toLowerCase();
            if (st === "canceled" || st === "cancelled" || st === "staffrejected") return;
            const bk = {
              id: d.id,
              date: data.date || "",
              dateKey: normalizeDateKey(data.date),
              time: data.time || "09:00",
              pickupTime: data.pickupTime || "",
              duration: data.duration || 60,
              client: data.client || data.clientName || "Customer",
              clientPhone: data.clientPhone || "",
              clientEmail: data.clientEmail || "",
              notes: data.notes || "",
              serviceName: data.serviceName || (Array.isArray(data.services) ? data.services.map((s:any) => s.name).join(", ") : "Service"),
              branchId: data.branchId || "",
              branchName: data.branchName || "",
              staffName: data.staffName || "",
              staffId: data.staffId || "",
              status: data.status || "Pending",
              price: data.price || 0,
              services: data.services || [],
            };
            bks.push(bk);
          });
          setCalBookings(bks);
        },
        () => setCalBookings([])
      );
    })();

    return () => { unsub?.(); };
  }, [ownerUid, isSuperAdmin, authLoading, isBranchAdmin, branchAdminBranchId]);

  // Fetch all staff from users for calendar filter (not just those with bookings)
  useEffect(() => {
    if (!ownerUid || isSuperAdmin || authLoading) return;
    let unsubStaff: (() => void) | undefined;
    (async () => {
      const { db } = await import("@/lib/firebase");
      const staffQuery = query(
        collection(db, "users"),
        where("ownerUid", "==", ownerUid)
      );
      unsubStaff = onSnapshot(
        staffQuery,
        async (snap) => {
          let staff = snap.docs
            .map(doc => {
              const data = doc.data();
              const role = (data.role || "").toLowerCase();
              const name = (data.displayName || data.name || "").toString().trim() || "Unknown";
              return { id: doc.id, name, role };
            })
            .filter((s: { role: string }) => s.role === "staff" || s.role === "branch_admin");
          if (isBranchAdmin && branchAdminBranchId) {
            try {
              const { doc: getDocRef, getDoc } = await import("firebase/firestore");
              const branchDoc = await getDoc(getDocRef(db, "branches", branchAdminBranchId));
              if (branchDoc.exists()) {
                const branchData = branchDoc.data();
                const branchStaffIds = branchData?.staffIds || [];
                staff = staff.filter((s: { id: string }) => branchStaffIds.includes(s.id));
              }
            } catch {
              // ignore
            }
          }
          setCalStaffList(staff.sort((a, b) => a.name.localeCompare(b.name)));
        },
        () => setCalStaffList([])
      );
    })();
    return () => { unsubStaff?.(); };
  }, [ownerUid, isSuperAdmin, authLoading, isBranchAdmin, branchAdminBranchId]);

  useEffect(() => {
    if (isBranchAdmin && branchAdminBranchId) {
      setCalBranchFilter(branchAdminBranchId);
      return;
    }
    if (calBranchFilter !== "all" && !calBranchList.some((b) => b.value === calBranchFilter)) {
      setCalBranchFilter("all");
    }
  }, [isBranchAdmin, branchAdminBranchId, calBranchList, calBranchFilter]);

  // Notifications are now managed by NotificationProvider context
  // No need for duplicate listener here

  // Fetch recent activity (tenants for super admin, booking activities for salon owners)
  // Skip for branch admins since we hide that section for them
  useEffect(() => {
    if (!ownerUid || isBranchAdmin || authLoading) return;

    let unsubTenants: (() => void) | undefined;
    let unsubActivities: (() => void) | undefined;

    (async () => {
      const { db } = await import("@/lib/firebase");

      if (isSuperAdmin) {
        // For super admin, fetch recent tenants
        const tenantsQuery = query(
          collection(db, "users"),
          where("role", "==", "workshop_owner")
        );
        unsubTenants = onSnapshot(
          tenantsQuery,
          (snapshot) => {
            const tenants = snapshot.docs
              .map(doc => ({
                id: doc.id,
                ...doc.data(),
                createdAt: doc.data().createdAt
              }))
              .sort((a: any, b: any) => {
                // Sort by createdAt descending (newest first)
                const aTime = a.createdAt?.toMillis?.() || 0;
                const bTime = b.createdAt?.toMillis?.() || 0;
                return bTime - aTime;
              })
              .slice(0, 5); // Get 5 most recent
          
          setRecentTenants(tenants);
        },
        (error) => {
          if (error.code === "permission-denied") {
            console.warn("Permission denied for tenants query.");
            setRecentTenants([]);
          } else {
            console.error("Error in tenants snapshot:", error);
          }
        }
        );
      } else {
        // For salon owners, fetch recent booking activities
        // Note: Using simple query without orderBy to avoid index requirement
        // We'll sort client-side instead
        console.log("Fetching booking activities for ownerUid:", ownerUid);
        const activitiesQuery = query(
          collection(db, "bookingActivities"),
          where("ownerUid", "==", ownerUid)
        );
        unsubActivities = onSnapshot(
          activitiesQuery,
          (snapshot) => {
            console.log("Booking activities snapshot received:", snapshot.docs.length, "documents");
            const activities = snapshot.docs.map(doc => ({
              id: doc.id,
              ...doc.data(),
            }));
            // Sort by createdAt descending client-side
            activities.sort((a: any, b: any) => {
              const aTime = a.createdAt?.toMillis?.() || a.createdAt?.seconds * 1000 || 0;
              const bTime = b.createdAt?.toMillis?.() || b.createdAt?.seconds * 1000 || 0;
              return bTime - aTime;
            });
            // Take only 15 most recent
            setRecentActivities(activities.slice(0, 15));
          },
          (error) => {
            console.error("Booking activities error:", error.code, error.message);
            if (error.code === "permission-denied") {
              console.warn("Permission denied for booking activities query. Please update Firestore rules.");
              setRecentActivities([]);
            } else if (error.code === "failed-precondition") {
              // Index not created yet - this is expected initially
              console.warn("Booking activities index not ready. Please create bookings to populate activities.");
              setRecentActivities([]);
            } else {
              console.error("Error in booking activities snapshot:", error);
              setRecentActivities([]);
            }
          }
        );
      }
    })();

    return () => {
      unsubTenants?.();
      unsubActivities?.();
    };
  }, [ownerUid, isSuperAdmin, isBranchAdmin, authLoading]);

  // Track if charts have been initially built
  const chartsInitializedRef = useRef(false);
  const dataHashRef = useRef<string>("");

  // Initialize charts with Chart.js (loaded via CDN Script)
  const buildCharts = (animate: boolean = true) => {
    // @ts-ignore
    const Chart = (window as any)?.Chart;
    if (!Chart) return false;
    if (!revCanvasRef.current || !statusCanvasRef.current) return false;

    // Destroy existing instances to avoid duplicates
    try {
      chartsRef.current.revenue?.destroy();
    } catch {}
    try {
      chartsRef.current.status?.destroy();
    } catch {}

    // Revenue line + area with real data
    const revenueSeries = revenueData.length > 0 ? revenueData : [0, 0, 0, 0, 0, 0];
    const labels = revenueLabels.length > 0 ? revenueLabels : ["Jan", "Feb", "Mar", "Apr", "May", "Jun"];
    const ctx = revCanvasRef.current?.getContext("2d");
    let gradient: CanvasGradient | undefined;
    if (ctx) {
      gradient = ctx.createLinearGradient(0, 0, 0, 300);
      gradient.addColorStop(0, "rgba(23, 23, 23, 0.15)");
      gradient.addColorStop(1, "rgba(23, 23, 23, 0)");
    }
    const revenue = new Chart(ctx as any, {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "Revenue",
            data: revenueSeries,
            borderColor: "#171717",
            backgroundColor: gradient,
            fill: true,
            tension: 0.4,
            pointRadius: 4,
            pointHoverRadius: 6,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: animate ? { duration: 750 } : false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { display: false }, ticks: { color: "#a3a3a3" } },
          y: {
            grid: { color: "#e5e5e5" },
            ticks: {
              color: "#a3a3a3",
              callback: function (value: number) {
                const v = Number(value);
                if (v >= 1000) {
                  return `AU$${Math.round(v / 1000)}k`;
                }
                return `AU$${v}`;
              },
            },
          },
        },
      },
    });

    // Booking status donut with real data
    const ctx2 = statusCanvasRef.current?.getContext("2d");
    const statusLabels: string[] = [];
    const statusValues: number[] = [];
    const statusColors: string[] = [];
    
    if (statusData.confirmed > 0) {
      statusLabels.push("Confirmed");
      statusValues.push(statusData.confirmed);
      statusColors.push("#10b981");
    }
    if (statusData.pending > 0) {
      statusLabels.push("Pending");
      statusValues.push(statusData.pending);
      statusColors.push("#f59e0b");
    }
    if (statusData.completed > 0) {
      statusLabels.push("Completed");
      statusValues.push(statusData.completed);
      statusColors.push("#3b82f6");
    }
    if (statusData.canceled > 0) {
      statusLabels.push("Canceled");
      statusValues.push(statusData.canceled);
      statusColors.push("#ef4444");
    }

    // If no data, show empty state
    if (statusValues.length === 0) {
      statusLabels.push("No Data");
      statusValues.push(1);
      statusColors.push("#e5e7eb");
    }

    const status = new Chart(ctx2 as any, {
      type: "doughnut",
      data: {
        labels: statusLabels,
        datasets: [
          {
            data: statusValues,
            backgroundColor: statusColors,
            borderWidth: 0,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: animate ? { duration: 750 } : false,
        cutout: "70%",
        plugins: {
          legend: { display: true, position: "right", labels: { color: "#737373" } },
        },
      },
    });

    chartsRef.current = { revenue, status };
    builtRef.current = true;
    return true;
  };

  // Build charts when data changes
  useEffect(() => {
    // Create a hash of the data to detect actual changes
    const currentDataHash = JSON.stringify({ revenueData, revenueLabels, statusData });
    const dataChanged = dataHashRef.current !== currentDataHash;
    
    // Only animate on first build, not on subsequent data updates
    const shouldAnimate = !chartsInitializedRef.current;
    
    const tryBuild = () => {
      // @ts-ignore
      const Chart = (window as any)?.Chart;
      if (Chart && revCanvasRef.current && statusCanvasRef.current) {
        const success = buildCharts(shouldAnimate);
        if (success) {
          chartsInitializedRef.current = true;
          dataHashRef.current = currentDataHash;
          return true;
        }
      }
      return false;
    };

    // If charts are already built and data hasn't changed, skip
    if (chartsInitializedRef.current && !dataChanged) {
      return;
    }

    // Try to build immediately
    if (tryBuild()) {
      return;
    }

    // If Chart.js isn't loaded yet, poll until it is (but stop after success)
    let attempts = 0;
    const maxAttempts = 50; // 10 seconds max
    const id = setInterval(() => {
      attempts++;
      if (tryBuild() || attempts >= maxAttempts) {
        clearInterval(id);
      }
    }, 200);

    return () => {
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revenueData, revenueLabels, statusData]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      try {
        chartsRef.current.revenue?.destroy();
      } catch {}
      try {
        chartsRef.current.status?.destroy();
      } catch {}
    };
  }, []);

  return (
    <div id="app" className="flex h-screen overflow-hidden bg-white">
      <Sidebar />
      <div className="flex-1 flex flex-col overflow-hidden">
        {authLoading ? (
          <div className="flex-1 flex items-center justify-center bg-neutral-50">
            <div className="text-center">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-neutral-900 mx-auto mb-4"></div>
              <p className="text-neutral-600">Loading dashboard...</p>
            </div>
          </div>
        ) : (
        <main className="flex-1 overflow-auto p-4 sm:p-6 lg:p-8">
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
              <div
                className="absolute inset-0 bg-black/40"
                onClick={() => setMobileOpen(false)}
              />
              <div className="absolute left-0 top-0 bottom-0">
                <Sidebar mobile onClose={() => setMobileOpen(false)} />
              </div>
            </div>
          )}

          <div className="mb-8">
            <div className="relative rounded-2xl bg-neutral-900 text-white p-8 shadow-lg overflow-hidden">
              {/* Decorative Background */}
              <div className="absolute inset-0 overflow-hidden">
                <div className="absolute -top-6 -right-6 w-36 h-36 rounded-full bg-amber-500/10" />
                <div className="absolute -bottom-10 -left-10 w-44 h-44 rounded-full bg-amber-500/5" />
                <div className="absolute top-1/3 right-1/4 w-2 h-2 rounded-full bg-amber-400/30" />
                <div className="absolute bottom-6 right-1/3 w-1.5 h-1.5 rounded-full bg-amber-400/20" />
                <i className="fas fa-gear absolute -right-3 -bottom-3 text-[90px] text-white/[0.03] rotate-12" />
                <i className="fas fa-gear absolute right-20 -top-5 text-[55px] text-white/[0.03] -rotate-6" />
              </div>
              <div className="relative flex items-center justify-between">
                <div className="flex items-center gap-4">
                  {logoUrl ? (
                    <div className="w-14 h-14 rounded-2xl bg-white p-1.5 shadow-lg">
                      <img src={logoUrl} alt="Workshop Logo" className="w-full h-full object-contain rounded-xl" />
                    </div>
                  ) : (
                    <div className="w-14 h-14 rounded-2xl bg-amber-500/20 border border-amber-500/30 flex items-center justify-center">
                      <i className="fas fa-gauge-high text-2xl text-amber-400" />
                    </div>
                  )}
                  <div>
                    <h1 className="text-2xl font-bold tracking-tight">
                      {isSuperAdmin ? "BMS Pro Admin" : (isBranchAdmin ? branchAdminBranchName : (salonName || "Dashboard"))}
                    </h1>
                    <p className="text-neutral-400 mt-0.5">
                      {isSuperAdmin ? "Super Admin Dashboard" : (isBranchAdmin ? "Branch Dashboard" : (salonName ? "Business Overview" : "Real-time system overview"))}
                    </p>
                  </div>
                </div>

                {/* Right side - Calendar, Pending request, Notifications */}
                <div className="flex items-center gap-3">
                  {!isSuperAdmin && (
                    <>
                      <button
                        onClick={() => setShowCalendarOnly(!showCalendarOnly)}
                        className={`flex items-center gap-2 px-4 py-2.5 rounded-xl font-semibold text-sm transition-all ${
                          showCalendarOnly ? "bg-white/20 text-white" : "bg-white/10 hover:bg-white/20 text-white/90"
                        }`}
                        title={showCalendarOnly ? "Show full dashboard" : "Show calendar only"}
                      >
                        <i className="fas fa-calendar-week" />
                        <span>Calendar</span>
                      </button>
                      {pendingUnassignedCount > 0 && (
                        <button
                          onClick={() => router.push("/bookings/pending")}
                          className="relative flex items-center gap-2 px-4 py-2.5 rounded-xl bg-amber-500/20 hover:bg-amber-500/30 border border-amber-400/40 text-amber-100 font-semibold text-sm transition-all"
                          title="Pending requests need staff assignment"
                        >
                          <i className="fas fa-user-clock" />
                          <span>Pending request</span>
                          <span className="min-w-[20px] h-5 px-1.5 bg-amber-500 text-white text-xs font-bold rounded-full flex items-center justify-center">
                            {pendingUnassignedCount > 9 ? "9+" : pendingUnassignedCount}
                          </span>
                        </button>
                      )}
                    </>
                  )}
                  <button 
                    onClick={() => setNotificationPanelOpen(!notificationPanelOpen)}
                    className={`relative w-12 h-12 rounded-xl flex items-center justify-center transition-all group ${
                      notificationPanelOpen ? 'bg-white/20' : 'bg-white/10 hover:bg-white/20'
                    }`}
                    title="Notifications"
                  >
                    <i className={`fas fa-bell text-lg text-white/80 ${unreadCount > 0 ? 'animate-pulse' : ''}`} />
                    {unreadCount > 0 && (
                      <span className="absolute -top-1 -right-1 w-5 h-5 bg-red-500 text-white text-xs font-bold rounded-full flex items-center justify-center shadow-lg border-2 border-neutral-900 animate-bounce">
                        {unreadCount > 9 ? '9+' : unreadCount}
                      </span>
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>
          {!showCalendarOnly && (
          <>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
            <div className="bg-white p-6 rounded-2xl border border-neutral-200 shadow-sm min-w-0">
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm font-medium text-neutral-600">
                  {isSuperAdmin ? "Platform Revenue" : "Monthly Revenue"}
                </span>
                <div className="w-10 h-10 bg-emerald-50 rounded-xl flex items-center justify-center">
                  <i className="fas fa-dollar-sign text-emerald-600" />
                </div>
              </div>
              <div className="mb-2">
                <h3 className="text-3xl font-bold text-neutral-900">AU${monthlyRevenue.toLocaleString()}</h3>
              </div>
              <div className="flex items-center space-x-2">
                {revenueGrowth !== 0 && (
                  <span className={`px-2 py-1 rounded-lg text-xs font-semibold flex items-center ${
                    revenueGrowth > 0 
                      ? "bg-emerald-50 text-emerald-700" 
                      : "bg-rose-50 text-rose-700"
                  }`}>
                    <i className={`fas fa-arrow-${revenueGrowth > 0 ? 'up' : 'down'} text-xs mr-1`} />
                    {revenueGrowth > 0 ? '+' : ''}{revenueGrowth}%
                  </span>
                )}
                <span className="text-xs text-neutral-500">vs last month</span>
              </div>
            </div>
            <div className="bg-white p-6 rounded-2xl border border-neutral-200 shadow-sm min-w-0">
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm font-medium text-neutral-600">
                  {isSuperAdmin ? "Total Bookings" : "Total Bookings"}
                </span>
                <div className="w-10 h-10 bg-blue-50 rounded-xl flex items-center justify-center">
                  <i className="fas fa-calendar-check text-blue-500" />
                </div>
              </div>
              <div className="mb-2">
                <h3 className="text-3xl font-bold text-neutral-900">{totalBookings}</h3>
              </div>
              <div className="flex items-center space-x-2">
                <span className="px-2 py-1 bg-emerald-50 text-emerald-700 rounded-lg text-xs font-semibold flex items-center">
                  <i className="fas fa-plus text-xs mr-1" />
                  +{weeklyBookings}
                </span>
                <span className="text-xs text-neutral-500">this week</span>
              </div>
            </div>
            <div className="bg-white p-6 rounded-2xl border border-neutral-200 shadow-sm min-w-0">
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm font-medium text-neutral-600">
                  {isSuperAdmin ? "Active Tenants" : "Active Staff"}
                </span>
                <div className="w-10 h-10 bg-amber-50 rounded-xl flex items-center justify-center">
                  <i className={`fas ${isSuperAdmin ? 'fa-store' : 'fa-users'} text-amber-500`} />
                </div>
              </div>
              <div className="mb-2">
                <h3 className="text-3xl font-bold text-neutral-900">{activeStaff}</h3>
              </div>
              <div className="text-xs text-neutral-500">{isSuperAdmin ? "Active workshop owners" : "Available for booking"}</div>
            </div>
            <div className="bg-white p-6 rounded-2xl border border-neutral-200 shadow-sm min-w-0">
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm font-medium text-neutral-600">
                  {isSuperAdmin ? "Total Tenants" : "Active Services"}
                </span>
                <div className="w-10 h-10 bg-purple-50 rounded-xl flex items-center justify-center">
                  <i className={`fas ${isSuperAdmin ? 'fa-building' : 'fa-tags'} text-purple-500`} />
                </div>
              </div>
              <div className="mb-2">
                <h3 className="text-3xl font-bold text-neutral-900">{activeServices}</h3>
              </div>
              <div className="text-xs text-neutral-500">{isSuperAdmin ? "All registered tenants" : "In catalog"}</div>
            </div>
          </div>
          
          {/* Today's Schedule Section */}
          {!authLoading && !isSuperAdmin && (
            <div className="bg-white rounded-2xl border border-neutral-200 shadow-sm mb-8">
              <div className="p-6 border-b border-neutral-200">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-neutral-100 rounded-xl flex items-center justify-center">
                      <i className="fas fa-calendar-day text-neutral-600" />
                    </div>
                    <div>
                      <h3 className="font-semibold text-lg text-neutral-900">Today's Schedule</h3>
                      <p className="text-sm text-neutral-500">
                        {new Date().toLocaleDateString('en-AU', { weekday: 'short', month: 'short', day: 'numeric' })}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="px-3 py-1.5 bg-neutral-100 text-neutral-700 rounded-full text-sm font-semibold">
                      {(() => {
                        let filtered = todayBookings;
                        // Auto-filter by branch admin's branch
                        if (isBranchAdmin && branchAdminBranchName) {
                          filtered = filtered.filter(b => b.branchName === branchAdminBranchName);
                        } else if (selectedBranch) {
                          filtered = filtered.filter(b => b.branchName === selectedBranch);
                        }
                        if (selectedStaffId) {
                          filtered = filtered.filter(b => {
                            if (b.staffId === selectedStaffId) return true;
                            return b.services?.some((s: any) => s.staffId === selectedStaffId);
                          });
                        }
                        return filtered.length;
                      })()} bookings
                    </span>
                  </div>
                </div>
                
                {/* View mode toggle and filters */}
                <div className="mt-4 flex flex-wrap items-center gap-3">
                  {/* View mode toggle */}
                  <div className="flex bg-neutral-100 rounded-lg p-1">
                    <button
                      onClick={() => setScheduleViewMode('time')}
                      className={`px-3 py-1.5 rounded-md text-sm font-medium transition-all ${
                        scheduleViewMode === 'time' 
                          ? 'bg-white text-neutral-900 shadow-sm font-semibold' 
                          : 'text-neutral-500 hover:text-neutral-900'
                      }`}
                    >
                      <i className="fas fa-clock mr-1.5" />Time
                    </button>
                    <button
                      onClick={() => setScheduleViewMode('staff')}
                      className={`px-3 py-1.5 rounded-md text-sm font-medium transition-all ${
                        scheduleViewMode === 'staff' 
                          ? 'bg-white text-neutral-900 shadow-sm font-semibold' 
                          : 'text-neutral-500 hover:text-neutral-900'
                      }`}
                    >
                      <i className="fas fa-users mr-1.5" />Staff
                    </button>
                    {/* Hide Branch view for branch admins - they only see their branch */}
                    {!isBranchAdmin && (
                      <button
                        onClick={() => setScheduleViewMode('branch')}
                        className={`px-3 py-1.5 rounded-md text-sm font-medium transition-all ${
                          scheduleViewMode === 'branch' 
                            ? 'bg-white text-neutral-900 shadow-sm font-semibold' 
                            : 'text-neutral-500 hover:text-neutral-900'
                        }`}
                      >
                        <i className="fas fa-store mr-1.5" />Branch
                      </button>
                    )}
                  </div>
                  
                  {/* Branch filter - hide for branch admins */}
                  {allBranches.length > 0 && !isBranchAdmin && (
                    <select
                      value={selectedBranch || ''}
                      onChange={(e) => setSelectedBranch(e.target.value || null)}
                      className="px-3 py-1.5 bg-white border border-neutral-200 rounded-lg text-sm text-neutral-700 focus:outline-none focus:ring-2 focus:ring-neutral-900"
                    >
                      <option value="">All Branches</option>
                      {allBranches.map(branch => (
                        <option key={branch} value={branch}>{branch}</option>
                      ))}
                    </select>
                  )}
                  
                  {/* Show branch name badge for branch admins */}
                  {isBranchAdmin && branchAdminBranchName && (
                    <div className="px-3 py-1.5 bg-purple-50 text-purple-700 rounded-lg text-sm font-medium flex items-center gap-2">
                      <i className="fas fa-store" />
                      {branchAdminBranchName}
                    </div>
                  )}
                  
                  {/* Staff filter */}
                  {allStaff.length > 0 && (
                    <select
                      value={selectedStaffId || ''}
                      onChange={(e) => setSelectedStaffId(e.target.value || null)}
                      className="px-3 py-1.5 bg-white border border-neutral-200 rounded-lg text-sm text-neutral-700 focus:outline-none focus:ring-2 focus:ring-neutral-900"
                    >
                      <option value="">All Staff</option>
                      {(() => {
                        // For branch admins, only show staff from their branch's bookings
                        if (isBranchAdmin && branchAdminBranchName) {
                          const branchBookings = todayBookings.filter(b => b.branchName === branchAdminBranchName);
                          const branchStaffMap = new Map<string, string>();
                          branchBookings.forEach(b => {
                            if (b.staffId && b.staffName) branchStaffMap.set(b.staffId, b.staffName);
                            b.services?.forEach((s: any) => {
                              if (s.staffId && s.staffName) branchStaffMap.set(s.staffId, s.staffName);
                            });
                          });
                          return [...branchStaffMap.entries()]
                            .sort((a, b) => a[1].localeCompare(b[1]))
                            .map(([id, name]) => (
                              <option key={id} value={id}>{name}</option>
                            ));
                        }
                        return allStaff.map(staff => (
                          <option key={staff.id} value={staff.id}>{staff.name}</option>
                        ));
                      })()}
                    </select>
                  )}
                  
                  {/* Clear filters */}
                  {(selectedBranch || selectedStaffId) && (
                    <button
                      onClick={() => { setSelectedBranch(null); setSelectedStaffId(null); }}
                      className="px-3 py-1.5 bg-rose-50 text-rose-600 rounded-lg text-sm font-medium hover:bg-rose-100 transition-colors"
                    >
                      <i className="fas fa-times mr-1.5" />Clear
                    </button>
                  )}
                </div>
              </div>
              
              {/* Schedule content */}
              <div className="p-6">
                {(() => {
                  // Filter bookings
                  let filtered = todayBookings;
                  
                  // Auto-filter by branch admin's branch
                  if (isBranchAdmin && branchAdminBranchName) {
                    filtered = filtered.filter(b => b.branchName === branchAdminBranchName);
                  } else if (selectedBranch) {
                    filtered = filtered.filter(b => b.branchName === selectedBranch);
                  }
                  
                  if (selectedStaffId) {
                    filtered = filtered.filter(b => {
                      if (b.staffId === selectedStaffId) return true;
                      return b.services?.some((s: any) => s.staffId === selectedStaffId);
                    });
                  }

                  if (filtered.length === 0) {
                    return (
                      <div className="text-center py-12">
                        <i className="fas fa-calendar-xmark text-5xl text-neutral-300 mb-4" />
                        <p className="text-neutral-500 font-medium">No bookings for today</p>
                        <p className="text-neutral-400 text-sm mt-1">Bookings will appear here as they are scheduled</p>
                      </div>
                    );
                  }

                  // Group bookings based on view mode
                  if (scheduleViewMode === 'time') {
                    // Flatten bookings - if a booking has multiple services with different times, show each separately
                    interface TimeSlotEntry {
                      bookingId: string;
                      time: string;
                      client: string;
                      clientPhone: string;
                      serviceName: string;
                      staffName: string;
                      staffId: string;
                      branchName: string;
                      status: string;
                      price: number;
                      duration: number;
                      isMultiService: boolean;
                      totalServices: number;
                      serviceIndex: number;
                      totalPrice: number;
                    }
                    
                    const timeSlotEntries: TimeSlotEntry[] = [];
                    
                    filtered.forEach(b => {
                      const hasMultipleServices = b.services?.length > 1;
                      const totalPrice = b.price || b.services?.reduce((sum: number, s: any) => sum + (Number(s.price) || 0), 0) || 0;
                      
                      if (b.services?.length > 0) {
                        // Show each service with its own time slot
                        b.services.forEach((svc: any, idx: number) => {
                          timeSlotEntries.push({
                            bookingId: b.id,
                            time: svc.time || b.time || '09:00',
                            client: b.client,
                            clientPhone: b.clientPhone || '',
                            serviceName: svc.name || 'Service',
                            staffName: svc.staffName || b.staffName || '',
                            staffId: svc.staffId || b.staffId || '',
                            branchName: b.branchName || '',
                            status: b.status,
                            price: Number(svc.price) || 0,
                            duration: Number(svc.duration) || 30,
                            isMultiService: hasMultipleServices,
                            totalServices: b.services.length,
                            serviceIndex: idx + 1,
                            totalPrice,
                          });
                        });
                      } else {
                        // Single service booking
                        timeSlotEntries.push({
                          bookingId: b.id,
                          time: b.time || '09:00',
                          client: b.client,
                          clientPhone: b.clientPhone || '',
                          serviceName: b.serviceName || 'Service',
                          staffName: b.staffName || '',
                          staffId: b.staffId || '',
                          branchName: b.branchName || '',
                          status: b.status,
                          price: Number(b.price) || 0,
                          duration: 30,
                          isMultiService: false,
                          totalServices: 1,
                          serviceIndex: 1,
                          totalPrice: Number(b.price) || 0,
                        });
                      }
                    });
                    
                    // Sort by time
                    timeSlotEntries.sort((a, b) => a.time.localeCompare(b.time));
                    
                    // Group by time slot (exact time, not hour)
                    const byTime: Record<string, TimeSlotEntry[]> = {};
                    timeSlotEntries.forEach(entry => {
                      if (!byTime[entry.time]) byTime[entry.time] = [];
                      byTime[entry.time].push(entry);
                    });

                    const formatTime = (time: string) => {
                      const [h, m] = time.split(':').map(Number);
                      const ampm = h >= 12 ? 'PM' : 'AM';
                      const hour = h > 12 ? h - 12 : h === 0 ? 12 : h;
                      return `${hour}:${String(m).padStart(2, '0')} ${ampm}`;
                    };

                    const formatDuration = (mins: number) => {
                      if (mins >= 60) {
                        const h = Math.floor(mins / 60);
                        const m = mins % 60;
                        return m > 0 ? `${h}h ${m}m` : `${h}h`;
                      }
                      return `${mins}m`;
                    };

                    // Calculate end time
                    const getEndTime = (startTime: string, duration: number) => {
                      const [h, m] = startTime.split(':').map(Number);
                      const totalMins = h * 60 + m + duration;
                      const endH = Math.floor(totalMins / 60) % 24;
                      const endM = totalMins % 60;
                      return `${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}`;
                    };

                    return (
                      <div className="space-y-4">
                        {Object.keys(byTime).sort().map(time => (
                          <div key={time} className="relative">
                            {/* Time marker */}
                            <div className="flex items-center gap-3 mb-3">
                              <div className="flex items-center gap-2 bg-neutral-900 text-white px-3 py-1.5 rounded-full shadow-sm">
                                <i className="fas fa-clock text-xs text-amber-400" />
                                <span className="text-sm font-bold">{formatTime(time)}</span>
                              </div>
                              <div className="flex-1 h-px bg-gradient-to-r from-neutral-300 to-transparent" />
                              <span className="text-xs font-medium text-neutral-500 bg-neutral-100 px-2 py-1 rounded-full">
                                {byTime[time].length} {byTime[time].length === 1 ? 'service' : 'services'}
                              </span>
                            </div>
                            
                            {/* Appointments at this time */}
                            <div className="ml-4 space-y-3">
                              {byTime[time].map((entry, idx) => (
                                <div 
                                  key={`${entry.bookingId}-${entry.serviceIndex}-${idx}`}
                                  className={`relative overflow-hidden rounded-xl border transition-all hover:shadow-lg ${
                                    entry.status.toLowerCase() === 'confirmed' 
                                      ? 'border-emerald-200 bg-gradient-to-br from-emerald-50/50 to-white' 
                                      : entry.status.toLowerCase() === 'completed'
                                      ? 'border-blue-200 bg-gradient-to-br from-blue-50/50 to-white'
                                      : 'border-amber-200 bg-gradient-to-br from-amber-50/50 to-white'
                                  }`}
                                >
                                  {/* Status indicator bar */}
                                  <div className={`absolute left-0 top-0 bottom-0 w-1 ${
                                    entry.status.toLowerCase() === 'confirmed' ? 'bg-emerald-500' :
                                    entry.status.toLowerCase() === 'completed' ? 'bg-blue-500' :
                                    'bg-amber-500'
                                  }`} />
                                  
                                  <div className="p-4 pl-5">
                                    {/* Header row */}
                                    <div className="flex items-start justify-between mb-3">
                                      <div className="flex items-center gap-3">
                                        {/* Client avatar */}
                                        <div className="w-10 h-10 bg-neutral-900 rounded-full flex items-center justify-center text-white font-bold text-sm shadow-md">
                                          {entry.client?.charAt(0)?.toUpperCase() || '?'}
                                        </div>
                                        <div>
                                          <h4 className="font-semibold text-neutral-900">{entry.client}</h4>
                                          {entry.clientPhone && (
                                            <p className="text-xs text-neutral-500">
                                              <i className="fas fa-phone mr-1" />{entry.clientPhone}
                                            </p>
                                          )}
                                        </div>
                                      </div>
                                      
                                      {/* Status badge */}
                                      <div className="flex flex-col items-end gap-1">
                                        <span className={`px-2.5 py-1 rounded-full text-xs font-semibold ${
                                          entry.status.toLowerCase() === 'confirmed' ? 'bg-emerald-100 text-emerald-700' :
                                          entry.status.toLowerCase() === 'completed' ? 'bg-blue-100 text-blue-700' :
                                          'bg-amber-100 text-amber-700'
                                        }`}>
                                          <i className={`fas ${
                                            entry.status.toLowerCase() === 'confirmed' ? 'fa-check-circle' :
                                            entry.status.toLowerCase() === 'completed' ? 'fa-check-double' :
                                            'fa-clock'
                                          } mr-1`} />
                                          {entry.status}
                                        </span>
                                        {entry.isMultiService && (
                                          <span className="text-[10px] text-neutral-400">
                                            Service {entry.serviceIndex}/{entry.totalServices}
                                          </span>
                                        )}
                                      </div>
                                    </div>
                                    
                                    {/* Service details */}
                                    <div className="bg-white/60 rounded-lg p-3 mb-3">
                                      <div className="flex items-center justify-between">
                                        <div className="flex items-center gap-2">
                                          <div className="w-8 h-8 bg-neutral-100 rounded-lg flex items-center justify-center">
                                            <i className="fas fa-wrench text-neutral-600 text-sm" />
                                          </div>
                                          <div>
                                            <p className="font-medium text-neutral-900">{entry.serviceName}</p>
                                            <div className="flex items-center gap-2 text-xs text-neutral-500">
                                              <span><i className="fas fa-hourglass-half mr-1" />{formatDuration(entry.duration)}</span>
                                              <span>•</span>
                                              <span>{formatTime(entry.time)} - {formatTime(getEndTime(entry.time, entry.duration))}</span>
                                            </div>
                                          </div>
                                        </div>
                                        <div className="text-right">
                                          <p className="font-bold text-neutral-900">AU${entry.price.toLocaleString()}</p>
                                          {entry.isMultiService && (
                                            <p className="text-[10px] text-neutral-400">Total: AU${entry.totalPrice.toLocaleString()}</p>
                                          )}
                                        </div>
                                      </div>
                                    </div>
                                    
                                    {/* Footer with staff and branch */}
                                    <div className="flex flex-wrap items-center gap-2">
                                      {entry.staffName && !entry.staffName.toLowerCase().includes('any') && (
                                        <div className="flex items-center gap-2 bg-indigo-50 px-2.5 py-1.5 rounded-lg">
                                          <div className="w-6 h-6 bg-indigo-200 rounded-full flex items-center justify-center">
                                            <i className="fas fa-user text-indigo-600 text-[10px]" />
                                          </div>
                                          <span className="text-xs font-medium text-indigo-700">{entry.staffName}</span>
                                        </div>
                                      )}
                                      {entry.branchName && (
                                        <div className="flex items-center gap-2 bg-blue-50 px-2.5 py-1.5 rounded-lg">
                                          <div className="w-6 h-6 bg-blue-200 rounded-full flex items-center justify-center">
                                            <i className="fas fa-store text-blue-600 text-[10px]" />
                                          </div>
                                          <span className="text-xs font-medium text-blue-700">{entry.branchName}</span>
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    );
                  }

                  if (scheduleViewMode === 'staff') {
                    // Group by staff - use Map to avoid duplicates
                    const byStaff: Record<string, { name: string; bookings: typeof filtered }> = {};
                    filtered.forEach(b => {
                      // Use Map to track unique staff for this booking
                      const uniqueStaff = new Map<string, string>();
                      
                      // Check top-level staff
                      if (b.staffId && b.staffName && !b.staffName.toLowerCase().includes('any')) {
                        uniqueStaff.set(b.staffId, b.staffName);
                      }
                      
                      // Check services array
                      if (b.services?.length) {
                        b.services.forEach((s: any) => {
                          if (s.staffId && s.staffName && !s.staffName.toLowerCase().includes('any')) {
                            if (!uniqueStaff.has(s.staffId)) {
                              uniqueStaff.set(s.staffId, s.staffName);
                            }
                          }
                        });
                      }
                      
                      if (uniqueStaff.size === 0) {
                        uniqueStaff.set('unassigned', 'Unassigned');
                      }
                      
                      uniqueStaff.forEach((name, id) => {
                        if (!byStaff[id]) byStaff[id] = { name, bookings: [] };
                        byStaff[id].bookings.push(b);
                      });
                    });

                    // Helper functions
                    const formatTime = (time: string) => {
                      const [h, m] = time.split(':').map(Number);
                      const ampm = h >= 12 ? 'PM' : 'AM';
                      const hour = h > 12 ? h - 12 : h === 0 ? 12 : h;
                      return `${hour}:${String(m).padStart(2, '0')} ${ampm}`;
                    };

                    const getTotalRevenue = (bookings: typeof filtered) => {
                      return bookings
                        .filter((b: any) => {
                          // Only count completed bookings for revenue
                          const status = (b.status || '').toString().toLowerCase();
                          return status === 'completed';
                        })
                        .reduce((sum, b) => {
                          const price = b.price || b.services?.reduce((s: number, svc: any) => s + (Number(svc.price) || 0), 0) || 0;
                          return sum + price;
                        }, 0);
                    };

                    const getTotalDuration = (bookings: typeof filtered) => {
                      return bookings.reduce((sum, b) => {
                        const dur = b.services?.reduce((s: number, svc: any) => s + (Number(svc.duration) || 30), 0) || 30;
                        return sum + dur;
                      }, 0);
                    };

                    const formatDuration = (mins: number) => {
                      if (mins >= 60) {
                        const h = Math.floor(mins / 60);
                        const m = mins % 60;
                        return m > 0 ? `${h}h ${m}m` : `${h}h`;
                      }
                      return `${mins}m`;
                    };

                    const staffColors = [
                      { bg: 'from-neutral-800 to-neutral-900', light: 'neutral' },
                      { bg: 'from-neutral-700 to-neutral-800', light: 'neutral' },
                      { bg: 'from-neutral-800 to-neutral-900', light: 'neutral' },
                      { bg: 'from-neutral-700 to-neutral-800', light: 'neutral' },
                      { bg: 'from-neutral-800 to-neutral-900', light: 'neutral' },
                    ];

                    return (
                      <div className="space-y-6">
                        {Object.entries(byStaff).sort((a, b) => a[1].name.localeCompare(b[1].name)).map(([staffId, { name, bookings }], staffIdx) => {
                          const colorScheme = staffColors[staffIdx % staffColors.length];
                          const totalRevenue = getTotalRevenue(bookings);
                          const totalDuration = getTotalDuration(bookings);
                          const sortedBookings = [...bookings].sort((a, b) => (a.time || '').localeCompare(b.time || ''));
                          
                          return (
                            <div key={staffId} className="rounded-2xl overflow-hidden shadow-lg border border-neutral-200">
                              {/* Staff Header */}
                              <div className={`bg-gradient-to-r ${staffId === 'unassigned' ? 'from-neutral-400 to-neutral-500' : colorScheme.bg} p-5`}>
                                <div className="flex items-center justify-between">
                                  <div className="flex items-center gap-4">
                                    <div className={`w-14 h-14 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center shadow-lg`}>
                                      {staffId === 'unassigned' 
                                        ? <i className="fas fa-user-slash text-white text-xl" />
                                        : <span className="font-bold text-white text-xl">{name[0]?.toUpperCase()}</span>
                                      }
                                    </div>
                                    <div>
                                      <h3 className="font-bold text-white text-lg">{name}</h3>
                                      <p className="text-white/80 text-sm">
                                        {bookings.length} appointment{bookings.length !== 1 ? 's' : ''} today
                                      </p>
                                    </div>
                                  </div>
                                  
                                  {/* Stats */}
                                  <div className="hidden md:flex items-center gap-4">
                                    <div className="text-center px-4 py-2 bg-white/10 backdrop-blur-sm rounded-lg">
                                      <p className="text-white/70 text-xs">Total Duration</p>
                                      <p className="text-white font-bold">{formatDuration(totalDuration)}</p>
                                    </div>
                                    <div className="text-center px-4 py-2 bg-white/10 backdrop-blur-sm rounded-lg">
                                      <p className="text-white/70 text-xs">Revenue</p>
                                      <p className="text-white font-bold">AU${totalRevenue.toLocaleString()}</p>
                                    </div>
                                  </div>
                                </div>
                              </div>
                              
                              {/* Mobile Stats */}
                              <div className="md:hidden bg-neutral-50 px-4 py-3 flex justify-around border-b border-neutral-200">
                                <div className="text-center">
                                  <p className="text-neutral-500 text-xs">Duration</p>
                                  <p className="text-neutral-900 font-semibold">{formatDuration(totalDuration)}</p>
                                </div>
                                <div className="text-center">
                                  <p className="text-neutral-500 text-xs">Revenue</p>
                                  <p className="text-neutral-900 font-semibold">AU${totalRevenue.toLocaleString()}</p>
                                </div>
                              </div>
                              
                              {/* Bookings Timeline */}
                              <div className="p-4 bg-white">
                                <div className="space-y-3">
                                  {sortedBookings.map((b, idx) => {
                                    const servicesList = b.services?.length > 0 
                                      ? b.services 
                                      : [{ name: b.serviceName || 'Service', price: b.price, duration: 30 }];
                                    const bookingPrice = b.price || servicesList.reduce((s: number, svc: any) => s + (Number(svc.price) || 0), 0);
                                    
                                    return (
                                      <div 
                                        key={`${staffId}-${b.id}-${idx}`} 
                                        className="relative pl-6 pb-3 border-l-2 border-neutral-200 last:border-l-transparent last:pb-0"
                                      >
                                        {/* Timeline dot */}
                                        <div className={`absolute -left-[9px] top-0 w-4 h-4 rounded-full border-2 border-white shadow ${
                                          b.status.toLowerCase() === 'confirmed' ? 'bg-emerald-500' :
                                          b.status.toLowerCase() === 'completed' ? 'bg-blue-500' :
                                          'bg-amber-500'
                                        }`} />
                                        
                                        <div className="bg-gradient-to-br from-neutral-50 to-white rounded-xl border border-neutral-200 overflow-hidden hover:shadow-md transition-shadow">
                                          {/* Booking Header */}
                                          <div className="p-4">
                                            <div className="flex items-start justify-between mb-3">
                                              <div className="flex items-center gap-3">
                                                <div className="w-10 h-10 bg-neutral-900 rounded-full flex items-center justify-center text-white font-bold shadow">
                                                  {b.client?.charAt(0)?.toUpperCase() || '?'}
                                                </div>
                                                <div>
                                                  <h4 className="font-semibold text-neutral-900">{b.client}</h4>
                                                  {b.clientPhone && (
                                                    <p className="text-xs text-neutral-500">
                                                      <i className="fas fa-phone mr-1" />{b.clientPhone}
                                                    </p>
                                                  )}
                                                </div>
                                              </div>
                                              <div className="flex flex-col items-end gap-1">
                                                <span className={`px-2.5 py-1 rounded-full text-xs font-semibold ${
                                                  b.status.toLowerCase() === 'confirmed' ? 'bg-emerald-100 text-emerald-700' :
                                                  b.status.toLowerCase() === 'completed' ? 'bg-blue-100 text-blue-700' :
                                                  'bg-amber-100 text-amber-700'
                                                }`}>
                                                  <i className={`fas ${
                                                    b.status.toLowerCase() === 'confirmed' ? 'fa-check-circle' :
                                                    b.status.toLowerCase() === 'completed' ? 'fa-check-double' :
                                                    'fa-clock'
                                                  } mr-1`} />
                                                  {b.status}
                                                </span>
                                                <span className="text-lg font-bold text-neutral-900">AU${bookingPrice.toLocaleString()}</span>
                                              </div>
                                            </div>
                                            
                                            {/* Services */}
                                            <div className="space-y-2">
                                              {servicesList.map((svc: any, svcIdx: number) => (
                                                <div key={svcIdx} className="flex items-center justify-between bg-white/80 rounded-lg p-2 border border-neutral-100">
                                                  <div className="flex items-center gap-2">
                                                    <div className="w-7 h-7 bg-neutral-100 rounded-lg flex items-center justify-center">
                                                      <i className="fas fa-wrench text-neutral-600 text-xs" />
                                                    </div>
                                                    <div>
                                                      <p className="text-sm font-medium text-neutral-900">{svc.name}</p>
                                                      <p className="text-xs text-neutral-500">
                                                        <i className="fas fa-clock mr-1" />
                                                        {formatTime(svc.time || b.time || '09:00')}
                                                        {svc.duration && ` • ${formatDuration(svc.duration)}`}
                                                      </p>
                                                    </div>
                                                  </div>
                                                  {svc.price && (
                                                    <span className="text-sm font-semibold text-neutral-700">AU${Number(svc.price).toLocaleString()}</span>
                                                  )}
                                                </div>
                                              ))}
                                            </div>
                                            
                                            {/* Branch info */}
                                            {b.branchName && (
                                              <div className="mt-3 flex items-center gap-2">
                                                <div className="flex items-center gap-2 bg-blue-50 px-2.5 py-1.5 rounded-lg">
                                                  <i className="fas fa-store text-blue-600 text-xs" />
                                                  <span className="text-xs font-medium text-blue-700">{b.branchName}</span>
                                                </div>
                                              </div>
                                            )}
                                          </div>
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    );
                  }

                  if (scheduleViewMode === 'branch') {
                    // Group by branch
                    const byBranch: Record<string, typeof filtered> = {};
                    filtered.forEach(b => {
                      const branch = b.branchName || 'Unknown Branch';
                      if (!byBranch[branch]) byBranch[branch] = [];
                      byBranch[branch].push(b);
                    });

                    // Helper functions
                    const formatTime = (time: string) => {
                      const [h, m] = time.split(':').map(Number);
                      const ampm = h >= 12 ? 'PM' : 'AM';
                      const hour = h > 12 ? h - 12 : h === 0 ? 12 : h;
                      return `${hour}:${String(m).padStart(2, '0')} ${ampm}`;
                    };

                    const getTotalRevenue = (bookings: typeof filtered) => {
                      return bookings
                        .filter((b: any) => {
                          // Only count completed bookings for revenue
                          const status = (b.status || '').toString().toLowerCase();
                          return status === 'completed';
                        })
                        .reduce((sum, b) => {
                          const price = b.price || b.services?.reduce((s: number, svc: any) => s + (Number(svc.price) || 0), 0) || 0;
                          return sum + price;
                        }, 0);
                    };

                    const getUniqueStaffCount = (bookings: typeof filtered) => {
                      const staffSet = new Set<string>();
                      bookings.forEach(b => {
                        if (b.staffId) staffSet.add(b.staffId);
                        b.services?.forEach((s: any) => { if (s.staffId) staffSet.add(s.staffId); });
                      });
                      return staffSet.size;
                    };

                    const formatDuration = (mins: number) => {
                      if (mins >= 60) {
                        const h = Math.floor(mins / 60);
                        const m = mins % 60;
                        return m > 0 ? `${h}h ${m}m` : `${h}h`;
                      }
                      return `${mins}m`;
                    };

                    const branchGradients = [
                      { bg: 'from-neutral-800 to-neutral-900', accent: 'neutral' },
                      { bg: 'from-neutral-700 to-neutral-800', accent: 'neutral' },
                      { bg: 'from-neutral-800 to-neutral-900', accent: 'neutral' },
                      { bg: 'from-neutral-700 to-neutral-800', accent: 'neutral' },
                      { bg: 'from-neutral-800 to-neutral-900', accent: 'neutral' },
                    ];

                    return (
                      <div className="space-y-6">
                        {Object.keys(byBranch).sort().map((branch, branchIdx) => {
                          const colorScheme = branchGradients[branchIdx % branchGradients.length];
                          const branchBookings = byBranch[branch];
                          const totalRevenue = getTotalRevenue(branchBookings);
                          const uniqueStaff = getUniqueStaffCount(branchBookings);
                          const confirmedCount = branchBookings.filter(b => b.status.toLowerCase() === 'confirmed').length;
                          const sortedBookings = [...branchBookings].sort((a, b) => (a.time || '').localeCompare(b.time || ''));
                          
                          return (
                            <div key={branch} className="rounded-2xl overflow-hidden shadow-lg border border-neutral-200">
                              {/* Branch Header */}
                              <div className={`bg-gradient-to-r ${colorScheme.bg} p-5`}>
                                <div className="flex items-center justify-between">
                                  <div className="flex items-center gap-4">
                                    <div className="w-14 h-14 rounded-xl bg-white/20 backdrop-blur-sm flex items-center justify-center shadow-lg">
                                      <i className="fas fa-store text-white text-xl" />
                                    </div>
                                    <div>
                                      <h3 className="font-bold text-white text-lg">{branch}</h3>
                                      <p className="text-white/80 text-sm flex items-center gap-2">
                                        <span>{branchBookings.length} booking{branchBookings.length !== 1 ? 's' : ''}</span>
                                        <span>•</span>
                                        <span>{uniqueStaff} staff</span>
                                      </p>
                                    </div>
                                  </div>
                                  
                                  {/* Stats */}
                                  <div className="hidden md:flex items-center gap-3">
                                    <div className="text-center px-4 py-2 bg-white/10 backdrop-blur-sm rounded-lg">
                                      <p className="text-white/70 text-xs">Confirmed</p>
                                      <p className="text-white font-bold text-lg">{confirmedCount}/{branchBookings.length}</p>
                                    </div>
                                    <div className="text-center px-4 py-2 bg-white/10 backdrop-blur-sm rounded-lg">
                                      <p className="text-white/70 text-xs">Revenue</p>
                                      <p className="text-white font-bold text-lg">AU${totalRevenue.toLocaleString()}</p>
                                    </div>
                                  </div>
                                </div>
                              </div>
                              
                              {/* Mobile Stats */}
                              <div className="md:hidden bg-neutral-50 px-4 py-3 flex justify-around border-b border-neutral-200">
                                <div className="text-center">
                                  <p className="text-neutral-500 text-xs">Confirmed</p>
                                  <p className="text-neutral-900 font-semibold">{confirmedCount}/{branchBookings.length}</p>
                                </div>
                                <div className="text-center">
                                  <p className="text-neutral-500 text-xs">Staff</p>
                                  <p className="text-neutral-900 font-semibold">{uniqueStaff}</p>
                                </div>
                                <div className="text-center">
                                  <p className="text-neutral-500 text-xs">Revenue</p>
                                  <p className="text-neutral-900 font-semibold">AU${totalRevenue.toLocaleString()}</p>
                                </div>
                              </div>
                              
                              {/* Bookings Grid */}
                              <div className="p-4 bg-white">
                                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                                  {sortedBookings.map((b, idx) => {
                                    const servicesList = b.services?.length > 0 
                                      ? b.services 
                                      : [{ name: b.serviceName || 'Service', price: b.price, duration: 30, staffName: b.staffName }];
                                    const bookingPrice = b.price || servicesList.reduce((s: number, svc: any) => s + (Number(svc.price) || 0), 0);
                                    
                                    return (
                                      <div 
                                        key={`${branch}-${b.id}-${idx}`}
                                        className={`relative overflow-hidden rounded-xl border transition-all hover:shadow-lg ${
                                          b.status.toLowerCase() === 'confirmed' 
                                            ? 'border-emerald-200 bg-gradient-to-br from-emerald-50/30 to-white' 
                                            : b.status.toLowerCase() === 'completed'
                                            ? 'border-blue-200 bg-gradient-to-br from-blue-50/30 to-white'
                                            : 'border-amber-200 bg-gradient-to-br from-amber-50/30 to-white'
                                        }`}
                                      >
                                        {/* Status bar */}
                                        <div className={`absolute left-0 top-0 bottom-0 w-1.5 ${
                                          b.status.toLowerCase() === 'confirmed' ? 'bg-emerald-500' :
                                          b.status.toLowerCase() === 'completed' ? 'bg-blue-500' :
                                          'bg-amber-500'
                                        }`} />
                                        
                                        <div className="p-4 pl-5">
                                          {/* Header */}
                                          <div className="flex items-start justify-between mb-3">
                                            <div className="flex items-center gap-3">
                                              <div className="w-11 h-11 bg-neutral-900 rounded-full flex items-center justify-center text-white font-bold shadow">
                                                {b.client?.charAt(0)?.toUpperCase() || '?'}
                                              </div>
                                              <div>
                                                <h4 className="font-semibold text-neutral-900">{b.client}</h4>
                                                <div className="flex items-center gap-2 text-xs text-neutral-500">
                                                  <span><i className="fas fa-clock mr-1" />{formatTime(b.time || '09:00')}</span>
                                                  {b.clientPhone && (
                                                    <>
                                                      <span>•</span>
                                                      <span><i className="fas fa-phone mr-1" />{b.clientPhone}</span>
                                                    </>
                                                  )}
                                                </div>
                                              </div>
                                            </div>
                                            <span className={`px-2.5 py-1 rounded-full text-xs font-semibold ${
                                              b.status.toLowerCase() === 'confirmed' ? 'bg-emerald-100 text-emerald-700' :
                                              b.status.toLowerCase() === 'completed' ? 'bg-blue-100 text-blue-700' :
                                              'bg-amber-100 text-amber-700'
                                            }`}>
                                              {b.status}
                                            </span>
                                          </div>
                                          
                                          {/* Services */}
                                          <div className="space-y-2 mb-3">
                                            {servicesList.map((svc: any, svcIdx: number) => (
                                              <div key={svcIdx} className="flex items-center justify-between bg-white/80 rounded-lg p-2.5 border border-neutral-100">
                                                <div className="flex items-center gap-2">
                                                  <div className="w-8 h-8 bg-neutral-100 rounded-lg flex items-center justify-center">
                                                    <i className="fas fa-wrench text-neutral-600 text-sm" />
                                                  </div>
                                                  <div>
                                                    <p className="text-sm font-medium text-neutral-900">{svc.name}</p>
                                                    {svc.duration && (
                                                      <p className="text-xs text-neutral-500">
                                                        <i className="fas fa-hourglass-half mr-1" />{formatDuration(svc.duration)}
                                                      </p>
                                                    )}
                                                  </div>
                                                </div>
                                                <div className="text-right">
                                                  {svc.price && (
                                                    <p className="text-sm font-semibold text-neutral-900">AU${Number(svc.price).toLocaleString()}</p>
                                                  )}
                                                </div>
                                              </div>
                                            ))}
                                          </div>
                                          
                                          {/* Footer */}
                                          <div className="flex items-center justify-between pt-2 border-t border-neutral-100">
                                            <div className="flex flex-wrap items-center gap-2">
                                              {servicesList.map((svc: any, svcIdx: number) => (
                                                svc.staffName && !svc.staffName.toLowerCase().includes('any') && (
                                                  <div key={svcIdx} className="flex items-center gap-1.5 bg-indigo-50 px-2 py-1 rounded-lg">
                                                    <div className="w-5 h-5 bg-indigo-200 rounded-full flex items-center justify-center">
                                                      <i className="fas fa-user text-indigo-600 text-[8px]" />
                                                    </div>
                                                    <span className="text-xs font-medium text-indigo-700">{svc.staffName}</span>
                                                  </div>
                                                )
                                              ))}
                                            </div>
                                            <p className="text-lg font-bold text-neutral-900">AU${bookingPrice.toLocaleString()}</p>
                                          </div>
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    );
                  }

                  return null;
                })()}
              </div>
            </div>
          )}
          </>
          )}

          {/* ═══════ WEEKLY CALENDAR ═══════ */}
          {!authLoading && !isSuperAdmin && (
          <>
          {showCalendarOnly && (
            <button
              onClick={() => setShowCalendarOnly(false)}
              className="flex items-center gap-2 px-4 py-2.5 mb-4 rounded-xl bg-neutral-100 hover:bg-neutral-200 text-neutral-700 font-semibold text-sm transition-colors border border-neutral-200"
            >
              <i className="fas fa-arrow-left" />
              Back to Dashboard
            </button>
          )}
          {(() => {
            const CAL_HOURS = Array.from({ length: 12 }, (_, i) => i + 7); // 7 AM – 6 PM
            const SLOT_H = 52; // 52px per hour (compact)
            const GRID_HEIGHT = CAL_HOURS.length * SLOT_H;
            const dayNames = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"];
            const weekDates: Date[] = [];
            for (let i = 0; i < 7; i++) { const d = new Date(calWeekStart); d.setDate(d.getDate() + i); weekDates.push(d); }
            const todayStr = (() => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')}`; })();
            const fmtDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
            const weekLabel = (() => { const s = weekDates[0]; const e = weekDates[6]; const fmt = (d: Date) => d.toLocaleDateString("en-AU",{day:"numeric",month:"short"}); return `${fmt(s)} – ${fmt(e)} ${e.getFullYear()}`; })();

            const prevWeek = () => { const d = new Date(calWeekStart); d.setDate(d.getDate() - 7); setCalWeekStart(d); };
            const nextWeek = () => { const d = new Date(calWeekStart); d.setDate(d.getDate() + 7); setCalWeekStart(d); };
            const goToday = () => { const d = new Date(); d.setDate(d.getDate() - ((d.getDay()+6)%7)); d.setHours(0,0,0,0); setCalWeekStart(d); };

            const weekDateSet = new Set(weekDates.map(d => fmtDate(d)));
            const inWeek = calBookings.filter((b: any) => weekDateSet.has(b.dateKey || normalizeDateKey(b.date)));
            const branchAdminOnly = isBranchAdmin
              ? inWeek.filter((b: any) => {
                  const bid = (b.branchId || "").toString();
                  const bname = (b.branchName || "").toString().trim().toLowerCase();
                  const adminBid = (branchAdminBranchId || "").toString();
                  const adminBname = (branchAdminBranchName || "").toString().trim().toLowerCase();
                  if (adminBid && bid && bid === adminBid) return true;
                  if (adminBname && bname && bname === adminBname) return true;
                  return false;
                })
              : inWeek;
            const byBranch = calBranchFilter === "all"
              ? branchAdminOnly
              : branchAdminOnly.filter((b: any) => (b.branchId || b.branchName) === calBranchFilter);
            const filtered = calStaffFilter === "all" ? byBranch : byBranch.filter((b: any) => {
              if (b.staffId === calStaffFilter) return true;
              return b.services?.some((s: any) => s.staffId === calStaffFilter || s.staffAuthUid === calStaffFilter);
            });

            // Flatten to blocks: multi-service bookings become one block per service (with its own time)
            const toBlocks = (): {
              id: string;
              bookingId: string;
              date: string;
              time: string;
              duration: number;
              client: string;
              serviceName: string;
              servicesText: string;
              staffName: string;
              staffId: string;
              branchName: string;
              pickupTime: string;
              price: number;
              status: string;
            }[] => {
              const blocks: any[] = [];
              filtered.forEach(b => {
                if (Array.isArray(b.services) && b.services.length > 0) {
                  b.services.forEach((svc: any, idx: number) => {
                    const t = svc.time || b.time || "09:00";
                    const dur = Number(svc.duration) || 60;
                    blocks.push({
                      id: `${b.id}-${idx}`,
                      bookingId: b.id,
                      date: b.dateKey || normalizeDateKey(b.date),
                      time: t,
                      duration: dur,
                      client: b.client,
                      clientPhone: b.clientPhone || "",
                      clientEmail: b.clientEmail || "",
                      vehicleNumber: b.vehicleNumber || "",
                      notes: b.notes || "",
                      serviceName: svc.name || b.serviceName || "Service",
                      servicesText: Array.isArray(b.services) && b.services.length > 0
                        ? b.services.map((x: any) => x?.name).filter(Boolean).join(", ")
                        : (svc.name || b.serviceName || "Service"),
                      staffName: svc.staffName || b.staffName || "",
                      staffId: svc.staffId || svc.staffAuthUid || b.staffId || "",
                      branchName: b.branchName || "",
                      pickupTime: b.pickupTime || "",
                      price: svc.price ?? b.price ?? 0,
                      status: b.status || "Pending",
                    });
                  });
                } else {
                  blocks.push({
                    id: b.id,
                    bookingId: b.id,
                    date: b.dateKey || normalizeDateKey(b.date),
                    time: b.time || "09:00",
                    duration: b.duration || 60,
                    client: b.client,
                    clientPhone: b.clientPhone || "",
                    clientEmail: b.clientEmail || "",
                    vehicleNumber: b.vehicleNumber || "",
                    notes: b.notes || "",
                    serviceName: b.serviceName || "Service",
                    servicesText: b.serviceName || "Service",
                    staffName: b.staffName || "",
                    staffId: b.staffId || "",
                    branchName: b.branchName || "",
                    pickupTime: b.pickupTime || "",
                    price: b.price || 0,
                    status: b.status || "Pending",
                  });
                }
              });
              return blocks;
            };
            const blocks = toBlocks();

            // Parse time: supports "09:00", "9:00", "9:00 AM", "1:00 PM", "13:00", "0700" (HHMM)
            const parseTime = (t: string): { h: number; m: number } => {
              if (!t || typeof t !== "string") return { h: 9, m: 0 };
              const upper = t.toUpperCase();
              const isPM = upper.includes("PM") && !upper.includes("12:00");
              const is12PM = /12\s*:\s*\d+\s*PM/i.test(t);
              const is12AM = /12\s*:\s*\d+\s*AM/i.test(t);
              const numPart = t.replace(/\s*(AM|PM)/gi, "").trim();
              const parts = numPart.split(":").map(x => parseInt(x.replace(/\D/g, "") || "0", 10));
              let h: number;
              let m: number;
              // Handle "0700" or "0930" (HHMM) format when no colon
              if (parts.length === 1 && parts[0] >= 100) {
                const v = parts[0];
                h = Math.floor(v / 100) % 24;
                m = v % 100;
              } else {
                h = parts[0] ?? 9;
                m = parts[1] ?? 0;
              }
              if (is12AM && h === 12) h = 0;
              else if ((is12PM || isPM) && h !== 12) h += 12;
              return { h, m };
            };

            const COLORFUL_COLORS = [
              "bg-gradient-to-br from-cyan-100 to-sky-100 border-cyan-300 text-cyan-900",
              "bg-gradient-to-br from-emerald-100 to-lime-100 border-emerald-300 text-emerald-900",
              "bg-gradient-to-br from-blue-100 to-indigo-100 border-blue-300 text-blue-900",
              "bg-gradient-to-br from-teal-100 to-cyan-100 border-teal-300 text-teal-900",
              "bg-gradient-to-br from-violet-100 to-purple-100 border-violet-300 text-violet-900",
              "bg-gradient-to-br from-amber-100 to-yellow-100 border-amber-300 text-amber-900",
            ];
            const DAY_HEADER_COLORS = [
              "from-cyan-50 to-cyan-100/70",
              "from-lime-50 to-emerald-100/70",
              "from-blue-50 to-indigo-100/70",
              "from-teal-50 to-cyan-100/70",
              "from-violet-50 to-fuchsia-100/70",
              "from-amber-50 to-yellow-100/70",
              "from-rose-50 to-pink-100/70",
            ];
            const staffColorMap = new Map<string, string>();
            let colorIdx = 0;
            const getColor = (staffKey: string) => {
              if (!staffColorMap.has(staffKey)) {
                staffColorMap.set(staffKey, COLORFUL_COLORS[colorIdx % COLORFUL_COLORS.length]);
                colorIdx++;
              }
              return staffColorMap.get(staffKey)!;
            };

            const formatHour = (hour: number) => hour === 0 ? "12 AM" : hour === 12 ? "12 PM" : hour < 12 ? `${hour} AM` : `${hour - 12} PM`;

            // Assign column index to overlapping blocks (waterfall layout)
            const assignOverlapColumns = (bks: typeof blocks) => {
              if (bks.length === 0) return [];
              const withMinutes = bks.map(b => {
                const { h, m } = parseTime(b.time);
                const dur = b.duration || 60;
                const startM = h * 60 + m;
                const endM = startM + dur;
                return { ...b, startM, endM };
              });
              withMinutes.sort((a, b) => a.startM !== b.startM ? a.startM - b.startM : (a.id || "").localeCompare(b.id || ""));
              const columnAssign: { [id: string]: number } = {};
              const active: { endM: number; col: number }[] = [];
              for (const b of withMinutes) {
                // Free columns that have ended
                while (active.length > 0 && active[0].endM <= b.startM) {
                  active.shift();
                }
                const usedCols = new Set(active.map(x => x.col));
                let col = 0;
                while (usedCols.has(col)) col++;
                columnAssign[b.id] = col;
                active.push({ endM: b.endM, col });
                active.sort((a, b) => a.endM - b.endM);
              }
              const maxCol = Math.max(...Object.values(columnAssign), 0);
              const n = maxCol + 1;
              return bks.map(b => {
                const col = columnAssign[b.id] ?? 0;
                return { ...b, overlapCol: col, overlapCount: n };
              });
            };

            return (
              <div className="bg-white rounded-2xl shadow-xl border border-slate-200 mb-8 overflow-hidden">
                <style>{`
                  .cal-grid-scroll::-webkit-scrollbar { width: 6px; }
                  .cal-grid-scroll::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 10px; }
                  .cal-booking-card {
                    transition: all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275);
                    overflow: hidden;
                    white-space: nowrap;
                    position: absolute;
                    border: 1px solid rgba(255,255,255,0.2);
                  }
                  .cal-booking-card:hover {
                    width: 200px !important;
                    min-width: 200px !important;
                    z-index: 50 !important;
                  }
                  .cal-day-column:hover .cal-booking-card:not(:hover) {
                    opacity: 0.35;
                    filter: grayscale(0.6);
                  }
                  .cal-hour-marker { height: 52px; border-bottom: 1px solid #e2e8f0; }
                  .cal-today-column { background: linear-gradient(180deg, #eef2ff 0%, #f8fafc 100%) !important; }
                  .cal-day-tint-0 { background: linear-gradient(180deg, #f0f9ff 0%, #fff 100%); }
                  .cal-day-tint-1 { background: linear-gradient(180deg, #f0fdf4 0%, #fff 100%); }
                  .cal-day-tint-2 { background: linear-gradient(180deg, #eef2ff 0%, #f8fafc 100%); }
                  .cal-day-tint-3 { background: linear-gradient(180deg, #fff7ed 0%, #fff 100%); }
                  .cal-day-tint-4 { background: linear-gradient(180deg, #fefce8 0%, #fff 100%); }
                  .cal-day-tint-5 { background: linear-gradient(180deg, #fdf4ff 0%, #fff 100%); }
                  .cal-day-tint-6 { background: linear-gradient(180deg, #fce7f3 0%, #fff 100%); }
                  .cal-booking-card { box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
                  .cal-booking-card:hover { box-shadow: 0 20px 25px -5px rgb(0 0 0 / 0.15), 0 8px 10px -6px rgb(0 0 0 / 0.1); }
                `}</style>
                {/* Sticky Header: Left = Calendar + Filters, Right = Nav */}
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 p-6 border-b border-slate-200 bg-white sticky top-0 z-30">
                  <div className="flex items-center gap-4 flex-wrap">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 bg-gradient-to-br from-indigo-600 to-violet-700 rounded-xl flex items-center justify-center shadow-lg shadow-indigo-500/25">
                        <i className="fas fa-calendar-week text-white text-sm" />
                      </div>
                      <div>
                        <h3 className="font-bold text-lg text-neutral-900">Calendar</h3>
                        <p className="text-sm text-neutral-500">{weekLabel}</p>
                      </div>
                    </div>
                    <div className="h-6 w-px bg-slate-200 hidden sm:block" />
                    <div className="flex items-center gap-2">
                      {!isBranchAdmin ? (
                        <div className="relative">
                          <select
                            value={calBranchFilter}
                            onChange={e => setCalBranchFilter(e.target.value)}
                            className="appearance-none text-xs font-medium border border-neutral-200 rounded-lg pl-2.5 pr-7 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400"
                          >
                            <option value="all">All Branches</option>
                            {calBranchList.map(b => <option key={b.value} value={b.value}>{b.label}</option>)}
                          </select>
                          <i className="fas fa-chevron-down pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-neutral-500" />
                        </div>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1.5 rounded-lg border border-neutral-200 bg-neutral-50 text-neutral-700">
                          <i className="fas fa-location-dot text-[10px]" />
                          {branchAdminBranchName || "Branch"}
                        </span>
                      )}
                      <div className="relative">
                        <select
                          value={calStaffFilter}
                          onChange={e => setCalStaffFilter(e.target.value)}
                          className="appearance-none text-xs font-medium border border-neutral-200 rounded-lg pl-2.5 pr-7 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400"
                        >
                          <option value="all">All Staff</option>
                          {calStaffList.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                        </select>
                        <i className="fas fa-chevron-down pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-neutral-500" />
                      </div>
                      {(calBranchFilter !== "all" || calStaffFilter !== "all") && (
                        <button
                          onClick={() => { setCalBranchFilter("all"); setCalStaffFilter("all"); }}
                          className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-slate-700 px-2.5 py-1.5 rounded-lg hover:bg-slate-100 transition"
                          title="Clear filters"
                        >
                          <i className="fas fa-times" /> Clear
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button onClick={prevWeek} className="p-2.5 border border-slate-200 rounded-lg text-slate-600 hover:bg-slate-50 hover:border-slate-300 transition" title="Previous week"><i className="fas fa-chevron-left text-sm" /></button>
                    <button onClick={nextWeek} className="p-2.5 border border-slate-200 rounded-lg text-slate-600 hover:bg-slate-50 hover:border-slate-300 transition" title="Next week"><i className="fas fa-chevron-right text-sm" /></button>
                  </div>
                </div>

                {/* Day headers row */}
                <div className="grid grid-cols-[80px_1fr] border-b border-slate-200 bg-gradient-to-r from-slate-50 to-slate-100/80">
                  <div className="border-r border-slate-200" />
                  <div className="grid grid-cols-7 text-center text-xs font-bold uppercase tracking-widest">
                    {weekDates.map((d, i) => {
                      const ds = fmtDate(d);
                      const isToday = ds === todayStr;
                      const dayShort = dayNames[i].substring(0, 3);
                      return (
                        <div
                          key={i}
                          className={`py-4 border-r border-slate-200 last:border-r-0 transition-colors ${
                            isToday
                              ? "bg-gradient-to-br from-indigo-600 to-violet-700 text-white shadow-sm"
                              : "text-slate-700"
                          }`}
                        >
                          {dayShort} {d.getDate()}{isToday ? " (Today)" : ""}
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Calendar grid - scrollable */}
                <div className="cal-grid-scroll grid grid-cols-[80px_1fr] h-[520px] overflow-y-auto overflow-x-auto">
                  {/* Time column */}
                  <div className="border-r border-slate-200 bg-white">
                    {CAL_HOURS.map((hour) => (
                      <div key={hour} className="cal-hour-marker text-xs text-slate-600 font-bold text-right pr-3 pt-2">
                        {formatHour(hour)}
                      </div>
                    ))}
                  </div>
                  {/* Day columns - 7 columns */}
                  <div className="grid grid-cols-7 relative overflow-visible min-w-[700px]">
                    {weekDates.map((d, dayIdx) => {
                      const ds = fmtDate(d);
                      const dayBksRaw = blocks.filter(b => b.date === ds);
                      const dayBks = assignOverlapColumns(dayBksRaw);
                      const isToday = ds === todayStr;
                      return (
                        <div
                          key={dayIdx}
                          className={`cal-day-column relative overflow-visible ${dayIdx < 6 ? "border-r border-slate-200" : ""} ${isToday ? "cal-today-column" : `cal-day-tint-${dayIdx}`}`}
                          style={{ minHeight: GRID_HEIGHT }}
                        >
                          {/* Hour grid lines */}
                          {CAL_HOURS.slice(1).map(hour => (
                            <div key={hour} className="absolute left-0 right-0 border-b border-slate-200" style={{ top: (hour - CAL_HOURS[0]) * SLOT_H }} />
                          ))}
                          {/* Booking blocks - side-by-side for overlaps */}
                          {dayBks.map((bk: any) => {
                              let { h, m } = parseTime(bk.time);
                              // Clamp invalid hours (e.g. from "0700" parsed as 700) to visible range
                              if (h < 0 || h > 23) h = 9;
                              if (m < 0 || m > 59) m = 0;
                              const dur = bk.duration || 60;
                              const topPx = ((h - CAL_HOURS[0]) * SLOT_H) + ((m / 60) * SLOT_H);
                              const heightPx = Math.max(24, Math.min((dur / 60) * SLOT_H, GRID_HEIGHT - topPx - 2));

                              if (h < CAL_HOURS[0] || h >= CAL_HOURS[CAL_HOURS.length - 1] + 1) return null;

                              const staffKey = bk.staffId || bk.staffName || "default";
                              const statusNorm = String(bk.status || "").toLowerCase().replace(/[\s_-]/g, "");
                              const statusColorCls = statusNorm === "completed"
                                ? "bg-gradient-to-br from-blue-100 to-sky-100 border-blue-300 text-blue-900"
                                : statusNorm === "confirmed"
                                  ? "bg-gradient-to-br from-emerald-100 to-green-100 border-emerald-300 text-emerald-900"
                                  : null;
                              const colorCls = statusColorCls || getColor(staffKey);
                              const isDark = colorCls.includes("neutral-8") || colorCls.includes("neutral-9");
                              const targetPath = (() => {
                                if (statusNorm === "completed") return "/bookings/completed";
                                if (statusNorm === "confirmed") return "/bookings/confirmed";
                                if (statusNorm === "awaitingstaffapproval") return "/bookings/awaiting-staff";
                                if (statusNorm === "staffrejected") return "/bookings/staff-rejected";
                                if (statusNorm === "canceled" || statusNorm === "cancelled") return "/bookings/cancelled";
                                return "/bookings/pending";
                              })();

                              const endM = h * 60 + m + dur;
                              const endH = Math.floor(endM / 60);
                              const endMin = endM % 60;
                              const formatTimeLabel = (hh: number, mm: number) => {
                                const safeH = ((hh % 24) + 24) % 24;
                                const ap = safeH >= 12 ? "PM" : "AM";
                                const h12 = safeH % 12 === 0 ? 12 : safeH % 12;
                                return `${h12}:${String(mm).padStart(2, "0")} ${ap}`;
                              };
                              const pickupDisplay = (() => {
                                if (bk.pickupTime && String(bk.pickupTime).trim() !== "") {
                                  const { h: ph, m: pm } = parseTime(String(bk.pickupTime));
                                  return formatTimeLabel(ph, pm);
                                }
                                // Fallback: use calculated end time when pickup time is not stored
                                return formatTimeLabel(endH, endMin);
                              })();
                              const statusLabel = statusNorm === "completed"
                                ? "Completed"
                                : statusNorm === "confirmed"
                                  ? "Confirmed"
                                  : statusNorm === "awaitingstaffapproval"
                                    ? "Awaiting Staff"
                                    : statusNorm === "staffrejected"
                                      ? "Staff Rejected"
                                      : statusNorm === "canceled" || statusNorm === "cancelled"
                                        ? "Cancelled"
                                        : "Pending";

                              const n = bk.overlapCount ?? 1;
                              const colIdx = bk.overlapCol ?? 0;
                              // Dynamic width: each block gets equal share, no limit on count (6, 10, or more)
                              const gapPct = n > 1 ? Math.min(1, 8 / n) : 0; // smaller gap when many blocks
                              const widthPct = n > 1 ? (100 / n) - gapPct : 100;
                              const leftPct = n > 1 ? colIdx * (100 / n) + (gapPct / 2) : 0;

                              const tooltipData = {
                                client: bk.client,
                                serviceName: bk.serviceName,
                                statusLabel,
                                statusNorm,
                                timeLabel: `${formatTimeLabel(h, m)} – ${formatTimeLabel(endH, endMin)}`,
                                dur,
                                branchName: bk.branchName,
                                staffName: bk.staffName,
                                pickupDisplay,
                                clientPhone: bk.clientPhone,
                                clientEmail: bk.clientEmail,
                                vehicleNumber: bk.vehicleNumber,
                                notes: bk.notes,
                                price: Number(bk.price || 0),
                              };

                              const showTooltip = (e: React.MouseEvent) => {
                                if (calTooltipTimeoutRef.current) {
                                  clearTimeout(calTooltipTimeoutRef.current);
                                  calTooltipTimeoutRef.current = null;
                                }
                                setCalHoverTooltip({ data: tooltipData, rect: e.currentTarget.getBoundingClientRect() });
                              };
                              const hideTooltip = () => {
                                calTooltipTimeoutRef.current = setTimeout(() => setCalHoverTooltip(null), 200);
                              };

                              return (
                                <div
                                  key={`${bk.bookingId || bk.id}-${bk.id}-${(bk.client || "").slice(0, 20)}`}
                                  className="cal-booking-card absolute cursor-pointer rounded-lg text-white"
                                  style={{
                                    top: topPx + 2,
                                    height: heightPx - 2,
                                    left: `${leftPct}%`,
                                    width: `${widthPct}%`,
                                    minWidth: n > 1 ? (n <= 6 ? 36 : 0) : 60, // no min when many blocks so they fit
                                    backgroundColor: (() => {
                                      const palette = [
                                        "#3b82f6", "#6366f1", "#8b5cf6", "#a855f7", "#d946ef", "#ec4899",
                                        "#14b8a6", "#10b981", "#22c55e", "#84cc16", "#eab308", "#f59e0b",
                                        "#ef4444", "#f97316", "#0ea5e9", "#06b6d4",
                                      ];
                                      // Use colIdx for overlapping slots so adjacent blocks get different colors
                                      const idx = n > 1 ? colIdx % palette.length : Math.abs(`${bk.staffId || ""}-${bk.client || ""}-${bk.id}`.split("").reduce((a: number, c: string) => a + c.charCodeAt(0), 0)) % palette.length;
                                      return palette[idx];
                                    })(),
                                    zIndex: 20 + colIdx,
                                  }}
                                  onMouseEnter={showTooltip}
                                  onMouseLeave={hideTooltip}
                                  onClick={() => router.push(`${targetPath}?highlight=${bk.bookingId || bk.id.split("-")[0]}`)}
                                >
                                  <div className="cal-booking-inner h-full overflow-hidden p-1.5 flex flex-col justify-center">
                                    <b className="text-xs font-bold block truncate">
                                      {n > 4 ? (bk.client || "?").split(/\s+/).map((s: string) => s[0]).join("").toUpperCase().slice(0, 2) : (bk.client || "—")}
                                    </b>
                                    <span className="text-[10px] font-medium opacity-95">{formatTimeLabel(h, m).replace(/\s/g, "")}</span>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                <p className="text-center text-slate-500 text-xs py-4 border-t border-slate-100"><i className="fas fa-hand-pointer text-slate-400 mr-1" /> Hover over any booking to expand details</p>
                {/* Floating tooltip for small slots - always visible */}
                {calHoverTooltip && (
                  <div
                    className="fixed z-[100] w-[320px] rounded-xl shadow-2xl border border-slate-200 bg-white p-4 text-left"
                    style={{
                      left: Math.max(12, Math.min(calHoverTooltip.rect.left + calHoverTooltip.rect.width / 2 - 160, (typeof window !== "undefined" ? window.innerWidth : 1200) - 332)),
                      top: calHoverTooltip.rect.top < 360 ? calHoverTooltip.rect.bottom + 8 : calHoverTooltip.rect.top - 8,
                      transform: calHoverTooltip.rect.top < 360 ? "none" : "translateY(-100%)",
                    }}
                    onMouseEnter={() => {
                      if (calTooltipTimeoutRef.current) {
                        clearTimeout(calTooltipTimeoutRef.current);
                        calTooltipTimeoutRef.current = null;
                      }
                    }}
                    onMouseLeave={() => {
                      calTooltipTimeoutRef.current = setTimeout(() => setCalHoverTooltip(null), 200);
                    }}
                  >
                    {(() => {
                      const d = calHoverTooltip.data;
                      return (
                        <div className="space-y-2 text-neutral-800">
                          <div className="flex items-center justify-between gap-2">
                            <p className="text-sm font-bold truncate text-neutral-900">{d.client}</p>
                            <span className={`text-xs px-1.5 py-0.5 rounded font-semibold shrink-0 ${
                              d.statusNorm === "completed" ? "bg-blue-100 text-blue-800" :
                              d.statusNorm === "confirmed" ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"
                            }`}>{d.statusLabel}</span>
                          </div>
                          <p className="text-xs font-semibold text-neutral-800">{d.serviceName}</p>
                          <p className="text-xs text-slate-700">{d.timeLabel} · {d.dur} min</p>
                          {d.branchName && <p className="text-xs text-slate-700"><i className="fas fa-location-dot w-3 mr-1" />{d.branchName}</p>}
                          {d.staffName && <p className="text-xs text-slate-700"><i className="fas fa-user w-3 mr-1" />{d.staffName}</p>}
                          {d.pickupDisplay && <p className="text-xs text-slate-700"><i className="fas fa-clock w-3 mr-1" />Pickup: {d.pickupDisplay}</p>}
                          {d.clientPhone && <p className="text-xs text-slate-700"><i className="fas fa-phone w-3 mr-1" />{d.clientPhone}</p>}
                          {d.clientEmail && <p className="text-xs text-slate-700 truncate"><i className="fas fa-envelope w-3 mr-1" />{d.clientEmail}</p>}
                          {d.vehicleNumber && <p className="text-xs text-slate-700"><i className="fas fa-car w-3 mr-1" />{d.vehicleNumber}</p>}
                          {d.notes && String(d.notes).trim() && <p className="text-xs text-slate-700 line-clamp-2">{d.notes}</p>}
                          <p className="text-sm font-bold pt-1 border-t border-slate-200 text-neutral-900">${d.price.toLocaleString()}</p>
                          <p className="text-xs text-slate-600 pt-1">Click to open full booking</p>
                        </div>
                      );
                    })()}
                  </div>
                )}
              </div>
            );
          })()}
          </>
          )}
          
          {!showCalendarOnly && (
          <>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
            <div className="lg:col-span-2 bg-white p-6 rounded-2xl border border-neutral-200 shadow-sm min-w-0 overflow-hidden">
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h3 className="font-semibold text-lg text-neutral-900">
                    {isSuperAdmin ? "Platform Revenue Trend" : "Revenue Trend"}
                  </h3>
                  <p className="text-sm text-neutral-500 mt-1">
                    {isSuperAdmin ? "Last 6 months (all tenants)" : "Last 6 months"}
                  </p>
                </div>
              </div>
              <div className="h-[280px] relative">
                <canvas ref={revCanvasRef} />
              </div>
            </div>
            <div className="bg-white p-6 rounded-2xl border border-neutral-200 shadow-sm min-w-0">
              <div className="mb-6">
                <h3 className="font-semibold text-lg text-neutral-900">
                  {isSuperAdmin ? "Platform Booking Status" : "Booking Status"}
                </h3>
                <p className="text-sm text-neutral-500 mt-1">
                  {isSuperAdmin ? "All tenants distribution" : "Distribution by status"}
                </p>
              </div>
              <div className="space-y-4">
                <div className="relative h-48 mb-2">
                  <canvas ref={statusCanvasRef} />
                </div>
              </div>
            </div>
          </div>
          {/* Recent Activity - hide for branch admins */}
          {!isBranchAdmin && (
          <div className="bg-white rounded-2xl border border-neutral-200 shadow-sm">
            <div className="p-6 border-b border-neutral-200">
              <div>
                <h3 className="font-semibold text-lg text-neutral-900">Recent Activity</h3>
                <p className="text-sm text-neutral-500 mt-1">
                  {isSuperAdmin ? "Latest tenant onboardings" : "Recent bookings"}
                </p>
              </div>
            </div>
            <div className="overflow-x-auto">
              {isSuperAdmin ? (
                <table className="w-full">
                  <thead className="bg-neutral-50 border-b border-neutral-200">
                    <tr>
                      <th className="px-6 py-4 text-left text-xs font-semibold text-neutral-600 uppercase tracking-wider">Business Name</th>
                      <th className="px-6 py-4 text-left text-xs font-semibold text-neutral-600 uppercase tracking-wider">Location</th>
                      <th className="px-6 py-4 text-left text-xs font-semibold text-neutral-600 uppercase tracking-wider">Plan</th>
                      <th className="px-6 py-4 text-left text-xs font-semibold text-neutral-600 uppercase tracking-wider">Status</th>
                      <th className="px-6 py-4 text-right text-xs font-semibold text-neutral-600 uppercase tracking-wider">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-neutral-200">
                    {recentTenants.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="px-6 py-8 text-center text-neutral-500">
                          No recent activity
                        </td>
                      </tr>
                    ) : (
                      recentTenants.map((tenant: any, idx: number) => {
                        const initials = (tenant.name || tenant.displayName || "?")
                          .split(" ")
                          .map((s: string) => s[0])
                          .filter(Boolean)
                          .slice(0, 2)
                          .join("")
                          .toUpperCase();
                        
                        const statusLabel = tenant.status || "Active";
                        const statusLower = statusLabel.toLowerCase();
                        const statusCls = statusLower.includes("suspend")
                          ? "bg-rose-50 text-rose-700"
                          : statusLower.includes("active")
                          ? "bg-emerald-50 text-emerald-700"
                          : statusLower.includes("pending")
                          ? "bg-amber-50 text-amber-700"
                          : "bg-neutral-100 text-neutral-700";
                        const statusIcon = statusLower.includes("active")
                          ? "fa-check-circle"
                          : statusLower.includes("pending")
                          ? "fa-clock"
                          : "fa-circle-info";

                        const state = tenant.state || "";
                        const stateCls = state === "NSW"
                          ? "bg-blue-50 text-blue-700"
                          : state === "VIC"
                          ? "bg-purple-50 text-purple-700"
                          : state === "QLD"
                          ? "bg-orange-50 text-orange-700"
                          : state === "WA"
                          ? "bg-indigo-50 text-indigo-700"
                          : state === "SA"
                          ? "bg-green-50 text-green-700"
                          : "bg-neutral-100 text-neutral-700";

                        const colors = [
                          { from: "from-neutral-700", to: "to-neutral-900" },
                          { from: "from-blue-400", to: "to-blue-600" },
                          { from: "from-purple-400", to: "to-purple-600" },
                          { from: "from-teal-400", to: "to-teal-600" },
                          { from: "from-amber-400", to: "to-amber-600" },
                        ];
                        const color = colors[idx % colors.length];

                        // Calculate relative time
                        const createdAt = tenant.createdAt?.toDate?.();
                        let timeAgo = "Recently";
                        if (createdAt) {
                          const now = new Date();
                          const diffMs = now.getTime() - createdAt.getTime();
                          const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
                          const diffDays = Math.floor(diffHours / 24);
                          
                          if (diffHours < 1) {
                            timeAgo = "Just now";
                          } else if (diffHours < 24) {
                            timeAgo = `Registered ${diffHours}h ago`;
                          } else if (diffDays === 1) {
                            timeAgo = "Registered 1d ago";
                          } else {
                            timeAgo = `Registered ${diffDays}d ago`;
                          }
                        }

                        return (
                          <tr key={tenant.id} className="hover:bg-neutral-50 transition">
                            <td className="px-6 py-4">
                              <div className="flex items-center space-x-3">
                                <div className={`w-10 h-10 bg-gradient-to-br ${color.from} ${color.to} rounded-lg flex items-center justify-center`}>
                                  <span className="text-white font-semibold text-sm">{initials}</span>
                                </div>
                                <div>
                                  <p className="font-medium text-neutral-900">{tenant.name || tenant.displayName || "Unknown"}</p>
                                  <p className="text-xs text-neutral-500">{timeAgo}</p>
                                </div>
                              </div>
                            </td>
                            <td className="px-6 py-4">
                              {state ? (
                                <span className={`px-2 py-1 ${stateCls} rounded-lg text-sm font-medium`}>{state}</span>
                              ) : (
                                <span className="text-sm text-neutral-400">—</span>
                              )}
                            </td>
                            <td className="px-6 py-4">
                              <div className="flex items-center space-x-2">
                                <span className="px-3 py-1 bg-neutral-100 text-neutral-700 rounded-lg text-sm font-semibold">
                                  {tenant.plan || "Starter"}
                                </span>
                                {tenant.price && (
                                  <span className="text-sm text-neutral-500">{tenant.price}</span>
                                )}
                              </div>
                            </td>
                            <td className="px-6 py-4">
                              <span className={`px-3 py-1 ${statusCls} rounded-lg text-sm font-medium flex items-center w-fit`}>
                                <i className={`fas ${statusIcon} text-xs mr-1.5`} />
                                {statusLabel}
                              </span>
                            </td>
                            <td className="px-6 py-4 text-right">
                              <button 
                                onClick={() => router.push("/tenants")}
                                className="px-4 py-2 text-sm font-medium text-neutral-900 hover:bg-neutral-50 rounded-lg transition"
                              >
                                Manage
                                <i className="fas fa-arrow-right ml-2 text-xs" />
                              </button>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              ) : (
                <table className="w-full">
                  <thead className="bg-neutral-50 border-b border-neutral-200">
                    <tr>
                      <th className="px-6 py-4 text-left text-xs font-semibold text-neutral-600 uppercase tracking-wider">Activity</th>
                      <th className="px-6 py-4 text-left text-xs font-semibold text-neutral-600 uppercase tracking-wider">Client</th>
                      <th className="px-6 py-4 text-left text-xs font-semibold text-neutral-600 uppercase tracking-wider">Service</th>
                      <th className="px-6 py-4 text-left text-xs font-semibold text-neutral-600 uppercase tracking-wider">Staff</th>
                      <th className="px-6 py-4 text-left text-xs font-semibold text-neutral-600 uppercase tracking-wider">Booking Date</th>
                      <th className="px-6 py-4 text-right text-xs font-semibold text-neutral-600 uppercase tracking-wider">Amount</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-neutral-200">
                    {recentActivities.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="px-6 py-8 text-center text-neutral-500">
                          <i className="fas fa-calendar-check text-4xl text-neutral-300 mb-3 block" />
                          <p>Booking activity will appear here</p>
                        </td>
                      </tr>
                    ) : (
                      recentActivities.map((activity: any) => {
                        // Activity type config
                        const activityConfig: Record<string, { label: string; bg: string; text: string; icon: string }> = {
                          booking_created: { label: "New Booking", bg: "bg-amber-50", text: "text-amber-700", icon: "fa-plus-circle" },
                          booking_confirmed: { label: "Confirmed", bg: "bg-emerald-50", text: "text-emerald-700", icon: "fa-check-circle" },
                          booking_completed: { label: "Completed", bg: "bg-blue-50", text: "text-blue-700", icon: "fa-circle-check" },
                          booking_cancelled: { label: "Cancelled", bg: "bg-rose-50", text: "text-rose-700", icon: "fa-times-circle" },
                          booking_rescheduled: { label: "Rescheduled", bg: "bg-purple-50", text: "text-purple-700", icon: "fa-calendar-alt" },
                          staff_assigned: { label: "Staff Assigned", bg: "bg-indigo-50", text: "text-indigo-700", icon: "fa-user-plus" },
                        };
                        const activityStyle = activityConfig[activity.activityType] || { label: "Updated", bg: "bg-neutral-100", text: "text-neutral-700", icon: "fa-circle-info" };

                        // Get initials from client name
                        const clientName = activity.clientName || "Unknown";
                        const initials = clientName
                          .split(" ")
                          .map((s: string) => s[0])
                          .filter(Boolean)
                          .slice(0, 2)
                          .join("")
                          .toUpperCase();

                        // Format date and time
                        const bookingDate = activity.date 
                          ? new Date(activity.date).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })
                          : "—";
                        const bookingTime = activity.time || "";

                        // Calculate relative time for activity
                        const createdAt = activity.createdAt?.toDate?.() || 
                                          (activity.createdAt?.seconds ? new Date(activity.createdAt.seconds * 1000) : null);
                        let timeAgo = "";
                        if (createdAt) {
                          const now = new Date();
                          const diffMs = now.getTime() - createdAt.getTime();
                          const diffMins = Math.floor(diffMs / (1000 * 60));
                          const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
                          const diffDays = Math.floor(diffHours / 24);
                          
                          if (diffMins < 1) {
                            timeAgo = "Just now";
                          } else if (diffMins < 60) {
                            timeAgo = `${diffMins}m ago`;
                          } else if (diffHours < 24) {
                            timeAgo = `${diffHours}h ago`;
                          } else if (diffDays === 1) {
                            timeAgo = "1d ago";
                          } else {
                            timeAgo = `${diffDays}d ago`;
                          }
                        }

                        return (
                          <tr key={activity.id} className="hover:bg-neutral-50 transition">
                            <td className="px-6 py-4">
                              <div className="flex items-center space-x-3">
                                <div className={`w-9 h-9 ${activityStyle.bg} rounded-lg flex items-center justify-center`}>
                                  <i className={`fas ${activityStyle.icon} ${activityStyle.text}`} />
                                </div>
                                <div>
                                  <span className={`px-2.5 py-1 ${activityStyle.bg} ${activityStyle.text} rounded-lg text-xs font-semibold`}>
                                    {activityStyle.label}
                                  </span>
                                  {timeAgo && <p className="text-xs text-neutral-400 mt-1">{timeAgo}</p>}
                                </div>
                              </div>
                            </td>
                            <td className="px-6 py-4">
                              <div className="flex items-center space-x-2">
                                <div className="w-8 h-8 bg-neutral-900 rounded-full flex items-center justify-center">
                                  <span className="text-white font-semibold text-xs">{initials}</span>
                                </div>
                                <span className="text-sm font-medium text-neutral-900">{clientName}</span>
                              </div>
                            </td>
                            <td className="px-6 py-4">
                              <p className="text-sm text-neutral-900">{activity.serviceName || "—"}</p>
                              {activity.branchName && (
                                <p className="text-xs text-neutral-500">{activity.branchName}</p>
                              )}
                            </td>
                            <td className="px-6 py-4">
                              {(() => {
                                // Get staff names from services array or staffName field
                                let staffNames: string[] = [];
                                if (Array.isArray(activity.services) && activity.services.length > 0) {
                                  staffNames = activity.services
                                    .map((s: any) => s.staffName)
                                    .filter((name: string) => name && name !== "Any Available" && name !== "Not Assigned Yet");
                                } else if (activity.staffName) {
                                  // staffName might be comma-separated for multiple staff
                                  staffNames = activity.staffName.split(",").map((n: string) => n.trim()).filter(Boolean);
                                }
                                
                                // Get unique staff names
                                const uniqueStaff = [...new Set(staffNames)];
                                
                                if (uniqueStaff.length === 0) {
                                  return <span className="text-sm text-neutral-400">—</span>;
                                }
                                
                                if (uniqueStaff.length === 1) {
                                  return (
                                    <div className="flex items-center space-x-2">
                                      <div className="w-7 h-7 bg-gradient-to-br from-indigo-400 to-indigo-600 rounded-full flex items-center justify-center">
                                        <i className="fas fa-user text-white text-xs" />
                                      </div>
                                      <span className="text-sm font-medium text-neutral-900">{uniqueStaff[0]}</span>
                                    </div>
                                  );
                                }
                                
                                // Multiple staff - show as stacked avatars with names
                                return (
                                  <div className="flex flex-col gap-1">
                                    {uniqueStaff.map((name, idx) => (
                                      <div key={idx} className="flex items-center space-x-2">
                                        <div className={`w-6 h-6 bg-neutral-900 rounded-full flex items-center justify-center`}>
                                          <i className="fas fa-user text-white text-[10px]" />
                                        </div>
                                        <span className="text-xs font-medium text-neutral-900">{name}</span>
                                      </div>
                                    ))}
                                  </div>
                                );
                              })()}
                            </td>
                            <td className="px-6 py-4">
                              <p className="text-sm text-neutral-900">{bookingDate}</p>
                              {bookingTime && <p className="text-xs text-neutral-500">{bookingTime}</p>}
                            </td>
                            <td className="px-6 py-4 text-right">
                              <span className="font-semibold text-neutral-900">
                                AU${(Number(activity.price) || 0).toLocaleString()}
                              </span>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              )}
            </div>
          </div>
          )}
          </>
          )}
        </main>
        )}

        {/* Load Chart.js from CDN and build charts */}
        <Script
          src="https://cdn.jsdelivr.net/npm/chart.js"
          strategy="afterInteractive"
          onLoad={buildCharts}
        />

        {/* Notification Panel - Fixed position */}
        {notificationPanelOpen && (
        <>
          {/* Backdrop - no blur */}
          <div 
            className="fixed inset-0 z-40 bg-black/30" 
            onClick={() => setNotificationPanelOpen(false)}
          />
          
          {/* Panel - wider and lower */}
          <div className="fixed top-20 right-4 sm:top-24 sm:right-6 lg:right-8 w-[calc(100%-2rem)] sm:w-[480px] md:w-[550px] lg:w-[600px] max-h-[80vh] bg-white rounded-2xl shadow-2xl border border-neutral-200 overflow-hidden z-50 animate-slideDown">
            {/* Panel Header */}
            <div className="px-5 py-4 bg-gradient-to-r from-neutral-900 to-neutral-800 text-white">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-amber-500/20 flex items-center justify-center">
                    <i className="fas fa-bell" />
                  </div>
                  <div>
                    <h3 className="font-bold text-lg">Notifications</h3>
                    {unreadCount > 0 && (
                      <p className="text-xs text-neutral-400">{unreadCount} unread</p>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {unreadCount > 0 && (
                    <button 
                      onClick={markAllAsRead}
                      className="px-3 py-1.5 text-xs bg-white/10 hover:bg-white/20 rounded-lg transition font-medium"
                    >
                      Mark all read
                    </button>
                  )}
                  {notifications.length > 0 && (
                    <button 
                      onClick={() => setShowDeleteAllModal(true)}
                      className="px-3 py-1.5 text-xs bg-red-500/20 hover:bg-red-500/30 text-red-200 rounded-lg transition font-medium"
                      title="Delete all notifications"
                    >
                      Clear all
                    </button>
                  )}
                  <button 
                    onClick={() => setNotificationPanelOpen(false)}
                    className="w-8 h-8 rounded-lg bg-white/10 hover:bg-white/20 flex items-center justify-center transition"
                  >
                    <i className="fas fa-times" />
                  </button>
                </div>
              </div>
            </div>

            {/* Notifications List */}
            <div className="max-h-[60vh] overflow-y-auto bg-neutral-50">
              {notifications.length === 0 ? (
                <div className="px-6 py-16 text-center bg-white">
                  <div className="w-20 h-20 mx-auto mb-4 rounded-2xl bg-gradient-to-br from-neutral-100 to-neutral-200 flex items-center justify-center">
                    <i className="fas fa-bell-slash text-3xl text-neutral-400" />
                  </div>
                  <p className="text-neutral-700 font-semibold text-lg">No notifications yet</p>
                  <p className="text-sm text-neutral-500 mt-2 max-w-xs mx-auto">
                    When you receive new booking requests, they'll appear here
                  </p>
                </div>
              ) : (
                <div className="p-3 space-y-2">
                  {notifications.map((notif) => {
                    const timeAgo = (() => {
                      const now = new Date();
                      const created = new Date(notif.createdAt);
                      const diffMs = now.getTime() - created.getTime();
                      const diffMins = Math.floor(diffMs / (1000 * 60));
                      const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
                      const diffDays = Math.floor(diffHours / 24);
                      
                      if (diffMins < 1) return 'Just now';
                      if (diffMins < 60) return `${diffMins}m ago`;
                      if (diffHours < 24) return `${diffHours}h ago`;
                      return `${diffDays}d ago`;
                    })();

                    return (
                      <div 
                        key={notif.id}
                        className={`p-4 rounded-xl transition-all hover:scale-[1.02] relative group ${
                          !notif.read 
                            ? 'bg-white shadow-md border-l-4 border-amber-500' 
                            : 'bg-white/60 hover:bg-white'
                        }`}
                      >
                        {/* Delete button - appears on hover */}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteNotification(notif.id);
                          }}
                          className="absolute top-2 right-2 w-7 h-7 rounded-lg bg-neutral-100 hover:bg-red-100 text-neutral-400 hover:text-red-500 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all z-10"
                          title="Delete notification"
                        >
                          <i className="fas fa-trash-alt text-xs" />
                        </button>
                        
                        <div 
                          onClick={() => {
                            markAsRead(notif.id);
                            router.push('/bookings/pending');
                            setNotificationPanelOpen(false);
                          }}
                          className="cursor-pointer"
                        >
                          <div className="flex items-start gap-3">
                            <div className={`w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0 ${
                              notif.type === 'booking_request' 
                                ? 'bg-gradient-to-br from-amber-400 to-orange-500 text-white'
                                : 'bg-neutral-900 text-white'
                            }`}>
                              <i className={`fas ${
                                notif.type === 'booking_request' ? 'fa-calendar-plus' : 'fa-bell'
                              } text-lg`} />
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center justify-between gap-2 pr-8">
                                <div className="flex items-center gap-2">
                                  <p className="font-bold text-neutral-900">{notif.title}</p>
                                  {!notif.read && (
                                    <span className="px-2 py-0.5 bg-amber-500 text-white text-[10px] font-bold rounded-full uppercase">New</span>
                                  )}
                                </div>
                                <span className="text-xs text-neutral-400 flex-shrink-0">{timeAgo}</span>
                              </div>
                              <p className="text-sm text-neutral-600 mt-1">{notif.message}</p>
                              <div className="flex items-center flex-wrap gap-2 mt-3">
                                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-neutral-100 rounded-lg text-xs text-neutral-600">
                                  <i className="fas fa-tag text-amber-500" />
                                  {notif.serviceName}
                                </span>
                                {notif.date && (
                                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-neutral-100 rounded-lg text-xs text-neutral-600">
                                    <i className="fas fa-calendar text-blue-500" />
                                    {new Date(notif.date).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })}
                                  </span>
                                )}
                                {notif.price && (
                                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-emerald-50 rounded-lg text-xs text-emerald-700 font-semibold">
                                    <i className="fas fa-dollar-sign" />
                                    AU${Number(notif.price).toLocaleString()}
                                  </span>
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

            {/* Panel Footer */}
            <div className="p-4 bg-white border-t border-neutral-200">
              <button 
                onClick={() => {
                  router.push('/bookings/pending');
                  setNotificationPanelOpen(false);
                }}
                className="w-full py-3 bg-neutral-900 hover:bg-neutral-800 text-white rounded-xl font-semibold transition flex items-center justify-center gap-2 shadow-lg"
              >
                <i className="fas fa-calendar-check" />
                View All Booking Requests
              </button>
            </div>
          </div>
        </>
      )}

        {/* Toast Notifications are now rendered by NotificationProvider */}

        {/* Animation for notification bell and panel */}
        <style>{`
        @keyframes wiggle {
          0%, 100% { transform: rotate(0deg); }
          15% { transform: rotate(12deg); }
          30% { transform: rotate(-10deg); }
          45% { transform: rotate(8deg); }
          60% { transform: rotate(-6deg); }
          75% { transform: rotate(4deg); }
        }
        .group:hover .group-hover\\:animate-wiggle {
          animation: wiggle 0.5s ease-in-out;
        }
        @keyframes slideDown {
          from {
            opacity: 0;
            transform: translateY(-10px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        .animate-slideDown {
          animation: slideDown 0.2s ease-out;
        }
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.6; }
        }
        .animate-pulse {
          animation: pulse 2s ease-in-out infinite;
        }
        @keyframes slideIn {
          from {
            opacity: 0;
            transform: translateX(100px);
          }
          to {
            opacity: 1;
            transform: translateX(0);
          }
        }
        .animate-slideIn {
          animation: slideIn 0.4s cubic-bezier(0.16, 1, 0.3, 1);
        }
        `}</style>

        {/* Delete All Notifications Confirmation Modal */}
        {showDeleteAllModal && (
        <div 
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
          onClick={() => setShowDeleteAllModal(false)}
        >
          <div 
            className="bg-white rounded-2xl shadow-2xl max-w-md w-full mx-4 transform transition-all animate-slideIn"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="px-6 py-5 border-b border-neutral-200">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-full bg-red-100 flex items-center justify-center">
                  <i className="fas fa-exclamation-triangle text-red-600 text-xl"></i>
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-neutral-900">Delete All Notifications</h3>
                  <p className="text-sm text-neutral-500 mt-0.5">This action cannot be undone</p>
                </div>
              </div>
            </div>

            {/* Modal Body */}
            <div className="px-6 py-5">
              <p className="text-neutral-700">
                Are you sure you want to delete all <span className="font-semibold text-neutral-900">{notifications.length}</span> notification{notifications.length !== 1 ? 's' : ''}? 
                This will permanently remove all notifications from your account.
              </p>
            </div>

            {/* Modal Footer */}
            <div className="px-6 py-4 border-t border-neutral-200 flex items-center justify-end gap-3">
              <button
                onClick={() => setShowDeleteAllModal(false)}
                className="px-4 py-2 text-sm font-medium text-neutral-700 bg-neutral-100 hover:bg-neutral-200 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  deleteAllNotifications();
                  setShowDeleteAllModal(false);
                }}
                className="px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors flex items-center gap-2"
              >
                <i className="fas fa-trash"></i>
                Delete All
              </button>
            </div>
          </div>
        </div>
        )}
      </div>
    </div>
  );
}



