"use client";

import Sidebar from "@/components/Sidebar";
import { DeleteConfirmModal } from "@/components/delete-confirm-modal";
import { useRouter } from "next/navigation";
import { onAuthStateChanged } from "firebase/auth";
import { auth } from "@/lib/firebase";
import React, { useCallback, useEffect, useMemo, useState } from "react";

export type CatalogItem = {
  id: string;
  name: string;
  code: string | null;
  description: string | null;
  priceAud: number;
  createdAt: number | null;
  updatedAt: number | null;
};

type ItemDraft = {
  name: string;
  code: string;
  description: string;
  priceAud: string;
};

const PAGE_SIZE = 15;

const INPUT_CLASS =
  "w-full px-4 py-2.5 border border-neutral-300 rounded-xl text-sm text-neutral-900 placeholder:text-neutral-400 focus:ring-2 focus:ring-neutral-900 focus:border-transparent outline-none";
const NUMBER_INPUT_CLASS = `${INPUT_CLASS} [appearance:textfield] [-moz-appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none`;
const LABEL_CLASS = "block text-xs font-semibold uppercase tracking-wider text-neutral-500 mb-1.5";

function formatAud(value: number): string {
  return `Aus $${value.toFixed(2)}`;
}

function emptyDraft(): ItemDraft {
  return { name: "", code: "", description: "", priceAud: "" };
}

async function authFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const user = auth.currentUser;
  if (!user) return { ok: false, error: "Please sign in again." };
  const token = await user.getIdToken();
  const response = await fetch(path, {
    ...options,
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  let body: (T & { ok?: boolean; error?: string }) | null = null;
  if (text.trim()) {
    try {
      body = JSON.parse(text) as T & { ok?: boolean; error?: string };
    } catch {
      return { ok: false, error: "Invalid response from server." };
    }
  }
  if (!response.ok || !body || body.ok === false) {
    return { ok: false, error: body?.error ?? "Request failed." };
  }
  return { ok: true, data: body };
}

export default function ItemsBoard() {
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);

  const [items, setItems] = useState<CatalogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<CatalogItem | null>(null);
  const [draft, setDraft] = useState<ItemDraft>(emptyDraft());
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [deleteTarget, setDeleteTarget] = useState<CatalogItem | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const result = await authFetch<{ items: CatalogItem[] }>("/api/items");
    if (!result.ok) {
      setError(result.error);
      setItems([]);
    } else {
      setItems(result.data.items ?? []);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (user) => {
      if (!user) {
        router.replace("/login");
        return;
      }
      void load();
    });
    return () => unsub();
  }, [router, load]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return items;
    return items.filter(
      (item) =>
        item.name.toLowerCase().includes(query) ||
        (item.code?.toLowerCase().includes(query) ?? false) ||
        (item.description?.toLowerCase().includes(query) ?? false),
    );
  }, [items, search]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const paged = useMemo(
    () => filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
    [filtered, currentPage],
  );

  function openCreate() {
    setEditTarget(null);
    setDraft(emptyDraft());
    setFormError(null);
    setEditorOpen(true);
  }

  function openEdit(item: CatalogItem) {
    setEditTarget(item);
    setDraft({
      name: item.name,
      code: item.code ?? "",
      description: item.description ?? "",
      priceAud: String(item.priceAud),
    });
    setFormError(null);
    setEditorOpen(true);
  }

  async function saveDraft() {
    const name = draft.name.trim();
    const price = Number.parseFloat(draft.priceAud.replace(/[^\d.]/g, ""));
    if (!name) {
      setFormError("Enter an item name.");
      return;
    }
    if (!Number.isFinite(price) || price < 0) {
      setFormError("Enter a valid price.");
      return;
    }

    setSaving(true);
    setFormError(null);
    const payload = {
      name,
      priceAud: price,
      code: draft.code.trim() || null,
      description: draft.description.trim() || null,
    };
    const result = editTarget
      ? await authFetch<{ item: CatalogItem }>(`/api/items/${editTarget.id}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        })
      : await authFetch<{ item: CatalogItem }>("/api/items", {
          method: "POST",
          body: JSON.stringify(payload),
        });
    setSaving(false);
    if (!result.ok) {
      setFormError(result.error);
      return;
    }
    setEditorOpen(false);
    setEditTarget(null);
    void load();
  }

  async function confirmDelete() {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    setError(null);
    const result = await authFetch<{ ok: true }>(`/api/items/${deleteTarget.id}`, {
      method: "DELETE",
    });
    setDeleting(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setDeleteTarget(null);
    void load();
  }

  return (
    <div id="app" className="flex h-screen overflow-hidden bg-white">
      <Sidebar />
      <div className="flex-1 flex flex-col overflow-hidden">
        <main className="flex-1 overflow-auto bg-neutral-50 p-4 sm:p-6 lg:p-8">
          <div className="md:hidden mb-4">
            <button
              className="inline-flex items-center gap-2 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-neutral-700 shadow-sm hover:bg-neutral-50"
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

          <div className="mb-6 rounded-2xl bg-neutral-900 p-6 text-white shadow-sm">
            <div className="flex items-center gap-4">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-white/10">
                <i className="fas fa-box text-lg text-white" />
              </div>
              <div>
                <h1 className="text-2xl font-bold">Item list</h1>
                <p className="mt-0.5 text-sm text-neutral-400">
                  Reusable line items and prices for your quotations.
                </p>
              </div>
            </div>
          </div>

          {error && (
            <div className="mb-4 flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
              <i className="fas fa-exclamation-circle mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="relative w-full sm:max-w-md">
              <i className="fas fa-search pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-sm text-neutral-400" />
              <input
                type="search"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
                placeholder="Search items..."
                className="w-full rounded-xl border border-neutral-300 bg-white py-2.5 pl-10 pr-3.5 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-900 focus:outline-none focus:ring-2 focus:ring-neutral-900/10"
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void load()}
                disabled={loading}
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-neutral-300 bg-white px-4 py-2.5 text-sm font-medium text-neutral-700 transition hover:bg-neutral-50 disabled:opacity-50"
              >
                <i className={`fas fa-sync-alt ${loading ? "fa-spin" : ""}`} />
                Refresh
              </button>
              <button
                type="button"
                onClick={openCreate}
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-neutral-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-neutral-800"
              >
                <i className="fas fa-plus" />
                Add item
              </button>
            </div>
          </div>

          {loading ? (
            <div className="rounded-2xl border border-neutral-200 bg-white px-4 py-16 text-center text-neutral-400">
              <i className="fas fa-spinner fa-spin mr-2" />
              Loading items…
            </div>
          ) : paged.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-neutral-300 bg-white px-4 py-16 text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-neutral-100">
                <i className="fas fa-tag text-xl text-neutral-500" />
              </div>
              <div>
                <p className="font-semibold text-neutral-900">
                  {items.length === 0 ? "No items yet" : "No matching items"}
                </p>
                <p className="mt-1 text-sm text-neutral-500">
                  {items.length === 0
                    ? "Add your first item to reuse it on quotations and invoices."
                    : "Try a different search term."}
                </p>
              </div>
              {items.length === 0 && (
                <button
                  type="button"
                  onClick={openCreate}
                  className="mt-1 inline-flex items-center gap-2 rounded-xl bg-neutral-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-neutral-800"
                >
                  <i className="fas fa-plus" />
                  Add item
                </button>
              )}
            </div>
          ) : (
            <>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {paged.map((item) => (
                  <article
                    key={item.id}
                    className="group flex items-start gap-3 rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm transition-all duration-300 ease-out hover:-translate-y-1 hover:shadow-[0_12px_32px_rgba(15,23,42,0.1)]"
                  >
                    <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-neutral-900 text-white transition-transform duration-300 group-hover:scale-110">
                      <i className="fas fa-tag text-sm" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium uppercase tracking-wide text-neutral-400">
                        {item.code || "No code"}
                      </p>
                      <h3 className="mt-0.5 truncate text-base font-bold text-neutral-900">
                        {item.name}
                      </h3>
                      <p className="mt-1 text-sm font-semibold text-neutral-800">
                        {formatAud(item.priceAud)}
                      </p>
                      {item.description && (
                        <p className="mt-1.5 line-clamp-2 text-xs text-neutral-500">
                          {item.description}
                        </p>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-0.5">
                      <button
                        type="button"
                        onClick={() => openEdit(item)}
                        className="rounded-lg p-2 text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-700"
                        title="Edit"
                      >
                        <i className="fas fa-pen text-sm" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setDeleteTarget(item)}
                        className="rounded-lg p-2 text-neutral-400 transition hover:bg-rose-50 hover:text-rose-600"
                        title="Delete"
                      >
                        <i className="fas fa-trash text-sm" />
                      </button>
                    </div>
                  </article>
                ))}
              </div>

              {filtered.length > PAGE_SIZE && (
                <div className="mt-5 flex flex-wrap items-center justify-between gap-3 text-sm text-neutral-600">
                  <span>
                    Showing {(currentPage - 1) * PAGE_SIZE + 1}–
                    {Math.min(currentPage * PAGE_SIZE, filtered.length)} of {filtered.length} item
                    {filtered.length === 1 ? "" : "s"}
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={currentPage <= 1}
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                      className="rounded-lg border border-neutral-300 bg-white px-3 py-1.5 disabled:opacity-40"
                    >
                      Previous
                    </button>
                    <span>
                      Page {currentPage} of {totalPages}
                    </span>
                    <button
                      type="button"
                      disabled={currentPage >= totalPages}
                      onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                      className="rounded-lg border border-neutral-300 bg-white px-3 py-1.5 disabled:opacity-40"
                    >
                      Next
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </main>
      </div>

      {editorOpen && (
        <div className="fixed inset-0 z-50">
          <div className="absolute inset-0 bg-black/50" onClick={() => setEditorOpen(false)} />
          <div className="relative flex min-h-screen items-start justify-center overflow-y-auto p-4 md:items-center">
            <div className="flex max-h-[90vh] w-full max-w-lg flex-col rounded-2xl bg-white shadow-2xl">
              <div className="flex items-center justify-between border-b border-neutral-200 px-6 py-4">
                <h3 className="text-lg font-bold text-neutral-900">
                  {editTarget ? "Edit item" : "Add item"}
                </h3>
                <button
                  type="button"
                  onClick={() => setEditorOpen(false)}
                  className="rounded-lg p-2 transition hover:bg-neutral-100"
                >
                  <i className="fas fa-times text-neutral-400" />
                </button>
              </div>
              <div className="flex-1 space-y-4 overflow-y-auto p-6">
                {formError && (
                  <div className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
                    <i className="fas fa-exclamation-circle mt-0.5" />
                    <span>{formError}</span>
                  </div>
                )}
                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="block sm:col-span-2">
                    <span className={LABEL_CLASS}>Item name</span>
                    <input
                      type="text"
                      value={draft.name}
                      onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                      placeholder="e.g. Oil filter replacement"
                      className={INPUT_CLASS}
                      maxLength={200}
                      autoFocus
                    />
                  </label>
                  <label className="block">
                    <span className={LABEL_CLASS}>Item code</span>
                    <input
                      type="text"
                      value={draft.code}
                      onChange={(e) => setDraft((d) => ({ ...d, code: e.target.value }))}
                      placeholder="e.g. OIL-001"
                      className={INPUT_CLASS}
                      maxLength={50}
                    />
                  </label>
                  <label className="block">
                    <span className={LABEL_CLASS}>Price (AU$)</span>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={draft.priceAud}
                      onChange={(e) => setDraft((d) => ({ ...d, priceAud: e.target.value }))}
                      placeholder="0.00"
                      className={NUMBER_INPUT_CLASS}
                    />
                  </label>
                  <label className="block sm:col-span-2">
                    <span className={LABEL_CLASS}>Description</span>
                    <textarea
                      value={draft.description}
                      onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
                      rows={3}
                      placeholder="Optional details about this item"
                      className={`${INPUT_CLASS} resize-y`}
                      maxLength={500}
                    />
                  </label>
                </div>
              </div>
              <div className="flex items-center justify-end gap-3 border-t border-neutral-200 px-6 py-4">
                <button
                  type="button"
                  onClick={() => setEditorOpen(false)}
                  className="rounded-xl px-5 py-2.5 font-semibold text-neutral-700 transition hover:bg-neutral-100"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void saveDraft()}
                  disabled={saving}
                  className="inline-flex items-center gap-2 rounded-xl bg-neutral-900 px-5 py-2.5 font-semibold text-white transition hover:bg-neutral-800 disabled:opacity-60"
                >
                  {saving && <i className="fas fa-spinner fa-spin" />}
                  {editTarget ? "Save changes" : "Create item"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <DeleteConfirmModal
        open={Boolean(deleteTarget)}
        title="Delete item"
        description={`Are you sure you want to delete "${deleteTarget?.name ?? ""}"? This cannot be undone.`}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={confirmDelete}
        isLoading={deleting}
      />
    </div>
  );
}
