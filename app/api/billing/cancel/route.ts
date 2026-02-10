import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { adminDb } from "@/lib/firebaseAdmin";
import { verifyAdminAuth } from "@/lib/authHelpers";

export const runtime = "nodejs";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2025-12-15.clover",
});

/**
 * POST /api/billing/cancel
 * Cancels subscription at end of current billing period
 * 
 * Input: (none - uses authenticated user)
 * 
 * Behavior:
 * - Sets cancel_at_period_end = true
 * - Access continues until current_period_end
 * - Subscription deletes automatically at period end
 * - Webhook will fire customer.subscription.deleted
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

    // Parse request body for cancellation reason
    let reason = "";
    try {
      const body = await req.json();
      reason = body.reason || "";
    } catch {
      // No body provided, reason is optional
    }

    const { userData } = authResult;
    const db = adminDb();
    const userId = userData.uid;

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

    if (subscription.cancel_at_period_end) {
      return NextResponse.json(
        { error: "Subscription is already scheduled for cancellation" },
        { status: 400 }
      );
    }

    // Cancel at period end
    await stripe.subscriptions.update(subscriptionId, {
      cancel_at_period_end: true,
      metadata: {
        ...subscription.metadata,
        cancelled_at: new Date().toISOString(),
        cancellation_reason: reason || "Not provided",
      },
    });

    // Update Firestore
    const updateData: any = {
      cancelAtPeriodEnd: true,
      cancellationRequestedAt: new Date(),
      cancellationReason: reason || null,
      updatedAt: new Date(),
    };

    await db.collection("users").doc(userId).update(updateData);

    // Also update owners collection if exists
    const ownerDoc = await db.collection("owners").doc(userId).get();
    if (ownerDoc.exists) {
      await db.collection("owners").doc(userId).update(updateData);
    }

    // Save cancellation record for analytics
    await db.collection("subscription_cancellations").add({
      userId: userId,
      userEmail: userData_db.email || null,
      userName: userData_db.name || userData_db.displayName || null,
      plan: userData_db.plan || null,
      subscriptionId: subscriptionId,
      reason: reason || "Not provided",
      cancelledAt: new Date(),
      accessEndsAt: (subscription as any).current_period_end 
        ? new Date((subscription as any).current_period_end * 1000)
        : null,
    });

    // Use the subscription object we already retrieved (it has current_period_end)
    const currentPeriodEnd = (subscription as any).current_period_end 
      ? new Date((subscription as any).current_period_end * 1000).toISOString()
      : null;

    console.log(`[BILLING] User ${userId} cancelled subscription. Reason: ${reason || 'Not provided'}. Access until ${currentPeriodEnd || 'end of period'}`);

    return NextResponse.json({
      success: true,
      message: "Subscription cancelled. Access will continue until the end of your current billing period.",
      subscription: {
        id: subscription.id,
        cancelAtPeriodEnd: true,
        currentPeriodEnd: currentPeriodEnd,
      },
    });
  } catch (error: any) {
    console.error("[BILLING CANCEL] Error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to cancel subscription" },
      { status: 500 }
    );
  }
}
