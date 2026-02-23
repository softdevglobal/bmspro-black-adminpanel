import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";
import { FieldValue } from "firebase-admin/firestore";
import { sendEstimateReplyEmail } from "@/lib/emailService";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { estimateId, ownerUid, message, imageUrls } = body;

    if (!estimateId || !ownerUid || !message?.trim()) {
      return NextResponse.json(
        { error: "Missing required fields: estimateId, ownerUid, and message are required." },
        { status: 400 }
      );
    }

    const db = adminDb();

    const estimateDoc = await db.collection("estimates").doc(estimateId).get();
    if (!estimateDoc.exists) {
      return NextResponse.json({ error: "Estimate not found" }, { status: 404 });
    }
    const estimateData = estimateDoc.data()!;

    if (estimateData.ownerUid !== ownerUid) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    }

    const replyData = {
      estimateId,
      ownerUid,
      message: message.trim(),
      imageUrls: imageUrls || [],
      createdAt: FieldValue.serverTimestamp(),
    };

    const replyRef = await db
      .collection("estimates")
      .doc(estimateId)
      .collection("replies")
      .add(replyData);

    // Update estimate status to Reviewed if still New
    if (estimateData.status === "New") {
      await db.collection("estimates").doc(estimateId).update({
        status: "Reviewed",
        updatedAt: FieldValue.serverTimestamp(),
      });
    }

    // Send email to customer
    try {
      const ownerDoc = await db.collection("users").doc(ownerUid).get();
      const ownerData = ownerDoc.data();
      const salonName = ownerData?.workshopName || ownerData?.displayName || "Workshop";

      await sendEstimateReplyEmail({
        customerEmail: estimateData.customerEmail,
        customerName: estimateData.customerName,
        salonName,
        message: message.trim(),
        imageUrls: imageUrls || [],
        vehicleInfo: [estimateData.vehicleYear, estimateData.vehicleMake, estimateData.vehicleModel].filter(Boolean).join(" "),
        rego: estimateData.rego || "",
      });
    } catch (emailErr) {
      console.error("Failed to send estimate reply email:", emailErr);
    }

    return NextResponse.json({ success: true, replyId: replyRef.id });
  } catch (error: any) {
    console.error("Estimate reply error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to submit reply" },
      { status: 500 }
    );
  }
}

export async function GET(req: NextRequest) {
  try {
    const estimateId = req.nextUrl.searchParams.get("estimateId");

    if (!estimateId) {
      return NextResponse.json({ error: "Missing estimateId" }, { status: 400 });
    }

    const db = adminDb();
    const snap = await db
      .collection("estimates")
      .doc(estimateId)
      .collection("replies")
      .orderBy("createdAt", "asc")
      .get();

    const replies = snap.docs.map((d) => {
      const data = d.data();
      return {
        id: d.id,
        message: data.message || "",
        imageUrls: data.imageUrls || [],
        createdAt: data.createdAt?.toDate?.()?.toISOString() || null,
      };
    });

    return NextResponse.json({ replies });
  } catch (error: any) {
    console.error("Error fetching estimate replies:", error);
    return NextResponse.json(
      { error: error.message || "Failed to fetch replies" },
      { status: 500 }
    );
  }
}
