import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";
import { CALL_CENTER_ROLES, CORS_HEADERS } from "@/lib/callCenterAuth";

export const runtime = "nodejs";

export async function OPTIONS() {
  return NextResponse.json({}, { headers: CORS_HEADERS });
}

type FirebasePasswordSignInResponse = {
  kind?: string;
  localId?: string;
  email?: string;
  displayName?: string;
  idToken?: string;
  registered?: boolean;
  refreshToken?: string;
  expiresIn?: string;
};

type FirebaseErrorBody = {
  error?: { message?: string; code?: number };
};

/**
 * POST /api/call-center/auth/login
 *
 * Email/password sign-in for call center agents. Wraps Firebase Identity Toolkit so the
 * client gets **`agent_id`** (Firebase UID) instead of Google's **`localId`** field name.
 *
 * Body: `{ "email": string, "password": string }`
 *
 * Success: `{ agent_id, email, displayName?, idToken, refreshToken, expiresIn, registered }`
 */
export async function POST(req: NextRequest) {
  const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY?.trim();
  if (!apiKey) {
    return NextResponse.json(
      { error: "Server missing NEXT_PUBLIC_FIREBASE_API_KEY" },
      { status: 500, headers: CORS_HEADERS }
    );
  }

  let body: { email?: string; password?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400, headers: CORS_HEADERS });
  }

  const email = typeof body.email === "string" ? body.email.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!email || !password) {
    return NextResponse.json(
      { error: "Missing email or password" },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(apiKey)}`;

  try {
    const firebaseRes = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        password,
        returnSecureToken: true,
      }),
    });

    const data = (await firebaseRes.json()) as FirebasePasswordSignInResponse & FirebaseErrorBody;

    if (!firebaseRes.ok) {
      const msg = data.error?.message || "Sign-in failed";
      const lower = msg.toLowerCase();
      const status =
        lower.includes("invalid_password") || lower.includes("email_not_found") || lower.includes("invalid_email")
          ? 401
          : firebaseRes.status >= 400 && firebaseRes.status < 600
            ? firebaseRes.status
            : 400;
      return NextResponse.json({ error: msg }, { status, headers: CORS_HEADERS });
    }

    const localId = data.localId?.trim();
    if (!localId || !data.idToken) {
      return NextResponse.json(
        { error: "Invalid response from identity service" },
        { status: 502, headers: CORS_HEADERS }
      );
    }

    const db = adminDb();
    const agentDoc = await db.doc(`call_center_agents/${localId}`).get();
    const agentData = agentDoc.exists ? agentDoc.data() : null;

    let allowed = false;
    if (agentData && !agentData.suspended) {
      const r = (agentData.role || "agent").toString().toLowerCase();
      allowed = CALL_CENTER_ROLES.includes(r);
    }
    if (!allowed) {
      const userDoc = await db.doc(`users/${localId}`).get();
      if (userDoc.exists && !userDoc.data()?.suspended) {
        const ud = userDoc.data()!;
        const ur = (ud.role || ud.systemRole || "").toString().toLowerCase();
        allowed = CALL_CENTER_ROLES.includes(ur);
      }
    }

    if (!allowed) {
      return NextResponse.json(
        { error: "Not a registered call center agent" },
        { status: 403, headers: CORS_HEADERS }
      );
    }
    if (agentData?.suspended) {
      return NextResponse.json(
        { error: "Agent account suspended" },
        { status: 403, headers: CORS_HEADERS }
      );
    }

    return NextResponse.json(
      {
        agent_id: localId,
        email: data.email ?? email,
        ...(data.displayName != null && data.displayName !== ""
          ? { displayName: data.displayName }
          : {}),
        idToken: data.idToken,
        refreshToken: data.refreshToken ?? "",
        expiresIn: data.expiresIn ?? "3600",
        registered: data.registered === true,
      },
      { headers: CORS_HEADERS }
    );
  } catch (e: any) {
    console.error("[call-center/auth/login POST]", e);
    return NextResponse.json(
      { error: e?.message || "Sign-in request failed" },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
