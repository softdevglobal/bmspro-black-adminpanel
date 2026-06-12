import { normalizePhoneDigits } from "./customerAccount";

const TEXTBEE_API_KEY = process.env.TEXTBEE_API_KEY;
const TEXTBEE_DEVICE_ID = process.env.TEXTBEE_DEVICE_ID;
const TEXTBEE_API_BASE_URL = process.env.TEXTBEE_API_BASE_URL || "https://api.textbee.dev";
const TEXTBEE_DEFAULT_COUNTRY_CODE = process.env.TEXTBEE_DEFAULT_COUNTRY_CODE || "+61";
const TEXTBEE_SUPPORTED_COUNTRY_CODES = process.env.TEXTBEE_SUPPORTED_COUNTRY_CODES || "+61,+94";
const TEXTBEE_SIM_SUBSCRIPTION_ID = process.env.TEXTBEE_SIM_SUBSCRIPTION_ID;

export type SendSmsResult = {
  success: boolean;
  skipped?: boolean;
  error?: string;
};

type SendSmsParams = {
  to: string | null | undefined;
  message: string;
  context?: string;
};

function normalizeCountryCode(countryCode: string): string {
  const digits = normalizePhoneDigits(countryCode);
  return digits ? `+${digits}` : "+61";
}

function getSupportedCountryDigits(): string[] {
  return TEXTBEE_SUPPORTED_COUNTRY_CODES
    .split(",")
    .map((code) => normalizePhoneDigits(code))
    .filter(Boolean);
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
    return `${defaultCountryCode}${digits.slice(1)}`;
  }

  return `${defaultCountryCode}${digits}`;
}

export function isSmsConfigured(): boolean {
  return !!TEXTBEE_API_KEY && !!TEXTBEE_DEVICE_ID;
}

export async function sendSms(params: SendSmsParams): Promise<SendSmsResult> {
  const recipient = normalizeSmsRecipient(params.to);
  const context = params.context ? ` (${params.context})` : "";

  if (!recipient) {
    console.warn(`[SMS] Skipping SMS${context}: missing or invalid phone number`);
    return { success: false, skipped: true, error: "Invalid phone number" };
  }

  if (!isSmsConfigured()) {
    console.warn(`[SMS] Skipping SMS to ${recipient}${context}: TextBee is not configured`);
    return { success: false, skipped: true, error: "TextBee is not configured" };
  }

  const message = params.message.trim();
  if (!message) {
    return { success: false, skipped: true, error: "SMS message is empty" };
  }

  try {
    const body: Record<string, unknown> = {
      recipients: [recipient],
      message,
    };
    if (TEXTBEE_SIM_SUBSCRIPTION_ID) {
      body.simSubscriptionId = Number(TEXTBEE_SIM_SUBSCRIPTION_ID);
    }

    const response = await fetch(
      `${TEXTBEE_API_BASE_URL.replace(/\/+$/, "")}/api/v1/gateway/devices/${encodeURIComponent(
        TEXTBEE_DEVICE_ID as string,
      )}/send-sms`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": TEXTBEE_API_KEY as string,
        },
        body: JSON.stringify(body),
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[SMS] TextBee send failed${context}:`, response.status, errorText);
      return {
        success: false,
        error: `TextBee send failed with status ${response.status}`,
      };
    }

    console.log(`[SMS] TextBee SMS sent to ${recipient}${context}`);
    return { success: true };
  } catch (error: unknown) {
    console.error(`[SMS] Error sending TextBee SMS${context}:`, error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to send SMS",
    };
  }
}
