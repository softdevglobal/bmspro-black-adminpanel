import { NextRequest, NextResponse } from "next/server";
import { CORS_HEADERS } from "@/lib/callCenterAuth";
import { handleCallCenterBookingStatusChange } from "@/lib/callCenterBookingStatus";

export const runtime = "nodejs";

export async function OPTIONS() {
  return NextResponse.json({}, { headers: CORS_HEADERS });
}

/**
 * POST /api/call-center/bookings/[id]/complete
 *
 * Mark a confirmed booking as completed. `id` may be the Firestore document
 * id or the human `bookingCode`.
 *
 * Valid transition: Confirmed → Completed.
 *
 * Blocked when any tasks are still pending (returns 400 with task summary)
 * unless `{ "forceComplete": true }` is sent. Also blocked while any
 * `additionalIssues` row is awaiting owner/admin or customer decision.
 *
 * Body (optional): `{ "forceComplete": false }`
 *
 * Side-effects: recalculates the booking total to include accepted additional
 * issue prices, writes a `bookingActivities` entry + audit log, sends the
 * customer completion notification, completion email, and the owner's
 * "booking completed" push.
 */
export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  return handleCallCenterBookingStatusChange(req, context, "complete");
}
