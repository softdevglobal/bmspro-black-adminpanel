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
 * GET /api/call-center/workshops
 *
 * List all workshops the agent has access to.
 * CC admins see all active workshops; agents see only assigned ones.
 *
 * Returns: array of workshop summaries.
 */
export async function GET(req: NextRequest) {
  const auth = await verifyCallCenterAuth(req);
  if (!auth.success || !auth.user) {
    return NextResponse.json(
      { error: auth.error },
      { status: auth.status || 401, headers: CORS_HEADERS }
    );
  }

  try {
    const db = adminDb();
    const user = auth.user;

    let workshopDocs;

    if (user.isCCAdmin) {
      const snap = await db
        .collection("users")
        .where("role", "==", "workshop_owner")
        .get();
      workshopDocs = snap.docs;
    } else {
      if (user.assignedWorkshops.length === 0) {
        return NextResponse.json({ workshops: [] }, { headers: CORS_HEADERS });
      }
      // Firestore `in` queries support max 30 values
      const batches: string[][] = [];
      for (let i = 0; i < user.assignedWorkshops.length; i += 30) {
        batches.push(user.assignedWorkshops.slice(i, i + 30));
      }
      workshopDocs = [];
      for (const batch of batches) {
        const snap = await db
          .collection("users")
          .where("role", "==", "workshop_owner")
          .where("__name__", "in", batch)
          .get();
        workshopDocs.push(...snap.docs);
      }
    }

    const workshops = workshopDocs
      .filter((doc) => {
        const d = doc.data();
        const status = d.accountStatus || d.status || "";
        return status !== "suspended" && status !== "inactive";
      })
      .map((doc) => {
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
      });

    return NextResponse.json({ workshops }, { headers: CORS_HEADERS });
  } catch (error: any) {
    console.error("[call-center/workshops] Error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
