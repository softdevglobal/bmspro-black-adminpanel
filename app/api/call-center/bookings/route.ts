import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";
import {
  verifyCallCenterOrTenantAdminAuth,
  canAccessWorkshopForAuth,
  getTenantId,
  CORS_HEADERS,
} from "@/lib/callCenterAuth";
import { normalizeBookingStatus, getServiceCompletionProgress } from "@/lib/bookingTypes";

export const runtime = "nodejs";

export async function OPTIONS() {
  return NextResponse.json({}, { headers: CORS_HEADERS });
}

/**
 * GET /api/call-center/bookings?ownerUid=X&status=Confirmed&date=2026-03-31&customerId=X&limit=25
 *
 * List bookings for a workshop with optional filters.
 * Supports filtering by status, date, customer, and branch.
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
  if (!ownerUid) {
    return NextResponse.json(
      { error: "Missing ownerUid" },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  if (!canAccessWorkshopForAuth(gate.auth, ownerUid)) {
    return NextResponse.json(
      { error: "Access denied" },
      { status: 403, headers: CORS_HEADERS }
    );
  }

  const filterStatus = req.nextUrl.searchParams.get("status");
  const filterDate = req.nextUrl.searchParams.get("date");
  const filterCustomerId = req.nextUrl.searchParams.get("customerId");
  const filterBranchId = req.nextUrl.searchParams.get("branchId");
  const limit = Math.min(
    parseInt(req.nextUrl.searchParams.get("limit") || "25", 10),
    100
  );

  try {
    const db = adminDb();

    let query: FirebaseFirestore.Query = db
      .collection("bookings")
      .where("ownerUid", "==", ownerUid);

    if (filterDate) {
      query = query.where("date", "==", filterDate);
    }

    if (filterBranchId) {
      query = query.where("branchId", "==", filterBranchId);
    }

    query = query.orderBy("createdAt", "desc").limit(limit);

    const snap = await query.get();

    const bookings: any[] = [];

    for (const doc of snap.docs) {
      const d = doc.data();
      const status = normalizeBookingStatus(d.status);

      if (filterStatus && status !== filterStatus) continue;

      if (filterCustomerId && d.customerId !== filterCustomerId) continue;

      const services = Array.isArray(d.services) ? d.services : [];
      const progress = getServiceCompletionProgress(services);
      const additionalIssues = Array.isArray(d.additionalIssues)
        ? d.additionalIssues
        : [];

      bookings.push({
        id: doc.id,
        bookingCode: d.bookingCode || "",
        status,
        date: d.date || "",
        time: d.time || "",
        pickupTime: d.pickupTime || null,
        clientName: d.client || d.clientName || "",
        clientEmail: d.clientEmail || "",
        clientPhone: d.clientPhone || "",
        vehicleNumber: d.vehicleNumber || "",
        branchId: d.branchId || "",
        branchName: d.branchName || "",
        services: services.map((s: any) => ({
          name: s.name || "",
          price: s.price || 0,
          staffName: s.staffName || null,
          completionStatus: s.completionStatus || "pending",
        })),
        totalPrice: d.price || d.totalPrice || 0,
        progress,
        additionalIssueCount: additionalIssues.length,
        pendingApprovalCount: additionalIssues.filter(
          (i: any) => i.status === "approved" && !i.customerResponse
        ).length,
        notes: d.notes || "",
        createdAt: d.createdAt || null,
      });
    }

    return NextResponse.json(
      { bookings, total: bookings.length },
      { headers: CORS_HEADERS }
    );
  } catch (error: any) {
    console.error("[call-center/bookings GET] Error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}

/**
 * POST /api/call-center/bookings
 *
 * Create a new booking on behalf of a customer.
 *
 * Body: {
 *   ownerUid: string,
 *   branchId: string,
 *   branchName?: string,
 *   date: string,         // YYYY-MM-DD
 *   time: string,         // HH:mm
 *   pickupTime?: string,  // HH:mm
 *   services: [{ serviceId, serviceName?, price?, duration?, staffId? }],
 *   client: string,
 *   clientEmail?: string,
 *   clientPhone?: string,
 *   customerId?: string,
 *   vehicleNumber?: string,
 *   vehicleDetails?: { bodyType, colour, vin, engineNumber, mileage },
 *   notes?: string,
 * }
 */
export async function POST(req: NextRequest) {
  const gate = await verifyCallCenterOrTenantAdminAuth(req);
  if (!gate.success) {
    return NextResponse.json(
      { error: gate.error },
      { status: gate.status || 401, headers: CORS_HEADERS }
    );
  }

  try {
    const actor =
      gate.auth.kind === "agent"
        ? { uid: gate.auth.user.uid, name: gate.auth.user.name }
        : { uid: gate.auth.uid, name: gate.auth.name };
    const createdByRole =
      gate.auth.kind === "agent" ? "call_center_agent" : gate.auth.role;

    const body = await req.json();
    const {
      ownerUid,
      branchId,
      branchName,
      date,
      time,
      pickupTime,
      services: requestedServices,
      client,
      clientEmail,
      clientPhone,
      customerId,
      vehicleNumber,
      vehicleDetails,
      notes,
    } = body;

    // Validation
    if (!ownerUid) {
      return NextResponse.json(
        { error: "Missing ownerUid" },
        { status: 400, headers: CORS_HEADERS }
      );
    }

    if (!canAccessWorkshopForAuth(gate.auth, ownerUid)) {
      return NextResponse.json(
        { error: "Access denied" },
        { status: 403, headers: CORS_HEADERS }
      );
    }

    if (!branchId || !date || !time || !client) {
      return NextResponse.json(
        { error: "Missing required fields: branchId, date, time, client" },
        { status: 400, headers: CORS_HEADERS }
      );
    }

    if (
      !requestedServices ||
      !Array.isArray(requestedServices) ||
      requestedServices.length === 0
    ) {
      return NextResponse.json(
        { error: "At least one service is required" },
        { status: 400, headers: CORS_HEADERS }
      );
    }

    const db = adminDb();

    // Verify workshop exists
    const workshopDoc = await db.doc(`users/${ownerUid}`).get();
    if (!workshopDoc.exists) {
      return NextResponse.json(
        { error: "Workshop not found" },
        { status: 404, headers: CORS_HEADERS }
      );
    }

    // Verify branch
    const branchDoc = await db.doc(`branches/${branchId}`).get();
    if (!branchDoc.exists || branchDoc.data()?.ownerUid !== ownerUid) {
      return NextResponse.json(
        { error: "Branch not found or does not belong to this workshop" },
        { status: 404, headers: CORS_HEADERS }
      );
    }
    const branchData = branchDoc.data()!;

    // Resolve service details from catalog
    const resolvedServices: any[] = [];
    let totalPrice = 0;
    let totalDuration = 0;

    for (const rs of requestedServices) {
      if (rs.serviceId) {
        const svcDoc = await db.doc(`services/${rs.serviceId}`).get();
        if (svcDoc.exists && svcDoc.data()?.ownerUid === ownerUid) {
          const svcData = svcDoc.data()!;
          const price = rs.price ?? svcData.price ?? 0;
          const duration = rs.duration ?? svcData.duration ?? 0;
          resolvedServices.push({
            id: rs.serviceId,
            name: rs.serviceName || svcData.name || "",
            price,
            duration,
            staffId: rs.staffId || null,
            staffName: rs.staffName || null,
            approvalStatus: rs.staffId ? "pending" : "needs_assignment",
            completionStatus: "pending",
          });
          totalPrice += price;
          totalDuration += duration;
        }
      } else {
        const price = rs.price || 0;
        const duration = rs.duration || 0;
        resolvedServices.push({
          id: `custom_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          name: rs.serviceName || "Custom Service",
          price,
          duration,
          staffId: rs.staffId || null,
          staffName: rs.staffName || null,
          approvalStatus: "needs_assignment",
          completionStatus: "pending",
        });
        totalPrice += price;
        totalDuration += duration;
      }
    }

    // Build tasks from service checklists
    const tasks: any[] = [];
    let taskIndex = 0;
    for (const svc of resolvedServices) {
      if (svc.id && !svc.id.startsWith("custom_")) {
        const svcDoc = await db.doc(`services/${svc.id}`).get();
        const checklist = svcDoc.data()?.checklist;
        if (Array.isArray(checklist)) {
          for (const item of checklist) {
            tasks.push({
              id: `task_${taskIndex++}`,
              serviceId: svc.id,
              serviceName: svc.name,
              name: item.name || item.title || "",
              description: item.description || "",
              done: false,
              imageUrl: "",
              staffNote: "",
            });
          }
        }
      }
    }

    // Generate booking code
    const bookingCode = `CC-${Date.now().toString(36).toUpperCase()}`;

    const allNeedAssignment = resolvedServices.every(
      (s) => s.approvalStatus === "needs_assignment"
    );

    const now = new Date();

    const bookingData: Record<string, any> = {
      ownerUid,
      branchId,
      branchName: branchName || branchData.name || "",
      branchTimezone: branchData.timezone || "Australia/Sydney",
      date,
      time,
      pickupTime: pickupTime || null,
      duration: totalDuration,
      price: totalPrice,
      client: client.trim(),
      clientEmail: clientEmail?.trim() || "",
      clientPhone: clientPhone?.trim() || "",
      customerId: customerId || null,
      vehicleNumber: vehicleNumber?.trim() || "",
      vehicleBodyType: vehicleDetails?.bodyType || "",
      vehicleColour: vehicleDetails?.colour || "",
      vehicleVinChassis: vehicleDetails?.vin || "",
      vehicleEngineNumber: vehicleDetails?.engineNumber || "",
      vehicleMileage: vehicleDetails?.mileage || "",
      services: resolvedServices,
      tasks,
      additionalIssues: [],
      notes: notes?.trim() || "",
      bookingCode,
      status: allNeedAssignment ? "Pending" : "AwaitingStaffApproval",
      createdAt: now,
      updatedAt: now,
      createdBy: actor.uid,
      createdByRole,
      source: "call_center",
    };

    const bookingRef = await db.collection("bookings").add(bookingData);

    // Log activity
    await db.collection("bookingActivities").add({
      bookingId: bookingRef.id,
      type: "created",
      message: `Booking created by ${gate.auth.kind === "agent" ? "call center agent" : "BMS staff"} ${actor.name}`,
      performedBy: actor.uid,
      performedByName: actor.name,
      performedByRole: createdByRole,
      timestamp: now,
    });

    return NextResponse.json(
      {
        success: true,
        bookingId: bookingRef.id,
        bookingCode,
        status: bookingData.status,
        totalPrice,
        totalDuration,
      },
      { status: 201, headers: CORS_HEADERS }
    );
  } catch (error: any) {
    console.error("[call-center/bookings POST] Error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
