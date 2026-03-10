import { NextRequest, NextResponse } from "next/server";
import { adminAuth, adminDb } from "@/lib/firebaseAdmin";
import { createNotification, createBranchAdminNotification, getBranchAdminUids } from "@/lib/notifications";

export const runtime = "nodejs";

/**
 * POST - Create owner/branch admin notifications for an additional issue
 * that was added via Firestore fallback (when main API failed).
 * Call this from Flutter after direct Firestore update.
 */
export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const authHeader = req.headers.get("authorization") || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let staffUid: string;
    try {
      const decoded = await adminAuth().verifyIdToken(token);
      staffUid = decoded.uid;
    } catch {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const db = adminDb();
    const bookingSnap = await db.doc(`bookings/${id}`).get();
    if (!bookingSnap.exists) {
      return NextResponse.json({ error: "Booking not found" }, { status: 404 });
    }

    const bookingData = bookingSnap.data() as any;
    const issues: any[] = Array.isArray(bookingData.additionalIssues) ? bookingData.additionalIssues : [];
    const lastIssue = issues[issues.length - 1];
    if (!lastIssue) {
      return NextResponse.json({ error: "No additional issue to notify" }, { status: 400 });
    }

    let ownerUid = (bookingData.ownerUid || bookingData.ownerId || "") as string;
    if (!ownerUid && bookingData.branchId) {
      const branchSnap = await db.doc(`branches/${bookingData.branchId}`).get();
      const branchData = branchSnap.data() as any;
      ownerUid = branchData?.ownerUid || "";
    }
    const staffDoc = await db.doc(`users/${staffUid}`).get();
    const staffData = staffDoc.data();
    if (!ownerUid) ownerUid = staffData?.ownerUid || "";
    if (!ownerUid || ownerUid === staffUid) {
      return NextResponse.json({ error: "Booking has no owner" }, { status: 400 });
    }

    const staffName = lastIssue.reportedByStaffName || staffData?.name || staffData?.displayName || "Staff";
    const issueTitle = lastIssue.issueTitle || "Additional work";
    const clientName = bookingData.client || bookingData.clientName || "Customer";
    const bookingCode = bookingData.bookingCode || null;
    const branchId = bookingData.branchId || null;
    const branchName = bookingData.branchName || null;
    const bookingDate = bookingData.date || "";
    const bookingTime = bookingData.time || "";
    const serviceName = bookingData.serviceName || null;

    // Notify branch admin(s)
    if (branchId) {
      try {
        const branchAdminUids = await getBranchAdminUids(db, branchId, ownerUid);
        for (const branchAdminUid of branchAdminUids) {
          await createBranchAdminNotification({
            bookingId: id,
            bookingCode: bookingCode || undefined,
            branchAdminUid,
            ownerUid,
            clientName,
            serviceName: serviceName || undefined,
            branchName: branchName || undefined,
            branchId,
            bookingDate,
            bookingTime,
            status: "Confirmed",
            type: "additional_issue_found" as any,
            title: "Additional Issue Reported",
            message: `${staffName} found: ${issueTitle} (${clientName}) - ${bookingCode || id}`,
          });
        }
      } catch (e) {
        console.error("Failed to notify branch admin:", e);
      }
    }

    // Notify owner
    try {
      await createNotification({
        bookingId: id,
        bookingCode: bookingCode || undefined,
        type: "additional_issue_found" as any,
        title: "Additional Issue Reported",
        message: `${staffName} found: ${issueTitle} (${clientName}) - ${bookingCode || id}`,
        status: "Confirmed",
        ownerUid,
        targetOwnerUid: ownerUid,
        clientName,
        serviceName: serviceName || undefined,
        branchName: branchName || undefined,
        branchId: branchId || undefined,
        bookingDate: bookingDate || undefined,
        bookingTime: bookingTime || undefined,
      } as any);
    } catch (e) {
      console.error("Failed to notify owner:", e);
    }

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error("Error in POST additional-issues/notify:", e);
    return NextResponse.json({ error: e?.message || "Internal error" }, { status: 500 });
  }
}
