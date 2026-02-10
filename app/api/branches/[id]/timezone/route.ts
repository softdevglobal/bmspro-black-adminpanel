import { NextRequest, NextResponse } from "next/server";
import { adminAuth, adminDb } from "@/lib/firebaseAdmin";
import { FieldValue } from "firebase-admin/firestore";

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const body = await req.json();
    const { timezone } = body;

    if (!timezone || typeof timezone !== "string") {
      return NextResponse.json(
        { error: "timezone is required and must be a string" },
        { status: 400 }
      );
    }

    // Get auth token from header
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return NextResponse.json(
        { error: "Unauthorized - No token provided" },
        { status: 401 }
      );
    }

    const token = authHeader.substring(7);
    const decodedToken = await adminAuth().verifyIdToken(token);
    const callerUid = decodedToken.uid;

    const db = adminDb();
    
    // Verify caller has permission (must be salon owner or branch admin of this branch)
    const callerDoc = await db.collection("users").doc(callerUid).get();
    if (!callerDoc.exists) {
      return NextResponse.json(
        { error: "User not found" },
        { status: 404 }
      );
    }

    const callerData = callerDoc.data();
    const callerRole = callerData?.role;
    
    // Get branch data
    const branchDoc = await db.collection("branches").doc(id).get();
    if (!branchDoc.exists) {
      return NextResponse.json(
        { error: "Branch not found" },
        { status: 404 }
      );
    }

    const branchData = branchDoc.data();
    const ownerUid = branchData?.ownerUid;
    const adminStaffId = branchData?.adminStaffId;
    
    // Check permissions: salon owner or branch admin of this branch
    const isOwner = callerRole === "salon_owner" && ownerUid === callerUid;
    const isBranchAdmin = callerRole === "salon_branch_admin" && adminStaffId === callerUid;
    
    if (!isOwner && !isBranchAdmin) {
      return NextResponse.json(
        { error: "Unauthorized - Only salon owners or branch admins can update branch timezone" },
        { status: 403 }
      );
    }

    // Update branch timezone
    await db.collection("branches").doc(id).update({
      timezone,
      updatedAt: FieldValue.serverTimestamp(),
    });

    // Also update user timezone for branch admin for consistency
    if (isBranchAdmin) {
      await db.collection("users").doc(callerUid).update({
        timezone,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }

    return NextResponse.json({
      success: true,
      message: "Branch timezone updated successfully",
      timezone,
    });
  } catch (error: any) {
    console.error("Error updating branch timezone:", error);
    return NextResponse.json(
      { error: error.message || "Failed to update branch timezone" },
      { status: 500 }
    );
  }
}
