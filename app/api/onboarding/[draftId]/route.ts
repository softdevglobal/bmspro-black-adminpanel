import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
async function forward(req: NextRequest, context: { params: Promise<{ draftId: string }> }, action: "review" | "approve") {
  if (process.env.COMMAND_CENTRE_ONBOARDING_ENABLED !== "true") return NextResponse.json({ error: "Onboarding is unavailable." }, { status: 404 });
  const { draftId } = await context.params;
  if (!/^[a-f0-9-]{36}$/i.test(draftId)) return NextResponse.json({ error: "Invalid review reference." }, { status: 400 });
  const authorization = req.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  try {
    const url = new URL(process.env.COMMAND_CENTRE_API_URL || "https://command-api.bmspros.com.au");
    const local = process.env.COMMAND_CENTRE_ALLOW_LOCAL_TEST === "true" && url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if ((url.protocol !== "https:" && !local) || url.username || url.password || url.search || url.hash) throw new Error("Invalid backend URL");
    url.pathname = `/api/onboarding/${draftId}/${action}`;
    const response = await fetch(url, { method: action === "review" ? "GET" : "POST", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15000),
      headers: { Authorization: authorization, "Content-Type": "application/json" }, ...(action === "approve" ? { body: JSON.stringify(await req.json()) } : {}) });
    return NextResponse.json(await response.json(), { status: response.status, headers: { "Cache-Control": "no-store" } });
  } catch { return NextResponse.json({ error: "The onboarding service is unavailable. Your approval has not been confirmed." }, { status: 503 }); }
}
export async function GET(req: NextRequest, context: { params: Promise<{ draftId: string }> }) { return forward(req, context, "review"); }
export async function POST(req: NextRequest, context: { params: Promise<{ draftId: string }> }) { return forward(req, context, "approve"); }
