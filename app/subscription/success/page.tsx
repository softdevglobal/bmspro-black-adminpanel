"use client";
import React, { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { onAuthStateChanged } from "firebase/auth";
import { auth } from "@/lib/firebase";

export default function SubscriptionSuccessPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const sessionId = searchParams.get("session_id");
  const [countdown, setCountdown] = useState(3);
  const [verifying, setVerifying] = useState(true);
  const [verified, setVerified] = useState(false);
  const [isTrialing, setIsTrialing] = useState(false);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        router.replace("/login");
        return;
      }

      // Verify the session and update user status
      if (sessionId) {
        try {
          const token = await user.getIdToken();
          const response = await fetch("/api/stripe/verify-session", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${token}`,
            },
            body: JSON.stringify({ sessionId }),
          });

          const data = await response.json();
          
          if (response.ok && data.success) {
            setVerified(true);
            setIsTrialing(data.isTrialing || false);
          } else {
            console.error("Verification error:", data.error);
            setVerified(true);
          }
        } catch (err) {
          console.error("Error verifying session:", err);
          setVerified(true);
        }
      } else {
        setVerified(true);
      }
      
      setVerifying(false);
    });
    return () => unsub();
  }, [router, sessionId]);

  useEffect(() => {
    if (verifying || !verified) return;
    
    const timer = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          // Use setTimeout to avoid calling router during render
          setTimeout(() => {
            router.push("/dashboard");
          }, 0);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [router, verifying, verified]);

  if (verifying) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-emerald-50 via-teal-50 to-cyan-50 flex items-center justify-center p-4">
        <div className="text-center">
          <div className="w-16 h-16 bg-emerald-100 rounded-full flex items-center justify-center mx-auto mb-4 animate-pulse">
            <i className="fas fa-circle-notch fa-spin text-2xl text-emerald-600" />
          </div>
          <p className="text-slate-600">Verifying...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-emerald-50 via-teal-50 to-cyan-50 flex items-center justify-center p-4">
      <div className="max-w-md w-full">
        <div className="bg-white rounded-2xl shadow-2xl overflow-hidden">
          {/* Success Header - Compact */}
          <div className="bg-gradient-to-r from-emerald-500 via-teal-500 to-cyan-500 p-6 text-center">
            <div className="w-16 h-16 bg-white/20 backdrop-blur rounded-full flex items-center justify-center mx-auto mb-3">
              <i className="fas fa-check text-3xl text-white" />
            </div>
            <h1 className="text-xl font-bold text-white mb-1">
              {isTrialing ? "Trial Started!" : "Success!"}
            </h1>
            <p className="text-sm text-white/90">
              {isTrialing ? "Free trial activated" : "Subscription activated"}
            </p>
          </div>

          {/* Content - Compact */}
          <div className="p-6 text-center">
            <div className="mb-4">
              <div className="w-12 h-12 bg-emerald-100 rounded-full flex items-center justify-center mx-auto mb-3">
                <i className={`fas ${isTrialing ? 'fa-gift' : 'fa-crown'} text-xl text-emerald-600`} />
              </div>
              <h2 className="text-lg font-bold text-slate-900 mb-1">
                {isTrialing ? "Welcome!" : "All Set!"}
              </h2>
              <p className="text-sm text-slate-600">
                {isTrialing 
                  ? "Full access during trial. No charge until trial ends."
                  : "You have full access to all features."
                }
              </p>
            </div>

            {isTrialing && (
              <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 mb-4">
                <p className="text-xs text-emerald-700">
                  <i className="fas fa-info-circle mr-1" />
                  Card charged when trial ends
                </p>
              </div>
            )}

            <div className="space-y-2 mb-4">
              <button
                onClick={() => router.push("/dashboard")}
                className="w-full py-2.5 px-4 bg-gradient-to-r from-emerald-500 to-teal-500 text-white font-semibold rounded-lg hover:shadow-lg transition-all text-sm"
              >
                <i className="fas fa-home mr-2" />
                Go to Dashboard
              </button>
            </div>

            <p className="text-xs text-slate-500">
              Redirecting in {countdown} seconds...
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
