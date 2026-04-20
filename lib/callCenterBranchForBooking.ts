import type { DocumentData } from "firebase-admin/firestore";

/**
 * Normalized branch payload for call-center booking UIs and APIs.
 * Merges weekly `hours`, per-day open/close for a given date, and `bookingLimitPerDay`.
 */
export type CallCenterBranchDaySchedule = {
  dayOfWeek: string;
  closed: boolean;
  /** Local branch time HH:mm when open */
  open: string | null;
  /** Local branch time HH:mm when open */
  close: string | null;
};

export type CallCenterBranchBookingDetails = {
  id: string;
  name: string;
  address: string;
  phone: string;
  email: string;
  timezone: string;
  status: string;
  /** Weekly hours from Firestore (e.g. Monday: { open, close, closed? }) */
  hours: Record<string, unknown> | null;
  /**
   * Open/close for every weekday — **no `date` query required** on GET /branches/...
   */
  daySchedules: Record<string, CallCenterBranchDaySchedule>;
  /**
   * Convenience copy of `daySchedules[weekday]` when optional `?date=YYYY-MM-DD` is passed
   * (the weekday of that calendar date). Otherwise null.
   */
  daySchedule: CallCenterBranchDaySchedule | null;
  /** Max bookings counted toward the daily cap, or null if unlimited / unset */
  bookingLimitPerDay: number | null;
};

export function getDayOfWeekFromYmd(dateStr: string): string {
  const dateObj = new Date(dateStr + "T12:00:00");
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  return days[dateObj.getDay()];
}

export function resolveBranchDaySchedule(
  hours: unknown,
  dayOfWeek: string
): CallCenterBranchDaySchedule {
  if (!hours || typeof hours !== "object" || Array.isArray(hours)) {
    return { dayOfWeek, closed: true, open: null, close: null };
  }
  const h = hours as Record<string, { open?: string; close?: string; closed?: boolean }>;
  const dayHours = h[dayOfWeek];
  if (!dayHours || dayHours.closed) {
    return { dayOfWeek, closed: true, open: null, close: null };
  }
  return {
    dayOfWeek,
    closed: false,
    open: (dayHours.open || "09:00").toString(),
    close: (dayHours.close || "17:00").toString(),
  };
}

const WEEKDAYS_ORDERED = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/** Resolved open/close for each weekday from branch `hours`. */
export function buildAllDaySchedules(hours: unknown): Record<string, CallCenterBranchDaySchedule> {
  const out: Record<string, CallCenterBranchDaySchedule> = {};
  for (const day of WEEKDAYS_ORDERED) {
    out[day] = resolveBranchDaySchedule(hours, day);
  }
  return out;
}

/** `{ open, close }` for slot generation, or null if closed / invalid */
export function branchHoursWindowFromSchedule(
  schedule: CallCenterBranchDaySchedule
): { open: string; close: string } | null {
  if (schedule.closed || !schedule.open || !schedule.close) return null;
  return { open: schedule.open, close: schedule.close };
}

/**
 * Build the branch object returned on GET /call-center/branches/[branchId] and inside
 * GET /call-center/bookings/availability.
 *
 * @param highlightDateYmd optional `YYYY-MM-DD`; if set, `daySchedule` duplicates that weekday’s entry in `daySchedules`.
 */
export function serializeCallCenterBranchForBooking(
  branchId: string,
  data: DocumentData | undefined,
  highlightDateYmd: string | null
): CallCenterBranchBookingDetails | null {
  if (!data) return null;
  const rawHours = data.hours;
  const hours =
    rawHours && typeof rawHours === "object" && !Array.isArray(rawHours)
      ? (rawHours as Record<string, unknown>)
      : null;
  const daySchedules = buildAllDaySchedules(hours);
  let daySchedule: CallCenterBranchDaySchedule | null = null;
  if (highlightDateYmd && /^\d{4}-\d{2}-\d{2}$/.test(highlightDateYmd.trim())) {
    const dow = getDayOfWeekFromYmd(highlightDateYmd.trim());
    daySchedule = daySchedules[dow] ?? null;
  }
  return {
    id: branchId,
    name: (data.name || "").toString(),
    address: (data.address || data.locationText || "").toString(),
    phone: (data.phone || "").toString(),
    email: (data.email || "").toString(),
    timezone: (data.timezone || "Australia/Sydney").toString(),
    status: (data.status || "Active").toString(),
    hours,
    daySchedules,
    daySchedule,
    bookingLimitPerDay:
      typeof data.bookingLimitPerDay === "number" ? data.bookingLimitPerDay : null,
  };
}
