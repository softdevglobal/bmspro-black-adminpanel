import { adminDb } from "@/lib/firebaseAdmin";
import { FieldValue, Timestamp, type Firestore, type QueryDocumentSnapshot } from "firebase-admin/firestore";
import { createNotification } from "@/lib/notifications";
import { sendSms, isSmsConfigured } from "@/lib/smsService";
import { appendBookNowMyBookingsDeepLink, resolveBookingEngineUrl } from "@/lib/customerAccount";
import { sendEmail, isZeptoMailConfigured } from "@/lib/email";
import {
  DEFAULT_SERVICE_REMINDER_INTERVAL_DAYS,
  MAX_SERVICE_REMINDER_INTERVAL_DAYS,
  MIN_SERVICE_REMINDER_INTERVAL_DAYS,
  SERVICE_REMINDER_COLLECTION,
  computeAdvanceReminderDueDate,
  type BookingServiceReminderSnapshot,
  type ServiceReminderDoc,
  type ServiceReminderSettings,
  type ServiceReminderStatus,
  type ServiceReminderAdvanceStatus,
} from "@/lib/serviceReminders/types";

const CRON_BATCH_LIMIT = 100;

function defaultSettings(): ServiceReminderSettings {
  return {
    enabled: false,
    intervalDays: DEFAULT_SERVICE_REMINDER_INTERVAL_DAYS,
    serviceIntervals: {},
  };
}

/** Collect service IDs from a booking (multi-service array and/or legacy top-level field). */
export function resolveBookingServiceIds(booking: Record<string, unknown>): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const push = (raw: unknown) => {
    const id = String(raw || "").trim();
    if (!id || seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };

  const services = booking.services;
  if (Array.isArray(services)) {
    for (const s of services) {
      if (!s || typeof s !== "object") continue;
      const row = s as Record<string, unknown>;
      push(row.id ?? row.serviceId);
    }
  }
  push(booking.serviceId);
  return ids;
}

function normalizeServiceIntervals(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const serviceId = String(key || "").trim();
    if (!serviceId) continue;
    const days = typeof value === "number" ? Math.round(value) : Math.round(Number(value));
    if (
      Number.isFinite(days) &&
      days >= MIN_SERVICE_REMINDER_INTERVAL_DAYS &&
      days <= MAX_SERVICE_REMINDER_INTERVAL_DAYS
    ) {
      out[serviceId] = days;
    }
  }
  return out;
}

/**
 * Resolve reminder interval for a booking from per-service settings.
 * Returns null when no configured interval exists for the booking's service(s).
 */
export function resolveIntervalDaysForBooking(
  booking: Record<string, unknown>,
  settings: ServiceReminderSettings,
): number | null {
  const intervals = settings.serviceIntervals || {};
  const serviceIds = resolveBookingServiceIds(booking);
  const matched = serviceIds
    .map((id) => intervals[id])
    .filter((d): d is number => typeof d === "number" && d > 0);
  if (matched.length > 0) {
    return Math.min(...matched);
  }
  return null;
}

async function getWorkshopName(ownerUid: string): Promise<string> {
  try {
    const snap = await adminDb().doc(`users/${ownerUid}`).get();
    if (snap.exists) {
      const data = snap.data() || {};
      return (
        data.workshopName ||
        data.salonName ||
        data.name ||
        data.businessName ||
        data.displayName ||
        "Workshop"
      );
    }
  } catch (error) {
    console.error("[serviceReminders] getWorkshopName:", error);
  }
  return "Workshop";
}

async function getBookingPortalUrl(ownerUid: string): Promise<string> {
  try {
    const ownerDoc = await adminDb().doc(`users/${ownerUid}`).get();
    const ownerData = ownerDoc.exists ? ownerDoc.data() || null : null;
    return appendBookNowMyBookingsDeepLink(resolveBookingEngineUrl(ownerData));
  } catch (error) {
    console.error("[serviceReminders] getBookingPortalUrl:", error);
    return appendBookNowMyBookingsDeepLink(
      process.env.NEXT_PUBLIC_BOOKING_ENGINE_URL ||
        process.env.NEXT_PUBLIC_APP_URL ||
        "https://book.bmspros.com.au",
    );
  }
}

function resolveBookingDateForReminder(booking: Record<string, unknown>): Date {
  const date = String(booking.date || "").trim();
  const time = String(booking.time || "12:00").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const timePart = /^\d{1,2}:\d{2}/.test(time) ? time.slice(0, 5) : "12:00";
    const d = new Date(`${date}T${timePart}:00`);
    if (!Number.isNaN(d.getTime())) return d;
    const fallback = new Date(`${date}T12:00:00`);
    if (!Number.isNaN(fallback.getTime())) return fallback;
  }
  return new Date();
}

/** Anchor reminders from when the booking was completed; fall back to booking date. */
function resolveReminderAnchorDate(booking: Record<string, unknown>): Date {
  const completedAt = booking.completedAt as { toDate?: () => Date } | string | undefined;
  if (completedAt && typeof completedAt === "object" && typeof completedAt.toDate === "function") {
    const d = completedAt.toDate();
    if (!Number.isNaN(d.getTime())) return d;
  }
  if (typeof completedAt === "string") {
    const d = new Date(completedAt);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return resolveBookingDateForReminder(booking);
}

function addDays(base: Date, days: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d;
}

function toIso(ts: Timestamp | Date | string | { toDate: () => Date } | null | undefined): string | null {
  if (!ts) return null;
  if (ts instanceof Timestamp) return ts.toDate().toISOString();
  if (ts instanceof Date) return ts.toISOString();
  if (typeof ts === "string") return ts;
  if (typeof ts === "object" && typeof ts.toDate === "function") {
    return ts.toDate().toISOString();
  }
  return null;
}

function buildReminderMessage(params: {
  clientName: string;
  workshopName: string;
  serviceName?: string | null;
  bookingCode?: string | null;
  vehicleNumber?: string | null;
  portalUrl: string;
  customMessage?: string;
  phase?: "main" | "advance";
}): { title: string; message: string; sms: string; type: "service_reminder" | "service_reminder_advance" } {
  const name = params.clientName?.trim() || "there";
  const code = params.bookingCode ? ` (${params.bookingCode})` : "";
  const service = params.serviceName ? ` for your ${params.serviceName}` : "";
  const vehicle = params.vehicleNumber ? ` (${params.vehicleNumber})` : "";
  const portal = params.portalUrl ? ` Book online: ${params.portalUrl}` : "";

  if (params.phase === "advance") {
    const message = `Hi ${name}, friendly reminder that your vehicle${vehicle} service${service}${code} is due in 1 week. Book your next appointment when it suits you.`;
    return {
      title: "Service Due in 1 Week",
      message,
      sms: `${params.workshopName}: ${message}${portal}`,
      type: "service_reminder_advance",
    };
  }

  if (params.customMessage?.trim()) {
    const personalized = params.customMessage
      .replace(/\{name\}/gi, name)
      .replace(/\{service\}/gi, params.serviceName || "service")
      .replace(/\{vehicle\}/gi, params.vehicleNumber || "vehicle")
      .trim();
    return {
      title: "Service Reminder",
      message: personalized,
      sms: `${params.workshopName}: ${personalized}${portal}`,
      type: "service_reminder",
    };
  }

  const message = `Hi ${name}, friendly reminder that your vehicle${vehicle} is due${service}${code}. Book your next service when it suits you.`;
  return {
    title: "Service Reminder",
    message,
    sms: `${params.workshopName}: ${message}${portal}`,
    type: "service_reminder",
  };
}

export async function getServiceReminderSettings(branchId: string): Promise<ServiceReminderSettings> {
  const snap = await adminDb().doc(`branches/${branchId}`).get();
  if (!snap.exists) return defaultSettings();
  const raw = snap.data()?.serviceReminderSettings;
  if (!raw || typeof raw !== "object") return defaultSettings();
  return {
    enabled: !!raw.enabled,
    intervalDays:
      typeof raw.intervalDays === "number" && raw.intervalDays > 0
        ? raw.intervalDays
        : DEFAULT_SERVICE_REMINDER_INTERVAL_DAYS,
    customMessage:
      typeof raw.customMessage === "string" && raw.customMessage.trim()
        ? raw.customMessage.trim()
        : undefined,
    serviceIntervals: normalizeServiceIntervals(raw.serviceIntervals),
  };
}

function parseOwnerServiceReminderSettings(raw: unknown): ServiceReminderSettings {
  if (!raw || typeof raw !== "object") return defaultSettings();
  const data = raw as Record<string, unknown>;
  const serviceIntervals = normalizeServiceIntervals(data.serviceIntervals);
  const hasIntervals = Object.keys(serviceIntervals).length > 0;
  return {
    enabled: !!data.enabled || hasIntervals,
    intervalDays: DEFAULT_SERVICE_REMINDER_INTERVAL_DAYS,
    customMessage:
      typeof data.customMessage === "string" && data.customMessage.trim()
        ? data.customMessage.trim()
        : undefined,
    serviceIntervals,
  };
}

/** Owner-level reminder settings (preferred). Falls back to merged branch settings. */
export async function getOwnerServiceReminderSettings(ownerUid: string): Promise<ServiceReminderSettings> {
  const ownerSnap = await adminDb().doc(`users/${ownerUid}`).get();
  const ownerRaw = ownerSnap.data()?.serviceReminderSettings;
  const ownerSettings = parseOwnerServiceReminderSettings(ownerRaw);
  if (Object.keys(ownerSettings.serviceIntervals || {}).length > 0) {
    return ownerSettings;
  }

  // Backward compatibility: merge intervals saved on branches before owner-level storage.
  const branchSnap = await adminDb()
    .collection("branches")
    .where("ownerUid", "==", ownerUid)
    .get();
  const merged: Record<string, number> = {};
  let enabled = false;
  let customMessage: string | undefined;
  for (const doc of branchSnap.docs) {
    const branchSettings = parseOwnerServiceReminderSettings(doc.data()?.serviceReminderSettings);
    if (branchSettings.enabled) enabled = true;
    if (branchSettings.customMessage) customMessage = branchSettings.customMessage;
    Object.assign(merged, branchSettings.serviceIntervals || {});
  }
  if (Object.keys(merged).length === 0) {
    return defaultSettings();
  }
  return {
    enabled,
    intervalDays: DEFAULT_SERVICE_REMINDER_INTERVAL_DAYS,
    customMessage,
    serviceIntervals: merged,
  };
}

export async function saveOwnerServiceReminderSettings(
  ownerUid: string,
  serviceIntervals: Record<string, number>,
  customMessage?: string,
): Promise<ServiceReminderSettings> {
  const normalized = normalizeServiceIntervals(serviceIntervals);
  const trimmedMessage = customMessage?.trim() || "";
  const settingsPayload: Record<string, unknown> = {
    enabled: Object.keys(normalized).length > 0,
    serviceIntervals: normalized,
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (trimmedMessage) {
    settingsPayload.customMessage = trimmedMessage;
  } else {
    settingsPayload.customMessage = FieldValue.delete();
  }

  await adminDb().doc(`users/${ownerUid}`).set(
    { serviceReminderSettings: settingsPayload },
    { merge: true },
  );

  return {
    enabled: !!settingsPayload.enabled,
    intervalDays: DEFAULT_SERVICE_REMINDER_INTERVAL_DAYS,
    customMessage: trimmedMessage || undefined,
    serviceIntervals: normalized,
  };
}

export async function assertBranchReminderAccess(params: {
  branchId: string;
  ownerUid: string;
  userUid: string;
  userRole: string;
}): Promise<void> {
  const branchId = params.branchId.trim();
  if (!branchId) {
    throw new Error("Branch is required");
  }

  const branchSnap = await adminDb().doc(`branches/${branchId}`).get();
  if (!branchSnap.exists) {
    throw new Error("Branch not found");
  }

  const branchData = branchSnap.data() || {};
  if (String(branchData.ownerUid || "") !== params.ownerUid) {
    throw new Error("Forbidden");
  }

  if (params.userRole === "branch_admin") {
    const userSnap = await adminDb().doc(`users/${params.userUid}`).get();
    const userBranchId = String(userSnap.data()?.branchId || "").trim();
    if (userBranchId !== branchId) {
      throw new Error("Forbidden");
    }
  } else if (params.userRole !== "workshop_owner") {
    throw new Error("Forbidden");
  }
}

export async function saveServiceReminderSettings(
  branchId: string,
  settings: ServiceReminderSettings,
): Promise<ServiceReminderSettings> {
  const serviceIntervals = normalizeServiceIntervals(settings.serviceIntervals);
  const payload = {
    enabled: true,
    intervalDays: settings.intervalDays,
    serviceIntervals,
    ...(settings.customMessage ? { customMessage: settings.customMessage.trim() } : {}),
    updatedAt: FieldValue.serverTimestamp(),
  };

  await adminDb().doc(`branches/${branchId}`).set(
    { serviceReminderSettings: payload },
    { merge: true },
  );

  return {
    enabled: true,
    intervalDays: payload.intervalDays,
    customMessage: settings.customMessage?.trim() || undefined,
    serviceIntervals,
  };
}

function bookingReminderSnapshot(
  intervalDays: number,
  dueAt: Date,
  status: ServiceReminderStatus,
  sentAt?: Date | null,
  advanceDueAt?: Date | null,
  advanceStatus?: ServiceReminderAdvanceStatus,
  advanceSentAt?: Date | null,
): BookingServiceReminderSnapshot {
  return {
    enabled: status !== "cancelled",
    intervalDays,
    dueAt: dueAt.toISOString(),
    status,
    sentAt: sentAt ? sentAt.toISOString() : null,
    advanceDueAt: advanceDueAt ? advanceDueAt.toISOString() : null,
    advanceStatus: advanceStatus || (advanceDueAt ? "pending" : "skipped"),
    advanceSentAt: advanceSentAt ? advanceSentAt.toISOString() : null,
  };
}

export async function upsertServiceReminderForBooking(params: {
  bookingId: string;
  ownerUid: string;
  booking?: Record<string, unknown>;
  intervalDays: number;
  enabled?: boolean;
}): Promise<void> {
  const { bookingId, ownerUid, intervalDays } = params;
  const enabled = params.enabled !== false;

  if (!enabled) {
    await cancelServiceReminderForBooking(bookingId);
    return;
  }

  const db = adminDb();
  const bookingSnap = params.booking
    ? null
    : await db.doc(`bookings/${bookingId}`).get();
  const booking = (params.booking || bookingSnap?.data() || {}) as Record<string, unknown>;

  if (String(booking.status || "") !== "Completed") {
    throw new Error("Service reminders can only be scheduled for completed bookings");
  }

  const bookingAnchor = resolveReminderAnchorDate(booking);
  const dueAt = addDays(bookingAnchor, intervalDays);
  const advanceDueAt = computeAdvanceReminderDueDate(bookingAnchor, intervalDays);
  const now = Timestamp.now();
  const anchorTs = Timestamp.fromDate(bookingAnchor);
  const dueTs = Timestamp.fromDate(dueAt);
  const advanceDueTs = advanceDueAt ? Timestamp.fromDate(advanceDueAt) : null;

  const reminderRef = db.collection(SERVICE_REMINDER_COLLECTION).doc(bookingId);
  const existing = await reminderRef.get();
  const existingData = existing.data();
  if (existing.exists && existingData?.status === "sent") {
    return;
  }

  const advanceAlreadySent = existingData?.advanceStatus === "sent";
  const advanceStatus: ServiceReminderAdvanceStatus = advanceDueAt
    ? advanceAlreadySent
      ? "sent"
      : "pending"
    : "skipped";

  const doc: Omit<ServiceReminderDoc, "createdAt"> & { createdAt?: Timestamp } = {
    bookingId,
    ownerUid,
    branchId: (booking.branchId as string) || null,
    customerUid: (booking.customerUid as string) || (booking.customerId as string) || null,
    customerEmail: (booking.clientEmail as string) || null,
    customerPhone: (booking.clientPhone as string) || null,
    clientName: String(booking.client || "Customer"),
    serviceName: (booking.serviceName as string) || null,
    bookingCode: (booking.bookingCode as string) || null,
    branchName: (booking.branchName as string) || null,
    vehicleNumber: (booking.vehicleNumber as string) || null,
    bookingDate: String(booking.date || "") || null,
    completedAt: anchorTs,
    dueAt: dueTs,
    intervalDays,
    status: "pending",
    sentAt: null,
    advanceDueAt: advanceDueTs,
    advanceStatus,
    advanceSentAt: advanceAlreadySent ? existingData?.advanceSentAt ?? null : null,
    updatedAt: now,
    ...(existing.exists ? {} : { createdAt: now }),
  };

  await reminderRef.set(doc, { merge: true });

  const snapshot = bookingReminderSnapshot(
    intervalDays,
    dueAt,
    "pending",
    null,
    advanceDueAt,
    advanceStatus,
    advanceAlreadySent && existingData?.advanceSentAt
      ? (existingData.advanceSentAt as { toDate?: () => Date }).toDate?.() ?? null
      : null,
  );
  await db.doc(`bookings/${bookingId}`).set(
    {
      serviceReminder: snapshot,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

export async function cancelServiceReminderForBooking(bookingId: string): Promise<void> {
  const db = adminDb();
  const reminderRef = db.collection(SERVICE_REMINDER_COLLECTION).doc(bookingId);
  const existing = await reminderRef.get();
  if (existing.exists && existing.data()?.status !== "sent") {
    await reminderRef.set(
      {
        status: "cancelled",
        advanceStatus: "cancelled",
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  }

  await db.doc(`bookings/${bookingId}`).set(
    {
      serviceReminder: {
        enabled: false,
        status: "cancelled",
        updatedAt: new Date().toISOString(),
      },
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

/**
 * Schedule a reminder when a booking is marked completed, using owner defaults.
 * Safe to call fire-and-forget from completion routes.
 */
export async function scheduleServiceReminderOnCompletion(bookingId: string): Promise<void> {
  try {
    const db = adminDb();
    const bookingSnap = await db.doc(`bookings/${bookingId}`).get();
    if (!bookingSnap.exists) return;

    const booking = bookingSnap.data() as Record<string, unknown>;
    const ownerUid = String(booking.ownerUid || "");
    if (!ownerUid) return;

    const settings = await getOwnerServiceReminderSettings(ownerUid);
    if (!settings.enabled) return;

    const intervalDays = resolveIntervalDaysForBooking(booking, settings);
    if (intervalDays === null) return;

    const existing = await db.collection(SERVICE_REMINDER_COLLECTION).doc(bookingId).get();
    if (existing.exists && existing.data()?.status === "sent") {
      return;
    }

    await upsertServiceReminderForBooking({
      bookingId,
      ownerUid,
      booking,
      intervalDays,
      enabled: true,
    });
  } catch (error) {
    console.error(`[serviceReminders] scheduleServiceReminderOnCompletion(${bookingId}):`, error);
  }
}

const BULK_SCHEDULE_LIMIT = 500;

/** Schedule or refresh reminders for every completed booking for an owner. */
export async function bulkScheduleServiceRemindersForOwner(
  ownerUid: string,
  settings: ServiceReminderSettings,
): Promise<{ scheduled: number; skipped: number; errors: number }> {
  const db = adminDb();
  let scheduled = 0;
  let skipped = 0;
  let errors = 0;

  const snap = await db
    .collection("bookings")
    .where("ownerUid", "==", ownerUid)
    .where("status", "==", "Completed")
    .limit(BULK_SCHEDULE_LIMIT)
    .get();

  for (const doc of snap.docs) {
    const booking = doc.data() as Record<string, unknown>;
    try {
      const intervalDays = resolveIntervalDaysForBooking(booking, settings);
      if (intervalDays === null) {
        skipped++;
        continue;
      }
      const existing = await db.collection(SERVICE_REMINDER_COLLECTION).doc(doc.id).get();
      if (existing.exists && existing.data()?.status === "sent") {
        skipped++;
        continue;
      }
      await upsertServiceReminderForBooking({
        bookingId: doc.id,
        ownerUid,
        booking,
        intervalDays,
        enabled: true,
      });
      scheduled++;
    } catch (e) {
      errors++;
      console.error(`[serviceReminders] bulk schedule failed for ${doc.id}:`, e);
    }
  }

  return { scheduled, skipped, errors };
}

async function sendServiceReminderChannels(
  reminder: ServiceReminderDoc,
  phase: "main" | "advance",
): Promise<void> {
  const workshopName = await getWorkshopName(reminder.ownerUid);
  const portalUrl = await getBookingPortalUrl(reminder.ownerUid);
  const ownerSettings = await getOwnerServiceReminderSettings(reminder.ownerUid);
  const content = buildReminderMessage({
    clientName: reminder.clientName,
    workshopName,
    serviceName: reminder.serviceName,
    bookingCode: reminder.bookingCode,
    vehicleNumber: reminder.vehicleNumber,
    portalUrl,
    customMessage: ownerSettings.customMessage,
    phase,
  });

  await createNotification({
    bookingId: reminder.bookingId,
    bookingCode: reminder.bookingCode || undefined,
    type: content.type,
    title: content.title,
    message: content.message,
    status: "Completed",
    ownerUid: reminder.ownerUid,
    customerUid: reminder.customerUid || undefined,
    customerEmail: reminder.customerEmail || undefined,
    customerPhone: reminder.customerPhone || undefined,
    clientName: reminder.clientName,
    serviceName: reminder.serviceName || undefined,
    branchName: reminder.branchName || undefined,
  } as Parameters<typeof createNotification>[0]);

  const smsContext =
    phase === "advance"
      ? `service-reminder-advance:${reminder.bookingId}`
      : `service-reminder:${reminder.bookingId}`;

  if (reminder.customerPhone && isSmsConfigured()) {
    const smsResult = await sendSms({
      to: reminder.customerPhone,
      message: content.sms,
      context: smsContext,
      ownerUid: reminder.ownerUid,
      source: "service_reminder",
    });
    if (!smsResult.success && !smsResult.skipped) {
      console.error(`[serviceReminders] SMS failed for ${reminder.bookingId} (${phase}):`, smsResult.error);
    }
  }

  if (reminder.customerEmail && isZeptoMailConfigured()) {
    const emailResult = await sendEmail({
      sender: "request",
      to: reminder.customerEmail,
      toName: reminder.clientName,
      subject: `${content.title} - ${workshopName}`,
      htmlBody: `<p>${content.message.replace(/\n/g, "<br>")}</p>${
        portalUrl
          ? `<p><a href="${portalUrl}">Book your next service</a></p>`
          : ""
      }`,
    });
    if (!emailResult.ok) {
      console.error(`[serviceReminders] Email failed for ${reminder.bookingId} (${phase}):`, emailResult.message);
    }
  }
}

async function syncBookingReminderSnapshot(
  db: Firestore,
  reminder: ServiceReminderDoc,
  patch: Partial<BookingServiceReminderSnapshot>,
): Promise<void> {
  const dueIso = toIso(reminder.dueAt);
  const advanceDueIso = reminder.advanceDueAt ? toIso(reminder.advanceDueAt) : null;
  await db.doc(`bookings/${reminder.bookingId}`).set(
    {
      serviceReminder: {
        enabled: true,
        intervalDays: reminder.intervalDays,
        dueAt: dueIso || new Date().toISOString(),
        status: patch.status ?? reminder.status,
        sentAt: patch.sentAt ?? null,
        advanceDueAt: advanceDueIso,
        advanceStatus: patch.advanceStatus ?? reminder.advanceStatus ?? "skipped",
        advanceSentAt: patch.advanceSentAt ?? null,
      },
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

async function queryDueAdvanceReminders(
  db: Firestore,
  now: Timestamp,
): Promise<QueryDocumentSnapshot[]> {
  try {
    const snap = await db
      .collection(SERVICE_REMINDER_COLLECTION)
      .where("advanceStatus", "==", "pending")
      .where("advanceDueAt", "<=", now)
      .limit(CRON_BATCH_LIMIT)
      .get();
    return snap.docs;
  } catch (error) {
    console.error("[serviceReminders] Advance query failed (index may be required):", error);
    const fallback = await db
      .collection(SERVICE_REMINDER_COLLECTION)
      .where("advanceStatus", "==", "pending")
      .limit(CRON_BATCH_LIMIT)
      .get();
    return fallback.docs.filter((d) => {
      const advanceDueAt = d.data().advanceDueAt as Timestamp | undefined;
      if (!advanceDueAt?.toDate) return false;
      return advanceDueAt.toDate() <= now.toDate();
    });
  }
}

async function queryDueMainReminders(
  db: Firestore,
  now: Timestamp,
): Promise<QueryDocumentSnapshot[]> {
  try {
    const snap = await db
      .collection(SERVICE_REMINDER_COLLECTION)
      .where("status", "==", "pending")
      .where("dueAt", "<=", now)
      .limit(CRON_BATCH_LIMIT)
      .get();
    return snap.docs;
  } catch (error) {
    console.error("[serviceReminders] Main query failed (index may be required):", error);
    const fallback = await db
      .collection(SERVICE_REMINDER_COLLECTION)
      .where("status", "==", "pending")
      .limit(CRON_BATCH_LIMIT)
      .get();
    return fallback.docs.filter((d) => {
      const dueAt = d.data().dueAt as Timestamp | undefined;
      if (!dueAt?.toDate) return false;
      return dueAt.toDate() <= now.toDate();
    });
  }
}

export async function processDueServiceReminders(): Promise<{
  processed: number;
  sent: number;
  advanceSent: number;
  errors: number;
  truncated: boolean;
}> {
  const db = adminDb();
  const now = Timestamp.now();

  const advanceDocs = await queryDueAdvanceReminders(db, now);
  const mainDocs = await queryDueMainReminders(db, now);

  let sent = 0;
  let advanceSent = 0;
  let errors = 0;

  for (const doc of advanceDocs) {
    const reminder = doc.data() as ServiceReminderDoc;
    try {
      await sendServiceReminderChannels(reminder, "advance");
      const advanceSentAt = Timestamp.now();
      await doc.ref.set(
        {
          advanceStatus: "sent",
          advanceSentAt,
          updatedAt: advanceSentAt,
        },
        { merge: true },
      );
      await syncBookingReminderSnapshot(db, reminder, {
        advanceStatus: "sent",
        advanceSentAt: advanceSentAt.toDate().toISOString(),
        status: reminder.status,
      });
      advanceSent++;
    } catch (error) {
      errors++;
      console.error(`[serviceReminders] Failed to send advance reminder ${doc.id}:`, error);
    }
  }

  for (const doc of mainDocs) {
    const reminder = doc.data() as ServiceReminderDoc;
    try {
      await sendServiceReminderChannels(reminder, "main");
      const sentAt = Timestamp.now();
      await doc.ref.set(
        {
          status: "sent",
          sentAt,
          updatedAt: sentAt,
        },
        { merge: true },
      );
      await syncBookingReminderSnapshot(db, reminder, {
        status: "sent",
        sentAt: sentAt.toDate().toISOString(),
        advanceStatus: reminder.advanceStatus ?? "skipped",
        advanceSentAt: reminder.advanceSentAt ? toIso(reminder.advanceSentAt) : null,
      });
      sent++;
    } catch (error) {
      errors++;
      console.error(`[serviceReminders] Failed to send main reminder ${doc.id}:`, error);
    }
  }

  const truncated =
    advanceDocs.length === CRON_BATCH_LIMIT || mainDocs.length === CRON_BATCH_LIMIT;

  return {
    processed: advanceDocs.length + mainDocs.length,
    sent,
    advanceSent,
    errors,
    truncated,
  };
}

/** Send pending reminder phases immediately (for owner testing — ignores due dates). */
export async function sendServiceReminderNowForBooking(bookingId: string): Promise<{
  advanceSent: boolean;
  mainSent: boolean;
}> {
  const db = adminDb();
  const docRef = db.collection(SERVICE_REMINDER_COLLECTION).doc(bookingId);
  const doc = await docRef.get();
  if (!doc.exists) {
    throw new Error("No reminder scheduled. Click Schedule reminder first.");
  }

  const reminder = doc.data() as ServiceReminderDoc;
  let advanceSent = false;
  let mainSent = false;
  const now = Timestamp.now();

  if (reminder.advanceStatus === "pending") {
    await sendServiceReminderChannels(reminder, "advance");
    await docRef.set(
      { advanceStatus: "sent", advanceSentAt: now, updatedAt: now },
      { merge: true },
    );
    reminder.advanceStatus = "sent";
    advanceSent = true;
  }

  if (reminder.status === "pending") {
    await sendServiceReminderChannels(reminder, "main");
    await docRef.set({ status: "sent", sentAt: now, updatedAt: now }, { merge: true });
    reminder.status = "sent";
    mainSent = true;
  }

  if (!advanceSent && !mainSent) {
    throw new Error("All reminders for this booking were already sent.");
  }

  const dueIso = toIso(reminder.dueAt);
  const advanceDueIso = reminder.advanceDueAt ? toIso(reminder.advanceDueAt) : null;
  await db.doc(`bookings/${bookingId}`).set(
    {
      serviceReminder: {
        enabled: true,
        intervalDays: reminder.intervalDays,
        dueAt: dueIso || new Date().toISOString(),
        status: reminder.status,
        sentAt: mainSent ? now.toDate().toISOString() : null,
        advanceDueAt: advanceDueIso,
        advanceStatus: reminder.advanceStatus ?? "skipped",
        advanceSentAt: advanceSent ? now.toDate().toISOString() : toIso(reminder.advanceSentAt),
      },
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  return { advanceSent, mainSent };
}

export function parseBookingServiceReminder(raw: unknown): BookingServiceReminderSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const status = r.status as ServiceReminderStatus;
  if (status !== "pending" && status !== "sent" && status !== "cancelled") return null;
  const dueAt = typeof r.dueAt === "string" ? r.dueAt : null;
  if (!dueAt) return null;
  return {
    enabled: !!r.enabled,
    intervalDays: typeof r.intervalDays === "number" ? r.intervalDays : DEFAULT_SERVICE_REMINDER_INTERVAL_DAYS,
    dueAt,
    status,
    sentAt: typeof r.sentAt === "string" ? r.sentAt : null,
    advanceDueAt: typeof r.advanceDueAt === "string" ? r.advanceDueAt : null,
    advanceStatus:
      r.advanceStatus === "pending" ||
      r.advanceStatus === "sent" ||
      r.advanceStatus === "skipped" ||
      r.advanceStatus === "cancelled"
        ? r.advanceStatus
        : undefined,
    advanceSentAt: typeof r.advanceSentAt === "string" ? r.advanceSentAt : null,
  };
}
