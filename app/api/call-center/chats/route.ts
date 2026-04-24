import { NextRequest, NextResponse } from "next/server";
import { verifyCallCenterAuth, CORS_HEADERS } from "@/lib/callCenterAuth";
import { listCcChatsForAgent } from "@/lib/ccDirectChat";

export const runtime = "nodejs";

export async function OPTIONS() {
  return NextResponse.json({}, { headers: CORS_HEADERS });
}

/**
 * GET /api/call-center/chats?limit=50
 * List 1:1 chats for the authenticated call center agent.
 */
export async function GET(req: NextRequest) {
  const gate = await verifyCallCenterAuth(req);
  if (!gate.success || !gate.user) {
    return NextResponse.json(
      { error: gate.error },
      { status: gate.status || 401, headers: CORS_HEADERS }
    );
  }

  const limitRaw = req.nextUrl.searchParams.get("limit");
  const limit = limitRaw ? parseInt(limitRaw, 10) : 50;
  try {
    const chats = await listCcChatsForAgent(gate.user.uid, Number.isFinite(limit) ? limit : 50);
    return NextResponse.json({ chats }, { headers: CORS_HEADERS });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Server error";
    return NextResponse.json({ error: msg }, { status: 500, headers: CORS_HEADERS });
  }
}
