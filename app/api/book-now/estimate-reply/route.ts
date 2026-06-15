import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";
import { FieldValue } from "firebase-admin/firestore";
import { sendEstimateReplyEmail } from "@/lib/emailService";
import {
  CUSTOMER_NOTIFICATION_AGENT_TRACKING_DEFAULTS,
  resolveCustomerNameForStorage,
  resolveCustomerPhoneForStorage,
} from "@/lib/notifications";
import { appendBookNowMyBookingsDeepLink, resolveBookingEngineUrl } from "@/lib/customerAccount";

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

    // Create in-app notification for booking engine customer
    const customerId = estimateData.customerId;
    if (customerId) {
      try {
        let customerPhone = resolveCustomerPhoneForStorage(estimateData as Record<string, any>);
        let customerName = resolveCustomerNameForStorage(estimateData as Record<string, any>);
        if (!customerPhone || !customerName) {
          const custSnap = await db.collection("customers").doc(customerId).get();
          if (custSnap.exists) {
            const cd = custSnap.data() as Record<string, any>;
            if (!customerPhone) customerPhone = resolveCustomerPhoneForStorage(cd);
            if (!customerName) customerName = resolveCustomerNameForStorage(cd);
          }
        }
        await db.collection("customer_notifications").add({
          customerId,
          ownerUid,
          type: "estimate_reply",
          estimateId,
          title: "New Reply to Your Estimate",
          message: "The workshop has replied to your estimate request.",
          read: false,
          customerPhone: customerPhone ?? null,
          customerName: customerName ?? null,
          ...CUSTOMER_NOTIFICATION_AGENT_TRACKING_DEFAULTS,
          workshopName: (await db.collection("users").doc(ownerUid).get()).data()?.workshopName || "Workshop",
          createdAt: FieldValue.serverTimestamp(),
        });
      } catch (notifErr) {
        console.error("Failed to create customer notification:", notifErr);
      }
    }

    // Send email to customer
    try {
      const ownerDoc = await db.collection("users").doc(ownerUid).get();
      const ownerData = ownerDoc.data();
      const workshopName = ownerData?.workshopName || ownerData?.displayName || "Workshop";
      const portalUrl = appendBookNowMyBookingsDeepLink(resolveBookingEngineUrl(ownerData));

      await sendEstimateReplyEmail({
        customerEmail: estimateData.customerEmail,
        customerPhone:
          resolveCustomerPhoneForStorage(estimateData as Record<string, unknown>) ||
          estimateData.customerPhone ||
          null,
        customerName: estimateData.customerName,
        workshopName,
        message: message.trim(),
        imageUrls: imageUrls || [],
        vehicleInfo: [estimateData.vehicleYear, estimateData.vehicleMake, estimateData.vehicleModel].filter(Boolean).join(" "),
        rego: estimateData.rego || "",
        portalUrl,
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
