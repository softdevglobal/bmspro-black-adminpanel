"use client";
import React, { useEffect, useState } from "react";
import Sidebar from "@/components/Sidebar";
import { useRouter } from "next/navigation";
import { onAuthStateChanged } from "firebase/auth";
import { auth, db } from "@/lib/firebase";
import { doc, getDoc } from "firebase/firestore";
import {
  createDefaultService,
  updateDefaultService,
  deleteDefaultService,
  subscribeDefaultServices,
  type DefaultServiceInput,
} from "@/lib/defaultServices";
import { type ChecklistItem, normalizeChecklist } from "@/lib/services";

type DefaultService = {
  id: string;
  name: string;
  checklist: ChecklistItem[];
};

export default function AdminServicesPage() {
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [adminUid, setAdminUid] = useState<string | null>(null);
  const [services, setServices] = useState<DefaultService[]>([]);

  // modal/form
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [previewService, setPreviewService] = useState<DefaultService | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DefaultService | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [name, setName] = useState("");
  const [checklist, setChecklist] = useState<ChecklistItem[]>([]);
  const [newChecklistItem, setNewChecklistItem] = useState("");
  const [newChecklistDesc, setNewChecklistDesc] = useState("");

  // toast
  const [toasts, setToasts] = useState<Array<{ id: string; text: string }>>([]);
  const showToast = (text: string) => {
    const id = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    setToasts((t) => [...t, { id, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3000);
  };

  // guard: super_admin only
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        router.replace("/login");
        return;
      }
      try {
        const snap = await getDoc(doc(db, "super_admins", user.uid));
        if (!snap.exists()) {
          router.replace("/dashboard");
          return;
        }
        setAdminUid(user.uid);
      } catch {
        router.replace("/login");
      }
    });
    return () => unsub();
  }, [router]);

  // subscribe to default services
  useEffect(() => {
    if (!adminUid) return;
    const unsub = subscribeDefaultServices((rows) => {
      setServices(
        rows.map((r) => ({
          id: String(r.id),
          name: String(r.name || ""),
          checklist: normalizeChecklist(r.checklist as any[]),
        }))
      );
    });
    return () => unsub();
  }, [adminUid]);

  const openModal = () => {
    setEditingId(null);
    setName("");
    setChecklist([]);
    setNewChecklistItem("");
    setNewChecklistDesc("");
    setIsModalOpen(true);
  };

  const openEdit = (svc: DefaultService) => {
    setEditingId(svc.id);
    setName(svc.name);
    setChecklist(svc.checklist || []);
    setNewChecklistItem("");
    setNewChecklistDesc("");
    setIsModalOpen(true);
  };

  const closeModal = () => setIsModalOpen(false);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!name.trim() || !adminUid) return;

    setSaving(true);
    try {
      const data: DefaultServiceInput = {
        name: name.trim(),
        checklist: checklist.filter((item) => item.name.trim() !== ""),
      };

      if (editingId) {
        await updateDefaultService(editingId, data);
        showToast("Default service updated.");
      } else {
        await createDefaultService(adminUid, data);
        showToast("Default service created!");
      }
      setIsModalOpen(false);
      setEditingId(null);
    } catch (error) {
      console.error("Error saving default service:", error);
      showToast("Failed to save default service.");
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteDefaultService(deleteTarget.id);
      showToast("Default service removed.");
      setDeleteTarget(null);
    } catch {
      showToast("Failed to remove default service.");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div id="app" className="flex h-screen overflow-hidden bg-white">
      <Sidebar />
      <div className="flex-1 flex flex-col overflow-hidden">
        <main className="flex-1 overflow-auto p-4 sm:p-6 lg:p-8">
          <div className="md:hidden mb-4">
            <button
              className="inline-flex items-center gap-2 rounded-lg border border-neutral-200 px-3 py-2 text-neutral-700 shadow-sm hover:bg-neutral-50"
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

          {/* Header Banner */}
          <div className="mb-8">
            <div className="relative rounded-2xl bg-neutral-900 text-white p-6 shadow-sm overflow-hidden">
              <div className="absolute top-0 right-0 w-32 h-32 bg-white/5 rounded-full -translate-y-1/2 translate-x-1/2" />
              <div className="absolute bottom-0 left-1/3 w-20 h-20 bg-white/5 rounded-full translate-y-1/2" />
              <div className="absolute top-3 right-20 text-white/10 text-3xl"><i className="fas fa-gear" /></div>
              <div className="absolute bottom-2 right-40 text-white/10 text-xl"><i className="fas fa-wrench" /></div>
              <div className="relative flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="flex items-center gap-3">
                    <div className="w-11 h-11 rounded-xl bg-amber-500/20 flex items-center justify-center border border-amber-500/30">
                      <i className="fas fa-layer-group text-amber-400" />
                    </div>
                    <h1 className="text-2xl font-bold">Default Service Templates</h1>
                  </div>
                  <p className="text-sm text-neutral-400 mt-2">Manage default services that workshop owners will see as templates</p>
                </div>
              </div>
            </div>
          </div>

          <div className="max-w-7xl mx-auto">
            {/* Section header */}
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-8">
              <div>
                <h2 className="text-2xl font-bold text-neutral-800">Service Templates</h2>
                <p className="text-sm text-neutral-400 mt-1">
                  {services.length} template{services.length !== 1 ? "s" : ""} available &middot; Owners will add their own price, duration, branches &amp; staff
                </p>
              </div>
              <button
                onClick={openModal}
                className="w-full sm:w-auto px-5 py-2.5 bg-neutral-900 text-white rounded-xl text-sm hover:bg-neutral-800 font-semibold shadow-lg shadow-neutral-900/10 transition-all hover:shadow-xl active:scale-[0.97] flex items-center justify-center gap-2"
              >
                <i className="fa-solid fa-plus text-amber-400" />
                Add Default Service
              </button>
            </div>

            {services.length === 0 && (
              <div className="text-center py-20">
                <div className="w-20 h-20 rounded-2xl bg-neutral-100 flex items-center justify-center mx-auto mb-4">
                  <i className="fas fa-layer-group text-3xl text-neutral-300" />
                </div>
                <h3 className="text-lg font-semibold text-neutral-700 mb-2">No default services yet</h3>
                <p className="text-sm text-neutral-400 max-w-md mx-auto">
                  Create default service templates with a name and todo list. Workshop owners will see these as ready-made options.
                </p>
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
              {services.map((s) => (
                <div key={s.id} className="group relative">
                  <div className="relative bg-neutral-900 rounded-2xl overflow-hidden transition-all duration-500 hover:shadow-2xl hover:shadow-amber-500/[0.08] hover:-translate-y-1">
                    <div className="h-1 bg-gradient-to-r from-amber-500 via-amber-400 to-orange-500 opacity-80 group-hover:opacity-100 transition-opacity" />

                    <div className="p-5">
                      {/* Name + Actions */}
                      <div className="flex items-start justify-between mb-4">
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="w-10 h-10 rounded-xl bg-amber-500/15 flex items-center justify-center flex-shrink-0 border border-amber-500/20">
                            <i className="fas fa-wrench text-amber-400" />
                          </div>
                          <h3 className="font-bold text-lg text-white truncate">{s.name}</h3>
                        </div>
                        <div className="flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-all">
                          <button
                            onClick={() => setPreviewService(s)}
                            className="w-8 h-8 rounded-lg flex items-center justify-center bg-white/10 text-white hover:bg-white/20 transition-all"
                            title="View"
                          >
                            <i className="fas fa-eye text-xs" />
                          </button>
                          <button
                            onClick={() => openEdit(s)}
                            className="w-8 h-8 rounded-lg flex items-center justify-center bg-white/10 text-white hover:bg-blue-500/80 transition-all"
                            title="Edit"
                          >
                            <i className="fas fa-pen text-xs" />
                          </button>
                          <button
                            onClick={() => setDeleteTarget(s)}
                            className="w-8 h-8 rounded-lg flex items-center justify-center bg-white/10 text-white hover:bg-rose-500/80 transition-all"
                            title="Delete"
                          >
                            <i className="fas fa-trash text-xs" />
                          </button>
                        </div>
                      </div>

                      {/* Badges */}
                      <div className="flex flex-wrap gap-2 mb-4">
                        {s.checklist.length > 0 && (
                          <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold bg-amber-500/10 text-amber-400 px-2.5 py-1.5 rounded-lg border border-amber-500/10">
                            <i className="fas fa-clipboard-check text-[9px]" />
                            {s.checklist.length} Tasks
                          </span>
                        )}
                        <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold bg-emerald-500/10 text-emerald-400 px-2.5 py-1.5 rounded-lg border border-emerald-500/10">
                          <i className="fas fa-layer-group text-[9px]" />
                          Template
                        </span>
                      </div>

                      {/* Todo list preview */}
                      {s.checklist.length > 0 && (
                        <div className="bg-white/[0.04] rounded-xl border border-white/[0.06] p-3.5">
                          <div className="flex items-center gap-2 mb-2.5">
                            <i className="fas fa-clipboard-list text-amber-500 text-[10px]" />
                            <span className="text-[10px] font-bold text-neutral-400 uppercase tracking-widest">Todo List</span>
                          </div>
                          <div className="space-y-1.5">
                            {s.checklist.slice(0, 3).map((item, i) => (
                              <div key={i} className="flex items-start gap-2">
                                <div className="w-4 h-4 rounded bg-amber-500/15 flex items-center justify-center flex-shrink-0 mt-0.5">
                                  <i className="fas fa-check text-amber-400 text-[7px]" />
                                </div>
                                <div className="min-w-0">
                                  <span className="text-xs text-neutral-300 truncate font-medium block">{item.name}</span>
                                  {item.description && (
                                    <span className="text-[10px] text-neutral-500 truncate block">{item.description}</span>
                                  )}
                                </div>
                              </div>
                            ))}
                            {s.checklist.length > 3 && (
                              <button
                                onClick={() => setPreviewService(s)}
                                className="text-[11px] text-amber-500 hover:text-amber-400 font-semibold pl-6 transition-colors cursor-pointer"
                              >
                                +{s.checklist.length - 3} more tasks &rarr;
                              </button>
                            )}
                          </div>
                        </div>
                      )}

                      {s.checklist.length === 0 && (
                        <div className="bg-white/[0.04] rounded-xl border border-white/[0.06] p-4 text-center">
                          <i className="fas fa-clipboard text-neutral-600 text-lg mb-1 block" />
                          <span className="text-xs text-neutral-500">No tasks added yet</span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </main>
      </div>

      {/* Toasts */}
      <div className="fixed bottom-5 right-5 z-50 space-y-2">
        {toasts.map((t) => (
          <div key={t.id} className="toast bg-neutral-800 text-white px-4 py-3 rounded-lg shadow-md border-l-4 border-amber-500 flex items-center gap-2">
            <i className="fas fa-circle-check text-amber-500" />
            <span className="text-sm">{t.text}</span>
          </div>
        ))}
      </div>

      {/* Add/Edit Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 bg-neutral-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-2 sm:p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[85vh] sm:max-h-[90vh] flex flex-col">
            <div className="relative bg-neutral-900 p-3 sm:p-5 border-b border-neutral-700 flex justify-between items-center rounded-t-xl shrink-0 overflow-hidden">
              <div className="absolute top-0 right-0 w-24 h-24 bg-white/5 rounded-full -translate-y-1/2 translate-x-1/2" />
              <div className="absolute top-2 right-20 text-white/10 text-xl"><i className="fas fa-gear" /></div>
              <div className="relative flex items-center gap-2 sm:gap-3">
                <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-lg bg-amber-500/20 flex items-center justify-center border border-amber-500/30">
                  <i className="fa-solid fa-layer-group text-amber-400 text-sm sm:text-base" />
                </div>
                <h3 className="font-bold text-white text-sm sm:text-lg">{editingId ? "Edit Default Service" : "Add Default Service"}</h3>
              </div>
              <button
                type="button"
                onClick={closeModal}
                className="text-white/60 hover:text-white transition w-8 h-8 rounded-lg hover:bg-white/10 flex items-center justify-center"
              >
                <i className="fa-solid fa-xmark text-xl" />
              </button>
            </div>
            <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto custom-scrollbar">
              <div className="p-3 sm:p-6 space-y-3 sm:space-y-4">
                {/* Service Name */}
                <div className="bg-neutral-50 rounded-lg sm:rounded-xl p-3 sm:p-4 border border-neutral-200">
                  <h4 className="text-xs sm:text-sm font-bold text-neutral-700 mb-2 sm:mb-3 flex items-center gap-2">
                    <i className="fas fa-sparkles text-amber-500" />
                    Service Name
                  </h4>
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                    className="w-full border border-neutral-300 rounded-lg p-2 sm:p-2.5 text-xs sm:text-sm focus:ring-2 focus:ring-neutral-900 focus:outline-none"
                    placeholder="e.g. Full Vehicle Service"
                  />
                  <p className="text-[10px] text-neutral-400 mt-2">
                    <i className="fas fa-info-circle mr-1" />
                    Owners can rename this when they use the template
                  </p>
                </div>

                {/* Todo List */}
                <div className="bg-amber-50 rounded-lg sm:rounded-xl p-3 sm:p-4 border border-amber-200">
                  <h4 className="text-xs sm:text-sm font-bold text-neutral-700 mb-2 sm:mb-3 flex items-center gap-2">
                    <i className="fas fa-clipboard-list text-amber-600" />
                    Default Todo List
                  </h4>
                  <p className="text-[10px] text-amber-700 mb-3">
                    <i className="fas fa-info-circle mr-1" />
                    These tasks will be included as defaults when an owner uses this template. They can modify them.
                  </p>

                  {checklist.length > 0 && (
                    <div className="space-y-2.5 mb-3">
                      {checklist.map((item, index) => (
                        <div key={index} className="bg-white rounded-xl border border-amber-200 overflow-hidden group/item">
                          <div className="flex items-start gap-2.5 p-3">
                            <div className="w-6 h-6 rounded-lg bg-amber-100 flex items-center justify-center flex-shrink-0 mt-0.5">
                              <span className="text-[10px] font-bold text-amber-700">{index + 1}</span>
                            </div>
                            <div className="flex-1 min-w-0 space-y-1.5">
                              <input
                                type="text"
                                value={item.name}
                                onChange={(e) => {
                                  const updated = [...checklist];
                                  updated[index] = { ...updated[index], name: e.target.value };
                                  setChecklist(updated);
                                }}
                                placeholder="Task name"
                                className="w-full text-xs sm:text-sm font-semibold text-neutral-800 bg-transparent focus:outline-none focus:ring-0 border-none p-0"
                              />
                              <textarea
                                value={item.description}
                                onChange={(e) => {
                                  const updated = [...checklist];
                                  updated[index] = { ...updated[index], description: e.target.value };
                                  setChecklist(updated);
                                }}
                                placeholder="Description (optional)"
                                rows={2}
                                className="w-full text-[11px] sm:text-xs text-neutral-500 bg-neutral-50 rounded-lg border border-neutral-200 p-2 focus:outline-none focus:ring-1 focus:ring-amber-400 focus:border-amber-400 resize-none"
                              />
                            </div>
                            <button
                              type="button"
                              onClick={() => setChecklist(checklist.filter((_, i) => i !== index))}
                              className="opacity-0 group-hover/item:opacity-100 w-6 h-6 rounded-md bg-red-50 text-red-400 hover:bg-red-100 hover:text-red-600 flex items-center justify-center transition-all flex-shrink-0 mt-0.5"
                            >
                              <i className="fas fa-trash-can text-[9px]" />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="bg-white rounded-xl border border-dashed border-amber-300 p-3 space-y-2">
                    <input
                      type="text"
                      value={newChecklistItem}
                      onChange={(e) => setNewChecklistItem(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          if (newChecklistItem.trim()) {
                            setChecklist([...checklist, { name: newChecklistItem.trim(), description: newChecklistDesc.trim(), done: false, imageUrl: "" }]);
                            setNewChecklistItem("");
                            setNewChecklistDesc("");
                          }
                        }
                      }}
                      placeholder="Task name — e.g. Oil & filter change"
                      className="w-full border border-amber-300 rounded-lg p-2 sm:p-2.5 text-xs sm:text-sm focus:ring-2 focus:ring-amber-500 focus:outline-none"
                    />
                    <textarea
                      value={newChecklistDesc}
                      onChange={(e) => setNewChecklistDesc(e.target.value)}
                      placeholder="Description (optional)"
                      rows={2}
                      className="w-full border border-neutral-200 rounded-lg p-2 text-[11px] sm:text-xs text-neutral-500 focus:ring-1 focus:ring-amber-400 focus:outline-none resize-none"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        if (newChecklistItem.trim()) {
                          setChecklist([...checklist, { name: newChecklistItem.trim(), description: newChecklistDesc.trim(), done: false, imageUrl: "" }]);
                          setNewChecklistItem("");
                          setNewChecklistDesc("");
                        }
                      }}
                      className="w-full py-2 bg-neutral-900 text-white rounded-lg hover:bg-neutral-800 transition-all text-xs sm:text-sm font-medium flex items-center justify-center gap-1.5"
                    >
                      <i className="fas fa-plus text-[10px]" />
                      Add Task
                    </button>
                  </div>

                  {checklist.length > 0 && (
                    <div className="mt-2 text-[10px] text-amber-600 font-medium">
                      <i className="fas fa-list-check mr-1" />
                      {checklist.length} task{checklist.length !== 1 ? "s" : ""} in todo list
                    </div>
                  )}
                </div>
              </div>

              {/* Footer Submit */}
              <div className="p-3 sm:p-4 bg-neutral-50 border-t border-neutral-200 rounded-b-xl shrink-0">
                <button
                  type="submit"
                  disabled={saving}
                  className={`w-full bg-neutral-900 text-white font-bold py-2.5 sm:py-3 rounded-lg shadow-lg transition-all text-sm sm:text-base ${
                    saving ? "opacity-60 cursor-not-allowed" : "hover:bg-neutral-800 hover:shadow-xl transform active:scale-95 sm:hover:scale-[1.02]"
                  }`}
                >
                  {saving ? (
                    <span className="inline-flex items-center justify-center gap-2">
                      <i className="fa-solid fa-circle-notch fa-spin" />
                      Saving...
                    </span>
                  ) : (
                    <span className="inline-flex items-center justify-center gap-2">
                      <i className="fa-solid fa-save" />
                      {editingId ? "Save Changes" : "Create Default Service"}
                    </span>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Preview Sidebar */}
      <div
        className={`fixed inset-0 z-50 ${previewService ? "pointer-events-auto" : "pointer-events-none"}`}
        aria-hidden={!previewService}
      >
        <div
          onClick={() => setPreviewService(null)}
          className={`absolute inset-0 bg-black/50 transition-opacity duration-200 ${previewService ? "opacity-100" : "opacity-0"}`}
        />
        <aside
          className={`absolute top-0 h-full right-0 w-[92vw] sm:w-[28rem] bg-white shadow-2xl border-l border-neutral-200 transform transition-transform duration-300 ${previewService ? "translate-x-0" : "translate-x-full"}`}
        >
          {previewService && (
            <div className="flex h-full flex-col">
              <div className="shrink-0 relative bg-neutral-900 p-5 overflow-hidden">
                <div className="absolute top-0 right-0 w-24 h-24 bg-white/5 rounded-full -translate-y-1/2 translate-x-1/2" />
                <div className="relative flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-amber-500/20 flex items-center justify-center border border-amber-500/30">
                      <i className="fas fa-eye text-amber-400" />
                    </div>
                    <div>
                      <h3 className="text-lg font-bold text-white">Template Details</h3>
                      <p className="text-white/80 text-sm">{previewService.name}</p>
                    </div>
                  </div>
                  <button
                    onClick={() => setPreviewService(null)}
                    className="w-9 h-9 bg-white/20 backdrop-blur-sm hover:bg-white/30 rounded-full flex items-center justify-center text-white transition-all"
                  >
                    <i className="fas fa-times text-lg" />
                  </button>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto">
                <div className="p-5 space-y-5">
                  {/* Service Name */}
                  <div className="bg-neutral-50 rounded-xl p-4 border-2 border-neutral-200">
                    <h3 className="text-sm font-bold text-neutral-800 mb-2 flex items-center gap-2">
                      <i className="fas fa-tag text-amber-500" />
                      Service Name
                    </h3>
                    <p className="text-lg font-bold text-neutral-900">{previewService.name}</p>
                  </div>

                  {/* Todo List */}
                  {previewService.checklist.length > 0 ? (
                    <div className="bg-gradient-to-br from-amber-50 to-orange-50 rounded-xl p-4 border-2 border-amber-200">
                      <h3 className="text-sm font-bold text-neutral-800 mb-3 flex items-center gap-2">
                        <i className="fas fa-clipboard-list text-amber-600" />
                        Default Todo List
                        <span className="ml-auto text-[10px] bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full font-semibold">
                          {previewService.checklist.length} task{previewService.checklist.length !== 1 ? "s" : ""}
                        </span>
                      </h3>
                      <div className="space-y-2">
                        {previewService.checklist.map((item, index) => (
                          <div key={index} className="flex items-start gap-2.5 bg-white rounded-lg p-3 border border-amber-100">
                            <div className="w-6 h-6 rounded-lg bg-amber-500 flex items-center justify-center flex-shrink-0 mt-0.5">
                              <span className="text-[10px] font-bold text-white">{index + 1}</span>
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-sm text-neutral-800 font-semibold">{item.name}</p>
                              {item.description && (
                                <p className="text-xs text-neutral-500 mt-0.5">{item.description}</p>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="bg-neutral-50 rounded-xl p-6 border-2 border-neutral-200 text-center">
                      <i className="fas fa-clipboard text-neutral-300 text-2xl mb-2 block" />
                      <p className="text-sm text-neutral-500">No tasks in this template</p>
                    </div>
                  )}

                  {/* Info note */}
                  <div className="bg-blue-50 rounded-xl p-4 border border-blue-200">
                    <p className="text-xs text-blue-700">
                      <i className="fas fa-info-circle mr-1.5" />
                      When owners use this template, they&apos;ll add their own price, duration, branches, staff, and image.
                    </p>
                  </div>
                </div>
              </div>

              <div className="shrink-0 border-t border-neutral-200 p-4 bg-white flex gap-3">
                <button
                  onClick={() => setPreviewService(null)}
                  className="flex-1 px-4 py-2.5 bg-neutral-200 text-neutral-700 rounded-lg font-semibold hover:bg-neutral-300 transition-all text-sm"
                >
                  <i className="fas fa-times mr-2" />
                  Close
                </button>
                <button
                  onClick={() => {
                    const svc = previewService;
                    setPreviewService(null);
                    openEdit(svc);
                  }}
                  className="flex-1 px-4 py-2.5 bg-neutral-900 text-white rounded-lg font-semibold hover:bg-neutral-800 shadow-lg hover:shadow-xl transition-all text-sm"
                >
                  <i className="fas fa-pen mr-2" />
                  Edit Template
                </button>
              </div>
            </div>
          )}
        </aside>
      </div>

      {/* Delete Confirmation */}
      {deleteTarget && (
        <div className="fixed inset-0 bg-neutral-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0" onClick={() => !deleting && setDeleteTarget(null)} />
          <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
            <div className="p-6 border-b border-neutral-100 flex items-center gap-3">
              <div className="w-12 h-12 rounded-full bg-rose-100 text-rose-600 flex items-center justify-center shrink-0">
                <i className="fa-solid fa-triangle-exclamation text-xl" />
              </div>
              <h3 className="font-semibold text-neutral-900 text-lg">Delete Default Service?</h3>
            </div>
            <div className="p-6 text-sm text-neutral-600">
              Are you sure you want to delete <span className="font-semibold text-neutral-800">&quot;{deleteTarget.name}&quot;</span>?
              This will remove the template. Existing copies made by owners will not be affected.
            </div>
            <div className="px-6 pb-6 flex items-center justify-end gap-3">
              <button
                onClick={() => setDeleteTarget(null)}
                disabled={deleting}
                className="px-5 py-2.5 rounded-lg border border-neutral-300 text-neutral-700 hover:bg-neutral-50 disabled:opacity-60 font-medium transition-all"
              >
                Cancel
              </button>
              <button
                onClick={confirmDelete}
                disabled={deleting}
                className="px-5 py-2.5 rounded-lg bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-60 font-medium transition-all shadow-md hover:shadow-lg"
              >
                {deleting ? (
                  <span className="inline-flex items-center gap-2">
                    <i className="fa-solid fa-circle-notch fa-spin" />
                    Deleting...
                  </span>
                ) : (
                  <span>
                    <i className="fa-solid fa-trash mr-2" />
                    Delete Template
                  </span>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
