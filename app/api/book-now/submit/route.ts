import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";
import { FieldValue } from "firebase-admin/firestore";
import { generateBookingCode } from "@/lib/bookings";
import { sendBookingRequestReceivedEmail } from "@/lib/emailService";
import { getBranchAdminUids, createBranchAdminNotification } from "@/lib/notifications";
import {
  isVehicleType,
  normalizeVehicleTypePricing,
  resolveServicePricingForVehicleType,
  VEHICLE_TYPE_LABELS,
  type VehicleType,
} from "@/lib/services";

export const runtime = "nodejs";

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
      vehicleType: rawVehicleType,
      notes,
      date,
      time,
      pickupTime,
      customerId,
    } = body;

    // Canonical vehicle type (one of the 5 sizes) used to resolve per-vehicle
    // price/duration from each service's `vehicleTypePricing` map. Optional
    // on the wire — legacy flat-price services don't need it, but services
    // that only have vehicle-type pricing will error out below if it's
    // missing or doesn't match one of their configured types.
    const vehicleType: VehicleType | null = isVehicleType(rawVehicleType)
      ? rawVehicleType
      : null;

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

    // Customer email + phone must be valid — consistent with /api/bookings and
    // /api/call-center/bookings so every booking creation path enforces it.
    const normalizedCustomerEmail = String(customerEmail).trim();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(normalizedCustomerEmail)) {
      return NextResponse.json(
        { error: "Please enter a valid email address.", field: "customerEmail" },
        { status: 400 }
      );
    }

    const normalizedCustomerPhone = String(customerPhone).trim();
    const phoneDigits = normalizedCustomerPhone.replace(/\D/g, "");
    if (phoneDigits.length < 6 || !/^[+\d][\d\s\-()]+$/.test(normalizedCustomerPhone)) {
      return NextResponse.json(
        { error: "Please enter a valid phone number.", field: "customerPhone" },
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

    // Calculate total price and duration from selected services. For each
    // service we resolve pricing via `resolveServicePricingForVehicleType`:
    //   - Services with `vehicleTypePricing` → use the entry matching the
    //     customer's vehicle type (errors out if the service doesn't offer
    //     that type; the client prevents this by filtering the list, but we
    //     guard server-side too).
    //   - Services with only legacy flat fields → use those.
    let totalPrice = 0;
    let totalDuration = 0;
    const serviceDetails: any[] = [];

    for (const svc of selectedServices) {
      const serviceDoc = await db.collection("services").doc(svc.id).get();
      if (!serviceDoc.exists) continue;
      const serviceData = serviceDoc.data()!;
      const vt = normalizeVehicleTypePricing(serviceData.vehicleTypePricing);

      // If the service uses vehicle-type pricing, the customer must have
      // picked a vehicle type that the service supports — otherwise we'd
      // silently bill $0 / 0 min.
      if (vt.vehicleTypes.length > 0) {
        if (!vehicleType) {
          return NextResponse.json(
            {
              error:
                "Please select your vehicle type before booking. Pricing depends on the vehicle size.",
              field: "vehicleType",
            },
            { status: 400 },
          );
        }
        if (!vt.vehicleTypes.includes(vehicleType)) {
          const name = serviceData.name || "this service";
          return NextResponse.json(
            {
              error: `“${name}” isn't offered for ${VEHICLE_TYPE_LABELS[vehicleType]}. Please remove it or pick a different vehicle type.`,
              field: "vehicleType",
            },
            { status: 400 },
          );
        }
      }

      const resolved = resolveServicePricingForVehicleType(
        {
          price: serviceData.price,
          duration: serviceData.duration,
          vehicleTypePricing: vt.vehicleTypePricing,
        },
        vehicleType,
      );

      totalPrice += resolved.price;
      totalDuration += resolved.duration;

      // Snapshot the owner's current area ordering so the booking preview
      // keeps the same area-wise grouping even if the owner later reorders.
      const rawAreaOrder = Array.isArray(serviceData.areaOrder)
        ? serviceData.areaOrder.filter(
            (v: unknown) =>
              v === "interior" ||
              v === "engine_bay" ||
              v === "underbody" ||
              v === "exterior"
          )
        : [];

      serviceDetails.push({
        id: svc.id,
        serviceId: svc.id,
        name: serviceData.name || "Service",
        price: resolved.price,
        duration: resolved.duration,
        // Record which vehicle-type tier was picked so audit/refund flows
        // and invoices can show exactly why this service cost what it did.
        vehicleType: resolved.matchedVehicleType || null,
        time: svc.time || time,
        staffId: null,
        staffName: "Not Assigned Yet",
        approvalStatus: "needs_assignment",
        areaOrder: rawAreaOrder,
      });
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

    // NOTE: Staff-wise capacity checks have been intentionally removed.
    // The booking engine no longer caps bookings by the number of eligible
    // staff on shift — the workshop decides how many bookings to accept and
    // handles staff assignment manually. The only remaining quota is the
    // branch's optional `bookingLimitPerDay` (enforced in the availability
    // endpoint by blocking all slots for the day once it is reached).

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
          const rawSection =
            typeof item === "string" ? undefined : (item as any)?.section;
          const section =
            rawSection === "interior" ||
            rawSection === "engine_bay" ||
            rawSection === "underbody" ||
            rawSection === "exterior"
              ? rawSection
              : "interior";
          bookingTasks.push({
            id: `task_${taskIndex++}`,
            serviceId: svcId,
            serviceName: svcName,
            name: typeof item === "string" ? item : (item.name || ""),
            description: typeof item === "string" ? "" : (item.description || ""),
            section,
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
      // Canonical "size class" the customer picked for pricing. Distinct
      // from the free-text `vehicleBodyType` because this one always maps
      // to one of our 5 `VehicleType` enum values and is what drove the
      // per-service pricing resolution above.
      vehicleType: vehicleType || null,
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
          customerPhone,
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
