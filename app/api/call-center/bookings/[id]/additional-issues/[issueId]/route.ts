import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";
import {
  verifyCallCenterOrTenantAdminAuth,
  canAccessWorkshopForAuth,
  CORS_HEADERS,
} from "@/lib/callCenterAuth";

export const runtime = "nodejs";

export async function OPTIONS() {
  return NextResponse.json({}, { headers: CORS_HEADERS });
}

/**
 * PATCH /api/call-center/bookings/[id]/additional-issues/[issueId]
 *
 * Relay customer's decision on an additional issue (extra work).
 * The agent calls the customer, explains the issue and price,
 * then records accept/reject here.
 *
 * Body: { customerResponse: "accept" | "reject" }
 *
 * Only issues with status "approved" (admin has set price) can receive a customer response.
 */
export async function PATCH(
  req: NextRequest,
  context: {
    params: Promise<{ id: string; issueId: string }>;
  }
) {
  const gate = await verifyCallCenterOrTenantAdminAuth(req);
  if (!gate.success) {
    return NextResponse.json(
      { error: gate.error },
      { status: gate.status || 401, headers: CORS_HEADERS }
    );
  }

  const { id: bookingId, issueId } = await context.params;

  try {
    const body = await req.json();
    const { customerResponse } = body;

    if (!customerResponse || !["accept", "reject"].includes(customerResponse)) {
      return NextResponse.json(
        { error: "customerResponse must be 'accept' or 'reject'" },
        { status: 400, headers: CORS_HEADERS }
      );
    }

    const db = adminDb();

    const bookingRef = db.doc(`bookings/${bookingId}`);
    const bookingDoc = await bookingRef.get();

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

    const additionalIssues = Array.isArray(d.additionalIssues)
      ? [...d.additionalIssues]
      : [];

    const issueIndex = additionalIssues.findIndex(
      (i: any) => i.id === issueId
    );

    if (issueIndex === -1) {
      return NextResponse.json(
        { error: "Additional issue not found" },
        { status: 404, headers: CORS_HEADERS }
      );
    }

    const issue = additionalIssues[issueIndex];

    if (issue.status !== "approved") {
      return NextResponse.json(
        {
          error:
            "Can only respond to issues that have been approved with a price by the workshop",
        },
        { status: 400, headers: CORS_HEADERS }
      );
    }

    if (issue.customerResponse) {
      return NextResponse.json(
        { error: "Customer has already responded to this issue" },
        { status: 409, headers: CORS_HEADERS }
      );
    }

    const actor =
      gate.auth.kind === "agent"
        ? { uid: gate.auth.user.uid, name: gate.auth.user.name }
        : { uid: gate.auth.uid, name: gate.auth.name };
    const performedByRole =
      gate.auth.kind === "agent" ? "call_center_agent" : gate.auth.role;

    const now = new Date().toISOString();
    additionalIssues[issueIndex] = {
      ...issue,
      customerResponse,
      customerRespondedAt: now,
      customerRespondedBy: `${gate.auth.kind === "agent" ? "agent" : "staff"}:${actor.uid}`,
    };

    await bookingRef.update({
      additionalIssues,
      updatedAt: new Date(),
    });

    // Log activity
    await db.collection("bookingActivities").add({
      bookingId,
      type: "additional_issue_customer_response",
      message: `Customer ${customerResponse === "accept" ? "accepted" : "rejected"} extra work "${issue.issueTitle}" (${issue.price ? "$" + issue.price : "no price"}) — relayed by ${actor.name}`,
      performedBy: actor.uid,
      performedByName: actor.name,
      performedByRole: performedByRole,
      issueId,
      customerResponse,
      timestamp: new Date(),
    });

    // Notify the reporting staff member
    if (issue.reportedByStaffUid) {
      await db.collection("notifications").add({
        type: "additional_issue_response",
        title: `Customer ${customerResponse === "accept" ? "Accepted" : "Rejected"} Extra Work`,
        message: `${d.client || "Customer"} has ${customerResponse === "accept" ? "accepted" : "rejected"} the additional work: "${issue.issueTitle}"`,
        bookingId,
        issueId,
        staffUid: issue.reportedByStaffUid,
        ownerUid: d.ownerUid,
        read: false,
        createdAt: new Date(),
      });
    }

    return NextResponse.json(
      {
        success: true,
        issueId,
        customerResponse,
        issueName: issue.issueTitle,
        price: issue.price,
      },
      { headers: CORS_HEADERS }
    );
  } catch (error: any) {
    console.error("[call-center/additional-issues PATCH] Error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
