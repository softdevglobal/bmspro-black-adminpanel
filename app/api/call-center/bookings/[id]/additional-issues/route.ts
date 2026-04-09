import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";
import {
  verifyCallCenterOrTenantAdminAuth,
  canAccessWorkshopForAuth,
  CORS_HEADERS,
} from "@/lib/callCenterAuth";
import {
  mergeBookingContactIntoAdditionalIssues,
  serializeAdditionalIssuesForCallCenterApi,
} from "@/lib/callCenterAdditionalIssues";

export const runtime = "nodejs";

export async function OPTIONS() {
  return NextResponse.json({}, { headers: CORS_HEADERS });
}

/**
 * GET /api/call-center/bookings/[id]/additional-issues
 *
 * List all additional issues (extra work) for a booking.
 * Includes admin-set prices and customer response status.
 * Agents use this to know what needs customer approval.
 */
export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const gate = await verifyCallCenterOrTenantAdminAuth(req);
  if (!gate.success) {
    return NextResponse.json(
      { error: gate.error },
      { status: gate.status || 401, headers: CORS_HEADERS }
    );
  }

  const { id } = await context.params;

  try {
    const db = adminDb();

    const bookingDoc = await db.doc(`bookings/${id}`).get();
    if (!bookingDoc.exists) {
      return NextResponse.json(
        { error: "Booking not found" },
        { status: 404, headers: CORS_HEADERS }
      );
    }

    const d = bookingDoc.data()!;

    if (!canAccessWorkshopForAuth(gate.auth, d.ownerUid)) {
      return NextResponse.json(
        { error: "Access denied" },
        { status: 403, headers: CORS_HEADERS }
      );
    }

    const issues = mergeBookingContactIntoAdditionalIssues(
      serializeAdditionalIssuesForCallCenterApi(d.additionalIssues),
      d as Record<string, unknown>
    );

    const pendingPricing = issues.filter(
      (i: any) => i.status === "pending"
    );
    const awaitingCustomer = issues.filter(
      (i: any) => i.status === "approved" && !i.customerResponse
    );
    const accepted = issues.filter(
      (i: any) => i.customerResponse === "accept"
    );
    const rejected = issues.filter(
      (i: any) =>
        i.status === "rejected" || i.customerResponse === "reject"
    );

    return NextResponse.json(
      {
        bookingId: id,
        clientName: d.client || d.clientName || "",
        clientPhone: d.clientPhone || "",
        issues,
        summary: {
          total: issues.length,
          pendingPricing: pendingPricing.length,
          awaitingCustomer: awaitingCustomer.length,
          accepted: accepted.length,
          rejected: rejected.length,
        },
      },
      { headers: CORS_HEADERS }
    );
  } catch (error: any) {
    console.error("[call-center/bookings/additional-issues GET] Error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
