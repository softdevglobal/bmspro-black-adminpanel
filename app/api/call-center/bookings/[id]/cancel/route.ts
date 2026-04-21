import { NextRequest, NextResponse } from "next/server";
import { CORS_HEADERS } from "@/lib/callCenterAuth";
import { handleCallCenterBookingStatusChange } from "@/lib/callCenterBookingStatus";

export const runtime = "nodejs";

export async function OPTIONS() {
  return NextResponse.json({}, { headers: CORS_HEADERS });
}

/**
 * POST /api/call-center/bookings/[id]/cancel
 *
 * Cancel a booking on behalf of the workshop. `id` may be the Firestore
 * document id or the human `bookingCode`.
 *
 * Valid transitions: any non-terminal status → Canceled
 *   (Pending, AwaitingStaffApproval, PartiallyApproved, StaffRejected, Confirmed).
 *
 * Body (optional): `{ "reason": "Customer no longer needs service" }`
 *
 * Side-effects: writes `bookingActivities` entry + audit log, stores the
 * cancel reason on the booking, and sends the customer cancellation
 * notification and cancellation email.
 */
export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  return handleCallCenterBookingStatusChange(req, context, "cancel");
}
