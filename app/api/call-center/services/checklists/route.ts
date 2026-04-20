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

export const runtime = "nodejs";

export async function OPTIONS() {
  return NextResponse.json({}, { headers: CORS_HEADERS });
}

type NormalizedChecklistItem = {
  index: number;
  name: string;
  description: string;
  done: boolean;
  /** Which vehicle part this task applies to: `interior | engine_bay | underbody | exterior`. */
  section: ChecklistSection;
};

function normalizeChecklistItems(raw: unknown): NormalizedChecklistItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item, index) => {
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
 * GET /api/call-center/services/checklists?ownerUid=X&branchId=Y
 *
 * Aggregated service checklist / todo items for call-center integrations
 * (explain job steps to customers, scripts, training). Same auth as /services.
 *
 * Response:
 * - services: per-service checklist (template todos from BMS service definition)
 * - todos: flat list with serviceId + serviceName on each row (easy to scan)
 * - totalServices, totalChecklistItems
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
      { error: "Missing ownerUid (query or X-Tenant-Id header)" },
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

  try {
    const db = adminDb();
    const servicesSnap = await db
      .collection("services")
      .where("ownerUid", "==", ownerUid)
      .get();

    let docs = servicesSnap.docs;
    if (branchId) {
      docs = docs.filter((doc) => {
        const branches: string[] = doc.data().branches || [];
        return branches.includes(branchId);
      });
    }

    const services: Array<{
      serviceId: string;
      serviceName: string;
      checklist: NormalizedChecklistItem[];
    }> = [];

    const todos: Array<{
      serviceId: string;
      serviceName: string;
      index: number;
      name: string;
      description: string;
      done: boolean;
      section: ChecklistSection;
    }> = [];

    for (const doc of docs) {
      const d = doc.data();
      const serviceName = d.name || "";
      const checklist = normalizeChecklistItems(d.checklist);
      services.push({
        serviceId: doc.id,
        serviceName,
        checklist,
      });
      for (const row of checklist) {
        todos.push({
          serviceId: doc.id,
          serviceName,
          index: row.index,
          name: row.name,
          description: row.description,
          done: row.done,
          section: row.section,
        });
      }
    }

    services.sort((a, b) =>
      a.serviceName.localeCompare(b.serviceName, undefined, { sensitivity: "base" })
    );
    todos.sort((a, b) => {
      const c = a.serviceName.localeCompare(b.serviceName, undefined, {
        sensitivity: "base",
      });
      if (c !== 0) return c;
      return a.index - b.index;
    });

    const totalChecklistItems = todos.length;

    return NextResponse.json(
      {
        ownerUid,
        branchId: branchId || null,
        totalServices: services.length,
        totalChecklistItems,
        services,
        todos,
      },
      { headers: CORS_HEADERS }
    );
  } catch (error: any) {
    console.error("[call-center/services/checklists GET] Error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
