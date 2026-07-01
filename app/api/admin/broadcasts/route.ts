import { requireSuperAdmin } from "@/lib/broadcasts/auth";
import {
  logCustomNotificationSent,
  resolveAuditIdentityForUid,
} from "@/lib/broadcasts/audit-server";
import {
  createBroadcast,
  listAllBroadcasts,
} from "@/lib/broadcasts/server";
import { isValidAudience } from "@/lib/broadcasts/types";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const MAX_TITLE_LENGTH = 120;
const MAX_BODY_LENGTH = 2000;

export async function GET(request: Request) {
  const auth = await requireSuperAdmin(request);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }
  const broadcasts = await listAllBroadcasts();
  return NextResponse.json({ ok: true, broadcasts });
}

export async function POST(request: Request) {
  const auth = await requireSuperAdmin(request);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  let payload: Record<string, unknown>;
  try {
    payload = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request body." }, { status: 400 });
  }

  const title = typeof payload.title === "string" ? payload.title.trim() : "";
  const body = typeof payload.body === "string" ? payload.body.trim() : "";
  const audience = payload.audience;
  const platforms = (payload.platforms ?? {}) as Record<string, unknown>;
  const targetAdmin = platforms.admin === true;
  const targetMobile = platforms.mobile === true;

  if (!title) {
    return NextResponse.json({ ok: false, error: "A title is required." }, { status: 400 });
  }
  if (title.length > MAX_TITLE_LENGTH) {
    return NextResponse.json(
      { ok: false, error: `Title must be ${MAX_TITLE_LENGTH} characters or fewer.` },
      { status: 400 },
    );
  }
  if (!body) {
    return NextResponse.json({ ok: false, error: "A message body is required." }, { status: 400 });
  }
  if (body.length > MAX_BODY_LENGTH) {
    return NextResponse.json(
      { ok: false, error: `Message must be ${MAX_BODY_LENGTH} characters or fewer.` },
      { status: 400 },
    );
  }
  if (!isValidAudience(audience)) {
    return NextResponse.json({ ok: false, error: "Select a valid audience." }, { status: 400 });
  }
  if (!targetAdmin && !targetMobile) {
    return NextResponse.json(
      { ok: false, error: "Select at least one platform (admin panel or mobile app)." },
      { status: 400 },
    );
  }

  const result = await createBroadcast({
    title,
    body,
    platforms: { admin: targetAdmin, mobile: targetMobile },
    audience,
    createdByUid: auth.uid,
    createdByEmail: auth.email ?? null,
  });

  const identity = await resolveAuditIdentityForUid(auth.uid);
  await logCustomNotificationSent({
    actor: {
      uid: auth.uid,
      email: identity.email ?? auth.email ?? null,
      name: identity.name,
    },
    broadcastId: result.id,
    title,
    audience,
    platforms: { admin: targetAdmin, mobile: targetMobile },
    mobilePushCount: result.mobilePushCount,
  });

  return NextResponse.json({ ok: true, ...result });
}
