export type GreetingAudience = "customers" | "staff" | "both";

export type GreetingRecipientType = "customer" | "staff";

export type GreetingRecipient = {
  id: string;
  name: string;
  phone: string;
  type: GreetingRecipientType;
};

export type GreetingSendResult = {
  sent: number;
  failed: number;
  skipped: number;
  total: number;
  errors: string[];
};

export const GREETING_AUDIENCE_LABELS: Record<GreetingAudience, string> = {
  customers: "Customers",
  staff: "Staff members",
  both: "Customers & staff",
};

export const MAX_GREETING_MESSAGE_LENGTH = 320;

export function isValidGreetingAudience(value: unknown): value is GreetingAudience {
  return value === "customers" || value === "staff" || value === "both";
}
