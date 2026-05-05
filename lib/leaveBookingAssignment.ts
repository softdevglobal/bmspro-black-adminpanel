/**
 * Whether an approved leave_requests document blocks assigning staff on a booking calendar day.
 * Matches Flutter `approvedLeaveBlocksBookingOnDate` (dayDetails + start/end range).
 */
function ymd(d: Date): string {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${y}-${mo}-${da}`;
}

export function parseBookingYmd(dateStr: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr).trim());
  if (!m) return null;
  return new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
}

function toJsDate(v: unknown): Date | null {
  if (v == null) return null;
  if (typeof v === "object" && v !== null && "toDate" in v && typeof (v as { toDate: () => Date }).toDate === "function") {
    return (v as { toDate: () => Date }).toDate();
  }
  if (typeof v === "string") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

export function approvedLeaveBlocksBookingOnDate(
  leave: Record<string, unknown>,
  bookingDay: Date,
): boolean {
  const status = String(leave.status ?? "").toLowerCase();
  if (status !== "approved") return false;

  const bd = new Date(bookingDay.getFullYear(), bookingDay.getMonth(), bookingDay.getDate());
  const bookingKey = ymd(bd);

  const startDate = toJsDate(leave.startDate);
  let endDate = toJsDate(leave.endDate);
  if (!startDate) return false;
  if (!endDate) endDate = startDate;

  const startOnly = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
  const endOnly = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());
  const inCalendarRange = bd.getTime() >= startOnly.getTime() && bd.getTime() <= endOnly.getTime();

  const details = leave.dayDetails;
  if (Array.isArray(details) && details.length > 0) {
    for (const item of details) {
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      let key: string | null = null;
      const raw = row.date;
      const fromTs = toJsDate(raw);
      if (fromTs) {
        key = ymd(new Date(fromTs.getFullYear(), fromTs.getMonth(), fromTs.getDate()));
      } else if (raw != null) {
        const str = String(raw).trim();
        key = str.length >= 10 ? str.substring(0, 10) : str;
      }
      if (key === bookingKey) return true;
    }
    return inCalendarRange;
  }

  return inCalendarRange;
}

export function collectStaffIdsOnApprovedLeaveForDate(
  leaveDocs: Array<{ data: () => Record<string, unknown> }>,
  bookingDay: Date,
): Set<string> {
  const out = new Set<string>();
  for (const doc of leaveDocs) {
    const d = doc.data();
    const staffId = String(d.staffId ?? "").trim();
    if (!staffId) continue;
    if (approvedLeaveBlocksBookingOnDate(d, bookingDay)) {
      out.add(staffId);
    }
  }
  return out;
}
