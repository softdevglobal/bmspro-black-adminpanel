import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";
import { FieldValue } from "firebase-admin/firestore";
import { generateBookingCode } from "@/lib/bookings";
import { sendBookingRequestReceivedEmail } from "@/lib/emailService";
import { shouldBlockSlots } from "@/lib/bookingTypes";
import { getBranchAdminUids, createBranchAdminNotification } from "@/lib/notifications";

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

function isAnyStaffId(staffId?: string | null): boolean {
  if (!staffId) return true;
  const str = String(staffId).trim().toLowerCase();
  return str === "" || str === "null" || str.includes("any") || str === "not assigned yet";
}

function timeToMinutes(timeStr: string): number {
  const parts = timeStr.split(":").map(Number);
  if (parts.length < 2) return 0;
  return parts[0] * 60 + parts[1];
}

function timeRangesOverlap(s1: number, e1: number, s2: number, e2: number): boolean {
  return s1 < e2 && s2 < e1;
}

/**
 * Public API: Submit a booking from the booking engine.
 * No admin authentication required - this is for public customers.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    const {
      slug,
      branchId,
      branchName,
      services: selectedServices,
      customerName,
      customerEmail,
      customerPhone,
      vehicleNumber,
      vehicleDetails,
      notes,
      date,
      time,
      pickupTime,
      customerId,
    } = body;

    if (!customerId) {
      return NextResponse.json(
        { error: "Login required. Please sign in or create an account to book." },
        { status: 401 }
      );
    }

    const effectiveVehicleNumber =
      (vehicleNumber || "").trim() ||
      [vehicleDetails?.make, vehicleDetails?.model, vehicleDetails?.year].filter(Boolean).join(" ").trim() ||
      "Vehicle";

    if (!slug || !branchId || !selectedServices?.length || !customerName || !customerPhone || !customerEmail?.trim() || !date || !time || !pickupTime) {
      return NextResponse.json(
        { error: "Missing required fields. Please fill in all required fields." },
        { status: 400 }
      );
    }

    const db = adminDb();

    // Find the workshop owner by slug (support both roles)
    let usersQuery = await db
      .collection("users")
      .where("slug", "==", slug)
      .where("role", "==", "workshop_owner")
      .limit(1)
      .get();

    if (usersQuery.empty) {
      usersQuery = await db
        .collection("users")
        .where("slug", "==", slug)
        .where("role", "in", ["workshop_owner"])
        .limit(1)
        .get();
    }

    if (usersQuery.empty) {
      return NextResponse.json({ error: "Workshop not found" }, { status: 404 });
    }

    const ownerDoc = usersQuery.docs[0];
    const ownerUid = ownerDoc.id;

    // Calculate total price and duration from selected services
    let totalPrice = 0;
    let totalDuration = 0;
    const serviceDetails: any[] = [];

    for (const svc of selectedServices) {
      const serviceDoc = await db.collection("services").doc(svc.id).get();
      if (serviceDoc.exists) {
        const serviceData = serviceDoc.data()!;
        totalPrice += serviceData.price || 0;
        totalDuration += serviceData.duration || 0;
        serviceDetails.push({
          id: svc.id,
          serviceId: svc.id,
          name: serviceData.name || "Service",
          price: serviceData.price || 0,
          duration: serviceData.duration || 0,
          time: svc.time || time,
          staffId: null,
          staffName: "Not Assigned Yet",
          approvalStatus: "needs_assignment",
        });
      }
    }

    // Get branch timezone and hours
    let branchTimezone = "Australia/Sydney";
    let branchHours: Record<string, { open?: string; close?: string; closed?: boolean }> | null = null;
    try {
      const branchDoc = await db.collection("branches").doc(branchId).get();
      if (branchDoc.exists) {
        const branchData = branchDoc.data();
        branchTimezone = branchData?.timezone || "Australia/Sydney";
        if (branchData?.hours && typeof branchData.hours === "object") {
          branchHours = branchData.hours;
        }
      }
    } catch {}

    // Validate booking is within branch opening hours
    if (branchHours) {
      // Get the day name for the booking date
      const bookingDate = new Date(date + "T12:00:00");
      const dayName = new Intl.DateTimeFormat("en-US", { weekday: "long" }).format(bookingDate);
      const dayHours = branchHours[dayName];
      if (!dayHours || dayHours.closed) {
        return NextResponse.json(
          { error: `The branch is closed on ${dayName}. Please select a different date.` },
          { status: 400 }
        );
      }
      const openTime = dayHours.open || "09:00";
      const closeTime = dayHours.close || "17:00";
      // Validate drop-off time is within opening hours
      if (time < openTime || time >= closeTime) {
        return NextResponse.json(
          { error: `Drop-off time must be within branch hours (${openTime} – ${closeTime}).` },
          { status: 400 }
        );
      }
      // Validate pick-up time is within opening hours (can be at closing time)
      if (pickupTime < openTime || pickupTime > closeTime) {
        return NextResponse.json(
          { error: `Pick-up time must be within branch hours (${openTime} – ${closeTime}).` },
          { status: 400 }
        );
      }
    }

    // Australian booking rule: drop-off by 11 AM, pick-up 2 PM – 5 PM
    const DROPOFF_CUTOFF = "11:00";
    const PICKUP_START = "14:00";
    const PICKUP_END = "17:00";

    if (time > DROPOFF_CUTOFF) {
      return NextResponse.json(
        { error: "Drop-off time must be by 11:00 AM." },
        { status: 400 }
      );
    }
    if (pickupTime < PICKUP_START || pickupTime > PICKUP_END) {
      return NextResponse.json(
        { error: "Pick-up time must be between 2:00 PM and 5:00 PM." },
        { status: 400 }
      );
    }

    const bookingCode = generateBookingCode();

    // Validate pick-up time is >= drop-off time + total service duration
    const [dropH, dropM] = time.split(":").map(Number);
    const [pickH, pickM] = pickupTime.split(":").map(Number);
    const dropOffMins = dropH * 60 + dropM;
    const pickupMins = pickH * 60 + pickM;
    const earliestPickupMins = dropOffMins + totalDuration;

    if (pickupMins < earliestPickupMins) {
      return NextResponse.json(
        { error: `Pick-up time must be at least ${totalDuration} minutes after drop-off time (earliest: ${Math.floor(earliestPickupMins / 60).toString().padStart(2, "0")}:${(earliestPickupMins % 60).toString().padStart(2, "0")})` },
        { status: 400 }
      );
    }

    // Capacity check: ensure not all eligible staff are booked at the requested time
    try {
      const dayOfWeek = getDayOfWeek(date);

      const [staffSnapshot, servicesSnapshot, bookingsSnapshot] = await Promise.all([
        db.collection("users").where("ownerUid", "==", ownerUid).get(),
        db.collection("services").where("ownerUid", "==", ownerUid).get(),
        db.collection("bookings").where("ownerUid", "==", ownerUid).where("date", "==", date).get(),
      ]);

      const allStaff = staffSnapshot.docs.map((d: any) => ({ id: d.id, ...d.data() }));
      const allServicesData = servicesSnapshot.docs.map((d: any) => ({ id: d.id, ...d.data() }));
      const activeBookings = bookingsSnapshot.docs
        .map((d: any) => ({ id: d.id, ...d.data() }))
        .filter((b: any) => b.branchId === branchId && shouldBlockSlots(b.status));

      for (const svc of serviceDetails) {
        const serviceData: any = allServicesData.find((s: any) => String(s.id) === String(svc.id));
        const eligible = allStaff.filter((st: any) => {
          const role = (st.role || "").toString().toLowerCase();
          if (role !== "staff" && role !== "branch_admin") return false;
          if (st.status && st.status !== "Active") return false;
          if (serviceData?.staffIds?.length > 0) {
            if (!serviceData.staffIds.some((id: string) => String(id) === st.id || String(id) === (st.uid || st.id))) return false;
          }
          return isStaffAssignedToBranch(st, branchId, dayOfWeek);
        });

        if (eligible.length === 0) continue;

        const svcDuration = svc.duration || totalDuration || 60;
        const newStart = timeToMinutes(svc.time || time);
        const newEnd = newStart + svcDuration;

        const bookedStaffIds = new Set<string>();
        let anyStaffOverlapping = 0;

        for (const booking of activeBookings) {
          if (booking.services && Array.isArray(booking.services) && booking.services.length > 0) {
            for (const existingSvc of booking.services) {
              if (!existingSvc.time) continue;
              const existingStaffId = existingSvc.staffId || booking.staffId || null;
              const existingStart = timeToMinutes(existingSvc.time);
              const existingEnd = existingStart + (existingSvc.duration || booking.duration || 60);
              if (!timeRangesOverlap(newStart, newEnd, existingStart, existingEnd)) continue;
              if (!isAnyStaffId(existingStaffId)) {
                if (eligible.some((s: any) => s.id === existingStaffId)) bookedStaffIds.add(existingStaffId!);
              } else {
                anyStaffOverlapping++;
              }
            }
          } else {
            if (!booking.time) continue;
            const existingStaffId = booking.staffId || null;
            const existingStart = timeToMinutes(booking.time);
            const existingEnd = existingStart + (booking.duration || 60);
            if (!timeRangesOverlap(newStart, newEnd, existingStart, existingEnd)) continue;
            if (!isAnyStaffId(existingStaffId)) {
              if (eligible.some((s: any) => s.id === existingStaffId)) bookedStaffIds.add(existingStaffId!);
            } else {
              anyStaffOverlapping++;
            }
          }
        }

        const freeStaff = eligible.length - bookedStaffIds.size - anyStaffOverlapping;
        if (freeStaff <= 0) {
          return NextResponse.json(
            { error: `The ${svc.time || time} time slot is fully booked for ${svc.name}. All ${eligible.length} available staff are occupied. Please choose a different time.` },
            { status: 409 }
          );
        }
      }
    } catch (capErr) {
      console.error("Capacity check error (non-blocking):", capErr);
    }

    // Build tasks array from service checklists
    let bookingTasks: any[] = [];
    try {
      let taskIndex = 0;
      for (const svc of serviceDetails) {
        const svcId = svc.id ? String(svc.id) : null;
        if (!svcId) continue;
        const svcDoc = await db.collection("services").doc(svcId).get();
        if (!svcDoc.exists) continue;
        const svcData = svcDoc.data();
        const checklist = svcData?.checklist;
        if (!Array.isArray(checklist) || checklist.length === 0) continue;
        const svcName = svcData?.name || svc.name || "";
        for (const item of checklist) {
          bookingTasks.push({
            id: `task_${taskIndex++}`,
            serviceId: svcId,
            serviceName: svcName,
            name: typeof item === "string" ? item : (item.name || ""),
            description: typeof item === "string" ? "" : (item.description || ""),
            done: false,
            imageUrl: "",
            staffNote: "",
            completedAt: null,
            completedByStaffUid: null,
            completedByStaffName: null,
          });
        }
      }
    } catch (taskErr) {
      console.error("Failed to build tasks from checklists:", taskErr);
    }

    // Create the booking
    const bookingPayload: any = {
      ownerUid,
      client: customerName,
      clientEmail: customerEmail || null,
      clientPhone: customerPhone || null,
      vehicleNumber: effectiveVehicleNumber || null,
      vehicleMake: vehicleDetails?.make || null,
      vehicleModel: vehicleDetails?.model || null,
      vehicleYear: vehicleDetails?.year || null,
      vehicleMileage: vehicleDetails?.mileage || null,
      vehicleBodyType: vehicleDetails?.bodyType || null,
      vehicleColour: vehicleDetails?.colour || null,
      vehicleVinChassis: vehicleDetails?.vinChassis || null,
      vehicleEngineNumber: vehicleDetails?.engineNumber || null,
      notes: notes || null,
      serviceId: serviceDetails.length === 1 ? serviceDetails[0].id : serviceDetails.map((s: any) => s.id).join(","),
      serviceName: serviceDetails.map((s: any) => s.name).join(", "),
      staffId: null,
      staffName: "Not Assigned Yet",
      branchId,
      branchName: branchName || null,
      branchTimezone,
      date,
      time,
      pickupTime,
      duration: totalDuration,
      status: "Pending",
      price: totalPrice,
      services: serviceDetails,
      bookingSource: "Online Booking Engine",
      bookingCode,
      customerId: body.customerId || null,
      tasks: bookingTasks.length > 0 ? bookingTasks : [],
      taskProgress: 0,
      finalSubmission: null,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };

    const ref = await db.collection("bookings").add(bookingPayload);

    // Create booking activity log
    try {
      await db.collection("bookingActivities").add({
        ownerUid,
        bookingId: ref.id,
        bookingCode,
        activityType: "booking_created",
        clientName: customerName,
        serviceName: serviceDetails.map((s: any) => s.name).join(", "),
        branchName: branchName || null,
        staffName: "Not Assigned Yet",
        price: totalPrice,
        date,
        time,
        pickupTime,
        previousStatus: null,
        newStatus: "Pending",
        createdAt: FieldValue.serverTimestamp(),
      });
    } catch (activityError) {
      console.error("Failed to create booking activity:", activityError);
    }

    // Create notification for workshop owner
    try {
      await db.collection("notifications").add({
        ownerUid,
        type: "online_booking",
        title: "New Online Booking",
        message: `${customerName} booked ${serviceDetails.map((s: any) => s.name).join(", ")} for ${date} — Drop-off: ${time}, Pick-up: ${pickupTime} via online booking.`,
        bookingId: ref.id,
        bookingCode,
        branchId,
        branchName: branchName || null,
        clientName: customerName,
        clientPhone: customerPhone || null,
        serviceName: serviceDetails.map((s: any) => s.name).join(", "),
        read: false,
        createdAt: FieldValue.serverTimestamp(),
      });
    } catch (notifError) {
      console.error("Failed to create notification:", notifError);
    }

    // Create notifications for branch admins (so they receive branch booking alerts on mobile)
    try {
      const branchAdminUids = await getBranchAdminUids(db, branchId, ownerUid);
      const serviceList = serviceDetails.map((s: any) => s.name).join(", ");
      for (const branchAdminUid of branchAdminUids) {
        if (branchAdminUid === ownerUid) continue;
        await createBranchAdminNotification({
          bookingId: ref.id,
          bookingCode,
          branchAdminUid,
          ownerUid,
          clientName: customerName,
          serviceName: serviceList,
          services: serviceDetails.map((s: any) => ({
            name: s.name,
            staffName: "Not Assigned Yet",
            staffId: undefined,
          })),
          branchName: branchName || null,
          branchId,
          bookingDate: date,
          bookingTime: `Drop-off: ${time}, Pick-up: ${pickupTime}`,
          status: "Pending",
          type: "booking_engine_new_booking",
        });
      }
      if (branchAdminUids.length > 0) {
        console.log(`[BOOK-NOW] Notified ${branchAdminUids.length} branch admin(s) for online booking ${bookingCode}`);
      }
    } catch (branchAdminNotifError) {
      console.error("Failed to create branch admin notifications:", branchAdminNotifError);
    }

    // Send booking confirmation email to customer
    try {
      await sendBookingRequestReceivedEmail(
        ref.id,
        bookingCode,
        customerEmail,
        customerName,
        ownerUid,
        {
          branchName: branchName || null,
          bookingDate: date,
          bookingTime: `Drop-off: ${time} | Pick-up: ${pickupTime}`,
          duration: totalDuration,
          price: totalPrice,
          serviceName: serviceDetails.map((s: any) => s.name).join(", "),
          services: serviceDetails.map((s: any) => ({
            name: s.name,
            staffName: s.staffName || null,
            time: s.time || time,
            duration: s.duration,
          })),
          staffName: "Not Assigned Yet",
        }
      );
    } catch (emailError) {
      console.error("Failed to send booking confirmation email:", emailError);
      // Don't fail the booking if email fails
    }

    return NextResponse.json({
      success: true,
      bookingId: ref.id,
      bookingCode,
      totalPrice,
      totalDuration,
    });
  } catch (error: any) {
    console.error("Error creating booking:", error);
    return NextResponse.json({ error: "Failed to create booking" }, { status: 500 });
  }
}
