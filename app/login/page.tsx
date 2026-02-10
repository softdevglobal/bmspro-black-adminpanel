"use client";
import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { signInWithEmailAndPassword } from "firebase/auth";
import { auth, db } from "@/lib/firebase";
import { doc, getDoc } from "firebase/firestore";
import { ensureUserDocument } from "@/lib/users";
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
      // Don't auto-redirect if we just landed here; let the user interaction or explicit auth check handle it
      // to prevent loops if token is invalid but present.
      // However, for UX, we often want to skip login if logged in.
      // Let's verify the token with onAuthStateChanged instead of blind redirect.
    }
  }, [router]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setAuthErrorCode(null);
    // simple client-side validation
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
      await signInWithEmailAndPassword(auth, email, password);
      await ensureUserDocument(auth.currentUser);

      // Check suspension and role BEFORE persisting any tokens/role locally
      const uid = auth.currentUser?.uid;
      if (uid) {
        // Check super_admins collection first
        const superAdminSnap = await getDoc(doc(db, "super_admins", uid));
        let userRole: string;
        let suspended = false;
        let statusText = "";
        
        if (superAdminSnap.exists()) {
          // User is a super_admin
          userRole = "super_admin";
        } else {
          // Check users collection
          const snap = await getDoc(doc(db, "users", uid));
          const userData = snap.data();
          suspended = Boolean(userData?.suspended);
          statusText = (userData?.status || "").toString().toLowerCase();
          userRole = (userData?.role || "").toString().toLowerCase();
        }
        
        // Check if account is suspended (only applies to regular users, not super_admins)
        if (suspended || statusText.includes("suspend")) {
          await (await import("firebase/auth")).signOut(auth);
          setError("Your account is suspended. Please contact support.");
          return;
        }
        
        // Check if user has admin role - only allow admin roles, not customers
        const allowedRoles = ["salon_owner", "salon_branch_admin", "super_admin"];
        if (!allowedRoles.includes(userRole)) {
          await (await import("firebase/auth")).signOut(auth);
          setError("Access denied. This portal is for admin users only.");
          return;
        }
      }

      // Persist token
      const token = await auth.currentUser?.getIdToken();
      if (token && typeof window !== "undefined") {
        localStorage.setItem("idToken", token);
      }
      // Fetch role and persist for immediate sidebar rendering (after suspension check)
      try {
        const uid2 = auth.currentUser?.uid;
        if (uid2) {
          // Check super_admins collection first
          const superAdminSnap = await getDoc(doc(db, "super_admins", uid2));
          let data: any;
          let role: string;
          let name: string;
          let ownerUid: string;
          
          if (superAdminSnap.exists()) {
            // User is a super_admin
            data = superAdminSnap.data();
            role = "super_admin";
            name = (data?.displayName || "").toString();
            ownerUid = uid2; // Super admin is their own owner
          } else {
            // Check users collection
            const snap = await getDoc(doc(db, "users", uid2));
            data = snap.data();
            role = (data?.role || "").toString();
            name = (data?.displayName || data?.name || "").toString();
            ownerUid = data?.ownerUid || uid2; // For staff, get their owner; for owners, use their own uid
          }
          
          if (typeof window !== "undefined") {
            localStorage.setItem("role", role);
            if (name) localStorage.setItem("userName", name);
          }

          // Audit log for successful login
          try {
            // Log to salon-specific audit logs (for salon owners/staff)
            if (role !== "super_admin") {
              await logUserLogin(ownerUid, uid2, name || email, role);
            }
            
            // Log to super admin audit logs (for all logins - visible to super admins)
            if (role === "super_admin") {
              await logSuperAdminLogin(uid2, name || email);
            } else {
              // Log salon owner/staff logins to super admin audit logs
              await createSuperAdminAuditLog({
                action: `${role === "salon_owner" ? "Salon Owner" : "Staff"} logged in: ${name || email}`,
                actionType: "login",
                entityType: "tenant",
                entityId: ownerUid,
                entityName: name || email,
                performedBy: uid2,
                performedByName: name || email,
                details: `Role: ${role}`,
              });
            }
          } catch (auditErr) {
            console.error("Failed to create login audit log:", auditErr);
          }
        }
      } catch {}
      // Avoid immediate redirect if we are already on a page that might redirect back
      // Instead, verify role logic one last time
      const userRole = localStorage.getItem("role");
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

    // Validate email
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
    <div className="min-h-screen flex items-center justify-center bg-white p-6">
      <div className="w-full max-w-md">
        <div className="rounded-2xl border border-slate-200 shadow-sm p-6">
          <div className="flex items-center gap-3 mb-6">
            <img
              src="/bmspink-icon.jpeg"
              alt="BMS PRO BLACK"
              className="w-10 h-10 rounded-xl shadow-lg object-cover"
            />
            <div>
              <h1 className="font-bold text-lg text-slate-900">BMS PRO</h1>
              <p className="text-xs font-semibold text-pink-600">PINK — Admin</p>
            </div>
          </div>

          <div className="flex items-center justify-between mb-2">
            <h2 className="text-xl font-bold text-slate-900">Sign in</h2>
          </div>
          <p className="text-sm text-slate-500 mb-6">
            Access your business dashboard
          </p>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">Email</label>
              <input
                type="email"
                placeholder="you@company.com"
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
                className={`w-full px-4 py-3 border rounded-lg focus:ring-2 focus:ring-pink-500 focus:border-transparent ${
                  emailError || authErrorCode === "auth/user-not-found" || authErrorCode === "auth/invalid-email"
                    ? "border-rose-400"
                    : "border-slate-300"
                }`}
              />
              {emailError && <p className="mt-1 text-xs text-rose-600">{emailError}</p>}
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">Password</label>
              <div className="relative">
                <input
                  type={showPassword ? "text" : "password"}
                  placeholder="••••••••"
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
                  className={`w-full px-4 py-3 pr-12 border rounded-lg focus:ring-2 focus:ring-pink-500 focus:border-transparent ${
                    passwordError || authErrorCode === "auth/wrong-password" || authErrorCode === "auth/invalid-credential"
                      ? "border-rose-400"
                      : "border-slate-300"
                  }`}
                />
                <button
                  type="button"
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  onClick={() => setShowPassword((s) => !s)}
                  className="absolute inset-y-0 right-0 px-3 text-slate-500 hover:text-slate-700"
                >
                  <i className={`fas ${showPassword ? "fa-eye-slash" : "fa-eye"}`} />
                </button>
              </div>
              {passwordError && <p className="mt-1 text-xs text-rose-600">{passwordError}</p>}
            </div>
            <div className="flex items-center justify-end">
              <button
                type="button"
                onClick={() => setShowForgotPassword(true)}
                className="text-sm text-pink-600 hover:text-pink-700 font-medium"
              >
                Forgot password?
              </button>
            </div>
            {error && (
              <div className="rounded-lg border border-rose-200 bg-rose-50 text-rose-800 p-3 flex items-start gap-2">
                <i className="fas fa-circle-exclamation mt-0.5" />
                <div className="flex-1">
                  <p className="text-sm font-semibold">Sign in failed</p>
                  <p className="text-sm">{error}</p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    setAuthErrorCode(null);
                  }}
                  aria-label="Dismiss error"
                  className="text-rose-700/70 hover:text-rose-800"
                >
                  <i className="fas fa-times" />
                </button>
              </div>
            )}
            <button
              type="submit"
              disabled={loading}
              className="w-full px-5 py-3 bg-pink-600 text-white font-semibold rounded-lg hover:bg-pink-700 transition disabled:opacity-70"
            >
              {loading ? "Signing in..." : "Sign in"}
            </button>
          </form>

          <p className="text-xs text-slate-500 mt-6 text-center">
            By continuing you agree to our{" "}
            <a
              href="https://bmspros.com.au/terms"
              target="_blank"
              rel="noopener noreferrer"
              className="text-pink-600 hover:text-pink-700 underline"
            >
              Terms
            </a>{" "}
            and{" "}
            <a
              href="https://bmspros.com.au/privacy"
              target="_blank"
              rel="noopener noreferrer"
              className="text-pink-600 hover:text-pink-700 underline"
            >
              Privacy Policy
            </a>
            .
          </p>

          {/* Sign Up Section */}
          <div className="mt-8 pt-6 border-t border-slate-200">
            <div className="text-center">
              <p className="text-sm text-slate-600 mb-3">
                New to BMS PRO BLACK?
              </p>
              <Link
                href="/signup"
                className="w-full inline-flex items-center justify-center gap-2 px-5 py-3 border-2 border-pink-500 text-pink-600 font-semibold rounded-lg hover:bg-pink-50 transition"
              >
                <i className="fas fa-store" />
                Register Your Business
              </Link>
              <p className="text-xs text-slate-500 mt-3">
                Beauty salons, hair studios, nail spas, massage centers & more
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Forgot Password Modal */}
      {showForgotPassword && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md">
            <div className="p-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-xl font-bold text-slate-900">Reset Password</h2>
                <button
                  onClick={() => {
                    setShowForgotPassword(false);
                    setForgotPasswordEmail("");
                    setForgotPasswordError(null);
                    setForgotPasswordSuccess(false);
                  }}
                  className="text-slate-400 hover:text-slate-600"
                >
                  <i className="fas fa-times" />
                </button>
              </div>

              {forgotPasswordSuccess ? (
                <div className="text-center py-6">
                  <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-4">
                    <i className="fas fa-check text-2xl text-green-600" />
                  </div>
                  <h3 className="text-lg font-semibold text-slate-900 mb-2">Check your email</h3>
                  <p className="text-sm text-slate-600 mb-6">
                    We've sent a 6-digit verification code to <strong>{forgotPasswordEmail}</strong>. Please check your inbox and enter the code on the reset password page.
                  </p>
                  <div className="flex gap-3">
                    <button
                      onClick={() => {
                        setShowForgotPassword(false);
                        setForgotPasswordEmail("");
                        setForgotPasswordSuccess(false);
                      }}
                      className="flex-1 px-5 py-2.5 border border-slate-300 text-slate-700 font-semibold rounded-lg hover:bg-slate-50 transition"
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
                      className="flex-1 px-5 py-2.5 bg-pink-600 text-white font-semibold rounded-lg hover:bg-pink-700 transition"
                    >
                      Go to Reset Password Page
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <p className="text-sm text-slate-600 mb-6">
                    Enter your email address and we'll send you a 6-digit code to reset your password.
                  </p>
                  <form onSubmit={handleForgotPassword} className="space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-2">Email</label>
                      <input
                        type="email"
                        placeholder="you@company.com"
                        value={forgotPasswordEmail}
                        onChange={(e) => {
                          setForgotPasswordEmail(e.target.value);
                          if (forgotPasswordError) setForgotPasswordError(null);
                        }}
                        className={`w-full px-4 py-3 border rounded-lg focus:ring-2 focus:ring-pink-500 focus:border-transparent ${
                          forgotPasswordError ? "border-rose-400" : "border-slate-300"
                        }`}
                        required
                      />
                      {forgotPasswordError && (
                        <p className="mt-1 text-xs text-rose-600">{forgotPasswordError}</p>
                      )}
                    </div>
                    <div className="flex gap-3">
                      <button
                        type="button"
                        onClick={() => {
                          setShowForgotPassword(false);
                          setForgotPasswordEmail("");
                          setForgotPasswordError(null);
                        }}
                        className="flex-1 px-5 py-2.5 border border-slate-300 text-slate-700 font-semibold rounded-lg hover:bg-slate-50 transition"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        disabled={forgotPasswordLoading}
                        className="flex-1 px-5 py-2.5 bg-pink-600 text-white font-semibold rounded-lg hover:bg-pink-700 transition disabled:opacity-70 disabled:cursor-not-allowed"
                      >
                        {forgotPasswordLoading ? "Sending..." : "Send Reset Code"}
                      </button>
                    </div>
                  </form>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


