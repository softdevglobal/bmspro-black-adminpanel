"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { auth, db } from "@/lib/firebase";
import { doc, getDoc, onSnapshot } from "firebase/firestore";
import { onAuthStateChanged } from "firebase/auth";

interface TrialInfo {
  isTrialing: boolean;
  daysRemaining: number;
  trialEndDate: Date | null;
  showWarning: boolean; // Show warning when 2 days or less remaining
  isExpired: boolean;
}

export default function TrialWarningBanner() {
  const router = useRouter();
  const [trialInfo, setTrialInfo] = useState<TrialInfo>({
    isTrialing: false,
    daysRemaining: 0,
    trialEndDate: null,
    showWarning: false,
    isExpired: false,
  });
  const [dismissed, setDismissed] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let unsubUser: (() => void) | null = null;

    const unsubAuth = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        setLoading(false);
        return;
      }

      try {
        // First check if user is super_admin (they don't have trials)
        const superAdminDoc = await getDoc(doc(db, "super_admins", user.uid));
        if (superAdminDoc.exists()) {
          setLoading(false);
          return;
        }

        // Get user data and listen for changes
        unsubUser = onSnapshot(
          doc(db, "users", user.uid),
          (docSnap) => {
            if (!docSnap.exists()) {
              setLoading(false);
              return;
            }

            const userData = docSnap.data();
            const role = userData?.role || "";

            // Only salon_owner has trial status
            if (role !== "salon_owner") {
              // For branch admins, check owner's trial status
              if (role === "salon_branch_admin" && userData?.ownerUid) {
                checkOwnerTrialStatus(userData.ownerUid);
              } else {
                setLoading(false);
              }
              return;
            }

            // Check trial status
            const accountStatus = userData?.accountStatus || "";
            const subscriptionStatus = userData?.subscriptionStatus || "";
            const hasStripeSubscription = !!userData?.stripeSubscriptionId;

            // User is in active trial without Stripe subscription
            const isTrialing =
              (accountStatus === "active_trial" || subscriptionStatus === "trialing") &&
              !hasStripeSubscription;

            if (!isTrialing) {
              setTrialInfo({
                isTrialing: false,
                daysRemaining: 0,
                trialEndDate: null,
                showWarning: false,
                isExpired: false,
              });
              setLoading(false);
              return;
            }

            // Calculate days remaining
            let trialEnd: Date | null = null;
            if (userData?.trial_end) {
              trialEnd = userData.trial_end.toDate
                ? userData.trial_end.toDate()
                : new Date(userData.trial_end);
            }

            if (!trialEnd) {
              setLoading(false);
              return;
            }

            const now = new Date();
            const diffMs = trialEnd.getTime() - now.getTime();
            const daysRemaining = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
            const isExpired = daysRemaining <= 0;
            const showWarning = daysRemaining <= 2 && !isExpired;

            setTrialInfo({
              isTrialing: true,
              daysRemaining: Math.max(0, daysRemaining),
              trialEndDate: trialEnd,
              showWarning,
              isExpired,
            });
            setLoading(false);
          },
          (error) => {
            console.error("Error watching user document:", error);
            setLoading(false);
          }
        );
      } catch (error) {
        console.error("Error checking trial status:", error);
        setLoading(false);
      }
    });

    const checkOwnerTrialStatus = async (ownerUid: string) => {
      try {
        const ownerDoc = await getDoc(doc(db, "users", ownerUid));
        if (!ownerDoc.exists()) {
          setLoading(false);
          return;
        }

        const ownerData = ownerDoc.data();
        const accountStatus = ownerData?.accountStatus || "";
        const subscriptionStatus = ownerData?.subscriptionStatus || "";
        const hasStripeSubscription = !!ownerData?.stripeSubscriptionId;

        const isTrialing =
          (accountStatus === "active_trial" || subscriptionStatus === "trialing") &&
          !hasStripeSubscription;

        if (!isTrialing) {
          setLoading(false);
          return;
        }

        let trialEnd: Date | null = null;
        if (ownerData?.trial_end) {
          trialEnd = ownerData.trial_end.toDate
            ? ownerData.trial_end.toDate()
            : new Date(ownerData.trial_end);
        }

        if (!trialEnd) {
          setLoading(false);
          return;
        }

        const now = new Date();
        const diffMs = trialEnd.getTime() - now.getTime();
        const daysRemaining = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
        const isExpired = daysRemaining <= 0;
        const showWarning = daysRemaining <= 2 && !isExpired;

        setTrialInfo({
          isTrialing: true,
          daysRemaining: Math.max(0, daysRemaining),
          trialEndDate: trialEnd,
          showWarning,
          isExpired,
        });
        setLoading(false);
      } catch (error) {
        console.error("Error checking owner trial status:", error);
        setLoading(false);
      }
    };

    return () => {
      unsubAuth();
      if (unsubUser) unsubUser();
    };
  }, []);

  // Don't show if loading, not trialing, no warning needed, or dismissed
  if (loading || !trialInfo.isTrialing || !trialInfo.showWarning || dismissed) {
    return null;
  }

  const formatDate = (date: Date) => {
    return date.toLocaleDateString("en-AU", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    });
  };

  return (
    <div className="fixed top-0 left-0 right-0 z-[100] bg-gradient-to-r from-amber-500 via-orange-500 to-red-500 text-white shadow-lg">
      <div className="max-w-7xl mx-auto px-4 py-3">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center flex-shrink-0">
              <i className="fas fa-exclamation-triangle text-lg" />
            </div>
            <div>
              <p className="font-bold text-sm sm:text-base">
                {trialInfo.daysRemaining === 0
                  ? "Your free trial ends today!"
                  : trialInfo.daysRemaining === 1
                  ? "Your free trial ends tomorrow!"
                  : `Your free trial ends in ${trialInfo.daysRemaining} days!`}
              </p>
              <p className="text-xs sm:text-sm text-white/90">
                {trialInfo.trialEndDate && (
                  <>Trial expires on {formatDate(trialInfo.trialEndDate)}. </>
                )}
                Add payment details to continue using the platform without interruption.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              onClick={() => router.push("/subscription")}
              className="px-4 py-2 bg-white text-orange-600 rounded-lg font-semibold text-sm hover:bg-orange-50 transition-colors shadow-md"
            >
              <i className="fas fa-credit-card mr-2" />
              Add Payment
            </button>
            <button
              onClick={() => setDismissed(true)}
              className="p-2 hover:bg-white/20 rounded-lg transition-colors"
              title="Dismiss for now"
            >
              <i className="fas fa-times" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
