import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";
import { FieldValue } from "firebase-admin/firestore";
import {
  createAdditionalIssueAcceptedNotification,
  createNotification,
  createBranchAdminNotification,
  getBranchAdminUids,
} from "@/lib/notifications";

export const runtime = "nodejs";

/**
 * PATCH - Customer accepts or rejects an additional issue quote.
 * Secured by customerId (must match booking's customerId or clientEmail).
 * When customer accepts, notifies: staff (reporter + assigned), owner, and branch admin.
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

    // When customer accepts, notify staff (reporter + assigned), owner, and branch admin
    if (action === "accept") {
      const clientName = bookingData.client || bookingData.clientName || "Customer";
      const bookingCode = bookingData.bookingCode || undefined;
      const ownerUid = (bookingData.ownerUid || bookingData.ownerId || "").toString();
      const branchId = (bookingData.branchId || "").toString();
      const issueTitle = issue.issueTitle || "Additional work";
      const priceStr = issue.price != null ? `$${issue.price.toFixed(2)}` : "";

      // 1. Notify staff who reported the issue
      const reportedByStaffUid = issue.reportedByStaffUid || issue.reportedByStaffId;
      const staffUidsToNotify = new Set<string>();
      if (reportedByStaffUid) staffUidsToNotify.add(reportedByStaffUid);

      // 2. Also notify staff assigned to the booking (in case different from reporter)
      const services = Array.isArray(bookingData.services) ? bookingData.services : [];
      for (const svc of services) {
        const staffAuthUid = (svc.staffAuthUid || svc.staffId || "").toString();
        if (staffAuthUid) staffUidsToNotify.add(staffAuthUid);
      }
      if (bookingData.staffAuthUid) staffUidsToNotify.add(String(bookingData.staffAuthUid));
      if (bookingData.staffId) staffUidsToNotify.add(String(bookingData.staffId));

      for (const staffUid of staffUidsToNotify) {
        try {
          await createAdditionalIssueAcceptedNotification({
            bookingId: id,
            bookingCode,
            staffUid,
            staffName: issue.reportedByStaffName || undefined,
            clientName,
            issueTitle,
            price: issue.price ?? undefined,
            serviceName: bookingData.serviceName || undefined,
            branchName: bookingData.branchName || undefined,
            bookingDate: bookingData.date || undefined,
            bookingTime: bookingData.time || undefined,
            ownerUid,
          });
        } catch (e) {
          console.error(`Failed to notify staff ${staffUid} of customer acceptance:`, e);
        }
      }

      // 3. Notify owner
      if (ownerUid) {
        try {
          await createNotification({
            bookingId: id,
            bookingCode,
            type: "additional_issue_customer_accepted" as any,
            title: "Customer Accepted Additional Work",
            message: `${clientName} accepted ${issueTitle}${priceStr ? ` (${priceStr})` : ""}.`,
            status: "Confirmed",
            ownerUid,
            targetOwnerUid: ownerUid,
            clientName,
            serviceName: bookingData.serviceName || undefined,
            branchName: bookingData.branchName || undefined,
            bookingDate: bookingData.date || undefined,
            bookingTime: bookingData.time || undefined,
          } as any);
        } catch (e) {
          console.error("Failed to notify owner of customer acceptance:", e);
        }
      }

      // 4. Notify branch admin(s)
      if (branchId && ownerUid) {
        try {
          const branchAdminUids = await getBranchAdminUids(db, branchId, ownerUid);
          for (const branchAdminUid of branchAdminUids) {
            await createBranchAdminNotification({
              bookingId: id,
              bookingCode,
              branchAdminUid,
              ownerUid,
              clientName,
              serviceName: bookingData.serviceName || undefined,
              branchName: bookingData.branchName || undefined,
              branchId,
              bookingDate: bookingData.date || "",
              bookingTime: bookingData.time || "",
              status: "Confirmed",
              type: "additional_issue_customer_accepted" as any,
              title: "Customer Accepted Additional Work",
              message: `${clientName} accepted ${issueTitle}${priceStr ? ` (${priceStr})` : ""}.`,
            });
          }
        } catch (e) {
          console.error("Failed to notify branch admin of customer acceptance:", e);
        }
      }
    }

    return NextResponse.json({ ok: true, issue: updatedIssues[issueIndex] });
  } catch (e: any) {
    console.error("Error in PATCH customer additional-issues:", e);
    return NextResponse.json({ error: e?.message || "Internal error" }, { status: 500 });
  }
}
