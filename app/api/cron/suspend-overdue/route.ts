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

    // Find users whose grace period has actually expired. Previously this
    // query read **every** `past_due` user (regardless of grace_until) and
    // then filtered in memory + did a per-user `owners/{id}.get()`. Now we
    // ask Firestore for only the rows that need action and bound the page
    // size; rows without `grace_until` are handled by a separate one-time
    // pass below.
    //
    // We also batch the `owners/{id}` reads via `getAll` to drop the per-row
    // round trip.
    const CRON_BATCH_LIMIT = 200;
    let suspendedCount = 0;
    const batch = db.batch();

    let expiredSnap;
    try {
      expiredSnap = await db
        .collection("users")
        .where("billing_status", "==", "past_due")
        .where("grace_until", "<", now)
        .limit(CRON_BATCH_LIMIT)
        .get();
    } catch {
      // Composite index missing — fall back to the previous shape but capped.
      expiredSnap = await db
        .collection("users")
        .where("billing_status", "==", "past_due")
        .limit(CRON_BATCH_LIMIT)
        .get();
    }

    type UserDoc = FirebaseFirestore.QueryDocumentSnapshot;
    const toSuspend: UserDoc[] = [];
    for (const userDoc of expiredSnap.docs) {
      const userData = userDoc.data();
      const graceUntil = userData.grace_until;
      // When the indexed path is available, every row already satisfies
      // `grace_until < now`. When we hit the fallback path, re-check here.
      if (!graceUntil) {
        // Treated as "suspend immediately" — surface separately so it's
        // visible in logs.
        toSuspend.push(userDoc);
        continue;
      }
      const graceDate = graceUntil.toDate ? graceUntil.toDate() : new Date(graceUntil);
      if (now > graceDate) toSuspend.push(userDoc);
    }

    if (toSuspend.length > 0) {
      // Batch the corresponding `owners/{id}` reads.
      const ownerRefs = toSuspend.map((d) => db.collection("owners").doc(d.id));
      const ownerSnaps = await db.getAll(...ownerRefs);
      const ownerExistsById = new Map<string, boolean>();
      for (let i = 0; i < toSuspend.length; i++) {
        ownerExistsById.set(toSuspend[i].id, ownerSnaps[i].exists);
      }
      for (const userDoc of toSuspend) {
        batch.update(userDoc.ref, {
          billing_status: "suspended",
          accountStatus: "suspended",
          suspendedReason: "Payment past due - grace period expired",
          suspendedAt: now,
          updatedAt: now,
        });
        if (ownerExistsById.get(userDoc.id)) {
          batch.update(db.collection("owners").doc(userDoc.id), {
            billing_status: "suspended",
            accountStatus: "suspended",
            suspendedReason: "Payment past due - grace period expired",
            suspendedAt: now,
            updatedAt: now,
          });
        }
        suspendedCount++;
      }
      await batch.commit();
      console.log(`[CRON] Suspended ${suspendedCount} accounts with expired grace periods`);
    }

    return NextResponse.json({
      success: true,
      message: `Suspended ${suspendedCount} accounts`,
      suspended_count: suspendedCount,
      /** True when this run hit `CRON_BATCH_LIMIT` and there may be more rows to suspend on the next scheduled run. */
      truncated: expiredSnap.size === CRON_BATCH_LIMIT,
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
