import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/broadcasts/auth";
import { syncSmsPackageToStripe } from "@/lib/stripe/fulfill";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  try {
    const body = await req.json();
    const id = String(body.id ?? "").trim();
    if (!id) {
      return NextResponse.json({ ok: false, error: "id is required" }, { status: 400 });
    }

    const pkg = await syncSmsPackageToStripe(id);
    return NextResponse.json({ ok: true, package: pkg });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to sync SMS package to Stripe";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
