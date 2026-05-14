import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";
import {
  verifyCallCenterOrTenantAdminAuth,
  workshopListScopeForAuth,
  CORS_HEADERS,
} from "@/lib/callCenterAuth";
import { fetchWorkshopFullDetail } from "@/lib/callCenterWorkshopDetail";
import {
  queryActiveWorkshopOwnerDocs,
  workshopOwnerDocToSummary,
} from "@/lib/callCenterWorkshopOwnersQuery";

export const runtime = "nodejs";

export async function OPTIONS() {
  return NextResponse.json({}, { headers: CORS_HEADERS });
}

/**
 * GET /api/call-center/workshops
 *
 * Lists workshops the caller can access. Each item includes full detail:
 * workshop profile, branches, services, staff (same shape as GET .../workshops/[ownerUid]).
 *
 * Query: summary=1 — legacy light list (ownerUid, name, slug, … only).
 *
 * Local dev: without Bearer, all workshops are listed unless CALL_CENTER_DEV_LIST_ALL_WORKSHOPS=false.
 */
export async function GET(req: NextRequest) {
  const summaryOnly = req.nextUrl.searchParams.get("summary") === "1";

  const devListAllUnauthed =
    process.env.NODE_ENV === "development" &&
    process.env.CALL_CENTER_DEV_LIST_ALL_WORKSHOPS !== "false";

  let scope: ReturnType<typeof workshopListScopeForAuth>;

  if (devListAllUnauthed) {
    scope = { mode: "all" };
  } else {
    const gate = await verifyCallCenterOrTenantAdminAuth(req);
    if (!gate.success) {
      const body: Record<string, string> = { error: gate.error || "Unauthorized" };
      if (process.env.NODE_ENV === "development") {
        body.hint =
          "Add Authorization: Bearer <Firebase idToken>, or ?access_token=… on localhost. To require a token in dev, set CALL_CENTER_DEV_LIST_ALL_WORKSHOPS=false in .env.local.";
      }
      return NextResponse.json(body, {
        status: gate.status || 401,
        headers: CORS_HEADERS,
      });
    }
    scope = workshopListScopeForAuth(gate.auth);
  }

  try {
    const db = adminDb();
    if (scope.mode === "ids" && scope.ids.length === 0) {
      return NextResponse.json({ workshops: [] }, { headers: CORS_HEADERS });
    }

    const activeDocs = await queryActiveWorkshopOwnerDocs(scope);

    const headers =
      devListAllUnauthed && process.env.NODE_ENV === "development"
        ? { ...CORS_HEADERS, "X-Dev-Auth-Bypass": "development-default" }
        : CORS_HEADERS;

    if (summaryOnly) {
      const workshops = activeDocs.map(workshopOwnerDocToSummary);
      return NextResponse.json({ workshops }, { headers });
    }

    const bundles = await Promise.all(
      activeDocs.map((doc) => fetchWorkshopFullDetail(db, doc.id))
    );
    const workshops = bundles.filter((b): b is NonNullable<typeof b> => b != null);

    return NextResponse.json({ workshops }, { headers });
  } catch (error: unknown) {
    console.error("[call-center/workshops] Error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
