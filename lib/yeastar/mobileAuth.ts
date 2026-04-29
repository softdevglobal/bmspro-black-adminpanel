/**
 * Bearer-token auth + extension-ownership check shared by all
 * mobile-facing Yeastar routes (`/api/yeastar/sign`, `/api/yeastar/linkus-sign`,
 * `/api/yeastar/register-push`, `/api/user-extension`).
 *
 * Why a separate helper instead of `verifyAdminAuth`: we want **staff** to be
 * allowed (they get incoming calls), but `verifyAdminAuth` defaults to
 * `ADMIN_ROLES` only. We resolve the Linkus extension from
 * `users/{uid}.yeastarExtension`, falling back to legacy `pbxExtension`
 * when the former is unset — both represent the same PBX extension in BMS.
 */

import { NextRequest, NextResponse } from "next/server";
import { adminAuth, adminDb } from "@/lib/firebaseAdmin";
import {
  getFirebaseIdTokenFromRequest,
  missingFirebaseTokenMessage,
  MOBILE_ROLES,
} from "@/lib/authHelpers";

export type MobileCaller = {
  uid: string;
  email: string;
  role: string;
  yeastarExtension: string;
};

export type MobileAuthOk = { ok: true; caller: MobileCaller };
export type MobileAuthErr = { ok: false; response: NextResponse };
export type MobileAuthResult = MobileAuthOk | MobileAuthErr;

function jsonError(
  status: number,
  body: Record<string, unknown>,
): NextResponse {
  return NextResponse.json(body, { status });
}

/**
 * Verifies the Firebase ID token, ensures the user is one of the
 * `MOBILE_ROLES`, isn't suspended, and returns their assigned PBX extension
 * (may be empty if the admin hasn't assigned one yet).
 */
export async function authenticateMobileRequest(
  req: NextRequest,
): Promise<MobileAuthResult> {
  const idToken = getFirebaseIdTokenFromRequest(req);
  if (!idToken) {
    return {
      ok: false,
      response: jsonError(401, {
        success: false,
        error: missingFirebaseTokenMessage(),
      }),
    };
  }

  let decoded;
  try {
    decoded = await adminAuth().verifyIdToken(idToken);
  } catch {
    return {
      ok: false,
      response: jsonError(401, {
        success: false,
        error: "Invalid or expired token",
      }),
    };
  }

  const uid = decoded.uid;
  const userDoc = await adminDb().doc(`users/${uid}`).get();
  if (!userDoc.exists) {
    return {
      ok: false,
      response: jsonError(404, {
        success: false,
        error: "User profile not found",
      }),
    };
  }

  const data = userDoc.data() ?? {};
  const role = (data.role ?? data.systemRole ?? "").toString().toLowerCase();
  const status = (data.status ?? "").toString().toLowerCase();
  const suspended = data.suspended === true || status === "suspended";

  if (suspended) {
    return {
      ok: false,
      response: jsonError(403, {
        success: false,
        error: "Account suspended",
      }),
    };
  }

  if (!MOBILE_ROLES.includes(role)) {
    return {
      ok: false,
      response: jsonError(403, {
        success: false,
        error: `Role '${role || "unknown"}' is not authorized for the mobile app`,
      }),
    };
  }

  const yeastar =
    (data.yeastarExtension ?? "").toString().trim() ||
    (data.pbxExtension ?? "").toString().trim();

  return {
    ok: true,
    caller: {
      uid,
      email: (data.email ?? decoded.email ?? "").toString().toLowerCase(),
      role,
      yeastarExtension: yeastar,
    },
  };
}

/**
 * Defense-in-depth: confirm the caller actually owns the extension they're
 * asking us to sign for / register a push token against. Without this, any
 * authenticated mobile user could phish another user's signed login token.
 */
export function assertCallerOwnsExtension(
  caller: MobileCaller,
  requestedExtension: string,
): NextResponse | null {
  const want = requestedExtension.trim();
  const have = caller.yeastarExtension.trim();
  if (!want) {
    return jsonError(400, {
      success: false,
      error: "extension required",
    });
  }
  if (!have) {
    return jsonError(404, {
      success: false,
      error: "extension_not_assigned",
      hint:
        "Your account has no Yeastar PBX extension. Set users/{uid}.yeastarExtension or users/{uid}.pbxExtension (same value as the PBX extension).",
    });
  }
  if (have !== want) {
    return jsonError(403, {
      success: false,
      error: "extension does not belong to caller",
    });
  }
  return null;
}

// ────────── Per-uid soft rate limit ─────────────────────────────────────────
// In-memory bucket. Yeastar caps tokens per PBX, so we want to prevent a
// runaway client from hammering /sign and burning the quota.

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

export function checkMobileRateLimit(
  key: string,
  limit = 10,
  windowMs = 60_000,
): NextResponse | null {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now >= b.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return null;
  }
  if (b.count >= limit) {
    const retryAfter = Math.max(1, Math.ceil((b.resetAt - now) / 1000));
    return NextResponse.json(
      { success: false, error: "rate_limited" },
      {
        status: 429,
        headers: { "Retry-After": String(retryAfter) },
      },
    );
  }
  b.count += 1;
  return null;
}
