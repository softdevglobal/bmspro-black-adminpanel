import { NextResponse } from "next/server";
import { listSmsPackages } from "@/lib/sms-packages/server";

export const runtime = "nodejs";

export async function GET() {
  try {
    const packages = await listSmsPackages({ publicOnly: true });
    return NextResponse.json({ ok: true, packages });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to load SMS packages";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
