import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { adminDb, adminAuth } from "@/lib/firebaseAdmin";

export const runtime = "nodejs";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2025-12-15.clover",
});

// Default product name for BMS Pro subscriptions
const PRODUCT_NAME = "BMS Pro Subscription";

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

    // Skip billing check for checkout (users need to pay even if suspended)

    const userId = decodedToken.uid;
    const body = await req.json();
    const { planId, successUrl, cancelUrl } = body;

    if (!planId) {
      return NextResponse.json(
        { error: "Missing required field: planId" },
        { status: 400 }
      );
    }

    const db = adminDb();

    // Get the subscription plan
    const planDoc = await db.collection("subscription_plans").doc(planId).get();
    if (!planDoc.exists) {
      return NextResponse.json(
        { error: "Subscription plan not found" },
        { status: 404 }
      );
    }

    const planData = planDoc.data()!;
    
    // Validate plan has a price
    if (!planData.price || planData.price <= 0) {
      return NextResponse.json(
        { error: "Subscription plan does not have a valid price configured" },
        { status: 400 }
      );
    }

    // Get or create Stripe customer
    const userDoc = await db.collection("users").doc(userId).get();
    const userData = userDoc.data();
    
    let stripeCustomerId = userData?.stripeCustomerId;

    if (!stripeCustomerId) {
      // Create a new Stripe customer
      const customer = await stripe.customers.create({
        email: userData?.email || decodedToken.email,
        name: userData?.name || userData?.displayName || "",
        metadata: {
          firebaseUid: userId,
        },
      });
      stripeCustomerId = customer.id;

      // Save the Stripe customer ID to Firestore
      await db.collection("users").doc(userId).update({
        stripeCustomerId: customer.id,
      });

      // Also update owners collection if exists
      const ownerDoc = await db.collection("owners").doc(userId).get();
      if (ownerDoc.exists) {
        await db.collection("owners").doc(userId).update({
          stripeCustomerId: customer.id,
        });
      }
    }

    // Create Stripe Checkout Session
    const baseUrl = req.headers.get("origin") || process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
    
    // Get trial days from plan (0 or undefined = no trial)
    const trialDays = planData.trialDays ? parseInt(planData.trialDays, 10) : 0;
    
    // Build subscription_data with optional trial period
    const subscriptionData: Stripe.Checkout.SessionCreateParams.SubscriptionData = {
      metadata: {
        firebaseUid: userId,
        planId: planId,
        planName: planData.name,
        plan_key: planData.plan_key || "",
      },
    };
    
    // Only add trial period if trialDays > 0
    if (trialDays > 0) {
      subscriptionData.trial_period_days = trialDays;
    }

    // Build line_items - use price_data to create price inline (no need for Stripe Price ID)
    const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [
      {
        price_data: {
          currency: "aud", // Australian Dollars
          product_data: {
            name: planData.name || PRODUCT_NAME,
            description: planData.priceLabel || `${planData.name} Plan`,
            metadata: {
              planId: planId,
              plan_key: planData.plan_key || "",
            },
          },
          unit_amount: Math.round(planData.price * 100), // Convert to cents
          recurring: {
            interval: "day",
            interval_count: 28, // 28-day billing cycle
          },
        },
        quantity: 1,
      },
    ];
    
    const session = await stripe.checkout.sessions.create({
      customer: stripeCustomerId,
      payment_method_types: ["card"],
      mode: "subscription",
      line_items: lineItems,
      success_url: successUrl || `${baseUrl}/subscription/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: cancelUrl || `${baseUrl}/subscription/cancel`,
      metadata: {
        firebaseUid: userId,
        planId: planId,
        planName: planData.name,
        trialDays: trialDays.toString(),
        price: planData.price.toString(),
      },
      subscription_data: subscriptionData,
      allow_promotion_codes: true,
      billing_address_collection: "auto",
    });

    return NextResponse.json({
      success: true,
      sessionId: session.id,
      url: session.url,
    });
  } catch (error: any) {
    console.error("[CREATE CHECKOUT] Error:", error);
    return NextResponse.json(
      { success: false, error: error.message || "Failed to create checkout session" },
      { status: 500 }
    );
  }
}
