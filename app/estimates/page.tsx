"use client";
import React, { useEffect, useState, useCallback, useRef } from "react";
import Sidebar from "@/components/Sidebar";
import { useRouter } from "next/navigation";
import { auth, db } from "@/lib/firebase";
import { onAuthStateChanged } from "firebase/auth";
import { getStorage, ref as storageRef, uploadBytes, getDownloadURL } from "firebase/storage";
import {
  collection,
  doc,
  onSnapshot,
  query,
  where,
  updateDoc,
  serverTimestamp,
  orderBy,
} from "firebase/firestore";

type Reply = {
  id: string;
  message: string;
  imageUrls: string[];
  createdAt: string | null;
};

type Estimate = {
  id: string;
  ownerUid: string;
  workshopSlug: string;
  workshopName: string;
  branchId: string | null;
  branchName: string | null;
  customerName: string;
  customerPhone: string;
  customerEmail: string;
  vehicleMake: string;
  vehicleModel: string;
  vehicleYear: string;
  rego: string;
  description: string;
  imageUrls?: string[];
  status: "New" | "Reviewed" | "Quoted" | "Closed";
  createdAt: any;
  updatedAt: any;
};

function mapEstimateFromFirestore(doc: { id: string; data: () => Record<string, unknown> }): Estimate {
  const d = doc.data() as Record<string, unknown>;
  const imageUrls = Array.isArray(d?.imageUrls)
    ? (d.imageUrls as string[]).map((u) => String(u))
    : Array.isArray(d?.images)
      ? (d.images as unknown[]).map((u) => String(u))
      : [];
  return { id: doc.id, ...d, imageUrls } as Estimate;
}

const statusConfig: Record<
  string,
  { bg: string; text: string; icon: string; label: string }
> = {
  New: { bg: "bg-amber-100", text: "text-amber-700", icon: "fa-sparkles", label: "New" },
  Reviewed: { bg: "bg-blue-100", text: "text-blue-700", icon: "fa-eye", label: "Reviewed" },
  Quoted: { bg: "bg-emerald-100", text: "text-emerald-700", icon: "fa-check", label: "Quoted" },
  Closed: { bg: "bg-neutral-200", text: "text-neutral-600", icon: "fa-xmark", label: "Closed" },
};

export default function EstimatesPage() {
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [ownerUid, setOwnerUid] = useState<string | null>(null);
  const [estimates, setEstimates] = useState<Estimate[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterStatus, setFilterStatus] = useState<string>("All");
  const [previewEstimate, setPreviewEstimate] = useState<Estimate | null>(null);
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  // Reply state
  const [replies, setReplies] = useState<Reply[]>([]);
  const [repliesLoading, setRepliesLoading] = useState(false);
  const [replyMessage, setReplyMessage] = useState("");
  const [replyImages, setReplyImages] = useState<File[]>([]);
  const [replyImagePreviews, setReplyImagePreviews] = useState<string[]>([]);
  const [replySending, setReplySending] = useState(false);
  const [replySuccess, setReplySuccess] = useState(false);
  const replyFileRef = useRef<HTMLInputElement>(null);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) { router.replace("/login"); return; }
      setOwnerUid(user.uid);
    });
    return () => unsub();
  }, [router]);

  useEffect(() => {
    if (!ownerUid) return;
    const q = query(
      collection(db, "estimates"),
      where("ownerUid", "==", ownerUid),
      orderBy("createdAt", "desc")
    );
    const unsub = onSnapshot(q, (snap) => {
      const data = snap.docs.map((d) => mapEstimateFromFirestore(d));
      setEstimates(data);
      setLoading(false);
    }, (error) => {
      console.error("Estimates query error:", error);
      // Fallback: try without orderBy (avoids composite index requirement)
      const fallbackQ = query(
        collection(db, "estimates"),
        where("ownerUid", "==", ownerUid)
      );
      onSnapshot(fallbackQ, (snap) => {
        const data = snap.docs
          .map((d) => mapEstimateFromFirestore(d))
          .sort((a, b) => {
            const aTime = a.createdAt?.toDate?.() || new Date(0);
            const bTime = b.createdAt?.toDate?.() || new Date(0);
            return bTime.getTime() - aTime.getTime();
          });
        setEstimates(data);
        setLoading(false);
      }, () => setLoading(false));
    });
    return () => unsub();
  }, [ownerUid]);

  const updateStatus = async (id: string, newStatus: string) => {
    setUpdatingId(id);
    try {
      await updateDoc(doc(db, "estimates", id), {
        status: newStatus,
        updatedAt: serverTimestamp(),
      });
    } catch (e) {
      console.error("Failed to update estimate:", e);
    } finally {
      setUpdatingId(null);
    }
  };

  const fetchReplies = useCallback(async (estimateId: string) => {
    setRepliesLoading(true);
    try {
      const res = await fetch(`/api/book-now/estimate-reply?estimateId=${estimateId}`);
      if (res.ok) {
        const data = await res.json();
        setReplies(data.replies || []);
      }
    } catch (err) {
      console.error("Failed to fetch replies:", err);
    } finally {
      setRepliesLoading(false);
    }
  }, []);

  const openPreview = useCallback((est: Estimate) => {
    setPreviewEstimate(est);
    setReplyMessage("");
    setReplyImages([]);
    setReplyImagePreviews([]);
    setReplySuccess(false);
    fetchReplies(est.id);
  }, [fetchReplies]);

  const handleReplyImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    const newFiles = [...replyImages, ...files].slice(0, 5);
    setReplyImages(newFiles);
    setReplyImagePreviews(newFiles.map((f) => URL.createObjectURL(f)));
    if (replyFileRef.current) replyFileRef.current.value = "";
  };

  const removeReplyImage = (idx: number) => {
    const newFiles = replyImages.filter((_, i) => i !== idx);
    setReplyImages(newFiles);
    setReplyImagePreviews(newFiles.map((f) => URL.createObjectURL(f)));
  };

  const sendReply = async () => {
    if (!previewEstimate || !ownerUid || !replyMessage.trim()) return;
    setReplySending(true);
    try {
      let imageUrls: string[] = [];
      if (replyImages.length > 0) {
        const storage = getStorage();
        for (const file of replyImages) {
          const ts = Date.now();
          const path = `estimates/${previewEstimate.id}/replies/${ts}_${file.name}`;
          const imgRef = storageRef(storage, path);
          await uploadBytes(imgRef, file);
          const url = await getDownloadURL(imgRef);
          imageUrls.push(url);
        }
      }

      const res = await fetch("/api/book-now/estimate-reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          estimateId: previewEstimate.id,
          ownerUid,
          message: replyMessage.trim(),
          imageUrls,
        }),
      });

      if (!res.ok) {
        const text = await res.text();
        let data: { error?: string } = {};
        try {
          data = text ? JSON.parse(text) : {};
        } catch {
          if (res.status === 413) throw new Error("Request payload too large. Try reducing the number or size of attached images.");
          throw new Error("Failed to send reply");
        }
        throw new Error(data.error || "Failed to send reply");
      }

      setReplyMessage("");
      setReplyImages([]);
      setReplyImagePreviews([]);
      setReplySuccess(true);
      setTimeout(() => setReplySuccess(false), 3000);
      fetchReplies(previewEstimate.id);
    } catch (err) {
      console.error("Failed to send reply:", err);
    } finally {
      setReplySending(false);
    }
  };

  const filtered = filterStatus === "All" ? estimates : estimates.filter((e) => e.status === filterStatus);

  const counts = {
    All: estimates.length,
    New: estimates.filter((e) => e.status === "New").length,
    Reviewed: estimates.filter((e) => e.status === "Reviewed").length,
    Quoted: estimates.filter((e) => e.status === "Quoted").length,
    Closed: estimates.filter((e) => e.status === "Closed").length,
  };

  const formatDate = (ts: any) => {
    if (!ts) return "-";
    const d = ts.toDate ? ts.toDate() : new Date(ts);
    return d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  };

  return (
    <div id="app" className="flex h-screen overflow-hidden bg-white">
      <Sidebar />
      <div className="flex-1 flex flex-col overflow-hidden">
        <main className="flex-1 overflow-auto p-4 sm:p-6 lg:p-8 bg-neutral-50">
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

          <div className="max-w-7xl mx-auto">
            {/* Header */}
            <div className="mb-8">
              <div className="relative rounded-2xl bg-neutral-900 text-white p-8 shadow-lg overflow-hidden">
                <div className="absolute inset-0 overflow-hidden">
                  <div className="absolute -top-6 -right-6 w-36 h-36 rounded-full bg-amber-500/10" />
                  <div className="absolute -bottom-10 -left-10 w-44 h-44 rounded-full bg-amber-500/5" />
                  <i className="fas fa-file-invoice absolute -right-3 -bottom-3 text-[90px] text-white/[0.03] rotate-12" />
                </div>
                <div className="relative flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-xl bg-amber-500/20 border border-amber-500/30 flex items-center justify-center">
                        <i className="fas fa-file-invoice text-amber-400" />
                      </div>
                      <h1 className="text-2xl font-bold tracking-tight">Estimates</h1>
                    </div>
                    <p className="text-neutral-400 mt-2">
                      Manage customer estimate requests
                    </p>
                  </div>
                </div>
              </div>
            </div>
          {/* Filter Tabs */}
          <div className="flex items-center gap-2 mb-6 overflow-x-auto pb-1">
            {(["All", "New", "Reviewed", "Quoted", "Closed"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setFilterStatus(s)}
                className={`flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-bold transition-all whitespace-nowrap ${
                  filterStatus === s
                    ? "bg-neutral-900 text-white shadow-md"
                    : "bg-white text-neutral-500 hover:bg-neutral-100 border border-neutral-200"
                }`}
              >
                {s}
                {counts[s] > 0 && (
                  <span className={`min-w-[18px] h-[18px] flex items-center justify-center text-[9px] font-bold rounded-full px-1 ${
                    filterStatus === s ? "bg-white/20 text-white" : "bg-neutral-100 text-neutral-600"
                  }`}>
                    {counts[s]}
                  </span>
                )}
              </button>
            ))}
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-20">
              <svg className="animate-spin h-6 w-6 text-neutral-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-20">
              <div className="w-16 h-16 mx-auto mb-4 bg-neutral-100 rounded-2xl flex items-center justify-center">
                <i className="fas fa-file-invoice text-2xl text-neutral-300" />
              </div>
              <p className="text-neutral-500 font-medium">No {filterStatus !== "All" ? filterStatus.toLowerCase() : ""} estimates found</p>
            </div>
          ) : (
            <>
              {/* Mobile Card View */}
              <div className="md:hidden space-y-3">
                {filtered.map((e) => {
                  const sc = statusConfig[e.status] || statusConfig.New;
                  return (
                    <div key={e.id} className="bg-white rounded-xl border border-neutral-200 shadow-sm overflow-hidden">
                      <div className="p-4">
                        <div className="flex items-center justify-between mb-3">
                          <div className="flex items-center gap-2.5">
                            <div className="w-10 h-10 flex-shrink-0 bg-neutral-900 text-white flex items-center justify-center text-sm font-bold" style={{ borderRadius: "50%" }}>
                              {e.customerName.charAt(0).toUpperCase()}
                            </div>
                            <div>
                              <div className="font-semibold text-neutral-800 text-sm">{e.customerName}</div>
                              <div className="text-[11px] text-neutral-400">{e.customerPhone}</div>
                            </div>
                          </div>
                          <span className={`px-2.5 py-1 rounded-full text-[10px] font-bold ${sc.bg} ${sc.text}`}>
                            <i className={`fas ${sc.icon} mr-1`} />
                            {sc.label}
                          </span>
                        </div>

                        {(e.vehicleMake || e.vehicleModel) && (
                          <div className="flex items-center gap-1.5 text-xs text-neutral-600 mb-2 bg-neutral-50 rounded-lg px-2.5 py-1.5">
                            <i className="fas fa-car text-[10px] text-neutral-400" />
                            <span className="font-medium">
                              {[e.vehicleYear, e.vehicleMake, e.vehicleModel].filter(Boolean).join(" ")}
                              {e.rego && <span className="text-neutral-400 ml-1">({e.rego})</span>}
                            </span>
                          </div>
                        )}

                        <p className="text-xs text-neutral-600 line-clamp-2 mb-3">{e.description}</p>

                        {(e.imageUrls?.length ?? 0) > 0 && (
                          <div className="flex items-center gap-1.5 mb-2 text-[10px] text-amber-600">
                            <i className="fas fa-images" />
                            <span>{e.imageUrls!.length} photo{(e.imageUrls!.length ?? 0) > 1 ? "s" : ""} attached</span>
                          </div>
                        )}

                        <div className="flex items-center justify-between text-[10px] text-neutral-400">
                          {e.branchName && (
                            <span className="flex items-center gap-1">
                              <i className="fas fa-location-dot text-[8px]" />
                              {e.branchName}
                            </span>
                          )}
                          <span>{formatDate(e.createdAt)}</span>
                        </div>
                      </div>

                      <div className="border-t border-neutral-100 px-4 py-2.5 flex items-center gap-2 bg-neutral-50/50">
                        <button onClick={() => openPreview(e)} className="px-3 py-1.5 rounded-full text-xs font-semibold bg-neutral-300 text-neutral-800 hover:bg-neutral-400 transition inline-flex items-center gap-1">
                          Preview
                        </button>
                        <div className="flex-1" />
                        {e.status === "New" && (
                          <button disabled={updatingId === e.id} onClick={() => updateStatus(e.id, "Reviewed")}
                            className="px-3 py-1.5 rounded-full text-xs font-semibold bg-blue-500 text-white hover:bg-blue-600 transition inline-flex items-center gap-1">
                            <i className="fas fa-eye text-[10px]" />
                            Reviewed
                          </button>
                        )}
                        {(e.status === "New" || e.status === "Reviewed") && (
                          <button disabled={updatingId === e.id} onClick={() => updateStatus(e.id, "Quoted")}
                            className="px-3 py-1.5 rounded-full text-xs font-semibold bg-emerald-500 text-white hover:bg-emerald-600 transition inline-flex items-center gap-1">
                            <i className="fas fa-check text-[10px]" />
                            Quoted
                          </button>
                        )}
                        {e.status !== "Closed" && (
                          <button disabled={updatingId === e.id} onClick={() => updateStatus(e.id, "Closed")}
                            className="px-3 py-1.5 rounded-full text-xs font-semibold bg-neutral-400 text-white hover:bg-neutral-500 transition inline-flex items-center gap-1">
                            <i className="fas fa-xmark text-[10px]" />
                            Close
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Desktop Table View */}
              <div className="hidden md:block bg-white rounded-2xl border border-neutral-200 shadow-sm overflow-hidden">
                <div className="relative overflow-x-auto">
                  <table className="min-w-[900px] w-full text-left text-sm text-neutral-600">
                    <thead className="bg-neutral-50/90 backdrop-blur text-neutral-800 font-semibold border-b border-neutral-100 sticky top-0 z-10">
                      <tr>
                        <th className="p-4 pl-6">Customer</th>
                        <th className="p-4">Vehicle</th>
                        <th className="p-4">Description</th>
                        <th className="p-4">Branch</th>
                        <th className="p-4">Status</th>
                        <th className="p-4">Date</th>
                        <th className="p-4 text-right pr-6">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-neutral-100">
                      {filtered.map((e) => {
                        const sc = statusConfig[e.status] || statusConfig.New;
                        return (
                          <tr key={e.id} className="hover:bg-neutral-50 transition">
                            <td className="p-4 pl-6">
                              <div className="flex items-center gap-3">
                                <div className="w-9 h-9 flex-shrink-0 bg-neutral-900 text-white flex items-center justify-center text-xs font-bold" style={{ borderRadius: "50%" }}>
                                  {e.customerName.charAt(0).toUpperCase()}
                                </div>
                                <div>
                                  <div className="font-semibold text-neutral-800">{e.customerName}</div>
                                  <div className="text-[11px] text-neutral-400">{e.customerPhone}</div>
                                  <div className="text-[11px] text-neutral-400">{e.customerEmail}</div>
                                </div>
                              </div>
                            </td>
                            <td className="p-4">
                              {(e.vehicleMake || e.vehicleModel) ? (
                                <div>
                                  <div className="font-medium text-neutral-700 text-xs">
                                    {[e.vehicleYear, e.vehicleMake, e.vehicleModel].filter(Boolean).join(" ")}
                                  </div>
                                  {e.rego && <div className="text-[11px] text-neutral-400 mt-0.5">Reg: {e.rego}</div>}
                                </div>
                              ) : (
                                <span className="text-neutral-300">-</span>
                              )}
                            </td>
                            <td className="p-4 max-w-[200px]">
                              <div className="flex items-center gap-1.5">
                                {(e.imageUrls?.length ?? 0) > 0 && (
                                  <span className="text-amber-500 flex-shrink-0" title={`${e.imageUrls!.length} photo(s)`}>
                                    <i className="fas fa-images text-[10px]" />
                                  </span>
                                )}
                                <p className="text-xs text-neutral-600 truncate" title={e.description}>{e.description}</p>
                              </div>
                            </td>
                            <td className="p-4">
                              <span className="text-xs text-neutral-600">{e.branchName || "-"}</span>
                            </td>
                            <td className="p-4">
                              <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-bold ${sc.bg} ${sc.text}`}>
                                <i className={`fas ${sc.icon} text-[8px]`} />
                                {sc.label}
                              </span>
                            </td>
                            <td className="p-4">
                              <span className="text-xs text-neutral-500 whitespace-nowrap">{formatDate(e.createdAt)}</span>
                            </td>
                            <td className="p-4 text-right pr-6">
                              <div className="inline-flex items-center gap-1.5">
                                <button onClick={() => openPreview(e)} className="px-2.5 py-1 rounded-full text-[10px] font-semibold bg-neutral-300 text-neutral-800 hover:bg-neutral-400 transition" title="Preview">
                                  Preview
                                </button>
                                {e.status === "New" && (
                                  <button disabled={updatingId === e.id} onClick={() => updateStatus(e.id, "Reviewed")}
                                    className="px-2.5 py-1 rounded-full text-[10px] font-semibold bg-blue-500 text-white hover:bg-blue-600 transition">
                                    Reviewed
                                  </button>
                                )}
                                {(e.status === "New" || e.status === "Reviewed") && (
                                  <button disabled={updatingId === e.id} onClick={() => updateStatus(e.id, "Quoted")}
                                    className="px-2.5 py-1 rounded-full text-[10px] font-semibold bg-emerald-500 text-white hover:bg-emerald-600 transition">
                                    Quoted
                                  </button>
                                )}
                                {e.status !== "Closed" && (
                                  <button disabled={updatingId === e.id} onClick={() => updateStatus(e.id, "Closed")}
                                    className="px-2.5 py-1 rounded-full text-[10px] font-semibold bg-neutral-400 text-white hover:bg-neutral-500 transition">
                                    Close
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
          </div>
        </main>
      </div>

      {/* Preview Modal */}
      {previewEstimate && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setPreviewEstimate(null)} />
          <div className="relative bg-white rounded-2xl shadow-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto z-10 animate-[modalPop_0.3s_ease-out]">
            <div className="sticky top-0 bg-white border-b border-neutral-100 px-6 py-4 flex items-center justify-between rounded-t-2xl">
              <h3 className="font-bold text-neutral-900 text-lg">Estimate Details</h3>
              <button onClick={() => setPreviewEstimate(null)} className="w-8 h-8 rounded-lg bg-neutral-100 hover:bg-neutral-200 flex items-center justify-center transition">
                <i className="fas fa-times text-neutral-500 text-sm" />
              </button>
            </div>
            <div className="p-6 space-y-5">
              {/* Status */}
              <div className="flex items-center justify-between">
                <span className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold ${statusConfig[previewEstimate.status]?.bg} ${statusConfig[previewEstimate.status]?.text}`}>
                  <i className={`fas ${statusConfig[previewEstimate.status]?.icon}`} />
                  {statusConfig[previewEstimate.status]?.label}
                </span>
                <span className="text-xs text-neutral-400">{formatDate(previewEstimate.createdAt)}</span>
              </div>

              {/* Customer */}
              <div>
                <h4 className="text-[11px] font-bold text-neutral-400 uppercase tracking-wider mb-2">Customer</h4>
                <div className="flex items-center gap-3">
                  <div className="w-11 h-11 bg-neutral-900 text-white flex items-center justify-center text-sm font-bold" style={{ borderRadius: "50%" }}>
                    {previewEstimate.customerName.charAt(0).toUpperCase()}
                  </div>
                  <div>
                    <div className="font-semibold text-neutral-800">{previewEstimate.customerName}</div>
                    <div className="text-xs text-neutral-500 flex items-center gap-3 mt-0.5">
                      <span><i className="fas fa-phone text-[9px] mr-1" />{previewEstimate.customerPhone}</span>
                      <span><i className="fas fa-envelope text-[9px] mr-1" />{previewEstimate.customerEmail}</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Vehicle */}
              {(previewEstimate.vehicleMake || previewEstimate.vehicleModel || previewEstimate.rego) && (
                <div>
                  <h4 className="text-[11px] font-bold text-neutral-400 uppercase tracking-wider mb-2">Vehicle</h4>
                  <div className="bg-neutral-50 rounded-xl p-3.5 border border-neutral-100">
                    <div className="flex items-center gap-2">
                      <i className="fas fa-car text-neutral-400" />
                      <span className="font-medium text-neutral-800 text-sm">
                        {[previewEstimate.vehicleYear, previewEstimate.vehicleMake, previewEstimate.vehicleModel].filter(Boolean).join(" ") || "-"}
                      </span>
                    </div>
                    {previewEstimate.rego && (
                      <div className="mt-1.5 text-xs text-neutral-500">
                        <span className="font-semibold">Registration Number:</span> {previewEstimate.rego}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Customer Photos - shown prominently after Vehicle */}
              {((previewEstimate.imageUrls?.length ?? 0) > 0) && (
                <div>
                  <h4 className="text-[11px] font-bold text-neutral-400 uppercase tracking-wider mb-2">
                    Customer Photos ({previewEstimate.imageUrls!.length})
                  </h4>
                  <div className="flex flex-wrap gap-2">
                    {previewEstimate.imageUrls!.map((url, i) => (
                      <button key={i} onClick={() => setLightboxUrl(url)} className="group relative rounded-xl overflow-hidden border border-neutral-200 hover:border-neutral-300 transition-all hover:shadow-md">
                        <img src={url} alt={`Customer photo ${i + 1}`} className="w-24 h-24 object-cover" />
                        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-all flex items-center justify-center">
                          <i className="fas fa-expand text-white text-xs opacity-0 group-hover:opacity-100 transition-opacity" />
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Branch */}
              {previewEstimate.branchName && (
                <div>
                  <h4 className="text-[11px] font-bold text-neutral-400 uppercase tracking-wider mb-2">Branch</h4>
                  <div className="flex items-center gap-2 text-sm text-neutral-700">
                    <i className="fas fa-location-dot text-amber-500 text-xs" />
                    {previewEstimate.branchName}
                  </div>
                </div>
              )}

              {/* Description */}
              <div>
                <h4 className="text-[11px] font-bold text-neutral-400 uppercase tracking-wider mb-2">Description</h4>
                <div className="bg-neutral-50 rounded-xl p-4 border border-neutral-100">
                  <p className="text-sm text-neutral-700 leading-relaxed whitespace-pre-wrap">{previewEstimate.description}</p>
                </div>
              </div>

              {/* Actions */}
              <div className="flex items-center gap-2 pt-2">
                {previewEstimate.status === "New" && (
                  <button onClick={() => { updateStatus(previewEstimate.id, "Reviewed"); setPreviewEstimate({ ...previewEstimate, status: "Reviewed" }); }}
                    className="flex-1 py-2.5 rounded-xl text-xs font-bold bg-blue-500 text-white hover:bg-blue-600 transition text-center">
                    <i className="fas fa-eye mr-1.5" />Mark as Reviewed
                  </button>
                )}
                {(previewEstimate.status === "New" || previewEstimate.status === "Reviewed") && (
                  <button onClick={() => { updateStatus(previewEstimate.id, "Quoted"); setPreviewEstimate({ ...previewEstimate, status: "Quoted" }); }}
                    className="flex-1 py-2.5 rounded-xl text-xs font-bold bg-emerald-500 text-white hover:bg-emerald-600 transition text-center">
                    <i className="fas fa-check mr-1.5" />Mark as Quoted
                  </button>
                )}
                {previewEstimate.status !== "Closed" && (
                  <button onClick={() => { updateStatus(previewEstimate.id, "Closed"); setPreviewEstimate({ ...previewEstimate, status: "Closed" }); }}
                    className="flex-1 py-2.5 rounded-xl text-xs font-bold bg-neutral-400 text-white hover:bg-neutral-500 transition text-center">
                    <i className="fas fa-xmark mr-1.5" />Close
                  </button>
                )}
              </div>

              {/* Contact shortcuts */}
              <div className="flex items-center gap-2 pt-1">
                <a href={`tel:${previewEstimate.customerPhone}`} className="flex-1 py-2.5 rounded-xl text-xs font-bold bg-neutral-100 text-neutral-700 hover:bg-neutral-200 transition text-center">
                  <i className="fas fa-phone mr-1.5" />Call
                </a>
                <a href={`mailto:${previewEstimate.customerEmail}`} className="flex-1 py-2.5 rounded-xl text-xs font-bold bg-neutral-100 text-neutral-700 hover:bg-neutral-200 transition text-center">
                  <i className="fas fa-envelope mr-1.5" />Email
                </a>
              </div>

              {/* ── Replies Section ── */}
              <div className="border-t border-neutral-200 pt-5 mt-2">
                <h4 className="text-[11px] font-bold text-neutral-400 uppercase tracking-wider mb-3">
                  Replies {replies.length > 0 && `(${replies.length})`}
                </h4>

                {repliesLoading ? (
                  <div className="flex items-center justify-center py-6">
                    <svg className="animate-spin h-5 w-5 text-neutral-300" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                  </div>
                ) : replies.length > 0 ? (
                  <div className="space-y-3 mb-4">
                    {replies.map((r) => (
                      <div key={r.id} className="bg-neutral-50 rounded-xl p-3.5 border border-neutral-100">
                        <p className="text-sm text-neutral-700 leading-relaxed whitespace-pre-wrap">{r.message}</p>
                        {r.imageUrls.length > 0 && (
                          <div className="flex flex-wrap gap-2 mt-2.5">
                            {r.imageUrls.map((url, i) => (
                              <button key={i} onClick={() => setLightboxUrl(url)} className="group relative rounded-lg overflow-hidden border border-neutral-200 hover:border-neutral-300 transition-all hover:shadow-md">
                                <img src={url} alt="Attachment" className="w-20 h-20 object-cover" />
                                <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-all flex items-center justify-center">
                                  <i className="fas fa-expand text-white text-xs opacity-0 group-hover:opacity-100 transition-opacity" />
                                </div>
                              </button>
                            ))}
                          </div>
                        )}
                        <div className="mt-2 text-[10px] text-neutral-400">
                          {r.createdAt ? new Date(r.createdAt).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : ""}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-neutral-400 mb-4">No replies yet.</p>
                )}

                {/* Reply Form */}
                {previewEstimate.status !== "Closed" && (
                  <div className="bg-white rounded-xl border border-neutral-200 overflow-hidden">
                    <textarea
                      value={replyMessage}
                      onChange={(e) => setReplyMessage(e.target.value)}
                      placeholder="Write a reply to the customer..."
                      rows={3}
                      className="w-full px-4 py-3 text-sm text-neutral-800 placeholder-neutral-400 resize-none focus:outline-none border-0"
                    />

                    {replyImagePreviews.length > 0 && (
                      <div className="flex flex-wrap gap-2 px-4 pb-2">
                        {replyImagePreviews.map((url, i) => (
                          <div key={i} className="relative group">
                            <img src={url} alt="Preview" className="w-16 h-16 object-cover rounded-lg border border-neutral-200" />
                            <button
                              onClick={() => removeReplyImage(i)}
                              className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-rose-500 text-white flex items-center justify-center text-[8px] opacity-0 group-hover:opacity-100 transition-opacity shadow-md"
                            >
                              <i className="fas fa-times" />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}

                    <div className="flex items-center justify-between px-3 py-2 border-t border-neutral-100 bg-neutral-50/50">
                      <div className="flex items-center gap-1">
                        <input
                          ref={replyFileRef}
                          type="file"
                          accept="image/*"
                          multiple
                          onChange={handleReplyImageSelect}
                          className="hidden"
                        />
                        <button
                          onClick={() => replyFileRef.current?.click()}
                          className="h-8 w-8 rounded-lg text-neutral-400 hover:text-neutral-600 hover:bg-neutral-100 flex items-center justify-center transition"
                          title="Attach images"
                        >
                          <i className="fas fa-image text-sm" />
                        </button>
                        {replyImages.length > 0 && (
                          <span className="text-[10px] text-neutral-400">{replyImages.length}/5 images</span>
                        )}
                      </div>
                      <button
                        onClick={sendReply}
                        disabled={replySending || !replyMessage.trim()}
                        className="px-4 py-1.5 rounded-lg text-xs font-bold bg-neutral-900 text-white hover:bg-neutral-800 disabled:opacity-40 disabled:cursor-not-allowed transition-all flex items-center gap-1.5"
                      >
                        {replySending ? (
                          <>
                            <svg className="animate-spin h-3 w-3" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                            </svg>
                            Sending...
                          </>
                        ) : (
                          <>
                            <i className="fas fa-paper-plane text-[9px]" />
                            Send Reply
                          </>
                        )}
                      </button>
                    </div>

                    {replySuccess && (
                      <div className="px-4 py-2 bg-emerald-50 text-emerald-700 text-xs font-medium flex items-center gap-1.5">
                        <i className="fas fa-check-circle text-[10px]" />
                        Reply sent successfully! Customer has been notified via email.
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Image Lightbox */}
      {lightboxUrl && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[200] flex items-center justify-center p-4" onClick={() => setLightboxUrl(null)}>
          <div className="relative max-w-2xl w-full max-h-[85vh]" onClick={(e) => e.stopPropagation()}>
            <button onClick={() => setLightboxUrl(null)} className="absolute -top-3 -right-3 z-10 w-8 h-8 rounded-full bg-white shadow-lg flex items-center justify-center text-neutral-600 hover:text-neutral-900 transition">
              <i className="fas fa-times text-sm" />
            </button>
            <img src={lightboxUrl} alt="Full size" className="w-full max-h-[85vh] object-contain rounded-2xl shadow-2xl" />
          </div>
        </div>
      )}
    </div>
  );
}
