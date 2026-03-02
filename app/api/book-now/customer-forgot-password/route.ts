import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";
import { FieldValue } from "firebase-admin/firestore";
import { sendCustomerPasswordResetEmail } from "@/lib/emailService";

export const runtime = "nodejs";

function generateResetCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { email, ownerUid } = body;

    if (!email || !email.trim()) {
      return NextResponse.json({ error: "Email is required" }, { status: 400 });
    }
    if (!ownerUid) {
      return NextResponse.json({ error: "Workshop is required" }, { status: 400 });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(normalizedEmail)) {
      return NextResponse.json({ error: "Invalid email address" }, { status: 400 });
    }

    const db = adminDb();
    const snap = await db
      .collection("customers")
      .where("email", "==", normalizedEmail)
      .where("ownerUid", "==", ownerUid)
      .limit(1)
      .get();

    // Don't reveal if account exists - return success either way for security
    if (snap.empty) {
      return NextResponse.json({
        success: true,
        message: "If an account exists with this email, a password reset code has been sent.",
      });
    }

    const doc = snap.docs[0];
    const customerId = doc.id;
    const data = doc.data();
    const customerName = data.name || normalizedEmail;

    const resetCode = generateResetCode();
    const expiresAt = new Date();
    expiresAt.setMinutes(expiresAt.getMinutes() + 15);

    await db.collection("customerPasswordResetCodes").doc(customerId).set({
      email: normalizedEmail,
      ownerUid,
      code: resetCode,
      expiresAt,
      createdAt: FieldValue.serverTimestamp(),
      used: false,
    });

    try {
      const ownerDoc = await db.doc(`users/${ownerUid}`).get();
      if (ownerDoc.exists) {
        const od = ownerDoc.data();
        const name = od?.workshopName || od?.salonName || od?.name || "Workshop";
        await sendCustomerPasswordResetEmail(normalizedEmail, customerName, resetCode, name);
      } else {
        await sendCustomerPasswordResetEmail(normalizedEmail, customerName, resetCode, "Workshop");
      }
    } catch (emailErr) {
      console.error("[API] Customer forgot password - email send failed:", emailErr);
      return NextResponse.json(
        { error: "Failed to send reset email. Please try again." },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      message: "If an account exists with this email, a password reset code has been sent.",
    });
  } catch (error: any) {
    console.error("[API] Customer forgot password error:", error);
    return NextResponse.json(
      { error: "Failed to process request. Please try again." },
      { status: 500 }
    );
  }
}
