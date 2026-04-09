import type { Firestore } from "firebase-admin/firestore";

export type ActorProfile = {
  email: string | null;
  displayName: string | null;
  name: string | null;
};

/** Load display + email for call-center POST attribution (agents + BMS users). Batched `getAll`. */
export async function loadActorProfilesByUid(
  db: Firestore,
  uids: string[]
): Promise<Map<string, ActorProfile>> {
  const map = new Map<string, ActorProfile>();
  const unique = [...new Set(uids.map((u) => String(u).trim()).filter(Boolean))];
  for (let i = 0; i < unique.length; i += 10) {
    const chunk = unique.slice(i, i + 10);
    const agentSnaps = await db.getAll(...chunk.map((uid) => db.doc(`call_center_agents/${uid}`)));
    const needUser: string[] = [];
    for (let j = 0; j < chunk.length; j++) {
      const uid = chunk[j];
      const s = agentSnaps[j];
      if (s.exists) {
        const d = s.data()!;
        const email = String(d.email || "").trim() || null;
        const displayName = String(d.displayName || d.name || "").trim() || null;
        map.set(uid, { email, displayName, name: displayName });
      } else {
        needUser.push(uid);
      }
    }
    if (needUser.length === 0) continue;
    const userSnaps = await db.getAll(...needUser.map((uid) => db.doc(`users/${uid}`)));
    for (let j = 0; j < needUser.length; j++) {
      const uid = needUser[j];
      if (map.has(uid)) continue;
      const s = userSnaps[j];
      if (!s.exists) continue;
      const d = s.data()!;
      const email = String(d.email || "").trim() || null;
      const displayName = String(d.displayName || d.name || "").trim() || null;
      map.set(uid, { email, displayName, name: displayName });
    }
  }
  return map;
}

export type NotificationAgentTrackingFields = {
  notificationReviewedByUid: string | null;
  notificationReviewedByName: string | null;
  notificationReviewedByDisplayName: string | null;
  notificationReviewedByEmail: string | null;
  calledCustomerByUid: string | null;
  calledCustomerByName: string | null;
  calledCustomerByDisplayName: string | null;
  calledCustomerByEmail: string | null;
};

/** Fill missing *By* strings from `call_center_agents` / `users` when a UID is present. */
export function enrichNotificationAgentTrackingFromProfiles<T extends NotificationAgentTrackingFields>(
  row: T,
  profiles: Map<string, ActorProfile>
): T {
  const next = { ...row };
  const revUid = next.notificationReviewedByUid?.trim();
  if (revUid) {
    const p = profiles.get(revUid);
    if (p) {
      if (!next.notificationReviewedByEmail?.trim() && p.email) {
        next.notificationReviewedByEmail = p.email;
      }
      if (!next.notificationReviewedByDisplayName?.trim() && p.displayName) {
        next.notificationReviewedByDisplayName = p.displayName;
      }
      if (!next.notificationReviewedByName?.trim()) {
        next.notificationReviewedByName =
          p.displayName || (p.email ? p.email.split("@")[0] : null) || p.name;
      }
    }
  }
  const callUid = next.calledCustomerByUid?.trim();
  if (callUid) {
    const p = profiles.get(callUid);
    if (p) {
      if (!next.calledCustomerByEmail?.trim() && p.email) {
        next.calledCustomerByEmail = p.email;
      }
      if (!next.calledCustomerByDisplayName?.trim() && p.displayName) {
        next.calledCustomerByDisplayName = p.displayName;
      }
      if (!next.calledCustomerByName?.trim()) {
        next.calledCustomerByName =
          p.displayName || (p.email ? p.email.split("@")[0] : null) || p.name;
      }
    }
  }
  return next;
}
