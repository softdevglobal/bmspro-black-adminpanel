import { NextRequest, NextResponse } from "next/server";
import type { DocumentData, Firestore, QueryDocumentSnapshot } from "firebase-admin/firestore";
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

/** `?all=1` — super admin, or any call center agent (scoped to assigned workshops unless CC admin / super admin). */
function canUseAllQueryParam(auth: CallCenterRequestAuth): boolean {
  if (auth.kind === "tenant_admin" && auth.isSuperAdmin) return true;
  if (auth.kind === "agent") return true;
  return false;
}

/** Full database read (no workshop filter): super admin or call center admin only. */
function hasFullSystemWideAccess(auth: CallCenterRequestAuth): boolean {
  if (auth.kind === "tenant_admin" && auth.isSuperAdmin) return true;
  if (auth.kind === "agent" && auth.user.isCCAdmin) return true;
  return false;
}

/**
 * Booking-engine `customer_notifications` for one or more workshop owner UIDs
 * (matches per-tenant logic: by ownerUid field + legacy via customers → customerId).
 */
async function fetchBookingEngineNotificationsForWorkshops(
  db: Firestore,
  workshopOwnerUids: string[]
): Promise<QueryDocumentSnapshot[]> {
  const normalized = [...new Set(workshopOwnerUids.map((x) => String(x).trim()).filter(Boolean))];
  if (normalized.length === 0) return [];

  const seen = new Set<string>();
  const rows: QueryDocumentSnapshot[] = [];

  for (let i = 0; i < normalized.length; i += 30) {
    const chunk = normalized.slice(i, i + 30);
    const snap = await db
      .collection("customer_notifications")
      .where("ownerUid", "in", chunk)
      .get();
    for (const doc of snap.docs) {
      if (seen.has(doc.id)) continue;
      seen.add(doc.id);
      rows.push(doc);
    }
  }

  for (const tenant of normalized) {
    const custSnap = await db.collection("customers").where("ownerUid", "==", tenant).get();
    const ids = custSnap.docs.map((d) => d.id);
    for (let j = 0; j < ids.length; j += 30) {
      const chunk = ids.slice(j, j + 30);
      if (chunk.length === 0) continue;
      const snap = await db
        .collection("customer_notifications")
        .where("customerId", "in", chunk)
        .get();
      for (const doc of snap.docs) {
        if (seen.has(doc.id)) continue;
        seen.add(doc.id);
        rows.push(doc);
      }
    }
  }

  return rows;
}

/** Internal `notifications` rows whose ownerUid is in the allowed workshop list (max 30 per `in` query). */
async function fetchAdminNotificationsForWorkshops(
  db: Firestore,
  workshopOwnerUids: string[]
): Promise<QueryDocumentSnapshot[]> {
  const normalized = [...new Set(workshopOwnerUids.map((x) => String(x).trim()).filter(Boolean))];
  if (normalized.length === 0) return [];

  const seen = new Set<string>();
  const rows: QueryDocumentSnapshot[] = [];

  for (let i = 0; i < normalized.length; i += 30) {
    const chunk = normalized.slice(i, i + 30);
    const snap = await db.collection("notifications").where("ownerUid", "in", chunk).get();
    for (const doc of snap.docs) {
      if (seen.has(doc.id)) continue;
      seen.add(doc.id);
      rows.push(doc);
    }
  }

  return rows;
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
  customerPhone: string | null;
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
  customerMeta: Map<string, { name: string; email: string; phone?: string }>
): MappedNotification {
  const d = doc.data();
  const customerId = (d.customerId as string) || null;
  const meta = customerId ? customerMeta.get(customerId) : undefined;
  const docPhone =
    (typeof d.customerPhone === "string" && d.customerPhone.trim()) ||
    (typeof d.clientPhone === "string" && d.clientPhone.trim()) ||
    "";
  const metaPhone = meta?.phone?.trim() || "";
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
    customerPhone: docPhone || metaPhone || null,
  };
}

/** Same blocklist as `lib/notifications` mirror — not shown as customer inbox. */
const NOT_CUSTOMER_INBOX_NOTIFICATION_TYPES = new Set([
  "staff_assignment",
  "staff_reassignment",
  "additional_issue_accepted",
  "additional_issue_rejected",
  "additional_issue_customer_rejected",
  "staff_rejected",
  "additional_issue_found",
  "staff_booking_created",
  "booking_needs_assignment",
  "booking_engine_new_booking",
]);

const LEGACY_BOOKING_TYPES_FOR_FULL_SCAN = [
  "booking_confirmed",
  "booking_completed",
  "booking_canceled",
  "booking_status_changed",
];

const BOOKING_CUSTOMER_NOTIFICATION_TYPES = new Set(LEGACY_BOOKING_TYPES_FOR_FULL_SCAN);

function dedupeKeyCustomerInbox(m: MappedNotification): string {
  return [
    m.customerId || "",
    m.bookingId || "",
    m.type,
    m.estimateId ?? "",
    m.issueId ?? "",
  ].join("|");
}

function mapNotificationsDocToCustomerPanel(
  doc: QueryDocumentSnapshot,
  customerMeta: Map<string, { name: string; email: string; phone?: string }>,
  ownerNames: Map<string, string>
): MappedNotification {
  const d = doc.data();
  const uid = typeof d.customerUid === "string" ? d.customerUid.trim() : "";
  const em =
    (typeof d.customerEmail === "string" && d.customerEmail.trim()) ||
    (typeof d.clientEmail === "string" && d.clientEmail.trim()) ||
    "";
  const customerId = uid || em || null;
  const meta = customerId ? customerMeta.get(customerId) : undefined;
  const ownerUid = (d.ownerUid as string) || null;
  const docPhone =
    (typeof d.customerPhone === "string" && d.customerPhone.trim()) ||
    (typeof d.clientPhone === "string" && d.clientPhone.trim()) ||
    "";
  const metaPhone = meta?.phone?.trim() || "";
  return {
    source: "customer_panel",
    id: doc.id,
    customerId,
    ownerUid,
    type: (d.type as string) || "booking_status_changed",
    estimateId: (d.estimateId as string) || null,
    bookingId: (d.bookingId as string) || null,
    bookingCode: (d.bookingCode as string) || null,
    issueId: (d.issueId as string) || null,
    issueTitle: (d.issueTitle as string) || null,
    price: typeof d.price === "number" ? d.price : null,
    title: (d.title as string) || "Notification",
    message: (d.message as string) || "",
    read: d.read === true,
    workshopName: (ownerUid ? ownerNames.get(ownerUid) : null) || (d.branchName as string) || null,
    createdAt: d.createdAt?.toDate?.()?.toISOString() || null,
    customerName: meta?.name || (d.clientName as string) || null,
    customerEmail: meta?.email || em || null,
    customerPhone: docPhone || metaPhone || null,
  };
}

function isCustomerFacingNotificationsDoc(d: DocumentData): boolean {
  const t = String(d.type || "");
  if (t && NOT_CUSTOMER_INBOX_NOTIFICATION_TYPES.has(t)) return false;

  const uid = d.customerUid;
  if (typeof uid === "string" && uid.trim()) return true;

  /**
   * Many booking status notifications only set `customerEmail` / `clientEmail` when the booking
   * has no Firebase `customerUid` — those rows were previously dropped from this API and never mirrored.
   */
  if (BOOKING_CUSTOMER_NOTIFICATION_TYPES.has(t)) {
    const em =
      (typeof d.customerEmail === "string" && d.customerEmail.trim()) ||
      (typeof d.clientEmail === "string" && d.clientEmail.trim());
    if (em) return true;
  }

  return false;
}

/**
 * Legacy rows in `notifications` aimed at customers (`customerUid` and/or booking-type + email).
 * Scoped: `ownerUid in workshops`. Unscoped: per booking type (full history) + recent scan for other customerUid rows.
 */
async function fetchLegacyCustomerBookingNotifications(
  db: Firestore,
  workshopOwnerUids: string[] | null
): Promise<QueryDocumentSnapshot[]> {
  const out: QueryDocumentSnapshot[] = [];
  const seen = new Set<string>();

  const visit = (doc: QueryDocumentSnapshot) => {
    const d = doc.data();
    if (!isCustomerFacingNotificationsDoc(d)) return;
    if (workshopOwnerUids !== null) {
      const ou = d.ownerUid as string | undefined;
      if (!ou || !workshopOwnerUids.includes(ou)) return;
    }
    if (seen.has(doc.id)) return;
    seen.add(doc.id);
    out.push(doc);
  };

  if (workshopOwnerUids !== null) {
    if (workshopOwnerUids.length === 0) return [];
    const normalized = [...new Set(workshopOwnerUids.map((x) => String(x).trim()).filter(Boolean))];
    for (let i = 0; i < normalized.length; i += 30) {
      const chunk = normalized.slice(i, i + 30);
      const snap = await db.collection("notifications").where("ownerUid", "in", chunk).get();
      snap.docs.forEach(visit);
    }
    return out;
  }

  for (const t of LEGACY_BOOKING_TYPES_FOR_FULL_SCAN) {
    try {
      let last: QueryDocumentSnapshot | undefined;
      while (true) {
        let q = db
          .collection("notifications")
          .where("type", "==", t)
          .orderBy("createdAt", "desc")
          .limit(PAGE_SIZE);
        if (last) q = q.startAfter(last);
        const snap = await q.get();
        if (snap.empty) break;
        snap.docs.forEach((doc) => {
          const d = doc.data();
          if (!isCustomerFacingNotificationsDoc(d)) return;
          if (seen.has(doc.id)) return;
          seen.add(doc.id);
          out.push(doc);
        });
        if (snap.docs.length < PAGE_SIZE) break;
        last = snap.docs[snap.docs.length - 1];
      }
    } catch {
      const snap = await db.collection("notifications").where("type", "==", t).get();
      snap.docs.forEach((doc) => {
        const d = doc.data();
        if (!isCustomerFacingNotificationsDoc(d)) return;
        if (seen.has(doc.id)) return;
        seen.add(doc.id);
        out.push(doc);
      });
    }
  }

  const rowsAfterBookingTypeQueries = out.length;
  const MAX_RECENT_SCAN_BATCHES = 60;
  const MAX_RECENT_CUSTOMER_ROWS = 4000;
  try {
    let last: QueryDocumentSnapshot | undefined;
    let batches = 0;
    while (batches < MAX_RECENT_SCAN_BATCHES) {
      let q = db.collection("notifications").orderBy("createdAt", "desc").limit(PAGE_SIZE);
      if (last) q = q.startAfter(last);
      const snap = await q.get();
      if (snap.empty) break;
      for (const doc of snap.docs) {
        const d = doc.data();
        if (!isCustomerFacingNotificationsDoc(d)) continue;
        if (seen.has(doc.id)) continue;
        seen.add(doc.id);
        out.push(doc);
        if (out.length - rowsAfterBookingTypeQueries >= MAX_RECENT_CUSTOMER_ROWS) break;
      }
      if (out.length - rowsAfterBookingTypeQueries >= MAX_RECENT_CUSTOMER_ROWS) break;
      batches += 1;
      if (snap.docs.length < PAGE_SIZE) break;
      last = snap.docs[snap.docs.length - 1];
    }
  } catch {
    /* orderBy(createdAt) may fail without index */
  }

  return out;
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
 * Every `customer_notifications` doc for all owners (no orderBy — Firestore would omit rows missing `createdAt`).
 * Sorted newest-first in memory for the merged response.
 */
async function fetchEntireCustomerNotificationsCollection(
  db: Firestore
): Promise<QueryDocumentSnapshot[]> {
  const snap = await db.collection("customer_notifications").get();
  const docs = [...snap.docs] as QueryDocumentSnapshot[];
  docs.sort(
    (a, b) =>
      parseTime(b.data().createdAt?.toDate?.()?.toISOString() || null) -
      parseTime(a.data().createdAt?.toDate?.()?.toISOString() || null)
  );
  return docs;
}

/**
 * GET /api/call-center/customer-notifications
 *
 * **Workshop scope** — `ownerUid` (or X-Tenant-Id): all **booking-engine customer** notifications
 * for that tenant (`customer_notifications` only — what customers see in the public booking app).
 *
 * **System scope** — `all=1` or `scope=all`: booking-engine customer notifications for **all owners / all customers**.
 * Any **call center agent** or **super admin** with `all=1` loads the full `customer_notifications` collection (plus legacy `notifications` with customerUid).
 * **Customer-only feed (default):** `notifications` entries have `source: "customer_panel"` — same Firestore data customers see
 * (`customer_notifications` plus legacy `notifications` with `customerUid`). Use **`customerOnly=1`** to force that even if a client sends `includeAdmin=1`.
 * Optional **`includeAdmin=1`**: also append internal staff/admin rows (`source: "admin_panel"`); full internal collection for **super admin** or **call center admin**, scoped for agents.
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

  /**
   * When true, also merges internal `notifications` (admin/staff app) into the list (`source: "admin_panel"`).
   * Default false — response is **only what customers see** (book-now inbox + legacy rows with `customerUid`).
   */
  const customerOnly =
    req.nextUrl.searchParams.get("customerOnly") === "1" ||
    req.nextUrl.searchParams.get("customerOnly")?.toLowerCase() === "true";
  const includeAdminPanel =
    !customerOnly &&
    (req.nextUrl.searchParams.get("includeAdmin") === "1" ||
      req.nextUrl.searchParams.get("includeAdmin")?.toLowerCase() === "true" ||
      req.nextUrl.searchParams.get("includeAdminPanel") === "1" ||
      req.nextUrl.searchParams.get("includeAdminPanel")?.toLowerCase() === "true");

  const unreadOnly =
    req.nextUrl.searchParams.get("unreadOnly") === "1" ||
    req.nextUrl.searchParams.get("unreadOnly")?.toLowerCase() === "true";

  if (systemWide) {
    if (!canUseAllQueryParam(gate.auth)) {
      return NextResponse.json(
        {
          error:
            "Use ?all=1 with a call center or super admin account, or pass ownerUid for workshop-scoped access.",
        },
        { status: 403, headers: CORS_HEADERS }
      );
    }

    try {
      const db = adminDb();
      const fullAccess = hasFullSystemWideAccess(gate.auth);
      /**
       * `canUseAllQueryParam` only allows super admin or call center agents — both get every owner's
       * customer_notifications + system-wide legacy customer rows (not filtered by assigned workshops).
       */
      let scopedToWorkshops: string[] | null = null;
      if (!fullAccess && gate.auth.kind === "agent") {
        scopedToWorkshops = [...gate.auth.user.assignedWorkshops];
      }

      const custDocs = await fetchEntireCustomerNotificationsCollection(db);

      const adminDocs =
        includeAdminPanel && fullAccess
          ? await fetchAllDocumentsNewestFirst(db, "notifications")
          : includeAdminPanel && gate.auth.kind === "agent"
            ? await fetchAdminNotificationsForWorkshops(
                db,
                gate.auth.user.assignedWorkshops
              )
            : [];

      const legacyScope: string[] | null = null;
      const legacyDocs = await fetchLegacyCustomerBookingNotifications(db, legacyScope);

      const customerIds = new Set<string>();
      const ownerUids = new Set<string>();
      for (const doc of custDocs) {
        const d = doc.data();
        if (d.customerId) customerIds.add(String(d.customerId));
        if (d.ownerUid) ownerUids.add(String(d.ownerUid));
      }
      for (const doc of legacyDocs) {
        const d = doc.data();
        if (d.customerUid) customerIds.add(String(d.customerUid));
        if (typeof d.customerEmail === "string" && d.customerEmail.trim()) {
          customerIds.add(d.customerEmail.trim());
        }
        if (typeof d.clientEmail === "string" && d.clientEmail.trim()) {
          customerIds.add(d.clientEmail.trim());
        }
        if (d.ownerUid) ownerUids.add(String(d.ownerUid));
      }
      for (const doc of adminDocs) {
        const d = doc.data();
        const ou = d.ownerUid || d.targetOwnerUid || d.targetAdminUid;
        if (ou) ownerUids.add(String(ou));
      }

      const customerMeta = new Map<string, { name: string; email: string; phone?: string }>();
      const customerIdList = [...customerIds];
      for (let i = 0; i < customerIdList.length; i += 10) {
        const chunk = customerIdList.slice(i, i + 10);
        if (chunk.length === 0) continue;
        const refs = chunk.map((cid) => db.collection("customers").doc(cid));
        const csnaps = await db.getAll(...refs);
        for (const cs of csnaps) {
          if (!cs.exists) continue;
          const c = cs.data()!;
          const ph = String(c.phone || c.clientPhone || "").trim();
          customerMeta.set(cs.id, {
            name: String(c.name || c.client || c.fullName || "").trim() || "Customer",
            email: String(c.email || c.clientEmail || "").trim(),
            ...(ph ? { phone: ph } : {}),
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

      const inboxByKey = new Map<string, MappedNotification>();
      for (const doc of custDocs) {
        const m = mapCustomerDoc(doc, customerMeta);
        inboxByKey.set(dedupeKeyCustomerInbox(m), m);
      }
      for (const doc of legacyDocs) {
        const m = mapNotificationsDocToCustomerPanel(doc, customerMeta, ownerNames);
        const k = dedupeKeyCustomerInbox(m);
        if (!inboxByKey.has(k)) inboxByKey.set(k, m);
      }
      const customerInboxRows = Array.from(inboxByKey.values()).sort(
        (a, b) => parseTime(b.createdAt) - parseTime(a.createdAt)
      );

      const merged: UnifiedNotification[] = [
        ...customerInboxRows,
        ...adminDocs.map((doc) => mapAdminPanelDoc(doc, ownerNames)),
      ];

      let out = merged;
      if (unreadOnly) out = out.filter((r) => !r.read);

      const unreadCount = merged.filter((r) => !r.read).length;

      return NextResponse.json(
        {
          scope: "all",
          fullSystemAccess: fullAccess,
          scopedToWorkshops,
          customerOnly,
          includeAdminPanel,
          /** Same inbox as book-now per customer: `customer_notifications` + legacy `notifications` (customerUid). */
          customerFacingNotificationCount: customerInboxRows.length,
          notifications: out,
          totalMerged: merged.length,
          unreadCount,
          counts: {
            bookingEngineCustomerInbox: customerInboxRows.length,
            customerNotificationsDocs: custDocs.length,
            legacyNotificationsMerged: legacyDocs.length,
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
      { error: "Missing ownerUid (query param ownerUid / tenantId or X-Tenant-Id header), or use all=1 as a call center / super admin user" },
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

    const customerMeta = new Map<string, { name: string; email: string; phone?: string }>();
    const custSnap = await db.collection("customers").where("ownerUid", "==", tenant).get();
    for (const c of custSnap.docs) {
      const d = c.data();
      const ph = String(d.phone || d.clientPhone || "").trim();
      customerMeta.set(c.id, {
        name: String(d.name || d.client || d.fullName || "").trim() || "Customer",
        email: String(d.email || d.clientEmail || "").trim(),
        ...(ph ? { phone: ph } : {}),
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

    const ownerNames = new Map<string, string>();
    const userSnap = await db.collection("users").doc(tenant).get();
    if (userSnap.exists) {
      const u = userSnap.data()!;
      ownerNames.set(
        tenant,
        String(u.workshopName || u.displayName || u.name || u.businessName || "").trim() || "Workshop"
      );
    }

    const legacyDocs = await fetchLegacyCustomerBookingNotifications(db, [tenant]);

    const inboxByKey = new Map<string, MappedNotification>();
    for (const row of rows) {
      inboxByKey.set(dedupeKeyCustomerInbox(row), row);
    }
    for (const doc of legacyDocs) {
      const m = mapNotificationsDocToCustomerPanel(doc, customerMeta, ownerNames);
      const k = dedupeKeyCustomerInbox(m);
      if (!inboxByKey.has(k)) inboxByKey.set(k, m);
    }
    const mergedRows = Array.from(inboxByKey.values()).sort(
      (a, b) => parseTime(b.createdAt) - parseTime(a.createdAt)
    );

    let filtered = unreadOnly ? mergedRows.filter((r) => !r.read) : mergedRows;

    const unreadCount = mergedRows.filter((r) => !r.read).length;

    return NextResponse.json(
      {
        scope: "workshop",
        notifications: filtered,
        totalFetched: mergedRows.length,
        unreadCount,
        counts: {
          customerNotificationsDocs: rows.length,
          legacyNotificationsMerged: legacyDocs.length,
        },
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
