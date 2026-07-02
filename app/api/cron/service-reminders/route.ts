import { NextRequest, NextResponse } from "next/server";
import { processDueServiceReminders } from "@/lib/serviceReminders/server";

export const runtime = "nodejs";

/**
 * POST /api/cron/service-reminders
 *
 * Sends due next-service reminders to customers (in-app, push, SMS, email).
 * Schedule externally (e.g. Vercel Cron, cron-job.org) — recommended hourly.
 */
export async function POST(req: NextRequest) {
  try {
    const authHeader = req.headers.get("authorization");
    const cronSecret = process.env.CRON_SECRET;

    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const result = await processDueServiceReminders();
    console.log(
      `[CRON service-reminders] processed=${result.processed} mainSent=${result.sent} advanceSent=${result.advanceSent} errors=${result.errors}`,
    );

    return NextResponse.json({
      success: true,
      ...result,
    });
  } catch (error: unknown) {
    console.error("[CRON service-reminders] Error:", error);
    const message = error instanceof Error ? error.message : "Failed to process service reminders";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  return POST(req);
}
