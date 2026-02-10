import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/trial/check-expiration
 * 
 * Checks all users with active trials and:
 * 1. Marks expired trials as suspended if no payment details
 * 2. Returns list of users whose trials expire in 2 days (for notification)
 * 
 * This can be called by a cron job (e.g., daily at midnight)
 * 
 * Headers:
 * - x-cron-secret: Secret key for cron job authentication (optional, for security)
 */
export async function POST(req: NextRequest) {
  try {
    // Optional: Verify cron secret for security
    const cronSecret = req.headers.get("x-cron-secret");
    const expectedSecret = process.env.CRON_SECRET;
    
    // If CRON_SECRET is set, require it
    if (expectedSecret && cronSecret !== expectedSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const db = adminDb();
    const now = new Date();
    const twoDaysFromNow = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);

    // Query all users with active trial status
    const usersRef = db.collection("users");
    const trialUsersSnapshot = await usersRef
      .where("accountStatus", "==", "active_trial")
      .get();

    const expiredTrials: string[] = [];
    const expiringIn2Days: string[] = [];
    const updatedUsers: string[] = [];

    for (const doc of trialUsersSnapshot.docs) {
      const userData = doc.data();
      const userId = doc.id;

      // Skip if user already has Stripe subscription
      if (userData.stripeSubscriptionId) {
        continue;
      }

      // Check trial_end date
      let trialEnd: Date | null = null;
      if (userData.trial_end) {
        trialEnd = userData.trial_end.toDate
          ? userData.trial_end.toDate()
          : new Date(userData.trial_end);
      }

      if (!trialEnd) {
        continue;
      }

      // Check if trial has expired
      if (now > trialEnd) {
        // Trial has expired - suspend account
        await usersRef.doc(userId).update({
          accountStatus: "trial_expired",
          subscriptionStatus: "expired",
          status: "Trial Expired - Payment Required",
          updatedAt: new Date(),
        });
        expiredTrials.push(userId);
        updatedUsers.push(userId);
        
        console.log(`[TrialCheck] Trial expired for user ${userId} (${userData.email})`);
      } else if (trialEnd <= twoDaysFromNow) {
        // Trial expires within 2 days - add to warning list
        expiringIn2Days.push(userId);
        
        console.log(`[TrialCheck] Trial expiring soon for user ${userId} (${userData.email})`);
      }
    }

    // Also check users marked as trialing in subscription status
    const trialingUsersSnapshot = await usersRef
      .where("subscriptionStatus", "==", "trialing")
      .get();

    for (const doc of trialingUsersSnapshot.docs) {
      const userData = doc.data();
      const userId = doc.id;

      // Skip if already processed or has Stripe subscription
      if (updatedUsers.includes(userId) || userData.stripeSubscriptionId) {
        continue;
      }

      let trialEnd: Date | null = null;
      if (userData.trial_end) {
        trialEnd = userData.trial_end.toDate
          ? userData.trial_end.toDate()
          : new Date(userData.trial_end);
      }

      if (!trialEnd) {
        continue;
      }

      if (now > trialEnd) {
        await usersRef.doc(userId).update({
          accountStatus: "trial_expired",
          subscriptionStatus: "expired",
          status: "Trial Expired - Payment Required",
          updatedAt: new Date(),
        });
        expiredTrials.push(userId);
        
        console.log(`[TrialCheck] Trial expired for user ${userId} (${userData.email})`);
      } else if (trialEnd <= twoDaysFromNow && !expiringIn2Days.includes(userId)) {
        expiringIn2Days.push(userId);
      }
    }

    return NextResponse.json({
      success: true,
      message: "Trial expiration check completed",
      stats: {
        checkedAt: now.toISOString(),
        expiredTrials: expiredTrials.length,
        expiringIn2Days: expiringIn2Days.length,
      },
      expiredUserIds: expiredTrials,
      warningUserIds: expiringIn2Days,
    });
  } catch (error: any) {
    console.error("[TrialCheck] Error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to check trial expirations" },
      { status: 500 }
    );
  }
}

/**
 * GET /api/trial/check-expiration
 * 
 * Two modes:
 * 1. Vercel Cron (no auth header) → runs the batch trial expiry check (same as POST)
 * 2. Authenticated user (Bearer token) → returns trial status for that user
 */
export async function GET(req: NextRequest) {
  try {
    const authHeader = req.headers.get("authorization");

    // If no auth header, this is a Vercel Cron call → run batch check
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      // Vercel Cron verification (optional extra security)
      const cronSecret = req.headers.get("x-cron-secret");
      const expectedSecret = process.env.CRON_SECRET;
      if (expectedSecret && cronSecret !== expectedSecret) {
        // Also allow Vercel's built-in cron calls (they don't send custom headers)
        const isVercelCron = req.headers.get("user-agent")?.includes("vercel-cron");
        if (!isVercelCron) {
          return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }
      }
      // Run the batch trial expiry check
      return POST(req);
    }

    // Verify token and get user
    const { adminAuth } = await import("@/lib/firebaseAdmin");
    const token = authHeader.split("Bearer ")[1];
    const decodedToken = await adminAuth().verifyIdToken(token);
    const uid = decodedToken.uid;

    const db = adminDb();
    const userDoc = await db.collection("users").doc(uid).get();

    if (!userDoc.exists) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const userData = userDoc.data();
    if (!userData) {
      return NextResponse.json({ error: "User data not found" }, { status: 404 });
    }

    const accountStatus = userData.accountStatus || "";
    const subscriptionStatus = userData.subscriptionStatus || "";
    const hasStripeSubscription = !!userData.stripeSubscriptionId;

    // Check if user is in active trial
    const isTrialing =
      (accountStatus === "active_trial" || subscriptionStatus === "trialing") &&
      !hasStripeSubscription;

    if (!isTrialing) {
      return NextResponse.json({
        isTrialing: false,
        daysRemaining: null,
        trialEndDate: null,
        showWarning: false,
        isExpired: accountStatus === "trial_expired",
      });
    }

    // Calculate days remaining
    let trialEnd: Date | null = null;
    if (userData.trial_end) {
      trialEnd = userData.trial_end.toDate
        ? userData.trial_end.toDate()
        : new Date(userData.trial_end);
    }

    if (!trialEnd) {
      return NextResponse.json({
        isTrialing: true,
        daysRemaining: null,
        trialEndDate: null,
        showWarning: false,
        isExpired: false,
      });
    }

    const now = new Date();
    const diffMs = trialEnd.getTime() - now.getTime();
    const daysRemaining = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
    const isExpired = daysRemaining <= 0;
    const showWarning = daysRemaining <= 2 && !isExpired;

    return NextResponse.json({
      isTrialing: true,
      daysRemaining: Math.max(0, daysRemaining),
      trialEndDate: trialEnd.toISOString(),
      showWarning,
      isExpired,
      trialDays: userData.trialDays || 0,
    });
  } catch (error: any) {
    console.error("[TrialCheck] Error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to get trial status" },
      { status: 500 }
    );
  }
}
