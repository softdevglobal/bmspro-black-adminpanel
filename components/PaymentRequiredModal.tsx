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

        <div className="relative my-auto max-h-[calc(100dvh-3rem)] w-full max-w-md shrink-0 overflow-x-hidden overflow-y-auto rounded-2xl bg-white shadow-2xl md:max-h-[calc(100dvh-7rem)]">
          <div className="bg-neutral-900 p-6 text-white text-center">
            <div className="w-16 h-16 bg-white/20 backdrop-blur rounded-full flex items-center justify-center mx-auto mb-4">
              <i className="fas fa-hourglass-end text-3xl" />
            </div>
            <h2 className="text-2xl font-bold mb-2">Your Trial Has Ended</h2>
            <p className="text-white/90 text-sm">
              Complete your payment to continue using BMS Pro
            </p>
          </div>

          <div className="p-6">
            {planName && (
              <div className="bg-gradient-to-br from-neutral-50 to-neutral-100 rounded-xl p-5 mb-5 border border-neutral-200 relative overflow-hidden">
                <div className="absolute top-0 right-0 bg-neutral-900 text-white text-[10px] font-bold px-3 py-1 rounded-bl-lg uppercase tracking-wider">
                  Your Plan
                </div>
                <div className="flex items-center justify-between mt-2">
                  <div>
                    <p className="text-xs text-neutral-500 uppercase tracking-wide font-semibold mb-1">
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

            <div className="bg-neutral-50 rounded-xl p-4 mb-5 border border-neutral-200">
              <p className="text-sm font-semibold text-neutral-800 mb-3">
                <i className="fas fa-arrow-right text-neutral-500 mr-2" />
                What happens next?
              </p>
              <div className="space-y-2.5">
                <div className="flex items-start gap-2.5">
                  <div className="w-5 h-5 rounded-full bg-neutral-200 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <span className="text-[10px] font-bold text-neutral-700">1</span>
                  </div>
                  <p className="text-sm text-neutral-600">You&apos;ll be redirected to a secure payment page</p>
                </div>
                <div className="flex items-start gap-2.5">
                  <div className="w-5 h-5 rounded-full bg-neutral-200 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <span className="text-[10px] font-bold text-neutral-700">2</span>
                  </div>
                  <p className="text-sm text-neutral-600">Enter your payment details to activate your subscription</p>
                </div>
                <div className="flex items-start gap-2.5">
                  <div className="w-5 h-5 rounded-full bg-neutral-200 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <span className="text-[10px] font-bold text-neutral-700">3</span>
                  </div>
                  <p className="text-sm text-neutral-600">Your account will be reactivated instantly</p>
                </div>
              </div>
            </div>

            <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 mb-5">
              <div className="flex items-start gap-3">
                <i className="fas fa-shield-alt text-emerald-600 mt-0.5" />
                <p className="text-sm text-emerald-700">
                  <span className="font-medium">Your data is safe.</span> All your workshop data, bookings, and settings are preserved and will be fully accessible once you subscribe.
                </p>
              </div>
            </div>

            {error && (
              <div className="bg-rose-50 border border-rose-200 rounded-xl p-4 mb-5">
                <div className="flex items-start gap-3">
                  <i className="fas fa-exclamation-circle text-rose-600 mt-0.5" />
                  <p className="text-sm text-rose-800">{error}</p>
                </div>
              </div>
            )}

            <button
              onClick={handlePayNow}
              disabled={loading}
              className="w-full py-4 px-6 text-white font-bold rounded-xl hover:shadow-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed mb-4 bg-neutral-900 hover:bg-neutral-800"
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
                onClick={handleLogout}
                className="text-neutral-500 hover:text-neutral-700 transition-colors"
              >
                <i className="fas fa-sign-out-alt mr-1" />
                Log out
              </button>
              <a
                href="mailto:support@bmspros.com.au"
                className="text-neutral-600 hover:text-neutral-800 transition-colors"
              >
                <i className="fas fa-envelope mr-1" />
                Contact Support
              </a>
            </div>
          </div>

          <div className="bg-neutral-50 px-6 py-4 border-t border-neutral-200">
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
    );
  }

  // Free trial / pending payment view
  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center overflow-y-auto p-4 py-6 md:py-14 md:px-8">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />

      <div className="relative my-auto max-h-[calc(100dvh-3rem)] w-full max-w-md shrink-0 overflow-x-hidden overflow-y-auto rounded-2xl bg-white shadow-2xl md:max-h-[calc(100dvh-7rem)]">
        <div className={`p-6 text-white text-center ${
          hasFreeTrial 
            ? 'bg-gradient-to-r from-emerald-500 via-teal-500 to-cyan-500' 
            : 'bg-gradient-to-r from-amber-500 via-orange-500 to-rose-500'
        }`}>
          <div className="w-16 h-16 bg-white/20 backdrop-blur rounded-full flex items-center justify-center mx-auto mb-4">
            <i className={`fas ${hasFreeTrial ? 'fa-gift' : 'fa-lock'} text-3xl`} />
          </div>
          <h2 className="text-2xl font-bold mb-2">
            {hasFreeTrial 
              ? 'Start Your Free Trial' 
              : 'Payment Required'
            }
          </h2>
          <p className="text-white/90 text-sm">
            {hasFreeTrial 
              ? `Enter payment details to start your ${trialDays}-day free trial`
              : 'Complete your subscription to access the dashboard'
            }
          </p>
        </div>

        <div className="p-6">
          {planName && (
            <div className="bg-gradient-to-r from-neutral-50 to-neutral-100 rounded-xl p-4 mb-6 border border-neutral-200">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs text-neutral-500 uppercase tracking-wide mb-1">
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
                <div className="mt-3 pt-3 border-t border-neutral-200">
                  <div className="flex items-center gap-2 text-emerald-600">
                    <i className="fas fa-check-circle" />
                    <span className="text-sm font-medium">{trialDays}-day free trial included</span>
                  </div>
                </div>
              )}
            </div>
          )}

          <div className={`rounded-xl p-4 mb-6 ${
            hasFreeTrial 
              ? 'bg-emerald-50 border border-emerald-200' 
              : 'bg-amber-50 border border-amber-200'
          }`}>
            <div className="flex items-start gap-3">
              <i className={`fas fa-info-circle mt-0.5 ${
                hasFreeTrial ? 'text-emerald-600' : 'text-amber-600'
              }`} />
              <div>
                {hasFreeTrial ? (
                  <>
                    <p className="text-sm text-emerald-800 font-medium mb-1">
                      No charge during your trial
                    </p>
                    <p className="text-sm text-emerald-700">
                      We need your payment details to start the trial. You won&apos;t be charged until day {trialDays! + 1}. Cancel anytime before then.
                    </p>
                  </>
                ) : (
                  <>
                    <p className="text-sm text-amber-800 font-medium mb-1">
                      Your account is pending activation
                    </p>
                    <p className="text-sm text-amber-700">
                      To access all features and start managing your workshop, please
                      complete your subscription payment.
                    </p>
                  </>
                )}
              </div>
            </div>
          </div>

          {error && (
            <div className="bg-rose-50 border border-rose-200 rounded-xl p-4 mb-6">
              <div className="flex items-start gap-3">
                <i className="fas fa-exclamation-circle text-rose-600 mt-0.5" />
                <p className="text-sm text-rose-800">{error}</p>
              </div>
            </div>
          )}

          <button
            onClick={handlePayNow}
            disabled={loading}
            className="w-full py-4 px-6 text-white font-bold rounded-xl hover:shadow-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed mb-4 bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-600 hover:to-teal-600"
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
              onClick={handleLogout}
              className="text-neutral-500 hover:text-neutral-700 transition-colors"
            >
              <i className="fas fa-sign-out-alt mr-1" />
              Log out
            </button>
            <a
              href="mailto:support@bmspros.com.au"
              className="text-neutral-600 hover:text-neutral-800 transition-colors"
            >
              <i className="fas fa-envelope mr-1" />
              Contact Support
            </a>
          </div>
        </div>

        <div className="bg-neutral-50 px-6 py-4 border-t border-neutral-200">
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
  );
}
