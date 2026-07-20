"use client";

import Link from "next/link";
import React, { useEffect, useState } from "react";
import SalesDocumentPdfViewer from "@/components/documents/SalesDocumentPdfViewer";

type Variant = "quotation" | "invoice";

export type DocumentDetail = {
  id: string;
  code: string;
  status: string;
  customer?: { fullName?: string; email?: string; phone?: string };
  address?: { street?: string; suburb?: string; state?: string; postcode?: string };
  jobTitle?: string;
  jobDescription?: string;
  lineItems?: Array<{
    code?: string;
    name?: string;
    description?: string;
    quantity?: number;
    rate?: number;
    discountPercent?: number;
    applyGst?: boolean;
  }>;
  discountAud?: number;
  gstEnabled?: boolean;
  gstAud?: number;
  subtotalAud?: number;
  totalAud?: number;
  documentDate?: string;
  dueDate?: string;
  paymentTermsLabel?: string;
  terms?: string;
  comment?: string;
  depositRequested?: boolean;
  depositAud?: number;
  balanceAud?: number;
  depositDueDate?: string;
  paymentRecorded?: boolean;
  amountPaidAud?: number;
  balanceDueAud?: number;
  balanceDueDate?: string;
  invoiceId?: string | null;
  invoiceCode?: string | null;
  quotationId?: string | null;
  quotationCode?: string | null;
  sentAt?: number | null;
  createdAt?: number | null;
};

type Props = {
  open: boolean;
  variant: Variant;
  documentId: string | null;
  apiBase: string;
  createHref: string;
  docLabel: string;
  onClose: () => void;
  onUpdated: (doc: DocumentDetail) => void;
  onRequestDelete: (doc: DocumentDetail) => void;
};

function formatDate(iso?: string): string {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Date(y, m - 1, d).toLocaleDateString("en-AU", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function formatAud(value?: number): string {
  return `AU$ ${(value ?? 0).toFixed(2)}`;
}

function formatWhen(ms?: number | null): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString("en-AU", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function StatusBadge({ status }: { status: string }) {
  if (status === "sent") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-emerald-700">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
        Sent
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-amber-700">
      <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
      Draft
    </span>
  );
}

function PaymentBadge({
  paymentRecorded,
  amountPaidAud,
  totalAud,
}: {
  paymentRecorded?: boolean;
  amountPaidAud?: number;
  totalAud?: number;
}) {
  const paid = paymentRecorded === true && (amountPaidAud ?? 0) > 0;
  const total = totalAud ?? 0;
  const amount = amountPaidAud ?? 0;
  if (!paid) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-rose-200 bg-rose-50 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-rose-700">
        <span className="h-1.5 w-1.5 rounded-full bg-rose-500" />
        Unpaid
      </span>
    );
  }
  if (total > 0 && amount + 0.001 < total) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-sky-200 bg-sky-50 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-sky-700">
        <span className="h-1.5 w-1.5 rounded-full bg-sky-500" />
        Partial
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-emerald-700">
      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
      Paid
    </span>
  );
}

function DetailRow({
  label,
  value,
  emphasize,
}: {
  label: string;
  value: React.ReactNode;
  emphasize?: boolean;
}) {
  if (emphasize) {
    return (
      <div className="flex items-start justify-between gap-3 rounded-md bg-amber-50 px-2 py-2">
        <span className="text-xs font-semibold text-amber-800">{label}</span>
        <span className="text-right text-sm font-bold text-amber-900">{value}</span>
      </div>
    );
  }
  return (
    <div className="flex items-start justify-between gap-3 py-2">
      <span className="text-xs font-medium text-neutral-500">{label}</span>
      <span className="text-right text-sm font-semibold text-neutral-900">{value}</span>
    </div>
  );
}

export default function DocumentDetailPanel({
  open,
  variant,
  documentId,
  apiBase,
  createHref,
  docLabel,
  onClose,
  onUpdated,
  onRequestDelete,
}: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [doc, setDoc] = useState<DocumentDetail | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [pdfViewerOpen, setPdfViewerOpen] = useState(false);
  const [pdfAuthHeaders, setPdfAuthHeaders] = useState<HeadersInit | undefined>();

  useEffect(() => {
    if (!open || !documentId) {
      setDoc(null);
      setError(null);
      return;
    }

    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const { auth } = await import("@/lib/firebase");
        const user = auth.currentUser;
        if (!user) return;
        const token = await user.getIdToken();
        const res = await fetch(`${apiBase}/${documentId}`, {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
        });
        const data = (await res.json()) as {
          ok?: boolean;
          error?: string;
          document?: DocumentDetail;
        };
        if (cancelled) return;
        if (res.ok && data.ok && data.document) {
          setDoc(data.document);
        } else {
          setError(data.error || `Could not load this ${docLabel.toLowerCase()}.`);
        }
      } catch {
        if (!cancelled) setError(`Could not load this ${docLabel.toLowerCase()}.`);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, documentId, apiBase, docLabel]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  async function openPdfViewer() {
    if (!doc || actionBusy) return;
    setError(null);
    try {
      const { auth } = await import("@/lib/firebase");
      const user = auth.currentUser;
      if (!user) return;
      const token = await user.getIdToken();
      setPdfAuthHeaders({ Authorization: `Bearer ${token}` });
      setPdfViewerOpen(true);
    } catch {
      setError(`Could not open the ${docLabel.toLowerCase()} PDF.`);
    }
  }

  async function togglePaid(paid: boolean) {
    if (!doc || variant !== "invoice" || actionBusy) return;
    setActionBusy(paid ? "mark_paid" : "mark_unpaid");
    setError(null);
    try {
      const { auth } = await import("@/lib/firebase");
      const user = auth.currentUser;
      if (!user) return;
      const token = await user.getIdToken();
      const res = await fetch(`${apiBase}/${doc.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ action: paid ? "mark_paid" : "mark_unpaid" }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        document?: DocumentDetail;
      };
      if (!res.ok || !data.ok || !data.document) {
        setError(data.error || "Could not update payment status.");
        return;
      }
      setDoc(data.document);
      onUpdated(data.document);
    } catch {
      setError("Could not update payment status.");
    } finally {
      setActionBusy(null);
    }
  }

  const addressLine = [
    doc?.address?.street,
    doc?.address?.suburb,
    doc?.address?.state,
    doc?.address?.postcode,
  ]
    .filter(Boolean)
    .join(", ");

  const isPaid =
    variant === "invoice" &&
    doc?.paymentRecorded === true &&
    (doc.amountPaidAud ?? 0) > 0 &&
    (doc.totalAud ?? 0) > 0 &&
    (doc.amountPaidAud ?? 0) + 0.001 >= (doc.totalAud ?? 0);

  return (
    <div
      className={`fixed inset-0 z-50 ${open ? "pointer-events-auto" : "pointer-events-none"}`}
      aria-hidden={!open}
    >
      <div
        onClick={onClose}
        className={`absolute inset-0 bg-black/50 transition-opacity duration-200 ${
          open ? "opacity-100" : "opacity-0"
        }`}
      />
      <aside
        className={`absolute top-0 right-0 flex h-full w-[92vw] max-w-lg flex-col border-l border-neutral-200 bg-white shadow-2xl transition-transform duration-300 sm:w-[32rem] ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        {/* Header */}
        <div className="relative shrink-0 overflow-hidden bg-neutral-900 p-5">
          <div className="absolute top-0 right-0 h-24 w-24 translate-x-1/2 -translate-y-1/2 rounded-full bg-white/5" />
          <div className="relative flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-amber-500/30 bg-amber-500/20">
                <i
                  className={`fas ${
                    variant === "quotation" ? "fa-file-lines" : "fa-file-invoice-dollar"
                  } text-amber-400`}
                />
              </div>
              <div className="min-w-0">
                <h3 className="truncate text-lg font-bold text-white">
                  {doc?.code || `${docLabel} details`}
                </h3>
                <p className="truncate text-sm text-white/70">
                  {doc?.customer?.fullName || doc?.jobTitle || "Loading…"}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/20 text-white transition hover:bg-white/30"
              aria-label="Close"
            >
              <i className="fas fa-times" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="custom-scrollbar min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-neutral-500">
              <i className="fas fa-spinner fa-spin" />
              Loading details…
            </div>
          ) : error && !doc ? (
            <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
              {error}
            </div>
          ) : doc ? (
            <>
              {error && (
                <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
                  {error}
                </div>
              )}

              {/* Status strip */}
              <div className="flex flex-wrap items-center gap-2 rounded-xl border border-neutral-200 bg-neutral-50 p-4">
                <StatusBadge status={doc.status} />
                {variant === "invoice" && (
                  <PaymentBadge
                    paymentRecorded={doc.paymentRecorded}
                    amountPaidAud={doc.amountPaidAud}
                    totalAud={doc.totalAud}
                  />
                )}
                <div className="ml-auto text-right">
                  <p className="text-xs font-medium text-neutral-500">Total</p>
                  <p className="text-lg font-bold text-neutral-900">{formatAud(doc.totalAud)}</p>
                </div>
              </div>

              {/* Customer */}
              <div className="rounded-xl border border-neutral-200 bg-white p-4">
                <h5 className="mb-3 flex items-center gap-2 text-sm font-semibold text-neutral-800">
                  <i className="fas fa-user text-neutral-500" />
                  Customer
                </h5>
                <div className="space-y-1 divide-y divide-neutral-100">
                  <DetailRow label="Name" value={doc.customer?.fullName || "—"} />
                  <DetailRow label="Email" value={doc.customer?.email || "—"} />
                  <DetailRow label="Phone" value={doc.customer?.phone || "—"} />
                  {addressLine ? <DetailRow label="Address" value={addressLine} /> : null}
                </div>
              </div>

              {/* Job */}
              <div className="rounded-xl border border-neutral-200 bg-white p-4">
                <h5 className="mb-3 flex items-center gap-2 text-sm font-semibold text-neutral-800">
                  <i className="fas fa-briefcase text-neutral-500" />
                  Job details
                </h5>
                <p className="font-semibold text-neutral-900">{doc.jobTitle || "—"}</p>
                {doc.jobDescription ? (
                  <p className="mt-2 whitespace-pre-wrap text-sm text-neutral-600">
                    {doc.jobDescription}
                  </p>
                ) : null}
              </div>

              {/* Line items */}
              <div className="rounded-xl border border-neutral-200 bg-white p-4">
                <h5 className="mb-3 flex items-center gap-2 text-sm font-semibold text-neutral-800">
                  <i className="fas fa-list text-neutral-500" />
                  Line items
                </h5>
                {(doc.lineItems?.length ?? 0) === 0 ? (
                  <p className="text-sm text-neutral-500">No line items yet.</p>
                ) : (
                  <ul className="space-y-3">
                    {doc.lineItems!.map((item, idx) => {
                      const qty = item.quantity ?? 0;
                      const rate = item.rate ?? 0;
                      const disc = item.discountPercent ?? 0;
                      const net = Math.round(qty * rate * (1 - disc / 100) * 100) / 100;
                      return (
                        <li
                          key={`${item.name}-${idx}`}
                          className="rounded-lg border border-neutral-100 bg-neutral-50 px-3 py-2.5"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <p className="truncate text-sm font-semibold text-neutral-900">
                                {item.name || "Untitled item"}
                              </p>
                              <p className="mt-0.5 text-xs text-neutral-500">
                                {qty} × {formatAud(rate)}
                                {disc > 0 ? ` · ${disc}% off` : ""}
                              </p>
                            </div>
                            <p className="shrink-0 text-sm font-semibold text-neutral-900">
                              {formatAud(net)}
                            </p>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
                <div className="mt-3 space-y-1 border-t border-neutral-100 pt-3">
                  <DetailRow label="Subtotal" value={formatAud(doc.subtotalAud)} />
                  {(doc.discountAud ?? 0) > 0 && (
                    <DetailRow label="Discount" value={`− ${formatAud(doc.discountAud)}`} />
                  )}
                  {doc.gstEnabled && (
                    <DetailRow label="GST" value={formatAud(doc.gstAud)} />
                  )}
                  <DetailRow label="Total" value={formatAud(doc.totalAud)} />
                  {variant === "quotation" && doc.depositRequested && (
                    <>
                      <DetailRow label="Deposit" value={formatAud(doc.depositAud)} />
                      {doc.depositDueDate ? (
                        <DetailRow label="Deposit due" value={formatDate(doc.depositDueDate)} />
                      ) : null}
                    </>
                  )}
                  {variant === "invoice" && doc.paymentRecorded && (
                    <>
                      <DetailRow label="Amount paid" value={formatAud(doc.amountPaidAud)} />
                      <DetailRow
                        label="Balance due"
                        value={formatAud(doc.balanceDueAud)}
                        emphasize
                      />
                      {doc.balanceDueDate && (doc.balanceDueAud ?? 0) > 0 ? (
                        <DetailRow label="Balance due date" value={formatDate(doc.balanceDueDate)} />
                      ) : null}
                    </>
                  )}
                </div>
              </div>

              {/* Dates & meta */}
              <div className="rounded-xl border border-neutral-200 bg-white p-4">
                <h5 className="mb-3 flex items-center gap-2 text-sm font-semibold text-neutral-800">
                  <i className="fas fa-calendar text-neutral-500" />
                  Dates & terms
                </h5>
                <div className="divide-y divide-neutral-100">
                  <DetailRow
                    label={variant === "quotation" ? "Quote date" : "Invoice date"}
                    value={formatDate(doc.documentDate)}
                  />
                  <DetailRow
                    label={variant === "quotation" ? "Valid until" : "Due date"}
                    value={formatDate(doc.dueDate)}
                  />
                  {doc.paymentTermsLabel && (
                    <DetailRow label="Payment terms" value={doc.paymentTermsLabel} />
                  )}
                  <DetailRow label="Created" value={formatWhen(doc.createdAt)} />
                  <DetailRow label="Sent" value={formatWhen(doc.sentAt)} />
                </div>
              </div>

              {(doc.terms || doc.comment) && (
                <div className="rounded-xl border border-neutral-200 bg-white p-4">
                  <h5 className="mb-3 flex items-center gap-2 text-sm font-semibold text-neutral-800">
                    <i className="fas fa-align-left text-neutral-500" />
                    Notes
                  </h5>
                  {doc.terms ? (
                    <div className="mb-3">
                      <p className="text-xs font-medium text-neutral-500">Terms</p>
                      <p className="mt-1 whitespace-pre-wrap text-sm text-neutral-700">{doc.terms}</p>
                    </div>
                  ) : null}
                  {doc.comment ? (
                    <div>
                      <p className="text-xs font-medium text-neutral-500">Comment</p>
                      <p className="mt-1 whitespace-pre-wrap text-sm text-neutral-700">
                        {doc.comment}
                      </p>
                    </div>
                  ) : null}
                </div>
              )}

              {/* Linked docs */}
              {(doc.invoiceId || doc.quotationId) && (
                <div className="rounded-xl border border-neutral-200 bg-white p-4">
                  <h5 className="mb-3 flex items-center gap-2 text-sm font-semibold text-neutral-800">
                    <i className="fas fa-link text-neutral-500" />
                    Linked documents
                  </h5>
                  {doc.invoiceId && (
                    <Link
                      href={`/invoices/create?id=${doc.invoiceId}`}
                      className="flex items-center justify-between rounded-lg border border-neutral-200 px-3 py-2.5 text-sm font-semibold text-neutral-800 transition hover:bg-neutral-50"
                    >
                      <span>
                        <i className="fas fa-file-invoice-dollar mr-2 text-amber-600" />
                        Invoice {doc.invoiceCode || ""}
                      </span>
                      <i className="fas fa-chevron-right text-neutral-400" />
                    </Link>
                  )}
                  {doc.quotationId && (
                    <Link
                      href={`/quotations/create?id=${doc.quotationId}`}
                      className="mt-2 flex items-center justify-between rounded-lg border border-neutral-200 px-3 py-2.5 text-sm font-semibold text-neutral-800 transition hover:bg-neutral-50"
                    >
                      <span>
                        <i className="fas fa-file-lines mr-2 text-amber-600" />
                        Quotation {doc.quotationCode || ""}
                      </span>
                      <i className="fas fa-chevron-right text-neutral-400" />
                    </Link>
                  )}
                </div>
              )}

              {/* Actions */}
              <div className="rounded-xl border border-neutral-200 bg-white p-4">
                <h5 className="mb-3 flex items-center gap-2 text-sm font-semibold text-neutral-800">
                  <i className="fas fa-bolt text-neutral-500" />
                  Actions
                </h5>
                <div className="grid gap-2">
                  <Link
                    href={`${createHref}?id=${doc.id}`}
                    className="inline-flex items-center justify-center gap-2 rounded-lg bg-neutral-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-neutral-800"
                  >
                    <i className="fas fa-pen" />
                    {doc.status === "sent" ? "Edit / resend" : "Edit draft"}
                  </Link>

                  <button
                    type="button"
                    onClick={() => void openPdfViewer()}
                    disabled={!!actionBusy}
                    className="inline-flex items-center justify-center gap-2 rounded-lg border border-neutral-300 bg-white px-4 py-2.5 text-sm font-semibold text-neutral-800 transition hover:bg-neutral-50 disabled:opacity-60"
                  >
                    <i className="fas fa-file-pdf" />
                    View / download PDF
                  </button>

                  {variant === "quotation" &&
                    (doc.invoiceId ? (
                      <Link
                        href={`/invoices/create?id=${doc.invoiceId}`}
                        className="inline-flex items-center justify-center gap-2 rounded-lg border border-neutral-300 bg-white px-4 py-2.5 text-sm font-semibold text-neutral-800 transition hover:bg-neutral-50"
                      >
                        <i className="fas fa-file-invoice-dollar" />
                        View invoice {doc.invoiceCode || ""}
                      </Link>
                    ) : (
                      <Link
                        href={`/invoices/create?fromQuotation=${doc.id}`}
                        className="inline-flex items-center justify-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-4 py-2.5 text-sm font-semibold text-amber-900 transition hover:bg-amber-100"
                      >
                        <i className="fas fa-file-invoice-dollar" />
                        Issue invoice
                      </Link>
                    ))}

                  {variant === "invoice" &&
                    (isPaid ? (
                      <button
                        type="button"
                        onClick={() => void togglePaid(false)}
                        disabled={!!actionBusy}
                        className="inline-flex items-center justify-center gap-2 rounded-lg border border-neutral-300 bg-white px-4 py-2.5 text-sm font-semibold text-neutral-800 transition hover:bg-neutral-50 disabled:opacity-60"
                      >
                        <i
                          className={`fas ${
                            actionBusy === "mark_unpaid" ? "fa-spinner fa-spin" : "fa-rotate-left"
                          }`}
                        />
                        Mark as unpaid
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void togglePaid(true)}
                        disabled={!!actionBusy}
                        className="inline-flex items-center justify-center gap-2 rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-2.5 text-sm font-semibold text-emerald-900 transition hover:bg-emerald-100 disabled:opacity-60"
                      >
                        <i
                          className={`fas ${
                            actionBusy === "mark_paid" ? "fa-spinner fa-spin" : "fa-circle-check"
                          }`}
                        />
                        Mark as paid
                      </button>
                    ))}

                  <button
                    type="button"
                    onClick={() => onRequestDelete(doc)}
                    className="inline-flex items-center justify-center gap-2 rounded-lg border border-rose-200 bg-rose-50 px-4 py-2.5 text-sm font-semibold text-rose-700 transition hover:bg-rose-100"
                  >
                    <i className="fas fa-trash" />
                    Delete {docLabel.toLowerCase()}
                  </button>
                </div>
              </div>
            </>
          ) : null}
        </div>
      </aside>

      <SalesDocumentPdfViewer
        open={pdfViewerOpen && !!doc}
        title={`${docLabel} ${doc?.code || ""}`.trim()}
        pdfUrl={doc ? `${apiBase}/${doc.id}/pdf` : null}
        fetchHeaders={pdfAuthHeaders}
        filename={`${docLabel}-${doc?.code || doc?.id || "document"}.pdf`}
        onClose={() => setPdfViewerOpen(false)}
      />
    </div>
  );
}
