import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";
import {
  verifyCallCenterOrTenantAdminAuth,
  canAccessWorkshopForAuth,
  CORS_HEADERS,
} from "@/lib/callCenterAuth";
import {
  DEFAULT_CHECKLIST_SECTION,
  isChecklistSection,
} from "@/lib/services";
import { serializeCallCenterServicePricing } from "@/lib/callCenterServicePricing";

export const runtime = "nodejs";

export async function OPTIONS() {
  return NextResponse.json({}, { headers: CORS_HEADERS });
}

/**
 * GET /api/call-center/services/[serviceId]
 *
 * Full service detail including checklist items, assigned branches
 * (resolved to names), and staff that can perform this service.
 */
export async function GET(
  req: NextRequest,
  context: { params: Promise<{ serviceId: string }> }
) {
  const gate = await verifyCallCenterOrTenantAdminAuth(req);
  if (!gate.success) {
    return NextResponse.json(
      { error: gate.error },
      { status: gate.status || 401, headers: CORS_HEADERS }
    );
  }

  const { serviceId } = await context.params;

  try {
    const db = adminDb();

    const serviceDoc = await db.doc(`services/${serviceId}`).get();
    if (!serviceDoc.exists) {
      return NextResponse.json(
        { error: "Service not found" },
        { status: 404, headers: CORS_HEADERS }
      );
    }

    const d = serviceDoc.data()! as Record<string, unknown>;
    const ownerUidField = d.ownerUid;

    if (!canAccessWorkshopForAuth(gate.auth, ownerUidField as string)) {
      return NextResponse.json(
        { error: "Access denied" },
        { status: 403, headers: CORS_HEADERS }
      );
    }

    const branchIds: string[] = Array.isArray(d.branches)
      ? (d.branches as unknown[]).map(String)
      : [];
    const branches: { id: string; name: string }[] = [];
    for (const bid of branchIds) {
      const branchDoc = await db.doc(`branches/${bid}`).get();
      if (branchDoc.exists) {
        branches.push({
          id: bid,
          name: branchDoc.data()?.name || "",
        });
      }
    }

    const staffIds: string[] = Array.isArray(d.staffIds)
      ? (d.staffIds as unknown[]).map(String)
      : [];
    const staff: { id: string; name: string; role: string; branchId: string | null }[] = [];
    if (staffIds.length > 0) {
      const batches: string[][] = [];
      for (let i = 0; i < staffIds.length; i += 30) {
        batches.push(staffIds.slice(i, i + 30));
      }
      for (const batch of batches) {
        const snap = await db
          .collection("users")
          .where("__name__", "in", batch)
          .get();
        for (const s of snap.docs) {
          const sd = s.data();
          staff.push({
            id: s.id,
            name: sd.displayName || sd.name || "",
            role: sd.role || "",
            branchId: sd.branchId || null,
          });
        }
      }
    }

    const checklist = Array.isArray(d.checklist)
      ? d.checklist.map((item: any) => ({
          name: item.name || "",
          description: item.description || "",
          section: isChecklistSection(item?.section)
            ? item.section
            : DEFAULT_CHECKLIST_SECTION,
        }))
      : [];

    const pricing = serializeCallCenterServicePricing(d);

    return NextResponse.json(
      {
        service: {
          id: serviceId,
          name: (d.name as string) || "",
          description: (d.description as string) || "",
          ...pricing,
          icon: (d.icon as string) || "",
          imageUrl: (d.imageUrl as string) || "",
          branches,
          staff,
          checklist,
        },
      },
      { headers: CORS_HEADERS }
    );
  } catch (error: any) {
    console.error("[call-center/services/[serviceId]] Error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
