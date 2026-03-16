"use client";
import React, { useEffect, useRef, useState } from "react";
import Sidebar from "@/components/Sidebar";
import { useRouter } from "next/navigation";
import { auth, db } from "@/lib/firebase";
import { onAuthStateChanged } from "firebase/auth";
import { addDoc, collection, deleteDoc, doc, getDoc, getDocs, onSnapshot, query, setDoc, where } from "firebase/firestore";
import { toCsv, parseCsv, downloadFile } from "@/lib/csvUtils";

type Customer = {
  id: string;
  name: string;
  phone?: string;
  email?: string;
  visits?: number;
  lastVisit?: string;
  notes?: string;
  status?: "Active" | "Inactive";
  firestoreId?: string; // Firestore customers doc id when available
};

type Vehicle = {
  id: string;
  registrationNumber: string;
  make?: string;
  model?: string;
  year?: string;
  mileage?: string;
  bodyType?: string;
  colour?: string;
  vinChassis?: string;
  engineNumber?: string;
};

type PreviewBooking = {
  id: string;
  date: string;
  time: string;
  serviceName: string;
  status: string;
  branchName?: string;
};

export default function CustomersPage() {
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [ownerUid, setOwnerUid] = useState<string | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [notes, setNotes] = useState("");
  const [status, setStatus] = useState<"Active" | "Inactive">("Active");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [previewCust, setPreviewCust] = useState<Customer | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [deleteConfirmCustomer, setDeleteConfirmCustomer] = useState<Customer | null>(null);
  const [deletingCustomer, setDeletingCustomer] = useState(false);
  const [previewVehicles, setPreviewVehicles] = useState<Vehicle[]>([]);
  const [previewBookings, setPreviewBookings] = useState<PreviewBooking[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [bookingsAgg, setBookingsAgg] = useState<Customer[]>([]);
  const [savedCustomers, setSavedCustomers] = useState<Customer[]>([]);
  const [deletedCustomerKeys, setDeletedCustomerKeys] = useState<Set<string>>(new Set());
  const [deletedKeysLoaded, setDeletedKeysLoaded] = useState(false);
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);


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

  // Remove dummy/local storage seed; show only real customers from bookings

  // Live customers derived from bookings for this owner
  useEffect(() => {
    if (!ownerUid) return;
    const q = query(collection(db, "bookings"), where("ownerUid", "==", ownerUid));
    const unsub = onSnapshot(
      q,
      (snap) => {
        const map = new Map<string, Customer>();
        snap.forEach((doc) => {
          const d = doc.data() as any;
          const name = String(d.client || "").trim();
          const email = (d.clientEmail || undefined) as string | undefined;
          const phone = (d.clientPhone || undefined) as string | undefined;
          if (!name && !email && !phone) return;
          const key = (email || phone || name).toString().toLowerCase();
          const date = String(d.date || "");
          const existing = map.get(key);
          if (!existing) {
            map.set(key, {
              id: key,
              name: name || email || phone || "Customer",
              email,
              phone,
              visits: 1,
              lastVisit: date || undefined,
              status: "Active",
            });
          } else {
            existing.visits = (existing.visits || 0) + 1;
            if ((existing.lastVisit || "") < date) existing.lastVisit = date;
          }
        });
        // Save aggregate from bookings
        setBookingsAgg(Array.from(map.values()));
      },
      (error) => {
        if (error.code === "permission-denied") {
          console.warn("Permission denied for customers bookings query.");
          setBookingsAgg([]);
        } else {
          console.error("Error in customers bookings snapshot:", error);
          setBookingsAgg([]);
        }
      }
    );
    return () => unsub();
  }, [ownerUid]);

  // Live customers saved in a dedicated "customers" collection (if your system writes them)
  useEffect(() => {
    if (!ownerUid) return;
    const q = query(collection(db, "customers"), where("ownerUid", "==", ownerUid));
    const unsub = onSnapshot(
      q,
      (snap) => {
        const list: Customer[] = [];
        snap.forEach((doc) => {
          const d = doc.data() as any;
          list.push({
            id: String(doc.id),
            name: String(d.name || d.fullName || d.client || "Customer"),
            phone: d.phone || d.clientPhone || undefined,
          email: d.email || d.clientEmail || undefined,
          notes: d.notes || undefined,
          visits: typeof d.visits === "number" ? d.visits : undefined,
          lastVisit: d.lastVisit || undefined,
          status: (d.status as any) || "Active",
        });
      });
      setSavedCustomers(list);
    },
    (error) => {
      if (error.code === "permission-denied") {
        console.warn("Permission denied for customers query.");
        setSavedCustomers([]);
      } else {
        console.error("Error in customers snapshot:", error);
        setSavedCustomers([]);
      }
    }
    );
    return () => unsub();
  }, [ownerUid]);

  // Fetch deleted customer keys (admin-deleted; hide even when they have bookings)
  // Load with getDoc first to avoid "show then disappear" flash on reload
  useEffect(() => {
    if (!ownerUid) return;
    const ref = doc(db, "customer_deletions", ownerUid);
    getDoc(ref).then(
      (snap) => {
        const keys = (snap.data()?.keys as string[] | undefined) || [];
        setDeletedCustomerKeys(new Set(keys.map((k) => String(k).toLowerCase())));
        setDeletedKeysLoaded(true);
      },
      () => {
        setDeletedCustomerKeys(new Set());
        setDeletedKeysLoaded(true);
      }
    );
    const unsub = onSnapshot(
      ref,
      (snap) => {
        const keys = (snap.data()?.keys as string[] | undefined) || [];
        setDeletedCustomerKeys(new Set(keys.map((k) => String(k).toLowerCase())));
        setDeletedKeysLoaded(true);
      },
      () => {
        setDeletedCustomerKeys(new Set());
        setDeletedKeysLoaded(true);
      }
    );
    return () => unsub();
  }, [ownerUid]);

  // Combine both sources (exclude deleted) - wait for deleted keys to load to avoid flash
  useEffect(() => {
    if (!deletedKeysLoaded) return;
    const keyFor = (c: Customer) => (c.email || c.phone || c.name).toString().toLowerCase();
    const map = new Map<string, Customer>();
    for (const c of savedCustomers) {
      const k = keyFor(c);
      if (deletedCustomerKeys.has(k)) continue;
      map.set(k, { ...c, firestoreId: c.id });
    }
    for (const b of bookingsAgg) {
      const k = keyFor(b);
      if (deletedCustomerKeys.has(k)) continue;
      const existing = map.get(k);
      if (!existing) {
        map.set(k, { ...b });
      } else {
        const visits = (existing.visits || 0) + (b.visits || 0);
        const lastVisit = (existing.lastVisit || "") < (b.lastVisit || "") ? b.lastVisit : existing.lastVisit;
        map.set(k, { ...existing, visits, lastVisit });
      }
    }
    setCustomers(Array.from(map.values()));
  }, [bookingsAgg, savedCustomers, deletedCustomerKeys, deletedKeysLoaded]);

  // Fetch vehicles and bookings when preview opens
  useEffect(() => {
    if (!previewCust || !ownerUid) {
      setPreviewVehicles([]);
      setPreviewBookings([]);
      return;
    }
    let cancelled = false;
    setPreviewLoading(true);
    (async () => {
      try {
        // Resolve Firestore customer ID
        let customerId = previewCust.firestoreId;
        if (!customerId) {
          const custQuery = query(
            collection(db, "customers"),
            where("ownerUid", "==", ownerUid)
          );
          const custSnap = await getDocs(custQuery);
          const email = (previewCust.email || "").trim().toLowerCase();
          const phone = (previewCust.phone || "").trim();
          const name = (previewCust.name || "").trim().toLowerCase();
          for (const d of custSnap.docs) {
            const data = d.data();
            const dEmail = (data.email || "").toString().toLowerCase();
            const dPhone = (data.phone || data.clientPhone || "").toString().trim();
            const dName = (data.name || data.client || "").toString().trim().toLowerCase();
            if ((email && dEmail === email) || (phone && dPhone === phone) || (name && dName === name)) {
              customerId = d.id;
              break;
            }
          }
        }
        const [vehiclesList, bookingsList] = await Promise.all([
          customerId
            ? getDocs(collection(db, "customers", customerId, "vehicles")).then((snap) =>
                snap.docs.map((d) => {
                  const data = d.data();
                  return {
                    id: d.id,
                    registrationNumber: (data.registrationNumber || data.vehicleNumber || "").toString(),
                    make: data.make,
                    model: data.model,
                    year: data.year,
                    mileage: data.mileage,
                    bodyType: data.bodyType,
                    colour: data.colour,
                    vinChassis: data.vinChassis,
                    engineNumber: data.engineNumber,
                  };
                })
              )
            : Promise.resolve([]),
          getDocs(query(collection(db, "bookings"), where("ownerUid", "==", ownerUid))).then((snap) => {
            const email = (previewCust.email || "").trim().toLowerCase();
            const phone = (previewCust.phone || "").trim();
            const name = (previewCust.name || "").trim().toLowerCase();
            const list: PreviewBooking[] = [];
            for (const d of snap.docs) {
              const data = d.data() as any;
              const bEmail = (data.clientEmail || "").toString().trim().toLowerCase();
              const bPhone = (data.clientPhone || "").toString().trim();
              const bName = (data.client || "").toString().trim().toLowerCase();
              const matches =
                (email && bEmail === email) ||
                (phone && bPhone === phone) ||
                (!email && !phone && name && bName === name);
              if (!matches) continue;
              const services = data.services || [];
              const firstService = Array.isArray(services) ? services[0] : null;
              list.push({
                id: d.id,
                date: (data.date || "").toString(),
                time: (data.time || "").toString(),
                serviceName: (data.serviceName || (firstService?.name ?? "Service")).toString(),
                status: (data.status || "").toString(),
                branchName: data.branchName,
              });
            }
            list.sort((a, b) => {
              const d = (a.date || "").localeCompare(b.date || "", undefined, { numeric: true });
              return d !== 0 ? -d : (b.time || "").localeCompare(a.time || "", undefined, { numeric: true });
            });
            return list.slice(0, 20);
          }),
        ]);
        if (!cancelled) {
          setPreviewVehicles(vehiclesList);
          setPreviewBookings(bookingsList);
        }
      } catch (err) {
        if (!cancelled) {
          setPreviewVehicles([]);
          setPreviewBookings([]);
        }
      } finally {
        if (!cancelled) setPreviewLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [previewCust, ownerUid]);

  const saveData = (next: Customer[]) => {
    setCustomers(next);
    try {
      if (typeof window !== "undefined") localStorage.setItem("bms_customers_data", JSON.stringify({ customers: next }));
    } catch {}
  };

  const openModal = (cust?: Customer) => {
    if (cust) {
      setEditingId(cust.id);
      setName(cust.name || "");
      setPhone(cust.phone || "");
      setEmail(cust.email || "");
      setNotes(cust.notes || "");
      setStatus(cust.status || "Active");
    } else {
      setEditingId(null);
      setName("");
      setPhone("");
      setEmail("");
      setNotes("");
      setStatus("Active");
    }
    setIsModalOpen(true);
  };
  const closeModal = () => setIsModalOpen(false);

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!name.trim()) return;
    if (editingId) {
      const next = customers.map((c) =>
        c.id === editingId ? { ...c, name: name.trim(), phone: phone.trim() || undefined, email: email.trim() || undefined, notes: notes.trim() || undefined, status } : c
      );
      saveData(next);
    } else {
      const newC: Customer = {
        id: "cu" + Date.now(),
        name: name.trim(),
        phone: phone.trim() || undefined,
        email: email.trim() || undefined,
        visits: 0,
        lastVisit: undefined,
        notes: notes.trim() || undefined,
        status,
      };
      saveData([...customers, newC]);
    }
    setIsModalOpen(false);
  };

  const removeCustomer = (id: string) => {
    const customer = customers.find((c) => c.id === id);
    if (customer) setDeleteConfirmCustomer(customer);
  };

  const confirmDeleteCustomer = async () => {
    if (!deleteConfirmCustomer || !ownerUid) return;
    setDeletingCustomer(true);
    try {
      const customerId = deleteConfirmCustomer.firestoreId;
      const customerKey = (deleteConfirmCustomer.email || deleteConfirmCustomer.phone || deleteConfirmCustomer.name || "").toString().toLowerCase();
      // Delete from Firestore when customer exists in customers collection (has firestoreId)
      if (customerId) {
        // Delete vehicles subcollection first
        const vehiclesRef = collection(db, "customers", customerId, "vehicles");
        const vehiclesSnap = await getDocs(vehiclesRef);
        await Promise.all(vehiclesSnap.docs.map((d) => deleteDoc(doc(db, "customers", customerId, "vehicles", d.id))));
        // Delete customer document (this also removes their login ability from booking engine)
        await deleteDoc(doc(db, "customers", customerId));
      }
      // Persist deleted key so customer stays hidden after reload (even when they have bookings)
      if (customerKey) {
        const ref = doc(db, "customer_deletions", ownerUid);
        const snap = await getDoc(ref);
        const existing = (snap.data()?.keys as string[] | undefined) || [];
        if (!existing.includes(customerKey)) {
          await setDoc(ref, { keys: [...existing, customerKey] }, { merge: true });
        }
      }
      saveData(customers.filter((c) => c.id !== deleteConfirmCustomer.id));
      setDeleteConfirmCustomer(null);
      if (previewCust?.id === deleteConfirmCustomer.id || previewCust?.firestoreId === customerId) {
        setPreviewOpen(false);
        setPreviewCust(null);
      }
    } catch (err: any) {
      console.error("Failed to delete customer:", err);
      alert(err?.message || "Failed to delete customer. Please try again.");
    } finally {
      setDeletingCustomer(false);
    }
  };

  const resetCustomersData = () => {
    if (!confirm("Reset customer data to defaults?")) return;
    try {
      if (typeof window !== "undefined") {
        localStorage.removeItem("bms_customers_data");
        location.reload();
      }
    } catch {}
  };

  const handleExportCsv = async () => {
    if (!ownerUid) return;
    setExporting(true);
    try {
      const custQuery = query(collection(db, "customers"), where("ownerUid", "==", ownerUid));
      const custSnap = await getDocs(custQuery);
      const bookingsSnap = await getDocs(query(collection(db, "bookings"), where("ownerUid", "==", ownerUid)));
      const allBookings = bookingsSnap.docs.map((d) => ({ id: d.id, ...d.data() } as any));

      type ExportRow = {
        name: string;
        email: string;
        phone: string;
        visits: string;
        lastVisit: string;
        notes: string;
        status: string;
        vehicles: string;
        previousBookings: string;
      };

      const rows: ExportRow[] = [];
      for (const c of customers) {
        let customerId = c.firestoreId;
        if (!customerId) {
          const email = (c.email || "").trim().toLowerCase();
          const phone = (c.phone || "").trim();
          const name = (c.name || "").trim().toLowerCase();
          for (const d of custSnap.docs) {
            const data = d.data();
            const dEmail = (data.email || "").toString().toLowerCase();
            const dPhone = (data.phone || data.clientPhone || "").toString().trim();
            const dName = (data.name || data.client || "").toString().trim().toLowerCase();
            if ((email && dEmail === email) || (phone && dPhone === phone) || (name && dName === name)) {
              customerId = d.id;
              break;
            }
          }
        }

        let vehiclesList: Vehicle[] = [];
        if (customerId) {
          const vSnap = await getDocs(collection(db, "customers", customerId, "vehicles"));
          vehiclesList = vSnap.docs.map((d) => {
            const data = d.data();
            return {
              id: d.id,
              registrationNumber: (data.registrationNumber || data.vehicleNumber || "").toString(),
              make: data.make,
              model: data.model,
              year: data.year,
              mileage: data.mileage,
              bodyType: data.bodyType,
              colour: data.colour,
              vinChassis: data.vinChassis,
              engineNumber: data.engineNumber,
            };
          });
        }

        const email = (c.email || "").trim().toLowerCase();
        const phone = (c.phone || "").trim();
        const name = (c.name || "").trim().toLowerCase();
        const custBookings = allBookings
          .filter((b: any) => {
            const bEmail = (b.clientEmail || "").toString().trim().toLowerCase();
            const bPhone = (b.clientPhone || "").toString().trim();
            const bName = (b.client || "").toString().trim().toLowerCase();
            return (email && bEmail === email) || (phone && bPhone === phone) || (!email && !phone && name && bName === name);
          })
          .sort((a: any, b: any) => {
            const d = (a.date || "").localeCompare(b.date || "", undefined, { numeric: true });
            return d !== 0 ? -d : (b.time || "").localeCompare(a.time || "", undefined, { numeric: true });
          });

        const vehiclesStr = vehiclesList
          .map(
            (v) =>
              [v.registrationNumber, v.make, v.model, v.year, v.bodyType, v.colour, v.mileage, v.vinChassis]
                .filter(Boolean)
                .join(" | ")
          )
          .join("; ");
        const bookingsStr = custBookings
          .map((b: any) => {
            const svc = Array.isArray(b.services) && b.services[0] ? b.services[0].name : b.serviceName || "Service";
            return `${b.date || ""} ${b.time || ""} - ${svc} (${b.status || ""})${b.branchName ? ` @ ${b.branchName}` : ""}`;
          })
          .join("; ");

        rows.push({
          name: c.name || "",
          email: c.email || "",
          phone: c.phone || "",
          visits: String(c.visits ?? 0),
          lastVisit: c.lastVisit || "",
          notes: c.notes || "",
          status: c.status || "Active",
          vehicles: vehiclesStr,
          previousBookings: bookingsStr,
        });
      }

      const columns: { key: keyof ExportRow; header: string }[] = [
        { key: "name", header: "Name" },
        { key: "email", header: "Email" },
        { key: "phone", header: "Phone" },
        { key: "visits", header: "Visits" },
        { key: "lastVisit", header: "Last Visit" },
        { key: "notes", header: "Notes" },
        { key: "status", header: "Status" },
        { key: "vehicles", header: "Vehicles (Reg | Make | Model | Year | Body | Colour | Mileage | VIN)" },
        { key: "previousBookings", header: "Previous Bookings (Date Time - Service (Status) @ Branch)" },
      ];
      const csv = toCsv(rows, columns);
      downloadFile(csv, `customers-export-${new Date().toISOString().slice(0, 10)}.csv`);
    } catch (err: any) {
      console.error("Export failed:", err);
      alert(err?.message || "Export failed.");
    } finally {
      setExporting(false);
    }
  };

  const handleImportCsv = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !ownerUid) return;
    setImporting(true);
    setImportError(null);
    try {
      const text = await file.text();
      const rows = parseCsv(text);
      if (rows.length === 0) {
        setImportError("No valid rows found in CSV.");
        return;
      }
      const headers = Object.keys(rows[0] || {});
      const nameKey = headers.find((h) => /name/i.test(h)) || headers[0];
      const emailKey = headers.find((h) => /email/i.test(h)) || "email";
      const phoneKey = headers.find((h) => /phone/i.test(h)) || "phone";

      let imported = 0;
      for (const row of rows) {
        const name = String((row as any)[nameKey] ?? "").trim();
        const email = String((row as any)[emailKey] ?? "").trim();
        const phone = String((row as any)[phoneKey] ?? "").trim();
        if (!name && !email && !phone) continue;
        await addDoc(collection(db, "customers"), {
          ownerUid,
          name: name || "Customer",
          email: email || null,
          phone: phone || null,
          client: name || "Customer",
          clientEmail: email || null,
          clientPhone: phone || null,
          status: "Active",
        });
        imported++;
      }
      setImportError(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      alert(`Imported ${imported} customer(s) successfully.`);
    } catch (err: any) {
      setImportError(err?.message || "Import failed.");
    } finally {
      setImporting(false);
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

          <div className="mb-8">
            <div className="relative rounded-2xl bg-neutral-900 text-white p-6 shadow-sm overflow-hidden">
              <div className="absolute top-0 right-0 w-32 h-32 bg-white/5 rounded-full -translate-y-1/2 translate-x-1/2" />
              <div className="absolute bottom-0 left-1/3 w-20 h-20 bg-white/5 rounded-full translate-y-1/2" />
              <div className="absolute top-3 right-20 text-white/10 text-3xl"><i className="fas fa-gear" /></div>
              <div className="absolute bottom-2 right-40 text-white/10 text-xl"><i className="fas fa-wrench" /></div>
              <div className="relative flex items-center gap-3">
                <div className="w-11 h-11 rounded-xl bg-amber-500/20 flex items-center justify-center border border-amber-500/30">
                  <i className="fas fa-user-group text-amber-400" />
                </div>
                <div>
                  <h1 className="text-2xl font-bold">Customers</h1>
                  <p className="text-sm text-neutral-400 mt-1">Customer directory and contact details</p>
                </div>
              </div>
            </div>
          </div>

          <div className="max-w-7xl mx-auto">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-6">
              <h2 className="text-2xl font-bold text-neutral-800">Customer Directory</h2>
              <button onClick={() => openModal()} className="w-full sm:w-auto px-4 py-2 bg-neutral-900 text-white rounded-lg text-sm hover:bg-neutral-800 font-medium shadow-md transition flex items-center gap-2">
                <i className="fas fa-user-plus" />
                Add Customer
              </button>
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <div className="lg:col-span-2 space-y-4">
                {!deletedKeysLoaded ? (
                  <div className="bg-white rounded-xl border border-neutral-200 p-8 text-center text-neutral-500">
                    <i className="fas fa-spinner fa-spin text-2xl mb-2" />
                    <p className="text-sm">Loading customers…</p>
                  </div>
                ) : (
                <>
                {customers.map((c) => {
                  const inactive = c.status === "Inactive";
                  const borderColor = inactive ? "border-red-400" : "border-green-500";
                  return (
                    <div
                      key={c.id}
                      className={`bg-white rounded-xl border border-neutral-200 p-4 border-l-4 ${borderColor} ${
                        inactive ? "opacity-75" : ""
                      } hover:shadow-md transition-shadow`}
                    >
                      {/* Mobile & Tablet Layout */}
                      <div className="flex items-start gap-3 sm:gap-4">
                        <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-full bg-neutral-900 text-white flex items-center justify-center font-bold text-lg flex-shrink-0">
                          {c.name.substring(0, 1).toUpperCase()}
                        </div>
                        
                        <div className="flex-1 min-w-0">
                          {/* Name and Contact */}
                          <div className="mb-3">
                            <div className="font-bold text-base sm:text-lg text-neutral-900 mb-1">{c.name}</div>
                            <div className="text-xs sm:text-sm text-neutral-500 flex flex-wrap gap-x-2 gap-y-1">
                              <span className="flex items-center gap-1">
                                <i className="fas fa-phone text-neutral-600" />
                                {c.phone || "No phone"}
                              </span>
                              <span className="hidden sm:inline">•</span>
                              <span className="flex items-center gap-1">
                                <i className="fas fa-envelope text-indigo-600" />
                                {c.email || "No email"}
                              </span>
                            </div>
                          </div>
                          
                          {/* Stats Row */}
                          <div className="flex items-center justify-between gap-3">
                            <div className="flex items-center gap-4 sm:gap-6">
                              <div>
                                <div className="text-xs text-neutral-500 mb-0.5">Bookings</div>
                                <div className="font-bold text-neutral-600">{c.visits ?? 0}</div>
                              </div>
                              <div>
                                <div className="text-xs text-neutral-500 mb-0.5">Last Visit</div>
                                <div className="font-semibold text-sm text-neutral-800">{c.lastVisit || "—"}</div>
                              </div>
                            </div>
                            
                            {/* Action Buttons */}
                            <div className="flex items-center gap-2">
                              <button
                                className="w-9 h-9 rounded-lg bg-neutral-100 hover:bg-indigo-100 text-neutral-600 hover:text-indigo-600 flex items-center justify-center transition-colors"
                                title="Preview Customer"
                                onClick={() => {
                                  setPreviewCust(c);
                                  setPreviewOpen(true);
                                }}
                              >
                                <i className="fas fa-eye" />
                              </button>
                              <button 
                                className="w-9 h-9 rounded-lg bg-neutral-100 hover:bg-rose-100 text-neutral-600 hover:text-rose-600 flex items-center justify-center transition-colors" 
                                title="Delete Customer" 
                                onClick={() => removeCustomer(c.id)}
                              >
                                <i className="fas fa-trash" />
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
                {customers.length === 0 && <div className="bg-white rounded-xl border border-neutral-200 p-6 text-neutral-500">No customers yet. Add your first customer.</div>}
                </>
                )}
              </div>
              <div className="space-y-6">
                <div className="bg-neutral-900 text-white rounded-xl p-4 border-none h-fit">
                  <h3 className="font-bold mb-4">Customer Quick Stats</h3>
                  <div className="space-y-4">
                    <div className="bg-white/10 p-3 rounded-lg flex justify-between">
                      <span>Total Customers</span>
                      <span className="font-bold">{customers.length}</span>
                    </div>
                    <div className="bg-white/10 p-3 rounded-lg flex justify-between">
                      <span>Active</span>
                      <span className="font-bold text-green-400">
                        {customers.filter((c) => c.status !== "Inactive").length}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="bg-neutral-900 text-white rounded-xl p-4 border-none h-fit">
                  <h3 className="font-bold mb-1">Import & Export</h3>
                  <p className="text-xs text-white/60 mb-3">Upload or download customer data as CSV.</p>
                  {importError && (
                    <div className="mb-3 p-2 rounded-lg bg-red-500/20 text-red-200 text-xs">{importError}</div>
                  )}
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".csv"
                    onChange={handleImportCsv}
                    className="hidden"
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      disabled={importing || !ownerUid}
                      className="flex-1 bg-white/10 hover:bg-white/20 py-2 px-3 rounded-lg flex items-center justify-center gap-1.5 text-xs font-medium text-white/90 hover:text-white border border-white/20 transition disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {importing ? (
                        <svg className="animate-spin h-3.5 w-3.5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                        </svg>
                      ) : (
                        <i className="fas fa-file-import text-[11px]" />
                      )}
                      Import
                    </button>
                    <button
                      onClick={handleExportCsv}
                      disabled={exporting}
                      className="flex-1 bg-white/10 hover:bg-white/20 py-2 px-3 rounded-lg flex items-center justify-center gap-1.5 text-xs font-medium text-white/90 hover:text-white border border-white/20 transition disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {exporting ? (
                        <svg className="animate-spin h-3.5 w-3.5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                        </svg>
                      ) : (
                        <i className="fas fa-file-export text-[11px]" />
                      )}
                      {exporting ? "Exporting…" : "Export"}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </main>
      </div>

      {/* Preview Sidebar */}
      <div
        className={`fixed inset-0 z-50 ${previewOpen ? "pointer-events-auto" : "pointer-events-none"}`}
        aria-hidden={!previewOpen}
      >
        <div
          onClick={() => setPreviewOpen(false)}
          className={`absolute inset-0 bg-black/50 transition-opacity duration-200 ${previewOpen ? "opacity-100" : "opacity-0"}`}
        />
        <aside
          className={`absolute top-0 h-full right-0 w-[92vw] sm:w-[28rem] bg-white shadow-2xl border-l border-neutral-200 transform transition-transform duration-300 ${previewOpen ? "translate-x-0" : "translate-x-full"}`}
        >
          {previewCust && (
            <div className="flex h-full flex-col">
              {/* Fixed Header */}
              <div className="shrink-0 relative bg-neutral-900 p-5 overflow-hidden">
                <div className="absolute top-0 right-0 w-24 h-24 bg-white/5 rounded-full -translate-y-1/2 translate-x-1/2" />
                <div className="absolute top-2 right-16 text-white/10 text-xl"><i className="fas fa-gear" /></div>
                <div className="relative flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-amber-500/20 flex items-center justify-center border border-amber-500/30">
                      <i className="fas fa-user text-amber-400"></i>
                    </div>
                    <div>
                      <h3 className="text-lg font-bold text-white">Customer Details</h3>
                      <p className="text-white/80 text-sm">{previewCust.name}</p>
                    </div>
                  </div>
                  <button 
                    onClick={() => setPreviewOpen(false)}
                    className="w-9 h-9 bg-white/20 backdrop-blur-sm hover:bg-white/30 rounded-full flex items-center justify-center text-white transition-all"
                  >
                    <i className="fas fa-times text-lg" />
                  </button>
                </div>
              </div>
              
              {/* Scrollable Content */}
              <div className="flex-1 overflow-y-auto p-5 space-y-4">
                {/* Profile Section */}
                <div className="flex items-center gap-4 bg-neutral-50 rounded-xl p-4 border-2 border-neutral-200">
                  <div className="w-16 h-16 rounded-full bg-neutral-900 text-white flex items-center justify-center font-bold text-2xl shadow-lg flex-shrink-0">
                    {previewCust.name.substring(0, 1).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <h4 className="font-bold text-lg text-neutral-900 mb-1">{previewCust.name}</h4>
                    <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold ${
                        previewCust.status === "Inactive" 
                          ? "bg-red-100 text-red-700" 
                          : "bg-green-100 text-green-700"
                      }`}>
                      <span className="w-1.5 h-1.5 rounded-full bg-current"></span>
                        {previewCust.status || "Active"}
                      </span>
                  </div>
                </div>

                {/* Contact Information */}
                <div className="bg-white rounded-xl p-4 border-2 border-neutral-200">
                  <h5 className="font-semibold text-sm text-neutral-800 mb-3 flex items-center gap-2">
                    <i className="fas fa-address-book text-neutral-600" />
                    Contact Information
                  </h5>
                  <div className="space-y-3">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-lg bg-neutral-100 flex items-center justify-center flex-shrink-0">
                        <i className="fas fa-phone text-neutral-600" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-xs text-neutral-500 font-medium">Phone Number</div>
                        <div className="font-semibold text-sm text-neutral-900">{previewCust.phone || "Not provided"}</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-lg bg-indigo-100 flex items-center justify-center flex-shrink-0">
                        <i className="fas fa-envelope text-indigo-600" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-xs text-neutral-500 font-medium">Email Address</div>
                        <div className="font-semibold text-sm text-neutral-900 truncate">{previewCust.email || "Not provided"}</div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Booking Statistics */}
                <div className="bg-white rounded-xl p-4 border-2 border-neutral-200">
                  <h5 className="font-semibold text-sm text-neutral-800 mb-3 flex items-center gap-2">
                    <i className="fas fa-chart-simple text-neutral-600" />
                    Booking Statistics
                  </h5>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="bg-neutral-50 rounded-lg p-3 border border-neutral-200">
                      <div className="text-3xl font-bold text-neutral-900 mb-1">
                        {previewCust.visits ?? 0}
                      </div>
                      <div className="text-xs text-neutral-600 font-medium">Total Bookings</div>
                    </div>
                    <div className="bg-gradient-to-br from-blue-50 to-indigo-50 rounded-lg p-3 border border-blue-200">
                      <div className="text-sm font-bold text-blue-600 mb-1">{previewCust.lastVisit || "Never"}</div>
                      <div className="text-xs text-neutral-600 font-medium">Last Visit</div>
                    </div>
                  </div>
                </div>

                {/* Vehicle Details */}
                <div className="bg-white rounded-xl p-4 border-2 border-neutral-200">
                  <h5 className="font-semibold text-sm text-neutral-800 mb-3 flex items-center gap-2">
                    <i className="fas fa-car text-neutral-600" />
                    Vehicle Details
                  </h5>
                  {previewLoading ? (
                    <div className="flex items-center justify-center py-4">
                      <svg className="animate-spin h-5 w-5 text-neutral-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                      </svg>
                    </div>
                  ) : previewVehicles.length === 0 ? (
                    <p className="text-xs text-neutral-500 py-2">No vehicles on file</p>
                  ) : (
                    <div className="space-y-3">
                      {previewVehicles.map((v) => (
                        <div key={v.id} className="bg-neutral-50 rounded-lg p-3 border border-neutral-200">
                          <div className="font-semibold text-sm text-neutral-900 flex items-center gap-2">
                            <i className="fas fa-id-card text-[10px] text-neutral-500" />
                            {[v.registrationNumber, v.make, v.model, v.year].filter(Boolean).join(" ") || "—"}
                          </div>
                          <div className="flex flex-wrap gap-1.5 mt-1.5 text-[11px] text-neutral-600">
                            {v.bodyType && <span className="bg-neutral-200 px-1.5 py-0.5 rounded">{v.bodyType}</span>}
                            {v.colour && <span className="bg-neutral-200 px-1.5 py-0.5 rounded">{v.colour}</span>}
                            {v.mileage && <span className="bg-neutral-200 px-1.5 py-0.5 rounded">{v.mileage}</span>}
                            {v.vinChassis && <span className="text-neutral-500 truncate max-w-[120px]" title={v.vinChassis}>VIN: {v.vinChassis}</span>}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Previous Bookings */}
                <div className="bg-white rounded-xl p-4 border-2 border-neutral-200">
                  <h5 className="font-semibold text-sm text-neutral-800 mb-3 flex items-center gap-2">
                    <i className="fas fa-history text-neutral-600" />
                    Previous Bookings
                  </h5>
                  {previewLoading ? (
                    <div className="flex items-center justify-center py-4">
                      <svg className="animate-spin h-5 w-5 text-neutral-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                      </svg>
                    </div>
                  ) : previewBookings.length === 0 ? (
                    <p className="text-xs text-neutral-500 py-2">No booking history</p>
                  ) : (
                    <div className="space-y-2 max-h-48 overflow-y-auto">
                      {previewBookings.map((b) => (
                        <div key={b.id} className="flex items-center justify-between gap-2 py-2 border-b border-neutral-100 last:border-0">
                          <div className="min-w-0">
                            <div className="font-medium text-sm text-neutral-800 truncate">{b.serviceName}</div>
                            <div className="text-[11px] text-neutral-500">{b.date} {b.time}</div>
                          </div>
                          <span className={`shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                            b.status === "Completed" ? "bg-green-100 text-green-700" :
                            b.status === "Confirmed" ? "bg-blue-100 text-blue-700" :
                            b.status === "Canceled" || b.status === "Cancelled" ? "bg-red-100 text-red-700" :
                            "bg-amber-100 text-amber-700"
                          }`}>{b.status}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Loyalty Badge */}
                <div className="bg-neutral-50 rounded-xl p-4 border-2 border-neutral-200">
                  <div className="flex items-center justify-center gap-3">
                    <span className="text-3xl">
                    {(previewCust.visits ?? 0) >= 10 ? "🌟" : (previewCust.visits ?? 0) >= 5 ? "💎" : "🆕"}
                  </span>
                    <div>
                      <div className="font-bold text-sm text-neutral-900">
                    {(previewCust.visits ?? 0) >= 10 ? "VIP Member" : 
                     (previewCust.visits ?? 0) >= 5 ? "Regular Customer" : 
                     "New Customer"}
                      </div>
                      <div className="text-xs text-neutral-600">
                        {(previewCust.visits ?? 0) >= 10 ? "10+ bookings" : 
                         (previewCust.visits ?? 0) >= 5 ? "5+ bookings" : 
                         "First time customer"}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Notes Section */}
                {previewCust.notes && (
                  <div className="bg-amber-50 rounded-xl p-4 border-2 border-amber-200">
                    <h5 className="font-semibold text-sm text-neutral-900 mb-2 flex items-center gap-2">
                      <i className="fas fa-sticky-note text-amber-600" />
                      Notes
                    </h5>
                    <div className="text-sm text-neutral-700 whitespace-pre-wrap">{previewCust.notes}</div>
                  </div>
                )}
              </div>

              {/* Footer Actions */}
              <div className="shrink-0 border-t border-neutral-200 p-4 bg-white flex gap-3">
                  <button 
                    onClick={() => setPreviewOpen(false)} 
                  className="flex-1 px-4 py-2.5 rounded-lg text-sm font-semibold bg-neutral-200 hover:bg-neutral-300 text-neutral-700 transition"
                  >
                  <i className="fas fa-times mr-2" />
                    Close
                  </button>
                  <button 
                    onClick={() => removeCustomer(previewCust.id)} 
                    className="flex-1 px-4 py-2.5 rounded-lg text-sm font-semibold bg-rose-600 hover:bg-rose-700 text-white transition shadow-lg"
                  >
                  <i className="fas fa-trash mr-2" />
                    Delete
                  </button>
              </div>
            </div>
          )}
        </aside>
        </div>

      {/* Delete confirmation modal */}
      {deleteConfirmCustomer && (
        <div className="fixed inset-0 z-50">
          <div className="absolute inset-0 bg-black/50" onClick={() => setDeleteConfirmCustomer(null)} />
          <div className="relative flex items-center justify-center min-h-screen p-4">
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-12 h-12 rounded-xl bg-rose-100 flex items-center justify-center">
                  <i className="fas fa-trash text-rose-600" />
                </div>
                <div>
                  <h3 className="text-lg font-bold text-neutral-900">Delete Customer</h3>
                  <p className="text-sm text-neutral-500">This action cannot be undone.</p>
                </div>
              </div>
              <p className="text-neutral-600 mb-6">
                Are you sure you want to delete <span className="font-semibold text-neutral-900">{deleteConfirmCustomer.name}</span>? All associated data will be removed.
              </p>
              <div className="flex gap-3">
                <button
                  onClick={() => setDeleteConfirmCustomer(null)}
                  className="flex-1 px-4 py-2.5 rounded-lg text-sm font-semibold bg-neutral-200 hover:bg-neutral-300 text-neutral-700 transition"
                >
                  Cancel
                </button>
                <button
                  onClick={confirmDeleteCustomer}
                  disabled={deletingCustomer}
                  className="flex-1 px-4 py-2.5 rounded-lg text-sm font-semibold bg-rose-600 hover:bg-rose-700 text-white transition disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {deletingCustomer ? "Deleting…" : "Delete"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {isModalOpen && (
        <div className="fixed inset-0 z-50">
          <div className="absolute inset-0 bg-black/50" onClick={closeModal} />
          <div className="relative flex items-center justify-center min-h-screen p-4">
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[92vh] flex flex-col overflow-hidden">
              <div className="relative px-5 py-4 bg-neutral-900 flex items-center justify-between sticky top-0 z-10 overflow-hidden rounded-t-2xl">
                <div className="absolute top-0 right-0 w-24 h-24 bg-white/5 rounded-full -translate-y-1/2 translate-x-1/2" />
                <div className="absolute top-2 right-20 text-white/10 text-xl"><i className="fas fa-gear" /></div>
                <div className="relative flex items-center gap-3">
                  <div className="w-9 h-9 rounded-lg bg-amber-500/20 flex items-center justify-center border border-amber-500/30">
                    <i className="fas fa-user-plus text-amber-400 text-sm" />
                  </div>
                  <h3 className="text-base font-semibold text-white">{editingId ? "Edit Customer" : "Add Customer"}</h3>
                </div>
                <button className="relative text-white/60 hover:text-white" onClick={closeModal}>
                  <i className="fas fa-times" />
                </button>
              </div>
              <form onSubmit={handleSubmit} className="p-6 space-y-4 overflow-y-auto" style={{ maxHeight: "calc(92vh - 56px)" }}>
                <div>
                  <label className="block text-xs font-bold text-neutral-600 mb-1">Full Name</label>
                  <input value={name} onChange={(e) => setName(e.target.value)} required className="w-full border border-neutral-300 rounded-lg p-2.5 text-sm focus:ring-2 focus:ring-neutral-900 focus:outline-none" placeholder="Jane Doe" />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-bold text-neutral-600 mb-1">Phone</label>
                    <input value={phone} onChange={(e) => setPhone(e.target.value)} className="w-full border border-neutral-300 rounded-lg p-2.5 text-sm focus:ring-2 focus:ring-neutral-900 focus:outline-none" placeholder="0400 000 000" />
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-neutral-600 mb-1">Email</label>
                    <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" className="w-full border border-neutral-300 rounded-lg p-2.5 text-sm focus:ring-2 focus:ring-neutral-900 focus:outline-none" placeholder="jane@example.com" />
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-bold text-neutral-600 mb-1">Status</label>
                  <select value={status} onChange={(e) => setStatus(e.target.value as any)} className="w-full border border-neutral-300 rounded-lg p-2.5 text-sm bg-white focus:ring-2 focus:ring-neutral-900 focus:outline-none">
                    <option value="Active">Active</option>
                    <option value="Inactive">Inactive</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-bold text-neutral-600 mb-1">Notes</label>
                  <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} className="w-full border border-neutral-300 rounded-lg p-2.5 text-sm focus:ring-2 focus:ring-neutral-900 focus:outline-none" placeholder="Any details..." />
                </div>
                <button type="submit" className="w-full bg-neutral-900 hover:bg-neutral-800 text-white font-bold py-2.5 rounded-lg shadow-md transition mt-2">
                  {editingId ? "Save Changes" : "Add Customer"}
                </button>
              </form>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}



