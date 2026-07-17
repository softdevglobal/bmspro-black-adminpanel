/** Human-readable SMS log source (hides booking IDs, emails, etc.). */
export function formatSmsLogSource(source: string): string {
  const s = source.trim();
  if (!s) return "Unknown";

  const bookingStatus = s.match(
    /^booking\s+(Pending|Confirmed|Completed|Canceled)\s+notification\s+for\s+/i,
  );
  if (bookingStatus) {
    return `Booking · ${bookingStatus[1]}`;
  }

  if (/^booking reschedule notification for /i.test(s)) {
    return "Booking · Rescheduled";
  }

  if (/^customer welcome notification for /i.test(s)) {
    return "Customer welcome";
  }

  if (/^workshop owner welcome notification for /i.test(s)) {
    return "Owner welcome";
  }

  if (/^staff welcome notification for /i.test(s)) {
    return "Staff welcome";
  }

  if (/^additional issue quote notification for /i.test(s)) {
    return "Additional work quote";
  }

  if (/^customer password reset notification for /i.test(s)) {
    return "Password reset";
  }

  if (/^estimate reply notification for /i.test(s)) {
    return "Estimate reply";
  }

  if (s === "custom_message" || /^custom SMS to /i.test(s)) {
    return "Custom message";
  }

  if (s === "service_reminder") {
    return "Service reminder";
  }

  if (s.startsWith("bulk_message")) {
    return "Bulk message";
  }

  return s
    .replace(/\s+for\s+[a-zA-Z0-9_-]{10,}$/i, "")
    .replace(/\s+to\s+\w+\s+[a-zA-Z0-9_-]+$/i, "")
    .trim();
}

/** Human-readable delivery status detail (hides gateway batch IDs). */
export function formatSmsStatusDetail(detail: string): string {
  const d = detail.trim();
  if (!d) return "";

  if (d.startsWith("gateway_queued")) {
    return "Queued on TextBee device";
  }

  const labels: Record<string, string> = {
    delivered: "Delivered",
    quota_exceeded: "Quota exceeded",
    invalid_recipient: "Invalid phone number",
    gateway_not_configured: "TextBee not configured",
    gateway_rejected: "Rejected by gateway",
    gateway_error: "Gateway error",
    empty_message: "Empty message",
  };

  return labels[d] ?? d;
}
