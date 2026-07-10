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

const INPUT_CLASS =
  "w-full px-4 py-2.5 border border-neutral-300 rounded-lg text-sm text-neutral-900 placeholder:text-neutral-400 focus:ring-2 focus:ring-neutral-900 focus:border-transparent outline-none";
const NUMBER_INPUT_CLASS = `${INPUT_CLASS} [appearance:textfield] [-moz-appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none`;
const LABEL_CLASS = "block text-xs font-semibold uppercase tracking-wider text-neutral-500 mb-1.5";

function formatAud(value: number): string {
  return `AU$ ${value.toFixed(2)}`;
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
                    <i className="fas fa-boxes-stacked text-amber-400" />
                  </div>
                  <h1 className="text-2xl font-bold">Items</h1>
                </div>
                <p className="text-sm text-neutral-400 mt-2">
                  Manage your reusable items. They appear as suggestions when adding lines to
                  quotations and invoices.
                </p>
              </div>
            </div>
          </div>

          {/* Toolbar */}
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="relative w-full sm:max-w-xs">
              <i className="fas fa-magnifying-glass pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-neutral-400" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search items"
                className={`${INPUT_CLASS} pl-9`}
              />
            </div>
            <button
              type="button"
              onClick={openCreate}
              className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg text-sm font-semibold bg-neutral-900 text-white hover:bg-neutral-800 transition shadow-sm"
            >
              <i className="fas fa-plus" />
              New Item
            </button>
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
                    <th className="px-6 py-4">Item</th>
                    <th className="px-6 py-4">Code</th>
                    <th className="px-6 py-4 text-right">Price</th>
                    <th className="px-6 py-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100">
                  {loading ? (
                    <tr>
                      <td colSpan={4} className="px-6 py-16 text-center text-sm text-neutral-400">
                        <i className="fas fa-spinner fa-spin mr-2" />
                        Loading items…
                      </td>
                    </tr>
                  ) : filtered.length === 0 ? (
                    <tr>
                      <td colSpan={4}>
                        <div className="flex flex-col items-center justify-center gap-4 px-6 py-16 text-center">
                          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-neutral-100">
                            <i className="fas fa-boxes-stacked text-xl text-neutral-400" />
                          </div>
                          <div>
                            <p className="text-base font-semibold text-neutral-900">
                              {items.length === 0 ? "No items yet" : "No matching items"}
                            </p>
                            <p className="mt-1 text-sm text-neutral-500">
                              {items.length === 0
                                ? "Add your first item to reuse it across quotations and invoices."
                                : "Try a different search term."}
                            </p>
                          </div>
                          {items.length === 0 && (
                            <button
                              type="button"
                              onClick={openCreate}
                              className="inline-flex items-center gap-2 rounded-lg bg-neutral-900 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-neutral-800"
                            >
                              <i className="fas fa-plus" />
                              New Item
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ) : (
                    filtered.map((item) => (
                      <tr key={item.id} className="hover:bg-neutral-50 transition">
                        <td className="px-6 py-4">
                          <p className="font-semibold text-neutral-900">{item.name}</p>
                          {item.description && (
                            <p className="mt-0.5 text-xs text-neutral-500">{item.description}</p>
                          )}
                        </td>
                        <td className="px-6 py-4 text-neutral-600">
                          {item.code || <span className="text-neutral-300">—</span>}
                        </td>
                        <td className="px-6 py-4 text-right font-semibold text-neutral-900">
                          {formatAud(item.priceAud)}
                        </td>
                        <td className="px-6 py-4 text-right">
                          <div className="flex items-center justify-end gap-2">
                            <button
                              type="button"
                              onClick={() => openEdit(item)}
                              className="p-2 text-neutral-400 hover:text-neutral-700 hover:bg-neutral-100 rounded-lg transition"
                              title="Edit"
                            >
                              <i className="fas fa-pen text-sm" />
                            </button>
                            <button
                              type="button"
                              onClick={() => setDeleteTarget(item)}
                              className="p-2 text-rose-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition"
                              title="Delete"
                            >
                              <i className="fas fa-trash text-sm" />
                            </button>
                          </div>
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

      {/* Editor modal */}
      {editorOpen && (
        <div className="fixed inset-0 z-50">
          <div className="absolute inset-0 bg-black/50" onClick={() => setEditorOpen(false)} />
          <div className="relative flex items-start md:items-center justify-center min-h-screen p-4 overflow-y-auto">
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] flex flex-col">
              <div className="px-6 py-4 border-b border-neutral-200 flex items-center justify-between">
                <h3 className="text-lg font-bold text-neutral-900">
                  {editTarget ? "Edit item" : "New item"}
                </h3>
                <button
                  onClick={() => setEditorOpen(false)}
                  className="p-2 hover:bg-neutral-100 rounded-lg transition"
                >
                  <i className="fas fa-times text-neutral-400" />
                </button>
              </div>
              <div className="p-6 space-y-4 flex-1 overflow-y-auto">
                {formError && (
                  <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
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
              <div className="px-6 py-4 border-t border-neutral-200 flex items-center justify-end gap-3">
                <button
                  onClick={() => setEditorOpen(false)}
                  className="px-5 py-2.5 text-neutral-700 font-semibold hover:bg-neutral-100 rounded-lg transition"
                >
                  Cancel
                </button>
                <button
                  onClick={saveDraft}
                  disabled={saving}
                  className="inline-flex items-center gap-2 px-5 py-2.5 bg-neutral-900 text-white font-semibold rounded-lg hover:bg-neutral-800 transition disabled:opacity-60"
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
