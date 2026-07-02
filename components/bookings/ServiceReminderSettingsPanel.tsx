"use client";

import { auth, db } from "@/lib/firebase";
import {
  DEFAULT_SERVICE_REMINDER_INTERVAL_DAYS,
  SERVICE_REMINDER_ADVANCE_NOTICE_DAYS,
  parseServiceReminderIntervalDays,
  type ServiceReminderSettings,
} from "@/lib/serviceReminders/types";
import { onAuthStateChanged } from "firebase/auth";
import { collection, getDocs, query, where } from "firebase/firestore";
import { useCallback, useEffect, useState } from "react";
import ServiceReminderIntervalPicker from "./ServiceReminderIntervalPicker";

const INPUT_CLASS =
  "w-full rounded-lg border border-neutral-300 bg-white px-3.5 py-2.5 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-900 focus:outline-none focus:ring-2 focus:ring-neutral-900/10";

type BranchOption = { id: string; name: string };

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

export default function ServiceReminderSettingsPanel() {
  const [initLoading, setInitLoading] = useState(true);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [savedSummary, setSavedSummary] = useState<string | null>(null);
  const [intervalDays, setIntervalDays] = useState(DEFAULT_SERVICE_REMINDER_INTERVAL_DAYS);
  const [customMessage, setCustomMessage] = useState(
    "Hi {name}, friendly reminder that your vehicle service is due soon. Book a time that suits you.",
  );
  const [branches, setBranches] = useState<BranchOption[]>([]);
  const [selectedBranchId, setSelectedBranchId] = useState("");
  const [isBranchAdmin, setIsBranchAdmin] = useState(false);

  const loadSettingsForBranch = useCallback(async (branchId: string) => {
    if (!branchId) return;
    setSettingsLoading(true);
    setError(null);
    const result = await authFetch<{ settings: ServiceReminderSettings; branchId: string }>(
      `/api/service-reminders/settings?branchId=${encodeURIComponent(branchId)}`,
    );
    if (!result.ok) {
      setError(result.error);
      setSettingsLoading(false);
      return;
    }
    const s = result.data.settings;
    setIntervalDays(s.intervalDays || DEFAULT_SERVICE_REMINDER_INTERVAL_DAYS);
    setCustomMessage(
      s.customMessage ||
        "Hi {name}, friendly reminder that your vehicle service is due soon. Book a time that suits you.",
    );
    setSettingsLoading(false);
  }, []);

  useEffect(() => {
    let cancelled = false;

    const init = async (userId: string) => {
      setInitLoading(true);
      setError(null);

      try {
        const { getDoc, doc: firestoreDoc } = await import("firebase/firestore");
        const userSnap = await getDoc(firestoreDoc(db, "users", userId));
        const userData = userSnap.data();
        const role = String(userData?.role || userData?.systemRole || "").toLowerCase();
        const ownerUid =
          role === "workshop_owner" ? userId : String(userData?.ownerUid || userId);
        const userBranchId = String(userData?.branchId || "").trim();
        const branchAdmin = role === "branch_admin";

        if (cancelled) return;
        setIsBranchAdmin(branchAdmin);

        if (branchAdmin && userBranchId) {
          setBranches([{ id: userBranchId, name: String(userData?.branchName || "Your branch") }]);
          setSelectedBranchId(userBranchId);
          setInitLoading(false);
          return;
        }

        if (role !== "workshop_owner") {
          setError("Only workshop owners and branch admins can manage service reminder settings.");
          setInitLoading(false);
          return;
        }

        const branchSnap = await getDocs(
          query(collection(db, "branches"), where("ownerUid", "==", ownerUid)),
        );
        const branchList: BranchOption[] = branchSnap.docs.map((d) => ({
          id: d.id,
          name: String(d.data().name || "Branch"),
        }));
        branchList.sort((a, b) => a.name.localeCompare(b.name));

        if (cancelled) return;

        if (branchList.length === 0) {
          setError("No branches found. Create a branch first.");
          setInitLoading(false);
          return;
        }

        setBranches(branchList);
        setSelectedBranchId(branchList[0].id);
        setInitLoading(false);
      } catch (e: unknown) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load branches");
          setInitLoading(false);
        }
      }
    };

    const user = auth.currentUser;
    if (user?.uid) {
      void init(user.uid);
    } else {
      const unsub = onAuthStateChanged(auth, (u) => {
        if (u?.uid) void init(u.uid);
        else {
          setError("Please sign in again.");
          setInitLoading(false);
        }
      });
      return () => {
        cancelled = true;
        unsub();
      };
    }

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!selectedBranchId || initLoading) return;
    void loadSettingsForBranch(selectedBranchId);
  }, [selectedBranchId, initLoading, loadSettingsForBranch]);

  const handleSave = async () => {
    if (!selectedBranchId) {
      setError("Select a branch first.");
      return;
    }
    setSaving(true);
    setError(null);
    setSaved(false);
    setSavedSummary(null);
    const parsed = parseServiceReminderIntervalDays(intervalDays);
    if (!parsed.ok) {
      setError(parsed.error);
      setSaving(false);
      return;
    }
    const result = await authFetch<{
      settings: ServiceReminderSettings;
      branchId: string;
      bulk?: { scheduled: number; skipped: number; errors: number };
    }>(
      "/api/service-reminders/settings",
      {
        method: "PATCH",
        body: JSON.stringify({
          branchId: selectedBranchId,
          intervalDays: parsed.days,
          customMessage: customMessage.trim() || undefined,
        }),
      },
    );
    setSaving(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setIntervalDays(result.data.settings.intervalDays);
    const bulk = result.data.bulk;
    if (bulk) {
      setSavedSummary(
        `Applied to ${bulk.scheduled} completed booking${bulk.scheduled === 1 ? "" : "s"}` +
          (bulk.skipped ? ` (${bulk.skipped} already sent, skipped)` : "") +
          ".",
      );
    } else {
      setSavedSummary("Settings saved for this branch.");
    }
    setSaved(true);
    setTimeout(() => {
      setSaved(false);
      setSavedSummary(null);
    }, 5000);
  };

  if (initLoading) {
    return (
      <div className="mb-6 rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm">
        <div className="text-sm text-neutral-500 flex items-center gap-2">
          <i className="fas fa-spinner fa-spin" />
          Loading service reminder settings…
        </div>
      </div>
    );
  }

  return (
    <div className="mb-6 rounded-2xl border border-neutral-200 bg-white shadow-sm overflow-hidden">
      <div className="border-b border-neutral-100 bg-gradient-to-r from-amber-50 to-orange-50 px-5 py-4">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-amber-500/15 flex items-center justify-center border border-amber-500/20 shrink-0">
            <i className="fas fa-bell text-amber-600" />
          </div>
          <div>
            <h2 className="text-base font-bold text-neutral-900">Next service reminders</h2>
            <p className="text-xs text-neutral-600 mt-0.5 max-w-2xl">
              Set how long after each booking is <strong>completed</strong> customers should be reminded.
              Saving applies to <strong>all completed bookings</strong> for the selected branch — each customer is
              reminded individually when their own interval is due. Customers also get a heads-up{" "}
              <strong>{SERVICE_REMINDER_ADVANCE_NOTICE_DAYS} days before</strong> the main reminder.
            </p>
          </div>
        </div>
      </div>

      <div className="p-5 space-y-4">
        {branches.length > 1 && !isBranchAdmin && (
          <div>
            <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wide mb-1.5">
              Branch
            </label>
            <select
              value={selectedBranchId}
              onChange={(e) => setSelectedBranchId(e.target.value)}
              className={INPUT_CLASS}
            >
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
        )}

        {branches.length === 1 && (
          <div className="text-xs text-neutral-500 flex items-center gap-1.5">
            <i className="fas fa-location-dot text-amber-500" />
            Branch: <span className="font-medium text-neutral-700">{branches[0].name}</span>
          </div>
        )}

        <div className={`grid sm:grid-cols-2 gap-4 ${settingsLoading ? "opacity-60 pointer-events-none" : ""}`}>
          <ServiceReminderIntervalPicker
            intervalDays={intervalDays}
            onChange={setIntervalDays}
            inputClass={INPUT_CLASS}
          />
          <div>
            <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wide mb-1.5">
              Custom message (optional)
            </label>
            <textarea
              value={customMessage}
              onChange={(e) => setCustomMessage(e.target.value)}
              rows={3}
              placeholder="Hi {name}, your next service is due soon…"
              className={`${INPUT_CLASS} resize-none`}
            />
            <p className="text-[11px] text-neutral-400 mt-1">
              Use {"{name}"}, {"{service}"}, or {"{vehicle}"} as placeholders.
            </p>
          </div>
        </div>

        {settingsLoading && (
          <p className="text-xs text-neutral-500 flex items-center gap-2">
            <i className="fas fa-spinner fa-spin" />
            Loading branch settings…
          </p>
        )}

        {error && (
          <div className="text-sm text-rose-600 bg-rose-50 border border-rose-100 rounded-lg px-3 py-2">
            {error}
          </div>
        )}
        {saved && savedSummary && (
          <div className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-lg px-3 py-2">
            {savedSummary}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || settingsLoading || !selectedBranchId}
            className="px-4 py-2 rounded-lg text-sm font-semibold bg-neutral-900 text-white hover:bg-neutral-800 disabled:opacity-60 inline-flex items-center gap-2"
          >
            {saving ? <i className="fas fa-spinner fa-spin" /> : <i className="fas fa-save" />}
            {saving ? "Saving…" : "Save settings"}
          </button>
        </div>
      </div>
    </div>
  );
}
