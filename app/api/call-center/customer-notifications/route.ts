import { NextRequest, NextResponse } from "next/server";
import type { Firestore, QueryDocumentSnapshot } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebaseAdmin";
import {
  verifyCallCenterOrTenantAdminAuth,
  canAccessWorkshopForAuth,
  getTenantId,
  CORS_HEADERS,
  type CallCenterRequestAuth,
} from "@/lib/callCenterAuth";

export const runtime = "nodejs";

export async function OPTIONS() {
  return NextResponse.json({}, { headers: CORS_HEADERS });
}

/** Super admin (BMS) or call center admin — may list all notifications system-wide. */
function canListSystemWideNotifications(auth: CallCenterRequestAuth): boolean {
  if (auth.kind === "tenant_admin" && auth.isSuperAdmin) return true;
  if (auth.kind === "agent" && auth.user.isCCAdmin) return true;
  return false;
}

type MappedNotification = {
  source: "customer_panel";
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

type MappedAdminNotification = {
  source: "admin_panel";
  id: string;
  type: string;
  title: string;
  message: string;
  read: boolean;
  ownerUid: string | null;
  bookingId: string | null;
  bookingCode: string | null;
  branchName: string | null;
  staffName: string | null;
  serviceName: string | null;
  clientName: string | null;
  createdAt: string | null;
  workshopName: string | null;
};

type UnifiedNotification = MappedNotification | MappedAdminNotification;

function mapCustomerDoc(
  doc: QueryDocumentSnapshot,
  customerMeta: Map<string, { name: string; email: string }>
): MappedNotification {
  const d = doc.data();
  const customerId = (d.customerId as string) || null;
  const meta = customerId ? customerMeta.get(customerId) : undefined;
  return {
    source: "customer_panel",
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

function mapAdminPanelDoc(
  doc: QueryDocumentSnapshot,
  ownerNames: Map<string, string>
): MappedAdminNotification {
  const d = doc.data();
  const ownerUid =
    (d.ownerUid as string) ||
    (d.targetOwnerUid as string) ||
    (d.targetAdminUid as string) ||
    null;
  return {
    source: "admin_panel",
    id: doc.id,
    type: (d.type as string) || "unknown",
    title: (d.title as string) || "Notification",
    message: (d.message as string) || "",
    read: d.read === true,
    ownerUid,
    bookingId: (d.bookingId as string) || null,
    bookingCode: (d.bookingCode as string) || null,
    branchName: (d.branchName as string) || null,
    staffName: (d.staffName as string) || null,
    serviceName: (d.serviceName as string) || null,
    clientName: (d.clientName as string) || null,
    createdAt: d.createdAt?.toDate?.()?.toISOString() || null,
    workshopName: ownerUid ? ownerNames.get(ownerUid) || null : null,
  };
}

function parseTime(iso: string | null): number {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? 0 : t;
}

const PAGE_SIZE = 500;

/** Read every document in a collection, newest first (paginated). Falls back to full scan if orderBy fails. */
async function fetchAllDocumentsNewestFirst(
  db: Firestore,
  collectionPath: string
): Promise<QueryDocumentSnapshot[]> {
  const col = db.collection(collectionPath);
  const out: QueryDocumentSnapshot[] = [];
  try {
    let last: QueryDocumentSnapshot | undefined;
    while (true) {
      let q = col.orderBy("createdAt", "desc").limit(PAGE_SIZE);
      if (last) q = q.startAfter(last);
      const snap = await q.get();
      if (snap.empty) break;
      out.push(...snap.docs);
      if (snap.docs.length < PAGE_SIZE) break;
      last = snap.docs[snap.docs.length - 1];
    }
    return out;
  } catch {
    const snap = await col.get();
    return snap.docs as QueryDocumentSnapshot[];
  }
}

/**
 * GET /api/call-center/customer-notifications
 *
 * **Workshop scope** — `ownerUid` (or X-Tenant-Id): all **booking-engine customer** notifications
 * for that tenant (`customer_notifications` only — what customers see in the public booking app).
 *
 * **System scope** — `all=1` or `scope=all`: all rows in `customer_notifications` system-wide
 * (booking engine inbox). Optional `includeAdmin=1` also merges internal `notifications`
 * (staff/admin app — not shown to booking customers). Super admin or call center admin only.
 *
 * Headers: Authorization: Bearer <Firebase ID token>
 */
export async function GET(req: NextRequest) {
  const gate = await verifyCallCenterOrTenantAdminAuth(req);
  if (!gate.success) {
    return NextResponse.json(
      { error: gate.error },
      { status: gate.status || 401, headers: CORS_HEADERS }
    );
  }

  const allParam = req.nextUrl.searchParams.get("all");
  const scopeParam = req.nextUrl.searchParams.get("scope");
  const systemWide =
    allParam === "1" ||
    allParam?.toLowerCase() === "true" ||
    scopeParam?.toLowerCase() === "all";

  /** When true, also loads internal `notifications` (admin/staff app). Default false — only booking-engine `customer_notifications`. */
  const includeAdminPanel =
    req.nextUrl.searchParams.get("includeAdmin") === "1" ||
    req.nextUrl.searchParams.get("includeAdmin")?.toLowerCase() === "true" ||
    req.nextUrl.searchParams.get("includeAdminPanel") === "1" ||
    req.nextUrl.searchParams.get("includeAdminPanel")?.toLowerCase() === "true";

  const unreadOnly =
    req.nextUrl.searchParams.get("unreadOnly") === "1" ||
    req.nextUrl.searchParams.get("unreadOnly")?.toLowerCase() === "true";

  if (systemWide) {
    if (!canListSystemWideNotifications(gate.auth)) {
      return NextResponse.json(
        {
          error:
            "System-wide list requires super admin or call center admin. Use ownerUid for workshop-scoped access.",
        },
        { status: 403, headers: CORS_HEADERS }
      );
    }

    try {
      const db = adminDb();

      const custDocs = await fetchAllDocumentsNewestFirst(db, "customer_notifications");
      const adminDocs = includeAdminPanel
        ? await fetchAllDocumentsNewestFirst(db, "notifications")
        : [];

      const customerIds = new Set<string>();
      const ownerUids = new Set<string>();
      for (const doc of custDocs) {
        const d = doc.data();
        if (d.customerId) customerIds.add(String(d.customerId));
        if (d.ownerUid) ownerUids.add(String(d.ownerUid));
      }
      for (const doc of adminDocs) {
        const d = doc.data();
        const ou = d.ownerUid || d.targetOwnerUid || d.targetAdminUid;
        if (ou) ownerUids.add(String(ou));
      }

      const customerMeta = new Map<string, { name: string; email: string }>();
      const customerIdList = [...customerIds];
      for (let i = 0; i < customerIdList.length; i += 10) {
        const chunk = customerIdList.slice(i, i + 10);
        if (chunk.length === 0) continue;
        const refs = chunk.map((cid) => db.collection("customers").doc(cid));
        const csnaps = await db.getAll(...refs);
        for (const cs of csnaps) {
          if (!cs.exists) continue;
          const c = cs.data()!;
          customerMeta.set(cs.id, {
            name: String(c.name || c.client || c.fullName || "").trim() || "Customer",
            email: String(c.email || c.clientEmail || "").trim(),
          });
        }
      }

      const ownerNames = new Map<string, string>();
      const ownerList = [...ownerUids];
      for (let i = 0; i < ownerList.length; i += 10) {
        const chunk = ownerList.slice(i, i + 10);
        const refs = chunk.map((id) => db.collection("users").doc(id));
        const snaps = await db.getAll(...refs);
        for (const s of snaps) {
          if (!s.exists) continue;
          const u = s.data()!;
          ownerNames.set(
            s.id,
            String(u.workshopName || u.displayName || u.name || u.businessName || "").trim() || "Workshop"
          );
        }
      }

      const merged: UnifiedNotification[] = [
        ...custDocs.map((doc) => mapCustomerDoc(doc, customerMeta)),
        ...adminDocs.map((doc) => mapAdminPanelDoc(doc, ownerNames)),
      ];

      merged.sort((a, b) => parseTime(b.createdAt) - parseTime(a.createdAt));

      let out = merged;
      if (unreadOnly) out = out.filter((r) => !r.read);

      const unreadCount = merged.filter((r) => !r.read).length;

      return NextResponse.json(
        {
          scope: "all",
          includeAdminPanel,
          notifications: out,
          totalMerged: merged.length,
          unreadCount,
          counts: {
            bookingEngineCustomer: custDocs.length,
            adminStaffApp: adminDocs.length,
          },
        },
        { headers: CORS_HEADERS }
      );
    } catch (error: any) {
      console.error("[call-center/customer-notifications GET system]", error);
      return NextResponse.json(
        { error: error?.message || "Failed to fetch system notifications" },
        { status: 500, headers: CORS_HEADERS }
      );
    }
  }

  const ownerUid = getTenantId(req);
  if (!ownerUid?.trim()) {
    return NextResponse.json(
      { error: "Missing ownerUid (query param ownerUid / tenantId or X-Tenant-Id header), or use all=1 with super admin / call center admin" },
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
      rows.push(mapCustomerDoc(doc, customerMeta));
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
        rows.push(mapCustomerDoc(doc, customerMeta));
      }
    }

    rows.sort((a, b) => parseTime(b.createdAt) - parseTime(a.createdAt));

    let filtered = unreadOnly ? rows.filter((r) => !r.read) : rows;

    const unreadCount = rows.filter((r) => !r.read).length;

    return NextResponse.json(
      {
        scope: "workshop",
        notifications: filtered,
        totalFetched: rows.length,
        unreadCount,
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
