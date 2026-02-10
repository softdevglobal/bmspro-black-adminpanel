import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";
import { verifyAdminAuth, verifyTenantAccess } from "@/lib/authHelpers";

export const runtime = "nodejs";

/**
 * DELETE /api/notifications/[id]
 * Delete a notification
 * 
 * Security: Requires admin authentication. Users can only delete notifications for their tenant.
 */
export async function DELETE(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    // Verify authentication
    const authResult = await verifyAdminAuth(req);
    if (!authResult.success) {
      return NextResponse.json(
        { error: authResult.error },
        { status: authResult.status }
      );
    }

    const { userData } = authResult;
    const { id } = await context.params;

    const db = adminDb();
    const ref = db.doc(`notifications/${id}`);
    const snap = await ref.get();

    if (!snap.exists) {
      return NextResponse.json({ error: "Notification not found" }, { status: 404 });
    }

    const notificationData = snap.data() as {
      ownerUid?: string | null;
      targetOwnerUid?: string | null;
      targetAdminUid?: string | null;
      branchAdminUid?: string | null;
    };

    // Verify tenant access - user can only delete notifications for their tenant
    const notificationOwnerUid = notificationData.ownerUid || 
                                   notificationData.targetOwnerUid || 
                                   notificationData.targetAdminUid ||
                                   notificationData.branchAdminUid;

    if (!verifyTenantAccess(notificationOwnerUid, userData.ownerUid)) {
      return NextResponse.json(
        { error: "You do not have permission to delete this notification" },
        { status: 403 }
      );
    }

    await ref.delete();

    return NextResponse.json({ ok: true, message: "Notification deleted successfully" });
  } catch (error: any) {
    console.error("Error deleting notification:", error);
    const message =
      process.env.NODE_ENV === "production"
        ? "Internal error"
        : error?.message || "Internal error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

