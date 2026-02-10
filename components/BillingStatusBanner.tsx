"use client";
import React from "react";
import { useRouter } from "next/navigation";

interface BillingStatusBannerProps {
  billingStatus: string;
  graceUntil?: string | null;
  nextBillingDate?: string | null;
  onUpdatePayment: () => void;
}

export default function BillingStatusBanner({
  billingStatus,
  graceUntil,
  nextBillingDate,
  onUpdatePayment,
}: BillingStatusBannerProps) {
  const router = useRouter();

  if (billingStatus === "past_due") {
    const graceDate = graceUntil ? new Date(graceUntil).toLocaleDateString() : "soon";
    const isGraceExpired = graceUntil ? new Date() > new Date(graceUntil) : false;

    return (
      <div className={`mb-6 rounded-xl border-2 p-4 ${
        isGraceExpired
          ? "border-rose-500 bg-rose-50"
          : "border-amber-500 bg-amber-50"
      }`}>
        <div className="flex items-start gap-4">
          <div className={`flex-shrink-0 w-12 h-12 rounded-xl flex items-center justify-center ${
            isGraceExpired ? "bg-rose-500" : "bg-amber-500"
          }`}>
            <i className={`fas ${isGraceExpired ? "fa-exclamation-triangle" : "fa-clock"} text-white text-xl`} />
          </div>
          <div className="flex-1">
            <h3 className={`font-bold text-lg mb-1 ${
              isGraceExpired ? "text-rose-900" : "text-amber-900"
            }`}>
              {isGraceExpired ? "Account Suspension Imminent" : "Payment Required"}
            </h3>
            <p className={`text-sm mb-3 ${
              isGraceExpired ? "text-rose-800" : "text-amber-800"
            }`}>
              {isGraceExpired
                ? `Your grace period has expired. Please update your payment method immediately to avoid account suspension.`
                : `Payment failed. Update your payment method by ${graceDate} to avoid account suspension.`
              }
            </p>
            <button
              onClick={onUpdatePayment}
              className={`px-4 py-2 rounded-lg font-semibold text-sm transition-colors ${
                isGraceExpired
                  ? "bg-rose-600 text-white hover:bg-rose-700"
                  : "bg-amber-600 text-white hover:bg-amber-700"
              }`}
            >
              <i className="fas fa-credit-card mr-2" />
              Update Payment Method
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (billingStatus === "suspended" || billingStatus === "cancelled") {
    return (
      <div className="mb-6 rounded-xl border-2 border-rose-500 bg-rose-50 p-6">
        <div className="flex items-start gap-4">
          <div className="flex-shrink-0 w-12 h-12 rounded-xl bg-rose-500 flex items-center justify-center">
            <i className="fas fa-lock text-white text-xl" />
          </div>
          <div className="flex-1">
            <h3 className="font-bold text-lg text-rose-900 mb-1">
              Account {billingStatus === "suspended" ? "Suspended" : "Cancelled"}
            </h3>
            <p className="text-sm text-rose-800 mb-4">
              {billingStatus === "suspended"
                ? "Your account has been suspended due to payment failure. Please update your payment method to restore access."
                : "Your subscription has been cancelled. You can reactivate by subscribing to a plan."}
            </p>
            <div className="flex gap-3">
              <button
                onClick={onUpdatePayment}
                className="px-4 py-2 bg-rose-600 text-white rounded-lg font-semibold text-sm hover:bg-rose-700 transition-colors"
              >
                <i className="fas fa-credit-card mr-2" />
                {billingStatus === "suspended" ? "Update Payment & Restore" : "Subscribe to Plan"}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (billingStatus === "trialing") {
    return (
      <div className="mb-6 rounded-xl border-2 border-blue-500 bg-blue-50 p-4">
        <div className="flex items-start gap-4">
          <div className="flex-shrink-0 w-12 h-12 rounded-xl bg-blue-500 flex items-center justify-center">
            <i className="fas fa-gift text-white text-xl" />
          </div>
          <div className="flex-1">
            <h3 className="font-bold text-lg text-blue-900 mb-1">Free Trial Active</h3>
            <p className="text-sm text-blue-800">
              You're currently on a 28-day free trial. Your subscription will begin automatically after the trial ends.
              {nextBillingDate && ` Trial ends on ${new Date(nextBillingDate).toLocaleDateString()}.`}
            </p>
          </div>
        </div>
      </div>
    );
  }

  return null;
}
