import { NextRequest, NextResponse } from "next/server";
import { adminAuth, adminDb } from "@/lib/firebaseAdmin";
import { FieldValue } from "firebase-admin/firestore";
import { normalizeBookingStatus } from "@/lib/bookingTypes";
import {
  createNotification,
  createBranchAdminNotification,
  getBranchAdminUids,
  resolveCustomerEmailForStorage,
  resolveCustomerPhoneForStorage,
} from "@/lib/notifications";
import { checkRateLimit, getClientIdentifier, RateLimiters, getRateLimitHeaders } from "@/lib/rateLimiterDistributed";
import { sendAdditionalIssueNotificationEmail } from "@/lib/emailService";

export const runtime = "nodejs";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders });
}

/**
 * POST - Technician adds an additional issue found during inspection.
 * Notifies branch admin and owner.
 */
export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const clientId = getClientIdentifier(req);
    const rateLimitResult = await checkRateLimit(clientId, RateLimiters.statusUpdate);
    if (!rateLimitResult.success) {
      return NextResponse.json(
        { error: "Too many requests. Please try again later.", retryAfter: rateLimitResult.retryAfter },
        { status: 429, headers: { ...corsHeaders, ...getRateLimitHeaders(rateLimitResult) } }
      );
    }

    const { id } = await context.params;
    const authHeader = req.headers.get("authorization") || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders });
    }

    let staffUid: string;
    try {
      const decoded = await adminAuth().verifyIdToken(token);
      staffUid = decoded.uid;
    } catch {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders });
    }

    const body = (await req.json().catch(() => ({}))) as {
      issueTitle: string;
      description: string;
      recommendedRepair: string;
      partsRequired: string;
      labourTimeHours: number;
      serviceId?: string | null;
      imageUrl?: string | null;
      /** Optional snapshot when booking has no phone/email yet */
      customerPhone?: string;
      customerEmail?: string;
    };

    const issueTitle = (body.issueTitle || "").toString().trim();
    if (!issueTitle) {
      return NextResponse.json({ error: "Issue title is required" }, { status: 400, headers: corsHeaders });
    }

    const labourTimeHours = typeof body.labourTimeHours === "number" ? body.labourTimeHours : parseFloat(String(body.labourTimeHours || 0)) || 0;

    const db = adminDb();
    const staffDoc = await db.doc(`users/${staffUid}`).get();
    const staffData = staffDoc.data();
    const staffName = staffData?.name || staffData?.displayName || "Staff";

    const bookingRef = db.doc(`bookings/${id}`);
    const bookingSnap = await bookingRef.get();
    if (!bookingSnap.exists) {
      return NextResponse.json({ error: "Booking not found" }, { status: 404, headers: corsHeaders });
    }

    const bookingData = bookingSnap.data() as any;
    // Resolve ownerUid: booking first, then branch, then staff's ownerUid (never use staffUid as owner)
    let ownerUid = (bookingData.ownerUid || bookingData.ownerId || staffData?.ownerUid) as string | undefined;
    if (!ownerUid && bookingData.branchId) {
      const branchSnap = await db.doc(`branches/${bookingData.branchId}`).get();
      const branchData = branchSnap.data() as any;
      ownerUid = branchData?.ownerUid;
    }
    if (!ownerUid) ownerUid = staffData?.ownerUid;
    if (!ownerUid) {
      console.error("[additional-issues] No ownerUid found for booking - notification will be skipped");
    }
    const status = normalizeBookingStatus(bookingData.status);

    // Only Confirmed or Completed bookings can have additional issues
    if (status !== "Confirmed" && status !== "Completed") {
      return NextResponse.json({ error: "Additional issues can only be added for confirmed or completed bookings" }, { status: 400, headers: corsHeaders });
    }

    // Verify staff is assigned to this booking
    const hasMultipleServices = bookingData.services && Array.isArray(bookingData.services) && bookingData.services.length > 0;
    const isAssigned = hasMultipleServices
      ? bookingData.services.some((s: any) => s.staffId === staffUid || s.staffAuthUid === staffUid)
      : bookingData.staffId === staffUid || bookingData.staffAuthUid === staffUid;

    if (!isAssigned) {
      return NextResponse.json({ error: "You are not assigned to this booking" }, { status: 403, headers: corsHeaders });
    }

    const issueId = `issue_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const now = new Date().toISOString();

    const imageUrl = (body.imageUrl || "").toString().trim() || null;
    const postPhone = typeof body.customerPhone === "string" ? body.customerPhone.trim() : "";
    const postEmailRaw = typeof body.customerEmail === "string" ? body.customerEmail.trim() : "";
    const postEmail =
      postEmailRaw && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(postEmailRaw) ? postEmailRaw : "";
    const newIssue = {
      id: issueId,
      issueTitle,
      description: (body.description || "").toString().trim(),
      recommendedRepair: (body.recommendedRepair || "").toString().trim(),
      partsRequired: (body.partsRequired || "").toString().trim(),
      labourTimeHours,
      imageUrl,
      price: null,
      priceSetAt: null,
      priceSetByUid: null,
      priceSetByName: null,
      status: "pending",
      reportedAt: now,
      reportedByStaffUid: staffUid,
      reportedByStaffName: staffName,
      serviceId: body.serviceId ?? null,
      customerPhone:
        postPhone ||
        resolveCustomerPhoneForStorage(bookingData as Record<string, any>) ||
        null,
      customerEmail:
        postEmail ||
        resolveCustomerEmailForStorage(bookingData as Record<string, any>) ||
        null,
    };

    const existingIssues = Array.isArray(bookingData.additionalIssues) ? bookingData.additionalIssues : [];
    const updatedIssues = [...existingIssues, newIssue];

    await bookingRef.update({
      additionalIssues: updatedIssues,
      updatedAt: FieldValue.serverTimestamp(),
    });

    const clientName = bookingData.client || bookingData.clientName || "Customer";
    const bookingCode = bookingData.bookingCode || null;
    const branchId = bookingData.branchId || null;
    const branchName = bookingData.branchName || null;
    const bookingDate = bookingData.date || null;
    const bookingTime = bookingData.time || null;
    const serviceName = bookingData.serviceName || null;

    // Notify branch admin(s)
    if (branchId && ownerUid) {
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
            bookingDate: bookingDate || "",
            bookingTime: bookingTime || "",
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

    // Notify owner (only if we have valid ownerUid and it's not the staff themselves)
    if (ownerUid && ownerUid !== staffUid) {
      try {
        console.log(`[additional-issues] Creating notification for ownerUid: ${ownerUid}, booking: ${id}`);
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
    }

    // Send email to owner and branch admins
    const emailPayload = {
      staffName,
      issueTitle,
      description: newIssue.description || undefined,
      recommendedRepair: newIssue.recommendedRepair || undefined,
      partsRequired: newIssue.partsRequired || undefined,
      labourTimeHours: newIssue.labourTimeHours,
      clientName,
      bookingCode: bookingCode || undefined,
      branchName: branchName || undefined,
      bookingDate: bookingDate || undefined,
      bookingTime: bookingTime || undefined,
    };
    try {
      const ownerDoc = await db.doc(`users/${ownerUid}`).get();
      const ownerData = ownerDoc.data();
      const ownerEmail = ownerData?.email?.trim();
      if (ownerEmail) {
        await sendAdditionalIssueNotificationEmail({
          ...emailPayload,
          to: ownerEmail,
          recipientName: ownerData?.name || ownerData?.displayName,
        });
      }
      if (branchId && ownerUid) {
        const branchAdminUids = await getBranchAdminUids(db, branchId, ownerUid);
        for (const uid of branchAdminUids) {
          if (uid === ownerUid) continue;
          const adminDoc = await db.doc(`users/${uid}`).get();
          const adminData = adminDoc.data();
          const adminEmail = adminData?.email?.trim();
          if (adminEmail) {
            await sendAdditionalIssueNotificationEmail({
              ...emailPayload,
              to: adminEmail,
              recipientName: adminData?.name || adminData?.displayName,
            });
          }
        }
      }
    } catch (e) {
      console.error("Failed to send additional issue email:", e);
    }

    return NextResponse.json({ ok: true, issue: newIssue }, { headers: corsHeaders });
  } catch (e: any) {
    console.error("Error in POST /api/bookings/[id]/additional-issues:", e);
    return NextResponse.json({ error: e?.message || "Internal error" }, { status: 500, headers: corsHeaders });
  }
}
