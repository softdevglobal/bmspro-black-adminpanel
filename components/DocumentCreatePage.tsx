"use client";

import Link from "next/link";
import Sidebar from "@/components/Sidebar";
import DocumentPreview from "@/components/documents/DocumentPreview";
import SalesDocumentPdfViewer from "@/components/documents/SalesDocumentPdfViewer";
import type { DocumentData } from "@/lib/documentData";
import { printDocumentPreview } from "@/lib/printDocumentPreview";
import { useRouter, useSearchParams } from "next/navigation";
import { onAuthStateChanged } from "firebase/auth";
import React, { useEffect, useMemo, useRef, useState } from "react";

type Variant = "quotation" | "invoice";
type Tab = "create" | "preview" | "send";
type TermsId = "same_day" | "net_7" | "net_14" | "net_30";
type GstPricing = "exclusive" | "inclusive";

type LineItem = {
  id: string;
  code: string;
  name: string;
  description: string;
  quantity: number;
  rate: number;
  discountPercent: number;
  applyGst: boolean;
};

type DraftLineItem = {
  code: string;
  name: string;
  description: string;
  quantity: string;
  rate: string;
  discountPercent: string;
  applyGst: boolean;
};

type CatalogItem = {
  id: string;
  name: string;
  code: string | null;
  description: string | null;
  priceAud: number;
};

type CustomerOption = {
  id: string;
  name: string;
  email: string;
  phone: string;
  address: {
    street: string;
    suburb: string;
    state: string;
    postcode: string;
  } | null;
};

type Address = {
  street: string;
  suburb: string;
  state: string;
  postcode: string;
};

type VariantConfig = {
  pageTitle: string;
  heroSubtitle: string;
  heroIcon: string;
  dateLabel: string;
  dueLabel: string;
  docLabel: string;
  saveDraftLabel: string;
  sendLabel: string;
  listHref: string;
  apiBase: string;
  emailSubject: (business: string) => string;
};

const VARIANT_CONFIG: Record<Variant, VariantConfig> = {
  quotation: {
    pageTitle: "Create a quotation",
    heroSubtitle: "Build a quote, preview the document, and send it to your customer.",
    heroIcon: "fa-file-lines",
    dateLabel: "Quote date",
    dueLabel: "Valid until",
    docLabel: "Quotation",
    saveDraftLabel: "Save draft",
    sendLabel: "Save & send quotation",
    listHref: "/quotations",
    apiBase: "/api/quotations",
    emailSubject: (business) => `Quotation from ${business}`,
  },
  invoice: {
    pageTitle: "Create an invoice",
    heroSubtitle: "Build an invoice, preview the document, and send it to your customer.",
    heroIcon: "fa-file-invoice-dollar",
    dateLabel: "Invoice date",
    dueLabel: "Due date",
    docLabel: "Invoice",
    saveDraftLabel: "Save draft",
    sendLabel: "Save & send invoice",
    listHref: "/invoices",
    apiBase: "/api/invoices",
    emailSubject: (business) => `Invoice from ${business}`,
  },
};

type SavedLineItem = {
  code?: string;
  name?: string;
  description?: string;
  quantity?: number;
  rate?: number;
  discountPercent?: number;
  applyGst?: boolean;
};

type SavedDocument = {
  id: string;
  code: string;
  status: string;
  customer?: { fullName?: string; email?: string; phone?: string };
  address?: { street?: string; suburb?: string; state?: string; postcode?: string };
  jobTitle?: string;
  jobDescription?: string;
  lineItems?: SavedLineItem[];
  discountAud?: number;
  gstEnabled?: boolean;
  gstPricing?: string;
  documentDate?: string;
  dueDate?: string;
  paymentTermsId?: string;
  terms?: string;
  comment?: string;
  depositRequested?: boolean;
  depositMode?: "value" | "percent";
  depositValue?: number;
  depositAud?: number;
  balanceAud?: number;
  depositDueDate?: string;
  paymentRecorded?: boolean;
  amountPaidAud?: number;
  balanceDueAud?: number;
  balanceDueDate?: string;
  quotationId?: string | null;
  quotationCode?: string | null;
  invoiceId?: string | null;
  invoiceCode?: string | null;
};

type QuotationOption = {
  id: string;
  code: string;
  status: string;
  customer?: { fullName?: string; email?: string };
  jobTitle?: string;
  documentDate?: string;
  totalAud?: number;
};

const TERMS_OPTIONS: { id: TermsId; days: number; label: string }[] = [
  { id: "same_day", days: 0, label: "Same day" },
  { id: "net_7", days: 7, label: "7 days" },
  { id: "net_14", days: 14, label: "14 days" },
  { id: "net_30", days: 30, label: "30 days" },
];

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const INPUT_CLASS =
  "w-full px-4 py-2.5 border border-neutral-300 rounded-lg text-sm text-neutral-900 placeholder:text-neutral-400 focus:ring-2 focus:ring-neutral-900 focus:border-transparent outline-none";
const NUMBER_INPUT_CLASS = `${INPUT_CLASS} [appearance:textfield] [-moz-appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none`;
const LABEL_CLASS = "block text-xs font-semibold uppercase tracking-wider text-neutral-500 mb-1.5";

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString("en-AU", { day: "2-digit", month: "short", year: "numeric" });
}

function formatAud(value: number): string {
  return `AU$ ${value.toFixed(2)}`;
}

function parseNum(value: string): number {
  const n = Number.parseFloat((value || "").replace(/[^\d.]/g, ""));
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** Local AU digits for the +61 input (strips country code / leading zeros). */
function toAuLocalPhone(value: string): string {
  let digits = value.replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("0061")) digits = digits.slice(4);
  else if (digits.startsWith("61") && digits.length >= 10) digits = digits.slice(2);
  while (digits.startsWith("0")) digits = digits.slice(1);
  return digits;
}

function toAuE164Phone(localOrFull: string): string {
  const local = toAuLocalPhone(localOrFull);
  return local ? `+61${local}` : "";
}

function computeLineNet(item: Pick<LineItem, "quantity" | "rate" | "discountPercent">): number {
  const base = item.quantity * item.rate * (1 - item.discountPercent / 100);
  return Math.round(base * 100) / 100;
}

export default function DocumentCreatePage({ variant }: { variant: Variant }) {
  const config = VARIANT_CONFIG[variant];
  const router = useRouter();
  const searchParams = useSearchParams();
  const editingDocId = searchParams.get("id");
  const fromQuotationParam = searchParams.get("fromQuotation");
  const pickQuotationParam = searchParams.get("pickQuotation");

  const [mobileOpen, setMobileOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("create");
  const [error, setError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState<false | "draft" | "send">(false);
  const [docCode, setDocCode] = useState<string | null>(null);
  const [docStatus, setDocStatus] = useState<string>("draft");
  const [docId, setDocId] = useState<string | null>(editingDocId);
  const [linkedInvoiceId, setLinkedInvoiceId] = useState<string | null>(null);
  const [linkedInvoiceCode, setLinkedInvoiceCode] = useState<string | null>(null);
  const [linkedQuotationId, setLinkedQuotationId] = useState<string | null>(null);
  const [linkedQuotationCode, setLinkedQuotationCode] = useState<string | null>(null);
  const [issuingInvoice, setIssuingInvoice] = useState(false);
  const [quotationPickerOpen, setQuotationPickerOpen] = useState(false);
  const [quotationOptions, setQuotationOptions] = useState<QuotationOption[]>([]);
  const [quotationSearch, setQuotationSearch] = useState("");
  const [quotationLoading, setQuotationLoading] = useState(false);
  const [importingQuotation, setImportingQuotation] = useState(false);
  const [downloadingPdf, setDownloadingPdf] = useState(false);
  const [pdfViewerOpen, setPdfViewerOpen] = useState(false);
  const [pdfAuthHeaders, setPdfAuthHeaders] = useState<HeadersInit | undefined>();
  const [livePdfBytes, setLivePdfBytes] = useState<Uint8Array | null>(null);

  const [clientOpen, setClientOpen] = useState(true);
  const [customer, setCustomer] = useState({ fullName: "", email: "", phone: "" });
  const [address, setAddress] = useState<Address>({ street: "", suburb: "", state: "", postcode: "" });
  const [customerSearch, setCustomerSearch] = useState("");
  const [customerOptions, setCustomerOptions] = useState<CustomerOption[]>([]);
  const [customerSearchOpen, setCustomerSearchOpen] = useState(false);
  const [customerSearchLoading, setCustomerSearchLoading] = useState(false);
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(null);
  const customerSearchRef = useRef<HTMLDivElement>(null);

  const [jobTitle, setJobTitle] = useState("");
  const [jobDescription, setJobDescription] = useState("");

  const [lineItems, setLineItems] = useState<LineItem[]>([]);
  const [itemDraft, setItemDraft] = useState<DraftLineItem | null>(null);
  const [editingItemId, setEditingItemId] = useState<string | null>(null);

  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [catalogField, setCatalogField] = useState<"code" | "name" | null>(null);

  const [attachments, setAttachments] = useState<{ name: string; url: string; isPdf: boolean }[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [terms, setTerms] = useState("");
  const [comment, setComment] = useState("");

  const [documentDate, setDocumentDate] = useState(todayIso());
  const [paymentTerms, setPaymentTerms] = useState<TermsId>("same_day");
  const [discountAud, setDiscountAud] = useState(0);
  const [discountMode, setDiscountMode] = useState<"value" | "percent">("value");
  const [discountPercentBill, setDiscountPercentBill] = useState(0);
  const [gstEnabled, setGstEnabled] = useState(true);
  const [gstPercentage] = useState(10);
  const [gstPricing, setGstPricing] = useState<GstPricing>("exclusive");
  const [depositRequested, setDepositRequested] = useState(false);
  const [depositMode, setDepositMode] = useState<"value" | "percent">("percent");
  const [depositValue, setDepositValue] = useState(0);
  const [depositDueDate, setDepositDueDate] = useState(todayIso());
  const [paymentRecorded, setPaymentRecorded] = useState(false);
  const [amountPaidInput, setAmountPaidInput] = useState(0);
  const [balanceDueDate, setBalanceDueDate] = useState(todayIso());

  const [businessName, setBusinessName] = useState("Your business");
  const [businessEmail, setBusinessEmail] = useState<string | null>(null);
  const [businessPhone, setBusinessPhone] = useState<string | null>(null);

  function applySavedDocument(
    doc: SavedDocument,
    options?: { importAsInvoice?: boolean },
  ) {
    const importAsInvoice = options?.importAsInvoice === true;

    if (!importAsInvoice) {
      setDocCode(doc.code || null);
      setDocStatus(doc.status || "draft");
      if (doc.id) setDocId(doc.id);
    } else {
      setDocCode(null);
      setDocStatus("draft");
      setDocId(null);
      setDocumentDate(todayIso());
    }

    setCustomer({
      fullName: doc.customer?.fullName ?? "",
      email: doc.customer?.email ?? "",
      phone: toAuLocalPhone(doc.customer?.phone ?? ""),
    });
    setAddress({
      street: doc.address?.street ?? "",
      suburb: doc.address?.suburb ?? "",
      state: doc.address?.state ?? "",
      postcode: doc.address?.postcode ?? "",
    });
    setClientOpen(true);
    setJobTitle(doc.jobTitle ?? "");
    setJobDescription(doc.jobDescription ?? "");
    setLineItems(
      (doc.lineItems ?? []).map((item) => ({
        id: crypto.randomUUID?.() ?? `${Math.random()}`,
        code: item.code ?? "",
        name: item.name ?? "",
        description: item.description ?? "",
        quantity: item.quantity ?? 1,
        rate: item.rate ?? 0,
        discountPercent: item.discountPercent ?? 0,
        applyGst: item.applyGst !== false,
      })),
    );
    setDiscountAud(doc.discountAud ?? 0);
    setGstEnabled(doc.gstEnabled === true);
    setGstPricing(doc.gstPricing === "inclusive" ? "inclusive" : "exclusive");
    if (!importAsInvoice && doc.documentDate) setDocumentDate(doc.documentDate);
    const termsId = TERMS_OPTIONS.find((t) => t.id === doc.paymentTermsId)?.id;
    if (termsId) setPaymentTerms(termsId);
    setTerms(doc.terms ?? "");
    setComment(doc.comment ?? "");

    if (variant === "quotation" && !importAsInvoice) {
      setDepositRequested(doc.depositRequested === true);
      setDepositMode(doc.depositMode === "value" ? "value" : "percent");
      setDepositValue(
        typeof doc.depositValue === "number"
          ? doc.depositValue
          : typeof doc.depositAud === "number"
            ? doc.depositAud
            : 0,
      );
      setDepositDueDate(
        doc.depositDueDate && /^\d{4}-\d{2}-\d{2}$/.test(doc.depositDueDate)
          ? doc.depositDueDate
          : doc.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(doc.dueDate)
            ? doc.dueDate
            : todayIso(),
      );
      setPaymentRecorded(false);
      setAmountPaidInput(0);
      setBalanceDueDate(todayIso());
      setLinkedInvoiceId(doc.invoiceId ?? null);
      setLinkedInvoiceCode(doc.invoiceCode ?? null);
      setLinkedQuotationId(null);
      setLinkedQuotationCode(null);
    } else {
      setDepositRequested(false);
      setDepositValue(0);
      setDepositDueDate(todayIso());
      if (variant === "invoice" && !importAsInvoice) {
        setPaymentRecorded(doc.paymentRecorded === true);
        setAmountPaidInput(
          typeof doc.amountPaidAud === "number" ? doc.amountPaidAud : 0,
        );
        setBalanceDueDate(
          doc.balanceDueDate && /^\d{4}-\d{2}-\d{2}$/.test(doc.balanceDueDate)
            ? doc.balanceDueDate
            : doc.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(doc.dueDate)
              ? doc.dueDate
              : todayIso(),
        );
      } else {
        setPaymentRecorded(false);
        setAmountPaidInput(0);
        setBalanceDueDate(todayIso());
      }
      if (importAsInvoice) {
        setLinkedQuotationId(doc.id);
        setLinkedQuotationCode(doc.code || null);
        setLinkedInvoiceId(null);
        setLinkedInvoiceCode(null);
      } else {
        setLinkedQuotationId(doc.quotationId ?? null);
        setLinkedQuotationCode(doc.quotationCode ?? null);
        setLinkedInvoiceId(null);
        setLinkedInvoiceCode(null);
      }
    }
  }

  useEffect(() => {
    let unsub: (() => void) | undefined;
    (async () => {
      const { auth } = await import("@/lib/firebase");
      unsub = onAuthStateChanged(auth, async (user) => {
        if (!user) {
          router.replace("/login");
          return;
        }
        const token = await user.getIdToken();
        const authHeaders = { Authorization: `Bearer ${token}` };

        try {
          const res = await fetch("/api/items", { headers: authHeaders, cache: "no-store" });
          const data = (await res.json()) as { ok?: boolean; items?: CatalogItem[] };
          if (res.ok && data.ok && data.items) setCatalog(data.items);
        } catch {
          /* catalog is optional */
        }

        try {
          const res = await fetch("/api/business-profile", {
            headers: authHeaders,
            cache: "no-store",
          });
          const data = (await res.json()) as {
            ok?: boolean;
            businessName?: string;
            email?: string;
            phone?: string;
          };
          if (res.ok && data.ok) {
            if (data.businessName) setBusinessName(data.businessName);
            if (typeof data.email === "string") setBusinessEmail(data.email.trim() || null);
            if (typeof data.phone === "string") setBusinessPhone(data.phone.trim() || null);
          }
        } catch {
          /* profile is cosmetic on this page */
        }

        // Editing an existing draft: prefill the form from the saved document.
        if (editingDocId) {
          try {
            const res = await fetch(`${config.apiBase}/${editingDocId}`, {
              headers: authHeaders,
              cache: "no-store",
            });
            const data = (await res.json()) as { ok?: boolean; document?: SavedDocument };
            if (res.ok && data.ok && data.document) {
              applySavedDocument(data.document);
            } else {
              setError(`Could not load the ${config.docLabel.toLowerCase()} for editing.`);
            }
          } catch {
            setError(`Could not load the ${config.docLabel.toLowerCase()} for editing.`);
          }
          return;
        }

        // Invoice create: prefill from a quotation (?fromQuotation=…).
        if (variant === "invoice" && fromQuotationParam) {
          try {
            const res = await fetch(`/api/quotations/${fromQuotationParam}`, {
              headers: authHeaders,
              cache: "no-store",
            });
            const data = (await res.json()) as { ok?: boolean; document?: SavedDocument };
            if (res.ok && data.ok && data.document) {
              applySavedDocument(data.document, { importAsInvoice: true });
              setSavedNotice(
                `Loaded quotation ${data.document.code || ""}. Review and save as an invoice.`,
              );
            } else {
              setError("Could not load the quotation to create an invoice.");
            }
          } catch {
            setError("Could not load the quotation to create an invoice.");
          }
          return;
        }

        // Invoice create: open quotation picker (?pickQuotation=1).
        if (variant === "invoice" && pickQuotationParam === "1") {
          void openQuotationPicker();
        }
      });
    })();
    return () => {
      if (unsub) unsub();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router, editingDocId, fromQuotationParam, pickQuotationParam, config.apiBase, variant]);

  // Search existing customers for autofill (debounced).
  useEffect(() => {
    if (!clientOpen || !customerSearchOpen) return;

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setCustomerSearchLoading(true);
      try {
        const { auth } = await import("@/lib/firebase");
        const user = auth.currentUser;
        if (!user) return;
        const token = await user.getIdToken();
        const q = customerSearch.trim();
        const url = q
          ? `/api/customers?q=${encodeURIComponent(q)}`
          : "/api/customers";
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
        });
        const data = (await res.json()) as {
          ok?: boolean;
          customers?: CustomerOption[];
        };
        if (!cancelled && res.ok && data.ok && data.customers) {
          setCustomerOptions(data.customers);
        }
      } catch {
        if (!cancelled) setCustomerOptions([]);
      } finally {
        if (!cancelled) setCustomerSearchLoading(false);
      }
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [clientOpen, customerSearch, customerSearchOpen]);

  useEffect(() => {
    function handlePointerDown(event: MouseEvent) {
      if (!customerSearchRef.current) return;
      if (!customerSearchRef.current.contains(event.target as Node)) {
        setCustomerSearchOpen(false);
      }
    }
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, []);

  const dueDate = useMemo(() => {
    const opt = TERMS_OPTIONS.find((t) => t.id === paymentTerms);
    return addDaysIso(documentDate, opt?.days ?? 0);
  }, [documentDate, paymentTerms]);

  const subtotal = useMemo(
    () => lineItems.reduce((sum, item) => sum + computeLineNet(item), 0),
    [lineItems],
  );

  const discountAmount = useMemo(() => {
    if (discountMode === "percent") {
      const pct = Math.min(100, Math.max(0, discountPercentBill));
      return Math.round(subtotal * (pct / 100) * 100) / 100;
    }
    return discountAud;
  }, [discountMode, discountPercentBill, discountAud, subtotal]);

  const cappedDiscount = useMemo(
    () => Math.min(discountAmount, subtotal),
    [discountAmount, subtotal],
  );

  // The GST-eligible portion of the subtotal after the document discount has
  // been allocated proportionally. This is the base GST is charged on, so we
  // surface it in the UI to make it clear why GST changes when a discount is
  // applied (GST is always calculated on the discounted amount).
  const gstTaxableBase = useMemo(() => {
    if (!gstEnabled) return 0;
    const gstItemsNet = lineItems
      .filter((item) => item.applyGst)
      .reduce((sum, item) => sum + computeLineNet(item), 0);
    const discountRatio = subtotal > 0 ? cappedDiscount / subtotal : 0;
    return Math.round(gstItemsNet * (1 - discountRatio) * 100) / 100;
  }, [gstEnabled, lineItems, subtotal, cappedDiscount]);

  const gstAmount = useMemo(() => {
    if (!gstEnabled) return 0;
    if (gstPricing === "inclusive") {
      return Math.round((gstTaxableBase - gstTaxableBase / (1 + gstPercentage / 100)) * 100) / 100;
    }
    return Math.round(gstTaxableBase * (gstPercentage / 100) * 100) / 100;
  }, [gstEnabled, gstTaxableBase, gstPricing, gstPercentage]);

  const total = useMemo(() => {
    const net = subtotal - cappedDiscount;
    if (!gstEnabled) return Math.round(net * 100) / 100;
    if (gstPricing === "inclusive") return Math.round(net * 100) / 100;
    return Math.round((net + gstAmount) * 100) / 100;
  }, [subtotal, cappedDiscount, gstEnabled, gstPricing, gstAmount]);

  const depositAud = useMemo(() => {
    if (variant !== "quotation" || !depositRequested) return 0;
    if (depositMode === "percent") {
      const pct = Math.min(100, Math.max(0, depositValue));
      return Math.min(total, Math.round(total * (pct / 100) * 100) / 100);
    }
    return Math.min(total, Math.max(0, Math.round(depositValue * 100) / 100));
  }, [variant, depositRequested, depositMode, depositValue, total]);

  const balanceAud = useMemo(
    () => Math.max(0, Math.round((total - depositAud) * 100) / 100),
    [total, depositAud],
  );

  const amountPaidAud = useMemo(() => {
    if (variant !== "invoice" || !paymentRecorded) return 0;
    return Math.min(total, Math.max(0, Math.round(amountPaidInput * 100) / 100));
  }, [variant, paymentRecorded, amountPaidInput, total]);

  const balanceDueAud = useMemo(
    () => Math.max(0, Math.round((total - amountPaidAud) * 100) / 100),
    [total, amountPaidAud],
  );

  const paymentTermsLabel =
    TERMS_OPTIONS.find((t) => t.id === paymentTerms)?.label ?? "Same day";

  /** Shared view-model for live HTML preview (mirrors pdf-lib PDF fields). */
  const documentData: DocumentData = useMemo(
    () => ({
      kind: variant,
      code: docCode || "DRAFT",
      status: docStatus || "draft",
      business: {
        name: businessName,
        email: businessEmail,
        phone: businessPhone,
      },
      customer: {
        fullName: customer.fullName,
        email: customer.email,
        phone: toAuE164Phone(customer.phone) || customer.phone,
      },
      address,
      jobTitle,
      jobDescription,
      lineItems: lineItems.map(({ code, name, description, quantity, rate, discountPercent, applyGst }) => ({
        code,
        name,
        description,
        quantity,
        rate,
        discountPercent,
        applyGst,
      })),
      discountAud: cappedDiscount,
      gstEnabled,
      gstPercentage,
      gstPricing,
      subtotalAud: Math.round(subtotal * 100) / 100,
      gstAud: gstAmount,
      totalAud: total,
      depositRequested: variant === "quotation" && depositRequested && depositAud > 0,
      depositMode,
      depositValue,
      depositAud,
      balanceAud,
      depositDueDate:
        variant === "quotation" && depositRequested && depositAud > 0 ? depositDueDate : "",
      paymentRecorded: variant === "invoice" && paymentRecorded && amountPaidAud > 0,
      amountPaidAud,
      balanceDueAud,
      balanceDueDate:
        variant === "invoice" && paymentRecorded && amountPaidAud > 0 && balanceDueAud > 0
          ? balanceDueDate
          : "",
      documentDate,
      dueDate,
      paymentTermsLabel,
      terms,
      comment,
    }),
    [
      variant,
      docCode,
      docStatus,
      businessName,
      businessEmail,
      businessPhone,
      customer,
      address,
      jobTitle,
      jobDescription,
      lineItems,
      cappedDiscount,
      gstEnabled,
      gstPercentage,
      gstPricing,
      subtotal,
      gstAmount,
      total,
      depositRequested,
      depositMode,
      depositValue,
      depositAud,
      balanceAud,
      depositDueDate,
      paymentRecorded,
      amountPaidAud,
      balanceDueAud,
      balanceDueDate,
      documentDate,
      dueDate,
      paymentTermsLabel,
      terms,
      comment,
    ],
  );

  function startAddItem() {
    setItemDraft({
      code: "",
      name: "",
      description: "",
      quantity: "1",
      rate: "",
      discountPercent: "0",
      applyGst: true,
    });
    setEditingItemId(null);
  }

  function startEditItem(item: LineItem) {
    setItemDraft({
      code: item.code,
      name: item.name,
      description: item.description,
      quantity: String(item.quantity),
      rate: String(item.rate),
      discountPercent: String(item.discountPercent),
      applyGst: item.applyGst,
    });
    setEditingItemId(item.id);
  }

  function applyCatalogItem(item: CatalogItem) {
    setItemDraft((prev) =>
      prev
        ? {
            ...prev,
            code: item.code ?? "",
            name: item.name,
            description: item.description ?? "",
            rate: String(item.priceAud),
          }
        : prev,
    );
    setCatalogField(null);
  }

  function applyExistingCustomer(option: CustomerOption) {
    setSelectedCustomerId(option.id);
    setCustomer({
      fullName: option.name,
      email: option.email,
      phone: toAuLocalPhone(option.phone),
    });
    if (option.address) {
      setAddress({
        street: option.address.street,
        suburb: option.address.suburb,
        state: option.address.state,
        postcode: option.address.postcode,
      });
    }
    setCustomerSearch(option.name);
    setCustomerSearchOpen(false);
    setError(null);
  }

  function clearSelectedCustomer() {
    setSelectedCustomerId(null);
    setCustomerSearch("");
    setCustomer({ fullName: "", email: "", phone: "" });
    setAddress({ street: "", suburb: "", state: "", postcode: "" });
  }

  async function saveItemToCatalog(item: {
    name: string;
    priceAud: number;
    code: string | null;
    description: string | null;
  }) {
    try {
      const { auth } = await import("@/lib/firebase");
      const user = auth.currentUser;
      if (!user) return;
      const token = await user.getIdToken();
      const res = await fetch("/api/items", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(item),
      });
      const data = (await res.json()) as { ok?: boolean; item?: CatalogItem };
      if (res.ok && data.ok && data.item) {
        setCatalog((prev) => {
          const rest = prev.filter((existing) => existing.id !== data.item!.id);
          return [...rest, data.item!].sort((a, b) => a.name.localeCompare(b.name));
        });
      }
    } catch {
      /* catalog save is best-effort */
    }
  }

  function commitItemDraft() {
    if (!itemDraft) return;
    const name = itemDraft.name.trim();
    const rate = parseNum(itemDraft.rate);
    if (!name || rate <= 0) {
      setError("Enter an item name and rate.");
      return;
    }
    const code = itemDraft.code.trim();
    const description = itemDraft.description.trim();
    const saved: LineItem = {
      id: editingItemId ?? (crypto.randomUUID?.() ?? String(Date.now())),
      code,
      name,
      description,
      quantity: parseNum(itemDraft.quantity) || 1,
      rate,
      discountPercent: Math.min(100, parseNum(itemDraft.discountPercent)),
      applyGst: itemDraft.applyGst,
    };
    setLineItems((prev) =>
      editingItemId ? prev.map((row) => (row.id === editingItemId ? saved : row)) : [...prev, saved],
    );
    setItemDraft(null);
    setEditingItemId(null);
    setCatalogField(null);
    setError(null);

    void saveItemToCatalog({
      name,
      priceAud: rate,
      code: code || null,
      description: description || null,
    });
  }

  function uploadAttachment(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
    setAttachments((prev) => [...prev, { name: file.name, url, isPdf }].slice(0, 10));
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function validate(send: boolean): string | null {
    // Drafts can be incomplete — only block if a line-item editor is mid-edit.
    if (!send) {
      if (itemDraft) return "Finish adding the current item, or cancel it.";
      return null;
    }

    // Client
    if (customer.fullName.trim().length < 2) return "Add a client name.";
    if (!EMAIL_REGEX.test(customer.email.trim())) return "Enter a valid client email.";
    if (toAuLocalPhone(customer.phone).length < 6) return "Enter a valid client mobile number.";
    if (address.postcode && address.postcode.length !== 4) {
      return "Enter a valid 4-digit postcode, or clear it.";
    }

    // Job details
    if (jobTitle.trim().length < 3) return "Add a job title (at least 3 characters).";
    if (jobDescription.trim().length < 10) {
      return "Describe the work (at least 10 characters).";
    }

    // Items
    if (itemDraft) return "Finish adding the current item, or cancel it.";
    if (lineItems.length === 0) return "Add at least one line item.";
    for (const item of lineItems) {
      if (!item.name.trim()) return "Every item needs a name.";
      if (item.rate <= 0) return `Enter a rate for "${item.name}".`;
      if (item.quantity <= 0) return `Enter a quantity for "${item.name}".`;
    }

    // Totals
    if (!documentDate) return `Choose a ${config.dateLabel.toLowerCase()}.`;
    if (discountMode === "percent") {
      if (discountPercentBill < 0) return "Discount cannot be negative.";
      if (discountPercentBill > 100) return "Discount cannot exceed 100%.";
    } else {
      if (discountAud < 0) return "Discount cannot be negative.";
      if (discountAud > subtotal) return "Discount cannot exceed the subtotal.";
    }
    if (total <= 0) return "The total must be greater than zero.";

    if (variant === "quotation" && depositRequested) {
      if (depositValue < 0) return "Deposit cannot be negative.";
      if (depositMode === "percent") {
        if (depositValue > 100) return "Deposit cannot exceed 100%.";
      } else if (depositValue > total) {
        return "Deposit cannot exceed the quotation total.";
      }
      if (depositAud <= 0) return "Enter a deposit greater than zero, or turn off the deposit request.";
      if (!depositDueDate || !/^\d{4}-\d{2}-\d{2}$/.test(depositDueDate)) {
        return "Choose a deposit due date.";
      }
    }

    if (variant === "invoice" && paymentRecorded) {
      if (amountPaidInput < 0) return "Amount paid cannot be negative.";
      if (amountPaidInput > total) return "Amount paid cannot exceed the invoice total.";
      if (amountPaidAud <= 0) {
        return "Enter an amount paid greater than zero, or turn off record payment.";
      }
      if (balanceDueAud > 0 && (!balanceDueDate || !/^\d{4}-\d{2}-\d{2}$/.test(balanceDueDate))) {
        return "Choose a balance due date.";
      }
    }

    return null;
  }

  function collectPayload() {
    return {
      customer: {
        fullName: customer.fullName.trim(),
        email: customer.email.trim(),
        phone: toAuE164Phone(customer.phone),
      },
      address,
      jobTitle: jobTitle.trim(),
      jobDescription: jobDescription.trim(),
      lineItems: lineItems.map((item) => ({
        code: item.code,
        name: item.name,
        description: item.description,
        quantity: item.quantity,
        rate: item.rate,
        discountPercent: item.discountPercent,
        applyGst: item.applyGst,
      })),
      discountAud: cappedDiscount,
      gstEnabled,
      gstPercentage,
      gstPricing,
      documentDate,
      paymentTermsId: paymentTerms,
      terms: terms.trim(),
      comment: comment.trim(),
      ...(variant === "quotation"
        ? {
            depositRequested,
            depositMode,
            depositValue: depositRequested ? depositValue : 0,
            depositAud,
            balanceAud: depositRequested ? balanceAud : total,
            depositDueDate: depositRequested ? depositDueDate : "",
          }
        : {
            paymentRecorded,
            amountPaidAud,
            balanceDueAud: paymentRecorded ? balanceDueAud : total,
            balanceDueDate:
              paymentRecorded && amountPaidAud > 0 && balanceDueAud > 0 ? balanceDueDate : "",
            ...(linkedQuotationId ? { quotationId: linkedQuotationId } : {}),
          }),
    };
  }

  function attachSavedDocument(doc: SavedDocument) {
    setDocCode(doc.code || null);
    setDocStatus(doc.status || "draft");
    if (doc.id) setDocId(doc.id);
  }

  async function save(send: boolean) {
    if (saving) return;
    const validationError = validate(send);
    if (validationError) {
      setError(validationError);
      setTab("create");
      return;
    }
    if (send && !customer.email.trim()) {
      setError("Add a client email before sending.");
      setTab("send");
      return;
    }
    if (send && !gstEnabled) {
      setError("Apply GST before sending. Tick “Apply GST” in the summary to continue.");
      setTab("create");
      return;
    }
    setError(null);
    setSavedNotice(null);
    setSaving(send ? "send" : "draft");

    try {
      const { auth } = await import("@/lib/firebase");
      const user = auth.currentUser;
      if (!user) {
        router.replace("/login");
        return;
      }
      const token = await user.getIdToken();

      const payload = { ...collectPayload(), send };

      const url = editingDocId || docId ? `${config.apiBase}/${editingDocId || docId}` : config.apiBase;
      const res = await fetch(url, {
        method: editingDocId || docId ? "PATCH" : "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        document?: SavedDocument;
        documentId?: string;
        emailSent?: boolean;
        customerAccountCreated?: boolean;
      };

      if (!res.ok || !data.ok) {
        // Failed send still persists a draft — attach so further edits PATCH that doc.
        const attachedId = data.document?.id || data.documentId;
        if (data.document) {
          attachSavedDocument(data.document);
        } else if (attachedId) {
          setDocId(attachedId);
          setDocStatus("draft");
        }
        if (attachedId && !editingDocId) {
          router.replace(`${config.listHref}/create?id=${attachedId}`);
        }
        setError(data.error || `Could not save the ${config.docLabel.toLowerCase()}.`);
        return;
      }

      if (data.document) {
        attachSavedDocument(data.document);
      }

      if (send) {
        const accountNote = data.customerAccountCreated
          ? " A booking engine account was created for this customer and their login details were emailed to them."
          : "";
        setSavedNotice(
          `${config.docLabel} ${data.document?.code ?? ""} sent to ${customer.email.trim()}.${accountNote}`,
        );
        window.setTimeout(() => router.push(config.listHref), 1800);
      } else {
        setSavedNotice(`${config.docLabel} ${data.document?.code ?? ""} saved as a draft.`);
        if (!editingDocId && data.document?.id) {
          router.replace(`${config.listHref}/create?id=${data.document.id}`);
        }
      }
    } catch {
      setError(`Could not save the ${config.docLabel.toLowerCase()}. Check your connection and try again.`);
    } finally {
      setSaving(false);
    }
  }

  async function fetchLivePdfBlob(): Promise<Blob> {
    const { auth } = await import("@/lib/firebase");
    const user = auth.currentUser;
    if (!user) {
      router.replace("/login");
      throw new Error("Not signed in");
    }
    const token = await user.getIdToken();
    const res = await fetch(`${config.apiBase}/preview-pdf`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(collectPayload()),
    });
    if (!res.ok) {
      throw new Error(`Could not generate the ${config.docLabel.toLowerCase()} PDF.`);
    }
    return res.blob();
  }

  async function openSavedPdfViewer() {
    setError(null);
    try {
      const blob = await fetchLivePdfBlob();
      const buffer = await blob.arrayBuffer();
      setLivePdfBytes(new Uint8Array(buffer));
      setPdfAuthHeaders(undefined);
      setPdfViewerOpen(true);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : `Could not open the ${config.docLabel.toLowerCase()} PDF.`,
      );
    }
  }

  async function downloadPdf() {
    if (downloadingPdf) return;
    setDownloadingPdf(true);
    setError(null);
    try {
      const blob = await fetchLivePdfBlob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${config.docLabel}-${docCode || "draft"}.pdf`.replace(/[^\w.-]+/g, "_");
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : `Could not generate the ${config.docLabel.toLowerCase()} PDF.`,
      );
    } finally {
      setDownloadingPdf(false);
    }
  }

  function issueInvoiceFromQuotation() {
    if (variant !== "quotation" || !docId || issuingInvoice) return;
    if (linkedInvoiceId) {
      router.push(`/invoices/create?id=${linkedInvoiceId}`);
      return;
    }
    setIssuingInvoice(true);
    router.push(`/invoices/create?fromQuotation=${docId}`);
  }

  async function openQuotationPicker() {
    if (variant !== "invoice" || quotationLoading) return;
    setQuotationPickerOpen(true);
    setQuotationLoading(true);
    setError(null);
    try {
      const { auth } = await import("@/lib/firebase");
      const user = auth.currentUser;
      if (!user) {
        router.replace("/login");
        return;
      }
      const token = await user.getIdToken();
      const res = await fetch("/api/quotations", {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        documents?: QuotationOption[];
      };
      if (res.ok && data.ok && data.documents) {
        setQuotationOptions(data.documents);
      } else {
        setError(data.error || "Could not load quotations.");
      }
    } catch {
      setError("Could not load quotations.");
    } finally {
      setQuotationLoading(false);
    }
  }

  async function importQuotation(quotationId: string) {
    if (importingQuotation) return;
    setImportingQuotation(true);
    setError(null);
    try {
      const { auth } = await import("@/lib/firebase");
      const user = auth.currentUser;
      if (!user) {
        router.replace("/login");
        return;
      }
      const token = await user.getIdToken();
      const res = await fetch(`/api/quotations/${quotationId}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      const data = (await res.json()) as { ok?: boolean; document?: SavedDocument; error?: string };
      if (!res.ok || !data.ok || !data.document) {
        setError(data.error || "Could not load the selected quotation.");
        return;
      }
      applySavedDocument(data.document, { importAsInvoice: true });
      setQuotationPickerOpen(false);
      setQuotationSearch("");
      setSavedNotice(
        `Loaded quotation ${data.document.code || ""}. Review and save as an invoice.`,
      );
      setTab("create");
      // Keep URL in sync so refresh preserves the import source.
      router.replace(`/invoices/create?fromQuotation=${quotationId}`);
    } catch {
      setError("Could not load the selected quotation.");
    } finally {
      setImportingQuotation(false);
    }
  }

  const lineDraftPreview = useMemo(() => {
    if (!itemDraft) return 0;
    const net = computeLineNet({
      quantity: parseNum(itemDraft.quantity) || 1,
      rate: parseNum(itemDraft.rate),
      discountPercent: Math.min(100, parseNum(itemDraft.discountPercent)),
    });
    return net;
  }, [itemDraft]);

  const catalogSuggestions = useMemo(() => {
    if (!itemDraft || !catalogField || catalog.length === 0) return [];
    const query =
      catalogField === "code"
        ? itemDraft.code.trim().toLowerCase()
        : itemDraft.name.trim().toLowerCase();
    const matches = query
      ? catalog.filter((item) => {
          const name = item.name.toLowerCase();
          const code = (item.code ?? "").toLowerCase();
          const description = (item.description ?? "").toLowerCase();
          return (
            name.includes(query) || code.includes(query) || description.includes(query)
          );
        })
      : catalog;
    return matches.slice(0, 8);
  }, [catalog, itemDraft, catalogField]);

  const filteredQuotations = useMemo(() => {
    const query = quotationSearch.trim().toLowerCase();
    if (!query) return quotationOptions;
    return quotationOptions.filter((row) => {
      const haystack = [
        row.code,
        row.customer?.fullName ?? "",
        row.customer?.email ?? "",
        row.jobTitle ?? "",
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [quotationOptions, quotationSearch]);

  function renderCatalogSuggestions(field: "code" | "name") {
    if (catalogField !== field || catalogSuggestions.length === 0) return null;
    const query =
      field === "code" ? (itemDraft?.code ?? "").trim() : (itemDraft?.name ?? "").trim();
    return (
      <ul className="absolute z-30 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border border-neutral-200 bg-white py-1 shadow-lg">
        {!query && (
          <li className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wide text-neutral-400">
            Saved items
          </li>
        )}
        {catalogSuggestions.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => applyCatalogItem(item)}
              className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left transition hover:bg-neutral-50"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold text-neutral-900">
                  {item.name}
                </span>
                {item.code && (
                  <span className="text-xs text-neutral-500">{item.code}</span>
                )}
              </span>
              <span className="shrink-0 text-xs font-semibold text-neutral-900">
                {formatAud(item.priceAud)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div id="app" className="flex h-screen overflow-hidden bg-white">
      <Sidebar />
      <div className="flex-1 flex flex-col overflow-hidden">
        <main className="flex-1 overflow-auto p-4 sm:p-6 lg:p-8 bg-neutral-50">
          {/* Mobile menu */}
          <div className="md:hidden mb-4">
            <button
              className="inline-flex items-center gap-2 rounded-lg border border-neutral-200 px-3 py-2 text-neutral-700 shadow-sm hover:bg-neutral-50 bg-white"
              onClick={() => setMobileOpen(true)}
            >
              <i className="fas fa-bars" />
              Menu
            </button>
          </div>
          {mobileOpen && (
            <div className="fixed inset-0 z-50 md:hidden">
              <div className="absolute inset-0 bg-black/40" onClick={() => setMobileOpen(false)} />
              <div className="absolute left-0 top-0 bottom-0">
                <Sidebar mobile onClose={() => setMobileOpen(false)} />
              </div>
            </div>
          )}

          {/* Hero header */}
          <div className="mb-6">
            <div className="relative rounded-2xl bg-neutral-900 text-white p-6 shadow-sm overflow-hidden">
              <div className="absolute top-0 right-0 w-32 h-32 bg-white/5 rounded-full -translate-y-1/2 translate-x-1/2" />
              <div className="absolute bottom-0 left-1/3 w-20 h-20 bg-white/5 rounded-full translate-y-1/2" />
              <div className="relative">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-white/10 flex items-center justify-center">
                    <i className={`fas ${config.heroIcon} text-amber-400`} />
                  </div>
                  <h1 className="text-2xl font-bold">
                    {docCode
                      ? `${config.docLabel} ${docCode}`
                      : editingDocId
                        ? `Edit ${config.docLabel.toLowerCase()}`
                        : config.pageTitle}
                  </h1>
                  {(editingDocId || docId) && (
                    <span
                      className={`ml-1 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide ${
                        docStatus === "sent"
                          ? "border border-emerald-400/40 bg-emerald-400/15 text-emerald-200"
                          : "border border-amber-400/40 bg-amber-400/15 text-amber-200"
                      }`}
                    >
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${
                          docStatus === "sent" ? "bg-emerald-400" : "bg-amber-400"
                        }`}
                      />
                      {docStatus === "sent" ? "Sent" : "Draft"}
                    </span>
                  )}
                </div>
                <p className="text-sm text-neutral-400 mt-2">
                  {editingDocId || docId
                    ? docStatus === "sent"
                      ? `Update this ${config.docLabel.toLowerCase()} or resend it to your customer.`
                      : `Continue editing this draft. Save anytime, send when ready.`
                    : config.heroSubtitle}
                </p>
              </div>
            </div>
          </div>

          {/* Header + tabs */}
          <div className="mb-6 bg-white rounded-2xl border border-neutral-200 shadow-sm">
            <div className="flex items-center justify-between gap-3 px-6 py-4">
              <div className="flex min-w-0 items-center gap-3">
                <Link
                  href={config.listHref}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-900"
                  aria-label={`Back to ${config.docLabel.toLowerCase()}s`}
                >
                  <i className="fas fa-arrow-left" />
                </Link>
              </div>
              <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                <Link
                  href={config.listHref}
                  className="hidden rounded-lg px-3 py-2 text-sm font-semibold text-neutral-600 transition hover:bg-neutral-100 sm:inline"
                >
                  Close
                </Link>
                {variant === "invoice" && !editingDocId && (
                  <button
                    type="button"
                    onClick={openQuotationPicker}
                    disabled={quotationLoading}
                    className="inline-flex items-center gap-2 rounded-lg border border-neutral-300 px-4 py-2 text-sm font-semibold text-neutral-700 transition hover:bg-neutral-100 disabled:opacity-60"
                  >
                    <i className={`fas ${quotationLoading ? "fa-spinner fa-spin" : "fa-file-lines"}`} />
                    From quotation
                  </button>
                )}
                {variant === "quotation" && docId && (
                  linkedInvoiceId ? (
                    <Link
                      href={`/invoices/create?id=${linkedInvoiceId}`}
                      className="inline-flex items-center gap-2 rounded-lg border border-neutral-300 px-4 py-2 text-sm font-semibold text-neutral-700 transition hover:bg-neutral-100"
                    >
                      <i className="fas fa-file-invoice-dollar" />
                      {linkedInvoiceCode ? `Invoice ${linkedInvoiceCode}` : "View invoice"}
                    </Link>
                  ) : (
                    <button
                      type="button"
                      onClick={issueInvoiceFromQuotation}
                      disabled={issuingInvoice}
                      className="inline-flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-4 py-2 text-sm font-semibold text-amber-900 transition hover:bg-amber-100 disabled:opacity-60"
                    >
                      <i className={`fas ${issuingInvoice ? "fa-spinner fa-spin" : "fa-file-invoice-dollar"}`} />
                      Issue invoice
                    </button>
                  )
                )}
                <button
                  type="button"
                  onClick={() => void openSavedPdfViewer()}
                  className="inline-flex items-center gap-2 rounded-lg border border-neutral-300 px-4 py-2 text-sm font-semibold text-neutral-700 transition hover:bg-neutral-100"
                >
                  <i className="fas fa-eye" />
                  View PDF
                </button>
                <button
                  type="button"
                  onClick={() => void downloadPdf()}
                  disabled={downloadingPdf}
                  className="inline-flex items-center gap-2 rounded-lg border border-neutral-300 px-4 py-2 text-sm font-semibold text-neutral-700 transition hover:bg-neutral-100 disabled:opacity-60"
                >
                  <i className={`fas ${downloadingPdf ? "fa-spinner fa-spin" : "fa-download"}`} />
                  PDF
                </button>
                <button
                  type="button"
                  onClick={() => save(false)}
                  disabled={!!saving}
                  className="rounded-lg bg-neutral-900 px-5 py-2 text-sm font-semibold text-white transition hover:bg-neutral-800 disabled:opacity-60"
                >
                  {saving === "draft" ? (
                    <>
                      <i className="fas fa-spinner fa-spin mr-2" />
                      Saving…
                    </>
                  ) : docStatus === "sent" ? (
                    "Save changes"
                  ) : (
                    config.saveDraftLabel
                  )}
                </button>
              </div>
            </div>
            <div className="flex items-center gap-6 px-6 border-b border-t border-neutral-200">
              {(
                [
                  { id: "create" as const, label: "Create", icon: "fa-pen-to-square" },
                  { id: "preview" as const, label: "Preview", icon: "fa-eye" },
                  { id: "send" as const, label: "Send", icon: "fa-paper-plane" },
                ]
              ).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setTab(item.id)}
                  className={`py-4 text-sm font-semibold transition flex items-center gap-2 ${
                    tab === item.id
                      ? "text-neutral-900 border-b-2 border-neutral-900"
                      : "text-neutral-500 hover:text-neutral-900"
                  }`}
                >
                  <i className={`fas ${item.icon} text-xs`} />
                  {item.label}
                </button>
              ))}
            </div>

            {/* Notices */}
            {savedNotice && (
              <div className="mx-6 mt-4 flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
                <i className="fas fa-check-circle mt-0.5" />
                <span>{savedNotice}</span>
              </div>
            )}
            {error && (
              <div className="mx-6 mt-4 flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
                <i className="fas fa-exclamation-circle mt-0.5" />
                <span>{error}</span>
              </div>
            )}
            {variant === "invoice" && linkedQuotationCode && (
              <div className="mx-6 mt-4 flex items-start gap-2 rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
                <i className="fas fa-file-lines mt-0.5" />
                <span>
                  Based on quotation{" "}
                  <Link
                    href={`/quotations/create?id=${linkedQuotationId}`}
                    className="font-semibold underline underline-offset-2"
                  >
                    {linkedQuotationCode}
                  </Link>
                  . Saving will create a linked invoice.
                </span>
              </div>
            )}
            {variant === "quotation" && linkedInvoiceCode && linkedInvoiceId && (
              <div className="mx-6 mt-4 flex items-start gap-2 rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
                <i className="fas fa-file-invoice-dollar mt-0.5" />
                <span>
                  Invoice issued:{" "}
                  <Link
                    href={`/invoices/create?id=${linkedInvoiceId}`}
                    className="font-semibold underline underline-offset-2"
                  >
                    {linkedInvoiceCode}
                  </Link>
                </span>
              </div>
            )}

            <div className="flex flex-col lg:flex-row">
              {/* Main column */}
              <div className="flex-1 p-6 space-y-4 min-w-0">
                {tab === "create" && (
                  <>
                    {/* Client */}
                    {!clientOpen ? (
                      <button
                        type="button"
                        onClick={() => setClientOpen(true)}
                        className="flex w-full items-center gap-3 rounded-xl border border-neutral-200 bg-white px-4 py-3.5 text-left text-sm font-semibold text-neutral-900 transition hover:border-neutral-900 hover:bg-neutral-50"
                      >
                        <i className="fas fa-user text-neutral-500" />
                        Add a client
                      </button>
                    ) : (
                      <section className="rounded-xl border border-neutral-200 bg-white p-5">
                        <div className="flex items-center justify-between mb-4">
                          <h2 className="text-sm font-bold text-neutral-900">Client</h2>
                          <button
                            type="button"
                            onClick={() => setClientOpen(false)}
                            className="inline-flex items-center gap-1.5 text-xs font-semibold text-neutral-500 hover:text-neutral-900"
                          >
                            <i className="fas fa-xmark" />
                            Close
                          </button>
                        </div>

                        <div ref={customerSearchRef} className="relative mb-4">
                          <label className="block">
                            <span className={LABEL_CLASS}>Find existing customer</span>
                            <div className="relative">
                              <i className="fas fa-magnifying-glass pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-xs text-neutral-400" />
                              <input
                                type="text"
                                value={customerSearch}
                                onChange={(e) => {
                                  setCustomerSearch(e.target.value);
                                  setSelectedCustomerId(null);
                                  setCustomerSearchOpen(true);
                                }}
                                onFocus={() => setCustomerSearchOpen(true)}
                                placeholder="Search by name, email, or mobile"
                                className={`${INPUT_CLASS} pl-10`}
                                autoComplete="off"
                              />
                            </div>
                          </label>
                          {customerSearchOpen && (
                            <ul className="absolute z-30 mt-1 max-h-64 w-full overflow-y-auto rounded-lg border border-neutral-200 bg-white py-1 shadow-lg">
                              {customerSearchLoading ? (
                                <li className="px-3 py-2.5 text-sm text-neutral-500">Searching…</li>
                              ) : customerOptions.length === 0 ? (
                                <li className="px-3 py-2.5 text-sm text-neutral-500">
                                  {customerSearch.trim()
                                    ? "No matching customers. Enter details below."
                                    : "No saved customers yet. Enter details below."}
                                </li>
                              ) : (
                                <>
                                  {!customerSearch.trim() && (
                                    <li className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wide text-neutral-400">
                                      Existing customers
                                    </li>
                                  )}
                                  {customerOptions.map((option) => (
                                    <li key={option.id}>
                                      <button
                                        type="button"
                                        onMouseDown={(event) => event.preventDefault()}
                                        onClick={() => applyExistingCustomer(option)}
                                        className="flex w-full flex-col gap-0.5 px-3 py-2.5 text-left transition hover:bg-neutral-50"
                                      >
                                        <span className="truncate text-sm font-semibold text-neutral-900">
                                          {option.name || "Unnamed customer"}
                                        </span>
                                        <span className="truncate text-xs text-neutral-500">
                                          {[option.email, option.phone].filter(Boolean).join(" · ") ||
                                            "No contact details"}
                                        </span>
                                      </button>
                                    </li>
                                  ))}
                                </>
                              )}
                            </ul>
                          )}
                          {selectedCustomerId && (
                            <div className="mt-2 flex items-center justify-between gap-2 rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2">
                              <p className="min-w-0 truncate text-xs text-neutral-600">
                                <i className="fas fa-check text-neutral-900 mr-1.5" />
                                Filled from existing customer
                              </p>
                              <button
                                type="button"
                                onClick={clearSelectedCustomer}
                                className="shrink-0 text-xs font-semibold text-neutral-500 hover:text-neutral-900"
                              >
                                Clear
                              </button>
                            </div>
                          )}
                        </div>

                        <div className="grid gap-4 sm:grid-cols-2">
                          <label className="block sm:col-span-2">
                            <span className={LABEL_CLASS}>Client name</span>
                            <input
                              type="text"
                              value={customer.fullName}
                              onChange={(e) => {
                                setSelectedCustomerId(null);
                                setCustomer((p) => ({ ...p, fullName: e.target.value }));
                              }}
                              placeholder="e.g. Sam Wilson"
                              className={INPUT_CLASS}
                            />
                          </label>
                          <label className="block">
                            <span className={LABEL_CLASS}>Mobile</span>
                            <div className="flex items-stretch">
                              <span className="inline-flex items-center rounded-l-lg border border-r-0 border-neutral-300 bg-neutral-100 px-3.5 text-sm font-mono text-neutral-500">
                                +61
                              </span>
                              <input
                                type="tel"
                                inputMode="numeric"
                                value={customer.phone}
                                onChange={(e) => {
                                  setSelectedCustomerId(null);
                                  setCustomer((p) => ({
                                    ...p,
                                    phone: toAuLocalPhone(e.target.value),
                                  }));
                                }}
                                placeholder="412 345 678"
                                className="w-full min-w-0 rounded-r-lg border border-neutral-300 px-4 py-2.5 text-sm text-neutral-900 placeholder:text-neutral-400 focus:z-10 focus:ring-2 focus:ring-neutral-900 focus:border-transparent outline-none"
                              />
                            </div>
                          </label>
                          <label className="block">
                            <span className={LABEL_CLASS}>Email</span>
                            <input
                              type="email"
                              value={customer.email}
                              onChange={(e) => {
                                setSelectedCustomerId(null);
                                setCustomer((p) => ({ ...p, email: e.target.value }));
                              }}
                              placeholder="sam@email.com"
                              className={INPUT_CLASS}
                            />
                          </label>
                        </div>
                        <div className="mt-4 border-t border-neutral-200 pt-4">
                          <p className={LABEL_CLASS}>Bill to (optional)</p>
                          <div className="grid gap-4 sm:grid-cols-2 mt-1">
                            <label className="block sm:col-span-2">
                              <span className={LABEL_CLASS}>Street</span>
                              <input
                                type="text"
                                value={address.street}
                                onChange={(e) => setAddress((p) => ({ ...p, street: e.target.value }))}
                                placeholder="e.g. 12 Mechanic Lane"
                                className={INPUT_CLASS}
                              />
                            </label>
                            <label className="block">
                              <span className={LABEL_CLASS}>Suburb</span>
                              <input
                                type="text"
                                value={address.suburb}
                                onChange={(e) => setAddress((p) => ({ ...p, suburb: e.target.value }))}
                                placeholder="e.g. Preston"
                                className={INPUT_CLASS}
                              />
                            </label>
                            <label className="block">
                              <span className={LABEL_CLASS}>State</span>
                              <input
                                type="text"
                                value={address.state}
                                onChange={(e) => setAddress((p) => ({ ...p, state: e.target.value }))}
                                placeholder="e.g. VIC"
                                className={INPUT_CLASS}
                              />
                            </label>
                            <label className="block sm:max-w-[10rem]">
                              <span className={LABEL_CLASS}>Postcode</span>
                              <input
                                type="text"
                                inputMode="numeric"
                                value={address.postcode}
                                onChange={(e) =>
                                  setAddress((p) => ({
                                    ...p,
                                    postcode: e.target.value.replace(/\D/g, "").slice(0, 4),
                                  }))
                                }
                                placeholder="3072"
                                className={INPUT_CLASS}
                              />
                            </label>
                          </div>
                        </div>
                      </section>
                    )}

                    {/* Job details */}
                    <section className="rounded-xl border border-neutral-200 bg-white p-5">
                      <h2 className="text-sm font-bold text-neutral-900">Job details</h2>
                      <p className="mt-1 text-xs text-neutral-500">
                        Describe the vehicle work for this {config.docLabel.toLowerCase()}.
                      </p>
                      <div className="mt-4 grid gap-4">
                        <label className="block">
                          <span className={LABEL_CLASS}>Job title</span>
                          <input
                            type="text"
                            value={jobTitle}
                            onChange={(e) => {
                              setJobTitle(e.target.value);
                              setError(null);
                            }}
                            placeholder="e.g. Brake pad replacement – Toyota Hilux"
                            className={INPUT_CLASS}
                            maxLength={120}
                          />
                        </label>
                        <label className="block">
                          <span className={LABEL_CLASS}>What needs doing?</span>
                          <textarea
                            value={jobDescription}
                            onChange={(e) => setJobDescription(e.target.value)}
                            rows={4}
                            placeholder="e.g. Front pads and rotors, rego ABC123. Customer reports grinding noise. Parts + labour."
                            className={`${INPUT_CLASS} resize-y`}
                            maxLength={1500}
                          />
                        </label>
                      </div>
                    </section>

                    {/* Items */}
                    <section className="rounded-xl border border-neutral-200 bg-white p-5">
                      <h2 className="text-sm font-bold text-neutral-900">Items</h2>
                      {lineItems.length > 0 && (
                        <ul className="mt-3 divide-y divide-neutral-200">
                          {lineItems.map((item) => (
                            <li key={item.id} className="flex items-start justify-between gap-3 py-3">
                              <button
                                type="button"
                                onClick={() => startEditItem(item)}
                                className="min-w-0 flex-1 text-left"
                              >
                                <p className="text-sm font-semibold text-neutral-900">
                                  {item.code && <span className="text-neutral-500">{item.code} · </span>}
                                  {item.name}
                                </p>
                                {item.description && (
                                  <p className="mt-0.5 text-xs text-neutral-500">{item.description}</p>
                                )}
                                <p className="mt-1 text-xs text-neutral-500">
                                  {item.quantity} × {formatAud(item.rate)}
                                  {item.discountPercent > 0 ? ` · ${item.discountPercent}% off` : ""}
                                  {item.applyGst && gstEnabled ? ` · GST ${gstPercentage}%` : ""}
                                </p>
                              </button>
                              <div className="flex shrink-0 items-center gap-3">
                                <span className="text-sm font-semibold text-neutral-900">
                                  {formatAud(computeLineNet(item))}
                                </span>
                                <button
                                  type="button"
                                  onClick={() => setLineItems((prev) => prev.filter((r) => r.id !== item.id))}
                                  className="text-neutral-400 hover:text-rose-600"
                                  aria-label="Remove item"
                                >
                                  <i className="fas fa-times" />
                                </button>
                              </div>
                            </li>
                          ))}
                        </ul>
                      )}

                      {itemDraft ? (
                        <div className="mt-3 rounded-xl border border-neutral-900/10 bg-neutral-50 p-4">
                          <div className="grid gap-3 sm:grid-cols-2">
                            <label className="block">
                              <span className={LABEL_CLASS}>Item code</span>
                              <div className="relative">
                                <input
                                  type="text"
                                  value={itemDraft.code}
                                  onChange={(e) =>
                                    setItemDraft((p) => (p ? { ...p, code: e.target.value } : p))
                                  }
                                  onFocus={() => setCatalogField("code")}
                                  onBlur={() =>
                                    window.setTimeout(
                                      () =>
                                        setCatalogField((f) => (f === "code" ? null : f)),
                                      150,
                                    )
                                  }
                                  placeholder="e.g. BRK-001"
                                  className={INPUT_CLASS}
                                  autoComplete="off"
                                />
                                {renderCatalogSuggestions("code")}
                              </div>
                            </label>
                            <label className="block">
                              <span className={LABEL_CLASS}>Item name</span>
                              <div className="relative">
                                <input
                                  type="text"
                                  value={itemDraft.name}
                                  onChange={(e) =>
                                    setItemDraft((p) => (p ? { ...p, name: e.target.value } : p))
                                  }
                                  onFocus={() => setCatalogField("name")}
                                  onBlur={() =>
                                    window.setTimeout(
                                      () =>
                                        setCatalogField((f) => (f === "name" ? null : f)),
                                      150,
                                    )
                                  }
                                  placeholder="e.g. Front brake pads"
                                  className={INPUT_CLASS}
                                  autoComplete="off"
                                  autoFocus
                                />
                                {renderCatalogSuggestions("name")}
                              </div>
                            </label>
                          </div>
                          <label className="mt-3 block">
                            <span className={LABEL_CLASS}>Item description</span>
                            <input
                              type="text"
                              value={itemDraft.description}
                              onChange={(e) =>
                                setItemDraft((p) => (p ? { ...p, description: e.target.value } : p))
                              }
                              placeholder="e.g. OEM-style pads, includes fitting"
                              className={INPUT_CLASS}
                            />
                          </label>
                          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
                            <label className="block">
                              <span className={LABEL_CLASS}>Quantity</span>
                              <input
                                type="number"
                                min="0"
                                step="1"
                                value={itemDraft.quantity}
                                onChange={(e) =>
                                  setItemDraft((p) => (p ? { ...p, quantity: e.target.value } : p))
                                }
                                className={NUMBER_INPUT_CLASS}
                              />
                            </label>
                            <label className="block">
                              <span className={LABEL_CLASS}>Rate</span>
                              <input
                                type="number"
                                min="0"
                                step="0.01"
                                value={itemDraft.rate}
                                onChange={(e) => setItemDraft((p) => (p ? { ...p, rate: e.target.value } : p))}
                                className={NUMBER_INPUT_CLASS}
                              />
                            </label>
                            <label className="block">
                              <span className={LABEL_CLASS}>Discount (%)</span>
                              <input
                                type="number"
                                min="0"
                                max="100"
                                step="0.1"
                                value={itemDraft.discountPercent}
                                onChange={(e) =>
                                  setItemDraft((p) => (p ? { ...p, discountPercent: e.target.value } : p))
                                }
                                className={NUMBER_INPUT_CLASS}
                              />
                            </label>
                          </div>
                          {gstEnabled && (
                            <label className="mt-3 flex items-center gap-2 text-sm text-neutral-700">
                              <input
                                type="checkbox"
                                checked={itemDraft.applyGst}
                                onChange={(e) =>
                                  setItemDraft((p) => (p ? { ...p, applyGst: e.target.checked } : p))
                                }
                                className="rounded border-neutral-300"
                              />
                              Apply GST ({gstPercentage}%)
                            </label>
                          )}
                          <div className="mt-4 flex items-center justify-end gap-2">
                            <span className="mr-auto text-sm font-semibold text-neutral-900">
                              {formatAud(lineDraftPreview)}
                            </span>
                            <button
                              type="button"
                              onClick={() => {
                                setItemDraft(null);
                                setEditingItemId(null);
                              }}
                              className="rounded-lg px-4 py-2 text-sm font-semibold text-neutral-600 hover:bg-neutral-100"
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              onClick={commitItemDraft}
                              className="rounded-lg bg-neutral-900 px-5 py-2 text-sm font-semibold text-white hover:bg-neutral-800"
                            >
                              {editingItemId ? "Update" : "Add"}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={startAddItem}
                          className="mt-3 inline-flex items-center gap-2 text-sm font-semibold text-neutral-900 hover:text-neutral-600"
                        >
                          <i className="fas fa-plus" />
                          Add items
                        </button>
                      )}
                    </section>

                    {/* Attachments */}
                    <section className="rounded-xl border border-neutral-200 bg-white p-5">
                      <h2 className="text-sm font-bold text-neutral-900">Attachments</h2>
                      <p className="mt-1 text-xs text-neutral-500">Add photos or PDF documents (max 10 files).</p>
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/*,application/pdf,.pdf"
                        className="hidden"
                        onChange={uploadAttachment}
                      />
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={attachments.length >= 10}
                        className="mt-3 inline-flex items-center gap-2 text-sm font-semibold text-neutral-900 hover:text-neutral-600 disabled:opacity-50"
                      >
                        <i className="fas fa-paperclip" />
                        Add photos or PDFs
                      </button>
                      {attachments.length > 0 && (
                        <ul className="mt-3 flex flex-wrap gap-2">
                          {attachments.map((file, index) => (
                            <li key={`${file.name}-${index}`} className="relative">
                              {file.isPdf ? (
                                <div className="flex h-16 w-28 flex-col items-center justify-center gap-1 rounded-lg border border-neutral-200 bg-neutral-50 px-2">
                                  <i className="fas fa-file-pdf text-xl text-rose-500" />
                                  <span className="max-w-full truncate text-[9px] text-neutral-500">
                                    {file.name}
                                  </span>
                                </div>
                              ) : (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img
                                  src={file.url}
                                  alt={file.name}
                                  className="h-16 w-16 rounded-lg border border-neutral-200 object-cover"
                                />
                              )}
                              <button
                                type="button"
                                onClick={() => setAttachments((prev) => prev.filter((_, i) => i !== index))}
                                className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-neutral-900 text-white"
                                aria-label="Remove attachment"
                              >
                                <i className="fas fa-times text-[10px]" />
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </section>

                    {/* Terms */}
                    <section className="rounded-xl border border-neutral-200 bg-white p-5">
                      <h2 className="text-sm font-bold text-neutral-900">Terms and conditions</h2>
                      <p className="mt-1 text-xs text-neutral-500">
                        Payment terms, parts warranty, storage fees, etc.
                      </p>
                      <textarea
                        value={terms}
                        onChange={(e) => setTerms(e.target.value)}
                        rows={5}
                        maxLength={5000}
                        placeholder="e.g. Parts warranty 12 months / 20,000 km. Labour warranty 3 months. Payment due on collection."
                        className={`${INPUT_CLASS} mt-3 resize-y leading-relaxed`}
                      />
                    </section>

                    {/* Comments */}
                    <section className="rounded-xl border border-neutral-200 bg-white p-5">
                      <h2 className="text-sm font-bold text-neutral-900">Comments</h2>
                      <p className="mt-1 text-xs text-neutral-500">
                        Optional notes for the customer, shown on the document.
                      </p>
                      <textarea
                        value={comment}
                        onChange={(e) => setComment(e.target.value)}
                        rows={4}
                        maxLength={2000}
                        placeholder="e.g. Vehicle ready for collection after 3pm. Old parts available on request."
                        className={`${INPUT_CLASS} mt-3 resize-y leading-relaxed`}
                      />
                    </section>
                  </>
                )}

                {tab === "preview" && (
                  <div className="space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <p className="text-xs text-neutral-500">
                        Live HTML preview of the document. The emailed PDF is generated with the
                        same fields via pdf-lib.
                      </p>
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => printDocumentPreview()}
                          className="inline-flex items-center gap-2 rounded-lg border border-neutral-300 px-3 py-1.5 text-xs font-semibold text-neutral-700 transition hover:bg-neutral-100"
                        >
                          <i className="fas fa-print" />
                          Print
                        </button>
                        <button
                          type="button"
                          onClick={() => void openSavedPdfViewer()}
                          className="inline-flex items-center gap-2 rounded-lg border border-neutral-300 px-3 py-1.5 text-xs font-semibold text-neutral-700 transition hover:bg-neutral-100"
                        >
                          <i className="fas fa-file-pdf" />
                          View PDF
                        </button>
                      </div>
                    </div>

                    <div className="overflow-hidden rounded-xl border border-neutral-200 bg-neutral-100">
                      <div
                        className="overflow-auto"
                        style={{ maxHeight: "calc(100vh - 220px)", minHeight: 640 }}
                      >
                        <DocumentPreview data={documentData} />
                      </div>
                    </div>
                  </div>
                )}

                {tab === "send" && (
                  <div className="space-y-4">
                    <div className="rounded-xl border border-neutral-200 bg-white p-5">
                      <label className="block">
                        <span className={LABEL_CLASS}>To</span>
                        <input
                          type="email"
                          readOnly
                          value={customer.email}
                          placeholder="Add a client email in the Create tab"
                          className={`${INPUT_CLASS} bg-neutral-50`}
                        />
                      </label>
                      <label className="mt-3 block">
                        <span className={LABEL_CLASS}>Subject</span>
                        <input
                          type="text"
                          readOnly
                          value={config.emailSubject(businessName)}
                          className={`${INPUT_CLASS} bg-neutral-50`}
                        />
                      </label>
                      <label className="mt-3 block">
                        <span className={LABEL_CLASS}>Message</span>
                        <textarea
                          readOnly
                          rows={4}
                          value={`Thank you for your business. Please find your ${config.docLabel.toLowerCase()} attached.\n\nTotal: ${formatAud(total)}${
                            variant === "quotation" && depositRequested && depositAud > 0
                              ? `\nDeposit requested: ${formatAud(depositAud)}\nDeposit due: ${formatDate(depositDueDate)}`
                              : variant === "invoice" && paymentRecorded && amountPaidAud > 0
                                ? `\nAmount paid: ${formatAud(amountPaidAud)}\nBalance due: ${formatAud(balanceDueAud)}${
                                    balanceDueAud > 0
                                      ? `\nBalance due date: ${formatDate(balanceDueDate)}`
                                      : ""
                                  }`
                                : ""
                          }`}
                          className={`${INPUT_CLASS} resize-none bg-neutral-50`}
                        />
                      </label>
                    </div>
                    <p className="rounded-lg border border-dashed border-neutral-300 bg-neutral-50 px-4 py-3 text-xs leading-relaxed text-neutral-500">
                      Use <strong>{config.saveDraftLabel}</strong> anytime — even if the form is incomplete —
                      then reopen it from the list to finish later. When you click{" "}
                      <strong>{config.sendLabel}</strong>, the {config.docLabel.toLowerCase()} is emailed to the
                      client with a PDF attached. GST must be applied before sending. New customers also get a
                      booking engine account.
                    </p>
                    <button
                      type="button"
                      onClick={() => save(true)}
                      disabled={!customer.email.trim() || !!saving}
                      className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-neutral-900 px-4 py-3 text-sm font-semibold text-white transition hover:bg-neutral-800 disabled:opacity-50 sm:max-w-xs"
                    >
                      {saving === "send" ? (
                        <>
                          <i className="fas fa-spinner fa-spin" />
                          Sending…
                        </>
                      ) : (
                        <>
                          <i className="fas fa-paper-plane" />
                          {config.sendLabel}
                        </>
                      )}
                    </button>
                  </div>
                )}
              </div>

              {/* Summary sidebar */}
              <aside className="w-full shrink-0 border-t border-neutral-200 bg-neutral-50 p-6 lg:w-80 lg:border-l lg:border-t-0 xl:w-96">
                <div className="space-y-4">
                  <div className="rounded-xl border border-neutral-200 bg-white p-4 shadow-sm">
                    <div className="mb-3 flex items-center justify-between">
                      <p className="text-sm font-bold text-neutral-900">
                        {docCode ?? `Draft ${config.docLabel.toLowerCase()}`}
                      </p>
                      {docStatus === "sent" ? (
                        <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide text-emerald-700">
                          <span className="h-1 w-1 rounded-full bg-emerald-500" />
                          Sent
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide text-amber-700">
                          <span className="h-1 w-1 rounded-full bg-amber-500" />
                          Unsent
                        </span>
                      )}
                    </div>
                    <div className="space-y-3">
                      <label className="block">
                        <span className={LABEL_CLASS}>{config.dateLabel}</span>
                        <input
                          type="date"
                          value={documentDate}
                          onChange={(e) => setDocumentDate(e.target.value)}
                          className={INPUT_CLASS}
                        />
                      </label>
                      <label className="block">
                        <span className={LABEL_CLASS}>Payment terms</span>
                        <div className="relative">
                          <select
                            value={paymentTerms}
                            onChange={(e) => setPaymentTerms(e.target.value as TermsId)}
                            className={`${INPUT_CLASS} appearance-none pr-10`}
                          >
                            {TERMS_OPTIONS.map((opt) => (
                              <option key={opt.id} value={opt.id}>
                                {opt.label}
                              </option>
                            ))}
                          </select>
                          <i className="fas fa-chevron-down pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-neutral-500" />
                        </div>
                      </label>
                      <div className="flex items-center justify-between rounded-lg bg-neutral-100 px-3 py-2">
                        <span className="text-xs font-semibold text-neutral-500">{config.dueLabel}</span>
                        <span className="text-sm font-bold text-neutral-900">{formatDate(dueDate)}</span>
                      </div>
                    </div>
                  </div>

                  <div className="overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm">
                    <div className="space-y-2 px-4 py-3 text-sm">
                      <div className="flex justify-between text-neutral-600">
                        <span>Subtotal</span>
                        <span className="font-medium text-neutral-900">{formatAud(subtotal)}</span>
                      </div>
                      <div className="flex items-center justify-between gap-2 text-neutral-600">
                        <span>Discount</span>
                        <div className="flex items-center gap-2">
                          <div className="flex rounded-lg border border-neutral-300 p-0.5">
                            <button
                              type="button"
                              onClick={() => setDiscountMode("value")}
                              aria-pressed={discountMode === "value"}
                              className={`rounded-md px-2.5 py-1 text-xs font-semibold transition ${
                                discountMode === "value"
                                  ? "bg-neutral-900 text-white"
                                  : "text-neutral-500 hover:text-neutral-900"
                              }`}
                            >
                              AU$
                            </button>
                            <button
                              type="button"
                              onClick={() => setDiscountMode("percent")}
                              aria-pressed={discountMode === "percent"}
                              className={`rounded-md px-2.5 py-1 text-xs font-semibold transition ${
                                discountMode === "percent"
                                  ? "bg-neutral-900 text-white"
                                  : "text-neutral-500 hover:text-neutral-900"
                              }`}
                            >
                              %
                            </button>
                          </div>
                          {discountMode === "percent" ? (
                            <div className="relative w-24">
                              <input
                                type="text"
                                inputMode="decimal"
                                value={discountPercentBill || ""}
                                onChange={(e) =>
                                  setDiscountPercentBill(Math.min(100, parseNum(e.target.value)))
                                }
                                placeholder="0"
                                className="w-full rounded-lg border border-neutral-300 px-2 py-1 pr-6 text-right text-sm text-neutral-900 focus:ring-2 focus:ring-neutral-900 focus:border-transparent outline-none"
                              />
                              <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-neutral-400">
                                %
                              </span>
                            </div>
                          ) : (
                            <input
                              type="text"
                              inputMode="decimal"
                              value={discountAud || ""}
                              onChange={(e) => setDiscountAud(parseNum(e.target.value))}
                              placeholder="0.00"
                              className="w-24 rounded-lg border border-neutral-300 px-2 py-1 text-right text-sm text-neutral-900 focus:ring-2 focus:ring-neutral-900 focus:border-transparent outline-none"
                            />
                          )}
                        </div>
                      </div>
                      {discountMode === "percent" && cappedDiscount > 0 ? (
                        <div className="flex justify-between text-xs text-neutral-500">
                          <span>Discount ({Math.min(100, discountPercentBill)}%)</span>
                          <span>−{formatAud(cappedDiscount)}</span>
                        </div>
                      ) : null}

                      <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-2.5">
                        <button
                          type="button"
                          onClick={() => setGstEnabled((v) => !v)}
                          aria-pressed={gstEnabled}
                          className={`flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2.5 transition ${
                            gstEnabled ? "bg-neutral-900 text-white" : "bg-white hover:bg-neutral-100"
                          }`}
                        >
                          <span className="flex items-center gap-2.5">
                            <span
                              className={`flex h-8 w-8 items-center justify-center rounded-lg ${
                                gstEnabled ? "bg-white/10" : "bg-neutral-100"
                              }`}
                            >
                              <i className={`fas fa-receipt ${gstEnabled ? "text-white" : "text-neutral-600"}`} />
                            </span>
                            <span className="text-left">
                              <span className="block text-xs font-bold">Apply GST ({gstPercentage}%)</span>
                              <span
                                className={`block text-[10px] ${gstEnabled ? "text-white/65" : "text-neutral-500"}`}
                              >
                                {gstEnabled ? "GST is included in totals" : "Tap to add GST"}
                              </span>
                            </span>
                          </span>
                          <span
                            className={`flex h-6 w-6 items-center justify-center rounded-full border-2 transition ${
                              gstEnabled ? "border-white bg-white text-neutral-900" : "border-neutral-300"
                            }`}
                          >
                            {gstEnabled && <i className="fas fa-check text-[11px]" />}
                          </span>
                        </button>

                        {gstEnabled && (
                          <div className="mt-2.5">
                            <span className={LABEL_CLASS}>Prices are</span>
                            <div className="grid grid-cols-2 gap-1 rounded-lg bg-neutral-900 p-1">
                              {(["exclusive", "inclusive"] as GstPricing[]).map((mode) => (
                                <button
                                  key={mode}
                                  type="button"
                                  onClick={() => setGstPricing(mode)}
                                  className={`rounded-md px-2 py-1.5 text-[11px] font-semibold capitalize transition ${
                                    gstPricing === mode
                                      ? "bg-white text-neutral-900"
                                      : "text-white/75 hover:text-white"
                                  }`}
                                >
                                  {mode}
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>

                      {gstEnabled && (
                        <div className="flex justify-between text-neutral-600">
                          <span>
                            GST ({gstPercentage}%)
                            {cappedDiscount > 0 ? (
                              <span className="text-neutral-400"> on {formatAud(gstTaxableBase)}</span>
                            ) : null}
                          </span>
                          <span className="font-medium text-neutral-900">{formatAud(gstAmount)}</span>
                        </div>
                      )}

                      {variant === "quotation" ? (
                        <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-2.5">
                          <button
                            type="button"
                            onClick={() => {
                              setDepositRequested((v) => {
                                const next = !v;
                                if (next && !depositDueDate) setDepositDueDate(dueDate || todayIso());
                                return next;
                              });
                            }}
                            aria-pressed={depositRequested}
                            className={`flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2.5 transition ${
                              depositRequested
                                ? "bg-neutral-900 text-white"
                                : "bg-white hover:bg-neutral-100"
                            }`}
                          >
                            <span className="flex items-center gap-2.5">
                              <span
                                className={`flex h-8 w-8 items-center justify-center rounded-lg ${
                                  depositRequested ? "bg-white/10" : "bg-neutral-100"
                                }`}
                              >
                                <i
                                  className={`fas fa-hand-holding-dollar ${
                                    depositRequested ? "text-white" : "text-neutral-600"
                                  }`}
                                />
                              </span>
                              <span className="text-left">
                                <span className="block text-xs font-bold">Request deposit</span>
                                <span
                                  className={`block text-[10px] ${
                                    depositRequested ? "text-white/65" : "text-neutral-500"
                                  }`}
                                >
                                  {depositRequested
                                    ? "Shown on quote PDF and email"
                                    : "Optional deposit for this quote"}
                                </span>
                              </span>
                            </span>
                            <span
                              className={`flex h-6 w-6 items-center justify-center rounded-full border-2 transition ${
                                depositRequested
                                  ? "border-white bg-white text-neutral-900"
                                  : "border-neutral-300"
                              }`}
                            >
                              {depositRequested && <i className="fas fa-check text-[11px]" />}
                            </span>
                          </button>

                          {depositRequested ? (
                            <div className="mt-2.5 space-y-2">
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-xs font-semibold text-neutral-500">Amount</span>
                                <div className="flex items-center gap-2">
                                  <div className="flex rounded-lg border border-neutral-300 bg-white p-0.5">
                                    <button
                                      type="button"
                                      onClick={() => setDepositMode("value")}
                                      aria-pressed={depositMode === "value"}
                                      className={`rounded-md px-2.5 py-1 text-xs font-semibold transition ${
                                        depositMode === "value"
                                          ? "bg-neutral-900 text-white"
                                          : "text-neutral-500 hover:text-neutral-900"
                                      }`}
                                    >
                                      AU$
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => setDepositMode("percent")}
                                      aria-pressed={depositMode === "percent"}
                                      className={`rounded-md px-2.5 py-1 text-xs font-semibold transition ${
                                        depositMode === "percent"
                                          ? "bg-neutral-900 text-white"
                                          : "text-neutral-500 hover:text-neutral-900"
                                      }`}
                                    >
                                      %
                                    </button>
                                  </div>
                                  {depositMode === "percent" ? (
                                    <div className="relative w-24">
                                      <input
                                        type="text"
                                        inputMode="decimal"
                                        value={depositValue || ""}
                                        onChange={(e) =>
                                          setDepositValue(Math.min(100, parseNum(e.target.value)))
                                        }
                                        placeholder="0"
                                        className="w-full rounded-lg border border-neutral-300 bg-white px-2 py-1 pr-6 text-right text-sm text-neutral-900 focus:ring-2 focus:ring-neutral-900 focus:border-transparent outline-none"
                                      />
                                      <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-neutral-400">
                                        %
                                      </span>
                                    </div>
                                  ) : (
                                    <input
                                      type="text"
                                      inputMode="decimal"
                                      value={depositValue || ""}
                                      onChange={(e) => setDepositValue(parseNum(e.target.value))}
                                      placeholder="0.00"
                                      className="w-24 rounded-lg border border-neutral-300 bg-white px-2 py-1 text-right text-sm text-neutral-900 focus:ring-2 focus:ring-neutral-900 focus:border-transparent outline-none"
                                    />
                                  )}
                                </div>
                              </div>
                              <label className="flex items-center justify-between gap-2">
                                <span className="text-xs font-semibold text-neutral-500">
                                  Deposit due
                                </span>
                                <input
                                  type="date"
                                  value={depositDueDate}
                                  onChange={(e) => setDepositDueDate(e.target.value)}
                                  className="w-36 rounded-lg border border-neutral-300 bg-white px-2 py-1 text-right text-sm text-neutral-900 focus:ring-2 focus:ring-neutral-900 focus:border-transparent outline-none"
                                />
                              </label>
                              {depositAud > 0 ? (
                                <div className="flex justify-between text-xs text-neutral-500">
                                  <span>
                                    Deposit requested
                                    {depositMode === "percent"
                                      ? ` (${Math.min(100, depositValue)}%)`
                                      : ""}
                                  </span>
                                  <span className="font-medium text-neutral-900">
                                    {formatAud(depositAud)}
                                  </span>
                                </div>
                              ) : null}
                            </div>
                          ) : null}
                        </div>
                      ) : null}

                      {variant === "invoice" ? (
                        <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-2.5">
                          <button
                            type="button"
                            onClick={() => {
                              setPaymentRecorded((v) => {
                                const next = !v;
                                if (next && !balanceDueDate) {
                                  setBalanceDueDate(dueDate || todayIso());
                                }
                                return next;
                              });
                            }}
                            aria-pressed={paymentRecorded}
                            className={`flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2.5 transition ${
                              paymentRecorded
                                ? "bg-neutral-900 text-white"
                                : "bg-white hover:bg-neutral-100"
                            }`}
                          >
                            <span className="flex items-center gap-2.5">
                              <span
                                className={`flex h-8 w-8 items-center justify-center rounded-lg ${
                                  paymentRecorded ? "bg-white/10" : "bg-neutral-100"
                                }`}
                              >
                                <i
                                  className={`fas fa-money-bill-wave ${
                                    paymentRecorded ? "text-white" : "text-neutral-600"
                                  }`}
                                />
                              </span>
                              <span className="text-left">
                                <span className="block text-xs font-bold">Record payment</span>
                                <span
                                  className={`block text-[10px] ${
                                    paymentRecorded ? "text-white/65" : "text-neutral-500"
                                  }`}
                                >
                                  {paymentRecorded
                                    ? "Shown on invoice PDF and email"
                                    : "Optional amount already paid"}
                                </span>
                              </span>
                            </span>
                            <span
                              className={`flex h-6 w-6 items-center justify-center rounded-full border-2 transition ${
                                paymentRecorded
                                  ? "border-white bg-white text-neutral-900"
                                  : "border-neutral-300"
                              }`}
                            >
                              {paymentRecorded && <i className="fas fa-check text-[11px]" />}
                            </span>
                          </button>

                          {paymentRecorded ? (
                            <div className="mt-2.5 space-y-2">
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-xs font-semibold text-neutral-500">
                                  Amount paid
                                </span>
                                <input
                                  type="text"
                                  inputMode="decimal"
                                  value={amountPaidInput || ""}
                                  onChange={(e) => setAmountPaidInput(parseNum(e.target.value))}
                                  placeholder="0.00"
                                  className="w-28 rounded-lg border border-neutral-300 bg-white px-2 py-1 text-right text-sm text-neutral-900 focus:ring-2 focus:ring-neutral-900 focus:border-transparent outline-none"
                                />
                              </div>
                              {balanceDueAud > 0 ? (
                                <label className="flex items-center justify-between gap-2">
                                  <span className="text-xs font-semibold text-neutral-500">
                                    Balance due date
                                  </span>
                                  <input
                                    type="date"
                                    value={balanceDueDate}
                                    onChange={(e) => setBalanceDueDate(e.target.value)}
                                    className="w-36 rounded-lg border border-neutral-300 bg-white px-2 py-1 text-right text-sm text-neutral-900 focus:ring-2 focus:ring-neutral-900 focus:border-transparent outline-none"
                                  />
                                </label>
                              ) : null}
                              {amountPaidAud > 0 ? (
                                <>
                                  <div className="flex justify-between text-xs text-neutral-500">
                                    <span>Amount paid</span>
                                    <span className="font-medium text-neutral-900">
                                      {formatAud(amountPaidAud)}
                                    </span>
                                  </div>
                                  <div className="flex justify-between rounded-md bg-amber-50 px-2 py-1.5 text-xs font-semibold text-amber-900">
                                    <span>Balance due</span>
                                    <span>{formatAud(balanceDueAud)}</span>
                                  </div>
                                </>
                              ) : null}
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                    <div className="flex items-center justify-between bg-neutral-900 px-4 py-3">
                      <span className="text-xs font-bold text-white">
                        {variant === "quotation"
                          ? "Total estimate"
                          : paymentRecorded && amountPaidAud > 0
                            ? "Total"
                            : "Total due"}
                      </span>
                      <span className="text-base font-bold text-white">{formatAud(total)}</span>
                    </div>
                    {variant === "quotation" && depositRequested && depositAud > 0 ? (
                      <div className="space-y-1.5 border-t border-neutral-800 bg-neutral-900 px-4 pb-3">
                        <div className="flex justify-between text-xs text-white/70">
                          <span>Deposit requested</span>
                          <span className="font-semibold text-white">{formatAud(depositAud)}</span>
                        </div>
                        <div className="flex justify-between text-xs text-white/70">
                          <span>Deposit due</span>
                          <span className="font-semibold text-white">{formatDate(depositDueDate)}</span>
                        </div>
                      </div>
                    ) : null}
                    {variant === "invoice" && paymentRecorded && amountPaidAud > 0 ? (
                      <div className="space-y-1.5 border-t border-neutral-800 bg-neutral-900 px-4 pb-3">
                        <div className="flex justify-between text-xs text-white/70">
                          <span>Amount paid</span>
                          <span className="font-semibold text-white">{formatAud(amountPaidAud)}</span>
                        </div>
                        <div className="flex justify-between rounded-md bg-amber-400/20 px-2 py-1.5 text-xs font-semibold text-amber-200">
                          <span>Balance due</span>
                          <span>{formatAud(balanceDueAud)}</span>
                        </div>
                        {balanceDueAud > 0 ? (
                          <div className="flex justify-between text-xs text-white/70">
                            <span>Balance due date</span>
                            <span className="font-semibold text-white">
                              {formatDate(balanceDueDate)}
                            </span>
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>

                  <button
                    type="button"
                    onClick={() => setTab("send")}
                    className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-neutral-900 px-4 py-3 text-sm font-semibold text-white transition hover:bg-neutral-800"
                  >
                    <i className="fas fa-paper-plane" />
                    Continue to send
                  </button>
                </div>
              </aside>
            </div>
          </div>
        </main>
      </div>

      {quotationPickerOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => {
              if (!importingQuotation) setQuotationPickerOpen(false);
            }}
          />
          <div className="relative z-10 flex max-h-[85vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-neutral-200 px-5 py-4">
              <div>
                <h2 className="text-base font-bold text-neutral-900">Import from quotation</h2>
                <p className="mt-0.5 text-sm text-neutral-500">
                  Choose a quotation to prefill this invoice.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setQuotationPickerOpen(false)}
                disabled={importingQuotation}
                className="flex h-9 w-9 items-center justify-center rounded-lg text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-900 disabled:opacity-60"
                aria-label="Close"
              >
                <i className="fas fa-xmark" />
              </button>
            </div>
            <div className="border-b border-neutral-100 px-5 py-3">
              <div className="relative">
                <i className="fas fa-search pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-xs text-neutral-400" />
                <input
                  type="text"
                  value={quotationSearch}
                  onChange={(e) => setQuotationSearch(e.target.value)}
                  placeholder="Search by code, customer, or job…"
                  className={`${INPUT_CLASS} pl-10`}
                  autoFocus
                />
              </div>
            </div>
            <div className="flex-1 overflow-y-auto">
              {quotationLoading ? (
                <div className="flex items-center justify-center gap-2 px-5 py-12 text-sm text-neutral-500">
                  <i className="fas fa-spinner fa-spin" />
                  Loading quotations…
                </div>
              ) : filteredQuotations.length === 0 ? (
                <div className="px-5 py-12 text-center text-sm text-neutral-500">
                  {quotationSearch.trim()
                    ? "No matching quotations."
                    : "No quotations found. Create a quotation first."}
                </div>
              ) : (
                <ul className="divide-y divide-neutral-100">
                  {filteredQuotations.map((row) => (
                    <li key={row.id}>
                      <button
                        type="button"
                        onClick={() => importQuotation(row.id)}
                        disabled={importingQuotation}
                        className="flex w-full items-start justify-between gap-3 px-5 py-3.5 text-left transition hover:bg-neutral-50 disabled:opacity-60"
                      >
                        <span className="min-w-0">
                          <span className="block font-semibold text-neutral-900">
                            {row.code || "Untitled quotation"}
                          </span>
                          <span className="mt-0.5 block truncate text-sm text-neutral-600">
                            {row.customer?.fullName || "No customer"}
                            {row.jobTitle ? ` · ${row.jobTitle}` : ""}
                          </span>
                          <span className="mt-0.5 block text-xs text-neutral-400">
                            {row.documentDate
                              ? formatDate(row.documentDate)
                              : "No date"}{" "}
                            · {row.status === "sent" ? "Sent" : "Draft"}
                          </span>
                        </span>
                        <span className="shrink-0 text-sm font-semibold text-neutral-900">
                          {formatAud(row.totalAud ?? 0)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {importingQuotation && (
              <div className="border-t border-neutral-200 px-5 py-3 text-sm text-neutral-600">
                <i className="fas fa-spinner fa-spin mr-2" />
                Loading quotation…
              </div>
            )}
          </div>
        </div>
      )}

      <SalesDocumentPdfViewer
        open={pdfViewerOpen && !!livePdfBytes}
        title={`${config.docLabel} ${docCode || "Draft"}`.trim()}
        pdfBytes={livePdfBytes}
        fetchHeaders={pdfAuthHeaders}
        filename={`${config.docLabel}-${docCode || "draft"}.pdf`}
        onClose={() => {
          setPdfViewerOpen(false);
          setLivePdfBytes(null);
        }}
      />
    </div>
  );
}
