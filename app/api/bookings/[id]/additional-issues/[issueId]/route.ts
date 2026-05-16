import { NextRequest, NextResponse } from "next/server";
import { adminAuth, adminDb } from "@/lib/firebaseAdmin";
import { FieldValue } from "firebase-admin/firestore";
import {
  createNotification,
  createAdditionalIssueRejectedNotification,
  CUSTOMER_NOTIFICATION_AGENT_TRACKING_DEFAULTS,
  resolveCustomerEmailForStorage,
  resolveCustomerNameForStorage,
  resolveCustomerPhoneForStorage,
} from "@/lib/notifications";
import { verifyAdminAuth, verifyTenantAccess } from "@/lib/authHelpers";
import { sendAdditionalIssuePriceSetEmail } from "@/lib/emailService";
import { createAuditLogServer } from "@/lib/auditLogServer";
import {
  appendBookNowMyBookingsDeepLink,
  resolveBookingEngineUrl,
} from "@/lib/customerAccount";

export const runtime = "nodejs";

/**
 * PATCH - Owner or branch admin sets price for an additional issue.
 * Notifies customer when price is set.
 */
export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string; issueId: string }> }
) {
  try {
    const authResult = await verifyAdminAuth(req);
    if (!authResult.success || !authResult.userData) {
      return NextResponse.json({ error: authResult.error || "Unauthorized" }, { status: authResult.status || 401 });
    }
    const userData = authResult.userData;

    const { id, issueId } = await context.params;
    const body = (await req.json().catch(() => ({}))) as {
      price?: number;
      status?: "approved" | "rejected";
      /** Optional: persist when booking record has no phone yet */
      customerPhone?: string;
      customerEmail?: string;
    };

    const status = body.status === "approved" || body.status === "rejected" ? body.status : "approved";
    const price = status === "rejected" ? null : (typeof body.price === "number" ? body.price : parseFloat(String(body.price ?? "")));

    if (status === "approved" && (typeof price !== "number" || isNaN(price) || price < 0)) {
      return NextResponse.json({ error: "Valid price is required when approving" }, { status: 400 });
    }

    const db = adminDb();
    const bookingRef = db.doc(`bookings/${id}`);
    const bookingSnap = await bookingRef.get();

    if (!bookingSnap.exists) {
      return NextResponse.json({ error: "Booking not found" }, { status: 404 });
    }

    const bookingData = bookingSnap.data() as any;
    const ownerUid = bookingData.ownerUid || bookingData.ownerId || "";

    const tenantCheck = await verifyTenantAccess(
      userData.uid,
      userData.role,
      userData.ownerUid,
      ownerUid
    );
    if (!tenantCheck.allowed) {
      return NextResponse.json({ error: tenantCheck.error || "Access denied" }, { status: 403 });
    }

    const issues: any[] = Array.isArray(bookingData.additionalIssues) ? bookingData.additionalIssues : [];
    const issueIndex = issues.findIndex((i) => i.id === issueId);
    if (issueIndex < 0) {
      return NextResponse.json({ error: "Additional issue not found" }, { status: 404 });
    }

    const existingIssue = issues[issueIndex];
    if (existingIssue?.status === "rejected") {
      return NextResponse.json({ error: "This issue has already been rejected. Cannot set price or change status." }, { status: 400 });
    }

    const now = new Date().toISOString();
    const updatedIssues = [...issues];
    const issueSnap = updatedIssues[issueIndex] as Record<string, unknown>;
    const bodyPhone = typeof body.customerPhone === "string" ? body.customerPhone.trim() : "";
    const bodyEmail = typeof body.customerEmail === "string" ? body.customerEmail.trim() : "";
    const phoneForQuote =
      bodyPhone ||
      resolveCustomerPhoneForStorage(bookingData as Record<string, any>) ||
      resolveCustomerPhoneForStorage(issueSnap as Record<string, any>) ||
      null;
    const emailFromBody =
      bodyEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(bodyEmail) ? bodyEmail : "";
    const emailForQuote =
      emailFromBody ||
      resolveCustomerEmailForStorage(bookingData as Record<string, any>) ||
      resolveCustomerEmailForStorage(issueSnap as Record<string, any>) ||
      null;
    updatedIssues[issueIndex] = {
      ...updatedIssues[issueIndex],
      price: status === "approved" ? price : null,
      priceSetAt: now,
      priceSetByUid: userData.uid,
      priceSetByName: userData.name || "Admin",
      status,
      customerPhone: phoneForQuote,
      customerEmail: emailForQuote,
    };

    await bookingRef.update({
      additionalIssues: updatedIssues,
      updatedAt: FieldValue.serverTimestamp(),
    });

    const clientName = bookingData.client || bookingData.clientName || "Customer";
    const bookingCode = bookingData.bookingCode || null;
    const issueTitle = updatedIssues[issueIndex].issueTitle || "Additional work";

    // Audit log — record that an owner/branch admin set/declined a price for
    // an additional-work quote so it appears in the tenant audit trail.
    try {
      const actorRoleLower = (userData.role || "").toLowerCase();
      const actorRoleLabel =
        actorRoleLower === "workshop_owner"
          ? "owner"
          : actorRoleLower === "branch_admin"
            ? "branch admin"
            : actorRoleLower === "super_admin"
              ? "super admin"
              : "admin";
      const actorName = (userData.name || "").trim() || "Admin";
      const actorAttribution = `${actorName} (${actorRoleLabel})`;
      const previousPrice = (existingIssue as any)?.price;
      const hadPreviousPrice =
        typeof previousPrice === "number" && !isNaN(previousPrice);
      const isPriceUpdate =
        status === "approved" && hadPreviousPrice && previousPrice !== price;
      // Keep the headline short — the actor is surfaced in the
      // side-panel's "Performed By" section, and the `details` line
      // below preserves the narrative form for anyone who wants it.
      const auditAction =
        status === "rejected"
          ? `Additional work quote declined: ${issueTitle}`
          : isPriceUpdate
            ? `Additional work price updated: ${issueTitle} ($${Number(previousPrice).toFixed(2)} → $${Number(price).toFixed(2)})`
            : `Additional work priced: ${issueTitle} ($${Number(price).toFixed(2)})`;
      await createAuditLogServer({
        ownerUid,
        action: auditAction,
        actionType: status === "rejected" ? "status_change" : "update",
        entityType: "booking",
        entityId: id,
        entityName: bookingCode || `Booking for ${clientName}`,
        performedBy: userData.uid,
        performedByName: userData.name || "Admin",
        performedByRole: userData.role,
        previousValue:
          status === "rejected"
            ? "Pending"
            : hadPreviousPrice
              ? `$${Number(previousPrice).toFixed(2)}`
              : "No price",
        newValue:
          status === "rejected"
            ? "Rejected"
            : `$${Number(price).toFixed(2)}`,
        details: `Issue: ${issueTitle} · Customer: ${clientName} · Set by: ${actorName} (${userData.role})`,
        branchId: bookingData.branchId || undefined,
        branchName: bookingData.branchName || undefined,
        metadata: {
          issueId,
          status,
          price: status === "approved" ? price : null,
          previousPrice: hadPreviousPrice ? previousPrice : null,
          bookingCode: bookingCode || null,
          priceSetByUid: userData.uid,
          priceSetByName: actorName,
          priceSetByRole: userData.role,
        },
      });
    } catch (e) {
      console.error("Failed to write audit log for additional-issue price:", e);
    }

    // Notify customer only when approved with price (not when rejected)
    if (status === "approved" && price != null) {
      const customerEmail = bookingData.clientEmail || bookingData.customerId || "";
      const customerIdForNotif = bookingData.customerId || bookingData.clientEmail || "";

      // 1. Firestore notification (for mobile app if customer has customerUid)
      try {
        await createNotification({
          bookingId: id,
          bookingCode: bookingCode || undefined,
          type: "booking_status_changed" as any,
          title: "Additional Work Request",
          message: `${issueTitle}: $${price.toFixed(2)} - Please review and approve.`,
          status: "Confirmed",
          ownerUid,
          customerUid: bookingData.customerUid || undefined,
          customerEmail: customerEmail || undefined,
          customerPhone: bookingData.clientPhone || undefined,
          clientName,
          branchName: bookingData.branchName || undefined,
          bookingDate: bookingData.date || undefined,
          bookingTime: bookingData.time || undefined,
        } as any);
      } catch (e) {
        console.error("Failed to notify customer (Firestore):", e);
      }

      // 2. Email to customer
      if (customerEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) {
        try {
          const ownerDoc = await db.doc(`users/${ownerUid}`).get();
          const ownerData = ownerDoc.data();
          const workshopName = ownerData?.workshopName || ownerData?.displayName || "Workshop";
          const viewUrl = appendBookNowMyBookingsDeepLink(
            resolveBookingEngineUrl(ownerData),
          );
          await sendAdditionalIssuePriceSetEmail({
            to: customerEmail,
            customerName: clientName,
            issueTitle,
            price,
            bookingCode: bookingCode || undefined,
            workshopName,
            viewUrl,
            imageUrl: updatedIssues[issueIndex].imageUrl || undefined,
          });
        } catch (e) {
          console.error("Failed to send customer email:", e);
        }
      }

      // 3. Customer panel notification (book-now customers)
      if (customerIdForNotif) {
        try {
          const ownerDoc = await db.doc(`users/${ownerUid}`).get();
          const ownerData = ownerDoc.data();
          const workshopName = ownerData?.workshopName || ownerData?.displayName || "Workshop";
          await db.collection("customer_notifications").add({
            customerId: customerIdForNotif,
            ownerUid,
            type: "additional_issue_quote",
            bookingId: id,
            bookingCode: bookingCode || null,
            issueId,
            issueTitle,
            price,
            title: "Additional Work Quote Ready",
            message: `${issueTitle}: $${price.toFixed(2)} - Please review and approve or decline.`,
            read: false,
            customerPhone: phoneForQuote,
            clientPhone: phoneForQuote,
            customerName: resolveCustomerNameForStorage(bookingData as Record<string, any>) ?? null,
            ...CUSTOMER_NOTIFICATION_AGENT_TRACKING_DEFAULTS,
            workshopName,
            createdAt: FieldValue.serverTimestamp(),
          });
        } catch (e) {
          console.error("Failed to create customer panel notification:", e);
        }
      }
    }

    // When rejected: notify the staff who reported the issue so they see it in the app
    if (status === "rejected") {
      const reportedByStaffUid = updatedIssues[issueIndex].reportedByStaffUid || "";
      if (reportedByStaffUid) {
        try {
          await createAdditionalIssueRejectedNotification({
            bookingId: id,
            bookingCode: bookingCode || undefined,
            staffUid: reportedByStaffUid,
            staffName: updatedIssues[issueIndex].reportedByStaffName || undefined,
            clientName,
            issueTitle,
            serviceName: bookingData.serviceName || undefined,
            branchName: bookingData.branchName || undefined,
            bookingDate: bookingData.date || undefined,
            bookingTime: bookingData.time || undefined,
            ownerUid,
          });
        } catch (e) {
          console.error("Failed to notify staff of rejection:", e);
        }
      }
    }

    return NextResponse.json({ ok: true, issue: updatedIssues[issueIndex] });
  } catch (e: any) {
    console.error("Error in PATCH /api/bookings/[id]/additional-issues/[issueId]:", e);
    return NextResponse.json({ error: e?.message || "Internal error" }, { status: 500 });
  }
}
