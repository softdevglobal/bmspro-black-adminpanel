import "server-only";

import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebaseAdmin";
import { verifyAdminAuth } from "@/lib/authHelpers";
import { sendEmail } from "@/lib/email";
import { sendCustomerWelcomeEmail } from "@/lib/emailService";
import {
  ensureCustomerAccount,
  resolveBookingEngineUrl,
} from "@/lib/customerAccount";
import {
  generateSalesDocumentPdf,
  type SalesDocPdfInput,
} from "@/lib/salesDocumentPdf";

/**
 * Quotations & invoices ("sales documents") are a standalone feature: they live
 * in their own `quotations` / `invoices` collections scoped by `ownerUid` and
 * are intentionally NOT linked to bookings.
 */
export type SalesDocKind = "quotation" | "invoice";

const KIND_CONFIG: Record<
  SalesDocKind,
  {
    collection: string;
    codePrefix: string;
    counterField: string;
    docLabel: string;
    dateLabel: string;
    dueLabel: string;
  }
> = {
  quotation: {
    collection: "quotations",
    codePrefix: "QUO",
    counterField: "quotationSeq",
    docLabel: "Quotation",
    dateLabel: "Quote date",
    dueLabel: "Valid until",
  },
  invoice: {
    collection: "invoices",
    codePrefix: "INV",
    counterField: "invoiceSeq",
    docLabel: "Invoice",
    dateLabel: "Invoice date",
    dueLabel: "Due date",
  },
};

const READ_ROLES = ["workshop_owner", "branch_admin"];
const WRITE_ROLES = ["workshop_owner", "branch_admin"];

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

const TERMS_OPTIONS: Record<string, { days: number; label: string }> = {
  same_day: { days: 0, label: "Same day" },
  net_7: { days: 7, label: "7 days" },
  net_14: { days: 14, label: "14 days" },
  net_30: { days: 30, label: "30 days" },
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type LineItemInput = {
  code: string;
  name: string;
  description: string;
  quantity: number;
  rate: number;
  discountPercent: number;
  applyGst: boolean;
};

export type SalesDocumentInput = {
  customer: { fullName: string; email: string; phone: string };
  address: { street: string; suburb: string; state: string; postcode: string };
  jobTitle: string;
  jobDescription: string;
  lineItems: LineItemInput[];
  discountAud: number;
  gstEnabled: boolean;
  gstPercentage: number;
  gstPricing: "exclusive" | "inclusive";
  documentDate: string;
  paymentTermsId: string;
  terms: string;
  comment: string;
  send: boolean;
};

type Totals = {
  subtotalAud: number;
  discountAud: number;
  gstAud: number;
  totalAud: number;
};

// ---------------------------------------------------------------------------
// Parsing & math
// ---------------------------------------------------------------------------

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function asString(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function asNumber(value: unknown): number {
  const n = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  return Number.isFinite(n) ? n : 0;
}

export function parseSalesDocumentInput(
  body: unknown
): { input: SalesDocumentInput } | { error: string } {
  if (!body || typeof body !== "object") return { error: "Invalid request body." };
  const record = body as Record<string, unknown>;

  const customerRaw = (record.customer ?? {}) as Record<string, unknown>;
  const customer = {
    fullName: asString(customerRaw.fullName, 150),
    email: asString(customerRaw.email, 200).toLowerCase(),
    phone: asString(customerRaw.phone, 40),
  };
  if (customer.fullName.length < 2) return { error: "Add a client name." };
  if (!EMAIL_REGEX.test(customer.email)) return { error: "Enter a valid client email." };
  if (customer.phone.replace(/\D/g, "").length < 6) {
    return { error: "Enter a valid client mobile number." };
  }

  const addressRaw = (record.address ?? {}) as Record<string, unknown>;
  const address = {
    street: asString(addressRaw.street, 200),
    suburb: asString(addressRaw.suburb, 100),
    state: asString(addressRaw.state, 50),
    postcode: asString(addressRaw.postcode, 4).replace(/\D/g, ""),
  };

  const jobTitle = asString(record.jobTitle, 120);
  const jobDescription = asString(record.jobDescription, 1500);
  if (jobTitle.length < 3) return { error: "Add a job title." };
  if (jobDescription.length < 10) return { error: "Describe the work." };

  const rawItems = Array.isArray(record.lineItems) ? record.lineItems : [];
  if (rawItems.length === 0) return { error: "Add at least one line item." };
  if (rawItems.length > 100) return { error: "Too many line items." };

  const lineItems: LineItemInput[] = [];
  for (const raw of rawItems) {
    const row = (raw ?? {}) as Record<string, unknown>;
    const item: LineItemInput = {
      code: asString(row.code, 50),
      name: asString(row.name, 200),
      description: asString(row.description, 500),
      quantity: asNumber(row.quantity),
      rate: round2(asNumber(row.rate)),
      discountPercent: Math.min(100, Math.max(0, asNumber(row.discountPercent))),
      applyGst: row.applyGst !== false,
    };
    if (!item.name) return { error: "Every item needs a name." };
    if (item.rate <= 0) return { error: `Enter a rate for "${item.name}".` };
    if (item.quantity <= 0) return { error: `Enter a quantity for "${item.name}".` };
    lineItems.push(item);
  }

  const documentDate = asString(record.documentDate, 10);
  if (!ISO_DATE_REGEX.test(documentDate)) return { error: "Choose a valid document date." };

  const paymentTermsId =
    typeof record.paymentTermsId === "string" && TERMS_OPTIONS[record.paymentTermsId]
      ? record.paymentTermsId
      : "same_day";

  const gstEnabled = record.gstEnabled === true;
  const gstPricing = record.gstPricing === "inclusive" ? "inclusive" : "exclusive";
  const gstPercentage = 10;
  const discountAud = Math.max(0, round2(asNumber(record.discountAud)));

  const input: SalesDocumentInput = {
    customer,
    address,
    jobTitle,
    jobDescription,
    lineItems,
    discountAud,
    gstEnabled,
    gstPercentage,
    gstPricing,
    documentDate,
    paymentTermsId,
    terms: asString(record.terms, 5000),
    comment: asString(record.comment, 2000),
    send: record.send === true,
  };

  const totals = computeTotals(input);
  if (totals.totalAud <= 0) return { error: "The total must be greater than zero." };

  // GST must be applied before a document can be sent to the customer.
  if (input.send && !input.gstEnabled) {
    return { error: "Apply GST before sending. Tick “Apply GST” to continue." };
  }

  return { input };
}

/**
 * Lenient version of {@link parseSalesDocumentInput} used for live previews:
 * never rejects, fills sensible defaults, so an in-progress draft can be
 * rendered to the exact PDF that will be sent.
 */
export function coercePreviewInput(body: unknown): SalesDocumentInput {
  const record = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;

  const customerRaw = (record.customer ?? {}) as Record<string, unknown>;
  const addressRaw = (record.address ?? {}) as Record<string, unknown>;

  const rawItems = Array.isArray(record.lineItems) ? record.lineItems : [];
  const lineItems: LineItemInput[] = rawItems.map((raw) => {
    const row = (raw ?? {}) as Record<string, unknown>;
    return {
      code: asString(row.code, 50),
      name: asString(row.name, 200),
      description: asString(row.description, 500),
      quantity: asNumber(row.quantity) || 0,
      rate: round2(asNumber(row.rate)),
      discountPercent: Math.min(100, Math.max(0, asNumber(row.discountPercent))),
      applyGst: row.applyGst !== false,
    };
  });

  const documentDate = ISO_DATE_REGEX.test(asString(record.documentDate, 10))
    ? asString(record.documentDate, 10)
    : new Date().toISOString().slice(0, 10);

  const paymentTermsId =
    typeof record.paymentTermsId === "string" && TERMS_OPTIONS[record.paymentTermsId]
      ? record.paymentTermsId
      : "same_day";

  return {
    customer: {
      fullName: asString(customerRaw.fullName, 150),
      email: asString(customerRaw.email, 200).toLowerCase(),
      phone: asString(customerRaw.phone, 40),
    },
    address: {
      street: asString(addressRaw.street, 200),
      suburb: asString(addressRaw.suburb, 100),
      state: asString(addressRaw.state, 50),
      postcode: asString(addressRaw.postcode, 4).replace(/\D/g, ""),
    },
    jobTitle: asString(record.jobTitle, 120),
    jobDescription: asString(record.jobDescription, 1500),
    lineItems,
    discountAud: Math.max(0, round2(asNumber(record.discountAud))),
    gstEnabled: record.gstEnabled === true,
    gstPercentage: 10,
    gstPricing: record.gstPricing === "inclusive" ? "inclusive" : "exclusive",
    documentDate,
    paymentTermsId,
    terms: asString(record.terms, 5000),
    comment: asString(record.comment, 2000),
    send: false,
  };
}

function lineNet(item: LineItemInput): number {
  return round2(item.quantity * item.rate * (1 - item.discountPercent / 100));
}

export function computeTotals(input: SalesDocumentInput): Totals {
  const subtotal = round2(input.lineItems.reduce((sum, item) => sum + lineNet(item), 0));
  const discount = Math.min(input.discountAud, subtotal);

  let gst = 0;
  if (input.gstEnabled) {
    const gstItemsNet = input.lineItems
      .filter((item) => item.applyGst)
      .reduce((sum, item) => sum + lineNet(item), 0);
    const discountRatio = subtotal > 0 ? discount / subtotal : 0;
    const taxable = gstItemsNet * (1 - discountRatio);
    gst =
      input.gstPricing === "inclusive"
        ? round2(taxable - taxable / (1 + input.gstPercentage / 100))
        : round2(taxable * (input.gstPercentage / 100));
  }

  const net = subtotal - discount;
  const total =
    input.gstEnabled && input.gstPricing === "exclusive" ? round2(net + gst) : round2(net);

  return { subtotalAud: subtotal, discountAud: round2(discount), gstAud: gst, totalAud: total };
}

function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(y, m - 1, d + days);
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${mm}-${dd}`;
}

function formatDateHuman(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Date(y, m - 1, d).toLocaleDateString("en-AU", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function formatAud(value: number): string {
  return `AU$ ${value.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Document codes (QUO-0001 / INV-0001 per owner)
// ---------------------------------------------------------------------------

async function allocateDocumentCode(
  db: FirebaseFirestore.Firestore,
  ownerUid: string,
  kind: SalesDocKind
): Promise<string> {
  const config = KIND_CONFIG[kind];
  const counterRef = db.doc(`counters/${ownerUid}`);
  const seq = await db.runTransaction(async (tx) => {
    const snap = await tx.get(counterRef);
    const current = snap.exists ? Number(snap.data()?.[config.counterField]) || 0 : 0;
    const next = current + 1;
    tx.set(counterRef, { [config.counterField]: next }, { merge: true });
    return next;
  });
  return `${config.codePrefix}-${String(seq).padStart(4, "0")}`;
}

// ---------------------------------------------------------------------------
// Firestore mapping
// ---------------------------------------------------------------------------

function toMillis(value: unknown): number | null {
  if (!value) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "object" && value !== null && "toMillis" in value) {
    try {
      return (value as FirebaseFirestore.Timestamp).toMillis();
    } catch {
      return null;
    }
  }
  return null;
}

export function mapSalesDocument(id: string, data: FirebaseFirestore.DocumentData) {
  return {
    id,
    code: (data.code as string) ?? "",
    status: (data.status as string) ?? "draft",
    customer: data.customer ?? { fullName: "", email: "", phone: "" },
    address: data.address ?? { street: "", suburb: "", state: "", postcode: "" },
    jobTitle: (data.jobTitle as string) ?? "",
    jobDescription: (data.jobDescription as string) ?? "",
    lineItems: Array.isArray(data.lineItems) ? data.lineItems : [],
    discountAud: typeof data.discountAud === "number" ? data.discountAud : 0,
    gstEnabled: data.gstEnabled === true,
    gstPercentage: typeof data.gstPercentage === "number" ? data.gstPercentage : 10,
    gstPricing: (data.gstPricing as string) ?? "exclusive",
    subtotalAud: typeof data.subtotalAud === "number" ? data.subtotalAud : 0,
    gstAud: typeof data.gstAud === "number" ? data.gstAud : 0,
    totalAud: typeof data.totalAud === "number" ? data.totalAud : 0,
    documentDate: (data.documentDate as string) ?? "",
    dueDate: (data.dueDate as string) ?? "",
    paymentTermsId: (data.paymentTermsId as string) ?? "same_day",
    terms: (data.terms as string) ?? "",
    comment: (data.comment as string) ?? "",
    customerId: (data.customerId as string | null) ?? null,
    customerAccountCreated: data.customerAccountCreated === true,
    sentAt: toMillis(data.sentAt),
    createdAt: toMillis(data.createdAt),
    updatedAt: toMillis(data.updatedAt),
  };
}

function buildDocPayload(input: SalesDocumentInput, totals: Totals) {
  const termsOption = TERMS_OPTIONS[input.paymentTermsId] ?? TERMS_OPTIONS.same_day;
  return {
    customer: input.customer,
    address: input.address,
    jobTitle: input.jobTitle,
    jobDescription: input.jobDescription,
    lineItems: input.lineItems,
    discountAud: totals.discountAud,
    gstEnabled: input.gstEnabled,
    gstPercentage: input.gstPercentage,
    gstPricing: input.gstPricing,
    subtotalAud: totals.subtotalAud,
    gstAud: totals.gstAud,
    totalAud: totals.totalAud,
    documentDate: input.documentDate,
    dueDate: addDaysIso(input.documentDate, termsOption.days),
    paymentTermsId: input.paymentTermsId,
    paymentTermsLabel: termsOption.label,
    terms: input.terms,
    comment: input.comment,
    updatedAt: FieldValue.serverTimestamp(),
  };
}

// ---------------------------------------------------------------------------
// Customer email
// ---------------------------------------------------------------------------

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function nl2br(value: string): string {
  return escapeHtml(value).replace(/\n/g, "<br />");
}

function buildDocumentEmailHtml(params: {
  kind: SalesDocKind;
  workshopName: string;
  code: string;
  input: SalesDocumentInput;
  totals: Totals;
  dueDate: string;
}): string {
  const { kind, workshopName, code, input, totals, dueDate } = params;
  const config = KIND_CONFIG[kind];

  const addressLine = [
    input.address.street,
    input.address.suburb,
    input.address.state,
    input.address.postcode,
  ]
    .filter(Boolean)
    .join(", ");

  const itemRows = input.lineItems
    .map((item) => {
      const details = [
        item.code ? escapeHtml(item.code) : "",
        item.description ? escapeHtml(item.description) : "",
        item.discountPercent > 0 ? `${item.discountPercent}% discount` : "",
      ]
        .filter(Boolean)
        .join(" · ");
      return `
        <tr>
          <td style="padding: 10px 12px; border-bottom: 1px solid #e5e7eb;">
            <div style="font-weight: 600; color: #111827; font-size: 14px;">${escapeHtml(item.name)}</div>
            ${details ? `<div style="color: #6b7280; font-size: 12px; margin-top: 2px;">${details}</div>` : ""}
          </td>
          <td style="padding: 10px 12px; border-bottom: 1px solid #e5e7eb; text-align: right; color: #374151; font-size: 14px;">${item.quantity}</td>
          <td style="padding: 10px 12px; border-bottom: 1px solid #e5e7eb; text-align: right; color: #374151; font-size: 14px;">${formatAud(item.rate)}</td>
          <td style="padding: 10px 12px; border-bottom: 1px solid #e5e7eb; text-align: right; color: #111827; font-weight: 600; font-size: 14px;">${formatAud(lineNet(item))}</td>
        </tr>`;
    })
    .join("");

  const totalsRows = [
    `<tr><td style="padding: 4px 12px; color: #6b7280; font-size: 14px;">Subtotal</td><td style="padding: 4px 12px; text-align: right; color: #111827; font-size: 14px;">${formatAud(totals.subtotalAud)}</td></tr>`,
    totals.discountAud > 0
      ? `<tr><td style="padding: 4px 12px; color: #6b7280; font-size: 14px;">Discount</td><td style="padding: 4px 12px; text-align: right; color: #111827; font-size: 14px;">−${formatAud(totals.discountAud)}</td></tr>`
      : "",
    input.gstEnabled
      ? `<tr><td style="padding: 4px 12px; color: #6b7280; font-size: 14px;">GST (${input.gstPercentage}%)</td><td style="padding: 4px 12px; text-align: right; color: #111827; font-size: 14px;">${formatAud(totals.gstAud)}</td></tr>`
      : "",
    `<tr><td style="padding: 10px 12px; color: #111827; font-weight: 700; font-size: 16px; border-top: 2px solid #111827;">Total</td><td style="padding: 10px 12px; text-align: right; color: #111827; font-weight: 700; font-size: 16px; border-top: 2px solid #111827;">${formatAud(totals.totalAud)}</td></tr>`,
  ].join("");

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /></head>
<body style="margin: 0; padding: 0; background-color: #f3f4f6; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: #f3f4f6; padding: 24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width: 600px; width: 100%; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
        <tr>
          <td style="background-color: #111827; padding: 28px 32px;">
            <h1 style="margin: 0; color: #ffffff; font-size: 20px; font-weight: 700;">${escapeHtml(workshopName)}</h1>
            <p style="margin: 6px 0 0; color: #fbbf24; font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px;">${config.docLabel} ${escapeHtml(code)}</p>
          </td>
        </tr>
        <tr>
          <td style="padding: 28px 32px;">
            <p style="margin: 0 0 16px; color: #374151; font-size: 14px;">Hi ${escapeHtml(input.customer.fullName)},</p>
            <p style="margin: 0 0 20px; color: #374151; font-size: 14px;">Please find your ${config.docLabel.toLowerCase()} from ${escapeHtml(workshopName)} below.</p>

            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 20px;">
              <tr>
                <td style="vertical-align: top;">
                  <p style="margin: 0; color: #9ca3af; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px;">Bill to</p>
                  <p style="margin: 4px 0 0; color: #111827; font-size: 14px; font-weight: 600;">${escapeHtml(input.customer.fullName)}</p>
                  ${addressLine ? `<p style="margin: 2px 0 0; color: #6b7280; font-size: 12px;">${escapeHtml(addressLine)}</p>` : ""}
                </td>
                <td style="vertical-align: top; text-align: right;">
                  <p style="margin: 0; color: #6b7280; font-size: 12px;">${config.dateLabel}: <strong style="color: #111827;">${formatDateHuman(input.documentDate)}</strong></p>
                  <p style="margin: 4px 0 0; color: #6b7280; font-size: 12px;">${config.dueLabel}: <strong style="color: #111827;">${formatDateHuman(dueDate)}</strong></p>
                </td>
              </tr>
            </table>

            <div style="margin-bottom: 20px; padding: 14px 16px; background-color: #f9fafb; border-radius: 8px; border: 1px solid #e5e7eb;">
              <p style="margin: 0; color: #9ca3af; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px;">Job</p>
              <p style="margin: 4px 0 0; color: #111827; font-size: 14px; font-weight: 600;">${escapeHtml(input.jobTitle)}</p>
              ${input.jobDescription ? `<p style="margin: 4px 0 0; color: #6b7280; font-size: 13px;">${nl2br(input.jobDescription)}</p>` : ""}
            </div>

            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border: 1px solid #e5e7eb; border-radius: 8px; border-collapse: separate; overflow: hidden;">
              <tr style="background-color: #f9fafb;">
                <th style="padding: 10px 12px; text-align: left; color: #6b7280; font-size: 11px; text-transform: uppercase; letter-spacing: 1px;">Item</th>
                <th style="padding: 10px 12px; text-align: right; color: #6b7280; font-size: 11px; text-transform: uppercase; letter-spacing: 1px;">Qty</th>
                <th style="padding: 10px 12px; text-align: right; color: #6b7280; font-size: 11px; text-transform: uppercase; letter-spacing: 1px;">Rate</th>
                <th style="padding: 10px 12px; text-align: right; color: #6b7280; font-size: 11px; text-transform: uppercase; letter-spacing: 1px;">Amount</th>
              </tr>
              ${itemRows}
            </table>

            <table role="presentation" cellpadding="0" cellspacing="0" style="margin: 16px 0 0 auto; min-width: 260px;">
              ${totalsRows}
            </table>

            ${
              input.comment
                ? `<div style="margin-top: 24px;"><p style="margin: 0; color: #9ca3af; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px;">Notes</p><p style="margin: 6px 0 0; color: #374151; font-size: 13px;">${nl2br(input.comment)}</p></div>`
                : ""
            }
            ${
              input.terms
                ? `<div style="margin-top: 16px;"><p style="margin: 0; color: #9ca3af; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px;">Terms &amp; conditions</p><p style="margin: 6px 0 0; color: #6b7280; font-size: 12px;">${nl2br(input.terms)}</p></div>`
                : ""
            }
          </td>
        </tr>
        <tr>
          <td style="padding: 20px 32px; background-color: #f9fafb; border-top: 1px solid #e5e7eb;">
            <p style="margin: 0; color: #6b7280; font-size: 12px;">If you have any questions about this ${config.docLabel.toLowerCase()}, simply reply to this email.</p>
            <p style="margin: 8px 0 0; color: #9ca3af; font-size: 11px;">${escapeHtml(workshopName)} — powered by BMS PRO</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Send flow: booking-engine account + document email
// ---------------------------------------------------------------------------

type SendOutcome = {
  customerId: string | null;
  customerAccountCreated: boolean;
  emailSent: boolean;
  emailError: string | null;
};

async function sendDocumentToCustomer(params: {
  db: FirebaseFirestore.Firestore;
  ownerUid: string;
  kind: SalesDocKind;
  code: string;
  input: SalesDocumentInput;
  totals: Totals;
  dueDate: string;
}): Promise<SendOutcome> {
  const { db, ownerUid, kind, code, input, totals, dueDate } = params;
  const config = KIND_CONFIG[kind];

  let workshopName = "Workshop";
  let bookingEngineUrl = "";
  let ownerEmail = "";
  let ownerPhone = "";
  try {
    const ownerDoc = await db.doc(`users/${ownerUid}`).get();
    const ownerData = ownerDoc.exists ? ownerDoc.data() || {} : {};
    workshopName =
      (ownerData.workshopName as string) ||
      (ownerData.salonName as string) ||
      (ownerData.name as string) ||
      (ownerData.businessName as string) ||
      (ownerData.displayName as string) ||
      "Workshop";
    ownerEmail = typeof ownerData.email === "string" ? ownerData.email.trim() : "";
    ownerPhone = typeof ownerData.phone === "string" ? ownerData.phone.trim() : "";
    bookingEngineUrl = resolveBookingEngineUrl(ownerData);
  } catch (error) {
    console.warn(`[${config.collection}] Could not load owner profile for ${ownerUid}:`, error);
  }

  // 1. Ensure the customer has a booking-engine account (creates one with the
  //    default password when this is a brand-new customer for this workshop).
  let customerId: string | null = null;
  let customerAccountCreated = false;
  try {
    const account = await ensureCustomerAccount(db, {
      ownerUid,
      email: input.customer.email,
      name: input.customer.fullName,
      phone: input.customer.phone,
    });
    if (account) {
      customerId = account.customerId;
      customerAccountCreated = account.created;
      if (account.created && account.defaultPassword) {
        const welcome = await sendCustomerWelcomeEmail({
          customerEmail: account.email,
          customerPhone: input.customer.phone,
          password: account.defaultPassword,
          customerName: input.customer.fullName,
          workshopName,
          bookingEngineUrl,
        });
        if (!welcome.success) {
          console.error(
            `[${config.collection}] Welcome email failed for new customer ${account.email}:`,
            welcome.error
          );
        }
      }
    }
  } catch (error) {
    console.error(`[${config.collection}] Customer account provisioning failed:`, error);
  }

  // 2. Build the PDF (matches the platform's booking PDF styling) and attach it.
  const termsOption = TERMS_OPTIONS[input.paymentTermsId] ?? TERMS_OPTIONS.same_day;
  const pdfInput: SalesDocPdfInput = {
    kind,
    code,
    status: "sent",
    business: { name: workshopName, email: ownerEmail || null, phone: ownerPhone || null },
    customer: input.customer,
    address: input.address,
    jobTitle: input.jobTitle,
    jobDescription: input.jobDescription,
    lineItems: input.lineItems,
    discountAud: totals.discountAud,
    gstEnabled: input.gstEnabled,
    gstPercentage: input.gstPercentage,
    gstPricing: input.gstPricing,
    subtotalAud: totals.subtotalAud,
    gstAud: totals.gstAud,
    totalAud: totals.totalAud,
    documentDate: input.documentDate,
    dueDate,
    paymentTermsLabel: termsOption.label,
    terms: input.terms,
    comment: input.comment,
  };

  let attachments: { content: string; mimeType: string; name: string }[] | undefined;
  try {
    const pdf = await generateSalesDocumentPdf(pdfInput);
    attachments = [
      {
        content: pdf.buffer.toString("base64"),
        mimeType: "application/pdf",
        name: pdf.filename,
      },
    ];
  } catch (error) {
    // Non-fatal: still send the HTML email even if the PDF could not be rendered
    // (e.g. Chromium missing in this environment).
    console.error(`[${config.collection}] PDF generation failed for ${code}:`, error);
  }

  // 3. Email the document itself, with the PDF attached.
  const html = buildDocumentEmailHtml({ kind, workshopName, code, input, totals, dueDate });
  const emailResult = await sendEmail({
    sender: "request",
    to: input.customer.email,
    toName: input.customer.fullName,
    subject: `${config.docLabel} ${code} from ${workshopName}`,
    htmlBody: html,
    replyTo: ownerEmail || null,
    attachments,
  });

  return {
    customerId,
    customerAccountCreated,
    emailSent: emailResult.ok,
    emailError: emailResult.ok ? null : emailResult.message,
  };
}

// ---------------------------------------------------------------------------
// Route handlers (shared by /api/quotations and /api/invoices)
// ---------------------------------------------------------------------------

function jsonError(message: string, status: number) {
  return NextResponse.json({ ok: false, error: message }, { status });
}

export async function handleListSalesDocuments(req: NextRequest, kind: SalesDocKind) {
  const auth = await verifyAdminAuth(req, READ_ROLES);
  if (!auth.success || !auth.userData) {
    return jsonError(auth.error || "Unauthorized", auth.status || 401);
  }

  const config = KIND_CONFIG[kind];
  try {
    const snap = await adminDb()
      .collection(config.collection)
      .where("ownerUid", "==", auth.userData.ownerUid)
      .get();

    const documents = snap.docs
      .map((doc) => mapSalesDocument(doc.id, doc.data()))
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));

    return NextResponse.json({ ok: true, documents });
  } catch (error) {
    console.error(`[${config.collection} GET] Error:`, error);
    return jsonError(`Could not load ${config.collection}.`, 500);
  }
}

export async function handleGetSalesDocument(
  req: NextRequest,
  kind: SalesDocKind,
  id: string
) {
  const auth = await verifyAdminAuth(req, READ_ROLES);
  if (!auth.success || !auth.userData) {
    return jsonError(auth.error || "Unauthorized", auth.status || 401);
  }

  const config = KIND_CONFIG[kind];
  try {
    const snap = await adminDb().collection(config.collection).doc(id).get();
    if (!snap.exists || snap.data()?.ownerUid !== auth.userData.ownerUid) {
      return jsonError(`${config.docLabel} not found.`, 404);
    }
    return NextResponse.json({ ok: true, document: mapSalesDocument(snap.id, snap.data()!) });
  } catch (error) {
    console.error(`[${config.collection} GET one] Error:`, error);
    return jsonError(`Could not load the ${config.docLabel.toLowerCase()}.`, 500);
  }
}

export async function handleCreateSalesDocument(req: NextRequest, kind: SalesDocKind) {
  const auth = await verifyAdminAuth(req, WRITE_ROLES);
  if (!auth.success || !auth.userData) {
    return jsonError(auth.error || "Unauthorized", auth.status || 401);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError("Invalid request body.", 400);
  }

  const parsed = parseSalesDocumentInput(body);
  if ("error" in parsed) return jsonError(parsed.error, 400);

  const config = KIND_CONFIG[kind];
  const { input } = parsed;
  const totals = computeTotals(input);
  const db = adminDb();
  const ownerUid = auth.userData.ownerUid;

  try {
    const code = await allocateDocumentCode(db, ownerUid, kind);
    const payload = buildDocPayload(input, totals);

    const ref = db.collection(config.collection).doc();
    await ref.set({
      ...payload,
      ownerUid,
      code,
      status: "draft",
      customerId: null,
      customerAccountCreated: false,
      sentAt: null,
      createdAt: FieldValue.serverTimestamp(),
      createdByUid: auth.userData.uid,
      createdByName: auth.userData.name || auth.userData.email,
    });

    let outcome: SendOutcome | null = null;
    if (input.send) {
      outcome = await sendDocumentToCustomer({
        db,
        ownerUid,
        kind,
        code,
        input,
        totals,
        dueDate: payload.dueDate,
      });
      await ref.set(
        {
          status: outcome.emailSent ? "sent" : "draft",
          sentAt: outcome.emailSent ? FieldValue.serverTimestamp() : null,
          customerId: outcome.customerId,
          customerAccountCreated: outcome.customerAccountCreated,
          lastEmailError: outcome.emailError,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      if (!outcome.emailSent) {
        return NextResponse.json(
          {
            ok: false,
            error: `The ${config.docLabel.toLowerCase()} was saved as a draft, but the email could not be sent: ${outcome.emailError}`,
            documentId: ref.id,
          },
          { status: 502 }
        );
      }
    }

    const fresh = await ref.get();
    return NextResponse.json(
      {
        ok: true,
        document: mapSalesDocument(ref.id, fresh.data()!),
        emailSent: outcome?.emailSent ?? false,
        customerAccountCreated: outcome?.customerAccountCreated ?? false,
      },
      { status: 201 }
    );
  } catch (error) {
    console.error(`[${config.collection} POST] Error:`, error);
    return jsonError(`Could not save the ${config.docLabel.toLowerCase()}.`, 500);
  }
}

export async function handleUpdateSalesDocument(
  req: NextRequest,
  kind: SalesDocKind,
  id: string
) {
  const auth = await verifyAdminAuth(req, WRITE_ROLES);
  if (!auth.success || !auth.userData) {
    return jsonError(auth.error || "Unauthorized", auth.status || 401);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError("Invalid request body.", 400);
  }

  const parsed = parseSalesDocumentInput(body);
  if ("error" in parsed) return jsonError(parsed.error, 400);

  const config = KIND_CONFIG[kind];
  const { input } = parsed;
  const totals = computeTotals(input);
  const db = adminDb();
  const ownerUid = auth.userData.ownerUid;

  try {
    const ref = db.collection(config.collection).doc(id);
    const snap = await ref.get();
    if (!snap.exists || snap.data()?.ownerUid !== ownerUid) {
      return jsonError(`${config.docLabel} not found.`, 404);
    }

    const code = (snap.data()?.code as string) || (await allocateDocumentCode(db, ownerUid, kind));
    const payload = buildDocPayload(input, totals);
    await ref.set({ ...payload, code }, { merge: true });

    let outcome: SendOutcome | null = null;
    if (input.send) {
      outcome = await sendDocumentToCustomer({
        db,
        ownerUid,
        kind,
        code,
        input,
        totals,
        dueDate: payload.dueDate,
      });
      await ref.set(
        {
          status: outcome.emailSent ? "sent" : snap.data()?.status || "draft",
          ...(outcome.emailSent ? { sentAt: FieldValue.serverTimestamp() } : {}),
          customerId: outcome.customerId,
          customerAccountCreated:
            outcome.customerAccountCreated || snap.data()?.customerAccountCreated === true,
          lastEmailError: outcome.emailError,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      if (!outcome.emailSent) {
        return NextResponse.json(
          {
            ok: false,
            error: `Changes were saved, but the email could not be sent: ${outcome.emailError}`,
            documentId: ref.id,
          },
          { status: 502 }
        );
      }
    }

    const fresh = await ref.get();
    return NextResponse.json({
      ok: true,
      document: mapSalesDocument(ref.id, fresh.data()!),
      emailSent: outcome?.emailSent ?? false,
      customerAccountCreated: outcome?.customerAccountCreated ?? false,
    });
  } catch (error) {
    console.error(`[${config.collection} PATCH] Error:`, error);
    return jsonError(`Could not update the ${config.docLabel.toLowerCase()}.`, 500);
  }
}

async function loadBusinessInfo(
  db: FirebaseFirestore.Firestore,
  ownerUid: string
): Promise<{ name: string; email: string | null; phone: string | null }> {
  try {
    const ownerDoc = await db.doc(`users/${ownerUid}`).get();
    const ownerData = ownerDoc.exists ? ownerDoc.data() || {} : {};
    return {
      name:
        (ownerData.workshopName as string) ||
        (ownerData.salonName as string) ||
        (ownerData.name as string) ||
        (ownerData.businessName as string) ||
        (ownerData.displayName as string) ||
        "Workshop",
      email: typeof ownerData.email === "string" ? ownerData.email.trim() : null,
      phone: typeof ownerData.phone === "string" ? ownerData.phone.trim() : null,
    };
  } catch {
    return { name: "Workshop", email: null, phone: null };
  }
}

export async function handleSalesDocumentPreviewPdf(req: NextRequest, kind: SalesDocKind) {
  const auth = await verifyAdminAuth(req, READ_ROLES);
  if (!auth.success || !auth.userData) {
    return jsonError(auth.error || "Unauthorized", auth.status || 401);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const config = KIND_CONFIG[kind];
  try {
    const db = adminDb();
    const input = coercePreviewInput(body);
    const totals = computeTotals(input);
    const business = await loadBusinessInfo(db, auth.userData.ownerUid);
    const termsOption = TERMS_OPTIONS[input.paymentTermsId] ?? TERMS_OPTIONS.same_day;

    const pdfInput: SalesDocPdfInput = {
      kind,
      code: "DRAFT",
      status: "draft",
      business,
      customer: input.customer,
      address: input.address,
      jobTitle: input.jobTitle,
      jobDescription: input.jobDescription,
      lineItems: input.lineItems,
      discountAud: totals.discountAud,
      gstEnabled: input.gstEnabled,
      gstPercentage: input.gstPercentage,
      gstPricing: input.gstPricing,
      subtotalAud: totals.subtotalAud,
      gstAud: totals.gstAud,
      totalAud: totals.totalAud,
      documentDate: input.documentDate,
      dueDate: addDaysIso(input.documentDate, termsOption.days),
      paymentTermsLabel: termsOption.label,
      terms: input.terms,
      comment: input.comment,
    };

    const pdf = await generateSalesDocumentPdf(pdfInput);
    return new NextResponse(new Uint8Array(pdf.buffer), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${pdf.filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error(`[${config.collection} preview PDF] Error:`, error);
    return jsonError(`Could not generate the ${config.docLabel.toLowerCase()} preview.`, 500);
  }
}

export async function handleSalesDocumentPdf(
  req: NextRequest,
  kind: SalesDocKind,
  id: string
) {
  const auth = await verifyAdminAuth(req, READ_ROLES);
  if (!auth.success || !auth.userData) {
    return jsonError(auth.error || "Unauthorized", auth.status || 401);
  }

  const config = KIND_CONFIG[kind];
  try {
    const db = adminDb();
    const snap = await db.collection(config.collection).doc(id).get();
    if (!snap.exists || snap.data()?.ownerUid !== auth.userData.ownerUid) {
      return jsonError(`${config.docLabel} not found.`, 404);
    }

    const doc = mapSalesDocument(snap.id, snap.data()!);
    const business = await loadBusinessInfo(db, auth.userData.ownerUid);

    const pdfInput: SalesDocPdfInput = {
      kind,
      code: doc.code,
      status: doc.status,
      business,
      customer: {
        fullName: doc.customer?.fullName ?? "",
        email: doc.customer?.email ?? "",
        phone: doc.customer?.phone ?? "",
      },
      address: {
        street: doc.address?.street ?? "",
        suburb: doc.address?.suburb ?? "",
        state: doc.address?.state ?? "",
        postcode: doc.address?.postcode ?? "",
      },
      jobTitle: doc.jobTitle,
      jobDescription: doc.jobDescription,
      lineItems: (doc.lineItems as SalesDocPdfInput["lineItems"]).map((item) => ({
        code: item.code ?? "",
        name: item.name ?? "",
        description: item.description ?? "",
        quantity: Number(item.quantity) || 0,
        rate: Number(item.rate) || 0,
        discountPercent: Number(item.discountPercent) || 0,
        applyGst: item.applyGst !== false,
      })),
      discountAud: doc.discountAud,
      gstEnabled: doc.gstEnabled,
      gstPercentage: doc.gstPercentage,
      gstPricing: doc.gstPricing === "inclusive" ? "inclusive" : "exclusive",
      subtotalAud: doc.subtotalAud,
      gstAud: doc.gstAud,
      totalAud: doc.totalAud,
      documentDate: doc.documentDate,
      dueDate: doc.dueDate,
      paymentTermsLabel:
        (snap.data()?.paymentTermsLabel as string) ||
        TERMS_OPTIONS[doc.paymentTermsId]?.label ||
        "Same day",
      terms: doc.terms,
      comment: doc.comment,
    };

    const pdf = await generateSalesDocumentPdf(pdfInput);

    return new NextResponse(new Uint8Array(pdf.buffer), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${pdf.filename}"`,
        "Cache-Control": "private, max-age=30",
      },
    });
  } catch (error) {
    console.error(`[${config.collection} PDF] Error:`, error);
    return jsonError(`Could not generate the ${config.docLabel.toLowerCase()} PDF.`, 500);
  }
}

export async function handleDeleteSalesDocument(
  req: NextRequest,
  kind: SalesDocKind,
  id: string
) {
  const auth = await verifyAdminAuth(req, WRITE_ROLES);
  if (!auth.success || !auth.userData) {
    return jsonError(auth.error || "Unauthorized", auth.status || 401);
  }

  const config = KIND_CONFIG[kind];
  try {
    const ref = adminDb().collection(config.collection).doc(id);
    const snap = await ref.get();
    if (!snap.exists || snap.data()?.ownerUid !== auth.userData.ownerUid) {
      return jsonError(`${config.docLabel} not found.`, 404);
    }
    await ref.delete();
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error(`[${config.collection} DELETE] Error:`, error);
    return jsonError(`Could not delete the ${config.docLabel.toLowerCase()}.`, 500);
  }
}
