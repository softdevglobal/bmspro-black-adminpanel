"use client";
import React, { useState } from "react";
import { auth } from "@/lib/firebase";

interface PaymentRequiredModalProps {
  isOpen: boolean;
  planName?: string;
  planPrice?: string;
  planId?: string;
  trialDays?: number;
  accountStatus?: string;
  onClose?: () => void; // Optional - typically we don't allow closing
}

export default function PaymentRequiredModal({
  isOpen,
  planName,
  planPrice,
  planId,
  trialDays,
  accountStatus,
  onClose,
}: PaymentRequiredModalProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const isTrialExpired = accountStatus === "trial_expired";
  const isSuspended = accountStatus === "suspended";
  const hasFreeTrial = !isTrialExpired && !isSuspended && trialDays && trialDays > 0;

  const handlePayNow = async () => {
    if (!planId) {
      setError("No subscription plan found. Please contact support.");
      return;
    }

    try {
      setLoading(true);
      setError(null);

      const user = auth.currentUser;
      if (!user) {
        setError("Please log in to continue.");
        return;
      }

      const token = await user.getIdToken();

      // Create Stripe checkout session
      const response = await fetch("/api/stripe/create-checkout", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          planId: planId,
        }),
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error || "Failed to create checkout session");
      }

      // Redirect to Stripe Checkout
      if (data.url) {
        window.location.href = data.url;
      } else {
        throw new Error("No checkout URL returned");
      }
    } catch (err: any) {
      console.error("Payment error:", err);
      setError(err.message || "Failed to start payment. Please try again.");
      setLoading(false);
    }
  };

  const handleLogout = async () => {
    try {
      await auth.signOut();
      window.location.href = "/login";
    } catch (err) {
      console.error("Logout error:", err);
    }
  };

  // Trial expired view - dedicated walkthrough
  if (isTrialExpired) {
    return (
      <div className="fixed inset-0 z-[9999] flex items-center justify-center overflow-y-auto p-4 py-6 md:py-14 md:px-8">
        <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />

        <div className="relative my-auto flex max-h-[calc(100dvh-3rem)] w-full max-w-md shrink-0 flex-col overflow-hidden rounded-2xl bg-white shadow-2xl md:max-h-[calc(100dvh-7rem)]">
          <div className="shrink-0 bg-neutral-900 p-6 text-center text-white">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-white/20 backdrop-blur">
              <i className="fas fa-hourglass-end text-3xl" />
            </div>
            <h2 className="mb-2 text-2xl font-bold">Your Trial Has Ended</h2>
            <p className="text-sm text-white/90">
              Complete your payment to continue using BMS Pro
            </p>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-6">
            {planName && (
              <div className="relative mb-5 overflow-hidden rounded-xl border border-neutral-200 bg-gradient-to-br from-neutral-50 to-neutral-100 p-5">
                <div className="absolute right-0 top-0 rounded-bl-lg bg-neutral-900 px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-white">
                  Your Plan
                </div>
                <div className="mt-2 flex items-center justify-between">
                  <div>
                    <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-neutral-500">
                      Selected Package
                    </p>
                    <p className="text-xl font-bold text-neutral-900">{planName}</p>
                  </div>
                  {planPrice && (
                    <div className="text-right">
                      <p className="text-2xl font-bold text-neutral-900">{planPrice}</p>
                    </div>
                  )}
                </div>
              </div>
            )}

            <div className="mb-5 rounded-xl border border-neutral-200 bg-neutral-50 p-4">
              <p className="mb-3 text-sm font-semibold text-neutral-800">
                <i className="fas fa-arrow-right mr-2 text-neutral-500" />
                What happens next?
              </p>
              <div className="space-y-2.5">
                <div className="flex items-start gap-2.5">
                  <div className="mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-neutral-200">
                    <span className="text-[10px] font-bold text-neutral-700">1</span>
                  </div>
                  <p className="text-sm text-neutral-600">You&apos;ll be redirected to a secure payment page</p>
                </div>
                <div className="flex items-start gap-2.5">
                  <div className="mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-neutral-200">
                    <span className="text-[10px] font-bold text-neutral-700">2</span>
                  </div>
                  <p className="text-sm text-neutral-600">Enter your payment details to activate your subscription</p>
                </div>
                <div className="flex items-start gap-2.5">
                  <div className="mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-neutral-200">
                    <span className="text-[10px] font-bold text-neutral-700">3</span>
                  </div>
                  <p className="text-sm text-neutral-600">Your account will be reactivated instantly</p>
                </div>
              </div>
            </div>

            <div className="mb-5 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
              <div className="flex items-start gap-3">
                <i className="fas fa-shield-alt mt-0.5 text-emerald-600" />
                <p className="text-sm text-emerald-700">
                  <span className="font-medium">Your data is safe.</span> All your workshop data, bookings, and settings are preserved and will be fully accessible once you subscribe.
                </p>
              </div>
            </div>

            {error && (
              <div className="rounded-xl border border-rose-200 bg-rose-50 p-4">
                <div className="flex items-start gap-3">
                  <i className="fas fa-exclamation-circle mt-0.5 text-rose-600" />
                  <p className="text-sm text-rose-800">{error}</p>
                </div>
              </div>
            )}
          </div>

          <div className="shrink-0 border-t border-neutral-200 bg-white">
            <div className="px-6 pb-4 pt-4">
              <button
                type="button"
                onClick={handlePayNow}
                disabled={loading}
                className="mb-4 w-full rounded-xl bg-neutral-900 px-6 py-4 font-bold text-white transition-all hover:bg-neutral-800 hover:shadow-lg disabled:cursor-not-allowed disabled:opacity-50"
              >
                {loading ? (
                  <>
                    <i className="fas fa-circle-notch fa-spin mr-2" />
                    Redirecting to payment...
                  </>
                ) : (
                  <>
                    <i className="fas fa-credit-card mr-2" />
                    Complete Payment & Continue
                  </>
                )}
              </button>

              <div className="flex items-center justify-between text-sm">
                <button
                  type="button"
                  onClick={handleLogout}
                  className="text-neutral-500 transition-colors hover:text-neutral-700"
                >
                  <i className="fas fa-sign-out-alt mr-1" />
                  Log out
                </button>
                <a
                  href="mailto:support@bmspros.com.au"
                  className="text-neutral-600 transition-colors hover:text-neutral-800"
                >
                  <i className="fas fa-envelope mr-1" />
                  Contact Support
                </a>
              </div>
            </div>

            <div className="border-t border-neutral-200 bg-neutral-50 px-6 py-4">
              <div className="flex items-center justify-center gap-4 text-xs text-neutral-500">
                <div className="flex items-center gap-1">
                  <i className="fas fa-lock text-emerald-500" />
                  <span>Secure Payment</span>
                </div>
                <div className="flex items-center gap-1">
                  <i className="fab fa-stripe text-indigo-500" />
                  <span>Powered by Stripe</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Free trial / pending payment view
  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center overflow-y-auto p-4 py-6 md:py-14 md:px-8">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />

      <div className="relative my-auto flex max-h-[calc(100dvh-3rem)] w-full max-w-md shrink-0 flex-col overflow-hidden rounded-2xl bg-white shadow-2xl md:max-h-[calc(100dvh-7rem)]">
        <div
          className={`shrink-0 p-6 text-center text-white ${
            hasFreeTrial
              ? "bg-gradient-to-r from-emerald-500 via-teal-500 to-cyan-500"
              : "bg-gradient-to-r from-amber-500 via-orange-500 to-rose-500"
          }`}
        >
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-white/20 backdrop-blur">
            <i className={`fas ${hasFreeTrial ? "fa-gift" : "fa-lock"} text-3xl`} />
          </div>
          <h2 className="mb-2 text-2xl font-bold">
            {hasFreeTrial ? "Start Your Free Trial" : "Payment Required"}
          </h2>
          <p className="text-sm text-white/90">
            {hasFreeTrial
              ? `Enter payment details to start your ${trialDays}-day free trial`
              : "Complete your subscription to access the dashboard"}
          </p>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-6">
          {planName && (
            <div className="mb-6 rounded-xl border border-neutral-200 bg-gradient-to-r from-neutral-50 to-neutral-100 p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="mb-1 text-xs uppercase tracking-wide text-neutral-500">
                    Selected Plan
                  </p>
                  <p className="text-lg font-bold text-neutral-900">{planName}</p>
                </div>
                {planPrice && (
                  <div className="text-right">
                    <p className="text-2xl font-bold text-neutral-900">{planPrice}</p>
                  </div>
                )}
              </div>
              {hasFreeTrial && (
                <div className="mt-3 border-t border-neutral-200 pt-3">
                  <div className="flex items-center gap-2 text-emerald-600">
                    <i className="fas fa-check-circle" />
                    <span className="text-sm font-medium">{trialDays}-day free trial included</span>
                  </div>
                </div>
              )}
            </div>
          )}

          <div
            className={`mb-6 rounded-xl p-4 ${
              hasFreeTrial
                ? "border border-emerald-200 bg-emerald-50"
                : "border border-amber-200 bg-amber-50"
            }`}
          >
            <div className="flex items-start gap-3">
              <i
                className={`fas fa-info-circle mt-0.5 ${
                  hasFreeTrial ? "text-emerald-600" : "text-amber-600"
                }`}
              />
              <div>
                {hasFreeTrial ? (
                  <>
                    <p className="mb-1 text-sm font-medium text-emerald-800">
                      No charge during your trial
                    </p>
                    <p className="text-sm text-emerald-700">
                      We need your payment details to start the trial. You won&apos;t be charged until day{" "}
                      {trialDays! + 1}. Cancel anytime before then.
                    </p>
                  </>
                ) : (
                  <>
                    <p className="mb-1 text-sm font-medium text-amber-800">
                      Your account is pending activation
                    </p>
                    <p className="text-sm text-amber-700">
                      To access all features and start managing your workshop, please complete your subscription
                      payment.
                    </p>
                  </>
                )}
              </div>
            </div>
          </div>

          {error && (
            <div className="rounded-xl border border-rose-200 bg-rose-50 p-4">
              <div className="flex items-start gap-3">
                <i className="fas fa-exclamation-circle mt-0.5 text-rose-600" />
                <p className="text-sm text-rose-800">{error}</p>
              </div>
            </div>
          )}
        </div>

        <div className="shrink-0 border-t border-neutral-200 bg-white">
          <div className="px-6 pb-4 pt-4">
            <button
              type="button"
              onClick={handlePayNow}
              disabled={loading}
              className="mb-4 w-full rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 px-6 py-4 font-bold text-white transition-all hover:from-emerald-600 hover:to-teal-600 hover:shadow-lg disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? (
                <>
                  <i className="fas fa-circle-notch fa-spin mr-2" />
                  Redirecting to checkout...
                </>
              ) : hasFreeTrial ? (
                <>
                  <i className="fas fa-gift mr-2" />
                  Start {trialDays}-Day Free Trial
                </>
              ) : (
                <>
                  <i className="fas fa-credit-card mr-2" />
                  Pay Now & Activate Account
                </>
              )}
            </button>

            <div className="flex items-center justify-between text-sm">
              <button
                type="button"
                onClick={handleLogout}
                className="text-neutral-500 transition-colors hover:text-neutral-700"
              >
                <i className="fas fa-sign-out-alt mr-1" />
                Log out
              </button>
              <a
                href="mailto:support@bmspros.com.au"
                className="text-neutral-600 transition-colors hover:text-neutral-800"
              >
                <i className="fas fa-envelope mr-1" />
                Contact Support
              </a>
            </div>
          </div>

          <div className="border-t border-neutral-200 bg-neutral-50 px-6 py-4">
            <div className="flex items-center justify-center gap-4 text-xs text-neutral-500">
              <div className="flex items-center gap-1">
                <i className="fas fa-lock text-emerald-500" />
                <span>Secure Payment</span>
              </div>
              <div className="flex items-center gap-1">
                <i className="fab fa-stripe text-indigo-500" />
                <span>Powered by Stripe</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
