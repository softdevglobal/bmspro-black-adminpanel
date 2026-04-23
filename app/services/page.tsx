"use client";
import React, { useEffect, useState, useRef } from "react";
import Sidebar from "@/components/Sidebar";
import { useRouter } from "next/navigation";
import { auth, db } from "@/lib/firebase";
import { onAuthStateChanged } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { getStorage, ref as storageRef, uploadBytes, getDownloadURL } from "firebase/storage";
import { subscribeBranchesForOwner } from "@/lib/branches";
import { subscribeSalonStaffForOwner } from "@/lib/salonStaff";
import {
  createServiceForOwner,
  deleteService as deleteServiceDoc,
  subscribeServicesForOwner,
  updateService,
  normalizeChecklist,
  normalizeAreaOrder,
  normalizeVehicleTypePricing,
  minPricingFromVehicleTypePricing,
  DEFAULT_AREA_ORDER,
  CHECKLIST_SECTIONS,
  CHECKLIST_SECTION_LABELS,
  VEHICLE_TYPES,
  VEHICLE_TYPE_LABELS,
  VEHICLE_TYPE_ICONS,
  isChecklistSection,
  groupChecklistItemsWithGlobalNumbers,
  type ChecklistItem,
  type ChecklistSection,
  type VehicleType,
  type VehicleTypePricingMap,
} from "@/lib/services";
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
import { subscribeDefaultServices } from "@/lib/defaultServices";
import { getErrorMessage } from "@/lib/errorMessage";

type ToastVariant = "success" | "error" | "warning";
import { nativeSelectInsetChevronClass } from "@/lib/nativeSelectChevron";

type Service = {
  id: string;
  name: string;
  description?: string;
  price: number;
  duration: number;
  icon?: string;
  imageUrl?: string;
  reviews?: number;
  staffIds: string[];
  branches: string[];
  checklist?: ChecklistItem[];
  /** Owner-defined area group order. Normalised on read (always 4 sections). */
  areaOrder: ChecklistSection[];
  sourceTemplateId?: string;
  /** Vehicle types this service is offered for. Empty = legacy flat pricing. */
  vehicleTypes: VehicleType[];
  /** Per-vehicle-type price + duration overrides. Empty when `vehicleTypes` is empty. */
  vehicleTypePricing: VehicleTypePricingMap;
};

type DefaultTemplate = {
  id: string;
  name: string;
  checklist: ChecklistItem[];
  areaOrder: ChecklistSection[];
};

/** dnd-kit id prefix used on the area chips so drag-end can tell chips apart from task rows. */
const CHIP_ID_PREFIX = "area-chip:";
const chipId = (s: ChecklistSection) => `${CHIP_ID_PREFIX}${s}` as const;
const sectionFromChipId = (id: string): ChecklistSection | null => {
  if (!id.startsWith(CHIP_ID_PREFIX)) return null;
  const raw = id.slice(CHIP_ID_PREFIX.length);
  return isChecklistSection(raw) ? raw : null;
};

type Staff = { id: string; name: string; role: string; branch: string; status: "Active" | "Suspended"; avatar: string };
type Branch = { id: string; name: string };

type ChecklistRow = ChecklistItem & { rowId: string };

function newChecklistRowId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

function rowsFromChecklist(items: ChecklistItem[]): ChecklistRow[] {
  return items.map((c) => ({ ...c, rowId: newChecklistRowId() }));
}

function checklistPayloadFromRows(rows: ChecklistRow[]): ChecklistItem[] {
  return rows
    .map(({ rowId: _rowId, ...item }) => item)
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

/** Small pastel palette for the draggable chips. Active ring matches the area accent. */
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

/** dnd-kit id prefix for row drag items so we can tell them apart from chip ids. */
const ROW_ID_PREFIX = "row:";
const rowDndId = (rowId: string) => `${ROW_ID_PREFIX}${rowId}`;
const rowIdFromDndId = (id: string): string | null =>
  id.startsWith(ROW_ID_PREFIX) ? id.slice(ROW_ID_PREFIX.length) : null;

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
    id: rowDndId(row.rowId),
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
      className={`bg-white rounded-xl border overflow-hidden group ${
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
          className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-red-50 text-red-400 opacity-0 transition-all hover:bg-red-100 hover:text-red-600 group-hover:opacity-100"
          aria-label="Remove task"
        >
          <i className="fas fa-trash-can text-[9px]" />
        </button>
      </div>
    </div>
  );
}

export default function ServicesPage() {
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [ownerUid, setOwnerUid] = useState<string | null>(null);

  const [services, setServices] = useState<Service[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [defaultTemplates, setDefaultTemplates] = useState<DefaultTemplate[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("");

  // modal/form
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editingServiceId, setEditingServiceId] = useState<string | null>(null);
  const [previewService, setPreviewService] = useState<Service | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Service | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [selectedStaff, setSelectedStaff] = useState<Record<string, boolean>>({});
  const [selectedBranches, setSelectedBranches] = useState<Record<string, boolean>>({});
  // Vehicle-type pricing form state. `vehicleTypeEnabled[vt] === true` means
  // the owner has ticked that type; `vehicleTypePricingForm[vt]` holds the
  // raw string input (kept as string so we don't flicker while typing "12.").
  const [vehicleTypeEnabled, setVehicleTypeEnabled] = useState<
    Record<VehicleType, boolean>
  >({
    small_car: false,
    sedan_wagon: false,
    suv: false,
    ute_van_4wd: false,
    performance_large: false,
  });
  const [vehicleTypePricingForm, setVehicleTypePricingForm] = useState<
    Record<VehicleType, { price: string; duration: string }>
  >({
    small_car: { price: "", duration: "" },
    sedan_wagon: { price: "", duration: "" },
    suv: { price: "", duration: "" },
    ute_van_4wd: { price: "", duration: "" },
    performance_large: { price: "", duration: "" },
  });
  const anyVehicleTypeEnabled = VEHICLE_TYPES.some(
    (vt) => vehicleTypeEnabled[vt],
  );
  const [checklistRows, setChecklistRows] = useState<ChecklistRow[]>([]);
  const [newChecklistItem, setNewChecklistItem] = useState("");
  const [newChecklistDesc, setNewChecklistDesc] = useState("");
  const [newChecklistSection, setNewChecklistSection] = useState<ChecklistSection | "">("");
  const [areaOrder, setAreaOrder] = useState<ChecklistSection[]>(DEFAULT_AREA_ORDER);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const draggingRow = !!activeDragId && activeDragId.startsWith(ROW_ID_PREFIX);
  const [showFormPreview, setShowFormPreview] = useState(false);

  /** Live counts per area for the chips badge. */
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

  const checklistSensors = useSensors(
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

    // Reordering area chips
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

    // Dragging a task row
    const activeRowId = rowIdFromDndId(activeId);
    if (!activeRowId) return;

    // Row dropped onto a chip → reassign that row's area
    if (overChipSection) {
      setChecklistRows((rows) =>
        rows.map((r) => (r.rowId === activeRowId ? { ...r, section: overChipSection } : r))
      );
      return;
    }

    // Row reorder within the list
    const overRowId = rowIdFromDndId(overId);
    if (!overRowId || activeRowId === overRowId) return;
    setChecklistRows((items) => {
      const oldIndex = items.findIndex((r) => r.rowId === activeRowId);
      const newIndex = items.findIndex((r) => r.rowId === overRowId);
      if (oldIndex < 0 || newIndex < 0) return items;
      return arrayMove(items, oldIndex, newIndex);
    });
  };
  const fileInputRef = useRef<HTMLInputElement>(null);

  // guard
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        router.replace("/login");
        return;
      }
      try {
        const token = await user.getIdToken();
        if (typeof window !== "undefined") localStorage.setItem("idToken", token);
      } catch {
        router.replace("/login");
        return;
      }
      try {
        const snap = await getDoc(doc(db, "users", user.uid));
        const role = (snap.data()?.role || "").toString();
        if (role === "branch_admin") {
          router.replace("/branches");
          return;
        }
        if (role !== "workshop_owner") {
          router.replace("/dashboard");
          return;
        }
        setOwnerUid(user.uid);
      } catch {
        router.replace("/login");
      }
    });
    return () => unsub();
  }, [router]);

  // live Firestore data for this owner
  useEffect(() => {
    if (!ownerUid) return;
    const unsubBranches = subscribeBranchesForOwner(ownerUid, (rows) => {
      setBranches(rows.map((r) => ({ id: String(r.id), name: String(r.name || "") })));
    });
    const unsubStaff = subscribeSalonStaffForOwner(ownerUid, (rows) => {
      setStaff(
        rows.map((r) => ({
          id: String(r.id),
          name: String(r.name || ""),
          role: String(r.role || ""),
          branch: String(r.branchName || ""),
          status: (r.status as any) === "Suspended" ? "Suspended" : "Active",
          avatar: String(r.avatar || r.name || ""),
        }))
      );
    });
    const unsubServices = subscribeServicesForOwner(ownerUid, (rows) => {
      setServices(
        rows.map((r) => {
          const vt = normalizeVehicleTypePricing((r as any).vehicleTypePricing);
          // Derive headline price/duration. Workshop-owner services no
          // longer persist the flat `price`/`duration` fields — we compute
          // the "starting from" number from the cheapest tier in
          // `vehicleTypePricing`. Super-admin default_services clones and
          // un-migrated docs still have flat fields, so we fall back to
          // them when the map is empty.
          const min = minPricingFromVehicleTypePricing(vt.vehicleTypePricing);
          return {
            id: String(r.id),
            name: String(r.name || ""),
            description: r.description ? String(r.description) : undefined,
            price: min ? min.price : Number(r.price || 0),
            duration: min ? min.duration : Number(r.duration || 0),
            icon: String(r.icon || ""),
            imageUrl: String((r as any).imageUrl || ""),
            reviews: Number(r.reviews || 0),
            branches: (Array.isArray(r.branches) ? r.branches : []).map(String),
            staffIds: (Array.isArray(r.staffIds) ? r.staffIds : []).map(String),
            checklist: normalizeChecklist((r as any).checklist),
            areaOrder: normalizeAreaOrder((r as any).areaOrder),
            sourceTemplateId: r.sourceTemplateId ? String(r.sourceTemplateId) : undefined,
            vehicleTypes: vt.vehicleTypes,
            vehicleTypePricing: vt.vehicleTypePricing,
          };
        })
      );
    });
    const unsubDefaults = subscribeDefaultServices((rows) => {
      setDefaultTemplates(
        rows.map((r) => ({
          id: String(r.id),
          name: String(r.name || ""),
          checklist: normalizeChecklist(r.checklist as any[]),
          areaOrder: normalizeAreaOrder((r as any).areaOrder),
        }))
      );
    });
    return () => {
      unsubBranches();
      unsubStaff();
      unsubServices();
      unsubDefaults();
    };
  }, [ownerUid]);

  // Toasts must sit above modal overlays (z-50 + backdrop-blur) or they look blurred.
  const [toasts, setToasts] = useState<
    Array<{ id: string; text: string; variant: ToastVariant }>
  >([]);
  const showToast = (text: string, variant: ToastVariant = "success") => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
    setToasts((t) => [...t, { id, text, variant }]);
    const duration = variant === "error" ? 6500 : variant === "warning" ? 4500 : 3200;
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), duration);
  };

  const openModal = () => {
    setEditingServiceId(null);
    setSelectedTemplateId("");
    setName("");
    setDescription("");
    setImageUrl("");
    setImageFile(null);
    setImagePreview(null);
    setChecklistRows([]);
    setNewChecklistItem("");
    setNewChecklistDesc("");
    setNewChecklistSection("");
    setAreaOrder(DEFAULT_AREA_ORDER);
    const staffMap: Record<string, boolean> = {};
    const branchMap: Record<string, boolean> = {};
    staff.forEach((s) => (staffMap[s.id] = false));
    branches.forEach((b) => (branchMap[b.id] = false));
    setSelectedStaff(staffMap);
    setSelectedBranches(branchMap);
    setVehicleTypeEnabled({
      small_car: false,
      sedan_wagon: false,
      suv: false,
      ute_van_4wd: false,
      performance_large: false,
    });
    setVehicleTypePricingForm({
      small_car: { price: "", duration: "" },
      sedan_wagon: { price: "", duration: "" },
      suv: { price: "", duration: "" },
      ute_van_4wd: { price: "", duration: "" },
      performance_large: { price: "", duration: "" },
    });
    setIsModalOpen(true);
  };
  const closeModal = () => {
    setIsModalOpen(false);
    setImageFile(null);
    setImagePreview(null);
  };

  const handleTemplateSelect = (templateId: string) => {
    setSelectedTemplateId(templateId);
    if (!templateId) {
      setName("");
      setChecklistRows([]);
      return;
    }
    const tpl = defaultTemplates.find((t) => t.id === templateId);
    if (tpl) {
      setName(tpl.name);
      setChecklistRows(rowsFromChecklist(tpl.checklist));
      setAreaOrder(tpl.areaOrder);
    }
  };

  const openEdit = (svc: Service) => {
    setEditingServiceId(svc.id);
    setName(svc.name);
    setDescription(svc.description || "");
    setImageUrl(svc.imageUrl || "");
    setImagePreview(svc.imageUrl || null);
    setImageFile(null);
    setChecklistRows(rowsFromChecklist(svc.checklist || []));
    setNewChecklistItem("");
    setNewChecklistDesc("");
    setNewChecklistSection("");
    setAreaOrder(normalizeAreaOrder(svc.areaOrder));
    const staffMap: Record<string, boolean> = {};
    const branchMap: Record<string, boolean> = {};
    staff.forEach((s) => (staffMap[s.id] = svc.staffIds?.includes(s.id) || false));
    branches.forEach((b) => (branchMap[b.id] = svc.branches?.includes(b.id) || false));
    setSelectedStaff(staffMap);
    setSelectedBranches(branchMap);
    // Hydrate vehicle-type form from the stored pricing map, then fill the
    // rest of the types with blank rows so every tick-box is addressable.
    const enabled: Record<VehicleType, boolean> = {
      small_car: false,
      sedan_wagon: false,
      suv: false,
      ute_van_4wd: false,
      performance_large: false,
    };
    const form: Record<VehicleType, { price: string; duration: string }> = {
      small_car: { price: "", duration: "" },
      sedan_wagon: { price: "", duration: "" },
      suv: { price: "", duration: "" },
      ute_van_4wd: { price: "", duration: "" },
      performance_large: { price: "", duration: "" },
    };
    for (const vt of VEHICLE_TYPES) {
      const entry = svc.vehicleTypePricing?.[vt];
      if (entry) {
        enabled[vt] = true;
        form[vt] = {
          price: String(entry.price ?? ""),
          duration: String(entry.duration ?? ""),
        };
      }
    }
    setVehicleTypeEnabled(enabled);
    setVehicleTypePricingForm(form);
    setIsModalOpen(true);
  };

  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      // Validate file type
      if (!file.type.startsWith('image/')) {
        showToast("Please select an image file", "warning");
        return;
      }
      // Validate file size (max 5MB)
      if (file.size > 5 * 1024 * 1024) {
        showToast("Image size should be less than 5MB", "warning");
        return;
      }
      setImageFile(file);
      // Create preview
      const reader = new FileReader();
      reader.onloadend = () => {
        setImagePreview(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  const uploadImage = async (): Promise<string | null> => {
    if (!imageFile || !ownerUid) return null;
    
    setUploading(true);
    try {
      const storage = getStorage();
      const timestamp = Date.now();
      const fileName = `services/${ownerUid}/${timestamp}_${imageFile.name}`;
      const imageRef = storageRef(storage, fileName);
      
      await uploadBytes(imageRef, imageFile);
      const downloadURL = await getDownloadURL(imageRef);
      
      return downloadURL;
    } catch (error) {
      console.error('Error uploading image:', error);
      showToast("Failed to upload image", "error");
      return null;
    } finally {
      setUploading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!name.trim()) return;
    const qualifiedStaff = Object.keys(selectedStaff).filter((id) => selectedStaff[id]);
    const selectedBrs = Object.keys(selectedBranches).filter((id) => selectedBranches[id]);
    if (!ownerUid) return;
    
    // Validate that at least one branch is selected
    if (selectedBrs.length === 0) {
      showToast("Please select at least one branch for this service", "error");
      return;
    }

    const checklistPayload = checklistPayloadFromRows(checklistRows);
    if (
      checklistPayload.some(
        (item) => item.name.trim() !== "" && !isChecklistSection(item.section)
      )
    ) {
      showToast("Please select a vehicle area for every task.", "error");
      return;
    }

    // Validate vehicle-type pricing rows. Pricing is now the ONLY way to
    // price a service, so at least one type must be ticked and every ticked
    // row must have both a non-negative price and a positive duration.
    const selectedVehicleTypes: VehicleType[] = VEHICLE_TYPES.filter(
      (vt) => vehicleTypeEnabled[vt],
    );
    if (selectedVehicleTypes.length === 0) {
      showToast(
        "Select at least one vehicle type and set its price & duration.",
        "error",
      );
      return;
    }
    const vehicleTypePricingOut: VehicleTypePricingMap = {};
    for (const vt of selectedVehicleTypes) {
      const row = vehicleTypePricingForm[vt];
      const priceNum = Number(row.price);
      const durationNum = Number(row.duration);
      if (
        row.price.trim() === "" ||
        !Number.isFinite(priceNum) ||
        priceNum < 0
      ) {
        showToast(
          `Enter a valid price for ${VEHICLE_TYPE_LABELS[vt]}.`,
          "error",
        );
        return;
      }
      if (
        row.duration.trim() === "" ||
        !Number.isFinite(durationNum) ||
        durationNum <= 0
      ) {
        showToast(
          `Enter a valid duration for ${VEHICLE_TYPE_LABELS[vt]}.`,
          "error",
        );
        return;
      }
      vehicleTypePricingOut[vt] = {
        price: priceNum,
        duration: Math.round(durationNum),
      };
    }

    setSaving(true);
    try {
      // Upload image if a new file is selected
      let finalImageUrl = imageUrl;
      if (imageFile) {
        const uploadedUrl = await uploadImage();
        if (uploadedUrl) {
          finalImageUrl = uploadedUrl;
        } else {
          showToast("Failed to upload image", "error");
          setSaving(false);
          return;
        }
      }

      // NOTE: we intentionally don't send `price`/`duration`. Pricing lives
      // entirely in `vehicleTypePricing`; `updateService` will also scrub
      // any stale flat fields off the existing doc.
      if (editingServiceId) {
        await updateService(editingServiceId, {
          name: name.trim(),
          description: description.trim(),
          imageUrl: finalImageUrl || "",
          staffIds: qualifiedStaff,
          branches: selectedBrs,
          checklist: checklistPayload,
          areaOrder,
          vehicleTypes: selectedVehicleTypes,
          vehicleTypePricing: vehicleTypePricingOut,
        });
      } else {
        await createServiceForOwner(ownerUid, {
          name: name.trim(),
          description: description.trim(),
          imageUrl: finalImageUrl || "",
          reviews: 0,
          staffIds: qualifiedStaff,
          branches: selectedBrs,
          checklist: checklistPayload,
          areaOrder,
          vehicleTypes: selectedVehicleTypes,
          vehicleTypePricing: vehicleTypePricingOut,
        });
      }
      setIsModalOpen(false);
      setEditingServiceId(null);
      setImageFile(null);
      setImagePreview(null);
      showToast(editingServiceId ? "Service updated." : "Service added to catalog!");
    } catch (error) {
      console.error("Error saving service:", error);
      const base = editingServiceId
        ? "Failed to update service"
        : "Failed to add service";
      const detail = getErrorMessage(error, "");
      showToast(
        detail ? `${base}. ${detail}` : base,
        "error",
      );
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteClick = (service: Service) => {
    setDeleteTarget(service);
  };

  const confirmDeleteService = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteServiceDoc(deleteTarget.id);
      showToast("Service removed.");
      setDeleteTarget(null);
    } catch (err) {
      showToast(
        `Failed to remove service. ${getErrorMessage(err, "Please try again.")}`,
        "error",
      );
    } finally {
      setDeleting(false);
    }
  };

  const totalBranches = branches.length;

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
                      <i className="fas fa-tags text-amber-400" />
                    </div>
                    <h1 className="text-2xl font-bold">Services</h1>
                  </div>
                  <p className="text-sm text-neutral-400 mt-2">Manage your workshop service catalog</p>
                </div>
              </div>
            </div>
          </div>

          <div className="max-w-7xl mx-auto">
            {/* Section header */}
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-8">
              <div>
                <h2 className="text-2xl font-bold text-neutral-800">Services</h2>
                <p className="text-sm text-neutral-400 mt-1">{services.length} service{services.length !== 1 ? "s" : ""} available</p>
              </div>
              <button
                onClick={openModal}
                className="w-full sm:w-auto px-5 py-2.5 bg-neutral-900 text-white rounded-xl text-sm hover:bg-neutral-800 font-semibold shadow-lg shadow-neutral-900/10 transition-all hover:shadow-xl active:scale-[0.97] flex items-center justify-center gap-2"
              >
                <i className="fa-solid fa-plus text-amber-400" />
                Add New Service
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
              {services.map((s) => {
                const staffCount = s.staffIds?.length || 0;
                const branchCount = s.branches?.length || 0;
                const branchLabel = branchCount === totalBranches ? "All Branches" : `${branchCount} Branch${branchCount !== 1 ? "es" : ""}`;
                return (
                  <div key={s.id} className="group relative">
                    {/* Card */}
                    <div className="relative bg-neutral-900 rounded-2xl overflow-hidden transition-all duration-500 hover:shadow-2xl hover:shadow-amber-500/[0.08] hover:-translate-y-1">
                      {/* ─── Top: Image with overlay ─── */}
                      <div className="relative h-56 overflow-hidden">
                        {s.imageUrl ? (
                          <img 
                            src={s.imageUrl} 
                            alt={s.name}
                            className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-700 ease-out"
                          />
                        ) : (
                          <div className="w-full h-full bg-gradient-to-br from-neutral-800 via-neutral-900 to-neutral-800 relative">
                            <div className="absolute inset-0 opacity-[0.06]" style={{ backgroundImage: `repeating-linear-gradient(45deg, transparent, transparent 10px, rgba(255,255,255,0.03) 10px, rgba(255,255,255,0.03) 20px)` }} />
                            <div className="absolute inset-0 flex items-center justify-center">
                              <div className="w-20 h-20 rounded-2xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center group-hover:rotate-12 transition-transform duration-500">
                                <i className="fas fa-wrench text-3xl text-amber-500/40" />
                              </div>
                            </div>
                          </div>
                        )}
                        
                        {/* Gradient overlays */}
                        <div className="absolute inset-0 bg-gradient-to-t from-neutral-900 via-neutral-900/40 to-transparent" />
                        <div className="absolute inset-0 bg-gradient-to-r from-neutral-900/30 to-transparent" />
                        
                        {/* Amber accent line */}
                        <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-amber-500 via-amber-400 to-orange-500 opacity-80 group-hover:opacity-100 transition-opacity" />

                        {/* Action buttons - floating top right */}
                        <div className="absolute top-4 right-4 flex items-center gap-1.5 opacity-0 group-hover:opacity-100 -translate-y-2 group-hover:translate-y-0 transition-all duration-300 z-20">
                          <button 
                            onClick={() => setPreviewService(s)} 
                            className="w-8 h-8 rounded-lg flex items-center justify-center bg-white/20 backdrop-blur-md text-white hover:bg-white/30 transition-all border border-white/10"
                            title="View Details"
                          >
                            <i className="fas fa-eye text-xs" />
                          </button>
                          <button 
                            onClick={() => openEdit(s)} 
                            className="w-8 h-8 rounded-lg flex items-center justify-center bg-white/20 backdrop-blur-md text-white hover:bg-blue-500/80 transition-all border border-white/10"
                            title="Edit Service"
                          >
                            <i className="fas fa-pen text-xs" />
                          </button>
                          <button 
                            onClick={() => handleDeleteClick(s)} 
                            className="w-8 h-8 rounded-lg flex items-center justify-center bg-white/20 backdrop-blur-md text-white hover:bg-rose-500/80 transition-all border border-white/10"
                            title="Delete Service"
                          >
                            <i className="fas fa-trash text-xs" />
                          </button>
                        </div>

                        {/* Service name overlay on image */}
                        <div className="absolute bottom-0 left-0 right-0 p-5 z-10">
                          <h3 className="font-black text-xl text-white line-clamp-2 tracking-tight leading-tight drop-shadow-lg">{s.name}</h3>
                          {s.description && (
                            <p className="text-xs text-white/70 mt-1 line-clamp-1 drop-shadow">{s.description}</p>
                          )}
                        </div>
                      </div>

                      {/* ─── Bottom: Dark info section ─── */}
                      <div className="p-5 relative">
                        {/* Diagonal hazard stripe accent */}
                        <div className="absolute top-0 left-0 right-0 h-[3px] bg-gradient-to-r from-amber-500/0 via-amber-500/30 to-amber-500/0" />

                        {/* Price + Duration row.
                            When the service has vehicle-type pricing, we
                            stamp a clear "STARTING FROM" label above the
                            price so the card number matches what the owner
                            sees in the Pricing by Vehicle Type matrix (the
                            lowest-priced type). Duration follows the same
                            "from" treatment for consistency. */}
                        <div className="flex items-end justify-between mb-4 gap-3">
                          <div className="flex flex-col min-w-0">
                            {s.vehicleTypes.length > 0 && (
                              <span
                                className="inline-flex items-center gap-1 self-start mb-1.5 px-2 py-0.5 rounded-md bg-amber-400/10 border border-amber-400/25 text-amber-300 text-[10px] font-bold uppercase tracking-[0.14em] leading-none"
                                title={`Lowest price across ${s.vehicleTypes.length} vehicle type${s.vehicleTypes.length !== 1 ? "s" : ""}`}
                              >
                                <i className="fas fa-tag text-[8px]" />
                                Starting from
                              </span>
                            )}
                            <div className="flex items-baseline gap-1">
                              <span className="text-amber-400 text-base font-semibold">$</span>
                              <span className="text-3xl font-black text-white tracking-tighter leading-none tabular-nums">
                                {s.price.toLocaleString()}
                              </span>
                            </div>
                          </div>
                          <div className="flex flex-col items-end">
                            {s.vehicleTypes.length > 0 && (
                              <span className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-neutral-500 leading-none">
                                From
                              </span>
                            )}
                            <div className="flex items-center gap-1.5 bg-white/[0.06] border border-white/[0.08] rounded-lg px-3 py-1.5">
                              <i className="far fa-clock text-amber-400 text-[10px]" />
                              <span className="text-sm font-bold text-white tabular-nums">{s.duration}</span>
                              <span className="text-xs text-neutral-500 font-medium">min</span>
                            </div>
                          </div>
                        </div>

                        {/* Info badges */}
                        <div className="flex flex-wrap gap-2 mb-4">
                          <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold bg-white/[0.06] text-neutral-300 px-2.5 py-1.5 rounded-lg border border-white/[0.06]">
                            <i className="fas fa-building text-[9px] text-amber-500/70" />
                            {branchLabel}
                          </span>
                          <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold bg-emerald-500/10 text-emerald-400 px-2.5 py-1.5 rounded-lg border border-emerald-500/10">
                            <i className="fas fa-users text-[9px]" />
                            {staffCount} Staff
                          </span>
                          {s.checklist && s.checklist.length > 0 && (
                            <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold bg-amber-500/10 text-amber-400 px-2.5 py-1.5 rounded-lg border border-amber-500/10">
                              <i className="fas fa-clipboard-check text-[9px]" />
                              {s.checklist.length} Tasks
                            </span>
                          )}
                          {s.vehicleTypes.length > 0 && (
                            <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold bg-indigo-500/10 text-indigo-300 px-2.5 py-1.5 rounded-lg border border-indigo-500/10">
                              <i className="fas fa-car text-[9px]" />
                              {s.vehicleTypes.length} Vehicle{s.vehicleTypes.length !== 1 ? "s" : ""}
                            </span>
                          )}
                          {s.sourceTemplateId && (
                            <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold bg-violet-500/10 text-violet-400 px-2.5 py-1.5 rounded-lg border border-violet-500/10">
                              <i className="fas fa-layer-group text-[9px]" />
                              From Template
                            </span>
                          )}
                        </div>

                        {/* Todo list preview */}
                        {s.checklist && s.checklist.length > 0 && (
                          <div className="bg-white/[0.04] rounded-xl border border-white/[0.06] p-3.5 mb-4">
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
                                  +{s.checklist.length - 3} more tasks →
                                </button>
                              )}
                            </div>
                          </div>
                        )}

                        {/* Footer */}
                        <div className="flex items-center justify-between pt-3 border-t border-white/[0.06]">
                          <div className="flex items-center gap-1.5">
                            <i className="fas fa-star text-amber-400 text-xs" />
                            <span className="text-xs text-neutral-500 font-medium">{s.reviews || 0} reviews</span>
                          </div>
                          <button 
                            onClick={() => setPreviewService(s)}
                            className="group/btn text-xs font-semibold text-amber-500 hover:text-amber-400 flex items-center gap-1.5 transition-colors"
                          >
                            View details 
                            <i className="fas fa-arrow-right text-[9px] group-hover/btn:translate-x-0.5 transition-transform" />
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </main>
      </div>

      {/* Add Service Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 bg-neutral-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-2 sm:p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[85vh] sm:max-h-[90vh] flex flex-col">
            <div className="relative bg-neutral-900 p-3 sm:p-5 border-b border-neutral-700 flex justify-between items-center rounded-t-xl shrink-0 overflow-hidden">
              <div className="absolute top-0 right-0 w-24 h-24 bg-white/5 rounded-full -translate-y-1/2 translate-x-1/2" />
              <div className="absolute top-2 right-20 text-white/10 text-xl"><i className="fas fa-gear" /></div>
              <div className="relative flex items-center gap-2 sm:gap-3">
                <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-lg bg-amber-500/20 flex items-center justify-center border border-amber-500/30">
                  <i className="fa-solid fa-tags text-amber-400 text-sm sm:text-base" />
                </div>
                <h3 className="font-bold text-white text-sm sm:text-lg">{editingServiceId ? "Edit Service" : "Add New Service"}</h3>
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
                {/* Template Selector — only when creating new */}
                {!editingServiceId && defaultTemplates.length > 0 && (
                  <div className="bg-gradient-to-r from-amber-50 to-orange-50 rounded-lg sm:rounded-xl p-3 sm:p-4 border border-amber-200">
                    <h4 className="text-xs sm:text-sm font-bold text-neutral-700 mb-2 flex items-center gap-2">
                      <i className="fas fa-layer-group text-amber-500" />
                      Start from a Template
                    </h4>
                    <p className="text-[10px] text-amber-700 mb-2">
                      <i className="fas fa-info-circle mr-1" />
                      Select a template to pre-fill the name and todo list, or start from scratch.
                    </p>
                    <select
                      value={selectedTemplateId}
                      onChange={(e) => handleTemplateSelect(e.target.value)}
                      className="select-inset-chevron w-full border border-amber-300 rounded-lg p-2 sm:p-2.5 text-xs sm:text-sm focus:ring-2 focus:ring-amber-500 focus:outline-none bg-white font-medium"
                    >
                      <option value="">— Start from scratch —</option>
                      {defaultTemplates.map((tpl) => (
                        <option key={tpl.id} value={tpl.id}>
                          {tpl.name} {tpl.checklist.length > 0 ? `(${tpl.checklist.length} tasks)` : ""}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                {/* Basic Service Information */}
                <div className="bg-neutral-50 rounded-lg sm:rounded-xl p-3 sm:p-4 border border-neutral-200">
                  <h4 className="text-xs sm:text-sm font-bold text-neutral-700 mb-2 sm:mb-3 flex items-center gap-2">
                    <i className="fas fa-sparkles text-amber-500" />
                    Service Details
                  </h4>
                  <div className="space-y-2.5 sm:space-y-3">
                    <div>
                      <label className="block text-xs font-bold text-neutral-600 mb-1">Service Name</label>
                      <input value={name} onChange={(e) => setName(e.target.value)} required className="w-full border border-neutral-300 rounded-lg p-2 sm:p-2.5 text-xs sm:text-sm focus:ring-2 focus:ring-neutral-900 focus:outline-none" placeholder="e.g. Full Vehicle Service" />
                    </div>
                    <div>
                      <label className="block text-xs font-bold text-neutral-600 mb-1">Description</label>
                      <textarea
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                        rows={3}
                        className="w-full border border-neutral-300 rounded-lg p-2 sm:p-2.5 text-xs sm:text-sm focus:ring-2 focus:ring-neutral-900 focus:outline-none resize-none"
                        placeholder="Describe what this service includes..."
                      />
                    </div>
                  </div>
                </div>

                {/* Vehicle Types & Pricing */}
                <div className="bg-indigo-50 rounded-lg sm:rounded-xl p-3 sm:p-4 border border-indigo-200">
                  <h4 className="text-xs sm:text-sm font-bold text-neutral-700 mb-2 sm:mb-3 flex items-center gap-2">
                    <i className="fas fa-car text-indigo-600" />
                    Vehicle Types & Pricing
                    <span className="text-[10px] font-semibold text-rose-600 ml-1">*</span>
                  </h4>
                  <p className="text-[10px] text-indigo-700 mb-3">
                    <i className="fas fa-info-circle mr-1" />
                    Tick at least one vehicle type this service applies to, and set the price and duration for each selected type.
                  </p>
                  <div className="space-y-2">
                    {VEHICLE_TYPES.map((vt) => {
                      const enabled = vehicleTypeEnabled[vt];
                      const row = vehicleTypePricingForm[vt];
                      return (
                        <div
                          key={vt}
                          className={`rounded-lg border-2 transition-all ${
                            enabled
                              ? "border-indigo-400 bg-white shadow-sm"
                              : "border-indigo-100 bg-white/60"
                          }`}
                        >
                          <label
                            className={`flex items-center gap-2 p-2.5 sm:p-3 cursor-pointer select-none ${
                              enabled ? "" : "hover:bg-indigo-50"
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={enabled}
                              onChange={(e) =>
                                setVehicleTypeEnabled((prev) => ({
                                  ...prev,
                                  [vt]: e.target.checked,
                                }))
                              }
                              className="rounded border-indigo-300 text-indigo-600 focus:ring-indigo-500 w-4 h-4"
                            />
                            <i
                              className={`${VEHICLE_TYPE_ICONS[vt]} text-indigo-500 text-sm w-5 text-center`}
                            />
                            <span className="text-xs sm:text-sm font-semibold text-neutral-800 flex-1">
                              {VEHICLE_TYPE_LABELS[vt]}
                            </span>
                            {enabled && row.price && row.duration && (
                              <span className="text-[10px] font-semibold text-indigo-600 bg-indigo-100 px-2 py-0.5 rounded-full">
                                ${Number(row.price).toLocaleString()} · {row.duration} min
                              </span>
                            )}
                          </label>
                          {enabled && (
                            <div className="border-t border-indigo-100 bg-indigo-50/40 p-2.5 sm:p-3">
                              <div className="grid grid-cols-2 gap-2.5 sm:gap-3">
                                <div>
                                  <label className="block text-[10px] font-bold text-neutral-600 mb-1">
                                    Price ($)
                                  </label>
                                  <input
                                    type="text"
                                    inputMode="decimal"
                                    autoComplete="off"
                                    value={row.price}
                                    onChange={(e) => {
                                      const v = e.target.value;
                                      if (v !== "" && !/^\d*\.?\d*$/.test(v)) return;
                                      setVehicleTypePricingForm((prev) => ({
                                        ...prev,
                                        [vt]: { ...prev[vt], price: v },
                                      }));
                                    }}
                                    className="w-full border border-indigo-200 rounded-lg p-2 text-xs sm:text-sm focus:ring-2 focus:ring-indigo-500 focus:outline-none bg-white"
                                    placeholder="e.g. 180"
                                  />
                                </div>
                                <div>
                                  <label className="block text-[10px] font-bold text-neutral-600 mb-1">
                                    Duration (mins)
                                  </label>
                                  <select
                                    value={row.duration}
                                    onChange={(e) =>
                                      setVehicleTypePricingForm((prev) => ({
                                        ...prev,
                                        [vt]: { ...prev[vt], duration: e.target.value },
                                      }))
                                    }
                                    className="select-inset-chevron w-full border border-indigo-200 rounded-lg p-2 text-xs sm:text-sm focus:ring-2 focus:ring-indigo-500 focus:outline-none bg-white"
                                  >
                                    <option value="">Select Duration</option>
                                    <option value="15">15 mins</option>
                                    <option value="30">30 mins</option>
                                    <option value="45">45 mins</option>
                                    <option value="60">60 mins</option>
                                    <option value="75">75 mins</option>
                                    <option value="90">90 mins</option>
                                    <option value="105">105 mins</option>
                                    <option value="120">120 mins</option>
                                    <option value="135">135 mins</option>
                                    <option value="150">150 mins</option>
                                    <option value="165">165 mins</option>
                                    <option value="180">180 mins</option>
                                    <option value="195">195 mins</option>
                                    <option value="210">210 mins</option>
                                    <option value="225">225 mins</option>
                                    <option value="240">240 mins</option>
                                  </select>
                                </div>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  {!anyVehicleTypeEnabled && (
                    <p className="text-[10px] text-rose-600 mt-2 font-medium">
                      <i className="fas fa-triangle-exclamation mr-1" />
                      Select at least one vehicle type to save this service.
                    </p>
                  )}
                </div>

                {/* Service Image Upload */}
                <div className="bg-neutral-50 rounded-lg sm:rounded-xl p-3 sm:p-4 border border-neutral-200">
                  <h4 className="text-xs sm:text-sm font-bold text-neutral-700 mb-2 sm:mb-3 flex items-center gap-2">
                    <i className="fas fa-image text-neutral-600" />
                    Service Image
                  </h4>
                  <div className="space-y-3">
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*"
                      onChange={handleImageChange}
                      className="hidden"
                    />
                    
                    {/* Image Preview */}
                    <div className="flex flex-col sm:flex-row items-center gap-3">
                      <div className="w-32 h-32 sm:w-40 sm:h-40 rounded-xl bg-neutral-100 border-2 border-dashed border-neutral-300 flex items-center justify-center overflow-hidden shadow-inner">
                        {imagePreview ? (
                          <img 
                            src={imagePreview} 
                            alt="Service preview" 
                            className="w-full h-full object-cover"
                          />
                        ) : (
                          <div className="text-center text-neutral-400">
                            <i className="fas fa-image text-4xl mb-2 block" />
                            <p className="text-xs">No image selected</p>
                          </div>
                        )}
                      </div>
                      
                      <div className="flex-1 space-y-2 w-full">
                        <button
                          type="button"
                          onClick={() => fileInputRef.current?.click()}
                          className="w-full px-4 py-2.5 text-sm rounded-lg bg-neutral-900 text-white hover:bg-neutral-800 shadow-md transition-all font-medium flex items-center justify-center gap-2"
                        >
                          <i className="fas fa-upload" />
                          {imagePreview ? "Change Image" : "Upload Image"}
                        </button>
                        
                        {imagePreview && (
                          <button
                            type="button"
                            onClick={() => {
                              setImageFile(null);
                              setImagePreview(null);
                              setImageUrl("");
                              if (fileInputRef.current) fileInputRef.current.value = "";
                            }}
                            className="w-full px-4 py-2 text-xs rounded-lg bg-neutral-100 text-neutral-600 hover:bg-neutral-200 transition-all font-medium flex items-center justify-center gap-2"
                          >
                            <i className="fas fa-trash" />
                            Remove Image
                          </button>
                        )}
                        
                        <div className="text-[10px] text-neutral-500 space-y-1">
                          <p><i className="fas fa-info-circle mr-1" />Recommended: 500x500px or larger</p>
                          <p><i className="fas fa-info-circle mr-1" />Max size: 5MB</p>
                          <p><i className="fas fa-info-circle mr-1" />Formats: JPG, PNG, GIF, WebP</p>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
                {/* Service Todo List */}
                <div className="bg-amber-50 rounded-lg sm:rounded-xl p-3 sm:p-4 border border-amber-200">
                  <h4 className="text-xs sm:text-sm font-bold text-neutral-700 mb-2 sm:mb-3 flex items-center gap-2">
                    <i className="fas fa-clipboard-list text-amber-600" />
                    Service Todo List
                  </h4>
                  <p className="text-[10px] text-amber-700 mb-1.5">
                    <i className="fas fa-info-circle mr-1" />
                    Add tasks staff must complete. For each task, pick which part of the vehicle it belongs to: Interior, Engine Bay, Underbody, or Exterior.
                  </p>
                  <p className="text-[10px] text-neutral-500 mb-3">
                    <i className="fas fa-arrows-alt-v mr-1" />
                    Drag the grip handle to reorder tasks. Use the <strong>Area order</strong> panel below to reorder areas (drag chips) or reassign tasks (drop a task onto a chip).
                  </p>

                  <DndContext
                    sensors={checklistSensors}
                    collisionDetection={closestCenter}
                    onDragStart={(ev) => setActiveDragId(String(ev.active.id))}
                    onDragCancel={() => setActiveDragId(null)}
                    onDragEnd={onChecklistDragEnd}
                  >
                    {checklistRows.length > 0 && (
                      <SortableContext
                        items={checklistRows.map((r) => rowDndId(r.rowId))}
                        strategy={verticalListSortingStrategy}
                      >
                        <div className="space-y-2.5 mb-3">
                          {checklistRows.map((row, index) => (
                            <SortableChecklistRow
                              key={row.rowId}
                              row={row}
                              index={index}
                              onNameChange={(value) =>
                                setChecklistRows((prev) =>
                                  prev.map((r) =>
                                    r.rowId === row.rowId ? { ...r, name: value } : r
                                  )
                                )
                              }
                              onDescriptionChange={(value) =>
                                setChecklistRows((prev) =>
                                  prev.map((r) =>
                                    r.rowId === row.rowId ? { ...r, description: value } : r
                                  )
                                )
                              }
                              onSectionChange={(value) =>
                                setChecklistRows((prev) =>
                                  prev.map((r) =>
                                    r.rowId === row.rowId ? { ...r, section: value } : r
                                  )
                                )
                              }
                              onRemove={() =>
                                setChecklistRows((prev) =>
                                  prev.filter((r) => r.rowId !== row.rowId)
                                )
                              }
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
                              rowId: newChecklistRowId(),
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
                            rowId: newChecklistRowId(),
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

                    {/* Area order — stacked below the Add Task card. Drag chips
                        to reorder (this is the order customers see), drop a
                        task onto a chip to move it into that area, or click
                        a chip to quick-pick the area for the next new task. */}
                    <div className="mt-3 rounded-xl border border-amber-200 bg-white/70 p-2.5">
                      <div className="mb-2 flex items-center justify-between px-0.5">
                        <span className="text-[10px] font-bold uppercase tracking-wide text-amber-700">
                          <i className="fas fa-arrows-alt-v mr-1" />
                          Area order
                        </span>
                        <span className="text-[9px] text-neutral-500">Drag to reorder • Drop tasks here</span>
                      </div>
                      <SortableContext
                        items={areaOrder.map((s) => chipId(s))}
                        strategy={verticalListSortingStrategy}
                      >
                        <div className="flex flex-col gap-2">
                          {areaOrder.map((s) => (
                            <SortableAreaChip
                              key={s}
                              section={s}
                              count={areaCounts[s]}
                              active={newChecklistSection === s}
                              draggingRow={draggingRow}
                              onClick={() => setNewChecklistSection(s)}
                            />
                          ))}
                        </div>
                      </SortableContext>
                    </div>
                  </DndContext>

                  <button
                    type="button"
                    onClick={() => setShowFormPreview((v) => !v)}
                    disabled={checklistPayloadFromRows(checklistRows).length === 0}
                    aria-expanded={showFormPreview}
                    className={`mt-3 w-full flex items-center justify-center gap-2 rounded-lg border-2 border-amber-400 bg-white py-2 text-xs sm:text-sm font-semibold text-amber-700 transition-all ${
                      checklistPayloadFromRows(checklistRows).length === 0
                        ? "opacity-50 cursor-not-allowed"
                        : "hover:bg-amber-100 active:scale-[0.98]"
                    }`}
                  >
                    <i className={`fas ${showFormPreview ? "fa-chevron-up" : "fa-eye"} text-xs`} />
                    {showFormPreview ? "Hide preview" : "Preview customer view"}
                  </button>

                  {/* Inline preview — expands smoothly in place (no modal).
                      Mounts only when open so there's no reserved empty area
                      when collapsed; the fade+slide keyframe supplies the
                      opening animation (see globals.css .animate-previewExpand). */}
                  {showFormPreview && (() => {
                    const items = checklistPayloadFromRows(checklistRows);
                    if (items.length === 0) return null;
                    return (
                      <div className="animate-previewExpand mt-3 rounded-xl border-2 border-amber-200 bg-gradient-to-br from-amber-50 to-orange-50 p-3 sm:p-4">
                        <div className="mb-3 flex items-center gap-2">
                          <i className="fas fa-eye text-amber-600" />
                          <div className="flex min-w-0 flex-col">
                            <span className="text-[10px] font-semibold uppercase tracking-wide text-amber-700">
                              Customer preview
                            </span>
                            <span className="truncate text-xs font-bold text-neutral-800">
                              {name.trim() || "Unnamed service"}
                            </span>
                          </div>
                          <span className="ml-auto rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700">
                            {items.length} task{items.length !== 1 ? "s" : ""}
                          </span>
                        </div>
                        <div className="space-y-4">
                          {groupChecklistItemsWithGlobalNumbers(items, areaOrder).map((group) => (
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
                                  className="flex items-start gap-2.5 rounded-lg border border-amber-100 bg-white p-3"
                                >
                                  <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-amber-400 via-amber-500 to-orange-600 shadow-sm shadow-amber-500/40 tabular-nums">
                                    <span className="text-[10px] font-black leading-none text-white drop-shadow-[0_1px_1px_rgba(0,0,0,0.35)]">{num}</span>
                                  </div>
                                  <div className="min-w-0 flex-1">
                                    <p className="text-sm font-semibold text-neutral-800">{item.name}</p>
                                    {item.description && (
                                      <p className="mt-0.5 text-xs text-neutral-500">{item.description}</p>
                                    )}
                                  </div>
                                </div>
                              ))}
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })()}
                </div>

                {/* Available Branches */}
                <div className="bg-blue-50 rounded-lg sm:rounded-xl p-3 sm:p-4 border border-blue-200">
                  <h4 className="text-xs sm:text-sm font-bold text-neutral-700 mb-2 sm:mb-3 flex items-center gap-2">
                    <i className="fas fa-store text-blue-600" />
                    Available Branches
                  </h4>
                  <div className="grid grid-cols-1 gap-1.5 max-h-48 overflow-y-auto border-2 border-blue-200 rounded-lg p-2 sm:p-3 bg-white custom-scrollbar">
                    {branches.length > 0 ? (
                      branches.map((b) => (
                        <label key={b.id} className="flex items-center gap-2 p-2 hover:bg-blue-50 rounded-md cursor-pointer transition group">
                          <input
                            type="checkbox"
                            checked={!!selectedBranches[b.id]}
                            onChange={(e) => setSelectedBranches((m) => ({ ...m, [b.id]: e.target.checked }))}
                            className="rounded border-blue-300 text-blue-600 focus:ring-blue-500 w-4 h-4"
                          />
                          <span className="text-xs sm:text-sm text-neutral-700 font-medium group-hover:text-blue-700">
                            <i className="fas fa-building text-blue-400 mr-1.5" />
                            {b.name}
                          </span>
                        </label>
                      ))
                    ) : (
                      <div className="text-xs text-neutral-400 text-center py-3">
                        <i className="fas fa-store-slash mb-1 block text-neutral-300" />
                        No Branches Configured.
                      </div>
                    )}
                  </div>
                  <p className="text-[10px] text-blue-600 mt-1.5">
                    <i className="fas fa-info-circle mr-1" />
                    Select which locations offer this service
                  </p>
                </div>
                {/* Qualified Staff */}
                <div className="bg-emerald-50 rounded-lg sm:rounded-xl p-3 sm:p-4 border border-emerald-200">
                  <h4 className="text-xs sm:text-sm font-bold text-neutral-700 mb-2 sm:mb-3 flex items-center gap-2">
                    <i className="fas fa-user-check text-emerald-600" />
                    Qualified Staff
                  </h4>
                  <div className="grid grid-cols-1 gap-1.5 max-h-64 overflow-y-auto border-2 border-emerald-200 rounded-lg p-2 sm:p-3 bg-white custom-scrollbar">
                    {staff.filter((s) => s.status === "Active").length > 0 ? (
                      staff
                        .filter((s) => s.status === "Active")
                        .map((s) => (
                          <label key={s.id} className="flex items-center gap-2 p-2 hover:bg-emerald-50 rounded-md cursor-pointer transition group">
                            <input
                              type="checkbox"
                              checked={!!selectedStaff[s.id]}
                              onChange={(e) => setSelectedStaff((m) => ({ ...m, [s.id]: e.target.checked }))}
                              className="rounded border-emerald-300 text-emerald-600 focus:ring-emerald-500 w-4 h-4"
                            />
                            <img
                              src={`https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(s.avatar)}`}
                              alt={s.name}
                              className="w-6 h-6 rounded-full bg-neutral-100"
                            />
                            <div className="flex-1 min-w-0">
                              <span className="text-xs sm:text-sm text-neutral-700 font-medium group-hover:text-emerald-700 block truncate">{s.name}</span>
                              <span className="text-[10px] text-neutral-500">{s.role}</span>
                            </div>
                          </label>
                        ))
                    ) : (
                      <div className="text-xs text-neutral-400 text-center py-3">
                        <i className="fas fa-user-slash mb-1 block text-neutral-300" />
                        No Active Staff Found.
                      </div>
                    )}
                  </div>
                  <p className="text-[10px] text-emerald-600 mt-1.5">
                    <i className="fas fa-info-circle mr-1" />
                    Only selected staff can perform this service
                  </p>
                </div>
                </div>
                
                {/* Footer with Submit Button */}
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
                        {editingServiceId ? "Save Changes" : "Add Service"}
                      </span>
                    )}
                  </button>
                </div>
              </form>
            </div>
          </div>
      )}

      {/* Preview Service Sidebar */}
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
              {/* Fixed Header */}
              <div className="shrink-0 relative bg-neutral-900 p-5 overflow-hidden">
                <div className="absolute top-0 right-0 w-24 h-24 bg-white/5 rounded-full -translate-y-1/2 translate-x-1/2" />
                <div className="absolute top-2 right-16 text-white/10 text-xl"><i className="fas fa-gear" /></div>
                <div className="relative flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-amber-500/20 flex items-center justify-center border border-amber-500/30">
                      <i className="fas fa-eye text-amber-400"></i>
                    </div>
                    <div>
                      <h3 className="text-lg font-bold text-white">Service Details</h3>
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

              {/* Scrollable Content */}
              <div className="flex-1 overflow-y-auto">
                {/* Service Image */}
                <div className="relative w-full h-56 bg-neutral-100">
                  {previewService.imageUrl ? (
                    <img src={previewService.imageUrl} alt={previewService.name} className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <i className="fas fa-wrench text-6xl text-neutral-300/50" />
                    </div>
                  )}
                  <div className="absolute inset-0 bg-gradient-to-t from-black/30 via-transparent to-transparent" />
                </div>

                <div className="p-5 space-y-5">
                  {/* Description */}
                  {previewService.description && (
                    <div className="bg-neutral-50 rounded-xl p-4 border-2 border-neutral-200">
                      <h3 className="text-sm font-bold text-neutral-800 mb-2 flex items-center gap-2">
                        <i className="fas fa-align-left text-neutral-600" />
                        Description
                      </h3>
                      <p className="text-sm text-neutral-600 whitespace-pre-wrap">{previewService.description}</p>
                    </div>
                  )}

                  {/* Flat Price / Duration — only for legacy services that
                      predate vehicle-type pricing. New services always have
                      at least one vehicle-type entry and surface pricing
                      through the matrix below instead. */}
                  {previewService.vehicleTypes.length === 0 && (
                    <div className="grid grid-cols-2 gap-3">
                      <div className="bg-neutral-50 rounded-xl p-4 border-2 border-neutral-200">
                        <div className="flex items-center gap-2 mb-2">
                          <div className="w-8 h-8 rounded-lg bg-neutral-100 flex items-center justify-center">
                            <i className="fas fa-dollar-sign text-amber-500" />
                          </div>
                          <div className="text-xs text-neutral-600 font-semibold">Price</div>
                        </div>
                        <div className="text-3xl font-bold text-neutral-900">${previewService.price}</div>
                      </div>
                      <div className="bg-gradient-to-br from-blue-50 to-indigo-50 rounded-xl p-4 border-2 border-blue-200">
                        <div className="flex items-center gap-2 mb-2">
                          <div className="w-8 h-8 rounded-lg bg-blue-100 flex items-center justify-center">
                            <i className="fas fa-clock text-blue-600" />
                          </div>
                          <div className="text-xs text-neutral-600 font-semibold">Duration</div>
                        </div>
                        <div className="text-3xl font-bold text-blue-600">{previewService.duration}<span className="text-lg">min</span></div>
                      </div>
                    </div>
                  )}

                  {/* "Starting from" summary + Vehicle-type pricing matrix.
                      Mirrors the card: headline shows the cheapest tier and
                      shortest duration (both drawn straight from the stored
                      matrix so there's no drift), then the matrix breaks
                      the full price list down by vehicle type. The tier
                      matching the headline is tagged with a small "lowest"
                      chip so the owner can see what feeds the headline. */}
                  {previewService.vehicleTypes.length > 0 && (() => {
                    const entries = previewService.vehicleTypes
                      .map((vt) => ({
                        vt,
                        entry: previewService.vehicleTypePricing[vt],
                      }))
                      .filter((x) => !!x.entry) as {
                      vt: VehicleType;
                      entry: { price: number; duration: number };
                    }[];
                    if (entries.length === 0) return null;
                    const minPrice = Math.min(...entries.map((e) => e.entry.price));
                    const minDuration = Math.min(
                      ...entries.map((e) => e.entry.duration),
                    );
                    return (
                      <div className="space-y-3">
                        {/* Starting-from headline */}
                        <div className="bg-gradient-to-br from-amber-50 via-white to-indigo-50 rounded-xl p-4 border-2 border-amber-200">
                          <div className="flex items-center gap-2 mb-2">
                            <i className="fas fa-tag text-amber-600 text-xs" />
                            <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-amber-700">
                              Starting from
                            </span>
                          </div>
                          <div className="flex items-end justify-between gap-3 flex-wrap">
                            <div className="flex items-baseline gap-1">
                              <span className="text-2xl font-black text-neutral-400 leading-none">$</span>
                              <span className="text-4xl font-black text-neutral-900 tracking-tight leading-none tabular-nums">
                                {minPrice.toLocaleString()}
                              </span>
                            </div>
                            <div className="flex items-center gap-1.5 bg-blue-50 border border-blue-200 rounded-lg px-3 py-1.5">
                              <i className="far fa-clock text-blue-600 text-xs" />
                              <span className="text-[10px] font-semibold uppercase tracking-wider text-blue-700">From</span>
                              <span className="text-sm font-bold text-blue-900 tabular-nums">{minDuration}</span>
                              <span className="text-xs text-blue-600 font-medium">min</span>
                            </div>
                          </div>
                          <p className="text-[10px] text-neutral-500 mt-2">
                            Lowest price across {entries.length} configured vehicle
                            {entries.length !== 1 ? " types" : " type"}. Final price depends on the customer's vehicle.
                          </p>
                        </div>

                        {/* Per-vehicle matrix */}
                        <div className="bg-gradient-to-br from-indigo-50 to-violet-50 rounded-xl p-4 border-2 border-indigo-200">
                          <h3 className="text-sm font-bold text-neutral-800 mb-3 flex items-center gap-2">
                            <i className="fas fa-car text-indigo-600" />
                            Pricing by Vehicle Type
                            <span className="ml-auto text-[10px] bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded-full font-semibold">
                              {entries.length} type{entries.length !== 1 ? "s" : ""}
                            </span>
                          </h3>
                          <div className="space-y-2">
                            {entries.map(({ vt, entry }) => {
                              const isLowest = entry.price === minPrice;
                              return (
                                <div
                                  key={vt}
                                  className={`flex items-center gap-3 rounded-lg p-3 transition-all ${
                                    isLowest
                                      ? "bg-amber-50 border-2 border-amber-300 shadow-sm"
                                      : "bg-white border border-indigo-100"
                                  }`}
                                >
                                  <div
                                    className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${
                                      isLowest ? "bg-amber-100" : "bg-indigo-100"
                                    }`}
                                  >
                                    <i
                                      className={`${VEHICLE_TYPE_ICONS[vt]} ${
                                        isLowest ? "text-amber-700" : "text-indigo-600"
                                      }`}
                                    />
                                  </div>
                                  <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-1.5">
                                      <p className="text-sm font-semibold text-neutral-800 truncate">
                                        {VEHICLE_TYPE_LABELS[vt]}
                                      </p>
                                      {isLowest && (
                                        <span className="text-[9px] font-bold uppercase tracking-wider text-amber-700 bg-amber-200/70 rounded-full px-1.5 py-0.5 leading-none">
                                          Lowest
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                  <div className="flex items-center gap-2 shrink-0">
                                    <span className="text-sm font-bold text-neutral-900 tabular-nums">
                                      ${entry.price.toLocaleString()}
                                    </span>
                                    <span className="text-neutral-300">·</span>
                                    <span className="inline-flex items-center gap-1 text-xs font-semibold text-blue-700 bg-blue-50 border border-blue-100 rounded-full px-2 py-0.5 tabular-nums">
                                      <i className="far fa-clock text-[9px]" />
                                      {entry.duration}m
                                    </span>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      </div>
                    );
                  })()}

                  {/* Stats */}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="bg-white border-2 border-neutral-200 rounded-xl p-4">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-lg bg-amber-100 flex items-center justify-center">
                          <i className="fas fa-star text-amber-500 text-lg" />
                        </div>
                        <div>
                          <div className="text-xs text-neutral-500 font-medium">Rating</div>
                          <div className="text-lg font-bold text-neutral-900">{previewService.reviews || 0}</div>
                          <div className="text-xs text-neutral-400">reviews</div>
                        </div>
                      </div>
                    </div>
                    <div className="bg-white border-2 border-neutral-200 rounded-xl p-4">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-lg bg-emerald-100 flex items-center justify-center">
                          <i className="fas fa-users text-emerald-600 text-lg" />
                        </div>
                        <div>
                          <div className="text-xs text-neutral-500 font-medium">Staff</div>
                          <div className="text-lg font-bold text-neutral-900">{previewService.staffIds?.length || 0}</div>
                          <div className="text-xs text-neutral-400">qualified</div>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Qualified Staff Members */}
                  {previewService.staffIds && previewService.staffIds.length > 0 && (
                    <div className="bg-gradient-to-br from-emerald-50 to-teal-50 rounded-xl p-4 border-2 border-emerald-200">
                      <h3 className="text-sm font-bold text-neutral-800 mb-3 flex items-center gap-2">
                        <i className="fas fa-user-check text-emerald-600" />
                        Qualified Staff Members
                      </h3>
                      <div className="space-y-2">
                        {previewService.staffIds.map((staffId) => {
                          const staffMember = staff.find((s) => s.id === staffId);
                          if (!staffMember) return null;
                          return (
                            <div key={staffId} className="flex items-center gap-3 bg-white rounded-lg p-3 border border-emerald-100">
                              <div className="w-10 h-10 rounded-full overflow-hidden border-2 border-emerald-200 flex-shrink-0">
                                <img
                                  src={`https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(staffMember.avatar)}`}
                                  alt={staffMember.name}
                                  className="w-full h-full object-cover"
                                />
                              </div>
                              <div className="flex-1 min-w-0">
                                <p className="font-semibold text-neutral-800 text-sm truncate">{staffMember.name}</p>
                                <p className="text-xs text-neutral-500 truncate">{staffMember.role}</p>
                              </div>
                              <div className="flex-shrink-0">
                                <span className="text-xs bg-emerald-50 text-emerald-700 px-2 py-1 rounded-full font-medium">
                                  <i className="fas fa-store text-[10px] mr-1"></i>
                                  {staffMember.branch}
                                </span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Service Todo List */}
                  {previewService.checklist && previewService.checklist.length > 0 && (
                    <div className="bg-gradient-to-br from-amber-50 to-orange-50 rounded-xl p-4 border-2 border-amber-200">
                      <h3 className="text-sm font-bold text-neutral-800 mb-3 flex items-center gap-2">
                        <i className="fas fa-clipboard-list text-amber-600" />
                        Service Todo List
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
                  )}

                  {/* Available Branches */}
                  <div className="bg-neutral-50 rounded-xl p-4 border-2 border-neutral-200">
                    <h3 className="text-sm font-bold text-neutral-800 mb-3 flex items-center gap-2">
                      <i className="fas fa-map-marker-alt text-neutral-600" />
                      Available Locations
                    </h3>
                    <div className="flex flex-wrap gap-2">
                      {previewService.branches.length > 0 ? (
                        previewService.branches.map((bid) => {
                          const b = branches.find((x) => x.id === bid);
                          return (
                            <span key={bid} className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-white border border-neutral-300 text-neutral-700 text-sm font-medium shadow-sm">
                              <i className="fas fa-store text-xs" />
                              {b?.name || bid}
                            </span>
                          );
                        })
                      ) : (
                        <span className="text-sm text-neutral-500 italic">No branches assigned yet</span>
                      )}
                    </div>
                  </div>
                </div>
              </div>
              
              {/* Footer Actions */}
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
                    const serviceToEdit = previewService;
                    setPreviewService(null);
                    openEdit(serviceToEdit);
                  }}
                  className="flex-1 px-4 py-2.5 bg-neutral-900 text-white rounded-lg font-semibold hover:bg-neutral-800 shadow-lg hover:shadow-xl transition-all text-sm"
                >
                  <i className="fas fa-pen mr-2" />
                  Edit Service
                </button>
              </div>
            </div>
      )}
        </aside>
      </div>

      {/* Preview on the unsaved edit form */}
      {/* Delete Confirmation Modal */}
      {deleteTarget && (
        <div className="fixed inset-0 bg-neutral-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0" onClick={() => !deleting && setDeleteTarget(null)} />
          <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
            <div className="p-6 border-b border-neutral-100 flex items-center gap-3">
              <div className="w-12 h-12 rounded-full bg-rose-100 text-rose-600 flex items-center justify-center shrink-0">
                <i className="fa-solid fa-triangle-exclamation text-xl" />
              </div>
              <h3 className="font-semibold text-neutral-900 text-lg">Delete Service?</h3>
            </div>
            <div className="p-6 text-sm text-neutral-600">
              Are you sure you want to delete <span className="font-semibold text-neutral-800">"{deleteTarget.name}"</span>? This action cannot be undone.
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
                onClick={confirmDeleteService}
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
                    Delete Service
                  </span>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toasts: z-[200] so they render above modal backdrops (z-50 + blur) */}
      <div
        id="toast-container"
        className="fixed bottom-5 right-5 z-[200] flex max-w-[min(100vw-1.5rem,22rem)] flex-col gap-2 pointer-events-none"
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


