import { NextRequest, NextResponse } from "next/server";
import { adminDb, adminMessaging } from "@/lib/firebaseAdmin";
import { verifyAdminAuth } from "@/lib/authHelpers";
import { Message } from "firebase-admin/messaging";

export const runtime = "nodejs";

/**
 * POST /api/notifications/send-push
 * Send FCM push notification to a user
 * 
 * This endpoint is called by the mobile app to send push notifications
 * when creating booking approval requests or other notifications.
 * 
 * Requires authentication - any authenticated user (owner, admin, staff) can call this.
 */
export async function POST(req: NextRequest) {
  try {
    console.log("📥 Received push notification request");
    
    // Verify authentication
    const authResult = await verifyAdminAuth(req);
    if (!authResult.success) {
      console.error("❌ Authentication failed:", authResult.error);
      return NextResponse.json(
        { error: authResult.error },
        { status: authResult.status }
      );
    }

    console.log("✅ Authentication successful");
    const body = await req.json();
    const { staffUid, title, message, data } = body;

    console.log("📋 Request data:", { staffUid, title, message: message?.substring(0, 50) + "..." });

    if (!staffUid || !title || !message) {
      console.error("❌ Missing required fields");
      return NextResponse.json(
        { error: "Missing required fields: staffUid, title, message" },
        { status: 400 }
      );
    }

    // Get FCM token for the staff member
    const db = adminDb();
    console.log("🔍 Looking up FCM token for staff:", staffUid);
    const userDoc = await db.collection("users").doc(staffUid).get();
    
    if (!userDoc.exists) {
      console.error("❌ User not found:", staffUid);
      return NextResponse.json(
        { error: "User not found" },
        { status: 404 }
      );
    }

    const userData = userDoc.data();
    const fcmToken = userData?.fcmToken;

    console.log("🔑 FCM token found:", fcmToken ? "Yes" : "No");

    if (!fcmToken) {
      console.error("❌ User does not have FCM token registered");
      return NextResponse.json(
        { error: "User does not have an FCM token registered" },
        { status: 404 }
      );
    }

    // Send push notification
    const messaging = adminMessaging();
    
    const notificationMessage: Message = {
      token: fcmToken,
      notification: {
        title,
        body: message,
      },
      data: data || {},
      android: {
        priority: "high",
        ttl: 86400000, // 24 hours in milliseconds
        notification: {
          sound: "default",
          channelId: "appointments",
          priority: "high",
          defaultSound: true,
          defaultVibrateTimings: true,
        },
      },
      apns: {
        headers: {
          "apns-priority": "10", // High priority for immediate delivery
          "apns-push-type": "alert",
        },
        payload: {
          aps: {
            alert: {
              title,
              body: message,
            },
            sound: "default",
            badge: 1,
            "content-available": 1, // Wake up app in background
            "mutable-content": 1,   // Allow notification modification
          },
        },
      },
    };

    console.log("📤 Sending FCM message to token:", fcmToken.substring(0, 20) + "...");
    const response = await messaging.send(notificationMessage);
    console.log("✅ FCM message sent successfully, message ID:", response);

    return NextResponse.json({
      success: true,
      message: "Push notification sent successfully",
      messageId: response,
    });
  } catch (error: any) {
    console.error("Error sending push notification:", error);
    
    // Handle specific FCM errors
    if (error.code === "messaging/invalid-registration-token" || 
        error.code === "messaging/registration-token-not-registered") {
      return NextResponse.json(
        { error: "Invalid or unregistered FCM token" },
        { status: 400 }
      );
    }

    return NextResponse.json(
      { error: "Failed to send push notification", details: error.message },
      { status: 500 }
    );
  }
}

