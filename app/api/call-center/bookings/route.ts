import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";
import {
  verifyCallCenterOrTenantAdminAuth,
  canAccessWorkshopForAuth,
  getTenantId,
  CORS_HEADERS,
} from "@/lib/callCenterAuth";
import {
  normalizeBookingStatus,
  getServiceCompletionProgress,
  countsTowardDailyLimit,
} from "@/lib/bookingTypes";
import {
  mergeBookingContactIntoAdditionalIssues,
  serializeAdditionalIssuesForCallCenterApi,
} from "@/lib/callCenterAdditionalIssues";
import {
  createOwnerNotification,
  createBranchAdminNotification,
  createStaffAssignmentNotification,
  getBranchAdminUids,
} from "@/lib/notifications";
import { sendCustomerWelcomeEmail } from "@/lib/emailService";
import { ensureCustomerAccount, resolveBookingEngineUrl } from "@/lib/customerAccount";
import { upsertCustomerVehicleFromBooking } from "@/lib/callCenterCustomerVehiclesServer";
import {
  isVehicleType,
  normalizeVehicleTypePricing,
  resolveServicePricingForVehicleType,
  type VehicleType,
} from "@/lib/services";

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
      const additionalIssues = mergeBookingContactIntoAdditionalIssues(
        serializeAdditionalIssuesForCallCenterApi(additionalIssuesRaw),
        d as Record<string, unknown>
      );

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
        vehicleType: isVehicleType(d.vehicleType) ? d.vehicleType : null,
        vehicleBodyType: d.vehicleBodyType || "",
        branchId: d.branchId || "",
        branchName: d.branchName || "",
        services: services.map((s: any) => ({
          // `id` is the service id the agent needs when assigning staff via
          // POST /bookings/{id}/confirm → body.staffAssignments[<id>].
          id: s.id || s.serviceId || null,
          name: s.name || "",
          price: s.price || 0,
          staffId: s.staffId || null,
          staffName: s.staffName || null,
          completionStatus: s.completionStatus || "pending",
          vehicleType: isVehicleType(s.vehicleType) ? s.vehicleType : null,
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
  /** Canonical size class used for per-type pricing — validated against VEHICLE_TYPES. */
  vehicleType: VehicleType | null;
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

  const rawType = pick("vehicleType");
  const vehicleType: VehicleType | null = rawType && isVehicleType(rawType) ? (rawType as VehicleType) : null;

  return {
    vehicleNumber: rego,
    vehicleMake: pick("make"),
    vehicleModel: pick("model"),
    vehicleYear: pick("year"),
    vehicleMileage: pick("mileage"),
    vehicleBodyType: pick("bodyType"),
    vehicleType,
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
      gate.auth.kind === "agent" ? gate.auth.user.role : gate.auth.role;

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

    // Customer email + phone are mandatory when creating bookings on behalf
    // of a customer — the email is used to auto-create their Booking Engine
    // account (see `ensureCustomerAccount` below) and the phone is required
    // for workshop contact.
    const trimmedClientEmail =
      typeof clientEmail === "string" ? clientEmail.trim() : "";
    const trimmedClientPhone =
      typeof clientPhone === "string" ? clientPhone.trim() : "";

    if (!trimmedClientEmail) {
      return NextResponse.json(
        { error: "Customer email is required", field: "clientEmail" },
        { status: 400, headers: CORS_HEADERS }
      );
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(trimmedClientEmail)) {
      return NextResponse.json(
        { error: "Customer email must be a valid email address", field: "clientEmail" },
        { status: 400, headers: CORS_HEADERS }
      );
    }

    if (!trimmedClientPhone) {
      return NextResponse.json(
        { error: "Customer phone is required", field: "clientPhone" },
        { status: 400, headers: CORS_HEADERS }
      );
    }
    const phoneDigits = trimmedClientPhone.replace(/\D/g, "");
    if (phoneDigits.length < 6 || !/^[+\d][\d\s\-()]+$/.test(trimmedClientPhone)) {
      return NextResponse.json(
        { error: "Customer phone must be a valid phone number", field: "clientPhone" },
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

    // ─── Daily booking limit enforcement ──────────────────────────────────
    // The ONLY restriction on agent-side booking creation is the branch's
    // `bookingLimitPerDay`. As long as the count of bookings counting toward
    // the daily cap (see `countsTowardDailyLimit`) is below that number, the
    // agent can book any in-hours time slot. Unset / non-positive limits are
    // treated as "unlimited".
    const bookingLimitPerDay =
      typeof branchData.bookingLimitPerDay === "number" &&
      branchData.bookingLimitPerDay > 0
        ? branchData.bookingLimitPerDay
        : null;
    if (bookingLimitPerDay !== null) {
      const existingForDay = await db
        .collection("bookings")
        .where("ownerUid", "==", ownerUid)
        .where("branchId", "==", branchId)
        .where("date", "==", date)
        .get();
      const countingBookings = existingForDay.docs.filter((d) =>
        countsTowardDailyLimit((d.data() as any)?.status),
      );
      if (countingBookings.length >= bookingLimitPerDay) {
        return NextResponse.json(
          {
            error: "Daily booking limit reached for this branch on this date.",
            field: "date",
            dailyLimit: bookingLimitPerDay,
            currentBookings: countingBookings.length,
            remainingBookings: 0,
          },
          { status: 409, headers: CORS_HEADERS },
        );
      }
    }

    // Resolve service details from catalog
    const resolvedServices: any[] = [];
    let totalPrice = 0;
    let totalDuration = 0;

    for (const rs of requestedServices) {
      if (rs.serviceId) {
        const svcDoc = await db.doc(`services/${rs.serviceId}`).get();
        if (svcDoc.exists && svcDoc.data()?.ownerUid === ownerUid) {
          const svcData = svcDoc.data()!;
          // If the agent supplied a canonical vehicleType, resolve the
          // price/duration from the service's vehicleTypePricing map so the
          // call-center flow stays consistent with the customer booking
          // engine. Explicit overrides on the request still win.
          let resolvedPrice: number | null = null;
          let resolvedDuration: number | null = null;
          if (vf.vehicleType) {
            const pricing = resolveServicePricingForVehicleType(
              {
                price: typeof svcData.price === "number" ? svcData.price : undefined,
                duration: typeof svcData.duration === "number" ? svcData.duration : undefined,
                vehicleTypePricing: normalizeVehicleTypePricing(svcData.vehicleTypePricing)
                  .vehicleTypePricing,
              },
              vf.vehicleType,
            );
            if (pricing) {
              resolvedPrice = pricing.price;
              resolvedDuration = pricing.duration;
            }
          }
          const price = rs.price ?? resolvedPrice ?? svcData.price ?? 0;
          const duration = rs.duration ?? resolvedDuration ?? svcData.duration ?? 0;
          // Snapshot owner's current area ordering for this service so the
          // booking preview can group tasks in the owner's chosen order.
          const areaOrder = Array.isArray(svcData.areaOrder)
            ? (svcData.areaOrder as unknown[]).filter(
                (v) =>
                  v === "interior" ||
                  v === "engine_bay" ||
                  v === "underbody" ||
                  v === "exterior"
              )
            : [];
          resolvedServices.push({
            id: rs.serviceId,
            name: rs.serviceName || svcData.name || "",
            price,
            duration,
            staffId: rs.staffId || null,
            staffName: rs.staffName || null,
            approvalStatus: rs.staffId ? "pending" : "needs_assignment",
            completionStatus: "pending",
            ...(vf.vehicleType ? { vehicleType: vf.vehicleType } : {}),
            ...(areaOrder.length > 0 ? { areaOrder } : {}),
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
          ...(vf.vehicleType ? { vehicleType: vf.vehicleType } : {}),
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
            const rawSection =
              typeof item === "string" ? undefined : (item as any)?.section;
            const section =
              rawSection === "interior" ||
              rawSection === "engine_bay" ||
              rawSection === "underbody" ||
              rawSection === "exterior"
                ? rawSection
                : "interior";
            tasks.push({
              id: `task_${taskIndex++}`,
              serviceId: svc.id,
              serviceName: svc.name,
              name: item.name || item.title || "",
              description: item.description || "",
              section,
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

    // ─── Resolve / provision customer account BEFORE saving the booking ────
    // Prefer the caller-supplied `customerId` (already-known customer).
    // Otherwise, look up by (ownerUid, email). If a customer exists → link
    // the booking to that existing account and send NO welcome email.
    // If not → create a new one with the default password "000000" and queue
    // a welcome email to be sent after the booking is successfully saved.
    let resolvedCustomerId: string | null = customerId || null;
    let newCustomerWelcome: {
      email: string;
      password: string;
      name: string;
    } | null = null;
    try {
      const rawEmail = typeof clientEmail === "string" ? clientEmail.trim() : "";
      if (!resolvedCustomerId && rawEmail) {
        const ensureResult = await ensureCustomerAccount(db, {
          ownerUid,
          email: rawEmail,
          name: typeof client === "string" ? client : null,
          phone: typeof clientPhone === "string" ? clientPhone : null,
        });
        if (ensureResult) {
          resolvedCustomerId = ensureResult.customerId;
          if (ensureResult.created && ensureResult.defaultPassword) {
            newCustomerWelcome = {
              email: ensureResult.email,
              password: ensureResult.defaultPassword,
              name: String(client || "").trim(),
            };
            console.log(
              `[call-center/bookings] Auto-created customer account ${ensureResult.customerId} for ${ensureResult.email} (workshop ${ownerUid})`
            );
          } else {
            console.log(
              `[call-center/bookings] Linking booking to existing customer account ${ensureResult.customerId} for ${ensureResult.email} (workshop ${ownerUid}) — skipping welcome email`
            );
          }
        }
      }
    } catch (customerAccountErr: any) {
      console.error(
        `[call-center/bookings] ❌ Exception during customer account resolution — proceeding without linked customerId:`,
        customerAccountErr?.message || customerAccountErr
      );
    }

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
      customerId: resolvedCustomerId,
      vehicleNumber: vf.vehicleNumber,
      vehicleMake: vf.vehicleMake || null,
      vehicleModel: vf.vehicleModel || null,
      vehicleYear: vf.vehicleYear || null,
      vehicleBodyType: vf.vehicleBodyType || "",
      vehicleType: vf.vehicleType, // canonical size class used for per-type pricing; null for legacy
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
    const bookingId = bookingRef.id;

    // ─── Persist the vehicle into the customer's "My Vehicles" list ──────
    // Mirrors /api/bookings so agents who capture a rego / VIN while taking
    // the call populate the customer profile for the next booking. Dedupes
    // against existing vehicles; best-effort — never breaks booking creation.
    if (resolvedCustomerId) {
      try {
        const vehicleResult = await upsertCustomerVehicleFromBooking(db, {
          customerId: resolvedCustomerId,
          ownerUid,
          createdByUid: actor.uid || null,
          vehicle: {
            vehicleNumber: vf.vehicleNumber,
            vehicleMake: vf.vehicleMake,
            vehicleModel: vf.vehicleModel,
            vehicleYear: vf.vehicleYear,
            vehicleMileage: vf.vehicleMileage,
            vehicleBodyType: vf.vehicleBodyType,
            vehicleType: vf.vehicleType,
            vehicleColour: vf.vehicleColour,
            vehicleVinChassis: vf.vehicleVinChassis,
            vehicleEngineNumber: vf.vehicleEngineNumber,
          },
        });
        if (vehicleResult.saved) {
          console.log(
            `[call-center/bookings] ✅ Vehicle ${vehicleResult.vehicleId} ${
              vehicleResult.updatedExisting ? "merged into existing" : "added to"
            } customer ${resolvedCustomerId} from booking ${bookingId}`,
          );
        } else {
          console.log(
            `[call-center/bookings] ℹ️ Skipped vehicle upsert for booking ${bookingId} — reason: ${vehicleResult.reason}`,
          );
        }
      } catch (vehicleErr: any) {
        console.error(
          `[call-center/bookings] ❌ Exception persisting vehicle for booking ${bookingId}:`,
          vehicleErr?.message || vehicleErr,
        );
      }
    }

    const bookingTimeDisplay = pickupTime
      ? `Drop-off: ${String(time)}, Pick-up: ${pickupTime}`
      : String(time);
    const primaryServiceName =
      resolvedServices.length > 0
        ? resolvedServices.map((s: { name?: string }) => s.name || "Service").join(", ")
        : "Service";
    const servicesForNotif = resolvedServices.map((s: any) => ({
      name: s.name || "Service",
      staffName: s.staffName || undefined,
      staffId: s.staffId || undefined,
    }));

    // Workshop owner + branch admins + staff: same Firestore/FCM paths as /api/bookings (mobile app listens here)
    try {
      if (allNeedAssignment) {
        await createOwnerNotification({
          bookingId,
          bookingCode,
          ownerUid,
          clientName: String(client).trim(),
          serviceName: primaryServiceName,
          services: servicesForNotif,
          branchName: bookingData.branchName,
          branchId: String(branchId),
          bookingDate: String(date),
          bookingTime: bookingTimeDisplay,
          type: "booking_needs_assignment",
          status: "Pending",
        });
        const branchAdminUids = await getBranchAdminUids(db, String(branchId), ownerUid);
        for (const branchAdminUid of branchAdminUids) {
          if (branchAdminUid === ownerUid) continue;
          await createBranchAdminNotification({
            bookingId,
            bookingCode,
            branchAdminUid,
            ownerUid,
            clientName: String(client).trim(),
            serviceName: primaryServiceName,
            services: servicesForNotif,
            branchName: bookingData.branchName,
            branchId: String(branchId),
            bookingDate: String(date),
            bookingTime: bookingTimeDisplay,
            status: "Pending",
            type: "booking_needs_assignment",
            clientPhone: typeof clientPhone === "string" ? clientPhone.trim() || undefined : undefined,
            customerPhone: typeof clientPhone === "string" ? clientPhone.trim() || undefined : undefined,
            clientEmail: typeof clientEmail === "string" ? clientEmail.trim() || undefined : undefined,
          });
        }
      } else {
        await createOwnerNotification({
          bookingId,
          bookingCode,
          ownerUid,
          clientName: String(client).trim(),
          serviceName: primaryServiceName,
          services: servicesForNotif,
          branchName: bookingData.branchName,
          branchId: String(branchId),
          bookingDate: String(date),
          bookingTime: bookingTimeDisplay,
          type: "staff_booking_created",
          status: "AwaitingStaffApproval",
          creatorUid: actor.uid,
          creatorName: actor.name,
          creatorRole: createdByRole,
        });
        const branchAdminUids = await getBranchAdminUids(db, String(branchId), ownerUid);
        for (const branchAdminUid of branchAdminUids) {
          if (branchAdminUid === ownerUid) continue;
          await createBranchAdminNotification({
            bookingId,
            bookingCode,
            branchAdminUid,
            ownerUid,
            clientName: String(client).trim(),
            serviceName: primaryServiceName,
            services: servicesForNotif,
            branchName: bookingData.branchName,
            branchId: String(branchId),
            bookingDate: String(date),
            bookingTime: bookingTimeDisplay,
            status: "AwaitingStaffApproval",
            type: "branch_booking_created",
            clientPhone: typeof clientPhone === "string" ? clientPhone.trim() || undefined : undefined,
            clientEmail: typeof clientEmail === "string" ? clientEmail.trim() || undefined : undefined,
          });
        }
        const staffSeen = new Set<string>();
        for (const svc of resolvedServices) {
          const sid = svc.staffId as string | null | undefined;
          if (!sid || String(sid).toLowerCase().includes("any")) continue;
          if (staffSeen.has(sid)) continue;
          staffSeen.add(sid);
          await createStaffAssignmentNotification({
            bookingId,
            bookingCode,
            staffUid: sid,
            staffName: (svc.staffName as string) || "Staff",
            clientName: String(client).trim(),
            clientPhone: typeof clientPhone === "string" ? clientPhone.trim() || undefined : undefined,
            serviceName: primaryServiceName,
            services: servicesForNotif,
            branchName: bookingData.branchName,
            bookingDate: String(date),
            bookingTime: bookingTimeDisplay,
            duration: totalDuration,
            price: totalPrice,
            ownerUid,
          });
        }
      }
      console.log(
        `[call-center/bookings] Notifications sent for booking ${bookingCode} (${allNeedAssignment ? "Pending" : "AwaitingStaffApproval"})`
      );
    } catch (notifErr) {
      console.error("[call-center/bookings POST] Failed to send notifications:", notifErr);
    }

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

    // ─── Welcome email for NEWLY-created customer accounts ─────────────────
    // Existing accounts were already linked via `customerId` on the booking
    // payload above, so no email is needed for them. Only fire this when a
    // brand-new customer was provisioned during account resolution.
    if (newCustomerWelcome) {
      try {
        let workshopName = "Workshop";
        let bookingEngineUrl = process.env.NEXT_PUBLIC_APP_URL || "https://black.bmspros.com.au";
        try {
          const ownerData = workshopDoc.exists ? workshopDoc.data() || {} : {};
          workshopName =
            (ownerData.workshopName as string) ||
            (ownerData.salonName as string) ||
            (ownerData.businessName as string) ||
            (ownerData.name as string) ||
            (ownerData.displayName as string) ||
            "Workshop";
          bookingEngineUrl = resolveBookingEngineUrl(ownerData);
        } catch (ownerLookupErr) {
          console.warn(
            `[call-center/bookings] Could not resolve workshop metadata for welcome email (owner ${ownerUid}):`,
            ownerLookupErr
          );
        }

        const welcomeResult = await sendCustomerWelcomeEmail({
          customerEmail: newCustomerWelcome.email,
          password: newCustomerWelcome.password,
          customerName: newCustomerWelcome.name,
          workshopName,
          bookingEngineUrl,
        });

        if (welcomeResult.success) {
          console.log(
            `[call-center/bookings] ✅ Welcome email sent to new customer ${newCustomerWelcome.email} for booking ${bookingRef.id}`
          );
        } else {
          console.error(
            `[call-center/bookings] ❌ Welcome email failed for new customer ${newCustomerWelcome.email} on booking ${bookingRef.id}:`,
            welcomeResult.error
          );
        }
      } catch (welcomeErr: any) {
        console.error(
          `[call-center/bookings] ❌ Exception sending welcome email for booking ${bookingRef.id}:`,
          welcomeErr?.message || welcomeErr
        );
      }
    }

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
