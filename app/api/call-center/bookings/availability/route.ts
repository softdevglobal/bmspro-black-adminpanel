import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";
import {
  verifyCallCenterOrTenantAdminAuth,
  canAccessWorkshopForAuth,
  getTenantId,
  CORS_HEADERS,
} from "@/lib/callCenterAuth";
import { shouldBlockSlots, countsTowardDailyLimit } from "@/lib/bookingTypes";

export const runtime = "nodejs";

export async function OPTIONS() {
  return NextResponse.json({}, { headers: CORS_HEADERS });
}

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

function timeRangesOverlap(
  start1: number, end1: number,
  start2: number, end2: number
): boolean {
  return start1 < end2 && start2 < end1;
}

function isAnyStaff(staffId?: string | null): boolean {
  if (!staffId) return true;
  const str = String(staffId).trim().toLowerCase();
  return str === "" || str === "null" || str.includes("any") || str === "not assigned yet";
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

/**
 * GET /api/call-center/bookings/availability?ownerUid=X&branchId=Y&date=2026-04-01&serviceIds=svc1,svc2
 *
 * Check time slot availability before creating a booking.
 * Returns: blocked time slots, daily limit info, and available slots.
 * The call center dashboard should call this BEFORE creating a booking.
 */
export async function GET(req: NextRequest) {
  const gate = await verifyCallCenterOrTenantAdminAuth(req);
  if (!gate.success) {
    return NextResponse.json(
      { error: gate.error },
      { status: gate.status || 401, headers: CORS_HEADERS }
    );
  }

  const ownerUid = getTenantId(req);
  const branchId = req.nextUrl.searchParams.get("branchId");
  const date = req.nextUrl.searchParams.get("date");
  const serviceIdsParam = req.nextUrl.searchParams.get("serviceIds");

  if (!ownerUid || !branchId || !date || !serviceIdsParam) {
    return NextResponse.json(
      { error: "Missing required params: ownerUid, branchId, date, serviceIds" },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  if (!canAccessWorkshopForAuth(gate.auth, ownerUid)) {
    return NextResponse.json(
      { error: "Access denied" },
      { status: 403, headers: CORS_HEADERS }
    );
  }

  const serviceIds = serviceIdsParam.split(",").filter(Boolean);

  try {
    const db = adminDb();
    const dayOfWeek = getDayOfWeek(date);

    const [staffSnapshot, servicesSnapshot, branchDoc, bookingsSnapshot] = await Promise.all([
      db.collection("users").where("ownerUid", "==", ownerUid).get(),
      db.collection("services").where("ownerUid", "==", ownerUid).get(),
      db.collection("branches").doc(branchId).get(),
      db.collection("bookings").where("ownerUid", "==", ownerUid).where("date", "==", date).get(),
    ]);

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
      return NextResponse.json(
        {
          available: false,
          reason: "Branch is closed on this day",
          dayOfWeek,
          blockedSlots: [],
          availableSlots: [],
          dailyLimitReached: false,
        },
        { headers: CORS_HEADERS }
      );
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

    // Generate all 30-min slots
    const openMins = timeToMinutes(branchHours.open);
    const closeMins = timeToMinutes(branchHours.close);
    const allSlots: string[] = [];
    for (let mins = openMins; mins < closeMins; mins += 30) {
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      allSlots.push(`${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`);
    }

    if (isDailyLimitReached) {
      return NextResponse.json(
        {
          available: false,
          reason: "Daily booking limit reached",
          dayOfWeek,
          branchHours,
          blockedSlots: allSlots,
          availableSlots: [],
          dailyLimitReached: true,
          dailyLimit: bookingLimitPerDay,
          currentBookings: bookingsTowardLimit.length,
        },
        { headers: CORS_HEADERS }
      );
    }

    const allStaff = staffSnapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
    const allServicesData = servicesSnapshot.docs.map((d) => ({ id: d.id, ...d.data() }));

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

    const activeBookings = bookingsSnapshot.docs
      .map((d) => ({ id: d.id, ...d.data() } as any))
      .filter((b: any) => b.branchId === branchId && shouldBlockSlots(b.status));

    const blockedSlots: string[] = [];

    for (const slot of allSlots) {
      let isBlocked = false;

      for (const serviceId of serviceIds) {
        const eligibleIds = eligibleStaffByService[serviceId] || [];
        const totalCapacity = eligibleIds.length;
        if (totalCapacity === 0) continue;

        const duration = serviceDurations[serviceId];
        const slotStart = timeToMinutes(slot);
        const slotEnd = slotStart + duration;

        const bookedStaffIds = new Set<string>();
        let anyStaffOverlapping = 0;

        for (const booking of activeBookings) {
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

    const availableSlots = allSlots.filter((s) => !blockedSlots.includes(s));

    return NextResponse.json(
      {
        available: availableSlots.length > 0,
        dayOfWeek,
        branchHours,
        allSlots,
        blockedSlots,
        availableSlots,
        dailyLimitReached: false,
        dailyLimit: bookingLimitPerDay,
        currentBookings: bookingsTowardLimit.length,
      },
      { headers: CORS_HEADERS }
    );
  } catch (error: any) {
    console.error("[call-center/bookings/availability] Error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
