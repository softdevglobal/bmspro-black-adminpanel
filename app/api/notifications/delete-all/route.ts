import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";
import { verifyAdminAuth } from "@/lib/authHelpers";

export const runtime = "nodejs";

/**
 * DELETE /api/notifications/delete-all
 * Delete all notifications for the authenticated user's tenant
 * 
 * Security: Requires admin authentication. Users can only delete notifications for their tenant.
 */
export async function DELETE(req: NextRequest) {
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
    const db = adminDb();

    // Query all notifications for this tenant
    // Notifications can be targeted via ownerUid, targetOwnerUid, targetAdminUid, or branchAdminUid
    const notificationsSnapshot = await db
      .collection("notifications")
      .where("ownerUid", "==", userData.ownerUid)
      .get();

    // Also get notifications targeted via other fields
    const [targetOwnerSnapshot, targetAdminSnapshot, branchAdminSnapshot] = await Promise.all([
      db.collection("notifications")
        .where("targetOwnerUid", "==", userData.ownerUid)
        .get(),
      db.collection("notifications")
        .where("targetAdminUid", "==", userData.ownerUid)
        .get(),
      db.collection("notifications")
        .where("branchAdminUid", "==", userData.ownerUid)
        .get(),
    ]);

    // Combine all notification references
    const allNotifications: FirebaseFirestore.DocumentReference[] = [];
    
    notificationsSnapshot.forEach((doc) => allNotifications.push(doc.ref));
    targetOwnerSnapshot.forEach((doc) => {
      // Avoid duplicates
      if (!allNotifications.some(ref => ref.id === doc.id)) {
        allNotifications.push(doc.ref);
      }
    });
    targetAdminSnapshot.forEach((doc) => {
      if (!allNotifications.some(ref => ref.id === doc.id)) {
        allNotifications.push(doc.ref);
      }
    });
    branchAdminSnapshot.forEach((doc) => {
      if (!allNotifications.some(ref => ref.id === doc.id)) {
        allNotifications.push(doc.ref);
      }
    });

    // Delete all notifications in batch
    if (allNotifications.length > 0) {
      // Firestore batch limit is 500 operations
      const batchSize = 500;
      for (let i = 0; i < allNotifications.length; i += batchSize) {
        const batch = db.batch();
        const batchNotifications = allNotifications.slice(i, i + batchSize);
        
        batchNotifications.forEach((ref) => {
          batch.delete(ref);
        });
        
        await batch.commit();
      }
    }

    return NextResponse.json({ 
      ok: true, 
      message: `Deleted ${allNotifications.length} notifications successfully` 
    });
  } catch (error: any) {
    console.error("Error deleting all notifications:", error);
    const message =
      process.env.NODE_ENV === "production"
        ? "Internal error"
        : error?.message || "Internal error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

