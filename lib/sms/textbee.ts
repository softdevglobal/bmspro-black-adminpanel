import "server-only";

import { adminDb } from "@/lib/firebaseAdmin";
import { normalizePhoneDigits } from "@/lib/customerAccount";
import { appendSmsLog } from "@/lib/sms/sms-log-server";
import { releaseSmsCredits, tryConsumeSmsCredits } from "@/lib/sms/usage";

const TEXTBEE_API_KEY = process.env.TEXTBEE_API_KEY;
const TEXTBEE_DEVICE_ID = process.env.TEXTBEE_DEVICE_ID;
const TEXTBEE_API_BASE =
  process.env.TEXTBEE_API_BASE || process.env.TEXTBEE_API_BASE_URL || "https://api.textbee.dev/api/v1";
const TEXTBEE_DEFAULT_COUNTRY_CODE = process.env.TEXTBEE_DEFAULT_COUNTRY_CODE || "+61";
const TEXTBEE_SUPPORTED_COUNTRY_CODES = process.env.TEXTBEE_SUPPORTED_COUNTRY_CODES || "+61,+94";
const TEXTBEE_SIM_SUBSCRIPTION_ID = process.env.TEXTBEE_SIM_SUBSCRIPTION_ID;

export type SmsSendStatus = "sent" | "failed" | "skipped";

export type SmsSendResult = {
  ok: boolean;
  status: SmsSendStatus;
  statusDetail: string;
  error?: string;
};

type SendSmsParams = {
  to: string | null | undefined;
  message: string;
  ownerUid?: string | null;
  businessId?: string | null;
  source?: string;
  senderName?: string;
  receiverName?: string | null;
};

function normalizeCountryCode(countryCode: string): string {
  const digits = normalizePhoneDigits(countryCode);
  return digits ? `+${digits}` : "+61";
}

function getSupportedCountryDigits(): string[] {
  return TEXTBEE_SUPPORTED_COUNTRY_CODES.split(",")
    .map((code) => normalizePhoneDigits(code))
    .filter(Boolean);
}

export function toE164(phone: string | null | undefined): string | null {
  return normalizeSmsRecipient(phone);
}

function resolveLocalNumberCountryCode(localDigits: string): string | null {
  const defaultCountryCode = normalizeCountryCode(TEXTBEE_DEFAULT_COUNTRY_CODE);
  const supportedCountryDigits = getSupportedCountryDigits();

  // Sri Lanka mobiles: 7XXXXXXXX (9 digits) after stripping a leading 0
  if (
    localDigits.startsWith("7") &&
    localDigits.length === 9 &&
    supportedCountryDigits.includes("94")
  ) {
    return "+94";
  }

  // Australian mobiles: 4XXXXXXXX (9 digits) after stripping a leading 0
  if (
    localDigits.startsWith("4") &&
    localDigits.length === 9 &&
    supportedCountryDigits.includes("61")
  ) {
    return "+61";
  }

  return defaultCountryCode;
}

export function normalizeSmsRecipient(phone: string | null | undefined): string | null {
  const raw = String(phone ?? "").trim();
  if (!raw) return null;

  if (raw.startsWith("+")) {
    const digits = normalizePhoneDigits(raw);
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  }

  if (raw.startsWith("00")) {
    const digits = normalizePhoneDigits(raw.slice(2));
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  }

  const digits = normalizePhoneDigits(raw);
  if (digits.length < 8 || digits.length > 15) return null;

  const defaultCountryCode = normalizeCountryCode(TEXTBEE_DEFAULT_COUNTRY_CODE);
  const supportedCountryDigits = getSupportedCountryDigits();

  if (
    supportedCountryDigits.some(
      (countryDigits) => digits.startsWith(countryDigits) && digits.length > countryDigits.length,
    )
  ) {
    return `+${digits}`;
  }

  if (digits.startsWith("0")) {
    const localDigits = digits.slice(1);
    const countryCode = resolveLocalNumberCountryCode(localDigits);
    return `${countryCode}${localDigits}`;
  }

  return `${defaultCountryCode}${digits}`;
}

export function isSmsConfigured(): boolean {
  return !!TEXTBEE_API_KEY && !!TEXTBEE_DEVICE_ID;
}

async function resolveSenderName(ownerUid: string | null, override?: string): Promise<string> {
  if (override?.trim()) return override.trim();
  if (!ownerUid) return "System";

  try {
    const snap = await adminDb().collection("users").doc(ownerUid).get();
    if (snap.exists) {
      const data = snap.data();
      return (
        data?.workshopName ||
        data?.salonName ||
        data?.businessName ||
        data?.name ||
        data?.displayName ||
        "Workshop"
      );
    }
  } catch (error) {
    console.error("[SMS] Failed to resolve sender name:", error);
  }
  return "Workshop";
}

type TextBeeSendResponse = {
  data?: {
    success?: boolean;
    message?: string;
    smsBatchId?: string;
    recipientCount?: number;
  };
  success?: boolean;
  message?: string;
  error?: string;
};

async function postToGateway(recipient: string, message: string): Promise<SmsSendResult> {
  try {
    const body: Record<string, unknown> = {
      recipients: [recipient],
      message,
    };
    if (TEXTBEE_SIM_SUBSCRIPTION_ID) {
      body.simSubscriptionId = Number(TEXTBEE_SIM_SUBSCRIPTION_ID);
    }

    const apiBase = TEXTBEE_API_BASE.replace(/\/+$/, "");
    const response = await fetch(
      `${apiBase}/gateway/devices/${encodeURIComponent(TEXTBEE_DEVICE_ID as string)}/send-sms`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": TEXTBEE_API_KEY as string,
        },
        body: JSON.stringify(body),
      },
    );

    const responseText = await response.text();
    let payload: TextBeeSendResponse | null = null;
    try {
      payload = responseText ? (JSON.parse(responseText) as TextBeeSendResponse) : null;
    } catch {
      payload = null;
    }

    if (!response.ok) {
      console.error("[SMS] TextBee send failed:", response.status, responseText);
      return {
        ok: false,
        status: "failed",
        statusDetail: "gateway_rejected",
        error: payload?.error || payload?.message || `Gateway rejected (${response.status})`,
      };
    }

    const accepted =
      payload?.data?.success === true ||
      payload?.success === true ||
      /queue/i.test(payload?.data?.message ?? payload?.message ?? "");

    if (!accepted) {
      console.error("[SMS] TextBee unexpected response:", responseText);
      return {
        ok: false,
        status: "failed",
        statusDetail: "gateway_rejected",
        error: payload?.error || payload?.message || "Gateway did not accept the message",
      };
    }

    const batchId = payload?.data?.smsBatchId;
    const queueMessage = payload?.data?.message || payload?.message || "queued for device";
    console.log("[SMS] TextBee accepted message (queued on Android device)", {
      recipient,
      smsBatchId: batchId ?? null,
      queueMessage,
    });

    return {
      ok: true,
      status: "sent",
      statusDetail: batchId ? `gateway_queued:${batchId}` : "gateway_queued",
    };
  } catch (error: unknown) {
    console.error("[SMS] TextBee error:", error);
    return {
      ok: false,
      status: "failed",
      statusDetail: "gateway_error",
      error: error instanceof Error ? error.message : "Gateway error",
    };
  }
}

export async function sendSms(params: SendSmsParams): Promise<SmsSendResult> {
  const ownerUid = params.ownerUid ?? params.businessId ?? null;
  const source = params.source ?? "unknown";
  const message = params.message.trim();
  const recipient = normalizeSmsRecipient(params.to);
  const senderName = await resolveSenderName(ownerUid, params.senderName);

  const logBase = {
    ownerUid,
    businessId: ownerUid,
    senderName,
    receiverPhone: recipient ?? String(params.to ?? ""),
    receiverName: params.receiverName ?? null,
    message: message || params.message,
    source,
  };

  if (!recipient) {
    const result: SmsSendResult = {
      ok: false,
      status: "skipped",
      statusDetail: "invalid_recipient",
      error: "Invalid phone number",
    };
    console.warn(`[SMS] Skipped (${source}): invalid recipient`, { raw: params.to ?? null });
    await appendSmsLog({ ...logBase, status: "skipped", statusDetail: result.statusDetail });
    return result;
  }

  if (!message) {
    const result: SmsSendResult = {
      ok: false,
      status: "skipped",
      statusDetail: "empty_message",
      error: "SMS message is empty",
    };
    console.warn(`[SMS] Skipped (${source}): empty message`);
    await appendSmsLog({ ...logBase, receiverPhone: recipient, status: "skipped", statusDetail: result.statusDetail });
    return result;
  }

  if (!isSmsConfigured()) {
    const result: SmsSendResult = {
      ok: false,
      status: "skipped",
      statusDetail: "gateway_not_configured",
      error: "TextBee is not configured",
    };
    console.warn(`[SMS] Skipped (${source}): TextBee not configured`);
    await appendSmsLog({ ...logBase, receiverPhone: recipient, message, status: "skipped", statusDetail: result.statusDetail });
    return result;
  }

  let creditsReserved = false;
  if (ownerUid) {
    const consume = await tryConsumeSmsCredits(ownerUid, 1);
    if (!consume.ok) {
      const result: SmsSendResult = {
        ok: false,
        status: "skipped",
        statusDetail: "quota_exceeded",
        error: "SMS quota exceeded",
      };
      console.warn(`[SMS] Skipped (${source}): quota exceeded for owner ${ownerUid}`);
      await appendSmsLog({ ...logBase, receiverPhone: recipient, message, status: "skipped", statusDetail: result.statusDetail });
      return result;
    }
    creditsReserved = !consume.unlimited;
  }

  console.log(`[SMS] Sending (${source}) to ${recipient}`, { ownerUid: ownerUid ?? null });

  const gateway = await postToGateway(recipient, message);

  if (gateway.ok) {
    console.log(`[SMS] Queued on TextBee device (${source}) to ${recipient}`, {
      statusDetail: gateway.statusDetail,
    });
  } else {
    console.error(`[SMS] Failed (${source}) to ${recipient}:`, gateway.error);
  }

  if (!gateway.ok && creditsReserved && ownerUid) {
    await releaseSmsCredits(ownerUid, 1);
  }

  await appendSmsLog({
    ...logBase,
    receiverPhone: recipient,
    message,
    status: gateway.status,
    statusDetail: gateway.statusDetail,
  });

  return gateway;
}

export async function sendBulkSms(
  phones: string[],
  message: string,
  ownerUid?: string | null,
  source = "bulk_message",
  senderName?: string,
): Promise<{ sent: number; failed: number; skipped: number; total: number }> {
  const uniquePhones = [
    ...new Set(
      phones.map((phone) => normalizeSmsRecipient(phone)).filter((phone): phone is string => !!phone),
    ),
  ];

  const result = { sent: 0, failed: 0, skipped: 0, total: uniquePhones.length };

  for (const phone of uniquePhones) {
    const single = await sendSms({ to: phone, message, ownerUid, source, senderName });
    if (single.status === "sent") result.sent += 1;
    else if (single.status === "skipped") result.skipped += 1;
    else result.failed += 1;
  }

  return result;
}
