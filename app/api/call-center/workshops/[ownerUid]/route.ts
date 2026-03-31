import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";
import {
  verifyCallCenterAuth,
  canAccessWorkshop,
  CORS_HEADERS,
} from "@/lib/callCenterAuth";

export const runtime = "nodejs";

export async function OPTIONS() {
  return NextResponse.json({}, { headers: CORS_HEADERS });
}

/**
 * GET /api/call-center/workshops/[ownerUid]
 *
 * Get full workshop details: profile, branches, services.
 * Agent must have access to this workshop.
 */
export async function GET(
  req: NextRequest,
  context: { params: Promise<{ ownerUid: string }> }
) {
  const auth = await verifyCallCenterAuth(req);
  if (!auth.success || !auth.user) {
    return NextResponse.json(
      { error: auth.error },
      { status: auth.status || 401, headers: CORS_HEADERS }
    );
  }

  const { ownerUid } = await context.params;

  if (!canAccessWorkshop(auth.user, ownerUid)) {
    return NextResponse.json(
      { error: "You do not have access to this workshop" },
      { status: 403, headers: CORS_HEADERS }
    );
  }

  try {
    const db = adminDb();

    const workshopDoc = await db.doc(`users/${ownerUid}`).get();
    if (!workshopDoc.exists) {
      return NextResponse.json(
        { error: "Workshop not found" },
        { status: 404, headers: CORS_HEADERS }
      );
    }

    const ws = workshopDoc.data()!;

    // Branches
    const branchesSnap = await db
      .collection("branches")
      .where("ownerUid", "==", ownerUid)
      .get();

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
          typeof d.bookingLimitPerDay === "number"
            ? d.bookingLimitPerDay
            : null,
        status: d.status || "Active",
      };
    });

    // Services
    const servicesSnap = await db
      .collection("services")
      .where("ownerUid", "==", ownerUid)
      .get();

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

    // Staff (limited info — name, role, branch)
    const staffSnap = await db
      .collection("users")
      .where("ownerUid", "==", ownerUid)
      .where("role", "in", ["branch_admin", "staff"])
      .get();

    const staff = staffSnap.docs.map((doc) => {
      const d = doc.data();
      return {
        id: doc.id,
        name: d.displayName || d.name || "",
        role: d.role || "",
        branchId: d.branchId || null,
      };
    });

    return NextResponse.json(
      {
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
        },
        branches,
        services,
        staff,
      },
      { headers: CORS_HEADERS }
    );
  } catch (error: any) {
    console.error("[call-center/workshops/[ownerUid]] Error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
