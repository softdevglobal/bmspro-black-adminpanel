"use client";

import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { auth, db } from "@/lib/firebase";
import { doc, getDoc } from "firebase/firestore";
import { fetchCurrentUser } from "@/lib/authClient";
import PaymentRequiredModal from "./PaymentRequiredModal";
import OwnerAccountInactiveModal from "./OwnerAccountInactiveModal";
import TrialWarningBanner from "./TrialWarningBanner";

interface AuthGuardProps {
  children: React.ReactNode;
}

// Pages that super_admin is allowed to access
const SUPER_ADMIN_ALLOWED_PAGES = ["/admin-dashboard", "/tenants", "/login", "/", "/packages", "/admin-services", "/super-admin-audit-logs"];

// Pages that don't require payment check (allow access even if pending payment)
const PAYMENT_EXEMPT_PAGES = ["/subscription", "/login", "/reset-password"];

interface PaymentInfo {
  required: boolean;
  planName?: string;
  planPrice?: string;
  planId?: string;
  trialDays?: number;
  accountStatus?: string;
}

interface OwnerAccountBlockedInfo {
  blocked: boolean;
  reason: string;
  ownerName?: string;
}

export default function AuthGuard({ children }: AuthGuardProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [loading, setLoading] = useState(true);
  const [authorized, setAuthorized] = useState(false);
  const [paymentInfo, setPaymentInfo] = useState<PaymentInfo>({ required: false });
  const [ownerBlocked, setOwnerBlocked] = useState<OwnerAccountBlockedInfo>({ blocked: false, reason: "" });

  useEffect(() => {
    const checkAuth = async () => {
      const unsub = onAuthStateChanged(auth, async (user) => {
        if (!user) {
          router.replace("/login");
          setLoading(false);
          return;
        }

        try {
          console.log("[AuthGuard] Checking user:", user.uid, user.email);
          
          // Use server API to get role (bypasses Firestore rules)
          const meData = await fetchCurrentUser();
          
          if (!meData) {
            console.error("[AuthGuard] Failed to fetch user data from API");
            router.replace("/login");
            setLoading(false);
            return;
          }

          const userRole = meData.role;
          console.log("[AuthGuard] User role:", userRole, "isSuperAdmin:", meData.isSuperAdmin);

          if (meData.isSuperAdmin) {
            // Super admin route restriction
            const isAllowedPage = pathname && SUPER_ADMIN_ALLOWED_PAGES.some(page => {
              if (page === "/") return pathname === "/" || pathname === "/admin-dashboard";
              return pathname === page || pathname.startsWith(page + "/");
            });
            
            if (!isAllowedPage) {
              router.replace("/admin-dashboard");
              setLoading(false);
              return;
            }
          }
          
          // Check if user has admin role
          const allowedRoles = ["workshop_owner", "branch_admin", "super_admin"];
          
          if (!allowedRoles.includes(userRole)) {
            await auth.signOut();
            router.replace("/login");
            setLoading(false);
            return;
          }

          // Check payment status for workshop_owner
          if (userRole === "workshop_owner" && meData) {
            const accountStatus = meData.accountStatus || "active";
            const subscriptionStatus = meData.subscriptionStatus || "active";
            
            const isCardFreeTrial = accountStatus === "active_trial" && !meData.stripeSubscriptionId;
            const isActiveTrialing = subscriptionStatus === "trialing" && meData.stripeSubscriptionId;
            
            // Check trial expiry
            let trialExpired = false;
            if ((isCardFreeTrial || isActiveTrialing) && meData.trial_end) {
              const trialEnd = typeof meData.trial_end === "object" && meData.trial_end._seconds
                ? new Date(meData.trial_end._seconds * 1000)
                : new Date(meData.trial_end);
              trialExpired = new Date() > trialEnd;
            }
            
            if (isCardFreeTrial && !trialExpired) {
              setPaymentInfo({ required: false });
              setOwnerBlocked({ blocked: false, reason: "" });
              setAuthorized(true);
              setLoading(false);
              return;
            }
            
            const needsPayment = 
              accountStatus === "pending_payment" || 
              accountStatus === "suspended" ||
              accountStatus === "trial_expired" ||
              (subscriptionStatus === "pending" && !isActiveTrialing && !isCardFreeTrial) ||
              subscriptionStatus === "past_due" ||
              subscriptionStatus === "unpaid" ||
              (trialExpired && !meData.stripeSubscriptionId);
            
            if (needsPayment) {
              const isPaymentExemptPage = pathname && PAYMENT_EXEMPT_PAGES.some(page => 
                pathname === page || pathname.startsWith(page + "/")
              );
              const isSuccessPage = pathname?.includes("/subscription/success");
              
              if (!isPaymentExemptPage && !isSuccessPage) {
                let trialDays = meData.trialDays || 0;
                
                // If trialDays not set on user, fetch from subscription plan
                if (!trialDays && meData.planId) {
                  try {
                    const planDoc = await getDoc(doc(db, "subscription_plans", meData.planId));
                    if (planDoc.exists()) {
                      const planData = planDoc.data();
                      trialDays = planData.trialDays ? parseInt(String(planData.trialDays), 10) : 0;
                    }
                  } catch (e) {
                    console.error("[AuthGuard] Error fetching plan:", e);
                  }
                }
                
                // If trial has expired by date, treat as trial_expired even if DB not updated yet
                const effectiveAccountStatus = trialExpired ? "trial_expired" : accountStatus;
                
                setPaymentInfo({
                  required: true,
                  planName: meData.plan || undefined,
                  planPrice: meData.price || undefined,
                  planId: meData.planId || undefined,
                  trialDays: trialDays,
                  accountStatus: effectiveAccountStatus,
                });
              } else {
                setPaymentInfo({ required: false });
              }
            } else {
              setPaymentInfo({ required: false });
            }
            setOwnerBlocked({ blocked: false, reason: "" });
          } else if (userRole === "branch_admin" && meData.ownerUid) {
            // For branch admins: Check the OWNER's account status
            console.log("[AuthGuard] Branch admin - checking owner account status");
            setPaymentInfo({ required: false });
            
            const ownerUid = meData.ownerUid;
            try {
              const ownerDoc = await getDoc(doc(db, "users", ownerUid));
              if (ownerDoc.exists()) {
                const ownerData = ownerDoc.data();
                const ownerAccountStatus = ownerData?.accountStatus || "active";
                const ownerSubscriptionStatus = ownerData?.subscriptionStatus || "active";
                const ownerName = ownerData?.displayName || ownerData?.name || ownerData?.email || "Workshop Owner";
                
                // Check if owner is in card-free trial or active trial with Stripe
                const ownerIsCardFreeTrial = ownerAccountStatus === "active_trial" && !ownerData?.stripeSubscriptionId;
                const ownerIsActiveTrialing = ownerSubscriptionStatus === "trialing" && ownerData?.stripeSubscriptionId;
                
                // Check trial expiry for owner
                let ownerTrialExpired = false;
                if ((ownerIsCardFreeTrial || ownerIsActiveTrialing) && ownerData?.trial_end) {
                  const trialEnd = ownerData.trial_end.toDate ? ownerData.trial_end.toDate() : new Date(ownerData.trial_end);
                  ownerTrialExpired = new Date() > trialEnd;
                }
                
                if (ownerIsCardFreeTrial && !ownerTrialExpired) {
                  console.log("[AuthGuard] Owner is in card-free trial period - allowing branch admin access");
                  setOwnerBlocked({ blocked: false, reason: "" });
                  setAuthorized(true);
                  setLoading(false);
                  return;
                }
                
                const ownerAccountInactive = 
                  ownerAccountStatus === "suspended" ||
                  ownerAccountStatus === "cancelled" ||
                  ownerAccountStatus === "trial_expired" ||
                  ownerSubscriptionStatus === "past_due" ||
                  ownerSubscriptionStatus === "unpaid" ||
                  ownerSubscriptionStatus === "canceled" ||
                  ownerSubscriptionStatus === "cancelled" ||
                  (ownerTrialExpired && !ownerData?.stripeSubscriptionId);
                
                if (ownerAccountInactive) {
                  let reason = "The workshop's subscription is currently inactive.";
                  
                  if (ownerAccountStatus === "suspended") {
                    reason = "The workshop's account has been suspended due to payment issues.";
                  } else if (ownerAccountStatus === "cancelled" || ownerSubscriptionStatus === "canceled" || ownerSubscriptionStatus === "cancelled") {
                    reason = "The workshop's subscription has been cancelled.";
                  } else if (ownerSubscriptionStatus === "past_due") {
                    reason = "The workshop's subscription payment is past due.";
                  } else if (ownerSubscriptionStatus === "unpaid") {
                    reason = "The workshop's subscription payment has failed.";
                  } else if (ownerTrialExpired) {
                    reason = "The workshop's free trial has expired.";
                  }
                  
                  console.log("[AuthGuard] Owner account inactive - blocking branch admin. Reason:", reason);
                  setOwnerBlocked({
                    blocked: true,
                    reason,
                    ownerName,
                  });
                } else {
                  setOwnerBlocked({ blocked: false, reason: "" });
                }
              } else {
                setOwnerBlocked({ blocked: false, reason: "" });
              }
            } catch (e) {
              console.error("[AuthGuard] Error fetching owner data:", e);
              setOwnerBlocked({ blocked: false, reason: "" });
            }
          } else {
            setPaymentInfo({ required: false });
            setOwnerBlocked({ blocked: false, reason: "" });
          }

          // User is authorized
          setAuthorized(true);
          setLoading(false);
        } catch (error) {
          console.error("Auth check error:", error);
          router.replace("/login");
          setLoading(false);
        }
      });

      return () => unsub();
    };

    checkAuth();
  }, [router, pathname]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-neutral-50">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-neutral-900 mx-auto mb-4"></div>
          <p className="text-neutral-600">Loading...</p>
        </div>
      </div>
    );
  }

  if (!authorized) {
    return null;
  }

  // If owner account is blocked (for branch admins), show blocking modal only
  if (ownerBlocked.blocked) {
    return (
      <OwnerAccountInactiveModal
        isOpen={true}
        reason={ownerBlocked.reason}
        ownerName={ownerBlocked.ownerName}
        onLogout={async () => {
          await signOut(auth);
          router.replace("/login");
        }}
      />
    );
  }

  return (
    <>
      <TrialWarningBanner />
      {children}
      <PaymentRequiredModal
        isOpen={paymentInfo.required}
        planName={paymentInfo.planName}
        planPrice={paymentInfo.planPrice}
        planId={paymentInfo.planId}
        trialDays={paymentInfo.trialDays}
        accountStatus={paymentInfo.accountStatus}
      />
    </>
  );
}

