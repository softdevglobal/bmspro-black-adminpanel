import type { QueryDocumentSnapshot } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebaseAdmin";

export type CallCenterWorkshopOwnerSummary = {
  ownerUid: string;
  name: string;
  slug: string;
  logoUrl: string;
  contactPhone: string;
  email: string;
  timezone: string;
  state: string;
  accountStatus: string;
};

/**
 * Workshop owner user docs the call center may target (same scope rules as GET /api/call-center/workshops).
 */
export async function queryActiveWorkshopOwnerDocs(
  scope: { mode: "all" } | { mode: "ids"; ids: string[] }
): Promise<QueryDocumentSnapshot[]> {
  const db = adminDb();
  let workshopDocs: QueryDocumentSnapshot[];

  if (scope.mode === "all") {
    const snap = await db.collection("users").where("role", "==", "workshop_owner").get();
    workshopDocs = snap.docs;
  } else {
    if (scope.ids.length === 0) return [];
    workshopDocs = [];
    for (let i = 0; i < scope.ids.length; i += 30) {
      const batch = scope.ids.slice(i, i + 30);
      const snap = await db
        .collection("users")
        .where("role", "==", "workshop_owner")
        .where("__name__", "in", batch)
        .get();
      workshopDocs.push(...snap.docs);
    }
  }

  return workshopDocs.filter((doc) => {
    const d = doc.data();
    const status = d.accountStatus || d.status || "";
    return status !== "suspended" && status !== "inactive";
  });
}

export function workshopOwnerDocToSummary(doc: QueryDocumentSnapshot): CallCenterWorkshopOwnerSummary {
  const d = doc.data();
  return {
    ownerUid: doc.id,
    name: d.name || d.displayName || "",
    slug: d.slug || "",
    logoUrl: d.logoUrl || "",
    contactPhone: d.contactPhone || "",
    email: d.email || "",
    timezone: d.timezone || "Australia/Sydney",
    state: d.state || "",
    accountStatus: d.accountStatus || "active",
  };
}
