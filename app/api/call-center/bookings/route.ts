import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";
import {
  verifyCallCenterOrTenantAdminAuth,
  canAccessWorkshopForAuth,
  getTenantId,
  CORS_HEADERS,
} from "@/lib/callCenterAuth";
import { normalizeBookingStatus, getServiceCompletionProgress } from "@/lib/bookingTypes";
import { serializeAdditionalIssuesForCallCenterApi } from "@/lib/callCenterAdditionalIssues";

export const runtime = "nodejs";

export async function OPTIONS() {
  return NextResponse.json({}, { headers: CORS_HEADERS });
}

/** Internal Firestore page size only; response is not capped when listing all. */
const BOOKINGS_LIST_BATCH_SIZE = 500;
/** Optional cap when client passes limit=N (avoids accidental huge values). */
const BOOKINGS_LIST_MAX_EXPLICIT_LIMIT = 50_000;

/**
 * GET /api/call-center/bookings?ownerUid=X&status=Confirmed&date=2026-03-31&customerId=X&limit=100
 *
 * List bookings for a workshop with optional filters.
 * By default returns every matching Firestore row (loaded in batches server-side).
 * Pass limit=N to return at most N rows (max BOOKINGS_LIST_MAX_EXPLICIT_LIMIT).
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
  const limitParam = req.nextUrl.searchParams.get("limit");
  const allParam = req.nextUrl.searchParams.get("all");
  const forceAll =
    allParam === "true" ||
    allParam === "1" ||
    (limitParam && limitParam.toLowerCase() === "all");

  let explicitLimit: number | null = null;
  if (limitParam != null && limitParam.toLowerCase() !== "all") {
    const raw = parseInt(limitParam, 10);
    if (Number.isFinite(raw) && raw > 0) {
      explicitLimit = Math.min(raw, BOOKINGS_LIST_MAX_EXPLICIT_LIMIT);
    }
  }

  const fetchAll = forceAll || explicitLimit === null;

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

    query = query.orderBy("createdAt", "desc");

    let listDocs: FirebaseFirestore.QueryDocumentSnapshot[];
    if (fetchAll) {
      listDocs = [];
      let last: FirebaseFirestore.QueryDocumentSnapshot | undefined;
      while (true) {
        let paged = query.limit(BOOKINGS_LIST_BATCH_SIZE);
        if (last) {
          paged = paged.startAfter(last);
        }
        const snap = await paged.get();
        if (snap.empty) break;
        listDocs.push(...snap.docs);
        last = snap.docs[snap.docs.length - 1];
        if (snap.docs.length < BOOKINGS_LIST_BATCH_SIZE) break;
      }
    } else {
      const snap = await query.limit(explicitLimit!).get();
      listDocs = snap.docs;
    }

    const bookings: any[] = [];

    for (const doc of listDocs) {
      const d = doc.data();
      const status = normalizeBookingStatus(d.status);

      if (filterStatus && status !== filterStatus) continue;

      if (filterCustomerId && d.customerId !== filterCustomerId) continue;

      const services = Array.isArray(d.services) ? d.services : [];
      const progress = getServiceCompletionProgress(services);
      const additionalIssuesRaw = Array.isArray(d.additionalIssues)
        ? d.additionalIssues
        : [];
      const additionalIssues = serializeAdditionalIssuesForCallCenterApi(additionalIssuesRaw);

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
        additionalIssues,
        additionalIssueCount: additionalIssues.length,
        pendingApprovalCount: additionalIssues.filter(
          (i) => i.status === "approved" && !i.customerResponse
        ).length,
        notes: d.notes || "",
        createdAt: d.createdAt || null,
      });
    }

    return NextResponse.json(
      { bookings, total: bookings.length },
      { headers: CORS_HEADERS }
    );
  } catch (error: unknown) {
    console.error("[call-center/bookings GET] Error:", error);
    const err = error as { code?: number | string; message?: string };
    const message = typeof err.message === "string" ? err.message : String(error);
    const indexUrl = message.match(
      /https:\/\/console\.firebase\.google\.com[^\s)]+/
    );
    const failedPrecondition =
      err.code === 9 ||
      err.code === "failed-precondition" ||
      /requires an index|FAILED_PRECONDITION/i.test(message);
    if (failedPrecondition) {
      return NextResponse.json(
        {
          error:
            "Firestore composite index missing for bookings list. Deploy indexes (see firestore.indexes.json in repo) or open the link from your server logs.",
          ...(indexUrl?.[0] ? { indexUrl: indexUrl[0] } : {}),
        },
        { status: 503, headers: CORS_HEADERS }
      );
    }
    if (err.code === 3 || err.code === "invalid-argument") {
      return NextResponse.json(
        { error: "Invalid query", details: message },
        { status: 400, headers: CORS_HEADERS }
      );
    }
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}

function str(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" && !Number.isNaN(v)) return String(v);
  return "";
}

/** Same vehicle shape as book-now (make, model, year, rego, mileage, body, colour, VIN, engine, notes). */
function vehicleFieldsFromBody(body: Record<string, unknown>): {
  vehicleNumber: string;
  vehicleMake: string;
  vehicleModel: string;
  vehicleYear: string;
  vehicleMileage: string;
  vehicleBodyType: string;
  vehicleColour: string;
  vehicleVinChassis: string;
  vehicleEngineNumber: string;
  vehicleNotes: string;
} {
  const vd =
    body.vehicleDetails && typeof body.vehicleDetails === "object" && body.vehicleDetails !== null
      ? (body.vehicleDetails as Record<string, unknown>)
      : {};

  const pick = (key: string, alt?: string) =>
    str(vd[key]) || (alt ? str(vd[alt]) : "") || str(body[key]) || (alt ? str(body[alt]) : "");

  const rego =
    pick("registrationNumber") ||
    pick("rego") ||
    str(body.vehicleNumber);

  return {
    vehicleNumber: rego,
    vehicleMake: pick("make"),
    vehicleModel: pick("model"),
    vehicleYear: pick("year"),
    vehicleMileage: pick("mileage"),
    vehicleBodyType: pick("bodyType"),
    vehicleColour: pick("colour", "color"),
    vehicleVinChassis: pick("vinChassis") || pick("vin"),
    vehicleEngineNumber: pick("engineNumber"),
    vehicleNotes: pick("notes"),
  };
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
 *   vehicleNumber?: string,  // or registration — see vehicleDetails
 *   vehicleDetails?: {
 *     make?, model?, year?, registrationNumber?, rego?, mileage?, bodyType?, colour?, color?,
 *     vin?, vinChassis?, engineNumber?, notes? (vehicle-specific; merged into booking notes),
 *   },
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

    const body = (await req.json()) as Record<string, unknown>;
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
      notes,
    } = body as Record<string, any>;

    const vf = vehicleFieldsFromBody(body);
    const generalNotes = typeof notes === "string" ? notes.trim() : "";
    const combinedNotes = [generalNotes, vf.vehicleNotes].filter(Boolean).join("\n\n");

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
      client: (client as string).trim(),
      clientEmail: clientEmail?.trim() || "",
      clientPhone: clientPhone?.trim() || "",
      customerId: customerId || null,
      vehicleNumber: vf.vehicleNumber,
      vehicleMake: vf.vehicleMake || null,
      vehicleModel: vf.vehicleModel || null,
      vehicleYear: vf.vehicleYear || null,
      vehicleBodyType: vf.vehicleBodyType || "",
      vehicleColour: vf.vehicleColour || "",
      vehicleVinChassis: vf.vehicleVinChassis || "",
      vehicleEngineNumber: vf.vehicleEngineNumber || "",
      vehicleMileage: vf.vehicleMileage || "",
      services: resolvedServices,
      tasks,
      additionalIssues: [],
      notes: combinedNotes,
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
