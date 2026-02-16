"use client";

import React, { useEffect, useState, useMemo, useCallback, useRef } from "react";
import { useParams } from "next/navigation";
import { type ChecklistItem, normalizeChecklist } from "@/lib/services";

type Branch = { id: string; name: string; address: string; phone: string; timezone: string };
type Service = { id: string; name: string; price: number; duration: number; imageUrl: string; checklist: ChecklistItem[]; branches: string[] };
type Workshop = { id: string; name: string; slug: string; logoUrl: string };
type CustomerSession = { customerId: string; name: string; email: string; phone: string };
type CustomerBooking = {
  id: string;
  bookingCode: string;
  serviceName: string;
  status: string;
  date: string;
  time: string;
  branchName: string;
  price: number;
  createdAt: string | null;
  updatedAt: string | null;
};

export default function BookingEnginePage() {
  const params = useParams();
  const slug = params?.slug as string;

  const [workshop, setWorkshop] = useState<Workshop | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [allServices, setAllServices] = useState<Service[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [activeView, setActiveView] = useState<"booking" | "myBookings">("booking");
  const [bookingsFilter, setBookingsFilter] = useState("All");

  const [step, setStep] = useState(1);
  const [prevStep, setPrevStep] = useState(1);
  const [animDir, setAnimDir] = useState<"forward" | "back">("forward");
  const [selectedBranch, setSelectedBranch] = useState<Branch | null>(null);
  const [selectedServices, setSelectedServices] = useState<string[]>([]);
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [calendarMonth, setCalendarMonth] = useState(() => { const now = new Date(); return { year: now.getFullYear(), month: now.getMonth() }; });
  const [customerName, setCustomerName] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [notes, setNotes] = useState("");

  const [customer, setCustomer] = useState<CustomerSession | null>(null);
  const [showAuth, setShowAuth] = useState(false);
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authName, setAuthName] = useState("");
  const [authPhone, setAuthPhone] = useState("");
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [bookingResult, setBookingResult] = useState<{ bookingCode: string; totalPrice: number; totalDuration: number } | null>(null);

  const [showConfetti, setShowConfetti] = useState(false);
  const [expandedService, setExpandedService] = useState<string | null>(null);

  // Notification panel state
  const [showNotifications, setShowNotifications] = useState(false);
  const [customerBookings, setCustomerBookings] = useState<CustomerBooking[]>([]);
  const [notifLoading, setNotifLoading] = useState(false);
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());
  const [readIds, setReadIds] = useState<Set<string>>(new Set());

  // Navigate between steps with animation direction
  const goToStep = useCallback((target: number) => {
    setAnimDir(target > step ? "forward" : "back");
    setPrevStep(step);
    setStep(target);
  }, [step]);

  useEffect(() => {
    if (!slug) return;
    (async () => {
      try {
        setLoading(true);
        const res = await fetch(`/api/book-now/${slug}`);
        if (!res.ok) { const data = await res.json(); setError(data.error || "Workshop not found"); return; }
        const data = await res.json();
        setWorkshop(data.workshop); setBranches(data.branches);
        setAllServices((data.services || []).map((s: any) => ({ ...s, checklist: normalizeChecklist(s.checklist) })));
      } catch { setError("Failed to load workshop data"); }
      finally { setLoading(false); }
    })();
  }, [slug]);

  useEffect(() => {
    if (!slug) return;
    try {
      const saved = sessionStorage.getItem(`bms_customer_${slug}`);
      if (saved) {
        const parsed = JSON.parse(saved) as CustomerSession;
        setCustomer(parsed); setCustomerName(parsed.name); setCustomerEmail(parsed.email); setCustomerPhone(parsed.phone);
      }
    } catch {}
  }, [slug]);

  // Load dismissed & read notification IDs from localStorage
  useEffect(() => {
    if (!customer?.customerId) return;
    try {
      const storedDismissed = localStorage.getItem(`bms_dismissed_notifs_${customer.customerId}`);
      if (storedDismissed) setDismissedIds(new Set(JSON.parse(storedDismissed)));
      const storedRead = localStorage.getItem(`bms_read_notifs_${customer.customerId}`);
      if (storedRead) setReadIds(new Set(JSON.parse(storedRead)));
    } catch {}
  }, [customer?.customerId]);

  const dismissNotification = (bookingId: string) => {
    setDismissedIds((prev) => {
      const next = new Set(prev);
      next.add(bookingId);
      if (customer?.customerId) {
        localStorage.setItem(`bms_dismissed_notifs_${customer.customerId}`, JSON.stringify([...next]));
      }
      return next;
    });
  };

  const markAllAsRead = () => {
    const ids = visibleBookings.map((b) => b.id);
    setReadIds((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => next.add(id));
      if (customer?.customerId) {
        localStorage.setItem(`bms_read_notifs_${customer.customerId}`, JSON.stringify([...next]));
      }
      return next;
    });
  };

  const visibleBookings = customerBookings.filter((b) => !dismissedIds.has(b.id));
  const unreadCount = visibleBookings.filter((b) => !readIds.has(b.id)).length;

  // Fetch customer bookings via API (server-side, no Firestore permissions needed)
  const fetchBookingsRef = useRef(false);
  const fetchCustomerBookings = useCallback(async () => {
    if (!customer?.customerId) return;
    try {
      const res = await fetch(`/api/book-now/customer-bookings?customerId=${customer.customerId}`);
      if (res.ok) {
        const data = await res.json();
        setCustomerBookings(data.bookings || []);
      }
    } catch (err) {
      console.error("Failed to fetch customer bookings:", err);
    } finally {
      setNotifLoading(false);
    }
  }, [customer?.customerId]);

  useEffect(() => {
    if (!customer?.customerId) {
      setCustomerBookings([]);
      return;
    }
    if (!fetchBookingsRef.current) {
      setNotifLoading(true);
      fetchBookingsRef.current = true;
    }
    fetchCustomerBookings();
    // Poll every 30 seconds for updates
    const interval = setInterval(fetchCustomerBookings, 30000);
    return () => clearInterval(interval);
  }, [customer?.customerId, fetchCustomerBookings]);

  const branchServices = useMemo(() => {
    if (!selectedBranch) return [];
    return allServices.filter((s) => s.branches.includes(selectedBranch.id));
  }, [selectedBranch, allServices]);

  const selectedServiceDetails = useMemo(() => allServices.filter((s) => selectedServices.includes(s.id)), [selectedServices, allServices]);
  const totalPrice = useMemo(() => selectedServiceDetails.reduce((sum, s) => sum + s.price, 0), [selectedServiceDetails]);
  const totalDuration = useMemo(() => selectedServiceDetails.reduce((sum, s) => sum + s.duration, 0), [selectedServiceDetails]);

  const today = new Date().toISOString().split("T")[0];
  const timeSlots = useMemo(() => {
    const slots: string[] = [];
    for (let h = 7; h <= 19; h++) for (let m = 0; m < 60; m += 30) slots.push(`${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`);
    return slots;
  }, []);

  const handleBranchSelect = (branch: Branch) => { setSelectedBranch(branch); setSelectedServices([]); goToStep(2); };
  const toggleService = (serviceId: string) => {
    setSelectedServices((prev) => prev.includes(serviceId) ? prev.filter((id) => id !== serviceId) : [...prev, serviceId]);
  };

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!workshop) return;
    setAuthLoading(true); setAuthError("");
    try {
      const res = await fetch("/api/book-now/customer-auth", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: authMode === "login" ? "login" : "register", email: authEmail, password: authPassword, ownerUid: workshop.id, name: authName || undefined, phone: authPhone || undefined }),
      });
      const data = await res.json();
      if (!res.ok) { setAuthError(data.error || "Authentication failed"); return; }
      const session: CustomerSession = { customerId: data.customerId, name: data.name, email: data.email, phone: data.phone };
      setCustomer(session); setCustomerName(data.name); setCustomerEmail(data.email); setCustomerPhone(data.phone);
      sessionStorage.setItem(`bms_customer_${slug}`, JSON.stringify(session));
      setShowAuth(false); setAuthEmail(""); setAuthPassword(""); setAuthName(""); setAuthPhone("");
    } catch (err: any) { setAuthError(err.message || "Something went wrong"); }
    finally { setAuthLoading(false); }
  };

  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const [editingProfile, setEditingProfile] = useState(false);
  const [editName, setEditName] = useState("");
  const [editPhone, setEditPhone] = useState("");
  const [savingProfile, setSavingProfile] = useState(false);

  const handleLogout = () => {
    setCustomer(null); setCustomerName(""); setCustomerEmail(""); setCustomerPhone("");
    sessionStorage.removeItem(`bms_customer_${slug}`);
    setShowLogoutConfirm(false);
    setShowProfileMenu(false);
  };

  const handleSaveProfile = async () => {
    if (!customer || !editName.trim() || !editPhone.trim()) return;
    setSavingProfile(true);
    try {
      const res = await fetch("/api/book-now/customer-auth", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerId: customer.customerId, name: editName.trim(), phone: editPhone.trim() }),
      });
      if (res.ok) {
        const updated = { ...customer, name: editName.trim(), phone: editPhone.trim() };
        setCustomer(updated);
        setCustomerName(editName.trim());
        setCustomerPhone(editPhone.trim());
        sessionStorage.setItem(`bms_customer_${slug}`, JSON.stringify(updated));
        setEditingProfile(false);
      }
    } catch (err) {
      console.error("Failed to save profile:", err);
    } finally {
      setSavingProfile(false);
    }
  };


  const handleSubmit = async () => {
    if (!selectedBranch || selectedServices.length === 0 || !customerName || !customerPhone || !date || !time) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/book-now/submit", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, branchId: selectedBranch.id, branchName: selectedBranch.name, services: selectedServiceDetails.map((s) => ({ id: s.id, time })), customerName, customerEmail, customerPhone, notes, date, time, customerId: customer?.customerId || null }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to submit booking");
      setBookingResult({ bookingCode: data.bookingCode, totalPrice: data.totalPrice, totalDuration: data.totalDuration });
      fetchCustomerBookings(); // Refresh bookings list immediately
      goToStep(4);
      setTimeout(() => setShowConfetti(true), 400);
    } catch (err: any) { alert(err.message || "Something went wrong"); }
    finally { setSubmitting(false); }
  };

  /* ═══════════════════ LOADING STATE ═══════════════════ */
  if (loading) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center relative overflow-hidden">
        {/* Animated background blobs */}
        <div className="absolute w-[500px] h-[500px] rounded-full bg-amber-500/[0.03] blur-[100px] -top-48 -left-48 animate-pulse" />
        <div className="absolute w-[400px] h-[400px] rounded-full bg-neutral-500/[0.04] blur-[80px] -bottom-32 -right-32 animate-pulse" style={{ animationDelay: "1s" }} />
        <div className="relative z-10 text-center">
          {/* Animated gear */}
          <div className="relative w-20 h-20 mx-auto mb-6">
            <div className="absolute inset-0 rounded-full border-[3px] border-neutral-800 border-t-amber-500 animate-spin" />
            <div className="absolute inset-3 rounded-full border-[3px] border-neutral-800 border-b-amber-400 animate-spin" style={{ animationDirection: "reverse", animationDuration: "1.5s" }} />
            <div className="absolute inset-0 flex items-center justify-center">
              <i className="fas fa-wrench text-amber-500/60 text-lg" />
            </div>
          </div>
          <p className="text-neutral-500 text-sm font-medium tracking-wide">Loading your booking page</p>
          <div className="flex items-center justify-center gap-1 mt-3">
            {[0, 1, 2].map(i => (
              <div key={i} className="w-1.5 h-1.5 rounded-full bg-amber-500/60 animate-bounce" style={{ animationDelay: `${i * 150}ms` }} />
            ))}
          </div>
        </div>
      </div>
    );
  }

  /* ═══════════════════ ERROR / NOT FOUND ═══════════════════ */
  if (error || !workshop) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center p-4 relative overflow-hidden">
        <div className="absolute w-[500px] h-[500px] rounded-full bg-red-500/[0.02] blur-[100px] top-0 right-0" />
        <div className="relative z-10 text-center max-w-md">
          <div className="w-24 h-24 mx-auto mb-6 relative">
            <div className="absolute inset-0 rounded-2xl bg-white/[0.03] border border-white/[0.06] rotate-6" />
            <div className="absolute inset-0 rounded-2xl bg-white/[0.05] border border-white/[0.08] -rotate-3" />
            <div className="relative w-full h-full rounded-2xl bg-white/[0.07] border border-white/[0.1] flex items-center justify-center">
              <i className="fas fa-wrench text-3xl text-neutral-600" />
            </div>
          </div>
          <h1 className="text-2xl font-bold text-white mb-2">Workshop Not Found</h1>
          <p className="text-neutral-500 text-sm leading-relaxed">{error || "This booking page doesn't exist or is no longer available."}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#fafafa] flex flex-col relative">

      {/* ═══════════════════ ANIMATED BACKGROUND ═══════════════════ */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden z-0">
        <div className="absolute w-[600px] h-[600px] rounded-full bg-amber-200/20 blur-[120px] -top-64 -right-64 animate-[float_20s_ease-in-out_infinite]" />
        <div className="absolute w-[500px] h-[500px] rounded-full bg-neutral-300/15 blur-[100px] -bottom-48 -left-48 animate-[float_25s_ease-in-out_infinite_reverse]" />
        <div className="absolute w-[300px] h-[300px] rounded-full bg-amber-100/10 blur-[80px] top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 animate-[float_15s_ease-in-out_infinite]" />
      </div>

      {/* ═══════════════════ TOP NAV BAR ═══════════════════ */}
      <nav className="sticky top-0 z-40 backdrop-blur-xl bg-white/70 border-b border-neutral-200/60">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            {workshop.logoUrl ? (
              <img src={workshop.logoUrl} alt={workshop.name} className="w-10 h-10 rounded-xl object-cover shadow-md border border-neutral-200/50" />
            ) : (
              <div className="w-10 h-10 rounded-xl bg-neutral-900 flex items-center justify-center shadow-md">
                <i className="fas fa-wrench text-amber-400 text-sm" />
              </div>
            )}
            <div className="leading-none">
              <h1 className="text-base font-extrabold text-neutral-900 tracking-tight">{workshop.name}</h1>
              <p className="text-[10px] text-neutral-400 font-medium mt-0.5">Online Booking</p>
            </div>
          </div>
          {customer ? (
            <div className="flex items-center gap-1.5">
              {/* Notification Bell */}
              <button
                onClick={() => { setShowNotifications((v) => { if (!v) markAllAsRead(); return !v; }); }}
                className="relative w-9 h-9 rounded-xl bg-neutral-100 hover:bg-neutral-200 flex items-center justify-center transition-all active:scale-95"
                title="Notifications"
              >
                <i className="fas fa-bell text-sm text-neutral-600" />
                {unreadCount > 0 && (
                    <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] flex items-center justify-center bg-amber-500 text-white text-[9px] font-bold rounded-full px-1 shadow-lg shadow-amber-500/30 animate-[popIn_0.3s_ease-out]">
                      {unreadCount}
                  </span>
                )}
              </button>
              {/* Profile Icon */}
              <button
                onClick={() => { setShowProfileMenu((v) => !v); setEditingProfile(false); }}
                className="w-9 h-9 rounded-full bg-neutral-900 flex items-center justify-center text-white text-xs font-bold hover:bg-neutral-800 transition-all active:scale-95 shadow-sm"
                title="Profile"
              >
                {customer.name?.charAt(0)?.toUpperCase() || <i className="fas fa-user text-[10px]" />}
              </button>
            </div>
          ) : (
            <button onClick={() => setShowAuth(true)} className="group flex items-center gap-2 bg-neutral-900 hover:bg-neutral-800 text-white text-xs font-semibold px-4 py-2.5 rounded-xl transition-all shadow-lg shadow-neutral-900/10 hover:shadow-xl hover:shadow-neutral-900/15 active:scale-[0.97]">
              <i className="fas fa-arrow-right-to-bracket text-[10px] group-hover:translate-x-0.5 transition-transform" />
              Sign in
            </button>
          )}
        </div>
        {/* ── View Tabs (logged in only) ── */}
        {customer && (
          <div className="max-w-4xl mx-auto px-4 sm:px-6 flex items-center gap-1 pt-2 pb-1">
            <button
              onClick={() => setActiveView("booking")}
              className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-[11px] font-bold transition-all ${
                activeView === "booking"
                  ? "bg-neutral-900 text-white shadow-md shadow-neutral-900/15"
                  : "text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700"
              }`}
            >
              <i className="fas fa-calendar-plus text-[9px]" />
              Book Now
            </button>
            <button
              onClick={() => setActiveView("myBookings")}
              className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-[11px] font-bold transition-all ${
                activeView === "myBookings"
                  ? "bg-neutral-900 text-white shadow-md shadow-neutral-900/15"
                  : "text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700"
              }`}
            >
              <i className="fas fa-list-check text-[9px]" />
              My Bookings
              {customerBookings.length > 0 && (
                <span className={`min-w-[18px] h-[18px] flex items-center justify-center text-[9px] font-bold rounded-full px-1 ${
                  activeView === "myBookings" ? "bg-white/20 text-white" : "bg-neutral-200 text-neutral-600"
                }`}>
                  {customerBookings.length}
                </span>
              )}
            </button>
          </div>
        )}
      </nav>

      {/* ═══════════════════ NOTIFICATIONS DROPDOWN ═══════════════════ */}
      {showNotifications && (
        <>
          {/* Backdrop - click to close */}
          <div className="fixed inset-0 z-50 bg-black/20 sm:bg-black/10" onClick={() => setShowNotifications(false)} />

          {/* Panel: mobile bottom-sheet / desktop top-right card */}
          <div className="fixed inset-x-0 bottom-0 sm:bottom-auto sm:top-[68px] sm:inset-x-auto sm:right-[max(1rem,calc((100vw-56rem)/2+0.5rem))] sm:w-[380px] z-50 max-h-[75vh] sm:max-h-[70vh] bg-white rounded-t-2xl sm:rounded-2xl shadow-2xl shadow-neutral-900/20 border border-neutral-200/80 flex flex-col overflow-hidden animate-[slideUpSheet_0.25s_ease-out] sm:animate-[dropdownPop_0.2s_ease-out]">

            {/* Drag handle (mobile only) */}
            <div className="sm:hidden flex justify-center pt-2 pb-1">
              <div className="w-10 h-1 rounded-full bg-neutral-300" />
            </div>

            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-100 bg-neutral-50/80">
              <div className="flex items-center gap-2.5">
                <div className="w-7 h-7 rounded-lg bg-neutral-900 flex items-center justify-center">
                  <i className="fas fa-bell text-amber-400 text-[10px]" />
                </div>
                <h3 className="text-sm font-extrabold text-neutral-900">Notifications</h3>
              </div>
              <button
                onClick={() => setShowNotifications(false)}
                className="w-7 h-7 rounded-lg hover:bg-neutral-200/60 flex items-center justify-center transition-colors"
              >
                <i className="fas fa-times text-[10px] text-neutral-400" />
              </button>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto overscroll-contain">
              {notifLoading ? (
                <div className="flex flex-col items-center justify-center py-12 gap-2">
                  <div className="w-8 h-8 rounded-full border-[3px] border-neutral-200 border-t-amber-500 animate-spin" />
                  <p className="text-[11px] text-neutral-400 font-medium">Loading...</p>
                </div>
              ) : visibleBookings.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 gap-3 text-center px-6">
                  <div className="w-12 h-12 rounded-xl bg-neutral-100 flex items-center justify-center">
                    <i className="fas fa-bell-slash text-lg text-neutral-300" />
                  </div>
                  <p className="text-xs font-bold text-neutral-600">No notifications</p>
                  <p className="text-[11px] text-neutral-400 -mt-1.5">Your booking updates will appear here.</p>
                </div>
              ) : (
                <div className="px-3 py-3 space-y-2.5">
                  {visibleBookings.map((bk) => {
                    const notifMap: Record<string, { iconBg: string; iconColor: string; icon: string; title: string; message: string }> = {
                      Pending: {
                        iconBg: "bg-amber-100",
                        iconColor: "text-amber-600",
                        icon: "fa-paper-plane",
                        title: "Request Received",
                        message: `Your booking for ${bk.serviceName} has been submitted and is awaiting confirmation.`,
                      },
                      AwaitingStaffApproval: {
                        iconBg: "bg-purple-100",
                        iconColor: "text-purple-600",
                        icon: "fa-user-clock",
                        title: "Awaiting Staff Approval",
                        message: `Your booking for ${bk.serviceName} is being reviewed by our staff.`,
                      },
                      PartiallyApproved: {
                        iconBg: "bg-purple-100",
                        iconColor: "text-purple-600",
                        icon: "fa-hourglass-half",
                        title: "In Review",
                        message: `Your booking for ${bk.serviceName} is partially approved and under review.`,
                      },
                      Confirmed: {
                        iconBg: "bg-emerald-100",
                        iconColor: "text-emerald-600",
                        icon: "fa-circle-check",
                        title: "Booking Confirmed",
                        message: `Great news! Your booking for ${bk.serviceName} on ${bk.date} at ${bk.time} has been confirmed.`,
                      },
                      Completed: {
                        iconBg: "bg-blue-100",
                        iconColor: "text-blue-600",
                        icon: "fa-flag-checkered",
                        title: "Service Completed",
                        message: `Your ${bk.serviceName} service has been completed. Thank you for choosing us!`,
                      },
                      Canceled: {
                        iconBg: "bg-rose-100",
                        iconColor: "text-rose-600",
                        icon: "fa-ban",
                        title: "Booking Cancelled",
                        message: `Your booking for ${bk.serviceName} on ${bk.date} has been cancelled.`,
                      },
                      StaffRejected: {
                        iconBg: "bg-orange-100",
                        iconColor: "text-orange-600",
                        icon: "fa-exclamation-triangle",
                        title: "Action Required",
                        message: `Your booking for ${bk.serviceName} needs attention. Please contact us for details.`,
                      },
                    };
                    const notif = notifMap[bk.status] || notifMap.Pending;

                    // Format time ago
                    const timeAgo = (() => {
                      const raw = bk.updatedAt || bk.createdAt;
                      if (!raw) return "";
                      const updated = new Date(raw);
                      const diff = Date.now() - updated.getTime();
                      const mins = Math.floor(diff / 60000);
                      if (mins < 1) return "Just now";
                      if (mins < 60) return `${mins}m ago`;
                      const hrs = Math.floor(mins / 60);
                      if (hrs < 24) return `${hrs}h ago`;
                      const days = Math.floor(hrs / 24);
                      return `${days}d ago`;
                    })();

                    return (
                      <div key={bk.id} className="bg-white rounded-xl border border-neutral-200/80 shadow-sm hover:shadow-md transition-all group overflow-hidden">
                        {/* Top color accent */}
                        <div className={`h-[3px] ${notif.iconBg.replace("100", "400").replace("bg-amber-400", "bg-amber-400").replace("bg-emerald-400", "bg-emerald-400").replace("bg-purple-400", "bg-purple-400").replace("bg-blue-400", "bg-blue-400").replace("bg-rose-400", "bg-rose-400").replace("bg-orange-400", "bg-orange-400")}`} style={{ background: notif.iconColor.includes("amber") ? "#f59e0b" : notif.iconColor.includes("emerald") ? "#10b981" : notif.iconColor.includes("purple") ? "#9333ea" : notif.iconColor.includes("blue") ? "#3b82f6" : notif.iconColor.includes("rose") ? "#f43f5e" : "#f97316" }} />
                        <div className="px-3.5 pt-3 pb-3">
                          {/* Header row */}
                          <div className="flex items-start gap-2.5 mb-2">
                            <div className={`w-8 h-8 rounded-lg ${notif.iconBg} flex items-center justify-center shrink-0`}>
                              <i className={`fas ${notif.icon} text-xs ${notif.iconColor}`} />
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-start justify-between gap-2">
                                <h4 className="text-[11px] font-bold text-neutral-900 leading-snug">{notif.title}</h4>
                                <div className="flex items-center gap-1.5 shrink-0">
                                  {timeAgo && <span className="text-[9px] text-neutral-300 font-medium">{timeAgo}</span>}
                                  <button
                                    onClick={(e) => { e.stopPropagation(); dismissNotification(bk.id); }}
                                    title="Remove notification"
                                    className="opacity-0 group-hover:opacity-100 sm:opacity-0 sm:group-hover:opacity-100 max-sm:opacity-60 w-5 h-5 flex items-center justify-center rounded-full text-neutral-300 hover:text-rose-500 hover:bg-rose-50 transition-all"
                                  >
                                    <i className="fas fa-trash-can text-[8px]" />
                                  </button>
                                </div>
                              </div>
                              <p className="text-[10px] text-neutral-500 leading-relaxed mt-0.5">{notif.message}</p>
                            </div>
                          </div>
                          {/* Details */}
                          <div className="bg-neutral-50/80 rounded-lg px-3 py-2 space-y-1.5">
                            <div className="flex items-center justify-between">
                              <span className="text-[10px] text-neutral-400 font-medium flex items-center gap-1.5"><i className="fas fa-hashtag text-[7px]" />Booking Code</span>
                              <span className="text-[10px] text-neutral-700 font-bold font-mono tracking-wide">{bk.bookingCode}</span>
                            </div>
                            <div className="flex items-center justify-between">
                              <span className="text-[10px] text-neutral-400 font-medium flex items-center gap-1.5"><i className="fas fa-wrench text-[7px]" />Service</span>
                              <span className="text-[10px] text-neutral-700 font-semibold">{bk.serviceName}</span>
                            </div>
                            <div className="flex items-center justify-between">
                              <span className="text-[10px] text-neutral-400 font-medium flex items-center gap-1.5"><i className="fas fa-calendar text-[7px]" />Date & Time</span>
                              <span className="text-[10px] text-neutral-700 font-semibold">{bk.date} at {bk.time}</span>
                            </div>
                            {bk.branchName && (
                              <div className="flex items-center justify-between">
                                <span className="text-[10px] text-neutral-400 font-medium flex items-center gap-1.5"><i className="fas fa-location-dot text-[7px]" />Branch</span>
                                <span className="text-[10px] text-neutral-700 font-semibold">{bk.branchName}</span>
                              </div>
                            )}
                            <div className="flex items-center justify-between pt-0.5 border-t border-neutral-100">
                              <span className="text-[10px] text-neutral-400 font-medium flex items-center gap-1.5"><i className="fas fa-dollar-sign text-[7px]" />Amount</span>
                              <span className="text-[10px] text-neutral-900 font-bold">${bk.price}</span>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Safe area for mobile */}
            <div className="sm:hidden h-[env(safe-area-inset-bottom)]" />
          </div>
        </>
      )}

      {/* ═══════════════════ PROFILE DROPDOWN ═══════════════════ */}
      {showProfileMenu && customer && (
        <>
          <div className="fixed inset-0 z-50 bg-black/20 sm:bg-black/10" onClick={() => { setShowProfileMenu(false); setEditingProfile(false); }} />
          <div className="fixed inset-x-0 bottom-0 sm:bottom-auto sm:top-[68px] sm:inset-x-auto sm:right-[max(1rem,calc((100vw-56rem)/2+0.5rem))] sm:w-[320px] z-50 bg-white rounded-t-2xl sm:rounded-2xl shadow-2xl shadow-neutral-900/20 border border-neutral-200/80 overflow-hidden animate-[slideUpSheet_0.25s_ease-out] sm:animate-[dropdownPop_0.2s_ease-out]">

            {/* Drag handle (mobile) */}
            <div className="sm:hidden flex justify-center pt-2 pb-1">
              <div className="w-10 h-1 rounded-full bg-neutral-300" />
            </div>

            {/* Profile Header */}
            <div className="px-5 pt-4 pb-3">
              <div className="flex items-center gap-3">
                <div className="w-11 h-11 rounded-full bg-neutral-900 flex items-center justify-center text-white text-base font-bold shrink-0">
                  {customer.name?.charAt(0)?.toUpperCase() || "?"}
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-bold text-neutral-900 truncate">{customer.name}</p>
                  <p className="text-[11px] text-neutral-400 truncate">{customer.email}</p>
                </div>
              </div>
            </div>

            <div className="border-t border-neutral-100" />

            {/* Edit Profile Section */}
            {!editingProfile ? (
              <div className="px-5 py-3">
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-xs text-neutral-500">
                      <i className="fas fa-user text-[10px] text-neutral-300 w-4 text-center" />
                      <span className="font-medium">{customer.name}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-neutral-500">
                    <i className="fas fa-envelope text-[10px] text-neutral-300 w-4 text-center" />
                    <span className="font-medium">{customer.email}</span>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-neutral-500">
                    <i className="fas fa-phone text-[10px] text-neutral-300 w-4 text-center" />
                    <span className="font-medium">{customer.phone || "—"}</span>
                  </div>
                </div>
                <button
                  onClick={() => { setEditName(customer.name); setEditPhone(customer.phone); setEditingProfile(true); }}
                  className="mt-3 w-full flex items-center justify-center gap-1.5 py-2 rounded-xl bg-neutral-100 hover:bg-neutral-200 text-xs font-semibold text-neutral-700 transition-colors"
                >
                  <i className="fas fa-pen text-[9px]" />
                  Edit Details
                </button>
              </div>
            ) : (
              <div className="px-5 py-3 space-y-3">
                <div>
                  <label className="block text-[10px] font-semibold text-neutral-400 mb-1 uppercase tracking-wider">Name</label>
                  <input
                    type="text"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    className="w-full border-2 border-neutral-200 rounded-xl px-3 py-2 text-sm font-medium text-neutral-900 focus:border-neutral-900 focus:ring-0 outline-none transition-colors bg-neutral-50/50"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-semibold text-neutral-400 mb-1 uppercase tracking-wider">Email</label>
                  <div className="w-full border-2 border-neutral-100 rounded-xl px-3 py-2 text-sm font-medium text-neutral-400 bg-neutral-50 cursor-not-allowed flex items-center gap-2">
                    <i className="fas fa-lock text-[9px] text-neutral-300" />
                    {customer.email}
                  </div>
                </div>
                <div>
                  <label className="block text-[10px] font-semibold text-neutral-400 mb-1 uppercase tracking-wider">Phone</label>
                  <input
                    type="tel"
                    value={editPhone}
                    onChange={(e) => setEditPhone(e.target.value)}
                    className="w-full border-2 border-neutral-200 rounded-xl px-3 py-2 text-sm font-medium text-neutral-900 focus:border-neutral-900 focus:ring-0 outline-none transition-colors bg-neutral-50/50"
                  />
                </div>
                <div className="flex gap-2 pt-1">
                  <button
                    onClick={() => setEditingProfile(false)}
                    className="flex-1 py-2.5 rounded-xl bg-neutral-100 hover:bg-neutral-200 text-xs font-bold text-neutral-600 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleSaveProfile}
                    disabled={savingProfile || !editName.trim() || !editPhone.trim()}
                    className="flex-1 py-2.5 rounded-xl bg-neutral-900 hover:bg-neutral-800 text-white text-xs font-bold transition-colors disabled:opacity-50 flex items-center justify-center gap-1.5"
                  >
                    {savingProfile ? (
                      <div className="w-3.5 h-3.5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                    ) : (
                      <><i className="fas fa-check text-[9px]" />Save</>
                    )}
                  </button>
                </div>
              </div>
            )}

            <div className="border-t border-neutral-100" />

            {/* Sign Out */}
            <button
              onClick={() => { setShowProfileMenu(false); setShowLogoutConfirm(true); }}
              className="w-full px-5 py-3 flex items-center justify-center gap-2 text-xs font-semibold text-rose-600 hover:bg-rose-50 transition-colors"
            >
              <i className="fas fa-arrow-right-from-bracket text-[10px]" />
              Sign Out
            </button>

            {/* Bottom spacing + safe area for mobile */}
            <div className="h-4 sm:h-1" />
            <div className="sm:hidden h-[env(safe-area-inset-bottom)]" />
          </div>
        </>
      )}

      {/* ═══════════════════ HERO BANNER (Step 1 only) ═══════════════════ */}
      {activeView === "booking" && step === 1 && (
        <div className="relative z-10 overflow-hidden">
          <div className="bg-neutral-900 relative">
            {/* Abstract shapes */}
            <div className="absolute inset-0 overflow-hidden">
              <div className="absolute top-0 right-0 w-96 h-96 bg-amber-500/[0.07] rounded-full blur-[80px] translate-x-1/3 -translate-y-1/3" />
              <div className="absolute bottom-0 left-0 w-64 h-64 bg-white/[0.03] rounded-full blur-[60px] -translate-x-1/3 translate-y-1/3" />
              {/* Geometric lines */}
              <svg className="absolute inset-0 w-full h-full opacity-[0.04]" xmlns="http://www.w3.org/2000/svg">
                <defs>
                  <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
                    <path d="M 40 0 L 0 0 0 40" fill="none" stroke="white" strokeWidth="0.5" />
                  </pattern>
                </defs>
                <rect width="100%" height="100%" fill="url(#grid)" />
              </svg>
            </div>

            <div className="max-w-4xl mx-auto px-4 sm:px-6 py-12 sm:py-16 relative z-10">
              <div className="animate-[fadeSlideUp_0.7s_ease-out]">
                {/* Workshop branding */}
                <div className="flex items-center gap-4 mb-8">
                  {workshop.logoUrl ? (
                    <img src={workshop.logoUrl} alt={workshop.name} className="w-16 h-16 sm:w-20 sm:h-20 rounded-2xl object-cover shadow-2xl shadow-black/30 border-2 border-white/10" />
                  ) : (
                    <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-2xl bg-white/10 backdrop-blur-sm border-2 border-white/10 flex items-center justify-center shadow-2xl shadow-black/20">
                      <i className="fas fa-wrench text-amber-400 text-xl sm:text-2xl" />
                    </div>
                  )}
                  <div>
                    <h2 className="text-2xl sm:text-4xl font-black text-white leading-tight tracking-tight">
                      {workshop.name}
                    </h2>
                    <div className="flex items-center gap-2 mt-1.5">
                      <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                      <span className="text-xs sm:text-sm text-neutral-400 font-medium">Online booking available</span>
                    </div>
                  </div>
                </div>

                <h3 className="text-xl sm:text-2xl font-bold text-white/80 leading-snug max-w-lg">
                  Schedule your
                  <span className="text-transparent bg-clip-text bg-gradient-to-r from-amber-400 via-yellow-300 to-amber-500 animate-[shimmer_3s_ease-in-out_infinite] ml-2" style={{ backgroundSize: "200% auto" }}>
                    next service
                  </span>
                </h3>

                <p className="text-neutral-500 text-sm sm:text-base mt-3 max-w-md leading-relaxed">
                  Select your branch, pick services, and book — all in under 2 minutes.
                </p>

                {/* Feature chips */}
                <div className="flex flex-wrap gap-2.5 mt-8">
                  {[
                    { icon: "fa-bolt", label: "Instant Booking", color: "text-amber-400" },
                    { icon: "fa-layer-group", label: "Multi-Service", color: "text-blue-400" },
                    { icon: "fa-shield-check", label: "Confirmed", color: "text-emerald-400" },
                  ].map((chip) => (
                    <div key={chip.label} className="flex items-center gap-2 bg-white/[0.06] backdrop-blur-sm border border-white/[0.08] rounded-xl px-3.5 py-2 hover:bg-white/[0.1] transition-colors cursor-default group">
                      <i className={`fas ${chip.icon} text-[10px] ${chip.color} group-hover:scale-110 transition-transform`} />
                      <span className="text-[11px] text-neutral-300 font-medium">{chip.label}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Wave separator */}
            <div className="absolute bottom-0 left-0 right-0">
              <svg viewBox="0 0 1440 60" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-full" preserveAspectRatio="none">
                <path d="M0 60L48 55C96 50 192 40 288 35C384 30 480 30 576 33.3C672 36.7 768 43.3 864 45C960 46.7 1056 43.3 1152 38.3C1248 33.3 1344 26.7 1392 23.3L1440 20V60H1392C1344 60 1248 60 1152 60C1056 60 960 60 864 60C768 60 672 60 576 60C480 60 384 60 288 60C192 60 96 60 48 60H0Z" fill="#fafafa" />
              </svg>
            </div>
          </div>
        </div>
      )}

      {/* ═══════════════════ PROGRESS BAR ═══════════════════ */}
      {activeView === "booking" && step < 4 && (
        <div className="relative z-10 bg-white/70 backdrop-blur-md border-b border-neutral-100">
          <div className="max-w-4xl mx-auto px-4 sm:px-6 py-4">
            <div className="flex items-center">
              {[
                { n: 1, label: "Location", icon: "fa-location-dot" },
                { n: 2, label: "Services", icon: "fa-wrench" },
                { n: 3, label: "Book", icon: "fa-calendar-check" },
              ].map((s, i) => (
                <React.Fragment key={s.n}>
                  {i > 0 && (
                    <div className="flex-1 mx-2 sm:mx-3 h-[3px] rounded-full bg-neutral-100 relative overflow-hidden">
                      <div
                        className="absolute inset-y-0 left-0 bg-neutral-900 rounded-full transition-all duration-700 ease-out"
                        style={{ width: step > s.n - 1 ? "100%" : step === s.n - 1 ? "0%" : "0%" }}
                      />
                    </div>
                  )}
                  <button
                    onClick={() => { if (s.n < step && s.n < 4) goToStep(s.n); }}
                    disabled={s.n >= step}
                    className="flex items-center gap-2 group"
                  >
                    <div className={`relative w-9 h-9 rounded-xl flex items-center justify-center text-xs font-bold transition-all duration-500 ${
                      step > s.n
                        ? "bg-neutral-900 text-white shadow-lg shadow-neutral-900/15 scale-100"
                        : step === s.n
                        ? "bg-amber-500 text-neutral-900 shadow-lg shadow-amber-500/25 scale-105"
                        : "bg-neutral-100 text-neutral-400"
                    }`}>
                      {step > s.n ? (
                        <i className="fas fa-check text-[10px]" />
                      ) : (
                        <i className={`fas ${s.icon} text-[11px]`} />
                      )}
                      {step === s.n && (
                        <div className="absolute inset-0 rounded-xl border-2 border-amber-400 animate-[ringPulse_2s_ease-in-out_infinite]" />
                      )}
                    </div>
                    <span className={`text-xs font-semibold hidden sm:block transition-colors duration-300 ${
                      step >= s.n ? "text-neutral-900" : "text-neutral-400"
                    }`}>
                      {s.label}
                    </span>
                  </button>
                </React.Fragment>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ═══════════════════ MAIN CONTENT ═══════════════════ */}
      {activeView === "booking" && (
      <main className="flex-1 max-w-4xl mx-auto px-4 sm:px-6 py-8 sm:py-10 w-full relative z-10">

        {/* ── STEP 1: Branch Selection ── */}
        {step === 1 && (
          <div className="animate-[fadeSlideUp_0.5s_ease-out]">
            <div className="flex items-end justify-between mb-6">
              <div>
                <h3 className="text-xl sm:text-2xl font-bold text-neutral-900 tracking-tight">Choose a location</h3>
                <p className="text-neutral-500 text-sm mt-1">Select the workshop branch nearest to you</p>
              </div>
              <span className="text-xs text-neutral-400 font-semibold bg-neutral-100 px-3 py-1.5 rounded-full hidden sm:block">
                {branches.length} location{branches.length !== 1 ? "s" : ""}
              </span>
            </div>

            {branches.length === 0 ? (
              <div className="text-center py-20 bg-white rounded-3xl border border-neutral-200/80 shadow-sm">
                <div className="w-20 h-20 bg-neutral-100 rounded-3xl flex items-center justify-center mx-auto mb-5 relative">
                  <i className="fas fa-store text-2xl text-neutral-300" />
                  <div className="absolute -bottom-1 -right-1 w-7 h-7 rounded-full bg-amber-100 flex items-center justify-center border-2 border-white">
                    <i className="fas fa-clock text-amber-600 text-[9px]" />
                  </div>
                </div>
                <p className="text-neutral-600 font-semibold text-lg">No locations yet</p>
                <p className="text-neutral-400 text-sm mt-1.5 max-w-xs mx-auto">This workshop is still setting up. Check back soon!</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {branches.map((branch, idx) => (
                  <button
                    key={branch.id}
                    onClick={() => handleBranchSelect(branch)}
                    className="group relative bg-white rounded-2xl border border-neutral-200/80 p-6 sm:p-7 text-left transition-all duration-300 hover:shadow-2xl hover:shadow-neutral-900/[0.06] hover:-translate-y-1 hover:border-neutral-300 active:scale-[0.98] overflow-hidden"
                    style={{ animationDelay: `${idx * 100}ms`, animation: `fadeSlideUp 0.5s ease-out ${idx * 100}ms both` }}
                  >
                    {/* Hover gradient overlay */}
                    <div className="absolute inset-0 bg-gradient-to-br from-amber-50/0 via-transparent to-amber-50/0 group-hover:from-amber-50/50 group-hover:to-orange-50/30 transition-all duration-500 rounded-2xl" />

                    <div className="relative z-10">
                      <div className="flex items-start justify-between mb-5">
                        <div className="w-14 h-14 rounded-2xl bg-neutral-900 group-hover:bg-amber-500 flex items-center justify-center transition-all duration-300 shadow-lg shadow-neutral-900/10 group-hover:shadow-amber-500/20 group-hover:rotate-3 group-hover:scale-105">
                          <i className="fas fa-map-marker-alt text-white text-base" />
                        </div>
                        <div className="w-10 h-10 rounded-xl bg-neutral-50 group-hover:bg-neutral-900 flex items-center justify-center transition-all duration-300 opacity-0 group-hover:opacity-100 translate-x-2 group-hover:translate-x-0">
                          <i className="fas fa-arrow-right text-neutral-900 group-hover:text-white text-xs transition-colors" />
                        </div>
                      </div>

                      <h4 className="font-extrabold text-neutral-900 text-xl sm:text-2xl mb-2 group-hover:text-neutral-900 transition-colors tracking-tight leading-tight">{branch.name}</h4>

                      {branch.address && (
                        <div className="flex items-start gap-2 mb-2 bg-neutral-50 group-hover:bg-amber-50/60 rounded-xl px-3 py-2.5 transition-colors">
                          <i className="fas fa-location-dot text-[11px] mt-0.5 text-amber-500" />
                          <p className="text-sm font-medium text-neutral-600 group-hover:text-neutral-700 transition-colors leading-snug">{branch.address}</p>
                        </div>
                      )}
                      {branch.phone && (
                        <div className="flex items-center gap-2 mt-1">
                          <i className="fas fa-phone text-[10px] text-neutral-400" />
                          <p className="text-sm text-neutral-500 font-medium">{branch.phone}</p>
                        </div>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── STEP 2: Service Selection ── */}
        {step === 2 && (
          <div className="animate-[fadeSlideUp_0.4s_ease-out]">
            <div className="flex items-start sm:items-center justify-between mb-6 gap-3 flex-col sm:flex-row">
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <button onClick={() => goToStep(1)} className="w-8 h-8 rounded-xl bg-neutral-100 hover:bg-neutral-200 flex items-center justify-center transition group">
                    <i className="fas fa-arrow-left text-[10px] text-neutral-500 group-hover:-translate-x-0.5 transition-transform" />
                  </button>
                  <span className="inline-flex items-center gap-1.5 bg-neutral-900 text-white text-[11px] font-semibold px-3 py-1 rounded-full">
                    <i className="fas fa-location-dot text-amber-400 text-[8px]" />
                    {selectedBranch?.name}
                  </span>
                </div>
                <h3 className="text-xl sm:text-2xl font-bold text-neutral-900 tracking-tight">Pick your services</h3>
                <p className="text-neutral-500 text-sm mt-1">Select one or more services for your visit</p>
              </div>
              {selectedServices.length > 0 && (
                <div className="bg-amber-50 border border-amber-200/50 rounded-xl px-4 py-2 flex items-center gap-2">
                  <span className="w-6 h-6 rounded-full bg-amber-500 text-white text-[10px] font-bold flex items-center justify-center">{selectedServices.length}</span>
                  <span className="text-sm font-semibold text-amber-800">selected</span>
                </div>
              )}
            </div>

            {branchServices.length === 0 ? (
              <div className="text-center py-20 bg-white rounded-3xl border border-neutral-200/80 shadow-sm">
                <div className="w-20 h-20 bg-neutral-100 rounded-3xl flex items-center justify-center mx-auto mb-5">
                  <i className="fas fa-wrench text-2xl text-neutral-300" />
                </div>
                <p className="text-neutral-600 font-semibold text-lg">No services available</p>
                <p className="text-neutral-400 text-sm mt-1.5">This branch doesn&apos;t have services listed yet.</p>
              </div>
            ) : (
              <div className="space-y-3">
                {branchServices.map((service, idx) => {
                  const isSelected = selectedServices.includes(service.id);
                  const isExpanded = expandedService === service.id;
                  return (
                    <div
                      key={service.id}
                      className={`rounded-2xl border-2 transition-all duration-300 overflow-hidden ${
                        isSelected
                          ? "border-neutral-900 bg-white shadow-xl shadow-neutral-900/[0.08]"
                          : "border-neutral-200/80 bg-white hover:border-neutral-300 hover:shadow-lg hover:shadow-neutral-900/[0.03]"
                      }`}
                      style={{ animation: `fadeSlideUp 0.4s ease-out ${idx * 60}ms both` }}
                    >
                      {/* Main row - clickable to select */}
                      <button
                        onClick={() => toggleService(service.id)}
                        className="w-full text-left group"
                      >
                        <div className="flex items-stretch">
                          {/* Left color accent */}
                          <div className={`w-1.5 flex-shrink-0 transition-all duration-300 ${isSelected ? "bg-amber-500" : "bg-transparent group-hover:bg-neutral-200"}`} />

                          <div className="flex items-center gap-4 p-4 sm:p-5 flex-1 min-w-0">
                            {/* Checkbox */}
                            <div className={`w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0 transition-all duration-300 ${
                              isSelected
                                ? "bg-neutral-900 shadow-md shadow-neutral-900/20 scale-105"
                                : "bg-neutral-100 group-hover:bg-neutral-200"
                            }`}>
                              {isSelected ? (
                                <i className="fas fa-check text-white text-xs animate-[popIn_0.3s_ease-out]" />
                              ) : (
                                <i className="fas fa-plus text-neutral-400 text-xs" />
                              )}
                            </div>

                            {/* Service image */}
                            {service.imageUrl ? (
                              <img src={service.imageUrl} alt={service.name} className="w-14 h-14 sm:w-16 sm:h-16 rounded-xl object-cover flex-shrink-0 border border-neutral-100" />
                            ) : (
                              <div className="w-14 h-14 sm:w-16 sm:h-16 rounded-xl bg-gradient-to-br from-neutral-100 to-neutral-50 flex items-center justify-center flex-shrink-0">
                                <i className="fas fa-wrench text-neutral-300 text-lg" />
                              </div>
                            )}

                            {/* Service info */}
                            <div className="flex-1 min-w-0">
                              <h4 className="font-bold text-neutral-900 text-sm sm:text-base truncate">{service.name}</h4>
                              <div className="flex items-center gap-3 mt-1">
                                <span className="text-xs text-neutral-400 flex items-center gap-1">
                                  <i className="far fa-clock text-[9px]" />
                                  {service.duration} min
                                </span>
                                {service.checklist.length > 0 && (
                                  <span className="text-xs text-amber-600 flex items-center gap-1">
                                    <i className="fas fa-list-check text-[9px]" />
                                    {service.checklist.length} tasks
                                  </span>
                                )}
                              </div>
                            </div>

                            {/* Price */}
                            <div className="flex-shrink-0 text-right">
                              <p className={`text-xl font-extrabold tracking-tight transition-colors ${isSelected ? "text-neutral-900" : "text-neutral-700"}`}>
                                ${service.price}
                              </p>
                            </div>
                          </div>
                        </div>
                      </button>

                      {/* See more / checklist toggle */}
                      {service.checklist.length > 0 && (
                        <div className="px-5 pb-1">
                          <button
                            onClick={(e) => { e.stopPropagation(); setExpandedService(isExpanded ? null : service.id); }}
                            className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-600 hover:text-amber-700 py-2 transition-colors group/see"
                          >
                            <i className={`fas fa-chevron-down text-[8px] transition-transform duration-300 ${isExpanded ? "rotate-180" : ""}`} />
                            {isExpanded ? "Hide details" : `What's included (${service.checklist.length})`}
                          </button>
                        </div>
                      )}

                      {/* Expanded todo list */}
                      {service.checklist.length > 0 && isExpanded && (
                        <div className="px-5 pb-5 animate-[fadeSlideUp_0.3s_ease-out]">
                          <div className="bg-gradient-to-br from-amber-50/80 to-orange-50/50 rounded-xl border border-amber-200/40 p-4">
                            <div className="flex items-center gap-2 mb-3">
                              <div className="w-6 h-6 rounded-lg bg-amber-500 flex items-center justify-center">
                                <i className="fas fa-clipboard-list text-white text-[9px]" />
                              </div>
                              <h5 className="text-xs font-bold text-neutral-800 uppercase tracking-wider">What&apos;s Included</h5>
                            </div>
                            <div className="space-y-2">
                              {service.checklist.map((item, i) => (
                                <div key={i} className="flex items-start gap-2.5 group/item" style={{ animation: `fadeSlideUp 0.3s ease-out ${i * 50}ms both` }}>
                                  <div className="w-5 h-5 rounded-md bg-white border border-amber-200 flex items-center justify-center flex-shrink-0 mt-0.5 shadow-sm">
                                    <i className="fas fa-check text-amber-500 text-[8px]" />
                                  </div>
                                  <div className="min-w-0">
                                    <span className="text-sm text-neutral-700 font-medium leading-snug block">{item.name}</span>
                                    {item.description && (
                                      <span className="text-xs text-neutral-400 leading-snug block mt-0.5">{item.description}</span>
                                    )}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Floating summary bar */}
            {selectedServices.length > 0 && (
              <div className="mt-8 animate-[slideUpBounce_0.4s_ease-out]">
                <div className="bg-neutral-900 text-white rounded-2xl p-5 flex items-center justify-between sticky bottom-4 shadow-2xl shadow-neutral-900/25 border border-white/[0.05] relative overflow-hidden">
                  {/* Animated shimmer */}
                  <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/[0.03] to-transparent animate-[shimmerBg_3s_linear_infinite]" style={{ backgroundSize: "200% 100%" }} />
                  <div className="relative z-10 flex items-center justify-between w-full">
                    <div>
                      <p className="text-neutral-400 text-xs font-medium">
                        {selectedServices.length} service{selectedServices.length > 1 ? "s" : ""} · {totalDuration} min
                      </p>
                      <p className="text-2xl font-extrabold tracking-tight mt-0.5">
                        ${totalPrice}
                      </p>
                    </div>
                    <button onClick={() => goToStep(3)} className="group bg-amber-500 hover:bg-amber-400 text-neutral-900 font-bold px-6 py-3 rounded-xl transition-all text-sm active:scale-[0.97] shadow-lg shadow-amber-500/25 flex items-center gap-2">
                      Continue
                      <i className="fas fa-arrow-right text-xs group-hover:translate-x-1 transition-transform" />
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── STEP 3: Customer Details ── */}
        {step === 3 && (
          <div className="animate-[fadeSlideUp_0.4s_ease-out]">
            <div className="flex items-center gap-2 mb-6">
              <button onClick={() => goToStep(2)} className="w-8 h-8 rounded-xl bg-neutral-100 hover:bg-neutral-200 flex items-center justify-center transition group">
                <i className="fas fa-arrow-left text-[10px] text-neutral-500 group-hover:-translate-x-0.5 transition-transform" />
              </button>
              <div>
                <h3 className="text-xl sm:text-2xl font-bold text-neutral-900 tracking-tight">Complete your booking</h3>
                <p className="text-neutral-500 text-sm mt-0.5">Choose a date, time, and fill in your details</p>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
              {/* Left column - form */}
              <div className="lg:col-span-3 space-y-5">

                {/* Login prompt */}
                {!customer && (
                  <div className="relative bg-white rounded-2xl border border-neutral-200/80 p-5 overflow-hidden group hover:shadow-lg transition-shadow">
                    <div className="absolute top-0 right-0 w-32 h-32 bg-amber-100/30 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2" />
                    <div className="relative z-10 flex items-center justify-between gap-4">
                      <div className="flex items-center gap-3">
                        <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center shadow-lg shadow-amber-500/15">
                          <i className="fas fa-user-circle text-white text-base" />
                        </div>
                        <div>
                          <p className="font-bold text-neutral-900 text-sm">Already a customer?</p>
                          <p className="text-xs text-neutral-400 mt-0.5">Sign in to auto-fill your info</p>
                        </div>
                      </div>
                      <button onClick={() => setShowAuth(true)} className="bg-neutral-900 text-white text-xs font-semibold px-5 py-2.5 rounded-xl hover:bg-neutral-800 transition active:scale-[0.97] shadow-md flex-shrink-0">
                        Sign in
                      </button>
                    </div>
                  </div>
                )}

                {customer && (
                  <div className="bg-white rounded-2xl border border-emerald-200/60 p-4 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-xl bg-emerald-500 flex items-center justify-center shadow-md shadow-emerald-500/15">
                        <i className="fas fa-check text-white text-sm" />
                      </div>
                      <div>
                        <p className="font-bold text-neutral-900 text-sm">{customer.name}</p>
                        <p className="text-[11px] text-neutral-400">{customer.email}</p>
                      </div>
                    </div>
                    <button onClick={() => setShowLogoutConfirm(true)} className="text-xs text-neutral-400 hover:text-neutral-700 font-medium bg-neutral-100 px-3 py-1.5 rounded-lg hover:bg-neutral-200 transition">
                      Sign out
                    </button>
                  </div>
                )}

                {/* Date & Time */}
                <div className="bg-white rounded-2xl border border-neutral-200/80 p-5 sm:p-6 shadow-sm hover:shadow-md transition-shadow">
                  <h4 className="font-bold text-neutral-900 mb-4 flex items-center gap-2.5 text-sm">
                    <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center shadow-md shadow-amber-500/10">
                      <i className="fas fa-calendar text-white text-xs" />
                    </div>
                    When would you like to visit?
                  </h4>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    {/* Custom Calendar */}
                    <div>
                      <label className="block text-[11px] font-bold text-neutral-400 uppercase tracking-wider mb-2">Date <span className="text-red-400">*</span></label>
                      {(() => {
                        const { year, month } = calendarMonth;
                        const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
                        const dayNames = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
                        const firstDay = new Date(year, month, 1);
                        const lastDay = new Date(year, month + 1, 0);
                        const startDow = (firstDay.getDay() + 6) % 7; // Monday=0
                        const daysInMonth = lastDay.getDate();
                        const todayDate = new Date(); todayDate.setHours(0, 0, 0, 0);

                        const prevMonth = () => setCalendarMonth((p) => p.month === 0 ? { year: p.year - 1, month: 11 } : { year: p.year, month: p.month - 1 });
                        const nextMonth = () => setCalendarMonth((p) => p.month === 11 ? { year: p.year + 1, month: 0 } : { year: p.year, month: p.month + 1 });
                        const goToday = () => { const now = new Date(); setCalendarMonth({ year: now.getFullYear(), month: now.getMonth() }); };

                        const canGoPrev = new Date(year, month, 1) > new Date(todayDate.getFullYear(), todayDate.getMonth(), 1);

                        const cells: (number | null)[] = [];
                        for (let i = 0; i < startDow; i++) cells.push(null);
                        for (let d = 1; d <= daysInMonth; d++) cells.push(d);
                        while (cells.length % 7 !== 0) cells.push(null);

                        return (
                          <div className="border-2 border-neutral-200 rounded-xl overflow-hidden bg-white">
                            {/* Month nav */}
                            <div className="flex items-center justify-between px-3 py-2.5 bg-neutral-50 border-b border-neutral-100">
                              <button type="button" onClick={prevMonth} disabled={!canGoPrev}
                                className="w-7 h-7 rounded-lg flex items-center justify-center text-neutral-500 hover:bg-neutral-200 hover:text-neutral-700 transition-all disabled:opacity-30 disabled:cursor-not-allowed">
                                <i className="fas fa-chevron-left text-[10px]" />
                              </button>
                              <span className="text-xs font-bold text-neutral-800">{monthNames[month]} {year}</span>
                              <button type="button" onClick={nextMonth}
                                className="w-7 h-7 rounded-lg flex items-center justify-center text-neutral-500 hover:bg-neutral-200 hover:text-neutral-700 transition-all">
                                <i className="fas fa-chevron-right text-[10px]" />
                              </button>
                            </div>
                            {/* Day headers */}
                            <div className="grid grid-cols-7 px-2 pt-2">
                              {dayNames.map((d) => (
                                <div key={d} className="text-center text-[10px] font-bold text-neutral-400 py-1">{d}</div>
                              ))}
                            </div>
                            {/* Day cells */}
                            <div className="grid grid-cols-7 px-2 pb-2 gap-y-0.5">
                              {cells.map((day, i) => {
                                if (day === null) return <div key={`e-${i}`} />;
                                const cellDate = new Date(year, month, day); cellDate.setHours(0, 0, 0, 0);
                                const dateStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
                                const isPast = cellDate < todayDate;
                                const isSelected = date === dateStr;
                                const isToday = cellDate.getTime() === todayDate.getTime();

                                return (
                                  <button
                                    key={dateStr}
                                    type="button"
                                    disabled={isPast}
                                    onClick={() => setDate(dateStr)}
                                    className={`w-full aspect-square rounded-lg flex items-center justify-center text-xs font-semibold transition-all
                                      ${isPast ? "text-neutral-300 cursor-not-allowed" : ""}
                                      ${isSelected ? "bg-neutral-900 text-white shadow-md shadow-neutral-900/20" : ""}
                                      ${isToday && !isSelected ? "bg-amber-100 text-amber-700 font-bold" : ""}
                                      ${!isPast && !isSelected && !isToday ? "text-neutral-700 hover:bg-neutral-100" : ""}
                                    `}
                                  >
                                    {day}
                                  </button>
                                );
                              })}
                            </div>
                            {/* Footer */}
                            <div className="flex items-center justify-between px-3 py-2 border-t border-neutral-100 bg-neutral-50/50">
                              <button type="button" onClick={() => { setDate(""); }} className="text-[10px] font-semibold text-neutral-400 hover:text-neutral-600 transition-colors">Clear</button>
                              <button type="button" onClick={() => { goToday(); setDate(today); }} className="text-[10px] font-semibold text-amber-600 hover:text-amber-700 transition-colors">Today</button>
                            </div>
                          </div>
                        );
                      })()}
                      {date && (
                        <div className="mt-2 flex items-center gap-2 px-1">
                          <i className="fas fa-calendar-check text-[10px] text-emerald-500" />
                          <span className="text-xs font-semibold text-neutral-700">{date}</span>
                        </div>
                      )}
                    </div>
                    {/* Time picker */}
                    <div>
                      <label className="block text-[11px] font-bold text-neutral-400 uppercase tracking-wider mb-2">Time <span className="text-red-400">*</span></label>
                      <div className="border-2 border-neutral-200 rounded-xl overflow-hidden bg-white">
                        <div className="px-3 py-2.5 bg-neutral-50 border-b border-neutral-100">
                          <span className="text-xs font-bold text-neutral-800">Available Times</span>
                        </div>
                        <div className="grid grid-cols-3 gap-1.5 p-2.5 max-h-[280px] overflow-y-auto">
                          {timeSlots.length === 0 ? (
                            <p className="col-span-3 text-center text-[11px] text-neutral-400 py-6">No times available</p>
                          ) : (
                            timeSlots.map((t) => (
                              <button
                                key={t}
                                type="button"
                                onClick={() => setTime(t)}
                                className={`px-2 py-2 rounded-lg text-xs font-semibold transition-all text-center
                                  ${time === t ? "bg-neutral-900 text-white shadow-md shadow-neutral-900/20" : "bg-neutral-50 text-neutral-600 hover:bg-neutral-100 hover:text-neutral-800"}
                                `}
                              >
                                {t}
                              </button>
                            ))
                          )}
                        </div>
                      </div>
                      {time && (
                        <div className="mt-2 flex items-center gap-2 px-1">
                          <i className="fas fa-clock text-[10px] text-emerald-500" />
                          <span className="text-xs font-semibold text-neutral-700">{time}</span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {/* Personal Info */}
                <div className="bg-white rounded-2xl border border-neutral-200/80 p-5 sm:p-6 shadow-sm hover:shadow-md transition-shadow">
                  <h4 className="font-bold text-neutral-900 mb-4 flex items-center gap-2.5 text-sm">
                    <div className="w-9 h-9 rounded-xl bg-neutral-900 flex items-center justify-center shadow-md shadow-neutral-900/10">
                      <i className="fas fa-user text-white text-xs" />
                    </div>
                    Your information
                  </h4>
                  <div className="space-y-4">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-[11px] font-bold text-neutral-400 uppercase tracking-wider mb-2">Full Name <span className="text-red-400">*</span></label>
                        <input type="text" value={customerName} onChange={(e) => setCustomerName(e.target.value)} required placeholder="John Smith"
                          className="w-full border-2 border-neutral-200 hover:border-neutral-300 rounded-xl px-4 py-3 text-sm focus:ring-0 focus:border-neutral-900 transition-all outline-none bg-neutral-50/50 placeholder:text-neutral-300 font-medium" />
                      </div>
                      <div>
                        <label className="block text-[11px] font-bold text-neutral-400 uppercase tracking-wider mb-2">Phone <span className="text-red-400">*</span></label>
                        <input type="tel" value={customerPhone} onChange={(e) => setCustomerPhone(e.target.value)} required placeholder="0412 345 678"
                          className="w-full border-2 border-neutral-200 hover:border-neutral-300 rounded-xl px-4 py-3 text-sm focus:ring-0 focus:border-neutral-900 transition-all outline-none bg-neutral-50/50 placeholder:text-neutral-300 font-medium" />
                      </div>
                    </div>
                    <div>
                      <label className="block text-[11px] font-bold text-neutral-400 uppercase tracking-wider mb-2">Email <span className="text-neutral-300 text-[10px] font-normal lowercase">(optional)</span></label>
                      <input type="email" value={customerEmail} onChange={(e) => setCustomerEmail(e.target.value)} placeholder="john@example.com"
                        className="w-full border-2 border-neutral-200 hover:border-neutral-300 rounded-xl px-4 py-3 text-sm focus:ring-0 focus:border-neutral-900 transition-all outline-none bg-neutral-50/50 placeholder:text-neutral-300 font-medium" />
                    </div>
                    <div>
                      <label className="block text-[11px] font-bold text-neutral-400 uppercase tracking-wider mb-2">Notes <span className="text-neutral-300 text-[10px] font-normal lowercase">(optional)</span></label>
                      <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} placeholder="Vehicle details, special requests..."
                        className="w-full border-2 border-neutral-200 hover:border-neutral-300 rounded-xl px-4 py-3 text-sm focus:ring-0 focus:border-neutral-900 transition-all outline-none bg-neutral-50/50 placeholder:text-neutral-300 resize-none font-medium" />
                    </div>
                  </div>
                </div>
              </div>

              {/* Right column - summary card */}
              <div className="lg:col-span-2">
                <div className="sticky top-[140px] bg-white rounded-2xl border border-neutral-200/80 overflow-hidden shadow-sm hover:shadow-lg transition-shadow">
                  {/* Card header */}
                  <div className="bg-neutral-900 p-5 relative overflow-hidden">
                    <div className="absolute inset-0 overflow-hidden">
                      <div className="absolute top-0 right-0 w-24 h-24 bg-amber-500/[0.08] rounded-full blur-xl" />
                    </div>
                    <div className="relative z-10">
                      <div className="flex items-center gap-2 mb-1">
                        <i className="fas fa-receipt text-amber-400 text-xs" />
                        <h4 className="font-bold text-white text-sm">Order Summary</h4>
                      </div>
                      <p className="text-neutral-500 text-[11px]">{selectedServiceDetails.length} service{selectedServiceDetails.length > 1 ? "s" : ""} selected</p>
                    </div>
                  </div>

                  <div className="p-5">
                    {/* Branch & schedule */}
                    <div className="space-y-2.5 mb-4">
                      <div className="flex items-center gap-2.5 text-sm">
                        <div className="w-7 h-7 rounded-lg bg-amber-50 flex items-center justify-center flex-shrink-0">
                          <i className="fas fa-location-dot text-amber-500 text-[10px]" />
                        </div>
                        <span className="font-medium text-neutral-700 text-xs">{selectedBranch?.name}</span>
                      </div>
                      {date && (
                        <div className="flex items-center gap-2.5 text-sm">
                          <div className="w-7 h-7 rounded-lg bg-neutral-100 flex items-center justify-center flex-shrink-0">
                            <i className="fas fa-calendar text-neutral-500 text-[10px]" />
                          </div>
                          <span className="text-neutral-600 text-xs">
                            {new Date(date + "T12:00:00").toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short", year: "numeric" })}
                          </span>
                        </div>
                      )}
                      {time && (
                        <div className="flex items-center gap-2.5 text-sm">
                          <div className="w-7 h-7 rounded-lg bg-neutral-100 flex items-center justify-center flex-shrink-0">
                            <i className="far fa-clock text-neutral-500 text-[10px]" />
                          </div>
                          <span className="text-neutral-600 text-xs">{time}</span>
                        </div>
                      )}
                    </div>

                    {/* Service list */}
                    <div className="border-t border-neutral-100 pt-4 space-y-2.5">
                      {selectedServiceDetails.map((s) => (
                        <div key={s.id} className="flex items-center justify-between">
                          <div className="flex items-center gap-2 min-w-0">
                            <div className="w-2 h-2 rounded-full bg-amber-400 flex-shrink-0" />
                            <span className="text-sm text-neutral-700 truncate">{s.name}</span>
                          </div>
                          <span className="font-bold text-neutral-900 text-sm ml-2 flex-shrink-0">${s.price}</span>
                        </div>
                      ))}
                    </div>

                    {/* Total */}
                    <div className="border-t-2 border-neutral-900/10 pt-4 mt-4">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-xs text-neutral-400 font-medium">Total</p>
                          <p className="text-2xl font-extrabold text-neutral-900 tracking-tight">${totalPrice}</p>
                        </div>
                        <span className="text-xs text-neutral-400 bg-neutral-100 px-2.5 py-1.5 rounded-lg font-semibold">{totalDuration} min</span>
                      </div>
                    </div>

                    {/* Confirm button */}
                    <button
                      onClick={handleSubmit}
                      disabled={submitting || !customerName || !customerPhone || !date || !time}
                      className={`w-full mt-5 font-bold py-3.5 rounded-xl transition-all text-sm relative overflow-hidden group ${
                        submitting || !customerName || !customerPhone || !date || !time
                          ? "bg-neutral-200 text-neutral-400 cursor-not-allowed"
                          : "bg-neutral-900 text-white hover:bg-neutral-800 active:scale-[0.98] shadow-xl shadow-neutral-900/15"
                      }`}
                    >
                      {!(submitting || !customerName || !customerPhone || !date || !time) && (
                        <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/[0.06] to-transparent group-hover:animate-[shimmerBg_1.5s_linear_infinite]" style={{ backgroundSize: "200% 100%" }} />
                      )}
                      <span className="relative z-10 flex items-center justify-center gap-2">
                        {submitting ? (
                          <>
                            <svg className="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                            </svg>
                            Submitting...
                          </>
                        ) : (
                          <>
                            <i className="fas fa-paper-plane text-xs" />
                            Confirm Booking
                          </>
                        )}
                      </span>
                    </button>

                    <p className="text-[10px] text-neutral-400 text-center mt-3">
                      By confirming, you agree to the workshop&apos;s booking terms
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── STEP 4: Confirmation ── */}
        {step === 4 && bookingResult && (
          <div className="max-w-lg mx-auto text-center py-6 sm:py-10">
            {/* Confetti-like particles */}
            {showConfetti && (
              <div className="fixed inset-0 pointer-events-none z-50 overflow-hidden">
                {Array.from({ length: 30 }).map((_, i) => (
                  <div
                    key={i}
                    className="absolute w-2 h-2 rounded-full animate-[confetti_3s_ease-out_forwards]"
                    style={{
                      left: `${Math.random() * 100}%`,
                      top: "-10px",
                      backgroundColor: ["#f59e0b", "#10b981", "#3b82f6", "#8b5cf6", "#ef4444", "#06b6d4"][i % 6],
                      animationDelay: `${Math.random() * 1}s`,
                      animationDuration: `${2 + Math.random() * 2}s`,
                    }}
                  />
                ))}
              </div>
            )}

            {/* Success animation */}
            <div className="relative w-28 h-28 mx-auto mb-8 animate-[fadeSlideUp_0.6s_ease-out]">
              <div className="absolute inset-0 rounded-full bg-emerald-200/50 animate-ping" style={{ animationDuration: "2s" }} />
              <div className="absolute inset-2 rounded-full bg-emerald-100/50 animate-ping" style={{ animationDuration: "2.5s", animationDelay: "0.3s" }} />
              <div className="relative w-28 h-28 rounded-full bg-gradient-to-br from-emerald-400 to-emerald-600 flex items-center justify-center shadow-2xl shadow-emerald-500/30">
                <i className="fas fa-check text-4xl text-white animate-[popIn_0.5s_ease-out_0.3s_both]" />
              </div>
            </div>

            <div className="animate-[fadeSlideUp_0.6s_ease-out_0.2s_both]">
              <h2 className="text-2xl sm:text-3xl font-black text-neutral-900 tracking-tight">
                You&apos;re all set!
              </h2>
              <p className="text-neutral-500 text-sm mt-2 max-w-sm mx-auto">
                Your booking has been submitted. The workshop will confirm shortly.
              </p>
            </div>

            {/* Booking details card */}
            <div className="mt-8 animate-[fadeSlideUp_0.6s_ease-out_0.4s_both]">
              <div className="bg-white rounded-2xl border border-neutral-200/80 overflow-hidden text-left shadow-xl shadow-neutral-900/[0.05]">
                {/* Ticket-style header */}
                <div className="bg-neutral-900 p-6 relative overflow-hidden">
                  <div className="absolute inset-0 overflow-hidden">
                    <svg className="absolute inset-0 w-full h-full opacity-[0.05]" xmlns="http://www.w3.org/2000/svg">
                      <defs>
                        <pattern id="ticketGrid" width="20" height="20" patternUnits="userSpaceOnUse">
                          <circle cx="10" cy="10" r="1" fill="white" />
                        </pattern>
                      </defs>
                      <rect width="100%" height="100%" fill="url(#ticketGrid)" />
                    </svg>
                  </div>
                  <div className="relative z-10">
                    <p className="text-neutral-500 text-[10px] font-bold uppercase tracking-[0.2em]">Booking Reference</p>
                    <p className="text-3xl font-black tracking-[0.2em] text-white mt-1">{bookingResult.bookingCode}</p>
                  </div>
                </div>

                {/* Ticket tear line */}
                <div className="relative">
                  <div className="absolute -left-3 top-1/2 -translate-y-1/2 w-6 h-6 rounded-full bg-[#fafafa]" />
                  <div className="absolute -right-3 top-1/2 -translate-y-1/2 w-6 h-6 rounded-full bg-[#fafafa]" />
                  <div className="border-t-2 border-dashed border-neutral-200 mx-6" />
                </div>

                <div className="p-6 space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <p className="text-[10px] font-bold text-neutral-400 uppercase tracking-wider">Branch</p>
                      <p className="text-sm font-semibold text-neutral-900 mt-1">{selectedBranch?.name}</p>
                    </div>
                    <div>
                      <p className="text-[10px] font-bold text-neutral-400 uppercase tracking-wider">Date</p>
                      <p className="text-sm font-semibold text-neutral-900 mt-1">
                        {date && new Date(date + "T12:00:00").toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" })}
                      </p>
                    </div>
                    <div>
                      <p className="text-[10px] font-bold text-neutral-400 uppercase tracking-wider">Time</p>
                      <p className="text-sm font-semibold text-neutral-900 mt-1">{time}</p>
                    </div>
                    <div>
                      <p className="text-[10px] font-bold text-neutral-400 uppercase tracking-wider">Duration</p>
                      <p className="text-sm font-semibold text-neutral-900 mt-1">{bookingResult.totalDuration} min</p>
                    </div>
                  </div>

                  <div className="border-t border-neutral-100 pt-4 space-y-2">
                    {selectedServiceDetails.map((s) => (
                      <div key={s.id} className="flex items-center justify-between text-sm">
                        <span className="text-neutral-600 flex items-center gap-2">
                          <div className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                          {s.name}
                        </span>
                        <span className="font-semibold text-neutral-900">${s.price}</span>
                      </div>
                    ))}
                  </div>

                  <div className="border-t-2 border-neutral-200 pt-4 flex items-center justify-between">
                    <span className="font-bold text-neutral-500 text-sm uppercase tracking-wider">Total</span>
                    <span className="font-black text-neutral-900 text-2xl">${bookingResult.totalPrice}</span>
                  </div>
                </div>
              </div>
            </div>

            <div className="mt-8 animate-[fadeSlideUp_0.6s_ease-out_0.6s_both]">
              <button
                onClick={() => {
                  setStep(1); setSelectedBranch(null); setSelectedServices([]); setDate(""); setTime(""); setNotes(""); setBookingResult(null); setShowConfetti(false);
                }}
                className="group bg-neutral-900 text-white font-bold px-8 py-3.5 rounded-xl hover:bg-neutral-800 transition-all text-sm active:scale-[0.97] shadow-xl shadow-neutral-900/15 inline-flex items-center gap-2"
              >
                <i className="fas fa-plus text-xs" />
                Book Another Service
                <i className="fas fa-arrow-right text-xs group-hover:translate-x-1 transition-transform" />
              </button>
            </div>
          </div>
        )}
      </main>
      )}

      {/* ═══════════════════ MY BOOKINGS VIEW ═══════════════════ */}
      {activeView === "myBookings" && customer && (
        <main className="flex-1 max-w-4xl mx-auto px-4 sm:px-6 py-8 sm:py-10 w-full relative z-10">
          <div className="animate-[fadeSlideUp_0.4s_ease-out]">
            {/* Header */}
            <div className="flex items-start sm:items-center justify-between mb-6 gap-3 flex-col sm:flex-row">
              <div>
                <h3 className="text-xl sm:text-2xl font-bold text-neutral-900 tracking-tight">My Bookings</h3>
                <p className="text-neutral-500 text-sm mt-1">View and track all your bookings</p>
              </div>
              <button
                onClick={() => setActiveView("booking")}
                className="flex items-center gap-2 bg-neutral-900 hover:bg-neutral-800 text-white text-xs font-bold px-4 py-2.5 rounded-xl transition-all shadow-lg shadow-neutral-900/10 active:scale-[0.97]"
              >
                <i className="fas fa-plus text-[9px]" />
                New Booking
              </button>
            </div>

            {/* Status filter tabs */}
            <div className="flex items-center gap-1.5 mb-6 overflow-x-auto pb-1 scrollbar-hide">
              {[
                { key: "All", icon: "fa-border-all", count: customerBookings.length },
                { key: "Pending", icon: "fa-clock", count: customerBookings.filter((b) => b.status === "Pending" || b.status === "AwaitingStaffApproval" || b.status === "PartiallyApproved").length },
                { key: "Confirmed", icon: "fa-circle-check", count: customerBookings.filter((b) => b.status === "Confirmed").length },
                { key: "Completed", icon: "fa-flag-checkered", count: customerBookings.filter((b) => b.status === "Completed").length },
                { key: "Cancelled", icon: "fa-ban", count: customerBookings.filter((b) => b.status === "Canceled").length },
              ].map((tab) => (
                <button
                  key={tab.key}
                  onClick={() => setBookingsFilter(tab.key)}
                  className={`flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-[11px] font-bold transition-all whitespace-nowrap ${
                    bookingsFilter === tab.key
                      ? "bg-neutral-900 text-white shadow-md shadow-neutral-900/15"
                      : "bg-white text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700 border border-neutral-200/80"
                  }`}
                >
                  <i className={`fas ${tab.icon} text-[9px]`} />
                  {tab.key}
                  {tab.count > 0 && (
                    <span className={`min-w-[18px] h-[18px] flex items-center justify-center text-[9px] font-bold rounded-full px-1 ${
                      bookingsFilter === tab.key ? "bg-white/20 text-white" : "bg-neutral-100 text-neutral-500"
                    }`}>
                      {tab.count}
                    </span>
                  )}
                </button>
              ))}
            </div>

            {/* Booking cards */}
            {(() => {
              const filtered = customerBookings.filter((bk) => {
                if (bookingsFilter === "All") return true;
                if (bookingsFilter === "Pending") return bk.status === "Pending" || bk.status === "AwaitingStaffApproval" || bk.status === "PartiallyApproved";
                if (bookingsFilter === "Confirmed") return bk.status === "Confirmed";
                if (bookingsFilter === "Completed") return bk.status === "Completed";
                if (bookingsFilter === "Cancelled") return bk.status === "Canceled";
                return true;
              });

              if (notifLoading) {
                return (
                  <div className="flex flex-col items-center justify-center py-20 gap-3">
                    <div className="w-10 h-10 rounded-full border-[3px] border-neutral-200 border-t-amber-500 animate-spin" />
                    <p className="text-xs text-neutral-400 font-medium">Loading bookings...</p>
                  </div>
                );
              }

              if (filtered.length === 0) {
                return (
                  <div className="text-center py-20 bg-white rounded-2xl border border-neutral-200/80 shadow-sm">
                    <div className="w-16 h-16 bg-neutral-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
                      <i className="fas fa-calendar-xmark text-2xl text-neutral-300" />
                    </div>
                    <p className="text-neutral-600 font-bold text-base">No bookings found</p>
                    <p className="text-neutral-400 text-sm mt-1.5 max-w-xs mx-auto">
                      {bookingsFilter === "All"
                        ? "You haven't made any bookings yet. Book a service to get started!"
                        : `No ${bookingsFilter.toLowerCase()} bookings.`}
                    </p>
                    {bookingsFilter === "All" && (
                      <button
                        onClick={() => setActiveView("booking")}
                        className="mt-5 inline-flex items-center gap-2 bg-neutral-900 hover:bg-neutral-800 text-white text-xs font-bold px-5 py-2.5 rounded-xl transition-all shadow-lg shadow-neutral-900/10"
                      >
                        <i className="fas fa-plus text-[9px]" />
                        Book a Service
                      </button>
                    )}
                  </div>
                );
              }

              const statusConfig: Record<string, { bg: string; text: string; icon: string; label: string; dot: string }> = {
                Pending: { bg: "bg-amber-50", text: "text-amber-700", icon: "fa-clock", label: "Pending", dot: "bg-amber-400" },
                Confirmed: { bg: "bg-emerald-50", text: "text-emerald-700", icon: "fa-circle-check", label: "Confirmed", dot: "bg-emerald-400" },
                AwaitingStaffApproval: { bg: "bg-amber-50", text: "text-amber-700", icon: "fa-clock", label: "Pending", dot: "bg-amber-400" },
                PartiallyApproved: { bg: "bg-amber-50", text: "text-amber-700", icon: "fa-clock", label: "Pending", dot: "bg-amber-400" },
                StaffRejected: { bg: "bg-amber-50", text: "text-amber-700", icon: "fa-clock", label: "Pending", dot: "bg-amber-400" },
                Completed: { bg: "bg-blue-50", text: "text-blue-700", icon: "fa-flag-checkered", label: "Completed", dot: "bg-blue-400" },
                Canceled: { bg: "bg-rose-50", text: "text-rose-700", icon: "fa-ban", label: "Cancelled", dot: "bg-rose-400" },
              };

              return (
                <div className="space-y-3">
                  {filtered.map((bk, idx) => {
                    const cfg = statusConfig[bk.status] || statusConfig.Pending;
                    const createdDate = (() => {
                      if (!bk.createdAt) return "";
                      const d = new Date(bk.createdAt);
                      return d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
                    })();

                    return (
                      <div
                        key={bk.id}
                        className="bg-white rounded-2xl border border-neutral-200/80 shadow-sm hover:shadow-lg hover:shadow-neutral-900/[0.04] transition-all overflow-hidden"
                        style={{ animation: `fadeSlideUp 0.4s ease-out ${idx * 60}ms both` }}
                      >
                        {/* Status accent */}
                        <div className={`h-[3px] ${cfg.dot}`} />

                        <div className="p-4 sm:p-5">
                          {/* Top row: service name + status badge */}
                          <div className="flex items-start justify-between gap-3 mb-3">
                            <div className="min-w-0 flex-1">
                              <h4 className="text-sm font-bold text-neutral-900 leading-snug truncate">{bk.serviceName}</h4>
                              <p className="text-[11px] text-neutral-400 font-medium mt-0.5">Booked {createdDate}</p>
                            </div>
                            <span className={`shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[10px] font-bold ${cfg.bg} ${cfg.text}`}>
                              <i className={`fas ${cfg.icon} text-[8px]`} />
                              {cfg.label}
                            </span>
                          </div>

                          {/* Details grid */}
                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                            <div className="bg-neutral-50 rounded-xl px-3 py-2.5">
                              <p className="text-[9px] font-bold text-neutral-400 uppercase tracking-wider mb-0.5">Booking Code</p>
                              <p className="text-[11px] font-bold text-neutral-800 font-mono">{bk.bookingCode}</p>
                            </div>
                            <div className="bg-neutral-50 rounded-xl px-3 py-2.5">
                              <p className="text-[9px] font-bold text-neutral-400 uppercase tracking-wider mb-0.5">Date</p>
                              <p className="text-[11px] font-bold text-neutral-800">{bk.date}</p>
                            </div>
                            <div className="bg-neutral-50 rounded-xl px-3 py-2.5">
                              <p className="text-[9px] font-bold text-neutral-400 uppercase tracking-wider mb-0.5">Time</p>
                              <p className="text-[11px] font-bold text-neutral-800">{bk.time}</p>
                            </div>
                            <div className="bg-neutral-50 rounded-xl px-3 py-2.5">
                              <p className="text-[9px] font-bold text-neutral-400 uppercase tracking-wider mb-0.5">Amount</p>
                              <p className="text-[11px] font-bold text-neutral-800">${bk.price}</p>
                            </div>
                          </div>

                          {/* Branch */}
                          {bk.branchName && (
                            <div className="flex items-center gap-2 mt-3 text-[11px] text-neutral-500">
                              <i className="fas fa-location-dot text-[9px] text-neutral-400" />
                              <span className="font-medium">{bk.branchName}</span>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })()}
          </div>
        </main>
      )}

      {/* ═══════════════════ SIGN OUT CONFIRM ═══════════════════ */}
      {showLogoutConfirm && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4 animate-[fadeIn_0.15s_ease-out]">
          <div className="w-full max-w-[340px] bg-white rounded-2xl shadow-2xl shadow-neutral-900/20 border border-neutral-200/50 animate-[modalPop_0.3s_ease-out] overflow-hidden">
            {/* Top accent */}
            <div className="h-1 bg-gradient-to-r from-amber-400 via-amber-500 to-orange-500" />
            <div className="p-6 text-center">
              <div className="w-12 h-12 rounded-xl bg-rose-100 flex items-center justify-center mx-auto mb-4">
                <i className="fas fa-arrow-right-from-bracket text-rose-500 text-lg" />
              </div>
              <h3 className="text-base font-extrabold text-neutral-900 mb-1">Sign out?</h3>
              <p className="text-xs text-neutral-500 leading-relaxed">
                You will need to sign in again to manage your bookings.
              </p>
            </div>
            <div className="flex border-t border-neutral-100">
              <button
                onClick={() => setShowLogoutConfirm(false)}
                className="flex-1 px-4 py-3.5 text-xs font-bold text-neutral-600 hover:bg-neutral-50 transition-colors"
              >
                Cancel
              </button>
              <div className="w-px bg-neutral-100" />
              <button
                onClick={handleLogout}
                className="flex-1 px-4 py-3.5 text-xs font-bold text-rose-600 hover:bg-rose-50 transition-colors"
              >
                Sign Out
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ═══════════════════ AUTH MODAL ═══════════════════ */}
      {showAuth && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-md z-50 flex items-center justify-center p-4 animate-[fadeIn_0.15s_ease-out]">
          <div className="w-full max-w-[420px] animate-[modalPop_0.35s_ease-out]">
            {/* Glass card */}
            <div className="bg-white rounded-3xl overflow-hidden shadow-2xl shadow-neutral-900/20 border border-neutral-200/50">
              {/* Header */}
              <div className="relative p-6 pb-5">
                <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-amber-400 via-amber-500 to-orange-500" />
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-lg font-bold text-neutral-900">
                      {authMode === "login" ? "Welcome back" : "Create account"}
                    </h3>
                    <p className="text-xs text-neutral-400 mt-0.5">
                      {authMode === "login" ? `Sign in to book at ${workshop.name}` : `Register for ${workshop.name}`}
                    </p>
                  </div>
                  <button onClick={() => { setShowAuth(false); setAuthError(""); }} className="w-9 h-9 rounded-xl bg-neutral-100 hover:bg-neutral-200 flex items-center justify-center transition group">
                    <i className="fas fa-times text-neutral-400 group-hover:text-neutral-600 text-sm transition-colors" />
                  </button>
                </div>
              </div>

              <form onSubmit={handleAuth} className="px-6 pb-6 space-y-3.5">
                {authMode === "register" && (
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[11px] font-semibold text-neutral-500 mb-1.5">Name <span className="text-red-400">*</span></label>
                      <input type="text" value={authName} onChange={(e) => setAuthName(e.target.value)} required placeholder="John"
                        className="w-full border-2 border-neutral-200 hover:border-neutral-300 rounded-xl px-3.5 py-2.5 text-sm focus:ring-0 focus:border-neutral-900 transition-all outline-none bg-neutral-50/50 placeholder:text-neutral-300 font-medium" />
                    </div>
                    <div>
                      <label className="block text-[11px] font-semibold text-neutral-500 mb-1.5">Phone <span className="text-red-400">*</span></label>
                      <input type="tel" value={authPhone} onChange={(e) => setAuthPhone(e.target.value)} required placeholder="0412 345 678"
                        className="w-full border-2 border-neutral-200 hover:border-neutral-300 rounded-xl px-3.5 py-2.5 text-sm focus:ring-0 focus:border-neutral-900 transition-all outline-none bg-neutral-50/50 placeholder:text-neutral-300 font-medium" />
                    </div>
                  </div>
                )}

                <div>
                  <label className="block text-[11px] font-semibold text-neutral-500 mb-1.5">Email <span className="text-red-400">*</span></label>
                  <div className="relative">
                    <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-neutral-300">
                      <i className="fas fa-envelope text-xs" />
                    </div>
                    <input type="email" value={authEmail} onChange={(e) => setAuthEmail(e.target.value)} required placeholder="name@email.com"
                      className="w-full border-2 border-neutral-200 hover:border-neutral-300 rounded-xl pl-10 pr-4 py-2.5 text-sm focus:ring-0 focus:border-neutral-900 transition-all outline-none bg-neutral-50/50 placeholder:text-neutral-300 font-medium" />
                  </div>
                </div>

                <div>
                  <label className="block text-[11px] font-semibold text-neutral-500 mb-1.5">Password <span className="text-red-400">*</span></label>
                  <div className="relative">
                    <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-neutral-300">
                      <i className="fas fa-lock text-xs" />
                    </div>
                    <input type="password" value={authPassword} onChange={(e) => setAuthPassword(e.target.value)} required minLength={6} placeholder="••••••••"
                      className="w-full border-2 border-neutral-200 hover:border-neutral-300 rounded-xl pl-10 pr-4 py-2.5 text-sm focus:ring-0 focus:border-neutral-900 transition-all outline-none bg-neutral-50/50 placeholder:text-neutral-300 font-medium" />
                  </div>
                </div>

                {authError && (
                  <div className="bg-red-50 border border-red-200/50 rounded-xl px-4 py-3 flex items-center gap-2.5 animate-[shakeX_0.4s_ease-out]">
                    <div className="w-7 h-7 rounded-lg bg-red-100 flex items-center justify-center flex-shrink-0">
                      <i className="fas fa-exclamation-triangle text-red-500 text-[10px]" />
                    </div>
                    <p className="text-xs text-red-700 font-medium">{authError}</p>
                  </div>
                )}

                <button type="submit" disabled={authLoading}
                  className="w-full bg-neutral-900 text-white font-bold py-3 rounded-xl hover:bg-neutral-800 transition-all text-sm disabled:opacity-50 active:scale-[0.98] shadow-lg shadow-neutral-900/15 relative overflow-hidden group mt-1">
                  <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/[0.06] to-transparent group-hover:animate-[shimmerBg_1.5s_linear_infinite]" style={{ backgroundSize: "200% 100%" }} />
                  <span className="relative z-10 flex items-center justify-center gap-2">
                    {authLoading ? (
                      <>
                        <svg className="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                        </svg>
                        {authMode === "login" ? "Signing in..." : "Creating account..."}
                      </>
                    ) : (
                      <>
                        <i className={`fas ${authMode === "login" ? "fa-arrow-right" : "fa-user-plus"} text-xs`} />
                        {authMode === "login" ? "Sign In" : "Create Account"}
                      </>
                    )}
                  </span>
                </button>

                <div className="pt-2">
                  <button type="button"
                    onClick={() => { setAuthMode(authMode === "login" ? "register" : "login"); setAuthError(""); }}
                    className="w-full text-center text-xs text-neutral-500 hover:text-neutral-900 font-medium py-2 transition">
                    {authMode === "login" ? (
                      <>Don&apos;t have an account? <span className="text-amber-600 font-semibold">Create one</span></>
                    ) : (
                      <>Already have an account? <span className="text-amber-600 font-semibold">Sign in</span></>
                    )}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}

      {/* ═══════════════════ FOOTER ═══════════════════ */}
      <footer className="relative z-10 bg-white/80 backdrop-blur-sm border-t border-neutral-200/50 mt-auto py-5">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 flex items-center justify-between">
          <p className="text-[11px] text-neutral-400">
            Powered by <span className="font-bold text-neutral-600">BMS PRO</span>
          </p>
          <div className="flex items-center gap-1.5 text-neutral-400 text-[10px]">
            <i className="fas fa-shield-halved" />
            <span className="font-medium">Secure Booking</span>
          </div>
        </div>
      </footer>

      {/* ═══════════════════ GLOBAL STYLES ═══════════════════ */}
      <style jsx global>{`
        @keyframes fadeSlideUp {
          from { opacity: 0; transform: translateY(20px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes popIn {
          0% { opacity: 0; transform: scale(0.3); }
          50% { transform: scale(1.1); }
          100% { opacity: 1; transform: scale(1); }
        }
        @keyframes slideUpBounce {
          0% { opacity: 0; transform: translateY(40px); }
          60% { transform: translateY(-4px); }
          100% { opacity: 1; transform: translateY(0); }
        }
        @keyframes modalPop {
          0% { opacity: 0; transform: scale(0.9) translateY(20px); }
          100% { opacity: 1; transform: scale(1) translateY(0); }
        }
        @keyframes ringPulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.5; transform: scale(1.15); }
        }
        @keyframes shimmer {
          0% { background-position: -200% center; }
          100% { background-position: 200% center; }
        }
        @keyframes shimmerBg {
          0% { background-position: -200% 0; }
          100% { background-position: 200% 0; }
        }
        @keyframes float {
          0%, 100% { transform: translate(0, 0) scale(1); }
          33% { transform: translate(30px, -20px) scale(1.05); }
          66% { transform: translate(-20px, 15px) scale(0.95); }
        }
        @keyframes confetti {
          0% { transform: translateY(0) rotate(0deg) scale(1); opacity: 1; }
          100% { transform: translateY(100vh) rotate(720deg) scale(0); opacity: 0; }
        }
        @keyframes dropdownPop {
          from { opacity: 0; transform: translateY(-8px) scale(0.97); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes slideUpSheet {
          from { transform: translateY(100%); }
          to { transform: translateY(0); }
        }
        @keyframes shakeX {
          0%, 100% { transform: translateX(0); }
          20% { transform: translateX(-6px); }
          40% { transform: translateX(6px); }
          60% { transform: translateX(-4px); }
          80% { transform: translateX(4px); }
        }
      `}</style>
    </div>
  );
}
