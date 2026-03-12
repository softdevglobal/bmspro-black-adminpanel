"use client";

import React, { useRef, useState } from "react";
import { parseCsv } from "@/lib/csvUtils";
import { createBooking } from "@/lib/bookings";
import { auth, db } from "@/lib/firebase";
import { getDoc, doc, getDocs, collection, query, where } from "firebase/firestore";

export default function BookingsImportButton() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [previewRows, setPreviewRows] = useState<Record<string, string>[]>([]);
  const [allRows, setAllRows] = useState<Record<string, string>[]>([]);
  const [previewFile, setPreviewFile] = useState<File | null>(null);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setPreviewFile(file);
    file.text().then((text) => {
      const rows = parseCsv(text);
      setAllRows(rows);
      setPreviewRows(rows.slice(0, 10));
      setOpen(true);
    }).catch(() => setError("Could not read file."));
    e.target.value = "";
  };

  const handleImport = async () => {
    if (!previewFile || allRows.length === 0) return;
    setImporting(true);
    setError(null);
    try {
      const userId = auth.currentUser?.uid;
      if (!userId) throw new Error("Not authenticated.");
      const userSnap = await getDoc(doc(db, "users", userId));
      const userData = userSnap.data();
      const ownerUid = (userData?.role === "workshop_owner" ? userId : userData?.ownerUid || userId) as string;

      const rows = allRows;
      const headers = Object.keys(rows[0] || {});
      const getCol = (row: Record<string, string>, patterns: string[]) => {
        const key = headers.find((h) => patterns.some((p) => new RegExp(p, "i").test(h)));
        return key ? String(row[key] ?? "").trim() : "";
      };

      const [branchesSnap, servicesSnap] = await Promise.all([
        getDocs(query(collection(db, "branches"), where("ownerUid", "==", ownerUid))),
        getDocs(query(collection(db, "services"), where("ownerUid", "==", ownerUid))),
      ]);
      const branches = branchesSnap.docs.map((d) => ({ id: d.id, name: d.data().name || "" }));
      const services = servicesSnap.docs.map((d) => ({ id: d.id, name: (d.data().name as string) || "" }));

      let imported = 0;
      for (const row of rows) {
        const client = getCol(row, ["client", "Client"]).trim();
        const branchName = getCol(row, ["branch", "Branch", "branchName"]).trim();
        const serviceName = getCol(row, ["service", "Service", "serviceName"]).trim();
        const date = getCol(row, ["date", "Date"]).trim();
        const time = getCol(row, ["time", "Time"]).trim();
        const priceStr = getCol(row, ["price", "Price"]).trim();
        const durationStr = getCol(row, ["duration", "Duration"]).trim();
        if (!client || !branchName || !serviceName || !date || !time) continue;

        const branch = branches.find((b) => b.name.toLowerCase() === branchName.toLowerCase());
        const service = services.find((s) => String(s.name).toLowerCase() === serviceName.toLowerCase());
        if (!branch || !service) continue;

        const price = parseFloat(priceStr) || 0;
        const duration = parseInt(durationStr, 10) || 60;
        await createBooking({
          client,
          clientEmail: getCol(row, ["email", "Email", "clientEmail"]).trim() || undefined,
          clientPhone: getCol(row, ["phone", "Phone", "clientPhone"]).trim() || undefined,
          vehicleNumber: getCol(row, ["vehicle", "vehicleNumber", "Vehicle Reg"]).trim() || undefined,
          serviceId: service.id,
          serviceName: service.name,
          branchId: branch.id,
          branchName: branch.name,
          date,
          time,
          duration,
          price,
          status: "Pending",
        });
        imported++;
      }
      setOpen(false);
      setPreviewFile(null);
      setPreviewRows([]);
      setAllRows([]);
      alert(`Imported ${imported} booking(s) successfully.`);
    } catch (err: any) {
      setError(err?.message || "Import failed.");
    } finally {
      setImporting(false);
    }
  };

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept=".csv"
        onChange={handleFileSelect}
        className="hidden"
      />
      <button
        onClick={() => fileInputRef.current?.click()}
        className="w-full px-4 py-2 rounded-lg bg-white/10 hover:bg-white/20 text-white text-sm font-medium flex items-center justify-center gap-2 border border-white/20 transition"
      >
        <i className="fas fa-file-import" />
        Import CSV
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/50" onClick={() => !importing && (setOpen(false), setPreviewFile(null), setPreviewRows([]), setAllRows([]))} />
          <div className="relative bg-white rounded-2xl shadow-xl max-w-lg w-full p-6 max-h-[80vh] overflow-hidden flex flex-col">
            <h3 className="text-lg font-bold text-neutral-900 mb-1">Import Bookings from CSV</h3>
            <p className="text-sm text-neutral-500 mb-4">Preview ({previewRows.length} of {allRows.length} rows). Required columns: Client, Branch, Service, Date, Time, Price, Duration.</p>
            {error && <div className="mb-4 p-3 rounded-lg bg-red-50 text-red-700 text-sm">{error}</div>}
            <div className="flex-1 overflow-auto mb-4 border border-neutral-200 rounded-lg p-2 text-xs">
              {previewRows.map((r, i) => (
                <div key={i} className="py-1 border-b border-neutral-100 last:border-0 truncate">
                  {Object.values(r).slice(0, 6).join(" | ")}
                </div>
              ))}
            </div>
            <div className="flex gap-3 justify-end">
              <button type="button" onClick={() => !importing && (setOpen(false), setPreviewFile(null), setPreviewRows([]), setAllRows([]))} className="px-4 py-2 rounded-lg border border-neutral-200 text-neutral-700 hover:bg-neutral-50">Cancel</button>
              <button type="button" onClick={handleImport} disabled={importing} className="px-4 py-2 rounded-lg bg-neutral-900 text-white hover:bg-neutral-800 disabled:opacity-50 flex items-center gap-2">
                {importing ? <svg className="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" /></svg> : null}
                {importing ? "Importing…" : "Import"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
