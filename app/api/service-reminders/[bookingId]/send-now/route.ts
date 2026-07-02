import { NextRequest, NextResponse } from "next/server";
import { verifyAdminAuth } from "@/lib/authHelpers";
import { adminDb } from "@/lib/firebaseAdmin";
import { sendServiceReminderNowForBooking } from "@/lib/serviceReminders/server";

export const runtime = "nodejs";

/**
 * POST /api/service-reminders/[bookingId]/send-now
 *
 * Immediately sends any pending reminder phases for this booking (testing).
 */
export async function POST(
  req: NextRequest,
  context: { params: Promise<{ bookingId: string }> },
) {
  const auth = await verifyAdminAuth(req, ["workshop_owner", "branch_admin"]);
  if (!auth.success || !auth.userData) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status || 401 });
  }

  const { bookingId } = await context.params;
  const bookingSnap = await adminDb().doc(`bookings/${bookingId}`).get();
  if (!bookingSnap.exists) {
    return NextResponse.json({ ok: false, error: "Booking not found" }, { status: 404 });
  }

  const booking = bookingSnap.data() as Record<string, unknown>;
  if (String(booking.ownerUid || "") !== auth.userData.ownerUid) {
    return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
  }

  if (String(booking.status || "") !== "Completed") {
    return NextResponse.json(
      { ok: false, error: "Reminders can only be sent for completed bookings" },
      { status: 400 },
    );
  }

  try {
    const result = await sendServiceReminderNowForBooking(bookingId);
    const updated = await adminDb().doc(`bookings/${bookingId}`).get();
    return NextResponse.json({
      ok: true,
      ...result,
      serviceReminder: updated.data()?.serviceReminder ?? null,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Failed to send reminder";
    return NextResponse.json({ ok: false, error: msg }, { status: 400 });
  }
}
