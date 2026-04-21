import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";
import { FieldValue } from "firebase-admin/firestore";
import {
  createAdditionalIssueAcceptedNotification,
  createAdditionalIssueCustomerRejectedNotification,
  createNotification,
  createBranchAdminNotification,
  getBranchAdminUids,
} from "@/lib/notifications";
import { verifyAdminAuth, verifyTenantAccess } from "@/lib/authHelpers";
import { createAuditLogServer } from "@/lib/auditLogServer";

export const runtime = "nodejs";

/**
 * PATCH - Owner or branch admin records the customer's decision on an
 * additional-work quote after calling/discussing with the customer directly.
 *
 * Mirrors the call-center agent endpoint (customerResponse accept|reject) but
 * is gated by tenant admin auth (workshop_owner / branch_admin / super_admin)
 * instead of the call-center agent gate. Notifies the reporting staff, the
 * owner and the branch admin(s) the same way a direct customer response would.
 *
 * Body: { action: "accept" | "reject" }
 */
export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string; issueId: string }> }
) {
  try {
    const authResult = await verifyAdminAuth(req, [
      "super_admin",
      "workshop_owner",
      "branch_admin",
    ]);
    if (!authResult.success || !authResult.userData) {
      return NextResponse.json(
        { error: authResult.error || "Unauthorized" },
        { status: authResult.status || 401 }
      );
    }
    const userData = authResult.userData;

    const { id, issueId } = await context.params;
    const body = (await req.json().catch(() => ({}))) as {
      action?: "accept" | "reject";
    };
    const action =
      body.action === "accept" || body.action === "reject" ? body.action : null;
    if (!action) {
      return NextResponse.json(
        { error: "Invalid action. Use 'accept' or 'reject'." },
        { status: 400 }
      );
    }

    const db = adminDb();
    const bookingRef = db.doc(`bookings/${id}`);
    const bookingSnap = await bookingRef.get();
    if (!bookingSnap.exists) {
      return NextResponse.json({ error: "Booking not found" }, { status: 404 });
    }

    const bookingData = bookingSnap.data() as any;
    const ownerUid = (bookingData.ownerUid || bookingData.ownerId || "").toString();

    const tenantCheck = await verifyTenantAccess(
      userData.uid,
      userData.role,
      userData.ownerUid,
      ownerUid
    );
    if (!tenantCheck.allowed) {
      return NextResponse.json(
        { error: tenantCheck.error || "Access denied" },
        { status: 403 }
      );
    }

    const bookingStatus = (bookingData.status || "").toString().toLowerCase();
    if (bookingStatus === "completed") {
      return NextResponse.json(
        {
          error:
            "Booking is already completed. Additional work can no longer be accepted or declined.",
        },
        { status: 400 }
      );
    }

    const issues: any[] = Array.isArray(bookingData.additionalIssues)
      ? bookingData.additionalIssues
      : [];
    const issueIndex = issues.findIndex((i) => i.id === issueId);
    if (issueIndex < 0) {
      return NextResponse.json(
        { error: "Additional issue not found" },
        { status: 404 }
      );
    }

    const issue = issues[issueIndex];
    const issueCompletionStatus = (issue.completionStatus || "")
      .toString()
      .toLowerCase();
    if (issueCompletionStatus === "completed") {
      return NextResponse.json(
        {
          error:
            "This additional work item is already completed and can no longer be responded to.",
        },
        { status: 400 }
      );
    }
    if (issue.status !== "approved") {
      return NextResponse.json(
        {
          error:
            "This issue is not awaiting a customer response. Set a price first.",
        },
        { status: 400 }
      );
    }
    if (issue.customerResponse) {
      return NextResponse.json(
        { error: "A customer response has already been recorded for this issue." },
        { status: 409 }
      );
    }

    const actorRoleLabel =
      userData.role === "workshop_owner"
        ? "owner"
        : userData.role === "branch_admin"
          ? "branch_admin"
          : userData.role === "super_admin"
            ? "super_admin"
            : "admin";
    const now = new Date().toISOString();
    const updatedIssues = [...issues];
    updatedIssues[issueIndex] = {
      ...issue,
      customerResponse: action,
      customerRespondedAt: now,
      customerRespondedBy: `${actorRoleLabel}:${userData.uid}`,
      customerResponseRecordedByUid: userData.uid,
      customerResponseRecordedByName: userData.name || "Admin",
      customerResponseRecordedByRole: userData.role,
    };

    await bookingRef.update({
      additionalIssues: updatedIssues,
      updatedAt: FieldValue.serverTimestamp(),
    });

    // Activity log
    try {
      await db.collection("bookingActivities").add({
        bookingId: id,
        type: "additional_issue_customer_response",
        message: `${userData.name || "Admin"} recorded that the customer ${
          action === "accept" ? "accepted" : "declined"
        } extra work "${issue.issueTitle || "Additional work"}"${
          issue.price != null ? ` ($${Number(issue.price).toFixed(2)})` : ""
        }.`,
        performedBy: userData.uid,
        performedByName: userData.name || "Admin",
        performedByRole: userData.role,
        issueId,
        customerResponse: action,
        timestamp: new Date(),
      });
    } catch (e) {
      console.error("Failed to write booking activity:", e);
    }

    // Audit log — tenant + super-admin audit trail for the customer decision
    // recorded by the owner / branch admin on behalf of the customer.
    try {
      const auditClientName =
        bookingData.client || bookingData.clientName || "Customer";
      const auditIssueTitle = issue.issueTitle || "Additional work";
      const auditPriceLabel =
        issue.price != null ? ` ($${Number(issue.price).toFixed(2)})` : "";
      const actionLabel = action === "accept" ? "accepted" : "declined";
      const actorName = (userData.name || "").trim() || "Admin";
      const priceSetByName =
        (issue.priceSetByName || "").toString().trim() || null;
      const priceSetByUid = (issue.priceSetByUid || "").toString() || null;
      await createAuditLogServer({
        ownerUid,
        action: `Customer ${actionLabel} additional work (recorded by ${actorName} (${actorRoleLabel})): "${auditIssueTitle}"${auditPriceLabel}`,
        actionType: "status_change",
        entityType: "booking",
        entityId: id,
        entityName: bookingData.bookingCode || `Booking for ${auditClientName}`,
        performedBy: userData.uid,
        performedByName: actorName,
        performedByRole: userData.role,
        previousValue: "Awaiting Customer",
        newValue:
          action === "accept" ? "Customer Accepted" : "Customer Declined",
        details: `Issue: ${auditIssueTitle}${auditPriceLabel} · Customer: ${auditClientName} · Recorded by: ${actorName} (${userData.role})${priceSetByName ? ` · Price originally set by: ${priceSetByName}` : ""}`,
        branchId: bookingData.branchId || undefined,
        branchName: bookingData.branchName || undefined,
        metadata: {
          issueId,
          customerResponse: action,
          price: issue.price ?? null,
          recordedOnBehalfOfCustomer: true,
          bookingCode: bookingData.bookingCode || null,
          recordedByUid: userData.uid,
          recordedByName: actorName,
          recordedByRole: userData.role,
          priceSetByUid,
          priceSetByName,
        },
      });
    } catch (e) {
      console.error("Failed to write audit log for customer response:", e);
    }

    const clientName =
      bookingData.client || bookingData.clientName || "Customer";
    const bookingCode = bookingData.bookingCode || undefined;
    const branchId = (bookingData.branchId || "").toString();
    const issueTitle = issue.issueTitle || "Additional work";
    const priceStr = issue.price != null ? `$${Number(issue.price).toFixed(2)}` : "";

    // Collect staff to notify (reporter + assigned)
    const reportedByStaffUid = issue.reportedByStaffUid || issue.reportedByStaffId;
    const staffUidsToNotify = new Set<string>();
    if (reportedByStaffUid) staffUidsToNotify.add(String(reportedByStaffUid));
    const services = Array.isArray(bookingData.services)
      ? bookingData.services
      : [];
    for (const svc of services) {
      const staffAuthUid = (svc.staffAuthUid || svc.staffId || "").toString();
      if (staffAuthUid) staffUidsToNotify.add(staffAuthUid);
    }
    if (bookingData.staffAuthUid) staffUidsToNotify.add(String(bookingData.staffAuthUid));
    if (bookingData.staffId) staffUidsToNotify.add(String(bookingData.staffId));

    if (action === "accept") {
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
          console.error(`Failed to notify staff ${staffUid}:`, e);
        }
      }

      // Notify owner (if the actor is not the owner themselves)
      if (ownerUid && ownerUid !== userData.uid) {
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
          console.error("Failed to notify owner:", e);
        }
      }

      // Notify branch admin(s) (skip the actor if they are one)
      if (branchId && ownerUid) {
        try {
          const branchAdminUids = await getBranchAdminUids(db, branchId, ownerUid);
          for (const branchAdminUid of branchAdminUids) {
            if (branchAdminUid === userData.uid) continue;
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
          console.error("Failed to notify branch admin:", e);
        }
      }
    } else {
      // reject
      for (const staffUid of staffUidsToNotify) {
        try {
          await createAdditionalIssueCustomerRejectedNotification({
            bookingId: id,
            bookingCode,
            staffUid,
            staffName: issue.reportedByStaffName || undefined,
            clientName,
            issueTitle,
            serviceName: bookingData.serviceName || undefined,
            branchName: bookingData.branchName || undefined,
            bookingDate: bookingData.date || undefined,
            bookingTime: bookingData.time || undefined,
            ownerUid,
          });
        } catch (e) {
          console.error(`Failed to notify staff ${staffUid} of rejection:`, e);
        }
      }

      if (ownerUid && ownerUid !== userData.uid) {
        try {
          await createNotification({
            bookingId: id,
            bookingCode,
            type: "additional_issue_customer_rejected" as any,
            title: "Customer Declined Additional Work",
            message: `${clientName} declined ${issueTitle}${priceStr ? ` (${priceStr})` : ""}.`,
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
          console.error("Failed to notify owner of rejection:", e);
        }
      }

      if (branchId && ownerUid) {
        try {
          const branchAdminUids = await getBranchAdminUids(db, branchId, ownerUid);
          for (const branchAdminUid of branchAdminUids) {
            if (branchAdminUid === userData.uid) continue;
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
              type: "additional_issue_customer_rejected" as any,
              title: "Customer Declined Additional Work",
              message: `${clientName} declined ${issueTitle}${priceStr ? ` (${priceStr})` : ""}.`,
            });
          }
        } catch (e) {
          console.error("Failed to notify branch admin of rejection:", e);
        }
      }
    }

    return NextResponse.json({ ok: true, issue: updatedIssues[issueIndex] });
  } catch (e: any) {
    console.error(
      "Error in PATCH /api/bookings/[id]/additional-issues/[issueId]/customer-response:",
      e
    );
    return NextResponse.json(
      { error: e?.message || "Internal error" },
      { status: 500 }
    );
  }
}
