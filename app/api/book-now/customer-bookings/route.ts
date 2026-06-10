import { NextRequest, NextResponse } from "next/server";
import type { DocumentData } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebaseAdmin";
import { isChecklistSection, normalizeAreaOrder, type ChecklistSection } from "@/lib/services";
import { isTaskCondition, type TaskCondition } from "@/lib/taskCondition";

/** Build `services` payload with stable area ordering: use booking snapshot when non-empty, else live `services/{id}` doc. */
function buildCustomerServicesPayload(
  d: DocumentData,
  liveAreaOrderByServiceId: Map<string, ChecklistSection[]>,
  taskRows: Array<{ serviceId?: string }> | null
): { id: string; areaOrder: ChecklistSection[] }[] {
  const fromDoc: { id: string; raw: unknown }[] = Array.isArray(d.services)
    ? d.services
        .map((s: { id?: unknown; serviceId?: unknown; areaOrder?: unknown }) => ({
          id: String(s.id ?? s.serviceId ?? "").trim(),
          raw: s.areaOrder,
        }))
        .filter((x) => x.id.length > 0)
    : [];

  const byId = new Map<string, ChecklistSection[]>();

  for (const row of fromDoc) {
    const raw = row.raw;
    let order = normalizeAreaOrder(raw);
    if ((!Array.isArray(raw) || raw.length === 0) && liveAreaOrderByServiceId.has(row.id)) {
      order = liveAreaOrderByServiceId.get(row.id)!;
    }
    byId.set(row.id, order);
  }

  const taskIds = new Set<string>();
  if (taskRows) {
    for (const t of taskRows) {
      const id = String(t.serviceId ?? "").trim();
      if (id) taskIds.add(id);
    }
  }

  for (const tid of taskIds) {
    if (!byId.has(tid)) {
      byId.set(tid, liveAreaOrderByServiceId.get(tid) ?? normalizeAreaOrder([]));
    }
  }

  return [...byId.entries()].map(([id, areaOrder]) => ({ id, areaOrder }));
}

export async function GET(req: NextRequest) {
  try {
    const customerId = req.nextUrl.searchParams.get("customerId");

    if (!customerId) {
      return NextResponse.json({ error: "Missing customerId" }, { status: 400 });
    }

    const db = adminDb();
    // Polled every ~30s from the customer-facing book-now page. Cap to the
    // 50 most recent bookings — the UI only displays a recent list and
    // slices to 50 anyway (see `bookings.slice(0, 50)` below). Without a
    // limit, customers with long histories were re-reading their entire
    // booking history on every poll.
    let snap;
    try {
      snap = await db
        .collection("bookings")
        .where("customerId", "==", customerId)
        .orderBy("createdAt", "desc")
        .limit(50)
        .get();
    } catch {
      // Composite index missing — fall back to unordered bounded read.
      snap = await db
        .collection("bookings")
        .where("customerId", "==", customerId)
        .limit(50)
        .get();
    }

    // Service IDs that need a live `areaOrder` (missing or empty on the booking snapshot)
    const idsToFetch = new Set<string>();
    for (const doc of snap.docs) {
      const d = doc.data();
      const tasks = Array.isArray(d.tasks) ? d.tasks : [];
      const hasSnapshotOrder = new Set<string>();
      if (Array.isArray(d.services)) {
        for (const s of d.services) {
          const id = String(s.id ?? s.serviceId ?? "").trim();
          if (!id) continue;
          const raw = s.areaOrder;
          if (Array.isArray(raw) && raw.length > 0) hasSnapshotOrder.add(id);
        }
      }
      const mentioned = new Set<string>();
      if (Array.isArray(d.services)) {
        for (const s of d.services) {
          const id = String(s.id ?? s.serviceId ?? "").trim();
          if (id) mentioned.add(id);
        }
      }
      for (const t of tasks) {
        const id = String(t.serviceId ?? "").trim();
        if (id) mentioned.add(id);
      }
      for (const id of mentioned) {
        if (!hasSnapshotOrder.has(id)) idsToFetch.add(id);
      }
    }

    const liveAreaOrderByServiceId = new Map<string, ChecklistSection[]>();
    await Promise.all(
      [...idsToFetch].map(async (id) => {
        try {
          const sdoc = await db.collection("services").doc(id).get();
          if (!sdoc.exists) return;
          const data = sdoc.data();
          const raw = data?.areaOrder;
          if (!Array.isArray(raw) || raw.length === 0) return;
          liveAreaOrderByServiceId.set(id, normalizeAreaOrder(raw));
        } catch {
          /* ignore */
        }
      })
    );

    const bookings = snap.docs.map((doc) => {
      const d = doc.data();
      const tasks = Array.isArray(d.tasks)
        ? d.tasks.map((t: Record<string, unknown>) => {
            const base: {
              id: string;
              serviceId: string;
              serviceName: string;
              name: string;
              description: string;
              done: boolean;
              imageUrl: string;
              staffNote: string;
              completedAt: string | null;
              completedByStaffName: string | null;
              section?: ChecklistSection;
              condition?: TaskCondition;
            } = {
              id: String(t.id ?? ""),
              serviceId: String(t.serviceId ?? ""),
              serviceName: String(t.serviceName ?? ""),
              name: String(t.name ?? ""),
              description: String(t.description ?? ""),
              done: !!t.done,
              imageUrl: String(t.imageUrl ?? ""),
              staffNote: String(t.staffNote ?? ""),
              completedAt: (t.completedAt as string | null | undefined) ?? null,
              completedByStaffName: (t.completedByStaffName as string | null | undefined) ?? null,
            };
            if (isChecklistSection(t.section)) base.section = t.section as ChecklistSection;
            if (isTaskCondition(t.condition)) base.condition = t.condition;
            return base;
          })
        : null;
      const n = tasks?.length ?? 0;
      const done = tasks?.filter((t) => t.done).length ?? 0;
      const taskProgress =
        n > 0 ? Math.round((done / n) * 100) : typeof d.taskProgress === "number" ? d.taskProgress : 0;

      const services = buildCustomerServicesPayload(d, liveAreaOrderByServiceId, tasks);

      return {
        id: doc.id,
        bookingCode: d.bookingCode || "",
        serviceName:
          d.serviceName ||
          (Array.isArray(d.services)
            ? d.services.map((s: { name?: string }) => s.name).join(", ")
            : "Service"),
        status: d.status || "Pending",
        date: d.date || "",
        time: d.time || "",
        pickupTime: d.pickupTime || null,
        branchName: d.branchName || "",
        price: d.price || 0,
        createdAt: d.createdAt?.toDate?.()?.toISOString() || null,
        updatedAt: d.updatedAt?.toDate?.()?.toISOString() || null,
        tasks,
        taskProgress,
        services,
        finalSubmission: d.finalSubmission
          ? {
              description: d.finalSubmission.description || "",
              imageUrl: d.finalSubmission.imageUrl || "",
              submittedAt: d.finalSubmission.submittedAt || null,
              submittedByStaffName: d.finalSubmission.submittedByStaffName || null,
            }
          : null,
        additionalIssues: Array.isArray(d.additionalIssues)
          ? d.additionalIssues.map((i: Record<string, unknown>) => ({
              id: i.id || "",
              issueTitle: i.issueTitle || "",
              description: i.description || "",
              recommendedRepair: i.recommendedRepair || "",
              imageUrl: i.imageUrl || null,
              price: typeof i.price === "number" ? i.price : null,
              status: i.status || "pending",
              customerResponse: i.customerResponse || null,
              customerRespondedAt: i.customerRespondedAt || null,
              customerPhone:
                (typeof i.customerPhone === "string" && i.customerPhone.trim()) ||
                (typeof i.clientPhone === "string" && i.clientPhone.trim()) ||
                (typeof d.clientPhone === "string" && d.clientPhone.trim()) ||
                null,
              customerEmail:
                (typeof i.customerEmail === "string" && i.customerEmail.trim()) ||
                (typeof i.clientEmail === "string" && i.clientEmail.trim()) ||
                (typeof d.clientEmail === "string" && d.clientEmail.trim()) ||
                null,
            }))
          : null,
      };
    });

    // Sort newest first (avoids needing a composite Firestore index)
    bookings.sort((a, b) => {
      const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return bTime - aTime;
    });

    return NextResponse.json({ bookings: bookings.slice(0, 50) });
  } catch (error: unknown) {
    console.error("Customer bookings fetch error:", error);
    return NextResponse.json(
      { error: "Failed to fetch bookings" },
      { status: 500 }
    );
  }
}
