import "server-only";

import Stripe from "stripe";
import { adminDb } from "@/lib/firebaseAdmin";
import { getSmsPackage, purchaseSmsPackageForBusiness, getBusinessSmsBalance } from "@/lib/sms-packages/server";
import type { SmsPackage } from "@/lib/sms-packages/types";
import type { BusinessSmsBalance } from "@/lib/sms-packages/balance";

let _stripe: Stripe | null = null;

function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key?.trim()) {
    throw new Error("Stripe is not configured");
  }
  return _stripe ?? (_stripe = new Stripe(key, { apiVersion: "2025-12-15.clover" }));
}

export async function syncSmsPackageToStripe(packageId: string): Promise<SmsPackage> {
  const pkg = await getSmsPackage(packageId);
  if (!pkg) {
    throw new Error("SMS package not found");
  }

  const stripe = getStripe();
  const db = adminDb();
  const ref = db.collection("sms_packages").doc(packageId);

  let productId = pkg.stripeProductId ?? undefined;
  if (!productId) {
    const product = await stripe.products.create({
      name: pkg.name,
      description: pkg.description || `${pkg.messageQuota} SMS credits`,
      metadata: { smsPackageId: packageId, type: "sms_topup" },
    });
    productId = product.id;
  } else {
    await stripe.products.update(productId, {
      name: pkg.name,
      description: pkg.description || `${pkg.messageQuota} SMS credits`,
    });
  }

  const price = await stripe.prices.create({
    product: productId,
    unit_amount: Math.round(pkg.price * 100),
    currency: "aud",
    metadata: { smsPackageId: packageId, type: "sms_topup" },
  });

  await ref.update({
    stripeProductId: productId,
    stripePriceId: price.id,
    updatedAt: new Date(),
  });

  const updated = await getSmsPackage(packageId);
  if (!updated) {
    throw new Error("Failed to reload SMS package");
  }
  return updated;
}

export async function fulfillSmsTopUpSession(
  session: Stripe.Checkout.Session,
): Promise<{ fulfilled: boolean; balance: BusinessSmsBalance }> {
  if (session.metadata?.type !== "sms_topup") {
    throw new Error("Not an SMS top-up session");
  }

  const ownerUid = session.metadata?.firebaseUid || session.metadata?.ownerUid;
  const smsPackageId = session.metadata?.smsPackageId;
  if (!ownerUid || !smsPackageId) {
    console.error("[STRIPE SMS] Missing metadata on checkout session", session.id);
    throw new Error("Checkout session is missing SMS metadata");
  }

  const ledgerRef = adminDb().collection("stripe_fulfilled_sessions").doc(session.id);
  const existing = await ledgerRef.get();
  if (existing.exists) {
    console.log("[STRIPE SMS] Session already fulfilled:", session.id);
    return { fulfilled: true, balance: await getBusinessSmsBalance(ownerUid) };
  }

  const pkg = await getSmsPackage(smsPackageId);
  if (!pkg) {
    throw new Error(`SMS package not found: ${smsPackageId}`);
  }

  const { balance } = await purchaseSmsPackageForBusiness(ownerUid, smsPackageId);

  await ledgerRef.set({
    sessionId: session.id,
    ownerUid,
    businessId: ownerUid,
    type: "sms_topup",
    smsPackageId,
    smsPackageName: pkg.name,
    amountTotal: session.amount_total ?? null,
    currency: session.currency ?? "aud",
    fulfilledAt: new Date(),
  });

  console.log("[STRIPE SMS] Fulfilled SMS top-up for", ownerUid, smsPackageId);
  return { fulfilled: true, balance };
}

export async function confirmCheckoutSessionForBusiness(
  sessionId: string,
  ownerUid: string,
): Promise<{ fulfilled: boolean; balance: BusinessSmsBalance }> {
  const stripe = getStripe();
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  if (session.metadata?.firebaseUid !== ownerUid && session.metadata?.ownerUid !== ownerUid) {
    throw new Error("Checkout session does not belong to this tenant");
  }
  if (session.metadata?.type !== "sms_topup") {
    throw new Error("Checkout session is not an SMS top-up");
  }
  if (session.payment_status !== "paid" && session.status !== "complete") {
    throw new Error("Payment not completed yet");
  }
  return fulfillSmsTopUpSession(session);
}

export async function createSmsCheckoutSession(args: {
  ownerUid: string;
  packageId: string;
  successUrl: string;
  cancelUrl: string;
  customerEmail?: string;
}): Promise<{ url: string; sessionId: string }> {
  const pkg = await getSmsPackage(args.packageId);
  if (!pkg || !pkg.active || pkg.hidden) {
    throw new Error("SMS package not available");
  }

  let stripePriceId = pkg.stripePriceId;
  if (!stripePriceId) {
    const synced = await syncSmsPackageToStripe(args.packageId);
    stripePriceId = synced.stripePriceId ?? undefined;
  }
  if (!stripePriceId) {
    throw new Error("SMS package is not linked to Stripe");
  }

  const stripe = getStripe();
  const db = adminDb();
  const userDoc = await db.collection("users").doc(args.ownerUid).get();
  const userData = userDoc.data();
  let customerId = userData?.stripeCustomerId as string | undefined;

  if (!customerId) {
    const customer = await stripe.customers.create({
      email: args.customerEmail || userData?.email || undefined,
      metadata: { firebaseUid: args.ownerUid },
    });
    customerId = customer.id;
    await db.collection("users").doc(args.ownerUid).update({ stripeCustomerId: customerId });
    const ownerRef = db.collection("owners").doc(args.ownerUid);
    if ((await ownerRef.get()).exists) {
      await ownerRef.update({ stripeCustomerId: customerId });
    }
  }

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    customer: customerId,
    line_items: [{ price: stripePriceId, quantity: 1 }],
    success_url: args.successUrl,
    cancel_url: args.cancelUrl,
    metadata: {
      type: "sms_topup",
      firebaseUid: args.ownerUid,
      ownerUid: args.ownerUid,
      smsPackageId: args.packageId,
    },
  });

  if (!session.url) {
    throw new Error("Failed to create Stripe checkout session");
  }

  return { url: session.url, sessionId: session.id };
}
