import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { adminDb } from "@/lib/firebaseAdmin";

export const runtime = "nodejs";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2025-12-15.clover",
});

const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET!;

// Grace period in days (3 days recommended)
const GRACE_DAYS = 3;

/**
 * Check if event has already been processed (idempotency)
 */
async function isEventProcessed(db: FirebaseFirestore.Firestore, eventId: string): Promise<boolean> {
  const eventDoc = await db.collection("stripe_events").doc(eventId).get();
  return eventDoc.exists;
}

/**
 * Mark event as processed
 */
async function markEventProcessed(
  db: FirebaseFirestore.Firestore,
  eventId: string,
  eventType: string
): Promise<void> {
  await db.collection("stripe_events").doc(eventId).set({
    event_id: eventId,
    event_type: eventType,
    processed_at: new Date(),
  });
}

/**
 * Find user by subscription ID
 */
async function findUserBySubscriptionId(
  db: FirebaseFirestore.Firestore,
  subscriptionId: string
): Promise<string | null> {
  const usersSnapshot = await db
    .collection("users")
    .where("stripeSubscriptionId", "==", subscriptionId)
    .limit(1)
    .get();

  if (!usersSnapshot.empty) {
    return usersSnapshot.docs[0].id;
  }

  // Also check owners collection
  const ownersSnapshot = await db
    .collection("owners")
    .where("stripeSubscriptionId", "==", subscriptionId)
    .limit(1)
    .get();

  if (!ownersSnapshot.empty) {
    return ownersSnapshot.docs[0].id;
  }

  return null;
}

/**
 * Update user billing data in both users and owners collections
 */
async function updateUserBilling(
  db: FirebaseFirestore.Firestore,
  userId: string,
  updateData: any
): Promise<void> {
  await db.collection("users").doc(userId).update(updateData);

  const ownerDoc = await db.collection("owners").doc(userId).get();
  if (ownerDoc.exists) {
    await db.collection("owners").doc(userId).update(updateData);
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.text();
    const signature = req.headers.get("stripe-signature");

    if (!signature) {
      console.error("[WEBHOOK] Missing stripe-signature header");
      return NextResponse.json(
        { error: "Missing stripe-signature header" },
        { status: 400 }
      );
    }

    let event: Stripe.Event;

    try {
      event = stripe.webhooks.constructEvent(body, signature, webhookSecret);
    } catch (err: any) {
      console.error("[WEBHOOK] Signature verification failed:", err.message);
      return NextResponse.json(
        { error: `Webhook signature verification failed: ${err.message}` },
        { status: 400 }
      );
    }

    const db = adminDb();

    // Idempotency check - skip if already processed
    if (await isEventProcessed(db, event.id)) {
      console.log(`[WEBHOOK] Event ${event.id} already processed, skipping`);
      return NextResponse.json({ received: true, skipped: true });
    }

    // Handle the event
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        await handleCheckoutCompleted(db, session);
        break;
      }

      case "invoice.payment_succeeded": {
        const invoice = event.data.object as Stripe.Invoice;
        await handlePaymentSucceeded(db, invoice);
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        await handlePaymentFailed(db, invoice);
        break;
      }

      case "customer.subscription.updated": {
        const subscription = event.data.object as Stripe.Subscription;
        await handleSubscriptionUpdated(db, subscription);
        break;
      }

      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription;
        await handleSubscriptionDeleted(db, subscription);
        break;
      }

      default:
        console.log(`[WEBHOOK] Unhandled event type: ${event.type}`);
    }

    // Mark event as processed
    await markEventProcessed(db, event.id, event.type);

    return NextResponse.json({ received: true });
  } catch (error: any) {
    console.error("[WEBHOOK] Error:", error);
    return NextResponse.json(
      { error: error.message || "Webhook handler failed" },
      { status: 500 }
    );
  }
}

/**
 * checkout.session.completed
 * Save stripe IDs, set billing_status = trialing (if trial) or pending
 */
async function handleCheckoutCompleted(
  db: FirebaseFirestore.Firestore,
  session: Stripe.Checkout.Session
) {
  console.log("[WEBHOOK] Checkout completed:", session.id);

  const firebaseUid = session.metadata?.firebaseUid;
  if (!firebaseUid) {
    console.error("[WEBHOOK] Missing firebaseUid in session metadata");
    return;
  }

  const subscriptionId = session.subscription as string;
  const customerId = session.customer as string;

  if (!subscriptionId) {
    console.error("[WEBHOOK] No subscription ID in checkout session");
    return;
  }

  // Get subscription details from Stripe
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const sub = subscription as any;
  const priceId = sub.items?.data[0]?.price?.id;
  
  // Check if subscription has a trial period (trial_end exists and is in the future)
  const now = Math.floor(Date.now() / 1000);
  const hasTrialEnd = sub.trial_end && sub.trial_end > now;
  const isTrialing = sub.status === "trialing" || hasTrialEnd;
  
  console.log("[WEBHOOK] Subscription status:", sub.status, "trial_end:", sub.trial_end, "isTrialing:", isTrialing);

  const updateData: any = {
    stripeCustomerId: customerId,
    stripeSubscriptionId: subscriptionId,
    stripePriceId: priceId,
    subscriptionStatus: sub.status,
    billing_status: isTrialing ? "trialing" : "pending", // Will become active when invoice paid
    // Activate account for trialing users (they can access dashboard during trial)
    accountStatus: isTrialing ? "active" : "pending_payment",
    status: isTrialing ? "Trial" : "Pending Payment",
    currentPeriodStart: new Date(sub.current_period_start * 1000),
    currentPeriodEnd: new Date(sub.current_period_end * 1000),
    cancelAtPeriodEnd: sub.cancel_at_period_end || false,
    updatedAt: new Date(),
  };

  // Set trial end if subscription has trial period
  if (sub.trial_end) {
    updateData.trial_end = new Date(sub.trial_end * 1000);
  }

  // Get plan details from subscription_plans if priceId matches
  if (priceId) {
    const plansSnapshot = await db
      .collection("subscription_plans")
      .where("stripePriceId", "==", priceId)
      .limit(1)
      .get();

    if (!plansSnapshot.empty) {
      const planData = plansSnapshot.docs[0].data();
      updateData.plan_key = planData.plan_key || plansSnapshot.docs[0].id;
      updateData.plan = planData.name;
      updateData.planId = plansSnapshot.docs[0].id;
      updateData.price = planData.priceLabel || null;
      // Update limits from new plan
      if (planData.branches !== undefined) {
        updateData.branchLimit = planData.branches;
      }
      if (planData.staff !== undefined) {
        updateData.staffLimit = planData.staff;
      }
    }
  }

  // Add metadata from session
  if (session.metadata?.planId) {
    updateData.planId = session.metadata.planId;
  }
  if (session.metadata?.planName) {
    updateData.plan = session.metadata.planName;
  }

  await updateUserBilling(db, firebaseUid, updateData);

  console.log(`[WEBHOOK] User ${firebaseUid} checkout completed, status: ${updateData.billing_status}`);
}

/**
 * invoice.payment_succeeded
 * Set billing_status = active, clear grace_until, update period dates
 */
async function handlePaymentSucceeded(
  db: FirebaseFirestore.Firestore,
  invoice: Stripe.Invoice
) {
  const inv = invoice as any;
  console.log("[WEBHOOK] Payment succeeded:", inv.id);

  if (!inv.subscription) {
    console.log("[WEBHOOK] Invoice has no subscription, skipping");
    return;
  }

  const userId = await findUserBySubscriptionId(db, inv.subscription as string);
  if (!userId) {
    console.error("[WEBHOOK] Could not find user for invoice:", inv.id);
    return;
  }

  // Get subscription to get current price
  const subscription = await stripe.subscriptions.retrieve(inv.subscription as string);
  const sub = subscription as any;
  const priceId = sub.items?.data[0]?.price?.id;

  const updateData: any = {
    billing_status: "active",
    subscriptionStatus: sub.status,
    stripePriceId: priceId,
    currentPeriodStart: new Date(sub.current_period_start * 1000),
    currentPeriodEnd: new Date(sub.current_period_end * 1000),
    last_invoice_id: inv.id,
    lastPaymentDate: new Date(),
    lastPaymentAmount: inv.amount_paid / 100, // Convert from cents
    grace_until: null, // Clear grace period
    accountStatus: "active",
    suspendedReason: null,
    suspendedAt: null,
    updatedAt: new Date(),
  };

  // Clear trial_end if trial ended
  if (sub.status === "active" && sub.trial_end) {
    const trialEnd = new Date(sub.trial_end * 1000);
    if (new Date() > trialEnd) {
      updateData.trial_end = null;
    }
  }

  await updateUserBilling(db, userId, updateData);

  console.log(`[WEBHOOK] User ${userId} payment succeeded, status: active`);
}

/**
 * invoice.payment_failed
 * Set billing_status = past_due, set grace_until = now + GRACE_DAYS
 */
async function handlePaymentFailed(
  db: FirebaseFirestore.Firestore,
  invoice: Stripe.Invoice
) {
  const inv = invoice as any;
  console.log("[WEBHOOK] Payment failed:", inv.id);

  if (!inv.subscription) {
    console.log("[WEBHOOK] Invoice has no subscription, skipping");
    return;
  }

  const userId = await findUserBySubscriptionId(db, inv.subscription as string);
  if (!userId) {
    console.error("[WEBHOOK] Could not find user for failed invoice:", inv.id);
    return;
  }

  // Calculate grace period end (3 days from now)
  const graceUntil = new Date();
  graceUntil.setDate(graceUntil.getDate() + GRACE_DAYS);

  const updateData: any = {
    billing_status: "past_due",
    subscriptionStatus: "past_due",
    last_invoice_id: inv.id,
    grace_until: graceUntil,
    paymentFailureReason: inv.last_payment_error?.message || "Payment failed",
    updatedAt: new Date(),
  };

  // Don't suspend immediately - set past_due and grace period
  // Suspension will happen automatically when grace expires

  await updateUserBilling(db, userId, updateData);

  console.log(`[WEBHOOK] User ${userId} payment failed, status: past_due, grace until: ${graceUntil.toISOString()}`);
}

/**
 * customer.subscription.updated
 * Sync current_period_end, trial_end, cancel_at_period_end flag
 * Do NOT grant access unless invoice paid (check billing_status)
 */
async function handleSubscriptionUpdated(
  db: FirebaseFirestore.Firestore,
  subscription: Stripe.Subscription
) {
  const sub = subscription as any;
  console.log("[WEBHOOK] Subscription updated:", sub.id);

  const userId = await findUserBySubscriptionId(db, sub.id);
  if (!userId) {
    // Try metadata
    const firebaseUid = sub.metadata?.firebaseUid;
    if (firebaseUid) {
      const userDoc = await db.collection("users").doc(firebaseUid).get();
      if (userDoc.exists) {
        await updateUserSubscription(db, firebaseUid, subscription);
        return;
      }
    }
    console.error("[WEBHOOK] Could not find user for subscription:", sub.id);
    return;
  }

  await updateUserSubscription(db, userId, subscription);
}

async function updateUserSubscription(
  db: FirebaseFirestore.Firestore,
  userId: string,
  subscription: Stripe.Subscription
) {
  const sub = subscription as any;
  const updateData: any = {
    stripeSubscriptionId: sub.id,
    stripePriceId: sub.items?.data[0]?.price?.id || null,
    subscriptionStatus: sub.status,
    currentPeriodStart: new Date(sub.current_period_start * 1000),
    currentPeriodEnd: new Date(sub.current_period_end * 1000),
    cancelAtPeriodEnd: sub.cancel_at_period_end,
    updatedAt: new Date(),
  };

  // Update trial_end if exists
  if (sub.trial_end) {
    updateData.trial_end = new Date(sub.trial_end * 1000);
  }

  // Update billing_status based on subscription status
  // BUT: Don't change from past_due to active unless invoice was paid
  // The invoice.payment_succeeded event will handle that
  if (sub.status === "active" || sub.status === "trialing") {
    // Only update if not currently past_due (let payment_succeeded handle that)
    const userDoc = await db.collection("users").doc(userId).get();
    const currentBillingStatus = userDoc.data()?.billing_status;
    
    if (currentBillingStatus !== "past_due") {
      updateData.billing_status = sub.status === "trialing" ? "trialing" : "active";
      updateData.accountStatus = "active";
      updateData.suspendedReason = null;
      updateData.suspendedAt = null;
    }
  } else if (sub.status === "past_due" || sub.status === "unpaid") {
    // Don't override if already past_due with grace period
    const userDoc = await db.collection("users").doc(userId).get();
    const currentBillingStatus = userDoc.data()?.billing_status;
    
    if (currentBillingStatus !== "past_due") {
      // Set grace period if not already set
      const graceUntil = new Date();
      graceUntil.setDate(graceUntil.getDate() + GRACE_DAYS);
      updateData.billing_status = "past_due";
      updateData.grace_until = graceUntil;
    }
  }

  await updateUserBilling(db, userId, updateData);

  console.log(`[WEBHOOK] User ${userId} subscription updated to ${sub.status}`);
}

/**
 * customer.subscription.deleted
 * Set billing_status = cancelled, lock account
 */
async function handleSubscriptionDeleted(
  db: FirebaseFirestore.Firestore,
  subscription: Stripe.Subscription
) {
  const sub = subscription as any;
  console.log("[WEBHOOK] Subscription deleted:", sub.id);

  const userId = await findUserBySubscriptionId(db, sub.id);
  if (!userId) {
    console.error("[WEBHOOK] Could not find user for deleted subscription:", sub.id);
    return;
  }

  const updateData = {
    billing_status: "cancelled",
    subscriptionStatus: "canceled",
    cancelAtPeriodEnd: true,
    accountStatus: "suspended",
    suspendedReason: "Subscription cancelled",
    suspendedAt: new Date(),
    updatedAt: new Date(),
  };

  await updateUserBilling(db, userId, updateData);

  console.log(`[WEBHOOK] User ${userId} subscription cancelled, account locked`);
}
