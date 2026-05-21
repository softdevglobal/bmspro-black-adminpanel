import type { CallCenterRequestAuth } from "@/lib/callCenterAuth";

/**
 * Tiny in-memory response cache for the system-wide
 * (`/api/call-center/customer-notifications?all=1`) GET path.
 *
 * Multiple call-center agents poll this endpoint independently (~1 req/min each):
 * a single response easily reads 150–500 Firestore docs. Coalescing all agents
 * with the same effective scope onto one cached response for ~20 seconds drops
 * Firestore reads by an order of magnitude in busy hours without making the UI
 * feel stale.
 *
 * Mutation endpoints (`notification-reviewed`, `called-customer`, etc.) call
 * `invalidateCallCenterNotificationsCache()` to flush the cache so the next
 * poll returns the freshly-updated state immediately.
 */

export type CachedResponseBody = Record<string, unknown>;

type CacheEntry = { body: CachedResponseBody; expiresAt: number };

const SYSTEM_RESPONSE_CACHE = new Map<string, CacheEntry>();
const SYSTEM_RESPONSE_CACHE_TTL_MS = 20_000;
const SYSTEM_RESPONSE_CACHE_MAX_KEYS = 64;

export interface CallCenterCacheKeyParams {
  customerOnly: boolean;
  includeAdminPanel: boolean;
  unreadOnly: boolean;
  inboxLimit: number;
  sinceDays: number;
}

export function buildCallCenterNotificationsCacheKey(
  auth: CallCenterRequestAuth,
  params: CallCenterCacheKeyParams
): string {
  let principal: string;
  if (auth.kind === "tenant_admin") {
    principal = `tadm:${auth.isSuperAdmin ? "super" : "tenant"}:${auth.uid}`;
  } else {
    const sortedWorkshops = [...auth.user.assignedWorkshops].sort().join(",");
    principal = `agt:${auth.user.uid}:${auth.user.isCCAdmin ? "ccadm" : "agent"}:${sortedWorkshops}`;
  }
  const flags =
    `co=${params.customerOnly ? 1 : 0}` +
    `&ia=${params.includeAdminPanel ? 1 : 0}` +
    `&uo=${params.unreadOnly ? 1 : 0}` +
    `&l=${params.inboxLimit}` +
    `&sd=${params.sinceDays}`;
  return `${principal}|${flags}`;
}

export function readCallCenterNotificationsCache(key: string): CachedResponseBody | null {
  const entry = SYSTEM_RESPONSE_CACHE.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    SYSTEM_RESPONSE_CACHE.delete(key);
    return null;
  }
  return entry.body;
}

export function writeCallCenterNotificationsCache(
  key: string,
  body: CachedResponseBody
): void {
  if (SYSTEM_RESPONSE_CACHE.size >= SYSTEM_RESPONSE_CACHE_MAX_KEYS) {
    const now = Date.now();
    for (const [k, v] of SYSTEM_RESPONSE_CACHE) {
      if (now > v.expiresAt) SYSTEM_RESPONSE_CACHE.delete(k);
    }
    if (SYSTEM_RESPONSE_CACHE.size >= SYSTEM_RESPONSE_CACHE_MAX_KEYS) {
      const firstKey = SYSTEM_RESPONSE_CACHE.keys().next().value;
      if (firstKey) SYSTEM_RESPONSE_CACHE.delete(firstKey);
    }
  }
  SYSTEM_RESPONSE_CACHE.set(key, {
    body,
    expiresAt: Date.now() + SYSTEM_RESPONSE_CACHE_TTL_MS,
  });
}

/**
 * Flush the entire response cache. Called by mutation endpoints
 * (`notification-reviewed`, `called-customer`) so the next poll reflects
 * the updated state without waiting for the 20-second TTL.
 */
export function invalidateCallCenterNotificationsCache(): void {
  SYSTEM_RESPONSE_CACHE.clear();
}
