import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";
import {
  verifyCallCenterOrTenantAdminAuth,
  canAccessWorkshopForAuth,
  CORS_HEADERS,
} from "@/lib/callCenterAuth";
import {
  normalizeBookingStatus,
  getServiceCompletionProgress,
  getTaskProgress,
} from "@/lib/bookingTypes";

export const runtime = "nodejs";

export async function OPTIONS() {
  return NextResponse.json({}, { headers: CORS_HEADERS });
}

/**
 * GET /api/call-center/bookings/[id]
 *
 * Get full booking details including:
 * - All service details with completion status
 * - Task progress (checklist items)
 * - Additional issues / extra work with customer responses
 * - Activity log
 *
 * This is the main "job card" view for the agent.
 */
export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const gate = await verifyCallCenterOrTenantAdminAuth(req);
  if (!gate.success) {
    return NextResponse.json(
      { error: gate.error },
      { status: gate.status || 401, headers: CORS_HEADERS }
    );
  }

  const { id } = await context.params;

  try {
    const db = adminDb();

    const bookingDoc = await db.doc(`bookings/${id}`).get();
    if (!bookingDoc.exists) {
      return NextResponse.json(
        { error: "Booking not found" },
        { status: 404, headers: CORS_HEADERS }
      );
    }

    const d = bookingDoc.data()!;

    if (!canAccessWorkshopForAuth(gate.auth, d.ownerUid)) {
      return NextResponse.json(
        { error: "Access denied" },
        { status: 403, headers: CORS_HEADERS }
      );
    }

    const status = normalizeBookingStatus(d.status);
    const services = Array.isArray(d.services) ? d.services : [];
    const tasks = Array.isArray(d.tasks) ? d.tasks : [];
    const additionalIssues = Array.isArray(d.additionalIssues)
      ? d.additionalIssues
      : [];

    const serviceProgress = getServiceCompletionProgress(services);
    const taskProgress = getTaskProgress(tasks);

    // Fetch recent activity
    const activitiesSnap = await db
      .collection("bookingActivities")
      .where("bookingId", "==", id)
      .orderBy("timestamp", "desc")
      .limit(20)
      .get();

    const activities = activitiesSnap.docs.map((doc) => {
      const a = doc.data();
      return {
        id: doc.id,
        type: a.type || "",
        message: a.message || "",
        performedByName: a.performedByName || "",
        performedByRole: a.performedByRole || "",
        timestamp: a.timestamp || null,
      };
    });

    return NextResponse.json(
      {
        booking: {
          id,
          bookingCode: d.bookingCode || "",
          status,
          date: d.date || "",
          time: d.time || "",
          pickupTime: d.pickupTime || null,
          duration: d.duration || 0,
          totalPrice: d.price || d.totalPrice || 0,
          ownerUid: d.ownerUid,
          branchId: d.branchId || "",
          branchName: d.branchName || "",
          client: d.client || d.clientName || "",
          clientEmail: d.clientEmail || "",
          clientPhone: d.clientPhone || "",
          customerId: d.customerId || null,
          vehicleNumber: d.vehicleNumber || "",
          vehicleBodyType: d.vehicleBodyType || "",
          vehicleColour: d.vehicleColour || "",
          vehicleMileage: d.vehicleMileage || d.mileage || "",
          notes: d.notes || "",
          source: d.source || "",
          createdAt: d.createdAt || null,
          updatedAt: d.updatedAt || null,
        },
        services: services.map((s: any) => ({
          id: s.id || "",
          name: s.name || "",
          price: s.price || 0,
          duration: s.duration || 0,
          staffId: s.staffId || null,
          staffName: s.staffName || null,
          approvalStatus: s.approvalStatus || "pending",
          completionStatus: s.completionStatus || "pending",
          completedAt: s.completedAt || null,
        })),
        tasks: tasks.map((t: any) => ({
          id: t.id || "",
          serviceId: t.serviceId || "",
          serviceName: t.serviceName || "",
          name: t.name || "",
          description: t.description || "",
          done: !!t.done,
          imageUrl: t.imageUrl || "",
          staffNote: t.staffNote || "",
          completedAt: t.completedAt || null,
        })),
        additionalIssues: additionalIssues.map((i: any) => ({
          id: i.id || "",
          issueTitle: i.issueTitle || "",
          description: i.description || "",
          recommendedRepair: i.recommendedRepair || "",
          partsRequired: i.partsRequired || "",
          labourTimeHours: i.labourTimeHours || 0,
          imageUrl: i.imageUrl || null,
          price: i.price ?? null,
          status: i.status || "pending",
          customerResponse: i.customerResponse || null,
          customerRespondedAt: i.customerRespondedAt || null,
          reportedAt: i.reportedAt || null,
          reportedByStaffName: i.reportedByStaffName || "",
          completionStatus: i.completionStatus || null,
        })),
        progress: {
          services: serviceProgress,
          tasks: taskProgress,
        },
        activities,
      },
      { headers: CORS_HEADERS }
    );
  } catch (error: any) {
    console.error("[call-center/bookings/[id]] Error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
