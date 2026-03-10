import { NextRequest, NextResponse } from "next/server";
import { adminAuth, adminDb } from "@/lib/firebaseAdmin";
import { FieldValue } from "firebase-admin/firestore";

export const runtime = "nodejs";

/**
 * POST - Create a test "Additional Issue Reported" notification for the current user.
 * Use this to verify the notification flow works.
 */
export async function POST(req: NextRequest) {
  try {
    const authHeader = req.headers.get("authorization") || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const decoded = await adminAuth().verifyIdToken(token);
    const uid = decoded.uid;

    const db = adminDb();
    await db.collection("notifications").add({
      bookingId: "test-booking",
      bookingCode: "TEST-001",
      type: "additional_issue_found",
      title: "Additional Issue Reported (Test)",
      message: "Staff found: Test issue (Customer) - TEST-001. Set price in Bookings.",
      status: "Confirmed",
      ownerUid: uid,
      targetOwnerUid: uid,
      clientName: "Test Customer",
      read: false,
      createdAt: FieldValue.serverTimestamp(),
    });

    return NextResponse.json({ ok: true, message: "Test notification created. Check the Notifications panel." });
  } catch (e: any) {
    console.error("Error creating test notification:", e);
    return NextResponse.json({ error: e?.message || "Internal error" }, { status: 500 });
  }
}
