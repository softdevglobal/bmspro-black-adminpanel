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
 * Body (all fields optional):
 * {
 *   // Multi-service bookings — assign a staff member to each service.
 *   // Keys are the service id from `booking.services[].id`.
 *   "staffAssignments": {
 *     "<serviceId>": { "staffId": "<uid>", "staffName": "<display name>" }
 *   },
 *
 *   // Single-service bookings — shortcut. Applies to the only service if
 *   // `staffAssignments` is not supplied.
 *   "staffId": "<uid>",
 *   "staffName": "<display name>",
 *
 *   // Escape hatch: confirm without picking staff (legacy / "any staff" bookings).
 *   "skipStaffValidation": false
 * }
 *
 * Validation: every service must have a staff assigned (either already on
 * the booking, or supplied in the body) unless `skipStaffValidation: true`.
 * On failure the response is `400` with `missingStaffForServices`.
 *
 * Side-effects: marks every service `approvalStatus: "accepted"`, merges the
 * supplied staff into `services[]` (and legacy top-level `staffId` /
 * `staffName` for single-service bookings), writes a `bookingActivities`
 * entry + audit log, sends staff assignment notifications to each newly-
 * assigned staff, and sends the customer confirmation notification + email.
 */
export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  return handleCallCenterBookingStatusChange(req, context, "confirm");
}
