import type { DocumentData, DocumentReference } from "firebase-admin/firestore";
import { getAdminApp } from "@/lib/firebaseAdmin";

/** Firestore rejects `undefined` in writes; strip so partial updates never fail silently. */
export function stripUndefinedFirestorePatch(patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * Merge tracking fields and read back the same ref so API responses match what Firestore stored.
 * Uses `set(..., { merge: true })` instead of `update` for consistent behavior across doc shapes.
 */
export async function mergeAndReadNotificationTracking(
  ref: DocumentReference,
  patch: Record<string, unknown>
): Promise<{ projectId: string | undefined; data: DocumentData | undefined }> {
  const cleaned = stripUndefinedFirestorePatch(patch);
  await ref.set(cleaned, { merge: true });
  const snap = await ref.get();
  const projectId = getAdminApp().options.projectId;
  return { projectId, data: snap.data() };
}
