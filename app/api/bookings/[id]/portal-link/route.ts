import { NextRequest, NextResponse } from "next/server";
import { adminAuth, adminDb } from "@/lib/firebaseAdmin";
import { FieldValue } from "firebase-admin/firestore";
import type { Firestore } from "firebase-admin/firestore";
import { resolveCustomerForStaffBooking, getCanonicalCustomerContact } from "@/lib/customerAccount";
import { upsertCustomerVehicleFromBooking } from "@/lib/callCenterCustomerVehiclesServer";
import { isVehicleType } from "@/lib/services";

export const runtime = "nodejs";

async function workshopOwnerUidForCaller(db: Firestore, callerUid: string): Promise<string> {
  const userDoc = await db.doc(`users/${callerUid}`).get();
  const userData = userDoc.data();
  if (userData) {
    const userRole = userData.role || userData.systemRole;
    if ((userRole === "branch_admin" || userRole === "staff") && userData.ownerUid) {
      return String(userData.ownerUid);
    }
  }
  return callerUid;
}

/**
 * POST /api/bookings/[id]/portal-link
 * Best-effort: attach `customerId` from clientEmail/clientPhone (same rules as staff booking API)
 * and merge the booking's vehicle into `customers/{id}/vehicles`.
 * Used when a booking was created via a direct Firestore write (no server-side link).
 */
export async function POST(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id: bookingId } = await context.params;
    const authHeader = _req.headers.get("authorization") || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const decoded = await adminAuth().verifyIdToken(token);
    const callerUid = decoded.uid;
    const db = adminDb();
    const workshopOwnerUid = await workshopOwnerUidForCaller(db, callerUid);

    const bookingRef = db.doc(`bookings/${bookingId}`);
    const snap = await bookingRef.get();
    if (!snap.exists) {
      return NextResponse.json({ error: "Booking not found" }, { status: 404 });
    }

    const b = snap.data() as Record<string, unknown>;
    if (String(b.ownerUid) !== workshopOwnerUid) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const hadCustomerId =
      (typeof b.customerId === "string" && b.customerId.trim()) || null;
    let customerId = hadCustomerId;
    const resolution = await resolveCustomerForStaffBooking(db, {
      ownerUid: workshopOwnerUid,
      email: typeof b.clientEmail === "string" ? b.clientEmail : null,
      phone: typeof b.clientPhone === "string" ? b.clientPhone : null,
      name: typeof b.client === "string" ? b.client : null,
    });

    const updates: Record<string, unknown> = {};
    if (!customerId && resolution) {
      customerId = resolution.customerId;
      updates.customerId = customerId;
    }

    const cid = customerId || resolution?.customerId || null;
    const accountCreatedThisBooking = resolution?.created === true;
    let canonicalCustomerForResponse: {
      name: string;
      email: string;
      phone: string;
    } | null = null;

    if (cid && !accountCreatedThisBooking) {
      try {
        const canon = await getCanonicalCustomerContact(db, cid, workshopOwnerUid);
        if (canon) {
          canonicalCustomerForResponse = canon;
          if (canon.name) updates.client = canon.name;
          if (canon.email) updates.clientEmail = canon.email;
          if (canon.phone) updates.clientPhone = canon.phone;
        }
      } catch (e) {
        console.warn("[portal-link] canonical contact:", e);
      }
    }

    if (Object.keys(updates).length > 0) {
      updates.updatedAt = FieldValue.serverTimestamp();
      await bookingRef.update(updates);
    }
    const vtRaw = b.vehicleType;
    const resolvedVehicleType =
      typeof vtRaw === "string" && isVehicleType(vtRaw) ? vtRaw : null;

    if (cid) {
      await upsertCustomerVehicleFromBooking(db, {
        customerId: cid,
        ownerUid: workshopOwnerUid,
        createdByUid: callerUid,
        vehicle: {
          vehicleNumber: typeof b.vehicleNumber === "string" ? b.vehicleNumber : null,
          vehicleMake: typeof b.vehicleMake === "string" ? b.vehicleMake : null,
          vehicleModel: typeof b.vehicleModel === "string" ? b.vehicleModel : null,
          vehicleYear: typeof b.vehicleYear === "string" ? b.vehicleYear : null,
          vehicleMileage: typeof b.vehicleMileage === "string" ? b.vehicleMileage : null,
          vehicleBodyType: typeof b.vehicleBodyType === "string" ? b.vehicleBodyType : null,
          vehicleType: resolvedVehicleType,
          vehicleColour: typeof b.vehicleColour === "string" ? b.vehicleColour : null,
          vehicleVinChassis: typeof b.vehicleVinChassis === "string" ? b.vehicleVinChassis : null,
          vehicleEngineNumber: typeof b.vehicleEngineNumber === "string" ? b.vehicleEngineNumber : null,
        },
      });
    }

    return NextResponse.json({
      ok: true,
      customerId: cid,
      linkedNew: Boolean(resolution && !hadCustomerId && resolution.customerId),
      ...(canonicalCustomerForResponse
        ? { canonicalCustomer: canonicalCustomerForResponse }
        : {}),
    });
  } catch (e: unknown) {
    console.error("[portal-link]", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed" },
      { status: 500 }
    );
  }
}
