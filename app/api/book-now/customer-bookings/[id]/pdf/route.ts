import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";
import { generateBookingPDF } from "@/lib/pdfService";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const customerId = req.nextUrl.searchParams.get("customerId");

    if (!id) {
      return NextResponse.json({ error: "Missing booking id" }, { status: 400 });
    }
    if (!customerId) {
      return NextResponse.json({ error: "Missing customerId" }, { status: 400 });
    }

    const db = adminDb();
    const bookingSnap = await db.collection("bookings").doc(id).get();

    if (!bookingSnap.exists) {
      return NextResponse.json({ error: "Booking not found" }, { status: 404 });
    }

    const booking = bookingSnap.data() as any;
    if ((booking?.customerId || "") !== customerId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    if ((booking?.status || "").toString().toLowerCase() !== "completed") {
      return NextResponse.json(
        { error: "PDF is only available for completed bookings" },
        { status: 400 }
      );
    }

    const { buffer, filename } = await generateBookingPDF(id);
    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "private, max-age=60",
      },
    });
  } catch (error) {
    console.error("Customer PDF download error:", error);
    return NextResponse.json(
      { error: "Failed to generate booking PDF" },
      { status: 500 }
    );
  }
}
