import { NextRequest, NextResponse } from "next/server";
import type { Firestore, QueryDocumentSnapshot } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebaseAdmin";
import { isCustomerFacingNotificationsDoc } from "@/lib/callCenterCustomerInboxFilters";
import {
  enrichNotificationAgentTrackingFromProfiles,
  loadActorProfilesByUid,
} from "@/lib/callCenterNotificationActorProfiles";
import { agentTrackingFieldsFromFirestore } from "@/lib/customerNotificationAgentTrackingFields";
import { firestoreDocBestIso } from "@/lib/firestoreDocTimestamps";
import {
  dedupeNewEstimateNotifications,
  fetchCallCenterOpsNotifications,
  fetchEstimatesForCallCenter,
  mapEstimateDocForCallCenterFeed,
  type MappedEstimateFeedItem,
} from "@/lib/callCenterNotificationFeedExtras";
import {
  resolveCustomerEmailForStorage,
  resolveCustomerNameForStorage,
  resolveCustomerPhoneForStorage,
} from "@/lib/notifications";
import {
  verifyCallCenterOrTenantAdminAuth,
  canAccessWorkshopForAuth,
  getTenantId,
  CORS_HEADERS,
  type CallCenterRequestAuth,
} from "@/lib/callCenterAuth";
import {
  buildCallCenterNotificationsCacheKey,
  readCallCenterNotificationsCache,
  writeCallCenterNotificationsCache,
} from "@/lib/callCenterNotificationsResponseCache";

export const runtime = "nodejs";

export async function OPTIONS() {
  return NextResponse.json({}, { headers: CORS_HEADERS });
}

/** `?all=1` — super admin tenant, or any call center agent. */
function canUseAllQueryParam(auth: CallCenterRequestAuth): boolean {
  if (auth.kind === "tenant_admin" && auth.isSuperAdmin) return true;
  if (auth.kind === "agent") return true;
  return false;
}

/**
 * “Full access” merges (no workshop filter on aggregates + `fullSystemAccess: true`):
 * platform super_admin, **`call_center_admin`**, or **unscoped** agents (`assignedWorkshops` empty).
 * Scoped agents use `scopedToWorkshops` + {@link fetchAdminNotificationsForWorkshops} instead.
 */
function hasFullSystemWideAccess(auth: CallCenterRequestAuth): boolean {
  if (auth.kind === "tenant_admin" && auth.isSuperAdmin) return true;
  if (auth.kind === "agent" && auth.user.isCCAdmin) return true;
  if (auth.kind === "agent" && auth.user.assignedWorkshops.length === 0) return true;
  return false;
}

/**
 * Hard caps for the call-center inbox.
 *
 * Reads on this endpoint were the dominant Firestore cost driver (millions/day):
 * a single polled GET could read every `customer_notifications` doc plus every
 * `notifications` doc plus a 4 000-row "recent scan" of `notifications`. The
 * call center only displays the newest N rows in the inbox, so we cap every
 * fetch to a recent window + a row ceiling, then merge in memory.
 *
 * Defaults are deliberately tight (50 rows / 14 days). When polled at ~1 req/min
 * the old defaults (300 rows / 60 days) read ≥ 1500 docs per call across the
 * various underlying queries — easily ~1M reads/day in Firestore billing for a
 * single agent. The live inbox only ever surfaces the newest ~50 rows.
 *
 * Tune via query string if a tenant genuinely needs deeper history:
 * `?limit=<n>` (≤ MAX_HARD_CAP) and `?sinceDays=<n>` (≤ MAX_LOOKBACK_DAYS).
 */
const DEFAULT_INBOX_LIMIT = 50;
const MAX_HARD_CAP = 1000;
const MAX_LOOKBACK_DAYS = 365;
const DEFAULT_LOOKBACK_DAYS = 14;
const MAX_OPS_PER_TYPE = 100;
const MAX_PER_WORKSHOP_CHUNK = 100;

// In-memory response cache lives in `lib/callCenterNotificationsResponseCache.ts`
// so mutation endpoints (`notification-reviewed`, `called-customer`) can flush
// it after writes — see `invalidateCallCenterNotificationsCache()`.

function clampLimit(raw: string | null, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), MAX_HARD_CAP);
}

function clampLookbackDays(raw: string | null, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), MAX_LOOKBACK_DAYS);
}

function lookbackDateFromDays(days: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Booking-engine `customer_notifications` for one or more workshop owner UIDs
 * (matches per-tenant logic: by ownerUid field + legacy via customers → customerId).
 * Bounded to most-recent `MAX_PER_WORKSHOP_CHUNK` per `in` chunk so a tenant with
 * many historical rows can't blow up read counts on every poll.
 */
async function fetchBookingEngineNotificationsForWorkshops(
  db: Firestore,
  workshopOwnerUids: string[],
  perChunkLimit: number = MAX_PER_WORKSHOP_CHUNK
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
      .orderBy("createdAt", "desc")
      .limit(perChunkLimit)
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
        .orderBy("createdAt", "desc")
        .limit(perChunkLimit)
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

/**
 * Internal `notifications` rows whose ownerUid is in the allowed workshop list
 * (max 30 per `in` query). Bounded to the most recent `perChunkLimit` rows per
 * chunk; the call-center inbox only displays the newest items anyway.
 */
async function fetchAdminNotificationsForWorkshops(
  db: Firestore,
  workshopOwnerUids: string[],
  perChunkLimit: number = MAX_PER_WORKSHOP_CHUNK
): Promise<QueryDocumentSnapshot[]> {
  const normalized = [...new Set(workshopOwnerUids.map((x) => String(x).trim()).filter(Boolean))];
  if (normalized.length === 0) return [];

  const seen = new Set<string>();
  const rows: QueryDocumentSnapshot[] = [];

  for (let i = 0; i < normalized.length; i += 30) {
    const chunk = normalized.slice(i, i + 30);
    const snap = await db
      .collection("notifications")
      .where("ownerUid", "in", chunk)
      .orderBy("createdAt", "desc")
      .limit(perChunkLimit)
      .get();
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
  /** Filled from `bookings` when enriching additional-issue rows */
  issueStatus: string | null;
  issueDescription: string | null;
  title: string;
  message: string;
  read: boolean;
  workshopName: string | null;
  createdAt: string | null;
  customerName: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  /** Call center agent has reviewed/opened this notification. */
  notificationReviewed: boolean;
  /** Call center agent has called the customer. */
  calledCustomer: boolean;
  notificationReviewedByUid: string | null;
  notificationReviewedByName: string | null;
  notificationReviewedByDisplayName: string | null;
  notificationReviewedByEmail: string | null;
  calledCustomerByUid: string | null;
  calledCustomerByName: string | null;
  calledCustomerByDisplayName: string | null;
  calledCustomerByEmail: string | null;
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
  /** Same customer as `clientName`; use for call-center UI parity with `customer_panel`. */
  customerName: string | null;
  createdAt: string | null;
  workshopName: string | null;
  estimateId: string | null;
  issueId: string | null;
  issueTitle: string | null;
  price: number | null;
  /** Sub-document status on `bookings./additionalIssues[]` (pending, priced, …) */
  issueStatus: string | null;
  /** Short text from the issue; truncated when read from Firestore for list payloads */
  issueDescription: string | null;
  /** Booking / workflow status when present on the notification doc. */
  status: string | null;
  /** Customer contact on staff/ops notifications (e.g. additional_issue_found). */
  customerPhone: string | null;
  clientPhone: string | null;
  customerEmail: string | null;
  notificationReviewed: boolean;
  calledCustomer: boolean;
  notificationReviewedByUid: string | null;
  notificationReviewedByName: string | null;
  notificationReviewedByDisplayName: string | null;
  notificationReviewedByEmail: string | null;
  calledCustomerByUid: string | null;
  calledCustomerByName: string | null;
  calledCustomerByDisplayName: string | null;
  calledCustomerByEmail: string | null;
};

type UnifiedNotification =
  | MappedNotification
  | MappedAdminNotification
  | MappedEstimateFeedItem;

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
  const docCustomerName =
    (typeof d.customerName === "string" && d.customerName.trim()) ||
    (typeof d.clientName === "string" && d.clientName.trim()) ||
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
    issueStatus: strOrNull((d as Record<string, unknown>).issueStatus) ?? null,
    issueDescription: strOrNull((d as Record<string, unknown>).issueDescription) ?? null,
    title: (d.title as string) || "Notification",
    message: (d.message as string) || "",
    read: d.read === true,
    workshopName: (d.workshopName as string) || null,
    createdAt: firestoreDocBestIso(d as Record<string, unknown>, ["createdAt", "updatedAt"]),
    customerName: meta?.name || docCustomerName || null,
    customerEmail: meta?.email || null,
    customerPhone: docPhone || metaPhone || null,
    notificationReviewed: d.notificationReviewed === true,
    calledCustomer: d.calledCustomer === true,
    ...agentTrackingFieldsFromFirestore(d as Record<string, unknown>),
  };
}

function dedupeKeyCustomerInbox(m: MappedNotification): string {
  return [
    m.customerId || "",
    m.bookingId || "",
    m.type,
    m.estimateId ?? "",
    m.issueId ?? "",
  ].join("|");
}

/**
 * All rows from `customer_notifications` are kept (estimates, additional quotes, booking lifecycle, etc.).
 * Legacy `notifications` rows are only added when no `customer_notifications` doc already represents the
 * same business key (avoids duplicate mirror + legacy). Coarse dedupe keys must not collapse two real CN docs.
 */
function mergeCustomerPanelInbox(
  fromCustomerNotifications: MappedNotification[],
  legacyDocs: QueryDocumentSnapshot[],
  customerMeta: Map<string, { name: string; email: string; phone?: string }>,
  ownerNames: Map<string, string>
): MappedNotification[] {
  const cnBusinessKeys = new Set(
    fromCustomerNotifications.map((m) => dedupeKeyCustomerInbox(m))
  );
  const fromLegacy: MappedNotification[] = [];
  for (const doc of legacyDocs) {
    const m = mapNotificationsDocToCustomerPanel(doc, customerMeta, ownerNames);
    if (!cnBusinessKeys.has(dedupeKeyCustomerInbox(m))) {
      fromLegacy.push(m);
    }
  }
  return [...fromCustomerNotifications, ...fromLegacy].sort(
    (a, b) => parseTime(b.createdAt) - parseTime(a.createdAt)
  );
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
  const docCustomerName =
    (typeof d.customerName === "string" && d.customerName.trim()) ||
    (typeof d.clientName === "string" && d.clientName.trim()) ||
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
    issueStatus: strOrNull((d as Record<string, unknown>).issueStatus) ?? null,
    issueDescription: strOrNull((d as Record<string, unknown>).issueDescription) ?? null,
    title: (d.title as string) || "Notification",
    message: (d.message as string) || "",
    read: d.read === true,
    workshopName: (ownerUid ? ownerNames.get(ownerUid) : null) || (d.branchName as string) || null,
    createdAt: firestoreDocBestIso(d as Record<string, unknown>, ["createdAt", "updatedAt"]),
    customerName: meta?.name || docCustomerName || null,
    customerEmail: meta?.email || em || null,
    customerPhone: docPhone || metaPhone || null,
    notificationReviewed: d.notificationReviewed === true,
    calledCustomer: d.calledCustomer === true,
    ...agentTrackingFieldsFromFirestore(d as Record<string, unknown>),
  };
}

/**
 * Legacy rows in `notifications` aimed at customers (`customerUid` and/or booking-type + email).
 *
 * Scoped: a single bounded read per workshop chunk, ordered by `createdAt desc`,
 * capped at `perChunkLimit` rows. Unscoped (system wide): the most recent
 * `recentLimit` rows of `notifications` filtered in memory; we no longer scan
 * the historical collection per booking type.
 *
 * Previously this function could read up to 4 000 + (500 × types) docs per
 * call. The call-center inbox only ever surfaces the newest customer rows, so
 * bounding to recent rows is functionally equivalent.
 */
async function fetchLegacyCustomerBookingNotifications(
  db: Firestore,
  workshopOwnerUids: string[] | null,
  options: { perChunkLimit?: number; recentLimit?: number; sinceDays?: number } = {}
): Promise<QueryDocumentSnapshot[]> {
  const perChunkLimit = options.perChunkLimit ?? MAX_PER_WORKSHOP_CHUNK;
  const recentLimit = options.recentLimit ?? DEFAULT_INBOX_LIMIT;
  const sinceCutoff = lookbackDateFromDays(options.sinceDays ?? DEFAULT_LOOKBACK_DAYS);

  const out: QueryDocumentSnapshot[] = [];
  const seen = new Set<string>();

  if (workshopOwnerUids !== null) {
    if (workshopOwnerUids.length === 0) return [];
    const normalized = [...new Set(workshopOwnerUids.map((x) => String(x).trim()).filter(Boolean))];
    for (let i = 0; i < normalized.length; i += 30) {
      const chunk = normalized.slice(i, i + 30);
      const snap = await db
        .collection("notifications")
        .where("ownerUid", "in", chunk)
        .orderBy("createdAt", "desc")
        .limit(perChunkLimit)
        .get();
      for (const doc of snap.docs) {
        const d = doc.data();
        if (!isCustomerFacingNotificationsDoc(d)) continue;
        if (seen.has(doc.id)) continue;
        seen.add(doc.id);
        out.push(doc);
      }
    }
    return out;
  }

  try {
    const snap = await db
      .collection("notifications")
      .where("createdAt", ">=", sinceCutoff)
      .orderBy("createdAt", "desc")
      .limit(recentLimit)
      .get();
    for (const doc of snap.docs) {
      const d = doc.data();
      if (!isCustomerFacingNotificationsDoc(d)) continue;
      if (seen.has(doc.id)) continue;
      seen.add(doc.id);
      out.push(doc);
    }
  } catch {
    try {
      const snap = await db
        .collection("notifications")
        .orderBy("createdAt", "desc")
        .limit(recentLimit)
        .get();
      for (const doc of snap.docs) {
        const d = doc.data();
        if (!isCustomerFacingNotificationsDoc(d)) continue;
        if (seen.has(doc.id)) continue;
        seen.add(doc.id);
        out.push(doc);
      }
    } catch {
      /* orderBy may fail without a single-field index; fall through */
    }
  }

  return out;
}

function strOrNull(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}

/**
 * Same booking+issue from ensure + POST produced duplicate Firestore docs; keep newest-first row only.
 */
function dedupeAdminPanelAdditionalIssueFound(rows: UnifiedNotification[]): UnifiedNotification[] {
  const seen = new Set<string>();
  return rows.filter((r) => {
    if (r.source !== "admin_panel") return true;
    const m = r as MappedAdminNotification;
    if (m.type !== "additional_issue_found") return true;
    const bid = m.bookingId?.trim();
    const iid = (m.issueId || "").trim();
    if (!bid || !iid) return true;
    const key = `${bid}::${iid}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
  const phone = strOrNull(d.customerPhone) || strOrNull(d.clientPhone);
  const email = strOrNull(d.customerEmail) || strOrNull(d.clientEmail);
  const displayName = resolveCustomerNameForStorage(d as Record<string, any>);
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
    clientName: displayName,
    customerName: displayName,
    createdAt: d.createdAt?.toDate?.()?.toISOString() || null,
    workshopName: ownerUid ? ownerNames.get(ownerUid) || null : null,
    estimateId: (d.estimateId as string) || null,
    issueId:
      strOrNull(d.issueId) ||
      strOrNull((d as Record<string, unknown>).additionalIssueId),
    issueTitle: (d.issueTitle as string) || null,
    price: typeof d.price === "number" ? d.price : null,
    issueStatus: strOrNull((d as Record<string, unknown>).issueStatus) ?? null,
    issueDescription: strOrNull((d as Record<string, unknown>).issueDescription) ?? null,
    status: typeof d.status === "string" ? d.status : null,
    customerPhone: phone,
    clientPhone: phone,
    customerEmail: email,
    notificationReviewed: d.notificationReviewed === true,
    calledCustomer: d.calledCustomer === true,
    ...agentTrackingFieldsFromFirestore(d as Record<string, unknown>),
  };
}

/** Older `additional_issue_found` rows may lack contact or customer name on the notification — fill from `bookings/{id}`. */
async function enrichAdminPanelAdditionalIssueBookingContact(
  db: Firestore,
  items: UnifiedNotification[]
): Promise<UnifiedNotification[]> {
  const bookingIds = new Set<string>();
  for (const r of items) {
    if (r.source !== "admin_panel") continue;
    const m = r as MappedAdminNotification;
    if (m.type !== "additional_issue_found") continue;
    const bid = m.bookingId?.trim();
    if (!bid) continue;
    const ph = (m.customerPhone || m.clientPhone || "").toString().trim();
    const nm = (m.clientName || m.customerName || "").toString().trim();
    if (ph && nm) continue;
    bookingIds.add(bid);
  }
  if (bookingIds.size === 0) return items;

  const byId = new Map<
    string,
    { phone: string | null; email: string | null; customerName: string | null }
  >();
  const ids = [...bookingIds];
  for (let i = 0; i < ids.length; i += 10) {
    const chunk = ids.slice(i, i + 10);
    const snaps = await db.getAll(...chunk.map((id) => db.doc(`bookings/${id}`)));
    for (let j = 0; j < chunk.length; j++) {
      const doc = snaps[j];
      if (!doc.exists) continue;
      const raw = doc.data()!;
      byId.set(chunk[j], {
        phone: resolveCustomerPhoneForStorage(raw as Record<string, any>),
        email: resolveCustomerEmailForStorage(raw as Record<string, any>),
        customerName: resolveCustomerNameForStorage(raw as Record<string, any>),
      });
    }
  }

  return items.map((r) => {
    if (r.source !== "admin_panel") return r;
    const m = r as MappedAdminNotification;
    if (m.type !== "additional_issue_found" || !m.bookingId?.trim()) return r;
    const ph = (m.customerPhone || m.clientPhone || "").toString().trim();
    const nm = (m.clientName || m.customerName || "").toString().trim();
    if (ph && nm) return r;
    const got = byId.get(m.bookingId.trim());
    if (!got || (!got.phone && !got.email && !got.customerName)) return r;
    return {
      ...m,
      customerPhone: ph || got.phone,
      clientPhone: ph || got.phone,
      customerEmail: (m.customerEmail || "").trim() || got.email,
      clientName: nm || got.customerName || m.clientName,
      customerName: nm || got.customerName || m.customerName,
    } as UnifiedNotification;
  });
}

/** Best-effort match an `additionalIssues[]` entry to a notification (id hint, message title, or most recent). */
function pickAdditionalIssueForNotification(
  message: string,
  issueIdOnDoc: string | null,
  issues: Array<Record<string, unknown>>
): Record<string, unknown> | null {
  if (!Array.isArray(issues) || issues.length === 0) return null;
  const idHint = (issueIdOnDoc || "").trim();
  if (idHint) {
    const byId = issues.find((x) => x && String(x.id || "") === idHint);
    if (byId) return byId;
  }
  for (const iss of issues) {
    const t = String(iss?.issueTitle || "").trim();
    if (t && message.includes(t)) return iss;
  }
  return issues.slice().sort((a, b) => {
    const ta = new Date(String(a?.reportedAt || 0)).getTime();
    const tb = new Date(String(b?.reportedAt || 0)).getTime();
    return tb - ta;
  })[0];
}

/**
 * Fills `issueId` / `issueTitle` / `price` / status / description from `bookings/{id}.additionalIssues`
 * when those fields were missing on older `additional_issue_found` notification docs.
 */
async function enrichAdditionalIssueMetadataFromBookings(
  db: Firestore,
  items: UnifiedNotification[]
): Promise<UnifiedNotification[]> {
  const hitIdx: { idx: number; bookingId: string }[] = [];
  for (let i = 0; i < items.length; i++) {
    const r = items[i];
    if (r.source !== "admin_panel" && r.source !== "customer_panel") continue;
    const t = r as MappedAdminNotification | MappedNotification;
    if (t.type !== "additional_issue_found") continue;
    const bid = t.bookingId?.trim();
    if (!bid) continue;
    hitIdx.push({ idx: i, bookingId: bid });
  }
  if (hitIdx.length === 0) return items;

  const uniqueIds = [...new Set(hitIdx.map((h) => h.bookingId))];
  const bookingData = new Map<string, Record<string, unknown> | null>();
  for (let i = 0; i < uniqueIds.length; i += 10) {
    const chunk = uniqueIds.slice(i, i + 10);
    const snaps = await db.getAll(...chunk.map((id) => db.doc(`bookings/${id}`)));
    for (let j = 0; j < chunk.length; j++) {
      const doc = snaps[j];
      bookingData.set(chunk[j], doc.exists ? (doc.data() as Record<string, unknown>) : null);
    }
  }

  const out = [...items];
  for (const { idx, bookingId } of hitIdx) {
    const raw = bookingData.get(bookingId);
    if (!raw) continue;
    const issues = Array.isArray(raw.additionalIssues)
      ? (raw.additionalIssues as Array<Record<string, unknown>>)
      : [];
    const row = out[idx] as MappedAdminNotification | MappedNotification;
    const issue = pickAdditionalIssueForNotification(
      row.message,
      row.issueId,
      issues
    );
    if (!issue) continue;

    const id = String(issue.id || "").trim() || row.issueId;
    const issueTitle = String(issue.issueTitle || "").trim() || row.issueTitle;
    const priceFromIssue =
      typeof issue.price === "number" && Number.isFinite(issue.price)
        ? issue.price
        : null;
    const price =
      priceFromIssue != null ? priceFromIssue : row.price != null ? row.price : null;
    const issueStatus = issue.status != null ? String(issue.status) : null;
    const descRaw = String(issue.description || "").trim();
    const issueDescription = descRaw ? descRaw.slice(0, 500) : null;
    const reportedBy = String(issue.reportedByStaffName || "").trim() || null;

    if (row.source === "admin_panel") {
      const a = row as MappedAdminNotification;
      out[idx] = {
        ...a,
        issueId: id || a.issueId,
        issueTitle: issueTitle || a.issueTitle,
        price,
        issueStatus: issueStatus ?? a.issueStatus,
        issueDescription: issueDescription ?? a.issueDescription,
        staffName: a.staffName || reportedBy,
        serviceName: a.serviceName || (raw.serviceName != null ? String(raw.serviceName) : null),
      } as UnifiedNotification;
    } else {
      const c = row as MappedNotification;
      out[idx] = {
        ...c,
        issueId: id || c.issueId,
        issueTitle: issueTitle || c.issueTitle,
        price,
        issueStatus: issueStatus ?? c.issueStatus,
        issueDescription: issueDescription ?? c.issueDescription,
      } as UnifiedNotification;
    }
  }
  return out;
}

async function enrichUnifiedNotificationsList(
  db: Firestore,
  items: UnifiedNotification[]
): Promise<UnifiedNotification[]> {
  const uids = new Set<string>();
  for (const r of items) {
    if (r.source !== "customer_panel" && r.source !== "admin_panel") continue;
    const t = r as MappedNotification | MappedAdminNotification;
    if (t.notificationReviewedByUid?.trim()) uids.add(t.notificationReviewedByUid.trim());
    if (t.calledCustomerByUid?.trim()) uids.add(t.calledCustomerByUid.trim());
  }
  if (uids.size === 0) return items;
  const profiles = await loadActorProfilesByUid(db, [...uids]);
  return items.map((r) => {
    if (r.source !== "customer_panel" && r.source !== "admin_panel") return r;
    return enrichNotificationAgentTrackingFromProfiles(
      r as MappedNotification | MappedAdminNotification,
      profiles
    ) as UnifiedNotification;
  });
}

function unifiedItemCreatedAt(r: UnifiedNotification): string | null {
  return r.createdAt ?? null;
}

function parseTime(iso: string | null): number {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Read the most-recent `limit` documents from a collection ordered by
 * `createdAt desc`. Falls back to a bounded unordered read of the same size
 * when the ordered query fails (e.g. missing index in a fresh project).
 *
 * We deliberately do **not** paginate beyond `limit`: the call-center inbox
 * surfaces the newest rows and old rows are not useful for the live workflow.
 */
async function fetchRecentDocumentsNewestFirst(
  db: Firestore,
  collectionPath: string,
  rowLimit: number,
  sinceDays?: number
): Promise<QueryDocumentSnapshot[]> {
  const col = db.collection(collectionPath);
  const effLimit = Math.max(1, Math.min(rowLimit, MAX_HARD_CAP));
  try {
    const lookback = lookbackDateFromDays(sinceDays ?? DEFAULT_LOOKBACK_DAYS);
    let q = col
      .where("createdAt", ">=", lookback)
      .orderBy("createdAt", "desc")
      .limit(effLimit);
    let snap = await q.get();
    if (snap.empty) {
      q = col.orderBy("createdAt", "desc").limit(effLimit);
      snap = await q.get();
    }
    return snap.docs as QueryDocumentSnapshot[];
  } catch {
    try {
      const snap = await col.orderBy("createdAt", "desc").limit(effLimit).get();
      return snap.docs as QueryDocumentSnapshot[];
    } catch {
      const snap = await col.limit(effLimit).get();
      return snap.docs as QueryDocumentSnapshot[];
    }
  }
}

/**
 * Most-recent `customer_notifications` docs across all owners, newest first.
 * Bounded by `rowLimit` to keep system-wide polling from re-reading historical rows.
 */
async function fetchRecentCustomerNotificationsCollection(
  db: Firestore,
  rowLimit: number,
  sinceDays?: number
): Promise<QueryDocumentSnapshot[]> {
  return fetchRecentDocumentsNewestFirst(db, "customer_notifications", rowLimit, sinceDays);
}

/**
 * GET /api/call-center/customer-notifications
 *
 * **Workshop scope** — `ownerUid` (or X-Tenant-Id): all **booking-engine customer** notifications
 * for that tenant (`customer_notifications` only — what customers see in the public booking app).
 *
 * **System scope** — `all=1` or `scope=all`: customer inbox plus **call-center extras** (unless `customerOnly=1`):
 * - `additional_issue_found` and `new_estimate` from `notifications` (when not already covered by `includeAdmin=1`).
 * - All **`estimates`** documents (`source: "estimate"`) with vehicle / description / status.
 * **`fullSystemAccess`** is true for super admin, **`call_center_admin`**, or **unscoped** agents (empty `assignedWorkshops`).
 * Scoped agents merge only tenants in `assignedWorkshops`.
 * **Customer-only feed:** `customerOnly=1` — hide ops notifications and estimate records (book-now inbox only).
 * Optional **`includeAdmin=1`**: full `notifications` as `admin_panel` (includes ops types; dedicated ops fetch is skipped to avoid duplicates).
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

  const inboxLimit = clampLimit(req.nextUrl.searchParams.get("limit"), DEFAULT_INBOX_LIMIT);
  const sinceDays = clampLookbackDays(
    req.nextUrl.searchParams.get("sinceDays"),
    DEFAULT_LOOKBACK_DAYS
  );

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

    const cacheKey = buildCallCenterNotificationsCacheKey(gate.auth, {
      customerOnly,
      includeAdminPanel,
      unreadOnly,
      inboxLimit,
      sinceDays,
    });
    const cached = readCallCenterNotificationsCache(cacheKey);
    if (cached) {
      return NextResponse.json(
        { ...cached, cached: true },
        { headers: CORS_HEADERS }
      );
    }

    try {
      const db = adminDb();
      const fullAccess = hasFullSystemWideAccess(gate.auth);
      /**
       * Call center agents without CC-admin: data is limited to `assignedWorkshops` (owner UIDs).
       * Empty `assignedWorkshops` matches booking/services/chat: unscoped agents see all tenants.
       * Super admins and call_center_admin agents see all tenants.
       */
      let scopedToWorkshops: string[] | null = null;
      if (!fullAccess && gate.auth.kind === "agent") {
        const aw = gate.auth.user.assignedWorkshops;
        scopedToWorkshops = aw.length > 0 ? [...aw] : null;
      }

      const workshopScopeForFetch: string[] | null = fullAccess
        ? null
        : gate.auth.kind === "agent"
          ? scopedToWorkshops
          : null;

      const estimateDocs = !customerOnly
        ? await fetchEstimatesForCallCenter(db, workshopScopeForFetch, {
            rowLimit: inboxLimit,
            sinceDays,
          })
        : [];
      const opsDocsDedicated =
        !customerOnly && !includeAdminPanel
          ? await fetchCallCenterOpsNotifications(db, workshopScopeForFetch, {
              perTypeLimit: Math.min(inboxLimit, MAX_OPS_PER_TYPE),
              sinceDays,
            })
          : [];

      const custDocs = await fetchRecentCustomerNotificationsCollection(
        db,
        inboxLimit,
        sinceDays
      );

      const adminDocs =
        includeAdminPanel && fullAccess
          ? await fetchRecentDocumentsNewestFirst(
              db,
              "notifications",
              inboxLimit,
              sinceDays
            )
          : includeAdminPanel && gate.auth.kind === "agent"
            ? await fetchAdminNotificationsForWorkshops(
                db,
                gate.auth.user.assignedWorkshops,
                Math.min(inboxLimit, MAX_PER_WORKSHOP_CHUNK)
              )
            : [];

      const legacyScope: string[] | null = null;
      const legacyDocs = await fetchLegacyCustomerBookingNotifications(db, legacyScope, {
        recentLimit: inboxLimit,
        sinceDays,
      });

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
      for (const doc of estimateDocs) {
        const ou = doc.data().ownerUid;
        if (ou) ownerUids.add(String(ou));
      }
      for (const doc of opsDocsDedicated) {
        const ou = doc.data().ownerUid;
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

      const fromCn = custDocs.map((doc) => mapCustomerDoc(doc, customerMeta));
      const customerInboxRows = mergeCustomerPanelInbox(
        fromCn,
        legacyDocs,
        customerMeta,
        ownerNames
      );

      const estimateRows = estimateDocs.map((doc) =>
        mapEstimateDocForCallCenterFeed(doc, ownerNames)
      );
      const estimateFirestoreIds = new Set(estimateRows.map((e) => e.id));

      const opsMappedDedicated = dedupeNewEstimateNotifications(
        opsDocsDedicated.map((doc) => mapAdminPanelDoc(doc, ownerNames)),
        estimateFirestoreIds
      );

      const adminMapped = dedupeNewEstimateNotifications(
        includeAdminPanel
          ? adminDocs.map((doc) => mapAdminPanelDoc(doc, ownerNames))
          : [],
        estimateFirestoreIds
      );

      let merged: UnifiedNotification[] = [
        ...customerInboxRows,
        ...opsMappedDedicated,
        ...adminMapped,
        ...estimateRows,
      ];
      merged.sort(
        (a, b) => parseTime(unifiedItemCreatedAt(b)) - parseTime(unifiedItemCreatedAt(a))
      );
      merged = dedupeAdminPanelAdditionalIssueFound(merged);

      merged = await enrichUnifiedNotificationsList(db, merged);
      merged = await enrichAdminPanelAdditionalIssueBookingContact(db, merged);
      merged = await enrichAdditionalIssueMetadataFromBookings(db, merged);

      if (scopedToWorkshops && scopedToWorkshops.length > 0) {
        const allow = new Set(scopedToWorkshops);
        merged = merged.filter(
          (r) => r.ownerUid != null && allow.has(String(r.ownerUid).trim())
        );
      }

      let out = merged;
      if (unreadOnly) out = out.filter((r) => !r.read);

      const unreadCount = merged.filter((r) => !r.read).length;
      const customerFacingNotificationCount = merged.filter((r) => r.source === "customer_panel").length;

      const responseBody = {
        scope: "all" as const,
        fullSystemAccess: fullAccess,
        scopedToWorkshops,
        customerOnly,
        includeAdminPanel,
        /** Rows from book-now customer inbox after workshop scope (if any). */
        customerFacingNotificationCount,
        notifications: out,
        totalMerged: merged.length,
        unreadCount,
        /** Caps applied to each underlying fetch (callers can detect saturation). */
        limit: inboxLimit,
        sinceDays,
        counts: {
          bookingEngineCustomerInbox: customerFacingNotificationCount,
          customerNotificationsDocs: custDocs.length,
          legacyNotificationsMerged: legacyDocs.length,
          adminStaffApp: adminDocs.length,
          callCenterOpsNotifications: opsDocsDedicated.length,
          estimates: estimateRows.length,
        },
      };

      writeCallCenterNotificationsCache(cacheKey, responseBody);

      return NextResponse.json(responseBody, { headers: CORS_HEADERS });
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

    const perChunkLimit = Math.min(inboxLimit, MAX_PER_WORKSHOP_CHUNK);
    const byOwner = await db
      .collection("customer_notifications")
      .where("ownerUid", "==", tenant)
      .orderBy("createdAt", "desc")
      .limit(inboxLimit)
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
        .orderBy("createdAt", "desc")
        .limit(perChunkLimit)
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

    const legacyDocs = await fetchLegacyCustomerBookingNotifications(db, [tenant], {
      perChunkLimit,
      sinceDays,
    });

    const mergedRows = mergeCustomerPanelInbox(rows, legacyDocs, customerMeta, ownerNames);

    const opsDocsW = !customerOnly
      ? await fetchCallCenterOpsNotifications(db, [tenant], {
          perTypeLimit: Math.min(inboxLimit, MAX_OPS_PER_TYPE),
          sinceDays,
        })
      : [];
    const estimateDocsW = !customerOnly
      ? await fetchEstimatesForCallCenter(db, [tenant], {
          rowLimit: inboxLimit,
          sinceDays,
        })
      : [];
    const estimateRowsW = estimateDocsW.map((doc) =>
      mapEstimateDocForCallCenterFeed(doc, ownerNames)
    );
    const estimateIdSetW = new Set(estimateRowsW.map((e) => e.id));
    const opsMappedW = dedupeNewEstimateNotifications(
      opsDocsW.map((doc) => mapAdminPanelDoc(doc, ownerNames)),
      estimateIdSetW
    );

    let workshopMerged: UnifiedNotification[] = [...mergedRows, ...opsMappedW, ...estimateRowsW];
    workshopMerged.sort(
      (a, b) => parseTime(unifiedItemCreatedAt(b)) - parseTime(unifiedItemCreatedAt(a))
    );
    workshopMerged = dedupeAdminPanelAdditionalIssueFound(workshopMerged);

    workshopMerged = await enrichUnifiedNotificationsList(db, workshopMerged);
    workshopMerged = await enrichAdminPanelAdditionalIssueBookingContact(
      db,
      workshopMerged
    );
    workshopMerged = await enrichAdditionalIssueMetadataFromBookings(db, workshopMerged);

    let filtered = unreadOnly ? workshopMerged.filter((r) => !r.read) : workshopMerged;

    const unreadCount = workshopMerged.filter((r) => !r.read).length;

    return NextResponse.json(
      {
        scope: "workshop",
        notifications: filtered,
        totalFetched: workshopMerged.length,
        unreadCount,
        limit: inboxLimit,
        sinceDays,
        counts: {
          customerNotificationsDocs: rows.length,
          legacyNotificationsMerged: legacyDocs.length,
          callCenterOpsNotifications: opsDocsW.length,
          estimates: estimateRowsW.length,
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
