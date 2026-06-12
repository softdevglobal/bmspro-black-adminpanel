import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";
import { FieldValue } from "firebase-admin/firestore";
import {
  verifyCallCenterOrTenantAdminAuth,
  canAccessWorkshopForAuth,
  CORS_HEADERS,
} from "@/lib/callCenterAuth";
import {
  createNotification,
  createAdditionalIssueRejectedNotification,
  CUSTOMER_NOTIFICATION_AGENT_TRACKING_DEFAULTS,
  resolveCustomerEmailForStorage,
  resolveCustomerNameForStorage,
  resolveCustomerPhoneForStorage,
} from "@/lib/notifications";
import { sendAdditionalIssuePriceSetEmail } from "@/lib/emailService";
import {
  appendBookNowMyBookingsDeepLink,
  resolveBookingEngineUrl,
} from "@/lib/customerAccount";
import { createAuditLogServer } from "@/lib/auditLogServer";

export const runtime = "nodejs";

export async function OPTIONS() {
  return NextResponse.json({}, { headers: CORS_HEADERS });
}

/**
 * PATCH /api/call-center/bookings/[id]/additional-issues/[issueId]/price
 *
 * Agent-side counterpart of the admin endpoint at
 * `PATCH /api/bookings/[id]/additional-issues/[issueId]`. Lets a call-center
 * agent (or a BMS workshop owner / branch admin using the Call Center panel)
 * quote a price for an additional-work issue reported by staff, or decline it
 * entirely. On success the customer is notified (Firestore notification,
 * email, and `customer_notifications` panel entry) exactly the same way the
 * admin flow does it, and the action is written to the tenant audit trail.
 *
 * Path is `/price` to avoid colliding with the existing agent PATCH at
 * `.../[issueId]` (which records the customer's accept/reject response).
 *
 * Auth:
 *   `Authorization: Bearer <agent-JWT>` + `X-Tenant-Id: <workshopOwnerUid>`
 *   (or a BMS admin ID token for workshop_owner / branch_admin / super_admin)
 *
 * Body:
 *   {
 *     status: "approved" | "rejected",   // required
 *     price?: number,                     // required when status === "approved" (>= 0)
 *     customerPhone?: string,             // optional — backfills if booking has none
 *     customerEmail?: string              // optional — backfills if booking has none
 *   }
 *
 * Guards:
 *   • Issue already `rejected` → 400 (cannot re-price)
 *   • Approved without a valid non-negative numeric price → 400
 *   • Booking not found → 404
 *   • Caller cannot access that workshop → 403
 */
export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string; issueId: string }> },
) {
  const gate = await verifyCallCenterOrTenantAdminAuth(req);
  if (!gate.success) {
    return NextResponse.json(
      { error: gate.error },
      { status: gate.status || 401, headers: CORS_HEADERS },
    );
  }

  const { id: bookingId, issueId } = await context.params;

  try {
    const body = (await req.json().catch(() => ({}))) as {
      status?: "approved" | "rejected";
      price?: number | string;
      customerPhone?: string;
      customerEmail?: string;
    };

    const status =
      body.status === "approved" || body.status === "rejected"
        ? body.status
        : "approved";

    const parsedPrice =
      status === "rejected"
        ? null
        : typeof body.price === "number"
          ? body.price
          : parseFloat(String(body.price ?? ""));

    if (
      status === "approved" &&
      (typeof parsedPrice !== "number" || Number.isNaN(parsedPrice) || parsedPrice < 0)
    ) {
      return NextResponse.json(
        { error: "Valid non-negative `price` is required when status is 'approved'." },
        { status: 400, headers: CORS_HEADERS },
      );
    }

    const db = adminDb();
    const bookingRef = db.doc(`bookings/${bookingId}`);
    const bookingSnap = await bookingRef.get();
    if (!bookingSnap.exists) {
      return NextResponse.json(
        { error: "Booking not found" },
        { status: 404, headers: CORS_HEADERS },
      );
    }
    const bookingData = bookingSnap.data() as Record<string, any>;
    const ownerUid = String(bookingData.ownerUid ?? bookingData.ownerId ?? "");

    if (!ownerUid || !canAccessWorkshopForAuth(gate.auth, ownerUid)) {
      return NextResponse.json(
        { error: "Access denied for this workshop" },
        { status: 403, headers: CORS_HEADERS },
      );
    }

    const issues: any[] = Array.isArray(bookingData.additionalIssues)
      ? bookingData.additionalIssues
      : [];
    const issueIndex = issues.findIndex((i) => i?.id === issueId);
    if (issueIndex < 0) {
      return NextResponse.json(
        { error: "Additional issue not found" },
        { status: 404, headers: CORS_HEADERS },
      );
    }

    const existingIssue = issues[issueIndex];
    if (existingIssue?.status === "rejected") {
      return NextResponse.json(
        {
          error:
            "This issue has already been rejected. It cannot be re-priced or re-opened.",
        },
        { status: 400, headers: CORS_HEADERS },
      );
    }

    // Actor & role resolution — mirrors the other call-center routes so the
    // tenant admin path (super_admin / workshop_owner / branch_admin using the
    // Call Center panel) stays consistent.
    const actor =
      gate.auth.kind === "agent"
        ? { uid: gate.auth.user.uid, name: gate.auth.user.name || "Call Center Agent" }
        : { uid: gate.auth.uid, name: gate.auth.name || "BMS Staff" };
    const actorRealRole =
      gate.auth.kind === "agent"
        ? gate.auth.user.role || "agent"
        : gate.auth.role;
    const actorKindLabel =
      gate.auth.kind === "agent"
        ? "call-center agent"
        : actorRealRole === "workshop_owner"
          ? "owner"
          : actorRealRole === "branch_admin"
            ? "branch admin"
            : actorRealRole === "super_admin"
              ? "super admin"
              : "admin";

    const now = new Date().toISOString();
    const updatedIssues = [...issues];
    const issueSnap = updatedIssues[issueIndex] as Record<string, unknown>;

    const bodyPhone =
      typeof body.customerPhone === "string" ? body.customerPhone.trim() : "";
    const bodyEmail =
      typeof body.customerEmail === "string" ? body.customerEmail.trim() : "";
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
      price: status === "approved" ? parsedPrice : null,
      priceSetAt: now,
      priceSetByUid: actor.uid,
      priceSetByName: actor.name,
      priceSetByRole: actorRealRole,
      priceSetBySource: "call_center",
      status,
      customerPhone: phoneForQuote,
      customerEmail: emailForQuote,
    };

    await bookingRef.update({
      additionalIssues: updatedIssues,
      updatedAt: FieldValue.serverTimestamp(),
    });

    const clientName =
      bookingData.client || bookingData.clientName || "Customer";
    const bookingCode = bookingData.bookingCode || null;
    const issueTitle = updatedIssues[issueIndex].issueTitle || "Additional work";

    // Audit log — keep the call-center path in sync with the admin path.
    try {
      const previousPrice = (existingIssue as any)?.price;
      const hadPreviousPrice =
        typeof previousPrice === "number" && !Number.isNaN(previousPrice);
      const isPriceUpdate =
        status === "approved" &&
        hadPreviousPrice &&
        previousPrice !== parsedPrice;
      const auditAction =
        status === "rejected"
          ? `Additional work quote declined: ${issueTitle}`
          : isPriceUpdate
            ? `Additional work price updated: ${issueTitle} ($${Number(previousPrice).toFixed(2)} → $${Number(parsedPrice).toFixed(2)})`
            : `Additional work priced: ${issueTitle} ($${Number(parsedPrice).toFixed(2)})`;
      await createAuditLogServer({
        ownerUid,
        action: auditAction,
        actionType: status === "rejected" ? "status_change" : "update",
        entityType: "booking",
        entityId: bookingId,
        entityName: bookingCode || `Booking for ${clientName}`,
        performedBy: actor.uid,
        performedByName: actor.name,
        performedByRole: actorRealRole || "agent",
        previousValue:
          status === "rejected"
            ? "Pending"
            : hadPreviousPrice
              ? `$${Number(previousPrice).toFixed(2)}`
              : "No price",
        newValue:
          status === "rejected"
            ? "Rejected"
            : `$${Number(parsedPrice).toFixed(2)}`,
        details: `Issue: ${issueTitle} · Customer: ${clientName} · Set by: ${actor.name} (${actorKindLabel})`,
        branchId: bookingData.branchId || undefined,
        branchName: bookingData.branchName || undefined,
        metadata: {
          issueId,
          status,
          price: status === "approved" ? parsedPrice : null,
          previousPrice: hadPreviousPrice ? previousPrice : null,
          bookingCode: bookingCode || null,
          priceSetByUid: actor.uid,
          priceSetByName: actor.name,
          priceSetByRole: actorRealRole,
          priceSetBySource: "call_center",
          recordedBySource: gate.auth.kind,
        },
      });
    } catch (e) {
      console.error(
        "[call-center/additional-issues price PATCH] audit log failed:",
        e,
      );
    }

    // Customer notifications / email (only when a price is set).
    if (status === "approved" && parsedPrice != null) {
      const customerEmail =
        bookingData.clientEmail || bookingData.customerId || "";
      const customerIdForNotif =
        bookingData.customerId || bookingData.clientEmail || "";

      // 1) Firestore notification (for mobile app if customer has customerUid).
      try {
        await createNotification({
          bookingId,
          bookingCode: bookingCode || undefined,
          type: "booking_status_changed" as any,
          title: "Additional Work Request",
          message: `${issueTitle}: $${parsedPrice.toFixed(2)} - Please review and approve.`,
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
        console.error(
          "[call-center/additional-issues price PATCH] customer Firestore notif failed:",
          e,
        );
      }

      // 2) Customer email.
      if (customerEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) {
        try {
          const ownerDoc = await db.doc(`users/${ownerUid}`).get();
          const ownerData = ownerDoc.data();
          const workshopName =
            ownerData?.workshopName || ownerData?.displayName || "Workshop";
          const viewUrl = appendBookNowMyBookingsDeepLink(
            resolveBookingEngineUrl(ownerData),
          );
          await sendAdditionalIssuePriceSetEmail({
            to: customerEmail,
            customerPhone: bookingData.clientPhone || undefined,
            customerName: clientName,
            issueTitle,
            price: parsedPrice,
            bookingCode: bookingCode || undefined,
            workshopName,
            viewUrl,
            imageUrl: updatedIssues[issueIndex].imageUrl || undefined,
          });
        } catch (e) {
          console.error(
            "[call-center/additional-issues price PATCH] customer email failed:",
            e,
          );
        }
      }

      // 3) Customer-panel notification (book-now customers).
      if (customerIdForNotif) {
        try {
          const ownerDoc = await db.doc(`users/${ownerUid}`).get();
          const ownerData = ownerDoc.data();
          const workshopName =
            ownerData?.workshopName || ownerData?.displayName || "Workshop";
          await db.collection("customer_notifications").add({
            customerId: customerIdForNotif,
            ownerUid,
            type: "additional_issue_quote",
            bookingId,
            bookingCode: bookingCode || null,
            issueId,
            issueTitle,
            price: parsedPrice,
            title: "Additional Work Quote Ready",
            message: `${issueTitle}: $${parsedPrice.toFixed(2)} - Please review and approve or decline.`,
            read: false,
            customerPhone: phoneForQuote,
            clientPhone: phoneForQuote,
            customerName:
              resolveCustomerNameForStorage(
                bookingData as Record<string, any>,
              ) ?? null,
            ...CUSTOMER_NOTIFICATION_AGENT_TRACKING_DEFAULTS,
            workshopName,
            createdAt: FieldValue.serverTimestamp(),
          });
        } catch (e) {
          console.error(
            "[call-center/additional-issues price PATCH] customer_notifications write failed:",
            e,
          );
        }
      }
    }

    // On rejection: tell the reporting staff member so it clears from their
    // "waiting for quote" view in the mobile app — mirrors admin behaviour.
    if (status === "rejected") {
      const reportedByStaffUid =
        updatedIssues[issueIndex].reportedByStaffUid || "";
      if (reportedByStaffUid) {
        try {
          await createAdditionalIssueRejectedNotification({
            bookingId,
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
          console.error(
            "[call-center/additional-issues price PATCH] staff rejection notif failed:",
            e,
          );
        }
      }
    }

    return NextResponse.json(
      {
        success: true,
        bookingId,
        issueId,
        status,
        price: status === "approved" ? parsedPrice : null,
        issue: updatedIssues[issueIndex],
      },
      { headers: CORS_HEADERS },
    );
  } catch (error: any) {
    console.error(
      "[call-center/additional-issues price PATCH] Error:",
      error,
    );
    return NextResponse.json(
      { error: error?.message || "Internal server error" },
      { status: 500, headers: CORS_HEADERS },
    );
  }
}
