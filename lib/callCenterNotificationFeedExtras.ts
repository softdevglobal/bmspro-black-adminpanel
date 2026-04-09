import type { Firestore, QueryDocumentSnapshot } from "firebase-admin/firestore";

/** Shown on call-center feed even though excluded from customer book-now inbox. */
export const CALL_CENTER_OPS_NOTIFICATION_TYPES = [
  "additional_issue_found",
  "new_estimate",
] as const;

const PAGE_SIZE = 500;

function parseTimeMs(iso: string | null): number {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Paginate `notifications` by `type`, optionally filter by `ownerUid` in allowed set (in-memory filter if needed).
 */
export async function fetchCallCenterOpsNotifications(
  db: Firestore,
  workshopOwnerUids: string[] | null
): Promise<QueryDocumentSnapshot[]> {
  const allow =
    workshopOwnerUids !== null ? new Set(workshopOwnerUids.map((x) => String(x).trim()).filter(Boolean)) : null;

  const seen = new Set<string>();
  const out: QueryDocumentSnapshot[] = [];

  for (const t of CALL_CENTER_OPS_NOTIFICATION_TYPES) {
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
        for (const doc of snap.docs) {
          if (seen.has(doc.id)) continue;
          const ou = String(doc.data().ownerUid || "").trim();
          if (allow && (!ou || !allow.has(ou))) continue;
          seen.add(doc.id);
          out.push(doc);
        }
        if (snap.docs.length < PAGE_SIZE) break;
        last = snap.docs[snap.docs.length - 1];
      }
    } catch {
      const snap = await db.collection("notifications").where("type", "==", t).get();
      for (const doc of snap.docs) {
        if (seen.has(doc.id)) continue;
        const ou = String(doc.data().ownerUid || "").trim();
        if (allow && (!ou || !allow.has(ou))) continue;
        seen.add(doc.id);
        out.push(doc);
      }
    }
  }

  out.sort(
    (a, b) =>
      parseTimeMs(b.data().createdAt?.toDate?.()?.toISOString() || null) -
      parseTimeMs(a.data().createdAt?.toDate?.()?.toISOString() || null)
  );
  return out;
}

/** All estimates for given workshop owner UIDs, or entire collection if `workshopOwnerUids` is null. */
export async function fetchEstimatesForCallCenter(
  db: Firestore,
  workshopOwnerUids: string[] | null
): Promise<QueryDocumentSnapshot[]> {
  if (workshopOwnerUids !== null) {
    if (workshopOwnerUids.length === 0) return [];
    const normalized = [...new Set(workshopOwnerUids.map((x) => String(x).trim()).filter(Boolean))];
    const seen = new Set<string>();
    const rows: QueryDocumentSnapshot[] = [];
    for (let i = 0; i < normalized.length; i += 30) {
      const chunk = normalized.slice(i, i + 30);
      const snap = await db.collection("estimates").where("ownerUid", "in", chunk).get();
      for (const doc of snap.docs) {
        if (seen.has(doc.id)) continue;
        seen.add(doc.id);
        rows.push(doc);
      }
    }
    rows.sort(
      (a, b) =>
        parseTimeMs(b.data().createdAt?.toDate?.()?.toISOString() || null) -
        parseTimeMs(a.data().createdAt?.toDate?.()?.toISOString() || null)
    );
    return rows;
  }

  const snap = await db.collection("estimates").get();
  const docs = [...snap.docs] as QueryDocumentSnapshot[];
  docs.sort(
    (a, b) =>
      parseTimeMs(b.data().createdAt?.toDate?.()?.toISOString() || null) -
      parseTimeMs(a.data().createdAt?.toDate?.()?.toISOString() || null)
  );
  return docs;
}

export type MappedEstimateFeedItem = {
  source: "estimate";
  id: string;
  type: "estimate_request";
  title: string;
  message: string;
  read: boolean;
  ownerUid: string | null;
  customerId: string | null;
  customerName: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  branchName: string | null;
  branchId: string | null;
  status: string;
  vehicleMake: string | null;
  vehicleModel: string | null;
  vehicleYear: string | null;
  rego: string | null;
  mileage: string | null;
  description: string | null;
  imageUrls: string[];
  createdAt: string | null;
  updatedAt: string | null;
  workshopName: string | null;
};

export function mapEstimateDocForCallCenterFeed(
  doc: QueryDocumentSnapshot,
  ownerNames: Map<string, string>
): MappedEstimateFeedItem {
  const d = doc.data();
  const ownerUid = typeof d.ownerUid === "string" ? d.ownerUid.trim() : null;
  const customerName = String(d.customerName || "").trim() || null;
  const desc = String(d.description || "").trim();
  return {
    source: "estimate",
    id: doc.id,
    type: "estimate_request",
    title: "Estimate request",
    message: desc ? (desc.length > 240 ? `${desc.slice(0, 240)}…` : desc) : "Customer estimate request",
    read: d.read === true,
    ownerUid,
    customerId: d.customerId != null ? String(d.customerId) : null,
    customerName,
    customerEmail: String(d.customerEmail || "").trim() || null,
    customerPhone: String(d.customerPhone || "").trim() || null,
    branchName: d.branchName != null ? String(d.branchName) : null,
    branchId: d.branchId != null ? String(d.branchId) : null,
    status: String(d.status || "New"),
    vehicleMake: d.vehicleMake != null ? String(d.vehicleMake) : null,
    vehicleModel: d.vehicleModel != null ? String(d.vehicleModel) : null,
    vehicleYear: d.vehicleYear != null ? String(d.vehicleYear) : null,
    rego: d.rego != null ? String(d.rego) : null,
    mileage: d.mileage != null ? String(d.mileage) : null,
    description: desc || null,
    imageUrls: Array.isArray(d.imageUrls) ? d.imageUrls.map((x: unknown) => String(x)) : [],
    createdAt: d.createdAt?.toDate?.()?.toISOString() || null,
    updatedAt: d.updatedAt?.toDate?.()?.toISOString() || null,
    workshopName: ownerUid ? ownerNames.get(ownerUid) ?? null : null,
  };
}

/** Drop `new_estimate` notification rows when we already expose the full `estimates/{id}` row. */
export function dedupeNewEstimateNotifications<T extends { type: string; estimateId?: string | null }>(
  items: T[],
  estimateFirestoreIds: Set<string>
): T[] {
  return items.filter((m) => {
    if (m.type !== "new_estimate") return true;
    const eid = m.estimateId != null ? String(m.estimateId).trim() : "";
    if (!eid) return true;
    return !estimateFirestoreIds.has(eid);
  });
}
