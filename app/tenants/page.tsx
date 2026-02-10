"use client";
import React, { useMemo, useState, useEffect, useCallback } from "react";
import Sidebar from "@/components/Sidebar";
import { useRouter } from "next/navigation";
import { auth, db } from "@/lib/firebase";
import { collection, onSnapshot, orderBy, query, addDoc, serverTimestamp, doc, getDoc, where, updateDoc, deleteDoc, getDocs, setDoc } from "firebase/firestore";
import { initializeApp, getApp } from "firebase/app";
import { getAuth, createUserWithEmailAndPassword, signOut as signOutSecondary, onAuthStateChanged } from "firebase/auth";
import { TIMEZONES } from "@/lib/timezone";
import { generateUniqueSlug } from "@/lib/slug";
import { 
  logTenantOnboarded, 
  logTenantDetailsUpdated, 
  logTenantSuspended, 
  logTenantUnsuspended, 
  logTenantDeleted 
} from "@/lib/auditLog";

type TenantRow = {
  initials: string;
  name: string;
  subtitle: string;
  abn: string | "PENDING";
  abnStatus: "verified" | "pending";
  state: "NSW" | "VIC" | "QLD" | "WA";
  stateCls: string;
  badgeFrom: string;
  badgeTo: string;
  plan: "Starter" | "Pro" | "Enterprise";
  price: string;
  status: "Active" | "Pending ABN" | "Provisioning";
  statusCls: string;
  statusIcon: string;
};

const TENANTS: TenantRow[] = [
  {
    initials: "BG",
    name: "Bondi Glow Studio",
    subtitle: "Premium Beauty & Wellness",
    abn: "12 345 678 901",
    abnStatus: "verified",
    state: "NSW",
    stateCls: "bg-blue-50 text-blue-700",
    badgeFrom: "from-pink-400",
    badgeTo: "to-pink-600",
    plan: "Pro",
    price: "AU$149/mo",
    status: "Active",
    statusCls: "bg-emerald-50 text-emerald-700",
    statusIcon: "fa-check-circle",
  },
  {
    initials: "MC",
    name: "Melbourne Cuts Pty Ltd",
    subtitle: "Professional Hair Styling",
    abn: "98 765 432 109",
    abnStatus: "verified",
    state: "VIC",
    stateCls: "bg-purple-50 text-purple-700",
    badgeFrom: "from-purple-400",
    badgeTo: "to-purple-600",
    plan: "Enterprise",
    price: "AU$299/mo",
    status: "Active",
    statusCls: "bg-emerald-50 text-emerald-700",
    statusIcon: "fa-check-circle",
  },
  {
    initials: "GC",
    name: "Gold Coast Beauty Bar",
    subtitle: "Luxury Beauty Services",
    abn: "PENDING",
    abnStatus: "pending",
    state: "QLD",
    stateCls: "bg-orange-50 text-orange-700",
    badgeFrom: "from-amber-400",
    badgeTo: "to-amber-600",
    plan: "Starter",
    price: "AU$99/mo",
    status: "Pending ABN",
    statusCls: "bg-amber-50 text-amber-700",
    statusIcon: "fa-clock",
  },
  {
    initials: "PS",
    name: "Perth Style Studio",
    subtitle: "Modern Hair & Beauty",
    abn: "55 123 456 789",
    abnStatus: "verified",
    state: "WA",
    stateCls: "bg-indigo-50 text-indigo-700",
    badgeFrom: "from-teal-400",
    badgeTo: "to-teal-600",
    plan: "Pro",
    price: "AU$149/mo",
    status: "Provisioning",
    statusCls: "bg-blue-50 text-blue-700",
    statusIcon: "fa-cog",
  },
];

type TenantDoc = {
  name: string;
  email?: string;
  abn?: string;
  state?: string;
  plan?: string;
  price?: string;
  status?: string;
  locationText?: string;
  timezone?: string; // IANA timezone (e.g., 'Australia/Sydney')
  contactPhone?: string;
  businessStructure?: string;
  gstRegistered?: boolean;
  slug?: string;
  bookingEngineUrl?: string;
  createdAt?: any;
  updatedAt?: any;
};

// Format ABN as XX XXX XXX XXX
const formatAbn = (value: string) => {
  const digits = value.replace(/\D/g, '').slice(0, 11);
  if (digits.length <= 2) return digits;
  if (digits.length <= 5) return `${digits.slice(0, 2)} ${digits.slice(2)}`;
  if (digits.length <= 8) return `${digits.slice(0, 2)} ${digits.slice(2, 5)} ${digits.slice(5)}`;
  return `${digits.slice(0, 2)} ${digits.slice(2, 5)} ${digits.slice(5, 8)} ${digits.slice(8)}`;
};

export default function TenantsPage() {
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [currentStep, setCurrentStep] = useState<1 | 2 | 3>(1);
  const [selectedPlan, setSelectedPlan] = useState<string | null>(null);
  const [packages, setPackages] = useState<Array<{ id: string; name: string; price: number; priceLabel: string; branches: number; staff: number; features: string[]; popular?: boolean; color: string; image?: string; icon?: string; active?: boolean; stripePriceId?: string; trialDays?: number; plan_key?: string }>>([]);
  const [packagesLoading, setPackagesLoading] = useState(true);
  // Onboarding form (minimal fields to persist)
  const [formBusinessName, setFormBusinessName] = useState("");
  const [formAbn, setFormAbn] = useState("");
  const [formStructure, setFormStructure] = useState("");
  const [formGst, setFormGst] = useState(false);
  const [formAddress, setFormAddress] = useState("");
  const [formState, setFormState] = useState("");
  const [formPostcode, setFormPostcode] = useState("");
  const [formPhone, setFormPhone] = useState("");
  const [formEmail, setFormEmail] = useState("");
  const [emailError, setEmailError] = useState("");
  const [formOwnerPassword, setFormOwnerPassword] = useState("");
  const [showOwnerPassword, setShowOwnerPassword] = useState(false);
  const [formTimezone, setFormTimezone] = useState("Australia/Sydney"); // Default timezone
  const [tenants, setTenants] = useState<Array<{ id: string; data: TenantDoc }>>([]);
  const [loadingTenants, setLoadingTenants] = useState(true);
  const [creating, setCreating] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewTenant, setPreviewTenant] = useState<{ id: string; data: TenantDoc } | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [editTenantId, setEditTenantId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editAbn, setEditAbn] = useState("");
  const [editState, setEditState] = useState("");
  const [editPlan, setEditPlan] = useState("");
  const [editPrice, setEditPrice] = useState("");
  const [editStatus, setEditStatus] = useState("");
  const [editLocation, setEditLocation] = useState("");
  const [editPhone, setEditPhone] = useState("");
  const [editTimezone, setEditTimezone] = useState("Australia/Sydney");
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [suspendTarget, setSuspendTarget] = useState<{ id: string; isSuspended: boolean } | null>(null);
  const [suspending, setSuspending] = useState(false);
  const [savingEdit, setSavingEdit] = useState(false);
  const [tenantStats, setTenantStats] = useState<Record<string, { staffCount: number; branchCount: number }>>({});
  const [currentAdmin, setCurrentAdmin] = useState<{ uid: string; name: string } | null>(null);

  const stepIndicatorClass = (step: 1 | 2 | 3) => {
    const base =
      "w-8 h-8 rounded-full flex items-center justify-center font-semibold text-sm transition-all duration-300";
    if (currentStep === step) return `${base} bg-gradient-to-r from-pink-500 to-pink-600 text-white shadow-lg shadow-pink-500/30`;
    if (currentStep > step) return `${base} bg-emerald-500 text-white`;
    return `${base} bg-slate-100 text-slate-400 border border-slate-200`;
  };
  
  const stepLabelClass = (step: 1 | 2 | 3) => {
    if (currentStep === step) return "text-xs font-semibold text-pink-600";
    if (currentStep > step) return "text-xs font-medium text-emerald-600";
    return "text-xs font-medium text-slate-400";
  };
  
  const stepLineClass = (step: 1 | 2) => {
    if (currentStep > step) return "flex-1 h-0.5 bg-emerald-500 transition-all duration-300";
    return "flex-1 h-0.5 bg-slate-200 transition-all duration-300";
  };

  const { totalTenants, activeProCount, suspendedCount, churnRate } = useMemo(() => {
    const total = tenants.length;
    const activePro = tenants.filter(({ data }) => {
      const plan = (data.plan || "").toLowerCase();
      const status = (data.status || "").toLowerCase();
      return plan === "pro" && status.includes("active");
    }).length;
    const suspended = tenants.filter(
      ({ data }) =>
        String((data as any).suspended || "").toLowerCase() === "true" ||
        (data.status || "").toLowerCase().includes("suspend")
    ).length;
    // If there are explicit "churned" statuses, compute percent; else 0
    const churned = tenants.filter(({ data }) => (data.status || "").toLowerCase().includes("churn")).length;
    const rate = total > 0 ? (churned / total) * 100 : 0;
    return {
      totalTenants: total,
      activeProCount: activePro,
      suspendedCount: suspended,
      churnRate: Number.isFinite(rate) ? rate : 0,
    };
  }, [tenants]);

  const openOnboardModal = () => {
    setIsModalOpen(true);
    setCurrentStep(1);
    setSelectedPlan(null);
    // Always fetch packages when modal opens to ensure fresh data
    fetchPackages();
  };

  const closeOnboardModal = () => {
    setIsModalOpen(false);
    setEmailError("");
  };

  const validateEmail = (email: string): boolean => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  };

  // Sanitize email to remove hidden/unicode characters
  const sanitizeEmail = (email: string): string => {
    // Remove all types of whitespace and invisible characters
    return email
      .replace(/[\u200B-\u200D\uFEFF]/g, '') // Zero-width chars
      .replace(/[\u00A0]/g, ' ') // Non-breaking space to regular space
      .replace(/\s+/g, '') // Remove all whitespace
      .toLowerCase();
  };

  const goNext = async () => {
    if (currentStep < 3) {
      // Validate email before moving to next step if we're on step 2
      if (currentStep === 2) {
        const sanitizedEmail = sanitizeEmail(formEmail);
        if (!sanitizedEmail) {
          setEmailError("Email is required.");
          return;
        }
        if (!validateEmail(sanitizedEmail)) {
          setEmailError("Please enter a valid email address.");
          return;
        }
        // Update the form with sanitized email
        setFormEmail(sanitizedEmail);
        setEmailError("");
      }
      setCurrentStep((s) => ((s + 1) as 1 | 2 | 3));
      return;
    }
    // Complete onboarding: persist tenant (in users collection) and invite owner
    try {
      setCreating(true);
      if (!formBusinessName.trim()) throw new Error("Business name is required.");
      const trimmedEmail = sanitizeEmail(formEmail);
      if (!trimmedEmail) throw new Error("Email is required.");
      if (!validateEmail(trimmedEmail)) throw new Error("Please enter a valid email address.");
      
      console.log("Creating tenant with email:", trimmedEmail, "Length:", trimmedEmail.length);

      // Get selected package data
      const selectedPackage = packages.find(p => p.id === selectedPlan);
      if (!selectedPackage) {
        throw new Error("Please select a subscription plan");
      }
      
      const planLabel = selectedPackage.name;
      const price = selectedPackage.priceLabel;

      // Provision Auth account FIRST to get the UID
      if (!formOwnerPassword.trim() || formOwnerPassword.trim().length < 6) {
        throw new Error("Owner password is required (min 6 characters).");
      }
      
      let ownerUid: string;
      try {
        const options: any = getApp().options;
        const secondaryName = `provision-${Date.now()}`;
        const secondaryApp = initializeApp(options, secondaryName);
        const secondaryAuth = getAuth(secondaryApp);
        console.log("Creating Firebase Auth account for:", trimmedEmail);
        const userCredential = await createUserWithEmailAndPassword(secondaryAuth, trimmedEmail, formOwnerPassword.trim());
        ownerUid = userCredential.user.uid;
        await signOutSecondary(secondaryAuth);
        console.log("Firebase Auth account created with UID:", ownerUid);
      } catch (e: any) {
        console.error("Firebase Auth error:", e?.code, e?.message, "Email used:", trimmedEmail);
        if (e?.code === "auth/email-already-in-use") {
          throw new Error("This email is already registered. Please use a different email.");
        } else if (e?.code === "auth/invalid-email") {
          throw new Error(`Invalid email format: "${trimmedEmail}". Please check for special characters or spaces.`);
        } else {
          throw e;
        }
      }

      // Get trial days from the plan
      const trialDays = selectedPackage.trialDays ? parseInt(String(selectedPackage.trialDays), 10) : 0;
      const hasFreeTrial = trialDays > 0;

      // Calculate trial dates if free trial is available
      // Trial starts immediately - no card details required during trial
      const now = new Date();
      const trialStart = hasFreeTrial ? now : null;
      const trialEnd = hasFreeTrial ? new Date(now.getTime() + trialDays * 24 * 60 * 60 * 1000) : null;

      // Generate unique slug for booking engine URL
      const slug = await generateUniqueSlug(formBusinessName.trim());
      const bookingEngineBaseUrl = process.env.NEXT_PUBLIC_BOOKING_ENGINE_URL || "https://black.bmspros.com.au/book-now";
      const bookingEngineUrl = `${bookingEngineBaseUrl}/${slug}`;

      // Create Firestore document with Auth UID as document ID
      // If free trial: user starts active and can use system without card details
      // If no trial: user must enter payment details to activate
      const newTenantRef = doc(db, "users", ownerUid);
      await setDoc(newTenantRef, {
        // user identity fields
        email: trimmedEmail,
        displayName: "",
        role: "salon_owner",
        provider: "password",
        uid: ownerUid,
        // business fields
        name: formBusinessName.trim(),
        slug, // URL-friendly name for booking engine (e.g., "abc-salon")
        bookingEngineUrl, // Full booking engine link (e.g., "https://black.bmspros.com.au/book-now/abc-salon")
        abn: formAbn.replace(/\s/g, '').trim() || null,
        state: formState || null,
        timezone: formTimezone || "Australia/Sydney",
        plan: planLabel,
        price: price || null,
        // subscription package details
        planId: selectedPackage.id,
        plan_key: selectedPackage.plan_key || null,
        branchLimit: selectedPackage.branches,
        currentBranchCount: 0,
        branchNames: [],
        staffLimit: selectedPackage.staff,
        currentStaffCount: 0,
        // Payment status - free trial users start active without card
        status: hasFreeTrial ? "Free Trial Active" : "Pending Payment",
        accountStatus: hasFreeTrial ? "active_trial" : "pending_payment",
        subscriptionStatus: hasFreeTrial ? "trialing" : "pending",
        billing_status: hasFreeTrial ? "trialing" : "pending",
        // Trial period info - trial starts immediately, no card required
        trialDays: trialDays,
        hasFreeTrial: hasFreeTrial,
        trial_start: trialStart,
        trial_end: trialEnd,
        paymentDetailsRequired: !hasFreeTrial, // Card details NOT required during trial
        locationText: formAddress ? `${formAddress}${formPostcode ? ` ${formPostcode}` : ""}` : null,
        contactPhone: formPhone.trim() || null,
        businessStructure: formStructure || null,
        gstRegistered: formGst,
        // timestamps
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      console.log("Firestore document created with ID:", ownerUid);

      // Send welcome email to salon owner with login credentials and payment link
      try {
        const idToken = await auth.currentUser?.getIdToken();
        // Build payment URL - they'll be redirected to subscription page after login
        const baseUrl = window.location.origin || "https://black.bmspros.com.au";
        const paymentUrl = `${baseUrl}/subscription`;
        
        const response = await fetch("/api/salon-owner/welcome-email", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
          },
          body: JSON.stringify({
            email: trimmedEmail,
            password: formOwnerPassword.trim(),
            businessName: formBusinessName.trim(),
            planName: planLabel,
            planPrice: price,
            paymentUrl: paymentUrl, // Link to subscription page for payment
            trialDays: trialDays,
            bookingEngineUrl: bookingEngineUrl, // Booking engine link for the email
          }),
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          console.warn("Failed to send welcome email:", errorData.error || "Unknown error");
          // Don't throw - email failure shouldn't block onboarding
        } else {
          console.log("Welcome email sent successfully to", trimmedEmail);
        }
      } catch (emailError: any) {
        console.warn("Error sending welcome email:", emailError);
        // Don't throw - email failure shouldn't block onboarding
      }

      // Log tenant onboarding to super admin audit logs
      if (currentAdmin) {
        try {
          await logTenantOnboarded(
            newTenantRef.id,
            formBusinessName.trim(),
            trimmedEmail,
            planLabel || "No Plan",
            currentAdmin
          );
        } catch (auditError) {
          console.warn("Failed to create audit log:", auditError);
        }
      }

      setIsModalOpen(false);
      setFormBusinessName("");
      setFormAbn("");
      setFormStructure("");
      setFormGst(false);
      setFormAddress("");
      setFormState("");
      setFormPostcode("");
      setFormPhone("");
      setFormEmail("");
      setEmailError("");
      setFormOwnerPassword("");
      setFormTimezone("Australia/Sydney");
      setSelectedPlan(null);
    } catch (e: any) {
      alert(e?.message || "Failed to save tenant");
    } finally {
      setCreating(false);
    }
  };

  const goBack = () => {
    if (currentStep > 1) setCurrentStep((s) => ((s - 1) as 1 | 2 | 3));
  };

  const nextCtaLabel = useMemo(() => {
    return currentStep === 3 ? "Complete Onboarding" : "Next Step";
  }, [currentStep]);

  // Fetch packages from API
  const fetchPackages = useCallback(async () => {
    try {
      setPackagesLoading(true);
      const currentUser = auth.currentUser;
      
      if (!currentUser) {
        console.log("No current user, waiting for auth...");
        setPackagesLoading(false);
        return;
      }

      const token = await currentUser.getIdToken();
      if (!token) {
        console.error("No auth token available");
        setPackagesLoading(false);
        return;
      }

      console.log("Fetching packages...");
      const response = await fetch("/api/packages", {
        headers: {
          "Authorization": `Bearer ${token}`,
        },
      });
      
      if (response.ok) {
        const data = await response.json();
        console.log("Packages response:", data);
        if (data.success && data.plans) {
          // Filter only active packages
          const activePackages = data.plans.filter((p: any) => p.active !== false);
          console.log("Active packages found:", activePackages.length, activePackages);
          setPackages(activePackages);
        } else {
          console.error("API returned success=false or no plans:", data);
          setPackages([]);
        }
      } else {
        const errorText = await response.text();
        console.error("Failed to fetch packages:", response.status, errorText);
        setPackages([]);
      }
    } catch (error) {
      console.error("Error fetching packages:", error);
      setPackages([]);
    } finally {
      setPackagesLoading(false);
    }
  }, []);

  // Fetch packages when auth is ready
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (user) {
        // Auth is ready, fetch packages
        fetchPackages();
      }
    });
    return () => unsub();
  }, [fetchPackages]);

  // Fetch packages when modal opens or when step 3 is reached
  useEffect(() => {
    if (isModalOpen) {
      if (currentStep === 3 && packages.length === 0 && !packagesLoading) {
        fetchPackages();
      } else if (currentStep === 1) {
        // Pre-fetch when modal opens
        fetchPackages();
      }
    }
  }, [isModalOpen, currentStep, packages.length, packagesLoading, fetchPackages]);

  useEffect(() => {
    // Auth listener prevents early redirect flicker on reload
    const unsub = onAuthStateChanged(getAuth(), async (user) => {
      if (!user) {
        router.replace("/login");
        return;
      }
      try {
        const token = await user.getIdToken();
        if (typeof window !== "undefined") localStorage.setItem("idToken", token);
      } catch {
        router.replace("/login");
        return;
      }
      
      // Check super_admins collection first
      const superAdminDoc = await getDoc(doc(db, "super_admins", user.uid));
      let role: string;
      
      if (superAdminDoc.exists()) {
        role = "super_admin";
        const superAdminData = superAdminDoc.data();
        setCurrentAdmin({
          uid: user.uid,
          name: superAdminData?.displayName || superAdminData?.name || user.email || "Super Admin"
        });
        // Super admin is allowed on tenants page, so no redirect needed
        return;
      } else {
        // Get user role from users collection
        const userRef = doc(db, "users", user.uid);
        const snap = await getDoc(userRef);
        role = (snap.data()?.role || "").toString();
      }
      
      if (role === "salon_branch_admin") {
        router.replace("/branches");
        return;
      }
      if (role !== "super_admin") {
        router.replace("/dashboard");
        return;
      }
    });
    return () => unsub();
  }, [router]);

  useEffect(() => {
    // Live tenants list from Firestore
    // Avoid composite index requirement by filtering only; sort on client
    const q = query(collection(db, "users"), where("role", "==", "salon_owner"));
    const unsub = onSnapshot(
      q,
      (snap) => {
        const rows = snap.docs
          .map((d) => ({ id: d.id, data: d.data() as TenantDoc }))
          .sort((a, b) => (a.data.name || "").localeCompare(b.data.name || ""));
        setTenants(rows);
        setLoadingTenants(false);
      },
      (error) => {
        if (error.code === "permission-denied") {
          console.warn("Permission denied for tenants query.");
          setTenants([]);
        } else {
          console.error("Error in tenants snapshot:", error);
        }
        setLoadingTenants(false);
      }
    );
    return () => unsub();
  }, []);

  // Fetch staff and branch counts for each tenant
  useEffect(() => {
    if (tenants.length === 0) return;

    const tenantIds = tenants.map(t => t.id);
    const stats: Record<string, { staffCount: number; branchCount: number }> = {};

    // Initialize all tenants with 0 counts
    tenantIds.forEach(id => {
      stats[id] = { staffCount: 0, branchCount: 0 };
    });

    // Fetch staff counts
    const staffPromises = tenantIds.map(async (tenantId) => {
      try {
        const staffQuery = query(collection(db, "users"), where("ownerUid", "==", tenantId), where("role", "==", "salon_staff"));
        const staffSnap = await getDocs(staffQuery);
        stats[tenantId].staffCount = staffSnap.docs.length;
      } catch (error) {
        console.error(`Error fetching staff for tenant ${tenantId}:`, error);
      }
    });

    // Fetch branch counts
    const branchPromises = tenantIds.map(async (tenantId) => {
      try {
        const branchQuery = query(collection(db, "branches"), where("ownerUid", "==", tenantId));
        const branchSnap = await getDocs(branchQuery);
        stats[tenantId].branchCount = branchSnap.docs.length;
      } catch (error) {
        console.error(`Error fetching branches for tenant ${tenantId}:`, error);
      }
    });

    // Wait for all queries to complete
    Promise.all([...staffPromises, ...branchPromises]).then(() => {
      setTenantStats(stats);
    });
  }, [tenants]);

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
            <div className="rounded-2xl bg-gradient-to-r from-pink-500 via-fuchsia-600 to-indigo-600 text-white p-6 shadow-sm">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-white/20 flex items-center justify-center">
                      <i className="fas fa-store" />
                    </div>
                    <h1 className="text-2xl font-bold">Tenant Management</h1>
                  </div>
                  <p className="text-sm text-white/80 mt-2">
                    Manage salon subscriptions and compliance
                  </p>
                </div>
              </div>
            </div>
          </div>

          <div id="stats-section" className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-6 mb-8 min-w-0">
            <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm min-w-0">
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm font-medium text-slate-600">Total Tenants</span>
                <div className="w-10 h-10 bg-blue-50 rounded-xl flex items-center justify-center">
                  <i className="fas fa-store text-blue-500" />
                </div>
              </div>
              <div className="mb-2">
                <h3 className="text-3xl font-bold text-slate-900">{totalTenants}</h3>
              </div>
              <div className="flex items-center space-x-2">
                <span className="text-xs text-slate-500">total tenants</span>
              </div>
            </div>
            <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm min-w-0">
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm font-medium text-slate-600">Active Pro Users</span>
                <div className="w-10 h-10 bg-pink-50 rounded-xl flex items-center justify-center">
                  <i className="fas fa-crown text-pink-500" />
                </div>
              </div>
              <div className="mb-2">
                <h3 className="text-3xl font-bold text-slate-900">{activeProCount}</h3>
              </div>
              <div className="flex items-center space-x-2">
                <span className="text-xs text-slate-500">active on Pro</span>
              </div>
            </div>
            <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm min-w-0">
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm font-medium text-slate-600">Suspended</span>
                <div className="w-10 h-10 bg-rose-50 rounded-xl flex items-center justify-center">
                  <i className="fas fa-ban text-rose-500" />
                </div>
              </div>
              <div className="mb-2">
                <h3 className="text-3xl font-bold text-slate-900">{suspendedCount}</h3>
              </div>
              <div className="flex items-center space-x-2">
                <span className="text-xs text-slate-500">suspended tenants</span>
              </div>
            </div>
            <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm min-w-0">
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm font-medium text-slate-600">Churn Rate</span>
                <div className="w-10 h-10 bg-rose-50 rounded-xl flex items-center justify-center">
                  <i className="fas fa-user-minus text-rose-500" />
                </div>
              </div>
              <div className="mb-2">
                <h3 className="text-3xl font-bold text-slate-900">{`${churnRate.toFixed(1)}%`}</h3>
              </div>
              <div className="flex items-center space-x-2">
                <span className="text-xs text-slate-500">of tenants churned</span>
              </div>
            </div>
          </div>

          <div id="tenant-table-section" className="bg-white rounded-2xl border border-slate-200 shadow-sm">
            <div className="p-6 border-b border-slate-200">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h3 className="font-semibold text-lg text-slate-900">Tenant Management</h3>
                  <p className="text-sm text-slate-500 mt-1">Manage salon subscriptions and compliance</p>
                </div>
                <button
                  className="w-full sm:w-auto px-6 py-3 bg-pink-600 text-white font-semibold rounded-lg hover:bg-pink-700 transition flex items-center justify-center sm:justify-start space-x-2"
                  onClick={openOnboardModal}
                >
                  <i className="fas fa-plus text-sm" />
                  <span>Onboard New Salon</span>
                </button>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full table-fixed min-w-[1080px]">
                <thead className="bg-slate-50 border-b border-slate-200">
                  <tr>
                    <th className="w-[22%] px-4 py-3 text-left text-xs font-semibold text-slate-600 uppercase tracking-wider">
                      Business Name
                    </th>
                    <th className="w-[12%] px-4 py-3 text-left text-xs font-semibold text-slate-600 uppercase tracking-wider">
                      ABN
                    </th>
                    <th className="w-[7%] px-4 py-3 text-center text-xs font-semibold text-slate-600 uppercase tracking-wider">
                      State
                    </th>
                    <th className="w-[14%] px-4 py-3 text-left text-xs font-semibold text-slate-600 uppercase tracking-wider">
                      Plan
                    </th>
                    <th className="w-[7%] px-4 py-3 text-center text-xs font-semibold text-slate-600 uppercase tracking-wider">
                      Staff
                    </th>
                    <th className="w-[8%] px-4 py-3 text-center text-xs font-semibold text-slate-600 uppercase tracking-wider">
                      Branches
                    </th>
                    <th className="w-[18%] px-4 py-3 text-left text-xs font-semibold text-slate-600 uppercase tracking-wider">
                      Status
                    </th>
                    <th className="w-[12%] px-4 py-3 text-center text-xs font-semibold text-slate-600 uppercase tracking-wider">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {loadingTenants && (
                    <tr>
                      <td className="px-4 py-8 text-center text-slate-500" colSpan={8}>
                        <div className="flex items-center justify-center gap-2">
                          <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-pink-500" />
                          <span>Loading tenants…</span>
                        </div>
                      </td>
                    </tr>
                  )}
                  {!loadingTenants && tenants.length === 0 && (
                    <tr>
                      <td className="px-4 py-8 text-center text-slate-500" colSpan={8}>No tenants yet.</td>
                    </tr>
                  )}
                  {tenants.map(({ id, data }) => {
                    const initials = (data.name || "?")
                      .split(" ")
                      .map((s) => s[0])
                      .filter(Boolean)
                      .slice(0, 2)
                      .join("")
                      .toUpperCase();
                    const planLabel = (data.plan || "").trim() || "—";
                    const statusLabel = (data.status || "").trim() || "—";
                    const state = (data.state || "").trim();

                    const statusLower = statusLabel.toLowerCase();
                    let statusCls = "bg-slate-100 text-slate-600";
                    let statusIcon = "fa-circle text-slate-400";
                    let statusDot = "bg-slate-400";

                    if (statusLower.includes("expired") || statusLower.includes("payment required")) {
                      statusCls = "bg-rose-50 text-rose-700 border border-rose-200";
                      statusIcon = "fa-exclamation-circle text-rose-500";
                      statusDot = "bg-rose-500";
                    } else if (statusLower.includes("suspend")) {
                      statusCls = "bg-red-50 text-red-700 border border-red-200";
                      statusIcon = "fa-ban text-red-500";
                      statusDot = "bg-red-500";
                    } else if (statusLower.includes("active") || statusLower.includes("trial active")) {
                      statusCls = "bg-emerald-50 text-emerald-700 border border-emerald-200";
                      statusIcon = "fa-check-circle text-emerald-500";
                      statusDot = "bg-emerald-500";
                    } else if (statusLower.includes("pending")) {
                      statusCls = "bg-amber-50 text-amber-700 border border-amber-200";
                      statusIcon = "fa-clock text-amber-500";
                      statusDot = "bg-amber-500";
                    }

                    // Shorten long status labels for the badge
                    let shortStatus = statusLabel;
                    if (statusLower.includes("trial expired") && statusLower.includes("payment")) {
                      shortStatus = "Trial Expired";
                    } else if (statusLower.includes("free trial active")) {
                      shortStatus = "Free Trial";
                    }

                    return (
                      <tr key={id} className="hover:bg-slate-50/80 transition group">
                        {/* Business Name */}
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-3 min-w-0">
                            <div className="w-9 h-9 bg-gradient-to-br from-pink-400 to-pink-600 rounded-lg flex items-center justify-center flex-shrink-0">
                              <span className="text-white font-semibold text-xs">{initials}</span>
                            </div>
                            <div className="min-w-0">
                              <p className="font-semibold text-sm text-slate-900 truncate">{data.name}</p>
                              {data.locationText && (
                                <p className="text-xs text-slate-400 truncate">{data.locationText}</p>
                              )}
                            </div>
                          </div>
                        </td>
                        {/* ABN */}
                        <td className="px-4 py-3">
                          <span className={`font-mono text-xs ${data.abn ? "text-slate-600" : "text-amber-500 italic"}`}>
                            {data.abn || "Pending"}
                          </span>
                        </td>
                        {/* State */}
                        <td className="px-4 py-3 text-center">
                          {state ? (
                            <span className={`inline-flex px-2.5 py-0.5 rounded-full text-xs font-semibold ${
                              state === "NSW" ? "bg-blue-50 text-blue-600"
                              : state === "VIC" ? "bg-purple-50 text-purple-600"
                              : state === "QLD" ? "bg-orange-50 text-orange-600"
                              : state === "WA" ? "bg-indigo-50 text-indigo-600"
                              : state === "SA" ? "bg-cyan-50 text-cyan-600"
                              : state === "TAS" ? "bg-teal-50 text-teal-600"
                              : state === "NT" ? "bg-yellow-50 text-yellow-600"
                              : state === "ACT" ? "bg-lime-50 text-lime-600"
                              : "bg-slate-100 text-slate-600"
                            }`}>
                              {state}
                            </span>
                          ) : (
                            <span className="text-xs text-slate-400">—</span>
                          )}
                        </td>
                        {/* Plan */}
                        <td className="px-4 py-3">
                          <div className="flex flex-col">
                            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 bg-pink-50 text-pink-700 rounded-full text-xs font-semibold w-fit">
                              <i className="fas fa-crown text-[10px]" />
                              {planLabel}
                            </span>
                            {data.price && (
                              <span className="text-xs text-slate-400 mt-0.5">{data.price}</span>
                            )}
                          </div>
                        </td>
                        {/* Staff */}
                        <td className="px-4 py-3 text-center">
                          <div className="inline-flex items-center gap-1.5">
                            <i className="fas fa-users text-blue-400 text-[10px]" />
                            <span className="text-sm font-semibold text-slate-700">{tenantStats[id]?.staffCount ?? 0}</span>
                          </div>
                        </td>
                        {/* Branches */}
                        <td className="px-4 py-3 text-center">
                          <div className="inline-flex items-center gap-1.5">
                            <i className="fas fa-store text-teal-400 text-[10px]" />
                            <span className="text-sm font-semibold text-slate-700">{tenantStats[id]?.branchCount ?? 0}</span>
                          </div>
                        </td>
                        {/* Status */}
                        <td className="px-4 py-3">
                          <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold whitespace-nowrap ${statusCls}`}>
                            <span className={`w-1.5 h-1.5 rounded-full ${statusDot} flex-shrink-0`} />
                            {shortStatus}
                          </span>
                        </td>
                        {/* Actions */}
                        <td className="px-4 py-3">
                          <div className="flex items-center justify-center gap-1">
                            <button
                              className="w-8 h-8 flex items-center justify-center text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition"
                              onClick={() => {
                                setPreviewTenant({ id, data });
                                setPreviewOpen(true);
                              }}
                              title="Preview"
                            >
                              <i className="fas fa-eye text-xs" />
                            </button>
                            <button
                              className="w-8 h-8 flex items-center justify-center text-slate-400 hover:text-pink-600 hover:bg-pink-50 rounded-lg transition"
                              onClick={() => {
                                setEditTenantId(id);
                                setEditName(data.name || "");
                                setEditAbn(formatAbn(data.abn || ""));
                                setEditState(data.state || "");
                                setEditPlan(data.plan || "");
                                setEditPrice(data.price || "");
                                setEditStatus(data.status || "");
                                setEditLocation(data.locationText || "");
                                setEditPhone(data.contactPhone || "");
                                setEditTimezone(data.timezone || "Australia/Sydney");
                                setEditOpen(true);
                              }}
                              title="Edit"
                            >
                              <i className="fas fa-pen text-xs" />
                            </button>
                            <button
                              className="w-8 h-8 flex items-center justify-center text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition"
                              onClick={() => setDeleteId(id)}
                              title="Delete"
                            >
                              <i className="fas fa-trash-alt text-xs" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </main>
      </div>

      {/* Right preview drawer */}
      {previewOpen && previewTenant && (
        <div className="fixed inset-0 z-50">
          <div className="absolute inset-0 bg-black/40" onClick={() => setPreviewOpen(false)} />
          <div className="absolute right-0 top-0 bottom-0 w-full max-w-lg bg-white border-l border-slate-200 shadow-2xl flex flex-col transform transition-transform duration-300">
            <div className="relative p-6">
              {/* animated colorful gradient border */}
              <div
                className="relative rounded-2xl shadow-md p-[1px] overflow-hidden"
                style={{
                  background:
                    "linear-gradient(120deg, #ff52a2, #a855f7, #60a5fa, #f472b6)",
                  backgroundSize: "300% 300%",
                  animation: "gradientShift 9s ease infinite",
                }}
              >
                <div className="relative rounded-2xl bg-white/90 backdrop-blur-sm p-5">
                  <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-pink-500 to-indigo-600 text-white flex items-center justify-center font-semibold shadow-sm">
                    {(previewTenant.data.name || "?")
                      .split(" ")
                      .map((s) => s[0])
                      .filter(Boolean)
                      .slice(0, 2)
                      .join("")
                      .toUpperCase()}
                  </div>
                    <div className="min-w-0 relative z-[1]">
                      <h3 className="font-bold text-lg text-slate-900 truncate">{previewTenant.data.name}</h3>
                      <p className="text-xs text-slate-500 truncate">{previewTenant.data.locationText || ""}</p>
                    </div>
                  </div>
                  <div className="mt-4 flex flex-wrap items-center gap-2 relative z-[1]">
                    {previewTenant.data.plan && (
                      <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-gradient-to-r from-pink-500 to-fuchsia-600 text-white text-xs font-semibold shadow-sm">
                        <i className="fas fa-crown" /> {previewTenant.data.plan}
                      </span>
                    )}
                    {previewTenant.data.status && (
                      <span
                        className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-white text-xs font-semibold shadow-sm ${
                          String(previewTenant.data.status).toLowerCase().includes("active")
                            ? "bg-gradient-to-r from-emerald-500 to-teal-600"
                            : "bg-gradient-to-r from-amber-500 to-orange-600"
                        }`}
                      >
                        <i
                          className={`fas ${
                            String(previewTenant.data.status).toLowerCase().includes("active")
                              ? "fa-check-circle"
                              : "fa-clock"
                          }`}
                        />
                        {previewTenant.data.status}
                      </span>
                    )}
                  </div>
                </div>
              </div>
              <button
                className="absolute top-3 right-3 text-slate-500 hover:text-slate-700 bg-white border border-slate-200 rounded-full w-8 h-8 flex items-center justify-center shadow-sm"
                onClick={() => setPreviewOpen(false)}
                aria-label="Close preview"
              >
                <i className="fas fa-times text-sm" />
              </button>
            </div>
            <style jsx>{`
              @keyframes gradientShift {
                0% { background-position: 0% 50%; }
                50% { background-position: 100% 50%; }
                100% { background-position: 0% 50%; }
              }
            `}</style>

            <div className="flex-1 overflow-auto bg-slate-50">
              <div className="p-6 space-y-6">
                {/* Email Section - Creative Read-Only Display */}
                <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-pink-500 to-fuchsia-600 flex items-center justify-center shadow-lg shadow-pink-500/20">
                      <i className="fas fa-envelope text-white" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-xs text-slate-500 flex items-center gap-1.5 mb-0.5">
                        Account Email
                        <i className="fas fa-lock text-[9px] text-slate-400" title="Cannot be changed" />
                      </div>
                      <div className="text-slate-900 font-medium truncate">{previewTenant.data.email || "—"}</div>
                    </div>
                    <div className="flex-shrink-0">
                      <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs font-semibold">
                        <i className="fas fa-check-circle text-emerald-500" />
                        Verified
                      </span>
                    </div>
                  </div>
                </div>

                {/* Booking Engine Link */}
                {previewTenant.data.bookingEngineUrl && (
                  <div className="bg-gradient-to-r from-purple-50 to-indigo-50 border border-purple-200 rounded-xl p-4 shadow-sm">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-purple-500 to-indigo-600 flex items-center justify-center shadow-lg shadow-purple-500/20">
                        <i className="fas fa-globe text-white" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-xs text-purple-600 font-semibold mb-0.5">
                          Booking Engine URL
                        </div>
                        <a
                          href={previewTenant.data.bookingEngineUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-indigo-700 font-medium text-sm hover:text-indigo-900 underline truncate block"
                        >
                          {previewTenant.data.bookingEngineUrl}
                        </a>
                      </div>
                      <button
                        className="flex-shrink-0 px-3 py-1.5 bg-purple-600 hover:bg-purple-700 text-white text-xs font-semibold rounded-lg shadow-sm transition-colors"
                        onClick={() => {
                          navigator.clipboard.writeText(previewTenant.data.bookingEngineUrl || "");
                          alert("Booking link copied to clipboard!");
                        }}
                        title="Copy link"
                      >
                        <i className="fas fa-copy mr-1" />
                        Copy
                      </button>
                    </div>
                  </div>
                )}

                {/* Business Details */}
                <div>
                  <div className="text-xs font-semibold text-slate-500 mb-3 flex items-center gap-2">
                    <i className="fas fa-building text-pink-500" />
                    Business Details
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm hover:shadow-md transition-shadow">
                      <div className="flex items-center gap-2 text-xs text-slate-500 mb-1">
                        <i className="fas fa-hashtag text-pink-400" />
                        ABN
                      </div>
                      <div className="font-semibold text-slate-900 font-mono">{previewTenant.data.abn || "Pending"}</div>
                    </div>
                    <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm hover:shadow-md transition-shadow">
                      <div className="flex items-center gap-2 text-xs text-slate-500 mb-1">
                        <i className="fas fa-briefcase text-indigo-400" />
                        Business Structure
                      </div>
                      <div className="font-semibold text-slate-900">{previewTenant.data.businessStructure || "—"}</div>
                    </div>
                    <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm hover:shadow-md transition-shadow">
                      <div className="flex items-center gap-2 text-xs text-slate-500 mb-1">
                        <i className="fas fa-receipt text-emerald-400" />
                        GST Registered
                      </div>
                      <div className="font-semibold text-slate-900 flex items-center gap-2">
                        {previewTenant.data.gstRegistered ? (
                          <span className="text-emerald-600 flex items-center gap-1">
                            <i className="fas fa-check-circle" /> Yes
                          </span>
                        ) : (
                          <span className="text-slate-500">No</span>
                        )}
                      </div>
                    </div>
                    <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm hover:shadow-md transition-shadow">
                      <div className="flex items-center gap-2 text-xs text-slate-500 mb-1">
                        <i className="fas fa-map-marker-alt text-rose-400" />
                        State
                      </div>
                      <div className="font-semibold text-slate-900">{previewTenant.data.state || "—"}</div>
                    </div>
                    <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm hover:shadow-md transition-shadow">
                      <div className="flex items-center gap-2 text-xs text-slate-500 mb-1">
                        <i className="fas fa-users text-blue-400" />
                        Staff Members
                      </div>
                      <div className="font-semibold text-slate-900 flex items-center gap-2">
                        <span className="text-2xl">{tenantStats[previewTenant.id]?.staffCount ?? 0}</span>
                        <span className="text-sm text-slate-500">active staff</span>
                      </div>
                    </div>
                    <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm hover:shadow-md transition-shadow">
                      <div className="flex items-center gap-2 text-xs text-slate-500 mb-1">
                        <i className="fas fa-store text-teal-400" />
                        Branch Locations
                      </div>
                      <div className="font-semibold text-slate-900 flex items-center gap-2">
                        <span className="text-2xl">{tenantStats[previewTenant.id]?.branchCount ?? 0}</span>
                        <span className="text-sm text-slate-500">branches</span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Subscription Details */}
                <div>
                  <div className="text-xs font-semibold text-slate-500 mb-3 flex items-center gap-2">
                    <i className="fas fa-crown text-amber-500" />
                    Subscription
                  </div>
                  <div className="bg-gradient-to-br from-pink-50 to-fuchsia-50 border border-pink-200 rounded-xl p-4 shadow-sm">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-sm text-pink-600 font-medium">Current Plan</div>
                        <div className="text-2xl font-bold text-slate-900">{previewTenant.data.plan || "—"}</div>
                      </div>
                      <div className="text-right">
                        <div className="text-sm text-slate-500">Monthly</div>
                        <div className="text-xl font-bold text-pink-600">{previewTenant.data.price || "—"}</div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Contact & Location */}
                <div>
                  <div className="text-xs font-semibold text-slate-500 mb-3 flex items-center gap-2">
                    <i className="fas fa-address-card text-blue-500" />
                    Contact & Location
                  </div>
                  <div className="grid grid-cols-1 gap-3">
                    <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm hover:shadow-md transition-shadow">
                      <div className="flex items-center gap-2 text-xs text-slate-500 mb-1">
                        <i className="fas fa-phone text-green-400" />
                        Contact Phone
                      </div>
                      <div className="font-semibold text-slate-900">{previewTenant.data.contactPhone || "—"}</div>
                    </div>
                    <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm hover:shadow-md transition-shadow">
                      <div className="flex items-center gap-2 text-xs text-slate-500 mb-1">
                        <i className="fas fa-location-dot text-rose-400" />
                        Location
                      </div>
                      <div className="font-semibold text-slate-900">{previewTenant.data.locationText || "—"}</div>
                    </div>
                    <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm hover:shadow-md transition-shadow">
                      <div className="flex items-center gap-2 text-xs text-slate-500 mb-1">
                        <i className="fas fa-globe text-blue-400" />
                        Time Zone
                      </div>
                      <div className="font-semibold text-slate-900">{previewTenant.data.timezone || "Australia/Sydney"}</div>
                    </div>
                  </div>
                </div>

                {/* Timestamps */}
                {(previewTenant.data.createdAt || previewTenant.data.updatedAt) && (
                  <div>
                    <div className="text-xs font-semibold text-slate-500 mb-3 flex items-center gap-2">
                      <i className="fas fa-clock text-slate-400" />
                      Activity
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      {previewTenant.data.createdAt && (
                        <div className="bg-white border border-slate-200 rounded-xl p-3 shadow-sm">
                          <div className="text-[10px] text-slate-400 uppercase tracking-wide">Created</div>
                          <div className="text-xs font-medium text-slate-700 mt-1">
                            {previewTenant.data.createdAt?.toDate?.()?.toLocaleDateString?.() || "—"}
                          </div>
                        </div>
                      )}
                      {previewTenant.data.updatedAt && (
                        <div className="bg-white border border-slate-200 rounded-xl p-3 shadow-sm">
                          <div className="text-[10px] text-slate-400 uppercase tracking-wide">Last Updated</div>
                          <div className="text-xs font-medium text-slate-700 mt-1">
                            {previewTenant.data.updatedAt?.toDate?.()?.toLocaleDateString?.() || "—"}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
                  <div className="text-xs font-semibold text-slate-500 mb-3">Quick actions</div>
                  <div className="flex items-center gap-3">
                    <button
                      className="px-4 py-2 rounded-lg bg-gradient-to-r from-pink-600 to-fuchsia-600 hover:from-pink-700 hover:to-fuchsia-700 text-white text-sm font-semibold shadow-lg shadow-pink-500/25 transition-all"
                      onClick={() => {
                        setEditTenantId(previewTenant.id);
                        const d = previewTenant.data;
                        setEditName(d.name || "");
                        setEditAbn(formatAbn(d.abn || ""));
                        setEditState(d.state || "");
                        setEditPlan(d.plan || "");
                        setEditPrice(d.price || "");
                        setEditStatus(d.status || "");
                        setEditLocation(d.locationText || "");
                        setEditPhone(d.contactPhone || "");
                        setEditTimezone(d.timezone || "Australia/Sydney");
                        setEditOpen(true);
                      }}
                    >
                      <i className="fas fa-edit mr-2" />
                      Edit Details
                    </button>
                    <button
                      className={`px-4 py-2 rounded-lg text-white text-sm font-semibold shadow-sm ${
                        String(previewTenant.data.status || "").toLowerCase().includes("suspend") || (previewTenant.data as any).suspended
                          ? "bg-emerald-600 hover:bg-emerald-700"
                          : "bg-amber-600 hover:bg-amber-700"
                      }`}
                      onClick={() => {
                        const isSuspended =
                          Boolean((previewTenant.data as any).suspended) ||
                          String(previewTenant.data.status || "").toLowerCase().includes("suspend");
                        setSuspendTarget({ id: previewTenant.id, isSuspended });
                      }}
                    >
                      <i
                        className={`fas ${
                          String(previewTenant.data.status || "").toLowerCase().includes("suspend") ||
                          (previewTenant.data as any).suspended
                            ? "fa-unlock"
                            : "fa-ban"
                        } mr-2`}
                      />
                      {String(previewTenant.data.status || "").toLowerCase().includes("suspend") ||
                      (previewTenant.data as any).suspended
                        ? "Unsuspend"
                        : "Suspend"}
                    </button>
                    <button
                      className="px-4 py-2 rounded-lg bg-rose-600 hover:bg-rose-700 text-white text-sm font-semibold shadow-sm"
                      onClick={() => setDeleteId(previewTenant.id)}
                    >
                      <i className="fas fa-trash mr-2" />
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Edit modal */}
      {editOpen && editTenantId && (
        <div className="fixed inset-0 z-50">
          <div className="absolute inset-0 bg-black/50" onClick={() => setEditOpen(false)} />
          <div className="relative flex items-start md:items-center justify-center min-h-screen p-4 overflow-y-auto">
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col">
              <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between bg-gradient-to-r from-pink-500 to-fuchsia-600 rounded-t-2xl">
                <div>
                  <h3 className="text-lg font-semibold text-white">Edit Tenant Details</h3>
                  <p className="text-xs text-white/70">Update business information</p>
                </div>
                <button className="text-white/80 hover:text-white bg-white/10 hover:bg-white/20 rounded-lg w-8 h-8 flex items-center justify-center transition" onClick={() => setEditOpen(false)}>
                  <i className="fas fa-times" />
                </button>
              </div>
              <div className="p-6 space-y-5 overflow-auto">
                {/* Email - Read Only with Creative Display */}
                <div className="bg-gradient-to-r from-slate-100 to-slate-50 border-2 border-dashed border-slate-300 rounded-xl p-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-lg bg-slate-200 flex items-center justify-center">
                        <i className="fas fa-envelope text-slate-500" />
                      </div>
                      <div>
                        <div className="text-xs text-slate-500 flex items-center gap-1.5">
                          Account Email
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 text-[10px] font-semibold">
                            <i className="fas fa-lock text-[8px]" />
                            Read Only
                          </span>
                        </div>
                        <div className="font-medium text-slate-900">{tenants.find(t => t.id === editTenantId)?.data.email || "—"}</div>
                      </div>
                    </div>
                    <div className="text-xs text-slate-400 flex items-center gap-1">
                      <i className="fas fa-shield-alt" />
                      Protected
                    </div>
                  </div>
                  <p className="text-[10px] text-slate-400 mt-2 pl-13">
                    Email cannot be changed as it&apos;s linked to the authentication account
                  </p>
                </div>

                {/* Business Name */}
                <div>
                  <label className="block text-sm font-semibold text-slate-700 mb-1.5 flex items-center gap-2">
                    <i className="fas fa-store text-pink-500" />
                    Business Name
                  </label>
                  <input className="w-full px-4 py-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-pink-500 focus:border-transparent" value={editName} onChange={(e) => setEditName(e.target.value)} placeholder="Enter business name" />
                </div>

                {/* ABN & State Row */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-semibold text-slate-700 mb-1.5 flex items-center gap-2">
                      <i className="fas fa-hashtag text-indigo-500" />
                      ABN
                    </label>
                    <input className="w-full px-4 py-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-pink-500 focus:border-transparent font-mono tracking-wide" value={editAbn} onChange={(e) => setEditAbn(formatAbn(e.target.value))} placeholder="XX XXX XXX XXX" maxLength={14} />
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-slate-700 mb-1.5 flex items-center gap-2">
                      <i className="fas fa-map-marker-alt text-rose-500" />
                      State
                    </label>
                    <div className="relative">
                      <select
                        className="w-full appearance-none pr-10 px-4 py-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-pink-500 focus:border-transparent"
                        value={editState}
                        onChange={(e) => setEditState(e.target.value)}
                      >
                        <option value="">Select state</option>
                        <option>NSW</option>
                        <option>VIC</option>
                        <option>QLD</option>
                        <option>WA</option>
                        <option>SA</option>
                        <option>TAS</option>
                        <option>ACT</option>
                        <option>NT</option>
                      </select>
                      <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-slate-500">
                        <i className="fas fa-chevron-down" />
                      </span>
                    </div>
                  </div>
                </div>

                {/* Business Structure & GST Row */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-semibold text-slate-700 mb-1.5 flex items-center gap-2">
                      <i className="fas fa-briefcase text-purple-500" />
                      Business Structure
                    </label>
                    <div className="relative">
                      <select
                        className="w-full appearance-none pr-10 px-4 py-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-pink-500 focus:border-transparent"
                        value={(tenants.find(t => t.id === editTenantId)?.data as any)?.businessStructure || ""}
                        onChange={(e) => {
                          // Update local tenants state for businessStructure
                          setTenants(prev => prev.map(t => 
                            t.id === editTenantId 
                              ? { ...t, data: { ...t.data, businessStructure: e.target.value } }
                              : t
                          ));
                        }}
                      >
                        <option value="">Select structure</option>
                        <option value="Pty Ltd">Pty Ltd</option>
                        <option value="Sole Trader">Sole Trader</option>
                        <option value="Partnership">Partnership</option>
                        <option value="Trust">Trust</option>
                      </select>
                      <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-slate-500">
                        <i className="fas fa-chevron-down" />
                      </span>
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-slate-700 mb-1.5 flex items-center gap-2">
                      <i className="fas fa-receipt text-emerald-500" />
                      GST Registered
                    </label>
                    <div className="flex items-center gap-3 h-[50px] px-4 border border-slate-300 rounded-lg bg-white">
                      <label className="relative inline-flex items-center cursor-pointer">
                        <input
                          type="checkbox"
                          className="sr-only peer"
                          checked={(tenants.find(t => t.id === editTenantId)?.data as any)?.gstRegistered || false}
                          onChange={(e) => {
                            setTenants(prev => prev.map(t => 
                              t.id === editTenantId 
                                ? { ...t, data: { ...t.data, gstRegistered: e.target.checked } }
                                : t
                            ));
                          }}
                        />
                        <div className="w-11 h-6 bg-slate-300 peer-focus:ring-2 peer-focus:ring-pink-500 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-emerald-500" />
                      </label>
                      <span className="text-sm text-slate-600">
                        {(tenants.find(t => t.id === editTenantId)?.data as any)?.gstRegistered ? "Yes, registered" : "Not registered"}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Plan & Status Row */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-semibold text-slate-700 mb-1.5 flex items-center gap-2">
                      <i className="fas fa-crown text-amber-500" />
                      Plan
                    </label>
                    <div className="relative">
                      <select
                        className="w-full appearance-none pr-10 px-4 py-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-pink-500 focus:border-transparent"
                        value={editPlan}
                        onChange={(e) => {
                          setEditPlan(e.target.value);
                          // Auto-set price based on plan
                          const prices: Record<string, string> = {
                            "Starter": "AU$99/mo",
                            "Pro": "AU$149/mo",
                            "Enterprise": "AU$299/mo"
                          };
                          setEditPrice(prices[e.target.value] || "");
                        }}
                      >
                        <option value="">Select plan</option>
                        <option value="Starter">Starter</option>
                        <option value="Pro">Pro</option>
                        <option value="Enterprise">Enterprise</option>
                      </select>
                      <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-slate-500">
                        <i className="fas fa-chevron-down" />
                      </span>
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-slate-700 mb-1.5 flex items-center gap-2">
                      <i className="fas fa-circle-check text-blue-500" />
                      Status
                    </label>
                    <div className="relative">
                      <select
                        className="w-full appearance-none pr-10 px-4 py-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-pink-500 focus:border-transparent"
                        value={editStatus}
                        onChange={(e) => setEditStatus(e.target.value)}
                      >
                        <option value="">Select status</option>
                        <option value="Active">Active</option>
                        <option value="Pending ABN">Pending ABN</option>
                        <option value="Provisioning">Provisioning</option>
                        <option value="Suspended">Suspended</option>
                      </select>
                      <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-slate-500">
                        <i className="fas fa-chevron-down" />
                      </span>
                    </div>
                  </div>
                </div>

                {/* Location */}
                <div>
                  <label className="block text-sm font-semibold text-slate-700 mb-1.5 flex items-center gap-2">
                    <i className="fas fa-location-dot text-rose-500" />
                    Location / Address
                  </label>
                  <textarea 
                    className="w-full px-4 py-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-pink-500 focus:border-transparent resize-none" 
                    rows={2}
                    value={editLocation} 
                    onChange={(e) => setEditLocation(e.target.value)} 
                    placeholder="Full business address"
                  />
                </div>

                {/* Phone & Timezone Row */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-semibold text-slate-700 mb-1.5 flex items-center gap-2">
                      <i className="fas fa-phone text-green-500" />
                      Contact Phone
                    </label>
                    <div className="flex">
                      <span className="inline-flex items-center px-3 py-3 rounded-l-lg border border-r-0 border-slate-300 bg-slate-50 text-slate-500 text-sm">
                        +61
                      </span>
                      <input 
                        className="flex-1 px-4 py-3 border border-slate-300 rounded-r-lg focus:ring-2 focus:ring-pink-500 focus:border-transparent" 
                        value={editPhone} 
                        onChange={(e) => setEditPhone(e.target.value)} 
                        placeholder="412 345 678"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-slate-700 mb-1.5 flex items-center gap-2">
                      <i className="fas fa-globe text-blue-500" />
                      Time Zone
                    </label>
                    <div className="relative">
                      <select
                        className="w-full appearance-none pr-10 px-4 py-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-pink-500 focus:border-transparent"
                        value={editTimezone}
                        onChange={(e) => setEditTimezone(e.target.value)}
                      >
                        {TIMEZONES.map((tz) => (
                          <option key={tz.value} value={tz.value}>
                            {tz.label}
                          </option>
                        ))}
                      </select>
                      <i className="fas fa-chevron-down absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
                    </div>
                  </div>
                </div>
              </div>
              <div className="px-6 py-4 border-t border-slate-200 flex items-center justify-end gap-2">
                <button
                  className="px-4 py-2 rounded-lg text-slate-700 hover:bg-slate-100 text-sm font-semibold disabled:opacity-60"
                  onClick={() => setEditOpen(false)}
                  disabled={savingEdit}
                >
                  Cancel
                </button>
                <button
                  className="px-5 py-2.5 rounded-lg bg-gradient-to-r from-pink-600 to-fuchsia-600 hover:from-pink-700 hover:to-fuchsia-700 text-white text-sm font-semibold disabled:opacity-70 inline-flex items-center gap-2 shadow-lg shadow-pink-500/25 transition-all"
                  disabled={savingEdit}
onClick={async () => {
                                    if (!editTenantId) return;
                                    try {
                                      setSavingEdit(true);
                                      const tenantData = tenants.find(t => t.id === editTenantId)?.data;
                                      await updateDoc(doc(db, "users", editTenantId), {
                                        name: editName.trim(),
                                        abn: editAbn.replace(/\s/g, '').trim() || null,
                                        state: editState || null,
                                        timezone: editTimezone || "Australia/Sydney",
                                        plan: editPlan || null,
                                        price: editPrice || null,
                                        status: editStatus || null,
                                        locationText: editLocation || null,
                                        contactPhone: editPhone || null,
                                        businessStructure: (tenantData as any)?.businessStructure || null,
                                        gstRegistered: (tenantData as any)?.gstRegistered || false,
                                        updatedAt: serverTimestamp(),
                                      });
                                      
                                      // Log tenant details update
                                      if (currentAdmin) {
                                        console.log("[Tenants] Logging tenant update, admin:", currentAdmin);
                                        try {
                                          await logTenantDetailsUpdated(
                                            editTenantId,
                                            editName.trim(),
                                            currentAdmin,
                                            "Business details updated"
                                          );
                                        } catch (auditError) {
                                          console.warn("Failed to create audit log:", auditError);
                                        }
                                      } else {
                                        console.warn("[Tenants] No currentAdmin set, skipping audit log");
                                      }
                                    } catch (e: any) {
                                      alert(e?.message || "Failed to update");
                                    } finally {
                                      setSavingEdit(false);
                                      setEditOpen(false);
                                    }
                                  }}
                >
                  {savingEdit ? (
                    <>
                      <i className="fas fa-circle-notch fa-spin" />
                      Saving...
                    </>
                  ) : (
                    <>
                      <i className="fas fa-check" />
                      Save Changes
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirm */}
      {deleteId && (
        <div className="fixed inset-0 z-50">
          <div className="absolute inset-0 bg-black/50" onClick={() => setDeleteId(null)} />
          <div className="absolute inset-0 flex items-center justify-center p-4">
            <div className="w-full max-w-sm bg-white rounded-2xl shadow-2xl border border-slate-200">
              <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
                <h3 className="text-base font-semibold text-slate-900">Delete tenant</h3>
                <button className="text-slate-400 hover:text-slate-600" onClick={() => setDeleteId(null)}>
                  <i className="fas fa-times" />
                </button>
              </div>
              <div className="px-5 py-4">
                <p className="text-sm text-slate-600">This action cannot be undone. Are you sure?</p>
              </div>
              <div className="px-5 py-4 border-t border-slate-200 flex items-center justify-end gap-2">
                <button onClick={() => setDeleteId(null)} className="px-4 py-2 rounded-lg text-slate-700 hover:bg-slate-100 text-sm font-semibold">
                  Cancel
                </button>
                <button
onClick={async () => {
                                    try {
                                      const tenantToDelete = tenants.find(t => t.id === deleteId);
                                      await deleteDoc(doc(db, "users", deleteId));
                                      
                                      // Log tenant deletion
                                      if (currentAdmin && tenantToDelete) {
                                        try {
                                          await logTenantDeleted(
                                            deleteId,
                                            tenantToDelete.data.name || "Unknown Tenant",
                                            currentAdmin
                                          );
                                        } catch (auditError) {
                                          console.warn("Failed to create audit log:", auditError);
                                        }
                                      }
                                      
                                      setDeleteId(null);
                                      if (previewTenant?.id === deleteId) {
                                        setPreviewOpen(false);
                                        setPreviewTenant(null);
                                      }
                                    } catch (e: any) {
                                      alert(e?.message || "Failed to delete");
                                    }
                                  }}
                  className="px-4 py-2 rounded-lg bg-rose-600 hover:bg-rose-700 text-white text-sm font-semibold"
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Suspend/Unsuspend confirm */}
      {suspendTarget && (
        <div className="fixed inset-0 z-50">
          <div className="absolute inset-0 bg-black/50" onClick={() => setSuspendTarget(null)} />
          <div className="absolute inset-0 flex items-center justify-center p-4">
            <div className="w-full max-w-sm bg-white rounded-2xl shadow-2xl border border-slate-200">
              <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
                <h3 className="text-base font-semibold text-slate-900">
                  {suspendTarget.isSuspended ? "Unsuspend tenant" : "Suspend tenant"}
                </h3>
                <button className="text-slate-400 hover:text-slate-600" onClick={() => setSuspendTarget(null)}>
                  <i className="fas fa-times" />
                </button>
              </div>
              <div className="px-5 py-4">
                <p className="text-sm text-slate-600">
                  {suspendTarget.isSuspended
                    ? "This tenant will regain access. Continue?"
                    : "This tenant will be blocked from logging in. Continue?"}
                </p>
              </div>
              <div className="px-5 py-4 border-t border-slate-200 flex items-center justify-end gap-2">
                <button onClick={() => setSuspendTarget(null)} className="px-4 py-2 rounded-lg text-slate-700 hover:bg-slate-100 text-sm font-semibold">
                  Cancel
                </button>
                <button
                  onClick={async () => {
                    if (!suspendTarget || !suspendTarget.id) {
                      alert("Invalid tenant id. Please close and try again.");
                      setSuspendTarget(null);
                      return;
                    }
                    try {
                      setSuspending(true);
                      const { auth } = await import("@/lib/firebase");
                      const token = await auth.currentUser?.getIdToken();
                      const res = await fetch(`/api/users/${suspendTarget.id}/suspend`, {
                        method: "POST",
                        headers: {
                          "Content-Type": "application/json",
                          Authorization: `Bearer ${token || ""}`,
                        },
                        body: JSON.stringify({ suspended: !suspendTarget.isSuspended }),
                      });
                      if (!res.ok) {
                        const data = await res.json().catch(() => ({}));
                        throw new Error(data?.error || "Failed to update suspension");
                      }
                      const data = await res.json().catch(() => ({}));
                      const newSuspended = Boolean(data?.suspended);
                      const newStatus = (data?.status || (newSuspended ? "Suspended" : "Active")).toString();
                      
                      // Log suspend/unsuspend action
                      if (currentAdmin) {
                        const tenantName = tenants.find(t => t.id === suspendTarget.id)?.data.name || "Unknown Tenant";
                        try {
                          if (newSuspended) {
                            await logTenantSuspended(suspendTarget.id, tenantName, currentAdmin);
                          } else {
                            await logTenantUnsuspended(suspendTarget.id, tenantName, currentAdmin);
                          }
                        } catch (auditError) {
                          console.warn("Failed to create audit log:", auditError);
                        }
                      }
                      
                      // Optimistically update drawer button and list without closing
                      setPreviewTenant((prev) =>
                        prev && prev.id === suspendTarget.id
                          ? { id: prev.id, data: { ...(prev.data as any), suspended: newSuspended, status: newStatus } }
                          : prev
                      );
                      setTenants((prev) =>
                        prev.map((t) =>
                          t.id === suspendTarget.id ? { id: t.id, data: { ...(t.data as any), suspended: newSuspended, status: newStatus } } : t
                        )
                      );
                      setSuspendTarget(null);
                    } catch (e: any) {
                      alert(e?.message || "Failed to update suspension");
                    } finally {
                      setSuspending(false);
                    }
                  }}
                  className={`px-4 py-2 rounded-lg text-white text-sm font-semibold ${
                    suspendTarget.isSuspended ? "bg-emerald-600 hover:bg-emerald-700" : "bg-amber-600 hover:bg-amber-700"
                  } disabled:opacity-60 inline-flex items-center gap-2`}
                  disabled={suspending}
                >
                  {suspending ? <i className="fas fa-circle-notch fa-spin" /> : suspendTarget.isSuspended ? <i className="fas fa-unlock" /> : <i className="fas fa-ban" />}
                  {suspendTarget.isSuspended ? "Unsuspend" : "Suspend"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {isModalOpen && (
        <div className="fixed inset-0 z-50">
          <div className="absolute inset-0 bg-black/50" onClick={closeOnboardModal} />
          <div className="relative flex items-center justify-center min-h-screen p-4">
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg flex flex-col my-auto">
              <div className="px-5 py-4 border-b border-slate-200 shrink-0">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-xl font-bold text-slate-900">Onboard New Salon</h2>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Setup a new tenant with Australian compliance
                    </p>
                  </div>
                  <button onClick={closeOnboardModal} className="p-2 hover:bg-slate-100 rounded-lg transition">
                    <i className="fas fa-times text-slate-400" />
                  </button>
                </div>
                <div className="flex items-center mt-6">
                  {/* Step 1 */}
                  <div className="flex flex-col items-center">
                    <div className={stepIndicatorClass(1)}>
                      {currentStep > 1 ? <i className="fas fa-check text-xs" /> : "1"}
                    </div>
                    <span className={`mt-2 ${stepLabelClass(1)}`}>Business</span>
                  </div>
                  
                  {/* Line 1-2 */}
                  <div className={`${stepLineClass(1)} mx-4`} />
                  
                  {/* Step 2 */}
                  <div className="flex flex-col items-center">
                    <div className={stepIndicatorClass(2)}>
                      {currentStep > 2 ? <i className="fas fa-check text-xs" /> : "2"}
                    </div>
                    <span className={`mt-2 ${stepLabelClass(2)}`}>Location</span>
                  </div>
                  
                  {/* Line 2-3 */}
                  <div className={`${stepLineClass(2)} mx-4`} />
                  
                  {/* Step 3 */}
                  <div className="flex flex-col items-center">
                    <div className={stepIndicatorClass(3)}>3</div>
                    <span className={`mt-2 ${stepLabelClass(3)}`}>Plan</span>
                  </div>
                </div>
              </div>

              <div className="px-5 py-4 overflow-y-auto flex-1 min-h-0 max-h-[60vh]">
                {currentStep === 1 && (
                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-semibold text-slate-700 mb-2">
                        Business Name *
                      </label>
                      <input
                        type="text"
                        placeholder="e.g., Sydney Style Studio"
                        value={formBusinessName}
                        onChange={(e) => setFormBusinessName(e.target.value)}
                        className="w-full px-4 py-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-pink-500 focus:border-transparent"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-semibold text-slate-700 mb-2">
                        Australian Business Number (ABN) *
                      </label>
                      <div className="flex space-x-3">
                        <input
                          id="abn-input"
                          type="text"
                          placeholder="12 345 678 901"
                          maxLength={14}
                          value={formAbn}
                          onChange={(e) => setFormAbn(formatAbn(e.target.value))}
                          className="flex-1 px-4 py-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-pink-500 focus:border-transparent font-mono tracking-wide"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="block text-sm font-semibold text-slate-700 mb-2">
                        Business Structure *
                      </label>
                      <div className="relative">
                        <select
                          className="w-full px-4 py-3 pr-12 border border-slate-300 rounded-lg focus:ring-2 focus:ring-pink-500 focus:border-transparent appearance-none"
                          value={formStructure}
                          onChange={(e) => setFormStructure(e.target.value)}
                        >
                          <option value="">Select structure</option>
                          <option>Pty Ltd</option>
                          <option>Sole Trader</option>
                          <option>Partnership</option>
                          <option>Trust</option>
                        </select>
                        <i className="fas fa-chevron-down absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
                      </div>
                    </div>
                    <div className="flex items-center justify-between p-4 bg-slate-50 rounded-lg">
                      <div>
                        <p className="font-semibold text-slate-900">Registered for GST?</p>
                        <p className="text-sm text-slate-500 mt-1">
                          Required for businesses with turnover over AU$75,000
                        </p>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer">
                        <input
                          type="checkbox"
                          className="sr-only peer"
                          checked={formGst}
                          onChange={(e) => setFormGst(e.target.checked)}
                        />
                        <div className="w-11 h-6 bg-slate-300 peer-focus:ring-2 peer-focus:ring-pink-500 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-pink-500" />
                      </label>
                    </div>
                  </div>
                )}

                {currentStep === 2 && (
                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-semibold text-slate-700 mb-2">
                        Business Address *
                      </label>
                      <textarea
                        rows={3}
                        placeholder="Street address"
                        value={formAddress}
                        onChange={(e) => setFormAddress(e.target.value)}
                        className="w-full px-4 py-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-pink-500 focus:border-transparent"
                      />
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-semibold text-slate-700 mb-2">
                          State *
                        </label>
                        <div className="relative">
                          <select
                            className="w-full px-4 py-3 pr-12 border border-slate-300 rounded-lg focus:ring-2 focus:ring-pink-500 focus:border-transparent appearance-none"
                            value={formState}
                            onChange={(e) => setFormState(e.target.value)}
                          >
                            <option value="">Select state</option>
                            <option>NSW</option>
                            <option>VIC</option>
                            <option>QLD</option>
                            <option>WA</option>
                            <option>SA</option>
                            <option>TAS</option>
                            <option>ACT</option>
                            <option>NT</option>
                          </select>
                          <i className="fas fa-chevron-down absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
                        </div>
                      </div>
                      <div>
                        <label className="block text-sm font-semibold text-slate-700 mb-2">
                          Postcode *
                        </label>
                        <input
                          type="text"
                          placeholder="2000"
                          maxLength={4}
                          value={formPostcode}
                          onChange={(e) => setFormPostcode(e.target.value)}
                          className="w-full px-4 py-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-pink-500 focus:border-transparent"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="block text-sm font-semibold text-slate-700 mb-2">
                        Time Zone *
                      </label>
                      <div className="relative">
                        <i className="fas fa-globe absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" />
                        <select
                          className="w-full pl-10 pr-12 py-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-pink-500 focus:border-transparent appearance-none"
                          value={formTimezone}
                          onChange={(e) => setFormTimezone(e.target.value)}
                        >
                          {TIMEZONES.map((tz) => (
                            <option key={tz.value} value={tz.value}>
                              {tz.label}
                            </option>
                          ))}
                        </select>
                        <i className="fas fa-chevron-down absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
                      </div>
                      <p className="text-xs text-slate-500 mt-1">
                        This timezone will be used for all bookings and operations
                      </p>
                    </div>
                    <div>
                      <label className="block text-sm font-semibold text-slate-700 mb-2">
                        Contact Phone *
                      </label>
                      <div className="flex space-x-3">
                        <input
                          type="text"
                          value="+61"
                          readOnly
                          className="w-16 px-3 py-3 bg-slate-100 border border-slate-300 rounded-lg font-mono text-center"
                        />
                        <input
                          type="text"
                          placeholder="412 345 678"
                          value={formPhone}
                          onChange={(e) => setFormPhone(e.target.value)}
                          className="flex-1 px-4 py-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-pink-500 focus:border-transparent"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="block text-sm font-semibold text-slate-700 mb-2">
                        Email *
                      </label>
                      <input
                        type="email"
                        placeholder="contact@salon.com.au"
                        value={formEmail}
                        onChange={(e) => {
                          setFormEmail(e.target.value);
                          if (emailError) setEmailError("");
                        }}
                        className={`w-full px-4 py-3 border rounded-lg focus:ring-2 focus:ring-pink-500 focus:border-transparent ${
                          emailError ? "border-rose-500" : "border-slate-300"
                        }`}
                      />
                      {emailError && (
                        <p className="text-sm text-rose-600 mt-1">{emailError}</p>
                      )}
                    </div>
                    <div>
                      <label className="block text-sm font-semibold text-slate-700 mb-2">
                        Owner Password *
                      </label>
                      <div className="relative">
                        <input
                          type={showOwnerPassword ? "text" : "password"}
                          placeholder="Temporary password for owner"
                          value={formOwnerPassword}
                          onChange={(e) => setFormOwnerPassword(e.target.value)}
                          className="w-full px-4 py-3 pr-12 border border-slate-300 rounded-lg focus:ring-2 focus:ring-pink-500 focus:border-transparent"
                        />
                        <button
                          type="button"
                          aria-label={showOwnerPassword ? "Hide password" : "Show password"}
                          onClick={() => setShowOwnerPassword((s) => !s)}
                          className="absolute inset-y-0 right-0 px-3 text-slate-500 hover:text-slate-700"
                        >
                          <i className={`fas ${showOwnerPassword ? "fa-eye-slash" : "fa-eye"}`} />
                        </button>
                      </div>
                      <p className="text-xs text-slate-500 mt-1">
                        A salon owner account will be created with this password.
                      </p>
                    </div>
                  </div>
                )}

                {currentStep === 3 && (
                  <div className="space-y-3">
                    <p className="text-sm font-semibold text-slate-700">
                      Select a subscription plan
                    </p>
                    {packagesLoading ? (
                      <div className="flex items-center justify-center py-6">
                        <div className="flex flex-col items-center gap-2">
                          <i className="fas fa-circle-notch fa-spin text-2xl text-pink-500" />
                          <p className="text-xs text-slate-500">Loading packages...</p>
                        </div>
                      </div>
                    ) : packages.length === 0 ? (
                      <div className="text-center py-6">
                        <p className="text-sm text-slate-500">No packages available.</p>
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {packages.map((pkg) => {
                          const isSelected = selectedPlan === pkg.id;
                          const colorClass = pkg.color === "blue" ? "bg-blue-500" 
                            : pkg.color === "pink" ? "bg-pink-500" 
                            : pkg.color === "purple" ? "bg-purple-500" 
                            : pkg.color === "green" ? "bg-emerald-500"
                            : pkg.color === "orange" ? "bg-orange-500"
                            : pkg.color === "teal" ? "bg-teal-500"
                            : "bg-slate-500";
                          
                          return (
                            <button
                              key={pkg.id}
                              onClick={() => setSelectedPlan(pkg.id)}
                              className={`w-full p-3 rounded-xl border-2 transition-all duration-200 text-left ${
                                isSelected 
                                  ? "border-pink-500 bg-pink-50/50" 
                                  : "border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50"
                              }`}
                            >
                              {/* Header row */}
                              <div className="flex items-center gap-3">
                                {/* Color indicator & image */}
                                <div className={`w-10 h-10 rounded-lg ${colorClass} flex items-center justify-center overflow-hidden flex-shrink-0`}>
                                  {pkg.image ? (
                                    <img src={pkg.image} alt={pkg.name} className="w-full h-full object-cover" />
                                  ) : (
                                    <i className="fas fa-box text-white" />
                                  )}
                                </div>
                                
                                {/* Plan name & badges */}
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2">
                                    <h4 className="font-semibold text-slate-900">{pkg.name}</h4>
                                    {pkg.popular && (
                                      <span className="text-[10px] font-bold bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded">
                                        Popular
                                      </span>
                                    )}
                                  </div>
                                </div>
                                
                                {/* Price & selection */}
                                <div className="text-right flex-shrink-0 flex items-center gap-2">
                                  <div className="font-bold text-slate-900">{pkg.priceLabel}</div>
                                  {isSelected ? (
                                    <i className="fas fa-check-circle text-pink-500" />
                                  ) : (
                                    <div className="w-5 h-5 rounded-full border-2 border-slate-300" />
                                  )}
                                </div>
                              </div>
                              
                              {/* Details row */}
                              <div className="mt-2 pt-2 border-t border-slate-100">
                                <div className="flex items-center gap-4 text-xs text-slate-600">
                                  <span className="flex items-center gap-1">
                                    <i className="fas fa-building text-slate-400" />
                                    {pkg.branches === -1 ? "Unlimited" : pkg.branches} {pkg.branches === 1 ? "Branch" : "Branches"}
                                  </span>
                                  <span className="flex items-center gap-1">
                                    <i className="fas fa-users text-slate-400" />
                                    {pkg.staff === -1 ? "Unlimited" : pkg.staff} Staff
                                  </span>
                                </div>
                                
                                {/* Features - Line by line */}
                                {pkg.features && pkg.features.length > 0 && (
                                  <ul className="mt-2 space-y-1">
                                    {pkg.features.slice(0, 5).map((feature, idx) => (
                                      <li key={idx} className="flex items-center gap-2 text-xs text-slate-600">
                                        <i className="fas fa-check text-emerald-500 text-[10px]" />
                                        {feature}
                                      </li>
                                    ))}
                                    {pkg.features.length > 5 && (
                                      <li className="text-xs text-slate-400 pl-4">
                                        +{pkg.features.length - 5} more features
                                      </li>
                                    )}
                                  </ul>
                                )}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    )}
                    <div className="p-2.5 bg-amber-50 border border-amber-200 rounded-lg">
                      <p className="text-xs text-amber-800">
                        <i className="fas fa-info-circle mr-1.5" />
                        Invoice will be generated upon tenant activation
                      </p>
                    </div>
                  </div>
                )}
              </div>

              <div className="px-5 py-3 border-t border-slate-100 bg-slate-50/50 flex items-center justify-between shrink-0">
                <button
                  onClick={goBack}
                  disabled={creating}
                  className={`inline-flex items-center gap-2 px-4 py-2.5 text-slate-600 font-medium hover:bg-white hover:shadow-sm rounded-lg border border-transparent hover:border-slate-200 transition-all duration-200 disabled:opacity-60 ${
                    currentStep === 1 ? "invisible" : ""
                  }`}
                >
                  <i className="fas fa-chevron-left text-xs" />
                  Back
                </button>
                <div className="flex-1" />
                <button
                  onClick={closeOnboardModal}
                  disabled={creating}
                  className="px-4 py-2.5 text-slate-500 font-medium hover:text-slate-700 hover:bg-white rounded-lg transition-all duration-200 mr-2 disabled:opacity-60"
                >
                  Cancel
                </button>
                <button
                  onClick={goNext}
                  disabled={creating || (currentStep === 3 && !selectedPlan)}
                  className={`inline-flex items-center gap-2 px-5 py-2.5 font-semibold rounded-lg transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed ${
                    currentStep === 3 
                      ? "bg-gradient-to-r from-emerald-500 to-emerald-600 text-white shadow-lg shadow-emerald-500/25 hover:shadow-emerald-500/40 hover:from-emerald-600 hover:to-emerald-700" 
                      : "bg-gradient-to-r from-pink-500 to-pink-600 text-white shadow-lg shadow-pink-500/25 hover:shadow-pink-500/40 hover:from-pink-600 hover:to-pink-700"
                  }`}
                >
                  {creating ? (
                    <>
                      <i className="fas fa-circle-notch fa-spin text-sm" />
                      <span>Creating...</span>
                    </>
                  ) : currentStep === 3 ? (
                    <>
                      <i className="fas fa-check text-sm" />
                      <span>Complete Onboarding</span>
                    </>
                  ) : (
                    <>
                      <span>Continue</span>
                      <i className="fas fa-chevron-right text-xs" />
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


