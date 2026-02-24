import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";
import { shouldBlockSlots } from "@/lib/bookingTypes";

export const runtime = "nodejs";

function getDayOfWeek(dateStr: string): string {
  const dateObj = new Date(dateStr + "T12:00:00");
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  return days[dateObj.getDay()];
}

function isStaffAssignedToBranch(staff: any, branchId: string, dayOfWeek: string): boolean {
  if (dayOfWeek && staff.weeklySchedule && typeof staff.weeklySchedule === "object") {
    const daySchedule = staff.weeklySchedule[dayOfWeek];
    if (daySchedule && daySchedule.branchId) {
      return daySchedule.branchId === branchId;
    }
    if (daySchedule === null || daySchedule === undefined) {
      return false;
    }
  }
  return staff.branchId === branchId;
}

function isAnyStaff(staffId?: string | null): boolean {
  if (!staffId) return true;
  const str = String(staffId).trim().toLowerCase();
  return str === "" || str === "null" || str.includes("any") || str === "not assigned yet";
}

function timeToMinutes(timeStr: string): number {
  const parts = timeStr.split(":").map(Number);
  if (parts.length < 2) return 0;
  return parts[0] * 60 + parts[1];
}

function timeRangesOverlap(
  start1: number, end1: number,
  start2: number, end2: number
): boolean {
  return start1 < end2 && start2 < end1;
}

/**
 * Public API: Check time slot availability for the booking engine.
 * Returns slots blocked by staff availability and daily booking limit.
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

    // Fetch staff, services, branch, and existing bookings in parallel
    const [staffSnapshot, servicesSnapshot, branchDoc, bookingsSnapshot] = await Promise.all([
      db.collection("users").where("ownerUid", "==", ownerUid).get(),
      db.collection("services").where("ownerUid", "==", ownerUid).get(),
      db.collection("branches").doc(branchId).get(),
      db.collection("bookings").where("ownerUid", "==", ownerUid).where("date", "==", date).get(),
    ]);

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

    const allStaff = staffSnapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
    const allServicesData = servicesSnapshot.docs.map((d) => ({ id: d.id, ...d.data() }));

    // Compute eligible staff per selected service
    const eligibleStaffByService: Record<string, string[]> = {};
    const serviceDurations: Record<string, number> = {};

    for (const serviceId of serviceIds) {
      const serviceData: any = allServicesData.find((s) => s.id === serviceId);
      serviceDurations[serviceId] = serviceData?.duration || 60;

      const eligible = allStaff.filter((st: any) => {
        const role = (st.role || "").toString().toLowerCase();
        if (role !== "staff" && role !== "branch_admin") return false;
        if (st.status && st.status !== "Active") return false;

        if (serviceData?.staffIds && serviceData.staffIds.length > 0) {
          const canPerform = serviceData.staffIds.some(
            (id: string) => String(id) === st.id || String(id) === ((st as any).uid || st.id)
          );
          if (!canPerform) return false;
        }

        return isStaffAssignedToBranch(st, branchId, dayOfWeek);
      });

      eligibleStaffByService[serviceId] = eligible.map((s) => s.id);
    }

    // Filter active bookings for this branch
    const activeBookings = bookingsSnapshot.docs
      .map((d) => ({ id: d.id, ...d.data() } as any))
      .filter((b: any) => b.branchId === branchId && shouldBlockSlots(b.status));

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
    const isDailyLimitReached =
      typeof bookingLimitPerDay === "number" && bookingLimitPerDay > 0
        ? activeBookings.length >= bookingLimitPerDay
        : false;

    // If daily limit is reached, all slots are unavailable.
    if (isDailyLimitReached) {
      return NextResponse.json({
        blockedSlots: allSlots,
        dailyLimitReached: true,
        dailyLimit: bookingLimitPerDay,
        dayBookings: activeBookings.length,
      });
    }

    // For each slot, check staff availability against each selected service
    const blockedSlots: string[] = [];

    for (const slot of allSlots) {
      let isBlocked = false;

      for (const serviceId of serviceIds) {
        const eligibleIds = eligibleStaffByService[serviceId] || [];
        const totalCapacity = eligibleIds.length;

        if (totalCapacity === 0) {
          // No eligible staff configured -- don't block (allow owner to handle manually)
          continue;
        }

        const duration = serviceDurations[serviceId];
        const slotStart = timeToMinutes(slot);
        const slotEnd = slotStart + duration;

        const bookedStaffIds = new Set<string>();
        let anyStaffOverlapping = 0;

        for (const booking of activeBookings) {
          // Check services array for multi-service bookings
          if (booking.services && Array.isArray(booking.services) && booking.services.length > 0) {
            for (const existingSvc of booking.services) {
              if (!existingSvc.time) continue;
              const existingStaffId = existingSvc.staffId || booking.staffId || null;
              const existingStart = timeToMinutes(existingSvc.time);
              const existingDuration = existingSvc.duration || booking.duration || 60;
              const existingEnd = existingStart + existingDuration;

              if (!timeRangesOverlap(slotStart, slotEnd, existingStart, existingEnd)) continue;

              if (!isAnyStaff(existingStaffId)) {
                if (eligibleIds.includes(existingStaffId!)) {
                  bookedStaffIds.add(existingStaffId!);
                }
              } else {
                anyStaffOverlapping++;
              }
            }
          } else {
            if (!booking.time) continue;
            const existingStaffId = booking.staffId || null;
            const existingStart = timeToMinutes(booking.time);
            const existingDuration = booking.duration || 60;
            const existingEnd = existingStart + existingDuration;

            if (!timeRangesOverlap(slotStart, slotEnd, existingStart, existingEnd)) continue;

            if (!isAnyStaff(existingStaffId)) {
              if (eligibleIds.includes(existingStaffId!)) {
                bookedStaffIds.add(existingStaffId!);
              }
            } else {
              anyStaffOverlapping++;
            }
          }
        }

        const freeStaff = totalCapacity - bookedStaffIds.size - anyStaffOverlapping;
        if (freeStaff <= 0) {
          isBlocked = true;
        }
      }

      if (isBlocked) {
        blockedSlots.push(slot);
      }
    }

    return NextResponse.json({
      blockedSlots,
      dailyLimitReached: false,
      dailyLimit: bookingLimitPerDay,
      dayBookings: activeBookings.length,
    });
  } catch (error: any) {
    console.error("Error checking availability:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
