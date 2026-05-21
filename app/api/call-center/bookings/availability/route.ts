import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";
import {
  verifyCallCenterOrTenantAdminAuth,
  canAccessWorkshopForAuth,
  getTenantId,
  CORS_HEADERS,
} from "@/lib/callCenterAuth";
import { countsTowardDailyLimit } from "@/lib/bookingTypes";
import {
  branchHoursWindowFromSchedule,
  getDayOfWeekFromYmd,
  serializeCallCenterBranchForBooking,
} from "@/lib/callCenterBranchForBooking";

export const runtime = "nodejs";

export async function OPTIONS() {
  return NextResponse.json({}, { headers: CORS_HEADERS });
}

function timeToMinutes(timeStr: string): number {
  const parts = timeStr.split(":").map(Number);
  if (parts.length < 2) return 0;
  return parts[0] * 60 + parts[1];
}

/**
 * GET /api/call-center/bookings/availability?ownerUid=X&branchId=Y&date=2026-04-01
 *
 * Returns the bookable time slots for a branch on a given date. **Booking
 * creation is only restricted by the branch's daily booking limit** — slot
 * availability is NOT gated by per-staff conflicts, per-service capacity, or
 * any overlap logic. As long as the branch is open on that day AND the daily
 * cap has not been reached, every in-hours 30-min slot is returned as
 * available.
 *
 * `serviceIds` is still accepted for backward-compatibility with existing
 * call-center clients but is now ignored.
 *
 * Response:
 *   {
 *     available: boolean,
 *     reason?: string,
 *     dayOfWeek: string,
 *     branch: CallCenterBranchBookingDetails | null,
 *     branchHours: { open: string, close: string } | null,
 *     allSlots: string[],            // 30-min slots inside branch hours
 *     availableSlots: string[],      // same as allSlots when not capped, else []
 *     blockedSlots: string[],        // empty when not capped, else allSlots
 *     dailyLimitReached: boolean,
 *     dailyLimit: number | null,
 *     currentBookings: number,
 *     remainingBookings: number | null,
 *   }
 */
export async function GET(req: NextRequest) {
  const gate = await verifyCallCenterOrTenantAdminAuth(req);
  if (!gate.success) {
    return NextResponse.json(
      { error: gate.error },
      { status: gate.status || 401, headers: CORS_HEADERS },
    );
  }

  const ownerUid = getTenantId(req);
  const branchId = req.nextUrl.searchParams.get("branchId");
  const date = req.nextUrl.searchParams.get("date");

  if (!ownerUid || !branchId || !date) {
    return NextResponse.json(
      { error: "Missing required params: ownerUid (X-Tenant-Id), branchId, date" },
      { status: 400, headers: CORS_HEADERS },
    );
  }

  if (!canAccessWorkshopForAuth(gate.auth, ownerUid)) {
    return NextResponse.json(
      { error: "Access denied" },
      { status: 403, headers: CORS_HEADERS },
    );
  }

  try {
    const db = adminDb();
    const dayOfWeek = getDayOfWeekFromYmd(date);

    // Filter by branchId in the query (used to be filtered client-side after
    // reading every booking that day across ALL branches) and cap at 200 docs
    // as defense-in-depth for branches with high daily limits.
    let branchDoc: FirebaseFirestore.DocumentSnapshot;
    let bookingsSnapshot: { docs: FirebaseFirestore.QueryDocumentSnapshot[] };
    try {
      const [bd, bs] = await Promise.all([
        db.collection("branches").doc(branchId).get(),
        db
          .collection("bookings")
          .where("ownerUid", "==", ownerUid)
          .where("branchId", "==", branchId)
          .where("date", "==", date)
          .limit(200)
          .get(),
      ]);
      branchDoc = bd;
      bookingsSnapshot = { docs: bs.docs };
    } catch {
      // Composite index missing — fall back without `branchId` in the query
      // but still cap to 200.
      const [bd, bs] = await Promise.all([
        db.collection("branches").doc(branchId).get(),
        db
          .collection("bookings")
          .where("ownerUid", "==", ownerUid)
          .where("date", "==", date)
          .limit(200)
          .get(),
      ]);
      branchDoc = bd;
      bookingsSnapshot = { docs: bs.docs };
    }

    const branchData = branchDoc.exists ? branchDoc.data() : null;
    if (
      !branchDoc.exists ||
      !branchData ||
      (branchData.ownerUid && branchData.ownerUid !== ownerUid)
    ) {
      return NextResponse.json(
        {
          available: false,
          reason: "Branch not found or access denied",
          dayOfWeek,
          branch: null,
          branchHours: null,
          allSlots: [],
          availableSlots: [],
          blockedSlots: [],
          dailyLimitReached: false,
          dailyLimit: null,
          currentBookings: 0,
          remainingBookings: null,
        },
        { status: 404, headers: CORS_HEADERS },
      );
    }

    const branch = serializeCallCenterBranchForBooking(
      branchId,
      branchData,
      date,
    );
    const branchHours =
      branch?.daySchedule != null
        ? branchHoursWindowFromSchedule(branch.daySchedule)
        : null;
    const bookingLimitPerDay = branch?.bookingLimitPerDay ?? null;

    // Branch closed on this day → nothing bookable regardless of cap.
    if (!branchHours) {
      return NextResponse.json(
        {
          available: false,
          reason: "Branch is closed on this day",
          dayOfWeek,
          branch,
          branchHours: null,
          allSlots: [],
          availableSlots: [],
          blockedSlots: [],
          dailyLimitReached: false,
          dailyLimit: bookingLimitPerDay,
          currentBookings: 0,
          remainingBookings: null,
        },
        { headers: CORS_HEADERS },
      );
    }

    // Generate all 30-min slots inside branch hours.
    const openMins = timeToMinutes(branchHours.open);
    const closeMins = timeToMinutes(branchHours.close);
    const allSlots: string[] = [];
    for (let mins = openMins; mins < closeMins; mins += 30) {
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      allSlots.push(
        `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`,
      );
    }

    // Count only bookings that count toward the branch's daily cap.
    const bookingsTowardLimit = bookingsSnapshot.docs
      .map((d) => ({ id: d.id, ...d.data() } as any))
      .filter(
        (b: any) =>
          b.branchId === branchId && countsTowardDailyLimit(b.status),
      );

    const hasLimit =
      typeof bookingLimitPerDay === "number" && bookingLimitPerDay > 0;
    const dailyLimitReached = hasLimit
      ? bookingsTowardLimit.length >= bookingLimitPerDay
      : false;
    const remainingBookings = hasLimit
      ? Math.max(0, bookingLimitPerDay - bookingsTowardLimit.length)
      : null;

    if (dailyLimitReached) {
      return NextResponse.json(
        {
          available: false,
          reason: "Daily booking limit reached",
          dayOfWeek,
          branch,
          branchHours,
          allSlots,
          availableSlots: [],
          blockedSlots: allSlots,
          dailyLimitReached: true,
          dailyLimit: bookingLimitPerDay,
          currentBookings: bookingsTowardLimit.length,
          remainingBookings: 0,
        },
        { headers: CORS_HEADERS },
      );
    }

    // Daily cap not reached → every in-hours slot is bookable.
    return NextResponse.json(
      {
        available: allSlots.length > 0,
        dayOfWeek,
        branch,
        branchHours,
        allSlots,
        availableSlots: allSlots,
        blockedSlots: [],
        dailyLimitReached: false,
        dailyLimit: bookingLimitPerDay,
        currentBookings: bookingsTowardLimit.length,
        remainingBookings,
      },
      { headers: CORS_HEADERS },
    );
  } catch (error: any) {
    console.error("[call-center/bookings/availability] Error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500, headers: CORS_HEADERS },
    );
  }
}
