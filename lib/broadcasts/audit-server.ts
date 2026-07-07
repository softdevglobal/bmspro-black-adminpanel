import "server-only";

import { adminDb } from "@/lib/firebaseAdmin";
import { FieldValue } from "firebase-admin/firestore";

type CustomNotificationActor = {
  uid: string;
  email: string | null;
  name: string | null;
};

function platformSummary(platforms: { admin: boolean; mobile: boolean }): string {
  const parts: string[] = [];
  if (platforms.admin) parts.push("admin panel");
  if (platforms.mobile) parts.push("mobile app");
  return parts.length ? parts.join(" + ") : "no platform";
}

function audienceSummary(audience: "owners" | "all"): string {
  return audience === "all" ? "owners and staff" : "owners only";
}

async function writeCustomNotificationAudit(params: {
  action: string;
  actionType: "create" | "update" | "delete";
  summary: string;
  actor: CustomNotificationActor;
  broadcastId: string;
  title: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const who =
    params.actor.name?.trim() || params.actor.email?.trim() || "Super admin";
  const logData: Record<string, unknown> = {
    action: params.summary,
    actionType: params.actionType,
    entityType: "system",
    entityId: params.broadcastId,
    entityName: params.title,
    performedBy: params.actor.uid,
    performedByName: who,
    performedByRole: "super_admin",
    details: params.summary,
    timestamp: FieldValue.serverTimestamp(),
    createdAt: FieldValue.serverTimestamp(),
    metadata: {
      category: "custom_notification",
      action: params.action,
      collection: "admin_broadcasts",
      ...params.metadata,
    },
  };

  Object.keys(logData).forEach((key) => {
    if (logData[key] === undefined) delete logData[key];
  });

  try {
    await adminDb().collection("superAdminAuditLogs").add(logData);
  } catch (error) {
    console.error("[broadcast audit] Failed to write audit log:", error);
  }
}

export async function resolveAuditIdentityForUid(uid: string): Promise<{
  email: string | null;
  name: string | null;
}> {
  const superSnap = await adminDb().collection("super_admins").doc(uid).get();
  if (superSnap.exists) {
    const data = superSnap.data() ?? {};
    return {
      email: typeof data.email === "string" ? data.email : null,
      name:
        typeof data.displayName === "string"
          ? data.displayName
          : typeof data.name === "string"
            ? data.name
            : null,
    };
  }

  const userSnap = await adminDb().collection("users").doc(uid).get();
  if (userSnap.exists) {
    const data = userSnap.data() ?? {};
    return {
      email: typeof data.email === "string" ? data.email : null,
      name:
        typeof data.displayName === "string"
          ? data.displayName
          : typeof data.name === "string"
            ? data.name
            : null,
    };
  }

  return { email: null, name: null };
}

export async function logCustomNotificationSent(params: {
  actor: CustomNotificationActor;
  broadcastId: string;
  title: string;
  audience: "owners" | "all";
  platforms: { admin: boolean; mobile: boolean };
  mobilePushCount: number;
}): Promise<void> {
  const who = params.actor.name?.trim() || params.actor.email?.trim() || "Super admin";
  await writeCustomNotificationAudit({
    action: "custom_notification.sent",
    actionType: "create",
    summary: `${who} sent custom notification "${params.title}" to ${audienceSummary(params.audience)} via ${platformSummary(params.platforms)}`,
    actor: params.actor,
    broadcastId: params.broadcastId,
    title: params.title,
    metadata: {
      audience: params.audience,
      platforms: params.platforms,
      mobilePushCount: params.mobilePushCount,
    },
  });
}

export async function logCustomNotificationActiveChanged(params: {
  actor: CustomNotificationActor;
  broadcastId: string;
  title: string;
  active: boolean;
}): Promise<void> {
  const who = params.actor.name?.trim() || params.actor.email?.trim() || "Super admin";
  await writeCustomNotificationAudit({
    action: params.active
      ? "custom_notification.reactivated"
      : "custom_notification.recalled",
    actionType: "update",
    summary: params.active
      ? `${who} re-activated custom notification "${params.title}"`
      : `${who} recalled custom notification "${params.title}"`,
    actor: params.actor,
    broadcastId: params.broadcastId,
    title: params.title,
    metadata: { active: params.active },
  });
}

export async function logCustomNotificationDeleted(params: {
  actor: CustomNotificationActor;
  broadcastId: string;
  title: string;
}): Promise<void> {
  const who = params.actor.name?.trim() || params.actor.email?.trim() || "Super admin";
  await writeCustomNotificationAudit({
    action: "custom_notification.deleted",
    actionType: "delete",
    summary: `${who} deleted custom notification "${params.title}"`,
    actor: params.actor,
    broadcastId: params.broadcastId,
    title: params.title,
  });
}
