import { NextRequest, NextResponse } from "next/server";
import { CORS_HEADERS, verifyCallCenterAuth } from "@/lib/callCenterAuth";
import { registerAgentFcmToken } from "@/lib/supportChat";

export const runtime = "nodejs";

export async function OPTIONS() {
  return NextResponse.json({}, { headers: CORS_HEADERS });
}

/** POST /api/support-chat/agent/fcm-token — body `{ "token": string, "platform"?: string }` */
export async function POST(req: NextRequest) {
  const auth = await verifyCallCenterAuth(req);
  if (!auth.success || !auth.user) {
    return NextResponse.json(
      { error: auth.error },
      { status: auth.status || 401, headers: CORS_HEADERS },
    );
  }
  let body: { token?: unknown; platform?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400, headers: CORS_HEADERS },
    );
  }
  const token = typeof body.token === "string" ? body.token : "";
  const platform = typeof body.platform === "string" ? body.platform : "web";
  try {
    await registerAgentFcmToken({ agentUid: auth.user.uid, token, platform });
    return NextResponse.json({ ok: true }, { headers: CORS_HEADERS });
  } catch (e: unknown) {
    const status = typeof e === "object" && e !== null && "status" in e
      ? Number((e as { status: number }).status)
      : 500;
    const msg = e instanceof Error ? e.message : "Server error";
    return NextResponse.json(
      { error: msg },
      { status: Number.isFinite(status) ? status : 500, headers: CORS_HEADERS },
    );
  }
}
