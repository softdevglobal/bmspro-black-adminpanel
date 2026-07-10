"use client";

import Link from "next/link";
import Sidebar from "@/components/Sidebar";
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
  paymentTermsId?: string;
  terms?: string;
  comment?: string;
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

  const [mobileOpen, setMobileOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("create");
  const [error, setError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState<false | "draft" | "send">(false);
  const [docCode, setDocCode] = useState<string | null>(null);
  const [docStatus, setDocStatus] = useState<string>("draft");
  const [docId, setDocId] = useState<string | null>(editingDocId);
  const [downloadingPdf, setDownloadingPdf] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const previewUrlRef = useRef<string | null>(null);

  const [clientOpen, setClientOpen] = useState(false);
  const [customer, setCustomer] = useState({ fullName: "", email: "", phone: "" });
  const [address, setAddress] = useState<Address>({ street: "", suburb: "", state: "", postcode: "" });

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
  const [gstEnabled, setGstEnabled] = useState(false);
  const [gstPercentage] = useState(10);
  const [gstPricing, setGstPricing] = useState<GstPricing>("exclusive");

  const [businessName, setBusinessName] = useState("Your business");

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
          const data = (await res.json()) as { ok?: boolean; businessName?: string };
          if (res.ok && data.ok && data.businessName) setBusinessName(data.businessName);
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
              const doc = data.document;
              setDocCode(doc.code || null);
              setDocStatus(doc.status || "draft");
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
              if (doc.documentDate) setDocumentDate(doc.documentDate);
              const termsId = TERMS_OPTIONS.find((t) => t.id === doc.paymentTermsId)?.id;
              if (termsId) setPaymentTerms(termsId);
              setTerms(doc.terms ?? "");
              setComment(doc.comment ?? "");
            } else {
              setError(`Could not load the ${config.docLabel.toLowerCase()} for editing.`);
            }
          } catch {
            setError(`Could not load the ${config.docLabel.toLowerCase()} for editing.`);
          }
        }
      });
    })();
    return () => {
      if (unsub) unsub();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router, editingDocId, config.apiBase]);

  // Render the live creative PDF whenever the Preview tab is opened, so the
  // preview always matches the PDF that will be attached to the email.
  useEffect(() => {
    if (tab !== "preview") return;
    void loadPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  useEffect(() => {
    return () => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    };
  }, []);

  const dueDate = useMemo(() => {
    const opt = TERMS_OPTIONS.find((t) => t.id === paymentTerms);
    return addDaysIso(documentDate, opt?.days ?? 0);
  }, [documentDate, paymentTerms]);

  const subtotal = useMemo(
    () => lineItems.reduce((sum, item) => sum + computeLineNet(item), 0),
    [lineItems],
  );

  const cappedDiscount = useMemo(() => Math.min(discountAud, subtotal), [discountAud, subtotal]);

  const gstAmount = useMemo(() => {
    if (!gstEnabled) return 0;
    const gstItemsNet = lineItems
      .filter((item) => item.applyGst)
      .reduce((sum, item) => sum + computeLineNet(item), 0);
    const discountRatio = subtotal > 0 ? cappedDiscount / subtotal : 0;
    const taxable = gstItemsNet * (1 - discountRatio);
    if (gstPricing === "inclusive") {
      return Math.round((taxable - taxable / (1 + gstPercentage / 100)) * 100) / 100;
    }
    return Math.round(taxable * (gstPercentage / 100) * 100) / 100;
  }, [gstEnabled, lineItems, subtotal, cappedDiscount, gstPricing, gstPercentage]);

  const total = useMemo(() => {
    const net = subtotal - cappedDiscount;
    if (!gstEnabled) return Math.round(net * 100) / 100;
    if (gstPricing === "inclusive") return Math.round(net * 100) / 100;
    return Math.round((net + gstAmount) * 100) / 100;
  }, [subtotal, cappedDiscount, gstEnabled, gstPricing, gstAmount]);

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

  function validate(): string | null {
    // Client
    if (!clientOpen || customer.fullName.trim().length < 2) return "Add a client name.";
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
    if (discountAud < 0) return "Discount cannot be negative.";
    if (discountAud > subtotal) return "Discount cannot exceed the subtotal.";
    if (total <= 0) return "The total must be greater than zero.";

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
    };
  }

  async function loadPreview() {
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const { auth } = await import("@/lib/firebase");
      const user = auth.currentUser;
      if (!user) {
        router.replace("/login");
        return;
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
        setPreviewError(`Could not generate the ${config.docLabel.toLowerCase()} preview.`);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = url;
      setPreviewUrl(url);
    } catch {
      setPreviewError(`Could not generate the ${config.docLabel.toLowerCase()} preview.`);
    } finally {
      setPreviewLoading(false);
    }
  }

  async function save(send: boolean) {
    if (saving) return;
    const validationError = validate();
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

      const url = editingDocId ? `${config.apiBase}/${editingDocId}` : config.apiBase;
      const res = await fetch(url, {
        method: editingDocId ? "PATCH" : "POST",
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
        emailSent?: boolean;
        customerAccountCreated?: boolean;
      };

      if (!res.ok || !data.ok) {
        setError(data.error || `Could not save the ${config.docLabel.toLowerCase()}.`);
        return;
      }

      if (data.document) {
        setDocCode(data.document.code || null);
        setDocStatus(data.document.status || "draft");
        if (data.document.id) setDocId(data.document.id);
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

  async function downloadPdf() {
    if (!docId || downloadingPdf) return;
    setDownloadingPdf(true);
    setError(null);
    try {
      const { auth } = await import("@/lib/firebase");
      const user = auth.currentUser;
      if (!user) {
        router.replace("/login");
        return;
      }
      const token = await user.getIdToken();
      const res = await fetch(`${config.apiBase}/${docId}/pdf`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      if (!res.ok) {
        setError(`Could not generate the ${config.docLabel.toLowerCase()} PDF.`);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank", "noopener,noreferrer");
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      setError(`Could not generate the ${config.docLabel.toLowerCase()} PDF.`);
    } finally {
      setDownloadingPdf(false);
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
                    {docCode ? `${config.docLabel} ${docCode}` : config.pageTitle}
                  </h1>
                </div>
                <p className="text-sm text-neutral-400 mt-2">{config.heroSubtitle}</p>
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
              <div className="flex shrink-0 items-center gap-2">
                <Link
                  href={config.listHref}
                  className="hidden rounded-lg px-3 py-2 text-sm font-semibold text-neutral-600 transition hover:bg-neutral-100 sm:inline"
                >
                  Close
                </Link>
                {docId && (
                  <button
                    type="button"
                    onClick={downloadPdf}
                    disabled={downloadingPdf}
                    className="inline-flex items-center gap-2 rounded-lg border border-neutral-300 px-4 py-2 text-sm font-semibold text-neutral-700 transition hover:bg-neutral-100 disabled:opacity-60"
                  >
                    <i className={`fas ${downloadingPdf ? "fa-spinner fa-spin" : "fa-file-pdf"}`} />
                    PDF
                  </button>
                )}
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
                            onClick={() => {
                              setCustomer({ fullName: "", email: "", phone: "" });
                              setAddress({ street: "", suburb: "", state: "", postcode: "" });
                              setClientOpen(false);
                            }}
                            className="text-xs font-semibold text-neutral-500 hover:text-rose-600"
                          >
                            Remove
                          </button>
                        </div>
                        <div className="grid gap-4 sm:grid-cols-2">
                          <label className="block sm:col-span-2">
                            <span className={LABEL_CLASS}>Client name</span>
                            <input
                              type="text"
                              value={customer.fullName}
                              onChange={(e) => setCustomer((p) => ({ ...p, fullName: e.target.value }))}
                              placeholder="e.g. John Smith"
                              className={INPUT_CLASS}
                            />
                          </label>
                          <label className="block">
                            <span className={LABEL_CLASS}>Mobile</span>
                            <div className="flex">
                              <span className="inline-flex items-center rounded-l-lg border border-r-0 border-neutral-300 bg-neutral-100 px-3.5 text-sm font-mono text-neutral-500">
                                +61
                              </span>
                              <input
                                type="tel"
                                inputMode="numeric"
                                value={customer.phone}
                                onChange={(e) =>
                                  setCustomer((p) => ({
                                    ...p,
                                    phone: toAuLocalPhone(e.target.value),
                                  }))
                                }
                                placeholder="412 345 678"
                                className={`${INPUT_CLASS} rounded-l-none`}
                              />
                            </div>
                          </label>
                          <label className="block">
                            <span className={LABEL_CLASS}>Email</span>
                            <input
                              type="email"
                              value={customer.email}
                              onChange={(e) => setCustomer((p) => ({ ...p, email: e.target.value }))}
                              placeholder="name@email.com"
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
                                className={INPUT_CLASS}
                              />
                            </label>
                            <label className="block">
                              <span className={LABEL_CLASS}>Suburb</span>
                              <input
                                type="text"
                                value={address.suburb}
                                onChange={(e) => setAddress((p) => ({ ...p, suburb: e.target.value }))}
                                className={INPUT_CLASS}
                              />
                            </label>
                            <label className="block">
                              <span className={LABEL_CLASS}>State</span>
                              <input
                                type="text"
                                value={address.state}
                                onChange={(e) => setAddress((p) => ({ ...p, state: e.target.value }))}
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
                        Describe the work for this {config.docLabel.toLowerCase()}.
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
                            placeholder="e.g. Replace kitchen tap and check leak"
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
                            placeholder="Tell us the scope, materials involved, urgency, etc."
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
                                  placeholder="e.g. TAP-001"
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
                        Payment terms, warranty, cancellation policy, etc.
                      </p>
                      <textarea
                        value={terms}
                        onChange={(e) => setTerms(e.target.value)}
                        rows={5}
                        maxLength={5000}
                        placeholder="Add your terms and conditions…"
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
                        placeholder={`Add a comment for this ${config.docLabel.toLowerCase()}…`}
                        className={`${INPUT_CLASS} mt-3 resize-y leading-relaxed`}
                      />
                    </section>
                  </>
                )}

                {tab === "preview" && (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-xs text-neutral-500">
                        This is the exact PDF that will be attached to the customer&apos;s email.
                      </p>
                      <button
                        type="button"
                        onClick={() => loadPreview()}
                        disabled={previewLoading}
                        className="inline-flex items-center gap-2 rounded-lg border border-neutral-300 px-3 py-1.5 text-xs font-semibold text-neutral-700 transition hover:bg-neutral-100 disabled:opacity-60"
                      >
                        <i className={`fas ${previewLoading ? "fa-spinner fa-spin" : "fa-rotate-right"}`} />
                        Refresh
                      </button>
                    </div>

                    <div className="relative overflow-hidden rounded-xl border border-neutral-200 bg-neutral-100">
                      {previewLoading && (
                        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-white/80 text-sm text-neutral-500">
                          <i className="fas fa-spinner fa-spin text-xl" />
                          Building your {config.docLabel.toLowerCase()} PDF…
                        </div>
                      )}
                      {previewError ? (
                        <div className="flex flex-col items-center justify-center gap-3 px-6 py-20 text-center">
                          <i className="fas fa-triangle-exclamation text-2xl text-amber-500" />
                          <p className="text-sm text-neutral-600">{previewError}</p>
                          <button
                            type="button"
                            onClick={() => loadPreview()}
                            className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-neutral-800"
                          >
                            Try again
                          </button>
                        </div>
                      ) : previewUrl ? (
                        <iframe
                          src={previewUrl}
                          title={`${config.docLabel} preview`}
                          className="w-full block"
                          style={{ height: "calc(100vh - 220px)", minHeight: 640 }}
                        />
                      ) : (
                        !previewLoading && (
                          <div className="px-6 py-20 text-center text-sm text-neutral-400">
                            Preparing preview…
                          </div>
                        )
                      )}
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
                          value={`Thank you for your business. Please find your ${config.docLabel.toLowerCase()} attached.\n\nTotal: ${formatAud(total)}`}
                          className={`${INPUT_CLASS} resize-none bg-neutral-50`}
                        />
                      </label>
                    </div>
                    <p className="rounded-lg border border-dashed border-neutral-300 bg-neutral-50 px-4 py-3 text-xs leading-relaxed text-neutral-500">
                      Use <strong>{config.saveDraftLabel}</strong> to keep a draft. When you click{" "}
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
                      <label className="flex items-center justify-between gap-2 text-neutral-600">
                        <span>Discount (AU$)</span>
                        <input
                          type="text"
                          inputMode="decimal"
                          value={discountAud || ""}
                          onChange={(e) => setDiscountAud(parseNum(e.target.value))}
                          placeholder="0.00"
                          className="w-24 rounded-lg border border-neutral-300 px-2 py-1 text-right text-sm text-neutral-900 focus:ring-2 focus:ring-neutral-900 focus:border-transparent outline-none"
                        />
                      </label>

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
                          <span>GST ({gstPercentage}%)</span>
                          <span className="font-medium text-neutral-900">{formatAud(gstAmount)}</span>
                        </div>
                      )}
                    </div>
                    <div className="flex items-center justify-between bg-neutral-900 px-4 py-3">
                      <span className="text-xs font-bold text-white">Total due</span>
                      <span className="text-base font-bold text-white">{formatAud(total)}</span>
                    </div>
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
    </div>
  );
}
