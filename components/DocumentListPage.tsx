"use client";

import Link from "next/link";
import Sidebar from "@/components/Sidebar";
import { useRouter } from "next/navigation";
import { onAuthStateChanged } from "firebase/auth";
import React, { useEffect, useState } from "react";
import { DeleteConfirmModal } from "@/components/delete-confirm-modal";
import DocumentDetailPanel, {
  type DocumentDetail,
} from "@/components/DocumentDetailPanel";

type Variant = "quotation" | "invoice";

type DocumentRow = {
  id: string;
  code: string;
  status: string;
  customer?: { fullName?: string; email?: string };
  jobTitle?: string;
  documentDate?: string;
  totalAud?: number;
  createdAt?: number | null;
  sentAt?: number | null;
  invoiceId?: string | null;
  invoiceCode?: string | null;
  quotationId?: string | null;
  quotationCode?: string | null;
  paymentRecorded?: boolean;
  amountPaidAud?: number;
  balanceDueAud?: number;
};

type VariantConfig = {
  title: string;
  subtitle: string;
  heroIcon: string;
  docLabel: string;
  createHref: string;
  createLabel: string;
  apiBase: string;
  emptyTitle: string;
  emptyBody: string;
  columns: string[];
};

const VARIANT_CONFIG: Record<Variant, VariantConfig> = {
  quotation: {
    title: "Quotations",
    subtitle: "Create drafts, edit anytime, and send quotes to your customers.",
    heroIcon: "fa-file-lines",
    docLabel: "Quotation",
    createHref: "/quotations/create",
    createLabel: "New Quotation",
    apiBase: "/api/quotations",
    emptyTitle: "No quotations yet",
    emptyBody: "Create your first quotation and send it to a customer.",
    columns: ["Quote", "Customer", "Date", "Amount", "Status"],
  },
  invoice: {
    title: "Invoices",
    subtitle: "Create drafts, edit anytime, and send invoices to your customers.",
    heroIcon: "fa-file-invoice-dollar",
    docLabel: "Invoice",
    createHref: "/invoices/create",
    createLabel: "New Invoice",
    apiBase: "/api/invoices",
    emptyTitle: "No invoices yet",
    emptyBody: "Create your first invoice and send it to a customer.",
    columns: ["Invoice", "Customer", "Date", "Amount", "Status"],
  },
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

function PaymentBadge({ row }: { row: DocumentRow }) {
  const paid = row.paymentRecorded === true && (row.amountPaidAud ?? 0) > 0;
  const total = row.totalAud ?? 0;
  const amount = row.amountPaidAud ?? 0;
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

export default function DocumentListPage({ variant }: { variant: Variant }) {
  const config = VARIANT_CONFIG[variant];
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<DocumentRow[]>([]);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "draft" | "sent">("all");
  const [deleteTarget, setDeleteTarget] = useState<DocumentRow | DocumentDetail | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const panelOpen = !!selectedId;

  useEffect(() => {
    let unsub: (() => void) | undefined;
    (async () => {
      const { auth } = await import("@/lib/firebase");
      unsub = onAuthStateChanged(auth, async (user) => {
        if (!user) {
          router.replace("/login");
          return;
        }
        try {
          const token = await user.getIdToken();
          const res = await fetch(config.apiBase, {
            headers: { Authorization: `Bearer ${token}` },
            cache: "no-store",
          });
          const data = (await res.json()) as {
            ok?: boolean;
            error?: string;
            documents?: DocumentRow[];
          };
          if (res.ok && data.ok && data.documents) {
            setRows(data.documents);
          } else {
            setError(data.error || `Could not load ${config.title.toLowerCase()}.`);
          }
        } catch {
          setError(`Could not load ${config.title.toLowerCase()}.`);
        } finally {
          setLoading(false);
        }
      });
    })();
    return () => {
      if (unsub) unsub();
    };
  }, [router, config.apiBase, config.title]);

  async function confirmDelete() {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    try {
      const { auth } = await import("@/lib/firebase");
      const user = auth.currentUser;
      if (!user) return;
      const token = await user.getIdToken();
      const res = await fetch(`${config.apiBase}/${deleteTarget.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (res.ok && data.ok) {
        setRows((prev) => prev.filter((row) => row.id !== deleteTarget.id));
        if (selectedId === deleteTarget.id) setSelectedId(null);
        setDeleteTarget(null);
      } else {
        setError(data.error || `Could not delete the ${config.docLabel.toLowerCase()}.`);
      }
    } catch {
      setError(`Could not delete the ${config.docLabel.toLowerCase()}.`);
    } finally {
      setDeleting(false);
    }
  }

  function handlePanelUpdated(doc: DocumentDetail) {
    setRows((prev) =>
      prev.map((row) =>
        row.id === doc.id
          ? {
              ...row,
              code: doc.code || row.code,
              status: doc.status || row.status,
              customer: doc.customer ?? row.customer,
              jobTitle: doc.jobTitle ?? row.jobTitle,
              documentDate: doc.documentDate ?? row.documentDate,
              totalAud: doc.totalAud ?? row.totalAud,
              invoiceId: doc.invoiceId ?? row.invoiceId,
              invoiceCode: doc.invoiceCode ?? row.invoiceCode,
              quotationId: doc.quotationId ?? row.quotationId,
              quotationCode: doc.quotationCode ?? row.quotationCode,
              paymentRecorded: doc.paymentRecorded,
              amountPaidAud: doc.amountPaidAud,
              balanceDueAud: doc.balanceDueAud,
              sentAt: doc.sentAt ?? row.sentAt,
            }
          : row,
      ),
    );
  }

  const query = search.trim().toLowerCase();
  const draftCount = rows.filter((row) => row.status !== "sent").length;
  const sentCount = rows.filter((row) => row.status === "sent").length;
  const visibleRows = rows.filter((row) => {
    if (statusFilter === "draft" && row.status === "sent") return false;
    if (statusFilter === "sent" && row.status !== "sent") return false;
    if (!query) return true;
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

  const statusTabs: { id: "all" | "draft" | "sent"; label: string; count: number }[] = [
    { id: "all", label: "All", count: rows.length },
    { id: "draft", label: "Drafts", count: draftCount },
    { id: "sent", label: "Sent", count: sentCount },
  ];

  const emptyFilteredTitle =
    statusFilter === "draft"
      ? "No drafts"
      : statusFilter === "sent"
        ? "No sent documents"
        : config.emptyTitle;
  const emptyFilteredBody =
    statusFilter === "draft"
      ? `Save a ${config.docLabel.toLowerCase()} as a draft to finish it later.`
      : statusFilter === "sent"
        ? `Sent ${config.title.toLowerCase()} will show up here.`
        : config.emptyBody;

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
                  <h1 className="text-2xl font-bold">{config.title}</h1>
                </div>
                <p className="text-sm text-neutral-400 mt-2">{config.subtitle}</p>
              </div>
            </div>
          </div>

          {/* Toolbar */}
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <div className="relative sm:w-72">
                <i className="fas fa-search pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-xs text-neutral-400" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={`Search ${config.title.toLowerCase()}…`}
                  className="w-full rounded-lg border border-neutral-300 bg-white py-2.5 pl-9 pr-4 text-sm text-neutral-900 placeholder:text-neutral-400 focus:ring-2 focus:ring-neutral-900 focus:border-transparent outline-none"
                />
              </div>
              <div className="inline-flex rounded-lg border border-neutral-300 bg-white p-0.5">
                {statusTabs.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setStatusFilter(tab.id)}
                    className={`rounded-md px-3 py-1.5 text-xs font-semibold transition ${
                      statusFilter === tab.id
                        ? "bg-neutral-900 text-white"
                        : "text-neutral-600 hover:bg-neutral-50"
                    }`}
                  >
                    {tab.label}
                    <span
                      className={`ml-1.5 tabular-nums ${
                        statusFilter === tab.id ? "text-neutral-300" : "text-neutral-400"
                      }`}
                    >
                      {tab.count}
                    </span>
                  </button>
                ))}
              </div>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              {variant === "invoice" && (
                <Link
                  href="/invoices/create?pickQuotation=1"
                  className="inline-flex items-center justify-center gap-2 rounded-lg border border-neutral-300 bg-white px-5 py-2.5 text-sm font-semibold text-neutral-800 transition hover:bg-neutral-50"
                >
                  <i className="fas fa-file-lines" />
                  From quotation
                </Link>
              )}
              <Link
                href={config.createHref}
                className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg text-sm font-semibold bg-neutral-900 text-white hover:bg-neutral-800 transition shadow-sm"
              >
                <i className="fas fa-plus" />
                {config.createLabel}
              </Link>
            </div>
          </div>

          {error && (
            <div className="mb-4 flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
              <i className="fas fa-exclamation-circle mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {/* List card */}
          <div className="bg-white rounded-2xl border border-neutral-200 shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-neutral-50 border-b border-neutral-200 text-xs font-semibold uppercase tracking-wider text-neutral-600">
                  <tr>
                    {config.columns.map((col) => (
                      <th key={col} className="px-6 py-4">
                        {col}
                      </th>
                    ))}
                    <th className="px-6 py-4 text-right">
                      <span className="sr-only">Open</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100">
                  {loading ? (
                    <tr>
                      <td colSpan={config.columns.length + 1}>
                        <div className="flex items-center justify-center gap-2 px-6 py-16 text-sm text-neutral-500">
                          <i className="fas fa-spinner fa-spin" />
                          Loading {config.title.toLowerCase()}…
                        </div>
                      </td>
                    </tr>
                  ) : visibleRows.length === 0 ? (
                    <tr>
                      <td colSpan={config.columns.length + 1}>
                        <div className="flex flex-col items-center justify-center gap-4 px-6 py-16 text-center">
                          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-neutral-100">
                            <i className={`fas ${config.heroIcon} text-xl text-neutral-400`} />
                          </div>
                          <div>
                            <p className="text-base font-semibold text-neutral-900">
                              {query ? "No matches found" : emptyFilteredTitle}
                            </p>
                            <p className="mt-1 text-sm text-neutral-500">
                              {query ? "Try a different search term." : emptyFilteredBody}
                            </p>
                          </div>
                          {!query && (
                            <Link
                              href={config.createHref}
                              className="inline-flex items-center gap-2 rounded-lg bg-neutral-900 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-neutral-800"
                            >
                              <i className="fas fa-plus" />
                              {config.createLabel}
                            </Link>
                          )}
                        </div>
                      </td>
                    </tr>
                  ) : (
                    visibleRows.map((row) => (
                      <tr
                        key={row.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => setSelectedId(row.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            setSelectedId(row.id);
                          }
                        }}
                        className={`cursor-pointer transition hover:bg-neutral-50 ${
                          selectedId === row.id ? "bg-neutral-50" : ""
                        }`}
                      >
                        <td className="px-6 py-4">
                          <p className="font-semibold text-neutral-900">{row.code || "—"}</p>
                          {row.jobTitle && (
                            <p className="mt-0.5 max-w-[220px] truncate text-xs text-neutral-500">
                              {row.jobTitle}
                            </p>
                          )}
                        </td>
                        <td className="px-6 py-4">
                          <p className="font-medium text-neutral-900">
                            {row.customer?.fullName || "—"}
                          </p>
                          {row.customer?.email && (
                            <p className="text-xs text-neutral-500">{row.customer.email}</p>
                          )}
                        </td>
                        <td className="px-6 py-4 text-neutral-600">
                          {formatDate(row.documentDate)}
                        </td>
                        <td className="px-6 py-4 font-semibold text-neutral-900">
                          {formatAud(row.totalAud)}
                        </td>
                        <td className="px-6 py-4">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <StatusBadge status={row.status} />
                            {variant === "invoice" && <PaymentBadge row={row} />}
                          </div>
                        </td>
                        <td className="px-6 py-4 text-right">
                          <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-neutral-400">
                            <i className="fas fa-chevron-right" />
                          </span>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </main>
      </div>

      <DocumentDetailPanel
        open={panelOpen}
        variant={variant}
        documentId={selectedId}
        apiBase={config.apiBase}
        createHref={config.createHref}
        docLabel={config.docLabel}
        onClose={() => setSelectedId(null)}
        onUpdated={handlePanelUpdated}
        onRequestDelete={(doc) => setDeleteTarget(doc)}
      />

      <DeleteConfirmModal
        open={!!deleteTarget}
        title={`Delete ${config.docLabel.toLowerCase()} ${deleteTarget?.code ?? ""}?`}
        description={`This will permanently remove this ${config.docLabel.toLowerCase()}. This action cannot be undone.`}
        onCancel={() => {
          if (!deleting) setDeleteTarget(null);
        }}
        onConfirm={confirmDelete}
        isLoading={deleting}
      />
    </div>
  );
}
