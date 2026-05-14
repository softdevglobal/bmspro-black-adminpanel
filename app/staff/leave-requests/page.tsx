"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Sidebar from "@/components/Sidebar";
import { useRouter } from "next/navigation";
import { auth, db } from "@/lib/firebase";
import { onAuthStateChanged } from "firebase/auth";
import {
  addDoc,
  collection,
  deleteField,
  doc,
  getDoc,
  onSnapshot,
  query,
  serverTimestamp,
  Timestamp,
  updateDoc,
  where,
} from "firebase/firestore";
import { fetchCurrentUser } from "@/lib/authClient";

type DayDetail = {
  date: string;
  fullDay: boolean;
  startTime?: string;
  endTime?: string;
};

type LeaveRow = {
  id: string;
  staffId: string;
  staffName: string;
  status: string;
  startDate: Date | null;
  endDate: Date | null;
  reason?: string;
  rejectionReason?: string;
  createdAt?: Date | null;
  updatedAt?: Date | null;
  attachmentUrl?: string;
  requesterRole?: string;
  dayDetails?: DayDetail[];
  /** Resolved profile image URL (Dicebear or stored photo URL). */
  staffAvatarUrl: string;
};

function toDate(v: unknown): Date | null {
  if (!v) return null;
  if (v instanceof Timestamp) return v.toDate();
  if (typeof (v as { toDate?: () => Date }).toDate === "function") {
    try {
      return (v as { toDate: () => Date }).toDate();
    } catch {
      return null;
    }
  }
  if (typeof v === "string") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function formatDay(d: Date | null): string {
  if (!d) return "—";
  return d.toLocaleDateString("en-AU", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function formatLeaveRangeLabel(start: Date | null, end: Date | null): string {
  if (!start) return "—";
  const s = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  if (!end) return formatDay(s);
  const e = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  if (s.getTime() === e.getTime()) return formatDay(s);
  return `${formatDay(s)} → ${formatDay(e)}`;
}

function parseDayDetails(raw: unknown): DayDetail[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: DayDetail[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const m = item as Record<string, unknown>;
    const dateStr = typeof m.date === "string" ? m.date : "";
    const fd = m.fullDay === true || m.fullDay === "true" || m.fullDay === 1;
    const startTime = typeof m.startTime === "string" ? m.startTime : undefined;
    const endTime = typeof m.endTime === "string" ? m.endTime : undefined;
    if (!dateStr) continue;
    out.push({ date: dateStr, fullDay: fd, startTime, endTime });
  }
  return out.length ? out : undefined;
}

function formatDayDetailLine(d: DayDetail): string {
  if (d.fullDay) return `${d.date} — Full day`;
  if (d.startTime && d.endTime) return `${d.date} — ${d.startTime} to ${d.endTime}`;
  if (d.startTime || d.endTime) return `${d.date} — ${d.startTime ?? "?"}–${d.endTime ?? "?"}`;
  return d.date;
}

function formatDateTimeAu(d: Date | null | undefined): string {
  if (!d) return "—";
  return d.toLocaleString("en-AU", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Max characters for reason in table / card summary; preview drawer shows full text. */
const REASON_SUMMARY_MAX_CHARS = 100;

function truncateReasonSummary(text: string | undefined, maxLen: number): { short: string; full: string } {
  const full = (text ?? "").trim();
  if (!full) return { short: "—", full: "" };
  if (full.length <= maxLen) return { short: full, full };
  return { short: full.slice(0, maxLen).trimEnd() + "…", full };
}

function staffAvatarUrlFromUserData(
  d: Record<string, unknown>,
  fallbackName: string,
  userIdFallback: string
): string {
  const urlKeys = ["photoURL", "photoUrl", "profileImageUrl", "profilePhotoUrl"] as const;
  for (const k of urlKeys) {
    const v = d[k];
    if (typeof v === "string") {
      const u = v.trim();
      if (/^https?:\/\//i.test(u)) return u;
    }
  }
  const av = typeof d.avatar === "string" ? d.avatar.trim() : "";
  if (av && /^https?:\/\//i.test(av)) return av;
  const seed = (av || fallbackName || userIdFallback || "staff").slice(0, 64);
  return `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(seed)}`;
}

export default function LeaveRequestsPage() {
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [role, setRole] = useState<string | null>(null);
  const [ownerUid, setOwnerUid] = useState<string | null>(null);
  const [rows, setRows] = useState<LeaveRow[]>([]);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [denyTarget, setDenyTarget] = useState<LeaveRow | null>(null);
  const [denyReasonDraft, setDenyReasonDraft] = useState("");
  const [leavePreviewRow, setLeavePreviewRow] = useState<LeaveRow | null>(null);
  const [leavePreviewOpen, setLeavePreviewOpen] = useState(false);

  const canView = useMemo(() => role === "workshop_owner", [role]);

  const resolveStaffProfile = useCallback(
    async (
      staffId: string
    ): Promise<{ name: string; staffAvatarUrl: string }> => {
      if (!staffId) {
        return {
          name: "Unknown",
          staffAvatarUrl: `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent("unknown")}`,
        };
      }
      try {
        const u = await getDoc(doc(db, "users", staffId));
        if (u.exists()) {
          const d = u.data() as Record<string, unknown>;
          const name =
            (typeof d.displayName === "string" && d.displayName) ||
            (typeof d.name === "string" && d.name) ||
            (typeof d.email === "string" && d.email) ||
            staffId.slice(0, 8);
          return {
            name,
            staffAvatarUrl: staffAvatarUrlFromUserData(d, name, staffId),
          };
        }
      } catch {
        /* ignore */
      }
      return {
        name: staffId.slice(0, 8) + "…",
        staffAvatarUrl: `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(staffId)}`,
      };
    },
    []
  );

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        router.replace("/login");
        return;
      }
      try {
        const me = await fetchCurrentUser();
        const r = (me?.role || "").toString().toLowerCase();
        setRole(r);
        if (r !== "workshop_owner") {
          router.replace("/dashboard");
          return;
        }
        setOwnerUid(user.uid);
        setLoading(false);
      } catch {
        setError("Could not load your account.");
      } finally {
        setLoading(false);
      }
    });
    return () => unsub();
  }, [router]);

  const openLeavePreview = (row: LeaveRow) => {
    setLeavePreviewRow(row);
    setLeavePreviewOpen(true);
  };

  const closeLeavePreview = () => {
    setLeavePreviewOpen(false);
  };

  useEffect(() => {
    if (!leavePreviewOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLeavePreviewOpen(false);
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [leavePreviewOpen]);

  useEffect(() => {
    if (!ownerUid || !canView) {
      return;
    }

    const q = query(
      collection(db, "leave_requests"),
      where("ownerUid", "==", ownerUid)
    );

    const unsub = onSnapshot(
      q,
      async (snap) => {
        const next: LeaveRow[] = [];
        for (const d of snap.docs) {
          const data = d.data() as Record<string, unknown>;
          const staffId = String(data.staffId ?? "");
          const profile = await resolveStaffProfile(staffId);
          const staffName = profile.name;
          const staffAvatarUrl = profile.staffAvatarUrl;
          const startDate = toDate(data.startDate);
          const endDate = toDate(data.endDate) ?? startDate;
          const createdAt = toDate(data.createdAt);
          const updatedAt = toDate(data.updatedAt);
          next.push({
            id: d.id,
            staffId,
            staffName,
            staffAvatarUrl,
            status: String(data.status ?? "pending").toLowerCase(),
            startDate,
            endDate,
            reason: typeof data.reason === "string" ? data.reason : undefined,
            rejectionReason:
              typeof data.rejectionReason === "string" ? data.rejectionReason : undefined,
            createdAt,
            updatedAt,
            attachmentUrl:
              typeof data.attachmentUrl === "string" && data.attachmentUrl.trim()
                ? String(data.attachmentUrl).trim()
                : undefined,
            requesterRole:
              typeof data.requesterRole === "string" ? data.requesterRole : undefined,
            dayDetails: parseDayDetails(data.dayDetails),
          });
        }
        next.sort((a, b) => {
          const ta = (a.createdAt ?? a.startDate)?.getTime() ?? 0;
          const tb = (b.createdAt ?? b.startDate)?.getTime() ?? 0;
          return tb - ta;
        });
        setRows(next);
        setError(null);
      },
      (err) => {
        console.error("[leave-requests] subscription error:", err);
        setError("Could not load leave requests. Check Firestore rules and indexes.");
      }
    );

    return () => unsub();
  }, [ownerUid, canView, resolveStaffProfile]);

  const notifyStaffLeaveDecision = async (
    row: LeaveRow,
    decision: "approved" | "denied",
    rejectionReason?: string
  ) => {
    const staffUid = row.staffId?.trim();
    if (!staffUid) return;

    const type =
      decision === "approved" ? "leave_request_approved" : "leave_request_denied";
    const title = decision === "approved" ? "Leave approved" : "Leave declined";
    const rangeLabel = formatLeaveRangeLabel(row.startDate, row.endDate);
    const trimmedReject =
      typeof rejectionReason === "string" ? rejectionReason.trim() : "";
    const message =
      decision === "approved"
        ? `Your time off request (${rangeLabel}) was approved.`
        : `Your time off request (${rangeLabel}) was declined.${
            trimmedReject ? ` Reason: ${trimmedReject}` : ""
          }`;

    const notifRef = await addDoc(collection(db, "notifications"), {
      userId: staffUid,
      staffUid,
      type,
      leaveRequestId: row.id,
      status: decision === "approved" ? "Approved" : "Denied",
      title,
      message,
      ...(decision === "denied" && trimmedReject
        ? { rejectionReason: trimmedReject }
        : {}),
      read: false,
      createdAt: serverTimestamp(),
    });

    try {
      const token = await auth.currentUser?.getIdToken();
      if (!token) return;
      await fetch("/api/notifications/send-push", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          staffUid,
          title,
          message,
          data: {
            type,
            leaveRequestId: row.id,
            notificationId: notifRef.id,
            ...(decision === "denied" && trimmedReject
              ? { rejectionReason: trimmedReject }
              : {}),
          },
        }),
      });
    } catch (pushErr) {
      console.warn("[leave-requests] push notify:", pushErr);
    }
  };

  const setStatus = async (
    row: LeaveRow,
    status: "approved" | "denied",
    rejectionReason?: string
  ): Promise<boolean> => {
    if (!ownerUid) return false;
    if (status === "denied") {
      const t = (rejectionReason ?? "").trim();
      if (!t) {
        setError("A reason is required when declining leave.");
        return false;
      }
    }
    setUpdatingId(row.id);
    try {
      if (status === "approved") {
        await updateDoc(doc(db, "leave_requests", row.id), {
          status,
          updatedAt: Timestamp.now(),
          reviewedAt: Timestamp.now(),
          reviewedBy: auth.currentUser?.uid ?? null,
          rejectionReason: deleteField(),
        });
        await notifyStaffLeaveDecision(row, "approved");
      } else {
        const reason = (rejectionReason ?? "").trim();
        await updateDoc(doc(db, "leave_requests", row.id), {
          status,
          updatedAt: Timestamp.now(),
          reviewedAt: Timestamp.now(),
          reviewedBy: auth.currentUser?.uid ?? null,
          rejectionReason: reason,
        });
        await notifyStaffLeaveDecision({ ...row, status: "denied", rejectionReason: reason }, "denied", reason);
      }
      setError(null);
      return true;
    } catch (e) {
      console.error(e);
      setError("Update failed. You may not have permission to approve leave.");
      return false;
    } finally {
      setUpdatingId(null);
    }
  };

  const pendingCount = rows.filter((r) => r.status === "pending").length;

  return (
    <div className="flex h-screen overflow-hidden bg-neutral-50 font-inter text-neutral-800">
      <Sidebar />

      <div className="flex-1 flex flex-col overflow-hidden">
        <main className="flex-1 overflow-auto">
          <div className="md:hidden p-4 bg-white border-b border-neutral-200 flex items-center justify-between shrink-0">
            <h2 className="font-bold text-lg text-neutral-800">Leave requests</h2>
            <button
              type="button"
              className="inline-flex items-center gap-2 rounded-lg border border-neutral-200 px-3 py-2 text-neutral-700 shadow-sm hover:bg-neutral-50"
              onClick={() => setMobileOpen(true)}
            >
              <i className="fas fa-bars" />
            </button>
          </div>

          {mobileOpen && (
            <div className="fixed inset-0 z-50 md:hidden">
              <div
                className="absolute inset-0 bg-black/40"
                onClick={() => setMobileOpen(false)}
              />
              <div className="absolute left-0 top-0 bottom-0">
                <Sidebar mobile onClose={() => setMobileOpen(false)} />
              </div>
            </div>
          )}

          <div className="p-4 sm:p-6 lg:p-8">
            <div className="mb-6">
              <div className="relative rounded-2xl bg-neutral-900 text-white p-6 shadow-sm overflow-hidden">
                <div className="absolute top-0 right-0 w-32 h-32 bg-white/5 rounded-full -translate-y-1/2 translate-x-1/2" />
                <div className="absolute bottom-0 left-1/3 w-20 h-20 bg-white/5 rounded-full translate-y-1/2" />
                <div className="absolute top-3 right-20 text-white/10 text-3xl">
                  <i className="fas fa-calendar-day" />
                </div>
                <div className="absolute bottom-2 right-40 text-white/10 text-xl">
                  <i className="fas fa-umbrella-beach" />
                </div>
                <div className="relative flex items-center gap-3">
                  <div className="w-11 h-11 rounded-xl bg-amber-500/20 flex items-center justify-center border border-amber-500/30">
                    <i className="fas fa-umbrella-beach text-amber-400" />
                  </div>
                  <div>
                    <h1 className="text-2xl font-bold">Leave requests</h1>
                    <p className="text-sm text-neutral-400 mt-1">
                      Review staff leave — approved leave blocks clock-in for those dates
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {loading && (
              <div className="flex items-center justify-center py-20">
                <div className="flex flex-col items-center gap-4">
                  <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-neutral-900" />
                  <span className="text-neutral-600 text-sm">Loading leave requests…</span>
                </div>
              </div>
            )}

            {!loading && (
              <div className="max-w-7xl mx-auto space-y-6">
                {!ownerUid && canView ? (
                  <p className="text-sm text-neutral-600">Missing workshop scope.</p>
                ) : (
                  <>
                    {ownerUid && (
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                        <div className="bg-white rounded-xl border border-neutral-200 p-4 shadow-sm">
                          <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center">
                              <i className="fas fa-inbox text-amber-700" />
                            </div>
                            <div>
                              <div className="text-2xl font-bold text-neutral-800">{rows.length}</div>
                              <div className="text-xs text-neutral-500">Total requests</div>
                            </div>
                          </div>
                        </div>
                        <div className="bg-white rounded-xl border border-neutral-200 p-4 shadow-sm">
                          <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-full bg-orange-100 flex items-center justify-center">
                              <i className="fas fa-hourglass-half text-orange-600" />
                            </div>
                            <div>
                              <div className="text-2xl font-bold text-neutral-800">{pendingCount}</div>
                              <div className="text-xs text-neutral-500">Pending approval</div>
                            </div>
                          </div>
                        </div>
                        <div className="bg-white rounded-xl border border-neutral-200 p-4 shadow-sm">
                          <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-full bg-emerald-100 flex items-center justify-center">
                              <i className="fas fa-check-circle text-emerald-600" />
                            </div>
                            <div>
                              <div className="text-2xl font-bold text-neutral-800">
                                {rows.filter((r) => r.status === "approved").length}
                              </div>
                              <div className="text-xs text-neutral-500">Approved</div>
                            </div>
                          </div>
                        </div>
                      </div>
                    )}

                    {error && (
                      <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
                        <i className="fas fa-triangle-exclamation mr-2" />
                        {error}
                      </div>
                    )}

                    {!ownerUid ? null : rows.length === 0 ? (
                      <div className="bg-white rounded-xl border border-neutral-200 shadow-sm overflow-hidden">
                        <div className="flex flex-col items-center justify-center text-center px-6 py-16 sm:py-20 max-w-md mx-auto">
                          <div
                            className="mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-neutral-100 to-neutral-50 border border-neutral-200/80 shadow-inner"
                            aria-hidden
                          >
                            <i className="fas fa-umbrella-beach text-2xl text-neutral-600" />
                          </div>
                          <h2 className="text-lg font-semibold text-neutral-900 tracking-tight">
                            No leave requests yet
                          </h2>
                          <p className="mt-3 text-sm leading-relaxed text-neutral-600">
                            When a team member submits leave from the mobile app, it will show up here
                            for you to approve or deny.
                          </p>
                        </div>
                      </div>
                    ) : (
                      <>
                        {/* Mobile: stacked cards */}
                        <div className="md:hidden space-y-3">
                          {rows.map((r) => {
                            const reasonSum = truncateReasonSummary(
                              r.reason,
                              REASON_SUMMARY_MAX_CHARS
                            );
                            const declineSum =
                              r.status === "denied" && r.rejectionReason
                                ? truncateReasonSummary(
                                    r.rejectionReason,
                                    REASON_SUMMARY_MAX_CHARS
                                  )
                                : null;
                            return (
                            <div
                              key={`m-${r.id}`}
                              className="rounded-xl border border-neutral-200 bg-white p-4 shadow-sm"
                            >
                              <div className="flex items-start gap-3">
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img
                                  src={r.staffAvatarUrl}
                                  alt=""
                                  className="h-11 w-11 shrink-0 rounded-full border border-neutral-200 bg-neutral-100 object-cover"
                                />
                                <div className="min-w-0 flex-1">
                                  <div className="font-semibold text-base text-neutral-900">
                                    {r.staffName}
                                  </div>
                                  <div className="mt-1 flex items-center gap-1.5 text-sm text-neutral-600">
                                    <i className="fas fa-calendar-day text-emerald-600 text-xs shrink-0" />
                                    <span className="break-words">
                                      {formatDay(r.startDate)}
                                      {r.endDate &&
                                      r.startDate &&
                                      r.endDate.getTime() !== r.startDate.getTime() ? (
                                        <span> → {formatDay(r.endDate)}</span>
                                      ) : null}
                                    </span>
                                  </div>
                                </div>
                                <span
                                  className={`shrink-0 inline-flex px-2.5 py-1 rounded-full text-xs font-semibold ${
                                    r.status === "approved"
                                      ? "bg-emerald-100 text-emerald-800"
                                      : r.status === "denied"
                                        ? "bg-rose-100 text-rose-800"
                                        : "bg-amber-100 text-amber-900"
                                  }`}
                                >
                                  {r.status}
                                </span>
                              </div>

                              <div className="mt-3 border-t border-neutral-100 pt-3">
                                <div className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
                                  Reason
                                </div>
                                <p
                                  className="mt-1 text-sm text-neutral-800 leading-relaxed"
                                  title={reasonSum.full ? reasonSum.full : undefined}
                                >
                                  {reasonSum.short}
                                </p>
                                {declineSum ? (
                                  <p
                                    className="mt-2 text-xs text-rose-800 leading-snug"
                                    title={declineSum.full}
                                  >
                                    Declined: {declineSum.short}
                                  </p>
                                ) : null}
                              </div>

                              <div
                                className={`mt-4 flex gap-2 items-stretch ${
                                  r.status !== "pending" ? "justify-end" : ""
                                }`}
                              >
                                {r.status === "pending" ? (
                                  <>
                                    <button
                                      type="button"
                                      disabled={updatingId === r.id}
                                      onClick={() => setStatus(r, "approved")}
                                      className="min-w-0 flex-1 rounded-lg bg-emerald-600 px-2 py-2.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50 sm:px-3"
                                    >
                                      {updatingId === r.id ? "…" : "Approve"}
                                    </button>
                                    <button
                                      type="button"
                                      disabled={updatingId === r.id}
                                      onClick={() => {
                                        setDenyReasonDraft("");
                                        setDenyTarget(r);
                                      }}
                                      className="min-w-0 flex-1 rounded-lg border border-neutral-300 bg-white px-2 py-2.5 text-xs font-semibold text-neutral-800 hover:bg-neutral-50 disabled:opacity-50 sm:px-3"
                                    >
                                      Decline
                                    </button>
                                  </>
                                ) : null}
                                <button
                                  type="button"
                                  title="View full details"
                                  aria-label="Preview details"
                                  onClick={() => openLeavePreview(r)}
                                  className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-neutral-200 bg-white text-neutral-600 shadow-sm hover:bg-neutral-50 hover:border-neutral-300"
                                >
                                  <i className="fas fa-eye text-emerald-600" />
                                </button>
                              </div>
                            </div>
                            );
                          })}
                        </div>

                        {/* Desktop: table */}
                        <div className="hidden md:block bg-white rounded-xl border border-neutral-200 overflow-hidden shadow-sm">
                        <div className="overflow-x-auto">
                          <table className="w-full text-left text-sm">
                            <thead className="bg-neutral-50 border-b border-neutral-200 text-xs uppercase tracking-wide text-neutral-500">
                              <tr>
                                <th className="px-4 py-3 font-semibold">Staff</th>
                                <th className="px-4 py-3 font-semibold">Dates</th>
                                <th className="px-4 py-3 font-semibold">Status</th>
                                <th className="px-4 py-3 font-semibold">Reason</th>
                                <th className="px-4 py-3 font-semibold text-right">Actions</th>
                                <th className="px-4 py-3 font-semibold text-right">Preview</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-neutral-100">
                              {rows.map((r) => {
                                const reasonSum = truncateReasonSummary(
                                  r.reason,
                                  REASON_SUMMARY_MAX_CHARS
                                );
                                const declineSum =
                                  r.status === "denied" && r.rejectionReason
                                    ? truncateReasonSummary(
                                        r.rejectionReason,
                                        REASON_SUMMARY_MAX_CHARS
                                      )
                                    : null;
                                return (
                                <tr key={r.id} className="hover:bg-neutral-50/80">
                                  <td className="px-4 py-3">
                                    <div className="flex items-center gap-2.5 min-w-0 max-w-[220px]">
                                      {/* eslint-disable-next-line @next/next/no-img-element */}
                                      <img
                                        src={r.staffAvatarUrl}
                                        alt=""
                                        className="h-9 w-9 shrink-0 rounded-full border border-neutral-200 bg-neutral-100 object-cover"
                                      />
                                      <span className="font-medium text-neutral-900 truncate">
                                        {r.staffName}
                                      </span>
                                    </div>
                                  </td>
                                  <td className="px-4 py-3 text-neutral-700 whitespace-nowrap">
                                    {formatDay(r.startDate)}
                                    {r.endDate &&
                                    r.startDate &&
                                    r.endDate.getTime() !== r.startDate.getTime() ? (
                                      <span> → {formatDay(r.endDate)}</span>
                                    ) : null}
                                  </td>
                                  <td className="px-4 py-3">
                                    <span
                                      className={`inline-flex px-2 py-0.5 rounded-full text-xs font-semibold ${
                                        r.status === "approved"
                                          ? "bg-emerald-100 text-emerald-800"
                                          : r.status === "denied"
                                            ? "bg-rose-100 text-rose-800"
                                            : "bg-amber-100 text-amber-900"
                                      }`}
                                    >
                                      {r.status}
                                    </span>
                                  </td>
                                  <td className="px-4 py-3 text-neutral-600 max-w-[min(280px,32vw)]">
                                    <div
                                      className="line-clamp-2 text-sm"
                                      title={reasonSum.full || undefined}
                                    >
                                      {reasonSum.short}
                                    </div>
                                    {declineSum ? (
                                      <div
                                        className="mt-1 text-xs text-rose-800 line-clamp-2 leading-snug"
                                        title={declineSum.full}
                                      >
                                        Declined: {declineSum.short}
                                      </div>
                                    ) : null}
                                  </td>
                                  <td className="px-4 py-3 text-right whitespace-nowrap">
                                    {r.status === "pending" ? (
                                      <div className="inline-flex gap-2 justify-end">
                                        <button
                                          type="button"
                                          disabled={updatingId === r.id}
                                          onClick={() => setStatus(r, "approved")}
                                          className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
                                        >
                                          {updatingId === r.id ? "…" : "Approve"}
                                        </button>
                                        <button
                                          type="button"
                                          disabled={updatingId === r.id}
                                          onClick={() => {
                                            setDenyReasonDraft("");
                                            setDenyTarget(r);
                                          }}
                                          className="px-3 py-1.5 rounded-lg text-xs font-semibold border border-neutral-300 text-neutral-800 hover:bg-neutral-100 disabled:opacity-50"
                                        >
                                          Decline
                                        </button>
                                      </div>
                                    ) : (
                                      <span className="text-xs text-neutral-400">—</span>
                                    )}
                                  </td>
                                  <td className="px-4 py-3 text-right whitespace-nowrap">
                                    <button
                                      type="button"
                                      title="View details"
                                      aria-label="Preview"
                                      onClick={() => openLeavePreview(r)}
                                      className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-neutral-200 bg-white text-neutral-500 shadow-sm hover:bg-neutral-50 hover:border-neutral-300 ml-auto"
                                    >
                                      <i className="fas fa-eye text-sm text-emerald-600" />
                                    </button>
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
                  </>
                )}
              </div>
            )}
          </div>
        </main>
      </div>

      {/* Right-side leave detail drawer */}
      <div
        className={`fixed inset-0 z-50 ${leavePreviewOpen ? "pointer-events-auto" : "pointer-events-none"}`}
        aria-hidden={!leavePreviewOpen}
      >
        <div
          onClick={closeLeavePreview}
          className={`absolute inset-0 bg-black/50 transition-opacity duration-200 ${leavePreviewOpen ? "opacity-100" : "opacity-0"}`}
        />
        <aside
          className={`absolute top-0 h-full right-0 w-[92vw] sm:max-w-lg sm:w-[32rem] bg-white shadow-2xl border-l border-neutral-200 transform transition-transform duration-200 ease-out ${leavePreviewOpen ? "translate-x-0" : "translate-x-full"}`}
        >
          <div className="flex h-full min-h-0 flex-col">
            <div className="p-0 border-b border-neutral-200 shrink-0">
              <div className="relative bg-neutral-900 p-5 text-white flex items-center justify-between overflow-hidden">
                <div className="absolute top-0 right-0 w-24 h-24 bg-white/5 rounded-full -translate-y-1/2 translate-x-1/2" />
                <div className="absolute top-2 right-16 text-white/10 text-xl">
                  <i className="fas fa-gear" />
                </div>
                <div className="relative flex items-center gap-3 min-w-0">
                  {leavePreviewRow ? (
                    <>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={leavePreviewRow.staffAvatarUrl}
                        alt=""
                        className="h-10 w-10 shrink-0 rounded-xl object-cover border border-white/30 ring-1 ring-white/10"
                      />
                      <div className="min-w-0">
                        <h3 className="text-lg font-semibold leading-tight truncate">Leave request</h3>
                        <p className="text-sm text-white/75 mt-0.5 truncate">{leavePreviewRow.staffName}</p>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="w-10 h-10 rounded-xl bg-amber-500/20 flex items-center justify-center border border-amber-500/30 shrink-0">
                        <i className="fas fa-eye text-amber-400" />
                      </div>
                      <div className="min-w-0">
                        <h3 className="text-lg font-semibold leading-tight truncate">Leave request</h3>
                      </div>
                    </>
                  )}
                </div>
                <button
                  type="button"
                  onClick={closeLeavePreview}
                  className="relative text-white/80 hover:text-white p-2 -mr-2 shrink-0"
                  aria-label="Close"
                >
                  <i className="fas fa-times text-lg" />
                </button>
              </div>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-5">
              {!leavePreviewRow && (
                <div className="text-neutral-500 text-sm">No request selected.</div>
              )}
              {leavePreviewRow && (
                <div className="space-y-5 text-sm">
                  <dl className="space-y-3">
                    <div className="rounded-xl border border-neutral-200 bg-neutral-50/80 p-4">
                      <div className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                        Staff
                      </div>
                      <div className="mt-2 flex items-start gap-3">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={leavePreviewRow.staffAvatarUrl}
                          alt=""
                          className="h-14 w-14 shrink-0 rounded-full border border-neutral-200 bg-neutral-100 object-cover"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="font-semibold text-neutral-900 text-base leading-snug">
                            {leavePreviewRow.staffName}
                          </div>
                        </div>
                      </div>
                    </div>

                    {leavePreviewRow.requesterRole ? (
                      <div className="flex items-center justify-between gap-2 rounded-lg border border-neutral-200 bg-white px-3 py-2">
                        <span className="text-xs font-medium text-neutral-500">Submitted as</span>
                        <span className="text-xs font-semibold text-neutral-800 capitalize">
                          {leavePreviewRow.requesterRole.replace(/_/g, " ")}
                        </span>
                      </div>
                    ) : null}

                    <div className="rounded-xl border border-neutral-200 bg-white p-4">
                      <dt className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                        Date range
                      </dt>
                      <dd className="mt-1.5 text-neutral-900 font-medium">
                        {formatLeaveRangeLabel(leavePreviewRow.startDate, leavePreviewRow.endDate)}
                      </dd>
                    </div>

                    <div className="flex items-center justify-between gap-2 rounded-lg border border-neutral-200 bg-white px-3 py-2">
                      <span className="text-xs font-medium text-neutral-500">Status</span>
                      <span
                        className={`inline-flex px-2.5 py-1 rounded-full text-xs font-semibold ${
                          leavePreviewRow.status === "approved"
                            ? "bg-emerald-100 text-emerald-800"
                            : leavePreviewRow.status === "denied"
                              ? "bg-rose-100 text-rose-800"
                              : "bg-amber-100 text-amber-900"
                        }`}
                      >
                        {leavePreviewRow.status}
                      </span>
                    </div>

                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      <div className="rounded-lg border border-neutral-200 bg-white px-3 py-2">
                        <div className="text-[11px] font-semibold uppercase text-neutral-400">Submitted</div>
                        <div className="mt-0.5 text-neutral-800">
                          {formatDateTimeAu(leavePreviewRow.createdAt)}
                        </div>
                      </div>
                      <div className="rounded-lg border border-neutral-200 bg-white px-3 py-2">
                        <div className="text-[11px] font-semibold uppercase text-neutral-400">Last updated</div>
                        <div className="mt-0.5 text-neutral-800">
                          {formatDateTimeAu(leavePreviewRow.updatedAt ?? leavePreviewRow.createdAt)}
                        </div>
                      </div>
                    </div>
                  </dl>

                  {leavePreviewRow.dayDetails && leavePreviewRow.dayDetails.length > 0 ? (
                    <div className="rounded-xl border border-neutral-200 bg-white p-4">
                      <div className="text-xs font-semibold uppercase tracking-wide text-neutral-500 mb-2">
                        Day breakdown
                      </div>
                      <ul className="space-y-2">
                        {leavePreviewRow.dayDetails.map((d) => (
                          <li
                            key={d.date}
                            className="flex items-start gap-2 text-neutral-800 border-b border-neutral-100 pb-2 last:border-0 last:pb-0"
                          >
                            <i className="fas fa-sun mt-0.5 text-amber-500 text-xs shrink-0" />
                            <span className="leading-snug">{formatDayDetailLine(d)}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-4">
                    <div className="text-xs font-semibold uppercase tracking-wide text-neutral-500 mb-1.5">
                      Reason
                    </div>
                    <p className="text-neutral-900 leading-relaxed whitespace-pre-wrap">
                      {leavePreviewRow.reason?.trim() ? leavePreviewRow.reason : "—"}
                    </p>
                  </div>

                  {leavePreviewRow.status === "denied" && leavePreviewRow.rejectionReason ? (
                    <div className="rounded-xl border border-rose-200 bg-rose-50 p-4">
                      <div className="text-xs font-semibold uppercase tracking-wide text-rose-700 mb-1.5">
                        Decline reason
                      </div>
                      <p className="text-rose-900 leading-relaxed whitespace-pre-wrap">
                        {leavePreviewRow.rejectionReason}
                      </p>
                    </div>
                  ) : null}

                  <div className="rounded-xl border border-neutral-200 bg-white overflow-hidden">
                    <div className="border-b border-neutral-100 bg-neutral-50 px-4 py-2.5">
                      <span className="text-xs font-semibold uppercase tracking-wide text-neutral-600">
                        Attachment
                      </span>
                    </div>
                    <div className="p-4">
                      {leavePreviewRow.attachmentUrl ? (
                        <div className="space-y-3">
                          <div className="w-full rounded-lg bg-neutral-100 overflow-hidden border border-neutral-200">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={leavePreviewRow.attachmentUrl}
                              alt="Leave attachment"
                              className="max-w-full w-full h-auto max-h-[min(50vh,360px)] object-contain"
                              referrerPolicy="no-referrer"
                            />
                          </div>
                          <a
                            href={leavePreviewRow.attachmentUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-neutral-200 bg-white px-4 py-2.5 text-sm font-medium text-neutral-800 hover:bg-neutral-50"
                          >
                            <i className="fas fa-external-link-alt text-emerald-600" />
                            Open original in new tab
                          </a>
                        </div>
                      ) : (
                        <p className="text-sm text-neutral-500 text-center py-6">No photo attached.</p>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
            {leavePreviewRow && leavePreviewRow.status === "pending" ? (
              <div className="shrink-0 border-t border-neutral-200 bg-neutral-50 px-4 py-4">
                <div className="flex flex-col gap-2 sm:flex-row sm:justify-end sm:items-stretch">
                  <button
                    type="button"
                    disabled={updatingId === leavePreviewRow.id}
                    onClick={() => {
                      setDenyReasonDraft("");
                      setDenyTarget(leavePreviewRow);
                    }}
                    className="w-full sm:w-auto order-2 sm:order-1 px-4 py-2.5 rounded-lg text-sm font-semibold border border-neutral-300 bg-white text-neutral-800 hover:bg-neutral-100 disabled:opacity-50 sm:min-w-[112px]"
                  >
                    Decline
                  </button>
                  <button
                    type="button"
                    disabled={updatingId === leavePreviewRow.id}
                    onClick={async () => {
                      const ok = await setStatus(leavePreviewRow, "approved");
                      if (ok) closeLeavePreview();
                    }}
                    className="w-full sm:w-auto order-1 sm:order-2 px-4 py-2.5 rounded-lg text-sm font-semibold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 sm:min-w-[112px]"
                  >
                    {updatingId === leavePreviewRow.id ? "…" : "Approve"}
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </aside>
      </div>

      {denyTarget && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <button
            type="button"
            className="absolute inset-0 bg-black/40"
            aria-label="Close"
            disabled={updatingId !== null}
            onClick={() => {
              if (updatingId) return;
              setDenyTarget(null);
              setDenyReasonDraft("");
            }}
          />
          <div className="relative z-10 w-full max-w-md rounded-2xl border border-neutral-200 bg-white p-6 shadow-xl">
            <h2 className="text-lg font-semibold text-neutral-900">Decline leave request</h2>
            <p className="mt-2 text-sm text-neutral-600">
              Staff will receive an in-app and push notification with this reason.
            </p>
            <textarea
              value={denyReasonDraft}
              onChange={(e) => setDenyReasonDraft(e.target.value)}
              rows={4}
              placeholder="e.g. Short-staffed that week, policy, …"
              className="mt-4 w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-400 focus:outline-none focus:ring-2 focus:ring-neutral-900/10"
            />
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                disabled={updatingId !== null}
                onClick={() => {
                  setDenyTarget(null);
                  setDenyReasonDraft("");
                }}
                className="px-4 py-2 rounded-lg text-sm font-medium border border-neutral-200 text-neutral-800 hover:bg-neutral-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={updatingId !== null || !denyReasonDraft.trim()}
                onClick={async () => {
                  if (!denyTarget) return;
                  const ok = await setStatus(denyTarget, "denied", denyReasonDraft);
                  if (ok) {
                    setDenyTarget(null);
                    setDenyReasonDraft("");
                    closeLeavePreview();
                  }
                }}
                className="px-4 py-2 rounded-lg text-sm font-semibold bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-50"
              >
                {updatingId === denyTarget.id ? "…" : "Decline & notify"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
