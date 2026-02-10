import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { adminDb, adminAuth } from "@/lib/firebaseAdmin";

export const runtime = "nodejs";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2025-12-15.clover",
});

/**
 * POST /api/stripe/verify-session
 * Verifies a checkout session and updates user status
 * This is a fallback in case webhook didn't fire
 */
export async function POST(req: NextRequest) {
  try {
    // Verify authentication
    const authHeader = req.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const token = authHeader.split("Bearer ")[1];
    const auth = adminAuth();
    
    let decodedToken;
    try {
      decodedToken = await auth.verifyIdToken(token);
    } catch (authError) {
      return NextResponse.json({ error: "Invalid token" }, { status: 401 });
    }

    const userId = decodedToken.uid;
    const body = await req.json();
    const { sessionId } = body;

    if (!sessionId) {
      return NextResponse.json({ error: "Missing sessionId" }, { status: 400 });
    }

    const db = adminDb();

    // Get the checkout session from Stripe
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    
    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    // Verify the session belongs to this user
    if (session.metadata?.firebaseUid !== userId) {
      return NextResponse.json({ error: "Session does not belong to this user" }, { status: 403 });
    }

    // Check if payment was successful
    if (session.payment_status !== "paid" && session.status !== "complete") {
      return NextResponse.json({ 
        error: "Payment not completed",
        sessionStatus: session.status,
        paymentStatus: session.payment_status 
      }, { status: 400 });
    }

    const subscriptionId = session.subscription as string;
    const customerId = session.customer as string;

    if (!subscriptionId) {
      return NextResponse.json({ error: "No subscription in session" }, { status: 400 });
    }

    // Get subscription details from Stripe
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    const sub = subscription as any;
    const priceId = sub.items.data[0]?.price?.id;
    
    // Check if subscription has a trial period
    const now = Math.floor(Date.now() / 1000);
    const hasTrialEnd = sub.trial_end && sub.trial_end > now;
    const isTrialing = sub.status === "trialing" || hasTrialEnd;

    console.log("[VERIFY SESSION] Subscription status:", sub.status, "trial_end:", sub.trial_end, "isTrialing:", isTrialing);

    // Safely convert timestamps
    const safeTimestamp = (ts: any): Date | null => {
      if (!ts) return null;
      const seconds = typeof ts === 'number' ? ts : parseInt(ts, 10);
      if (isNaN(seconds)) return null;
      return new Date(seconds * 1000);
    };

    // Update user in Firestore
    const updateData: any = {
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscriptionId,
      stripePriceId: priceId,
      subscriptionStatus: sub.status,
      billing_status: isTrialing ? "trialing" : (sub.status === "active" ? "active" : "pending"),
      accountStatus: isTrialing || sub.status === "active" ? "active" : "pending_payment",
      status: isTrialing ? "Trial" : (sub.status === "active" ? "Active" : "Pending Payment"),
      cancelAtPeriodEnd: sub.cancel_at_period_end || false,
      updatedAt: new Date(),
    };

    // Add period dates if valid
    const periodStart = safeTimestamp(sub.current_period_start);
    const periodEnd = safeTimestamp(sub.current_period_end);
    if (periodStart) updateData.currentPeriodStart = periodStart;
    if (periodEnd) updateData.currentPeriodEnd = periodEnd;

    // Set trial end if subscription has trial period
    const trialEnd = safeTimestamp(sub.trial_end);
    if (trialEnd) {
      updateData.trial_end = trialEnd;
    }

    // Add metadata from session
    if (session.metadata?.planId) {
      updateData.planId = session.metadata.planId;
    }
    if (session.metadata?.planName) {
      updateData.plan = session.metadata.planName;
    }

    // Update users collection
    await db.collection("users").doc(userId).update(updateData);

    // Also update owners collection if exists
    const ownerDoc = await db.collection("owners").doc(userId).get();
    if (ownerDoc.exists) {
      await db.collection("owners").doc(userId).update(updateData);
    }

    console.log(`[VERIFY SESSION] User ${userId} status updated to: ${updateData.billing_status}`);

    return NextResponse.json({
      success: true,
      message: "Subscription verified and status updated",
      status: updateData.billing_status,
      isTrialing: isTrialing,
      trialEnd: trialEnd ? trialEnd.toISOString() : null,
    });
  } catch (error: any) {
    console.error("[VERIFY SESSION] Error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to verify session" },
      { status: 500 }
    );
  }
}
