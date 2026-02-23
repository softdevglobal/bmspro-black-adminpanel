import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";
import { FieldValue } from "firebase-admin/firestore";
import { sendEstimateRequestEmail } from "@/lib/emailService";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      slug,
      customerId,
      branchId,
      branchName,
      customerName,
      customerPhone,
      customerEmail,
      vehicleMake,
      vehicleModel,
      vehicleYear,
      rego,
      description,
      imageUrls,
    } = body;

    if (!slug || !customerName || !customerPhone || !customerEmail || !description) {
      return NextResponse.json(
        { error: "Missing required fields: name, phone, email, and description are required." },
        { status: 400 }
      );
    }

    const db = adminDb();

    const usersQuery = await db
      .collection("users")
      .where("slug", "==", slug)
      .where("role", "==", "workshop_owner")
      .limit(1)
      .get();

    if (usersQuery.empty) {
      return NextResponse.json({ error: "Workshop not found" }, { status: 404 });
    }

    const ownerDoc = usersQuery.docs[0];
    const ownerData = ownerDoc.data();
    const ownerUid = ownerDoc.id;
    const workshopName = ownerData.workshopName || ownerData.displayName || "Workshop";

    const estimateData = {
      ownerUid,
      workshopSlug: slug,
      workshopName,
      customerId: customerId || null,
      branchId: branchId || null,
      branchName: branchName || null,
      customerName: customerName.trim(),
      customerPhone: customerPhone.trim(),
      customerEmail: customerEmail.trim(),
      vehicleMake: (vehicleMake || "").trim(),
      vehicleModel: (vehicleModel || "").trim(),
      vehicleYear: (vehicleYear || "").trim(),
      rego: (rego || "").trim(),
      description: description.trim(),
      imageUrls: Array.isArray(imageUrls) ? imageUrls : [],
      status: "New",
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };

    const estimateRef = await db.collection("estimates").add(estimateData);

    await db.collection("notifications").add({
      ownerUid,
      type: "new_estimate",
      title: "New Estimate Request",
      message: `${customerName} has requested an estimate${branchName ? ` at ${branchName}` : ""}.`,
      read: false,
      estimateId: estimateRef.id,
      createdAt: FieldValue.serverTimestamp(),
    });

    // Send email notification to the salon/workshop owner
    try {
      await sendEstimateRequestEmail(ownerUid, {
        customerName: customerName.trim(),
        customerPhone: customerPhone.trim(),
        customerEmail: customerEmail.trim(),
        vehicleMake: (vehicleMake || "").trim(),
        vehicleModel: (vehicleModel || "").trim(),
        vehicleYear: (vehicleYear || "").trim(),
        rego: (rego || "").trim(),
        description: description.trim(),
        branchName: branchName || null,
        imageUrls: Array.isArray(imageUrls) ? imageUrls : [],
      });
    } catch (emailErr) {
      console.error("Failed to send estimate email to owner:", emailErr);
    }

    return NextResponse.json({ success: true, estimateId: estimateRef.id });
  } catch (error: any) {
    console.error("Estimate submission error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to submit estimate request" },
      { status: 500 }
    );
  }
}
