import { NextRequest, NextResponse } from "next/server";
import { CORS_HEADERS, verifyCallCenterAuth } from "@/lib/callCenterAuth";
import { setAgentPresence } from "@/lib/supportChat";

export const runtime = "nodejs";

export async function OPTIONS() {
  return NextResponse.json({}, { headers: CORS_HEADERS });
}

/** POST /api/support-chat/agent/presence — body `{ "online": boolean }` */
export async function POST(req: NextRequest) {
  const auth = await verifyCallCenterAuth(req);
  if (!auth.success || !auth.user) {
    return NextResponse.json(
      { error: auth.error },
      { status: auth.status || 401, headers: CORS_HEADERS },
    );
  }
  let body: { online?: unknown };
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const online = body.online === true;
  try {
    await setAgentPresence({ agentUid: auth.user.uid, online });
    return NextResponse.json({ ok: true, online }, { headers: CORS_HEADERS });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Server error";
    return NextResponse.json(
      { error: msg },
      { status: 500, headers: CORS_HEADERS },
    );
  }
}
