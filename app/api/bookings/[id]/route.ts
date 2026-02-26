import { NextRequest, NextResponse } from "next/server";
import { adminAuth, adminDb } from "@/lib/firebaseAdmin";
import { FieldValue } from "firebase-admin/firestore";
import { normalizeBookingStatus } from "@/lib/bookingTypes";

export const runtime = "nodejs";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PATCH, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders });
}

/**
 * PATCH /api/bookings/[id]
 * Update booking fields (e.g. mileage) - for assigned staff before/during the job.
 */
export async function PATCH(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const authHeader = req.headers.get("authorization") || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

    if (!token) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders });
    }

    let callerUid: string;
    try {
      const decoded = await adminAuth().verifyIdToken(token);
      callerUid = decoded.uid;
    } catch {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders });
    }

    const body = (await req.json().catch(() => ({}))) as { mileage?: string | null };

    const db = adminDb();
    const bookingRef = db.doc(`bookings/${id}`);
    const bookingSnap = await bookingRef.get();

    if (!bookingSnap.exists) {
      return NextResponse.json({ error: "Booking not found" }, { status: 404, headers: corsHeaders });
    }

    const bookingData = bookingSnap.data() as any;
    const currentStatus = normalizeBookingStatus(bookingData.status);

    // Only allow updates when booking is Confirmed (job in progress) - staff can add mileage before completing
    if (currentStatus !== "Confirmed") {
      return NextResponse.json(
        { error: "Can only update mileage for confirmed bookings (job in progress)" },
        { status: 400, headers: corsHeaders }
      );
    }

    // Verify caller is assigned staff or owner/branch admin
    const isAssignedStaff =
      bookingData.staffId === callerUid ||
      (Array.isArray(bookingData.services) &&
        bookingData.services.some((s: any) => s.staffId === callerUid || s.staffAuthUid === callerUid));

    let isOwnerOrAdmin = false;
    if (bookingData.ownerUid === callerUid) isOwnerOrAdmin = true;
    if (!isOwnerOrAdmin) {
      const userDoc = await db.doc(`users/${callerUid}`).get();
      const userData = userDoc.data();
      if (userData?.ownerUid === bookingData.ownerUid) isOwnerOrAdmin = true;
    }

    if (!isAssignedStaff && !isOwnerOrAdmin) {
      return NextResponse.json({ error: "Forbidden: only assigned staff or admins can update mileage" }, { status: 403, headers: corsHeaders });
    }

    const updates: Record<string, any> = {
      updatedAt: FieldValue.serverTimestamp(),
    };

    if (body.mileage !== undefined) {
      const val = typeof body.mileage === "string" ? body.mileage.trim() : "";
      updates.mileage = val || null;
    }

    if (Object.keys(updates).length <= 1) {
      return NextResponse.json({ error: "No valid fields to update" }, { status: 400, headers: corsHeaders });
    }

    await bookingRef.update(updates);

    return NextResponse.json({ ok: true }, { headers: corsHeaders });
  } catch (e) {
    console.error("Error in PATCH /api/bookings/[id]:", e);
    return NextResponse.json({ error: "Internal server error" }, { status: 500, headers: corsHeaders });
  }
}
