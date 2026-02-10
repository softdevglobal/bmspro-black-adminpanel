"use client";
import React, { useEffect } from "react";
import { useRouter } from "next/navigation";
import { onAuthStateChanged } from "firebase/auth";
import { auth } from "@/lib/firebase";

export default function SubscriptionCancelPage() {
  const router = useRouter();

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (user) => {
      if (!user) {
        router.replace("/login");
      }
    });
    return () => unsub();
  }, [router]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-slate-100 to-slate-50 flex items-center justify-center p-4">
      <div className="max-w-md w-full">
        <div className="bg-white rounded-3xl shadow-2xl overflow-hidden">
          {/* Header */}
          <div className="bg-gradient-to-r from-slate-600 via-slate-700 to-slate-800 p-8 text-center">
            <div className="w-20 h-20 bg-white/20 backdrop-blur rounded-full flex items-center justify-center mx-auto mb-4">
              <i className="fas fa-times text-4xl text-white" />
            </div>
            <h1 className="text-2xl font-bold text-white mb-2">Payment Cancelled</h1>
            <p className="text-white/90">Your subscription was not completed</p>
          </div>

          {/* Content */}
          <div className="p-8 text-center">
            <div className="mb-6">
              <div className="w-16 h-16 bg-amber-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <i className="fas fa-info-circle text-2xl text-amber-600" />
              </div>
              <h2 className="text-xl font-bold text-slate-900 mb-2">No Worries!</h2>
              <p className="text-slate-600">
                You can always come back and subscribe later. Your account data is safe.
              </p>
            </div>

            <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-6">
              <div className="flex items-start gap-3">
                <i className="fas fa-lightbulb text-amber-600 mt-0.5" />
                <div className="text-left">
                  <p className="text-sm text-amber-800 font-medium mb-1">Need help deciding?</p>
                  <p className="text-sm text-amber-700">
                    Contact our support team if you have questions about our subscription plans.
                  </p>
                </div>
              </div>
            </div>

            <div className="space-y-3">
              <button
                onClick={() => router.push("/subscription")}
                className="w-full py-3 px-6 bg-gradient-to-r from-pink-500 to-fuchsia-500 text-white font-semibold rounded-xl hover:shadow-lg transition-all"
              >
                <i className="fas fa-arrow-left mr-2" />
                Back to Subscription Plans
              </button>
              <button
                onClick={() => router.push("/dashboard")}
                className="w-full py-3 px-6 border border-slate-200 text-slate-700 font-semibold rounded-xl hover:bg-slate-50 transition-all"
              >
                <i className="fas fa-home mr-2" />
                Go to Dashboard
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
