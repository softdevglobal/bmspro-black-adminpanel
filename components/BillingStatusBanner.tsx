"use client";
import React from "react";
import { useRouter } from "next/navigation";

interface BillingStatusBannerProps {
  billingStatus: string;
  graceUntil?: string | null;
  nextBillingDate?: string | null;
  trialDays?: number;
  onUpdatePayment: () => void;
}

export default function BillingStatusBanner({
  billingStatus,
  graceUntil,
  nextBillingDate,
  trialDays,
  onUpdatePayment,
}: BillingStatusBannerProps) {
  const router = useRouter();

  if (billingStatus === "past_due") {
    const graceDate = graceUntil ? new Date(graceUntil).toLocaleDateString() : "soon";
    const isGraceExpired = graceUntil ? new Date() > new Date(graceUntil) : false;

    return (
      <div className={`mb-6 rounded-2xl border overflow-hidden ${
        isGraceExpired
          ? "border-red-300 bg-white"
          : "border-amber-300 bg-white"
      }`}>
        <div className={`px-6 py-4 ${
          isGraceExpired ? "bg-red-600" : "bg-amber-500"
        } text-white`}>
          <div className="flex items-center gap-3">
            <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${
              isGraceExpired ? "bg-white/20" : "bg-white/20"
            }`}>
              <i className={`fas ${isGraceExpired ? "fa-exclamation-triangle" : "fa-clock"} text-lg`} />
            </div>
            <div>
              <h3 className="font-bold text-lg">
                {isGraceExpired ? "Account Suspension Imminent" : "Payment Required"}
              </h3>
              <p className="text-sm text-white/80">
                {isGraceExpired
                  ? "Your grace period has expired"
                  : `Update payment by ${graceDate}`
                }
              </p>
            </div>
          </div>
        </div>
        <div className="p-5">
          <p className={`text-sm mb-4 ${
            isGraceExpired ? "text-red-700" : "text-amber-700"
          }`}>
            {isGraceExpired
              ? "Please update your payment method immediately to avoid account suspension."
              : `Payment failed. Update your payment method by ${graceDate} to avoid account suspension.`
            }
          </p>
          <button
            onClick={onUpdatePayment}
            className={`px-5 py-2.5 rounded-xl font-semibold text-sm transition-colors ${
              isGraceExpired
                ? "bg-red-600 text-white hover:bg-red-700"
                : "bg-amber-500 text-white hover:bg-amber-600"
            }`}
          >
            <i className="fas fa-credit-card mr-2" />
            Update Payment Method
          </button>
        </div>
      </div>
    );
  }

  if (billingStatus === "suspended" || billingStatus === "cancelled") {
    return (
      <div className="mb-6 rounded-2xl border border-red-300 bg-white overflow-hidden">
        <div className="px-6 py-4 bg-neutral-900 text-white">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-red-500/20 border border-red-500/30 flex items-center justify-center">
              <i className="fas fa-lock text-red-400 text-lg" />
            </div>
            <div>
              <h3 className="font-bold text-lg">
                Account {billingStatus === "suspended" ? "Suspended" : "Cancelled"}
              </h3>
              <p className="text-sm text-neutral-400">
                {billingStatus === "suspended" ? "Action required to restore access" : "Your subscription has ended"}
              </p>
            </div>
          </div>
        </div>
        <div className="p-5">
          <p className="text-sm text-neutral-600 mb-4">
            {billingStatus === "suspended"
              ? "Your account has been suspended due to payment failure. Please update your payment method to restore access."
              : "Your subscription has been cancelled. You can reactivate by subscribing to a plan."}
          </p>
          <button
            onClick={onUpdatePayment}
            className="px-5 py-2.5 bg-neutral-900 text-white rounded-xl font-semibold text-sm hover:bg-neutral-800 transition-colors"
          >
            <i className="fas fa-credit-card mr-2 text-amber-400" />
            {billingStatus === "suspended" ? "Update Payment & Restore" : "Subscribe to Plan"}
          </button>
        </div>
      </div>
    );
  }

  if (billingStatus === "trialing") {
    const days = trialDays && trialDays > 0 ? trialDays : 28;
    return (
      <div className="mb-6 rounded-2xl border border-neutral-200 bg-white overflow-hidden">
        <div className="px-6 py-4 bg-neutral-900 text-white">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-amber-500/20 border border-amber-500/30 flex items-center justify-center">
              <i className="fas fa-gift text-amber-400 text-lg" />
            </div>
            <div>
              <h3 className="font-bold text-lg">Free Trial Active</h3>
              <p className="text-sm text-neutral-400">
                You&apos;re currently on a {days}-day free trial. Your subscription will begin automatically after the trial ends.
                {nextBillingDate && ` Trial ends on ${new Date(nextBillingDate).toLocaleDateString()}.`}
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return null;
}
