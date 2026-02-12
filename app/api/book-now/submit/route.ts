import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";
import { FieldValue } from "firebase-admin/firestore";
import { generateBookingCode } from "@/lib/bookings";

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
    } = body;

    // Validate required fields
    if (!slug || !branchId || !selectedServices?.length || !customerName || !customerPhone || !date || !time) {
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
        .where("role", "==", "salon_owner")
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
          staffName: "Any Available",
          approvalStatus: "needs_assignment",
        });
      }
    }

    // Get branch timezone
    let branchTimezone = "Australia/Sydney";
    try {
      const branchDoc = await db.collection("branches").doc(branchId).get();
      if (branchDoc.exists) {
        branchTimezone = branchDoc.data()?.timezone || "Australia/Sydney";
      }
    } catch {}

    const bookingCode = generateBookingCode();

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
      staffName: "Any Available",
      branchId,
      branchName: branchName || null,
      branchTimezone,
      date,
      time,
      duration: totalDuration,
      status: "Pending",
      price: totalPrice,
      services: serviceDetails,
      bookingSource: "Online Booking Engine",
      bookingCode,
      customerId: body.customerId || null, // booking_customers doc ID (scoped to this workshop)
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
        staffName: "Any Available",
        price: totalPrice,
        date,
        time,
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
        message: `${customerName} booked ${serviceDetails.map((s: any) => s.name).join(", ")} for ${date} at ${time} via online booking.`,
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
