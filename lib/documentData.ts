/**
 * Shared view-model for quotation / invoice HTML preview and pdf-lib PDF generation.
 * Keep this module client-safe (no server-only imports).
 */

export type DocumentKind = "quotation" | "invoice";

/** Alias used in some call sites / docs ("quote" === quotation). */
export type DocumentKindAlias = DocumentKind | "quote";

export type DocumentLineItem = {
  code: string;
  name: string;
  description: string;
  quantity: number;
  rate: number;
  discountPercent: number;
  applyGst: boolean;
};

export type DocumentData = {
  kind: DocumentKind;
  code: string;
  status: string;
  business: {
    name: string;
    email?: string | null;
    phone?: string | null;
    address?: string | null;
  };
  customer: { fullName: string; email: string; phone: string };
  address: { street: string; suburb: string; state: string; postcode: string };
  jobTitle: string;
  jobDescription: string;
  lineItems: DocumentLineItem[];
  discountAud: number;
  gstEnabled: boolean;
  gstPercentage: number;
  gstPricing: "exclusive" | "inclusive";
  subtotalAud: number;
  gstAud: number;
  totalAud: number;
  /** Quotation deposit request (display-only). */
  depositRequested?: boolean;
  depositMode?: "value" | "percent";
  depositValue?: number;
  depositAud?: number;
  balanceAud?: number;
  depositDueDate?: string;
  /** Invoice recorded payment (display-only). */
  paymentRecorded?: boolean;
  amountPaidAud?: number;
  balanceDueAud?: number;
  /** ISO date when the remaining balance is due (invoice-only). */
  balanceDueDate?: string;
  documentDate: string;
  dueDate: string;
  paymentTermsLabel: string;
  terms: string;
  comment: string;
};

export type DocumentKindMeta = {
  docLabel: string;
  dateLabel: string;
  dueLabel: string;
  totalLabel: string;
  tagline: string;
  accent: string;
  accentLt: string;
  accentBorder: string;
  gradientMid: string;
};

export const DOCUMENT_KIND_META: Record<DocumentKind, DocumentKindMeta> = {
  quotation: {
    docLabel: "Quotation",
    dateLabel: "Quote Date",
    dueLabel: "Valid Until",
    totalLabel: "Total Estimate",
    tagline: "Quotation · BMS Pro",
    accent: "#1a6b4a",
    accentLt: "#e8f5ee",
    accentBorder: "#a7dfbf",
    gradientMid: "#34d399",
  },
  invoice: {
    docLabel: "Invoice",
    dateLabel: "Invoice Date",
    dueLabel: "Due Date",
    totalLabel: "Total Due",
    tagline: "Tax Invoice · BMS Pro",
    accent: "#2563a8",
    accentLt: "#e8f0fa",
    accentBorder: "#a9c6e8",
    gradientMid: "#5b9bd5",
  },
};

export function normalizeDocumentKind(kind: DocumentKindAlias): DocumentKind {
  return kind === "quote" ? "quotation" : kind;
}

export function formatDocumentAud(value: number): string {
  return `AU$ ${(value ?? 0).toFixed(2)}`;
}

export function formatDocumentDateHuman(iso: string): string {
  const [y, m, d] = (iso || "").split("-").map(Number);
  if (!y || !m || !d) return iso || "—";
  return new Date(y, m - 1, d).toLocaleDateString("en-AU", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export function documentLineNet(item: DocumentLineItem): number {
  return Math.round(item.quantity * item.rate * (1 - item.discountPercent / 100) * 100) / 100;
}

export function documentLineDiscountAud(item: DocumentLineItem): number {
  return Math.round(item.quantity * item.rate * (item.discountPercent / 100) * 100) / 100;
}

export function documentAddressLine(address: DocumentData["address"]): string {
  return [address.street, address.suburb, address.state, address.postcode]
    .filter(Boolean)
    .join(", ");
}

export function documentBusinessContact(business: DocumentData["business"]): string {
  return [business.email, business.phone, business.address].filter(Boolean).join("  ·  ");
}

export function documentGstTaxableBase(data: DocumentData): number {
  const gstItemsNet = data.lineItems
    .filter((item) => item.applyGst)
    .reduce((sum, item) => sum + documentLineNet(item), 0);
  const discountRatio = data.subtotalAud > 0 ? data.discountAud / data.subtotalAud : 0;
  return Math.round(gstItemsNet * (1 - discountRatio) * 100) / 100;
}

export function salesDocumentPdfFilename(kind: DocumentKindAlias, code: string): string {
  const normalized = normalizeDocumentKind(kind);
  const safeCode = (code || DOCUMENT_KIND_META[normalized].docLabel).replace(
    /[^a-zA-Z0-9-_]/g,
    "-"
  );
  return `${DOCUMENT_KIND_META[normalized].docLabel}-${safeCode}.pdf`;
}
