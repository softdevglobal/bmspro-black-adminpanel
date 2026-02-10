"use client";
import React, { useEffect, useState, useCallback } from "react";
import Sidebar from "@/components/Sidebar";
import BillingStatusBanner from "@/components/BillingStatusBanner";
import { useRouter } from "next/navigation";
import { onAuthStateChanged } from "firebase/auth";
import { auth, db } from "@/lib/firebase";
import { doc, getDoc } from "firebase/firestore";

interface Package {
  id: string;
  name: string;
  price: number;
  priceLabel: string;
  branches: number;
  staff: number;
  features: string[];
  popular?: boolean;
  color: string;
  image?: string;
  icon?: string;
  active?: boolean;
  hidden?: boolean; // Hidden packages are not shown for upgrade/downgrade (budget plans)
  stripePriceId?: string;
  trialDays?: number;
}

interface UserData {
  name: string;
  email: string;
  plan?: string;
  price?: string;
  subscriptionStatus?: string;
  billing_status?: string;
  currentPeriodEnd?: Date;
  stripeSubscriptionId?: string;
  stripeCustomerId?: string;
  stripePriceId?: string;
  accountStatus?: string;
  downgradeScheduled?: boolean;
  cancelAtPeriodEnd?: boolean;
  trial_end?: Date | null;
  trialDays?: number;
}

interface TrialInfo {
  isTrialing: boolean;
  daysRemaining: number;
  trialEndDate: Date | null;
  showWarning: boolean;
}

interface BillingStatus {
  plan: string;
  billing_status: string;
  next_billing_date?: string;
  payment_required: boolean;
  downgrade_scheduled: boolean;
  trial_ends_at?: string;
  grace_until?: string;
  cancel_at_period_end: boolean;
}

export default function SubscriptionPage() {
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [userData, setUserData] = useState<UserData | null>(null);
  const [packages, setPackages] = useState<Package[]>([]);
  const [packagesLoading, setPackagesLoading] = useState(true);
  
  // Confirmation modal state
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [selectedPackage, setSelectedPackage] = useState<Package | null>(null);
  const [updating, setUpdating] = useState(false);
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [portalLoading, setPortalLoading] = useState(false);
  
  // Billing status
  const [billingStatus, setBillingStatus] = useState<BillingStatus | null>(null);
  const [billingLoading, setBillingLoading] = useState(true);
  const [upgradeLoading, setUpgradeLoading] = useState(false);
  const [downgradeLoading, setDowngradeLoading] = useState(false);
  const [cancelLoading, setCancelLoading] = useState(false);
  
  // Trial info
  const [trialInfo, setTrialInfo] = useState<TrialInfo>({
    isTrialing: false,
    daysRemaining: 0,
    trialEndDate: null,
    showWarning: false,
  });
  
  // Cancel modal state
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [customReason, setCustomReason] = useState("");
  
  const cancellationReasons = [
    { id: "too_expensive", label: "Too expensive", icon: "fa-dollar-sign" },
    { id: "not_using", label: "Not using enough", icon: "fa-clock" },
    { id: "missing_features", label: "Missing features", icon: "fa-puzzle-piece" },
    { id: "found_alternative", label: "Found alternative", icon: "fa-exchange-alt" },
    { id: "other", label: "Other", icon: "fa-comment-dots" },
  ];

  // Fetch billing status
  const fetchBillingStatus = useCallback(async () => {
    try {
      setBillingLoading(true);
      const currentUser = auth.currentUser;
      if (!currentUser) return;

      const token = await currentUser.getIdToken();
      const res = await fetch("/api/billing/status", {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (res.ok) {
        const data = await res.json();
        if (data.success && data.billing) {
          setBillingStatus(data.billing);
        }
      }
    } catch (error) {
      console.error("Error fetching billing status:", error);
    } finally {
      setBillingLoading(false);
    }
  }, []);

  // Fetch packages from API
  const fetchPackages = useCallback(async () => {
    try {
      setPackagesLoading(true);
      const currentUser = auth.currentUser;
      if (!currentUser) return;

      const token = await currentUser.getIdToken();
      const res = await fetch("/api/packages", {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (res.ok) {
        const data = await res.json();
        // API returns 'plans' not 'packages'
        const allPackages = data.plans || data.packages || [];
        // Only filter by active - we'll handle hidden filtering when displaying
        const activePackages = allPackages.filter((p: Package) => p.active !== false);
        setPackages(activePackages);
      }
    } catch (error) {
      console.error("Error fetching packages:", error);
    } finally {
      setPackagesLoading(false);
    }
  }, []);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        router.replace("/login");
        return;
      }
      try {
        const token = await user.getIdToken();
        if (typeof window !== "undefined") localStorage.setItem("idToken", token);

        const snap = await getDoc(doc(db, "users", user.uid));
        const data = snap.data();
        const role = (data?.role || "").toString();

        // Only workshop_owner can access this page
        if (role !== "workshop_owner") {
          router.replace("/dashboard");
          return;
        }

        const trialEndRaw = data?.trial_end;
        let trialEndDate: Date | null = null;
        if (trialEndRaw) {
          trialEndDate = trialEndRaw.toDate ? trialEndRaw.toDate() : new Date(trialEndRaw);
        }

        setUserData({
          name: data?.name || data?.displayName || "",
          email: user.email || data?.email || "",
          plan: data?.plan || "",
          price: data?.price || "",
          subscriptionStatus: data?.subscriptionStatus || data?.billing_status || "",
          billing_status: data?.billing_status || data?.subscriptionStatus || "",
          currentPeriodEnd: data?.currentPeriodEnd?.toDate?.() || null,
          stripeSubscriptionId: data?.stripeSubscriptionId || "",
          stripeCustomerId: data?.stripeCustomerId || "",
          stripePriceId: data?.stripePriceId || "",
          accountStatus: data?.accountStatus || "active",
          downgradeScheduled: data?.downgradeScheduled || false,
          cancelAtPeriodEnd: data?.cancelAtPeriodEnd || false,
          trial_end: trialEndDate,
          trialDays: data?.trialDays || 0,
        });

        // Calculate trial info for card-free trial users
        const accountStatus = data?.accountStatus || "";
        const subscriptionStatus = data?.subscriptionStatus || "";
        const hasStripeSubscription = !!data?.stripeSubscriptionId;
        
        // Card-free trial: active_trial status without Stripe subscription
        const isCardFreeTrial = 
          (accountStatus === "active_trial" || subscriptionStatus === "trialing") && 
          !hasStripeSubscription;

        if (isCardFreeTrial && trialEndDate) {
          const now = new Date();
          const diffMs = trialEndDate.getTime() - now.getTime();
          const daysRemaining = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
          const showWarning = daysRemaining <= 2 && daysRemaining > 0;
          
          setTrialInfo({
            isTrialing: true,
            daysRemaining: Math.max(0, daysRemaining),
            trialEndDate,
            showWarning,
          });
        } else {
          setTrialInfo({
            isTrialing: false,
            daysRemaining: 0,
            trialEndDate: null,
            showWarning: false,
          });
        }

        // Fetch packages and billing status after auth is ready
        fetchPackages();
        fetchBillingStatus();

        setMounted(true);
        setLoading(false);
      } catch (error) {
        console.error("Error fetching user data:", error);
        router.replace("/login");
      }
    });
    return () => unsub();
  }, [router, fetchPackages, fetchBillingStatus]);

  const selectPlan = (pkg: Package) => {
    setSelectedPackage(pkg);
    setShowConfirmModal(true);
  };

  const confirmPlanChange = async () => {
    if (!selectedPackage || !auth.currentUser) return;
    
    // Check if package has a valid price
    if (!selectedPackage.price || selectedPackage.price <= 0) {
      alert("This package is not configured for payments yet. Please contact support.");
      return;
    }
    
    try {
      setCheckoutLoading(true);
      setUpdating(true);
      
      const token = await auth.currentUser.getIdToken();
      
      // Create Stripe Checkout session
      const response = await fetch("/api/stripe/create-checkout", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({
          planId: selectedPackage.id,
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
      
    } catch (error: any) {
      console.error("Error creating checkout:", error);
      alert(error.message || "Failed to start checkout. Please try again.");
      setCheckoutLoading(false);
      setUpdating(false);
    }
  };

  // Open Stripe billing portal
  const openBillingPortal = async () => {
    if (!auth.currentUser) return;
    
    try {
      setPortalLoading(true);
      
      const token = await auth.currentUser.getIdToken();
      
      const response = await fetch("/api/stripe/create-portal", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({}),
      });
      
      const data = await response.json();
      
      if (!response.ok || !data.success) {
        throw new Error(data.error || "Failed to open billing portal");
      }
      
      // Redirect to Stripe billing portal
      if (data.url) {
        window.location.href = data.url;
      }
      
    } catch (error: any) {
      console.error("Error opening billing portal:", error);
      alert(error.message || "Failed to open billing portal. Please try again.");
    } finally {
      setPortalLoading(false);
    }
  };

  // Upgrade subscription
  const handleUpgrade = async (newPlanId: string) => {
    if (!auth.currentUser || !confirm("Upgrades start a new 28-day cycle today and charge immediately. Continue?")) return;
    
    try {
      setUpgradeLoading(true);
      const token = await auth.currentUser.getIdToken();
      
      const response = await fetch("/api/billing/upgrade", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({ newPlanId }),
      });
      
      const data = await response.json();
      
      if (!response.ok) {
        throw new Error(data.error || "Failed to upgrade subscription");
      }
      
      alert("Upgrade initiated! Payment will be processed immediately.");
      fetchBillingStatus();
      // Refresh page to show updated status
      window.location.reload();
    } catch (error: any) {
      console.error("Error upgrading:", error);
      alert(error.message || "Failed to upgrade subscription. Please try again.");
    } finally {
      setUpgradeLoading(false);
    }
  };

  // Downgrade subscription
  const handleDowngrade = async (newPlanId: string) => {
    if (!auth.currentUser || !confirm("Downgrade applies at the end of your current 28-day cycle. Continue?")) return;
    
    try {
      setDowngradeLoading(true);
      const token = await auth.currentUser.getIdToken();
      
      const response = await fetch("/api/billing/downgrade", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({ newPlanId }),
      });
      
      const data = await response.json();
      
      if (!response.ok) {
        throw new Error(data.error || "Failed to schedule downgrade");
      }
      
      alert("Downgrade scheduled! Your plan will change at the end of your current billing cycle.");
      fetchBillingStatus();
    } catch (error: any) {
      console.error("Error downgrading:", error);
      alert(error.message || "Failed to schedule downgrade. Please try again.");
    } finally {
      setDowngradeLoading(false);
    }
  };

  // Open cancel modal
  const openCancelModal = () => {
    setCancelReason("");
    setCustomReason("");
    setShowCancelModal(true);
  };

  // Cancel subscription
  const handleCancel = async () => {
    if (!auth.currentUser) return;
    
    const reason = cancelReason === "other" ? customReason : cancellationReasons.find(r => r.id === cancelReason)?.label || "";
    
    if (!reason.trim()) {
      alert("Please select or enter a reason for cancellation.");
      return;
    }
    
    try {
      setCancelLoading(true);
      const token = await auth.currentUser.getIdToken();
      
      const response = await fetch("/api/billing/cancel", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({ reason }),
      });
      
      const data = await response.json();
      
      if (!response.ok) {
        throw new Error(data.error || "Failed to cancel subscription");
      }
      
      setShowCancelModal(false);
      fetchBillingStatus();
      // Show success message
      alert("Subscription cancelled. You'll continue to have access until the end of your current billing period.");
    } catch (error: any) {
      console.error("Error cancelling:", error);
      alert(error.message || "Failed to cancel subscription. Please try again.");
    } finally {
      setCancelLoading(false);
    }
  };

  return (
    <div id="app" className="flex h-screen overflow-hidden bg-white">
      <Sidebar />
      <div className="flex-1 flex flex-col overflow-hidden">
        <main className="flex-1 overflow-auto p-4 sm:p-6 lg:p-8">
          <div className="md:hidden mb-4">
            <button
              className="inline-flex items-center gap-2 rounded-lg border border-neutral-200 px-3 py-2 text-neutral-700 shadow-sm hover:bg-neutral-50"
              onClick={() => setMobileOpen(true)}
            >
              <i className="fas fa-bars" />
              Menu
            </button>
          </div>

          {mobileOpen && (
            <div className="fixed inset-0 z-50 md:hidden">
              <div className="absolute inset-0 bg-black/40" onClick={() => setMobileOpen(false)} />
              <div className="absolute left-0 top-0 bottom-0">
                <Sidebar mobile onClose={() => setMobileOpen(false)} />
              </div>
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center h-64">
              <div className="flex flex-col items-center gap-3">
                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-neutral-900" />
                <p className="text-neutral-500 font-medium">Loading subscription...</p>
              </div>
            </div>
          ) : (
            mounted &&
            userData && (
              <>
                {/* Header Banner */}
                <div className="mb-8">
                  <div className="relative rounded-2xl bg-neutral-900 text-white p-8 shadow-lg overflow-hidden">
                    {/* Decorative Background */}
                    <div className="absolute inset-0 overflow-hidden">
                      <div className="absolute -top-6 -right-6 w-36 h-36 rounded-full bg-amber-500/10" />
                      <div className="absolute -bottom-10 -left-10 w-44 h-44 rounded-full bg-amber-500/5" />
                      <div className="absolute top-1/3 right-1/4 w-2 h-2 rounded-full bg-amber-400/30" />
                      <div className="absolute bottom-6 right-1/3 w-1.5 h-1.5 rounded-full bg-amber-400/20" />
                      <i className="fas fa-gear absolute -right-3 -bottom-3 text-[90px] text-white/[0.03] rotate-12" />
                      <i className="fas fa-gear absolute right-20 -top-5 text-[55px] text-white/[0.03] -rotate-6" />
                    </div>
                    <div className="relative flex items-center justify-between flex-wrap gap-4">
                      <div className="flex items-center gap-4">
                        <div className="w-14 h-14 rounded-2xl bg-amber-500/20 border border-amber-500/30 flex items-center justify-center">
                          <i className="fas fa-file-invoice-dollar text-2xl text-amber-400" />
                        </div>
                        <div>
                          <h1 className="text-2xl font-bold tracking-tight">Subscription Management</h1>
                          <p className="text-neutral-400 mt-0.5">Manage your plan, billing, and subscription settings</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-3 flex-wrap">
                        {userData.plan && (
                          <div className="flex items-center gap-2 bg-white/10 border border-white/10 px-4 py-2 rounded-xl">
                            <i className="fas fa-check-circle text-amber-400" />
                            <span className="font-medium text-neutral-200">
                              Current: {userData.plan} {userData.price ? `(${userData.price})` : ""}
                            </span>
                          </div>
                        )}
                        {billingStatus?.billing_status && (
                          <div className={`flex items-center gap-2 px-4 py-2 rounded-xl border ${
                            billingStatus.billing_status === "active" || billingStatus.billing_status === "trialing"
                              ? "bg-emerald-500/20 border-emerald-500/30 text-emerald-400" 
                              : billingStatus.billing_status === "past_due"
                              ? "bg-amber-500/20 border-amber-500/30 text-amber-400"
                              : "bg-red-500/20 border-red-500/30 text-red-400"
                          }`}>
                            <i className={`fas ${
                              billingStatus.billing_status === "active" || billingStatus.billing_status === "trialing"
                                ? "fa-check-circle" 
                                : billingStatus.billing_status === "past_due"
                                ? "fa-exclamation-triangle"
                                : "fa-times-circle"
                            }`} />
                            <span className="font-medium capitalize">
                              {billingStatus.billing_status.replace("_", " ")}
                            </span>
                          </div>
                        )}
                        {userData.stripeCustomerId && (
                          <button
                            onClick={openBillingPortal}
                            disabled={portalLoading}
                            className="flex items-center gap-2 bg-amber-500/20 border border-amber-500/30 px-4 py-2 rounded-xl hover:bg-amber-500/30 transition-colors disabled:opacity-50 text-amber-400"
                          >
                            {portalLoading ? (
                              <i className="fas fa-circle-notch fa-spin" />
                            ) : (
                              <i className="fas fa-credit-card" />
                            )}
                            <span className="font-medium">Manage Billing</span>
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Billing Status Banner - hide when card-free trial section is visible to avoid duplication */}
                {billingStatus && !(trialInfo.isTrialing && billingStatus.billing_status === "trialing") && (
                  <BillingStatusBanner
                    billingStatus={billingStatus.billing_status}
                    graceUntil={billingStatus.grace_until}
                    nextBillingDate={billingStatus.next_billing_date}
                    trialDays={userData?.trialDays || 28}
                    onUpdatePayment={openBillingPortal}
                  />
                )}

                {/* Trial Warning/Info Section - For card-free trial users */}
                {trialInfo.isTrialing && (
                  <div className={`mb-6 rounded-2xl border-2 overflow-hidden ${
                    trialInfo.showWarning 
                      ? "border-amber-400 bg-white" 
                      : "border-neutral-200 bg-white"
                  }`}>
                    <div className="p-6">
                      <div className="flex items-start gap-4 mb-5">
                        <div className={`w-12 h-12 rounded-2xl flex items-center justify-center flex-shrink-0 ${
                          trialInfo.showWarning ? "bg-amber-100" : "bg-emerald-100"
                        }`}>
                          <i className={`fas ${trialInfo.showWarning ? "fa-exclamation-triangle text-amber-600" : "fa-gift text-emerald-600"} text-xl`} />
                        </div>
                        <div className="flex-1">
                          <h3 className="font-bold text-lg text-neutral-900">
                            {trialInfo.showWarning 
                              ? `Trial Ending Soon – ${trialInfo.daysRemaining} ${trialInfo.daysRemaining === 1 ? "Day" : "Days"} Left!`
                              : `Free Trial Active – ${trialInfo.daysRemaining} ${trialInfo.daysRemaining === 1 ? "Day" : "Days"} Remaining`
                            }
                          </h3>
                          <p className="text-sm text-neutral-500 mt-0.5">
                            {trialInfo.trialEndDate && (
                              <>Trial ends on {trialInfo.trialEndDate.toLocaleDateString("en-AU", { 
                                weekday: "long", 
                                day: "numeric", 
                                month: "long", 
                                year: "numeric" 
                              })}</>
                            )}
                          </p>
                        </div>
                      </div>
                      
                      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                        <div className="flex-1">
                          {trialInfo.showWarning ? (
                            <>
                              <p className="text-amber-800 font-medium mb-1">
                                <i className="fas fa-exclamation-circle mr-2" />
                                Add payment details to continue using BMS PRO BLACK
                              </p>
                              <p className="text-neutral-600 text-sm">
                                Your trial will expire soon. To avoid any interruption to your service, please add your payment details now. 
                                You won't be charged until your trial ends.
                              </p>
                            </>
                          ) : (
                            <>
                              <p className="text-neutral-800 font-medium mb-1">
                                <i className="fas fa-info-circle mr-2 text-neutral-400" />
                                Enjoying your free trial? Add payment details anytime!
                              </p>
                              <p className="text-neutral-500 text-sm">
                                You can add your payment details early to ensure uninterrupted access after your trial ends. 
                                You won't be charged until your trial period is over.
                              </p>
                            </>
                          )}
                        </div>
                        
                        <div className="flex-shrink-0">
                          <button
                            onClick={() => {
                              const currentPkg = packages.find(p => p.name === userData?.plan);
                              if (currentPkg) {
                                selectPlan(currentPkg);
                              } else if (packages.length > 0) {
                                selectPlan(packages[0]);
                              }
                            }}
                            className={`px-6 py-3 rounded-xl font-semibold text-white transition-all hover:shadow-lg hover:scale-[1.02] ${
                              trialInfo.showWarning 
                                ? "bg-amber-500 hover:bg-amber-600" 
                                : "bg-neutral-900 hover:bg-neutral-800"
                            }`}
                          >
                            <i className="fas fa-credit-card mr-2" />
                            Add Payment Details
                          </button>
                        </div>
                      </div>
                      
                      {/* Progress bar */}
                      <div className="mt-5">
                        <div className="flex items-center justify-between text-xs mb-2">
                          <span className="text-neutral-500 font-medium">Trial Started</span>
                          <span className="text-neutral-500 font-medium">Trial Ends</span>
                        </div>
                        <div className="h-2 rounded-full overflow-hidden bg-neutral-100">
                          <div 
                            className={`h-full rounded-full transition-all ${
                              trialInfo.showWarning 
                                ? "bg-amber-500" 
                                : "bg-emerald-500"
                            }`}
                            style={{ 
                              width: `${Math.max(5, 100 - ((trialInfo.daysRemaining / (userData?.trialDays || 28)) * 100))}%` 
                            }}
                          />
                        </div>
                        <div className="text-center mt-2">
                          <span className="text-sm font-medium text-neutral-600">
                            {trialInfo.daysRemaining} of {userData?.trialDays || 28} days remaining
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* Current Plan Management Section */}
                {userData.stripeSubscriptionId && userData.plan && (
                  <div className="mb-8 bg-white rounded-2xl border border-neutral-200 overflow-hidden">
                    <div className="flex items-center gap-3 px-6 py-4 border-b border-neutral-100 bg-neutral-50">
                      <div className="w-9 h-9 rounded-xl bg-neutral-100 flex items-center justify-center">
                        <i className="fas fa-box text-sm text-neutral-600" />
                      </div>
                      <h2 className="text-base font-bold text-neutral-900">Current Plan</h2>
                    </div>
                    <div className="p-6">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <div>
                          <div className="text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-1">Plan</div>
                          <div className="text-lg font-bold text-neutral-900">{userData.plan}</div>
                          {billingStatus?.next_billing_date && (
                            <>
                              <div className="text-xs font-semibold text-neutral-500 uppercase tracking-wider mt-3 mb-1">Next Billing Date</div>
                              <div className="text-sm text-neutral-700">
                                {new Date(billingStatus.next_billing_date).toLocaleDateString()}
                              </div>
                            </>
                          )}
                          {billingStatus?.trial_ends_at && (
                            <>
                              <div className="text-xs font-semibold text-neutral-500 uppercase tracking-wider mt-3 mb-1">Trial Ends</div>
                              <div className="text-sm text-neutral-700">
                                {new Date(billingStatus.trial_ends_at).toLocaleDateString()}
                              </div>
                            </>
                          )}
                        </div>
                        <div className="flex flex-col gap-3">
                          {billingStatus?.downgrade_scheduled && (
                            <div className="bg-amber-50 border border-amber-200 rounded-xl p-3">
                              <div className="flex items-center gap-2 text-amber-800">
                                <i className="fas fa-info-circle" />
                                <span className="text-sm font-medium">Downgrade scheduled</span>
                              </div>
                            </div>
                          )}
                          {userData.cancelAtPeriodEnd && (
                            <div className="bg-red-50 border border-red-200 rounded-xl p-3">
                              <div className="flex items-center gap-2 text-red-800">
                                <i className="fas fa-exclamation-triangle" />
                                <span className="text-sm font-medium">Cancellation scheduled</span>
                              </div>
                            </div>
                          )}
                          {!userData.cancelAtPeriodEnd && (
                            <button
                              onClick={openCancelModal}
                              className="px-4 py-2.5 border border-red-200 bg-red-50 rounded-xl text-red-600 font-medium hover:bg-red-100 hover:border-red-300 transition-colors text-sm group"
                            >
                              <i className="fas fa-times mr-2 group-hover:rotate-90 transition-transform" />
                              Cancel Subscription
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* Section Title */}
                <div className="flex items-center gap-3 mb-6">
                  <div className="w-9 h-9 rounded-xl bg-neutral-100 flex items-center justify-center">
                    <i className="fas fa-tags text-sm text-neutral-600" />
                  </div>
                  <div>
                    <h2 className="text-base font-bold text-neutral-900">Available Plans</h2>
                    <p className="text-xs text-neutral-500">Choose the best plan for your workshop</p>
                  </div>
                </div>

                {/* Pricing Cards */}
                {packagesLoading ? (
                  <div className="flex items-center justify-center py-12 mb-10">
                    <div className="flex flex-col items-center gap-3">
                      <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-neutral-900" />
                      <p className="text-neutral-500 font-medium">Loading packages...</p>
                    </div>
                  </div>
                ) : packages.length === 0 ? (
                  <div className="text-center py-12 mb-10">
                    <i className="fas fa-box-open text-4xl text-neutral-300 mb-3" />
                    <p className="text-neutral-500">No subscription plans available at the moment.</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6 mb-10">
                    {packages
                      .filter((pkg) => {
                        const isCurrentPlan = userData?.plan === pkg.name;
                        if (isCurrentPlan) return true;
                        return !pkg.hidden;
                      })
                      .map((pkg) => {
                      const isCurrentPlan = userData?.plan === pkg.name;
                      const gradientClass = pkg.color === "blue" ? "from-blue-500 via-blue-600 to-indigo-600" 
                        : pkg.color === "pink" ? "from-pink-500 via-rose-500 to-fuchsia-600" 
                        : pkg.color === "purple" ? "from-purple-500 via-violet-500 to-indigo-600" 
                        : pkg.color === "green" ? "from-emerald-500 via-green-500 to-teal-600"
                        : pkg.color === "orange" ? "from-orange-500 via-amber-500 to-yellow-500"
                        : pkg.color === "teal" ? "from-teal-500 via-cyan-500 to-blue-500"
                        : "from-neutral-700 via-neutral-800 to-neutral-900";
                      const lightBgClass = pkg.color === "blue" ? "bg-blue-50" 
                        : pkg.color === "pink" ? "bg-pink-50" 
                        : pkg.color === "purple" ? "bg-purple-50" 
                        : pkg.color === "green" ? "bg-emerald-50"
                        : pkg.color === "orange" ? "bg-orange-50"
                        : pkg.color === "teal" ? "bg-teal-50"
                        : "bg-neutral-50";
                      
                      return (
                        <div 
                          key={pkg.id}
                          className={`group relative bg-white rounded-2xl overflow-hidden hover:shadow-xl transition-all duration-300 hover:-translate-y-1 flex flex-col ${
                            isCurrentPlan ? "border-2 border-neutral-900 shadow-lg" : "border border-neutral-200 shadow-sm"
                          }`}
                        >
                          {/* Gradient Header */}
                          <div className={`relative h-28 bg-gradient-to-br ${gradientClass} overflow-visible flex-shrink-0`}>
                            <div className="absolute -top-6 -right-6 w-24 h-24 bg-white/10 rounded-full" />
                            <div className="absolute -bottom-4 -left-4 w-20 h-20 bg-white/10 rounded-full" />
                            
                            {/* Popular badge */}
                            {pkg.popular && (
                              <div className="absolute top-3 left-3 bg-white/20 backdrop-blur-sm text-white text-xs font-bold px-3 py-1 rounded-full flex items-center gap-1.5 z-10">
                                <i className="fas fa-star text-amber-300 text-xs" />
                                Popular
                              </div>
                            )}
                            
                            {/* Current Plan badge */}
                            {isCurrentPlan && (
                              <div className="absolute top-3 right-3 bg-neutral-900 text-white text-xs font-bold px-3 py-1 rounded-full flex items-center gap-1.5 z-10">
                                <i className="fas fa-check text-xs" />
                                Current
                              </div>
                            )}
                            
                            {/* Package Image/Icon */}
                            <div className="absolute -bottom-10 left-1/2 -translate-x-1/2 z-20">
                              <div className={`w-20 h-20 rounded-2xl flex items-center justify-center overflow-hidden shadow-lg ring-4 ring-white ${lightBgClass}`}>
                                {pkg.image ? (
                                  <img src={pkg.image} alt={pkg.name} className="w-full h-full object-cover" />
                                ) : pkg.icon ? (
                                  <i className={`fas ${pkg.icon} text-3xl bg-gradient-to-br ${gradientClass} bg-clip-text text-transparent`} />
                                ) : (
                                  <i className={`fas fa-box text-3xl bg-gradient-to-br ${gradientClass} bg-clip-text text-transparent`} />
                                )}
                              </div>
                            </div>
                          </div>
                          
                          {/* Card Content */}
                          <div className="pt-14 pb-5 px-5 flex flex-col flex-grow">
                            <div className="text-center mb-4">
                              <h3 className="text-lg font-bold text-neutral-900 mb-1">{pkg.name}</h3>
                              <div className="text-3xl font-extrabold text-neutral-900">
                                {pkg.priceLabel}
                              </div>
                            </div>
                            
                            {/* Branches & Staff */}
                            <div className="flex items-center justify-center gap-3 mb-2 text-sm text-neutral-500">
                              <span className="flex items-center gap-1.5">
                                <i className="fas fa-warehouse text-xs text-neutral-400" />
                                {pkg.branches === -1 ? "Unlimited" : pkg.branches} Branch
                              </span>
                              <span className="w-1 h-1 bg-neutral-300 rounded-full" />
                              <span className="flex items-center gap-1.5">
                                <i className="fas fa-users text-xs text-neutral-400" />
                                {pkg.staff === -1 ? "Unlimited" : pkg.staff} Staff
                              </span>
                            </div>
                            
                            {/* Trial Period Badge */}
                            {pkg.trialDays && pkg.trialDays > 0 && (
                              <div className="flex items-center justify-center mb-4">
                                <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-emerald-50 text-emerald-700 rounded-full text-xs font-semibold border border-emerald-200">
                                  <i className="fas fa-gift" />
                                  {pkg.trialDays}-day free trial
                                </span>
                              </div>
                            )}
                            
                            <div className="h-px bg-neutral-100 mb-4" />
                            
                            {/* Features List */}
                            {pkg.features && pkg.features.length > 0 && (
                              <div className="mb-4 flex-grow">
                                <ul className="space-y-2 max-h-48 overflow-y-auto pr-1">
                                  {pkg.features.map((feature, idx) => (
                                    <li key={idx} className="flex items-start gap-2">
                                      <div className="w-5 h-5 rounded-full bg-emerald-500 flex items-center justify-center flex-shrink-0 mt-0.5">
                                        <i className="fas fa-check text-white text-[9px]" />
                                      </div>
                                      <span className="text-sm text-neutral-600">{feature}</span>
                                    </li>
                                  ))}
                                </ul>
                                {pkg.features.length > 5 && (
                                  <p className="text-xs text-neutral-400 text-center mt-2 italic">Scroll for more</p>
                                )}
                              </div>
                            )}
                            
                            {/* Action Buttons */}
                            <div className="mt-auto pt-2 space-y-2">
                              {isCurrentPlan ? (
                                <button
                                  disabled
                                  className="w-full py-3 px-4 rounded-xl font-semibold text-sm bg-neutral-100 text-neutral-500 cursor-not-allowed"
                                >
                                  <i className="fas fa-check-circle mr-1.5 text-emerald-500" />
                                  Current Plan
                                </button>
                              ) : userData.stripeSubscriptionId ? (
                                <>
                                  {pkg.price > (parseFloat(userData.price?.replace(/[^0-9.]/g, "") || "0")) ? (
                                    <button
                                      onClick={() => handleUpgrade(pkg.id)}
                                      disabled={upgradeLoading}
                                      className="w-full py-3 px-4 rounded-xl font-semibold text-sm transition-all duration-200 bg-neutral-900 text-white hover:bg-neutral-800 hover:shadow-lg disabled:opacity-50"
                                    >
                                      {upgradeLoading ? (
                                        <>
                                          <i className="fas fa-circle-notch fa-spin mr-1.5" />
                                          Upgrading...
                                        </>
                                      ) : (
                                        <>
                                          <i className="fas fa-arrow-up mr-1.5" />
                                          Upgrade Now
                                        </>
                                      )}
                                    </button>
                                  ) : (
                                    <button
                                      onClick={() => handleDowngrade(pkg.id)}
                                      disabled={downgradeLoading}
                                      className="w-full py-3 px-4 rounded-xl font-semibold text-sm transition-all duration-200 border-2 border-neutral-900 text-neutral-900 hover:bg-neutral-900 hover:text-white disabled:opacity-50"
                                    >
                                      {downgradeLoading ? (
                                        <>
                                          <i className="fas fa-circle-notch fa-spin mr-1.5" />
                                          Scheduling...
                                        </>
                                      ) : (
                                        <>
                                          <i className="fas fa-arrow-down mr-1.5" />
                                          Downgrade
                                        </>
                                      )}
                                    </button>
                                  )}
                                </>
                              ) : (
                                <button
                                  onClick={() => selectPlan(pkg)}
                                  className="w-full py-3 px-4 rounded-xl font-semibold text-sm transition-all duration-200 bg-neutral-900 text-white hover:bg-neutral-800 hover:shadow-lg"
                                >
                                  <i className="fas fa-credit-card mr-1.5" />
                                  Subscribe
                                </button>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* FAQ / Help Section */}
                <div className="mt-10 text-center text-neutral-500 text-sm pb-4">
                  <p>
                    Need help choosing a plan?{" "}
                    <a href="#" className="text-neutral-900 hover:text-amber-600 font-semibold transition-colors">
                      Contact our support team
                    </a>
                  </p>
                </div>
              </>
            )
          )}
        </main>
      </div>

      {/* Confirmation Modal */}
      {showConfirmModal && selectedPackage && (
        <div className="fixed inset-0 z-50">
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => !updating && setShowConfirmModal(false)} />
          <div className="relative flex items-center justify-center min-h-screen p-4">
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
              {/* Header */}
              <div className="bg-neutral-900 p-6 text-white relative overflow-hidden">
                <div className="absolute -top-4 -right-4 w-24 h-24 rounded-full bg-amber-500/10" />
                <div className="absolute -bottom-6 -left-6 w-28 h-28 rounded-full bg-amber-500/5" />
                <div className="relative flex items-center gap-4">
                  <div className="w-14 h-14 rounded-2xl bg-amber-500/20 border border-amber-500/30 flex items-center justify-center">
                    <i className="fas fa-file-invoice-dollar text-2xl text-amber-400" />
                  </div>
                  <div>
                    <h3 className="text-xl font-bold">Subscribe to Plan</h3>
                    <p className="text-neutral-400 text-sm">You'll be redirected to secure checkout</p>
                  </div>
                </div>
              </div>
              
              {/* Content */}
              <div className="p-6">
                <div className="text-center mb-6">
                  <p className="text-neutral-600 mb-4">
                    You are about to change your subscription to:
                  </p>
                  <div className="inline-flex items-center gap-3 bg-neutral-50 border border-neutral-200 px-5 py-3 rounded-xl">
                    {selectedPackage.image && (
                      <img src={selectedPackage.image} alt={selectedPackage.name} className="w-10 h-10 rounded-lg object-cover" />
                    )}
                    <div className="text-left">
                      <div className="font-bold text-neutral-900">{selectedPackage.name}</div>
                      <div className="text-sm text-neutral-700 font-semibold">{selectedPackage.priceLabel}</div>
                    </div>
                  </div>
                </div>
                
                {/* Plan Details */}
                <div className="bg-neutral-50 border border-neutral-200 rounded-xl p-4 mb-6">
                  <div className="flex items-center justify-between text-sm mb-2">
                    <span className="text-neutral-500 flex items-center gap-2"><i className="fas fa-warehouse text-xs" /> Branches</span>
                    <span className="font-medium text-neutral-700">
                      {selectedPackage.branches === -1 ? "Unlimited" : selectedPackage.branches}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-sm mb-2">
                    <span className="text-neutral-500 flex items-center gap-2"><i className="fas fa-users text-xs" /> Staff</span>
                    <span className="font-medium text-neutral-700">
                      {selectedPackage.staff === -1 ? "Unlimited" : selectedPackage.staff}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-neutral-500 flex items-center gap-2"><i className="fas fa-list-check text-xs" /> Features</span>
                    <span className="font-medium text-neutral-700">
                      {selectedPackage.features?.length || 0} included
                    </span>
                  </div>
                </div>
                
                {/* Current Plan Info */}
                {userData?.plan && (
                  <div className="flex items-center gap-2 text-sm text-amber-700 bg-amber-50 border border-amber-200 p-3 rounded-xl mb-6">
                    <i className="fas fa-info-circle" />
                    <span>Your current plan: <strong>{userData.plan}</strong> ({userData.price})</span>
                  </div>
                )}
                
                {/* Buttons */}
                <div className="flex gap-3">
                  <button
                    onClick={() => setShowConfirmModal(false)}
                    disabled={updating}
                    className="flex-1 py-3 px-4 rounded-xl border border-neutral-200 text-neutral-700 font-medium hover:bg-neutral-50 transition-colors disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={confirmPlanChange}
                    disabled={updating}
                    className="flex-1 py-3 px-4 rounded-xl text-white font-semibold transition-all disabled:opacity-70 bg-neutral-900 hover:bg-neutral-800 hover:shadow-lg"
                  >
                    {updating || checkoutLoading ? (
                      <>
                        <i className="fas fa-circle-notch fa-spin mr-2" />
                        {checkoutLoading ? "Redirecting..." : "Processing..."}
                      </>
                    ) : (
                      <>
                        <i className="fas fa-credit-card mr-2 text-amber-400" />
                        Subscribe & Pay
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Cancel Subscription Modal */}
      {showCancelModal && (
        <div className="fixed inset-0 z-50">
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => !cancelLoading && setShowCancelModal(false)} />
          <div className="relative flex items-center justify-center min-h-screen p-4">
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden">
              {/* Header */}
              <div className="bg-neutral-900 px-6 py-5 text-white relative overflow-hidden">
                <div className="absolute -top-4 -right-4 w-20 h-20 rounded-full bg-red-500/10" />
                <button
                  onClick={() => !cancelLoading && setShowCancelModal(false)}
                  className="absolute top-4 right-4 w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center transition-colors z-10"
                >
                  <i className="fas fa-times text-sm text-white/70" />
                </button>
                <div className="relative flex items-center gap-4">
                  <div className="w-12 h-12 rounded-xl bg-red-500/20 border border-red-500/30 flex items-center justify-center">
                    <i className="fas fa-exclamation-triangle text-xl text-red-400" />
                  </div>
                  <div>
                    <h3 className="text-xl font-bold">Cancel Subscription</h3>
                    <p className="text-neutral-400 text-sm">
                      Access until {billingStatus?.next_billing_date 
                        ? new Date(billingStatus.next_billing_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                        : "end of billing period"}
                    </p>
                  </div>
                </div>
              </div>
              
              {/* Content */}
              <div className="p-6">
                <div className="mb-5">
                  <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-3">
                    Why are you leaving? <span className="text-red-500">*</span>
                  </label>
                  <div className="grid grid-cols-2 gap-3">
                    {cancellationReasons.map((reason) => (
                      <label
                        key={reason.id}
                        className={`flex items-center gap-3 p-3 rounded-xl border-2 cursor-pointer transition-all ${
                          cancelReason === reason.id
                            ? "border-neutral-900 bg-neutral-50"
                            : "border-neutral-200 hover:border-neutral-300 hover:bg-neutral-50"
                        }`}
                      >
                        <input
                          type="radio"
                          name="cancelReason"
                          value={reason.id}
                          checked={cancelReason === reason.id}
                          onChange={(e) => setCancelReason(e.target.value)}
                          className="sr-only"
                        />
                        <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${
                          cancelReason === reason.id
                            ? "bg-neutral-900 text-amber-400"
                            : "bg-neutral-100 text-neutral-500"
                        }`}>
                          <i className={`fas ${reason.icon} text-sm`} />
                        </div>
                        <span className={`text-sm font-medium ${
                          cancelReason === reason.id ? "text-neutral-900" : "text-neutral-700"
                        }`}>
                          {reason.label}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
                
                {cancelReason === "other" && (
                  <div className="mb-5">
                    <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-2">
                      Please tell us more <span className="text-red-500">*</span>
                    </label>
                    <textarea
                      value={customReason}
                      onChange={(e) => setCustomReason(e.target.value)}
                      placeholder="Share your feedback..."
                      rows={3}
                      className="w-full px-4 py-3 rounded-xl border-2 border-neutral-200 focus:border-neutral-900 focus:ring-0 outline-none text-sm resize-none"
                    />
                  </div>
                )}
                
                <div className="flex gap-3">
                  <button
                    onClick={() => setShowCancelModal(false)}
                    disabled={cancelLoading}
                    className="flex-1 py-3 px-4 rounded-xl bg-neutral-900 text-white font-semibold hover:bg-neutral-800 hover:shadow-lg transition-all disabled:opacity-50"
                  >
                    <i className="fas fa-check mr-2 text-amber-400" />
                    Keep Subscription
                  </button>
                  <button
                    onClick={handleCancel}
                    disabled={cancelLoading || !cancelReason || (cancelReason === "other" && !customReason.trim())}
                    className="flex-1 py-3 px-4 rounded-xl border-2 border-red-300 text-red-600 font-semibold hover:bg-red-50 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {cancelLoading ? (
                      <><i className="fas fa-circle-notch fa-spin mr-2" />Cancelling...</>
                    ) : (
                      <><i className="fas fa-times mr-2" />Confirm Cancel</>
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

