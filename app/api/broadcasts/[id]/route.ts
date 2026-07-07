import { requireBusinessMember } from "@/lib/broadcasts/auth";
import { dismissBroadcast, markBroadcastRead } from "@/lib/broadcasts/server";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await requireBusinessMember(request);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }
  const { id } = await context.params;
  await markBroadcastRead(auth.uid, id);
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await requireBusinessMember(request);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }
  const { id } = await context.params;
  await dismissBroadcast(auth.uid, id);
  return NextResponse.json({ ok: true });
}
