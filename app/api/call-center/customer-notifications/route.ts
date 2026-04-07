import { NextRequest, NextResponse } from "next/server";
import type { QueryDocumentSnapshot } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebaseAdmin";
import {
  verifyCallCenterOrTenantAdminAuth,
  canAccessWorkshopForAuth,
  getTenantId,
  CORS_HEADERS,
} from "@/lib/callCenterAuth";

export const runtime = "nodejs";

export async function OPTIONS() {
  return NextResponse.json({}, { headers: CORS_HEADERS });
}

type MappedNotification = {
  id: string;
  customerId: string | null;
  ownerUid: string | null;
  type: string;
  estimateId: string | null;
  bookingId: string | null;
  bookingCode: string | null;
  issueId: string | null;
  issueTitle: string | null;
  price: number | null;
  title: string;
  message: string;
  read: boolean;
  workshopName: string | null;
  createdAt: string | null;
  customerName: string | null;
  customerEmail: string | null;
};

function mapDoc(
  doc: QueryDocumentSnapshot,
  customerMeta: Map<string, { name: string; email: string }>
): MappedNotification {
  const d = doc.data();
  const customerId = (d.customerId as string) || null;
  const meta = customerId ? customerMeta.get(customerId) : undefined;
  return {
    id: doc.id,
    customerId,
    ownerUid: (d.ownerUid as string) || null,
    type: (d.type as string) || "estimate_reply",
    estimateId: (d.estimateId as string) || null,
    bookingId: (d.bookingId as string) || null,
    bookingCode: (d.bookingCode as string) || null,
    issueId: (d.issueId as string) || null,
    issueTitle: (d.issueTitle as string) || null,
    price: typeof d.price === "number" ? d.price : null,
    title: (d.title as string) || "Notification",
    message: (d.message as string) || "",
    read: d.read === true,
    workshopName: (d.workshopName as string) || null,
    createdAt: d.createdAt?.toDate?.()?.toISOString() || null,
    customerName: meta?.name || null,
    customerEmail: meta?.email || null,
  };
}

/**
 * GET /api/call-center/customer-notifications?ownerUid=...&limit=100&unreadOnly=1
 *
 * Lists customer-facing notifications (estimate replies, additional work quotes, etc.)
 * for a workshop. Call center agents (assigned workshops) or BMS staff may call this.
 *
 * Headers: Authorization: Bearer <Firebase ID token>
 * Optional: X-Tenant-Id: <ownerUid> (or query ownerUid / tenantId)
 */
export async function GET(req: NextRequest) {
  const gate = await verifyCallCenterOrTenantAdminAuth(req);
  if (!gate.success) {
    return NextResponse.json(
      { error: gate.error },
      { status: gate.status || 401, headers: CORS_HEADERS }
    );
  }

  const ownerUid = getTenantId(req);
  if (!ownerUid?.trim()) {
    return NextResponse.json(
      { error: "Missing ownerUid (query param ownerUid / tenantId or X-Tenant-Id header)" },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  const tenant = ownerUid.trim();
  if (!canAccessWorkshopForAuth(gate.auth, tenant)) {
    return NextResponse.json(
      { error: "Access denied to this workshop" },
      { status: 403, headers: CORS_HEADERS }
    );
  }

  const limitParam = req.nextUrl.searchParams.get("limit");
  const limit = Math.min(500, Math.max(1, parseInt(limitParam || "100", 10) || 100));
  const unreadOnly =
    req.nextUrl.searchParams.get("unreadOnly") === "1" ||
    req.nextUrl.searchParams.get("unreadOnly")?.toLowerCase() === "true";

  try {
    const db = adminDb();

    const customerMeta = new Map<string, { name: string; email: string }>();
    const custSnap = await db.collection("customers").where("ownerUid", "==", tenant).get();
    for (const c of custSnap.docs) {
      const d = c.data();
      customerMeta.set(c.id, {
        name: String(d.name || d.client || d.fullName || "").trim() || "Customer",
        email: String(d.email || d.clientEmail || "").trim(),
      });
    }

    const seen = new Set<string>();
    const rows: MappedNotification[] = [];

    const byOwner = await db
      .collection("customer_notifications")
      .where("ownerUid", "==", tenant)
      .get();
    for (const doc of byOwner.docs) {
      seen.add(doc.id);
      rows.push(mapDoc(doc, customerMeta));
    }

    const customerIds = custSnap.docs.map((d) => d.id);
    for (let i = 0; i < customerIds.length; i += 30) {
      const chunk = customerIds.slice(i, i + 30);
      if (chunk.length === 0) continue;
      const snap = await db
        .collection("customer_notifications")
        .where("customerId", "in", chunk)
        .get();
      for (const doc of snap.docs) {
        if (seen.has(doc.id)) continue;
        seen.add(doc.id);
        rows.push(mapDoc(doc, customerMeta));
      }
    }

    rows.sort((a, b) => {
      const aT = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const bT = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return bT - aT;
    });

    let filtered = unreadOnly ? rows.filter((r) => !r.read) : rows;
    filtered = filtered.slice(0, limit);

    const unreadCount = rows.filter((r) => !r.read).length;

    return NextResponse.json(
      {
        notifications: filtered,
        totalFetched: rows.length,
        unreadCount,
        limit,
      },
      { headers: CORS_HEADERS }
    );
  } catch (error: any) {
    console.error("[call-center/customer-notifications GET]", error);
    return NextResponse.json(
      { error: error?.message || "Failed to fetch customer notifications" },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
