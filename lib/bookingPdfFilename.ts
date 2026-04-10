/**
 * Download / modal title for job report PDF — matches booking code when present.
 */
export function bookingJobReportPdfFilename(
  bookingCode: string | null | undefined,
  bookingId: string
): string {
  const code = typeof bookingCode === "string" ? bookingCode.trim() : "";
  if (code) {
    const safe = code.replace(/[/\\?%*:|"<>]/g, "-").slice(0, 180);
    return `${safe}.pdf`;
  }
  const short = bookingId.replace(/[/\\?%*:|"<>]/g, "").slice(0, 8) || "report";
  return `Job-Report-${short}.pdf`;
}
