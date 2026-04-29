import { NextRequest, NextResponse } from "next/server";

import { authenticateMobileRequest } from "@/lib/yeastar/mobileAuth";

export const runtime = "nodejs";

const LOG_PREFIX = "[api/user-extension]";

/**
 * GET /api/user-extension?email=user@example.com
 *
 * Returns the Yeastar PBX extension assigned to the authenticated user.
 * Source of truth: `users/{uid}.yeastarExtension` in Firestore.
 *
 * Auth: `Authorization: Bearer <Firebase ID token>` (mobile roles only).
 * Callers may **only** look up their own email — the request `email` must
 * match the email on the Firebase token. We don't allow cross-user lookup
 * because that would let any logged-in mobile user enumerate the staff
 * directory.
 *
 * Responses:
 * - 200 `{ extension: "1001", email }`
 * - 400 missing/invalid email
 * - 401 missing/invalid Bearer
 * - 403 caller asked for someone else's email
 * - 404 `{ error: "extension_not_assigned" }` — admin hasn't set the field yet
 */
export async function GET(req: NextRequest) {
  const auth = await authenticateMobileRequest(req);
  if (!auth.ok) return auth.response;

  const rawEmail = (req.nextUrl.searchParams.get("email") ?? "").trim().toLowerCase();
  if (!rawEmail) {
    return NextResponse.json(
      { success: false, error: "email query parameter required" },
      { status: 400 },
    );
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail)) {
    return NextResponse.json(
      { success: false, error: "invalid email" },
      { status: 400 },
    );
  }

  if (rawEmail !== auth.caller.email.toLowerCase()) {
    return NextResponse.json(
      {
        success: false,
        error: "callers may only look up their own extension",
      },
      { status: 403 },
    );
  }

  const ext = auth.caller.yeastarExtension.trim();
  if (!ext) {
    console.warn(`${LOG_PREFIX} no yeastarExtension for uid=${auth.caller.uid}`);
    return NextResponse.json(
      {
        success: false,
        error: "extension_not_assigned",
        hint:
          "Your account has no Yeastar PBX extension assigned. Ask your admin to set users/{uid}.yeastarExtension.",
      },
      { status: 404 },
    );
  }

  return NextResponse.json(
    { extension: ext, email: rawEmail },
    {
      headers: {
        "Cache-Control": "no-store, max-age=0",
      },
    },
  );
}
