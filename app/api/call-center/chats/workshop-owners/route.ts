import { NextRequest, NextResponse } from "next/server";
import {
  verifyCallCenterOrTenantAdminAuth,
  workshopListScopeForAuth,
  CORS_HEADERS,
} from "@/lib/callCenterAuth";
import {
  queryActiveWorkshopOwnerDocs,
  workshopOwnerDocToSummary,
} from "@/lib/callCenterWorkshopOwnersQuery";

export const runtime = "nodejs";

export async function OPTIONS() {
  return NextResponse.json({}, { headers: CORS_HEADERS });
}

/**
 * GET /api/call-center/chats/workshop-owners
 *
 * Lightweight list of workshop owner accounts for starting 1:1 CC chats (same scope as
 * GET /api/call-center/workshops?summary=1 — agents with assignedWorkshops only see those uids).
 *
 * Local dev: without Bearer, all workshops when CALL_CENTER_DEV_LIST_ALL_WORKSHOPS is not "false".
 */
export async function GET(req: NextRequest) {
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
          "Add Authorization: Bearer <Firebase idToken>. In dev you can use ?access_token=… or set CALL_CENTER_DEV_LIST_ALL_WORKSHOPS=false to require auth.";
      }
      return NextResponse.json(body, {
        status: gate.status || 401,
        headers: CORS_HEADERS,
      });
    }
    scope = workshopListScopeForAuth(gate.auth);
  }

  try {
    if (scope.mode === "ids" && scope.ids.length === 0) {
      return NextResponse.json({ workshopOwners: [] }, { headers: CORS_HEADERS });
    }

    const activeDocs = await queryActiveWorkshopOwnerDocs(scope);
    const workshopOwners = activeDocs.map(workshopOwnerDocToSummary);

    const headers =
      devListAllUnauthed && process.env.NODE_ENV === "development"
        ? { ...CORS_HEADERS, "X-Dev-Auth-Bypass": "development-default" }
        : CORS_HEADERS;

    return NextResponse.json({ workshopOwners }, { headers });
  } catch (e: unknown) {
    console.error("[call-center/chats/workshop-owners] Error:", e);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
