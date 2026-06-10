import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";
import { countsTowardDailyLimit } from "@/lib/bookingTypes";

export const runtime = "nodejs";

function getDayOfWeek(dateStr: string): string {
  const dateObj = new Date(dateStr + "T12:00:00");
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  return days[dateObj.getDay()];
}

function timeToMinutes(timeStr: string): number {
  const parts = timeStr.split(":").map(Number);
  if (parts.length < 2) return 0;
  return parts[0] * 60 + parts[1];
}

/**
 * Public API: Check time slot availability for the booking engine.
 *
 * Slots are only blocked when the branch's daily booking limit has been
 * reached. Staff-wise capacity (i.e. blocking a slot because all eligible
 * staff for that time are already occupied) is intentionally NOT enforced
 * here — a branch can accept more bookings than it has staff; assignment is
 * handled manually by the workshop.
 */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const slug = searchParams.get("slug");
    const branchId = searchParams.get("branchId");
    const date = searchParams.get("date");
    const serviceIdsParam = searchParams.get("serviceIds");

    if (!slug || !branchId || !date || !serviceIdsParam) {
      return NextResponse.json({ error: "Missing required params: slug, branchId, date, serviceIds" }, { status: 400 });
    }

    const serviceIds = serviceIdsParam.split(",").filter(Boolean);
    if (serviceIds.length === 0) {
      return NextResponse.json({ error: "No services specified" }, { status: 400 });
    }

    const db = adminDb();

    // Resolve owner by slug
    const usersQuery = await db
      .collection("users")
      .where("slug", "==", slug)
      .where("role", "==", "workshop_owner")
      .limit(1)
      .get();

    if (usersQuery.empty) {
      return NextResponse.json({ error: "Workshop not found" }, { status: 404 });
    }

    const ownerUid = usersQuery.docs[0].id;
    const dayOfWeek = getDayOfWeek(date);

    // Fetch branch and existing bookings in parallel. We filter by branchId
    // in the query (used to be filtered in-memory after reading every booking
    // for the day across ALL branches) and cap at 200 docs as defense-in-depth
    // for branches with unreasonably high daily limits.
    let bookingsForBranchAndDate: FirebaseFirestore.QueryDocumentSnapshot[] = [];
    let branchDoc: FirebaseFirestore.DocumentSnapshot;
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
      bookingsForBranchAndDate = bs.docs;
    } catch (e) {
      // Composite index missing — fall back to the previous shape (owner+date)
      // but still cap to 200 to avoid runaway reads.
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
      bookingsForBranchAndDate = bs.docs;
    }
    const bookingsSnapshot = { docs: bookingsForBranchAndDate };

    // Get branch hours
    let branchHours: { open: string; close: string } | null = null;
    if (branchDoc.exists) {
      const branchData = branchDoc.data();
      if (branchData?.hours && typeof branchData.hours === "object") {
        const dayHours = branchData.hours[dayOfWeek];
        if (dayHours && !dayHours.closed) {
          branchHours = { open: dayHours.open || "09:00", close: dayHours.close || "17:00" };
        }
      }
    }

    if (!branchHours) {
      return NextResponse.json({ blockedSlots: [], dailyLimitReached: false });
    }

    // Generate all 30-min slots
    const openMins = timeToMinutes(branchHours.open);
    const closeMins = timeToMinutes(branchHours.close);
    const allSlots: string[] = [];
    for (let mins = openMins; mins < closeMins; mins += 30) {
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      allSlots.push(`${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`);
    }

    const branchData = branchDoc.exists ? branchDoc.data() : null;
    const bookingLimitPerDay =
      typeof branchData?.bookingLimitPerDay === "number" ? branchData.bookingLimitPerDay : null;
    const bookingsTowardLimit = bookingsSnapshot.docs
      .map((d) => ({ id: d.id, ...d.data() } as any))
      .filter((b: any) => b.branchId === branchId && countsTowardDailyLimit(b.status));
    const isDailyLimitReached =
      typeof bookingLimitPerDay === "number" && bookingLimitPerDay > 0
        ? bookingsTowardLimit.length >= bookingLimitPerDay
        : false;

    // If daily limit is reached, all slots are unavailable.
    if (isDailyLimitReached) {
      return NextResponse.json({
        blockedSlots: allSlots,
        dailyLimitReached: true,
        dailyLimit: bookingLimitPerDay,
        dayBookings: bookingsTowardLimit.length,
      });
    }

    // Otherwise, no slot is blocked — staff capacity is intentionally ignored.
    return NextResponse.json({
      blockedSlots: [],
      dailyLimitReached: false,
      dailyLimit: bookingLimitPerDay,
      dayBookings: bookingsTowardLimit.length,
    });
  } catch (error: any) {
    console.error("Error checking availability:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
