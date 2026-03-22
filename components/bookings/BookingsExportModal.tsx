"use client";

import React, { useState } from "react";
import { auth, db } from "@/lib/firebase";
import { collection, getDocs, query, where } from "firebase/firestore";
import { getDoc, doc } from "firebase/firestore";
import type { BookingStatus } from "@/lib/bookingTypes";
import { getStatusLabel, normalizeBookingStatus } from "@/lib/bookingTypes";

const REQUEST_STATUSES: BookingStatus[] = ["Pending", "AwaitingStaffApproval", "PartiallyApproved", "StaffRejected"];
const EXPORT_CATEGORIES: Array<{ id: string; label: string; statuses: BookingStatus[]; desc?: string; color: string }> = [
  { id: "requests", label: "Requests", statuses: REQUEST_STATUSES, desc: "Pending, Awaiting Staff, Partially Approved, Staff Rejected", color: "amber" },
  { id: "confirmed", label: "Confirmed", statuses: ["Confirmed" as BookingStatus], color: "emerald" },
  { id: "completed", label: "Completed", statuses: ["Completed" as BookingStatus], color: "indigo" },
  { id: "cancelled", label: "Cancelled", statuses: ["Canceled" as BookingStatus], color: "rose" },
];
import { toCsv, downloadFile } from "@/lib/csvUtils";

type ExportRow = {
  bookingCode: string;
  client: string;
  clientEmail: string;
  clientPhone: string;
  serviceName: string;
  staffName: string;
  branchName: string;
  date: string;
  time: string;
  duration: string;
  price: string;
  status: string;
  vehicleNumber: string;
  vehicleMake: string;
  vehicleModel: string;
};

export default function BookingsExportModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [selectedCategories, setSelectedCategories] = useState<Set<string>>(
    new Set(["requests", "confirmed", "completed", "cancelled"])
  );
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleCategory = (id: string) => {
    setSelectedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => setSelectedCategories(new Set(EXPORT_CATEGORIES.map((c) => c.id)));
  const selectNone = () => setSelectedCategories(new Set());

  const getSelectedStatuses = (): BookingStatus[] => {
    const statuses: BookingStatus[] = [];
    for (const cat of EXPORT_CATEGORIES) {
      if (selectedCategories.has(cat.id)) statuses.push(...cat.statuses);
    }
    return statuses;
  };

  const handleExport = async () => {
    const statusArray = getSelectedStatuses();
    if (statusArray.length === 0) {
      setError("Select at least one category to export.");
      return;
    }
    setExporting(true);
    setError(null);
    try {
      const userId = auth.currentUser?.uid;
      if (!userId) {
        setError("Not authenticated.");
        return;
      }
      const userSnap = await getDoc(doc(db, "users", userId));
      const userData = userSnap.data();
      const userRole = (userData?.role || "").toString();
      const ownerUid = userRole === "workshop_owner" ? userId : (userData?.ownerUid || userId);
      const userBranchId = userData?.branchId;

      const constraints = [where("ownerUid", "==", ownerUid)];
      if (userRole === "branch_admin" && userBranchId) {
        constraints.push(where("branchId", "==", userBranchId));
      }
      const q = query(collection(db, "bookings"), ...constraints);
      const snap = await getDocs(q);

      const statusArray = getSelectedStatuses();
      const rows: ExportRow[] = [];
      snap.forEach((d) => {
        const b = d.data() as any;
        const norm = normalizeBookingStatus(b?.status || null);
        if (!statusArray.includes(norm)) return;

        const services = b.services || [];
        const firstSvc = Array.isArray(services) ? services[0] : null;
        const serviceName = b.serviceName || firstSvc?.name || "—";
        const staffName = b.staffName || firstSvc?.staffName || "—";
        const duration = b.duration ?? firstSvc?.duration ?? 0;

        rows.push({
          bookingCode: b.bookingCode || "—",
          client: String(b.client || ""),
          clientEmail: String(b.clientEmail || ""),
          clientPhone: String(b.clientPhone || ""),
          serviceName: String(serviceName),
          staffName: String(staffName),
          branchName: String(b.branchName || ""),
          date: String(b.date || ""),
          time: String(b.time || ""),
          duration: String(duration),
          price: String(b.price ?? ""),
          status: getStatusLabel(norm),
          vehicleNumber: String(b.vehicleNumber || ""),
          vehicleMake: String(b.vehicleMake || ""),
          vehicleModel: String(b.vehicleModel || ""),
        });
      });

      // Human-readable booking codes only — do not add Firestore document IDs as a column.
      const columns: { key: keyof ExportRow; header: string }[] = [
        { key: "bookingCode", header: "Booking Code" },
        { key: "client", header: "Client" },
        { key: "clientEmail", header: "Email" },
        { key: "clientPhone", header: "Phone" },
        { key: "serviceName", header: "Service" },
        { key: "staffName", header: "Staff" },
        { key: "branchName", header: "Branch" },
        { key: "date", header: "Date" },
        { key: "time", header: "Time" },
        { key: "duration", header: "Duration (min)" },
        { key: "price", header: "Price" },
        { key: "status", header: "Status" },
        { key: "vehicleNumber", header: "Vehicle Reg" },
        { key: "vehicleMake", header: "Vehicle Make" },
        { key: "vehicleModel", header: "Vehicle Model" },
      ];
      const csv = toCsv(rows, columns);
      const filename = `bookings-export-${new Date().toISOString().slice(0, 10)}.csv`;
      downloadFile(csv, filename);
      onClose();
    } catch (e: any) {
      setError(e?.message || "Export failed.");
    } finally {
      setExporting(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm transition-opacity" onClick={onClose} />
      <div className="relative bg-white rounded-3xl shadow-2xl max-w-lg w-full overflow-hidden">
        {/* Header */}
        <div className="relative bg-gradient-to-br from-neutral-900 via-neutral-800 to-neutral-900 px-6 py-5 overflow-hidden">
          <div className="absolute top-0 right-0 w-40 h-40 bg-amber-500/10 rounded-full -translate-y-1/2 translate-x-1/2" />
          <div className="absolute bottom-0 left-0 w-24 h-24 bg-emerald-500/10 rounded-full translate-y-1/2 -translate-x-1/2" />
          <div className="relative flex items-center gap-4">
            <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center shadow-lg shadow-amber-500/25">
              <i className="fas fa-file-csv text-white text-lg" />
            </div>
            <div>
              <h3 className="text-xl font-bold text-white">Export Bookings</h3>
              <p className="text-sm text-white/70 mt-0.5">Choose which statuses to include in your CSV</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="absolute top-4 right-4 w-9 h-9 rounded-xl bg-white/10 hover:bg-white/20 text-white/80 hover:text-white flex items-center justify-center transition"
          >
            <i className="fas fa-times text-sm" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6">
          <div className="flex items-center justify-between mb-4">
            <span className="text-xs font-semibold text-neutral-500 uppercase tracking-wider">Booking statuses</span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={selectAll}
                className="text-xs font-medium text-neutral-500 hover:text-neutral-900 px-2 py-1 rounded-md hover:bg-neutral-100 transition"
              >
                Select all
              </button>
              <button
                type="button"
                onClick={selectNone}
                className="text-xs font-medium text-neutral-500 hover:text-neutral-900 px-2 py-1 rounded-md hover:bg-neutral-100 transition"
              >
                Clear
              </button>
            </div>
          </div>

          <div className="space-y-3 mb-5">
            {EXPORT_CATEGORIES.map((cat) => {
              const isSelected = selectedCategories.has(cat.id);
              const colorMap: Record<string, string> = {
                amber: "bg-amber-50 border-amber-200 text-amber-700",
                emerald: "bg-emerald-50 border-emerald-200 text-emerald-700",
                indigo: "bg-indigo-50 border-indigo-200 text-indigo-700",
                rose: "bg-rose-50 border-rose-200 text-rose-700",
              };
              const colors = colorMap[cat.color] || "bg-neutral-50 border-neutral-200 text-neutral-700";
              return (
                <button
                  key={cat.id}
                  type="button"
                  onClick={() => toggleCategory(cat.id)}
                  className={`w-full flex flex-col items-start gap-1 px-4 py-3 rounded-xl border-2 transition-all duration-200 text-left ${
                    isSelected
                      ? `${colors} ring-2 ring-offset-2 ring-neutral-900/20 shadow-sm`
                      : "bg-neutral-50 border-neutral-200 text-neutral-500 hover:border-neutral-300 hover:bg-neutral-100"
                  }`}
                >
                  <span className="flex items-center gap-2">
                    {isSelected && <i className="fas fa-check-circle text-current" />}
                    <span className="text-sm font-semibold">{cat.label}</span>
                  </span>
                  {cat.desc && (
                    <span className={`text-[11px] ml-6 ${isSelected ? "opacity-80" : "opacity-60"}`}>
                      {cat.desc}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {error && (
            <div className="mb-4 p-3 rounded-xl bg-red-50 border border-red-200 text-red-700 text-sm flex items-center gap-2">
              <i className="fas fa-exclamation-circle text-red-500" />
              {error}
            </div>
          )}

          <div className="flex gap-3 justify-end pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-5 py-2.5 rounded-xl border border-neutral-200 text-neutral-700 hover:bg-neutral-50 font-medium transition"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleExport}
              disabled={exporting || selectedCategories.size === 0}
              className="px-5 py-2.5 rounded-xl bg-neutral-900 text-white hover:bg-neutral-800 disabled:opacity-50 disabled:cursor-not-allowed font-medium flex items-center gap-2 transition shadow-lg shadow-neutral-900/20"
            >
              {exporting ? (
                <>
                  <svg className="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                  Exporting…
                </>
              ) : (
                <>
                  <i className="fas fa-download" />
                  Export CSV
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
