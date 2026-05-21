import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { adminDb } from "@/lib/firebaseAdmin";
import { verifyAdminAuth } from "@/lib/authHelpers";

export const runtime = "nodejs";

let _stripe: Stripe;
const getStripe = () => {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key || key.trim() === "") {
    throw new Error("Stripe is not configured. Add STRIPE_SECRET_KEY to your .env.local file.");
  }
  return _stripe || (_stripe = new Stripe(key, { apiVersion: "2025-12-15.clover" }));
};

/**
 * GET /api/billing/status
 * Returns current billing status and information for UI
 * 
 * Returns:
 * - plan: Current plan name
 * - billing_status: trialing | active | past_due | suspended | cancelled
 * - next_billing_date: When next payment is due
 * - payment_required: Boolean flag if payment action needed
 * - downgrade_scheduled: Boolean if downgrade is scheduled
 * - trial_ends_at: When trial ends (if trialing)
 * - grace_until: When grace period ends (if past_due)
 */
export async function GET(req: NextRequest) {
  try {
    const authResult = await verifyAdminAuth(req, undefined, true);
    if (!authResult.success) {
      return NextResponse.json(
        { error: authResult.error },
        { status: authResult.status }
      );
    }

    const { userData } = authResult;
    if (!userData) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const db = adminDb();
    const userId = userData.uid;

    // Get user's billing data
    const userDoc = await db.collection("users").doc(userId).get();
    if (!userDoc.exists) {
      return NextResponse.json(
        { error: "User not found" },
        { status: 404 }
      );
    }

    const userData_db = userDoc.data()!;
    const now = new Date();

    // Determine payment required status
    const billingStatus = userData_db.billing_status || userData_db.subscriptionStatus || "active";
    const paymentRequired = billingStatus === "past_due" || billingStatus === "suspended";

    // Calculate grace period status
    let graceExpired = false;
    if (billingStatus === "past_due" && userData_db.grace_until) {
      const graceUntil = userData_db.grace_until.toDate ? userData_db.grace_until.toDate() : new Date(userData_db.grace_until);
      graceExpired = now > graceUntil;
    }

    // Format dates
    const formatDate = (date: any) => {
      if (!date) return null;
      const d = date.toDate ? date.toDate() : new Date(date);
      if (isNaN(d.getTime())) return null;
      return d.toISOString();
    };

    // Try to get next billing date from Firestore first
    let nextBillingDate = formatDate(userData_db.currentPeriodEnd);
    let trialEndsAt = formatDate(userData_db.trial_end || userData_db.trialEnd);

    // If has Stripe subscription, always try to sync from Stripe for accuracy
    if (userData_db.stripeSubscriptionId) {
      try {
        const subscription = await getStripe().subscriptions.retrieve(userData_db.stripeSubscriptionId);
        const sub = subscription as any;
        // In Stripe API 2025-12-15.clover, current_period_end/start moved to subscription item level
        const firstItem = sub.items?.data?.[0];
        const stripePeriodEnd = firstItem?.current_period_end || sub.current_period_end;
        const stripePeriodStart = firstItem?.current_period_start || sub.current_period_start;

        if (stripePeriodEnd) {
          const periodEnd = new Date(Math.floor(Number(stripePeriodEnd)) * 1000);
          nextBillingDate = periodEnd.toISOString();

          const updateFields: Record<string, any> = {
            currentPeriodEnd: periodEnd,
          };
          if (stripePeriodStart) {
            updateFields.currentPeriodStart = new Date(Math.floor(Number(stripePeriodStart)) * 1000);
          }
          db.collection("users").doc(userId).update(updateFields).catch((err: any) => {
            console.error("[BILLING STATUS] Error saving period dates back to Firestore:", err);
          });
        }

        if (sub.trial_end) {
          trialEndsAt = new Date(Math.floor(Number(sub.trial_end)) * 1000).toISOString();
        }
      } catch (stripeError: any) {
        console.error("[BILLING STATUS] Error fetching subscription from Stripe:", stripeError.message);
      }
    }

    // Fetch branch and staff counts for downgrade eligibility. Previously
    // this loaded **every** branch doc and **every** user doc for the
    // workshop on every subscription-page open — for tenants with large
    // catalogs this single endpoint accounted for a noticeable share of
    // reads. Use Firestore's aggregation `.count()` (admin SDK) which is
    // billed at a tiny fraction of a normal read regardless of result size.
    let branchCount = 0;
    let staffCount = 0;
    const role = (userData_db.role || "").toString();
    if (role === "workshop_owner") {
      try {
        const [branchAgg, staffAgg] = await Promise.all([
          db
            .collection("branches")
            .where("ownerUid", "==", userId)
            .count()
            .get(),
          // Count only billable staff roles directly in Firestore. Previously
          // this read every owner-scoped user row and filtered client-side.
          db
            .collection("users")
            .where("ownerUid", "==", userId)
            .where("role", "in", ["workshop_staff", "branch_admin"])
            .count()
            .get(),
        ]);
        branchCount = branchAgg.data().count;
        staffCount = staffAgg.data().count;
      } catch (usageErr: any) {
        // If aggregation isn't supported (very old SDKs) or the composite
        // index is missing, fall back to the previous full-collection read.
        console.warn(
          "[BILLING STATUS] Count aggregation failed, falling back:",
          usageErr.message
        );
        try {
          const [branchSnap, staffSnap] = await Promise.all([
            db
              .collection("branches")
              .where("ownerUid", "==", userId)
              .limit(500)
              .get(),
            db
              .collection("users")
              .where("ownerUid", "==", userId)
              .limit(500)
              .get(),
          ]);
          branchCount = branchSnap.size;
          staffCount = staffSnap.docs.filter((d) =>
            ["workshop_staff", "branch_admin"].includes(
              (d.data().role || "").toString()
            )
          ).length;
        } catch (e: any) {
          console.error("[BILLING STATUS] Error fetching usage counts:", e.message);
        }
      }
    }

    const response = {
      plan: userData_db.plan || userData_db.planName || "Unknown",
      planId: userData_db.planId || null,
      plan_key: userData_db.plan_key || null,
      price: userData_db.price || null,
      billing_status: billingStatus,
      next_billing_date: nextBillingDate,
      payment_required: paymentRequired,
      downgrade_scheduled: userData_db.downgradeScheduled || false,
      downgrade_effective_date: formatDate(userData_db.downgradeEffectiveDate),
      downgrade_plan_name: userData_db.downgradePlanName || null,
      trial_ends_at: trialEndsAt,
      grace_until: formatDate(userData_db.grace_until),
      grace_expired: graceExpired,
      cancel_at_period_end: userData_db.cancelAtPeriodEnd || false,
      cancellation_date: formatDate(userData_db.currentPeriodEnd) || nextBillingDate,
      stripe_customer_id: userData_db.stripeCustomerId || null,
      stripe_subscription_id: userData_db.stripeSubscriptionId || null,
      branch_count: branchCount,
      staff_count: staffCount,
    };

    return NextResponse.json({
      success: true,
      billing: response,
    });
  } catch (error: any) {
    console.error("[BILLING STATUS] Error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to get billing status" },
      { status: 500 }
    );
  }
}
