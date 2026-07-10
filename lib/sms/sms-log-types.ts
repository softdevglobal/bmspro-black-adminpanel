export const SMS_LOGS_COLLECTION = "sms_logs";

export type SmsLogStatus = "sent" | "failed" | "skipped";

export type SmsLogEntry = {
  id: string;
  ownerUid: string | null;
  /** Alias kept for cross-app compatibility (same value as ownerUid). */
  businessId: string | null;
  senderName: string;
  receiverPhone: string;
  receiverName: string | null;
  message: string;
  status: SmsLogStatus;
  statusDetail: string;
  source: string;
  createdAt: Date | null;
};

export type AppendSmsLogInput = {
  ownerUid?: string | null;
  businessId?: string | null;
  senderName?: string;
  receiverPhone: string;
  receiverName?: string | null;
  message: string;
  status: SmsLogStatus;
  statusDetail: string;
  source: string;
};
