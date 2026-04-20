import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";

export const runtime = "nodejs";

/**
 * Public API: Get workshop data by slug for booking engine.
 * Returns: workshop name, branches (id, name, address, bookingLimitPerDay), services (id, name, price, duration, checklist, branches).
 * No authentication required.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  try {
    const { slug } = await params;
    if (!slug || typeof slug !== "string") {
      return NextResponse.json({ error: "Invalid slug" }, { status: 400 });
    }

    const db = adminDb();

    // Find the workshop owner by slug
    const usersQuery = await db
      .collection("users")
      .where("slug", "==", slug)
      .where("role", "==", "workshop_owner")
      .limit(1)
      .get();

    if (usersQuery.empty) {
      return NextResponse.json({ error: "Workshop not found" }, { status: 404 });
    }

    const ownerDoc = usersQuery.docs[0];
    const ownerData = ownerDoc.data();
    const ownerUid = ownerDoc.id;

    // Check if the workshop is active
    const accountStatus = ownerData.accountStatus || ownerData.status || "";
    if (accountStatus === "suspended" || accountStatus === "inactive") {
      return NextResponse.json({ error: "Workshop is currently unavailable" }, { status: 403 });
    }

    // Fetch branches for this owner
    const branchesSnapshot = await db
      .collection("branches")
      .where("ownerUid", "==", ownerUid)
      .get();

    const branches = branchesSnapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        name: data.name || "",
        address: data.address || data.locationText || "",
        phone: data.phone || "",
        timezone: data.timezone || "Australia/Sydney",
        hours: data.hours || null,
        bookingLimitPerDay: typeof data.bookingLimitPerDay === "number" ? data.bookingLimitPerDay : null,
      };
    });

    // Fetch services for this owner
    const servicesSnapshot = await db
      .collection("services")
      .where("ownerUid", "==", ownerUid)
      .get();

    const services = servicesSnapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        name: data.name || "",
        price: data.price || 0,
        duration: data.duration || 0,
        imageUrl: data.imageUrl || "",
        checklist: Array.isArray(data.checklist) ? data.checklist : [],
        areaOrder: Array.isArray(data.areaOrder) ? data.areaOrder : [],
        branches: Array.isArray(data.branches) ? data.branches : [],
      };
    });

    return NextResponse.json({
      workshop: {
        id: ownerUid, // needed for scoped customer auth
        name: ownerData.name || ownerData.displayName || "Workshop",
        slug: ownerData.slug,
        logoUrl: ownerData.logoUrl || "",
      },
      branches,
      services,
    });
  } catch (error: any) {
    console.error("Error fetching workshop data:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
