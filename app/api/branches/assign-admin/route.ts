import { NextRequest, NextResponse } from "next/server";
import { adminAuth, adminDb } from "@/lib/firebaseAdmin";
import { sendBranchAdminAssignmentEmail } from "@/lib/emailService";
import { FieldValue } from "firebase-admin/firestore";

const DAYS_OF_WEEK = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { branchId, adminStaffId, branchName, branchHours } = body;

    if (!branchId || !adminStaffId) {
      return NextResponse.json(
        { error: "branchId and adminStaffId are required" },
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
    
    // Verify caller has permission (must be salon owner)
    const callerDoc = await db.collection("users").doc(callerUid).get();
    if (!callerDoc.exists) {
      return NextResponse.json(
        { error: "User not found" },
        { status: 404 }
      );
    }

    const callerData = callerDoc.data();
    const callerRole = callerData?.role;
    
    if (callerRole !== "workshop_owner") {
      return NextResponse.json(
        { error: "Unauthorized - Only salon owners can assign branch admins" },
        { status: 403 }
      );
    }

    // Get branch data
    const branchDoc = await db.collection("branches").doc(branchId).get();
    if (!branchDoc.exists) {
      return NextResponse.json(
        { error: "Branch not found" },
        { status: 404 }
      );
    }

    const branchData = branchDoc.data();
    const ownerUid = branchData?.ownerUid;
    
    if (ownerUid !== callerUid) {
      return NextResponse.json(
        { error: "Unauthorized - Branch does not belong to this owner" },
        { status: 403 }
      );
    }

    // Get staff member data
    const staffDoc = await db.collection("users").doc(adminStaffId).get();
    if (!staffDoc.exists) {
      return NextResponse.json(
        { error: "Staff member not found" },
        { status: 404 }
      );
    }

    const staffData = staffDoc.data();
    const staffEmail = staffData?.email;
    const staffName = staffData?.name || staffData?.displayName || "Staff Member";
    
    if (!staffEmail) {
      return NextResponse.json(
        { error: "Staff member does not have an email address" },
        { status: 400 }
      );
    }

    // Get branch name if not provided
    const finalBranchName = branchName || branchData?.name || "Branch";
    const finalBranchHours = branchHours || branchData?.hours;

    // Demote old branch admin if different from new one
    const oldAdminId = branchData?.adminStaffId;
    if (oldAdminId && oldAdminId !== adminStaffId) {
      try {
        await db.collection("users").doc(oldAdminId).update({
          role: "staff",
          systemRole: "staff",
          updatedAt: FieldValue.serverTimestamp(),
        });
        console.log(`Demoted old branch admin ${oldAdminId} to staff`);
      } catch (e) {
        console.error("Failed to demote old branch admin:", e);
      }
    }

    // Build weekly schedule based on branch hours
    const weeklySchedule: Record<string, any> = {};
    if (finalBranchHours && typeof finalBranchHours === "object") {
      for (const day of DAYS_OF_WEEK) {
        const dayHours = (finalBranchHours as any)[day];
        if (dayHours && !dayHours.closed) {
          weeklySchedule[day] = { branchId, branchName: finalBranchName };
        } else {
          weeklySchedule[day] = null;
        }
      }
    } else {
      for (const day of DAYS_OF_WEEK) {
        if (day === "Sunday") {
          weeklySchedule[day] = null;
        } else {
          weeklySchedule[day] = { branchId, branchName: finalBranchName };
        }
      }
    }

    // Promote staff to branch admin using Admin SDK (bypasses Firestore rules)
    await db.collection("users").doc(adminStaffId).update({
      role: "branch_admin",
      systemRole: "branch_admin",
      branchId,
      branchName: finalBranchName,
      weeklySchedule,
      updatedAt: FieldValue.serverTimestamp(),
    });
    console.log(`Promoted staff ${adminStaffId} to branch_admin for branch ${branchId}`);

    // Update branch with adminStaffId
    await db.collection("branches").doc(branchId).update({
      adminStaffId,
      manager: staffName,
      email: staffEmail,
      updatedAt: FieldValue.serverTimestamp(),
    });

    // Get salon name for email
    let salonName: string | undefined;
    try {
      const ownerDoc = await db.collection("users").doc(ownerUid).get();
      if (ownerDoc.exists) {
        const ownerData = ownerDoc.data();
        salonName = ownerData?.salonName || ownerData?.name || ownerData?.businessName || ownerData?.displayName;
      }
    } catch (e) {
      console.error("Failed to fetch salon name for branch admin email:", e);
    }

    // Send branch admin assignment email
    try {
      await sendBranchAdminAssignmentEmail(staffEmail, staffName, finalBranchName, salonName);
    } catch (emailError) {
      console.error("Failed to send branch admin assignment email:", emailError);
      // Don't fail the request if email fails
    }

    return NextResponse.json({
      success: true,
      message: "Branch admin assigned and email sent",
    });
  } catch (error: any) {
    console.error("Error assigning branch admin:", error);
    return NextResponse.json(
      { error: error.message || "Failed to assign branch admin" },
      { status: 500 }
    );
  }
}
