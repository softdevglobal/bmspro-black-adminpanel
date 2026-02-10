import { NextRequest, NextResponse } from "next/server";
import { getAdminApp } from "@/lib/firebaseAdmin";
import { getStorage } from "firebase-admin/storage";
import { getFirestore } from "firebase-admin/firestore";
import { verifyAdminAuth, ADMIN_ROLES } from "@/lib/authHelpers";
import { createAuditLogServer } from "@/lib/auditLogServer";

export const runtime = "nodejs";

/**
 * Upload salon logo via API (server-side)
 * Accepts base64 encoded image data to bypass client-side storage restrictions
 */
export async function POST(req: NextRequest) {
  try {
    // Verify authentication
    const authResult = await verifyAdminAuth(req, ADMIN_ROLES);
    if (!authResult.success) {
      return NextResponse.json(
        { error: authResult.error },
        { status: authResult.status }
      );
    }

    const { userData } = authResult;
    const body = await req.json();
    const { imageData, fileExtension = "jpg" } = body;

    if (!imageData) {
      return NextResponse.json(
        { error: "Missing imageData (base64 encoded image)" },
        { status: 400 }
      );
    }

    // Validate file size (max 5MB when base64 decoded)
    if (imageData.length > 7 * 1024 * 1024) {
      // Base64 is ~33% larger than original
      return NextResponse.json(
        { error: "Image size must be less than 5MB" },
        { status: 400 }
      );
    }

    // Verify user is a salon owner
    if (userData.role?.toLowerCase() !== "salon_owner") {
      return NextResponse.json(
        { error: "Only salon owners can upload logos" },
        { status: 403 }
      );
    }

    try {
      // Initialize Firebase Admin Storage
      const adminApp = getAdminApp();
      const storage = getStorage(adminApp);
      const bucket = storage.bucket();

      // Create unique filename
      const timestamp = Date.now();
      const fileName = `salon-logos/${userData.uid}/logo-${timestamp}.${fileExtension}`;
      const file = bucket.file(fileName);

      // Convert base64 to buffer
      const base64Data = imageData.replace(/^data:image\/\w+;base64,/, "");
      const imageBuffer = Buffer.from(base64Data, "base64");

      // Upload to Firebase Storage
      await file.save(imageBuffer, {
        metadata: {
          contentType: `image/${fileExtension}`,
          metadata: {
            uploadedBy: userData.uid,
            uploadedAt: new Date().toISOString(),
          },
        },
        public: true,
      });

      // Make file publicly accessible
      await file.makePublic();

      // Get Firebase Storage download URL (standard format for public files)
      // Format: https://firebasestorage.googleapis.com/v0/b/{bucket}/o/{path}?alt=media
      const downloadUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(fileName)}?alt=media`;

      // Update Firestore
      const db = getFirestore(adminApp);
      await db.collection("users").doc(userData.uid).update({
        logoUrl: downloadUrl,
        updatedAt: new Date(),
      });

      // Log audit trail
      try {
        await createAuditLogServer({
          ownerUid: userData.uid, // salon owner owns their own profile
          action: `Profile logo changed: ${userData.name || userData.email || "Salon Owner"}`,
          actionType: "update",
          entityType: "user_profile",
          entityId: userData.uid,
          entityName: userData.name || userData.email || "Salon Owner",
          performedBy: userData.uid,
          performedByName: userData.name || userData.email || "Salon Owner",
          performedByRole: userData.role || "salon_owner",
          details: "User changed their profile logo",
        });
      } catch (auditError) {
        console.error("[API] Failed to log profile picture change:", auditError);
        // Don't block the upload if audit logging fails
      }

      return NextResponse.json({
        success: true,
        logoUrl: downloadUrl,
      });
    } catch (storageError: any) {
      console.error("[API] Error uploading logo to storage:", storageError);
      return NextResponse.json(
        {
          error: "Failed to upload logo to storage",
          details: storageError?.message || "Unknown error",
        },
        { status: 500 }
      );
    }
  } catch (error: any) {
    console.error("[API] Error in logo upload API:", error);
    return NextResponse.json(
      {
        error: error?.message || "Unknown error occurred",
      },
      { status: 500 }
    );
  }
}
