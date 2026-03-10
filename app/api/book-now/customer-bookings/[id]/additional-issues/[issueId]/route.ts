import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";
import { FieldValue } from "firebase-admin/firestore";
import { createAdditionalIssueAcceptedNotification } from "@/lib/notifications";

export const runtime = "nodejs";

/**
 * PATCH - Customer accepts or rejects an additional issue quote.
 * Secured by customerId (must match booking's customerId or clientEmail).
 * When customer accepts, notifies the staff member who reported the issue.
 */
export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string; issueId: string }> }
) {
  try {
    const customerId = req.nextUrl.searchParams.get("customerId");
    if (!customerId) {
      return NextResponse.json({ error: "Missing customerId" }, { status: 400 });
    }

    const body = (await req.json().catch(() => ({}))) as { action?: "accept" | "reject" };
    const action = body.action === "accept" || body.action === "reject" ? body.action : null;
    if (!action) {
      return NextResponse.json({ error: "Invalid action. Use accept or reject." }, { status: 400 });
    }

    const { id, issueId } = await context.params;
    const db = adminDb();
    const bookingRef = db.doc(`bookings/${id}`);
    const bookingSnap = await bookingRef.get();

    if (!bookingSnap.exists) {
      return NextResponse.json({ error: "Booking not found" }, { status: 404 });
    }

    const bookingData = bookingSnap.data() as any;
    const bookingCustomerId = (bookingData.customerId || "").toString().trim().toLowerCase();
    const bookingEmail = (bookingData.clientEmail || "").toString().trim().toLowerCase();
    const providedId = customerId.trim().toLowerCase();

    const isAuthorized =
      (bookingCustomerId && bookingCustomerId === providedId) ||
      (bookingEmail && bookingEmail === providedId);
    if (!isAuthorized) {
      return NextResponse.json({ error: "You are not authorized to respond to this booking." }, { status: 403 });
    }

    const issues: any[] = Array.isArray(bookingData.additionalIssues) ? bookingData.additionalIssues : [];
    const issueIndex = issues.findIndex((i) => i.id === issueId);
    if (issueIndex < 0) {
      return NextResponse.json({ error: "Additional issue not found" }, { status: 404 });
    }

    const issue = issues[issueIndex];
    if (issue.status !== "approved") {
      return NextResponse.json({ error: "This issue is not awaiting your response." }, { status: 400 });
    }
    if (issue.customerResponse) {
      return NextResponse.json({ error: "You have already responded to this issue." }, { status: 400 });
    }

    const now = new Date().toISOString();
    const updatedIssues = [...issues];
    updatedIssues[issueIndex] = {
      ...issue,
      customerResponse: action,
      customerRespondedAt: now,
      customerRespondedBy: providedId,
    };

    await bookingRef.update({
      additionalIssues: updatedIssues,
      updatedAt: FieldValue.serverTimestamp(),
    });

    // When customer accepts, notify the staff member who reported the issue
    if (action === "accept") {
      const reportedByStaffUid = issue.reportedByStaffUid || issue.reportedByStaffId;
      if (reportedByStaffUid) {
        try {
          await createAdditionalIssueAcceptedNotification({
            bookingId: id,
            bookingCode: bookingData.bookingCode || undefined,
            staffUid: reportedByStaffUid,
            staffName: issue.reportedByStaffName || undefined,
            clientName: bookingData.client || bookingData.clientName || "Customer",
            issueTitle: issue.issueTitle || "Additional work",
            price: issue.price ?? undefined,
            serviceName: bookingData.serviceName || undefined,
            branchName: bookingData.branchName || undefined,
            bookingDate: bookingData.date || undefined,
            bookingTime: bookingData.time || undefined,
            ownerUid: bookingData.ownerUid || bookingData.ownerId || "",
          });
        } catch (e) {
          console.error("Failed to notify staff of customer acceptance:", e);
        }
      }
    }

    return NextResponse.json({ ok: true, issue: updatedIssues[issueIndex] });
  } catch (e: any) {
    console.error("Error in PATCH customer additional-issues:", e);
    return NextResponse.json({ error: e?.message || "Internal error" }, { status: 500 });
  }
}
