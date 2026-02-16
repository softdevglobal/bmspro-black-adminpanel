import { NextRequest, NextResponse } from "next/server";
import { adminAuth, adminDb } from "@/lib/firebaseAdmin";

export const runtime = "nodejs";

/**
 * POST /api/auth/register
 *
 * Creates a new workshop owner account:
 * 1. Creates Firebase Auth user (via Admin SDK — bypasses client restrictions)
 * 2. Generates a unique booking-engine slug
 * 3. Creates the Firestore document in the `users` collection (via Admin SDK — bypasses security rules)
 *
 * Returns the new user's UID so the client can sign in afterwards.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    const {
      email,
      password,
      ownerName,
      businessName,
      businessType,
      abn,
      businessStructure,
      gstRegistered,
      state,
      timezone,
      address,
      postcode,
      phone,
      // Package / plan info
      planId,
      planName,
      planPrice,
      planKey,
      planBranches,
      planStaff,
      trialDays: rawTrialDays,
    } = body;

    // ---- Validation ----
    if (!email || typeof email !== "string") {
      return NextResponse.json({ error: "Email is required" }, { status: 400 });
    }
    if (!password || typeof password !== "string" || password.length < 6) {
      return NextResponse.json(
        { error: "Password must be at least 6 characters" },
        { status: 400 }
      );
    }
    if (!businessName || typeof businessName !== "string") {
      return NextResponse.json({ error: "Business name is required" }, { status: 400 });
    }
    if (!planId) {
      return NextResponse.json({ error: "Please select a plan" }, { status: 400 });
    }

    const trimmedEmail = email
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/[\u00A0]/g, " ")
      .replace(/\s+/g, "")
      .toLowerCase();

    const auth = adminAuth();
    const db = adminDb();

    // ---- 1. Create Firebase Auth user ----
    let uid: string;
    try {
      const userRecord = await auth.createUser({
        email: trimmedEmail,
        password,
        displayName: ownerName?.trim() || businessName.trim(),
        emailVerified: false,
        disabled: false,
      });
      uid = userRecord.uid;
    } catch (e: any) {
      if (e.code === "auth/email-already-exists") {
        return NextResponse.json(
          { error: "email-already-in-use", message: "An account with this email already exists." },
          { status: 409 }
        );
      }
      if (e.code === "auth/invalid-email") {
        return NextResponse.json(
          { error: "invalid-email", message: "Invalid email address format." },
          { status: 400 }
        );
      }
      if (e.code === "auth/weak-password" || e.code === "auth/invalid-password") {
        return NextResponse.json(
          { error: "weak-password", message: "Password is too weak." },
          { status: 400 }
        );
      }
      console.error("[register] Auth error:", e);
      throw e;
    }

    // ---- 2. Generate unique slug ----
    const generateSlug = (name: string): string =>
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)+/g, "");

    const baseSlug = generateSlug(businessName.trim()) || `workshop-${Date.now()}`;
    let slug = baseSlug;
    let counter = 1;

    // Check uniqueness via Admin SDK
    while (true) {
      const snapshot = await db
        .collection("users")
        .where("slug", "==", slug)
        .where("role", "==", "workshop_owner")
        .limit(1)
        .get();
      if (snapshot.empty) break;
      slug = `${baseSlug}-${counter}`;
      counter++;
    }

    // ---- 3. Build Firestore document ----
    const trialDays = rawTrialDays ? parseInt(String(rawTrialDays), 10) : 0;
    const hasFreeTrial = trialDays > 0;
    const now = new Date();
    const trialStart = hasFreeTrial ? now : null;
    const trialEnd = hasFreeTrial
      ? new Date(now.getTime() + trialDays * 24 * 60 * 60 * 1000)
      : null;

    const bookingEngineBaseUrl =
      process.env.NEXT_PUBLIC_BOOKING_ENGINE_URL || "https://black.bmspros.com.au/book-now";
    const bookingEngineUrl = `${bookingEngineBaseUrl}/${slug}`;

    const locationText = address
      ? `${address}${postcode ? ` ${postcode}` : ""}`
      : null;

    const docData: Record<string, any> = {
      email: trimmedEmail,
      displayName: ownerName?.trim() || businessName.trim(),
      role: "workshop_owner",
      provider: "password",
      uid,
      name: businessName.trim(),
      slug,
      bookingEngineUrl,
      businessType: businessType || null,
      abn: abn ? abn.replace(/\s/g, "").trim() : null,
      businessStructure: businessStructure || null,
      gstRegistered: !!gstRegistered,
      state: state || null,
      timezone: timezone || "Australia/Sydney",
      locationText,
      contactPhone: phone?.trim() || null,
      plan: planName || null,
      price: planPrice || null,
      planId: planId || null,
      plan_key: planKey || null,
      branchLimit: planBranches ?? 0,
      currentBranchCount: 0,
      branchNames: [],
      staffLimit: planStaff ?? 0,
      currentStaffCount: 0,
      status: hasFreeTrial ? "Free Trial Active" : "Pending Payment",
      accountStatus: hasFreeTrial ? "active_trial" : "pending_payment",
      subscriptionStatus: hasFreeTrial ? "trialing" : "pending",
      billing_status: hasFreeTrial ? "trialing" : "pending",
      trialDays,
      hasFreeTrial,
      trial_start: trialStart,
      trial_end: trialEnd,
      paymentDetailsRequired: !hasFreeTrial,
      signupSource: "self_registration",
      createdAt: now,
      updatedAt: now,
    };

    await db.doc(`users/${uid}`).set(docData);

    // ---- 4. Return success ----
    return NextResponse.json(
      {
        success: true,
        uid,
        email: trimmedEmail,
        slug,
        bookingEngineUrl,
        hasFreeTrial,
        trialDays,
      },
      { status: 201 }
    );
  } catch (err: any) {
    console.error("[/api/auth/register] Error:", err);
    return NextResponse.json(
      { error: err?.message || "Internal server error" },
      { status: 500 }
    );
  }
}
