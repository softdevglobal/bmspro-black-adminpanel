"use client";

import Link from "next/link";
import Sidebar from "@/components/Sidebar";
import { useRouter } from "next/navigation";
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
    emailSubject: (business) => `Invoice from ${business}`,
  },
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

function computeLineNet(item: Pick<LineItem, "quantity" | "rate" | "discountPercent">): number {
  const base = item.quantity * item.rate * (1 - item.discountPercent / 100);
  return Math.round(base * 100) / 100;
}

export default function DocumentCreatePage({ variant }: { variant: Variant }) {
  const config = VARIANT_CONFIG[variant];
  const router = useRouter();

  const [mobileOpen, setMobileOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("create");
  const [error, setError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);

  const [clientOpen, setClientOpen] = useState(false);
  const [customer, setCustomer] = useState({ fullName: "", email: "", phone: "" });
  const [address, setAddress] = useState<Address>({ street: "", suburb: "", state: "", postcode: "" });

  const [jobTitle, setJobTitle] = useState("");
  const [jobDescription, setJobDescription] = useState("");

  const [lineItems, setLineItems] = useState<LineItem[]>([]);
  const [itemDraft, setItemDraft] = useState<DraftLineItem | null>(null);
  const [editingItemId, setEditingItemId] = useState<string | null>(null);

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

  const businessName = "Your business";

  useEffect(() => {
    let unsub: (() => void) | undefined;
    (async () => {
      const { auth } = await import("@/lib/firebase");
      unsub = onAuthStateChanged(auth, (user) => {
        if (!user) router.replace("/login");
      });
    })();
    return () => {
      if (unsub) unsub();
    };
  }, [router]);

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

  function commitItemDraft() {
    if (!itemDraft) return;
    const name = itemDraft.name.trim();
    const rate = parseNum(itemDraft.rate);
    if (!name || rate <= 0) {
      setError("Enter an item name and rate.");
      return;
    }
    const saved: LineItem = {
      id: editingItemId ?? (crypto.randomUUID?.() ?? String(Date.now())),
      code: itemDraft.code.trim(),
      name,
      description: itemDraft.description.trim(),
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
    setError(null);
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
    if (customer.fullName.trim().length < 2) return "Add a client name.";
    if (!EMAIL_REGEX.test(customer.email.trim())) return "Enter a valid client email.";
    if (customer.phone.replace(/\D/g, "").length < 6) return "Enter a valid client mobile number.";
    if (jobTitle.trim().length < 3) return "Add a job title (at least 3 characters).";
    if (lineItems.length === 0) return "Add at least one line item.";
    return null;
  }

  function save(send: boolean) {
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
    setError(null);
    setSavedNotice(
      send
        ? `${config.docLabel} sent to ${customer.email.trim()}. (Front-end demo — no data was saved.)`
        : `${config.docLabel} draft saved. (Front-end demo — no data was saved.)`,
    );
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
                  <h1 className="text-2xl font-bold">{config.pageTitle}</h1>
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
                <button
                  type="button"
                  onClick={() => save(false)}
                  className="rounded-lg bg-neutral-900 px-5 py-2 text-sm font-semibold text-white transition hover:bg-neutral-800"
                >
                  {config.saveDraftLabel}
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
                            <input
                              type="tel"
                              value={customer.phone}
                              onChange={(e) => setCustomer((p) => ({ ...p, phone: e.target.value }))}
                              placeholder="04xx xxx xxx"
                              className={INPUT_CLASS}
                            />
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
                              <input
                                type="text"
                                value={itemDraft.code}
                                onChange={(e) => setItemDraft((p) => (p ? { ...p, code: e.target.value } : p))}
                                placeholder="e.g. TAP-001"
                                className={INPUT_CLASS}
                              />
                            </label>
                            <label className="block">
                              <span className={LABEL_CLASS}>Item name</span>
                              <input
                                type="text"
                                value={itemDraft.name}
                                onChange={(e) => setItemDraft((p) => (p ? { ...p, name: e.target.value } : p))}
                                className={INPUT_CLASS}
                                autoFocus
                              />
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
                                className={INPUT_CLASS}
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
                                className={INPUT_CLASS}
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
                                className={INPUT_CLASS}
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
                  <div className="rounded-xl border border-neutral-200 bg-white p-6 sm:p-8">
                    <div className="flex items-start justify-between gap-4 border-b border-neutral-200 pb-6">
                      <div>
                        <p className="text-lg font-bold text-neutral-900">{businessName}</p>
                        <p className="text-xs text-neutral-500">BMS PRO Workshop</p>
                      </div>
                      <div className="text-right">
                        <p className="text-xs font-semibold uppercase tracking-wider text-neutral-400">
                          {config.docLabel}
                        </p>
                        <p className="text-sm font-bold text-neutral-900">Draft</p>
                        <p className="mt-1 text-xs text-neutral-500">
                          {config.dateLabel}: {formatDate(documentDate)}
                        </p>
                        <p className="text-xs text-neutral-500">
                          {config.dueLabel}: {formatDate(dueDate)}
                        </p>
                      </div>
                    </div>

                    <div className="grid gap-4 py-6 sm:grid-cols-2">
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-wider text-neutral-400">Bill to</p>
                        <p className="mt-1 text-sm font-semibold text-neutral-900">
                          {customer.fullName || "—"}
                        </p>
                        {customer.email && <p className="text-xs text-neutral-500">{customer.email}</p>}
                        {customer.phone && <p className="text-xs text-neutral-500">{customer.phone}</p>}
                        {(address.street || address.suburb || address.state || address.postcode) && (
                          <p className="mt-1 text-xs text-neutral-500">
                            {[address.street, address.suburb, address.state, address.postcode]
                              .filter(Boolean)
                              .join(", ")}
                          </p>
                        )}
                      </div>
                      {jobTitle && (
                        <div>
                          <p className="text-xs font-semibold uppercase tracking-wider text-neutral-400">Job</p>
                          <p className="mt-1 text-sm font-semibold text-neutral-900">{jobTitle}</p>
                          {jobDescription && (
                            <p className="mt-1 text-xs text-neutral-500">{jobDescription}</p>
                          )}
                        </div>
                      )}
                    </div>

                    <table className="w-full text-left text-sm">
                      <thead className="border-y border-neutral-200 bg-neutral-50 text-xs uppercase tracking-wider text-neutral-500">
                        <tr>
                          <th className="py-2.5 pl-3 font-semibold">Item</th>
                          <th className="py-2.5 text-right font-semibold">Qty</th>
                          <th className="py-2.5 text-right font-semibold">Rate</th>
                          <th className="py-2.5 pr-3 text-right font-semibold">Amount</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-neutral-100">
                        {lineItems.length === 0 ? (
                          <tr>
                            <td colSpan={4} className="py-6 text-center text-sm text-neutral-400">
                              No items added yet.
                            </td>
                          </tr>
                        ) : (
                          lineItems.map((item) => (
                            <tr key={item.id}>
                              <td className="py-3 pl-3">
                                <p className="font-medium text-neutral-900">{item.name}</p>
                                {item.description && (
                                  <p className="text-xs text-neutral-500">{item.description}</p>
                                )}
                              </td>
                              <td className="py-3 text-right text-neutral-700">{item.quantity}</td>
                              <td className="py-3 text-right text-neutral-700">{formatAud(item.rate)}</td>
                              <td className="py-3 pr-3 text-right font-medium text-neutral-900">
                                {formatAud(computeLineNet(item))}
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>

                    <div className="mt-6 ml-auto max-w-xs space-y-1.5 text-sm">
                      <div className="flex justify-between text-neutral-600">
                        <span>Subtotal</span>
                        <span className="text-neutral-900">{formatAud(subtotal)}</span>
                      </div>
                      {cappedDiscount > 0 && (
                        <div className="flex justify-between text-neutral-600">
                          <span>Discount</span>
                          <span className="text-neutral-900">−{formatAud(cappedDiscount)}</span>
                        </div>
                      )}
                      {gstEnabled && (
                        <div className="flex justify-between text-neutral-600">
                          <span>GST ({gstPercentage}%)</span>
                          <span className="text-neutral-900">{formatAud(gstAmount)}</span>
                        </div>
                      )}
                      <div className="flex justify-between border-t border-neutral-200 pt-2 text-base font-bold text-neutral-900">
                        <span>Total</span>
                        <span>{formatAud(total)}</span>
                      </div>
                    </div>

                    {comment && (
                      <div className="mt-6 border-t border-neutral-200 pt-4">
                        <p className="text-xs font-semibold uppercase tracking-wider text-neutral-400">Notes</p>
                        <p className="mt-1 whitespace-pre-line text-sm text-neutral-600">{comment}</p>
                      </div>
                    )}
                    {terms && (
                      <div className="mt-4">
                        <p className="text-xs font-semibold uppercase tracking-wider text-neutral-400">
                          Terms and conditions
                        </p>
                        <p className="mt-1 whitespace-pre-line text-xs text-neutral-500">{terms}</p>
                      </div>
                    )}
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
                      Use <strong>{config.saveDraftLabel}</strong> to keep a draft. The {config.docLabel.toLowerCase()} is
                      emailed to the client only when you click <strong>{config.sendLabel}</strong> below.
                    </p>
                    <button
                      type="button"
                      onClick={() => save(true)}
                      disabled={!customer.email.trim()}
                      className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-neutral-900 px-4 py-3 text-sm font-semibold text-white transition hover:bg-neutral-800 disabled:opacity-50 sm:max-w-xs"
                    >
                      <i className="fas fa-paper-plane" />
                      {config.sendLabel}
                    </button>
                  </div>
                )}
              </div>

              {/* Summary sidebar */}
              <aside className="w-full shrink-0 border-t border-neutral-200 bg-neutral-50 p-6 lg:w-80 lg:border-l lg:border-t-0 xl:w-96">
                <div className="space-y-4">
                  <div className="rounded-xl border border-neutral-200 bg-white p-4 shadow-sm">
                    <div className="mb-3 flex items-center justify-between">
                      <p className="text-sm font-bold text-neutral-900">Draft {config.docLabel.toLowerCase()}</p>
                      <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide text-amber-700">
                        <span className="h-1 w-1 rounded-full bg-amber-500" />
                        Unsent
                      </span>
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
                        <select
                          value={paymentTerms}
                          onChange={(e) => setPaymentTerms(e.target.value as TermsId)}
                          className={INPUT_CLASS}
                        >
                          {TERMS_OPTIONS.map((opt) => (
                            <option key={opt.id} value={opt.id}>
                              {opt.label}
                            </option>
                          ))}
                        </select>
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
                          type="number"
                          min="0"
                          step="0.01"
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
