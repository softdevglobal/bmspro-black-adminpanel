import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";
import { verifyAdminAuth, ADMIN_ROLES } from "@/lib/authHelpers";
import { autoCheckOutIfExceededRadius } from "@/lib/staffCheckIn";
import { validateCheckInLocation } from "@/lib/geolocation";

export const runtime = "nodejs";

/**
 * POST /api/staff-check-in/auto-checkout
 * Monitor active check-ins and auto-checkout staff who exceed branch radius
 * This endpoint can be called by scheduled tasks or manually
 */
export async function POST(req: NextRequest) {
  try {
    // Verify authentication - only admins can trigger this
    const authResult = await verifyAdminAuth(req, ADMIN_ROLES);
    if (!authResult.success) {
      return NextResponse.json(
        { error: authResult.error },
        { status: authResult.status }
      );
    }

    const { userData } = authResult;
    const body = await req.json();
    const { ownerUid, checkInId, currentLatitude, currentLongitude } = body;

    // If specific check-in ID and location provided, check that one
    if (checkInId && currentLatitude !== undefined && currentLongitude !== undefined) {
      const wasAutoCheckedOut = await autoCheckOutIfExceededRadius(
        checkInId,
        currentLatitude,
        currentLongitude
      );

      return NextResponse.json({
        success: true,
        autoCheckedOut: wasAutoCheckedOut,
        message: wasAutoCheckedOut
          ? "Staff member was automatically checked out for exceeding branch radius"
          : "Staff member is still within branch radius",
      });
    }

    // Otherwise, check all active check-ins for the owner
    if (!ownerUid) {
      return NextResponse.json(
        { error: "ownerUid is required when not providing checkInId" },
        { status: 400 }
      );
    }

    // Verify tenant access
    if (userData.ownerUid !== ownerUid && !ADMIN_ROLES.includes(userData.role || "")) {
      return NextResponse.json(
        { error: "You can only monitor check-ins for your own salon" },
        { status: 403 }
      );
    }

    // Get all active check-ins for this owner
    const activeCheckInsSnapshot = await adminDb()
      .collection("staff_check_ins")
      .where("ownerUid", "==", ownerUid)
      .where("status", "==", "checked_in")
      .get();

    if (activeCheckInsSnapshot.empty) {
      return NextResponse.json({
        success: true,
        checked: 0,
        autoCheckedOut: 0,
        message: "No active check-ins found",
      });
    }

    let checkedCount = 0;
    let autoCheckedOutCount = 0;
    const results: Array<{
      checkInId: string;
      staffName: string;
      autoCheckedOut: boolean;
      reason?: string;
    }> = [];

    // Note: This endpoint requires location data to be provided
    // For a fully automated solution, you would need to:
    // 1. Store staff's last known location in Firestore
    // 2. Or use a background service that tracks location
    // 3. Or call this endpoint from the mobile app with location data

    return NextResponse.json({
      success: true,
      checked: checkedCount,
      autoCheckedOut: autoCheckedOutCount,
      message: `Checked ${checkedCount} active check-ins. ${autoCheckedOutCount} were auto-checked out.`,
      results,
      note: "This endpoint requires location data. For automated monitoring, use the mobile app's built-in location monitoring or provide location data for each check-in.",
    });
  } catch (error) {
    console.error("Auto-checkout monitoring error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

/**
 * GET /api/staff-check-in/auto-checkout
 * Get information about auto-checkout functionality
 */
export async function GET(req: NextRequest) {
  try {
    // Verify authentication
    const authResult = await verifyAdminAuth(req, ADMIN_ROLES);
    if (!authResult.success) {
      return NextResponse.json(
        { error: authResult.error },
        { status: authResult.status }
      );
    }

    return NextResponse.json({
      success: true,
      message: "Auto-checkout monitoring endpoint",
      description:
        "This endpoint monitors active check-ins and automatically checks out staff who exceed their branch radius.",
      usage: {
        singleCheckIn:
          "POST with { checkInId, currentLatitude, currentLongitude } to check a specific check-in",
        allCheckIns:
          "POST with { ownerUid } to get list of active check-ins (requires location data for each)",
      },
      note: "The mobile app automatically monitors location and performs auto-checkout. This endpoint is for server-side monitoring if needed.",
    });
  } catch (error) {
    console.error("Auto-checkout info error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

