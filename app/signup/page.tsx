"use client";
import React, { useState, useEffect, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { signInWithEmailAndPassword } from "firebase/auth";
import { auth } from "@/lib/firebase";
import { TIMEZONES } from "@/lib/timezone";

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
  
  // Loading & animation
  const [creating, setCreating] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  // Workshop / auto-repair business types
  const businessTypes = [
    { id: "auto_repair", label: "Auto Repair Shop", icon: "fa-car" },
    { id: "mechanic", label: "Mechanic Workshop", icon: "fa-wrench" },
    { id: "tire_service", label: "Tire & Wheel Service", icon: "fa-circle-dot" },
    { id: "body_shop", label: "Body & Paint Shop", icon: "fa-spray-can" },
    { id: "service_center", label: "Service Center", icon: "fa-screwdriver-wrench" },
    { id: "detailing", label: "Car Detailing", icon: "fa-droplet" },
    { id: "fleet", label: "Fleet Maintenance", icon: "fa-truck" },
    { id: "other", label: "Other", icon: "fa-store" },
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
    { value: "NSW", label: "New South Wales" },
    { value: "VIC", label: "Victoria" },
    { value: "QLD", label: "Queensland" },
    { value: "WA", label: "Western Australia" },
    { value: "SA", label: "South Australia" },
    { value: "TAS", label: "Tasmania" },
    { value: "ACT", label: "Australian Capital Territory" },
    { value: "NT", label: "Northern Territory" },
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

      // ---- Call server API to create auth user + Firestore document ----
      const registerRes = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: trimmedEmail,
          password: formPassword,
          ownerName: formOwnerName.trim(),
          businessName: formBusinessName.trim(),
          businessType: formBusinessType || null,
          abn: formAbn.replace(/\s/g, '').trim() || null,
          businessStructure: formStructure || null,
          gstRegistered: formGst,
          state: formState || null,
          timezone: formTimezone || "Australia/Sydney",
          address: formAddress || null,
          postcode: formPostcode || null,
          phone: formPhone.trim() || null,
          planId: selectedPackage.id,
          planName: selectedPackage.name,
          planPrice: selectedPackage.priceLabel || null,
          planKey: selectedPackage.plan_key || null,
          planBranches: selectedPackage.branches,
          planStaff: selectedPackage.staff,
          trialDays: selectedPackage.trialDays || 0,
        }),
      });

      const registerData = await registerRes.json();

      if (!registerRes.ok) {
        if (registerData.error === "email-already-in-use") {
          setEmailAlreadyExists(true);
          setGeneralError("");
          return;
        }
        if (registerData.error === "invalid-email") {
          setGeneralError("Invalid email address format.");
          return;
        }
        if (registerData.error === "weak-password") {
          setGeneralError("Password is too weak. Please use a stronger password.");
          return;
        }
        setGeneralError(registerData.message || registerData.error || "Registration failed.");
        return;
      }

      // ---- Sign in on the client so AuthGuard recognises the session ----
      await signInWithEmailAndPassword(auth, trimmedEmail, formPassword);

      // Send welcome email (non-blocking)
      try {
        const baseUrl = window.location.origin || "https://black.bmspros.com.au";
        const paymentUrl = `${baseUrl}/subscription`;
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
            trialDays: registerData.trialDays || 0,
            bookingEngineUrl: registerData.bookingEngineUrl || "",
            businessType: businessTypeLabel,
            state: formState || undefined,
            phone: formPhone.trim() || undefined,
            abn: formAbn.replace(/\s/g, '').trim() || undefined,
          }),
        });
      } catch (emailError) {
        console.warn("Failed to send welcome email:", emailError);
      }

      const token = await auth.currentUser?.getIdToken();
      if (token && typeof window !== "undefined") {
        localStorage.setItem("idToken", token);
        localStorage.setItem("role", "workshop_owner");
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

  const progressPercent = currentStep === 1 ? 33 : currentStep === 2 ? 66 : 100;

  // Shared input class
  const inputClass = (hasError?: boolean) =>
    `w-full px-4 py-3 text-sm bg-neutral-50/80 border-2 rounded-xl focus:ring-0 focus:border-neutral-900 focus:bg-white transition-all outline-none placeholder:text-neutral-400 ${
      hasError ? "border-rose-300 bg-rose-50/40" : "border-neutral-200 hover:border-neutral-300"
    }`;

  return (
    <div className="min-h-screen bg-neutral-100 flex flex-col">
      {/* ===== Header ===== */}
      <div className="bg-neutral-950 sticky top-0 z-20">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img src="/bmsblack-icon.jpeg" alt="BMS PRO BLACK" className="w-9 h-9 rounded-xl object-cover" />
            <div>
              <span className="text-white font-bold text-base tracking-tight">BMS PRO</span>
              <span className="text-neutral-500 text-[10px] font-semibold tracking-[0.3em] uppercase ml-2">Black</span>
            </div>
          </div>
          <Link
            href="/login"
            className="text-sm text-neutral-400 hover:text-white font-medium transition-colors"
          >
            Have an account? <span className="text-white underline underline-offset-2">Sign in</span>
          </Link>
        </div>
        
        {/* Progress bar */}
        <div className="h-1 bg-neutral-800">
          <div 
            className="h-full bg-white transition-all duration-500 ease-out"
            style={{ width: `${progressPercent}%` }}
          />
        </div>
      </div>

      <div className={`max-w-5xl mx-auto px-4 sm:px-6 py-8 w-full flex-1 transition-all duration-700 ${mounted ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'}`}>
        {/* Title Section */}
        <div className="text-center mb-8">
          <h2 className="text-2xl sm:text-3xl font-bold text-neutral-900 tracking-tight mb-2">
            {currentStep === 1 && "Tell us about your workshop"}
            {currentStep === 2 && "Create your account"}
            {currentStep === 3 && "Choose your plan"}
          </h2>
          <p className="text-neutral-500 text-sm max-w-lg mx-auto">
            {currentStep === 1 && "Share some details so we can personalize your experience"}
            {currentStep === 2 && "Set up your login credentials to access your dashboard"}
            {currentStep === 3 && "Select the plan that best fits your business needs"}
          </p>
        </div>

        {/* Step Indicator */}
        <div className="flex items-center justify-center gap-3 sm:gap-4 mb-8">
          {[
            { num: 1, label: "Business", icon: "fa-store" },
            { num: 2, label: "Account", icon: "fa-user" },
            { num: 3, label: "Plan", icon: "fa-crown" },
          ].map((step, idx) => (
            <React.Fragment key={step.num}>
              <div className="flex flex-col items-center">
                <div className={`w-11 h-11 rounded-xl flex items-center justify-center text-sm transition-all duration-300 ${
                  currentStep === step.num 
                    ? "bg-neutral-900 text-white shadow-lg shadow-neutral-900/20 scale-110" 
                    : currentStep > step.num 
                    ? "bg-emerald-500 text-white" 
                    : "bg-white text-neutral-400 border-2 border-neutral-200"
                }`}>
                  {currentStep > step.num ? (
                    <i className="fas fa-check text-sm" />
                  ) : (
                    <i className={`fas ${step.icon} text-sm`} />
                  )}
                </div>
                <span className={`text-[11px] font-medium mt-1.5 ${
                  currentStep === step.num ? "text-neutral-900" : currentStep > step.num ? "text-emerald-600" : "text-neutral-400"
                }`}>
                  {step.label}
                </span>
              </div>
              {idx < 2 && (
                <div className={`w-10 sm:w-16 h-0.5 rounded-full transition-all duration-300 mb-5 ${
                  currentStep > step.num ? "bg-emerald-500" : "bg-neutral-200"
                }`} />
              )}
            </React.Fragment>
          ))}
        </div>

        {/* Form Card */}
        <div className="bg-white rounded-2xl border border-neutral-200/60 shadow-xl shadow-neutral-900/[0.04] overflow-hidden">
          {/* Step 1: Business Details */}
          {currentStep === 1 && (
            <div className="p-5 sm:p-8">
              {/* Business Type Selection */}
              <div className="mb-7">
                <label className="block text-[13px] font-semibold text-neutral-700 mb-3">
                  What type of business do you run?
                </label>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                  {businessTypes.map((type) => (
                    <button
                      key={type.id}
                      type="button"
                      onClick={() => setFormBusinessType(type.id)}
                      className={`relative flex flex-col items-center gap-2 p-3.5 rounded-xl border-2 transition-all duration-200 ${
                        formBusinessType === type.id
                          ? "border-neutral-900 bg-neutral-50 shadow-md"
                          : "border-neutral-200 bg-white hover:border-neutral-300 hover:shadow-sm"
                      }`}
                    >
                      <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${
                        formBusinessType === type.id
                          ? "bg-neutral-900 text-white"
                          : "bg-neutral-100 text-neutral-500"
                      }`}>
                        <i className={`fas ${type.icon} text-sm`} />
                      </div>
                      <span className={`text-[11px] font-medium text-center leading-tight ${
                        formBusinessType === type.id ? "text-neutral-900" : "text-neutral-600"
                      }`}>
                        {type.label}
                      </span>
                      {formBusinessType === type.id && (
                        <div className="absolute top-2 right-2 w-5 h-5 bg-neutral-900 rounded-full flex items-center justify-center">
                          <i className="fas fa-check text-white text-[9px]" />
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              </div>

              {/* Business Name */}
              <div className="mb-5">
                <label className="block text-[13px] font-semibold text-neutral-700 mb-1.5">
                  Business Name <span className="text-rose-500">*</span>
                </label>
                <input
                  type="text"
                  value={formBusinessName}
                  onChange={(e) => setFormBusinessName(e.target.value)}
                  placeholder="e.g., City Auto Repairs"
                  className={inputClass()}
                />
              </div>

              {/* ABN & Business Structure Row */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-5">
                <div>
                  <label className="block text-[13px] font-semibold text-neutral-700 mb-1.5">
                    ABN <span className="text-neutral-400 text-xs">(Optional)</span>
                  </label>
                  <input
                    type="text"
                    value={formAbn}
                    onChange={(e) => setFormAbn(formatAbn(e.target.value))}
                    placeholder="XX XXX XXX XXX"
                    maxLength={14}
                    className={`${inputClass()} font-mono`}
                  />
                </div>
                <div>
                  <label className="block text-[13px] font-semibold text-neutral-700 mb-1.5">
                    Business Structure
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    {businessStructures.map((structure) => (
                      <button
                        key={structure.id}
                        type="button"
                        onClick={() => setFormStructure(structure.label)}
                        className={`flex items-center gap-2 px-3 py-2.5 rounded-lg border-2 transition-all text-sm ${
                          formStructure === structure.label
                            ? "border-neutral-900 bg-neutral-50 text-neutral-900 font-semibold"
                            : "border-neutral-200 hover:border-neutral-300 text-neutral-600"
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
              <div className="mb-5 p-4 bg-neutral-50 rounded-xl border border-neutral-200">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-semibold text-sm text-neutral-900">Registered for GST?</p>
                    <p className="text-xs text-neutral-500 mt-0.5">Required for businesses with turnover over AU$75,000</p>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      className="sr-only peer"
                      checked={formGst}
                      onChange={(e) => setFormGst(e.target.checked)}
                    />
                    <div className="w-12 h-6 bg-neutral-300 peer-focus:ring-2 peer-focus:ring-neutral-400 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all after:shadow-sm peer-checked:bg-neutral-900" />
                  </label>
                </div>
              </div>

              {/* Divider */}
              <div className="flex items-center gap-4 my-7">
                <div className="flex-1 h-px bg-neutral-200" />
                <span className="text-[11px] font-semibold text-neutral-400 uppercase tracking-wider">Location Details</span>
                <div className="flex-1 h-px bg-neutral-200" />
              </div>

              {/* Address */}
              <div className="mb-5">
                <label className="block text-[13px] font-semibold text-neutral-700 mb-1.5">
                  Business Address <span className="text-neutral-400 text-xs">(Optional)</span>
                </label>
                <textarea
                  rows={2}
                  value={formAddress}
                  onChange={(e) => setFormAddress(e.target.value)}
                  placeholder="Street address"
                  className={`${inputClass()} resize-none`}
                />
              </div>

              {/* State, Postcode, Timezone Row */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-5">
                <div>
                  <label className="block text-[13px] font-semibold text-neutral-700 mb-1.5">State</label>
                  <select
                    value={formState}
                    onChange={(e) => setFormState(e.target.value)}
                    className={`${inputClass()} appearance-none cursor-pointer`}
                  >
                    <option value="">Select state</option>
                    {australianStates.map((state) => (
                      <option key={state.value} value={state.value}>
                        {state.value} — {state.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-[13px] font-semibold text-neutral-700 mb-1.5">Postcode</label>
                  <input
                    type="text"
                    value={formPostcode}
                    onChange={(e) => setFormPostcode(e.target.value.replace(/\D/g, '').slice(0, 4))}
                    placeholder="2000"
                    maxLength={4}
                    className={inputClass()}
                  />
                </div>
                <div>
                  <label className="block text-[13px] font-semibold text-neutral-700 mb-1.5">Timezone</label>
                  <select
                    value={formTimezone}
                    onChange={(e) => setFormTimezone(e.target.value)}
                    className={`${inputClass()} appearance-none cursor-pointer`}
                  >
                    {TIMEZONES.filter(tz => tz.value.startsWith("Australia/")).map((tz) => (
                      <option key={tz.value} value={tz.value}>{tz.label}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Phone */}
              <div>
                <label className="block text-[13px] font-semibold text-neutral-700 mb-1.5">
                  Business Phone <span className="text-red-500 text-xs">*</span>
                </label>
                <div className="flex">
                  <span className="inline-flex items-center px-3.5 py-3 rounded-l-xl border-2 border-r-0 border-neutral-200 bg-neutral-100 text-neutral-500 text-sm font-mono">
                    +61
                  </span>
                  <input
                    type="tel"
                    value={formPhone}
                    onChange={(e) => setFormPhone(e.target.value)}
                    placeholder="412 345 678"
                    required
                    className={`flex-1 px-4 py-3 text-sm bg-neutral-50/80 border-2 border-l-0 rounded-r-xl focus:ring-0 focus:border-neutral-900 focus:bg-white transition-all outline-none placeholder:text-neutral-400 border-neutral-200 hover:border-neutral-300`}
                  />
                </div>
              </div>
            </div>
          )}

          {/* Step 2: Account Details */}
          {currentStep === 2 && (
            <div className="p-5 sm:p-8">
              {/* Owner Name */}
              <div className="mb-5">
                <label className="block text-[13px] font-semibold text-neutral-700 mb-1.5">
                  Your Full Name <span className="text-neutral-400 text-xs">(Optional)</span>
                </label>
                <input
                  type="text"
                  value={formOwnerName}
                  onChange={(e) => setFormOwnerName(e.target.value)}
                  placeholder="e.g., John Smith"
                  className={inputClass()}
                />
              </div>

              {/* Email */}
              <div className="mb-5">
                <label className="block text-[13px] font-semibold text-neutral-700 mb-1.5">
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
                  placeholder="you@workshop.com"
                  className={inputClass(!!emailError)}
                />
                {emailError && (
                  <p className="mt-1.5 text-xs text-rose-500 flex items-center gap-1.5">
                    <i className="fas fa-exclamation-circle text-[10px]" />{emailError}
                  </p>
                )}
              </div>

              {/* Password */}
              <div className="mb-5">
                <label className="block text-[13px] font-semibold text-neutral-700 mb-1.5">
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
                    className={`${inputClass(!!passwordError)} pr-12`}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute inset-y-0 right-0 px-4 text-neutral-400 hover:text-neutral-600 transition-colors"
                  >
                    <i className={`fas ${showPassword ? "fa-eye-slash" : "fa-eye"} text-sm`} />
                  </button>
                </div>
                {/* Password strength */}
                {formPassword && (
                  <div className="mt-2 flex items-center gap-2">
                    <div className="flex-1 h-1 bg-neutral-200 rounded-full overflow-hidden">
                      <div 
                        className={`h-full transition-all rounded-full ${
                          formPassword.length < 6 ? "w-1/4 bg-rose-500" :
                          formPassword.length < 8 ? "w-1/2 bg-amber-500" :
                          formPassword.length < 12 ? "w-3/4 bg-emerald-500" :
                          "w-full bg-emerald-500"
                        }`}
                      />
                    </div>
                    <span className={`text-[11px] font-medium ${
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
                <label className="block text-[13px] font-semibold text-neutral-700 mb-1.5">
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
                  className={inputClass(!!passwordError)}
                />
                {passwordError && (
                  <p className="mt-1.5 text-xs text-rose-500 flex items-center gap-1.5">
                    <i className="fas fa-exclamation-circle text-[10px]" />{passwordError}
                  </p>
                )}
                {formConfirmPassword && formPassword === formConfirmPassword && (
                  <p className="mt-1.5 text-xs text-emerald-600 flex items-center gap-1.5">
                    <i className="fas fa-check-circle text-[10px]" />
                    Passwords match
                  </p>
                )}
              </div>

              {/* Business Summary Card */}
              <div className="bg-neutral-950 rounded-xl p-5 text-white">
                <h4 className="font-semibold text-sm mb-3 flex items-center gap-2">
                  <i className="fas fa-building text-neutral-400" />
                  Business Summary
                </h4>
                <div className="space-y-2.5 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-neutral-400">Business</span>
                    <span className="font-medium">{formBusinessName || "—"}</span>
                  </div>
                  {formBusinessType && (
                    <div className="flex items-center justify-between">
                      <span className="text-neutral-400">Type</span>
                      <span className="font-medium">{businessTypes.find(t => t.id === formBusinessType)?.label}</span>
                    </div>
                  )}
                  {formState && (
                    <div className="flex items-center justify-between">
                      <span className="text-neutral-400">Location</span>
                      <span className="font-medium">{formState}{formPostcode ? `, ${formPostcode}` : ""}</span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Step 3: Select Plan */}
          {currentStep === 3 && (
            <div className="p-5 sm:p-8">
              {packagesLoading ? (
                <div className="flex items-center justify-center py-16">
                  <div className="flex flex-col items-center gap-4">
                    <svg className="animate-spin h-8 w-8 text-neutral-900" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    <p className="text-neutral-500 text-sm font-medium">Loading plans...</p>
                  </div>
                </div>
              ) : packages.length === 0 ? (
                <div className="text-center py-16">
                  <div className="w-16 h-16 bg-neutral-100 rounded-xl flex items-center justify-center mx-auto mb-4">
                    <i className="fas fa-box-open text-2xl text-neutral-400" />
                  </div>
                  <p className="text-neutral-500 font-medium text-sm">No plans available at the moment.</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
                  {packages.map((pkg) => {
                    const isSelected = selectedPlan === pkg.id;
                    return (
                      <div
                        key={pkg.id}
                        onClick={() => setSelectedPlan(pkg.id)}
                        className={`relative cursor-pointer rounded-2xl transition-all duration-200 group overflow-hidden ${
                          isSelected
                            ? "bg-neutral-900 text-white shadow-xl"
                            : "bg-white border border-neutral-200 hover:border-neutral-300 hover:shadow-md"
                        }`}
                      >
                        {/* Popular badge */}
                        {pkg.popular && (
                          <div className={`absolute top-4 right-4 text-[10px] font-bold px-2.5 py-1 rounded-full ${
                            isSelected ? "bg-amber-400 text-neutral-900" : "bg-neutral-900 text-white"
                          }`}>
                            ★ Popular
                          </div>
                        )}

                        <div className="p-6">
                          {/* Plan name */}
                          <p className={`text-sm font-semibold mb-1 ${isSelected ? "text-neutral-400" : "text-neutral-500"}`}>
                            {pkg.name}
                          </p>

                          {/* Price */}
                          <div className="flex items-baseline gap-1 mb-5">
                            <span className={`text-3xl font-extrabold tracking-tight ${isSelected ? "text-white" : "text-neutral-900"}`}>
                              {pkg.priceLabel?.replace('/mo', '')}
                            </span>
                            <span className={`text-sm font-medium ${isSelected ? "text-neutral-400" : "text-neutral-400"}`}>/mo</span>
                          </div>

                          {/* Limits */}
                          <div className={`flex items-center gap-4 text-xs font-medium mb-4 pb-4 border-b ${
                            isSelected ? "border-neutral-700 text-neutral-300" : "border-neutral-100 text-neutral-500"
                          }`}>
                            <span className="flex items-center gap-1.5">
                              <i className="fas fa-building text-[10px]" />
                              {pkg.branches === -1 ? "Unlimited" : pkg.branches} Branch{pkg.branches !== 1 ? "es" : ""}
                            </span>
                            <span className="flex items-center gap-1.5">
                              <i className="fas fa-users text-[10px]" />
                              {pkg.staff === -1 ? "Unlimited" : pkg.staff} Staff
                            </span>
                          </div>

                          {/* Trial badge */}
                          {pkg.trialDays && pkg.trialDays > 0 && (
                            <div className={`inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg mb-4 ${
                              isSelected ? "bg-emerald-500/20 text-emerald-300" : "bg-emerald-50 text-emerald-600"
                            }`}>
                              <i className="fas fa-gift text-[10px]" />
                              {pkg.trialDays}-day free trial
                            </div>
                          )}

                          {/* Features */}
                          {pkg.features && pkg.features.length > 0 && (
                            <ul className="space-y-2.5">
                              {pkg.features.slice(0, 5).map((feature, idx) => (
                                <li key={idx} className={`flex items-start gap-2.5 text-[13px] ${
                                  isSelected ? "text-neutral-300" : "text-neutral-600"
                                }`}>
                                  <i className={`fas fa-check text-[10px] mt-1 ${
                                    isSelected ? "text-amber-400" : "text-neutral-900"
                                  }`} />
                                  {feature}
                                </li>
                              ))}
                              {pkg.features.length > 5 && (
                                <li className={`text-[11px] font-medium pl-5 ${
                                  isSelected ? "text-neutral-500" : "text-neutral-400"
                                }`}>
                                  +{pkg.features.length - 5} more
                                </li>
                              )}
                            </ul>
                          )}

                          {/* Select indicator */}
                          <div className={`mt-5 w-full py-2.5 rounded-xl text-center text-xs font-bold transition-all ${
                            isSelected
                              ? "bg-white text-neutral-900"
                              : "bg-neutral-100 text-neutral-500 group-hover:bg-neutral-900 group-hover:text-white"
                          }`}>
                            {isSelected ? (
                              <span><i className="fas fa-check mr-1.5" />Selected</span>
                            ) : (
                              <span>Select Plan</span>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Summary Card */}
              <div className="mt-6 bg-neutral-50 border border-neutral-200 rounded-xl p-5">
                <h4 className="font-semibold text-sm text-neutral-900 mb-3 flex items-center gap-2">
                  <i className="fas fa-receipt text-neutral-500" />
                  Registration Summary
                </h4>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
                  <div className="bg-white rounded-lg p-3 border border-neutral-100">
                    <p className="text-neutral-400 text-[11px] mb-0.5">Business</p>
                    <p className="font-semibold text-neutral-900 text-sm">{formBusinessName}</p>
                  </div>
                  <div className="bg-white rounded-lg p-3 border border-neutral-100">
                    <p className="text-neutral-400 text-[11px] mb-0.5">Email</p>
                    <p className="font-semibold text-neutral-900 text-sm truncate">{formEmail}</p>
                  </div>
                  <div className="bg-white rounded-lg p-3 border border-neutral-100">
                    <p className="text-neutral-400 text-[11px] mb-0.5">Selected Plan</p>
                    <p className="font-semibold text-neutral-900 text-sm">
                      {selectedPlan ? packages.find(p => p.id === selectedPlan)?.name : "None selected"}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Email Already Exists */}
          {emailAlreadyExists && (
            <div className="mx-5 sm:mx-8 mb-4 p-4 bg-amber-50 border border-amber-200 rounded-xl">
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 bg-amber-100 rounded-lg flex items-center justify-center flex-shrink-0">
                  <i className="fas fa-user-check text-amber-600" />
                </div>
                <div className="flex-1">
                  <p className="font-semibold text-amber-800 text-sm mb-1">Account Already Exists</p>
                  <p className="text-xs text-amber-700 mb-3">
                    An account with <strong>{formEmail}</strong> is already registered.
                  </p>
                  <div className="flex items-center gap-3">
                    <Link
                      href="/login"
                      className="inline-flex items-center gap-2 px-4 py-2 bg-neutral-900 text-white font-semibold rounded-lg hover:bg-neutral-800 transition-all text-sm"
                    >
                      <i className="fas fa-sign-in-alt text-xs" />
                      Sign In
                    </Link>
                    <button
                      type="button"
                      onClick={() => {
                        setEmailAlreadyExists(false);
                        setFormEmail("");
                        setCurrentStep(2);
                      }}
                      className="text-xs text-amber-700 hover:text-amber-900 font-medium underline"
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
            <div className="mx-5 sm:mx-8 mb-4 p-4 bg-rose-50 border border-rose-200 rounded-xl">
              <div className="flex items-start gap-3">
                <div className="w-8 h-8 rounded-lg bg-rose-100 flex items-center justify-center shrink-0">
                  <i className="fas fa-circle-exclamation text-rose-500 text-xs" />
                </div>
                <div>
                  <p className="font-semibold text-rose-800 text-sm">Something went wrong</p>
                  <p className="text-xs text-rose-600 mt-0.5">{generalError}</p>
                </div>
              </div>
            </div>
          )}

          {/* Footer */}
          <div className="px-5 sm:px-8 py-4 bg-neutral-50/80 border-t border-neutral-200/60 flex items-center justify-between">
            {currentStep > 1 ? (
              <button
                onClick={goBack}
                disabled={creating}
                className="px-4 py-2.5 text-neutral-500 hover:text-neutral-900 font-medium transition-colors disabled:opacity-50 flex items-center gap-2 text-sm"
              >
                <i className="fas fa-arrow-left text-xs" />
                Back
              </button>
            ) : (
              <Link href="/login" className="px-4 py-2.5 text-neutral-500 hover:text-neutral-900 font-medium transition-colors flex items-center gap-2 text-sm">
                <i className="fas fa-arrow-left text-xs" />
                Back to Sign In
              </Link>
            )}
            
            <button
              onClick={goNext}
              disabled={creating || (currentStep === 3 && !selectedPlan)}
              className="px-6 sm:px-8 py-3 bg-neutral-900 text-white text-sm font-semibold rounded-xl hover:bg-neutral-800 active:scale-[0.98] transition-all shadow-lg shadow-neutral-900/20 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {creating && (
                <svg className="animate-spin h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
              )}
              {nextCtaLabel}
              {currentStep < 3 && !creating && <i className="fas fa-arrow-right text-xs" />}
            </button>
          </div>
        </div>

        {/* Trust badges */}
        <div className="flex items-center justify-center gap-5 mt-7 text-neutral-400">
          <div className="flex items-center gap-1.5 text-[11px]">
            <i className="fas fa-shield-halved" />
            <span>Secure</span>
          </div>
          <div className="w-px h-3 bg-neutral-300" />
          <div className="flex items-center gap-1.5 text-[11px]">
            <i className="fas fa-lock" />
            <span>Encrypted</span>
          </div>
          <div className="w-px h-3 bg-neutral-300" />
          <div className="flex items-center gap-1.5 text-[11px]">
            <i className="fas fa-headset" />
            <span>24/7 Support</span>
          </div>
        </div>

        {/* Terms */}
        <p className="text-[11px] text-neutral-400 text-center mt-4 mb-8">
          By creating an account, you agree to our{" "}
          <a href="https://bmspros.com.au/terms" target="_blank" rel="noopener noreferrer" className="text-neutral-500 hover:text-neutral-900 underline underline-offset-2 transition-colors">
            Terms of Service
          </a>{" "}
          and{" "}
          <a href="https://bmspros.com.au/privacy" target="_blank" rel="noopener noreferrer" className="text-neutral-500 hover:text-neutral-900 underline underline-offset-2 transition-colors">
            Privacy Policy
          </a>
        </p>
      </div>
    </div>
  );
}
