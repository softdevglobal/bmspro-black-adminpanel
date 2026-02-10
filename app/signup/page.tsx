"use client";
import React, { useState, useEffect, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createUserWithEmailAndPassword } from "firebase/auth";
import { doc, setDoc, serverTimestamp } from "firebase/firestore";
import { auth, db } from "@/lib/firebase";
import { TIMEZONES } from "@/lib/timezone";
import { generateUniqueSlug } from "@/lib/slug";

interface Package {
  id: string;
  name: string;
  price: number;
  priceLabel: string;
  branches: number;
  staff: number;
  features: string[];
  popular?: boolean;
  color: string;
  image?: string;
  trialDays?: number;
  plan_key?: string;
  active?: boolean;
  hidden?: boolean;
}

export default function SignupPage() {
  const router = useRouter();
  const [currentStep, setCurrentStep] = useState<1 | 2 | 3>(1);
  const [packages, setPackages] = useState<Package[]>([]);
  const [packagesLoading, setPackagesLoading] = useState(false);
  const [selectedPlan, setSelectedPlan] = useState<string | null>(null);
  
  // Business details (Step 1)
  const [formBusinessName, setFormBusinessName] = useState("");
  const [formBusinessType, setFormBusinessType] = useState("");
  const [formAbn, setFormAbn] = useState("");
  const [formStructure, setFormStructure] = useState("");
  const [formGst, setFormGst] = useState(false);
  
  // Location & Contact (Step 1 continued)
  const [formAddress, setFormAddress] = useState("");
  const [formState, setFormState] = useState("");
  const [formPostcode, setFormPostcode] = useState("");
  const [formPhone, setFormPhone] = useState("");
  const [formTimezone, setFormTimezone] = useState("Australia/Sydney");
  
  // Account details (Step 2)
  const [formEmail, setFormEmail] = useState("");
  const [formPassword, setFormPassword] = useState("");
  const [formConfirmPassword, setFormConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [formOwnerName, setFormOwnerName] = useState("");
  
  // Errors
  const [emailError, setEmailError] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [generalError, setGeneralError] = useState("");
  const [emailAlreadyExists, setEmailAlreadyExists] = useState(false);
  
  // Loading state
  const [creating, setCreating] = useState(false);

  // Business types for the industry
  const businessTypes = [
    { id: "beauty_salon", label: "Beauty Salon", icon: "fa-spa", color: "from-pink-500 to-rose-500" },
    { id: "hair_salon", label: "Hair Salon", icon: "fa-cut", color: "from-purple-500 to-indigo-500" },
    { id: "nail_spa", label: "Nail Spa", icon: "fa-hand-sparkles", color: "from-fuchsia-500 to-pink-500" },
    { id: "massage_spa", label: "Massage & Day Spa", icon: "fa-hot-tub", color: "from-teal-500 to-cyan-500" },
    { id: "barber", label: "Barber Shop", icon: "fa-user-tie", color: "from-slate-600 to-slate-800" },
    { id: "wellness", label: "Wellness Center", icon: "fa-leaf", color: "from-emerald-500 to-green-500" },
    { id: "medical_spa", label: "Medical Spa", icon: "fa-syringe", color: "from-blue-500 to-indigo-500" },
    { id: "other", label: "Other", icon: "fa-store", color: "from-amber-500 to-orange-500" },
  ];

  // Business structures
  const businessStructures = [
    { id: "pty_ltd", label: "Pty Ltd", icon: "fa-building" },
    { id: "sole_trader", label: "Sole Trader", icon: "fa-user" },
    { id: "partnership", label: "Partnership", icon: "fa-handshake" },
    { id: "trust", label: "Trust", icon: "fa-shield-halved" },
  ];

  // Australian states
  const australianStates = [
    { value: "NSW", label: "New South Wales", icon: "🏙️" },
    { value: "VIC", label: "Victoria", icon: "🎭" },
    { value: "QLD", label: "Queensland", icon: "🌴" },
    { value: "WA", label: "Western Australia", icon: "🌅" },
    { value: "SA", label: "South Australia", icon: "🍷" },
    { value: "TAS", label: "Tasmania", icon: "🏔️" },
    { value: "ACT", label: "Australian Capital Territory", icon: "🏛️" },
    { value: "NT", label: "Northern Territory", icon: "🦘" },
  ];

  // Fetch packages
  const fetchPackages = useCallback(async () => {
    if (packages.length > 0) return;
    try {
      setPackagesLoading(true);
      const res = await fetch("/api/packages/public");
      
      if (res.ok) {
        const data = await res.json();
        const allPackages = data.plans || data.packages || [];
        const activePackages = allPackages.filter((p: Package) => p.active !== false && !p.hidden);
        setPackages(activePackages);
      }
    } catch (error) {
      console.error("Error fetching packages:", error);
    } finally {
      setPackagesLoading(false);
    }
  }, [packages.length]);

  useEffect(() => {
    if (currentStep === 3) {
      fetchPackages();
    }
  }, [currentStep, fetchPackages]);

  // Validation functions
  const validateEmail = (email: string): boolean => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  };

  const sanitizeEmail = (email: string): string => {
    return email
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/[\u00A0]/g, ' ')
      .replace(/\s+/g, '')
      .toLowerCase();
  };

  // Format ABN as XX XXX XXX XXX
  const formatAbn = (value: string) => {
    const digits = value.replace(/\D/g, '').slice(0, 11);
    if (digits.length <= 2) return digits;
    if (digits.length <= 5) return `${digits.slice(0, 2)} ${digits.slice(2)}`;
    if (digits.length <= 8) return `${digits.slice(0, 2)} ${digits.slice(2, 5)} ${digits.slice(5)}`;
    return `${digits.slice(0, 2)} ${digits.slice(2, 5)} ${digits.slice(5, 8)} ${digits.slice(8)}`;
  };

  // Go to next step
  const goNext = async () => {
    setGeneralError("");
    
    if (currentStep === 1) {
      if (!formBusinessName.trim()) {
        setGeneralError("Business name is required.");
        return;
      }
      setCurrentStep(2);
      return;
    }
    
    if (currentStep === 2) {
      setEmailError("");
      setPasswordError("");
      
      const trimmedEmail = sanitizeEmail(formEmail);
      
      if (!trimmedEmail) {
        setEmailError("Email is required.");
        return;
      }
      if (!validateEmail(trimmedEmail)) {
        setEmailError("Please enter a valid email address.");
        return;
      }
      if (!formPassword || formPassword.length < 6) {
        setPasswordError("Password must be at least 6 characters.");
        return;
      }
      if (formPassword !== formConfirmPassword) {
        setPasswordError("Passwords do not match.");
        return;
      }
      
      setCurrentStep(3);
      return;
    }
    
    await handleSignup();
  };

  const goBack = () => {
    if (currentStep > 1) setCurrentStep((s) => ((s - 1) as 1 | 2 | 3));
  };

  // Handle signup
  const handleSignup = async () => {
    setGeneralError("");
    setEmailAlreadyExists(false);
    
    if (!selectedPlan) {
      setGeneralError("Please select a plan to continue.");
      return;
    }

    const selectedPackage = packages.find(p => p.id === selectedPlan);
    if (!selectedPackage) {
      setGeneralError("Please select a subscription plan.");
      return;
    }

    const trimmedEmail = sanitizeEmail(formEmail);

    try {
      setCreating(true);
      
      let ownerUid: string;
      try {
        // Create user and sign in directly with primary auth
        // This ensures we have an authenticated user for Firestore writes
        const userCredential = await createUserWithEmailAndPassword(auth, trimmedEmail, formPassword);
        ownerUid = userCredential.user.uid;
      } catch (e: any) {
        console.error("Firebase Auth error:", e?.code, e?.message);
        if (e?.code === "auth/email-already-in-use") {
          setEmailAlreadyExists(true);
          setGeneralError("");
          return;
        } else if (e?.code === "auth/invalid-email") {
          setGeneralError("Invalid email address format.");
          return;
        } else if (e?.code === "auth/weak-password") {
          setGeneralError("Password is too weak. Please use a stronger password.");
          return;
        }
        throw e;
      }

      // Calculate trial info
      const trialDays = selectedPackage.trialDays ? parseInt(String(selectedPackage.trialDays), 10) : 0;
      const hasFreeTrial = trialDays > 0;
      const now = new Date();
      const trialStart = hasFreeTrial ? now : null;
      const trialEnd = hasFreeTrial ? new Date(now.getTime() + trialDays * 24 * 60 * 60 * 1000) : null;

      // Generate unique slug for booking engine URL
      const slug = await generateUniqueSlug(formBusinessName.trim());
      const bookingEngineBaseUrl = process.env.NEXT_PUBLIC_BOOKING_ENGINE_URL || "https://black.bmspros.com.au/book-now";
      const bookingEngineUrl = `${bookingEngineBaseUrl}/${slug}`;

      // Create Firestore document (user is now authenticated)
      const newTenantRef = doc(db, "users", ownerUid);
      await setDoc(newTenantRef, {
        // User identity
        email: trimmedEmail,
        displayName: formOwnerName.trim() || formBusinessName.trim(),
        role: "salon_owner",
        provider: "password",
        uid: ownerUid,
        // Business fields
        name: formBusinessName.trim(),
        slug, // URL-friendly name for booking engine (e.g., "abc-salon")
        bookingEngineUrl, // Full booking engine link (e.g., "https://black.bmspros.com.au/book-now/abc-salon")
        businessType: formBusinessType || null,
        abn: formAbn.replace(/\s/g, '').trim() || null,
        businessStructure: formStructure || null,
        gstRegistered: formGst,
        state: formState || null,
        timezone: formTimezone || "Australia/Sydney",
        locationText: formAddress ? `${formAddress}${formPostcode ? ` ${formPostcode}` : ""}` : null,
        contactPhone: formPhone.trim() || null,
        // Plan details
        plan: selectedPackage.name,
        price: selectedPackage.priceLabel || null,
        planId: selectedPackage.id,
        plan_key: selectedPackage.plan_key || null,
        branchLimit: selectedPackage.branches,
        currentBranchCount: 0,
        branchNames: [],
        staffLimit: selectedPackage.staff,
        currentStaffCount: 0,
        // Payment status
        status: hasFreeTrial ? "Free Trial Active" : "Pending Payment",
        accountStatus: hasFreeTrial ? "active_trial" : "pending_payment",
        subscriptionStatus: hasFreeTrial ? "trialing" : "pending",
        billing_status: hasFreeTrial ? "trialing" : "pending",
        // Trial info
        trialDays: trialDays,
        hasFreeTrial: hasFreeTrial,
        trial_start: trialStart,
        trial_end: trialEnd,
        paymentDetailsRequired: !hasFreeTrial,
        // Source
        signupSource: "self_registration",
        // Timestamps
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      // Send welcome email and admin notification
      try {
        const baseUrl = window.location.origin || "https://black.bmspros.com.au";
        const paymentUrl = `${baseUrl}/subscription`;
        
        // Get business type label for admin notification
        const businessTypeLabel = businessTypes.find(t => t.id === formBusinessType)?.label || formBusinessType;
        
        await fetch("/api/salon-owner/welcome-email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: trimmedEmail,
            password: formPassword,
            businessName: formBusinessName.trim(),
            planName: selectedPackage.name,
            planPrice: selectedPackage.priceLabel,
            paymentUrl: paymentUrl,
            trialDays: trialDays,
            bookingEngineUrl: bookingEngineUrl, // Booking engine link for the email
            // Additional fields for admin notification
            businessType: businessTypeLabel,
            state: formState || undefined,
            phone: formPhone.trim() || undefined,
            abn: formAbn.replace(/\s/g, '').trim() || undefined,
          }),
        });
      } catch (emailError) {
        console.warn("Failed to send welcome email:", emailError);
      }

      // User is already signed in from createUserWithEmailAndPassword
      const token = await auth.currentUser?.getIdToken();
      if (token && typeof window !== "undefined") {
        localStorage.setItem("idToken", token);
        localStorage.setItem("role", "salon_owner");
        localStorage.setItem("userName", formBusinessName.trim());
      }

      router.replace("/dashboard");
      
    } catch (e: any) {
      console.error("Signup error:", e);
      setGeneralError(e?.message || "Failed to create account. Please try again.");
    } finally {
      setCreating(false);
    }
  };

  const nextCtaLabel = useMemo(() => {
    if (currentStep === 3) return creating ? "Creating Your Account..." : "Start Your Free Trial";
    return "Continue";
  }, [currentStep, creating]);

  // Progress percentage
  const progressPercent = currentStep === 1 ? 33 : currentStep === 2 ? 66 : 100;

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-pink-50/30 to-fuchsia-50/30">
      {/* Decorative background elements */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-40 -right-40 w-80 h-80 bg-gradient-to-br from-pink-400/20 to-fuchsia-400/20 rounded-full blur-3xl" />
        <div className="absolute top-1/2 -left-40 w-80 h-80 bg-gradient-to-br from-purple-400/20 to-indigo-400/20 rounded-full blur-3xl" />
        <div className="absolute -bottom-40 right-1/3 w-80 h-80 bg-gradient-to-br from-rose-400/20 to-pink-400/20 rounded-full blur-3xl" />
      </div>

      {/* Header */}
      <div className="bg-white/80 backdrop-blur-md border-b border-slate-200/50 sticky top-0 z-20">
        <div className="max-w-5xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="relative">
              <img
                src="/bmspink-icon.jpeg"
                alt="BMS PRO BLACK"
                className="w-11 h-11 rounded-xl shadow-lg object-cover ring-2 ring-pink-500/20"
              />
              <div className="absolute -bottom-1 -right-1 w-4 h-4 bg-emerald-500 rounded-full border-2 border-white" />
            </div>
            <div>
              <h1 className="font-bold text-lg text-slate-900">BMS PRO</h1>
              <p className="text-xs font-semibold bg-gradient-to-r from-pink-600 to-fuchsia-600 bg-clip-text text-transparent">
                PINK — Beauty & Wellness
              </p>
            </div>
          </div>
          <Link
            href="/login"
            className="text-sm text-slate-600 hover:text-pink-600 font-medium transition-colors"
          >
            Already have an account? <span className="text-pink-600 underline">Sign in</span>
          </Link>
        </div>
        
        {/* Progress bar */}
        <div className="h-1 bg-slate-100">
          <div 
            className="h-full bg-gradient-to-r from-pink-500 to-fuchsia-500 transition-all duration-500 ease-out"
            style={{ width: `${progressPercent}%` }}
          />
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-4 py-8 relative z-10">
        {/* Title Section */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-pink-100 to-fuchsia-100 rounded-full text-sm font-semibold text-pink-700 mb-4">
            <i className="fas fa-rocket" />
            Get started in minutes
          </div>
          <h2 className="text-3xl sm:text-4xl font-bold text-slate-900 mb-3">
            {currentStep === 1 && "Tell us about your business"}
            {currentStep === 2 && "Create your account"}
            {currentStep === 3 && "Choose your perfect plan"}
          </h2>
          <p className="text-slate-600 max-w-xl mx-auto">
            {currentStep === 1 && "Help us personalize your experience by sharing some details about your business"}
            {currentStep === 2 && "Set up your login credentials to access your dashboard"}
            {currentStep === 3 && "Select the plan that best fits your business needs"}
          </p>
        </div>

        {/* Step Indicator */}
        <div className="flex items-center justify-center gap-2 sm:gap-4 mb-10">
          {[
            { num: 1, label: "Business", icon: "fa-store" },
            { num: 2, label: "Account", icon: "fa-user" },
            { num: 3, label: "Plan", icon: "fa-crown" },
          ].map((step, idx) => (
            <React.Fragment key={step.num}>
              <div className="flex flex-col items-center">
                <div className={`w-12 h-12 rounded-2xl flex items-center justify-center font-semibold text-sm transition-all duration-300 ${
                  currentStep === step.num 
                    ? "bg-gradient-to-br from-pink-500 to-fuchsia-600 text-white shadow-lg shadow-pink-500/30 scale-110" 
                    : currentStep > step.num 
                    ? "bg-emerald-500 text-white" 
                    : "bg-white text-slate-400 border-2 border-slate-200"
                }`}>
                  {currentStep > step.num ? (
                    <i className="fas fa-check" />
                  ) : (
                    <i className={`fas ${step.icon}`} />
                  )}
                </div>
                <span className={`text-xs font-medium mt-2 ${
                  currentStep === step.num ? "text-pink-600" : currentStep > step.num ? "text-emerald-600" : "text-slate-400"
                }`}>
                  {step.label}
                </span>
              </div>
              {idx < 2 && (
                <div className={`w-12 sm:w-20 h-1 rounded-full transition-all duration-300 ${
                  currentStep > step.num ? "bg-emerald-500" : "bg-slate-200"
                }`} />
              )}
            </React.Fragment>
          ))}
        </div>

        {/* Form Card */}
        <div className="bg-white/90 backdrop-blur-sm rounded-3xl border border-slate-200/50 shadow-xl shadow-slate-200/50 overflow-hidden">
          {/* Step 1: Business Details */}
          {currentStep === 1 && (
            <div className="p-6 sm:p-8">
              {/* Business Type Selection */}
              <div className="mb-8">
                <label className="block text-sm font-semibold text-slate-700 mb-3">
                  What type of business do you run?
                </label>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {businessTypes.map((type) => (
                    <button
                      key={type.id}
                      type="button"
                      onClick={() => setFormBusinessType(type.id)}
                      className={`relative flex flex-col items-center gap-2 p-4 rounded-2xl border-2 transition-all duration-200 ${
                        formBusinessType === type.id
                          ? "border-pink-500 bg-pink-50 shadow-lg shadow-pink-500/10"
                          : "border-slate-200 bg-white hover:border-pink-300 hover:shadow-md"
                      }`}
                    >
                      <div className={`w-12 h-12 rounded-xl bg-gradient-to-br ${type.color} flex items-center justify-center shadow-lg`}>
                        <i className={`fas ${type.icon} text-white text-lg`} />
                      </div>
                      <span className={`text-xs font-medium text-center ${
                        formBusinessType === type.id ? "text-pink-700" : "text-slate-600"
                      }`}>
                        {type.label}
                      </span>
                      {formBusinessType === type.id && (
                        <div className="absolute top-2 right-2 w-5 h-5 bg-pink-500 rounded-full flex items-center justify-center">
                          <i className="fas fa-check text-white text-xs" />
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              </div>

              {/* Business Name */}
              <div className="mb-6">
                <label className="block text-sm font-semibold text-slate-700 mb-2">
                  <i className="fas fa-store text-pink-500 mr-2" />
                  Business Name <span className="text-rose-500">*</span>
                </label>
                <input
                  type="text"
                  value={formBusinessName}
                  onChange={(e) => setFormBusinessName(e.target.value)}
                  placeholder="e.g., Sunshine Beauty Spa"
                  className="w-full px-4 py-3.5 border border-slate-200 rounded-xl focus:ring-2 focus:ring-pink-500 focus:border-transparent transition-all bg-slate-50 focus:bg-white"
                />
              </div>

              {/* ABN & Business Structure Row */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
                <div>
                  <label className="block text-sm font-semibold text-slate-700 mb-2">
                    <i className="fas fa-hashtag text-blue-500 mr-2" />
                    ABN <span className="text-slate-400 text-xs">(Optional)</span>
                  </label>
                  <input
                    type="text"
                    value={formAbn}
                    onChange={(e) => setFormAbn(formatAbn(e.target.value))}
                    placeholder="XX XXX XXX XXX"
                    maxLength={14}
                    className="w-full px-4 py-3.5 border border-slate-200 rounded-xl focus:ring-2 focus:ring-pink-500 focus:border-transparent transition-all bg-slate-50 focus:bg-white font-mono"
                  />
                </div>
                <div>
                  <label className="block text-sm font-semibold text-slate-700 mb-2">
                    <i className="fas fa-briefcase text-purple-500 mr-2" />
                    Business Structure
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    {businessStructures.map((structure) => (
                      <button
                        key={structure.id}
                        type="button"
                        onClick={() => setFormStructure(structure.label)}
                        className={`flex items-center gap-2 px-3 py-2.5 rounded-lg border transition-all text-sm ${
                          formStructure === structure.label
                            ? "border-pink-500 bg-pink-50 text-pink-700"
                            : "border-slate-200 hover:border-pink-300 text-slate-600"
                        }`}
                      >
                        <i className={`fas ${structure.icon} text-xs`} />
                        {structure.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* GST Toggle */}
              <div className="mb-6 p-4 bg-gradient-to-r from-slate-50 to-slate-100 rounded-xl border border-slate-200">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-semibold text-slate-900">Registered for GST?</p>
                    <p className="text-sm text-slate-500 mt-0.5">Required for businesses with turnover over AU$75,000</p>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      className="sr-only peer"
                      checked={formGst}
                      onChange={(e) => setFormGst(e.target.checked)}
                    />
                    <div className="w-14 h-7 bg-slate-300 peer-focus:ring-2 peer-focus:ring-pink-500 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:rounded-full after:h-6 after:w-6 after:transition-all after:shadow-md peer-checked:bg-gradient-to-r peer-checked:from-pink-500 peer-checked:to-fuchsia-500" />
                  </label>
                </div>
              </div>

              {/* Divider */}
              <div className="flex items-center gap-4 my-8">
                <div className="flex-1 h-px bg-gradient-to-r from-transparent via-slate-300 to-transparent" />
                <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Location Details</span>
                <div className="flex-1 h-px bg-gradient-to-r from-transparent via-slate-300 to-transparent" />
              </div>

              {/* Address */}
              <div className="mb-6">
                <label className="block text-sm font-semibold text-slate-700 mb-2">
                  <i className="fas fa-location-dot text-rose-500 mr-2" />
                  Business Address <span className="text-slate-400 text-xs">(Optional)</span>
                </label>
                <textarea
                  rows={2}
                  value={formAddress}
                  onChange={(e) => setFormAddress(e.target.value)}
                  placeholder="Street address"
                  className="w-full px-4 py-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-pink-500 focus:border-transparent transition-all bg-slate-50 focus:bg-white resize-none"
                />
              </div>

              {/* State, Postcode, Timezone Row */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
                <div>
                  <label className="block text-sm font-semibold text-slate-700 mb-2">
                    <i className="fas fa-map text-emerald-500 mr-2" />
                    State
                  </label>
                  <select
                    value={formState}
                    onChange={(e) => setFormState(e.target.value)}
                    className="w-full px-4 py-3.5 border border-slate-200 rounded-xl focus:ring-2 focus:ring-pink-500 focus:border-transparent transition-all bg-slate-50 focus:bg-white appearance-none cursor-pointer"
                  >
                    <option value="">Select state</option>
                    {australianStates.map((state) => (
                      <option key={state.value} value={state.value}>
                        {state.icon} {state.value}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-semibold text-slate-700 mb-2">
                    <i className="fas fa-envelope text-amber-500 mr-2" />
                    Postcode
                  </label>
                  <input
                    type="text"
                    value={formPostcode}
                    onChange={(e) => setFormPostcode(e.target.value.replace(/\D/g, '').slice(0, 4))}
                    placeholder="2000"
                    maxLength={4}
                    className="w-full px-4 py-3.5 border border-slate-200 rounded-xl focus:ring-2 focus:ring-pink-500 focus:border-transparent transition-all bg-slate-50 focus:bg-white"
                  />
                </div>
                <div>
                  <label className="block text-sm font-semibold text-slate-700 mb-2">
                    <i className="fas fa-globe text-blue-500 mr-2" />
                    Timezone
                  </label>
                  <select
                    value={formTimezone}
                    onChange={(e) => setFormTimezone(e.target.value)}
                    className="w-full px-4 py-3.5 border border-slate-200 rounded-xl focus:ring-2 focus:ring-pink-500 focus:border-transparent transition-all bg-slate-50 focus:bg-white appearance-none cursor-pointer"
                  >
                    {TIMEZONES.filter(tz => tz.value.startsWith("Australia/")).map((tz) => (
                      <option key={tz.value} value={tz.value}>{tz.label}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Phone */}
              <div>
                <label className="block text-sm font-semibold text-slate-700 mb-2">
                  <i className="fas fa-phone text-green-500 mr-2" />
                  Business Phone <span className="text-slate-400 text-xs">(Optional)</span>
                </label>
                <div className="flex">
                  <span className="inline-flex items-center px-4 py-3.5 rounded-l-xl border border-r-0 border-slate-200 bg-slate-100 text-slate-600 font-mono text-sm">
                    +61
                  </span>
                  <input
                    type="tel"
                    value={formPhone}
                    onChange={(e) => setFormPhone(e.target.value)}
                    placeholder="412 345 678"
                    className="flex-1 px-4 py-3.5 border border-slate-200 rounded-r-xl focus:ring-2 focus:ring-pink-500 focus:border-transparent transition-all bg-slate-50 focus:bg-white"
                  />
                </div>
              </div>
            </div>
          )}

          {/* Step 2: Account Details */}
          {currentStep === 2 && (
            <div className="p-6 sm:p-8">
              {/* Owner Name */}
              <div className="mb-6">
                <label className="block text-sm font-semibold text-slate-700 mb-2">
                  <i className="fas fa-user text-pink-500 mr-2" />
                  Your Full Name <span className="text-slate-400 text-xs">(Optional)</span>
                </label>
                <input
                  type="text"
                  value={formOwnerName}
                  onChange={(e) => setFormOwnerName(e.target.value)}
                  placeholder="e.g., John Smith"
                  className="w-full px-4 py-3.5 border border-slate-200 rounded-xl focus:ring-2 focus:ring-pink-500 focus:border-transparent transition-all bg-slate-50 focus:bg-white"
                />
              </div>

              {/* Email */}
              <div className="mb-6">
                <label className="block text-sm font-semibold text-slate-700 mb-2">
                  <i className="fas fa-envelope text-blue-500 mr-2" />
                  Email Address <span className="text-rose-500">*</span>
                </label>
                <input
                  type="email"
                  value={formEmail}
                  onChange={(e) => {
                    setFormEmail(e.target.value);
                    if (emailError) setEmailError("");
                    if (emailAlreadyExists) setEmailAlreadyExists(false);
                  }}
                  placeholder="you@yourbusiness.com"
                  className={`w-full px-4 py-3.5 border rounded-xl focus:ring-2 focus:ring-pink-500 focus:border-transparent transition-all bg-slate-50 focus:bg-white ${
                    emailError ? "border-rose-400" : "border-slate-200"
                  }`}
                />
                {emailError && (
                  <p className="mt-2 text-sm text-rose-600 flex items-center gap-1">
                    <i className="fas fa-exclamation-circle" />
                    {emailError}
                  </p>
                )}
              </div>

              {/* Password */}
              <div className="mb-6">
                <label className="block text-sm font-semibold text-slate-700 mb-2">
                  <i className="fas fa-lock text-amber-500 mr-2" />
                  Password <span className="text-rose-500">*</span>
                </label>
                <div className="relative">
                  <input
                    type={showPassword ? "text" : "password"}
                    value={formPassword}
                    onChange={(e) => {
                      setFormPassword(e.target.value);
                      if (passwordError) setPasswordError("");
                    }}
                    placeholder="Minimum 6 characters"
                    className={`w-full px-4 py-3.5 pr-12 border rounded-xl focus:ring-2 focus:ring-pink-500 focus:border-transparent transition-all bg-slate-50 focus:bg-white ${
                      passwordError ? "border-rose-400" : "border-slate-200"
                    }`}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute inset-y-0 right-0 px-4 text-slate-500 hover:text-slate-700 transition-colors"
                  >
                    <i className={`fas ${showPassword ? "fa-eye-slash" : "fa-eye"}`} />
                  </button>
                </div>
                {/* Password strength indicator */}
                {formPassword && (
                  <div className="mt-2 flex items-center gap-2">
                    <div className="flex-1 h-1.5 bg-slate-200 rounded-full overflow-hidden">
                      <div 
                        className={`h-full transition-all ${
                          formPassword.length < 6 ? "w-1/4 bg-rose-500" :
                          formPassword.length < 8 ? "w-1/2 bg-amber-500" :
                          formPassword.length < 12 ? "w-3/4 bg-emerald-500" :
                          "w-full bg-emerald-500"
                        }`}
                      />
                    </div>
                    <span className={`text-xs font-medium ${
                      formPassword.length < 6 ? "text-rose-500" :
                      formPassword.length < 8 ? "text-amber-500" :
                      "text-emerald-500"
                    }`}>
                      {formPassword.length < 6 ? "Weak" :
                       formPassword.length < 8 ? "Fair" :
                       formPassword.length < 12 ? "Good" : "Strong"}
                    </span>
                  </div>
                )}
              </div>

              {/* Confirm Password */}
              <div className="mb-6">
                <label className="block text-sm font-semibold text-slate-700 mb-2">
                  <i className="fas fa-lock text-amber-500 mr-2" />
                  Confirm Password <span className="text-rose-500">*</span>
                </label>
                <input
                  type={showPassword ? "text" : "password"}
                  value={formConfirmPassword}
                  onChange={(e) => {
                    setFormConfirmPassword(e.target.value);
                    if (passwordError) setPasswordError("");
                  }}
                  placeholder="Re-enter your password"
                  className={`w-full px-4 py-3.5 border rounded-xl focus:ring-2 focus:ring-pink-500 focus:border-transparent transition-all bg-slate-50 focus:bg-white ${
                    passwordError ? "border-rose-400" : "border-slate-200"
                  }`}
                />
                {passwordError && (
                  <p className="mt-2 text-sm text-rose-600 flex items-center gap-1">
                    <i className="fas fa-exclamation-circle" />
                    {passwordError}
                  </p>
                )}
                {formConfirmPassword && formPassword === formConfirmPassword && (
                  <p className="mt-2 text-sm text-emerald-600 flex items-center gap-1">
                    <i className="fas fa-check-circle" />
                    Passwords match
                  </p>
                )}
              </div>

              {/* Business Summary Card */}
              <div className="bg-gradient-to-br from-slate-800 to-slate-900 rounded-2xl p-5 text-white">
                <h4 className="font-semibold mb-3 flex items-center gap-2">
                  <i className="fas fa-building" />
                  Your Business Summary
                </h4>
                <div className="space-y-2 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-slate-400">Business Name</span>
                    <span className="font-medium">{formBusinessName || "—"}</span>
                  </div>
                  {formBusinessType && (
                    <div className="flex items-center justify-between">
                      <span className="text-slate-400">Type</span>
                      <span className="font-medium">{businessTypes.find(t => t.id === formBusinessType)?.label}</span>
                    </div>
                  )}
                  {formState && (
                    <div className="flex items-center justify-between">
                      <span className="text-slate-400">Location</span>
                      <span className="font-medium">{formState}{formPostcode ? `, ${formPostcode}` : ""}</span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Step 3: Select Plan */}
          {currentStep === 3 && (
            <div className="p-6 sm:p-8">
              {packagesLoading ? (
                <div className="flex items-center justify-center py-16">
                  <div className="flex flex-col items-center gap-4">
                    <div className="relative">
                      <div className="w-16 h-16 border-4 border-pink-200 rounded-full" />
                      <div className="w-16 h-16 border-4 border-pink-500 border-t-transparent rounded-full animate-spin absolute inset-0" />
                    </div>
                    <p className="text-slate-500 font-medium">Loading plans...</p>
                  </div>
                </div>
              ) : packages.length === 0 ? (
                <div className="text-center py-16">
                  <div className="w-20 h-20 bg-slate-100 rounded-full flex items-center justify-center mx-auto mb-4">
                    <i className="fas fa-box-open text-3xl text-slate-400" />
                  </div>
                  <p className="text-slate-500 font-medium">No plans available at the moment.</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
                  {packages.map((pkg) => {
                    const isSelected = selectedPlan === pkg.id;
                    const gradientClass = pkg.color === "blue" ? "from-blue-500 to-indigo-600"
                      : pkg.color === "pink" ? "from-pink-500 to-fuchsia-600"
                      : pkg.color === "purple" ? "from-purple-500 to-indigo-600"
                      : pkg.color === "green" ? "from-emerald-500 to-teal-600"
                      : pkg.color === "orange" ? "from-orange-500 to-amber-500"
                      : pkg.color === "teal" ? "from-teal-500 to-cyan-500"
                      : "from-pink-500 to-fuchsia-600";

                    return (
                      <div
                        key={pkg.id}
                        onClick={() => setSelectedPlan(pkg.id)}
                        className={`relative cursor-pointer rounded-2xl border-2 transition-all duration-300 hover:shadow-xl ${
                          isSelected
                            ? "border-pink-500 bg-gradient-to-br from-pink-50 to-fuchsia-50 shadow-xl shadow-pink-500/20 scale-[1.02]"
                            : "border-slate-200 bg-white hover:border-pink-300"
                        }`}
                      >
                        {pkg.popular && (
                          <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-gradient-to-r from-amber-500 to-orange-500 text-white text-xs font-bold px-4 py-1.5 rounded-full shadow-lg">
                            <i className="fas fa-star mr-1" />
                            Most Popular
                          </div>
                        )}
                        
                        {isSelected && (
                          <div className="absolute top-4 right-4 w-7 h-7 bg-gradient-to-br from-pink-500 to-fuchsia-600 rounded-full flex items-center justify-center shadow-lg">
                            <i className="fas fa-check text-white text-sm" />
                          </div>
                        )}

                        <div className="p-6">
                          {/* Plan header */}
                          <div className="flex items-center gap-4 mb-4">
                            <div className={`w-14 h-14 rounded-2xl bg-gradient-to-br ${gradientClass} flex items-center justify-center shadow-lg`}>
                              {pkg.image ? (
                                <img src={pkg.image} alt={pkg.name} className="w-full h-full object-cover rounded-2xl" />
                              ) : (
                                <i className="fas fa-crown text-white text-xl" />
                              )}
                            </div>
                            <div>
                              <h4 className="font-bold text-lg text-slate-900">{pkg.name}</h4>
                              <p className={`text-2xl font-bold bg-gradient-to-r ${gradientClass} bg-clip-text text-transparent`}>
                                {pkg.priceLabel}
                              </p>
                            </div>
                          </div>

                          {/* Limits */}
                          <div className="flex items-center gap-4 text-sm text-slate-600 mb-4 pb-4 border-b border-slate-100">
                            <span className="flex items-center gap-1.5">
                              <i className="fas fa-building text-slate-400" />
                              {pkg.branches === -1 ? "Unlimited" : pkg.branches} Branch
                            </span>
                            <span className="flex items-center gap-1.5">
                              <i className="fas fa-users text-slate-400" />
                              {pkg.staff === -1 ? "Unlimited" : pkg.staff} Staff
                            </span>
                          </div>

                          {/* Trial badge */}
                          {pkg.trialDays && pkg.trialDays > 0 && (
                            <div className="inline-flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-emerald-100 to-teal-100 text-emerald-700 rounded-xl text-sm font-semibold mb-4">
                              <i className="fas fa-gift" />
                              {pkg.trialDays}-day free trial
                            </div>
                          )}

                          {/* Features */}
                          {pkg.features && pkg.features.length > 0 && (
                            <ul className="space-y-2">
                              {pkg.features.slice(0, 5).map((feature, idx) => (
                                <li key={idx} className="flex items-start gap-2 text-sm text-slate-600">
                                  <i className={`fas fa-check text-xs mt-1.5 ${isSelected ? "text-pink-500" : "text-emerald-500"}`} />
                                  {feature}
                                </li>
                              ))}
                              {pkg.features.length > 5 && (
                                <li className="text-xs text-slate-400 pl-5">
                                  +{pkg.features.length - 5} more features
                                </li>
                              )}
                            </ul>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Summary Card */}
              <div className="mt-8 bg-gradient-to-br from-pink-50 via-fuchsia-50 to-purple-50 border border-pink-200 rounded-2xl p-5">
                <h4 className="font-semibold text-slate-900 mb-4 flex items-center gap-2">
                  <i className="fas fa-receipt text-pink-500" />
                  Your Registration Summary
                </h4>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
                  <div className="bg-white/60 rounded-xl p-3">
                    <p className="text-slate-500 text-xs mb-1">Business</p>
                    <p className="font-semibold text-slate-900">{formBusinessName}</p>
                  </div>
                  <div className="bg-white/60 rounded-xl p-3">
                    <p className="text-slate-500 text-xs mb-1">Email</p>
                    <p className="font-semibold text-slate-900 truncate">{formEmail}</p>
                  </div>
                  <div className="bg-white/60 rounded-xl p-3">
                    <p className="text-slate-500 text-xs mb-1">Selected Plan</p>
                    <p className="font-semibold text-pink-600">
                      {selectedPlan ? packages.find(p => p.id === selectedPlan)?.name : "None selected"}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Email Already Exists Display */}
          {emailAlreadyExists && (
            <div className="mx-6 mb-4 p-5 bg-gradient-to-r from-amber-50 to-orange-50 border border-amber-200 rounded-xl">
              <div className="flex items-start gap-4">
                <div className="w-12 h-12 bg-amber-100 rounded-xl flex items-center justify-center flex-shrink-0">
                  <i className="fas fa-user-check text-amber-600 text-xl" />
                </div>
                <div className="flex-1">
                  <p className="font-semibold text-amber-800 mb-1">Account Already Exists</p>
                  <p className="text-sm text-amber-700 mb-3">
                    An account with <strong>{formEmail}</strong> is already registered. 
                    Please sign in to access your dashboard.
                  </p>
                  <div className="flex items-center gap-3">
                    <Link
                      href="/login"
                      className="inline-flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-pink-500 to-fuchsia-600 text-white font-semibold rounded-lg hover:from-pink-600 hover:to-fuchsia-700 transition-all shadow-md text-sm"
                    >
                      <i className="fas fa-sign-in-alt" />
                      Sign In Now
                    </Link>
                    <button
                      type="button"
                      onClick={() => {
                        setEmailAlreadyExists(false);
                        setFormEmail("");
                        setCurrentStep(2);
                      }}
                      className="text-sm text-amber-700 hover:text-amber-900 font-medium underline"
                    >
                      Use a different email
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Error Display */}
          {generalError && !emailAlreadyExists && (
            <div className="mx-6 mb-4 p-4 bg-rose-50 border border-rose-200 rounded-xl">
              <div className="flex items-start gap-3 text-rose-700">
                <i className="fas fa-exclamation-triangle mt-0.5" />
                <div>
                  <p className="font-semibold">Something went wrong</p>
                  <p className="text-sm">{generalError}</p>
                </div>
              </div>
            </div>
          )}

          {/* Footer */}
          <div className="px-6 sm:px-8 py-5 bg-slate-50/80 border-t border-slate-200/50 flex items-center justify-between">
            {currentStep > 1 ? (
              <button
                onClick={goBack}
                disabled={creating}
                className="px-5 py-2.5 text-slate-600 hover:text-slate-800 font-medium transition-colors disabled:opacity-50 flex items-center gap-2"
              >
                <i className="fas fa-arrow-left" />
                Back
              </button>
            ) : (
              <Link href="/login" className="px-5 py-2.5 text-slate-600 hover:text-slate-800 font-medium transition-colors flex items-center gap-2">
                <i className="fas fa-arrow-left" />
                Back to Sign In
              </Link>
            )}
            
            <button
              onClick={goNext}
              disabled={creating || (currentStep === 3 && !selectedPlan)}
              className="px-8 py-3 bg-gradient-to-r from-pink-500 to-fuchsia-600 text-white font-semibold rounded-xl hover:from-pink-600 hover:to-fuchsia-700 transition-all shadow-lg shadow-pink-500/25 hover:shadow-pink-500/40 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {creating && <i className="fas fa-circle-notch fa-spin" />}
              {nextCtaLabel}
              {currentStep < 3 && <i className="fas fa-arrow-right" />}
            </button>
          </div>
        </div>

        {/* Trust badges */}
        <div className="flex items-center justify-center gap-6 mt-8 text-slate-400">
          <div className="flex items-center gap-2 text-xs">
            <i className="fas fa-shield-halved" />
            <span>Secure & Encrypted</span>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <i className="fas fa-lock" />
            <span>Privacy Protected</span>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <i className="fas fa-headset" />
            <span>24/7 Support</span>
          </div>
        </div>

        {/* Terms */}
        <p className="text-xs text-slate-500 text-center mt-4">
          By creating an account, you agree to our{" "}
          <a href="https://bmspros.com.au/terms" target="_blank" rel="noopener noreferrer" className="text-pink-600 hover:underline">
            Terms of Service
          </a>{" "}
          and{" "}
          <a href="https://bmspros.com.au/privacy" target="_blank" rel="noopener noreferrer" className="text-pink-600 hover:underline">
            Privacy Policy
          </a>
        </p>
      </div>
    </div>
  );
}
