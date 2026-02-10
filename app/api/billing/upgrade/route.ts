import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { adminDb } from "@/lib/firebaseAdmin";
import { verifyAdminAuth } from "@/lib/authHelpers";

export const runtime = "nodejs";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2025-12-15.clover",
});

/**
 * POST /api/billing/upgrade
 * Upgrades subscription immediately - charges now and restarts 28-day cycle
 * 
 * Input: { newPlanId }
 * 
 * Behavior:
 * - Creates a new price in Stripe for the plan
 * - Updates subscription to new price
 * - Sets billing_cycle_anchor = now (restarts cycle today)
 * - proration_behavior = none (no proration, full charge)
 * - Stripe creates invoice immediately and attempts payment
 */
export async function POST(req: NextRequest) {
  try {
    const authResult = await verifyAdminAuth(req, ["salon_owner", "super_admin"], true);
    if (!authResult.success) {
      return NextResponse.json(
        { error: authResult.error },
        { status: authResult.status }
      );
    }

    const { userData } = authResult;
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
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    const subscriptionItemId = subscription.items.data[0]?.id;

    if (!subscriptionItemId) {
      return NextResponse.json(
        { error: "Subscription item not found" },
        { status: 400 }
      );
    }

    // Create a new price in Stripe for this plan
    const newPrice = await stripe.prices.create({
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

    // Update subscription: immediate charge + restart cycle
    await stripe.subscriptions.update(subscriptionId, {
      items: [{
        id: subscriptionItemId,
        price: newPrice.id,
      }],
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
    const updatedSubscription = await stripe.subscriptions.retrieve(subscriptionId);

    // Update Firestore
    const updateData: any = {
      stripePriceId: newPrice.id,
      planId: newPlanId,
      plan: newPlanData.name,
      plan_key: newPlanData.plan_key || newPlanId,
      price: newPlanData.priceLabel || `AU$${newPlanData.price}/mo`,
      currentPeriodEnd: new Date((updatedSubscription as any).current_period_end * 1000),
      currentPeriodStart: new Date((updatedSubscription as any).current_period_start * 1000),
      // Update plan limits
      branchLimit: newPlanData.branches ?? -1,
      staffLimit: newPlanData.staff ?? -1,
      updatedAt: new Date(),
    };

    await db.collection("users").doc(userId).update(updateData);

    // Also update owners collection if exists
    const ownerDoc = await db.collection("owners").doc(userId).get();
    if (ownerDoc.exists) {
      await db.collection("owners").doc(userId).update(updateData);
    }

    console.log(`[BILLING] User ${userId} upgraded to plan ${newPlanId} (${newPlanData.name})`);

    return NextResponse.json({
      success: true,
      message: "Upgrade initiated. Payment will be processed immediately.",
      subscription: {
        id: (updatedSubscription as any).id,
        status: (updatedSubscription as any).status,
        currentPeriodEnd: new Date((updatedSubscription as any).current_period_end * 1000).toISOString(),
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
