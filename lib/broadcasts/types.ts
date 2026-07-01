/**
 * Custom messages ("broadcasts") authored by a super admin and delivered to
 * business users as read-only notifications.
 */

export const BROADCAST_COLLECTION = "admin_broadcasts";
export const BROADCAST_USER_STATE_COLLECTION = "broadcast_user_state";

export type BroadcastPlatforms = {
  admin: boolean;
  mobile: boolean;
};

export type BroadcastAudience = "owners" | "all";

export type BroadcastRecord = {
  id: string;
  title: string;
  body: string;
  platforms: BroadcastPlatforms;
  audience: BroadcastAudience;
  active: boolean;
  createdAt: number;
  createdByUid: string | null;
  createdByEmail: string | null;
  mobilePushCount: number | null;
};

export type BroadcastForUser = {
  id: string;
  title: string;
  body: string;
  audience: BroadcastAudience;
  createdAt: number;
  read: boolean;
};

export const BROADCAST_AUDIENCE_LABELS: Record<BroadcastAudience, string> = {
  owners: "Business owners only",
  all: "All staff & owners",
};

export type BroadcastPlatform = "admin" | "mobile";

export const BROADCAST_NOTIFICATION_PREFIX = "broadcast__";

export function isValidAudience(value: unknown): value is BroadcastAudience {
  return value === "owners" || value === "all";
}

export function isValidPlatform(value: unknown): value is BroadcastPlatform {
  return value === "admin" || value === "mobile";
}
