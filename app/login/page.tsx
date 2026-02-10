"use client";
import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { signInWithEmailAndPassword } from "firebase/auth";
import { auth } from "@/lib/firebase";
import { fetchCurrentUser } from "@/lib/authClient";
import { logUserLogin, logSuperAdminLogin, createSuperAdminAuditLog } from "@/lib/auditLog";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [authErrorCode, setAuthErrorCode] = useState<string | null>(null);
  
  // Forgot password state
  const [showForgotPassword, setShowForgotPassword] = useState(false);
  const [forgotPasswordEmail, setForgotPasswordEmail] = useState("");
  const [forgotPasswordLoading, setForgotPasswordLoading] = useState(false);
  const [forgotPasswordError, setForgotPasswordError] = useState<string | null>(null);
  const [forgotPasswordSuccess, setForgotPasswordSuccess] = useState(false);

  // Mounted state for animations
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  function friendlyAuthMessage(code?: string) {
    switch (code) {
      case "auth/invalid-email":
        return "Enter a valid email address.";
      case "auth/user-not-found":
        return "Invalid email or password.";
      case "auth/wrong-password":
        return "Invalid email or password.";
      case "auth/invalid-credential":
        return "Invalid email or password.";
      case "auth/email-already-in-use":
        return "An account already exists with this email.";
      case "auth/weak-password":
        return "Password should be at least 6 characters.";
      case "auth/operation-not-allowed":
        return "Sign-in is temporarily unavailable. Please contact support.";
      case "auth/invalid-api-key":
        return "Configuration error. Please contact support.";
      case "auth/network-request-failed":
        return "Network error. Check your connection and try again.";
      case "auth/too-many-requests":
        return "Too many attempts. Try again later.";
      default:
        return "Sign in failed. Please try again.";
    }
  }

  useEffect(() => {
    const hasToken = typeof window !== "undefined" && localStorage.getItem("idToken");
    if (hasToken) {
      // Don't auto-redirect if we just landed here
    }
  }, [router]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setAuthErrorCode(null);
    let valid = true;
    if (!email.trim()) {
      setEmailError("Email is required.");
      valid = false;
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setEmailError("Enter a valid email address.");
      valid = false;
    } else {
      setEmailError(null);
    }
    if (!password) {
      setPasswordError("Password is required.");
      valid = false;
    } else {
      setPasswordError(null);
    }
    if (!valid) return;
    setLoading(true);
    try {
      // Step 1: Sign in with Firebase Auth
      await signInWithEmailAndPassword(auth, email, password);
      const uid = auth.currentUser?.uid;
      if (!uid) throw new Error("No user UID after sign in");

      // Step 2: Persist token
      const token = await auth.currentUser?.getIdToken();
      if (token && typeof window !== "undefined") {
        localStorage.setItem("idToken", token);
      }

      // Step 3: Fetch role via server API (bypasses Firestore rules)
      const userData = await fetchCurrentUser();
      if (!userData) {
        await (await import("firebase/auth")).signOut(auth);
        setError("Unable to verify your account. Please try again.");
        return;
      }

      const { role: userRole, displayName: userName, suspended, status: statusText, ownerUid, isSuperAdmin } = userData;

      // Step 4: Check suspension
      if (!isSuperAdmin && (suspended || (statusText || "").toLowerCase().includes("suspend"))) {
        await (await import("firebase/auth")).signOut(auth);
        setError("Your account is suspended. Please contact support.");
        return;
      }

      // Step 5: Check role is allowed
      const allowedRoles = ["salon_owner", "salon_branch_admin", "super_admin"];
      if (!allowedRoles.includes(userRole)) {
        await (await import("firebase/auth")).signOut(auth);
        setError("Access denied. This portal is for admin users only.");
        return;
      }

      // Step 6: Audit logging (non-blocking)
      try {
        if (userRole === "super_admin") {
          await logSuperAdminLogin(uid, userName || email);
        } else {
          await logUserLogin(ownerUid || uid, uid, userName || email, userRole);
          await createSuperAdminAuditLog({
            action: `${userRole === "salon_owner" ? "Salon Owner" : "Staff"} logged in: ${userName || email}`,
            actionType: "login",
            entityType: "tenant",
            entityId: ownerUid || uid,
            entityName: userName || email,
            performedBy: uid,
            performedByName: userName || email,
            details: `Role: ${userRole}`,
          });
        }
      } catch (auditErr) {
        console.warn("Audit log failed (non-blocking):", auditErr);
      }

      // Step 7: Redirect based on role
      if (userRole === "super_admin") {
        router.replace("/admin-dashboard");
      } else if (userRole === "salon_branch_admin") {
        router.replace("/branches");
      } else {
        router.replace("/dashboard");
      }
    } catch (err: any) {
      console.error("Auth error:", err);
      setError(friendlyAuthMessage(err?.code));
      setAuthErrorCode(err?.code || null);
    } finally {
      setLoading(false);
      }
    };

  const handleForgotPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setForgotPasswordError(null);
    setForgotPasswordSuccess(false);

    if (!forgotPasswordEmail.trim()) {
      setForgotPasswordError("Email is required.");
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(forgotPasswordEmail.trim())) {
      setForgotPasswordError("Enter a valid email address.");
      return;
    }

    setForgotPasswordLoading(true);
    try {
      const response = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: forgotPasswordEmail.trim().toLowerCase(),
        }),
      });

      const result = await response.json();

      if (!response.ok) {
        setForgotPasswordError(result.error || "Failed to send password reset email. Please try again.");
        return;
      }

      setForgotPasswordSuccess(true);
      setForgotPasswordEmail("");
    } catch (error: any) {
      console.error("Error sending password reset email:", error);
      setForgotPasswordError("Failed to send password reset email. Please try again.");
    } finally {
      setForgotPasswordLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col lg:flex-row bg-neutral-100">
      {/* ===== MOBILE: Dark branded header ===== */}
      <div className={`lg:hidden relative overflow-hidden bg-neutral-950 px-6 pt-12 pb-10 transition-all duration-700 ${mounted ? 'opacity-100' : 'opacity-0'}`}>
        {/* Gradient + dot pattern */}
        <div className="absolute inset-0 bg-gradient-to-br from-neutral-900 via-neutral-950 to-black" />
        <div className="absolute inset-0 opacity-[0.04]" style={{
          backgroundImage: `radial-gradient(circle at 1px 1px, rgba(255,255,255,0.15) 1px, transparent 0)`,
          backgroundSize: '24px 24px'
        }} />
        <div className="absolute -top-20 -right-20 w-60 h-60 bg-white/[0.03] rounded-full blur-3xl" />
        
        <div className="relative z-10">
          {/* Logo */}
          <div className="flex items-center gap-3 mb-6">
            <div className="w-10 h-10 rounded-xl bg-white flex items-center justify-center shadow-lg shadow-black/20">
              <i className="fas fa-wrench text-neutral-900 text-sm" />
            </div>
            <div>
              <span className="text-white font-bold text-lg tracking-tight">BMS PRO</span>
              <span className="text-neutral-500 text-[10px] font-semibold tracking-[0.3em] uppercase ml-2">Black</span>
            </div>
          </div>
          {/* Headline */}
          <h1 className="text-2xl sm:text-3xl font-bold text-white leading-tight tracking-tight">
            Your workshop,{" "}
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-neutral-300 to-neutral-500">
              fully managed.
            </span>
          </h1>
          <p className="text-neutral-500 text-sm mt-2 max-w-xs">
            Bookings, staff, services & operations in one dashboard.
          </p>
        </div>
      </div>

      {/* ===== DESKTOP: Left Panel - Hero Branding ===== */}
      <div className="hidden lg:flex lg:w-[55%] relative overflow-hidden bg-neutral-950">
        <div className="absolute inset-0 bg-gradient-to-br from-neutral-900 via-neutral-950 to-black" />
        <div className="absolute inset-0 opacity-[0.03]" style={{
          backgroundImage: `radial-gradient(circle at 1px 1px, rgba(255,255,255,0.15) 1px, transparent 0)`,
          backgroundSize: '32px 32px'
        }} />
        <div className="absolute -top-32 -left-32 w-96 h-96 bg-white/[0.03] rounded-full blur-3xl" />
        <div className="absolute -bottom-48 -right-48 w-[500px] h-[500px] bg-white/[0.02] rounded-full blur-3xl" />

        <div className={`relative z-10 flex flex-col justify-between p-12 xl:p-16 w-full transition-all duration-1000 ${mounted ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'}`}>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-white flex items-center justify-center">
              <i className="fas fa-wrench text-neutral-900 text-sm" />
            </div>
            <div>
              <span className="text-white font-bold text-lg tracking-tight">BMS PRO</span>
              <span className="text-neutral-500 text-[10px] font-semibold tracking-[0.3em] uppercase ml-2">Black</span>
            </div>
          </div>

          <div className="max-w-lg">
            <h1 className="text-4xl xl:text-5xl font-bold text-white leading-[1.1] tracking-tight mb-5">
              Your workshop,
              <br />
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-neutral-200 to-neutral-500">
                fully managed.
              </span>
            </h1>
            <p className="text-neutral-400 text-base xl:text-lg leading-relaxed max-w-md">
              Streamline bookings, staff, services, and operations — all from one powerful dashboard.
            </p>
            <div className="flex flex-wrap gap-2 mt-8">
              {["Bookings", "Staff Management", "Invoicing", "Analytics", "Multi-branch"].map((feature) => (
                <span
                  key={feature}
                  className="px-3 py-1.5 rounded-full text-[11px] font-medium bg-white/[0.06] text-neutral-400 border border-white/[0.06]"
                >
                  {feature}
                </span>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2 text-neutral-500 text-xs">
              <i className="fas fa-shield-halved text-sm text-neutral-600" />
              <span>Secured by Firebase</span>
            </div>
            <div className="w-px h-4 bg-neutral-800" />
            <div className="flex items-center gap-2 text-neutral-500 text-xs">
              <i className="fas fa-lock text-sm text-neutral-600" />
              <span>End-to-end encrypted</span>
            </div>
          </div>
        </div>
      </div>

      {/* ===== Right / Bottom Panel - Login Form ===== */}
      <div className="flex-1 flex items-start lg:items-center justify-center bg-neutral-100 lg:bg-white px-5 sm:px-8 py-8 lg:px-12 lg:py-12">
        <div className={`w-full max-w-[420px] transition-all duration-700 delay-200 ${mounted ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'}`}>
          {/* Card wrapper - visible on mobile, flat on desktop */}
          <div className="bg-white rounded-2xl lg:rounded-none lg:bg-transparent p-6 sm:p-8 lg:p-0 shadow-xl shadow-neutral-900/[0.04] lg:shadow-none border border-neutral-200/60 lg:border-0 -mt-6 lg:mt-0 relative z-10">
            {/* Header */}
            <div className="mb-7">
              <h2 className="text-xl sm:text-2xl font-bold text-neutral-900 tracking-tight">Welcome back</h2>
              <p className="text-sm text-neutral-400 mt-1">
                Sign in to your admin dashboard
              </p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4 sm:space-y-5">
              {/* Error banner */}
              {error && (
                <div className="rounded-xl bg-rose-50 border border-rose-200/60 text-rose-700 px-3.5 sm:px-4 py-3 flex items-start gap-2.5 sm:gap-3 text-sm animate-[fadeIn_0.2s_ease-out]">
                  <div className="w-7 h-7 sm:w-8 sm:h-8 rounded-lg bg-rose-100 flex items-center justify-center shrink-0 mt-0.5">
                    <i className="fas fa-circle-exclamation text-rose-500 text-[11px]" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-[13px]">Sign in failed</p>
                    <p className="text-rose-600/80 text-xs mt-0.5">{error}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => { setError(null); setAuthErrorCode(null); }}
                    aria-label="Dismiss error"
                    className="text-rose-400 hover:text-rose-600 transition p-1"
                  >
                    <i className="fas fa-times text-xs" />
                  </button>
                </div>
              )}

              {/* Email field */}
              <div>
                <label className="block text-[13px] font-semibold text-neutral-700 mb-1.5">Email</label>
                <div className="relative group">
                  <input
                    type="email"
                    placeholder="name@workshop.com"
                    value={email}
                    onChange={(e) => {
                      setEmail(e.target.value);
                      if (emailError) setEmailError(null);
                      if (authErrorCode) setAuthErrorCode(null);
                    }}
                    onBlur={() => {
                      if (!email.trim()) setEmailError("Email is required.");
                      else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) setEmailError("Enter a valid email address.");
                    }}
                    aria-invalid={!!emailError}
                    className={`w-full px-4 py-3 text-sm bg-neutral-50/80 border-2 rounded-xl focus:ring-0 focus:border-neutral-900 focus:bg-white transition-all outline-none placeholder:text-neutral-400 ${
                      emailError || authErrorCode === "auth/user-not-found" || authErrorCode === "auth/invalid-email"
                        ? "border-rose-300 bg-rose-50/40"
                        : "border-neutral-200 hover:border-neutral-300"
                    }`}
                  />
                </div>
                {emailError && (
                  <p className="mt-1.5 text-xs text-rose-500 flex items-center gap-1.5">
                    <i className="fas fa-exclamation-circle text-[10px]" />{emailError}
                  </p>
                )}
              </div>

              {/* Password field */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="block text-[13px] font-semibold text-neutral-700">Password</label>
                  <button
                    type="button"
                    onClick={() => setShowForgotPassword(true)}
                    className="text-xs text-neutral-400 hover:text-neutral-900 font-medium transition-colors"
                  >
                    Forgot password?
                  </button>
                </div>
                <div className="relative group">
                  <input
                    type={showPassword ? "text" : "password"}
                    placeholder="Enter your password"
                    value={password}
                    onChange={(e) => {
                      setPassword(e.target.value);
                      if (passwordError) setPasswordError(null);
                      if (authErrorCode) setAuthErrorCode(null);
                    }}
                    onBlur={() => {
                      if (!password) setPasswordError("Password is required.");
                    }}
                    aria-invalid={!!passwordError}
                    className={`w-full px-4 py-3 pr-12 text-sm bg-neutral-50/80 border-2 rounded-xl focus:ring-0 focus:border-neutral-900 focus:bg-white transition-all outline-none placeholder:text-neutral-400 ${
                      passwordError || authErrorCode === "auth/wrong-password" || authErrorCode === "auth/invalid-credential"
                        ? "border-rose-300 bg-rose-50/40"
                        : "border-neutral-200 hover:border-neutral-300"
                    }`}
                  />
                  <button
                    type="button"
                    aria-label={showPassword ? "Hide password" : "Show password"}
                    onClick={() => setShowPassword((s) => !s)}
                    className="absolute inset-y-0 right-0 px-4 text-neutral-400 hover:text-neutral-600 transition-colors"
                  >
                    <i className={`fas ${showPassword ? "fa-eye-slash" : "fa-eye"} text-sm`} />
                  </button>
                </div>
                {passwordError && (
                  <p className="mt-1.5 text-xs text-rose-500 flex items-center gap-1.5">
                    <i className="fas fa-exclamation-circle text-[10px]" />{passwordError}
                  </p>
                )}
              </div>

              {/* Submit */}
              <button
                type="submit"
                disabled={loading}
                className="w-full py-3 bg-neutral-900 text-white text-sm font-semibold rounded-xl hover:bg-neutral-800 active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-neutral-900/20 hover:shadow-xl hover:shadow-neutral-900/25 mt-1"
              >
                {loading ? (
                  <span className="flex items-center justify-center gap-2">
                    <svg className="animate-spin h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    Signing in...
                  </span>
                ) : "Sign in"}
              </button>
            </form>

            {/* Divider */}
            <div className="flex items-center gap-4 my-6">
              <div className="flex-1 h-px bg-neutral-200" />
              <span className="text-[11px] text-neutral-400 font-medium uppercase tracking-widest">or</span>
              <div className="flex-1 h-px bg-neutral-200" />
            </div>

            {/* Register */}
            <Link
              href="/signup"
              className="w-full flex items-center justify-center gap-2.5 py-3 border-2 border-neutral-200 text-neutral-700 text-sm font-semibold rounded-xl hover:bg-neutral-50 hover:border-neutral-300 active:scale-[0.98] transition-all"
            >
              <i className="fas fa-plus text-neutral-400 text-xs" />
              Register Your Workshop
            </Link>
            <p className="text-[11px] text-neutral-400 mt-3 text-center">
              Auto repair shops, garages, service centers & more
            </p>
          </div>

          {/* Terms footer - outside card on mobile */}
          <p className="text-[11px] text-neutral-400 mt-6 text-center leading-relaxed px-2">
            By continuing you agree to our{" "}
            <a href="https://bmspros.com.au/terms" target="_blank" rel="noopener noreferrer" className="text-neutral-500 hover:text-neutral-900 underline underline-offset-2 transition-colors">Terms</a>
            {" "}and{" "}
            <a href="https://bmspros.com.au/privacy" target="_blank" rel="noopener noreferrer" className="text-neutral-500 hover:text-neutral-900 underline underline-offset-2 transition-colors">Privacy Policy</a>.
          </p>

          {/* Mobile trust badges */}
          <div className="flex items-center justify-center gap-4 mt-5 lg:hidden">
            <div className="flex items-center gap-1.5 text-neutral-400 text-[11px]">
              <i className="fas fa-shield-halved text-[11px]" />
              <span>Secured</span>
            </div>
            <div className="w-px h-3 bg-neutral-300" />
            <div className="flex items-center gap-1.5 text-neutral-400 text-[11px]">
              <i className="fas fa-lock text-[11px]" />
              <span>Encrypted</span>
            </div>
            <div className="w-px h-3 bg-neutral-300" />
            <div className="flex items-center gap-1.5 text-neutral-400 text-[11px]">
              <i className="fas fa-bolt text-[11px]" />
              <span>Fast</span>
            </div>
          </div>
        </div>
      </div>

      {/* Forgot Password Modal */}
      {showForgotPassword && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-black/50 backdrop-blur-sm">
          <div
            className="bg-white rounded-t-2xl sm:rounded-2xl shadow-2xl w-full sm:max-w-md border border-neutral-200/60 animate-[slideUp_0.3s_ease-out] sm:animate-[fadeIn_0.2s_ease-out]"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Drag handle for mobile */}
            <div className="flex justify-center pt-3 pb-1 sm:hidden">
              <div className="w-10 h-1 rounded-full bg-neutral-300" />
            </div>
            <div className="p-5 sm:p-6">
              <div className="flex items-center justify-between mb-5">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-neutral-100 flex items-center justify-center">
                    <i className="fas fa-key text-neutral-600 text-sm" />
                  </div>
                  <h2 className="text-lg font-bold text-neutral-900">Reset Password</h2>
                </div>
                <button
                  onClick={() => {
                    setShowForgotPassword(false);
                    setForgotPasswordEmail("");
                    setForgotPasswordError(null);
                    setForgotPasswordSuccess(false);
                  }}
                  className="w-8 h-8 rounded-lg flex items-center justify-center text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 transition"
                >
                  <i className="fas fa-times text-sm" />
                </button>
              </div>

              {forgotPasswordSuccess ? (
                <div className="text-center py-4">
                  <div className="w-16 h-16 rounded-2xl bg-emerald-50 flex items-center justify-center mx-auto mb-4">
                    <i className="fas fa-check text-2xl text-emerald-600" />
                  </div>
                  <h3 className="text-base font-bold text-neutral-900 mb-1.5">Check your email</h3>
                  <p className="text-sm text-neutral-500 mb-6">
                    We've sent a 6-digit code to <strong className="text-neutral-700">{forgotPasswordEmail}</strong>.
                  </p>
                  <div className="flex gap-3">
                    <button
                      onClick={() => {
                        setShowForgotPassword(false);
                        setForgotPasswordEmail("");
                        setForgotPasswordSuccess(false);
                      }}
                      className="flex-1 py-3 border-2 border-neutral-200 text-neutral-700 text-sm font-semibold rounded-xl hover:bg-neutral-50 transition"
                    >
                      Close
                    </button>
                    <button
                      onClick={() => {
                        const email = forgotPasswordEmail;
                        setShowForgotPassword(false);
                        setForgotPasswordEmail("");
                        setForgotPasswordSuccess(false);
                        router.push(`/reset-password?email=${encodeURIComponent(email)}`);
                      }}
                      className="flex-1 py-3 bg-neutral-900 text-white text-sm font-semibold rounded-xl hover:bg-neutral-800 transition shadow-lg shadow-neutral-900/20"
                    >
                      Enter Code
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <p className="text-sm text-neutral-500 mb-5">
                    Enter your email and we'll send you a 6-digit code to reset your password.
                  </p>
                  <form onSubmit={handleForgotPassword} className="space-y-4">
                    <div>
                      <label className="block text-[13px] font-semibold text-neutral-700 mb-1.5">Email address</label>
                      <input
                        type="email"
                        placeholder="name@workshop.com"
                        value={forgotPasswordEmail}
                        onChange={(e) => {
                          setForgotPasswordEmail(e.target.value);
                          if (forgotPasswordError) setForgotPasswordError(null);
                        }}
                        className={`w-full px-4 py-3 text-sm bg-neutral-50 border-2 rounded-xl focus:ring-0 focus:border-neutral-900 focus:bg-white transition-all outline-none placeholder:text-neutral-400 ${
                          forgotPasswordError ? "border-rose-300 bg-rose-50/40" : "border-neutral-200 hover:border-neutral-300"
                        }`}
                        required
                      />
                      {forgotPasswordError && (
                        <p className="mt-1.5 text-xs text-rose-500 flex items-center gap-1.5">
                          <i className="fas fa-exclamation-circle text-[10px]" />{forgotPasswordError}
                        </p>
                      )}
                    </div>
                    <div className="flex gap-3 pt-1">
                      <button
                        type="button"
                        onClick={() => {
                          setShowForgotPassword(false);
                          setForgotPasswordEmail("");
                          setForgotPasswordError(null);
                        }}
                        className="flex-1 py-3 border-2 border-neutral-200 text-neutral-700 text-sm font-semibold rounded-xl hover:bg-neutral-50 transition"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        disabled={forgotPasswordLoading}
                        className="flex-1 py-3 bg-neutral-900 text-white text-sm font-semibold rounded-xl hover:bg-neutral-800 transition disabled:opacity-50 shadow-lg shadow-neutral-900/20"
                      >
                        {forgotPasswordLoading ? (
                          <span className="flex items-center justify-center gap-2">
                            <svg className="animate-spin h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                            </svg>
                            Sending...
                          </span>
                        ) : "Send Code"}
                      </button>
                    </div>
                  </form>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Global animation keyframes */}
      <style jsx global>{`
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes slideUp {
          from { opacity: 0; transform: translateY(100%); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
