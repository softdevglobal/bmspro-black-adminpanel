import { NextRequest, NextResponse } from "next/server";
import { verifyAdminAuth } from "@/lib/authHelpers";
import {
  bulkScheduleServiceRemindersForOwner,
  getOwnerServiceReminderSettings,
  saveOwnerServiceReminderSettings,
} from "@/lib/serviceReminders/server";
import {
  parseServiceReminderIntervalDays,
  type ServiceReminderSettings,
} from "@/lib/serviceReminders/types";

export const runtime = "nodejs";

function parseServiceIntervals(
  raw: unknown,
): { ok: true; intervals: Record<string, number> } | { ok: false; error: string } {
  if (raw === undefined || raw === null) {
    return { ok: false, error: "serviceIntervals is required." };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "serviceIntervals must be an object keyed by service id." };
  }
  const intervals: Record<string, number> = {};
  for (const [serviceId, value] of Object.entries(raw as Record<string, unknown>)) {
    const id = String(serviceId || "").trim();
    if (!id) continue;
    const parsed = parseServiceReminderIntervalDays(value);
    if (!parsed.ok) {
      return { ok: false, error: `Invalid interval for service ${id}: ${parsed.error}` };
    }
    intervals[id] = parsed.days;
  }
  if (Object.keys(intervals).length === 0) {
    return { ok: false, error: "Set at least one service interval before saving." };
  }
  return { ok: true, intervals };
}

/**
 * GET /api/service-reminders/settings
 * PATCH /api/service-reminders/settings
 *
 * Owner-level per-service reminder intervals.
 * Stored on users/{ownerUid}.serviceReminderSettings
 */
export async function GET(req: NextRequest) {
  const auth = await verifyAdminAuth(req, ["workshop_owner", "branch_admin"]);
  if (!auth.success || !auth.userData) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status || 401 });
  }

  const settings = await getOwnerServiceReminderSettings(auth.userData.ownerUid);
  return NextResponse.json({ ok: true, settings });
}

export async function PATCH(req: NextRequest) {
  const auth = await verifyAdminAuth(req, ["workshop_owner", "branch_admin"]);
  if (!auth.success || !auth.userData) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status || 401 });
  }

  let body: { serviceIntervals?: unknown; customMessage?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  const parsedIntervals = parseServiceIntervals(body.serviceIntervals);
  if (!parsedIntervals.ok) {
    return NextResponse.json({ ok: false, error: parsedIntervals.error }, { status: 400 });
  }

  const current = await getOwnerServiceReminderSettings(auth.userData.ownerUid);
  const customMessage =
    body.customMessage === undefined
      ? current.customMessage
      : typeof body.customMessage === "string"
        ? body.customMessage.trim()
        : "";

  const saved = await saveOwnerServiceReminderSettings(
    auth.userData.ownerUid,
    parsedIntervals.intervals,
    customMessage || undefined,
  );
  const bulk = await bulkScheduleServiceRemindersForOwner(auth.userData.ownerUid, saved);
  return NextResponse.json({ ok: true, settings: saved, bulk });
}
