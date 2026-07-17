export {
  isSmsConfigured,
  normalizeSmsRecipient,
  sendBulkSms,
  toE164,
} from "./sms/textbee";
export type { SmsSendResult, SmsSendStatus } from "./sms/textbee";

import { normalizeSmsRecipient, sendSms as sendSmsCore } from "./sms/textbee";

/** Legacy result shape used across the app. */
export type SendSmsResult = {
  success: boolean;
  skipped?: boolean;
  statusDetail?: string;
  recipient?: string | null;
  error?: string;
};

export async function sendSms(params: {
  to: string | null | undefined;
  message: string;
  context?: string;
  source?: string;
  ownerUid?: string | null;
  businessId?: string | null;
  senderName?: string;
  receiverName?: string | null;
}): Promise<SendSmsResult> {
  const result = await sendSmsCore({
    to: params.to,
    message: params.message,
    ownerUid: params.ownerUid ?? params.businessId,
    source: params.source ?? params.context ?? "legacy",
    senderName: params.senderName,
    receiverName: params.receiverName,
  });
  return {
    success: result.ok,
    skipped: result.status === "skipped",
    statusDetail: result.statusDetail,
    recipient: normalizeSmsRecipient(params.to),
    error: result.error,
  };
}
