import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";

export const runtime = "nodejs";

/**
 * GET /api/packages/public
 * 
 * Public endpoint to fetch active subscription packages for signup page.
 * No authentication required.
 * Only returns active, non-hidden packages.
 */
export async function GET(req: NextRequest) {
  try {
    const db = adminDb();
    const plansRef = db.collection("subscription_plans");
    const snapshot = await plansRef.get();

    const plans: any[] = [];

    snapshot.forEach((doc) => {
      const data = doc.data();
      // Only include active, non-hidden packages
      if (data.active !== false && data.hidden !== true) {
        plans.push({
          id: doc.id,
          name: data.name || "Unknown",
          price: data.price || 0,
          priceLabel: data.priceLabel || `AU$${data.price || 0}/mo`,
          branches: data.branches || 1,
          staff: data.staff || 1,
          features: data.features || [],
          popular: data.popular || false,
          color: data.color || "pink",
          image: data.image || null,
          trialDays: data.trialDays || 0,
          plan_key: data.plan_key || null,
          active: data.active !== false,
        });
      }
    });

    // Sort by price (ascending)
    plans.sort((a, b) => a.price - b.price);

    return NextResponse.json({
      success: true,
      plans,
    });
  } catch (error: any) {
    console.error("[PublicPackages] Error:", error);
    return NextResponse.json(
      { error: "Failed to fetch packages" },
      { status: 500 }
    );
  }
}
