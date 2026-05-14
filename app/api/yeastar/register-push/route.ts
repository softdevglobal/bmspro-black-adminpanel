import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";

import { adminDb } from "@/lib/firebaseAdmin";
import {
  annotateOpenApiError,
  getEnv,
  setPushToken,
  type PushPlatform,
  type PushType,
} from "@/lib/yeastar/openapi";
import {
  assertCallerOwnsExtension,
  authenticateMobileRequest,
  checkMobileRateLimit,
} from "@/lib/yeastar/mobileAuth";

export const runtime = "nodejs";

const LOG_PREFIX = "[api/yeastar/register-push]";

type RegisterBody = {
  extension?: unknown;
  deviceToken?: unknown;
  platform?: unknown;
  type?: unknown;
};

function parsePlatform(v: unknown): PushPlatform | null {
  return v === "android" || v === "ios" ? v : null;
}
function parseType(v: unknown): PushType | null {
  return v === "fcm" || v === "apns" ? v : null;
}

/**
 * POST /api/yeastar/register-push
 *
 * Registers (or clears, if `deviceToken` is empty) a mobile push token with
 * the Yeastar PBX so it can wake the device for incoming calls when the
 * Linkus SDK socket is dropped (background, screen off, doze).
 *
 * Body:
 * ```
 * {
 *   "extension": "1001",
 *   "deviceToken": "<fcm or apns hex>",
 *   "platform": "android" | "ios",
 *   "type": "fcm" | "apns"
 * }
 * ```
 *
 * Auth + ownership check: the caller's `users/{uid}.yeastarExtension` must
 * match `extension`.
 *
 * Side effects:
 * - PBX: `POST /openapi/v1.0/push/set` (or fallback `extension/set_push`).
 * - Firestore: mirrors the registration on `users/{uid}.yeastarPush` so we
 *   can re-register on PBX cache loss.
 */
export async function POST(req: NextRequest) {
  const auth = await authenticateMobileRequest(req);
  if (!auth.ok) return auth.response;

  let body: RegisterBody;
  try {
    body = (await req.json()) as RegisterBody;
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const extension = (body.extension ?? "").toString().trim();
  const deviceToken = (body.deviceToken ?? "").toString().trim();
  const platform = parsePlatform(body.platform);
  const type = parseType(body.type);

  if (!platform || !type) {
    return NextResponse.json(
      {
        success: false,
        error:
          "platform must be 'android' | 'ios', type must be 'fcm' | 'apns'",
      },
      { status: 400 },
    );
  }

  const ownership = assertCallerOwnsExtension(auth.caller, extension);
  if (ownership) return ownership;

  const limited = checkMobileRateLimit(`push:${auth.caller.uid}`, 20);
  if (limited) return limited;

  const env = getEnv();
  if (!env.configured) {
    return NextResponse.json(
      {
        success: false,
        error: "yeastar_not_configured",
      },
      { status: 503 },
    );
  }

  const isClear = deviceToken.length === 0;

  let pbxPushApplied = false;
  try {
    const result = await setPushToken(
      {
        extension,
        deviceToken,
        platform,
        type,
      },
      env,
    );
    pbxPushApplied = result.applied;
    if (!pbxPushApplied && !isClear) {
      console.warn(
        `${LOG_PREFIX} PBX did not apply push token (OpenAPI push not on firmware); Linkus foreground calls still work`,
      );
    }
  } catch (e) {
    console.error(LOG_PREFIX, e);
    const ann = annotateOpenApiError(e);
    return NextResponse.json(
      {
        success: false,
        error: ann.message,
        ...(ann.errcode != null ? { errcode: ann.errcode } : {}),
        ...(ann.hint ? { hint: ann.hint } : {}),
      },
      { status: 502 },
    );
  }

  // Mirror to Firestore only when the PBX accepted the change, or when
  // clearing local mapping after logout.
  try {
    if (isClear) {
      await adminDb()
        .doc(`users/${auth.caller.uid}`)
        .set(
          {
            yeastarPush: FieldValue.delete(),
          },
          { merge: true },
        );
    } else if (pbxPushApplied) {
      await adminDb()
        .doc(`users/${auth.caller.uid}`)
        .set(
          {
            yeastarPush: {
              token: deviceToken,
              platform,
              type,
              updatedAt: FieldValue.serverTimestamp(),
            },
          },
          { merge: true },
        );
    }
  } catch (e) {
    console.warn(`${LOG_PREFIX} firestore mirror failed`, e);
  }

  return NextResponse.json({
    success: true,
    cleared: isClear,
    pbxPushApplied,
  });
}
