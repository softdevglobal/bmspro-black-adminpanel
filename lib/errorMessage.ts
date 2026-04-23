/** Pull a readable message from unknown catch values (e.g. FirebaseError). */
export function getErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) {
    const m = err.message.trim();
    if (m) return m.length > 220 ? `${m.slice(0, 217)}…` : m;
  }
  if (typeof err === "object" && err !== null && "message" in err) {
    const m = String((err as { message: unknown }).message).trim();
    if (m && m !== "undefined") return m.length > 220 ? `${m.slice(0, 217)}…` : m;
  }
  return fallback;
}
