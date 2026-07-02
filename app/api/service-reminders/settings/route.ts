import { NextRequest, NextResponse } from "next/server";
import { verifyAdminAuth } from "@/lib/authHelpers";
import { adminDb } from "@/lib/firebaseAdmin";
import {
  assertBranchReminderAccess,
  bulkScheduleServiceRemindersForBranch,
  getServiceReminderSettings,
  saveServiceReminderSettings,
} from "@/lib/serviceReminders/server";
import {
  DEFAULT_SERVICE_REMINDER_INTERVAL_DAYS,
  parseServiceReminderIntervalDays,
  type ServiceReminderSettings,
} from "@/lib/serviceReminders/types";

export const runtime = "nodejs";

async function resolveBranchId(
  req: NextRequest,
  auth: NonNullable<Awaited<ReturnType<typeof verifyAdminAuth>>["userData"]>,
  bodyBranchId?: unknown,
): Promise<string | null> {
  const fromQuery = req.nextUrl.searchParams.get("branchId")?.trim();
  const fromBody = typeof bodyBranchId === "string" ? bodyBranchId.trim() : "";
  const requested = fromBody || fromQuery || "";

  if (auth.role === "branch_admin") {
    const userSnap = await adminDb().doc(`users/${auth.uid}`).get();
    return String(userSnap.data()?.branchId || "").trim() || null;
  }

  return requested || null;
}

/**
 * GET /api/service-reminders/settings?branchId=...
 * PATCH /api/service-reminders/settings
 *
 * Branch-level defaults for automatic next-service reminders on completed bookings.
 * Stored on branches/{branchId}.serviceReminderSettings
 */
export async function GET(req: NextRequest) {
  const auth = await verifyAdminAuth(req, ["workshop_owner", "branch_admin"]);
  if (!auth.success || !auth.userData) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status || 401 });
  }

  const branchId = await resolveBranchId(req, auth.userData);
  if (!branchId) {
    return NextResponse.json({ ok: false, error: "branchId is required" }, { status: 400 });
  }

  try {
    await assertBranchReminderAccess({
      branchId,
      ownerUid: auth.userData.ownerUid,
      userUid: auth.userData.uid,
      userRole: auth.userData.role,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Forbidden";
    const status = msg === "Branch not found" ? 404 : msg === "Branch is required" ? 400 : 403;
    return NextResponse.json({ ok: false, error: msg }, { status });
  }

  const settings = await getServiceReminderSettings(branchId);
  return NextResponse.json({ ok: true, branchId, settings });
}

export async function PATCH(req: NextRequest) {
  const auth = await verifyAdminAuth(req, ["workshop_owner", "branch_admin"]);
  if (!auth.success || !auth.userData) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status || 401 });
  }

  let body: {
    branchId?: unknown;
    intervalDays?: unknown;
    customMessage?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  const branchId = await resolveBranchId(req, auth.userData, body.branchId);
  if (!branchId) {
    return NextResponse.json({ ok: false, error: "branchId is required" }, { status: 400 });
  }

  try {
    await assertBranchReminderAccess({
      branchId,
      ownerUid: auth.userData.ownerUid,
      userUid: auth.userData.uid,
      userRole: auth.userData.role,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Forbidden";
    const status = msg === "Branch not found" ? 404 : msg === "Branch is required" ? 400 : 403;
    return NextResponse.json({ ok: false, error: msg }, { status });
  }

  const current = await getServiceReminderSettings(branchId);
  let intervalDays = current.intervalDays || DEFAULT_SERVICE_REMINDER_INTERVAL_DAYS;
  if (body.intervalDays !== undefined) {
    const parsed = parseServiceReminderIntervalDays(body.intervalDays);
    if (!parsed.ok) {
      return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });
    }
    intervalDays = parsed.days;
  }

  const customMessage =
    body.customMessage === undefined
      ? current.customMessage
      : typeof body.customMessage === "string"
        ? body.customMessage.trim()
        : "";

  const settings: ServiceReminderSettings = {
    enabled: true,
    intervalDays,
    ...(customMessage ? { customMessage } : {}),
  };

  const saved = await saveServiceReminderSettings(branchId, settings);
  const bulk = await bulkScheduleServiceRemindersForBranch(
    branchId,
    auth.userData.ownerUid,
    saved.intervalDays,
  );
  return NextResponse.json({ ok: true, branchId, settings: saved, bulk });
}
