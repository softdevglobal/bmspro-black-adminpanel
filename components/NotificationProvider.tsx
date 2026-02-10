"use client";
import React, { createContext, useContext, useEffect, useRef, useState, ReactNode, useMemo } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { collection, query, where, onSnapshot } from "firebase/firestore";
import ToastNotification from "./ToastNotification";

interface Notification {
  id: string;
  bookingId: string;
  type: string;
  title: string;
  message: string;
  serviceName?: string;
  branchName?: string;
  date?: string;
  time?: string;
  price?: number;
  createdAt: Date;
  read: boolean;
  status?: string;
}

interface NotificationContextType {
  notifications: Notification[];
  unreadCount: number;
  markAsRead: (id: string) => Promise<void>;
  markAllAsRead: () => Promise<void>;
  deleteNotification: (id: string) => Promise<void>;
  deleteAllNotifications: () => Promise<void>;
}

const NotificationContext = createContext<NotificationContextType | undefined>(undefined);

export const useNotifications = () => {
  const context = useContext(NotificationContext);
  if (!context) {
    throw new Error("useNotifications must be used within NotificationProvider");
  }
  return context;
};

interface NotificationProviderProps {
  children: ReactNode;
}

export default function NotificationProvider({ children }: NotificationProviderProps) {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [pendingBookings, setPendingBookings] = useState<any[]>([]);
  const [readPendingBookings, setReadPendingBookings] = useState<Set<string>>(new Set());
  const [dismissedPendingBookings, setDismissedPendingBookings] = useState<Set<string>>(new Set()); // Track deleted/dismissed pending booking notifications
  const [dismissedNotificationIds, setDismissedNotificationIds] = useState<Set<string>>(new Set()); // Track deleted Firestore notification IDs (persist across sessions)
  const [unreadCount, setUnreadCount] = useState(0);
  const [toastNotifications, setToastNotifications] = useState<any[]>([]);
  const [ownerUid, setOwnerUid] = useState<string | null>(null);
  const [isSuperAdmin, setIsSuperAdmin] = useState<boolean>(false);
  const previousNotificationIdsRef = useRef<Set<string>>(new Set());
  const previousPendingIdsRef = useRef<Set<string>>(new Set());
  const isInitialLoadRef = useRef(true);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioInitializedRef = useRef(false);

  // Load dismissed notifications from localStorage on mount
  useEffect(() => {
    if (typeof window !== "undefined") {
      try {
        const dismissedPending = localStorage.getItem("dismissedPendingBookings");
        const dismissedNotifs = localStorage.getItem("dismissedNotificationIds");
        
        if (dismissedPending) {
          setDismissedPendingBookings(new Set(JSON.parse(dismissedPending)));
        }
        if (dismissedNotifs) {
          setDismissedNotificationIds(new Set(JSON.parse(dismissedNotifs)));
        }
      } catch (error) {
        console.error("Error loading dismissed notifications from localStorage:", error);
      }
    }
  }, []);

  // Save dismissed pending bookings to localStorage when changed
  useEffect(() => {
    if (typeof window !== "undefined" && dismissedPendingBookings.size > 0) {
      try {
        localStorage.setItem("dismissedPendingBookings", JSON.stringify([...dismissedPendingBookings]));
      } catch (error) {
        console.error("Error saving dismissed pending bookings:", error);
      }
    }
  }, [dismissedPendingBookings]);

  // Save dismissed notification IDs to localStorage when changed
  useEffect(() => {
    if (typeof window !== "undefined" && dismissedNotificationIds.size > 0) {
      try {
        localStorage.setItem("dismissedNotificationIds", JSON.stringify([...dismissedNotificationIds]));
      } catch (error) {
        console.error("Error saving dismissed notification IDs:", error);
      }
    }
  }, [dismissedNotificationIds]);

  // Initialize audio element for notification sound
  useEffect(() => {
    if (typeof window !== "undefined" && !audioInitializedRef.current) {
      try {
        // Use the correct path to the sound file in public/sounds
        const audio = new Audio("/sounds/shopify_sale_sound.mp3");
        audio.volume = 0.7; // Set volume to 70%
        audio.preload = "auto";
        
        // Handle audio loading errors
        audio.addEventListener("error", (e) => {
          console.error("Audio loading error:", e);
          console.error("Audio error details:", {
            code: audio.error?.code,
            message: audio.error?.message,
            src: audio.src,
          });
        });

        // Handle successful load
        audio.addEventListener("canplaythrough", () => {
          console.log("Audio file loaded and ready to play");
        });

        // Load the audio (load() doesn't return a promise, it's a void method)
        try {
          audio.load();
        } catch (error) {
          console.error("Error loading audio file:", error);
        }

        audioRef.current = audio;
        audioInitializedRef.current = true;
      } catch (error) {
        console.error("Error initializing audio:", error);
      }
    }
  }, []);

  // Play notification sound
  const playNotificationSound = () => {
    if (!audioInitializedRef.current) {
      console.log("Audio not initialized yet");
      return;
    }

    try {
      // Create a new Audio instance each time to ensure it plays
      // This avoids issues with cloning and ensures the file is loaded fresh
      const audio = new Audio("/sounds/shopify_sale_sound.mp3");
      audio.volume = 0.7;
      
      // Reset to start
      audio.currentTime = 0;
      
      // Handle errors for this specific playback
      audio.addEventListener("error", (e) => {
        console.error("Error playing notification sound:", e);
        console.error("Audio src:", audio.src);
      });
      
      // Play the sound
      const playPromise = audio.play();
      
      if (playPromise !== undefined) {
        playPromise
          .then(() => {
            // Audio is playing successfully
            console.log("Notification sound played successfully");
          })
          .catch((error) => {
            // Autoplay was prevented or other error
            console.log("Autoplay prevented or error:", error.name, error.message);
            // Try to play on next user interaction
            const enableAudio = () => {
              const retryAudio = new Audio("/sounds/shopify_sale_sound.mp3");
              retryAudio.volume = 0.7;
              retryAudio.play().catch(() => {
                console.log("Still unable to play audio after user interaction");
              });
              document.removeEventListener("click", enableAudio, { capture: true });
              document.removeEventListener("touchstart", enableAudio, { capture: true });
            };
            document.addEventListener("click", enableAudio, { once: true, capture: true });
            document.addEventListener("touchstart", enableAudio, { once: true, capture: true });
          });
      }
    } catch (error) {
      console.error("Error playing notification sound:", error);
    }
  };

  // Show toast notification
  const showToastNotification = (notification: Notification | any) => {
    const id = `toast-${Date.now()}-${Math.random()}`;
    
    // Handle both Notification objects and booking objects
    const isNotification = notification.title && notification.message;
    
    const toast = {
      id,
      title: isNotification ? notification.title : "New Booking Request!",
      message: isNotification 
        ? notification.message 
        : `${notification.customerName || notification.clientName || "A customer"} requested a booking`,
      serviceName: notification.serviceName || notification.services?.[0]?.name || "Service",
      price: notification.price || notification.totalPrice,
      bookingId: notification.bookingId || notification.id,
      type: notification.type || "booking_request",
      branchName: notification.branchName,
      date: notification.date || notification.bookingDate,
      time: notification.time || notification.bookingTime,
    };
    
    console.log("🔔 Showing toast notification:", toast);
    setToastNotifications((prev) => [...prev, toast]);

    // Auto remove after 8 seconds (increased for better visibility)
    setTimeout(() => {
      setToastNotifications((prev) => prev.filter((t) => t.id !== id));
    }, 8000);
  };

  // Authentication and user setup
  useEffect(() => {
    (async () => {
      const { auth, db } = await import("@/lib/firebase");
      const { doc, getDoc } = await import("firebase/firestore");
      const unsub = onAuthStateChanged(auth, async (user) => {
        if (!user) {
          setOwnerUid(null);
          setIsSuperAdmin(false);
          return;
        }
        try {
          setOwnerUid(user.uid);

          // Check if user is super admin or branch admin
          // Check super_admins collection first
          const superAdminDoc = await getDoc(doc(db, "super_admins", user.uid));
          let userData: any;
          let role: string;
          
          if (superAdminDoc.exists()) {
            userData = superAdminDoc.data();
            role = "super_admin";
          } else {
            const userDoc = await getDoc(doc(db, "users", user.uid));
            userData = userDoc.data();
            role = userData?.role || "";
          }

          setIsSuperAdmin(role === "super_admin");

          // For branch admin, use their owner UID for notifications
          if (role === "salon_branch_admin" && userData?.ownerUid) {
            setOwnerUid(userData.ownerUid);
          }
        } catch (error) {
          console.error("Error fetching user data:", error);
        }
      });

      return () => unsub();
    })();
  }, []);

  // Listen to notifications collection from Firestore
  useEffect(() => {
    if (!ownerUid || isSuperAdmin) return;

    let unsubNotifications: (() => void) | undefined;
    let unsubBookings: (() => void) | undefined;

    (async () => {
      const { db, auth } = await import("@/lib/firebase");
      const { doc, getDoc } = await import("firebase/firestore");
      
      // Ensure user is authenticated before setting up listeners
      const user = auth.currentUser;
      if (!user) {
        console.warn("User not authenticated, skipping notification listeners");
        return;
      }

      // Subscribe to notifications collection for this owner
      // We need to listen for multiple notification types:
      // 1. ownerUid - general owner notifications
      // 2. targetOwnerUid - specific owner-targeted notifications (staff created bookings, etc.)
      // 3. targetAdminUid - admin-targeted notifications (staff rejections, etc.)
      const notificationsQuery = query(
        collection(db, "notifications"),
        where("ownerUid", "==", ownerUid)
      );

      // Also listen for targetOwnerUid notifications (for staff-created booking notifications)
      const targetOwnerQuery = query(
        collection(db, "notifications"),
        where("targetOwnerUid", "==", ownerUid)
      );

      // Also listen for targetAdminUid notifications
      const targetAdminQuery = query(
        collection(db, "notifications"),
        where("targetAdminUid", "==", ownerUid)
      );

      // Track notifications from all queries to deduplicate
      const allNotificationsMap = new Map<string, Notification>();
      const queryLoadedFlags = { main: false, targetOwner: false, targetAdmin: false };

      const processNotifications = async () => {
        // Wait until all queries have loaded once
        if (!queryLoadedFlags.main || !queryLoadedFlags.targetOwner || !queryLoadedFlags.targetAdmin) {
          return;
        }

        const allNotifs = Array.from(allNotificationsMap.values())
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(0, 50);

        // Find new notifications (IDs that weren't in previous snapshot)
        const currentNotificationIds = new Set(allNotifs.map((n) => n.id));
        const newNotifications = allNotifs.filter(
          (n) => !previousNotificationIdsRef.current.has(n.id)
        );

        // Only play sound and show toast after initial load
        // Filter to only relevant notification types before showing toast
        if (!isInitialLoadRef.current && newNotifications.length > 0) {
          // Only show toast for relevant notifications:
          // 1. New booking notifications (if still pending)
          // 2. Staff rejected notifications
          // 3. Not previously dismissed
          const relevantNotifications = newNotifications.filter((notif) => {
            // Skip dismissed notifications
            if (dismissedNotificationIds.has(notif.id)) {
              return false;
            }
            
            const isNewBooking = 
              notif.type === "booking_engine_new_booking" ||
              notif.type === "staff_booking_created" ||
              notif.type === "booking_needs_assignment" ||
              notif.type === "booking_request";
            
            const isStaffRejected = notif.type === "staff_rejected";
            
            if (isNewBooking) {
              const isPending = !notif.status || 
                notif.status === "Pending" || 
                notif.status === "AwaitingStaffApproval" ||
                notif.status === "PartiallyApproved";
              return isPending;
            }
            
            return isStaffRejected;
          });
          
          if (relevantNotifications.length > 0) {
            console.log("🔔 New relevant notifications:", relevantNotifications.length);
            
            // Play notification sound
            playNotificationSound();

            // Show toast notifications for new notifications - pass full notification object
            relevantNotifications.forEach((notif) => {
              showToastNotification(notif);
            });
          }
        }

        // Store notifications from Firestore (will be combined with pending bookings)
        setNotifications(allNotifs);

        // Update previous IDs ref
        previousNotificationIdsRef.current = currentNotificationIds;

        // Mark initial load as complete
        if (isInitialLoadRef.current) {
          isInitialLoadRef.current = false;
        }
      };

      const processSnapshot = async (snapshot: any, queryName: string) => {
        for (const docSnapshot of snapshot.docs) {
          const data = docSnapshot.data();
          const notifId = docSnapshot.id;
          
          // Skip if this notification was previously dismissed/deleted
          if (dismissedNotificationIds.has(notifId)) {
            continue;
          }
          
          // Get booking status to filter out confirmed/canceled
          let bookingStatus = data.status;
          if (data.bookingId) {
            try {
              const bookingDoc = await getDoc(doc(db, "bookings", data.bookingId));
              if (bookingDoc.exists()) {
                bookingStatus = bookingDoc.data()?.status || data.status;
              }
            } catch (error) {
              console.error("Error fetching booking status:", error);
            }
          }

          // ADMIN NOTIFICATION RULES:
          // Only show notifications for:
          // 1. New Booking Created (booking_engine_new_booking, staff_booking_created, booking_needs_assignment, booking_request)
          // 2. Staff Rejected a Service (staff_rejected)
          // 
          // DO NOT show notifications for:
          // - Booking confirmation (booking_confirmed)
          // - Booking completion (booking_completed)
          // - Status changes after confirmation
          // - Normal service acceptance by staff (staff_accepted)
          
          const isNewBookingNotification = 
            data.type === "booking_engine_new_booking" ||
            data.type === "staff_booking_created" ||
            data.type === "booking_needs_assignment" ||
            data.type === "booking_request";
          
          const isStaffRejectedNotification = data.type === "staff_rejected";
          
          // Only show new booking notifications if booking is still pending/awaiting
          const isPendingStatus = !bookingStatus || 
            bookingStatus === "Pending" || 
            bookingStatus === "AwaitingStaffApproval" ||
            bookingStatus === "PartiallyApproved";
          
          const shouldShow = 
            (isNewBookingNotification && isPendingStatus) || 
            isStaffRejectedNotification;

          if (!shouldShow) {
            continue;
          }

          const notification: Notification = {
            id: notifId,
            bookingId: data.bookingId || "",
            type: data.type || "booking_request",
            title: data.title || "Notification",
            message: data.message || "",
            serviceName: data.serviceName || data.services?.[0]?.name,
            branchName: data.branchName || "",
            date: data.bookingDate || data.date,
            time: data.bookingTime || data.time,
            price: data.price,
            createdAt: data.createdAt?.toDate ? data.createdAt.toDate() : new Date(data.createdAt?.seconds * 1000 || Date.now()),
            read: data.read || false,
            status: bookingStatus || data.status,
          };
          
          allNotificationsMap.set(notifId, notification);
        }

        // Mark this query as loaded
        if (queryName === "main") queryLoadedFlags.main = true;
        if (queryName === "targetOwner") queryLoadedFlags.targetOwner = true;
        if (queryName === "targetAdmin") queryLoadedFlags.targetAdmin = true;

        // Process all notifications
        await processNotifications();
      };

      // Subscribe to main ownerUid notifications
      unsubNotifications = onSnapshot(
        notificationsQuery,
        async (snapshot) => {
          await processSnapshot(snapshot, "main");
        },
        (error) => {
          // Suppress permission-denied errors to prevent uncaught error logs
          if (error.code === "permission-denied") {
            console.warn("Permission denied for owner notifications. User may not have access.");
            queryLoadedFlags.main = true;
            processNotifications();
            return; // Don't log as error, just handle gracefully
          }
          console.error("Error listening to owner notifications:", error);
          queryLoadedFlags.main = true;
          processNotifications();
        }
      );

      // Subscribe to targetOwnerUid notifications
      const unsubTargetOwner = onSnapshot(
        targetOwnerQuery,
        async (snapshot) => {
          await processSnapshot(snapshot, "targetOwner");
        },
        (error) => {
          // Suppress permission-denied errors to prevent uncaught error logs
          if (error.code === "permission-denied") {
            console.warn("Permission denied for target owner notifications. User may not have access.");
            queryLoadedFlags.targetOwner = true;
            processNotifications();
            return; // Don't log as error, just handle gracefully
          }
          console.error("Error listening to target owner notifications:", error);
          queryLoadedFlags.targetOwner = true;
          processNotifications();
        }
      );

      // Subscribe to targetAdminUid notifications
      const unsubTargetAdmin = onSnapshot(
        targetAdminQuery,
        async (snapshot) => {
          await processSnapshot(snapshot, "targetAdmin");
        },
        (error) => {
          // Suppress permission-denied errors to prevent uncaught error logs
          if (error.code === "permission-denied") {
            console.warn("Permission denied for target admin notifications. User may not have access.");
            queryLoadedFlags.targetAdmin = true;
            processNotifications();
            return; // Don't log as error, just handle gracefully
          }
          console.error("Error listening to target admin notifications:", error);
          queryLoadedFlags.targetAdmin = true;
          processNotifications();
        }
      );

      // Store unsubscribe for targetOwner and targetAdmin
      const originalUnsub = unsubNotifications;
      unsubNotifications = () => {
        originalUnsub?.();
        unsubTargetOwner?.();
        unsubTargetAdmin?.();
      };

      // Also listen to pending bookings to include them in the notification panel
      const pendingQuery = query(
        collection(db, "bookings"),
        where("ownerUid", "==", ownerUid),
        where("status", "==", "Pending")
      );

      unsubBookings = onSnapshot(
        pendingQuery,
        (snapshot) => {
          const bookings = snapshot.docs.map((doc) => ({
            id: doc.id,
            ...doc.data(),
          }));

          // Find new bookings (these are NEW booking requests - should notify)
          const currentPendingIds = new Set(bookings.map((b: any) => b.id));
          const newBookings = bookings.filter(
            (b: any) => !previousPendingIdsRef.current.has(b.id) && !dismissedPendingBookings.has(b.id)
          );

          // Only trigger for genuinely new pending bookings after initial load
          // This represents "New Booking Created" scenario
          if (!isInitialLoadRef.current && newBookings.length > 0) {
            console.log("🔔 New pending bookings detected:", newBookings.length);
            
            // Play notification sound
            playNotificationSound();

            // Show toast notifications for new booking requests
            newBookings.forEach((booking: any) => {
              showToastNotification(booking);
            });
          }

          // Update pending bookings state
          setPendingBookings(bookings);
          previousPendingIdsRef.current = currentPendingIds;
        },
        (error) => {
          // Suppress permission-denied errors to prevent uncaught error logs
          if (error.code === "permission-denied") {
            console.warn("Permission denied for pending bookings query. User may not have access.");
            setPendingBookings([]);
            return; // Don't log as error, just handle gracefully
          }
          console.error("Error listening to pending bookings:", error);
          setPendingBookings([]);
        }
      );
    })();

    return () => {
      unsubNotifications?.();
      unsubBookings?.();
    };
  }, [ownerUid, isSuperAdmin]);

  // Mark notification as read
  const markAsRead = async (notifId: string) => {
    // For pending bookings (prefixed with "pending-"), track read state
    if (notifId.startsWith("pending-")) {
      const bookingId = notifId.replace("pending-", "");
      setReadPendingBookings((prev) => new Set([...prev, bookingId]));
      return;
    }

    // For Firestore notifications, update both UI and Firestore
    // Optimistically update UI
    setNotifications((prev) =>
      prev.map((n) => (n.id === notifId ? { ...n, read: true } : n))
    );

    // Update in Firestore
    try {
      const { db } = await import("@/lib/firebase");
      const { doc, updateDoc } = await import("firebase/firestore");
      await updateDoc(doc(db, "notifications", notifId), {
        read: true,
      });
    } catch (error) {
      console.error("Error marking notification as read:", error);
      // Revert on error
      setNotifications((prev) =>
        prev.map((n) => (n.id === notifId ? { ...n, read: false } : n))
      );
    }
  };

  // Mark all as read
  const markAllAsRead = async () => {
    const unreadNotifications = combinedNotifications.filter((n) => !n.read);
    if (unreadNotifications.length === 0) return;

    // Optimistically update UI
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
    // Mark all pending bookings as read
    setReadPendingBookings(new Set(pendingBookings.map((b) => b.id)));

    // Update Firestore notifications
    const firestoreNotifications = unreadNotifications.filter((n) => !n.id.startsWith("pending-"));
    if (firestoreNotifications.length > 0) {
      try {
        const { db } = await import("@/lib/firebase");
        const { doc, updateDoc } = await import("firebase/firestore");
        
        await Promise.all(
          firestoreNotifications.map((notif) =>
            updateDoc(doc(db, "notifications", notif.id), {
              read: true,
            })
          )
        );
      } catch (error) {
        console.error("Error marking all notifications as read:", error);
        // Revert on error
        setNotifications((prev) =>
          prev.map((n) => {
            const wasUnread = firestoreNotifications.some((un) => un.id === n.id);
            return wasUnread ? { ...n, read: false } : n;
          })
        );
      }
    }
  };

  // Delete single notification
  const deleteNotification = async (notifId: string) => {
    // For pending bookings (prefixed with "pending-"), dismiss from UI
    if (notifId.startsWith("pending-")) {
      const bookingId = notifId.replace("pending-", "");
      // We can't delete pending bookings from Firestore, but we hide them from the notification panel
      setDismissedPendingBookings((prev) => new Set([...prev, bookingId]));
      console.log("Pending booking notification dismissed:", bookingId);
      return;
    }

    // Add to dismissed set (persisted to localStorage) so it won't come back
    setDismissedNotificationIds((prev) => new Set([...prev, notifId]));
    
    // Optimistically update UI
    setNotifications((prev) => prev.filter((n) => n.id !== notifId));

    // Delete from Firestore via API route (server-side for proper permissions)
    try {
      const { auth } = await import("@/lib/firebase");
      const user = auth.currentUser;
      
      if (!user) {
        throw new Error("User not authenticated");
      }

      const token = await user.getIdToken();
      
      const response = await fetch(`/api/notifications/${notifId}`, {
        method: "DELETE",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || "Failed to delete notification");
      }

      console.log("Notification deleted:", notifId);
    } catch (error) {
      console.error("Error deleting notification:", error);
      // The notification is already in dismissedNotificationIds, so it won't reappear
    }
  };

  // Delete all notifications
  const deleteAllNotifications = async () => {
    if (combinedNotifications.length === 0) return;

    // Get all Firestore notification IDs (not pending bookings)
    const firestoreNotifications = combinedNotifications.filter((n) => !n.id.startsWith("pending-"));
    
    // Add all Firestore notification IDs to dismissed set (persisted)
    setDismissedNotificationIds((prev) => {
      const newSet = new Set([...prev]);
      firestoreNotifications.forEach((n) => newSet.add(n.id));
      return newSet;
    });
    
    // Optimistically update UI
    setNotifications([]);
    // Dismiss all pending booking notifications (so they don't reappear)
    setDismissedPendingBookings((prev) => {
      const newSet = new Set([...prev]);
      pendingBookings.forEach((b) => newSet.add(b.id));
      return newSet;
    });

    // Delete from Firestore via API route (server-side for proper permissions)
    if (firestoreNotifications.length > 0) {
      try {
        const { auth } = await import("@/lib/firebase");
        const user = auth.currentUser;
        
        if (!user) {
          throw new Error("User not authenticated");
        }

        const token = await user.getIdToken();
        
        const response = await fetch("/api/notifications/delete-all", {
          method: "DELETE",
          headers: {
            "Authorization": `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.error || "Failed to delete all notifications");
        }

        console.log("All notifications deleted:", firestoreNotifications.length);
      } catch (error) {
        console.error("Error deleting all notifications:", error);
        // The notifications are already in dismissedNotificationIds, so they won't reappear
      }
    }
  };

  // Combine notifications from Firestore with pending bookings
  const combinedNotifications = useMemo(() => {
    // Convert pending bookings to notification format
    // Only include bookings that are still Pending and not dismissed
    const pendingNotifications: Notification[] = pendingBookings
      .filter((booking: any) => {
        // Only include if status is still Pending
        const status = booking.status || "Pending";
        // Filter out dismissed notifications
        if (dismissedPendingBookings.has(booking.id)) {
          return false;
        }
        return status === "Pending";
      })
      .map((booking: any) => ({
        id: `pending-${booking.id}`,
        bookingId: booking.id,
        type: "booking_request",
        title: "New Booking Request",
        message: `${booking.customerName || booking.clientName || "A customer"} requested a booking`,
        serviceName: booking.serviceName || booking.services?.[0]?.name || "Service",
        branchName: booking.branchName || "",
        date: booking.date,
        time: booking.time,
        price: booking.price || booking.totalPrice,
        createdAt: booking.createdAt?.toDate ? booking.createdAt.toDate() : new Date(booking.createdAt?.seconds * 1000 || Date.now()),
        read: readPendingBookings.has(booking.id),
        status: "Pending",
      }));

    // ADMIN NOTIFICATION RULES:
    // Only show notifications for:
    // 1. New Booking Created (booking_engine_new_booking, staff_booking_created, booking_needs_assignment, booking_request)
    // 2. Staff Rejected a Service (staff_rejected)
    const validNotifications = notifications.filter((notif) => {
      // Skip dismissed/deleted notifications
      if (dismissedNotificationIds.has(notif.id)) {
        return false;
      }
      
      const isNewBookingNotification = 
        notif.type === "booking_engine_new_booking" ||
        notif.type === "staff_booking_created" ||
        notif.type === "booking_needs_assignment" ||
        notif.type === "booking_request";
      
      const isStaffRejectedNotification = notif.type === "staff_rejected";
      
      // For new booking notifications, only show if booking is still pending
      if (isNewBookingNotification) {
        const isPendingStatus = !notif.status || 
          notif.status === "Pending" || 
          notif.status === "AwaitingStaffApproval" ||
          notif.status === "PartiallyApproved";
        return isPendingStatus;
      }
      
      // Always show staff rejection notifications (admin needs to reassign or cancel)
      if (isStaffRejectedNotification) {
        return true;
      }
      
      // Don't show any other notification types
      return false;
    });

    // Combine and deduplicate by bookingId (prefer Firestore notifications over pending)
    const allNotifications = [...pendingNotifications, ...validNotifications];
    const unique = Array.from(
      new Map(allNotifications.map((n) => [n.bookingId, n])).values()
    ).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    return unique.slice(0, 50);
  }, [notifications, pendingBookings, readPendingBookings, dismissedPendingBookings, dismissedNotificationIds]);

  // Calculate unread count from combined notifications
  const combinedUnreadCount = useMemo(() => {
    return combinedNotifications.filter((n) => !n.read).length;
  }, [combinedNotifications]);

  const value: NotificationContextType = {
    notifications: combinedNotifications,
    unreadCount: combinedUnreadCount,
    markAsRead,
    markAllAsRead,
    deleteNotification,
    deleteAllNotifications,
  };

  return (
    <NotificationContext.Provider value={value}>
      {children}
      {/* Toast Notifications Container - Bottom Right */}
      <div className="fixed bottom-4 right-4 z-[9999] flex flex-col gap-3 max-w-md pointer-events-none">
        {toastNotifications.map((toast) => (
          <div key={toast.id} className="pointer-events-auto">
            <ToastNotification
              id={toast.id}
              title={toast.title}
              message={toast.message}
              serviceName={toast.serviceName}
              price={toast.price}
              bookingId={toast.bookingId}
              type={toast.type}
              branchName={toast.branchName}
              date={toast.date}
              time={toast.time}
              onClose={() => {
                setToastNotifications((prev) => prev.filter((t) => t.id !== toast.id));
              }}
            />
          </div>
        ))}
      </div>
    </NotificationContext.Provider>
  );
}
