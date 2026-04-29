import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";
import {
  verifyCallCenterOrTenantAdminAuth,
  canAccessWorkshopForAuth,
  getTenantId,
  CORS_HEADERS,
} from "@/lib/callCenterAuth";
import {
  DEFAULT_CHECKLIST_SECTION,
  isChecklistSection,
  type ChecklistSection,
} from "@/lib/services";
import { serializeCallCenterServicePricing } from "@/lib/callCenterServicePricing";

export const runtime = "nodejs";

export async function OPTIONS() {
  return NextResponse.json({}, { headers: CORS_HEADERS });
}

function mapChecklistFromDoc(checklistRaw: unknown): Array<{
  index: number;
  name: string;
  description: string;
  done: boolean;
  section: ChecklistSection;
}> {
  if (!Array.isArray(checklistRaw)) return [];
  return checklistRaw.map((item: unknown, index: number) => {
    if (typeof item === "string") {
      return {
        index,
        name: item,
        description: "",
        done: false,
        section: DEFAULT_CHECKLIST_SECTION,
      };
    }
    const o = item as Record<string, unknown>;
    const rawSection = o.section;
    return {
      index,
      name: typeof o.name === "string" ? o.name : "",
      description: typeof o.description === "string" ? o.description : "",
      done: !!o.done,
      section: isChecklistSection(rawSection) ? rawSection : DEFAULT_CHECKLIST_SECTION,
    };
  });
}

/**
 * GET /api/call-center/services?ownerUid=X&branchId=Y
 *
 * List services for a workshop. Each service includes staff[] and full checklist[]
 * (todo template items: index, name, description, done), plus checklistCount.
 * Pricing: `vehicleTypePricing` / `pricingByVehicleType` (per size class) and
 * headline `price`/`duration` (cheapest tier when type pricing is set), same as
 * the customer book-now API.
 * Optional summary=1 — omit checklist[] and keep only checklistCount (smaller payload).
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
  if (!ownerUid) {
    return NextResponse.json(
      { error: "Missing ownerUid" },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  if (!canAccessWorkshopForAuth(gate.auth, ownerUid)) {
    return NextResponse.json(
      { error: "Access denied" },
      { status: 403, headers: CORS_HEADERS }
    );
  }

  const branchId = req.nextUrl.searchParams.get("branchId");
  const summaryOnly = req.nextUrl.searchParams.get("summary") === "1";

  try {
    const db = adminDb();

    const servicesSnap = await db
      .collection("services")
      .where("ownerUid", "==", ownerUid)
      .get();

    let serviceDocs = servicesSnap.docs;

    if (branchId) {
      serviceDocs = serviceDocs.filter((doc) => {
        const branches: string[] = doc.data().branches || [];
        return branches.includes(branchId);
      });
    }

    const allStaffIds = new Set<string>();
    for (const doc of serviceDocs) {
      const ids: string[] = doc.data().staffIds || [];
      ids.forEach((id) => allStaffIds.add(id));
    }

    const staffMap: Record<string, { id: string; name: string; role: string; branchId: string | null }> = {};
    if (allStaffIds.size > 0) {
      const staffIdArray = Array.from(allStaffIds);
      const batches: string[][] = [];
      for (let i = 0; i < staffIdArray.length; i += 30) {
        batches.push(staffIdArray.slice(i, i + 30));
      }
      for (const batch of batches) {
        const snap = await db
          .collection("users")
          .where("__name__", "in", batch)
          .get();
        for (const d of snap.docs) {
          const data = d.data();
          staffMap[d.id] = {
            id: d.id,
            name: data.displayName || data.name || "",
            role: data.role || "",
            branchId: data.branchId || null,
          };
        }
      }
    }

    const services = serviceDocs.map((doc) => {
      const d = doc.data() as Record<string, unknown>;
      const staffIds: string[] = Array.isArray(d.staffIds)
        ? (d.staffIds as unknown[]).map(String)
        : [];
      const checklistCount = Array.isArray(d.checklist) ? d.checklist.length : 0;
      const pricing = serializeCallCenterServicePricing(d);
      const base: Record<string, unknown> = {
        id: doc.id,
        name: d.name || "",
        description: d.description || "",
        ...pricing,
        icon: d.icon || "",
        imageUrl: d.imageUrl || "",
        branches: Array.isArray(d.branches) ? d.branches : [],
        staff: staffIds
          .filter((sid) => staffMap[sid])
          .map((sid) => staffMap[sid]),
        checklistCount,
      };
      if (!summaryOnly) {
        base.checklist = mapChecklistFromDoc(d.checklist);
      }
      return base;
    });

    return NextResponse.json(
      { services, total: services.length },
      { headers: CORS_HEADERS }
    );
  } catch (error: any) {
    console.error("[call-center/services GET] Error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
