import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";
import { verifyAdminAuth } from "@/lib/authHelpers";

export const runtime = "nodejs";

/** Lightweight workshop profile for document previews (name shown on quotes/invoices). */
export async function GET(req: NextRequest) {
  const auth = await verifyAdminAuth(req, ["workshop_owner", "branch_admin"]);
  if (!auth.success || !auth.userData) {
    return NextResponse.json(
      { ok: false, error: auth.error },
      { status: auth.status || 401 },
    );
  }

  try {
    const doc = await adminDb().doc(`users/${auth.userData.ownerUid}`).get();
    const data = doc.exists ? doc.data() || {} : {};
    const businessName =
      (data.workshopName as string) ||
      (data.salonName as string) ||
      (data.name as string) ||
      (data.businessName as string) ||
      (data.displayName as string) ||
      "Workshop";

    return NextResponse.json({
      ok: true,
      businessName,
      email: (data.email as string) || "",
      phone: (data.phone as string) || "",
    });
  } catch (error) {
    console.error("[business-profile GET] Error:", error);
    return NextResponse.json(
      { ok: false, error: "Could not load business profile." },
      { status: 500 },
    );
  }
}
