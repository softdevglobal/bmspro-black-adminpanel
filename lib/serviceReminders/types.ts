export const SERVICE_REMINDER_COLLECTION = "serviceReminders";

export type ServiceReminderStatus = "pending" | "sent" | "cancelled";

export type ServiceReminderIntervalOption = {
  label: string;
  days: number;
};

/** Preset intervals owners can choose from. */
export const SERVICE_REMINDER_INTERVAL_OPTIONS: ServiceReminderIntervalOption[] = [
  { label: "1 month", days: 30 },
  { label: "2 months", days: 60 },
  { label: "3 months", days: 90 },
  { label: "6 months", days: 180 },
  { label: "12 months", days: 365 },
];

export const DEFAULT_SERVICE_REMINDER_INTERVAL_DAYS = 90;
export const MIN_SERVICE_REMINDER_INTERVAL_DAYS = 1;
export const MAX_SERVICE_REMINDER_INTERVAL_DAYS = 730;
/** Send an early heads-up this many days before the main reminder due date. */
export const SERVICE_REMINDER_ADVANCE_NOTICE_DAYS = 7;

export type ServiceReminderAdvanceStatus = "pending" | "sent" | "skipped" | "cancelled";

export type ServiceReminderSettings = {
  /** True once owner has saved reminder settings (always on after first save). */
  enabled: boolean;
  intervalDays: number;
  customMessage?: string;
};

export type ServiceReminderDoc = {
  bookingId: string;
  ownerUid: string;
  branchId?: string | null;
  bookingDate?: string | null;
  customerUid?: string | null;
  customerEmail?: string | null;
  customerPhone?: string | null;
  clientName: string;
  serviceName?: string | null;
  bookingCode?: string | null;
  branchName?: string | null;
  vehicleNumber?: string | null;
  completedAt: { toDate: () => Date };
  dueAt: { toDate: () => Date };
  intervalDays: number;
  status: ServiceReminderStatus;
  sentAt?: { toDate: () => Date } | null;
  advanceDueAt?: { toDate: () => Date } | null;
  advanceStatus?: ServiceReminderAdvanceStatus;
  advanceSentAt?: { toDate: () => Date } | null;
  createdAt: { toDate: () => Date };
  updatedAt: { toDate: () => Date };
};

export type BookingServiceReminderSnapshot = {
  enabled: boolean;
  intervalDays: number;
  dueAt: string;
  status: ServiceReminderStatus;
  sentAt?: string | null;
  advanceDueAt?: string | null;
  advanceStatus?: ServiceReminderAdvanceStatus;
  advanceSentAt?: string | null;
};

export function computeAdvanceReminderDueDate(
  bookingAnchor: Date,
  intervalDays: number,
): Date | null {
  if (intervalDays <= SERVICE_REMINDER_ADVANCE_NOTICE_DAYS) return null;
  const d = new Date(bookingAnchor);
  d.setDate(d.getDate() + intervalDays - SERVICE_REMINDER_ADVANCE_NOTICE_DAYS);
  return d;
}

export function isPresetIntervalDays(days: number): boolean {
  return SERVICE_REMINDER_INTERVAL_OPTIONS.some((o) => o.days === days);
}

export function isValidServiceReminderIntervalDays(days: unknown): days is number {
  if (typeof days !== "number" || !Number.isFinite(days)) return false;
  const n = Math.round(days);
  return n >= MIN_SERVICE_REMINDER_INTERVAL_DAYS && n <= MAX_SERVICE_REMINDER_INTERVAL_DAYS;
}

export function normalizeServiceReminderIntervalDays(days: unknown): number {
  if (!isValidServiceReminderIntervalDays(days)) {
    return DEFAULT_SERVICE_REMINDER_INTERVAL_DAYS;
  }
  return Math.round(days);
}

export function parseServiceReminderIntervalDays(
  days: unknown,
): { ok: true; days: number } | { ok: false; error: string } {
  if (typeof days !== "number" && typeof days !== "string") {
    return { ok: false, error: "Interval days is required." };
  }
  const n = Math.round(Number(days));
  if (!isValidServiceReminderIntervalDays(n)) {
    return {
      ok: false,
      error: `Interval must be between ${MIN_SERVICE_REMINDER_INTERVAL_DAYS} and ${MAX_SERVICE_REMINDER_INTERVAL_DAYS} days.`,
    };
  }
  return { ok: true, days: n };
}

export function formatServiceReminderDueDate(isoOrDate: string | Date): string {
  try {
    const d = typeof isoOrDate === "string" ? new Date(isoOrDate) : isoOrDate;
    if (Number.isNaN(d.getTime())) return String(isoOrDate);
    return d.toLocaleDateString("en-AU", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  } catch {
    return String(isoOrDate);
  }
}
