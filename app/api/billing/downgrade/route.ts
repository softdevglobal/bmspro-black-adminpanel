import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { adminDb } from "@/lib/firebaseAdmin";
import { verifyAdminAuth } from "@/lib/authHelpers";

export const runtime = "nodejs";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2025-12-15.clover",
});

/**
 * POST /api/billing/downgrade
 * Schedules downgrade to apply at end of current billing cycle
 * 
 * Input: { newPlanId }
 * 
 * Behavior:
 * - Creates/updates Subscription Schedule
 * - Phase 1: Current price until current_period_end
 * - Phase 2: New price starting at current_period_end
 * - No immediate charge or change
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
    const currentPriceId = (subscription as any).items.data[0]?.price?.id;
    const currentPeriodEnd = (subscription as any).current_period_end;

    if (!currentPriceId) {
      return NextResponse.json(
        { error: "Subscription price not found" },
        { status: 400 }
      );
    }

    // Create a new price in Stripe for the downgrade plan
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

    // Check if subscription already has a schedule
    let scheduleId = userData_db.stripeScheduleId;

    if (scheduleId) {
      try {
        // Try to update existing schedule
        const schedule = await stripe.subscriptionSchedules.retrieve(scheduleId);
        
        await stripe.subscriptionSchedules.update(scheduleId, {
          phases: [
            {
              items: [{ price: currentPriceId, quantity: 1 }],
              start_date: (subscription as any).current_period_start,
              end_date: currentPeriodEnd,
            },
            {
              items: [{ price: newPrice.id, quantity: 1 }],
              start_date: currentPeriodEnd,
            },
          ],
          metadata: {
            ...schedule.metadata,
            downgraded_at: new Date().toISOString(),
            new_plan_id: newPlanId,
          },
        });
      } catch (e) {
        // Schedule doesn't exist or is invalid, create new one
        scheduleId = null;
      }
    }
    
    if (!scheduleId) {
      // Create new schedule from the subscription
      const schedule = await stripe.subscriptionSchedules.create({
        from_subscription: subscriptionId,
      });

      // Update the schedule with phases
      await stripe.subscriptionSchedules.update(schedule.id, {
        end_behavior: "release",
        phases: [
          {
            items: [{ price: currentPriceId, quantity: 1 }],
            start_date: (subscription as any).current_period_start,
            end_date: currentPeriodEnd,
          },
          {
            items: [{ price: newPrice.id, quantity: 1 }],
            start_date: currentPeriodEnd,
          },
        ],
        metadata: {
          firebaseUid: userId,
          downgraded_at: new Date().toISOString(),
          new_plan_id: newPlanId,
        },
      });

      scheduleId = schedule.id;
    }

    // Update Firestore - store scheduled downgrade info including future limits
    const updateData: any = {
      stripeScheduleId: scheduleId,
      downgradeScheduled: true,
      downgradePlanId: newPlanId,
      downgradePriceId: newPrice.id,
      downgradeEffectiveDate: new Date(currentPeriodEnd * 1000),
      downgradePlanKey: newPlanData.plan_key || newPlanId,
      downgradePlanName: newPlanData.name,
      downgradePlanPrice: newPlanData.priceLabel || `AU$${newPlanData.price}/mo`,
      // Store future limits (will be applied when downgrade takes effect)
      downgradeBranchLimit: newPlanData.branches ?? -1,
      downgradeStaffLimit: newPlanData.staff ?? -1,
      updatedAt: new Date(),
    };

    await db.collection("users").doc(userId).update(updateData);

    // Also update owners collection if exists
    const ownerDoc = await db.collection("owners").doc(userId).get();
    if (ownerDoc.exists) {
      await db.collection("owners").doc(userId).update(updateData);
    }

    console.log(`[BILLING] User ${userId} scheduled downgrade to plan ${newPlanId} at ${new Date(currentPeriodEnd * 1000).toISOString()}`);

    return NextResponse.json({
      success: true,
      message: "Downgrade scheduled. Plan will change at the end of your current billing cycle.",
      schedule: {
        id: scheduleId,
        effectiveDate: new Date(currentPeriodEnd * 1000).toISOString(),
        newPlan: newPlanData.name,
      },
    });
  } catch (error: any) {
    console.error("[BILLING DOWNGRADE] Error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to schedule downgrade" },
      { status: 500 }
    );
  }
}
