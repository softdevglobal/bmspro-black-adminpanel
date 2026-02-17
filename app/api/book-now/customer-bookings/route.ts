import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";

export async function GET(req: NextRequest) {
  try {
    const customerId = req.nextUrl.searchParams.get("customerId");

    if (!customerId) {
      return NextResponse.json({ error: "Missing customerId" }, { status: 400 });
    }

    const db = adminDb();
    const snap = await db
      .collection("bookings")
      .where("customerId", "==", customerId)
      .get();

    const bookings = snap.docs.map((doc) => {
      const d = doc.data();
      return {
        id: doc.id,
        bookingCode: d.bookingCode || "",
        serviceName:
          d.serviceName ||
          (Array.isArray(d.services)
            ? d.services.map((s: any) => s.name).join(", ")
            : "Service"),
        status: d.status || "Pending",
        date: d.date || "",
        time: d.time || "",
        pickupTime: d.pickupTime || null,
        branchName: d.branchName || "",
        price: d.price || 0,
        createdAt: d.createdAt?.toDate?.()?.toISOString() || null,
        updatedAt: d.updatedAt?.toDate?.()?.toISOString() || null,
      };
    });

    // Sort newest first (avoids needing a composite Firestore index)
    bookings.sort((a, b) => {
      const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return bTime - aTime;
    });

    return NextResponse.json({ bookings: bookings.slice(0, 50) });
  } catch (error: any) {
    console.error("Customer bookings fetch error:", error);
    return NextResponse.json(
      { error: "Failed to fetch bookings" },
      { status: 500 }
    );
  }
}
