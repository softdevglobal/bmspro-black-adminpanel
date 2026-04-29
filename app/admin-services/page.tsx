"use client";
import React, { useEffect, useState } from "react";
import Sidebar from "@/components/Sidebar";
import { useRouter } from "next/navigation";
import { onAuthStateChanged } from "firebase/auth";
import { auth, db } from "@/lib/firebase";
import { doc, getDoc } from "firebase/firestore";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

type ToastVariant = "success" | "error" | "warning";
import { getErrorMessage } from "@/lib/errorMessage";
import {
  createDefaultService,
  updateDefaultService,
  deleteDefaultService,
  subscribeDefaultServices,
  type DefaultServiceInput,
} from "@/lib/defaultServices";
import {
  CHECKLIST_SECTIONS,
  CHECKLIST_SECTION_LABELS,
  DEFAULT_AREA_ORDER,
  isChecklistSection,
  normalizeAreaOrder,
  normalizeChecklist,
  groupChecklistItemsWithGlobalNumbers,
  type ChecklistItem,
  type ChecklistSection,
} from "@/lib/services";
import { nativeSelectInsetChevronClass } from "@/lib/nativeSelectChevron";

type DefaultService = {
  id: string;
  name: string;
  checklist: ChecklistItem[];
  areaOrder: ChecklistSection[];
};

/** dnd-kit id prefixes so chip drags can be told apart from task-row drags. */
const CHIP_ID_PREFIX = "area-chip:";
const chipId = (s: ChecklistSection) => `${CHIP_ID_PREFIX}${s}` as const;
const sectionFromChipId = (id: string): ChecklistSection | null => {
  if (!id.startsWith(CHIP_ID_PREFIX)) return null;
  const raw = id.slice(CHIP_ID_PREFIX.length);
  return isChecklistSection(raw) ? raw : null;
};
const ROW_ID_PREFIX = "row:";
const rowDndId = (rowId: string) => `${ROW_ID_PREFIX}${rowId}`;
const rowIdFromDndId = (id: string): string | null =>
  id.startsWith(ROW_ID_PREFIX) ? id.slice(ROW_ID_PREFIX.length) : null;

type ChecklistRow = ChecklistItem & { id: string };

function newChecklistRowId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

function rowsFromChecklist(items: ChecklistItem[]): ChecklistRow[] {
  return items.map((c) => ({ ...c, id: newChecklistRowId() }));
}

function checklistPayloadFromRows(rows: ChecklistRow[]): ChecklistItem[] {
  return rows
    .map(({ id: _id, ...item }) => item)
    .filter((item) => item.name.trim() !== "");
}

/** Preview drawer — light area bars + dark text (same look as Book Now). */
const CHECKLIST_SECTION_BADGE: Record<ChecklistSection, string> = {
  interior: "border-blue-300 bg-blue-50 text-blue-900",
  engine_bay: "border-neutral-400 bg-white text-neutral-900",
  underbody: "border-violet-300 bg-violet-50 text-violet-900",
  exterior: "border-emerald-300 bg-emerald-50 text-emerald-900",
};

const CHECKLIST_SECTION_ICON: Record<ChecklistSection, string> = {
  interior: "fas fa-car-side",
  engine_bay: "fas fa-gears",
  underbody: "fas fa-wrench",
  exterior: "fas fa-car",
};

/** Pastel palette for the draggable area chips in the editor. */
const AREA_CHIP_THEME: Record<ChecklistSection, { base: string; active: string; dropTint: string; dot: string }> = {
  interior: {
    base: "border-blue-200 bg-blue-50 text-blue-800 hover:bg-blue-100",
    active: "border-blue-500 bg-blue-100 text-blue-900 ring-2 ring-blue-300",
    dropTint: "border-blue-500 bg-blue-100 text-blue-900 ring-2 ring-blue-400 ring-offset-1",
    dot: "bg-blue-500",
  },
  engine_bay: {
    base: "border-neutral-300 bg-white text-neutral-800 hover:bg-neutral-100",
    active: "border-neutral-600 bg-neutral-100 text-neutral-900 ring-2 ring-neutral-400",
    dropTint: "border-neutral-600 bg-neutral-100 text-neutral-900 ring-2 ring-neutral-500 ring-offset-1",
    dot: "bg-neutral-700",
  },
  underbody: {
    base: "border-violet-200 bg-violet-50 text-violet-800 hover:bg-violet-100",
    active: "border-violet-500 bg-violet-100 text-violet-900 ring-2 ring-violet-300",
    dropTint: "border-violet-500 bg-violet-100 text-violet-900 ring-2 ring-violet-400 ring-offset-1",
    dot: "bg-violet-500",
  },
  exterior: {
    base: "border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100",
    active: "border-emerald-500 bg-emerald-100 text-emerald-900 ring-2 ring-emerald-300",
    dropTint: "border-emerald-500 bg-emerald-100 text-emerald-900 ring-2 ring-emerald-400 ring-offset-1",
    dot: "bg-emerald-500",
  },
};

function SortableAreaChip({
  section,
  count,
  active,
  draggingRow,
  onClick,
}: {
  section: ChecklistSection;
  count: number;
  active: boolean;
  draggingRow: boolean;
  onClick: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging, isOver } = useSortable({
    id: chipId(section),
  });
  const theme = AREA_CHIP_THEME[section];
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.85 : 1,
    zIndex: isDragging ? 30 : undefined,
    position: "relative" as const,
  };
  const highlight = draggingRow && isOver
    ? theme.dropTint
    : active
      ? theme.active
      : theme.base;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex w-full items-center justify-between gap-2 rounded-lg border-2 px-3 py-2 text-xs font-semibold shadow-sm select-none transition-colors ${highlight} ${
        isDragging ? "cursor-grabbing" : "cursor-grab"
      }`}
      {...attributes}
      {...listeners}
      onClick={onClick}
      role="button"
      aria-pressed={active}
      aria-label={`${CHECKLIST_SECTION_LABELS[section]} (${count} task${count !== 1 ? "s" : ""})`}
      title="Drag to reorder • Drop a task here to move it into this area • Click to quick-pick for next task"
    >
      <div className="flex items-center gap-2 min-w-0">
        <i className="fas fa-grip-vertical text-[10px] text-neutral-400" aria-hidden />
        <i className={`${CHECKLIST_SECTION_ICON[section]} text-[11px] opacity-80`} />
        <span className="truncate">{CHECKLIST_SECTION_LABELS[section]}</span>
      </div>
      <span className={`inline-flex h-5 min-w-[1.5rem] items-center justify-center rounded ${theme.dot} px-1.5 text-[10px] font-bold text-white tabular-nums`}>
        {count}
      </span>
    </div>
  );
}

function SortableChecklistRow({
  row,
  index,
  onNameChange,
  onDescriptionChange,
  onSectionChange,
  onRemove,
}: {
  row: ChecklistRow;
  index: number;
  onNameChange: (name: string) => void;
  onDescriptionChange: (description: string) => void;
  onSectionChange: (section: ChecklistSection) => void;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: rowDndId(row.id),
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.92 : 1,
    zIndex: isDragging ? 20 : undefined,
    position: "relative" as const,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`bg-white rounded-xl border overflow-hidden group/item ${
        isDragging ? "border-amber-400 shadow-lg ring-2 ring-amber-200" : "border-amber-200"
      }`}
    >
      <div className="flex items-start gap-2 p-3">
        <button
          type="button"
          className="mt-0.5 flex h-8 w-6 shrink-0 cursor-grab touch-none items-center justify-center rounded-md border border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100 active:cursor-grabbing"
          aria-label="Drag to reorder"
          {...attributes}
          {...listeners}
        >
          <i className="fas fa-grip-vertical text-[11px]" />
        </button>
        <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-amber-100">
          <span className="text-[10px] font-bold text-amber-700">{index + 1}</span>
        </div>
        <div className="min-w-0 flex-1 space-y-1.5">
          <input
            type="text"
            value={row.name}
            onChange={(e) => onNameChange(e.target.value)}
            placeholder="Task name"
            className="w-full border-none bg-transparent p-0 text-xs font-semibold text-neutral-800 focus:outline-none focus:ring-0 sm:text-sm"
          />
          <textarea
            value={row.description}
            onChange={(e) => onDescriptionChange(e.target.value)}
            placeholder="Description (optional)"
            rows={2}
            className="w-full resize-none rounded-lg border border-neutral-200 bg-neutral-50 p-2 text-[11px] text-neutral-500 focus:border-amber-400 focus:outline-none focus:ring-1 focus:ring-amber-400 sm:text-xs"
          />
          <div className="pt-0.5">
            <select
              value={isChecklistSection(row.section) ? row.section : ""}
              onChange={(e) => {
                const v = e.target.value;
                if (v) onSectionChange(v as ChecklistSection);
              }}
              aria-label="Select area"
              className={`${nativeSelectInsetChevronClass} w-full rounded-md border border-neutral-200 py-1.5 text-[11px] focus:border-amber-400 focus:outline-none focus:ring-1 focus:ring-amber-400 sm:text-xs ${
                isChecklistSection(row.section) ? "text-neutral-700" : "text-neutral-400"
              }`}
            >
              <option value="" disabled hidden>
                Select area
              </option>
              {CHECKLIST_SECTIONS.map((s) => (
                <option key={s} value={s}>
                  {CHECKLIST_SECTION_LABELS[s]}
                </option>
              ))}
            </select>
          </div>
        </div>
        <button
          type="button"
          onClick={onRemove}
          className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-red-50 text-red-400 opacity-0 transition-all hover:bg-red-100 hover:text-red-600 group-hover/item:opacity-100"
          aria-label="Remove task"
        >
          <i className="fas fa-trash-can text-[9px]" />
        </button>
      </div>
    </div>
  );
}

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
  const [checklistRows, setChecklistRows] = useState<ChecklistRow[]>([]);
  const [newChecklistItem, setNewChecklistItem] = useState("");
  const [newChecklistDesc, setNewChecklistDesc] = useState("");
  /** Empty string shows “Select area” placeholder in the add-task dropdown until the user picks. */
  const [newChecklistSection, setNewChecklistSection] = useState<ChecklistSection | "">("");
  const [areaOrder, setAreaOrder] = useState<ChecklistSection[]>(DEFAULT_AREA_ORDER);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);

  /** Live per-area task counts for the chip badges. */
  const areaCounts = React.useMemo(() => {
    const counts: Record<ChecklistSection, number> = {
      interior: 0,
      engine_bay: 0,
      underbody: 0,
      exterior: 0,
    };
    for (const r of checklistRows) {
      if (isChecklistSection(r.section)) counts[r.section]++;
    }
    return counts;
  }, [checklistRows]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const onChecklistDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveDragId(null);
    if (!over) return;
    const activeId = String(active.id);
    const overId = String(over.id);
    const activeChipSection = sectionFromChipId(activeId);
    const overChipSection = sectionFromChipId(overId);

    // Area chip reordering
    if (activeChipSection && overChipSection) {
      if (activeChipSection === overChipSection) return;
      setAreaOrder((prev) => {
        const from = prev.indexOf(activeChipSection);
        const to = prev.indexOf(overChipSection);
        if (from < 0 || to < 0) return prev;
        return arrayMove(prev, from, to);
      });
      return;
    }

    const activeRowId = rowIdFromDndId(activeId);
    if (!activeRowId) return;

    // Row dropped on a chip → reassign that row's area
    if (overChipSection) {
      setChecklistRows((rows) =>
        rows.map((r) => (r.id === activeRowId ? { ...r, section: overChipSection } : r))
      );
      return;
    }

    const overRowId = rowIdFromDndId(overId);
    if (!overRowId || activeRowId === overRowId) return;
    setChecklistRows((items) => {
      const oldIndex = items.findIndex((r) => r.id === activeRowId);
      const newIndex = items.findIndex((r) => r.id === overRowId);
      if (oldIndex < 0 || newIndex < 0) return items;
      return arrayMove(items, oldIndex, newIndex);
    });
  };

  const [toasts, setToasts] = useState<
    Array<{ id: string; text: string; variant: ToastVariant }>
  >([]);
  const showToast = (text: string, variant: ToastVariant = "success") => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
    setToasts((t) => [...t, { id, text, variant }]);
    const duration =
      variant === "error" ? 6500 : variant === "warning" ? 4500 : 3200;
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), duration);
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
          areaOrder: normalizeAreaOrder((r as any).areaOrder),
        }))
      );
    });
    return () => unsub();
  }, [adminUid]);

  const openModal = () => {
    setEditingId(null);
    setName("");
    setChecklistRows([]);
    setNewChecklistItem("");
    setNewChecklistDesc("");
    setNewChecklistSection("");
    setAreaOrder(DEFAULT_AREA_ORDER);
    setIsModalOpen(true);
  };

  const openEdit = (svc: DefaultService) => {
    setEditingId(svc.id);
    setName(svc.name);
    setChecklistRows(rowsFromChecklist(svc.checklist || []));
    setNewChecklistItem("");
    setNewChecklistDesc("");
    setNewChecklistSection("");
    setAreaOrder(normalizeAreaOrder(svc.areaOrder));
    setIsModalOpen(true);
  };

  const closeModal = () => setIsModalOpen(false);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!name.trim() || !adminUid) return;

    const checklistPayload = checklistPayloadFromRows(checklistRows);
    if (
      checklistPayload.some(
        (item) => item.name.trim() !== "" && !isChecklistSection(item.section)
      )
    ) {
      showToast("Please select a vehicle area for every task.", "error");
      return;
    }

    setSaving(true);
    try {
      const data: DefaultServiceInput = {
        name: name.trim(),
        checklist: checklistPayload,
        areaOrder,
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
      const detail = getErrorMessage(error, "");
      showToast(
        detail ? `Failed to save default service. ${detail}` : "Failed to save default service.",
        "error",
      );
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
    } catch (err) {
      showToast(
        `Failed to remove default service. ${getErrorMessage(err, "Please try again.")}`,
        "error",
      );
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
                  <p className="text-[10px] text-neutral-500 mb-3">
                    <i className="fas fa-arrows-alt-v mr-1" />
                    Drag the grip handle to reorder tasks. Use the <strong>Area order</strong> panel below to reorder areas (drag chips) or reassign tasks (drop a task onto a chip).
                  </p>

                  <DndContext
                    sensors={sensors}
                    collisionDetection={closestCenter}
                    onDragStart={(ev) => setActiveDragId(String(ev.active.id))}
                    onDragCancel={() => setActiveDragId(null)}
                    onDragEnd={onChecklistDragEnd}
                  >
                    {checklistRows.length > 0 && (
                      <SortableContext items={checklistRows.map((r) => rowDndId(r.id))} strategy={verticalListSortingStrategy}>
                        <div className="mb-3 space-y-2.5">
                          {checklistRows.map((row, index) => (
                            <SortableChecklistRow
                              key={row.id}
                              row={row}
                              index={index}
                              onNameChange={(value) => {
                                setChecklistRows((prev) =>
                                  prev.map((r) => (r.id === row.id ? { ...r, name: value } : r))
                                );
                              }}
                              onDescriptionChange={(value) => {
                                setChecklistRows((prev) =>
                                  prev.map((r) => (r.id === row.id ? { ...r, description: value } : r))
                                );
                              }}
                              onSectionChange={(value) => {
                                setChecklistRows((prev) =>
                                  prev.map((r) => (r.id === row.id ? { ...r, section: value } : r))
                                );
                              }}
                              onRemove={() => {
                                setChecklistRows((prev) => prev.filter((r) => r.id !== row.id));
                              }}
                            />
                          ))}
                        </div>
                      </SortableContext>
                    )}

                    <div className="bg-white rounded-xl border border-dashed border-amber-300 p-3 space-y-2">
                    <input
                      type="text"
                      value={newChecklistItem}
                      onChange={(e) => setNewChecklistItem(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          if (!newChecklistItem.trim()) return;
                          if (newChecklistSection === "") {
                            showToast("Please select an area.", "error");
                            return;
                          }
                          setChecklistRows((prev) => [
                            ...prev,
                            {
                              id: newChecklistRowId(),
                              name: newChecklistItem.trim(),
                              description: newChecklistDesc.trim(),
                              done: false,
                              section: newChecklistSection,
                            },
                          ]);
                          setNewChecklistItem("");
                          setNewChecklistDesc("");
                          setNewChecklistSection("");
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
                    <select
                      value={newChecklistSection}
                      onChange={(e) =>
                        setNewChecklistSection(
                          e.target.value === "" ? "" : (e.target.value as ChecklistSection)
                        )
                      }
                      aria-label="Select area"
                      className={`${nativeSelectInsetChevronClass} w-full rounded-md border border-neutral-200 py-1.5 text-[11px] focus:border-amber-400 focus:outline-none focus:ring-1 focus:ring-amber-400 sm:text-xs ${
                        newChecklistSection === "" ? "text-neutral-400" : "text-neutral-700"
                      }`}
                    >
                      <option value="" disabled hidden>
                        Select area
                      </option>
                      {CHECKLIST_SECTIONS.map((s) => (
                        <option key={s} value={s}>
                          {CHECKLIST_SECTION_LABELS[s]}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => {
                        if (!newChecklistItem.trim()) return;
                        if (newChecklistSection === "") {
                          showToast("Please select an area.", "error");
                          return;
                        }
                        setChecklistRows((prev) => [
                          ...prev,
                          {
                            id: newChecklistRowId(),
                            name: newChecklistItem.trim(),
                            description: newChecklistDesc.trim(),
                            done: false,
                            section: newChecklistSection,
                          },
                        ]);
                        setNewChecklistItem("");
                        setNewChecklistDesc("");
                        setNewChecklistSection("");
                      }}
                      className="w-full py-2 bg-neutral-900 text-white rounded-lg hover:bg-neutral-800 transition-all text-xs sm:text-sm font-medium flex items-center justify-center gap-1.5"
                    >
                      <i className="fas fa-plus text-[10px]" />
                      Add Task
                    </button>
                  </div>

                    {checklistRows.length > 0 && (
                      <div className="mt-2 text-[10px] text-amber-600 font-medium">
                        <i className="fas fa-list-check mr-1" />
                        {checklistRows.length} task{checklistRows.length !== 1 ? "s" : ""} in todo list
                      </div>
                    )}
                    {/* Area-order chips are intentionally hidden for super-admin
                        templates — workshop owners customise the order per-service
                        on their own form. Templates always use the default order. */}
                  </DndContext>
                  {/* Inline customer preview is owner-only — super-admin
                      templates don't expose the area order or preview button;
                      owners see the preview on their service form. */}
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
                      <div className="space-y-4">
                        {groupChecklistItemsWithGlobalNumbers(previewService.checklist, previewService.areaOrder).map((group) => (
                          <div key={group.key} className="space-y-2">
                            <div
                              className={
                                group.key === "unset"
                                  ? "flex items-center gap-2 rounded-lg border-2 border-neutral-300 bg-neutral-50 px-2.5 py-1.5 text-neutral-800"
                                  : `flex items-center gap-2 rounded-lg border-2 px-2.5 py-1.5 ${CHECKLIST_SECTION_BADGE[group.key as ChecklistSection]}`
                              }
                            >
                              {group.key === "unset" ? (
                                <>
                                  <i className="fas fa-question-circle text-[10px] text-neutral-500" />
                                  <span className="text-[11px] font-bold">Area not set</span>
                                </>
                              ) : (
                                <>
                                  <i className={`${CHECKLIST_SECTION_ICON[group.key]} text-[10px] opacity-90`} />
                                  <span className="text-[11px] font-bold">
                                    {CHECKLIST_SECTION_LABELS[group.key as ChecklistSection]}
                                  </span>
                                </>
                              )}
                              <span className="ml-auto text-[10px] font-semibold text-neutral-600">
                                {group.items.length} task{group.items.length !== 1 ? "s" : ""}
                              </span>
                            </div>
                            {group.items.map(({ item, num }) => (
                              <div
                                key={`${group.key}-${num}-${item.name}`}
                                className="flex items-start gap-2.5 bg-white rounded-lg p-3 border border-amber-100"
                              >
                                <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-amber-400 via-amber-500 to-orange-600 shadow-sm shadow-amber-500/40 tabular-nums">
                                  <span className="text-[10px] font-black text-white leading-none drop-shadow-[0_1px_1px_rgba(0,0,0,0.35)]">{num}</span>
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

      <div
        id="toast-container"
        className="pointer-events-none fixed bottom-5 right-5 z-[200] flex max-w-[min(100vw-1.5rem,22rem)] flex-col gap-2"
        aria-live="polite"
      >
        {toasts.map((t) => {
          const isErr = t.variant === "error";
          const isWarn = t.variant === "warning";
          return (
            <div
              key={t.id}
              className={
                isErr
                  ? "pointer-events-auto flex items-start gap-3 rounded-lg border-l-4 border-red-500 bg-neutral-950 px-4 py-3 text-sm font-medium leading-snug text-white shadow-2xl ring-1 ring-white/10"
                  : isWarn
                    ? "pointer-events-auto flex items-start gap-3 rounded-lg border-l-4 border-amber-400 bg-neutral-900 px-4 py-3 text-sm font-medium leading-snug text-white shadow-2xl ring-1 ring-white/10"
                    : "pointer-events-auto flex items-start gap-3 rounded-lg border-l-4 border-emerald-500 bg-neutral-900 px-4 py-3 text-sm font-medium leading-snug text-white shadow-2xl ring-1 ring-white/10"
              }
            >
              <i
                className={
                  isErr
                    ? "fas fa-circle-exclamation mt-0.5 shrink-0 text-red-400"
                    : isWarn
                      ? "fas fa-triangle-exclamation mt-0.5 shrink-0 text-amber-300"
                      : "fas fa-circle-check mt-0.5 shrink-0 text-emerald-400"
                }
                aria-hidden
              />
              <span className="min-w-0 break-words">{t.text}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
