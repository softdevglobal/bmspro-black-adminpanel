import crypto from "crypto";
import type { Firestore } from "firebase-admin/firestore";
import { FieldValue } from "firebase-admin/firestore";

/**
 * Default password assigned to auto-created customer accounts when a booking
 * is created on the customer's behalf (by an Admin, Owner, or Staff member).
 * Customers are prompted (via the welcome email) to change this after first login.
 */
export const DEFAULT_CUSTOMER_PASSWORD = "000000";

/** Digits-only phone for matching walk-in / portal customers across formatting differences. */
export function normalizePhoneDigits(phone: string | null | undefined): string {
  return String(phone ?? "").replace(/\D/g, "");
}

/**
 * Hash a plain-text password using PBKDF2 (SHA-512, 100k iterations, 64-byte digest).
 * Matches the scheme used by `app/api/book-now/customer-auth/route.ts` so that
 * auto-created accounts can log in via the existing booking-engine login flow.
 */
export function hashCustomerPassword(
  password: string,
  salt?: string
): { hash: string; salt: string } {
  const s = salt || crypto.randomBytes(32).toString("hex");
  const hash = crypto
    .pbkdf2Sync(password, s, 100_000, 64, "sha512")
    .toString("hex");
  return { hash, salt: s };
}

export type EnsureCustomerAccountInput = {
  ownerUid: string;
  email: string;
  name?: string | null;
  phone?: string | null;
  /**
   * Override the default password when provisioning a brand-new account.
   * Defaults to `DEFAULT_CUSTOMER_PASSWORD` ("000000").
   */
  defaultPassword?: string;
};

export type EnsureCustomerAccountResult = {
  /** True when a brand-new customer doc was created by this call. */
  created: boolean;
  /** Firestore document id in the `customers` collection. */
  customerId: string;
  /** The normalized (lowercased, trimmed) email used for the lookup. */
  email: string;
  /** The default password used when `created` is true. `null` when existing. */
  defaultPassword: string | null;
};

/**
 * Ensure a customer account exists in the `customers` collection for the given
 * `ownerUid + email` pair. Accounts are scoped per workshop (ownerUid) to mirror
 * the behaviour of `app/api/book-now/customer-auth/route.ts`.
 *
 * - If a matching customer already exists, this is a no-op and returns
 *   `{ created: false, ... }` so the caller can skip sending a welcome email.
 * - Otherwise a new customer is created with the provided default password
 *   (hashed with PBKDF2) and the resulting id + flag are returned.
 *
 * Intentionally does NOT throw on missing email — returns `null` instead so
 * callers can keep the booking flow resilient when no email was supplied.
 */
export async function ensureCustomerAccount(
  db: Firestore,
  input: EnsureCustomerAccountInput
): Promise<EnsureCustomerAccountResult | null> {
  const rawEmail = (input.email || "").trim().toLowerCase();
  if (!rawEmail) return null;

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(rawEmail)) return null;

  if (!input.ownerUid) return null;

  const customersRef = db.collection("customers");

  const existing = await customersRef
    .where("email", "==", rawEmail)
    .where("ownerUid", "==", input.ownerUid)
    .limit(1)
    .get();

  if (!existing.empty) {
    const doc = existing.docs[0];
    const data = doc.data() || {};
    const patch: Record<string, unknown> = {};
    // Existing portal accounts: do not overwrite name/phone from staff-entered
    // booking forms (typos must not change the customer profile). Only backfill
    // phoneNormalized from the stored phone for indexing when missing/stale.
    const fromStored = normalizePhoneDigits(typeof data.phone === "string" ? data.phone : "");
    if (fromStored.length >= 6 && data.phoneNormalized !== fromStored) {
      patch.phoneNormalized = fromStored;
    }
    if (Object.keys(patch).length > 0) {
      patch.updatedAt = FieldValue.serverTimestamp();
      try {
        await doc.ref.update(patch);
      } catch {
        // Non-fatal; existing account is still valid without the extra fields.
      }
    }
    return {
      created: false,
      customerId: doc.id,
      email: rawEmail,
      defaultPassword: null,
    };
  }

  const password = input.defaultPassword || DEFAULT_CUSTOMER_PASSWORD;
  const { hash, salt } = hashCustomerPassword(password);
  const phoneDigitsNew = normalizePhoneDigits(input.phone);

  const ref = await customersRef.add({
    email: rawEmail,
    name: (input.name || "").trim(),
    client: (input.name || "").trim(),
    phone: (input.phone || "").trim(),
    ...(phoneDigitsNew.length >= 6 ? { phoneNormalized: phoneDigitsNew } : {}),
    passwordHash: hash,
    salt,
    ownerUid: input.ownerUid,
    autoCreatedFromBooking: true,
    mustChangePassword: true,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  return {
    created: true,
    customerId: ref.id,
    email: rawEmail,
    defaultPassword: password,
  };
}

/**
 * Resolve the workshop customer row for staff/admin-created bookings:
 * 1) Valid email → ensureCustomerAccount (creates or links; updates phoneNormalized).
 * 2) No usable email but normalized phone (8+ digits) → link to existing customer with same ownerUid + phoneNormalized.
 *
 * Returns null only when no email match is possible and no phone match exists (e.g. brand-new walk-in with no email in payload).
 */
export async function resolveCustomerForStaffBooking(
  db: Firestore,
  input: {
    ownerUid: string;
    email?: string | null;
    phone?: string | null;
    name?: string | null;
  }
): Promise<EnsureCustomerAccountResult | null> {
  if (!input.ownerUid) return null;

  const rawEmail = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const phoneDigits = normalizePhoneDigits(input.phone);

  if (rawEmail && emailRegex.test(rawEmail)) {
    return ensureCustomerAccount(db, {
      ownerUid: input.ownerUid,
      email: rawEmail,
      name: input.name,
      phone: input.phone,
    });
  }

  if (phoneDigits.length >= 8) {
    const snap = await db
      .collection("customers")
      .where("ownerUid", "==", input.ownerUid)
      .where("phoneNormalized", "==", phoneDigits)
      .limit(1)
      .get();
    if (!snap.empty) {
      const doc = snap.docs[0];
      const data = doc.data() || {};
      return {
        created: false,
        customerId: doc.id,
        email: String(data.email || ""),
        defaultPassword: null,
      };
    }
  }

  return null;
}

export type CanonicalCustomerContact = {
  name: string;
  email: string;
  phone: string;
};

/**
 * Load the workshop-scoped customer profile used on bookings/emails when an
 * existing portal account is linked (staff-entered contact fields are ignored).
 */
export async function getCanonicalCustomerContact(
  db: Firestore,
  customerId: string,
  ownerUid: string
): Promise<CanonicalCustomerContact | null> {
  if (!customerId || !ownerUid) return null;
  const snap = await db.doc(`customers/${customerId}`).get();
  if (!snap.exists) return null;
  const d = snap.data() || {};
  if (String(d.ownerUid) !== ownerUid) return null;
  const email = String(d.email || "").trim().toLowerCase();
  const name = String(d.name || d.client || "").trim();
  const phone = String(d.phone || "").trim();
  return { name, email, phone };
}

/**
 * Hard-coded production host for customer-facing links. We use this whenever
 * the configured app/booking-engine base looks like a local dev host (localhost,
 * 127.0.0.1, *.local, *.test, an IP, or empty), so that emails sent from a dev
 * machine still point real customers at the live black portal instead of a URL
 * they cannot reach (e.g. http://localhost:3000/book-now/...).
 */
const LIVE_BLACK_PORTAL_BASE = "https://black.bmspros.com.au";

function isUsableProductionHost(value: string | null | undefined): boolean {
  const v = (value || "").trim();
  if (!v) return false;
  try {
    const href = v.includes("://") ? v : `https://${v}`;
    const host = new URL(href).hostname.toLowerCase();
    if (!host) return false;
    if (host === "localhost") return false;
    if (host === "127.0.0.1" || host === "0.0.0.0" || host === "::1") return false;
    if (host.endsWith(".local") || host.endsWith(".test") || host.endsWith(".localhost")) return false;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the customer-facing booking-engine *base* URL (i.e. the host) used in
 * outbound emails. Order of preference:
 *   1. `NEXT_PUBLIC_BOOKING_ENGINE_URL`  (e.g. `https://black.bmspros.com.au/book-now`)
 *   2. `NEXT_PUBLIC_APP_URL`             (e.g. `https://black.bmspros.com.au`)
 *   3. Hard-coded live black portal     (`https://black.bmspros.com.au`)
 *
 * Localhost / dev hosts are skipped so dev-mode emails still point at the live
 * black portal, never `http://localhost:3000`.
 */
function resolveCustomerFacingAppBase(): string {
  const candidates = [
    process.env.NEXT_PUBLIC_BOOKING_ENGINE_URL,
    process.env.NEXT_PUBLIC_APP_URL,
  ];
  for (const candidate of candidates) {
    if (!isUsableProductionHost(candidate)) continue;
    const trimmed = (candidate as string).trim().replace(/\/$/, "");
    // `NEXT_PUBLIC_BOOKING_ENGINE_URL` is conventionally `<host>/book-now`;
    // strip the trailing `/book-now` so callers can append it themselves.
    return trimmed.replace(/\/book-now$/i, "");
  }
  return LIVE_BLACK_PORTAL_BASE;
}

/**
 * Build the public booking engine URL for a given workshop.
 *
 * The customer-facing portal lives at `<app-base>/book-now/<slug>`. We always
 * prefer the slug-based URL on the live host (see `resolveCustomerFacingAppBase`
 * above for the precedence + localhost guard). We only fall back to the owner's
 * stored `bookingEngineUrl` field when no slug is available; that stored value
 * can be stale or pointing at the wrong portal.
 */
export function resolveBookingEngineUrl(
  ownerData: Record<string, unknown> | null | undefined
): string {
  const appUrl = resolveCustomerFacingAppBase();
  if (!ownerData) return appUrl;

  const slug = typeof ownerData.slug === "string" ? ownerData.slug.trim() : "";
  if (slug) return `${appUrl}/book-now/${slug}`;

  const stored = typeof ownerData.bookingEngineUrl === "string"
    ? ownerData.bookingEngineUrl.trim()
    : "";
  if (stored && isUsableProductionHost(stored)) return stored;

  return appUrl;
}

/**
 * Appends `view=my-bookings` so the book-now page opens the customer's portal tab,
 * where they accept or decline additional-work quotes.
 *
 * If the input URL points at a local/dev host, we rewrite the host to the live
 * black portal so emails generated from a dev machine still reach customers
 * with a clickable production link.
 */
export function appendBookNowMyBookingsDeepLink(bookingEngineUrl: string): string {
  const trimmed = (bookingEngineUrl || "").trim();
  const fallbackBase = resolveCustomerFacingAppBase();
  const base = trimmed || fallbackBase;
  try {
    const href = base.includes("://") ? base : `https://${base}`;
    const u = new URL(href);
    if (!isUsableProductionHost(u.origin)) {
      const live = new URL(resolveCustomerFacingAppBase());
      u.protocol = live.protocol;
      u.hostname = live.hostname;
      u.port = live.port;
    }
    u.searchParams.set("view", "my-bookings");
    return u.toString();
  } catch {
    const sep = base.includes("?") ? "&" : "?";
    return `${base}${sep}view=my-bookings`;
  }
}
