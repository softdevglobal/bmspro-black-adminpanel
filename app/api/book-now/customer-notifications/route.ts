import { NextRequest, NextResponse } from "next/server";
import { agentTrackingFieldsFromFirestore } from "@/lib/customerNotificationAgentTrackingFields";
import { adminDb } from "@/lib/firebaseAdmin";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const customerId = req.nextUrl.searchParams.get("customerId");

    if (!customerId) {
      return NextResponse.json({ error: "Missing customerId" }, { status: 400 });
    }

    const db = adminDb();
    let snap;
    try {
      snap = await db
        .collection("customer_notifications")
        .where("customerId", "==", customerId)
        .orderBy("createdAt", "desc")
        .limit(20)
        .get();
    } catch (indexErr) {
      // Fallback if composite index not yet created
      snap = await db
        .collection("customer_notifications")
        .where("customerId", "==", customerId)
        .limit(50)
        .get();
    }

    const notifications = snap.docs
      .map((doc) => {
      const d = doc.data();
      return {
        id: doc.id,
        type: d.type || "estimate_reply",
        estimateId: d.estimateId || null,
        bookingId: d.bookingId || null,
        bookingCode: d.bookingCode || null,
        issueId: d.issueId || null,
        issueTitle: d.issueTitle || null,
        price: typeof d.price === "number" ? d.price : null,
        documentId: d.documentId || null,
        documentKind: d.documentKind || null,
        documentCode: d.documentCode || null,
        jobTitle: d.jobTitle || null,
        totalAud: typeof d.totalAud === "number" ? d.totalAud : null,
        dueDate: d.dueDate || null,
        pdfUrl: typeof d.pdfUrl === "string" ? d.pdfUrl : null,
        title: d.title || "Notification",
        message: d.message || "",
        read: d.read === true,
        workshopName: d.workshopName || null,
        customerPhone:
          (typeof d.customerPhone === "string" && d.customerPhone.trim()) ||
          (typeof d.clientPhone === "string" && d.clientPhone.trim()) ||
          null,
        customerName:
          (typeof d.customerName === "string" && d.customerName.trim()) ||
          (typeof d.clientName === "string" && d.clientName.trim()) ||
          null,
        notificationReviewed: d.notificationReviewed === true,
        calledCustomer: d.calledCustomer === true,
        ...agentTrackingFieldsFromFirestore(d as Record<string, unknown>),
        createdAt: d.createdAt?.toDate?.()?.toISOString() || null,
      };
    })
      .sort((a, b) => {
        const aT = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const bT = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return bT - aT;
      })
      .slice(0, 20);

    const unreadCount = notifications.filter((n) => !n.read).length;

    return NextResponse.json({ notifications, unreadCount });
  } catch (error: any) {
    console.error("Error fetching customer notifications:", error);
    return NextResponse.json(
      { error: error.message || "Failed to fetch notifications" },
      { status: 500 }
    );
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json();
    const { customerId, notificationIds } = body;

    if (!customerId || !Array.isArray(notificationIds) || notificationIds.length === 0) {
      return NextResponse.json(
        { error: "Missing customerId or notificationIds" },
        { status: 400 }
      );
    }

    const db = adminDb();
    const batch = db.batch();

    for (const id of notificationIds) {
      const ref = db.collection("customer_notifications").doc(id);
      const doc = await ref.get();
      if (doc.exists && doc.data()?.customerId === customerId) {
        batch.update(ref, { read: true });
      }
    }

    await batch.commit();
    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error("Error marking notifications as read:", error);
    return NextResponse.json(
      { error: error.message || "Failed to update notifications" },
      { status: 500 }
    );
  }
}

/**
 * Delete one or more customer_notifications that belong to the caller.
 *
 * Body (preferred):  { customerId, notificationIds: string[] }
 * Query (fallback):  ?customerId=...&notificationIds=a,b,c
 *
 * A notification is only removed when its `customerId` field matches the
 * supplied `customerId` — this prevents one customer from deleting another's
 * notifications via a stolen document id.
 */
export async function DELETE(req: NextRequest) {
  try {
    const url = req.nextUrl;
    let customerId: string | null = url.searchParams.get("customerId");
    const idsQuery = url.searchParams.get("notificationIds");
    let notificationIds: string[] = idsQuery
      ? idsQuery.split(",").map((s) => s.trim()).filter(Boolean)
      : [];

    // Prefer JSON body when present (covers clients that can't send a body
    // with DELETE via query string).
    try {
      const body = await req.json();
      if (body?.customerId) customerId = String(body.customerId);
      if (Array.isArray(body?.notificationIds)) {
        notificationIds = body.notificationIds.map((x: unknown) => String(x)).filter(Boolean);
      }
    } catch {
      /* no JSON body; rely on query params */
    }

    if (!customerId || notificationIds.length === 0) {
      return NextResponse.json(
        { error: "Missing customerId or notificationIds" },
        { status: 400 }
      );
    }

    const db = adminDb();
    const batch = db.batch();
    let deleted = 0;

    for (const id of notificationIds) {
      const ref = db.collection("customer_notifications").doc(id);
      const doc = await ref.get();
      if (doc.exists && doc.data()?.customerId === customerId) {
        batch.delete(ref);
        deleted += 1;
      }
    }

    if (deleted > 0) {
      await batch.commit();
    }
    return NextResponse.json({ success: true, deleted });
  } catch (error: any) {
    console.error("Error deleting customer notifications:", error);
    return NextResponse.json(
      { error: error.message || "Failed to delete notifications" },
      { status: 500 }
    );
  }
}
