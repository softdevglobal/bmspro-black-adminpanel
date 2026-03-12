import { NextRequest, NextResponse } from "next/server";
import { adminAuth, adminDb } from "@/lib/firebaseAdmin";
import { createNotification } from "@/lib/notifications";

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

    // Get all bookings for this owner (try ownerUid and ownerId)
    const [snap1, snap2] = await Promise.all([
      db.collection("bookings").where("ownerUid", "==", ownerUid).get(),
      db.collection("bookings").where("ownerId", "==", ownerUid).get(),
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

        // Check if notification already exists for this issue
        const notifSnap = await db
          .collection("notifications")
          .where("bookingId", "==", bookingId)
          .where("type", "==", "additional_issue_found")
          .limit(50)
          .get();

        const hasExisting = notifSnap.docs.some((d) => {
          const data = d.data();
          return data.additionalIssueId === issueId || data.message?.includes(issue.issueTitle || "");
        });
        if (hasExisting) {
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
            additionalIssueId: issueId,
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
