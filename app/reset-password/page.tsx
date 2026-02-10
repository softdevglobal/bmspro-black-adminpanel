"use client";
import React, { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";

function ResetPasswordForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPasswords, setShowPasswords] = useState({ new: false, confirm: false });
  const [loading, setLoading] = useState(false);
  const [verifyingCode, setVerifyingCode] = useState(false);
  const [codeVerified, setCodeVerified] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [passwordErrors, setPasswordErrors] = useState<string[]>([]);

  // Get email from URL params if available
  useEffect(() => {
    const emailParam = searchParams.get("email");
    if (emailParam) {
      setEmail(emailParam);
    }
  }, [searchParams]);

  // Password validation function
  const validatePassword = (password: string): string[] => {
    const errors: string[] = [];
    
    if (password.length < 8) {
      errors.push("At least 8 characters");
    }
    
    if (!/[A-Z]/.test(password)) {
      errors.push("One uppercase letter");
    }
    
    if (!/[a-z]/.test(password)) {
      errors.push("One lowercase letter");
    }
    
    if (!/[0-9]/.test(password)) {
      errors.push("One number");
    }
    
    if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) {
      errors.push("One special character");
    }
    
    return errors;
  };

  // Validate password on change
  const handleNewPasswordChange = (value: string) => {
    setNewPassword(value);
    if (value.length > 0) {
      const errors = validatePassword(value);
      setPasswordErrors(errors);
    } else {
      setPasswordErrors([]);
    }
  };

  const handleVerifyCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    // Validation
    if (!email.trim()) {
      setError("Email is required.");
      return;
    }

    if (!code.trim()) {
      setError("Verification code is required.");
      return;
    }

    if (!/^\d{6}$/.test(code.trim())) {
      setError("Code must be 6 digits.");
      return;
    }

    setVerifyingCode(true);
    try {
      const response = await fetch("/api/auth/verify-reset-code", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: email.trim().toLowerCase(),
          code: code.trim(),
        }),
      });

      const result = await response.json();

      if (!response.ok) {
        setError(result.error || "Invalid or expired code. Please try again.");
        return;
      }

      setCodeVerified(true);
      setError(null);
    } catch (error: any) {
      console.error("Error verifying code:", error);
      setError("Failed to verify code. Please try again.");
    } finally {
      setVerifyingCode(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    // Validation
    if (!newPassword || !confirmPassword) {
      setError("Please fill in all password fields.");
      return;
    }

    // Validate password strength
    const validationErrors = validatePassword(newPassword);
    if (validationErrors.length > 0) {
      setError(`Password must contain: ${validationErrors.join(", ")}`);
      return;
    }

    if (newPassword !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    if (!codeVerified) {
      setError("Please verify your code first.");
      return;
    }

    setLoading(true);
    try {
      const response = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: email.trim().toLowerCase(),
          code: code.trim(),
          newPassword: newPassword,
        }),
      });

      const result = await response.json();

      if (!response.ok) {
        setError(result.error || "Failed to reset password. Please try again.");
        return;
      }

      setSuccess(true);
      
      // Redirect to login after 3 seconds
      setTimeout(() => {
        router.push("/login");
      }, 3000);
    } catch (error: any) {
      console.error("Error resetting password:", error);
      setError(error?.message || "Failed to reset password. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  if (success) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-white p-6">
        <div className="w-full max-w-md">
          <div className="rounded-2xl border border-slate-200 shadow-sm p-6 text-center">
            <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-4">
              <i className="fas fa-check text-2xl text-green-600" />
            </div>
            <h2 className="text-xl font-bold text-slate-900 mb-2">Password Reset Successful!</h2>
            <p className="text-sm text-slate-600 mb-6">
              Your password has been successfully reset. You will be redirected to the login page shortly.
            </p>
            <button
              onClick={() => router.push("/login")}
              className="px-5 py-2.5 bg-pink-600 text-white font-semibold rounded-lg hover:bg-pink-700 transition"
            >
              Go to Login
            </button>
          </div>
        </div>
      </div>
    );
  }

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

          <h2 className="text-xl font-bold text-slate-900 mb-2">Reset Password</h2>
          <p className="text-sm text-slate-500 mb-6">
            {codeVerified 
              ? "Enter your new password below"
              : "Enter your email and the 6-digit code sent to your email"}
          </p>

          {error && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 text-rose-800 p-3 mb-4 flex items-start gap-2">
              <i className="fas fa-circle-exclamation mt-0.5" />
              <div className="flex-1">
                <p className="text-sm font-semibold">Error</p>
                <p className="text-sm">{error}</p>
              </div>
              <button
                type="button"
                onClick={() => setError(null)}
                className="text-rose-700/70 hover:text-rose-800"
              >
                <i className="fas fa-times" />
              </button>
            </div>
          )}

          {!codeVerified ? (
            <form onSubmit={handleVerifyCode} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">Email</label>
                <input
                  type="email"
                  placeholder="you@company.com"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    if (error) setError(null);
                  }}
                  className="w-full px-4 py-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-pink-500 focus:border-transparent"
                  disabled={verifyingCode}
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">Verification Code</label>
                <input
                  type="text"
                  placeholder="000000"
                  value={code}
                  onChange={(e) => {
                    // Only allow digits and limit to 6 characters
                    const value = e.target.value.replace(/\D/g, '').slice(0, 6);
                    setCode(value);
                    if (error) setError(null);
                  }}
                  maxLength={6}
                  className="w-full px-4 py-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-pink-500 focus:border-transparent text-center text-2xl font-mono tracking-widest"
                  disabled={verifyingCode}
                  required
                />
                <p className="mt-1 text-xs text-slate-500 text-center">
                  Enter the 6-digit code sent to your email
                </p>
              </div>

              <button
                type="submit"
                disabled={verifyingCode || !email.trim() || !code.trim() || code.length !== 6}
                className="w-full px-5 py-3 bg-pink-600 text-white font-semibold rounded-lg hover:bg-pink-700 transition disabled:opacity-70 disabled:cursor-not-allowed"
              >
                {verifyingCode ? "Verifying..." : "Verify Code"}
              </button>
            </form>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="bg-green-50 border border-green-200 rounded-lg p-3 mb-4 flex items-center gap-2">
                <i className="fas fa-check-circle text-green-600" />
                <p className="text-sm text-green-800 font-medium">Code verified successfully!</p>
                <button
                  type="button"
                  onClick={() => {
                    setCodeVerified(false);
                    setCode("");
                  }}
                  className="ml-auto text-green-700 hover:text-green-900 text-xs font-medium"
                >
                  Change Code
                </button>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">Email</label>
                <input
                  type="email"
                  value={email}
                  disabled
                  className="w-full px-4 py-3 border border-slate-300 rounded-lg bg-slate-50 text-slate-500 cursor-not-allowed"
                />
              </div>
            
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">New Password</label>
              <div className="relative">
                <input
                  type={showPasswords.new ? "text" : "password"}
                  className={`w-full px-4 py-3 border rounded-lg focus:ring-2 focus:ring-pink-500 focus:border-transparent pr-10 ${
                    newPassword && passwordErrors.length > 0
                      ? "border-red-300 bg-red-50"
                      : newPassword && passwordErrors.length === 0
                      ? "border-green-300 bg-green-50"
                      : "border-slate-300"
                  }`}
                  placeholder="Enter your new password"
                  value={newPassword}
                  onChange={(e) => handleNewPasswordChange(e.target.value)}
                  disabled={loading}
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPasswords({ ...showPasswords, new: !showPasswords.new })}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                >
                  <i className={`fas ${showPasswords.new ? "fa-eye-slash" : "fa-eye"}`} />
                </button>
              </div>
              {newPassword && (
                <div className="mt-2">
                  <p className="text-xs font-medium text-slate-600 mb-1">Password must contain:</p>
                  <ul className="text-xs space-y-1">
                    <li className={`flex items-center gap-2 ${newPassword.length >= 8 ? "text-green-600" : "text-slate-500"}`}>
                      <i className={`fas ${newPassword.length >= 8 ? "fa-check-circle" : "fa-circle"} text-xs`} />
                      At least 8 characters
                    </li>
                    <li className={`flex items-center gap-2 ${/[A-Z]/.test(newPassword) ? "text-green-600" : "text-slate-500"}`}>
                      <i className={`fas ${/[A-Z]/.test(newPassword) ? "fa-check-circle" : "fa-circle"} text-xs`} />
                      One uppercase letter
                    </li>
                    <li className={`flex items-center gap-2 ${/[a-z]/.test(newPassword) ? "text-green-600" : "text-slate-500"}`}>
                      <i className={`fas ${/[a-z]/.test(newPassword) ? "fa-check-circle" : "fa-circle"} text-xs`} />
                      One lowercase letter
                    </li>
                    <li className={`flex items-center gap-2 ${/[0-9]/.test(newPassword) ? "text-green-600" : "text-slate-500"}`}>
                      <i className={`fas ${/[0-9]/.test(newPassword) ? "fa-check-circle" : "fa-circle"} text-xs`} />
                      One number
                    </li>
                    <li className={`flex items-center gap-2 ${/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(newPassword) ? "text-green-600" : "text-slate-500"}`}>
                      <i className={`fas ${/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(newPassword) ? "fa-check-circle" : "fa-circle"} text-xs`} />
                      One special character (!@#$%^&*...)
                    </li>
                  </ul>
                </div>
              )}
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">Confirm New Password</label>
              <div className="relative">
                <input
                  type={showPasswords.confirm ? "text" : "password"}
                  className={`w-full px-4 py-3 border rounded-lg focus:ring-2 focus:ring-pink-500 focus:border-transparent pr-10 ${
                    confirmPassword && newPassword && confirmPassword !== newPassword
                      ? "border-red-300 bg-red-50"
                      : confirmPassword && confirmPassword === newPassword && newPassword.length > 0 && passwordErrors.length === 0
                      ? "border-green-300 bg-green-50"
                      : "border-slate-300"
                  }`}
                  placeholder="Confirm your new password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  disabled={loading}
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPasswords({ ...showPasswords, confirm: !showPasswords.confirm })}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                >
                  <i className={`fas ${showPasswords.confirm ? "fa-eye-slash" : "fa-eye"}`} />
                </button>
              </div>
              {confirmPassword && newPassword && confirmPassword !== newPassword && (
                <p className="mt-1 text-xs text-red-600 flex items-center gap-1">
                  <i className="fas fa-exclamation-circle" />
                  Passwords do not match
                </p>
              )}
              {confirmPassword && confirmPassword === newPassword && newPassword.length > 0 && passwordErrors.length === 0 && (
                <p className="mt-1 text-xs text-green-600 flex items-center gap-1">
                  <i className="fas fa-check-circle" />
                  Passwords match
                </p>
              )}
            </div>

              <button
                type="submit"
                disabled={loading || passwordErrors.length > 0 || newPassword !== confirmPassword}
                className="w-full px-5 py-3 bg-pink-600 text-white font-semibold rounded-lg hover:bg-pink-700 transition disabled:opacity-70 disabled:cursor-not-allowed"
              >
                {loading ? "Resetting Password..." : "Reset Password"}
              </button>
            </form>
          )}

          <p className="text-xs text-slate-500 mt-6 text-center">
            <button
              onClick={() => router.push("/login")}
              className="text-pink-600 hover:text-pink-700 font-medium"
            >
              Back to Login
            </button>
          </p>
        </div>
      </div>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-white p-6">
          <div className="text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-neutral-900 mx-auto mb-4"></div>
            <p className="text-slate-600 font-medium">Loading...</p>
          </div>
        </div>
      }
    >
      <ResetPasswordForm />
    </Suspense>
  );
}
