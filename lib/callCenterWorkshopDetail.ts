import type { Firestore } from "firebase-admin/firestore";

export type WorkshopFullBundle = {
  workshop: {
    ownerUid: string;
    name: string;
    slug: string;
    logoUrl: string;
    contactPhone: string;
    email: string;
    timezone: string;
    state: string;
    bookingEngineUrl: string;
    accountStatus?: string;
  };
  branches: Array<{
    id: string;
    name: string;
    address: string;
    phone: string;
    email: string;
    timezone: string;
    hours: unknown;
    bookingLimitPerDay: number | null;
    status: string;
  }>;
  services: Array<{
    id: string;
    name: string;
    description: string;
    price: number;
    duration: number;
    branches: string[];
    checklist: unknown[];
  }>;
  staff: Array<{
    id: string;
    name: string;
    role: string;
    branchId: string | null;
  }>;
};

/**
 * Load workshop profile + branches + services + staff (same payload as GET .../workshops/[ownerUid]).
 */
export async function fetchWorkshopFullDetail(
  db: Firestore,
  ownerUid: string
): Promise<WorkshopFullBundle | null> {
  const workshopDoc = await db.doc(`users/${ownerUid}`).get();
  if (!workshopDoc.exists) return null;

  const ws = workshopDoc.data()!;
  const status = ws.accountStatus || ws.status || "";
  if (status === "suspended" || status === "inactive") {
    return null;
  }

  const [branchesSnap, servicesSnap, staffSnap] = await Promise.all([
    db.collection("branches").where("ownerUid", "==", ownerUid).get(),
    db.collection("services").where("ownerUid", "==", ownerUid).get(),
    db
      .collection("users")
      .where("ownerUid", "==", ownerUid)
      .where("role", "in", ["branch_admin", "staff"])
      .get(),
  ]);

  const branches = branchesSnap.docs.map((doc) => {
    const d = doc.data();
    return {
      id: doc.id,
      name: d.name || "",
      address: d.address || d.locationText || "",
      phone: d.phone || "",
      email: d.email || "",
      timezone: d.timezone || "Australia/Sydney",
      hours: d.hours || null,
      bookingLimitPerDay:
        typeof d.bookingLimitPerDay === "number" ? d.bookingLimitPerDay : null,
      status: d.status || "Active",
    };
  });

  const services = servicesSnap.docs.map((doc) => {
    const d = doc.data();
    return {
      id: doc.id,
      name: d.name || "",
      description: d.description || "",
      price: d.price || 0,
      duration: d.duration || 0,
      branches: Array.isArray(d.branches) ? d.branches : [],
      checklist: Array.isArray(d.checklist) ? d.checklist : [],
    };
  });

  const staff = staffSnap.docs.map((doc) => {
    const d = doc.data();
    return {
      id: doc.id,
      name: d.displayName || d.name || "",
      role: d.role || "",
      branchId: d.branchId || null,
    };
  });

  return {
    workshop: {
      ownerUid,
      name: ws.name || ws.displayName || "",
      slug: ws.slug || "",
      logoUrl: ws.logoUrl || "",
      contactPhone: ws.contactPhone || "",
      email: ws.email || "",
      timezone: ws.timezone || "Australia/Sydney",
      state: ws.state || "",
      bookingEngineUrl: ws.bookingEngineUrl || "",
      accountStatus: ws.accountStatus || "active",
    },
    branches,
    services,
    staff,
  };
}
