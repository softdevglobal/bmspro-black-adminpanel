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
import { useCallback, useEffect, useMemo, useState } from "react";
import ServiceReminderIntervalPicker from "./ServiceReminderIntervalPicker";

const INPUT_CLASS =
  "w-full rounded-lg border border-neutral-300 bg-white px-3.5 py-2.5 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-900 focus:outline-none focus:ring-2 focus:ring-neutral-900/10";

const INLINE_SELECT_CLASS =
  "rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 focus:border-neutral-900 focus:outline-none focus:ring-2 focus:ring-neutral-900/10 min-w-[140px]";

type ServiceOption = { id: string; name: string };

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

const DEFAULT_REMINDER_MESSAGE =
  "Hi {name}, friendly reminder that your vehicle service is due soon. Book a time that suits you.";

export default function ServiceReminderSettingsPanel() {
  const [initLoading, setInitLoading] = useState(true);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [savedSummary, setSavedSummary] = useState<string | null>(null);
  const [serviceIntervals, setServiceIntervals] = useState<Record<string, number>>({});
  const [customMessage, setCustomMessage] = useState(DEFAULT_REMINDER_MESSAGE);
  const [services, setServices] = useState<ServiceOption[]>([]);
  const [search, setSearch] = useState("");

  const loadSettings = useCallback(async () => {
    setSettingsLoading(true);
    setError(null);
    const result = await authFetch<{ settings: ServiceReminderSettings }>(
      "/api/service-reminders/settings",
    );
    if (!result.ok) {
      setError(result.error);
      setSettingsLoading(false);
      return;
    }
    setServiceIntervals(result.data.settings.serviceIntervals || {});
    setCustomMessage(result.data.settings.customMessage || DEFAULT_REMINDER_MESSAGE);
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

        if (cancelled) return;

        if (role !== "workshop_owner" && role !== "branch_admin") {
          setError("Only workshop owners and branch admins can manage service reminder settings.");
          setInitLoading(false);
          return;
        }

        const servicesSnap = await getDocs(
          query(collection(db, "services"), where("ownerUid", "==", ownerUid)),
        );

        if (cancelled) return;

        const serviceList: ServiceOption[] = servicesSnap.docs.map((d) => ({
          id: d.id,
          name: String(d.data().name || "Service"),
        }));
        serviceList.sort((a, b) => a.name.localeCompare(b.name));
        setServices(serviceList);
        setInitLoading(false);
      } catch (e: unknown) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load services");
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
    if (initLoading) return;
    void loadSettings();
  }, [initLoading, loadSettings]);

  const filteredServices = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return services;
    return services.filter((s) => s.name.toLowerCase().includes(q));
  }, [services, search]);

  const getIntervalForService = (serviceId: string) =>
    serviceIntervals[serviceId] ?? DEFAULT_SERVICE_REMINDER_INTERVAL_DAYS;

  const setIntervalForService = (serviceId: string, days: number) => {
    setServiceIntervals((prev) => ({ ...prev, [serviceId]: days }));
  };

  const handleSave = async () => {
    if (services.length === 0) {
      setError("No services found. Add services first.");
      return;
    }

    setSaving(true);
    setError(null);
    setSaved(false);
    setSavedSummary(null);

    const intervalsToSave: Record<string, number> = {};
    for (const service of services) {
      const days = getIntervalForService(service.id);
      const parsed = parseServiceReminderIntervalDays(days);
      if (!parsed.ok) {
        setError(`${service.name}: ${parsed.error}`);
        setSaving(false);
        return;
      }
      intervalsToSave[service.id] = parsed.days;
    }

    const result = await authFetch<{
      settings: ServiceReminderSettings;
      bulk?: { scheduled: number; skipped: number; errors: number };
    }>("/api/service-reminders/settings", {
      method: "PATCH",
      body: JSON.stringify({
        serviceIntervals: intervalsToSave,
        customMessage: customMessage.trim() || undefined,
      }),
    });
    setSaving(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setServiceIntervals(result.data.settings.serviceIntervals || {});
    setCustomMessage(result.data.settings.customMessage || DEFAULT_REMINDER_MESSAGE);
    const bulk = result.data.bulk;
    if (bulk) {
      setSavedSummary(
        `Saved ${Object.keys(intervalsToSave).length} service interval${
          Object.keys(intervalsToSave).length === 1 ? "" : "s"
        }. Updated ${bulk.scheduled} completed booking${bulk.scheduled === 1 ? "" : "s"}` +
          (bulk.skipped ? ` (${bulk.skipped} skipped)` : "") +
          ".",
      );
    } else {
      setSavedSummary("Settings saved.");
    }
    setSaved(true);
    setTimeout(() => {
      setSaved(false);
      setSavedSummary(null);
    }, 6000);
  };

  if (initLoading) {
    return (
      <div className="rounded-2xl border border-neutral-200 bg-white p-8 shadow-sm">
        <div className="text-sm text-neutral-500 flex items-center justify-center gap-2">
          <i className="fas fa-spinner fa-spin" />
          Loading…
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-neutral-200 bg-white shadow-sm">
        <div className="px-5 py-4 border-b border-neutral-100">
          <h2 className="text-sm font-semibold text-neutral-900">Reminder message</h2>
          <p className="text-xs text-neutral-500 mt-0.5">
            Sent to customers when their service reminder is due
          </p>
        </div>
        <div className={`p-5 ${settingsLoading ? "opacity-60 pointer-events-none" : ""}`}>
          <textarea
            value={customMessage}
            onChange={(e) => setCustomMessage(e.target.value)}
            rows={3}
            placeholder="Hi {name}, your next service is due soon…"
            className={`${INPUT_CLASS} resize-none`}
          />
          <p className="text-[11px] text-neutral-400 mt-1.5">
            Placeholders: {"{name}"}, {"{service}"}, {"{vehicle}"}
          </p>
        </div>
      </div>

      <div className="rounded-2xl border border-neutral-200 bg-white shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-neutral-100 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-neutral-900">Reminder intervals by service</h2>
            <p className="text-xs text-neutral-500 mt-0.5">
              Customers are reminded after each service is completed. They also get a heads-up{" "}
              {SERVICE_REMINDER_ADVANCE_NOTICE_DAYS} days before the due date.
            </p>
          </div>
          <div className="relative sm:w-56 shrink-0">
            <i className="fas fa-search absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400 text-xs" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search services…"
              className={`${INPUT_CLASS} pl-9 py-2`}
            />
          </div>
        </div>

        <div className={settingsLoading ? "opacity-60 pointer-events-none" : ""}>
          {filteredServices.length === 0 ? (
            <div className="px-5 py-12 text-center text-sm text-neutral-500">
              {services.length === 0
                ? "No services yet. Add services from the Services page."
                : "No services match your search."}
            </div>
          ) : (
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-neutral-100 bg-neutral-50/80">
                  <th className="px-5 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
                    Service
                  </th>
                  <th className="px-5 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-500 text-right w-[220px]">
                    Remind after
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {filteredServices.map((service) => (
                  <tr key={service.id} className="hover:bg-neutral-50/60">
                    <td className="px-5 py-3.5">
                      <p className="text-sm font-medium text-neutral-900">{service.name}</p>
                    </td>
                    <td className="px-5 py-3.5">
                      <ServiceReminderIntervalPicker
                        intervalDays={getIntervalForService(service.id)}
                        onChange={(days) => setIntervalForService(service.id, days)}
                        inputClass={INLINE_SELECT_CLASS}
                        inline
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {settingsLoading && (
        <p className="text-xs text-neutral-500 flex items-center gap-2">
          <i className="fas fa-spinner fa-spin" />
          Loading settings…
        </p>
      )}

      {error && (
        <div className="text-sm text-rose-600 bg-rose-50 border border-rose-100 rounded-xl px-4 py-3">
          {error}
        </div>
      )}
      {saved && savedSummary && (
        <div className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-xl px-4 py-3">
          {savedSummary}
        </div>
      )}

      <div className="flex justify-end">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || settingsLoading || services.length === 0}
          className="px-5 py-2.5 rounded-xl text-sm font-semibold bg-neutral-900 text-white hover:bg-neutral-800 disabled:opacity-60 inline-flex items-center gap-2 shadow-sm"
        >
          {saving ? <i className="fas fa-spinner fa-spin" /> : <i className="fas fa-save" />}
          {saving ? "Saving…" : "Save settings"}
        </button>
      </div>
    </div>
  );
}
