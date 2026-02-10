import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { adminDb, adminAuth } from "@/lib/firebaseAdmin";

export const runtime = "nodejs";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2025-12-15.clover",
});

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
    const { returnUrl } = body;

    const db = adminDb();

    // Get user's Stripe customer ID
    const userDoc = await db.collection("users").doc(userId).get();
    const userData = userDoc.data();
    
    if (!userData?.stripeCustomerId) {
      return NextResponse.json(
        { error: "No Stripe customer found. Please subscribe to a plan first." },
        { status: 400 }
      );
    }

    // Create billing portal session
    const baseUrl = req.headers.get("origin") || process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
    
    const session = await stripe.billingPortal.sessions.create({
      customer: userData.stripeCustomerId,
      return_url: returnUrl || `${baseUrl}/subscription`,
    });

    return NextResponse.json({
      success: true,
      url: session.url,
    });
  } catch (error: any) {
    console.error("[CREATE PORTAL] Error:", error);
    return NextResponse.json(
      { success: false, error: error.message || "Failed to create billing portal session" },
      { status: 500 }
    );
  }
}
