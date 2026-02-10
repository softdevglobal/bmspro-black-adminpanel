"use client";
import React, { useEffect, useRef, useState } from "react";
import Sidebar from "@/components/Sidebar";
import { useRouter } from "next/navigation";
import { onAuthStateChanged } from "firebase/auth";
import Script from "next/script";
import { collection, query, where, onSnapshot, getDocs } from "firebase/firestore";
import { useNotifications } from "@/components/NotificationProvider";

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
  
  // Today's Schedule state
  const [todayBookings, setTodayBookings] = useState<any[]>([]);
  const [allBranches, setAllBranches] = useState<string[]>([]);
  const [allStaff, setAllStaff] = useState<any[]>([]);
  const [selectedBranch, setSelectedBranch] = useState<string | null>(null);
  const [selectedStaffId, setSelectedStaffId] = useState<string | null>(null);
  const [scheduleViewMode, setScheduleViewMode] = useState<'time' | 'staff' | 'branch'>('time');
  
  // Use notification context from NotificationProvider
  const { notifications, unreadCount, markAsRead, markAllAsRead, deleteNotification, deleteAllNotifications } = useNotifications();
  const [notificationPanelOpen, setNotificationPanelOpen] = useState(false);
  const [showDeleteAllModal, setShowDeleteAllModal] = useState(false);
  
  const revCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const statusCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const chartsRef = useRef<{ revenue?: any; status?: any }>({});
  const builtRef = useRef(false);

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
          if (role === "salon_branch_admin") {
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
              // Only count salon_staff and salon_branch_admin roles
              const role = (s.role || "").toLowerCase();
              return role === "salon_staff" || role === "salon_branch_admin";
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
      const tenantsQuery = query(collection(db, "users"), where("role", "==", "salon_owner"));
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
          where("role", "==", "salon_owner")
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
      gradient.addColorStop(0, "rgba(236, 72, 153, 0.25)");
      gradient.addColorStop(1, "rgba(236, 72, 153, 0)");
    }
    const revenue = new Chart(ctx as any, {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "Revenue",
            data: revenueSeries,
            borderColor: "#ec4899",
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
          x: { grid: { display: false }, ticks: { color: "#94a3b8" } },
          y: {
            grid: { color: "#e2e8f0" },
            ticks: {
              color: "#94a3b8",
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
          legend: { display: true, position: "right", labels: { color: "#64748b" } },
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
          <div className="flex-1 flex items-center justify-center bg-slate-50">
            <div className="text-center">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-pink-600 mx-auto mb-4"></div>
              <p className="text-slate-600">Loading dashboard...</p>
            </div>
          </div>
        ) : (
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
            <div className="rounded-2xl bg-gradient-to-r from-pink-500 via-fuchsia-600 to-indigo-600 text-white p-6 shadow-lg relative overflow-hidden">
              <div className="relative z-10 flex items-center justify-between">
                <div className="flex items-center gap-4">
                  {/* Logo or default icon */}
                  {logoUrl ? (
                    <div className="w-14 h-14 rounded-xl bg-white p-1.5 shadow-lg">
                      <img src={logoUrl} alt="Salon Logo" className="w-full h-full object-contain rounded-lg" />
                    </div>
                  ) : (
                    <div className="w-14 h-14 rounded-xl bg-white/20 flex items-center justify-center backdrop-blur-sm">
                      <i className="fas fa-chart-line text-2xl" />
                    </div>
                  )}
                  <div>
                    <h1 className="text-2xl font-bold">
                      {isSuperAdmin ? "BMS Pro Admin" : (isBranchAdmin ? branchAdminBranchName : (salonName || "Dashboard"))}
                    </h1>
                    <p className="text-sm text-white/80 mt-1">
                      {isSuperAdmin ? "Super Admin Dashboard" : (isBranchAdmin ? "Branch Dashboard" : (salonName ? "Business Overview" : "Real-time system overview"))}
                    </p>
                  </div>
                </div>

                {/* Right side - Notification icon */}
                <div className="flex items-center gap-3">
                  <button 
                    onClick={() => setNotificationPanelOpen(!notificationPanelOpen)}
                    className={`relative w-12 h-12 rounded-xl flex items-center justify-center transition-all backdrop-blur-sm group ${
                      notificationPanelOpen ? 'bg-white/40' : 'bg-white/20 hover:bg-white/30'
                    }`}
                    title="Notifications"
                  >
                    <i className={`fas fa-bell text-lg ${unreadCount > 0 ? 'animate-pulse' : ''} group-hover:animate-wiggle`} />
                    {/* Notification badge - show if there are unread notifications */}
                    {unreadCount > 0 && (
                      <span className="absolute -top-1 -right-1 w-5 h-5 bg-red-500 text-white text-xs font-bold rounded-full flex items-center justify-center shadow-lg border-2 border-white/20 animate-bounce">
                        {unreadCount > 9 ? '9+' : unreadCount}
                      </span>
                    )}
                  </button>
                </div>
              </div>
              <div className="absolute top-0 right-0 -mr-10 -mt-10 w-64 h-64 rounded-full bg-white opacity-10 blur-2xl" />
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
            <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm min-w-0">
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm font-medium text-slate-600">
                  {isSuperAdmin ? "Platform Revenue" : "Monthly Revenue"}
                </span>
                <div className="w-10 h-10 bg-pink-50 rounded-xl flex items-center justify-center">
                  <i className="fas fa-dollar-sign text-pink-500" />
                </div>
              </div>
              <div className="mb-2">
                <h3 className="text-3xl font-bold text-slate-900">AU${monthlyRevenue.toLocaleString()}</h3>
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
                <span className="text-xs text-slate-500">vs last month</span>
              </div>
            </div>
            <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm min-w-0">
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm font-medium text-slate-600">
                  {isSuperAdmin ? "Total Bookings" : "Total Bookings"}
                </span>
                <div className="w-10 h-10 bg-blue-50 rounded-xl flex items-center justify-center">
                  <i className="fas fa-calendar-check text-blue-500" />
                </div>
              </div>
              <div className="mb-2">
                <h3 className="text-3xl font-bold text-slate-900">{totalBookings}</h3>
              </div>
              <div className="flex items-center space-x-2">
                <span className="px-2 py-1 bg-emerald-50 text-emerald-700 rounded-lg text-xs font-semibold flex items-center">
                  <i className="fas fa-plus text-xs mr-1" />
                  +{weeklyBookings}
                </span>
                <span className="text-xs text-slate-500">this week</span>
              </div>
            </div>
            <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm min-w-0">
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm font-medium text-slate-600">
                  {isSuperAdmin ? "Active Tenants" : "Active Staff"}
                </span>
                <div className="w-10 h-10 bg-amber-50 rounded-xl flex items-center justify-center">
                  <i className={`fas ${isSuperAdmin ? 'fa-store' : 'fa-users'} text-amber-500`} />
                </div>
              </div>
              <div className="mb-2">
                <h3 className="text-3xl font-bold text-slate-900">{activeStaff}</h3>
              </div>
              <div className="text-xs text-slate-500">{isSuperAdmin ? "Active salon owners" : "Available for booking"}</div>
            </div>
            <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm min-w-0">
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm font-medium text-slate-600">
                  {isSuperAdmin ? "Total Tenants" : "Active Services"}
                </span>
                <div className="w-10 h-10 bg-purple-50 rounded-xl flex items-center justify-center">
                  <i className={`fas ${isSuperAdmin ? 'fa-building' : 'fa-tags'} text-purple-500`} />
                </div>
              </div>
              <div className="mb-2">
                <h3 className="text-3xl font-bold text-slate-900">{activeServices}</h3>
              </div>
              <div className="text-xs text-slate-500">{isSuperAdmin ? "All registered tenants" : "In catalog"}</div>
            </div>
          </div>
          
          {/* Today's Schedule Section */}
          {!authLoading && !isSuperAdmin && (
            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm mb-8">
              <div className="p-6 border-b border-slate-200">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-gradient-to-br from-pink-500 to-purple-500 rounded-xl flex items-center justify-center">
                      <i className="fas fa-calendar-day text-white" />
                    </div>
                    <div>
                      <h3 className="font-semibold text-lg text-slate-900">Today's Schedule</h3>
                      <p className="text-sm text-slate-500">
                        {new Date().toLocaleDateString('en-AU', { weekday: 'short', month: 'short', day: 'numeric' })}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="px-3 py-1.5 bg-pink-50 text-pink-700 rounded-full text-sm font-semibold">
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
                  <div className="flex bg-slate-100 rounded-lg p-1">
                    <button
                      onClick={() => setScheduleViewMode('time')}
                      className={`px-3 py-1.5 rounded-md text-sm font-medium transition-all ${
                        scheduleViewMode === 'time' 
                          ? 'bg-white text-pink-600 shadow-sm' 
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      <i className="fas fa-clock mr-1.5" />Time
                    </button>
                    <button
                      onClick={() => setScheduleViewMode('staff')}
                      className={`px-3 py-1.5 rounded-md text-sm font-medium transition-all ${
                        scheduleViewMode === 'staff' 
                          ? 'bg-white text-pink-600 shadow-sm' 
                          : 'text-slate-600 hover:text-slate-900'
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
                            ? 'bg-white text-pink-600 shadow-sm' 
                            : 'text-slate-600 hover:text-slate-900'
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
                      className="px-3 py-1.5 bg-white border border-slate-200 rounded-lg text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-pink-500"
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
                      className="px-3 py-1.5 bg-white border border-slate-200 rounded-lg text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-pink-500"
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
                        <i className="fas fa-calendar-xmark text-5xl text-slate-300 mb-4" />
                        <p className="text-slate-500 font-medium">No bookings for today</p>
                        <p className="text-slate-400 text-sm mt-1">Bookings will appear here as they are scheduled</p>
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
                              <div className="flex items-center gap-2 bg-gradient-to-r from-pink-500 to-purple-500 text-white px-3 py-1.5 rounded-full shadow-sm">
                                <i className="fas fa-clock text-xs" />
                                <span className="text-sm font-bold">{formatTime(time)}</span>
                              </div>
                              <div className="flex-1 h-px bg-gradient-to-r from-pink-200 to-transparent" />
                              <span className="text-xs font-medium text-slate-500 bg-slate-100 px-2 py-1 rounded-full">
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
                                        <div className="w-10 h-10 bg-gradient-to-br from-pink-400 to-purple-500 rounded-full flex items-center justify-center text-white font-bold text-sm shadow-md">
                                          {entry.client?.charAt(0)?.toUpperCase() || '?'}
                                        </div>
                                        <div>
                                          <h4 className="font-semibold text-slate-900">{entry.client}</h4>
                                          {entry.clientPhone && (
                                            <p className="text-xs text-slate-500">
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
                                          <span className="text-[10px] text-slate-400">
                                            Service {entry.serviceIndex}/{entry.totalServices}
                                          </span>
                                        )}
                                      </div>
                                    </div>
                                    
                                    {/* Service details */}
                                    <div className="bg-white/60 rounded-lg p-3 mb-3">
                                      <div className="flex items-center justify-between">
                                        <div className="flex items-center gap-2">
                                          <div className="w-8 h-8 bg-purple-100 rounded-lg flex items-center justify-center">
                                            <i className="fas fa-spa text-purple-600 text-sm" />
                                          </div>
                                          <div>
                                            <p className="font-medium text-slate-900">{entry.serviceName}</p>
                                            <div className="flex items-center gap-2 text-xs text-slate-500">
                                              <span><i className="fas fa-hourglass-half mr-1" />{formatDuration(entry.duration)}</span>
                                              <span>•</span>
                                              <span>{formatTime(entry.time)} - {formatTime(getEndTime(entry.time, entry.duration))}</span>
                                            </div>
                                          </div>
                                        </div>
                                        <div className="text-right">
                                          <p className="font-bold text-pink-600">AU${entry.price.toLocaleString()}</p>
                                          {entry.isMultiService && (
                                            <p className="text-[10px] text-slate-400">Total: AU${entry.totalPrice.toLocaleString()}</p>
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
                      { bg: 'from-indigo-500 to-purple-600', light: 'indigo' },
                      { bg: 'from-pink-500 to-rose-600', light: 'pink' },
                      { bg: 'from-emerald-500 to-teal-600', light: 'emerald' },
                      { bg: 'from-amber-500 to-orange-600', light: 'amber' },
                      { bg: 'from-cyan-500 to-blue-600', light: 'cyan' },
                    ];

                    return (
                      <div className="space-y-6">
                        {Object.entries(byStaff).sort((a, b) => a[1].name.localeCompare(b[1].name)).map(([staffId, { name, bookings }], staffIdx) => {
                          const colorScheme = staffColors[staffIdx % staffColors.length];
                          const totalRevenue = getTotalRevenue(bookings);
                          const totalDuration = getTotalDuration(bookings);
                          const sortedBookings = [...bookings].sort((a, b) => (a.time || '').localeCompare(b.time || ''));
                          
                          return (
                            <div key={staffId} className="rounded-2xl overflow-hidden shadow-lg border border-slate-200">
                              {/* Staff Header */}
                              <div className={`bg-gradient-to-r ${staffId === 'unassigned' ? 'from-slate-400 to-slate-500' : colorScheme.bg} p-5`}>
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
                              <div className="md:hidden bg-slate-50 px-4 py-3 flex justify-around border-b border-slate-200">
                                <div className="text-center">
                                  <p className="text-slate-500 text-xs">Duration</p>
                                  <p className="text-slate-900 font-semibold">{formatDuration(totalDuration)}</p>
                                </div>
                                <div className="text-center">
                                  <p className="text-slate-500 text-xs">Revenue</p>
                                  <p className="text-slate-900 font-semibold">AU${totalRevenue.toLocaleString()}</p>
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
                                        className="relative pl-6 pb-3 border-l-2 border-slate-200 last:border-l-transparent last:pb-0"
                                      >
                                        {/* Timeline dot */}
                                        <div className={`absolute -left-[9px] top-0 w-4 h-4 rounded-full border-2 border-white shadow ${
                                          b.status.toLowerCase() === 'confirmed' ? 'bg-emerald-500' :
                                          b.status.toLowerCase() === 'completed' ? 'bg-blue-500' :
                                          'bg-amber-500'
                                        }`} />
                                        
                                        <div className="bg-gradient-to-br from-slate-50 to-white rounded-xl border border-slate-200 overflow-hidden hover:shadow-md transition-shadow">
                                          {/* Booking Header */}
                                          <div className="p-4">
                                            <div className="flex items-start justify-between mb-3">
                                              <div className="flex items-center gap-3">
                                                <div className="w-10 h-10 bg-gradient-to-br from-pink-400 to-purple-500 rounded-full flex items-center justify-center text-white font-bold shadow">
                                                  {b.client?.charAt(0)?.toUpperCase() || '?'}
                                                </div>
                                                <div>
                                                  <h4 className="font-semibold text-slate-900">{b.client}</h4>
                                                  {b.clientPhone && (
                                                    <p className="text-xs text-slate-500">
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
                                                <span className="text-lg font-bold text-pink-600">AU${bookingPrice.toLocaleString()}</span>
                                              </div>
                                            </div>
                                            
                                            {/* Services */}
                                            <div className="space-y-2">
                                              {servicesList.map((svc: any, svcIdx: number) => (
                                                <div key={svcIdx} className="flex items-center justify-between bg-white/80 rounded-lg p-2 border border-slate-100">
                                                  <div className="flex items-center gap-2">
                                                    <div className="w-7 h-7 bg-purple-100 rounded-lg flex items-center justify-center">
                                                      <i className="fas fa-spa text-purple-600 text-xs" />
                                                    </div>
                                                    <div>
                                                      <p className="text-sm font-medium text-slate-900">{svc.name}</p>
                                                      <p className="text-xs text-slate-500">
                                                        <i className="fas fa-clock mr-1" />
                                                        {formatTime(svc.time || b.time || '09:00')}
                                                        {svc.duration && ` • ${formatDuration(svc.duration)}`}
                                                      </p>
                                                    </div>
                                                  </div>
                                                  {svc.price && (
                                                    <span className="text-sm font-semibold text-slate-700">AU${Number(svc.price).toLocaleString()}</span>
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
                      { bg: 'from-pink-500 to-rose-600', accent: 'pink' },
                      { bg: 'from-blue-500 to-indigo-600', accent: 'blue' },
                      { bg: 'from-emerald-500 to-teal-600', accent: 'emerald' },
                      { bg: 'from-purple-500 to-violet-600', accent: 'purple' },
                      { bg: 'from-amber-500 to-orange-600', accent: 'amber' },
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
                            <div key={branch} className="rounded-2xl overflow-hidden shadow-lg border border-slate-200">
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
                              <div className="md:hidden bg-slate-50 px-4 py-3 flex justify-around border-b border-slate-200">
                                <div className="text-center">
                                  <p className="text-slate-500 text-xs">Confirmed</p>
                                  <p className="text-slate-900 font-semibold">{confirmedCount}/{branchBookings.length}</p>
                                </div>
                                <div className="text-center">
                                  <p className="text-slate-500 text-xs">Staff</p>
                                  <p className="text-slate-900 font-semibold">{uniqueStaff}</p>
                                </div>
                                <div className="text-center">
                                  <p className="text-slate-500 text-xs">Revenue</p>
                                  <p className="text-slate-900 font-semibold">AU${totalRevenue.toLocaleString()}</p>
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
                                              <div className="w-11 h-11 bg-gradient-to-br from-pink-400 to-purple-500 rounded-full flex items-center justify-center text-white font-bold shadow">
                                                {b.client?.charAt(0)?.toUpperCase() || '?'}
                                              </div>
                                              <div>
                                                <h4 className="font-semibold text-slate-900">{b.client}</h4>
                                                <div className="flex items-center gap-2 text-xs text-slate-500">
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
                                              <div key={svcIdx} className="flex items-center justify-between bg-white/80 rounded-lg p-2.5 border border-slate-100">
                                                <div className="flex items-center gap-2">
                                                  <div className="w-8 h-8 bg-purple-100 rounded-lg flex items-center justify-center">
                                                    <i className="fas fa-spa text-purple-600 text-sm" />
                                                  </div>
                                                  <div>
                                                    <p className="text-sm font-medium text-slate-900">{svc.name}</p>
                                                    {svc.duration && (
                                                      <p className="text-xs text-slate-500">
                                                        <i className="fas fa-hourglass-half mr-1" />{formatDuration(svc.duration)}
                                                      </p>
                                                    )}
                                                  </div>
                                                </div>
                                                <div className="text-right">
                                                  {svc.price && (
                                                    <p className="text-sm font-semibold text-pink-600">AU${Number(svc.price).toLocaleString()}</p>
                                                  )}
                                                </div>
                                              </div>
                                            ))}
                                          </div>
                                          
                                          {/* Footer */}
                                          <div className="flex items-center justify-between pt-2 border-t border-slate-100">
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
                                            <p className="text-lg font-bold text-pink-600">AU${bookingPrice.toLocaleString()}</p>
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
          
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
            <div className="lg:col-span-2 bg-white p-6 rounded-2xl border border-slate-200 shadow-sm min-w-0 overflow-hidden">
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h3 className="font-semibold text-lg text-slate-900">
                    {isSuperAdmin ? "Platform Revenue Trend" : "Revenue Trend"}
                  </h3>
                  <p className="text-sm text-slate-500 mt-1">
                    {isSuperAdmin ? "Last 6 months (all tenants)" : "Last 6 months"}
                  </p>
                </div>
              </div>
              <div className="h-[280px] relative">
                <canvas ref={revCanvasRef} />
              </div>
            </div>
            <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm min-w-0">
              <div className="mb-6">
                <h3 className="font-semibold text-lg text-slate-900">
                  {isSuperAdmin ? "Platform Booking Status" : "Booking Status"}
                </h3>
                <p className="text-sm text-slate-500 mt-1">
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
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm">
            <div className="p-6 border-b border-slate-200">
              <div>
                <h3 className="font-semibold text-lg text-slate-900">Recent Activity</h3>
                <p className="text-sm text-slate-500 mt-1">
                  {isSuperAdmin ? "Latest tenant onboardings" : "Recent bookings"}
                </p>
              </div>
            </div>
            <div className="overflow-x-auto">
              {isSuperAdmin ? (
                <table className="w-full">
                  <thead className="bg-slate-50 border-b border-slate-200">
                    <tr>
                      <th className="px-6 py-4 text-left text-xs font-semibold text-slate-600 uppercase tracking-wider">Business Name</th>
                      <th className="px-6 py-4 text-left text-xs font-semibold text-slate-600 uppercase tracking-wider">Location</th>
                      <th className="px-6 py-4 text-left text-xs font-semibold text-slate-600 uppercase tracking-wider">Plan</th>
                      <th className="px-6 py-4 text-left text-xs font-semibold text-slate-600 uppercase tracking-wider">Status</th>
                      <th className="px-6 py-4 text-right text-xs font-semibold text-slate-600 uppercase tracking-wider">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {recentTenants.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="px-6 py-8 text-center text-slate-500">
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
                          : "bg-slate-100 text-slate-700";
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
                          : "bg-slate-100 text-slate-700";

                        const colors = [
                          { from: "from-pink-400", to: "to-pink-600" },
                          { from: "from-blue-400", to: "to-blue-600" },
                          { from: "from-purple-400", to: "to-purple-600" },
                          { from: "from-teal-400", to: "to-teal-600" },
                          { from: "from-rose-400", to: "to-rose-600" },
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
                          <tr key={tenant.id} className="hover:bg-slate-50 transition">
                            <td className="px-6 py-4">
                              <div className="flex items-center space-x-3">
                                <div className={`w-10 h-10 bg-gradient-to-br ${color.from} ${color.to} rounded-lg flex items-center justify-center`}>
                                  <span className="text-white font-semibold text-sm">{initials}</span>
                                </div>
                                <div>
                                  <p className="font-medium text-slate-900">{tenant.name || tenant.displayName || "Unknown"}</p>
                                  <p className="text-xs text-slate-500">{timeAgo}</p>
                                </div>
                              </div>
                            </td>
                            <td className="px-6 py-4">
                              {state ? (
                                <span className={`px-2 py-1 ${stateCls} rounded-lg text-sm font-medium`}>{state}</span>
                              ) : (
                                <span className="text-sm text-slate-400">—</span>
                              )}
                            </td>
                            <td className="px-6 py-4">
                              <div className="flex items-center space-x-2">
                                <span className="px-3 py-1 bg-pink-50 text-pink-700 rounded-lg text-sm font-semibold">
                                  {tenant.plan || "Starter"}
                                </span>
                                {tenant.price && (
                                  <span className="text-sm text-slate-500">{tenant.price}</span>
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
                                className="px-4 py-2 text-sm font-medium text-pink-600 hover:bg-pink-50 rounded-lg transition"
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
                  <thead className="bg-slate-50 border-b border-slate-200">
                    <tr>
                      <th className="px-6 py-4 text-left text-xs font-semibold text-slate-600 uppercase tracking-wider">Activity</th>
                      <th className="px-6 py-4 text-left text-xs font-semibold text-slate-600 uppercase tracking-wider">Client</th>
                      <th className="px-6 py-4 text-left text-xs font-semibold text-slate-600 uppercase tracking-wider">Service</th>
                      <th className="px-6 py-4 text-left text-xs font-semibold text-slate-600 uppercase tracking-wider">Staff</th>
                      <th className="px-6 py-4 text-left text-xs font-semibold text-slate-600 uppercase tracking-wider">Booking Date</th>
                      <th className="px-6 py-4 text-right text-xs font-semibold text-slate-600 uppercase tracking-wider">Amount</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {recentActivities.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="px-6 py-8 text-center text-slate-500">
                          <i className="fas fa-calendar-check text-4xl text-slate-300 mb-3 block" />
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
                        const activityStyle = activityConfig[activity.activityType] || { label: "Updated", bg: "bg-slate-100", text: "text-slate-700", icon: "fa-circle-info" };

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
                          <tr key={activity.id} className="hover:bg-slate-50 transition">
                            <td className="px-6 py-4">
                              <div className="flex items-center space-x-3">
                                <div className={`w-9 h-9 ${activityStyle.bg} rounded-lg flex items-center justify-center`}>
                                  <i className={`fas ${activityStyle.icon} ${activityStyle.text}`} />
                                </div>
                                <div>
                                  <span className={`px-2.5 py-1 ${activityStyle.bg} ${activityStyle.text} rounded-lg text-xs font-semibold`}>
                                    {activityStyle.label}
                                  </span>
                                  {timeAgo && <p className="text-xs text-slate-400 mt-1">{timeAgo}</p>}
                                </div>
                              </div>
                            </td>
                            <td className="px-6 py-4">
                              <div className="flex items-center space-x-2">
                                <div className="w-8 h-8 bg-gradient-to-br from-pink-400 to-pink-600 rounded-full flex items-center justify-center">
                                  <span className="text-white font-semibold text-xs">{initials}</span>
                                </div>
                                <span className="text-sm font-medium text-slate-900">{clientName}</span>
                              </div>
                            </td>
                            <td className="px-6 py-4">
                              <p className="text-sm text-slate-900">{activity.serviceName || "—"}</p>
                              {activity.branchName && (
                                <p className="text-xs text-slate-500">{activity.branchName}</p>
                              )}
                            </td>
                            <td className="px-6 py-4">
                              {(() => {
                                // Get staff names from services array or staffName field
                                let staffNames: string[] = [];
                                if (Array.isArray(activity.services) && activity.services.length > 0) {
                                  staffNames = activity.services
                                    .map((s: any) => s.staffName)
                                    .filter((name: string) => name && name !== "Any Available");
                                } else if (activity.staffName) {
                                  // staffName might be comma-separated for multiple staff
                                  staffNames = activity.staffName.split(",").map((n: string) => n.trim()).filter(Boolean);
                                }
                                
                                // Get unique staff names
                                const uniqueStaff = [...new Set(staffNames)];
                                
                                if (uniqueStaff.length === 0) {
                                  return <span className="text-sm text-slate-400">—</span>;
                                }
                                
                                if (uniqueStaff.length === 1) {
                                  return (
                                    <div className="flex items-center space-x-2">
                                      <div className="w-7 h-7 bg-gradient-to-br from-indigo-400 to-indigo-600 rounded-full flex items-center justify-center">
                                        <i className="fas fa-user text-white text-xs" />
                                      </div>
                                      <span className="text-sm font-medium text-slate-900">{uniqueStaff[0]}</span>
                                    </div>
                                  );
                                }
                                
                                // Multiple staff - show as stacked avatars with names
                                return (
                                  <div className="flex flex-col gap-1">
                                    {uniqueStaff.map((name, idx) => (
                                      <div key={idx} className="flex items-center space-x-2">
                                        <div className={`w-6 h-6 bg-gradient-to-br ${idx === 0 ? 'from-indigo-400 to-indigo-600' : idx === 1 ? 'from-purple-400 to-purple-600' : 'from-pink-400 to-pink-600'} rounded-full flex items-center justify-center`}>
                                          <i className="fas fa-user text-white text-[10px]" />
                                        </div>
                                        <span className="text-xs font-medium text-slate-900">{name}</span>
                                      </div>
                                    ))}
                                  </div>
                                );
                              })()}
                            </td>
                            <td className="px-6 py-4">
                              <p className="text-sm text-slate-900">{bookingDate}</p>
                              {bookingTime && <p className="text-xs text-slate-500">{bookingTime}</p>}
                            </td>
                            <td className="px-6 py-4 text-right">
                              <span className="font-semibold text-slate-900">
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
          <div className="fixed top-20 right-4 sm:top-24 sm:right-6 lg:right-8 w-[calc(100%-2rem)] sm:w-[480px] md:w-[550px] lg:w-[600px] max-h-[80vh] bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden z-50 animate-slideDown">
            {/* Panel Header */}
            <div className="px-5 py-4 bg-gradient-to-r from-slate-900 to-slate-800 text-white">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-pink-500 flex items-center justify-center">
                    <i className="fas fa-bell" />
                  </div>
                  <div>
                    <h3 className="font-bold text-lg">Notifications</h3>
                    {unreadCount > 0 && (
                      <p className="text-xs text-slate-400">{unreadCount} unread</p>
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
            <div className="max-h-[60vh] overflow-y-auto bg-slate-50">
              {notifications.length === 0 ? (
                <div className="px-6 py-16 text-center bg-white">
                  <div className="w-20 h-20 mx-auto mb-4 rounded-2xl bg-gradient-to-br from-slate-100 to-slate-200 flex items-center justify-center">
                    <i className="fas fa-bell-slash text-3xl text-slate-400" />
                  </div>
                  <p className="text-slate-700 font-semibold text-lg">No notifications yet</p>
                  <p className="text-sm text-slate-500 mt-2 max-w-xs mx-auto">
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
                            ? 'bg-white shadow-md border-l-4 border-pink-500' 
                            : 'bg-white/60 hover:bg-white'
                        }`}
                      >
                        {/* Delete button - appears on hover */}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteNotification(notif.id);
                          }}
                          className="absolute top-2 right-2 w-7 h-7 rounded-lg bg-slate-100 hover:bg-red-100 text-slate-400 hover:text-red-500 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all z-10"
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
                                : 'bg-gradient-to-br from-pink-400 to-pink-600 text-white'
                            }`}>
                              <i className={`fas ${
                                notif.type === 'booking_request' ? 'fa-calendar-plus' : 'fa-bell'
                              } text-lg`} />
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center justify-between gap-2 pr-8">
                                <div className="flex items-center gap-2">
                                  <p className="font-bold text-slate-900">{notif.title}</p>
                                  {!notif.read && (
                                    <span className="px-2 py-0.5 bg-pink-500 text-white text-[10px] font-bold rounded-full uppercase">New</span>
                                  )}
                                </div>
                                <span className="text-xs text-slate-400 flex-shrink-0">{timeAgo}</span>
                              </div>
                              <p className="text-sm text-slate-600 mt-1">{notif.message}</p>
                              <div className="flex items-center flex-wrap gap-2 mt-3">
                                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-slate-100 rounded-lg text-xs text-slate-600">
                                  <i className="fas fa-tag text-pink-500" />
                                  {notif.serviceName}
                                </span>
                                {notif.date && (
                                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-slate-100 rounded-lg text-xs text-slate-600">
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
            <div className="p-4 bg-white border-t border-slate-200">
              <button 
                onClick={() => {
                  router.push('/bookings/pending');
                  setNotificationPanelOpen(false);
                }}
                className="w-full py-3 bg-gradient-to-r from-pink-500 to-fuchsia-600 hover:from-pink-600 hover:to-fuchsia-700 text-white rounded-xl font-semibold transition flex items-center justify-center gap-2 shadow-lg shadow-pink-500/25"
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
            <div className="px-6 py-5 border-b border-slate-200">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-full bg-red-100 flex items-center justify-center">
                  <i className="fas fa-exclamation-triangle text-red-600 text-xl"></i>
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-slate-900">Delete All Notifications</h3>
                  <p className="text-sm text-slate-500 mt-0.5">This action cannot be undone</p>
                </div>
              </div>
            </div>

            {/* Modal Body */}
            <div className="px-6 py-5">
              <p className="text-slate-700">
                Are you sure you want to delete all <span className="font-semibold text-slate-900">{notifications.length}</span> notification{notifications.length !== 1 ? 's' : ''}? 
                This will permanently remove all notifications from your account.
              </p>
            </div>

            {/* Modal Footer */}
            <div className="px-6 py-4 border-t border-slate-200 flex items-center justify-end gap-3">
              <button
                onClick={() => setShowDeleteAllModal(false)}
                className="px-4 py-2 text-sm font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors"
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



