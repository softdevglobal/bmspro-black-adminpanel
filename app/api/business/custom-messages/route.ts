import { NextRequest, NextResponse } from "next/server";
import { verifyAdminAuth } from "@/lib/authHelpers";
import { getBusinessSmsBalance } from "@/lib/sms-packages/server";
import { loadCustomerRecipients } from "@/lib/greetingMessages/server";
import { sendBulkSms, isSmsConfigured } from "@/lib/sms/textbee";

export const runtime = "nodejs";

const MAX_CUSTOM_MESSAGE_LENGTH = 480;

export async function GET(req: NextRequest) {
  const auth = await verifyAdminAuth(req, ["workshop_owner"]);
  if (!auth.success || !auth.userData) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status ?? 401 });
  }

  try {
    const ownerUid = auth.userData.ownerUid;
    const [balance, customers] = await Promise.all([
      getBusinessSmsBalance(ownerUid),
      loadCustomerRecipients(ownerUid),
    ]);

    return NextResponse.json({
      ok: true,
      balance,
      customers,
      smsConfigured: isSmsConfigured(),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to load custom message data";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await verifyAdminAuth(req, ["workshop_owner"]);
  if (!auth.success || !auth.userData) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status ?? 401 });
  }

  try {
    const body = await req.json();
    const message = String(body.message ?? "").trim();
    const phones = Array.isArray(body.phones) ? body.phones.map(String) : [];

    if (!message) {
      return NextResponse.json({ ok: false, error: "Message is required" }, { status: 400 });
    }
    if (message.length > MAX_CUSTOM_MESSAGE_LENGTH) {
      return NextResponse.json(
        { ok: false, error: `Message must be ${MAX_CUSTOM_MESSAGE_LENGTH} characters or fewer` },
        { status: 400 },
      );
    }
    if (phones.length === 0) {
      return NextResponse.json({ ok: false, error: "Select at least one recipient" }, { status: 400 });
    }

    const result = await sendBulkSms(
      phones,
      message,
      auth.userData.ownerUid,
      "custom_message",
    );

    return NextResponse.json({ ok: true, result });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to send custom messages";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
