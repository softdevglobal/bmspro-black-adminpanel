import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";
import { verifyAdminAuth } from "@/lib/authHelpers";

export const runtime = "nodejs";

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
      return d.toISOString();
    };

    const response = {
      plan: userData_db.plan || userData_db.planName || "Unknown",
      plan_key: userData_db.plan_key || null,
      billing_status: billingStatus,
      next_billing_date: formatDate(userData_db.currentPeriodEnd),
      payment_required: paymentRequired,
      downgrade_scheduled: userData_db.downgradeScheduled || false,
      downgrade_effective_date: formatDate(userData_db.downgradeEffectiveDate),
      downgrade_plan_name: userData_db.downgradePlanName || null,
      trial_ends_at: formatDate(userData_db.trial_end || userData_db.trialEnd),
      grace_until: formatDate(userData_db.grace_until),
      grace_expired: graceExpired,
      cancel_at_period_end: userData_db.cancelAtPeriodEnd || false,
      cancellation_date: formatDate(userData_db.currentPeriodEnd),
      stripe_customer_id: userData_db.stripeCustomerId || null,
      stripe_subscription_id: userData_db.stripeSubscriptionId || null,
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
