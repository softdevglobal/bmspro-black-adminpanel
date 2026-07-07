import { requireBusinessMember } from "@/lib/broadcasts/auth";
import {
  dismissAllBroadcasts,
  listBroadcastsForUser,
  markAllBroadcastsRead,
} from "@/lib/broadcasts/server";
import { isValidPlatform, type BroadcastPlatform } from "@/lib/broadcasts/types";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

function resolvePlatform(request: Request): BroadcastPlatform {
  const value = new URL(request.url).searchParams.get("platform");
  return isValidPlatform(value) ? value : "mobile";
}

export async function GET(request: Request) {
  const auth = await requireBusinessMember(request);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }
  const broadcasts = await listBroadcastsForUser(
    auth.uid,
    auth.role,
    resolvePlatform(request),
  );
  return NextResponse.json({ ok: true, broadcasts });
}

export async function PATCH(request: Request) {
  const auth = await requireBusinessMember(request);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }
  await markAllBroadcastsRead(auth.uid, auth.role, resolvePlatform(request));
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request) {
  const auth = await requireBusinessMember(request);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }
  await dismissAllBroadcasts(auth.uid, auth.role, resolvePlatform(request));
  return NextResponse.json({ ok: true });
}
