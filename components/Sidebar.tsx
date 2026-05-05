"use client";
import Link from "next/link";
import React, { useEffect, useState, useRef } from "react";
import { usePathname } from "next/navigation";
import { useRouter } from "next/navigation";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { auth } from "@/lib/firebase";
import { fetchCurrentUser } from "@/lib/authClient";
import { logUserLogout, logSuperAdminLogout, createSuperAdminAuditLog } from "@/lib/auditLog";

type SidebarProps = {
  mobile?: boolean;
  onClose?: () => void;
};

export default function Sidebar({ mobile = false, onClose }: SidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isDashboard = pathname === "/dashboard" || pathname === "/admin-dashboard" || pathname === "/";
  const isBookings = pathname?.startsWith("/bookings");
  const isBookingsDashboard = pathname === "/bookings/dashboard";
  const isBookingsAll = pathname === "/bookings/all";
  const isBookingsPending = pathname === "/bookings/pending";
  const isBookingsConfirmed = pathname === "/bookings/confirmed";
  const isBookingsCompleted = pathname === "/bookings/completed";
  const isBookingsCancelled = pathname === "/bookings/cancelled";
  const isServices = pathname?.startsWith("/services");
  const isBranches = pathname?.startsWith("/branches");
  const isCustomers = pathname?.startsWith("/customers");
  const isEstimates = pathname?.startsWith("/estimates");
  const isTenants = pathname?.startsWith("/tenants");
  const isStaff = pathname?.startsWith("/staff");
  const isLeaveRequests = pathname?.startsWith("/staff/leave-requests");
  const isBilling = pathname?.startsWith("/billing");
  const isSettings = pathname?.startsWith("/settings");
  const isOwnerSettings = pathname?.startsWith("/owner-settings");
  const isAuditLogs = pathname?.startsWith("/audit-logs");
  const isSubscription = pathname?.startsWith("/subscription");
  const isPackages = pathname?.startsWith("/packages");
  const isSuperAdminAuditLogs = pathname?.startsWith("/super-admin-audit-logs");
  const [role, setRole] = useState<string | null>(null);
  const [userName, setUserName] = useState<string>("");
  const [userEmail, setUserEmail] = useState<string>("");
  const [mounted, setMounted] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false); // Loading state for sign out
  const [openBookings, setOpenBookings] = useState(pathname?.startsWith("/bookings") || false);
  const [openStaff, setOpenStaff] = useState(pathname?.startsWith("/staff") || false); // Staff Toggle State
  // Do not auto-open based on route; keep user preference until manually changed

  useEffect(() => {
    // Keep role in sync with auth state and Firestore; seed from localStorage for instant render
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        setRole(null);
        setUserName("");
        setUserEmail("");
        if (typeof window !== "undefined") {
          localStorage.removeItem("role");
          localStorage.removeItem("userName");
        }
        return;
      }
      try {
        // Use server API to get role (bypasses Firestore rules)
        const meData = await fetchCurrentUser();
        
        if (meData) {
          setRole(meData.role || null);
          setUserName(meData.displayName || user.displayName || "");
          setUserEmail(meData.email || user.email || "");
        } else {
          // Fallback to localStorage cache
          const cachedRole = typeof window !== "undefined" ? localStorage.getItem("role") : null;
          setRole(cachedRole || null);
          setUserName(user.displayName || user.email || "");
          setUserEmail(user.email || "");
        }
      } catch {
        // Fallback to localStorage
        const cachedRole = typeof window !== "undefined" ? localStorage.getItem("role") : null;
        setRole(cachedRole || null);
        setUserName(user.displayName || user.email || "");
        setUserEmail(user.email || "");
      }
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    // Ensure hydration-safe rendering by deferring role-based links until after mount
    setMounted(true);
    // Immediately hydrate from localStorage to avoid link flicker during client navigation
    try {
      if (typeof window !== "undefined") {
        const cached = localStorage.getItem("role");
        if (cached) setRole(cached);
        const cachedName = localStorage.getItem("userName");
        if (cachedName) setUserName(cachedName);
        const ob = localStorage.getItem("sidebarOpenBookings");
        if (ob === "1" || ob === "0") setOpenBookings(ob === "1");
        const os = localStorage.getItem("sidebarOpenStaff"); // Staff Toggle Hydration
        if (os === "1" || os === "0") setOpenStaff(os === "1");
        
        // Restore sidebar scroll position after mount
        const savedScrollTop = sessionStorage.getItem("sidebarScrollTop");
        if (savedScrollTop && scrollContainerRef.current) {
          requestAnimationFrame(() => {
            if (scrollContainerRef.current) {
              scrollContainerRef.current.scrollTop = parseInt(savedScrollTop, 10);
            }
          });
        }
      }
    } catch {}
  }, []);

  // Save scroll position whenever user scrolls the sidebar
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    
    const handleScroll = () => {
      try {
        sessionStorage.setItem("sidebarScrollTop", container.scrollTop.toString());
      } catch {}
    };
    
    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, [mounted]);

  // Restore scroll position after role-based menu items render
  useEffect(() => {
    if (mounted && role) {
      try {
        const savedScrollTop = sessionStorage.getItem("sidebarScrollTop");
        if (savedScrollTop && scrollContainerRef.current) {
          // Use setTimeout to ensure DOM has fully rendered
          setTimeout(() => {
            if (scrollContainerRef.current) {
              scrollContainerRef.current.scrollTop = parseInt(savedScrollTop, 10);
            }
          }, 50);
        }
      } catch {}
    }
  }, [mounted, role]);

  const toggleBookings = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const scrollTop = scrollContainerRef.current?.scrollTop || 0;
    setOpenBookings((v) => {
      const nv = !v;
      try {
        if (typeof window !== "undefined") {
          localStorage.setItem("sidebarOpenBookings", nv ? "1" : "0");
        }
      } catch {}
      // Restore scroll position after state update
      requestAnimationFrame(() => {
        if (scrollContainerRef.current) {
          scrollContainerRef.current.scrollTop = scrollTop;
        }
      });
      return nv;
    });
  };

  const toggleStaff = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const scrollTop = scrollContainerRef.current?.scrollTop || 0;
    setOpenStaff((v) => {
      const nv = !v;
      try {
        if (typeof window !== "undefined") {
          localStorage.setItem("sidebarOpenStaff", nv ? "1" : "0");
        }
      } catch {}
      // Restore scroll position after state update
      requestAnimationFrame(() => {
        if (scrollContainerRef.current) {
          scrollContainerRef.current.scrollTop = scrollTop;
        }
      });
      return nv;
    });
  };

  const handleSignOut = () => {
    setConfirmOpen(true);
  };

  const confirmSignOut = async () => {
    setSigningOut(true);
    try {
      // Log logout before clearing data (non-blocking)
      const currentUser = auth.currentUser;
      if (currentUser && role) {
        try {
          if (role === "super_admin") {
            await logSuperAdminLogout(currentUser.uid, userName || userEmail);
          } else {
            // Use currentUser.uid as ownerUid fallback
            const ownerUid = currentUser.uid;
            await logUserLogout(ownerUid, currentUser.uid, userName || userEmail, role);
            await createSuperAdminAuditLog({
              action: `${role === "workshop_owner" ? "Workshop Owner" : "Staff"} logged out: ${userName || userEmail}`,
              actionType: "logout",
              entityType: "tenant",
              entityId: ownerUid,
              entityName: userName || userEmail,
              performedBy: currentUser.uid,
              performedByName: userName || userEmail,
              details: `Role: ${role}`,
            });
          }
        } catch (e) {
          console.warn("Audit log on logout failed (non-blocking):", e);
        }
      }

      if (typeof window !== "undefined") {
        localStorage.removeItem("idToken");
        localStorage.removeItem("role");
        localStorage.removeItem("userName");
      }
      await signOut(auth);
    } catch (e) {
      console.error("Sign out error:", e);
    }
    router.replace("/login");
  };

  const cancelSignOut = () => setConfirmOpen(false);

  return (
    <>
    <nav
      id="sidebar"
      className={`${mobile ? "flex w-64 h-full" : "hidden md:flex md:w-64 md:h-full"} bg-neutral-900 flex-col`}
    >
      <div className="p-6 border-b border-neutral-800">
        <div className="flex items-center space-x-3">
          <img src="/bmsblack-icon.jpeg" alt="BMS PRO BLACK" className="w-10 h-10 rounded-xl shadow-lg object-cover" />
          <div>
            <h1 className="font-bold text-base text-white">BMS PRO</h1>
            <p className="text-[10px] font-semibold tracking-[0.2em] text-neutral-500 uppercase">Black</p>
          </div>
        </div>
        {mobile && (
          <button
            aria-label="Close menu"
            onClick={onClose}
            className="absolute right-3 top-3 text-neutral-400 hover:text-white md:hidden"
          >
            <i className="fas fa-times" />
          </button>
        )}
      </div>
      <div ref={scrollContainerRef} className="flex-1 p-4 space-y-1 overflow-y-auto sidebar-scroll bg-neutral-900" style={{ overflowAnchor: 'none' }}>
        {mounted && (role === "workshop_owner" || role === "branch_admin" || role === "super_admin") && (
          <Link
            href={role === "super_admin" ? "/admin-dashboard" : "/dashboard"}
            className={`flex items-center space-x-3 px-4 py-3 rounded-xl font-medium text-sm transition ${
              isDashboard
                ? "bg-white/10 text-white font-semibold"
                : "text-neutral-400 hover:bg-neutral-800 hover:text-white"
            }`}
          >
            <i className="fas fa-chart-line w-5" />
            <span>Dashboard</span>
          </Link>
        )}
        {/* Super Admin - Only Dashboard and Tenants */}
        {mounted && role === "super_admin" && (
          <Link href="/tenants" className={`flex items-center space-x-3 px-4 py-3 rounded-xl text-sm transition ${isTenants ? "bg-white/10 text-white font-semibold" : "hover:bg-neutral-800 text-neutral-400 hover:text-white"}`}>
            <i className="fas fa-store w-5" />
            <span>Tenant Management</span>
          </Link>
        )}
        {mounted && role === "super_admin" && (
          <Link href="/packages" className={`flex items-center space-x-3 px-4 py-3 rounded-xl text-sm transition ${isPackages ? "bg-white/10 text-white font-semibold" : "hover:bg-neutral-800 text-neutral-400 hover:text-white"}`}>
            <i className="fas fa-box w-5" />
            <span>Packages</span>
          </Link>
        )}
        {mounted && role === "super_admin" && (
          <Link href="/admin-services" className={`flex items-center space-x-3 px-4 py-3 rounded-xl text-sm transition ${pathname?.startsWith("/admin-services") ? "bg-white/10 text-white font-semibold" : "hover:bg-neutral-800 text-neutral-400 hover:text-white"}`}>
            <i className="fas fa-layer-group w-5" />
            <span>Services</span>
          </Link>
        )}
        {mounted && role === "super_admin" && (
          <Link href="/super-admin-audit-logs" className={`flex items-center space-x-3 px-4 py-3 rounded-xl text-sm transition ${isSuperAdminAuditLogs ? "bg-white/10 text-white font-semibold" : "hover:bg-neutral-800 text-neutral-400 hover:text-white"}`}>
            <i className="fas fa-shield-halved w-5" />
            <span>Audit Logs</span>
          </Link>
        )}
        {mounted && (role === "workshop_owner" || role === "branch_admin") && (
          <>
            <div
              role="button"
              tabIndex={0}
              onClick={(e) => toggleBookings(e)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') toggleBookings(e as unknown as React.MouseEvent); }}
              className={`flex items-center space-x-3 px-4 py-3 rounded-xl text-sm transition cursor-pointer select-none ${
                isBookings ? "bg-white/10 text-white font-semibold" : "hover:bg-neutral-800 text-neutral-400 hover:text-white"
              }`}
            >
              <i className="fas fa-calendar-check w-5" />
              <span>Bookings</span>
              <span className="ml-auto opacity-70">
                <i className={`fas fa-chevron-${openBookings ? "down" : "right"}`} />
              </span>
            </div>
            {openBookings && (
              <>
                <Link
                  href="/bookings/dashboard?create=true"
                  className="ml-3 flex items-center space-x-3 px-3 py-2 rounded-lg text-sm font-medium transition bg-white text-neutral-900 hover:bg-neutral-200 shadow-sm"
                >
                  <i className="fas fa-plus w-4" />
                  <span>Create Booking</span>
                </Link>
                <Link
                  href="/bookings/dashboard"
                  className={`ml-3 flex items-center space-x-3 px-3 py-2 rounded-lg text-sm font-medium transition ${
                    isBookingsDashboard && !pathname?.includes("create") ? "bg-neutral-800 text-white" : "text-neutral-400 hover:bg-neutral-800 hover:text-white"
                  }`}
                >
                  <i className="fas fa-gauge w-4" />
                  <span>Today's Bookings</span>
                </Link>
                <Link
                  href="/bookings/pending"
                  className={`ml-3 flex items-center space-x-3 px-3 py-2 rounded-lg text-sm font-medium transition ${
                    isBookingsPending ? "bg-neutral-800 text-white" : "text-neutral-400 hover:bg-neutral-800 hover:text-white"
                  }`}
                >
                  <i className="fas fa-hourglass-half w-4" />
                  <span>Booking Requests</span>
                </Link>
                <Link
                  href="/bookings/confirmed"
                  className={`ml-3 flex items-center space-x-3 px-3 py-2 rounded-lg text-sm font-medium transition ${
                    isBookingsConfirmed ? "bg-neutral-800 text-white" : "text-neutral-400 hover:bg-neutral-800 hover:text-white"
                  }`}
                >
                  <i className="fas fa-check-circle w-4" />
                  <span>Confirmed Bookings</span>
                </Link>
                <Link
                  href="/bookings/completed"
                  className={`ml-3 flex items-center space-x-3 px-3 py-2 rounded-lg text-sm font-medium transition ${
                    isBookingsCompleted ? "bg-neutral-800 text-white" : "text-neutral-400 hover:bg-neutral-800 hover:text-white"
                  }`}
                >
                  <i className="fas fa-flag-checkered w-4" />
                  <span>Completed Bookings</span>
                </Link>
                <Link
                  href="/bookings/cancelled"
                  className={`ml-3 flex items-center space-x-3 px-3 py-2 rounded-lg text-sm font-medium transition ${
                    isBookingsCancelled ? "bg-neutral-800 text-white" : "text-neutral-400 hover:bg-neutral-800 hover:text-white"
                  }`}
                >
                  <i className="fas fa-ban w-4" />
                  <span>Cancelled Bookings</span>
                </Link>
              </>
            )}
          </>
        )}
        {mounted && role === "workshop_owner" && (
          <Link
            href="/estimates"
            className={`flex items-center space-x-3 px-4 py-3 rounded-xl text-sm transition ${
              isEstimates ? "bg-white/10 text-white font-semibold" : "hover:bg-neutral-800 text-neutral-400 hover:text-white"
            }`}
          >
            <i className="fas fa-file-invoice w-5" />
            <span>Estimates</span>
          </Link>
        )}
        {mounted && role === "workshop_owner" && (
          <Link
            href="/services"
            className={`flex items-center space-x-3 px-4 py-3 rounded-xl text-sm transition ${
              isServices ? "bg-white/10 text-white font-semibold" : "hover:bg-neutral-800 text-neutral-400 hover:text-white"
            }`}
          >
            <i className="fas fa-tags w-5" />
            <span>Services</span>
          </Link>
        )}
      {mounted && role === "workshop_owner" && (
        <Link
          href="/customers"
          className={`flex items-center space-x-3 px-4 py-3 rounded-xl text-sm transition ${
            isCustomers ? "bg-white/10 text-white font-semibold" : "hover:bg-neutral-800 text-neutral-400 hover:text-white"
          }`}
        >
          <i className="fas fa-user-group w-5" />
          <span>Customers</span>
        </Link>
      )}
      {mounted && (role === "workshop_owner" || role === "branch_admin") && (
        <Link
          href="/branches"
          className={`flex items-center space-x-3 px-4 py-3 rounded-xl text-sm transition ${
            isBranches ? "bg-white/10 text-white font-semibold" : "hover:bg-neutral-800 text-neutral-400 hover:text-white"
          }`}
        >
          <i className="fas fa-store w-5" />
          <span>Branch Management</span>
        </Link>
      )}
        {mounted && (role === "workshop_owner" || role === "branch_admin") && (
          <>
            <div
              role="button"
              tabIndex={0}
              onClick={(e) => toggleStaff(e)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') toggleStaff(e as unknown as React.MouseEvent); }}
              className={`flex items-center space-x-3 px-4 py-3 rounded-xl text-sm transition cursor-pointer select-none ${
                isStaff ? "bg-white/10 text-white font-semibold" : "hover:bg-neutral-800 text-neutral-400 hover:text-white"
              }`}
            >
              <i className="fas fa-users w-5" />
              <span>Staff</span>
              <span className="ml-auto opacity-70">
                <i className={`fas fa-chevron-${openStaff ? "down" : "right"}`} />
              </span>
            </div>
            {openStaff && (
              <>
                {role === "workshop_owner" && (
                  <>
                    <Link
                      href="/staff/manage"
                      className={`ml-3 flex items-center space-x-3 px-3 py-2 rounded-lg text-sm font-medium transition ${
                        pathname === "/staff" || (pathname?.startsWith("/staff/manage") && !isLeaveRequests)
                          ? "bg-neutral-800 text-white"
                          : "text-neutral-400 hover:bg-neutral-800 hover:text-white"
                      }`}
                    >
                      <i className="fas fa-user-cog w-4" />
                      <span>Staff Management</span>
                    </Link>
                    <Link
                      href="/staff/attendance"
                      className={`ml-3 flex items-center space-x-3 px-3 py-2 rounded-lg text-sm font-medium transition ${
                        pathname === "/staff/attendance"
                          ? "bg-neutral-800 text-white"
                          : "text-neutral-400 hover:bg-neutral-800 hover:text-white"
                      }`}
                    >
                      <i className="fas fa-map-location-dot w-4" />
                      <span>Attendance & GPS</span>
                    </Link>
                    <Link
                      href="/staff/timesheets"
                      className={`ml-3 flex items-center space-x-3 px-3 py-2 rounded-lg text-sm font-medium transition ${
                        pathname === "/staff/timesheets"
                          ? "bg-neutral-800 text-white"
                          : "text-neutral-400 hover:bg-neutral-800 hover:text-white"
                      }`}
                    >
                      <i className="fas fa-clock w-4" />
                      <span>Timesheets</span>
                    </Link>
                  </>
                )}
                {(role === "workshop_owner" || role === "branch_admin") && (
                  <Link
                    href="/staff/leave-requests"
                    className={`ml-3 flex items-center space-x-3 px-3 py-2 rounded-lg text-sm font-medium transition ${
                      isLeaveRequests
                        ? "bg-neutral-800 text-white"
                        : "text-neutral-400 hover:bg-neutral-800 hover:text-white"
                    }`}
                  >
                    <i className="fas fa-umbrella-beach w-4" />
                    <span>Leave requests</span>
                  </Link>
                )}
              </>
            )}
          </>
        )}
        {/* {mounted && role !== "branch_admin" && (
          <Link href="/billing" className={`flex items-center space-x-3 px-4 py-3 rounded-xl text-sm transition ${isBilling ? "bg-white/10 text-white font-semibold" : "hover:bg-neutral-800 text-neutral-400 hover:text-white"}`}>
            <i className="fas fa-credit-card w-5" />
            <span>Billing & Invoices</span>
          </Link>
        )} */}
        {mounted && role === "workshop_owner" && (
          <Link href="/audit-logs" className={`flex items-center space-x-3 px-4 py-3 rounded-xl text-sm transition ${isAuditLogs ? "bg-white/10 text-white font-semibold" : "hover:bg-neutral-800 text-neutral-400 hover:text-white"}`}>
            <i className="fas fa-clipboard-list w-5" />
            <span>Audit Logs</span>
          </Link>
        )}
        {mounted && role === "workshop_owner" && (
          <Link href="/subscription" className={`flex items-center space-x-3 px-4 py-3 rounded-xl text-sm transition ${isSubscription ? "bg-white/10 text-white font-semibold" : "hover:bg-neutral-800 text-neutral-400 hover:text-white"}`}>
            <i className="fas fa-crown w-5" />
            <span>Subscription</span>
          </Link>
        )}
        {mounted && role === "workshop_owner" && (
          <Link href="/owner-settings" className={`flex items-center space-x-3 px-4 py-3 rounded-xl text-sm transition ${isOwnerSettings ? "bg-white/10 text-white font-semibold" : "hover:bg-neutral-800 text-neutral-400 hover:text-white"}`}>
            <i className="fas fa-cog w-5" />
            <span>Settings</span>
          </Link>
        )}
      </div>
      <div className="p-4 border-t border-neutral-800">
        <div className="flex items-center space-x-3 px-4 py-3 rounded-xl hover:bg-neutral-800 cursor-pointer transition">
          <div className="w-10 h-10 rounded-full bg-neutral-700 flex items-center justify-center text-white font-semibold text-sm">
            {userName ? userName.charAt(0).toUpperCase() : userEmail ? userEmail.charAt(0).toUpperCase() : <i className="fas fa-user" />}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-white truncate">
              {userName || userEmail.split('@')[0] || "Account"}
            </p>
            <p className="text-xs text-neutral-400">
              {mounted && role
                ? role === "super_admin"
                  ? "Super Admin"
                  : role === "workshop_owner"
                  ? "Workshop Owner"
                  : role === "branch_admin"
                  ? "Branch Admin"
                  : role === "staff"
                  ? "Staff Member"
                  : "User"
                : "User"}
            </p>
          </div>
          <i className="fas fa-chevron-right text-neutral-400 text-xs" />
        </div>
        <button
          onClick={handleSignOut}
          className="mt-3 w-full inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-300 hover:text-white text-sm font-semibold transition border border-neutral-700"
        >
          <i className="fas fa-right-from-bracket" />
          Sign Out
        </button>
      </div>
    </nav>

    {/* Sign-out confirmation modal */}
    {confirmOpen && (
      <div className="fixed inset-0 z-50">
        <div className="absolute inset-0 bg-black/50" onClick={signingOut ? undefined : cancelSignOut} />
        <div className="absolute inset-0 flex items-center justify-center p-4">
          <div className="w-full max-w-sm bg-white rounded-2xl shadow-2xl border border-neutral-200">
            <div className="px-5 py-4 border-b border-neutral-200 flex items-center justify-between">
              <h3 className="text-base font-semibold text-neutral-900">
                {signingOut ? "Signing out..." : "Sign out"}
              </h3>
              {!signingOut && (
                <button className="text-neutral-400 hover:text-neutral-600" onClick={cancelSignOut}>
                  <i className="fas fa-times" />
                </button>
              )}
            </div>
            <div className="px-5 py-4">
              {signingOut ? (
                <div className="flex items-center justify-center gap-3 py-2">
                  <div className="w-5 h-5 border-2 border-rose-600 border-t-transparent rounded-full animate-spin" />
                  <p className="text-sm text-neutral-600">Please wait while we sign you out...</p>
                </div>
              ) : (
                <p className="text-sm text-neutral-600">Are you sure you want to sign out?</p>
              )}
            </div>
            {!signingOut && (
              <div className="px-5 py-4 border-t border-neutral-200 flex items-center justify-end gap-2">
                <button onClick={cancelSignOut} className="px-4 py-2 rounded-lg text-neutral-700 hover:bg-neutral-100 text-sm font-semibold">
                  Cancel
                </button>
                <button onClick={confirmSignOut} className="px-4 py-2 rounded-lg bg-rose-600 hover:bg-rose-700 text-white text-sm font-semibold">
                  Sign Out
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    )}
    </>
  );
}


