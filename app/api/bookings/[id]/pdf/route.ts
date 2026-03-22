import { NextRequest, NextResponse } from "next/server";
import { adminAuth, adminDb } from "@/lib/firebaseAdmin";
import { generateBookingPDF } from "@/lib/pdfService";

export const runtime = "nodejs";
/** Allow time for Chromium + PDF render on Vercel (raise on Pro if needed). */
export const maxDuration = 60;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders });
}

/**
 * GET /api/bookings/[id]/pdf
 * Generate and return the job task PDF for a booking.
 * Accessible by: booking owner (salon admin), assigned staff, or the customer.
 */
export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;

    if (!id) {
      return NextResponse.json({ error: "Booking ID is required" }, { status: 400, headers: corsHeaders });
    }

    // Authenticate
    const authHeader = req.headers.get("authorization") || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

    if (!token) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders });
    }

    let uid: string;
    try {
      const decoded = await adminAuth().verifyIdToken(token);
      uid = decoded.uid;
    } catch {
      return NextResponse.json({ error: "Invalid token" }, { status: 401, headers: corsHeaders });
    }

    // Verify the user has access to this booking
    const db = adminDb();
    const bookingSnap = await db.collection("bookings").doc(id).get();

    if (!bookingSnap.exists) {
      return NextResponse.json({ error: "Booking not found" }, { status: 404, headers: corsHeaders });
    }

    const bookingData = bookingSnap.data() as any;

    const isOwner = bookingData.ownerUid === uid;
    const isCustomer = bookingData.customerUid === uid;
    const isStaff =
      bookingData.staffId === uid ||
      (Array.isArray(bookingData.services) &&
        bookingData.services.some((s: any) => s.staffId === uid || s.staffAuthUid === uid));

    // Also check if user is a staff member belonging to the same owner
    let isSalonStaff = false;
    if (!isOwner && !isCustomer && !isStaff) {
      try {
        const userDoc = await db.doc(`users/${uid}`).get();
        if (userDoc.exists) {
          const userData = userDoc.data();
          isSalonStaff = userData?.ownerUid === bookingData.ownerUid;
        }
      } catch {
        /* ignore */
      }
    }

    if (!isOwner && !isCustomer && !isStaff && !isSalonStaff) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403, headers: corsHeaders });
    }

    const { buffer, filename } = await generateBookingPDF(id);

    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": String(buffer.length),
      },
    });
  } catch (error: any) {
    console.error("Error generating booking PDF:", error);
    return NextResponse.json(
      { error: error.message || "Failed to generate PDF" },
      { status: 500, headers: corsHeaders }
    );
  }
}
