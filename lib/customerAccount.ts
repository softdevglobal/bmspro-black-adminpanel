import crypto from "crypto";
import type { Firestore } from "firebase-admin/firestore";
import { FieldValue } from "firebase-admin/firestore";

/**
 * Default password assigned to auto-created customer accounts when a booking
 * is created on the customer's behalf (by an Admin, Owner, or Staff member).
 * Customers are prompted (via the welcome email) to change this after first login.
 */
export const DEFAULT_CUSTOMER_PASSWORD = "000000";

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
    if (!data.name && input.name?.trim()) patch.name = input.name.trim();
    if (!data.phone && input.phone?.trim()) patch.phone = input.phone.trim();
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

  const ref = await customersRef.add({
    email: rawEmail,
    name: (input.name || "").trim(),
    client: (input.name || "").trim(),
    phone: (input.phone || "").trim(),
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
 * Build the public booking engine URL for a given workshop.
 * Prefers the owner's stored `bookingEngineUrl` field; falls back to
 * `${NEXT_PUBLIC_APP_URL}/book-now/${slug}` when a slug is available; finally
 * returns the plain app URL if nothing else is known.
 */
export function resolveBookingEngineUrl(
  ownerData: Record<string, unknown> | null | undefined
): string {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://black.bmspros.com.au";
  if (!ownerData) return appUrl;

  const stored = typeof ownerData.bookingEngineUrl === "string"
    ? ownerData.bookingEngineUrl.trim()
    : "";
  if (stored) return stored;

  const slug = typeof ownerData.slug === "string" ? ownerData.slug.trim() : "";
  if (slug) return `${appUrl}/book-now/${slug}`;

  return appUrl;
}
