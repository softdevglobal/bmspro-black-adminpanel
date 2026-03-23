import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { adminDb } from "@/lib/firebaseAdmin";
import { verifyAdminAuth } from "@/lib/authHelpers";

export const runtime = "nodejs";

let _stripe: Stripe;
const getStripe = () => _stripe || (_stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: "2025-12-15.clover" }));


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

    // Validate downgrade eligibility: current usage must not exceed target plan limits
    const targetBranchLimit = newPlanData.branches ?? -1;
    const targetStaffLimit = newPlanData.staff ?? -1;
    if (targetBranchLimit !== -1 || targetStaffLimit !== -1) {
      const [branchSnap, staffSnap] = await Promise.all([
        db.collection("branches").where("ownerUid", "==", userId).get(),
        db.collection("users").where("ownerUid", "==", userId).get(),
      ]);
      const branchCount = branchSnap.size;
      const staffCount = staffSnap.docs.filter(
        (d) => ["workshop_staff", "branch_admin"].includes((d.data().role || "").toString())
      ).length;

      const branchesExceeded = targetBranchLimit !== -1 && branchCount > targetBranchLimit;
      const staffExceeded = targetStaffLimit !== -1 && staffCount > targetStaffLimit;

      if (branchesExceeded || staffExceeded) {
        const parts: string[] = [];
        if (branchesExceeded) {
          parts.push(`branches (${branchCount} current vs ${targetBranchLimit} allowed)`);
        }
        if (staffExceeded) {
          parts.push(`staff (${staffCount} current vs ${targetStaffLimit} allowed)`);
        }
        return NextResponse.json(
          {
            error: `Cannot downgrade: your current usage exceeds the plan limits. ${parts.join(" and ")}. Please reduce your usage or contact admin@bmspros.com.au for assistance.`,
            code: "LIMITS_EXCEEDED",
            branchCount,
            staffCount,
            branchLimit: targetBranchLimit,
            staffLimit: targetStaffLimit,
          },
          { status: 400 }
        );
      }
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
    const sub = subscription as any;
    const firstItem = sub.items?.data?.[0];
    const currentPriceId = firstItem?.price?.id;
    // In Stripe API 2025-12-15.clover, current_period_end/start moved to subscription item level
    const currentPeriodEnd = firstItem?.current_period_end || sub.current_period_end;
    const currentPeriodStart = firstItem?.current_period_start || sub.current_period_start;

    console.log(`[BILLING DOWNGRADE] Subscription item current_period_end: ${currentPeriodEnd}, current_period_start: ${currentPeriodStart}`);

    if (!currentPriceId) {
      return NextResponse.json(
        { error: "Subscription price not found" },
        { status: 400 }
      );
    }

    if (!currentPeriodEnd) {
      return NextResponse.json(
        { error: "Cannot determine current billing period" },
        { status: 400 }
      );
    }

    // Create a new price in Stripe for the downgrade plan
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

    // Check if subscription already has a schedule
    let scheduleId = userData_db.stripeScheduleId;

    // Also check if the subscription has a schedule attached in Stripe
    const stripeAttachedScheduleId = sub.schedule 
      ? (typeof sub.schedule === "string" ? sub.schedule : sub.schedule.id) 
      : null;

    if (!scheduleId && stripeAttachedScheduleId) {
      console.log(`[BILLING DOWNGRADE] Found schedule ${stripeAttachedScheduleId} attached to subscription (not in Firestore)`);
      scheduleId = stripeAttachedScheduleId;
    }

    if (scheduleId) {
      try {
        const schedule = await getStripe().subscriptionSchedules.retrieve(scheduleId);
        
        if (schedule.status === "active" || schedule.status === "not_started") {
          console.log(`[BILLING DOWNGRADE] Updating existing schedule ${scheduleId}`);
          await getStripe().subscriptionSchedules.update(scheduleId, {
            phases: [
              {
                items: [{ price: currentPriceId, quantity: 1 }],
                start_date: currentPeriodStart,
                end_date: currentPeriodEnd,
              },
              {
                items: [{ price: newPrice.id, quantity: 1 }],
                start_date: currentPeriodEnd,
              },
            ],
            end_behavior: "release",
            metadata: {
              ...schedule.metadata,
              downgraded_at: new Date().toISOString(),
              new_plan_id: newPlanId,
            },
          });
        } else {
          console.log(`[BILLING DOWNGRADE] Schedule ${scheduleId} status is ${schedule.status}, releasing and creating new`);
          try {
            await getStripe().subscriptionSchedules.release(scheduleId);
          } catch (releaseErr) {
            console.log("[BILLING DOWNGRADE] Could not release schedule (may already be released):", releaseErr);
          }
          scheduleId = null;
        }
      } catch (e) {
        console.error("[BILLING DOWNGRADE] Error updating existing schedule:", e);
        try {
          await getStripe().subscriptionSchedules.release(scheduleId);
          console.log(`[BILLING DOWNGRADE] Released stale schedule ${scheduleId}`);
        } catch (releaseErr) {
          console.log("[BILLING DOWNGRADE] Could not release stale schedule:", releaseErr);
        }
        scheduleId = null;
      }
    }
    
    if (!scheduleId) {
      console.log(`[BILLING DOWNGRADE] Creating new schedule from subscription ${subscriptionId}`);
      const schedule = await getStripe().subscriptionSchedules.create({
        from_subscription: subscriptionId,
      });

      await getStripe().subscriptionSchedules.update(schedule.id, {
        end_behavior: "release",
        phases: [
          {
            items: [{ price: currentPriceId, quantity: 1 }],
            start_date: currentPeriodStart,
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
    const effectiveDate = currentPeriodEnd 
      ? new Date(Math.floor(Number(currentPeriodEnd)) * 1000) 
      : new Date();

    const updateData: Record<string, any> = {
      stripeScheduleId: scheduleId,
      downgradeScheduled: true,
      downgradePlanId: newPlanId,
      downgradePriceId: newPrice.id,
      downgradeEffectiveDate: effectiveDate,
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

    console.log(`[BILLING] User ${userId} scheduled downgrade to plan ${newPlanId} at ${effectiveDate.toISOString()}`);

    return NextResponse.json({
      success: true,
      message: "Downgrade scheduled. Plan will change at the end of your current billing cycle.",
      schedule: {
        id: scheduleId,
        effectiveDate: effectiveDate.toISOString(),
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
