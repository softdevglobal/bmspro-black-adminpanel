"use client";

import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { auth } from "@/lib/firebase";
import { fetchCurrentUser } from "@/lib/authClient";
import PaymentRequiredModal from "./PaymentRequiredModal";
import OwnerAccountInactiveModal from "./OwnerAccountInactiveModal";
import TrialWarningBanner from "./TrialWarningBanner";

interface AuthGuardProps {
  children: React.ReactNode;
}

// Pages that super_admin is allowed to access
const SUPER_ADMIN_ALLOWED_PAGES = ["/admin-dashboard", "/tenants", "/login", "/", "/packages", "/super-admin-audit-logs"];

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
          const allowedRoles = ["salon_owner", "salon_branch_admin", "super_admin"];
          
          if (!allowedRoles.includes(userRole)) {
            await auth.signOut();
            router.replace("/login");
            setLoading(false);
            return;
          }

          // Check payment status for salon_owner
          if (userRole === "salon_owner" && meData) {
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
                const trialDays = meData.trialDays || 0;
                setPaymentInfo({
                  required: true,
                  planName: meData.plan || undefined,
                  planPrice: meData.price || undefined,
                  planId: meData.planId || undefined,
                  trialDays: trialDays,
                  accountStatus: accountStatus,
                });
              } else {
                setPaymentInfo({ required: false });
              }
            } else {
              setPaymentInfo({ required: false });
            }
            setOwnerBlocked({ blocked: false, reason: "" });
          } else if (userRole === "salon_branch_admin" && meData.ownerUid) {
            // For branch admins, we check the owner status via a simple approach
            // The /api/auth/me already returns ownerUid; we trust the server data
            setPaymentInfo({ required: false });
            setOwnerBlocked({ blocked: false, reason: "" });
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
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-neutral-900 mx-auto mb-4"></div>
          <p className="text-slate-600">Loading...</p>
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

