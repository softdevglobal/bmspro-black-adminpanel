import { NextRequest, NextResponse } from "next/server";
import { verifyAdminAuth } from "@/lib/authHelpers";
import { adminDb } from "@/lib/firebaseAdmin";
import { upsertServiceReminderForBooking } from "@/lib/serviceReminders/server";
import {
  DEFAULT_SERVICE_REMINDER_INTERVAL_DAYS,
  parseServiceReminderIntervalDays,
} from "@/lib/serviceReminders/types";

export const runtime = "nodejs";

/**
 * PATCH /api/service-reminders/[bookingId]
 *
 * Schedule or update a next-service reminder for a single completed booking.
 * Body: { intervalDays?: number }
 */
export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ bookingId: string }> },
) {
  const auth = await verifyAdminAuth(req, ["workshop_owner", "branch_admin"]);
  if (!auth.success || !auth.userData) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status || 401 });
  }

  const { bookingId } = await context.params;
  let body: { intervalDays?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  const db = adminDb();
  const bookingSnap = await db.doc(`bookings/${bookingId}`).get();
  if (!bookingSnap.exists) {
    return NextResponse.json({ ok: false, error: "Booking not found" }, { status: 404 });
  }

  const booking = bookingSnap.data() as Record<string, unknown>;
  const ownerUid = String(booking.ownerUid || "");
  if (ownerUid !== auth.userData.ownerUid) {
    return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
  }

  if (String(booking.status || "") !== "Completed") {
    return NextResponse.json(
      { ok: false, error: "Reminders can only be set on completed bookings" },
      { status: 400 },
    );
  }

  const existingReminder = booking.serviceReminder as { intervalDays?: number } | undefined;
  const parsed = parseServiceReminderIntervalDays(
    body.intervalDays ?? existingReminder?.intervalDays ?? DEFAULT_SERVICE_REMINDER_INTERVAL_DAYS,
  );
  if (!parsed.ok) {
    return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });
  }
  const intervalDays = parsed.days;

  await upsertServiceReminderForBooking({
    bookingId,
    ownerUid,
    booking,
    intervalDays,
    enabled: true,
  });

  const updated = await db.doc(`bookings/${bookingId}`).get();
  return NextResponse.json({
    ok: true,
    enabled: true,
    serviceReminder: updated.data()?.serviceReminder || null,
  });
}
