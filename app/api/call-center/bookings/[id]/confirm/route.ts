import { NextRequest, NextResponse } from "next/server";
import { CORS_HEADERS } from "@/lib/callCenterAuth";
import { handleCallCenterBookingStatusChange } from "@/lib/callCenterBookingStatus";

export const runtime = "nodejs";

export async function OPTIONS() {
  return NextResponse.json({}, { headers: CORS_HEADERS });
}

/**
 * POST /api/call-center/bookings/[id]/confirm
 *
 * Confirm a booking on behalf of the workshop. `id` may be the Firestore
 * document id or the human `bookingCode` (e.g. `BK-2026-032612-2452`).
 *
 * Valid transitions: Pending | AwaitingStaffApproval | PartiallyApproved
 *   | StaffRejected(via reassignment ladder) → Confirmed.
 *
 * Body (all optional): `{}`
 *
 * Side-effects: marks every service `approvalStatus: "accepted"`, writes a
 * `bookingActivities` entry + audit log, sends the customer confirmation
 * notification and confirmation email.
 */
export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  return handleCallCenterBookingStatusChange(req, context, "confirm");
}
