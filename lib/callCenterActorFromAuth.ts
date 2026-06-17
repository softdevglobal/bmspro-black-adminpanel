import type { CallCenterRequestAuth } from "@/lib/callCenterAuth";
import { adminDb } from "@/lib/firebaseAdmin";

/** Authenticated user performing a call-center notification action (agent or BMS staff). */
export function actorFromCallCenterAuth(auth: CallCenterRequestAuth): {
  uid: string;
  name: string;
  email: string;
} {
  if (auth.kind === "agent") {
    return {
      uid: auth.user.uid,
      name: String(auth.user.name || "").trim() || "Agent",
      email: String(auth.user.email || "").trim(),
    };
  }
  return {
    uid: auth.uid,
    name: String(auth.name || "").trim() || "Staff",
    email: String(auth.email || "").trim(),
  };
}

export type NotificationActorSnapshot = {
  uid: string;
  /** Prefer `displayName` from `call_center_agents` / `users` for call-center UI. */
  displayName: string;
  email: string;
  role: string;
  recordedByKind: "agent" | "tenant_admin";
};

function roleFromAgentDoc(d: FirebaseFirestore.DocumentData | undefined, fallback: string): string {
  const r = String(d?.role || fallback || "agent").trim().toLowerCase();
  return r || "agent";
}

function roleFromUserDoc(d: FirebaseFirestore.DocumentData | undefined, fallback: string): string {
  const r = String(d?.role || d?.systemRole || fallback || "").trim().toLowerCase();
  return r || fallback || "staff";
}

function labelFromEmail(email: string, fallback: string): string {
  const e = email.trim();
  if (!e) return fallback;
  const local = e.split("@")[0]?.trim();
  return local || fallback;
}

/**
 * Loads the latest display name from Firestore (`call_center_agents` or `users`) so saved
 * notification attribution matches what the call-center UI shows.
 */
export async function resolveNotificationActorSnapshot(
  auth: CallCenterRequestAuth
): Promise<NotificationActorSnapshot> {
  const db = adminDb();
  try {
    if (auth.kind === "agent") {
      const doc = await db.doc(`call_center_agents/${auth.user.uid}`).get();
      const d = doc.data();
      const email = String(d?.email || auth.user.email || "").trim();
      const displayName = String(d?.displayName || d?.name || auth.user.name || "").trim();
      return {
        uid: auth.user.uid,
        email,
        displayName: displayName || labelFromEmail(email, "Agent"),
        role: roleFromAgentDoc(d, auth.user.role),
        recordedByKind: "agent",
      };
    }
    const doc = await db.doc(`users/${auth.uid}`).get();
    const d = doc.data();
    const email = String(d?.email || auth.email || "").trim();
    const displayName = String(d?.displayName || d?.name || auth.name || "").trim();
    const role = auth.isSuperAdmin
      ? "super_admin"
      : roleFromUserDoc(d, auth.role);
    return {
      uid: auth.uid,
      email,
      displayName: displayName || labelFromEmail(email, "Staff"),
      role,
      recordedByKind: "tenant_admin",
    };
  } catch (e) {
    console.warn("[resolveNotificationActorSnapshot] fallback to token claims", e);
    const a = actorFromCallCenterAuth(auth);
    return {
      uid: a.uid,
      email: a.email,
      displayName: a.name,
      role: auth.kind === "agent" ? auth.user.role : auth.role,
      recordedByKind: auth.kind === "agent" ? "agent" : "tenant_admin",
    };
  }
}

/** Actor fields stored on `agent_activities` — always derived from the Bearer token (+ Firestore profile). */
export async function resolveAgentActivityActor(
  auth: CallCenterRequestAuth
): Promise<NotificationActorSnapshot> {
  return resolveNotificationActorSnapshot(auth);
}
