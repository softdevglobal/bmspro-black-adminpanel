import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { adminDb } from "@/lib/firebaseAdmin";
import { verifyAdminAuth } from "@/lib/authHelpers";
import { FieldValue, Timestamp } from "firebase-admin/firestore";

export const runtime = "nodejs";

let _stripe: Stripe;
const getStripe = () => _stripe || (_stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: "2025-12-15.clover" }));

/**
 * POST /api/billing/upgrade
 * Upgrades subscription immediately - charges now and restarts 28-day cycle
 * 
 * Input: { newPlanId }
 * 
 * Behavior:
 * - Creates a new price in Stripe for the plan
 * - Updates subscription to new price
 * - Ends any active trial immediately (trial_end = "now")
 * - Sets billing_cycle_anchor = now (restarts cycle today)
 * - proration_behavior = none (no proration, full charge)
 * - Stripe creates invoice immediately and attempts payment
 * - Sets subscription status to "active" (not trial)
 */
export async function POST(req: NextRequest) {
  try {
    const authResult = await verifyAdminAuth(req, ["workshop_owner", "super_admin"], true);
    if (!authResult.success) {
      return NextResponse.json(
        { error: authResult.error },
        { status: authResult.status }
      );
    }

    const { userData } = authResult;
    if (!userData) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const body = await req.json();
    const { newPlanId } = body;

    if (!newPlanId) {
      return NextResponse.json(
        { error: "Missing required field: newPlanId" },
        { status: 400 }
      );
    }

    const db = adminDb();
    const userId = userData.uid;

    // Get the new plan details
    const newPlanDoc = await db.collection("subscription_plans").doc(newPlanId).get();
    if (!newPlanDoc.exists) {
      return NextResponse.json(
        { error: "Plan not found" },
        { status: 404 }
      );
    }

    const newPlanData = newPlanDoc.data()!;
    if (!newPlanData.price || newPlanData.price <= 0) {
      return NextResponse.json(
        { error: "Plan does not have a valid price" },
        { status: 400 }
      );
    }

    // Get user's current subscription
    const userDoc = await db.collection("users").doc(userId).get();
    if (!userDoc.exists) {
      return NextResponse.json(
        { error: "User not found" },
        { status: 404 }
      );
    }

    const userData_db = userDoc.data()!;
    const subscriptionId = userData_db.stripeSubscriptionId;

    if (!subscriptionId) {
      return NextResponse.json(
        { error: "No active subscription found" },
        { status: 400 }
      );
    }

    // Get current subscription from Stripe
    const subscription = await getStripe().subscriptions.retrieve(subscriptionId);
    const subscriptionItemId = subscription.items.data[0]?.id;

    if (!subscriptionItemId) {
      return NextResponse.json(
        { error: "Subscription item not found" },
        { status: 400 }
      );
    }

    // Release any existing subscription schedule before upgrading
    const existingScheduleId = (subscription as any).schedule 
      ? (typeof (subscription as any).schedule === "string" ? (subscription as any).schedule : (subscription as any).schedule.id) 
      : userData_db.stripeScheduleId;

    if (existingScheduleId) {
      try {
        console.log(`[BILLING UPGRADE] Releasing existing schedule ${existingScheduleId} before upgrade`);
        await getStripe().subscriptionSchedules.release(existingScheduleId);
      } catch (releaseErr: any) {
        console.log("[BILLING UPGRADE] Could not release schedule (may already be released):", releaseErr.message);
      }
    }

    // Create a new price in Stripe for this plan
    const newPrice = await getStripe().prices.create({
      currency: "aud",
      unit_amount: Math.round(newPlanData.price * 100), // Convert to cents
      recurring: {
        interval: "day",
        interval_count: 28, // 28-day billing cycle
      },
      product_data: {
        name: newPlanData.name || "BMS Pro Subscription",
        metadata: {
          planId: newPlanId,
          plan_key: newPlanData.plan_key || "",
        },
      },
      metadata: {
        planId: newPlanId,
        plan_key: newPlanData.plan_key || "",
      },
    });

    // Update subscription: end any trial, immediate charge + restart cycle
    await getStripe().subscriptions.update(subscriptionId, {
      items: [{
        id: subscriptionItemId,
        price: newPrice.id,
      }],
      trial_end: "now", // End trial immediately - upgrade activates the package directly
      billing_cycle_anchor: "now", // Restart cycle today
      proration_behavior: "none", // No proration, full charge
      metadata: {
        ...subscription.metadata,
        upgraded_at: new Date().toISOString(),
        previous_plan_id: userData_db.planId || "",
        planId: newPlanId,
        planName: newPlanData.name,
      },
    });

    // Retrieve updated subscription to get latest period dates
    const updatedSubscription = await getStripe().subscriptions.retrieve(subscriptionId);
    const updatedSub = updatedSubscription as any;
    const updatedFirstItem = updatedSub.items?.data?.[0];

    // In Stripe API 2025-12-15.clover, current_period_end/start moved to subscription item level
    const periodEndUnix = updatedFirstItem?.current_period_end || updatedSub.current_period_end;
    const periodStartUnix = updatedFirstItem?.current_period_start || updatedSub.current_period_start;

    // Convert to Firestore Timestamps safely (ensure integer seconds)
    const currentPeriodEnd = periodEndUnix
      ? Timestamp.fromMillis(Math.floor(Number(periodEndUnix)) * 1000)
      : Timestamp.now();
    const currentPeriodStart = periodStartUnix
      ? Timestamp.fromMillis(Math.floor(Number(periodStartUnix)) * 1000)
      : Timestamp.now();

    // Update Firestore - set as active (not trialing)
    const updateData: Record<string, any> = {
      stripePriceId: newPrice.id,
      planId: newPlanId,
      plan: newPlanData.name,
      plan_key: newPlanData.plan_key || newPlanId,
      price: newPlanData.priceLabel || `AU$${newPlanData.price}/mo`,
      currentPeriodEnd: currentPeriodEnd,
      currentPeriodStart: currentPeriodStart,
      // Set status to active (upgrade = no trial)
      subscriptionStatus: "active",
      billing_status: "active",
      accountStatus: "active",
      // Clear trial-related fields
      trial_end: FieldValue.delete(),
      trialEnd: FieldValue.delete(),
      trialEndDate: FieldValue.delete(),
      hasFreeTrial: FieldValue.delete(),
      // Clear downgrade-related fields (upgrade cancels any pending downgrade)
      stripeScheduleId: FieldValue.delete(),
      downgradeScheduled: false,
      downgradePlanId: FieldValue.delete(),
      downgradePriceId: FieldValue.delete(),
      downgradeEffectiveDate: FieldValue.delete(),
      downgradePlanKey: FieldValue.delete(),
      downgradePlanName: FieldValue.delete(),
      downgradePlanPrice: FieldValue.delete(),
      downgradeBranchLimit: FieldValue.delete(),
      downgradeStaffLimit: FieldValue.delete(),
      // Update plan limits
      branchLimit: newPlanData.branches ?? -1,
      staffLimit: newPlanData.staff ?? -1,
      updatedAt: Timestamp.now(),
    };

    await db.collection("users").doc(userId).update(updateData);

    // Also update owners collection if exists
    const ownerDoc = await db.collection("owners").doc(userId).get();
    if (ownerDoc.exists) {
      await db.collection("owners").doc(userId).update(updateData);
    }

    console.log(`[BILLING] User ${userId} upgraded to plan ${newPlanId} (${newPlanData.name}) - trial ended, status set to active`);

    return NextResponse.json({
      success: true,
      message: "Upgrade initiated. Payment will be processed immediately.",
      subscription: {
        id: updatedSub.id,
        status: updatedSub.status,
        currentPeriodEnd: periodEndUnix
          ? new Date(Math.floor(Number(periodEndUnix)) * 1000).toISOString()
          : new Date().toISOString(),
      },
    });
  } catch (error: any) {
    console.error("[BILLING UPGRADE] Error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to upgrade subscription" },
      { status: 500 }
    );
  }
}
