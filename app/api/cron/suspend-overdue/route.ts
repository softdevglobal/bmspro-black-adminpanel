import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";

export const runtime = "nodejs";

/**
 * POST /api/cron/suspend-overdue
 * 
 * Auto-suspends accounts that are past_due and grace period has expired
 * 
 * This should be called by:
 * - Vercel Cron (recommended): Add to vercel.json
 * - External cron service (cron-job.org, etc.)
 * - Or check on every request in middleware (simpler but less efficient)
 * 
 * Schedule: Run every hour or daily
 */
export async function POST(req: NextRequest) {
  try {
    // Optional: Add API key protection for cron endpoints
    const authHeader = req.headers.get("authorization");
    const cronSecret = process.env.CRON_SECRET;

    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      );
    }

    const db = adminDb();
    const now = new Date();

    // Find all users with billing_status = past_due and grace_until < now
    const usersSnapshot = await db
      .collection("users")
      .where("billing_status", "==", "past_due")
      .get();

    let suspendedCount = 0;
    const batch = db.batch();

    for (const userDoc of usersSnapshot.docs) {
      const userData = userDoc.data();
      const graceUntil = userData.grace_until;

      if (!graceUntil) {
        // No grace period set, suspend immediately
        batch.update(userDoc.ref, {
          billing_status: "suspended",
          accountStatus: "suspended",
          suspendedReason: "Payment past due - grace period expired",
          suspendedAt: now,
          updatedAt: now,
        });
        suspendedCount++;
        continue;
      }

      const graceDate = graceUntil.toDate ? graceUntil.toDate() : new Date(graceUntil);
      
      if (now > graceDate) {
        // Grace period expired, suspend account
        batch.update(userDoc.ref, {
          billing_status: "suspended",
          accountStatus: "suspended",
          suspendedReason: "Payment past due - grace period expired",
          suspendedAt: now,
          updatedAt: now,
        });
        suspendedCount++;

        // Also update owners collection
        const ownerRef = db.collection("owners").doc(userDoc.id);
        const ownerDoc = await ownerRef.get();
        if (ownerDoc.exists) {
          batch.update(ownerRef, {
            billing_status: "suspended",
            accountStatus: "suspended",
            suspendedReason: "Payment past due - grace period expired",
            suspendedAt: now,
            updatedAt: now,
          });
        }
      }
    }

    // Commit all updates
    if (suspendedCount > 0) {
      await batch.commit();
      console.log(`[CRON] Suspended ${suspendedCount} accounts with expired grace periods`);
    }

    return NextResponse.json({
      success: true,
      message: `Suspended ${suspendedCount} accounts`,
      suspended_count: suspendedCount,
    });
  } catch (error: any) {
    console.error("[CRON SUSPEND] Error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to suspend overdue accounts" },
      { status: 500 }
    );
  }
}

// Also allow GET for easier testing
export async function GET(req: NextRequest) {
  return POST(req);
}
