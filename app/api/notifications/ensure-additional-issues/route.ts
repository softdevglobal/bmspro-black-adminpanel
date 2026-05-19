import { NextRequest, NextResponse } from "next/server";
import { adminAuth, adminDb } from "@/lib/firebaseAdmin";
import {
  createNotification,
  additionalIssueFoundNotificationExists,
  resolveCustomerEmailForStorage,
  resolveCustomerPhoneForStorage,
} from "@/lib/notifications";

export const runtime = "nodejs";

/**
 * POST - Ensure notifications exist for all additional issues awaiting price.
 * Call when owner loads dashboard to backfill any missed notifications.
 */
export async function POST(req: NextRequest) {
  try {
    const authHeader = req.headers.get("authorization") || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const decoded = await adminAuth().verifyIdToken(token);
    const ownerUid = decoded.uid;

    const db = adminDb();

    // Bound the backfill scan to bookings from the last 180 days. This route
    // is called on every session start by NotificationProvider, and previously
    // it read EVERY booking ever created for the owner on each call (often
    // thousands), only to find pending additional issues that are practically
    // always on recent bookings. The pre-existing client-side bookings
    // listeners that re-triggered this API have been removed alongside this
    // change, so this is now a once-per-session scan capped at ~6 months.
    const lookback = new Date();
    lookback.setDate(lookback.getDate() - 180);
    lookback.setHours(0, 0, 0, 0);
    const yyyy = lookback.getFullYear();
    const mm = String(lookback.getMonth() + 1).padStart(2, "0");
    const dd = String(lookback.getDate()).padStart(2, "0");
    const lookbackStr = `${yyyy}-${mm}-${dd}`;

    const [snap1, snap2] = await Promise.all([
      db
        .collection("bookings")
        .where("ownerUid", "==", ownerUid)
        .where("date", ">=", lookbackStr)
        .get(),
      db
        .collection("bookings")
        .where("ownerId", "==", ownerUid)
        .where("date", ">=", lookbackStr)
        .get(),
    ]);
    const allDocs = [...snap1.docs];
    for (const d of snap2.docs) {
      if (!allDocs.some((x) => x.id === d.id)) allDocs.push(d);
    }

    let created = 0;
    const seen = new Set<string>(); // bookingId:issueId to avoid duplicates

    for (const doc of allDocs) {
      const bookingData = doc.data() as any;
      const bookingId = doc.id;
      const issues: any[] = Array.isArray(bookingData.additionalIssues) ? bookingData.additionalIssues : [];

      for (const issue of issues) {
        if (issue.status !== "pending") continue; // Only issues awaiting price

        const issueId = issue.id || "";
        const key = `${bookingId}:${issueId}`;
        if (seen.has(key)) continue;

        // Must match `issueId` on notification docs (POST /additional-issues sets `issueId`, not `additionalIssueId`).
        if (issueId && (await additionalIssueFoundNotificationExists(db, bookingId, issueId))) {
          seen.add(key);
          continue;
        }

        seen.add(key);

        const staffName = issue.reportedByStaffName || "Staff";
        const issueTitle = issue.issueTitle || "Additional work";
        const clientName = bookingData.client || bookingData.clientName || "Customer";
        const bookingCode = bookingData.bookingCode || null;
        const branchId = bookingData.branchId || null;
        const branchName = bookingData.branchName || null;
        const bookingDate = bookingData.date || "";
        const bookingTime = bookingData.time || "";
        const serviceName = bookingData.serviceName || null;
        const notifyPhone =
          resolveCustomerPhoneForStorage(bookingData as Record<string, any>) || undefined;
        const notifyEmail =
          resolveCustomerEmailForStorage(bookingData as Record<string, any>) || undefined;

        try {
          await createNotification({
            bookingId,
            bookingCode: bookingCode || undefined,
            type: "additional_issue_found" as any,
            title: "Additional Issue Reported",
            message: `${staffName} found: ${issueTitle} (${clientName}) - ${bookingCode || bookingId}`,
            status: "Confirmed",
            ownerUid,
            targetOwnerUid: ownerUid,
            clientName,
            serviceName: serviceName || undefined,
            branchName: branchName || undefined,
            branchId: branchId || undefined,
            bookingDate: bookingDate || undefined,
            bookingTime: bookingTime || undefined,
            issueId,
            additionalIssueId: issueId,
            clientPhone: notifyPhone,
            customerPhone: notifyPhone,
            clientEmail: notifyEmail,
            customerEmail: notifyEmail,
          } as any);
          created++;
        } catch (e) {
          console.error("Failed to create backfill notification:", e);
        }
      }
    }

    return NextResponse.json({ ok: true, created });
  } catch (e: any) {
    console.error("Error in ensure-additional-issues:", e);
    // Return 401 for auth errors (expired/invalid token) so client can retry with fresh token
    const isAuthError = e?.code?.startsWith?.("auth/") || e?.message?.includes?.("id-token");
    const status = isAuthError ? 401 : 500;
    return NextResponse.json({ error: e?.message || "Internal error" }, { status });
  }
}
