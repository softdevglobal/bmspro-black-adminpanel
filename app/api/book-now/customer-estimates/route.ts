import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const customerId = req.nextUrl.searchParams.get("customerId");

    if (!customerId) {
      return NextResponse.json({ error: "Missing customerId" }, { status: 400 });
    }

    const db = adminDb();
    const snap = await db
      .collection("estimates")
      .where("customerId", "==", customerId)
      .get();

    const estimates = snap.docs
      .map((doc) => {
        const d = doc.data();
        return {
          id: doc.id,
          customerName: d.customerName || "",
          customerPhone: d.customerPhone || "",
          customerEmail: d.customerEmail || "",
          vehicleMake: d.vehicleMake || "",
          vehicleModel: d.vehicleModel || "",
          vehicleYear: d.vehicleYear || "",
          rego: d.rego || "",
          mileage: d.mileage || "",
          description: d.description || "",
          imageUrls: Array.isArray(d.imageUrls) ? d.imageUrls : [],
          branchName: d.branchName || null,
          status: d.status || "New",
          createdAt: d.createdAt?.toDate?.()?.toISOString() || null,
          updatedAt: d.updatedAt?.toDate?.()?.toISOString() || null,
        };
      })
      .sort((a, b) => {
        const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return bTime - aTime;
      });

    return NextResponse.json({ estimates });
  } catch (error: any) {
    console.error("Error fetching customer estimates:", error);
    return NextResponse.json(
      { error: error.message || "Failed to fetch estimates" },
      { status: 500 }
    );
  }
}
