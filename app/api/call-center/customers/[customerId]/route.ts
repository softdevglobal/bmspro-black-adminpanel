import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";
import {
  verifyCallCenterAuth,
  canAccessWorkshop,
  getTenantId,
  CORS_HEADERS,
} from "@/lib/callCenterAuth";
import { normalizeBookingStatus, getServiceCompletionProgress } from "@/lib/bookingTypes";

export const runtime = "nodejs";

export async function OPTIONS() {
  return NextResponse.json({}, { headers: CORS_HEADERS });
}

/**
 * GET /api/call-center/customers/[customerId]?ownerUid=X
 *
 * Get full customer profile including:
 * - Customer details
 * - Registered vehicles
 * - Recent booking history with status & progress
 *
 * This is the "screen pop" data for when a call comes in.
 */
export async function GET(
  req: NextRequest,
  context: { params: Promise<{ customerId: string }> }
) {
  const auth = await verifyCallCenterAuth(req);
  if (!auth.success || !auth.user) {
    return NextResponse.json(
      { error: auth.error },
      { status: auth.status || 401, headers: CORS_HEADERS }
    );
  }

  const { customerId } = await context.params;
  const ownerUid = getTenantId(req);

  if (!ownerUid) {
    return NextResponse.json(
      { error: "Missing ownerUid or X-Tenant-Id header" },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  if (!canAccessWorkshop(auth.user, ownerUid)) {
    return NextResponse.json(
      { error: "Access denied to this workshop" },
      { status: 403, headers: CORS_HEADERS }
    );
  }

  try {
    const db = adminDb();

    // Get customer doc
    const custDoc = await db.doc(`customers/${customerId}`).get();
    if (!custDoc.exists) {
      return NextResponse.json(
        { error: "Customer not found" },
        { status: 404, headers: CORS_HEADERS }
      );
    }

    const custData = custDoc.data()!;

    if (custData.ownerUid !== ownerUid) {
      return NextResponse.json(
        { error: "Customer does not belong to this workshop" },
        { status: 403, headers: CORS_HEADERS }
      );
    }

    // Get vehicles
    const vehiclesSnap = await db
      .collection(`customers/${customerId}/vehicles`)
      .get();

    const vehicles = vehiclesSnap.docs.map((doc) => {
      const d = doc.data();
      return {
        id: doc.id,
        rego: d.rego || d.vehicleNumber || "",
        make: d.make || "",
        model: d.model || "",
        year: d.year || "",
        colour: d.colour || "",
        vin: d.vin || "",
        engineNumber: d.engineNumber || "",
        bodyType: d.bodyType || "",
      };
    });

    // Get booking history for this customer
    const customerEmail = (custData.email || "").toLowerCase();
    const customerPhone = (custData.phone || custData.clientPhone || "").replace(/[\s\-\(\)]/g, "");
    const customerName = (custData.name || custData.client || "").toLowerCase();

    const bookingsSnap = await db
      .collection("bookings")
      .where("ownerUid", "==", ownerUid)
      .orderBy("createdAt", "desc")
      .limit(50)
      .get();

    const bookings: any[] = [];

    for (const doc of bookingsSnap.docs) {
      const d = doc.data();

      // Match by customerId field, email, phone, or name
      const matchById = d.customerId === customerId;
      const matchByEmail =
        customerEmail &&
        (d.clientEmail || "").toLowerCase() === customerEmail;
      const matchByPhone =
        customerPhone &&
        (d.clientPhone || "").replace(/[\s\-\(\)]/g, "") === customerPhone;
      const matchByName =
        customerName &&
        (d.client || d.clientName || "").toLowerCase() === customerName;

      if (!matchById && !matchByEmail && !matchByPhone && !matchByName) {
        continue;
      }

      const status = normalizeBookingStatus(d.status);
      const services = Array.isArray(d.services) ? d.services : [];
      const progress = getServiceCompletionProgress(services);
      const additionalIssues = Array.isArray(d.additionalIssues)
        ? d.additionalIssues
        : [];
      const pendingIssues = additionalIssues.filter(
        (i: any) => i.status === "approved" && !i.customerResponse
      );

      bookings.push({
        id: doc.id,
        bookingCode: d.bookingCode || "",
        status,
        date: d.date || "",
        time: d.time || "",
        branchId: d.branchId || "",
        branchName: d.branchName || "",
        services: services.map((s: any) => ({
          name: s.name || "",
          price: s.price || 0,
          completionStatus: s.completionStatus || "pending",
        })),
        totalPrice: d.price || d.totalPrice || 0,
        vehicleNumber: d.vehicleNumber || "",
        progress,
        additionalIssueCount: additionalIssues.length,
        pendingApprovalCount: pendingIssues.length,
        notes: d.notes || "",
        createdAt: d.createdAt || null,
      });
    }

    return NextResponse.json(
      {
        customer: {
          id: customerId,
          name: custData.name || custData.client || "",
          email: custData.email || "",
          phone: custData.phone || custData.clientPhone || "",
          vehicleNumber: custData.vehicleNumber || "",
          address: custData.address || "",
          notes: custData.notes || "",
          createdAt: custData.createdAt || null,
        },
        vehicles,
        bookings,
        summary: {
          totalBookings: bookings.length,
          activeBookings: bookings.filter(
            (b) => b.status !== "Completed" && b.status !== "Canceled"
          ).length,
          completedBookings: bookings.filter(
            (b) => b.status === "Completed"
          ).length,
        },
      },
      { headers: CORS_HEADERS }
    );
  } catch (error: any) {
    console.error("[call-center/customers/[customerId]] Error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
