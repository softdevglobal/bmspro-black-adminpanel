function isoFromTimestampLike(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "object" && v !== null && typeof (v as { toDate?: () => Date }).toDate === "function") {
    try {
      const dt = (v as { toDate: () => Date }).toDate();
      if (dt && !Number.isNaN(dt.getTime())) return dt.toISOString();
    } catch {
      /* ignore */
    }
    return null;
  }
  if (typeof v === "object" && v !== null) {
    const sec =
      (v as { _seconds?: number; seconds?: number })._seconds ??
      (v as { seconds?: number }).seconds;
    if (typeof sec === "number" && Number.isFinite(sec)) {
      const ns = (v as { _nanoseconds?: number; nanoseconds?: number })._nanoseconds ?? 0;
      const ms = sec * 1000 + Math.floor(ns / 1e6);
      const dt = new Date(ms);
      if (!Number.isNaN(dt.getTime())) return dt.toISOString();
    }
  }
  return null;
}

/** Best-effort ISO string from Firestore Timestamp-like fields on a document. */
export function firestoreDocBestIso(
  d: Record<string, unknown>,
  preferredKeys: readonly string[] = ["createdAt", "updatedAt"]
): string | null {
  for (const key of preferredKeys) {
    const iso = isoFromTimestampLike(d[key]);
    if (iso) return iso;
  }
  return null;
}
