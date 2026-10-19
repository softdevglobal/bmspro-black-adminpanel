import { NextRequest, NextResponse } from "next/server";
import { adminAuth } from "@/lib/firebaseAdmin";
import { checkRateLimit, getClientIdentifier } from "@/lib/rateLimiterDistributed";

export const runtime = "nodejs";
export async function POST(req: NextRequest) {
  if (process.env.COMMAND_CENTRE_ONBOARDING_ENABLED !== "true") return NextResponse.json({ error: "Onboarding is unavailable." }, { status: 404 });
  const limited = await checkRateLimit(getClientIdentifier(req), { identifier: "onboarding-login-create", maxRequests: 3, windowMs: 3600000 });
  if (!limited.success) return NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429 });
  try {
    const body = await req.json();
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || typeof body.password !== "string" || body.password.length < 12 || body.password.length > 128)
      return NextResponse.json({ error: "Enter a valid email and a password of 12–128 characters." }, { status: 400 });
    const auth = adminAuth();
    const user = await auth.createUser({ email, password: body.password, emailVerified: false, disabled: true });
    // Keep onboarding logins out of browser Firestore access until launch.
    // If setting the restriction fails, the account remains disabled.
    await auth.setCustomUserClaims(user.uid, { onboardingOnly: true });
    await auth.updateUser(user.uid, { disabled: false });
    return NextResponse.json({ created: true, message: "Login created. Verify your email before reviewing the workshop setup." }, { status: 201 });
  } catch (error) {
    const exists = (error as { code?: string }).code === "auth/email-already-exists";
    return NextResponse.json({ error: exists ? "An account already exists. Sign in with your existing password." : "Login could not be created." }, { status: exists ? 409 : 400 });
  }
}
