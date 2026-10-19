import { createHash, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { BlackSetupError } from "@/lib/commandCentreOnboarding";
import { provisionCommandCentreWorkshop } from "@/lib/commandCentreOnboardingStore";
import { adminDb } from "@/lib/firebaseAdmin";

export const runtime = "nodejs";
function authorize(req: NextRequest) {
  if (process.env.COMMAND_CENTRE_ONBOARDING_ENABLED !== "true") return NextResponse.json({ error: "Not found" }, { status: 404 });
  const secret = process.env.COMMAND_CENTRE_ONBOARDING_SECRET?.trim() ?? "";
  if (secret.length < 32) return NextResponse.json({ error: "Provisioning is not configured." }, { status: 503 });
  const token = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "")?.[1]?.trim() ?? "";
  const hash = (value: string) => createHash("sha256").update(value).digest();
  if (!token || !timingSafeEqual(hash(token), hash(secret))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return null;
}
export async function POST(req: NextRequest) {
  const denied = authorize(req); if (denied) return denied;
  try {
    const raw = await req.text();
    if (Buffer.byteLength(raw) > 512000) return NextResponse.json({ error: "Setup is too large." }, { status: 413 });
    return NextResponse.json(await provisionCommandCentreWorkshop(JSON.parse(raw)), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof BlackSetupError ? error.message : "Black setup could not complete.", code: error instanceof BlackSetupError ? error.code : "SETUP_FAILED" },
      { status: error instanceof BlackSetupError ? error.status : 503, headers: { "Cache-Control": "no-store" } });
  }
}
export async function GET(req: NextRequest) {
  const denied = authorize(req); if (denied) return denied;
  const id = req.nextUrl.searchParams.get("requestId") ?? "";
  if (!/^[a-f0-9-]{36}$/i.test(id)) return NextResponse.json({ error: "Invalid request ID." }, { status: 400 });
  try {
    const doc = await adminDb().doc(`onboarding_requests/${id}`).get();
    if (!doc.exists) return NextResponse.json({ error: "Setup not found." }, { status: 404 });
    const data = doc.data()!;
    return NextResponse.json({ status: data.status, plannedResources: data.plannedResources, result: data.result ?? null }, { headers: { "Cache-Control": "no-store" } });
  } catch { return NextResponse.json({ error: "Checkpoint unavailable." }, { status: 503 }); }
}
