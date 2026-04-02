import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";
import {
  verifyCallCenterAuth,
  canAccessWorkshop,
  getTenantId,
  CORS_HEADERS,
} from "@/lib/callCenterAuth";

export const runtime = "nodejs";

export async function OPTIONS() {
  return NextResponse.json({}, { headers: CORS_HEADERS });
}

/**
 * GET /api/call-center/services?ownerUid=X&branchId=Y
 *
 * List services for a workshop. When branchId is provided, only returns
 * services assigned to that branch. Each service includes the staff
 * members that can perform it (matched via staffIds on the service doc).
 */
export async function GET(req: NextRequest) {
  const auth = await verifyCallCenterAuth(req);
  if (!auth.success || !auth.user) {
    return NextResponse.json(
      { error: auth.error },
      { status: auth.status || 401, headers: CORS_HEADERS }
    );
  }

  const ownerUid = getTenantId(req);
  if (!ownerUid) {
    return NextResponse.json(
      { error: "Missing ownerUid" },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  if (!canAccessWorkshop(auth.user, ownerUid)) {
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
      const d = doc.data();
      const staffIds: string[] = d.staffIds || [];
      return {
        id: doc.id,
        name: d.name || "",
        description: d.description || "",
        price: d.price || 0,
        duration: d.duration || 0,
        icon: d.icon || "",
        imageUrl: d.imageUrl || "",
        branches: Array.isArray(d.branches) ? d.branches : [],
        staff: staffIds
          .filter((sid) => staffMap[sid])
          .map((sid) => staffMap[sid]),
        checklistCount: Array.isArray(d.checklist) ? d.checklist.length : 0,
      };
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
