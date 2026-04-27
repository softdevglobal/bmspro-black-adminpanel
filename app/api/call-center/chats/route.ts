import { NextRequest, NextResponse } from "next/server";
import {
  verifyCallCenterOrTenantAdminAuth,
  workshopListScopeForAuth,
  getTenantId,
  CORS_HEADERS,
} from "@/lib/callCenterAuth";
import {
  type CcChatWithDetails,
  listCcChatsForAgent,
  listCcChatsForWorkshop,
  listCcChatsForWorkshopIds,
} from "@/lib/ccDirectChat";

export const runtime = "nodejs";

export async function OPTIONS() {
  return NextResponse.json({}, { headers: CORS_HEADERS });
}

/**
 * GET /api/call-center/chats?limit=50
 * List 1:1 chats: for call center agents (where you are `agentUid`), or for BMS staff (all threads for your workshop(s)).
 */
export async function GET(req: NextRequest) {
  const gate = await verifyCallCenterOrTenantAdminAuth(req);
  if (!gate.success) {
    return NextResponse.json(
      { error: gate.error },
      { status: gate.status || 401, headers: CORS_HEADERS }
    );
  }

  const limitRaw = req.nextUrl.searchParams.get("limit");
  const limit = limitRaw ? parseInt(limitRaw, 10) : 50;
  const lim = Number.isFinite(limit) ? limit : 50;

  try {
    const { auth } = gate;
    let chats: CcChatWithDetails[];
    if (auth.kind === "agent") {
      chats = await listCcChatsForAgent(auth.user.uid, lim);
    } else {
      const scope = workshopListScopeForAuth(auth);
      if (scope.mode === "all") {
        const tenant = getTenantId(req)?.trim();
        if (!tenant) {
          return NextResponse.json(
            {
              error:
                "Specify ownerUid, tenantId, or X-Tenant-Id to list chats for a workshop (super admin).",
            },
            { status: 400, headers: CORS_HEADERS }
          );
        }
        chats = await listCcChatsForWorkshop(tenant, lim);
      } else if (scope.ids.length === 0) {
        chats = [];
      } else {
        chats = await listCcChatsForWorkshopIds(scope.ids, lim);
      }
    }
    return NextResponse.json({ chats }, { headers: CORS_HEADERS });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Server error";
    return NextResponse.json({ error: msg }, { status: 500, headers: CORS_HEADERS });
  }
}
