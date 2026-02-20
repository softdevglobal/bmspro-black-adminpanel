import { NextRequest, NextResponse } from "next/server";
import { adminAuth, adminDb } from "@/lib/firebaseAdmin";
import { FieldValue } from "firebase-admin/firestore";
import { normalizeBookingStatus, areAllServicesCompleted, type BookingService, type ServiceCompletionStatus } from "@/lib/bookingTypes";
import { createNotification, getNotificationContent } from "@/lib/notifications";
import { sendBookingStatusChangeEmail } from "@/lib/emailService";

/**
 * PUT /api/bookings/[id]/tasks
 * Update a single task within a booking (mark done, upload image, add description)
 * Only the assigned staff member can update tasks.
 *
 * Body: { taskId, done, imageUrl?, staffNote? }
 */
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: bookingId } = await params;
    if (!bookingId) {
      return NextResponse.json({ error: "Booking ID is required" }, { status: 400 });
    }

    // Authenticate
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const token = authHeader.slice(7);
    const decoded = await adminAuth().verifyIdToken(token);
    const currentUserId = decoded.uid;

    const body = await req.json();
    const { taskId, done, imageUrl, staffNote } = body;

    if (!taskId) {
      return NextResponse.json({ error: "taskId is required" }, { status: 400 });
    }

    const db = adminDb();
    const bookingRef = db.collection("bookings").doc(bookingId);
    const bookingSnap = await bookingRef.get();

    if (!bookingSnap.exists) {
      return NextResponse.json({ error: "Booking not found" }, { status: 404 });
    }

    const bookingData = bookingSnap.data()!;

    // Permission check: only assigned staff can update tasks
    const isAssignedStaff = checkStaffAssignment(bookingData, currentUserId);
    if (!isAssignedStaff) {
      return NextResponse.json(
        { error: "Only the assigned staff member can update tasks" },
        { status: 403 }
      );
    }

    // Update the specific task in the tasks array
    const tasks: any[] = bookingData.tasks || [];
    const taskIndex = tasks.findIndex((t: any) => t.id === taskId);

    if (taskIndex === -1) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }

    // Get staff display name
    let staffName = decoded.name || "Staff";
    try {
      const userDoc = await db.collection("users").doc(currentUserId).get();
      if (userDoc.exists) {
        staffName = userDoc.data()?.name || userDoc.data()?.displayName || staffName;
      }
    } catch { /* ignore */ }

    // Update the task
    tasks[taskIndex] = {
      ...tasks[taskIndex],
      done: done !== undefined ? !!done : tasks[taskIndex].done,
      imageUrl: imageUrl !== undefined ? imageUrl : tasks[taskIndex].imageUrl,
      staffNote: staffNote !== undefined ? staffNote : tasks[taskIndex].staffNote,
      ...(done ? {
        completedAt: new Date().toISOString(),
        completedByStaffUid: currentUserId,
        completedByStaffName: staffName,
      } : {}),
    };

    // Recalculate progress
    const total = tasks.length;
    const completed = tasks.filter((t: any) => t.done).length;
    const taskProgress = total > 0 ? Math.round((completed / total) * 100) : 0;

    await bookingRef.update({
      tasks,
      taskProgress,
      updatedAt: FieldValue.serverTimestamp(),
    });

    return NextResponse.json({
      success: true,
      taskProgress,
      completed,
      total,
    });
  } catch (error: any) {
    console.error("Error updating task:", error);
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/bookings/[id]/tasks
 * Submit final submission after all tasks are completed.
 * Only the assigned staff member can submit.
 *
 * Body: { description, imageUrl }
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: bookingId } = await params;
    if (!bookingId) {
      return NextResponse.json({ error: "Booking ID is required" }, { status: 400 });
    }

    // Authenticate
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const token = authHeader.slice(7);
    const decoded = await adminAuth().verifyIdToken(token);
    const currentUserId = decoded.uid;

    const body = await req.json();
    const { description, imageUrl } = body;

    if (!description && !imageUrl) {
      return NextResponse.json(
        { error: "Description or image is required for final submission" },
        { status: 400 }
      );
    }

    const db = adminDb();
    const bookingRef = db.collection("bookings").doc(bookingId);
    const bookingSnap = await bookingRef.get();

    if (!bookingSnap.exists) {
      return NextResponse.json({ error: "Booking not found" }, { status: 404 });
    }

    const bookingData = bookingSnap.data()!;

    // Permission check: only assigned staff can submit
    const isAssignedStaff = checkStaffAssignment(bookingData, currentUserId);
    if (!isAssignedStaff) {
      return NextResponse.json(
        { error: "Only the assigned staff member can submit the final report" },
        { status: 403 }
      );
    }

    // Check all tasks are completed
    const tasks: any[] = bookingData.tasks || [];
    if (tasks.length > 0) {
      const allDone = tasks.every((t: any) => t.done);
      if (!allDone) {
        return NextResponse.json(
          { error: "All tasks must be completed before final submission" },
          { status: 400 }
        );
      }
    }

    // Get staff display name
    let staffName = decoded.name || "Staff";
    try {
      const userDoc = await db.collection("users").doc(currentUserId).get();
      if (userDoc.exists) {
        staffName = userDoc.data()?.name || userDoc.data()?.displayName || staffName;
      }
    } catch { /* ignore */ }

    const finalSubmission = {
      description: description || "",
      imageUrl: imageUrl || "",
      submittedAt: new Date().toISOString(),
      submittedByStaffUid: currentUserId,
      submittedByStaffName: staffName,
    };

    const updateData: Record<string, any> = {
      finalSubmission,
      taskProgress: 100,
      updatedAt: FieldValue.serverTimestamp(),
    };

    // Auto-complete the booking/service when final submission is done
    const currentStatus = normalizeBookingStatus(bookingData.status);
    let bookingCompleted = false;

    if (currentStatus === "Confirmed") {
      const hasMultipleServices = Array.isArray(bookingData.services) && bookingData.services.length > 0;

      if (hasMultipleServices) {
        const services: BookingService[] = bookingData.services;
        const updatedServices = services.map(service => {
          const isStaffService = service.staffId === currentUserId || (service as any).staffAuthUid === currentUserId;
          if (isStaffService && service.completionStatus !== "completed") {
            return {
              ...service,
              completionStatus: "completed" as ServiceCompletionStatus,
              completedAt: new Date().toISOString(),
              completedByStaffUid: currentUserId,
              completedByStaffName: staffName,
            };
          }
          return service;
        });
        updateData.services = updatedServices;
        bookingCompleted = areAllServicesCompleted(updatedServices);
      } else {
        bookingCompleted = true;
        updateData.completedByStaffUid = currentUserId;
        updateData.completedByStaffName = staffName;
      }

      if (bookingCompleted) {
        updateData.status = "Completed";
        updateData.completedAt = FieldValue.serverTimestamp();
      }
    }

    await bookingRef.update(updateData);

    // Send notifications and email when booking is fully completed
    if (bookingCompleted) {
      const ownerUid = bookingData.ownerUid || currentUserId;
      const clientName = bookingData.client || bookingData.clientName || "Customer";
      try {
        const notificationContent = getNotificationContent(
          "Completed",
          bookingData.bookingCode,
          staffName,
          bookingData.serviceName,
          bookingData.date,
          bookingData.time,
          (bookingData.services || []).map((s: any) => ({
            name: s.name || "Service",
            staffName: s.staffName || "Staff",
          }))
        );
        const notificationData: any = {
          bookingId,
          type: notificationContent.type,
          title: notificationContent.title,
          message: notificationContent.message,
          status: "Completed",
          ownerUid,
        };
        if (bookingData.customerUid) notificationData.customerUid = bookingData.customerUid;
        if (bookingData.clientEmail) notificationData.customerEmail = bookingData.clientEmail;
        if (bookingData.bookingCode) notificationData.bookingCode = bookingData.bookingCode;
        if (bookingData.branchName) notificationData.branchName = bookingData.branchName;
        if (bookingData.branchId) notificationData.branchId = bookingData.branchId;
        notificationData.staffName = staffName;
        notificationData.serviceName = bookingData.serviceName;
        await createNotification(notificationData);
      } catch (e) {
        console.error("Failed to send completion notification:", e);
      }

      try {
        await sendBookingStatusChangeEmail(
          bookingId,
          "Completed",
          bookingData.clientEmail,
          clientName,
          ownerUid,
          {
            bookingCode: bookingData.bookingCode,
            branchName: bookingData.branchName,
            bookingDate: bookingData.date,
            bookingTime: bookingData.time,
            duration: bookingData.duration,
            price: bookingData.price,
            serviceName: bookingData.serviceName,
            staffName,
          }
        );
      } catch (e) {
        console.error("Failed to send completion email:", e);
      }
    }

    return NextResponse.json({ success: true, finalSubmission, bookingCompleted });
  } catch (error: any) {
    console.error("Error submitting final report:", error);
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    );
  }
}

/**
 * Check if a user is assigned as staff for this booking
 * Checks: booking.staffId, booking.services[].staffId, booking.services[].staffAuthUid
 */
function checkStaffAssignment(bookingData: any, userId: string): boolean {
  // Check top-level staffId
  if (bookingData.staffId === userId) return true;

  // Check services array
  if (Array.isArray(bookingData.services)) {
    for (const svc of bookingData.services) {
      if (svc.staffId === userId || svc.staffAuthUid === userId) return true;
    }
  }

  return false;
}
