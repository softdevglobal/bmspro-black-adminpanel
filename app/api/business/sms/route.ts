import { NextRequest, NextResponse } from "next/server";
import { verifyAdminAuth } from "@/lib/authHelpers";
import {
  getBusinessSmsBalance,
  isDirectSmsTopUpAllowed,
  listSmsPackages,
  purchaseSmsPackageForBusiness,
} from "@/lib/sms-packages/server";
import { isSmsConfigured } from "@/lib/sms/textbee";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const auth = await verifyAdminAuth(req, ["workshop_owner"]);
  if (!auth.success || !auth.userData) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status ?? 401 });
  }

  try {
    const ownerUid = auth.userData.ownerUid;
    const balance = await getBusinessSmsBalance(ownerUid);
    const packages = await listSmsPackages({ publicOnly: true });

    return NextResponse.json({
      ok: true,
      balance,
      packages,
      smsConfigured: isSmsConfigured(),
      stripeRequired: !isDirectSmsTopUpAllowed(),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to load SMS balance";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await verifyAdminAuth(req, ["workshop_owner"]);
  if (!auth.success || !auth.userData) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status ?? 401 });
  }

  if (!isDirectSmsTopUpAllowed()) {
    return NextResponse.json(
      { ok: false, error: "Use Stripe checkout to purchase SMS credits in production." },
      { status: 403 },
    );
  }

  try {
    const body = await req.json();
    const packageId = String(body.packageId ?? "").trim();
    if (!packageId) {
      return NextResponse.json({ ok: false, error: "packageId is required" }, { status: 400 });
    }

    const { balance } = await purchaseSmsPackageForBusiness(auth.userData.ownerUid, packageId);
    return NextResponse.json({ ok: true, balance });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to purchase SMS package";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
