import { NextRequest, NextResponse } from "next/server";
import { adminDb, adminAuth } from "@/lib/firebaseAdmin";

export const runtime = "nodejs";

// GET - Fetch all packages
export async function GET(req: NextRequest) {
  try {
    const db = adminDb();
    const snapshot = await db.collection("subscription_plans").orderBy("price", "asc").get();
    
    const plans = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    return NextResponse.json({ success: true, plans });
  } catch (error: any) {
    console.error("[GET PACKAGES] Error:", error);
    return NextResponse.json(
      { success: false, error: error.message || "Failed to fetch packages" },
      { status: 500 }
    );
  }
}

// POST - Create a new package
export async function POST(req: NextRequest) {
  try {
    // Verify authentication
    const authHeader = req.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const token = authHeader.split("Bearer ")[1];
    const auth = adminAuth();
    
    try {
      await auth.verifyIdToken(token);
    } catch (authError) {
      return NextResponse.json({ error: "Invalid token" }, { status: 401 });
    }

    const body = await req.json();
    const { name, price, priceLabel, branches, staff, features, popular, color, image, icon, active, stripePriceId, trialDays, plan_key } = body;

    // Validation
    if (!name || price === undefined || !priceLabel) {
      return NextResponse.json(
        { success: false, error: "Missing required fields: name, price, priceLabel" },
        { status: 400 }
      );
    }

    const db = adminDb();
    const planData: any = {
      name: name.trim(),
      price: parseFloat(price),
      priceLabel: priceLabel.trim(),
      branches: branches !== undefined ? parseInt(branches, 10) : 1,
      staff: staff !== undefined ? parseInt(staff, 10) : 1,
      features: Array.isArray(features) ? features : [],
      popular: popular === true || popular === "true",
      color: color || "blue",
      active: active !== false && active !== "false",
      // Hidden packages are not shown in subscription page for upgrade/downgrade (budget plans for specific salons)
      hidden: body.hidden === true || body.hidden === "true",
      // Trial period in days (0 = no trial, null = no trial)
      trialDays: trialDays !== undefined && trialDays !== null && trialDays !== "" ? parseInt(trialDays, 10) : 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // Add Stripe Price ID if provided (required for payment processing)
    if (stripePriceId && stripePriceId.trim()) {
      planData.stripePriceId = stripePriceId.trim();
    }

    // Add plan_key if provided (internal identifier like SOLO, TEAM5)
    if (plan_key && plan_key.trim()) {
      planData.plan_key = plan_key.trim();
    }

    // Add image if provided, otherwise keep icon for backward compatibility
    if (image) {
      planData.image = image;
    } else if (icon) {
      planData.icon = icon;
    }

    const docRef = await db.collection("subscription_plans").add(planData);

    return NextResponse.json({
      success: true,
      message: "Package created successfully",
      id: docRef.id,
      plan: { id: docRef.id, ...planData },
    });
  } catch (error: any) {
    console.error("[CREATE PACKAGE] Error:", error);
    return NextResponse.json(
      { success: false, error: error.message || "Failed to create package" },
      { status: 500 }
    );
  }
}

// PUT - Update an existing package
export async function PUT(req: NextRequest) {
  try {
    // Verify authentication
    const authHeader = req.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const token = authHeader.split("Bearer ")[1];
    const auth = adminAuth();
    
    try {
      await auth.verifyIdToken(token);
    } catch (authError) {
      return NextResponse.json({ error: "Invalid token" }, { status: 401 });
    }

    const body = await req.json();
    const { id, name, price, priceLabel, branches, staff, features, popular, color, image, icon, active, stripePriceId, trialDays, plan_key } = body;

    if (!id) {
      return NextResponse.json(
        { success: false, error: "Missing package ID" },
        { status: 400 }
      );
    }

    const db = adminDb();
    const planRef = db.collection("subscription_plans").doc(id);
    const planDoc = await planRef.get();

    if (!planDoc.exists) {
      return NextResponse.json(
        { success: false, error: "Package not found" },
        { status: 404 }
      );
    }

    const updateData: any = {
      updatedAt: new Date(),
    };

    if (name !== undefined) updateData.name = name.trim();
    if (price !== undefined) updateData.price = parseFloat(price);
    if (priceLabel !== undefined) updateData.priceLabel = priceLabel.trim();
    if (branches !== undefined) updateData.branches = parseInt(branches, 10);
    if (staff !== undefined) updateData.staff = parseInt(staff, 10);
    if (features !== undefined) updateData.features = Array.isArray(features) ? features : [];
    if (popular !== undefined) updateData.popular = popular === true || popular === "true";
    if (color !== undefined) updateData.color = color;
    if (image !== undefined) {
      updateData.image = image;
      // Remove icon if image is provided
      if (image) {
        updateData.icon = null;
      }
    } else if (icon !== undefined) {
      updateData.icon = icon;
    }
    if (active !== undefined) updateData.active = active !== false && active !== "false";
    // Hidden packages are not shown in subscription page for upgrade/downgrade (budget plans for specific salons)
    if (body.hidden !== undefined) updateData.hidden = body.hidden === true || body.hidden === "true";
    if (stripePriceId !== undefined) {
      updateData.stripePriceId = stripePriceId && stripePriceId.trim() ? stripePriceId.trim() : null;
    }
    // Trial period in days (0 = no trial)
    if (trialDays !== undefined) {
      updateData.trialDays = trialDays !== null && trialDays !== "" ? parseInt(trialDays, 10) : 0;
    }
    // Internal plan key (e.g., SOLO, TEAM5)
    if (plan_key !== undefined) {
      updateData.plan_key = plan_key && plan_key.trim() ? plan_key.trim() : null;
    }

    await planRef.update(updateData);

    const updatedDoc = await planRef.get();

    return NextResponse.json({
      success: true,
      message: "Package updated successfully",
      plan: { id: updatedDoc.id, ...updatedDoc.data() },
    });
  } catch (error: any) {
    console.error("[UPDATE PACKAGE] Error:", error);
    return NextResponse.json(
      { success: false, error: error.message || "Failed to update package" },
      { status: 500 }
    );
  }
}

// DELETE - Delete a package
export async function DELETE(req: NextRequest) {
  try {
    // Verify authentication
    const authHeader = req.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const token = authHeader.split("Bearer ")[1];
    const auth = adminAuth();
    
    try {
      await auth.verifyIdToken(token);
    } catch (authError) {
      return NextResponse.json({ error: "Invalid token" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");

    if (!id) {
      return NextResponse.json(
        { success: false, error: "Missing package ID" },
        { status: 400 }
      );
    }

    const db = adminDb();
    const planRef = db.collection("subscription_plans").doc(id);
    const planDoc = await planRef.get();

    if (!planDoc.exists) {
      return NextResponse.json(
        { success: false, error: "Package not found" },
        { status: 404 }
      );
    }

    await planRef.delete();

    return NextResponse.json({
      success: true,
      message: "Package deleted successfully",
    });
  } catch (error: any) {
    console.error("[DELETE PACKAGE] Error:", error);
    return NextResponse.json(
      { success: false, error: error.message || "Failed to delete package" },
      { status: 500 }
    );
  }
}
