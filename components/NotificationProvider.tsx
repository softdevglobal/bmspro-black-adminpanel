"use client";
import React, { createContext, useContext, useEffect, useRef, useState, ReactNode, useMemo, useCallback } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { collection, query, where, onSnapshot, orderBy, limit } from "firebase/firestore";

const NOTIFICATION_QUERY_LIMIT = 50;
/** Cap the on-screen toast stack so a login / burst can't cover the viewport. */
const MAX_VISIBLE_TOASTS = 3;
import ToastNotification from "./ToastNotification";
import { SUPPORT_CHAT_PANEL_STATE_EVENT } from "@/lib/supportChatEvents";
import {
  broadcastIdFromNotificationId,
  dismissAllBroadcastsApi,
  dismissBroadcastApi,
  fetchBroadcastNotifications,
  isBroadcastNotificationId,
  markAllBroadcastsReadApi,
  markBroadcastReadApi,
  type BroadcastNotification,
} from "@/lib/broadcasts/api-client";

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
  /** Call center direct chat — open floating reception widget. */
  chatId?: string;
  /** Present on `additional_issue_found` — used to dedupe duplicate Firestore docs. */
  issueId?: string;
}

function broadcastToPanelNotification(note: BroadcastNotification): Notification {
  return {
    id: note.id,
    bookingId: note.bookingId,
    type: note.type,
    title: note.title,
    message: note.message,
    createdAt: note.createdAt,
    read: note.read,
  };
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

/** Firestore notification types that should always surface in the admin bell + toasts (one row per doc). */
/** Roles that receive platform broadcast messages in the admin bell. */
const BROADCAST_RECIPIENT_ROLES = new Set([
  "workshop_owner",
  "branch_admin",
  "staff",
  "owner",
  "admin",
  "business_owner",
]);

const WORKSHOP_ALERT_TYPES = new Set([
  "owner_booking_completed",
  "booking_rescheduled",
  "staff_clocked_in",
  "staff_clocked_out",
  "staff_break_started",
  "staff_break_ended",
  "leave_request_pending",
  "cc_chat_inbound",
]);

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
  const [broadcastNotes, setBroadcastNotes] = useState<Notification[]>([]);
  const [pendingBookings, setPendingBookings] = useState<any[]>([]);
  const [readPendingBookings, setReadPendingBookings] = useState<Set<string>>(new Set());
  const [dismissedPendingBookings, setDismissedPendingBookings] = useState<Set<string>>(new Set()); // Track deleted/dismissed pending booking notifications
  const [dismissedNotificationIds, setDismissedNotificationIds] = useState<Set<string>>(new Set()); // Track deleted Firestore notification IDs (persist across sessions)
  const [toastNotifications, setToastNotifications] = useState<any[]>([]);
  const [ownerUid, setOwnerUid] = useState<string | null>(null);
  const [currentUserUid, setCurrentUserUid] = useState<string | null>(null);
  const [isBranchAdmin, setIsBranchAdmin] = useState<boolean>(false);
  const [isStaffUser, setIsStaffUser] = useState<boolean>(false);
  const [isSuperAdmin, setIsSuperAdmin] = useState<boolean>(false);
  const [userRole, setUserRole] = useState<string | null>(null);
  const [authReady, setAuthReady] = useState(false);
  /** While the floating reception chat is open, suppress CC message toasts/sounds and bell unread for `cc_chat_inbound`. */
  const [supportChatPanelOpen, setSupportChatPanelOpen] = useState(false);
  const supportChatPanelOpenRef = useRef(false);
  const previousNotificationIdsRef = useRef<Set<string>>(new Set());
  const previousPendingIdsRef = useRef<Set<string>>(new Set());
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioInitializedRef = useRef(false);
  const reloadBroadcastsRef = useRef<() => Promise<void>>(async () => {});

  const canReceiveBroadcasts =
    authReady &&
    Boolean(userRole) &&
    !isSuperAdmin &&
    BROADCAST_RECIPIENT_ROLES.has(userRole!);

  const reloadBroadcasts = useCallback(async () => {
    if (!canReceiveBroadcasts || !currentUserUid) return;
    try {
      const { auth } = await import("@/lib/firebase");
      const user = auth.currentUser;
      if (!user) return;
      const token = await user.getIdToken();
      const broadcasts = await fetchBroadcastNotifications(token).catch(() => []);
      setBroadcastNotes(broadcasts.map(broadcastToPanelNotification));
    } catch {
      /* keep previous list */
    }
  }, [canReceiveBroadcasts, currentUserUid]);

  reloadBroadcastsRef.current = reloadBroadcasts;

  useEffect(() => {
    if (!canReceiveBroadcasts || !currentUserUid) {
      setBroadcastNotes([]);
      return;
    }

    void reloadBroadcasts();

    const onFocus = () => void reloadBroadcastsRef.current();
    window.addEventListener("focus", onFocus);
    const interval = window.setInterval(() => void reloadBroadcastsRef.current(), 120_000);

    return () => {
      window.removeEventListener("focus", onFocus);
      window.clearInterval(interval);
    };
  }, [canReceiveBroadcasts, currentUserUid, reloadBroadcasts]);

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

  useEffect(() => {
    const onPanel = (e: Event) => {
      const d = (e as CustomEvent<{ open?: boolean }>).detail;
      const open = Boolean(d?.open);
      supportChatPanelOpenRef.current = open;
      setSupportChatPanelOpen(open);
    };
    if (typeof window === "undefined") return undefined;
    window.addEventListener(SUPPORT_CHAT_PANEL_STATE_EVENT, onPanel);
    return () => window.removeEventListener(SUPPORT_CHAT_PANEL_STATE_EVENT, onPanel);
  }, []);

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
      chatId: notification.chatId,
    };
    
    console.log("🔔 Showing toast notification:", toast);
    // Never stack more than a few toasts at once — a burst (or a login that
    // surfaces several unread items) should not flood the whole screen.
    setToastNotifications((prev) => [...prev, toast].slice(-MAX_VISIBLE_TOASTS));

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
          setCurrentUserUid(null);
          setIsSuperAdmin(false);
          setUserRole(null);
          setAuthReady(false);
          return;
        }
        try {
          setCurrentUserUid(user.uid);
          setOwnerUid(user.uid);
          setAuthReady(false);

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
            role = String(userData?.role || "").toLowerCase();
          }

          setIsSuperAdmin(role === "super_admin");
          setUserRole(role || null);
          setIsBranchAdmin(role === "branch_admin");
          setIsStaffUser(role === "staff");

          // For branch admin, use their owner UID for owner-scoped notifications
          if (role === "branch_admin" && userData?.ownerUid) {
            setOwnerUid(userData.ownerUid);
          }
        } catch (error) {
          console.error("Error fetching user data:", error);
          setUserRole(null);
        } finally {
          setAuthReady(true);
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

    // Backfill: ensure notifications exist for additional issues awaiting price
    (async () => {
      try {
        const { auth } = await import("@/lib/firebase");
        const user = auth.currentUser;
        const token = user ? await user.getIdToken() : null;
        if (token) {
          await fetch("/api/notifications/ensure-additional-issues", {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
          });
        }
      } catch (_) {
        /* ignore */
      }
    })();

    (async () => {
      const { db, auth } = await import("@/lib/firebase");

      // Ensure user is authenticated before setting up listeners
      const user = auth.currentUser;
      if (!user) {
        console.warn("User not authenticated, skipping notification listeners");
        return;
      }

      // Per-subscription initial-load guards. These live inside the effect
      // closure (not a ref) so that EVERY (re)subscription — including the
      // several re-runs triggered while auth/role state settles on login —
      // treats its first delivered batch as a baseline instead of firing a
      // toast for every pre-existing notification. Genuinely new notifications
      // that arrive afterwards, while the page stays mounted, still toast.
      let notifInitialLoad = true;
      let pendingInitialLoad = true;

      // Subscribe to notifications collection for this owner
      // We need to listen for multiple notification types:
      // 1. ownerUid - general owner notifications
      // 2. targetOwnerUid - specific owner-targeted notifications (staff created bookings, etc.)
      // 3. targetAdminUid - admin-targeted notifications (staff rejections, etc.)
      // All notification queries are bounded with orderBy(createdAt desc) + limit
      // to prevent reading the entire historical notifications collection on every
      // page load. We only need the most recent N for the bell/toast UX (UI also
      // slices to 50 in `combinedNotifications`).
      const notificationsQuery = query(
        collection(db, "notifications"),
        where("ownerUid", "==", ownerUid),
        orderBy("createdAt", "desc"),
        limit(NOTIFICATION_QUERY_LIMIT)
      );

      // Also listen for targetOwnerUid notifications (for staff-created booking notifications)
      const targetOwnerQuery = query(
        collection(db, "notifications"),
        where("targetOwnerUid", "==", ownerUid),
        orderBy("createdAt", "desc"),
        limit(NOTIFICATION_QUERY_LIMIT)
      );

      // Also listen for targetAdminUid notifications
      const targetAdminQuery = query(
        collection(db, "notifications"),
        where("targetAdminUid", "==", ownerUid),
        orderBy("createdAt", "desc"),
        limit(NOTIFICATION_QUERY_LIMIT)
      );

      // For branch admins: also listen for branchAdminUid (their own uid) - additional_issue_found etc.
      const branchAdminQuery = currentUserUid && isBranchAdmin
        ? query(
            collection(db, "notifications"),
            where("branchAdminUid", "==", currentUserUid),
            orderBy("createdAt", "desc"),
            limit(NOTIFICATION_QUERY_LIMIT)
          )
        : null;

      const targetStaffQuery = currentUserUid && isStaffUser
        ? query(
            collection(db, "notifications"),
            where("targetStaffUid", "==", currentUserUid),
            orderBy("createdAt", "desc"),
            limit(NOTIFICATION_QUERY_LIMIT)
          )
        : null;

      // Track notifications from all queries to deduplicate
      const allNotificationsMap = new Map<string, Notification>();
      const queryLoadedFlags = {
        main: false,
        targetOwner: false,
        targetAdmin: false,
        branchAdmin: !branchAdminQuery,
        staff: !targetStaffQuery,
      };

      const processNotifications = async () => {
        // Wait until all queries have loaded once
        if (!queryLoadedFlags.main || !queryLoadedFlags.targetOwner || !queryLoadedFlags.targetAdmin || !queryLoadedFlags.branchAdmin || !queryLoadedFlags.staff) {
          return;
        }

        const sorted = Array.from(allNotificationsMap.values()).sort(
          (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
        );
        const seenAdditionalIssue = new Set<string>();
        const allNotifs = sorted
          .filter((n) => {
            if (n.type !== "additional_issue_found") return true;
            const iid = (n.issueId || "").trim();
            if (!n.bookingId || !iid) return true;
            const key = `${n.bookingId}::${iid}`;
            if (seenAdditionalIssue.has(key)) return false;
            seenAdditionalIssue.add(key);
            return true;
          })
          .slice(0, 50);

        // Find new notifications (IDs that weren't in previous snapshot)
        const currentNotificationIds = new Set(allNotifs.map((n) => n.id));
        const newNotifications = allNotifs.filter(
          (n) => !previousNotificationIdsRef.current.has(n.id)
        );

        // Only play sound and show toast after initial load
        // Filter to only relevant notification types before showing toast
        if (!notifInitialLoad && newNotifications.length > 0) {
          // Only show toast for relevant notifications:
          // 1. New booking notifications (if still pending)
          // 2. Staff rejected notifications
          // 3. Not previously dismissed
            const relevantNotifications = newNotifications.filter((notif) => {
              // Skip dismissed notifications
              if (dismissedNotificationIds.has(notif.id)) {
                return false;
              }

              if (isBranchAdmin && notif.type === "leave_request_pending") {
                return false;
              }

              const isNewBooking =
              notif.type === "booking_engine_new_booking" ||
              notif.type === "staff_booking_created" ||
              notif.type === "booking_needs_assignment" ||
              notif.type === "booking_request";
            
            const isNewEstimate = notif.type === "new_estimate";
            
            const isStaffRejected = notif.type === "staff_rejected";
            const isAdditionalIssue = notif.type === "additional_issue_found";
            const isCustomerAcceptedAdditionalWork = notif.type === "additional_issue_customer_accepted";
            const isCustomerRejectedAdditionalWork = notif.type === "additional_issue_customer_rejected";
            const isWorkshopAlert = WORKSHOP_ALERT_TYPES.has(notif.type);
            const isCcChatInbound = notif.type === "cc_chat_inbound";
            
            if (isNewBooking) {
              const isPending = !notif.status || 
                notif.status === "Pending" || 
                notif.status === "AwaitingStaffApproval" ||
                notif.status === "PartiallyApproved";
              return isPending;
            }
            
            if (isNewEstimate) return true;
            if (isAdditionalIssue) return true;
            if (isCustomerAcceptedAdditionalWork) return true;
            if (isCustomerRejectedAdditionalWork) return true;
            if (isWorkshopAlert) return true;
            if (isCcChatInbound) {
              if (supportChatPanelOpenRef.current) return false;
              return true;
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
        if (notifInitialLoad) {
          notifInitialLoad = false;
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

          if (isBranchAdmin && data.type === "leave_request_pending") {
            continue;
          }

          // Use the status stored on the notification doc itself instead of
          // reading the parent booking. Doing a getDoc per notification was
          // an N+1 hot path (50 notifs × 5 queries × every snapshot delivery
          // could easily add 250+ extra reads on each refresh). Slightly
          // stale status on the bell is an acceptable trade-off; the booking
          // detail pages always show the live status.
          const bookingStatus = data.status;

          // ADMIN NOTIFICATION RULES:
          // Only show notifications for:
          // 1. New Booking Created (booking_engine_new_booking, staff_booking_created, booking_needs_assignment, booking_request)
          // 2. Staff Rejected a Service (staff_rejected)
          // 3. Additional Issue Reported (additional_issue_found) - owner/branch admin must set price
          // 
          // DO NOT show notifications for:
          // - Booking confirmation (booking_confirmed)
          // - Customer-facing completion (booking_completed)
          // - Status changes after confirmation
          // - Normal service acceptance by staff (staff_accepted)
          
          const isNewBookingNotification = 
            data.type === "booking_engine_new_booking" ||
            data.type === "staff_booking_created" ||
            data.type === "booking_needs_assignment" ||
            data.type === "booking_request";
          
          const isStaffRejectedNotification = data.type === "staff_rejected";
          const isAdditionalIssueNotification = data.type === "additional_issue_found";
          const isCustomerAcceptedAdditionalWork = data.type === "additional_issue_customer_accepted";
          const isCustomerRejectedAdditionalWork = data.type === "additional_issue_customer_rejected";
          const isWorkshopAlert = WORKSHOP_ALERT_TYPES.has(data.type);
          const isCcChatInbound = data.type === "cc_chat_inbound";
          
          // Only show new booking notifications if booking is still pending/awaiting
          const isPendingStatus = !bookingStatus || 
            bookingStatus === "Pending" || 
            bookingStatus === "AwaitingStaffApproval" ||
            bookingStatus === "PartiallyApproved";
          
          const shouldShow =
            (isNewBookingNotification && isPendingStatus) ||
            isStaffRejectedNotification ||
            isAdditionalIssueNotification ||
            isCustomerAcceptedAdditionalWork ||
            isCustomerRejectedAdditionalWork ||
            isWorkshopAlert ||
            isCcChatInbound;

          if (!shouldShow) {
            continue;
          }

          const issueIdRaw =
            (typeof data.issueId === "string" && data.issueId.trim()) ||
            (typeof data.additionalIssueId === "string" && data.additionalIssueId.trim()) ||
            undefined;
          const chatIdRaw =
            typeof data.chatId === "string" && data.chatId.trim() ? data.chatId.trim() : undefined;
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
            ...(issueIdRaw ? { issueId: issueIdRaw } : {}),
            ...(chatIdRaw ? { chatId: chatIdRaw } : {}),
          };
          
          allNotificationsMap.set(notifId, notification);
        }

        // Mark this query as loaded
        if (queryName === "main") queryLoadedFlags.main = true;
        if (queryName === "targetOwner") queryLoadedFlags.targetOwner = true;
        if (queryName === "targetAdmin") queryLoadedFlags.targetAdmin = true;
        if (queryName === "branchAdmin") queryLoadedFlags.branchAdmin = true;
        if (queryName === "staff") queryLoadedFlags.staff = true;

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

      // Subscribe to branchAdminUid notifications (for branch admins - additional_issue_found etc.)
      let unsubBranchAdmin: (() => void) | undefined;
      if (branchAdminQuery) {
        unsubBranchAdmin = onSnapshot(
          branchAdminQuery,
          async (snapshot) => {
            await processSnapshot(snapshot, "branchAdmin");
          },
          (error) => {
            if (error.code === "permission-denied") {
              console.warn("Permission denied for branch admin notifications.");
              queryLoadedFlags.branchAdmin = true;
              processNotifications();
              return;
            }
            console.error("Error listening to branch admin notifications:", error);
            queryLoadedFlags.branchAdmin = true;
            processNotifications();
          }
        );
      }

      let unsubTargetStaff: (() => void) | undefined;
      if (targetStaffQuery) {
        unsubTargetStaff = onSnapshot(
          targetStaffQuery,
          async (snapshot) => {
            await processSnapshot(snapshot, "staff");
          },
          (error) => {
            if (error.code === "permission-denied") {
              queryLoadedFlags.staff = true;
              processNotifications();
              return;
            }
            console.error("Error listening to staff-target notifications:", error);
            queryLoadedFlags.staff = true;
            processNotifications();
          }
        );
      }

      // Store unsubscribe for targetOwner, targetAdmin, branchAdmin, and staff
      const originalUnsub = unsubNotifications;
      unsubNotifications = () => {
        originalUnsub?.();
        unsubTargetOwner?.();
        unsubTargetAdmin?.();
        unsubBranchAdmin?.();
        unsubTargetStaff?.();
      };

      // NOTE: Previously there were TWO additional `onSnapshot` listeners on the
      // entire `bookings` collection (filtered only by ownerUid / ownerId, no
      // limit) whose only purpose was to detect when an owner added a pending
      // additional-issue and call /api/notifications/ensure-additional-issues.
      // Those listeners alone could account for millions of reads/month on
      // active tenants because every booking update re-delivered every booking
      // doc. They have been removed: the once-per-session backfill call above
      // (and per-page-load when this Provider remounts on auth change) plus
      // the additional_issue_found notification listener cover the same UX,
      // and the source of truth (creating the notification) belongs in the
      // backend, not in a client-side full-collection listener.

      // Also listen to pending bookings to include them in the notification panel.
      // Bounded to the most recent 50 pending bookings — the panel only ever
      // shows up to 50 combined notifications anyway.
      const pendingQuery = query(
        collection(db, "bookings"),
        where("ownerUid", "==", ownerUid),
        where("status", "==", "Pending"),
        orderBy("createdAt", "desc"),
        limit(NOTIFICATION_QUERY_LIMIT)
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
          if (!pendingInitialLoad && newBookings.length > 0) {
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

          // Baseline captured — subsequent snapshots may toast genuinely new ones.
          if (pendingInitialLoad) {
            pendingInitialLoad = false;
          }
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
  }, [ownerUid, currentUserUid, isBranchAdmin, isStaffUser, isSuperAdmin]);

  // Mark notification as read
  const markAsRead = async (notifId: string) => {
    // For pending bookings (prefixed with "pending-"), track read state
    if (notifId.startsWith("pending-")) {
      const bookingId = notifId.replace("pending-", "");
      setReadPendingBookings((prev) => new Set([...prev, bookingId]));
      return;
    }

    if (isBroadcastNotificationId(notifId)) {
      const previousBroadcast = broadcastNotes;
      setBroadcastNotes((prev) =>
        prev.map((n) => (n.id === notifId ? { ...n, read: true } : n)),
      );
      try {
        const { auth } = await import("@/lib/firebase");
        const user = auth.currentUser;
        if (!user) throw new Error("Not authenticated");
        const token = await user.getIdToken();
        await markBroadcastReadApi(token, broadcastIdFromNotificationId(notifId));
      } catch (error) {
        console.error("Error marking broadcast as read:", error);
        setBroadcastNotes(previousBroadcast);
      }
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

    const previousBroadcast = broadcastNotes;

    // Optimistically update UI
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
    setBroadcastNotes((prev) => prev.map((n) => ({ ...n, read: true })));
    // Mark all pending bookings as read
    setReadPendingBookings(new Set(pendingBookings.map((b) => b.id)));

    try {
      const { auth } = await import("@/lib/firebase");
      const user = auth.currentUser;
      if (user) {
        const token = await user.getIdToken();
        await markAllBroadcastsReadApi(token).catch(() => {});
      }
    } catch {
      setBroadcastNotes(previousBroadcast);
    }

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

    if (isBroadcastNotificationId(notifId)) {
      const previousBroadcast = broadcastNotes;
      setBroadcastNotes((prev) => prev.filter((n) => n.id !== notifId));
      try {
        const { auth } = await import("@/lib/firebase");
        const user = auth.currentUser;
        if (!user) throw new Error("Not authenticated");
        const token = await user.getIdToken();
        await dismissBroadcastApi(token, broadcastIdFromNotificationId(notifId));
      } catch (error) {
        console.error("Error dismissing broadcast:", error);
        setBroadcastNotes(previousBroadcast);
      }
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

    const previousBroadcast = broadcastNotes;

    // Get all Firestore notification IDs (not pending bookings or broadcasts)
    const firestoreNotifications = combinedNotifications.filter(
      (n) => !n.id.startsWith("pending-") && !isBroadcastNotificationId(n.id),
    );
    
    // Add all Firestore notification IDs to dismissed set (persisted)
    setDismissedNotificationIds((prev) => {
      const newSet = new Set([...prev]);
      firestoreNotifications.forEach((n) => newSet.add(n.id));
      return newSet;
    });
    
    // Optimistically update UI
    setNotifications([]);
    setBroadcastNotes([]);
    // Dismiss all pending booking notifications (so they don't reappear)
    setDismissedPendingBookings((prev) => {
      const newSet = new Set([...prev]);
      pendingBookings.forEach((b) => newSet.add(b.id));
      return newSet;
    });

    try {
      const { auth } = await import("@/lib/firebase");
      const user = auth.currentUser;
      if (user) {
        const token = await user.getIdToken();
        await dismissAllBroadcastsApi(token).catch(() => {});
      }
    } catch {
      setBroadcastNotes(previousBroadcast);
    }

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
    // 3. Additional Issue Reported (additional_issue_found) - owner/branch admin must set price
    // 4. Customer accepted/rejected additional work (additional_issue_customer_accepted, additional_issue_customer_rejected)
    // 5. Workshop alerts (booking completed for owner, staff clock on/off, breaks)
    const validNotifications = notifications.filter((notif) => {
      // Skip dismissed/deleted notifications
      if (dismissedNotificationIds.has(notif.id)) {
        return false;
      }

      if (notif.type === "system_message") {
        return true;
      }
      
      const isNewBookingNotification = 
        notif.type === "booking_engine_new_booking" ||
        notif.type === "staff_booking_created" ||
        notif.type === "booking_needs_assignment" ||
        notif.type === "booking_request";
      
      const isStaffRejectedNotification = notif.type === "staff_rejected";
      const isAdditionalIssueNotification = notif.type === "additional_issue_found";
      const isCustomerAcceptedAdditionalWork = notif.type === "additional_issue_customer_accepted";
      const isCustomerRejectedAdditionalWork = notif.type === "additional_issue_customer_rejected";
      const isWorkshopAlert = WORKSHOP_ALERT_TYPES.has(notif.type);
      const isCcChatInbound = notif.type === "cc_chat_inbound";

      // For new booking notifications, only show if booking is still pending
      if (isNewBookingNotification) {
        const isPendingStatus =
          !notif.status ||
          notif.status === "Pending" ||
          notif.status === "AwaitingStaffApproval" ||
          notif.status === "PartiallyApproved";
        return isPendingStatus;
      }

      // Always show staff rejection notifications (admin needs to reassign or cancel)
      if (isStaffRejectedNotification) {
        return true;
      }

      // Always show additional issue notifications (owner/branch admin must set price)
      if (isAdditionalIssueNotification) {
        return true;
      }

      // Always show customer response to additional work (accepted or rejected)
      if (isCustomerAcceptedAdditionalWork || isCustomerRejectedAdditionalWork) {
        return true;
      }

      if (isWorkshopAlert) {
        return true;
      }

      if (isCcChatInbound) {
        return true;
      }

      // Don't show any other notification types
      return false;
    });

    // Combine and deduplicate: one row per booking for booking alerts; one row per doc for attendance / owner completion
    const allNotifications = [...pendingNotifications, ...validNotifications, ...broadcastNotes];
    const dedupeKey = (n: Notification) => {
      if (n.type === "system_message") return n.id;
      if (n.id.startsWith("pending-")) return `pending:${n.bookingId}`;
      if (WORKSHOP_ALERT_TYPES.has(n.type)) return n.id;
      if (n.type === "additional_issue_found" && n.bookingId && n.issueId) {
        return `additional_issue:${n.bookingId}:${n.issueId}`;
      }
      return n.bookingId || n.id;
    };
    const unique = Array.from(
      new Map(allNotifications.map((n) => [dedupeKey(n), n])).values()
    ).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    return unique.slice(0, 50);
  }, [notifications, broadcastNotes, pendingBookings, readPendingBookings, dismissedPendingBookings, dismissedNotificationIds]);

  // Calculate unread count from combined notifications
  const combinedUnreadCount = useMemo(() => {
    return combinedNotifications.filter((n) => {
      if (n.read) return false;
      if (n.type === "cc_chat_inbound" && supportChatPanelOpen) return false;
      return true;
    }).length;
  }, [combinedNotifications, supportChatPanelOpen]);

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
      <div className="fixed bottom-4 right-4 z-[9999] flex max-h-[calc(100vh-2rem)] flex-col gap-3 overflow-hidden max-w-md pointer-events-none">
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
              chatId={toast.chatId}
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
