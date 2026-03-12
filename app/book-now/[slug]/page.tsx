"use client";

import React, { useEffect, useState, useMemo, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { useParams } from "next/navigation";
import { type ChecklistItem, normalizeChecklist } from "@/lib/services";

type DayHours = { open?: string; close?: string; closed?: boolean };
type BranchHoursMap = {
  Monday?: DayHours; Tuesday?: DayHours; Wednesday?: DayHours; Thursday?: DayHours;
  Friday?: DayHours; Saturday?: DayHours; Sunday?: DayHours;
};
type Branch = {
  id: string;
  name: string;
  address: string;
  phone: string;
  timezone: string;
  hours?: BranchHoursMap | string | null;
  bookingLimitPerDay?: number | null;
};
type Service = { id: string; name: string; price: number; duration: number; imageUrl: string; checklist: ChecklistItem[]; branches: string[] };
type Workshop = { id: string; name: string; slug: string; logoUrl: string };
type CustomerSession = { customerId: string; name: string; email: string; phone: string };
type CustomerVehicle = {
  id: string;
  registrationNumber: string;
  make?: string;
  model?: string;
  year?: string;
  mileage?: string;
  bodyType?: string;
  colour?: string;
  vinChassis?: string;
  engineNumber?: string;
};
type CustomerBookingTask = {
  id: string;
  serviceId?: string;
  serviceName?: string;
  name: string;
  description: string;
  done: boolean;
  imageUrl: string;
  staffNote: string;
  completedAt?: string | null;
  completedByStaffName?: string | null;
};
type CustomerAdditionalIssue = {
  id: string;
  issueTitle: string;
  description: string;
  recommendedRepair: string;
  imageUrl?: string | null;
  image?: string | null;
  price: number | null;
  status: string;
  customerResponse?: "accept" | "reject" | null;
  customerRespondedAt?: string | null;
};
type CustomerBooking = {
  id: string;
  bookingCode: string;
  serviceName: string;
  status: string;
  date: string;
  time: string;
  pickupTime: string | null;
  branchName: string;
  price: number;
  createdAt: string | null;
  updatedAt: string | null;
  tasks?: CustomerBookingTask[] | null;
  taskProgress?: number;
  finalSubmission?: {
    description: string;
    imageUrl: string;
    submittedAt?: string | null;
    submittedByStaffName?: string | null;
  } | null;
  additionalIssues?: CustomerAdditionalIssue[] | null;
};

export default function BookingEnginePage() {
  const params = useParams();
  const slug = params?.slug as string;

  const [workshop, setWorkshop] = useState<Workshop | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [allServices, setAllServices] = useState<Service[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [activeView, setActiveView] = useState<"booking" | "myBookings" | "myVehicles" | "estimate" | "myEstimates">("booking");
  const [bookingsFilter, setBookingsFilter] = useState("All");
  const [customerEstimates, setCustomerEstimates] = useState<any[]>([]);
  const [customerEstimatesLoading, setCustomerEstimatesLoading] = useState(false);
  const [expandedEstimateId, setExpandedEstimateId] = useState<string | null>(null);
  const [estimateReplies, setEstimateReplies] = useState<Record<string, any[]>>({});
  const [estimateRepliesLoading, setEstimateRepliesLoading] = useState<string | null>(null);
  const [estimateLightboxUrl, setEstimateLightboxUrl] = useState<string | null>(null);

  // Estimate form state
  const [estimateName, setEstimateName] = useState("");
  const [estimatePhone, setEstimatePhone] = useState("");
  const [estimateEmail, setEstimateEmail] = useState("");
  const [estimateVehicleMake, setEstimateVehicleMake] = useState("");
  const [estimateVehicleModel, setEstimateVehicleModel] = useState("");
  const [estimateVehicleYear, setEstimateVehicleYear] = useState("");
  const [estimateRego, setEstimateRego] = useState("");
  const [estimateMileage, setEstimateMileage] = useState("");
  const [estimateDescription, setEstimateDescription] = useState("");
  const [estimateBranch, setEstimateBranch] = useState<Branch | null>(null);
  const [estimateSubmitting, setEstimateSubmitting] = useState(false);
  const [estimateSuccess, setEstimateSuccess] = useState(false);
  const [estimateError, setEstimateError] = useState("");
  const [estimateFieldErrors, setEstimateFieldErrors] = useState<Record<string, string>>({});
  const [estimateImages, setEstimateImages] = useState<File[]>([]);
  const [estimateImagePreviews, setEstimateImagePreviews] = useState<string[]>([]);
  const [customerEstimateNotifications, setCustomerEstimateNotifications] = useState<any[]>([]);
  const [customerEstimateUnreadCount, setCustomerEstimateUnreadCount] = useState(0);

  const [step, setStep] = useState(1);
  const [prevStep, setPrevStep] = useState(1);
  const [animDir, setAnimDir] = useState<"forward" | "back">("forward");
  const [selectedBranch, setSelectedBranch] = useState<Branch | null>(null);
  const [selectedServices, setSelectedServices] = useState<string[]>([]);
  const [date, setDate] = useState("");
  const [time, setTime] = useState(""); // drop-off time
  const [pickupTime, setPickupTime] = useState(""); // pick-up time
  const [calendarMonth, setCalendarMonth] = useState(() => { const now = new Date(); return { year: now.getFullYear(), month: now.getMonth() }; });
  const [customerName, setCustomerName] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [vehicleNumber, setVehicleNumber] = useState("");
  const [vehicleMake, setVehicleMake] = useState("");
  const [vehicleModel, setVehicleModel] = useState("");
  const [vehicleYear, setVehicleYear] = useState("");
  const [vehicleMileage, setVehicleMileage] = useState("");
  const [vehicleBodyType, setVehicleBodyType] = useState("");
  const [vehicleColour, setVehicleColour] = useState("");
  const [vehicleVinChassis, setVehicleVinChassis] = useState("");
  const [vehicleEngineNumber, setVehicleEngineNumber] = useState("");
  const [customerVehicles, setCustomerVehicles] = useState<CustomerVehicle[]>([]);
  const [selectedVehicleId, setSelectedVehicleId] = useState<string | "new">("new");
  const [notes, setNotes] = useState("");
  const [vehiclesLoading, setVehiclesLoading] = useState(false);
  const [vehicleFormOpen, setVehicleFormOpen] = useState(false);
  const [editingVehicle, setEditingVehicle] = useState<CustomerVehicle | null>(null);
  const [vehicleFormRego, setVehicleFormRego] = useState("");
  const [vehicleFormMake, setVehicleFormMake] = useState("");
  const [vehicleFormModel, setVehicleFormModel] = useState("");
  const [vehicleFormYear, setVehicleFormYear] = useState("");
  const [vehicleFormMileage, setVehicleFormMileage] = useState("");
  const [vehicleFormBodyType, setVehicleFormBodyType] = useState("");
  const [vehicleFormColour, setVehicleFormColour] = useState("");
  const [vehicleFormVin, setVehicleFormVin] = useState("");
  const [vehicleFormEngine, setVehicleFormEngine] = useState("");
  const [vehicleSaving, setVehicleSaving] = useState(false);
  const [vehicleDeleting, setVehicleDeleting] = useState<string | null>(null);

  const [customer, setCustomer] = useState<CustomerSession | null>(null);
  const [showAuth, setShowAuth] = useState(false);
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authConfirmPassword, setAuthConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [authName, setAuthName] = useState("");
  const [authPhone, setAuthPhone] = useState("");
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState("");

  const [showForgotPassword, setShowForgotPassword] = useState(false);
  const [forgotPasswordStep, setForgotPasswordStep] = useState<"email" | "reset">("email");
  const [forgotPasswordEmail, setForgotPasswordEmail] = useState("");
  const [resetCode, setResetCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newPasswordConfirm, setNewPasswordConfirm] = useState("");
  const [forgotPasswordLoading, setForgotPasswordLoading] = useState(false);
  const [forgotPasswordError, setForgotPasswordError] = useState("");
  const [forgotPasswordSuccess, setForgotPasswordSuccess] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [bookingResult, setBookingResult] = useState<{ bookingCode: string; totalPrice: number; totalDuration: number } | null>(null);

  const [showConfetti, setShowConfetti] = useState(false);
  const [expandedService, setExpandedService] = useState<string | null>(null);

  // Slot availability
  const [blockedSlots, setBlockedSlots] = useState<Set<string>>(new Set());
  const [dailyLimitReached, setDailyLimitReached] = useState(false);
  const [availabilityLoading, setAvailabilityLoading] = useState(false);

  // Notification panel state
  const [showNotifications, setShowNotifications] = useState(false);
  const [customerBookings, setCustomerBookings] = useState<CustomerBooking[]>([]);
  const [notifLoading, setNotifLoading] = useState(false);
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());
  const [readIds, setReadIds] = useState<Set<string>>(new Set());
  const [expandedBookingId, setExpandedBookingId] = useState<string | null>(null);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [downloadingBookingId, setDownloadingBookingId] = useState<string | null>(null);
  const [pdfConfirmBooking, setPdfConfirmBooking] = useState<CustomerBooking | null>(null);
  const [additionalIssueResponding, setAdditionalIssueResponding] = useState<Record<string, boolean>>({});

  const getSelectedVehicleStorageKey = useCallback(() => {
    if (!customer?.customerId || !slug) return null;
    return `bms_selected_vehicle_${slug}_${customer.customerId}`;
  }, [customer?.customerId, slug]);

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

  // Auto-fill estimate contact from logged-in customer
  useEffect(() => {
    if (customer) {
      setEstimateName(customer.name || "");
      setEstimateEmail(customer.email || "");
      setEstimatePhone(customer.phone || "");
    }
  }, [customer?.customerId]);

  const fetchCustomerVehicles = useCallback(async () => {
    if (!customer?.customerId || !slug) return;
    setVehiclesLoading(true);
    try {
      const res = await fetch(`/api/book-now/customer-vehicles?customerId=${encodeURIComponent(customer.customerId)}&slug=${encodeURIComponent(slug)}`);
      if (res.ok) {
        const data = await res.json();
        const vehicles = (data.vehicles || []) as CustomerVehicle[];
        setCustomerVehicles(vehicles);
        if (vehicles.length > 0) {
          const storageKey = getSelectedVehicleStorageKey();
          let preferredId: string | "new" = vehicles[0].id;
          if (storageKey) {
            const savedId = localStorage.getItem(storageKey);
            if (savedId && vehicles.some((v) => v.id === savedId)) preferredId = savedId;
          }
          setSelectedVehicleId(preferredId);
          const selectedVehicle = vehicles.find((v) => v.id === preferredId) || vehicles[0];
          setVehicleNumber(selectedVehicle.registrationNumber || "");
          setVehicleMake(selectedVehicle.make || ""); setVehicleModel(selectedVehicle.model || ""); setVehicleYear(selectedVehicle.year || ""); setVehicleMileage(selectedVehicle.mileage || "");
          setVehicleBodyType(selectedVehicle.bodyType || ""); setVehicleColour(selectedVehicle.colour || "");
          setVehicleVinChassis(selectedVehicle.vinChassis || ""); setVehicleEngineNumber(selectedVehicle.engineNumber || "");
        } else {
          setSelectedVehicleId("new");
          setVehicleNumber(""); setVehicleMake(""); setVehicleModel(""); setVehicleYear(""); setVehicleMileage("");
          setVehicleBodyType(""); setVehicleColour(""); setVehicleVinChassis(""); setVehicleEngineNumber("");
        }
      } else {
        setCustomerVehicles([]);
      }
    } catch {
      setCustomerVehicles([]);
    } finally {
      setVehiclesLoading(false);
    }
  }, [customer?.customerId, slug, getSelectedVehicleStorageKey]);

  const openAddVehicle = () => {
    setEditingVehicle(null);
    setVehicleFormRego(""); setVehicleFormMake(""); setVehicleFormModel(""); setVehicleFormYear(""); setVehicleFormMileage("");
    setVehicleFormBodyType(""); setVehicleFormColour(""); setVehicleFormVin(""); setVehicleFormEngine("");
    setVehicleFormOpen(true);
  };
  const openEditVehicle = (v: CustomerVehicle) => {
    setEditingVehicle(v);
    setVehicleFormRego(v.registrationNumber || "");
    setVehicleFormMake(v.make || ""); setVehicleFormModel(v.model || ""); setVehicleFormYear(v.year || ""); setVehicleFormMileage(v.mileage || "");
    setVehicleFormBodyType(v.bodyType || ""); setVehicleFormColour(v.colour || "");
    setVehicleFormVin(v.vinChassis || ""); setVehicleFormEngine(v.engineNumber || "");
    setVehicleFormOpen(true);
  };
  const closeVehicleForm = () => {
    setVehicleFormOpen(false);
    setEditingVehicle(null);
    setVehicleSaving(false);
  };
  const handleSaveVehicle = async () => {
    if (!customer?.customerId || !slug) return;
    if (!vehicleFormRego?.trim() && !vehicleFormMake?.trim() && !vehicleFormModel?.trim()) {
      alert("Please add at least one identifier: Registration number, Make, or Model.");
      return;
    }
    setVehicleSaving(true);
    try {
      if (editingVehicle) {
        const res = await fetch(`/api/book-now/customer-vehicles/${editingVehicle.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            customerId: customer.customerId,
            slug,
            registrationNumber: vehicleFormRego?.trim() || undefined,
            make: vehicleFormMake?.trim() || undefined,
            model: vehicleFormModel?.trim() || undefined,
            year: vehicleFormYear?.trim() || undefined,
            mileage: vehicleFormMileage?.trim() || undefined,
            bodyType: vehicleFormBodyType?.trim() || undefined,
            colour: vehicleFormColour?.trim() || undefined,
            vinChassis: vehicleFormVin?.trim() || undefined,
            engineNumber: vehicleFormEngine?.trim() || undefined,
          }),
        });
        if (!res.ok) throw new Error((await res.json()).error || "Failed to update");
      } else {
        const res = await fetch("/api/book-now/customer-vehicles", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            customerId: customer.customerId,
            slug,
            registrationNumber: vehicleFormRego?.trim() || undefined,
            make: vehicleFormMake?.trim() || undefined,
            model: vehicleFormModel?.trim() || undefined,
            year: vehicleFormYear?.trim() || undefined,
            mileage: vehicleFormMileage?.trim() || undefined,
            bodyType: vehicleFormBodyType?.trim() || undefined,
            colour: vehicleFormColour?.trim() || undefined,
            vinChassis: vehicleFormVin?.trim() || undefined,
            engineNumber: vehicleFormEngine?.trim() || undefined,
          }),
        });
        if (!res.ok) throw new Error((await res.json()).error || "Failed to add");
      }
      // If we edited the currently selected vehicle, sync form fields immediately so mileage etc. show correctly
      if (editingVehicle && editingVehicle.id === selectedVehicleId) {
        setVehicleNumber(vehicleFormRego?.trim() || "");
        setVehicleMake(vehicleFormMake?.trim() || "");
        setVehicleModel(vehicleFormModel?.trim() || "");
        setVehicleYear(vehicleFormYear?.trim() || "");
        setVehicleMileage(vehicleFormMileage?.trim() || "");
        setVehicleBodyType(vehicleFormBodyType?.trim() || "");
        setVehicleColour(vehicleFormColour?.trim() || "");
        setVehicleVinChassis(vehicleFormVin?.trim() || "");
        setVehicleEngineNumber(vehicleFormEngine?.trim() || "");
      }
      closeVehicleForm();
      await fetchCustomerVehicles();
    } catch (e: any) {
      alert(e?.message || "Failed to save vehicle");
    } finally {
      setVehicleSaving(false);
    }
  };
  const handleDeleteVehicle = async (vehicleId: string) => {
    if (!customer?.customerId || !slug || !confirm("Delete this vehicle?")) return;
    setVehicleDeleting(vehicleId);
    try {
      const res = await fetch(`/api/book-now/customer-vehicles/${vehicleId}?customerId=${encodeURIComponent(customer.customerId)}&slug=${encodeURIComponent(slug)}`, { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json()).error || "Failed to delete");
      await fetchCustomerVehicles();
    } catch (e: any) {
      alert(e?.message || "Failed to delete vehicle");
    } finally {
      setVehicleDeleting(null);
    }
  };

  useEffect(() => {
    fetchCustomerVehicles();
  }, [fetchCustomerVehicles]);

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

  const visibleBookings = customerBookings.filter((b) => !dismissedIds.has(b.id));
  const bookingUnreadCount = visibleBookings.filter((b) => !readIds.has(b.id)).length;
  const customerNotifUnreadCount = customerEstimateNotifications.filter((n) => !n.read).length;
  const unreadCount = bookingUnreadCount + customerNotifUnreadCount;

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

  const downloadBookingPdf = async (booking: CustomerBooking) => {
    if (!customer?.customerId) {
      setShowAuth(true);
      return;
    }
    if (booking.status !== "Completed") {
      alert("Job report is only available for completed bookings.");
      return;
    }

    try {
      setDownloadingBookingId(booking.id);
      const res = await fetch(
        `/api/book-now/customer-bookings/${booking.id}/pdf?customerId=${encodeURIComponent(customer.customerId)}`
      );
      if (!res.ok) {
        let message = "Failed to download PDF";
        try {
          const data = await res.json();
          message = data?.error || message;
        } catch {
          // Keep default error message when response is not JSON.
        }
        throw new Error(message);
      }

      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      const safeCode = (booking.bookingCode || booking.id).replace(/[^a-zA-Z0-9_-]/g, "");
      a.href = url;
      a.download = `Job-Report-${safeCode}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (err: any) {
      alert(err?.message || "Failed to download PDF");
    } finally {
      setDownloadingBookingId(null);
    }
  };

  const requestDownloadBookingPdf = (booking: CustomerBooking) => {
    if (booking.status !== "Completed") {
      alert("Job report is only available for completed bookings.");
      return;
    }
    setPdfConfirmBooking(booking);
  };

  const handleAdditionalIssueResponse = async (bookingId: string, issueId: string, action: "accept" | "reject") => {
    if (!customer?.customerId) return;
    const key = `${bookingId}-${issueId}`;
    setAdditionalIssueResponding((p) => ({ ...p, [key]: true }));
    try {
      const res = await fetch(
        `/api/book-now/customer-bookings/${bookingId}/additional-issues/${issueId}?customerId=${encodeURIComponent(customer.customerId)}`,
        { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) }
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || "Failed to submit response");
      }
      fetchCustomerBookings();
      // Mark related notification as read
      const toMark = customerEstimateNotifications
        .filter((n) => n.type === "additional_issue_quote" && n.bookingId === bookingId && n.issueId === issueId && !n.read)
        .map((n) => n.id);
      if (toMark.length > 0) {
        try {
          await fetch("/api/book-now/customer-notifications", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ customerId: customer.customerId, notificationIds: toMark }),
          });
        } catch {
          /* ignore */
        }
        fetchCustomerNotifications();
      } else {
        fetchCustomerNotifications();
      }
    } catch (err: any) {
      alert(err?.message || "Failed to submit response");
    } finally {
      setAdditionalIssueResponding((p) => ({ ...p, [key]: false }));
    }
  };

  const fetchCustomerEstimates = useCallback(async () => {
    if (!customer?.customerId) return;
    setCustomerEstimatesLoading(true);
    try {
      const res = await fetch(`/api/book-now/customer-estimates?customerId=${customer.customerId}`);
      if (res.ok) {
        const data = await res.json();
        setCustomerEstimates(data.estimates || []);
      }
    } catch (err) {
      console.error("Failed to fetch customer estimates:", err);
    } finally {
      setCustomerEstimatesLoading(false);
    }
  }, [customer?.customerId]);

  useEffect(() => {
    if (!customer?.customerId) {
      setCustomerEstimates([]);
      return;
    }
    fetchCustomerEstimates();
  }, [customer?.customerId, fetchCustomerEstimates]);

  const fetchCustomerNotifications = useCallback(async () => {
    if (!customer?.customerId) return;
    try {
      const res = await fetch(`/api/book-now/customer-notifications?customerId=${customer.customerId}`);
      if (res.ok) {
        const data = await res.json();
        setCustomerEstimateNotifications(data.notifications || []);
        setCustomerEstimateUnreadCount(data.unreadCount ?? 0);
      }
    } catch (err) {
      console.error("Failed to fetch customer notifications:", err);
    }
  }, [customer?.customerId]);

  const markAllAsRead = useCallback(async () => {
    const ids = visibleBookings.map((b) => b.id);
    setReadIds((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => next.add(id));
      if (customer?.customerId) {
        localStorage.setItem(`bms_read_notifs_${customer.customerId}`, JSON.stringify([...next]));
      }
      return next;
    });
    const toMark = customerEstimateNotifications.filter((n) => !n.read).map((n) => n.id);
    if (toMark.length > 0 && customer?.customerId) {
      try {
        await fetch("/api/book-now/customer-notifications", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ customerId: customer.customerId, notificationIds: toMark }),
        });
        fetchCustomerNotifications();
      } catch {
        /* ignore */
      }
    }
  }, [visibleBookings, customer?.customerId, customerEstimateNotifications, fetchCustomerNotifications]);

  useEffect(() => {
    if (!customer?.customerId) {
      setCustomerEstimateNotifications([]);
      setCustomerEstimateUnreadCount(0);
      return;
    }
    fetchCustomerNotifications();
    const interval = setInterval(fetchCustomerNotifications, 30000);
    return () => clearInterval(interval);
  }, [customer?.customerId, fetchCustomerNotifications]);

  const markEstimateNotificationsAsRead = useCallback(async (estimateId: string) => {
    const toMark = customerEstimateNotifications
      .filter((n) => n.type === "estimate_reply" && n.estimateId === estimateId && !n.read)
      .map((n) => n.id);
    if (toMark.length === 0 || !customer?.customerId) return;
    try {
      await fetch("/api/book-now/customer-notifications", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerId: customer.customerId, notificationIds: toMark }),
      });
      fetchCustomerNotifications();
    } catch (err) {
      console.error("Failed to mark notifications as read:", err);
    }
  }, [customer?.customerId, customerEstimateNotifications, fetchCustomerNotifications]);

  const toggleEstimateExpand = useCallback(async (estimateId: string) => {
    if (expandedEstimateId === estimateId) {
      setExpandedEstimateId(null);
      return;
    }
    setExpandedEstimateId(estimateId);
    markEstimateNotificationsAsRead(estimateId);
    if (!estimateReplies[estimateId]) {
      setEstimateRepliesLoading(estimateId);
      try {
        const res = await fetch(`/api/book-now/estimate-reply?estimateId=${estimateId}`);
        if (res.ok) {
          const data = await res.json();
          setEstimateReplies((prev) => ({ ...prev, [estimateId]: data.replies || [] }));
        }
      } catch (err) {
        console.error("Failed to fetch estimate replies:", err);
      } finally {
        setEstimateRepliesLoading(null);
      }
    }
  }, [expandedEstimateId, estimateReplies, markEstimateNotificationsAsRead]);

  const branchServices = useMemo(() => {
    if (!selectedBranch) return [];
    return allServices.filter((s) => s.branches.includes(selectedBranch.id));
  }, [selectedBranch, allServices]);

  const selectedServiceDetails = useMemo(() => allServices.filter((s) => selectedServices.includes(s.id)), [selectedServices, allServices]);
  const totalPrice = useMemo(() => selectedServiceDetails.reduce((sum, s) => sum + s.price, 0), [selectedServiceDetails]);
  const totalDuration = useMemo(() => selectedServiceDetails.reduce((sum, s) => sum + s.duration, 0), [selectedServiceDetails]);

  // ─── Real-time clock that ticks every 30s so time slots stay current ───
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const iv = setInterval(() => setNowTick(Date.now()), 30000);
    return () => clearInterval(iv);
  }, []);

  // ─── Branch-timezone-aware "today" date and current time ───
  const branchTimezone = selectedBranch?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;

  const branchToday = useMemo(() => {
    try {
      // en-CA locale gives YYYY-MM-DD format
      return new Intl.DateTimeFormat("en-CA", { timeZone: branchTimezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(nowTick));
    } catch {
      return new Date().toISOString().split("T")[0];
    }
  }, [branchTimezone, nowTick]);

  const branchCurrentTime = useMemo(() => {
    try {
      return new Intl.DateTimeFormat("en-GB", { timeZone: branchTimezone, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(nowTick));
    } catch {
      const n = new Date();
      return `${n.getHours().toString().padStart(2, "0")}:${n.getMinutes().toString().padStart(2, "0")}`;
    }
  }, [branchTimezone, nowTick]);

  // ─── Branch opening hours for the selected date ───
  const branchDayHours = useMemo<{ open: string; close: string } | null>(() => {
    if (!selectedBranch?.hours || typeof selectedBranch.hours === "string" || !date) return null;
    const hoursMap = selectedBranch.hours as BranchHoursMap;
    // Get the day-of-week name for the selected date in the branch timezone
    let dayName: string;
    try {
      dayName = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: branchTimezone }).format(new Date(date + "T12:00:00"));
    } catch {
      dayName = new Intl.DateTimeFormat("en-US", { weekday: "long" }).format(new Date(date + "T12:00:00"));
    }
    const dayHours = hoursMap[dayName as keyof BranchHoursMap];
    if (!dayHours || dayHours.closed) return null; // branch is closed this day
    return {
      open: dayHours.open || "09:00",
      close: dayHours.close || "17:00",
    };
  }, [selectedBranch, date, branchTimezone]);

  // Australian booking rule: drop-off till 11 AM, pick-up 2 PM – 5 PM
  const DROPOFF_CUTOFF = "11:00";
  const PICKUP_START = "14:00";
  const PICKUP_END = "17:00";

  // All possible drop-off time slots — branch hours capped at 11:00 AM
  const allTimeSlots = useMemo(() => {
    const openTime = branchDayHours?.open || "07:00";
    const closeTime = branchDayHours?.close || "19:30";
    const [openH, openM] = openTime.split(":").map(Number);
    const [closeH, closeM] = closeTime.split(":").map(Number);
    const openMins = openH * 60 + openM;
    const closeMins = closeH * 60 + closeM;
    const [cutH, cutM] = DROPOFF_CUTOFF.split(":").map(Number);
    const cutoffMins = cutH * 60 + cutM;
    const endMins = Math.min(closeMins, cutoffMins);
    const slots: string[] = [];
    for (let mins = openMins; mins <= endMins; mins += 30) {
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      slots.push(`${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`);
    }
    return slots;
  }, [branchDayHours]);

  // Available drop-off time slots — filter out past times and times where the service can't finish before closing
  const timeSlots = useMemo(() => {
    let slots = allTimeSlots;
    // Filter out past times if the selected date is today
    if (date && date === branchToday) {
      slots = slots.filter(t => t > branchCurrentTime);
    }
    // Filter out times where service can't finish before branch closes
    if (totalDuration > 0 && branchDayHours) {
      const [closeH, closeM] = branchDayHours.close.split(":").map(Number);
      const closeMins = closeH * 60 + closeM;
      slots = slots.filter(t => {
        const [h, m] = t.split(":").map(Number);
        return (h * 60 + m) + totalDuration <= closeMins;
      });
    }
    return slots;
  }, [allTimeSlots, date, branchToday, branchCurrentTime, totalDuration, branchDayHours]);

  // Earliest allowed pick-up time = drop-off time + total service duration
  const earliestPickupTime = useMemo(() => {
    if (!time || totalDuration === 0) return null;
    const [h, m] = time.split(":").map(Number);
    const totalMins = h * 60 + m + totalDuration;
    const pH = Math.floor(totalMins / 60);
    const pM = totalMins % 60;
    if (pH > 23) return null; // past end of day
    return `${pH.toString().padStart(2, "0")}:${pM.toString().padStart(2, "0")}`;
  }, [time, totalDuration]);

  // Filtered pick-up time slots: 2 PM – 5 PM, >= earliest pick-up time, and not past for today
  const pickupTimeSlots = useMemo(() => {
    if (!earliestPickupTime) return [];
    const [psH, psM] = PICKUP_START.split(":").map(Number);
    const [peH, peM] = PICKUP_END.split(":").map(Number);
    const startMins = psH * 60 + psM;
    const endMins = peH * 60 + peM;
    const slots: string[] = [];
    for (let mins = startMins; mins <= endMins; mins += 30) {
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      slots.push(`${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`);
    }
    let filtered = slots.filter(t => t >= earliestPickupTime);
    if (date === branchToday) {
      filtered = filtered.filter(t => t > branchCurrentTime);
    }
    return filtered;
  }, [earliestPickupTime, date, branchToday, branchCurrentTime]);

  // Clear pick-up time if it becomes invalid after drop-off or duration changes
  useEffect(() => {
    if (pickupTime && earliestPickupTime && pickupTime < earliestPickupTime) {
      setPickupTime("");
    }
    if (!time) setPickupTime("");
  }, [earliestPickupTime, pickupTime, time]);

  // Clear drop-off time if it becomes past (e.g. time ticked past selected slot for today)
  // Also clear if the selected time is outside branch hours
  useEffect(() => {
    if (time && date === branchToday && time <= branchCurrentTime) {
      setTime("");
    }
    // Clear time if branch is closed on the selected day
    if (time && branchDayHours === null && date && selectedBranch?.hours && typeof selectedBranch.hours !== "string") {
      setTime("");
    }
    // Clear time if it's outside the branch opening hours
    if (time && branchDayHours) {
      if (time < branchDayHours.open || time >= branchDayHours.close) {
        setTime("");
      }
    }
  }, [time, date, branchToday, branchCurrentTime, branchDayHours, selectedBranch]);

  // Fetch slot availability when branch, services, or date change
  useEffect(() => {
    if (!slug || !selectedBranch || selectedServices.length === 0 || !date) {
      setBlockedSlots(new Set());
      setDailyLimitReached(false);
      return;
    }
    let cancelled = false;
    const fetchAvailability = async () => {
      setAvailabilityLoading(true);
      try {
        const params = new URLSearchParams({
          slug: slug as string,
          branchId: selectedBranch.id,
          date,
          serviceIds: selectedServices.join(","),
        });
        const res = await fetch(`/api/book-now/availability?${params}`);
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (cancelled) return;
        setBlockedSlots(new Set(data.blockedSlots || []));
        setDailyLimitReached(Boolean(data.dailyLimitReached));
        // Clear selected time if it's now blocked
        if (data.blockedSlots?.includes(time)) {
          setTime("");
        }
      } catch {
        if (!cancelled) {
          setBlockedSlots(new Set());
          setDailyLimitReached(false);
        }
      } finally {
        if (!cancelled) setAvailabilityLoading(false);
      }
    };
    fetchAvailability();
    return () => { cancelled = true; };
  }, [slug, selectedBranch, selectedServices, date]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleBranchSelect = (branch: Branch) => { setSelectedBranch(branch); setSelectedServices([]); goToStep(2); };
  const toggleService = (serviceId: string) => {
    setSelectedServices((prev) => prev.includes(serviceId) ? prev.filter((id) => id !== serviceId) : [...prev, serviceId]);
  };

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!workshop) return;
    setAuthLoading(true); setAuthError("");
    if (authMode === "register" && authPassword !== authConfirmPassword) {
      setAuthError("Passwords do not match"); setAuthLoading(false); return;
    }
    try {
      const res = await fetch("/api/book-now/customer-auth", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: authMode === "login" ? "login" : "register", email: authEmail, password: authPassword, ownerUid: workshop.id, name: authName || undefined, phone: authPhone || undefined }),
      });
      const data = await res.json();
      if (!res.ok) { setAuthError(data.error || "Authentication failed"); return; }
      const session: CustomerSession = { customerId: data.customerId, name: data.name, email: data.email, phone: data.phone };
      setCustomer(session); setCustomerName(data.name); setCustomerEmail(data.email); setCustomerPhone(data.phone);
      if (!estimateName) setEstimateName(data.name || "");
      if (!estimateEmail) setEstimateEmail(data.email || "");
      if (!estimatePhone) setEstimatePhone(data.phone || "");
      sessionStorage.setItem(`bms_customer_${slug}`, JSON.stringify(session));
      setShowAuth(false); setAuthEmail(""); setAuthPassword(""); setAuthConfirmPassword(""); setAuthName(""); setAuthPhone("");
    } catch (err: any) { setAuthError(err.message || "Something went wrong"); }
    finally { setAuthLoading(false); }
  };

  const handleForgotPasswordEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!workshop || !forgotPasswordEmail.trim()) return;
    setForgotPasswordLoading(true); setForgotPasswordError("");
    try {
      const res = await fetch("/api/book-now/customer-forgot-password", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: forgotPasswordEmail.trim(), ownerUid: workshop.id }),
      });
      const data = await res.json();
      if (!res.ok) { setForgotPasswordError(data.error || "Failed to send reset code"); return; }
      setForgotPasswordStep("reset");
      setForgotPasswordError("");
    } catch (err: any) { setForgotPasswordError(err.message || "Something went wrong"); }
    finally { setForgotPasswordLoading(false); }
  };

  const handleForgotPasswordResetSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!workshop || !forgotPasswordEmail.trim() || !resetCode.trim() || !newPassword || !newPasswordConfirm) return;
    if (newPassword !== newPasswordConfirm) { setForgotPasswordError("Passwords do not match"); return; }
    if (newPassword.length < 6) { setForgotPasswordError("Password must be at least 6 characters"); return; }
    setForgotPasswordLoading(true); setForgotPasswordError("");
    try {
      const res = await fetch("/api/book-now/customer-reset-password", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: forgotPasswordEmail.trim(), code: resetCode.trim(), newPassword, ownerUid: workshop.id }),
      });
      const data = await res.json();
      if (!res.ok) { setForgotPasswordError(data.error || "Failed to reset password"); return; }
      setForgotPasswordSuccess(true);
      setForgotPasswordError("");
    } catch (err: any) { setForgotPasswordError(err.message || "Something went wrong"); }
    finally { setForgotPasswordLoading(false); }
  };

  const resetForgotPasswordFlow = () => {
    setShowForgotPassword(false);
    setForgotPasswordStep("email");
    setForgotPasswordEmail("");
    setResetCode("");
    setNewPassword("");
    setNewPasswordConfirm("");
    setForgotPasswordError("");
    setForgotPasswordSuccess(false);
  };

  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const [editingProfile, setEditingProfile] = useState(false);
  const [editName, setEditName] = useState("");
  const [editPhone, setEditPhone] = useState("");
  const [savingProfile, setSavingProfile] = useState(false);

  const handleLogout = () => {
    setCustomer(null); setCustomerName(""); setCustomerEmail(""); setCustomerPhone(""); setVehicleNumber("");
    setVehicleMake(""); setVehicleModel(""); setVehicleYear(""); setVehicleMileage("");
    setVehicleBodyType(""); setVehicleColour(""); setVehicleVinChassis(""); setVehicleEngineNumber("");
    setCustomerVehicles([]); setSelectedVehicleId("new");
    const storageKey = getSelectedVehicleStorageKey();
    if (storageKey) localStorage.removeItem(storageKey);
    sessionStorage.removeItem(`bms_customer_${slug}`);
    setShowLogoutConfirm(false);
    setShowProfileMenu(false);
  };

  const handleSelectVehicle = (id: string | "new") => {
    setSelectedVehicleId(id);
    const storageKey = getSelectedVehicleStorageKey();
    if (storageKey) {
      if (id === "new") localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, id);
    }
    if (id === "new") {
      setVehicleNumber(""); setVehicleMake(""); setVehicleModel(""); setVehicleYear(""); setVehicleMileage("");
      setVehicleBodyType(""); setVehicleColour(""); setVehicleVinChassis(""); setVehicleEngineNumber("");
    } else {
      const v = customerVehicles.find((x) => x.id === id);
      if (v) {
        setVehicleNumber(v.registrationNumber || "");
        setVehicleMake(v.make || ""); setVehicleModel(v.model || ""); setVehicleYear(v.year || ""); setVehicleMileage(v.mileage || "");
        setVehicleBodyType(v.bodyType || ""); setVehicleColour(v.colour || "");
        setVehicleVinChassis(v.vinChassis || ""); setVehicleEngineNumber(v.engineNumber || "");
      }
    }
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
    if (!customer?.customerId) {
      setShowAuth(true);
      return;
    }
    const effectiveVehicle = (vehicleNumber || "").trim() || [vehicleMake, vehicleModel, vehicleYear].filter(Boolean).join(" ").trim() || "Vehicle";
    if (!selectedBranch || selectedServices.length === 0 || !customerName || !customerPhone || !customerEmail?.trim() || !date || !time || !pickupTime) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/book-now/submit", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug, branchId: selectedBranch.id, branchName: selectedBranch.name,
          services: selectedServiceDetails.map((s) => ({ id: s.id, time })),
          customerName, customerEmail, customerPhone, vehicleNumber: effectiveVehicle, notes, date, time, pickupTime,
          customerId: customer?.customerId || null,
          vehicleDetails: {
            make: vehicleMake?.trim() || null,
            model: vehicleModel?.trim() || null,
            year: vehicleYear?.trim() || null,
            mileage: vehicleMileage?.trim() || null,
            bodyType: vehicleBodyType?.trim() || null,
            colour: vehicleColour?.trim() || null,
            vinChassis: vehicleVinChassis?.trim() || null,
            engineNumber: vehicleEngineNumber?.trim() || null,
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to submit booking");
      setBookingResult({ bookingCode: data.bookingCode, totalPrice: data.totalPrice, totalDuration: data.totalDuration });
      fetchCustomerBookings(); // Refresh bookings list immediately
      // Save new vehicle for future use if customer added one
      if (selectedVehicleId === "new" && (vehicleNumber?.trim() || vehicleMake?.trim() || vehicleModel?.trim()) && customer?.customerId) {
        try {
          await fetch("/api/book-now/customer-vehicles", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              customerId: customer.customerId,
              slug,
              registrationNumber: vehicleNumber?.trim() || undefined,
              make: vehicleMake?.trim() || undefined,
              model: vehicleModel?.trim() || undefined,
              year: vehicleYear?.trim() || undefined,
              mileage: vehicleMileage?.trim() || undefined,
              bodyType: vehicleBodyType?.trim() || undefined,
              colour: vehicleColour?.trim() || undefined,
              vinChassis: vehicleVinChassis?.trim() || undefined,
              engineNumber: vehicleEngineNumber?.trim() || undefined,
            }),
          });
          const vRes = await fetch(`/api/book-now/customer-vehicles?customerId=${encodeURIComponent(customer.customerId)}&slug=${encodeURIComponent(slug)}`);
          if (vRes.ok) setCustomerVehicles((await vRes.json()).vehicles || []);
        } catch {
          /* ignore */
        }
      }
      goToStep(4);
      setTimeout(() => setShowConfetti(true), 400);
    } catch (err: any) { alert(err.message || "Something went wrong"); }
    finally { setSubmitting(false); }
  };

  const validateEstimateForm = (): boolean => {
    const errs: Record<string, string> = {};
    if (!estimateName?.trim()) errs.name = "Full name is required";
    if (!estimatePhone?.trim()) errs.phone = "Phone is required";
    else if (!/^[\d\s+\-()]+$/.test(estimatePhone) || estimatePhone.replace(/\D/g, "").length < 8) {
      errs.phone = "Enter a valid phone number (numbers only, at least 8 digits)";
    }
    if (!estimateEmail?.trim()) errs.email = "Email is required";
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(estimateEmail.trim())) errs.email = "Enter a valid email address";
    if (!estimateDescription?.trim()) errs.description = "Description is required";
    if (estimateVehicleYear && !/^\d+$/.test(estimateVehicleYear.trim())) errs.year = "Year must be numbers only";
    if (estimateMileage && !/^\d+$/.test(estimateMileage)) {
      errs.mileage = "Mileage must be numbers only";
    }
    setEstimateFieldErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleEstimateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!customer?.customerId) { setShowAuth(true); return; }
    if (!workshop) return;
    if (!validateEstimateForm()) {
      setEstimateError("Please fix the errors below.");
      return;
    }
    setEstimateSubmitting(true);
    setEstimateError("");
    setEstimateFieldErrors({});
    try {
      // Upload images first via server API
      let imageUrls: string[] = [];
      if (estimateImages.length > 0) {
        for (let i = 0; i < estimateImages.length; i++) {
          const file = estimateImages[i];
          const formData = new FormData();
          formData.append("file", file);
          formData.append("folder", "estimates/customer-uploads");
          const uploadRes = await fetch("/api/book-now/upload-image", { method: "POST", body: formData });
          const uploadText = await uploadRes.text();
          let uploadData: { url?: string; error?: string } = {};
          try {
            uploadData = uploadText ? JSON.parse(uploadText) : {};
          } catch {
            if (uploadRes.status === 413) throw new Error("Image too large. Please use smaller photos (max 5MB each).");
            throw new Error(`Failed to upload image ${i + 1} of ${estimateImages.length}`);
          }
          if (!uploadRes.ok) {
            throw new Error(uploadData.error || `Failed to upload image ${i + 1} of ${estimateImages.length}`);
          }
          if (uploadData.url) {
            imageUrls.push(uploadData.url);
          } else {
            console.warn("Upload succeeded but no URL returned for image", i + 1);
          }
        }
      }

      const res = await fetch("/api/book-now/estimate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug,
          customerId: customer?.customerId || null,
          branchId: estimateBranch?.id || null,
          branchName: estimateBranch?.name || null,
          customerName: estimateName,
          customerPhone: estimatePhone,
          customerEmail: estimateEmail,
          vehicleMake: estimateVehicleMake,
          vehicleModel: estimateVehicleModel,
          vehicleYear: estimateVehicleYear,
          rego: estimateRego,
          mileage: estimateMileage ? `${estimateMileage.replace(/\D/g, "")} km` : "",
          description: estimateDescription,
          imageUrls,
        }),
      });
      const text = await res.text();
      let data: { error?: string } = {};
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        if (res.status === 413) throw new Error("Request payload too large. Try reducing the number or size of photos.");
        throw new Error("Invalid response from server. Please try again.");
      }
      if (!res.ok) throw new Error(data.error || "Failed to submit estimate request");
      setEstimateSuccess(true);
      setEstimateImages([]);
      setEstimateImagePreviews([]);
      setEstimateFieldErrors({});
      fetchCustomerEstimates();
    } catch (err: any) {
      setEstimateError(err.message || "Something went wrong");
    } finally {
      setEstimateSubmitting(false);
    }
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
                onClick={() => {
                  setShowNotifications((v) => {
                    if (!v) {
                      fetchCustomerNotifications();
                      markAllAsRead();
                    }
                    return !v;
                  });
                }}
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
        {/* ── View Tabs ── */}
        <div className="max-w-4xl mx-auto px-4 sm:px-6 pt-2 pb-1.5">
          <div className="flex items-center gap-1.5 p-1.5 rounded-2xl bg-neutral-100/90 border border-neutral-200/80 overflow-x-auto">
            <button
              onClick={() => { setActiveView("booking"); setEstimateSuccess(false); }}
              className={`h-8 shrink-0 inline-flex items-center gap-1.5 px-3.5 rounded-xl text-[11px] font-bold transition-all ${
                activeView === "booking"
                  ? "bg-white text-neutral-900 shadow-sm border border-neutral-200"
                  : "text-neutral-500 hover:bg-white/80 hover:text-neutral-700"
              }`}
            >
              <i className="fas fa-calendar-plus text-[9px]" />
              Book Now
            </button>
            {customer && (
              <button
                onClick={() => setActiveView("myBookings")}
                className={`h-8 shrink-0 inline-flex items-center gap-1.5 px-3.5 rounded-xl text-[11px] font-bold transition-all ${
                  activeView === "myBookings"
                    ? "bg-white text-neutral-900 shadow-sm border border-neutral-200"
                    : "text-neutral-500 hover:bg-white/80 hover:text-neutral-700"
                }`}
              >
                <i className="fas fa-list-check text-[9px]" />
                My Bookings
                {customerBookings.length > 0 && (
                  <span
                    className={`min-w-[18px] h-[18px] inline-flex items-center justify-center text-[9px] font-extrabold rounded-full px-1 ${
                      customerEstimateNotifications.some((n) => n.type === "additional_issue_quote" && !n.read)
                        ? "bg-amber-500 text-white"
                        : activeView === "myBookings"
                          ? "bg-neutral-900 text-white"
                          : "bg-neutral-200 text-neutral-700"
                    }`}
                    title={customerEstimateNotifications.some((n) => n.type === "additional_issue_quote" && !n.read) ? "Additional work quote to review" : undefined}
                  >
                    {customerBookings.length}
                  </span>
                )}
              </button>
            )}
            {customer && (
              <button
                onClick={() => { setActiveView("myEstimates"); fetchCustomerEstimates(); fetchCustomerNotifications(); }}
                className={`h-8 shrink-0 inline-flex items-center gap-1.5 px-3.5 rounded-xl text-[11px] font-bold transition-all ${
                  activeView === "myEstimates"
                    ? "bg-white text-neutral-900 shadow-sm border border-neutral-200"
                    : "text-neutral-500 hover:bg-white/80 hover:text-neutral-700"
                }`}
              >
                <i className="fas fa-file-invoice text-[9px]" />
                My Estimates
                {customerEstimateUnreadCount > 0 && (
                  <span className="min-w-[18px] h-[18px] inline-flex items-center justify-center text-[9px] font-extrabold rounded-full px-1 bg-amber-500 text-white">
                    {customerEstimateUnreadCount}
                  </span>
                )}
                {customerEstimateUnreadCount === 0 && customerEstimates.length > 0 && (
                  <span className={`min-w-[18px] h-[18px] inline-flex items-center justify-center text-[9px] font-extrabold rounded-full px-1 ${
                    activeView === "myEstimates" ? "bg-neutral-900 text-white" : "bg-neutral-200 text-neutral-700"
                  }`}>
                    {customerEstimates.length}
                  </span>
                )}
              </button>
            )}
            {customer && (
              <button
                onClick={() => { setActiveView("myVehicles"); fetchCustomerVehicles(); }}
                className={`h-8 shrink-0 inline-flex items-center gap-1.5 px-3.5 rounded-xl text-[11px] font-bold transition-all ${
                  activeView === "myVehicles"
                    ? "bg-white text-neutral-900 shadow-sm border border-neutral-200"
                    : "text-neutral-500 hover:bg-white/80 hover:text-neutral-700"
                }`}
              >
                <i className="fas fa-car text-[9px]" />
                My Vehicles
                {customerVehicles.length > 0 && (
                  <span className={`min-w-[18px] h-[18px] inline-flex items-center justify-center text-[9px] font-extrabold rounded-full px-1 ${
                    activeView === "myVehicles" ? "bg-neutral-900 text-white" : "bg-neutral-200 text-neutral-700"
                  }`}>
                    {customerVehicles.length}
                  </span>
                )}
              </button>
            )}
          </div>
        </div>
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
              ) : visibleBookings.length === 0 && customerEstimateNotifications.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 gap-3 text-center px-6">
                  <div className="w-12 h-12 rounded-xl bg-neutral-100 flex items-center justify-center">
                    <i className="fas fa-bell-slash text-lg text-neutral-300" />
                  </div>
                  <p className="text-xs font-bold text-neutral-600">No notifications</p>
                  <p className="text-[11px] text-neutral-400 -mt-1.5">Your booking updates will appear here.</p>
                </div>
              ) : (
                <div className="px-3 py-3 space-y-2.5">
                  {/* Additional work quote & estimate reply notifications */}
                  {customerEstimateNotifications.map((n) => {
                    const isAdditionalQuote = n.type === "additional_issue_quote";
                    const timeAgo = (() => {
                      const raw = n.createdAt;
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
                      <div
                        key={n.id}
                        className="bg-white rounded-xl border border-neutral-200/80 shadow-sm hover:shadow-md transition-all overflow-hidden cursor-pointer"
                        onClick={() => {
                          setShowNotifications(false);
                          if (isAdditionalQuote) {
                            setActiveView("myBookings");
                            fetchCustomerBookings();
                            setExpandedBookingId(n.bookingId || null);
                          } else {
                            setActiveView("myEstimates");
                            fetchCustomerEstimates();
                            fetchCustomerNotifications();
                          }
                        }}
                      >
                        <div className="h-[3px] bg-amber-400" />
                        <div className="px-3.5 pt-3 pb-3">
                          <div className="flex items-start gap-2.5">
                            <div className="w-8 h-8 rounded-lg bg-amber-100 flex items-center justify-center shrink-0">
                              <i className="fas fa-file-invoice-dollar text-xs text-amber-600" />
                            </div>
                            <div className="flex-1 min-w-0">
                              <h4 className="text-[11px] font-bold text-neutral-900 leading-snug">
                                {isAdditionalQuote ? "Additional Work Quote Ready" : "Estimate Reply"}
                              </h4>
                              <p className="text-[10px] text-neutral-500 leading-relaxed mt-0.5">
                                {n.message || (isAdditionalQuote ? `${n.issueTitle || "Additional work"}: $${typeof n.price === "number" ? n.price.toFixed(2) : "—"} - Please review.` : "You have a new reply to your estimate request.")}
                              </p>
                              {n.bookingCode && (
                                <p className="text-[9px] text-neutral-400 mt-1 font-mono">{n.bookingCode}</p>
                              )}
                              {timeAgo && <span className="text-[9px] text-neutral-300 font-medium block mt-1">{timeAgo}</span>}
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
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
                              <span className="text-[10px] text-neutral-700 font-semibold">{bk.date} · Drop-off {bk.time}{bk.pickupTime ? ` · Pick-up ${bk.pickupTime}` : ""}</span>
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

      {/* ═══════════════════ NOTIFICATION BANNER (estimates + additional work) ═══════════════════ */}
      {customer && customerEstimateUnreadCount > 0 && activeView !== "myEstimates" && activeView !== "myBookings" && (
        <div className="relative z-20 bg-amber-50 border-b border-amber-200/80">
          <div className="max-w-4xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <i className="fas fa-bell text-amber-600 text-sm" />
              <span className="text-sm font-medium text-amber-900">
                {customerEstimateNotifications.some((n) => n.type === "additional_issue_quote" && !n.read)
                  ? "You have an additional work quote to review."
                  : `You have ${customerEstimateUnreadCount} new reply${customerEstimateUnreadCount > 1 ? "s" : ""} to your estimate request${customerEstimateUnreadCount > 1 ? "s" : ""}.`}
              </span>
            </div>
            <button
              onClick={() => {
                if (customerEstimateNotifications.some((n) => n.type === "additional_issue_quote" && !n.read)) {
                  setActiveView("myBookings");
                  fetchCustomerBookings();
                } else {
                  setActiveView("myEstimates");
                  fetchCustomerEstimates();
                }
                fetchCustomerNotifications();
              }}
              className="shrink-0 px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-600 text-white text-xs font-bold transition-colors"
            >
              {customerEstimateNotifications.some((n) => n.type === "additional_issue_quote" && !n.read)
                ? "View My Bookings"
                : "View My Estimates"}
            </button>
          </div>
        </div>
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
            {/* Get Estimate Card */}
            <button
              onClick={() => { setActiveView("estimate"); setEstimateSuccess(false); setEstimateError(""); setEstimateFieldErrors({}); if (branches.length === 1 && !estimateBranch) setEstimateBranch(branches[0]); }}
              className="w-full mb-6 group relative overflow-hidden bg-gradient-to-r from-amber-50 via-amber-50/80 to-orange-50 hover:from-amber-100 hover:via-amber-100/80 hover:to-orange-100 border border-amber-200/60 rounded-2xl p-4 sm:p-5 flex items-center gap-4 transition-all duration-200 text-left"
            >
              <div className="w-12 h-12 rounded-xl bg-amber-500/15 flex items-center justify-center flex-shrink-0">
                <i className="fas fa-file-invoice text-amber-600 text-lg" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-bold text-neutral-900 text-sm sm:text-base">Get an Estimate</div>
                <p className="text-xs text-neutral-500 mt-0.5">Need a quote? Submit your vehicle details and we'll get back to you.</p>
              </div>
              <i className="fas fa-chevron-right text-amber-400 group-hover:text-amber-600 group-hover:translate-x-0.5 transition-all text-sm" />
            </button>

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
                  <div className="relative bg-amber-50 rounded-2xl border-2 border-amber-300/80 p-5 overflow-hidden group hover:shadow-lg transition-shadow">
                    <div className="absolute top-0 right-0 w-32 h-32 bg-amber-100/30 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2" />
                    <div className="relative z-10 flex items-center justify-between gap-4">
                      <div className="flex items-center gap-3">
                        <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center shadow-lg shadow-amber-500/15">
                          <i className="fas fa-lock text-white text-base" />
                        </div>
                        <div>
                          <p className="font-bold text-neutral-900 text-sm">Sign in required to book</p>
                          <p className="text-xs text-neutral-500 mt-0.5">Please sign in or create an account to continue</p>
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

                  {/* Row 1: Calendar + Drop-off Time (equal height) */}
                  <div className="flex flex-col sm:flex-row gap-4">
                    {/* Custom Calendar */}
                    <div className="flex-1 flex flex-col">
                      <label className="block text-[11px] font-bold text-neutral-400 uppercase tracking-wider mb-2">Date <span className="text-red-400">*</span></label>
                      {(() => {
                        const { year, month } = calendarMonth;
                        const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
                        const dayNames = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
                        const firstDay = new Date(year, month, 1);
                        const lastDay = new Date(year, month + 1, 0);
                        const startDow = (firstDay.getDay() + 6) % 7;
                        const daysInMonth = lastDay.getDate();
                        // Use branch timezone "today" for past-date calculations
                        const [tY, tM, tD] = branchToday.split("-").map(Number);
                        const todayDate = new Date(tY, tM - 1, tD); todayDate.setHours(0, 0, 0, 0);

                        const prevMonth = () => setCalendarMonth((p) => p.month === 0 ? { year: p.year - 1, month: 11 } : { year: p.year, month: p.month - 1 });
                        const nextMonth = () => setCalendarMonth((p) => p.month === 11 ? { year: p.year + 1, month: 0 } : { year: p.year, month: p.month + 1 });
                        const goToday = () => { setCalendarMonth({ year: tY, month: tM - 1 }); };

                        const canGoPrev = new Date(year, month, 1) > new Date(todayDate.getFullYear(), todayDate.getMonth(), 1);

                        const cells: (number | null)[] = [];
                        for (let i = 0; i < startDow; i++) cells.push(null);
                        for (let d = 1; d <= daysInMonth; d++) cells.push(d);
                        while (cells.length % 7 !== 0) cells.push(null);

                        return (
                          <div className="border-2 border-neutral-200 rounded-xl overflow-hidden bg-white flex-1 flex flex-col">
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
                            <div className="grid grid-cols-7 px-2 pb-2 gap-y-0.5 flex-1">
                              {cells.map((day, i) => {
                                if (day === null) return <div key={`e-${i}`} />;
                                const cellDate = new Date(year, month, day); cellDate.setHours(0, 0, 0, 0);
                                const dateStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
                                const isPast = cellDate < todayDate;

                                // Check if branch is closed on this day
                                let isClosed = false;
                                if (selectedBranch?.hours && typeof selectedBranch.hours !== "string") {
                                  let dayName: string;
                                  try { dayName = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: branchTimezone }).format(new Date(dateStr + "T12:00:00")); }
                                  catch { dayName = new Intl.DateTimeFormat("en-US", { weekday: "long" }).format(new Date(dateStr + "T12:00:00")); }
                                  const dh = (selectedBranch.hours as BranchHoursMap)[dayName as keyof BranchHoursMap];
                                  if (dh?.closed) isClosed = true;
                                }

                                const isDisabled = isPast || isClosed;
                                const isSelected = date === dateStr;
                                const isToday = cellDate.getTime() === todayDate.getTime();

                                return (
                                  <button
                                    key={dateStr}
                                    type="button"
                                    disabled={isDisabled}
                                    onClick={() => setDate(dateStr)}
                                    title={isClosed ? "Branch closed" : undefined}
                                    className={`w-full aspect-square rounded-lg flex items-center justify-center text-xs font-semibold transition-all
                                      ${isDisabled ? "text-neutral-300 cursor-not-allowed" : ""}
                                      ${isClosed && !isPast ? "line-through decoration-red-300" : ""}
                                      ${isSelected ? "bg-neutral-900 text-white shadow-md shadow-neutral-900/20" : ""}
                                      ${isToday && !isSelected && !isDisabled ? "bg-amber-100 text-amber-700 font-bold" : ""}
                                      ${!isDisabled && !isSelected && !isToday ? "text-neutral-700 hover:bg-neutral-100" : ""}
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
                              <button type="button" onClick={() => { goToday(); setDate(branchToday); }} className="text-[10px] font-semibold text-amber-600 hover:text-amber-700 transition-colors">Today</button>
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

                    {/* Drop-off Time picker */}
                    <div className="flex-1 flex flex-col">
                      <label className="block text-[11px] font-bold text-neutral-400 uppercase tracking-wider mb-2">
                        <i className="fas fa-arrow-right-to-bracket text-[9px] text-amber-500 mr-1" />
                        Drop-off Time <span className="text-red-400">*</span>
                      </label>
                      <div className="border-2 border-neutral-200 rounded-xl overflow-hidden bg-white flex-1 flex flex-col">
                        <div className="px-3 py-2.5 bg-neutral-50 border-b border-neutral-100">
                          <div className="flex items-center gap-2">
                            <i className="fas fa-clock text-[10px] text-amber-500" />
                            <span className="text-xs font-bold text-neutral-800">When do you drop off?</span>
                          </div>
                          {branchDayHours && (
                            <div className="flex items-center gap-1.5 mt-1">
                              <i className="fas fa-store text-[9px] text-neutral-300" />
                              <span className="text-[10px] font-medium text-neutral-400">
                                Opening hours: {branchDayHours.open} – {branchDayHours.close}
                              </span>
                            </div>
                          )}
                        </div>
                        {dailyLimitReached && (
                          <div className="mx-2.5 mt-2.5 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[11px] font-medium text-red-700">
                            Daily booking limit reached for this branch. Please choose another date.
                          </div>
                        )}
                        <div className="grid grid-cols-4 gap-1.5 p-2.5 flex-1 overflow-y-auto" style={{ alignContent: "start" }}>
                          {availabilityLoading && date && (
                            <div className="col-span-4 flex items-center justify-center gap-2 py-4">
                              <svg className="animate-spin h-3.5 w-3.5 text-neutral-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                              </svg>
                              <span className="text-[11px] text-neutral-400">Checking availability...</span>
                            </div>
                          )}
                          {!availabilityLoading && allTimeSlots.length === 0 ? (
                            <p className="col-span-4 text-center text-[11px] text-neutral-400 py-6">
                              {!date ? "Select a date first to see available times."
                                : branchDayHours === null && date ? "Branch is closed on this day. Please select another date."
                                : "No available times for this date."}
                            </p>
                          ) : !availabilityLoading && (
                            allTimeSlots.map((t) => {
                              const isFull = blockedSlots.has(t);
                              const isBookable = timeSlots.includes(t);
                              const isDisabled = isFull || !isBookable;
                              return (
                                <button
                                  key={t}
                                  type="button"
                                  onClick={() => !isDisabled && setTime(t)}
                                  disabled={isDisabled}
                                  className={`relative rounded-lg text-[13px] font-semibold transition-all text-center flex flex-col items-center justify-center py-2 min-h-[40px]
                                    ${isFull
                                      ? "bg-red-50 text-red-300 cursor-not-allowed"
                                      : isDisabled
                                        ? "bg-neutral-100 text-neutral-300 cursor-not-allowed"
                                        : time === t
                                          ? "bg-neutral-900 text-white shadow-md shadow-neutral-900/20"
                                          : "bg-amber-50 text-neutral-700 hover:bg-amber-100 hover:text-neutral-900 border border-amber-200/60"}
                                  `}
                                >
                                  <span>{t}</span>
                                </button>
                              );
                            })
                          )}
                        </div>
                      </div>
                      {time && (
                        <div className="mt-2 flex items-center gap-2 px-1">
                          <i className="fas fa-arrow-right-to-bracket text-[10px] text-emerald-500" />
                          <span className="text-xs font-semibold text-neutral-700">Drop-off: {time}</span>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Row 2: Pick-up Time (shown after drop-off time is selected) */}
                  {time && (
                    <div className="mt-4 animate-[fadeSlideUp_0.3s_ease-out]">
                      <label className="block text-[11px] font-bold text-neutral-400 uppercase tracking-wider mb-2">
                        <i className="fas fa-arrow-right-from-bracket text-[9px] text-emerald-500 mr-1" />
                        Pick-up Time <span className="text-red-400">*</span>
                        {earliestPickupTime && (
                          <span className="ml-2 text-[10px] font-medium text-neutral-400 normal-case tracking-normal">
                            (earliest: {earliestPickupTime} — based on {totalDuration} min service)
                          </span>
                        )}
                      </label>
                      <div className="border-2 border-emerald-200 rounded-xl overflow-hidden bg-white">
                        <div className="px-3 py-2.5 bg-emerald-50 border-b border-emerald-100">
                          <div className="flex items-center gap-2">
                            <i className="fas fa-arrow-right-from-bracket text-[10px] text-emerald-600" />
                            <span className="text-xs font-bold text-emerald-800">When do you pick up?</span>
                          </div>
                          {branchDayHours && (
                            <div className="flex items-center gap-1.5 mt-1">
                              <i className="fas fa-store text-[9px] text-emerald-300" />
                              <span className="text-[10px] font-medium text-emerald-400">
                                Branch closes at {branchDayHours.close}
                              </span>
                            </div>
                          )}
                        </div>
                        {pickupTimeSlots.length === 0 ? (
                          <div className="p-4 text-center">
                            <p className="text-[11px] text-neutral-400">No pick-up times available for this drop-off time and service duration.</p>
                          </div>
                        ) : (
                          <div className="grid grid-cols-3 gap-1.5 p-2.5 max-h-[200px] overflow-y-auto" style={{ alignContent: "start" }}>
                            {pickupTimeSlots.map((t) => (
                              <button
                                key={t}
                                type="button"
                                onClick={() => setPickupTime(t)}
                                className={`h-9 rounded-lg text-xs font-semibold transition-all text-center
                                  ${pickupTime === t ? "bg-emerald-600 text-white shadow-md shadow-emerald-600/20" : "bg-emerald-50 text-emerald-700 hover:bg-emerald-100 hover:text-emerald-800"}
                                `}
                              >
                                {t}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                      {pickupTime && (
                        <div className="mt-2 flex items-center gap-2 px-1">
                          <i className="fas fa-arrow-right-from-bracket text-[10px] text-emerald-500" />
                          <span className="text-xs font-semibold text-neutral-700">Pick-up: {pickupTime}</span>
                        </div>
                      )}
                    </div>
                  )}
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
                      <label className="block text-[11px] font-bold text-neutral-400 uppercase tracking-wider mb-2">Email <span className="text-red-400">*</span></label>
                      <input type="email" value={customerEmail} onChange={(e) => setCustomerEmail(e.target.value)} placeholder="john@example.com" required
                        className="w-full border-2 border-neutral-200 hover:border-neutral-300 rounded-xl px-4 py-3 text-sm focus:ring-0 focus:border-neutral-900 transition-all outline-none bg-neutral-50/50 placeholder:text-neutral-300 font-medium" />
                    </div>
                    {/* Vehicle block */}
                    <div className="space-y-4 rounded-xl border-2 border-neutral-200/80 p-4 bg-neutral-50/30">
                      <h5 className="text-[11px] font-bold text-neutral-400 uppercase tracking-wider flex items-center gap-2">
                        <i className="fas fa-car" />
                        Vehicle details
                      </h5>
                      {customer && customerVehicles.length > 0 && (
                        <div>
                          <label className="block text-[11px] font-bold text-neutral-400 uppercase tracking-wider mb-2">Select vehicle or add new</label>
                          <div className="relative">
                            <select
                              value={selectedVehicleId}
                              onChange={(e) => handleSelectVehicle(e.target.value as string | "new")}
                              className="w-full appearance-none border-2 border-neutral-200 hover:border-neutral-300 rounded-xl px-4 pr-10 py-3 text-sm focus:ring-0 focus:border-neutral-900 transition-all outline-none bg-white font-medium"
                            >
                              <option value="new">Add new vehicle</option>
                              {customerVehicles.map((v) => (
                                <option key={v.id} value={v.id}>
                                  {[v.registrationNumber, v.make, v.model, v.year].filter(Boolean).join(" ") || "Vehicle"} {v.bodyType ? `(${v.bodyType})` : ""}
                                </option>
                              ))}
                            </select>
                            <i className="fas fa-chevron-down pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-neutral-400" />
                          </div>
                        </div>
                      )}
                      {customer && (
                        <div className="flex items-center justify-between gap-2 mb-2">
                          <p className="text-[10px] text-neutral-500">
                            <i className="fas fa-info-circle mr-1" /> All vehicle fields are optional. Add at least one identifier (e.g. registration, make/model).
                          </p>
                          <button type="button" onClick={openAddVehicle} className="text-[10px] font-semibold text-neutral-600 hover:text-neutral-900 shrink-0">
                            <i className="fas fa-plus mr-1" />Add vehicle
                          </button>
                        </div>
                      )}
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                        <div>
                          <label className="block text-[11px] font-bold text-neutral-400 uppercase tracking-wider mb-2">Make <span className="text-neutral-300 text-[10px] font-normal lowercase">(optional)</span></label>
                          <input type="text" value={vehicleMake} onChange={(e) => setVehicleMake(e.target.value)} placeholder="e.g. Toyota, Honda"
                            className="w-full border-2 border-neutral-200 hover:border-neutral-300 rounded-xl px-4 py-3 text-sm focus:ring-0 focus:border-neutral-900 transition-all outline-none bg-white placeholder:text-neutral-300 font-medium" />
                        </div>
                        <div>
                          <label className="block text-[11px] font-bold text-neutral-400 uppercase tracking-wider mb-2">Model <span className="text-neutral-300 text-[10px] font-normal lowercase">(optional)</span></label>
                          <input type="text" value={vehicleModel} onChange={(e) => setVehicleModel(e.target.value)} placeholder="e.g. Camry, Civic"
                            className="w-full border-2 border-neutral-200 hover:border-neutral-300 rounded-xl px-4 py-3 text-sm focus:ring-0 focus:border-neutral-900 transition-all outline-none bg-white placeholder:text-neutral-300 font-medium" />
                        </div>
                        <div>
                          <label className="block text-[11px] font-bold text-neutral-400 uppercase tracking-wider mb-2">Year <span className="text-neutral-300 text-[10px] font-normal lowercase">(optional)</span></label>
                          <input type="text" value={vehicleYear} onChange={(e) => setVehicleYear(e.target.value)} placeholder="e.g. 2020"
                            className="w-full border-2 border-neutral-200 hover:border-neutral-300 rounded-xl px-4 py-3 text-sm focus:ring-0 focus:border-neutral-900 transition-all outline-none bg-white placeholder:text-neutral-300 font-medium" />
                        </div>
                      </div>
                      <div>
                        <label className="block text-[11px] font-bold text-neutral-400 uppercase tracking-wider mb-2">Registration number <span className="text-neutral-300 text-[10px] font-normal lowercase">(optional)</span></label>
                        <input type="text" value={vehicleNumber} onChange={(e) => setVehicleNumber(e.target.value)} placeholder="e.g. ABC 123"
                          className="w-full border-2 border-neutral-200 hover:border-neutral-300 rounded-xl px-4 py-3 text-sm focus:ring-0 focus:border-neutral-900 transition-all outline-none bg-white placeholder:text-neutral-300 font-medium" />
                      </div>
                      <div>
                        <label className="block text-[11px] font-bold text-neutral-400 uppercase tracking-wider mb-2">Mileage <span className="text-neutral-300 text-[10px] font-normal lowercase">(optional)</span></label>
                        <input type="text" value={vehicleMileage} onChange={(e) => setVehicleMileage(e.target.value)} placeholder="e.g. 45000 km"
                          className="w-full border-2 border-neutral-200 hover:border-neutral-300 rounded-xl px-4 py-3 text-sm focus:ring-0 focus:border-neutral-900 transition-all outline-none bg-white placeholder:text-neutral-300 font-medium" />
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div>
                          <label className="block text-[11px] font-bold text-neutral-400 uppercase tracking-wider mb-2">Body type <span className="text-neutral-300 text-[10px] font-normal lowercase">(optional)</span></label>
                          <input type="text" value={vehicleBodyType} onChange={(e) => setVehicleBodyType(e.target.value)} placeholder="e.g. Sedan, SUV"
                            className="w-full border-2 border-neutral-200 hover:border-neutral-300 rounded-xl px-4 py-3 text-sm focus:ring-0 focus:border-neutral-900 transition-all outline-none bg-white placeholder:text-neutral-300 font-medium" />
                        </div>
                        <div>
                          <label className="block text-[11px] font-bold text-neutral-400 uppercase tracking-wider mb-2">Colour <span className="text-neutral-300 text-[10px] font-normal lowercase">(optional)</span></label>
                          <input type="text" value={vehicleColour} onChange={(e) => setVehicleColour(e.target.value)} placeholder="e.g. White, Black"
                            className="w-full border-2 border-neutral-200 hover:border-neutral-300 rounded-xl px-4 py-3 text-sm focus:ring-0 focus:border-neutral-900 transition-all outline-none bg-white placeholder:text-neutral-300 font-medium" />
                        </div>
                      </div>
                      <div>
                        <label className="block text-[11px] font-bold text-neutral-400 uppercase tracking-wider mb-2">VIN / Chassis <span className="text-neutral-300 text-[10px] font-normal lowercase">(optional)</span></label>
                        <input type="text" value={vehicleVinChassis} onChange={(e) => setVehicleVinChassis(e.target.value)} placeholder="e.g. 1HGBH41JXMN109186"
                          className="w-full border-2 border-neutral-200 hover:border-neutral-300 rounded-xl px-4 py-3 text-sm focus:ring-0 focus:border-neutral-900 transition-all outline-none bg-white placeholder:text-neutral-300 font-medium" />
                      </div>
                      <div>
                        <label className="block text-[11px] font-bold text-neutral-400 uppercase tracking-wider mb-2">Engine number <span className="text-neutral-300 text-[10px] font-normal lowercase">(optional)</span></label>
                        <input type="text" value={vehicleEngineNumber} onChange={(e) => setVehicleEngineNumber(e.target.value)} placeholder="e.g. ABC123456"
                          className="w-full border-2 border-neutral-200 hover:border-neutral-300 rounded-xl px-4 py-3 text-sm focus:ring-0 focus:border-neutral-900 transition-all outline-none bg-white placeholder:text-neutral-300 font-medium" />
                      </div>
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
                        <div className="flex items-center justify-between flex-1 min-w-0">
                          <span className="font-medium text-neutral-700 text-xs">{selectedBranch?.name}</span>
                          <span className="text-xs font-bold text-amber-600 bg-amber-50 px-2.5 py-1 rounded-lg flex items-center gap-1.5">
                            <i className="fas fa-clock text-[10px]" />
                            {branchCurrentTime}
                          </span>
                        </div>
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
                          <div className="w-7 h-7 rounded-lg bg-amber-50 flex items-center justify-center flex-shrink-0">
                            <i className="fas fa-arrow-right-to-bracket text-amber-500 text-[10px]" />
                          </div>
                          <span className="text-neutral-600 text-xs">Drop-off: <span className="font-semibold text-neutral-700">{time}</span></span>
                        </div>
                      )}
                      {pickupTime && (
                        <div className="flex items-center gap-2.5 text-sm">
                          <div className="w-7 h-7 rounded-lg bg-emerald-50 flex items-center justify-center flex-shrink-0">
                            <i className="fas fa-arrow-right-from-bracket text-emerald-500 text-[10px]" />
                          </div>
                          <span className="text-neutral-600 text-xs">Pick-up: <span className="font-semibold text-neutral-700">{pickupTime}</span></span>
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
                      onClick={!customer ? () => setShowAuth(true) : handleSubmit}
                      disabled={submitting || (!!customer && (!customerName || !customerPhone || !customerEmail?.trim() || (!vehicleNumber?.trim() && !vehicleMake?.trim() && !vehicleModel?.trim()) || !date || !time || !pickupTime))}
                      className={`w-full mt-5 font-bold py-3.5 rounded-xl transition-all text-sm relative overflow-hidden group ${
                        !customer
                          ? "bg-amber-500 text-neutral-900 hover:bg-amber-400 active:scale-[0.98] shadow-xl shadow-amber-500/20"
                          : submitting || !customerName || !customerPhone || !customerEmail?.trim() || (!vehicleNumber?.trim() && !vehicleMake?.trim() && !vehicleModel?.trim()) || !date || !time || !pickupTime
                            ? "bg-neutral-200 text-neutral-400 cursor-not-allowed"
                            : "bg-neutral-900 text-white hover:bg-neutral-800 active:scale-[0.98] shadow-xl shadow-neutral-900/15"
                      }`}
                    >
                      {customer && !(submitting || !customerName || !customerPhone || !customerEmail?.trim() || (!vehicleNumber?.trim() && !vehicleMake?.trim() && !vehicleModel?.trim()) || !date || !time || !pickupTime) && (
                        <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/[0.06] to-transparent group-hover:animate-[shimmerBg_1.5s_linear_infinite]" style={{ backgroundSize: "200% 100%" }} />
                      )}
                      <span className="relative z-10 flex items-center justify-center gap-2">
                        {!customer ? (
                          <>
                            <i className="fas fa-arrow-right-to-bracket text-xs" />
                            Sign in to Book
                          </>
                        ) : submitting ? (
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
                      <p className="text-[10px] font-bold text-neutral-400 uppercase tracking-wider">Drop-off</p>
                      <p className="text-sm font-semibold text-neutral-900 mt-1">{time}</p>
                    </div>
                    <div>
                      <p className="text-[10px] font-bold text-neutral-400 uppercase tracking-wider">Pick-up</p>
                      <p className="text-sm font-semibold text-neutral-900 mt-1">{pickupTime}</p>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4 mt-4">
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
                  setStep(1); setSelectedBranch(null); setSelectedServices([]); setDate(""); setTime(""); setPickupTime(""); setNotes(""); setBookingResult(null); setShowConfetti(false);
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
                              <p className="text-[9px] font-bold text-neutral-400 uppercase tracking-wider mb-0.5">Drop-off</p>
                              <p className="text-[11px] font-bold text-neutral-800">{bk.time}</p>
                            </div>
                            {bk.pickupTime && (
                              <div className="bg-emerald-50 rounded-xl px-3 py-2.5">
                                <p className="text-[9px] font-bold text-emerald-500 uppercase tracking-wider mb-0.5">Pick-up</p>
                                <p className="text-[11px] font-bold text-emerald-800">{bk.pickupTime}</p>
                              </div>
                            )}
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

                          {/* Additional Issues - only admin-approved (priced) issues shown to customer for approval */}
                          {bk.additionalIssues && (() => {
                            const approvedIssues = bk.additionalIssues.filter((i) => i.status === "approved");
                            if (approvedIssues.length === 0) return null;
                            return (
                            <div className="mt-4 rounded-xl border border-amber-200/80 bg-gradient-to-br from-amber-50/80 to-orange-50/50 p-4">
                              <div className="flex items-center gap-2 mb-3">
                                <div className="w-6 h-6 rounded-lg bg-amber-500/20 flex items-center justify-center">
                                  <i className="fas fa-wrench text-amber-600 text-[10px]" />
                                </div>
                                <span className="text-[11px] font-bold text-neutral-800">Additional Work Found</span>
                              </div>
                              <div className="space-y-3">
                                {approvedIssues.map((issue) => (
                                  <div key={issue.id} className="bg-white/80 rounded-lg border border-amber-100 p-3">
                                    <p className="text-[11px] font-bold text-neutral-900">{issue.issueTitle}</p>
                                    {issue.description && <p className="text-[10px] text-neutral-600 mt-1">{issue.description}</p>}
                                    {(issue.imageUrl || issue.image) && (
                                      <div className="mt-2 rounded-lg overflow-hidden border border-neutral-200/80 shrink-0" style={{ width: 48, height: 56 }}>
                                        <img
                                          src={(issue.imageUrl || issue.image) as string}
                                          alt={issue.issueTitle || "Additional work"}
                                          width={48}
                                          height={56}
                                          className="block w-full h-full object-cover cursor-pointer hover:opacity-90 transition-opacity"
                                          style={{ maxWidth: 48, maxHeight: 56 }}
                                          onClick={() => setLightboxUrl((issue.imageUrl || issue.image) as string)}
                                        />
                                      </div>
                                    )}
                                    {issue.price != null && (
                                      <p className="text-[11px] font-bold text-amber-700 mt-1.5">Cost: ${issue.price.toFixed(2)}</p>
                                    )}
                                    {issue.status === "approved" && !issue.customerResponse ? (
                                      <div className="flex gap-2 mt-3">
                                        <button
                                          onClick={() => handleAdditionalIssueResponse(bk.id, issue.id, "accept")}
                                          disabled={additionalIssueResponding[`${bk.id}-${issue.id}`]}
                                          className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[10px] font-bold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-60 transition-all"
                                        >
                                          {additionalIssueResponding[`${bk.id}-${issue.id}`] ? <i className="fas fa-spinner fa-spin" /> : <i className="fas fa-check" />}
                                          Accept
                                        </button>
                                        <button
                                          onClick={() => handleAdditionalIssueResponse(bk.id, issue.id, "reject")}
                                          disabled={additionalIssueResponding[`${bk.id}-${issue.id}`]}
                                          className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[10px] font-bold bg-neutral-200 text-neutral-700 hover:bg-neutral-300 disabled:opacity-60 transition-all"
                                        >
                                          {additionalIssueResponding[`${bk.id}-${issue.id}`] ? <i className="fas fa-spinner fa-spin" /> : <i className="fas fa-times" />}
                                          Decline
                                        </button>
                                      </div>
                                    ) : (issue.customerResponse === "accept" || String(issue.customerResponse) === "accepted") ? (
                                      <span className="inline-flex items-center gap-1 mt-2 px-2 py-1 rounded-lg text-[10px] font-bold bg-emerald-100 text-emerald-700">
                                        <i className="fas fa-check" /> Accepted
                                      </span>
                                    ) : (issue.customerResponse === "reject" || String(issue.customerResponse) === "rejected") ? (
                                      <span className="inline-flex items-center gap-1 mt-2 px-2 py-1 rounded-lg text-[10px] font-bold bg-rose-100 text-rose-700">
                                        <i className="fas fa-times" /> Declined
                                      </span>
                                    ) : issue.status === "rejected" ? (
                                      <span className="inline-flex items-center gap-1 mt-2 px-2 py-1 rounded-lg text-[10px] font-bold bg-neutral-100 text-neutral-600">
                                        Not approved by workshop
                                      </span>
                                    ) : (
                                      <span className="inline-flex items-center gap-1 mt-2 px-2 py-1 rounded-lg text-[10px] font-bold bg-amber-100 text-amber-700">
                                        Awaiting quote
                                      </span>
                                    )}
                                  </div>
                                ))}
                              </div>
                            </div>
                            );
                          })()}

                          {bk.status === "Completed" && (
                            <div className="mt-3">
                              <button
                                onClick={() => requestDownloadBookingPdf(bk)}
                                disabled={downloadingBookingId === bk.id}
                                className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg text-[11px] font-bold bg-neutral-900 text-white hover:bg-neutral-800 disabled:opacity-60 disabled:cursor-not-allowed transition-all"
                              >
                                <i className={`fas ${downloadingBookingId === bk.id ? "fa-spinner fa-spin" : "fa-file-pdf"} text-[10px]`} />
                                {downloadingBookingId === bk.id ? "Generating..." : "Download Job Report"}
                              </button>
                            </div>
                          )}

                          {/* ─── Task Progress Bar ─────────────────────────── */}
                          {bk.tasks && bk.tasks.length > 0 && (() => {
                            const doneCount = bk.tasks.filter(t => t.done).length;
                            const totalCount = bk.tasks.length;
                            const pct = bk.taskProgress || 0;
                            const isComplete = pct === 100;
                            return (
                            <div className="mt-4">
                              <button
                                onClick={() => setExpandedBookingId(expandedBookingId === bk.id ? null : bk.id)}
                                className="w-full text-left group"
                              >
                                {/* Creative progress card */}
                                <div className={`relative rounded-2xl border p-4 transition-all duration-500 overflow-hidden ${
                                  isComplete
                                    ? "bg-gradient-to-br from-emerald-50 via-green-50 to-teal-50 border-emerald-200/80"
                                    : "bg-gradient-to-br from-neutral-50 via-white to-neutral-50/80 border-neutral-200/80"
                                }`}>
                                  {/* Decorative background glow */}
                                  {isComplete && (
                                    <div className="absolute top-0 right-0 w-24 h-24 bg-emerald-400/10 rounded-full blur-2xl -translate-y-6 translate-x-6" />
                                  )}

                                  {/* Header row */}
                                  <div className="flex items-center justify-between mb-3 relative z-10">
                                    <div className="flex items-center gap-2">
                                      <div className={`w-7 h-7 rounded-lg flex items-center justify-center ${
                                        isComplete
                                          ? "bg-emerald-500 shadow-md shadow-emerald-500/25"
                                          : "bg-neutral-900 shadow-md shadow-neutral-900/15"
                                      }`}>
                                        <i className={`fas ${isComplete ? "fa-check-double" : "fa-tasks"} text-white text-[10px]`} />
                                      </div>
                                      <div>
                                        <span className="text-[11px] font-extrabold text-neutral-800 tracking-tight">Service Progress</span>
                                        <p className="text-[9px] text-neutral-400 font-medium -mt-0.5">
                                          {isComplete ? "All tasks completed" : `${totalCount - doneCount} task${totalCount - doneCount !== 1 ? "s" : ""} remaining`}
                                        </p>
                                      </div>
                                    </div>
                                    <div className="flex items-center gap-2">
                                      {/* Circular percentage */}
                                      <div className="relative w-10 h-10">
                                        <svg className="w-10 h-10 -rotate-90" viewBox="0 0 36 36">
                                          <circle cx="18" cy="18" r="14" fill="none" stroke={isComplete ? "#d1fae5" : "#f5f5f5"} strokeWidth="3" />
                                          <circle
                                            cx="18" cy="18" r="14" fill="none"
                                            stroke={isComplete ? "#10b981" : pct > 50 ? "#f59e0b" : "#3b82f6"}
                                            strokeWidth="3"
                                            strokeLinecap="round"
                                            strokeDasharray={`${pct * 0.88} 88`}
                                            className="transition-all duration-1000 ease-out"
                                          />
                                        </svg>
                                        <span className={`absolute inset-0 flex items-center justify-center text-[9px] font-black ${
                                          isComplete ? "text-emerald-600" : "text-neutral-700"
                                        }`}>
                                          {pct}%
                                        </span>
                                      </div>
                                      <i className={`fas fa-chevron-down text-[9px] text-neutral-400 transition-transform duration-300 ${expandedBookingId === bk.id ? "rotate-180" : ""}`} />
                                    </div>
                                  </div>

                                  {/* Segmented step dots */}
                                  <div className="flex items-center gap-1 relative z-10">
                                    {bk.tasks.map((task, i) => (
                                      <div key={task.id || i} className="flex-1 flex items-center">
                                        <div
                                          className={`w-full h-2 rounded-full transition-all duration-500 ${
                                            task.done
                                              ? isComplete
                                                ? "bg-gradient-to-r from-emerald-400 to-emerald-500 shadow-sm shadow-emerald-500/20"
                                                : "bg-gradient-to-r from-amber-400 to-amber-500 shadow-sm shadow-amber-500/20"
                                              : "bg-neutral-200/80"
                                          }`}
                                          style={{ animationDelay: `${i * 100}ms` }}
                                        />
                                      </div>
                                    ))}
                                  </div>

                                  {/* Step labels */}
                                  <div className="flex items-center justify-between mt-2.5 relative z-10">
                                    <span className="text-[10px] font-bold text-neutral-500">
                                      <span className={`${isComplete ? "text-emerald-600" : "text-neutral-800"} text-xs`}>{doneCount}</span>
                                      <span className="text-neutral-400">/{totalCount} tasks</span>
                                    </span>
                                    {isComplete ? (
                                      <span className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-600 bg-emerald-100 px-2 py-0.5 rounded-full">
                                        <i className="fas fa-sparkles text-[8px]" />
                                        Complete
                                      </span>
                                    ) : (
                                      <span className="text-[10px] font-medium text-neutral-400 group-hover:text-neutral-600 transition-colors">
                                        Tap to view details <i className="fas fa-chevron-right text-[7px] ml-0.5" />
                                      </span>
                                    )}
                                  </div>
                                </div>
                              </button>

                              {/* Expanded task list */}
                              {expandedBookingId === bk.id && (
                                <div className="mt-3 space-y-2 animate-[fadeSlideUp_0.3s_ease-out]">
                                  {bk.tasks.map((task, tIdx) => (
                                    <div
                                      key={task.id || tIdx}
                                      className={`rounded-xl border p-3 transition-all ${
                                        task.done
                                          ? "bg-emerald-50/60 border-emerald-200/80"
                                          : "bg-neutral-50 border-neutral-200/80"
                                      }`}
                                    >
                                      <div className="flex items-start gap-2.5">
                                        {/* Checkbox indicator */}
                                        <div className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 mt-0.5 ${
                                          task.done ? "bg-emerald-500 text-white" : "bg-neutral-200 text-neutral-400"
                                        }`}>
                                          {task.done ? (
                                            <i className="fas fa-check text-[8px]" />
                                          ) : (
                                            <span className="text-[9px] font-bold">{tIdx + 1}</span>
                                          )}
                                        </div>
                                        <div className="flex-1 min-w-0">
                                          <div className="flex items-center justify-between gap-2">
                                            <p className={`text-xs font-semibold ${task.done ? "text-emerald-700" : "text-neutral-800"}`}>
                                              {task.name}
                                            </p>
                                            {task.done && (
                                              <span className="text-[9px] font-bold text-emerald-600 bg-emerald-100 px-1.5 py-0.5 rounded-full shrink-0">
                                                Done
                                              </span>
                                            )}
                                          </div>
                                          {task.description && (
                                            <p className="text-[11px] text-neutral-500 mt-0.5 leading-relaxed">{task.description}</p>
                                          )}
                                          {task.serviceName && (
                                            <p className="text-[10px] text-neutral-400 mt-1">
                                              <i className="fas fa-wrench mr-1 text-[8px]" />{task.serviceName}
                                            </p>
                                          )}
                                          {/* Staff note */}
                                          {task.staffNote && (
                                            <div className="mt-2 p-2 bg-blue-50 rounded-lg border border-blue-100">
                                              <p className="text-[11px] text-blue-700">
                                                <i className="fas fa-comment-alt mr-1 text-[9px]" />
                                                {task.staffNote}
                                              </p>
                                              {task.completedByStaffName && (
                                                <p className="text-[10px] text-blue-500 mt-0.5">— {task.completedByStaffName}</p>
                                              )}
                                            </div>
                                          )}
                                          {/* Task completion image */}
                                          {task.done && task.imageUrl && (
                                            <div className="mt-2">
                                              <button
                                                type="button"
                                                onClick={() => setLightboxUrl(task.imageUrl)}
                                                className="group relative rounded-xl overflow-hidden border border-neutral-200 hover:border-neutral-300 transition-all hover:shadow-md"
                                              >
                                                <img
                                                  src={task.imageUrl}
                                                  alt={`${task.name} — completed`}
                                                  className="w-full max-h-40 object-cover"
                                                />
                                                <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors flex items-center justify-center">
                                                  <span className="opacity-0 group-hover:opacity-100 transition-opacity bg-white/90 backdrop-blur-sm text-neutral-700 text-[10px] font-semibold px-2.5 py-1 rounded-full shadow-sm">
                                                    <i className="fas fa-expand mr-1 text-[8px]" />View
                                                  </span>
                                                </div>
                                              </button>
                                            </div>
                                          )}
                                        </div>
                                      </div>
                                    </div>
                                  ))}

                                  {/* Final Submission */}
                                  {bk.finalSubmission && (
                                    <div className="rounded-xl border border-indigo-200 bg-indigo-50/60 p-3 mt-2">
                                      <div className="flex items-center gap-2 mb-2">
                                        <div className="w-5 h-5 rounded-full bg-indigo-500 text-white flex items-center justify-center">
                                          <i className="fas fa-flag-checkered text-[8px]" />
                                        </div>
                                        <span className="text-xs font-bold text-indigo-700">Final Submission</span>
                                        {bk.finalSubmission.submittedByStaffName && (
                                          <span className="text-[10px] text-indigo-500 ml-auto">
                                            by {bk.finalSubmission.submittedByStaffName}
                                          </span>
                                        )}
                                      </div>
                                      {bk.finalSubmission.description && (
                                        <p className="text-[11px] text-indigo-800 leading-relaxed">{bk.finalSubmission.description}</p>
                                      )}
                                      {bk.finalSubmission.imageUrl && (
                                        <div className="mt-2">
                                          <button
                                            type="button"
                                            onClick={() => setLightboxUrl(bk.finalSubmission!.imageUrl)}
                                            className="group relative rounded-xl overflow-hidden border border-indigo-200 hover:border-indigo-300 transition-all hover:shadow-md"
                                          >
                                            <img
                                              src={bk.finalSubmission.imageUrl}
                                              alt="Final submission"
                                              className="w-full max-h-48 object-cover"
                                            />
                                            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors flex items-center justify-center">
                                              <span className="opacity-0 group-hover:opacity-100 transition-opacity bg-white/90 backdrop-blur-sm text-indigo-700 text-[10px] font-semibold px-2.5 py-1 rounded-full shadow-sm">
                                                <i className="fas fa-expand mr-1 text-[8px]" />View
                                              </span>
                                            </div>
                                          </button>
                                        </div>
                                      )}
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                            );
                          })()}
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

      {/* ═══════════════════ IMAGE LIGHTBOX ═══════════════════ */}
      {lightboxUrl && (
        <div
          className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[60] flex items-center justify-center p-4 animate-[fadeIn_0.15s_ease-out]"
          onClick={() => setLightboxUrl(null)}
        >
          <div className="relative max-w-md w-full max-h-[70vh] animate-[modalPop_0.3s_ease-out]" onClick={(e) => e.stopPropagation()}>
            <button
              onClick={() => setLightboxUrl(null)}
              className="absolute -top-3 -right-3 z-10 w-8 h-8 rounded-full bg-white shadow-lg flex items-center justify-center text-neutral-600 hover:text-neutral-900 hover:scale-110 transition-all"
            >
              <i className="fas fa-times text-sm" />
            </button>
            <img
              src={lightboxUrl}
              alt="Task completion"
              className="w-full max-h-[70vh] object-contain rounded-2xl shadow-2xl"
            />
          </div>
        </div>
      )}

      {/* ═══════════════════ PDF DOWNLOAD CONFIRM ═══════════════════ */}
      {pdfConfirmBooking && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[70] flex items-center justify-center p-4 animate-[fadeIn_0.15s_ease-out]">
          <div className="w-full max-w-sm bg-white rounded-2xl border border-neutral-200 shadow-2xl overflow-hidden animate-[modalPop_0.22s_ease-out]">
            <div className="h-1 bg-gradient-to-r from-neutral-800 via-neutral-700 to-neutral-800" />
            <div className="p-5">
              <div className="w-11 h-11 rounded-xl bg-neutral-100 flex items-center justify-center mb-3">
                <i className="fas fa-file-pdf text-neutral-700" />
              </div>
              <h3 className="text-sm font-extrabold text-neutral-900">Download job report?</h3>
              <p className="text-xs text-neutral-500 mt-1 leading-relaxed">
                This will generate and download the PDF for booking{" "}
                <span className="font-semibold text-neutral-700">{pdfConfirmBooking.bookingCode || pdfConfirmBooking.id}</span>.
              </p>
            </div>
            <div className="grid grid-cols-2 border-t border-neutral-100">
              <button
                onClick={() => setPdfConfirmBooking(null)}
                className="px-4 py-3 text-xs font-bold text-neutral-600 hover:bg-neutral-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  const target = pdfConfirmBooking;
                  setPdfConfirmBooking(null);
                  if (target) await downloadBookingPdf(target);
                }}
                className="px-4 py-3 text-xs font-bold text-white bg-neutral-900 hover:bg-neutral-800 transition-colors"
              >
                Download
              </button>
            </div>
          </div>
        </div>
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

      {/* ═══════════════════ ESTIMATE VIEW ═══════════════════ */}
      {activeView === "estimate" && (
        <main className="flex-1 max-w-4xl mx-auto px-4 sm:px-6 py-8 sm:py-10 w-full relative z-10">
          <div className="animate-[fadeSlideUp_0.4s_ease-out]">
            <button
              onClick={() => setActiveView("booking")}
              className="flex items-center gap-2 text-sm text-neutral-500 hover:text-neutral-800 font-medium mb-6 transition-colors"
            >
              <i className="fas fa-arrow-left text-xs" />
              Back to Booking
            </button>
            {estimateSuccess ? (
              <div className="max-w-lg mx-auto text-center py-16">
                <div className="w-20 h-20 mx-auto mb-6 bg-emerald-100 rounded-full flex items-center justify-center">
                  <i className="fas fa-check text-3xl text-emerald-600" />
                </div>
                <h3 className="text-2xl font-bold text-neutral-900 mb-2">Estimate Request Sent!</h3>
                <p className="text-neutral-500 text-sm mb-8">
                  Thank you for your request. We&apos;ll review your details and get back to you with an estimate as soon as possible.
                </p>
                <button
                  onClick={() => { setEstimateSuccess(false); setEstimateError(""); setEstimateFieldErrors({}); setEstimateName(""); setEstimatePhone(""); setEstimateEmail(""); setEstimateVehicleMake(""); setEstimateVehicleModel(""); setEstimateVehicleYear(""); setEstimateRego(""); setEstimateMileage(""); setEstimateDescription(""); setEstimateBranch(null); setActiveView("booking"); }}
                  className="bg-neutral-900 text-white font-bold text-sm px-6 py-3 rounded-xl hover:bg-neutral-800 transition-all shadow-lg shadow-neutral-900/15"
                >
                  Back to Booking
                </button>
              </div>
            ) : (
              <>
                <div className="mb-8">
                  <h3 className="text-xl sm:text-2xl font-bold text-neutral-900 tracking-tight">Request an Estimate</h3>
                  <p className="text-neutral-500 text-sm mt-1">Tell us about your vehicle and what you need — we&apos;ll get back to you with a quote.</p>
                </div>

                {!customer && (
                  <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 sm:p-5 flex items-center gap-4 mb-6">
                    <div className="w-10 h-10 rounded-xl bg-amber-100 flex items-center justify-center flex-shrink-0">
                      <i className="fas fa-lock text-amber-600 text-sm" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-bold text-amber-900">Sign in required to book</p>
                      <p className="text-xs text-amber-700 mt-0.5">Please sign in or create an account to submit an estimate request</p>
                    </div>
                    <button type="button" onClick={() => setShowAuth(true)} className="bg-neutral-900 text-white text-xs font-bold px-4 py-2.5 rounded-xl hover:bg-neutral-800 transition-all flex-shrink-0 shadow-sm">
                      Sign in
                    </button>
                  </div>
                )}

                <form onSubmit={handleEstimateSubmit} className="space-y-6">
                  {/* Contact Information */}
                  <div className="bg-white rounded-2xl border border-neutral-200 shadow-sm p-5 sm:p-6">
                    <div className="flex items-center gap-2 mb-4">
                      <div className="w-8 h-8 rounded-lg bg-neutral-900 flex items-center justify-center">
                        <i className="fas fa-user text-white text-xs" />
                      </div>
                      <h4 className="font-bold text-neutral-900 text-sm">Contact Information</h4>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-[11px] font-semibold text-neutral-500 mb-1.5">Full Name <span className="text-red-400">*</span></label>
                        <input type="text" required value={estimateName} onChange={(e) => { setEstimateName(e.target.value); setEstimateFieldErrors((p) => ({ ...p, name: "" })); }} placeholder="John Smith"
                          className={`w-full border-2 rounded-xl px-3.5 py-2.5 text-sm focus:ring-0 transition-all outline-none font-medium placeholder:text-neutral-300 ${estimateFieldErrors.name ? "border-red-400 bg-red-50/50" : "border-neutral-200 hover:border-neutral-300 bg-neutral-50/50 focus:border-neutral-900"}`} />
                        {estimateFieldErrors.name && <p className="text-xs text-red-500 mt-1">{estimateFieldErrors.name}</p>}
                      </div>
                      <div>
                        <label className="block text-[11px] font-semibold text-neutral-500 mb-1.5">Phone <span className="text-red-400">*</span></label>
                        <input type="tel" required value={estimatePhone} onChange={(e) => { const v = e.target.value.replace(/[^\d\s+\-()]/g, ""); setEstimatePhone(v); setEstimateFieldErrors((p) => ({ ...p, phone: "" })); }} placeholder="0412 345 678"
                          className={`w-full border-2 rounded-xl px-3.5 py-2.5 text-sm focus:ring-0 transition-all outline-none font-medium placeholder:text-neutral-300 ${estimateFieldErrors.phone ? "border-red-400 bg-red-50/50" : "border-neutral-200 hover:border-neutral-300 bg-neutral-50/50 focus:border-neutral-900"}`} />
                        {estimateFieldErrors.phone && <p className="text-xs text-red-500 mt-1">{estimateFieldErrors.phone}</p>}
                      </div>
                      <div className="sm:col-span-2">
                        <label className="block text-[11px] font-semibold text-neutral-500 mb-1.5">Email <span className="text-red-400">*</span></label>
                        <input type="email" required value={estimateEmail} onChange={(e) => { setEstimateEmail(e.target.value); setEstimateFieldErrors((p) => ({ ...p, email: "" })); }} placeholder="john@email.com"
                          className={`w-full border-2 rounded-xl px-3.5 py-2.5 text-sm focus:ring-0 transition-all outline-none font-medium placeholder:text-neutral-300 ${estimateFieldErrors.email ? "border-red-400 bg-red-50/50" : "border-neutral-200 hover:border-neutral-300 bg-neutral-50/50 focus:border-neutral-900"}`} />
                        {estimateFieldErrors.email && <p className="text-xs text-red-500 mt-1">{estimateFieldErrors.email}</p>}
                      </div>
                    </div>
                  </div>

                  {/* Vehicle Details */}
                  <div className="bg-white rounded-2xl border border-neutral-200 shadow-sm p-5 sm:p-6">
                    <div className="flex items-center gap-2 mb-4">
                      <div className="w-8 h-8 rounded-lg bg-neutral-900 flex items-center justify-center">
                        <i className="fas fa-car text-white text-xs" />
                      </div>
                      <h4 className="font-bold text-neutral-900 text-sm">Vehicle Details</h4>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                      <div>
                        <label className="block text-[11px] font-semibold text-neutral-500 mb-1.5">Make</label>
                        <input type="text" value={estimateVehicleMake} onChange={(e) => setEstimateVehicleMake(e.target.value)} placeholder="Toyota"
                          className="w-full border-2 border-neutral-200 hover:border-neutral-300 rounded-xl px-3.5 py-2.5 text-sm focus:ring-0 focus:border-neutral-900 transition-all outline-none bg-neutral-50/50 placeholder:text-neutral-300 font-medium" />
                      </div>
                      <div>
                        <label className="block text-[11px] font-semibold text-neutral-500 mb-1.5">Model</label>
                        <input type="text" value={estimateVehicleModel} onChange={(e) => setEstimateVehicleModel(e.target.value)} placeholder="Camry"
                          className="w-full border-2 border-neutral-200 hover:border-neutral-300 rounded-xl px-3.5 py-2.5 text-sm focus:ring-0 focus:border-neutral-900 transition-all outline-none bg-neutral-50/50 placeholder:text-neutral-300 font-medium" />
                      </div>
                      <div>
                        <label className="block text-[11px] font-semibold text-neutral-500 mb-1.5">Year</label>
                        <input type="text" inputMode="numeric" value={estimateVehicleYear} onChange={(e) => { const v = e.target.value.replace(/\D/g, "").slice(0, 4); setEstimateVehicleYear(v); setEstimateFieldErrors((p) => ({ ...p, year: "" })); }} placeholder="2024"
                          className={`w-full border-2 rounded-xl px-3.5 py-2.5 text-sm focus:ring-0 transition-all outline-none font-medium placeholder:text-neutral-300 ${estimateFieldErrors.year ? "border-red-400 bg-red-50/50" : "border-neutral-200 hover:border-neutral-300 bg-neutral-50/50 focus:border-neutral-900"}`} />
                        {estimateFieldErrors.year && <p className="text-xs text-red-500 mt-1">{estimateFieldErrors.year}</p>}
                      </div>
                      <div className="sm:col-span-3">
                        <label className="block text-[11px] font-semibold text-neutral-500 mb-1.5">Registration Number</label>
                        <input type="text" value={estimateRego} onChange={(e) => setEstimateRego(e.target.value)} placeholder="ABC 123"
                          className="w-full border-2 border-neutral-200 hover:border-neutral-300 rounded-xl px-3.5 py-2.5 text-sm focus:ring-0 focus:border-neutral-900 transition-all outline-none bg-neutral-50/50 placeholder:text-neutral-300 font-medium" />
                      </div>
                      <div className="sm:col-span-3">
                        <label className="block text-[11px] font-semibold text-neutral-500 mb-1.5">Mileage</label>
                        <div className="flex items-center gap-2">
                          <input type="text" inputMode="numeric" value={estimateMileage} onChange={(e) => { const v = e.target.value.replace(/\D/g, ""); setEstimateMileage(v); setEstimateFieldErrors((p) => ({ ...p, mileage: "" })); }} placeholder="e.g. 45000"
                            className={`flex-1 border-2 rounded-xl px-3.5 py-2.5 text-sm focus:ring-0 transition-all outline-none font-medium placeholder:text-neutral-300 ${estimateFieldErrors.mileage ? "border-red-400 bg-red-50/50" : "border-neutral-200 hover:border-neutral-300 bg-neutral-50/50 focus:border-neutral-900"}`} />
                          <span className="text-sm font-semibold text-neutral-500 shrink-0">km</span>
                        </div>
                        {estimateFieldErrors.mileage && <p className="text-xs text-red-500 mt-1">{estimateFieldErrors.mileage}</p>}
                      </div>
                    </div>
                  </div>

                  {/* Branch Selection */}
                  {branches.length > 1 && (
                    <div className="bg-white rounded-2xl border border-neutral-200 shadow-sm p-5 sm:p-6">
                      <div className="flex items-center gap-2 mb-4">
                        <div className="w-8 h-8 rounded-lg bg-neutral-900 flex items-center justify-center">
                          <i className="fas fa-location-dot text-white text-xs" />
                        </div>
                        <h4 className="font-bold text-neutral-900 text-sm">Preferred Location</h4>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        {branches.map((b) => (
                          <button key={b.id} type="button" onClick={() => setEstimateBranch(estimateBranch?.id === b.id ? null : b)}
                            className={`text-left p-4 rounded-xl border-2 transition-all ${
                              estimateBranch?.id === b.id
                                ? "border-neutral-900 bg-neutral-50 shadow-md"
                                : "border-neutral-200 hover:border-neutral-300 bg-white"
                            }`}>
                            <div className="font-semibold text-neutral-800 text-sm">{b.name}</div>
                            {b.address && <div className="text-xs text-neutral-500 mt-0.5">{b.address}</div>}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Description */}
                  <div className="bg-white rounded-2xl border border-neutral-200 shadow-sm p-5 sm:p-6">
                    <div className="flex items-center gap-2 mb-4">
                      <div className="w-8 h-8 rounded-lg bg-neutral-900 flex items-center justify-center">
                        <i className="fas fa-message text-white text-xs" />
                      </div>
                      <h4 className="font-bold text-neutral-900 text-sm">What do you need?</h4>
                    </div>
                    <textarea required rows={5} value={estimateDescription} onChange={(e) => { setEstimateDescription(e.target.value); setEstimateFieldErrors((p) => ({ ...p, description: "" })); }}
                      placeholder="Describe the issue or service you need — e.g. 'My car makes a grinding noise when braking, need brake pads checked and replaced if needed...'"
                      className={`w-full border-2 rounded-xl px-3.5 py-3 text-sm focus:ring-0 transition-all outline-none font-medium resize-none placeholder:text-neutral-300 ${estimateFieldErrors.description ? "border-red-400 bg-red-50/50" : "border-neutral-200 hover:border-neutral-300 bg-neutral-50/50 focus:border-neutral-900"}`} />
                    {estimateFieldErrors.description && <p className="text-xs text-red-500 mt-1">{estimateFieldErrors.description}</p>}
                  </div>

                  {/* Attach Images */}
                  <div className="bg-white rounded-2xl border border-neutral-200 shadow-sm p-5 sm:p-6">
                    <div className="flex items-center gap-2 mb-4">
                      <div className="w-8 h-8 rounded-lg bg-neutral-900 flex items-center justify-center">
                        <i className="fas fa-camera text-white text-xs" />
                      </div>
                      <div>
                        <h4 className="font-bold text-neutral-900 text-sm">Attach Photos</h4>
                        <p className="text-[11px] text-neutral-400">Optional — add up to 5 photos of the issue</p>
                      </div>
                    </div>

                    {estimateImagePreviews.length > 0 && (
                      <div className="flex flex-wrap gap-2 mb-3">
                        {estimateImagePreviews.map((url, i) => (
                          <div key={i} className="relative group">
                            <img src={url} alt="Preview" className="w-20 h-20 object-cover rounded-xl border border-neutral-200" />
                            <button type="button" onClick={() => {
                              const newFiles = estimateImages.filter((_, fi) => fi !== i);
                              setEstimateImages(newFiles);
                              setEstimateImagePreviews(newFiles.map((f) => URL.createObjectURL(f)));
                            }}
                              className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-rose-500 text-white flex items-center justify-center text-[8px] opacity-0 group-hover:opacity-100 transition-opacity shadow-md">
                              <i className="fas fa-times" />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}

                    {estimateImages.length < 5 && (
                      <label className="flex items-center justify-center gap-2 border-2 border-dashed border-neutral-200 hover:border-neutral-400 rounded-xl py-4 cursor-pointer transition-all text-neutral-400 hover:text-neutral-600">
                        <i className="fas fa-plus text-xs" />
                        <span className="text-xs font-semibold">Add Photo</span>
                        <input type="file" accept="image/*" multiple className="hidden" onChange={(e) => {
                          const files = Array.from(e.target.files || []);
                          if (files.length === 0) return;
                          const newFiles = [...estimateImages, ...files].slice(0, 5);
                          setEstimateImages(newFiles);
                          setEstimateImagePreviews(newFiles.map((f) => URL.createObjectURL(f)));
                          e.target.value = "";
                        }} />
                      </label>
                    )}

                    {estimateImages.length > 0 && (
                      <p className="text-[10px] text-neutral-400 mt-2">{estimateImages.length}/5 photos attached</p>
                    )}
                  </div>

                  {estimateError && (
                    <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 flex items-center gap-2.5">
                      <i className="fas fa-exclamation-triangle text-red-500 text-xs" />
                      <p className="text-xs text-red-700 font-medium">{estimateError}</p>
                    </div>
                  )}

                  <button type="submit" disabled={estimateSubmitting}
                    className="w-full bg-neutral-900 text-white font-bold py-3.5 rounded-xl hover:bg-neutral-800 transition-all text-sm disabled:opacity-50 active:scale-[0.98] shadow-lg shadow-neutral-900/15 relative overflow-hidden group">
                    <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/[0.06] to-transparent group-hover:animate-[shimmerBg_1.5s_linear_infinite]" style={{ backgroundSize: "200% 100%" }} />
                    <span className="relative z-10 flex items-center justify-center gap-2">
                      {estimateSubmitting ? (
                        <>
                          <svg className="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                          </svg>
                          Sending request...
                        </>
                      ) : (
                        <>
                          <i className="fas fa-paper-plane text-xs" />
                          Request Estimate
                        </>
                      )}
                    </span>
                  </button>
                </form>
              </>
            )}
          </div>
        </main>
      )}

      {/* ═══════════════════ MY VEHICLES VIEW ═══════════════════ */}
      {activeView === "myVehicles" && (
        <main className="flex-1 max-w-4xl mx-auto px-4 sm:px-6 py-8 sm:py-10 w-full relative z-10">
          <div className="animate-[fadeSlideUp_0.4s_ease-out]">
            <h3 className="text-xl sm:text-2xl font-bold text-neutral-900 tracking-tight mb-1">My Vehicles</h3>
            <p className="text-neutral-500 text-sm mb-6">Manage your saved vehicles for quicker booking</p>

            {vehiclesLoading ? (
              <div className="flex justify-center py-20">
                <svg className="animate-spin h-6 w-6 text-neutral-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
              </div>
            ) : customerVehicles.length === 0 ? (
              <div className="text-center py-20 bg-white rounded-3xl border border-neutral-200/80 shadow-sm">
                <div className="w-16 h-16 mx-auto mb-4 bg-neutral-100 rounded-2xl flex items-center justify-center">
                  <i className="fas fa-car text-2xl text-neutral-300" />
                </div>
                <p className="text-neutral-500 font-medium mb-1">No vehicles saved yet</p>
                <p className="text-neutral-400 text-xs mb-5">Add a vehicle to speed up future bookings.</p>
                <button
                  onClick={openAddVehicle}
                  className="bg-neutral-900 text-white font-bold text-xs px-5 py-2.5 rounded-xl hover:bg-neutral-800 transition-all shadow-md"
                >
                  <i className="fas fa-plus mr-1.5" />Add Vehicle
                </button>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex justify-end">
                  <button
                    onClick={openAddVehicle}
                    className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold bg-neutral-900 text-white hover:bg-neutral-800 transition-all shadow-md"
                  >
                    <i className="fas fa-plus text-[9px]" />Add Vehicle
                  </button>
                </div>
                {customerVehicles.map((v, i) => {
                  const accent = i % 3 === 0 ? "amber" : i % 3 === 1 ? "cyan" : "violet";
                  const accentClasses = {
                    amber: "from-amber-500/10 via-orange-500/5 to-transparent border-amber-200/60",
                    cyan: "from-cyan-500/10 via-blue-500/5 to-transparent border-cyan-200/60",
                    violet: "from-violet-500/10 via-purple-500/5 to-transparent border-violet-200/60",
                  };
                  const plateClasses = {
                    amber: "bg-gradient-to-br from-amber-50 to-orange-50 border-amber-300/80",
                    cyan: "bg-gradient-to-br from-cyan-50 to-blue-50 border-cyan-300/80",
                    violet: "bg-gradient-to-br from-violet-50 to-purple-50 border-violet-300/80",
                  };
                  const details = [
                    { label: "Make", value: v.make, icon: "fa-industry" },
                    { label: "Model", value: v.model, icon: "fa-tag" },
                    { label: "Year", value: v.year, icon: "fa-calendar" },
                    { label: "Body Type", value: v.bodyType, icon: "fa-shapes" },
                    { label: "Colour", value: v.colour, icon: "fa-palette" },
                    { label: "Mileage", value: v.mileage, icon: "fa-gauge-high" },
                    { label: "VIN / Chassis", value: v.vinChassis, icon: "fa-barcode" },
                    { label: "Engine No.", value: v.engineNumber, icon: "fa-gears" },
                  ].filter((d) => d.value);
                  return (
                    <div key={v.id} className={`group relative overflow-hidden rounded-3xl border-2 bg-gradient-to-br ${accentClasses[accent]} shadow-sm hover:shadow-xl transition-all duration-300`}>
                      <div className="relative p-5 sm:p-6">
                        {/* Header: registration plate + actions */}
                        <div className="flex items-start justify-between gap-4 mb-5">
                          <div className="flex-1 min-w-0">
                            <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-neutral-500 mb-2">Registration</p>
                            <div className={`inline-flex items-center gap-2 rounded-xl border-2 px-4 py-2.5 font-mono font-black tracking-[0.15em] text-neutral-900 text-base sm:text-lg ${plateClasses[accent]}`}>
                              {v.registrationNumber || "—"}
                            </div>
                            <p className="mt-2 font-bold text-neutral-800 text-lg sm:text-xl truncate">
                              {[v.make, v.model].filter(Boolean).join(" ") || "Vehicle"}
                              {v.year && <span className="font-normal text-neutral-500 ml-1">({v.year})</span>}
                            </p>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <button
                              onClick={() => openEditVehicle(v)}
                              className="w-10 h-10 rounded-xl text-neutral-500 bg-white/80 backdrop-blur border border-neutral-200 hover:bg-neutral-900 hover:text-white hover:border-neutral-900 transition-all shadow-sm"
                              title="Edit"
                            >
                              <i className="fas fa-pen text-xs" />
                            </button>
                            <button
                              onClick={() => handleDeleteVehicle(v.id)}
                              disabled={vehicleDeleting === v.id}
                              className="w-10 h-10 rounded-xl text-red-500 bg-white/80 backdrop-blur border border-red-100 hover:bg-red-500 hover:text-white hover:border-red-500 transition-all disabled:opacity-50 shadow-sm"
                              title="Delete"
                            >
                              {vehicleDeleting === v.id ? <i className="fas fa-spinner fa-spin text-xs" /> : <i className="fas fa-trash text-xs" />}
                            </button>
                          </div>
                        </div>

                        {/* Details grid */}
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                          {details.map(({ label, value, icon }) => (
                            <div key={label} className="flex items-center gap-2.5 rounded-xl bg-white/70 backdrop-blur-sm border border-neutral-200/60 px-3 py-2.5">
                              <div className="w-8 h-8 rounded-lg bg-neutral-100 flex items-center justify-center shrink-0">
                                <i className={`fas ${icon} text-[10px] text-neutral-500`} />
                              </div>
                              <div className="min-w-0">
                                <p className="text-[9px] font-bold uppercase tracking-wider text-neutral-400 truncate">{label}</p>
                                <p className="text-xs font-semibold text-neutral-800 truncate">{value}</p>
                              </div>
                            </div>
                          ))}
                        </div>

                        {details.length === 0 && (
                          <p className="text-sm text-neutral-400 italic py-2">No additional details</p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </main>
      )}

      {/* Add/Edit Vehicle Modal - rendered via portal (available from booking + My Vehicles) */}
      {vehicleFormOpen && typeof document !== "undefined" && createPortal(
            <>
              <div className="fixed inset-0 z-[9998] bg-black/60 backdrop-blur-md" onClick={closeVehicleForm} />
              <div className="fixed inset-0 z-[9999] p-4 flex items-center justify-center">
                <div className="w-full max-w-[560px] max-h-[90vh] overflow-hidden rounded-3xl border border-neutral-200/80 bg-white shadow-2xl shadow-neutral-900/30 flex flex-col">
                <div className="relative px-4 py-3 sm:px-5 sm:py-4 border-b border-neutral-200/70 bg-gradient-to-r from-neutral-900 via-neutral-800 to-neutral-900">
                  <div className="absolute -right-8 -top-8 w-24 h-24 rounded-full bg-amber-400/20 blur-2xl" />
                  <div className="flex items-center gap-3 relative">
                    <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-xl sm:rounded-2xl bg-white/15 text-white flex items-center justify-center border border-white/20">
                      <i className="fas fa-car text-sm" />
                    </div>
                    <div>
                      <h4 className="text-base sm:text-lg font-black text-white tracking-tight">{editingVehicle ? "Edit Vehicle" : "Add Vehicle"}</h4>
                      <p className="hidden sm:block text-xs text-white/70">Keep your vehicle details ready for faster bookings</p>
                    </div>
                  </div>
                </div>

                <div className="p-3.5 sm:p-5 space-y-2.5 sm:space-y-3 overflow-y-auto flex-1 min-h-0 bg-gradient-to-b from-white to-neutral-50/60">
                  <p className="text-[10px] text-neutral-500">Add at least one: Registration number, Make, or Model.</p>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    <div className="rounded-xl sm:rounded-2xl border border-neutral-200 bg-white p-2.5 sm:p-3.5">
                      <label className="block text-[11px] font-bold text-neutral-400 uppercase tracking-wider mb-1.5">Make <span className="text-neutral-300 text-[10px]">(optional)</span></label>
                      <input type="text" value={vehicleFormMake} onChange={(e) => setVehicleFormMake(e.target.value)} placeholder="e.g. Toyota, Honda"
                        className="w-full border-2 border-neutral-200 rounded-lg sm:rounded-xl px-3 py-1.5 sm:px-3.5 sm:py-2 text-sm focus:ring-0 focus:border-neutral-900 outline-none bg-neutral-50" />
                    </div>
                    <div className="rounded-xl sm:rounded-2xl border border-neutral-200 bg-white p-2.5 sm:p-3.5">
                      <label className="block text-[11px] font-bold text-neutral-400 uppercase tracking-wider mb-1.5">Model <span className="text-neutral-300 text-[10px]">(optional)</span></label>
                      <input type="text" value={vehicleFormModel} onChange={(e) => setVehicleFormModel(e.target.value)} placeholder="e.g. Camry, Civic"
                        className="w-full border-2 border-neutral-200 rounded-lg sm:rounded-xl px-3 py-1.5 sm:px-3.5 sm:py-2 text-sm focus:ring-0 focus:border-neutral-900 outline-none bg-neutral-50" />
                    </div>
                    <div className="rounded-xl sm:rounded-2xl border border-neutral-200 bg-white p-2.5 sm:p-3.5">
                      <label className="block text-[11px] font-bold text-neutral-400 uppercase tracking-wider mb-1.5">Year <span className="text-neutral-300 text-[10px]">(optional)</span></label>
                      <input type="text" value={vehicleFormYear} onChange={(e) => setVehicleFormYear(e.target.value)} placeholder="e.g. 2020"
                        className="w-full border-2 border-neutral-200 rounded-lg sm:rounded-xl px-3 py-1.5 sm:px-3.5 sm:py-2 text-sm focus:ring-0 focus:border-neutral-900 outline-none bg-neutral-50" />
                    </div>
                  </div>
                  <div className="rounded-xl sm:rounded-2xl border border-neutral-200 bg-white p-2.5 sm:p-3.5">
                    <label className="block text-[11px] font-bold text-neutral-400 uppercase tracking-wider mb-1.5">Registration number <span className="text-neutral-300 text-[10px]">(optional)</span></label>
                    <input type="text" value={vehicleFormRego} onChange={(e) => setVehicleFormRego(e.target.value)} placeholder="e.g. ABC 123"
                      className="w-full border-2 border-neutral-200 rounded-lg sm:rounded-xl px-3 py-1.5 sm:px-3.5 sm:py-2 text-sm font-semibold tracking-wide focus:ring-0 focus:border-neutral-900 outline-none bg-neutral-50" />
                  </div>
                  <div className="rounded-xl sm:rounded-2xl border border-neutral-200 bg-white p-2.5 sm:p-3.5">
                    <label className="block text-[11px] font-bold text-neutral-400 uppercase tracking-wider mb-1.5">Mileage <span className="text-neutral-300 text-[10px]">(optional)</span></label>
                    <input type="text" value={vehicleFormMileage} onChange={(e) => setVehicleFormMileage(e.target.value)} placeholder="e.g. 45000 km"
                      className="w-full border-2 border-neutral-200 rounded-lg sm:rounded-xl px-3 py-1.5 sm:px-3.5 sm:py-2 text-sm focus:ring-0 focus:border-neutral-900 outline-none bg-neutral-50" />
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <div className="rounded-xl sm:rounded-2xl border border-neutral-200 bg-white p-2.5 sm:p-3.5">
                      <label className="block text-[11px] font-bold text-neutral-400 uppercase tracking-wider mb-1.5">Body type <span className="text-neutral-300 text-[10px]">(optional)</span></label>
                      <input type="text" value={vehicleFormBodyType} onChange={(e) => setVehicleFormBodyType(e.target.value)} placeholder="e.g. Sedan, SUV"
                        className="w-full border-2 border-neutral-200 rounded-lg sm:rounded-xl px-3 py-1.5 sm:px-3.5 sm:py-2 text-sm focus:ring-0 focus:border-neutral-900 outline-none bg-neutral-50" />
                    </div>
                    <div className="rounded-xl sm:rounded-2xl border border-neutral-200 bg-white p-2.5 sm:p-3.5">
                      <label className="block text-[11px] font-bold text-neutral-400 uppercase tracking-wider mb-1.5">Colour <span className="text-neutral-300 text-[10px]">(optional)</span></label>
                      <input type="text" value={vehicleFormColour} onChange={(e) => setVehicleFormColour(e.target.value)} placeholder="e.g. White, Black"
                        className="w-full border-2 border-neutral-200 rounded-lg sm:rounded-xl px-3 py-1.5 sm:px-3.5 sm:py-2 text-sm focus:ring-0 focus:border-neutral-900 outline-none bg-neutral-50" />
                    </div>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <div className="rounded-xl sm:rounded-2xl border border-neutral-200 bg-white p-2.5 sm:p-3.5">
                      <label className="block text-[11px] font-bold text-neutral-400 uppercase tracking-wider mb-1.5">VIN / Chassis <span className="text-neutral-300 text-[10px]">(optional)</span></label>
                      <input type="text" value={vehicleFormVin} onChange={(e) => setVehicleFormVin(e.target.value)} placeholder="e.g. 1HGBH41JXMN109186"
                        className="w-full border-2 border-neutral-200 rounded-lg sm:rounded-xl px-3 py-1.5 sm:px-3.5 sm:py-2 text-sm focus:ring-0 focus:border-neutral-900 outline-none bg-neutral-50" />
                    </div>
                    <div className="rounded-xl sm:rounded-2xl border border-neutral-200 bg-white p-2.5 sm:p-3.5">
                      <label className="block text-[11px] font-bold text-neutral-400 uppercase tracking-wider mb-1.5">Engine number <span className="text-neutral-300 text-[10px]">(optional)</span></label>
                      <input type="text" value={vehicleFormEngine} onChange={(e) => setVehicleFormEngine(e.target.value)} placeholder="e.g. ABC123456"
                        className="w-full border-2 border-neutral-200 rounded-lg sm:rounded-xl px-3 py-1.5 sm:px-3.5 sm:py-2 text-sm focus:ring-0 focus:border-neutral-900 outline-none bg-neutral-50" />
                    </div>
                  </div>
                </div>

                <div className="px-4 sm:px-5 py-3 border-t border-neutral-200/80 bg-white flex gap-2">
                  <button onClick={closeVehicleForm} className="flex-1 py-2 rounded-lg sm:rounded-xl text-xs sm:text-sm font-bold border-2 border-neutral-200 text-neutral-600 hover:bg-neutral-50 transition-all">
                    Cancel
                  </button>
                  <button onClick={handleSaveVehicle} disabled={vehicleSaving || (!vehicleFormRego?.trim() && !vehicleFormMake?.trim() && !vehicleFormModel?.trim())} className="flex-1 py-2 rounded-lg sm:rounded-xl text-xs sm:text-sm font-bold bg-neutral-900 text-white hover:bg-neutral-800 disabled:opacity-50 transition-all shadow-md shadow-neutral-900/15">
                    {vehicleSaving ? "Saving..." : editingVehicle ? "Update Vehicle" : "Add Vehicle"}
                  </button>
                </div>
              </div>
              </div>
            </>,
            document.body
          )}

      {/* ═══════════════════ MY ESTIMATES VIEW ═══════════════════ */}
      {activeView === "myEstimates" && (
        <main className="flex-1 max-w-4xl mx-auto px-4 sm:px-6 py-8 sm:py-10 w-full relative z-10">
          <div className="animate-[fadeSlideUp_0.4s_ease-out]">
            <h3 className="text-xl sm:text-2xl font-bold text-neutral-900 tracking-tight mb-1">My Estimates</h3>
            <p className="text-neutral-500 text-sm mb-6">Track the status of your estimate requests</p>

            {customerEstimatesLoading ? (
              <div className="flex items-center justify-center py-20">
                <svg className="animate-spin h-6 w-6 text-neutral-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
              </div>
            ) : customerEstimates.length === 0 ? (
              <div className="text-center py-20 bg-white rounded-3xl border border-neutral-200/80 shadow-sm">
                <div className="w-16 h-16 mx-auto mb-4 bg-neutral-100 rounded-2xl flex items-center justify-center">
                  <i className="fas fa-file-invoice text-2xl text-neutral-300" />
                </div>
                <p className="text-neutral-500 font-medium mb-1">No estimate requests yet</p>
                <p className="text-neutral-400 text-xs mb-5">Submit a request to get a quote from us.</p>
                <button
                  onClick={() => { setActiveView("estimate"); setEstimateSuccess(false); setEstimateError(""); setEstimateFieldErrors({}); if (branches.length === 1 && !estimateBranch) setEstimateBranch(branches[0]); }}
                  className="bg-neutral-900 text-white font-bold text-xs px-5 py-2.5 rounded-xl hover:bg-neutral-800 transition-all shadow-md"
                >
                  <i className="fas fa-plus mr-1.5" />Get an Estimate
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                {customerEstimates.map((est) => {
                  const statusStyles: Record<string, { bg: string; text: string; icon: string }> = {
                    New: { bg: "bg-amber-100", text: "text-amber-700", icon: "fa-sparkles" },
                    Reviewed: { bg: "bg-blue-100", text: "text-blue-700", icon: "fa-eye" },
                    Quoted: { bg: "bg-emerald-100", text: "text-emerald-700", icon: "fa-check" },
                    Closed: { bg: "bg-neutral-200", text: "text-neutral-600", icon: "fa-xmark" },
                  };
                  const sc = statusStyles[est.status] || statusStyles.New;
                  const vehicleInfo = [est.vehicleYear, est.vehicleMake, est.vehicleModel].filter(Boolean).join(" ");
                  const dateStr = est.createdAt
                    ? new Date(est.createdAt).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" })
                    : "-";

                  const isExpanded = expandedEstimateId === est.id;
                  const estReplies = estimateReplies[est.id] || [];
                  const isLoadingReplies = estimateRepliesLoading === est.id;

                  return (
                    <div key={est.id} className="bg-white rounded-2xl border border-neutral-200/80 shadow-sm overflow-hidden">
                      <div className="p-4 sm:p-5">
                        <div className="flex items-center justify-between mb-3">
                          <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold ${sc.bg} ${sc.text}`}>
                            <i className={`fas ${sc.icon} text-[8px]`} />
                            {est.status}
                          </span>
                          <span className="text-[11px] text-neutral-400">{dateStr}</span>
                        </div>

                        {vehicleInfo && (
                          <div className="flex items-center gap-2 mb-2">
                            <i className="fas fa-car text-neutral-400 text-xs" />
                            <span className="text-sm font-semibold text-neutral-800">{vehicleInfo}</span>
                            {est.rego && <span className="text-xs text-neutral-400 bg-neutral-100 px-2 py-0.5 rounded-full">{est.rego}</span>}
                            {est.mileage && <span className="text-xs text-neutral-400 bg-neutral-100 px-2 py-0.5 rounded-full">{est.mileage}</span>}
                          </div>
                        )}

                        <p className="text-sm text-neutral-600 leading-relaxed line-clamp-3">{est.description}</p>

                        {est.imageUrls && est.imageUrls.length > 0 && (
                          <div className="flex flex-wrap gap-1.5 mt-2.5">
                            {est.imageUrls.map((url: string, i: number) => (
                              <button key={i} onClick={() => setEstimateLightboxUrl(url)} className="group relative rounded-lg overflow-hidden border border-neutral-200 hover:border-neutral-300 transition-all">
                                <img src={url} alt="Photo" className="w-16 h-16 object-cover" />
                                <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-all flex items-center justify-center">
                                  <i className="fas fa-expand text-white text-[9px] opacity-0 group-hover:opacity-100 transition-opacity" />
                                </div>
                              </button>
                            ))}
                          </div>
                        )}

                        {est.branchName && (
                          <div className="flex items-center gap-1.5 mt-3 text-xs text-neutral-400">
                            <i className="fas fa-location-dot text-[9px]" />
                            {est.branchName}
                          </div>
                        )}

                        <button
                          onClick={() => toggleEstimateExpand(est.id)}
                          className="mt-3 flex items-center gap-1.5 text-xs font-semibold text-neutral-500 hover:text-neutral-800 transition-colors"
                        >
                          <i className={`fas fa-chevron-${isExpanded ? "up" : "down"} text-[9px] transition-transform`} />
                          {isExpanded ? "Hide replies" : "View replies"}
                        </button>
                      </div>

                      {isExpanded && (
                        <div className="border-t border-neutral-100 bg-neutral-50/50 p-4 sm:p-5">
                          {isLoadingReplies ? (
                            <div className="flex items-center justify-center py-6">
                              <svg className="animate-spin h-5 w-5 text-neutral-300" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                              </svg>
                            </div>
                          ) : estReplies.length === 0 ? (
                            <div className="text-center py-6">
                              <i className="fas fa-comments text-neutral-200 text-2xl mb-2" />
                              <p className="text-xs text-neutral-400">No replies yet. We&apos;ll get back to you soon.</p>
                            </div>
                          ) : (
                            <div className="space-y-3">
                              {estReplies.map((reply: any) => (
                                <div key={reply.id} className="bg-white rounded-xl p-3.5 border border-neutral-200 shadow-sm">
                                  <div className="flex items-center gap-2 mb-2">
                                    <div className="w-6 h-6 rounded-full bg-neutral-900 flex items-center justify-center">
                                      <i className="fas fa-store text-[8px] text-white" />
                                    </div>
                                    <span className="text-xs font-bold text-neutral-700">Workshop Reply</span>
                                    <span className="text-[10px] text-neutral-400 ml-auto">
                                      {reply.createdAt ? new Date(reply.createdAt).toLocaleDateString("en-AU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : ""}
                                    </span>
                                  </div>
                                  <p className="text-sm text-neutral-700 leading-relaxed whitespace-pre-wrap">{reply.message}</p>
                                  {reply.imageUrls && reply.imageUrls.length > 0 && (
                                    <div className="flex flex-wrap gap-2 mt-2.5">
                                      {reply.imageUrls.map((url: string, i: number) => (
                                        <button key={i} onClick={() => setEstimateLightboxUrl(url)} className="group relative rounded-lg overflow-hidden border border-neutral-200 hover:border-neutral-300 transition-all hover:shadow-md">
                                          <img src={url} alt="Attachment" className="w-20 h-20 object-cover" />
                                          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-all flex items-center justify-center">
                                            <i className="fas fa-expand text-white text-xs opacity-0 group-hover:opacity-100 transition-opacity" />
                                          </div>
                                        </button>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </main>
      )}

      {/* Estimate Image Lightbox */}
      {estimateLightboxUrl && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[60] flex items-center justify-center p-4 animate-[fadeIn_0.15s_ease-out]" onClick={() => setEstimateLightboxUrl(null)}>
          <div className="relative max-w-2xl w-full max-h-[85vh] animate-[modalPop_0.3s_ease-out]" onClick={(e) => e.stopPropagation()}>
            <button onClick={() => setEstimateLightboxUrl(null)} className="absolute -top-3 -right-3 z-10 w-8 h-8 rounded-full bg-white shadow-lg flex items-center justify-center text-neutral-600 hover:text-neutral-900 hover:scale-110 transition-all">
              <i className="fas fa-times text-sm" />
            </button>
            <img src={estimateLightboxUrl} alt="Attachment" className="w-full max-h-[85vh] object-contain rounded-2xl shadow-2xl" />
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
                      {showForgotPassword
                        ? forgotPasswordStep === "email"
                          ? "Reset password"
                          : "Enter reset code"
                        : authMode === "login"
                          ? "Welcome back"
                          : "Create account"}
                    </h3>
                    <p className="text-xs text-neutral-400 mt-0.5">
                      {showForgotPassword
                        ? forgotPasswordStep === "email"
                          ? `Enter your email to receive a reset code`
                          : `Check your email for the 6-digit code`
                        : authMode === "login"
                          ? `Sign in to book at ${workshop.name}`
                          : `Register for ${workshop.name}`}
                    </p>
                  </div>
                  <button onClick={() => { setShowAuth(false); setAuthError(""); resetForgotPasswordFlow(); }} className="w-9 h-9 rounded-xl bg-neutral-100 hover:bg-neutral-200 flex items-center justify-center transition group">
                    <i className="fas fa-times text-neutral-400 group-hover:text-neutral-600 text-sm transition-colors" />
                  </button>
                </div>
              </div>

              {showForgotPassword ? (
                forgotPasswordSuccess ? (
                  <div className="px-6 pb-6 space-y-4">
                    <div className="bg-emerald-50 border border-emerald-200/50 rounded-xl px-4 py-4 flex items-center gap-2.5">
                      <div className="w-8 h-8 rounded-lg bg-emerald-100 flex items-center justify-center flex-shrink-0">
                        <i className="fas fa-check text-emerald-600 text-sm" />
                      </div>
                      <p className="text-sm text-emerald-800 font-medium">Password reset successfully. You can now sign in with your new password.</p>
                    </div>
                    <button type="button" onClick={() => { resetForgotPasswordFlow(); setShowAuth(false); }}
                      className="w-full bg-neutral-900 text-white font-bold py-3 rounded-xl hover:bg-neutral-800 transition-all text-sm active:scale-[0.98] shadow-lg shadow-neutral-900/15">
                      Sign in
                    </button>
                  </div>
                ) : (
                  <form onSubmit={forgotPasswordStep === "email" ? handleForgotPasswordEmailSubmit : handleForgotPasswordResetSubmit} className="px-6 pb-6 space-y-3.5">
                    {forgotPasswordStep === "email" ? (
                      <>
                        <div>
                          <label className="block text-[11px] font-semibold text-neutral-500 mb-1.5">Email <span className="text-red-400">*</span></label>
                          <div className="relative">
                            <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-neutral-300">
                              <i className="fas fa-envelope text-xs" />
                            </div>
                            <input type="email" value={forgotPasswordEmail} onChange={(e) => setForgotPasswordEmail(e.target.value)} required placeholder="name@email.com"
                              className="w-full border-2 border-neutral-200 hover:border-neutral-300 rounded-xl pl-10 pr-4 py-2.5 text-sm focus:ring-0 focus:border-neutral-900 transition-all outline-none bg-neutral-50/50 placeholder:text-neutral-300 font-medium" />
                          </div>
                        </div>
                        {forgotPasswordError && (
                          <div className="bg-red-50 border border-red-200/50 rounded-xl px-4 py-3 flex items-center gap-2.5">
                            <i className="fas fa-exclamation-triangle text-red-500 text-[10px]" />
                            <p className="text-xs text-red-700 font-medium">{forgotPasswordError}</p>
                          </div>
                        )}
                        <button type="submit" disabled={forgotPasswordLoading}
                          className="w-full bg-neutral-900 text-white font-bold py-3 rounded-xl hover:bg-neutral-800 transition-all text-sm disabled:opacity-50 active:scale-[0.98] shadow-lg shadow-neutral-900/15">
                          {forgotPasswordLoading ? "Sending..." : "Send reset code"}
                        </button>
                      </>
                    ) : (
                      <>
                        <div>
                          <label className="block text-[11px] font-semibold text-neutral-500 mb-1.5">Email</label>
                          <input type="text" value={forgotPasswordEmail} readOnly
                            className="w-full border-2 border-neutral-200 rounded-xl px-3.5 py-2.5 text-sm bg-neutral-100 text-neutral-600 font-medium" />
                        </div>
                        <div>
                          <label className="block text-[11px] font-semibold text-neutral-500 mb-1.5">Reset code <span className="text-red-400">*</span></label>
                          <input type="text" value={resetCode} onChange={(e) => setResetCode(e.target.value)} required placeholder="123456" maxLength={6} inputMode="numeric" pattern="[0-9]*"
                            className="w-full border-2 border-neutral-200 hover:border-neutral-300 rounded-xl px-3.5 py-2.5 text-sm focus:ring-0 focus:border-neutral-900 transition-all outline-none bg-neutral-50/50 placeholder:text-neutral-300 font-medium tracking-[0.3em] text-center" />
                        </div>
                        <div>
                          <label className="block text-[11px] font-semibold text-neutral-500 mb-1.5">New password <span className="text-red-400">*</span></label>
                          <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required minLength={6} placeholder="••••••••"
                            className="w-full border-2 border-neutral-200 hover:border-neutral-300 rounded-xl px-3.5 py-2.5 text-sm focus:ring-0 focus:border-neutral-900 transition-all outline-none bg-neutral-50/50 placeholder:text-neutral-300 font-medium" />
                        </div>
                        <div>
                          <label className="block text-[11px] font-semibold text-neutral-500 mb-1.5">Confirm password <span className="text-red-400">*</span></label>
                          <input type="password" value={newPasswordConfirm} onChange={(e) => setNewPasswordConfirm(e.target.value)} required minLength={6} placeholder="••••••••"
                            className={`w-full border-2 ${newPasswordConfirm && newPasswordConfirm !== newPassword ? "border-red-300" : "border-neutral-200 hover:border-neutral-300"} rounded-xl px-3.5 py-2.5 text-sm focus:ring-0 focus:border-neutral-900 transition-all outline-none bg-neutral-50/50 placeholder:text-neutral-300 font-medium`} />
                          {newPasswordConfirm && newPasswordConfirm !== newPassword && (
                            <p className="text-[10px] text-red-500 mt-1 font-medium">Passwords do not match</p>
                          )}
                        </div>
                        {forgotPasswordError && (
                          <div className="bg-red-50 border border-red-200/50 rounded-xl px-4 py-3 flex items-center gap-2.5">
                            <i className="fas fa-exclamation-triangle text-red-500 text-[10px]" />
                            <p className="text-xs text-red-700 font-medium">{forgotPasswordError}</p>
                          </div>
                        )}
                        <button type="submit" disabled={forgotPasswordLoading}
                          className="w-full bg-neutral-900 text-white font-bold py-3 rounded-xl hover:bg-neutral-800 transition-all text-sm disabled:opacity-50 active:scale-[0.98] shadow-lg shadow-neutral-900/15">
                          {forgotPasswordLoading ? "Resetting..." : "Reset password"}
                        </button>
                      </>
                    )}
                    <div className="pt-2">
                      <button type="button" onClick={resetForgotPasswordFlow}
                        className="w-full text-center text-xs text-neutral-500 hover:text-neutral-900 font-medium py-2 transition">
                        <span className="text-amber-600 font-semibold">← Back to sign in</span>
                      </button>
                    </div>
                  </form>
                )
              ) : (
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
                    <input type={showPassword ? "text" : "password"} value={authPassword} onChange={(e) => setAuthPassword(e.target.value)} required minLength={6} placeholder="••••••••"
                      className="w-full border-2 border-neutral-200 hover:border-neutral-300 rounded-xl pl-10 pr-10 py-2.5 text-sm focus:ring-0 focus:border-neutral-900 transition-all outline-none bg-neutral-50/50 placeholder:text-neutral-300 font-medium" />
                    <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute right-3.5 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-neutral-600 transition-colors">
                      <i className={`fas ${showPassword ? "fa-eye-slash" : "fa-eye"} text-xs`} />
                    </button>
                  </div>
                </div>

                {authMode === "login" && (
                  <div className="flex justify-end -mt-1">
                    <button type="button" onClick={() => { setShowForgotPassword(true); setForgotPasswordEmail(authEmail); setAuthError(""); }}
                      className="text-xs text-amber-600 hover:text-amber-700 font-medium transition">
                      Forgot password?
                    </button>
                  </div>
                )}

                {authMode === "register" && (
                  <div>
                    <label className="block text-[11px] font-semibold text-neutral-500 mb-1.5">Confirm Password <span className="text-red-400">*</span></label>
                    <div className="relative">
                      <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-neutral-300">
                        <i className="fas fa-lock text-xs" />
                      </div>
                      <input type={showConfirmPassword ? "text" : "password"} value={authConfirmPassword} onChange={(e) => setAuthConfirmPassword(e.target.value)} required minLength={6} placeholder="••••••••"
                        className={`w-full border-2 ${authConfirmPassword && authConfirmPassword !== authPassword ? "border-red-300 focus:border-red-500" : "border-neutral-200 hover:border-neutral-300 focus:border-neutral-900"} rounded-xl pl-10 pr-10 py-2.5 text-sm focus:ring-0 transition-all outline-none bg-neutral-50/50 placeholder:text-neutral-300 font-medium`} />
                      <button type="button" onClick={() => setShowConfirmPassword(!showConfirmPassword)} className="absolute right-3.5 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-neutral-600 transition-colors">
                        <i className={`fas ${showConfirmPassword ? "fa-eye-slash" : "fa-eye"} text-xs`} />
                      </button>
                    </div>
                    {authConfirmPassword && authConfirmPassword !== authPassword && (
                      <p className="text-[10px] text-red-500 mt-1 font-medium">Passwords do not match</p>
                    )}
                  </div>
                )}

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
              )}
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
