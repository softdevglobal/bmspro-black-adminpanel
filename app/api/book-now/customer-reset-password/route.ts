import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";
import { FieldValue } from "firebase-admin/firestore";
import crypto from "crypto";

export const runtime = "nodejs";

function hashPassword(password: string, salt: string): string {
  return crypto.pbkdf2Sync(password, salt, 100_000, 64, "sha512").toString("hex");
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { email, code, newPassword, ownerUid } = body;

    if (!email || !code || !newPassword || !ownerUid) {
      return NextResponse.json(
        { error: "Email, code, new password, and workshop are required" },
        { status: 400 }
      );
    }

    const normalizedEmail = email.trim().toLowerCase();
    if (newPassword.length < 6) {
      return NextResponse.json(
        { error: "Password must be at least 6 characters" },
        { status: 400 }
      );
    }

    const db = adminDb();

    // Find customer
    const customerSnap = await db
      .collection("customers")
      .where("email", "==", normalizedEmail)
      .where("ownerUid", "==", ownerUid)
      .limit(1)
      .get();

    if (customerSnap.empty) {
      return NextResponse.json({ error: "Invalid or expired reset code" }, { status: 400 });
    }

    const customerDoc = customerSnap.docs[0];
    const customerId = customerDoc.id;

    // Verify reset code
    const resetDoc = await db.collection("customerPasswordResetCodes").doc(customerId).get();
    if (!resetDoc.exists) {
      return NextResponse.json({ error: "Invalid or expired reset code" }, { status: 400 });
    }

    const resetData = resetDoc.data()!;
    if (resetData.used) {
      return NextResponse.json({ error: "This reset code has already been used" }, { status: 400 });
    }
    if (resetData.code !== String(code).trim()) {
      return NextResponse.json({ error: "Invalid reset code" }, { status: 400 });
    }
    const expiresAt = resetData.expiresAt?.toDate?.() ?? new Date(resetData.expiresAt);
    if (new Date() > expiresAt) {
      return NextResponse.json({ error: "Reset code has expired. Please request a new one." }, { status: 400 });
    }

    // Update password
    const salt = crypto.randomBytes(32).toString("hex");
    const passwordHash = hashPassword(newPassword, salt);

    await db.collection("customers").doc(customerId).update({
      passwordHash,
      salt,
      updatedAt: FieldValue.serverTimestamp(),
    });

    await db.collection("customerPasswordResetCodes").doc(customerId).update({
      used: true,
      usedAt: FieldValue.serverTimestamp(),
    });

    return NextResponse.json({
      success: true,
      message: "Password reset successfully. You can now sign in with your new password.",
    });
  } catch (error: any) {
    console.error("[API] Customer reset password error:", error);
    return NextResponse.json(
      { error: "Failed to reset password. Please try again." },
      { status: 500 }
    );
  }
}
