import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { adminAuth, adminDb } from "@/lib/firebaseAdmin";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const token = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return NextResponse.json({ error: "Sign in as a workshop owner to update this permission." }, { status: 401 });

  let decoded: Awaited<ReturnType<ReturnType<typeof adminAuth>["verifyIdToken"]>>;
  try {
    decoded = await adminAuth().verifyIdToken(token);
  } catch {
    return NextResponse.json({ error: "Your session is invalid or has expired." }, { status: 401 });
  }

  let body: unknown;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  if (!body || typeof body !== "object" || typeof (body as Record<string, unknown>).enabled !== "boolean") {
    return NextResponse.json({ error: "enabled must be true or false." }, { status: 400 });
  }

  try {
    const db = adminDb();
    const ownerRef = db.collection("users").doc(decoded.uid);
    const owner = await ownerRef.get();
    if (!owner.exists || owner.data()?.role !== "workshop_owner") {
      return NextResponse.json({ error: "Only the workshop owner can grant Sophie booking authority." }, { status: 403 });
    }
    const enabled = (body as Record<string, unknown>).enabled as boolean;
    await ownerRef.update({
      sophieBookingAuthority: enabled,
      sophieBookingAuthorityUpdatedBy: decoded.uid,
      sophieBookingAuthorityUpdatedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return NextResponse.json({ success: true, enabled });
  } catch (error) {
    console.error("[owner-settings/ai-booking-authority] Failed to save owner permission:", error);
    return NextResponse.json({ error: "Could not save Sophie booking authority." }, { status: 500 });
  }
}
