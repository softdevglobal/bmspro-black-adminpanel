import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";
import { FieldValue } from "firebase-admin/firestore";
import { generateBookingCode } from "@/lib/bookings";
import { sendBookingRequestReceivedEmail } from "@/lib/emailService";

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

    // Validate required fields
    if (!slug || !branchId || !selectedServices?.length || !customerName || !customerPhone || !date || !time || !pickupTime) {
      return NextResponse.json(
        { error: "Missing required fields" },
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
