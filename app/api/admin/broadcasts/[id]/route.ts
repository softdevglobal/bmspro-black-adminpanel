import { requireSuperAdmin } from "@/lib/broadcasts/auth";
import {
  logCustomNotificationActiveChanged,
  logCustomNotificationDeleted,
  resolveAuditIdentityForUid,
} from "@/lib/broadcasts/audit-server";
import {
  deleteBroadcast,
  getBroadcastById,
  setBroadcastActive,
} from "@/lib/broadcasts/server";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await requireSuperAdmin(request);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }
  const { id } = await context.params;

  let payload: Record<string, unknown>;
  try {
    payload = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request body." }, { status: 400 });
  }

  if (typeof payload.active !== "boolean") {
    return NextResponse.json({ ok: false, error: "`active` must be a boolean." }, { status: 400 });
  }

  const existing = await getBroadcastById(id);
  if (!existing) {
    return NextResponse.json({ ok: false, error: "Message not found." }, { status: 404 });
  }

  const ok = await setBroadcastActive(id, payload.active);
  if (!ok) {
    return NextResponse.json({ ok: false, error: "Message not found." }, { status: 404 });
  }

  const identity = await resolveAuditIdentityForUid(auth.uid);
  await logCustomNotificationActiveChanged({
    actor: {
      uid: auth.uid,
      email: identity.email ?? auth.email ?? null,
      name: identity.name,
    },
    broadcastId: id,
    title: existing.title,
    active: payload.active,
  });

  return NextResponse.json({ ok: true });
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await requireSuperAdmin(request);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }
  const { id } = await context.params;

  const existing = await getBroadcastById(id);
  if (!existing) {
    return NextResponse.json({ ok: false, error: "Message not found." }, { status: 404 });
  }

  const ok = await deleteBroadcast(id);
  if (!ok) {
    return NextResponse.json({ ok: false, error: "Message not found." }, { status: 404 });
  }

  const identity = await resolveAuditIdentityForUid(auth.uid);
  await logCustomNotificationDeleted({
    actor: {
      uid: auth.uid,
      email: identity.email ?? auth.email ?? null,
      name: identity.name,
    },
    broadcastId: id,
    title: existing.title,
  });

  return NextResponse.json({ ok: true });
}
