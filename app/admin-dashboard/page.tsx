"use client";
import React, { useEffect, useRef, useState } from "react";
import Sidebar from "@/components/Sidebar";
import { useRouter } from "next/navigation";
import { onAuthStateChanged } from "firebase/auth";
import Script from "next/script";
import { collection, query, where, onSnapshot } from "firebase/firestore";
import { useNotifications } from "@/components/NotificationProvider";

export default function AdminDashboardPage() {
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [monthlyRevenue, setMonthlyRevenue] = useState<number>(0);
  const [totalBookings, setTotalBookings] = useState<number>(0);
  const [activeTenants, setActiveTenants] = useState<number>(0);
  const [totalTenants, setTotalTenants] = useState<number>(0);
  const [revenueData, setRevenueData] = useState<number[]>([]);
  const [revenueLabels, setRevenueLabels] = useState<string[]>([]);
  const [statusData, setStatusData] = useState({ confirmed: 0, pending: 0, completed: 0, canceled: 0 });
  const [weeklyBookings, setWeeklyBookings] = useState<number>(0);
  const [revenueGrowth, setRevenueGrowth] = useState<number>(0);
  const [recentTenants, setRecentTenants] = useState<any[]>([]);
  const [authLoading, setAuthLoading] = useState<boolean>(true);
  
  // Additional metrics
  const [totalStaff, setTotalStaff] = useState<number>(0);
  const [totalCustomers, setTotalCustomers] = useState<number>(0);
  const [totalServices, setTotalServices] = useState<number>(0);
  const [todayBookings, setTodayBookings] = useState<number>(0);
  const [avgRevenuePerTenant, setAvgRevenuePerTenant] = useState<number>(0);
  const [mrr, setMrr] = useState<number>(0);
  const [planDistribution, setPlanDistribution] = useState<{ name: string; count: number; revenue: number; color: string }[]>([]);
  const [topTenants, setTopTenants] = useState<any[]>([]);
  const [completionRate, setCompletionRate] = useState<number>(0);
  const [avgBookingValue, setAvgBookingValue] = useState<number>(0);
  const [pendingApprovals, setPendingApprovals] = useState<number>(0);
  const [totalBranches, setTotalBranches] = useState<number>(0);
  const [chartReady, setChartReady] = useState<boolean>(false);
  
  // Use notification context from NotificationProvider (kept for potential future use)
  useNotifications();
  
  const revCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const statusCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const chartsRef = useRef<{ revenue?: any; status?: any }>({});
  const builtRef = useRef(false);

  // Authentication - redirect if not super_admin
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
          
          // Check if user is super admin
          const superAdminDoc = await getDoc(doc(db, "super_admins", user.uid));
          
          if (!superAdminDoc.exists()) {
            // Not a super admin, redirect to regular dashboard
            router.replace("/dashboard");
            return;
          }
          
          setAuthLoading(false);
        } catch {
          router.replace("/login");
        }
      });
      return () => unsub();
    })();
  }, [router]);

  // Fetch super_admin specific data (aggregate across all tenants)
  useEffect(() => {
    if (authLoading) return;

    let unsubTenants: (() => void) | undefined;
    let unsubAllBookings: (() => void) | undefined;

    (async () => {
      const { db } = await import("@/lib/firebase");

      // Fetch all tenants (salon owners)
      const tenantsQuery = query(collection(db, "users"), where("role", "==", "salon_owner"));
      unsubTenants = onSnapshot(
        tenantsQuery,
        async (snapshot) => {
          const tenants = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
          
          // Count active tenants (based on subscription/account status)
          const active = tenants.filter((t: any) => {
            const subscriptionStatus = (t.subscriptionStatus || "").toLowerCase();
            const accountStatus = (t.accountStatus || "").toLowerCase();
            const status = (t.status || "").toLowerCase();
            
            // Consider tenant active if:
            // - subscriptionStatus is "active", "trialing", or "trial"
            // - OR accountStatus is "active" and subscription isn't in a bad state
            // - OR status field includes "active" or "trial"
            const isActive = 
              subscriptionStatus === "active" || 
              subscriptionStatus === "trialing" ||
              subscriptionStatus === "trial" ||
              status === "active" ||
              status === "trial" ||
              status === "trialing" ||
              (accountStatus === "active" && !["cancelled", "canceled", "suspended", "past_due", "unpaid"].includes(subscriptionStatus));
            
            return isActive;
          }).length;
          
          setActiveTenants(active);
          setTotalTenants(tenants.length);

          // Calculate plan distribution and MRR with real data
          const planColors = ["#3b82f6", "#ec4899", "#8b5cf6", "#10b981", "#f59e0b", "#ef4444"];
          const planMap: { [key: string]: { count: number; revenue: number } } = {};
          let totalMRR = 0;
          
          tenants.forEach((t: any) => {
            const planName = t.plan || "Unknown";
            const subscriptionStatus = (t.subscriptionStatus || "").toLowerCase();
            const accountStatus = (t.accountStatus || "").toLowerCase();
            
            // Get the actual price from tenant data
            const priceValue = t.price || t.planPrice || 0;
            const numericPrice = typeof priceValue === "string" 
              ? parseFloat(priceValue.replace(/[^0-9.]/g, "")) || 0
              : (typeof priceValue === "number" ? priceValue : 0);
            
            // Initialize plan in map if not exists
            if (!planMap[planName]) {
              planMap[planName] = { count: 0, revenue: 0 };
            }
            planMap[planName].count++;
            
            // Only count MRR for active/trialing subscriptions
            const isActiveSubscription = 
              subscriptionStatus === "active" || 
              subscriptionStatus === "trialing" ||
              (accountStatus === "active" && !["cancelled", "canceled", "suspended", "past_due", "unpaid"].includes(subscriptionStatus));
            
            if (isActiveSubscription && numericPrice > 0) {
              totalMRR += numericPrice;
              planMap[planName].revenue += numericPrice;
            }
          });
          
          // Convert map to array for display
          const planDistArray = Object.entries(planMap)
            .map(([name, data], idx) => ({
              name,
              count: data.count,
              revenue: data.revenue,
              color: planColors[idx % planColors.length]
            }))
            .sort((a, b) => b.count - a.count); // Sort by count descending
          
          setPlanDistribution(planDistArray);
          setMrr(totalMRR);
        },
        (error) => {
          if (error.code === "permission-denied") {
            console.warn("Permission denied for tenants query.");
            setActiveTenants(0);
            setTotalTenants(0);
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

          // Calculate today's bookings
          const today = new Date().toISOString().split('T')[0];
          const todayCount = allBookings.filter((b: any) => {
            const bookingDate = b.date || b.bookingDate || '';
            return bookingDate.startsWith(today);
          }).length;
          setTodayBookings(todayCount);

          // Calculate completion rate
          const totalCompleted = statusCount.completed;
          const totalProcessed = statusCount.completed + statusCount.canceled;
          const rate = totalProcessed > 0 ? (totalCompleted / totalProcessed) * 100 : 0;
          setCompletionRate(Math.round(rate));

          // Calculate average booking value
          const completedBookings = allBookings.filter((b: any) => {
            const status = (b.status || '').toLowerCase();
            return status === 'completed' && (Number(b.price) || 0) > 0;
          });
          const totalValue = completedBookings.reduce((sum: number, b: any) => sum + (Number(b.price) || 0), 0);
          const avgValue = completedBookings.length > 0 ? totalValue / completedBookings.length : 0;
          setAvgBookingValue(Math.round(avgValue));

          // Calculate avg revenue per tenant
          if (totalTenants > 0) {
            setAvgRevenuePerTenant(Math.round(currentMonthRevenue / totalTenants));
          }

          // Count pending approvals (awaiting staff approval)
          const pendingCount = allBookings.filter((b: any) => {
            const status = (b.status || '').toLowerCase();
            return status.includes('awaiting') || status === 'pending';
          }).length;
          setPendingApprovals(pendingCount);
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
  }, [authLoading]);

  // Fetch recent tenants
  useEffect(() => {
    if (authLoading) return;

    let unsubTenants: (() => void) | undefined;

    (async () => {
      const { db } = await import("@/lib/firebase");
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
              const aTime = a.createdAt?.toMillis?.() || 0;
              const bTime = b.createdAt?.toMillis?.() || 0;
              return bTime - aTime;
            })
            .slice(0, 5);
        
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
    })();

    return () => {
      unsubTenants?.();
    };
  }, [authLoading]);

  // Fetch additional platform metrics (staff, services, branches, top tenants)
  useEffect(() => {
    if (authLoading) return;

    let unsubStaff: (() => void) | undefined;
    let unsubServices: (() => void) | undefined;
    let unsubBranches: (() => void) | undefined;
    let unsubCustomers: (() => void) | undefined;

    (async () => {
      const { db } = await import("@/lib/firebase");

      // Fetch all staff members
      const staffQuery = query(collection(db, "users"), where("role", "==", "salon_staff"));
      unsubStaff = onSnapshot(
        staffQuery,
        (snapshot) => {
          setTotalStaff(snapshot.docs.length);
        },
        (error) => {
          if (error.code !== "permission-denied") {
            console.error("Error in staff snapshot:", error);
          }
        }
      );

      // Fetch all services
      const servicesQuery = query(collection(db, "services"));
      unsubServices = onSnapshot(
        servicesQuery,
        (snapshot) => {
          setTotalServices(snapshot.docs.length);
        },
        (error) => {
          if (error.code !== "permission-denied") {
            console.error("Error in services snapshot:", error);
          }
        }
      );

      // Fetch all branches
      const branchesQuery = query(collection(db, "branches"));
      unsubBranches = onSnapshot(
        branchesQuery,
        (snapshot) => {
          setTotalBranches(snapshot.docs.length);
        },
        (error) => {
          if (error.code !== "permission-denied") {
            console.error("Error in branches snapshot:", error);
          }
        }
      );

      // Fetch all customers
      const customersQuery = query(collection(db, "customers"));
      unsubCustomers = onSnapshot(
        customersQuery,
        (snapshot) => {
          setTotalCustomers(snapshot.docs.length);
        },
        (error) => {
          if (error.code !== "permission-denied") {
            console.error("Error in customers snapshot:", error);
          }
        }
      );
    })();

    return () => {
      unsubStaff?.();
      unsubServices?.();
      unsubBranches?.();
      unsubCustomers?.();
    };
  }, [authLoading]);

  // Fetch top performing tenants by revenue
  useEffect(() => {
    if (authLoading) return;

    (async () => {
      const { db } = await import("@/lib/firebase");
      
      // Get all bookings
      const allBookingsQuery = query(collection(db, "bookings"));
      const { getDocs } = await import("firebase/firestore");
      const bookingsSnapshot = await getDocs(allBookingsQuery);
      const allBookings = bookingsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

      // Get tenants
      const tenantsQuery = query(collection(db, "users"), where("role", "==", "salon_owner"));
      const tenantsSnapshot = await getDocs(tenantsQuery);
      const tenants = tenantsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

      // Calculate revenue per tenant
      const tenantRevenue = tenants.map((tenant: any) => {
        const revenue = allBookings
          .filter((b: any) => b.ownerUid === tenant.id && (b.status || '').toLowerCase() === 'completed')
          .reduce((sum: number, b: any) => sum + (Number(b.price) || 0), 0);
        
        const bookingCount = allBookings.filter((b: any) => b.ownerUid === tenant.id).length;
        
        return {
          ...tenant,
          revenue,
          bookingCount
        };
      });

      // Sort by revenue and take top 5
      const top = tenantRevenue
        .sort((a: any, b: any) => b.revenue - a.revenue)
        .slice(0, 5);

      setTopTenants(top);
    })();
  }, [authLoading]);

  // Track if charts have been initially built
  const chartsInitializedRef = useRef(false);
  const dataHashRef = useRef<string>("");

  // Initialize charts with Chart.js (loaded via CDN Script)
  const buildCharts = (animate: boolean = true) => {
    // @ts-ignore
    const Chart = (window as any)?.Chart;
    if (!Chart) {
      console.warn("Chart.js not available");
      return false;
    }
    
    // Ensure canvas refs are available
    if (!revCanvasRef.current || !statusCanvasRef.current) {
      console.warn("Canvas refs not available", { 
        revenue: !!revCanvasRef.current, 
        status: !!statusCanvasRef.current 
      });
      return false;
    }

    // Destroy existing instances to avoid duplicates
    try {
      if (chartsRef.current.revenue) {
        chartsRef.current.revenue.destroy();
        chartsRef.current.revenue = undefined;
      }
    } catch (e) {
      console.warn("Error destroying revenue chart:", e);
    }
    try {
      if (chartsRef.current.status) {
        chartsRef.current.status.destroy();
        chartsRef.current.status = undefined;
      }
    } catch (e) {
      console.warn("Error destroying status chart:", e);
    }

    // Revenue line + area with real data
    const ctx = revCanvasRef.current.getContext("2d");
    const revenue = new Chart(ctx as any, {
      type: "line",
      data: {
        labels: revenueLabels,
        datasets: [
          {
            label: "Revenue",
            data: revenueData,
            borderColor: "#ec4899",
            backgroundColor: "rgba(236, 72, 153, 0.1)",
            fill: true,
            tension: 0.4,
            pointRadius: 4,
            pointHoverRadius: 6,
            pointBackgroundColor: "#ec4899",
            pointBorderColor: "#ffffff",
            pointBorderWidth: 2,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: "rgba(0, 0, 0, 0.8)",
            padding: 12,
            titleFont: { size: 14, weight: "bold" },
            bodyFont: { size: 13 },
            callbacks: {
              label: (context: any) => {
                const value = context.parsed.y;
                return `AU$${value.toLocaleString()}`;
              },
            },
          },
        },
        scales: {
          y: {
            beginAtZero: true,
            ticks: {
              callback: (v: any) => {
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
        plugins: {
          legend: {
            position: "bottom",
            labels: {
              padding: 15,
              font: { size: 12 },
            },
          },
          tooltip: {
            backgroundColor: "rgba(0, 0, 0, 0.8)",
            padding: 10,
            callbacks: {
              label: (context: any) => {
                const label = context.label || "";
                const value = context.parsed || 0;
                const total = context.dataset.data.reduce((a: number, b: number) => a + b, 0);
                const percentage = total > 0 ? ((value / total) * 100).toFixed(1) : 0;
                return `${label}: ${value} (${percentage}%)`;
              },
            },
          },
        },
      },
    });

    chartsRef.current = { revenue, status };
    return true;
  };

  // Build charts when data is ready and Chart.js is loaded
  useEffect(() => {
    if (authLoading) return;
    
    const dataHash = `${revenueData.join(",")}-${statusData.confirmed}-${statusData.pending}-${statusData.completed}-${statusData.canceled}`;
    const dataChanged = dataHash !== dataHashRef.current;
    
    const tryBuild = () => {
      // @ts-ignore
      const Chart = (window as any)?.Chart;
      if (!Chart) return false;
      
      // Ensure canvas refs are available and in the DOM
      if (!revCanvasRef.current || !statusCanvasRef.current) {
        return false;
      }
      
      // Verify canvas elements are actually in the DOM
      if (!document.contains(revCanvasRef.current) || !document.contains(statusCanvasRef.current)) {
        return false;
      }
      
      // Always destroy existing charts first to avoid duplicates
      try {
        if (chartsRef.current.revenue) {
          chartsRef.current.revenue.destroy();
          chartsRef.current.revenue = undefined;
        }
        if (chartsRef.current.status) {
          chartsRef.current.status.destroy();
          chartsRef.current.status = undefined;
        }
      } catch (e) {
        console.warn("Error destroying charts:", e);
      }
      
      const success = buildCharts(!chartsInitializedRef.current);
      if (success) {
        chartsInitializedRef.current = true;
        dataHashRef.current = dataHash;
        return true;
      }
      return false;
    };

    // If charts are already built and data hasn't changed, skip
    if (chartsInitializedRef.current && !dataChanged && chartReady) {
      return;
    }

    // Wait for Chart.js to be ready
    if (!chartReady) {
      // Check if Chart.js is already loaded (might be cached)
      // @ts-ignore
      if ((window as any)?.Chart) {
        setChartReady(true);
      }
      return;
    }

    // Try to build immediately
    if (tryBuild()) {
      return;
    }

    // If Chart.js isn't loaded yet, poll until it is
    let attempts = 0;
    const maxAttempts = 50;
    const id = setInterval(() => {
      attempts++;
      if (tryBuild() || attempts >= maxAttempts) {
        clearInterval(id);
      }
    }, 200);

    return () => {
      clearInterval(id);
    };
  }, [revenueData, revenueLabels, statusData, authLoading, chartReady]);

  // Reset chart state on mount to ensure charts rebuild when navigating back
  useEffect(() => {
    // Reset initialization flag when component mounts
    chartsInitializedRef.current = false;
    dataHashRef.current = "";
    
    // Check if Chart.js is already available (cached from previous navigation)
    // @ts-ignore
    if ((window as any)?.Chart) {
      setChartReady(true);
    } else {
      // If not available, wait a bit and check again (Script might still be loading)
      const checkInterval = setInterval(() => {
        // @ts-ignore
        if ((window as any)?.Chart) {
          setChartReady(true);
          clearInterval(checkInterval);
        }
      }, 100);
      
      // Clear after 5 seconds if still not loaded
      setTimeout(() => clearInterval(checkInterval), 5000);
      
      return () => clearInterval(checkInterval);
    }
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      try {
        if (chartsRef.current.revenue) {
          chartsRef.current.revenue.destroy();
          chartsRef.current.revenue = undefined;
        }
      } catch {}
      try {
        if (chartsRef.current.status) {
          chartsRef.current.status.destroy();
          chartsRef.current.status = undefined;
        }
      } catch {}
      // Reset flags on unmount
      chartsInitializedRef.current = false;
      dataHashRef.current = "";
    };
  }, []);

  return (
    <div id="app" className="flex h-screen overflow-hidden bg-white">
      <Script 
        src="https://cdn.jsdelivr.net/npm/chart.js" 
        strategy="afterInteractive"
        onLoad={() => setChartReady(true)}
      />
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
              <div className="relative z-10 flex items-center gap-4">
                <div className="w-14 h-14 rounded-xl bg-white/20 flex items-center justify-center backdrop-blur-sm">
                  <i className="fas fa-chart-line text-2xl" />
                </div>
                <div>
                  <h1 className="text-2xl font-bold">BMS Pro Admin</h1>
                  <p className="text-sm text-white/80 mt-1">Super Admin Dashboard</p>
                </div>
              </div>
              <div className="absolute top-0 right-0 -mr-10 -mt-10 w-64 h-64 rounded-full bg-white opacity-10 blur-2xl" />
            </div>
          </div>

          {/* Primary Stats Row */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-6">
            <div className="bg-gradient-to-br from-pink-500 to-fuchsia-600 p-6 rounded-2xl shadow-lg text-white min-w-0">
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm font-medium text-white/80">Monthly Revenue</span>
                <div className="w-10 h-10 bg-white/20 rounded-xl flex items-center justify-center backdrop-blur-sm">
                  <i className="fas fa-dollar-sign" />
                </div>
              </div>
              <div className="mb-2">
                <h3 className="text-3xl font-bold">AU${monthlyRevenue.toLocaleString()}</h3>
              </div>
              <div className="flex items-center space-x-2">
                {revenueGrowth !== 0 && (
                  <span className={`px-2 py-1 rounded-lg text-xs font-semibold flex items-center ${
                    revenueGrowth > 0 
                      ? "bg-white/20 text-white" 
                      : "bg-rose-400/30 text-white"
                  }`}>
                    <i className={`fas fa-arrow-${revenueGrowth > 0 ? 'up' : 'down'} text-xs mr-1`} />
                    {revenueGrowth > 0 ? '+' : ''}{revenueGrowth}%
                  </span>
                )}
                <span className="text-xs text-white/70">vs last month</span>
              </div>
            </div>
            <div className="bg-gradient-to-br from-emerald-500 to-teal-600 p-6 rounded-2xl shadow-lg text-white min-w-0">
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm font-medium text-white/80">Monthly Recurring</span>
                <div className="w-10 h-10 bg-white/20 rounded-xl flex items-center justify-center backdrop-blur-sm">
                  <i className="fas fa-rotate" />
                </div>
              </div>
              <div className="mb-2">
                <h3 className="text-3xl font-bold">AU${mrr.toLocaleString()}</h3>
              </div>
              <div className="text-xs text-white/70">MRR from subscriptions</div>
            </div>
            <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm min-w-0">
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm font-medium text-slate-600">Total Bookings</span>
                <div className="w-10 h-10 bg-blue-50 rounded-xl flex items-center justify-center">
                  <i className="fas fa-calendar-check text-blue-500" />
                </div>
              </div>
              <div className="mb-2">
                <h3 className="text-3xl font-bold text-slate-900">{totalBookings.toLocaleString()}</h3>
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
                <span className="text-sm font-medium text-slate-600">Today&apos;s Bookings</span>
                <div className="w-10 h-10 bg-amber-50 rounded-xl flex items-center justify-center">
                  <i className="fas fa-clock text-amber-500" />
                </div>
              </div>
              <div className="mb-2">
                <h3 className="text-3xl font-bold text-slate-900">{todayBookings}</h3>
              </div>
              <div className="text-xs text-slate-500">Bookings scheduled today</div>
            </div>
          </div>

          {/* Secondary Stats Row */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-8">
            <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
              <div className="flex items-center gap-2 mb-2">
                <div className="w-8 h-8 bg-purple-50 rounded-lg flex items-center justify-center">
                  <i className="fas fa-building text-purple-500 text-sm" />
                </div>
              </div>
              <div className="text-2xl font-bold text-slate-900">{totalTenants}</div>
              <div className="text-[11px] text-slate-500">Total Tenants</div>
            </div>
            <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
              <div className="flex items-center gap-2 mb-2">
                <div className="w-8 h-8 bg-emerald-50 rounded-lg flex items-center justify-center">
                  <i className="fas fa-check-circle text-emerald-500 text-sm" />
                </div>
              </div>
              <div className="text-2xl font-bold text-slate-900">{activeTenants}</div>
              <div className="text-[11px] text-slate-500">Active Tenants</div>
            </div>
            <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
              <div className="flex items-center gap-2 mb-2">
                <div className="w-8 h-8 bg-blue-50 rounded-lg flex items-center justify-center">
                  <i className="fas fa-users text-blue-500 text-sm" />
                </div>
              </div>
              <div className="text-2xl font-bold text-slate-900">{totalStaff}</div>
              <div className="text-[11px] text-slate-500">Total Staff</div>
            </div>
            <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
              <div className="flex items-center gap-2 mb-2">
                <div className="w-8 h-8 bg-indigo-50 rounded-lg flex items-center justify-center">
                  <i className="fas fa-spa text-indigo-500 text-sm" />
                </div>
              </div>
              <div className="text-2xl font-bold text-slate-900">{totalServices}</div>
              <div className="text-[11px] text-slate-500">Services</div>
            </div>
            <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
              <div className="flex items-center gap-2 mb-2">
                <div className="w-8 h-8 bg-teal-50 rounded-lg flex items-center justify-center">
                  <i className="fas fa-store text-teal-500 text-sm" />
                </div>
              </div>
              <div className="text-2xl font-bold text-slate-900">{totalBranches}</div>
              <div className="text-[11px] text-slate-500">Branches</div>
            </div>
            <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
              <div className="flex items-center gap-2 mb-2">
                <div className="w-8 h-8 bg-rose-50 rounded-lg flex items-center justify-center">
                  <i className="fas fa-chart-pie text-rose-500 text-sm" />
                </div>
              </div>
              <div className="text-2xl font-bold text-slate-900">{completionRate}%</div>
              <div className="text-[11px] text-slate-500">Completion</div>
            </div>
          </div>
          
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
            <div className="lg:col-span-2 bg-white p-6 rounded-2xl border border-slate-200 shadow-sm min-w-0 overflow-hidden">
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h3 className="font-semibold text-lg text-slate-900">Platform Revenue Trend</h3>
                  <p className="text-sm text-slate-500 mt-1">Last 6 months (all tenants)</p>
                </div>
              </div>
              <div className="h-[280px] relative">
                <canvas ref={revCanvasRef} />
              </div>
            </div>
            <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm min-w-0">
              <div className="mb-6">
                <h3 className="font-semibold text-lg text-slate-900">Platform Booking Status</h3>
                <p className="text-sm text-slate-500 mt-1">All tenants distribution</p>
              </div>
              <div className="space-y-4">
                <div className="relative h-48 mb-2">
                  <canvas ref={statusCanvasRef} />
                </div>
              </div>
            </div>
          </div>

          {/* Plan Distribution & Top Tenants */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
            {/* Plan Distribution */}
            <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
              <div className="mb-6">
                <h3 className="font-semibold text-lg text-slate-900">Plan Distribution</h3>
                <p className="text-sm text-slate-500 mt-1">Active subscriptions by plan</p>
              </div>
              <div className="space-y-4">
                {planDistribution.length === 0 ? (
                  <div className="text-center py-6 text-slate-400">
                    <i className="fas fa-box-open text-2xl mb-2" />
                    <p className="text-sm">No plans assigned yet</p>
                  </div>
                ) : (
                  planDistribution.map((plan) => (
                    <div key={plan.name}>
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <div 
                            className="w-3 h-3 rounded-full" 
                            style={{ backgroundColor: plan.color }}
                          ></div>
                          <span className="text-sm font-medium text-slate-700">{plan.name}</span>
                        </div>
                        <span className="text-sm font-semibold text-slate-900">{plan.count}</span>
                      </div>
                      <div className="w-full bg-slate-100 rounded-full h-2">
                        <div 
                          className="h-2 rounded-full transition-all duration-500" 
                          style={{ 
                            width: `${totalTenants > 0 ? (plan.count / totalTenants) * 100 : 0}%`,
                            backgroundColor: plan.color
                          }}
                        ></div>
                      </div>
                      <p className="text-[10px] text-slate-400 mt-1">
                        {plan.count} tenant{plan.count !== 1 ? 's' : ''} • MRR: AU${plan.revenue.toLocaleString()}
                      </p>
                    </div>
                  ))
                )}
              </div>
              <div className="mt-6 pt-4 border-t border-slate-100">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-slate-600">Total MRR</span>
                  <span className="text-lg font-bold text-emerald-600">AU${mrr.toLocaleString()}/mo</span>
                </div>
              </div>
            </div>

            {/* Top Performing Tenants */}
            <div className="lg:col-span-2 bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h3 className="font-semibold text-lg text-slate-900">Top Performing Tenants</h3>
                  <p className="text-sm text-slate-500 mt-1">By completed booking revenue</p>
                </div>
                <button 
                  onClick={() => router.push("/tenants")}
                  className="text-sm text-pink-600 hover:text-pink-700 font-medium"
                >
                  View All <i className="fas fa-arrow-right ml-1 text-xs" />
                </button>
              </div>
              <div className="space-y-3">
                {topTenants.length === 0 ? (
                  <div className="text-center py-8 text-slate-400">
                    <i className="fas fa-trophy text-3xl mb-2" />
                    <p className="text-sm">No revenue data yet</p>
                  </div>
                ) : (
                  topTenants.map((tenant: any, idx: number) => {
                    const initials = (tenant.name || "?")
                      .split(" ")
                      .map((s: string) => s[0])
                      .filter(Boolean)
                      .slice(0, 2)
                      .join("")
                      .toUpperCase();
                    const colors = [
                      "from-amber-400 to-amber-600",
                      "from-slate-400 to-slate-600",
                      "from-orange-400 to-orange-600",
                      "from-pink-400 to-pink-600",
                      "from-blue-400 to-blue-600"
                    ];
                    const medals = ["🥇", "🥈", "🥉", "", ""];
                    
                    return (
                      <div key={tenant.id} className="flex items-center gap-4 p-3 rounded-xl hover:bg-slate-50 transition">
                        <div className="w-6 text-center font-bold text-slate-400">
                          {medals[idx] || `#${idx + 1}`}
                        </div>
                        <div className={`w-10 h-10 bg-gradient-to-br ${colors[idx]} rounded-lg flex items-center justify-center`}>
                          <span className="text-white font-semibold text-sm">{initials}</span>
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-slate-900 truncate">{tenant.name || "Unknown"}</p>
                          <p className="text-xs text-slate-500">{tenant.bookingCount} bookings • {tenant.state || "—"}</p>
                        </div>
                        <div className="text-right">
                          <p className="font-bold text-slate-900">AU${tenant.revenue.toLocaleString()}</p>
                          <p className="text-[10px] text-slate-400">{tenant.plan || "Starter"}</p>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>

          {/* Quick Stats Summary */}
          <div className="bg-gradient-to-r from-slate-800 to-slate-900 rounded-2xl p-6 mb-8 text-white">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 bg-white/10 rounded-xl flex items-center justify-center">
                <i className="fas fa-chart-bar" />
              </div>
              <div>
                <h3 className="font-semibold">Platform Summary</h3>
                <p className="text-xs text-white/60">Real-time metrics overview</p>
              </div>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="bg-white/10 rounded-xl p-4">
                <div className="text-2xl font-bold">
                  {activeTenants > 0 ? `AU$${Math.round(mrr / activeTenants)}` : (totalTenants > 0 ? `AU$${Math.round(mrr / totalTenants)}` : "AU$0")}
                </div>
                <div className="text-xs text-white/60">Avg MRR/Tenant</div>
              </div>
              <div className="bg-white/10 rounded-xl p-4">
                <div className="text-2xl font-bold">{pendingApprovals}</div>
                <div className="text-xs text-white/60">Pending Approvals</div>
              </div>
              <div className="bg-white/10 rounded-xl p-4">
                <div className="text-2xl font-bold">{totalTenants > 0 ? Math.round((activeTenants / totalTenants) * 100) : 0}%</div>
                <div className="text-xs text-white/60">Tenant Activity Rate</div>
              </div>
              <div className="bg-white/10 rounded-xl p-4">
                <div className="text-2xl font-bold">{totalTenants > 0 ? Math.round(totalBookings / totalTenants) : 0}</div>
                <div className="text-xs text-white/60">Avg Bookings/Tenant</div>
              </div>
            </div>
          </div>

          {/* Recent Activity */}
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm">
            <div className="p-6 border-b border-slate-200">
              <div>
                <h3 className="font-semibold text-lg text-slate-900">Recent Activity</h3>
                <p className="text-sm text-slate-500 mt-1">Latest tenant onboardings</p>
              </div>
            </div>
            <div className="overflow-x-auto">
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
            </div>
          </div>
        </main>
        )}
      </div>
    </div>
  );
}
