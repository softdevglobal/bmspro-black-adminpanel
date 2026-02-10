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
  const hasFreeTrial = !isTrialExpired && trialDays && trialDays > 0;

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

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />

      {/* Modal */}
      <div className="relative bg-white rounded-2xl shadow-2xl max-w-md w-full mx-4 overflow-hidden">
        {/* Header */}
        <div className={`p-6 text-white text-center ${
          isTrialExpired
            ? 'bg-gradient-to-r from-rose-500 via-pink-500 to-rose-600'
            : hasFreeTrial 
              ? 'bg-gradient-to-r from-emerald-500 via-teal-500 to-cyan-500' 
              : 'bg-gradient-to-r from-amber-500 via-orange-500 to-rose-500'
        }`}>
          <div className="w-16 h-16 bg-white/20 backdrop-blur rounded-full flex items-center justify-center mx-auto mb-4">
            <i className={`fas ${isTrialExpired ? 'fa-clock' : hasFreeTrial ? 'fa-gift' : 'fa-lock'} text-3xl`} />
          </div>
          <h2 className="text-2xl font-bold mb-2">
            {isTrialExpired 
              ? 'Your Free Trial Has Ended'
              : hasFreeTrial 
                ? 'Start Your Free Trial' 
                : 'Payment Required'
            }
          </h2>
          <p className="text-white/90 text-sm">
            {isTrialExpired
              ? 'Subscribe now to continue using BMS Pro'
              : hasFreeTrial 
                ? `Enter payment details to start your ${trialDays}-day free trial`
                : 'Complete your subscription to access the dashboard'
            }
          </p>
        </div>

        {/* Content */}
        <div className="p-6">
          {/* Plan Info */}
          {planName && (
            <div className="bg-gradient-to-r from-slate-50 to-slate-100 rounded-xl p-4 mb-6 border border-slate-200">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs text-slate-500 uppercase tracking-wide mb-1">
                    Selected Plan
                  </p>
                  <p className="text-lg font-bold text-slate-900">{planName}</p>
                </div>
                {planPrice && (
                  <div className="text-right">
                    <p className="text-2xl font-bold text-pink-600">{planPrice}</p>
                  </div>
                )}
              </div>
              {hasFreeTrial && (
                <div className="mt-3 pt-3 border-t border-slate-200">
                  <div className="flex items-center gap-2 text-emerald-600">
                    <i className="fas fa-check-circle" />
                    <span className="text-sm font-medium">{trialDays}-day free trial included</span>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Message */}
          <div className={`rounded-xl p-4 mb-6 ${
            isTrialExpired 
              ? 'bg-rose-50 border border-rose-200' 
              : hasFreeTrial 
                ? 'bg-emerald-50 border border-emerald-200' 
                : 'bg-amber-50 border border-amber-200'
          }`}>
            <div className="flex items-start gap-3">
              <i className={`fas ${isTrialExpired ? 'fa-exclamation-triangle' : 'fa-info-circle'} mt-0.5 ${
                isTrialExpired ? 'text-rose-600' : hasFreeTrial ? 'text-emerald-600' : 'text-amber-600'
              }`} />
              <div>
                {isTrialExpired ? (
                  <>
                    <p className="text-sm text-rose-800 font-medium mb-1">
                      Your free trial period has expired
                    </p>
                    <p className="text-sm text-rose-700">
                      To continue using BMS Pro and access all features, please subscribe to a plan. Your data is safe and will be available once you subscribe.
                    </p>
                  </>
                ) : hasFreeTrial ? (
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
                      To access all features and start managing your salon, please
                      complete your subscription payment.
                    </p>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Error Message */}
          {error && (
            <div className="bg-rose-50 border border-rose-200 rounded-xl p-4 mb-6">
              <div className="flex items-start gap-3">
                <i className="fas fa-exclamation-circle text-rose-600 mt-0.5" />
                <p className="text-sm text-rose-800">{error}</p>
              </div>
            </div>
          )}

          {/* Pay Button */}
          <button
            onClick={handlePayNow}
            disabled={loading}
            className={`w-full py-4 px-6 text-white font-bold rounded-xl hover:shadow-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed mb-4 ${
              isTrialExpired
                ? 'bg-gradient-to-r from-pink-500 to-rose-500'
                : 'bg-gradient-to-r from-emerald-500 to-teal-500'
            }`}
          >
            {loading ? (
              <>
                <i className="fas fa-circle-notch fa-spin mr-2" />
                Redirecting to checkout...
              </>
            ) : isTrialExpired ? (
              <>
                <i className="fas fa-rocket mr-2" />
                Subscribe Now
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

          {/* Secondary Actions */}
          <div className="flex items-center justify-between text-sm">
            <button
              onClick={handleLogout}
              className="text-slate-500 hover:text-slate-700 transition-colors"
            >
              <i className="fas fa-sign-out-alt mr-1" />
              Log out
            </button>
            <a
              href="mailto:support@bmspros.com.au"
              className="text-pink-600 hover:text-pink-700 transition-colors"
            >
              <i className="fas fa-envelope mr-1" />
              Contact Support
            </a>
          </div>
        </div>

        {/* Footer */}
        <div className="bg-slate-50 px-6 py-4 border-t border-slate-200">
          <div className="flex items-center justify-center gap-4 text-xs text-slate-500">
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
