"use client";

import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { auth, db } from "@/lib/firebase";
import { doc, getDoc } from "firebase/firestore";
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
          
          // Check super_admins collection first
          const superAdminDoc = await getDoc(doc(db, "super_admins", user.uid));
          let userRole: string;
          let userData: any = null;
          
          if (superAdminDoc.exists()) {
            userRole = "super_admin";
            console.log("[AuthGuard] User is super_admin");
            
            // Super admin route restriction: only allow admin-dashboard and tenants
            const isAllowedPage = pathname && SUPER_ADMIN_ALLOWED_PAGES.some(page => {
              if (page === "/") return pathname === "/" || pathname === "/admin-dashboard";
              return pathname === page || pathname.startsWith(page + "/");
            });
            
            if (!isAllowedPage) {
              // Redirect super_admin to admin-dashboard if trying to access unauthorized page
              router.replace("/admin-dashboard");
              setLoading(false);
              return;
            }
          } else {
            // Get user role from users collection
            console.log("[AuthGuard] Looking up user document at: users/" + user.uid);
            const userDoc = await getDoc(doc(db, "users", user.uid));
            console.log("[AuthGuard] User document exists:", userDoc.exists());
            userData = userDoc.data();
            console.log("[AuthGuard] User data:", userData);
            userRole = (userData?.role || "").toString().toLowerCase();
            console.log("[AuthGuard] User role:", userRole);
          }
          
          // Check if user has admin role
          const allowedRoles = ["salon_owner", "salon_branch_admin", "super_admin"];
          
          if (!allowedRoles.includes(userRole)) {
            // User is not an admin (probably a customer)
            await auth.signOut();
            router.replace("/login");
            setLoading(false);
            return;
          }

          // Check payment status for salon_owner
          console.log("[AuthGuard] Checking payment status. Role:", userRole, "Has userData:", !!userData);
          if (userRole === "salon_owner" && userData) {
            const accountStatus = userData.accountStatus || "active";
            const subscriptionStatus = userData.subscriptionStatus || "active";
            console.log("[AuthGuard] Account status:", accountStatus, "Subscription status:", subscriptionStatus);
            
            // Check if user is in active trial (with or without Stripe)
            // active_trial: Free trial started, no card details yet (card-free trial)
            // trialing with stripeSubscriptionId: Trial with card details entered
            const isCardFreeTrial = accountStatus === "active_trial" && !userData.stripeSubscriptionId;
            const isActiveTrialing = subscriptionStatus === "trialing" && userData.stripeSubscriptionId;
            
            // Check trial expiry
            let trialExpired = false;
            if ((isCardFreeTrial || isActiveTrialing) && userData.trial_end) {
              const trialEnd = userData.trial_end.toDate ? userData.trial_end.toDate() : new Date(userData.trial_end);
              trialExpired = new Date() > trialEnd;
              console.log("[AuthGuard] Trial end:", trialEnd, "Expired:", trialExpired);
            }
            
            // Card-free trial: Allow access if trial hasn't expired
            if (isCardFreeTrial && !trialExpired) {
              console.log("[AuthGuard] User is in card-free trial period - allowing access");
              setPaymentInfo({ required: false });
              setOwnerBlocked({ blocked: false, reason: "" });
              setAuthorized(true);
              setLoading(false);
              return;
            }
            
            // Check if payment details are required
            // - pending_payment: needs to enter payment details
            // - suspended: account suspended
            // - trial_expired: free trial ended without payment
            // - Active trial with Stripe subscription: allowed
            const needsPayment = 
              accountStatus === "pending_payment" || 
              accountStatus === "suspended" ||
              accountStatus === "trial_expired" ||
              (subscriptionStatus === "pending" && !isActiveTrialing && !isCardFreeTrial) ||
              subscriptionStatus === "past_due" ||
              subscriptionStatus === "unpaid" ||
              (trialExpired && !userData.stripeSubscriptionId);
            
            console.log("[AuthGuard] Needs payment:", needsPayment, "Pathname:", pathname);
            
            if (needsPayment) {
              // Check if current page is payment-exempt
              const isPaymentExemptPage = pathname && PAYMENT_EXEMPT_PAGES.some(page => 
                pathname === page || pathname.startsWith(page + "/")
              );
              
              // If on subscription success page, don't show modal
              const isSuccessPage = pathname?.includes("/subscription/success");
              
              console.log("[AuthGuard] Is payment exempt page:", isPaymentExemptPage, "Is success page:", isSuccessPage);
              
              if (!isPaymentExemptPage && !isSuccessPage) {
                // Get trialDays from user data or fetch from plan
                let trialDays = userData.trialDays || 0;
                
                // If trialDays not set on user, fetch from subscription plan
                if (!trialDays && userData.planId) {
                  try {
                    const planDoc = await getDoc(doc(db, "subscription_plans", userData.planId));
                    if (planDoc.exists()) {
                      const planData = planDoc.data();
                      trialDays = planData.trialDays ? parseInt(String(planData.trialDays), 10) : 0;
                    }
                  } catch (e) {
                    console.error("[AuthGuard] Error fetching plan:", e);
                  }
                }
                
                console.log("[AuthGuard] SHOWING PAYMENT MODAL with planId:", userData.planId, "trialDays:", trialDays, "accountStatus:", accountStatus);
                setPaymentInfo({
                  required: true,
                  planName: userData.plan || undefined,
                  planPrice: userData.price || undefined,
                  planId: userData.planId || undefined,
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
          } else if (userRole === "salon_branch_admin" && userData) {
            // For branch admins: Check the OWNER's account status
            // If owner's account is not active (payment failed, suspended, etc.), block access
            console.log("[AuthGuard] Branch admin - checking owner account status");
            setPaymentInfo({ required: false });
            
            const ownerUid = userData.ownerUid;
            if (ownerUid) {
              try {
                const ownerDoc = await getDoc(doc(db, "users", ownerUid));
                if (ownerDoc.exists()) {
                  const ownerData = ownerDoc.data();
                  const ownerAccountStatus = ownerData?.accountStatus || "active";
                  const ownerSubscriptionStatus = ownerData?.subscriptionStatus || "active";
                  const ownerName = ownerData?.displayName || ownerData?.name || ownerData?.email || "Salon Owner";
                  
                  console.log("[AuthGuard] Owner account status:", ownerAccountStatus, "Subscription status:", ownerSubscriptionStatus);
                  
                  // Check if owner is in card-free trial or active trial with Stripe
                  const ownerIsCardFreeTrial = ownerAccountStatus === "active_trial" && !ownerData?.stripeSubscriptionId;
                  const ownerIsActiveTrialing = ownerSubscriptionStatus === "trialing" && ownerData?.stripeSubscriptionId;
                  
                  // Check trial expiry for owner
                  let ownerTrialExpired = false;
                  if ((ownerIsCardFreeTrial || ownerIsActiveTrialing) && ownerData?.trial_end) {
                    const trialEnd = ownerData.trial_end.toDate ? ownerData.trial_end.toDate() : new Date(ownerData.trial_end);
                    ownerTrialExpired = new Date() > trialEnd;
                  }
                  
                  // Card-free trial is valid - owner can access
                  if (ownerIsCardFreeTrial && !ownerTrialExpired) {
                    console.log("[AuthGuard] Owner is in card-free trial period - allowing branch admin access");
                    setOwnerBlocked({ blocked: false, reason: "" });
                    setAuthorized(true);
                    setLoading(false);
                    return;
                  }
                  
                  // Determine if owner account is inactive
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
                    // Determine the reason
                    let reason = "The salon's subscription is currently inactive.";
                    
                    if (ownerAccountStatus === "suspended") {
                      reason = "The salon's account has been suspended due to payment issues.";
                    } else if (ownerAccountStatus === "cancelled" || ownerSubscriptionStatus === "canceled" || ownerSubscriptionStatus === "cancelled") {
                      reason = "The salon's subscription has been cancelled.";
                    } else if (ownerSubscriptionStatus === "past_due") {
                      reason = "The salon's subscription payment is past due.";
                    } else if (ownerSubscriptionStatus === "unpaid") {
                      reason = "The salon's subscription payment has failed.";
                    } else if (ownerTrialExpired) {
                      reason = "The salon's free trial has expired.";
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
                  console.log("[AuthGuard] Owner document not found for ownerUid:", ownerUid);
                  setOwnerBlocked({ blocked: false, reason: "" });
                }
              } catch (e) {
                console.error("[AuthGuard] Error fetching owner data:", e);
                setOwnerBlocked({ blocked: false, reason: "" });
              }
            } else {
              console.log("[AuthGuard] No ownerUid found for branch admin");
              setOwnerBlocked({ blocked: false, reason: "" });
            }
          } else {
            console.log("[AuthGuard] Not showing payment modal - not salon_owner or no userData");
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
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-pink-600 mx-auto mb-4"></div>
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

