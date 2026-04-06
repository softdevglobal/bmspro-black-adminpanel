import type { Message } from "firebase-admin/messaging";

/**
 * Standard APNs config for user-visible alerts on iOS.
 * Avoids content-available + mutable-content on alert pushes (can interfere with reliable banner delivery).
 */
export function apnsAlertConfig(title: string, body: string): NonNullable<Message["apns"]> {
  return {
    headers: {
      "apns-priority": "10",
      "apns-push-type": "alert",
    },
    payload: {
      aps: {
        alert: { title, body },
        sound: "default",
        badge: 1,
      },
    },
  };
}

/** FCM requires all `data` values to be strings; coerces client JSON safely. */
export function normalizeFcmData(
  data: unknown
): Record<string, string> {
  if (data == null || typeof data !== "object" || Array.isArray(data)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    if (v === undefined || v === null) continue;
    out[k] = typeof v === "string" ? v : String(v);
  }
  return out;
}
