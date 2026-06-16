"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Sidebar from "@/components/Sidebar";
import { useRouter } from "next/navigation";
import { auth, db } from "@/lib/firebase";
import { onAuthStateChanged } from "firebase/auth";
import { collection, doc, getDoc, onSnapshot, query, where } from "firebase/firestore";
import { formatInTimezone } from "@/lib/timezone";
import {
  ACTIVITY_TYPE_CONFIG,
  type AgentActivityType,
} from "@/lib/agentActivitiesDummyData";
import {
  fetchAgentActivitiesForOwner,
  fetchAgentActivityRecordingBlob,
  getAgentActivityStats,
  mapApiRecordToRow,
  type AgentActivityRow,
} from "@/lib/agentActivitiesApi";

type TenantOption = { id: string; name: string; timezone: string };

function CallRecordingPanel({
  activity,
  ownerId,
}: {
  activity: AgentActivityRow;
  ownerId: string;
}) {
  const [audioSrc, setAudioSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    if (!activity.recordingUrl || !ownerId) {
      setAudioSrc(null);
      setError(null);
      return;
    }

    let objectUrl: string | null = null;
    let cancelled = false;

    (async () => {
      setLoading(true);
      setError(null);
      setAudioSrc(null);
      try {
        const user = auth.currentUser;
        if (!user) throw new Error("Not signed in");
        const token = await user.getIdToken();
        const blob = await fetchAgentActivityRecordingBlob(activity.id, ownerId, token);
        if (blob.size === 0) throw new Error("Recording file is empty");
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setAudioSrc(objectUrl);
      } catch (e: unknown) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load recording");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [activity.id, activity.recordingUrl, ownerId]);

  const handleDownload = async () => {
    if (!ownerId) return;
    setDownloading(true);
    setError(null);
    try {
      const user = auth.currentUser;
      if (!user) throw new Error("Not signed in");
      const token = await user.getIdToken();
      const blob = await fetchAgentActivityRecordingBlob(activity.id, ownerId, token, true);
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = activity.recordingFileName || `recording-${activity.callId || activity.id}.wav`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to download recording");
    } finally {
      setDownloading(false);
    }
  };

  if (!activity.recordingUrl) {
    return (
      <div className="rounded-xl border border-dashed border-neutral-200 bg-neutral-50 px-4 py-5 text-sm text-neutral-500">
        No call recording attached to this activity.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-neutral-900 flex items-center gap-2">
          <i className="fas fa-microphone text-violet-600" />
          Call recording
        </h3>
        <button
          type="button"
          onClick={handleDownload}
          disabled={downloading || loading}
          className="inline-flex items-center gap-2 rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"
        >
          <i className={`fas ${downloading ? "fa-spinner fa-spin" : "fa-download"}`} />
          Download
        </button>
      </div>

      {activity.recordingFileName && (
        <p className="text-xs text-neutral-500 font-mono truncate">{activity.recordingFileName}</p>
      )}

      {loading && (
        <div className="rounded-xl border border-neutral-200 bg-neutral-50 px-4 py-5 text-sm text-neutral-500">
          <i className="fas fa-spinner fa-spin mr-2" />
          Loading recording…
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {audioSrc && !loading && (
        <audio
          controls
          preload="metadata"
          className="w-full rounded-lg"
          src={audioSrc}
          onError={() => setError("This recording file could not be decoded by the browser. Try downloading it, or check the source audio format.")}
        >
          Your browser does not support audio playback.
        </audio>
      )}
    </div>
  );
}

export default function AgentActivitiesPage() {
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [authReady, setAuthReady] = useState(false);
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const [ownerId, setOwnerId] = useState<string | null>(null);
  const [workshopName, setWorkshopName] = useState("");
  const [tenants, setTenants] = useState<TenantOption[]>([]);
  const [selectedOwnerId, setSelectedOwnerId] = useState("");
  const [activities, setActivities] = useState<AgentActivityRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [filterAgent, setFilterAgent] = useState("All agents");
  const [searchQuery, setSearchQuery] = useState("");
  const [previewActivity, setPreviewActivity] = useState<AgentActivityRow | null>(null);
  const [ownerTimezone, setOwnerTimezone] = useState("Australia/Sydney");

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
        const superAdminDoc = await getDoc(doc(db, "super_admins", user.uid));
        if (superAdminDoc.exists()) {
          setIsSuperAdmin(true);
          setAuthReady(true);
          return;
        }
        const userDoc = await getDoc(doc(db, "users", user.uid));
        const data = userDoc.data();
        const role = (data?.role || "").toString();
        if (role !== "workshop_owner") {
          router.replace("/dashboard");
          return;
        }
        setOwnerId(user.uid);
        setWorkshopName((data?.name || data?.displayName || "Your workshop").toString());
        setOwnerTimezone((data?.timezone || "Australia/Sydney").toString());
        setAuthReady(true);
      } catch {
        router.replace("/login");
      }
    });
    return () => unsub();
  }, [router]);

  useEffect(() => {
    if (!authReady || !isSuperAdmin) return;
    const tenantsQuery = query(collection(db, "users"), where("role", "==", "workshop_owner"));
    const unsub = onSnapshot(
      tenantsQuery,
      (snapshot) => {
        const list = snapshot.docs
          .map((d) => ({
            id: d.id,
            name: (d.data().name || d.data().displayName || d.data().email || "Unnamed workshop").toString(),
            timezone: (d.data().timezone || "Australia/Sydney").toString(),
          }))
          .sort((a, b) => a.name.localeCompare(b.name));
        setTenants(list);
        setSelectedOwnerId((prev) => prev || list[0]?.id || "");
      },
      () => setTenants([])
    );
    return () => unsub();
  }, [authReady, isSuperAdmin]);

  useEffect(() => {
    if (!isSuperAdmin || !selectedOwnerId) return;
    const tenant = tenants.find((t) => t.id === selectedOwnerId);
    if (tenant?.timezone) {
      setOwnerTimezone(tenant.timezone);
    }
  }, [isSuperAdmin, selectedOwnerId, tenants]);

  const activeOwnerId = isSuperAdmin ? selectedOwnerId : ownerId;
  const activeWorkshopName = isSuperAdmin
    ? tenants.find((t) => t.id === selectedOwnerId)?.name || "Workshop"
    : workshopName;

  const loadActivities = useCallback(async () => {
    if (!activeOwnerId) {
      setActivities([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setFetchError(null);
    try {
      const user = auth.currentUser;
      if (!user) throw new Error("Not signed in");
      const token = await user.getIdToken();
      const records = await fetchAgentActivitiesForOwner(activeOwnerId, token, 100);
      const name =
        isSuperAdmin
          ? tenants.find((t) => t.id === activeOwnerId)?.name || activeWorkshopName
          : workshopName;
      setActivities(records.map((r) => mapApiRecordToRow(r, name)));
    } catch (e: unknown) {
      setFetchError(e instanceof Error ? e.message : "Failed to load activities");
      setActivities([]);
    } finally {
      setLoading(false);
    }
  }, [activeOwnerId, activeWorkshopName, isSuperAdmin, tenants, workshopName]);

  useEffect(() => {
    if (!authReady) return;
    if (isSuperAdmin && !selectedOwnerId) {
      setLoading(false);
      return;
    }
    if (!isSuperAdmin && !ownerId) return;
    loadActivities();
  }, [authReady, isSuperAdmin, selectedOwnerId, ownerId, loadActivities]);

  const agentFilterOptions = useMemo(() => {
    const names = Array.from(new Set(activities.map((a) => a.agentName).filter(Boolean))).sort();
    return ["All agents", ...names];
  }, [activities]);

  const stats = useMemo(() => getAgentActivityStats(activities), [activities]);

  const filteredActivities = useMemo(() => {
    return activities.filter((activity) => {
      if (filterAgent !== "All agents" && activity.agentName !== filterAgent) return false;
      if (!searchQuery.trim()) return true;
      const q = searchQuery.toLowerCase();
      return (
        activity.agentName.toLowerCase().includes(q) ||
        activity.agentEmail.toLowerCase().includes(q) ||
        activity.agentRole.toLowerCase().includes(q) ||
        activity.customerName.toLowerCase().includes(q) ||
        activity.customerPhone.toLowerCase().includes(q) ||
        activity.workshopName.toLowerCase().includes(q) ||
        activity.callId.toLowerCase().includes(q) ||
        activity.agentNote.toLowerCase().includes(q) ||
        activity.queueName.toLowerCase().includes(q) ||
        activity.didNumber.toLowerCase().includes(q) ||
        activity.branchName.toLowerCase().includes(q)
      );
    });
  }, [activities, filterAgent, searchQuery]);

  if (!authReady) {
    return (
      <div id="app" className="flex h-screen overflow-hidden bg-white">
        <Sidebar />
        <div className="flex-1 flex items-center justify-center bg-neutral-50">
          <div className="text-center">
            <i className="fas fa-spinner fa-spin text-2xl text-neutral-400 mb-3" />
            <p className="text-sm text-neutral-500">Loading agent activities…</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div id="app" className="flex h-screen overflow-hidden bg-white">
      <Sidebar />
      <div className="flex-1 flex flex-col overflow-hidden">
        <main className="flex-1 overflow-auto p-4 sm:p-6 lg:p-8 bg-neutral-50">
          <div className="md:hidden mb-4">
            <button
              type="button"
              className="inline-flex items-center gap-2 rounded-lg border border-neutral-200 px-3 py-2 text-neutral-700 shadow-sm hover:bg-neutral-50"
              onClick={() => setMobileOpen(true)}
            >
              <i className="fas fa-bars" />
              Menu
            </button>
          </div>

          {mobileOpen && (
            <div className="fixed inset-0 z-50 md:hidden">
              <div className="absolute inset-0 bg-black/50" onClick={() => setMobileOpen(false)} />
              <div className="absolute left-0 top-0 h-full w-72">
                <Sidebar mobile onClose={() => setMobileOpen(false)} />
              </div>
            </div>
          )}

          <div className="max-w-7xl mx-auto space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
              <div>
                <h1 className="text-2xl font-bold text-neutral-900">Agent Activities</h1>
                <p className="text-sm text-neutral-500 mt-1">
                  Call center activity for{" "}
                  <span className="font-medium text-neutral-700">{activeWorkshopName}</span>
                  <span className="text-neutral-400"> · Times in {ownerTimezone}</span>
                </p>
              </div>
              <button
                type="button"
                onClick={() => loadActivities()}
                disabled={loading || !activeOwnerId}
                className="inline-flex items-center gap-2 self-start rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-700 shadow-sm hover:bg-neutral-50 disabled:opacity-50"
              >
                <i className={`fas fa-rotate-right ${loading ? "fa-spin" : ""}`} />
                Refresh
              </button>
            </div>

            {isSuperAdmin && (
              <div className="bg-white rounded-xl border border-neutral-200 shadow-sm p-4">
                <label className="block text-xs font-semibold uppercase tracking-wide text-neutral-500 mb-2">
                  Workshop owner
                </label>
                <select
                  value={selectedOwnerId}
                  onChange={(e) => setSelectedOwnerId(e.target.value)}
                  className="w-full sm:max-w-md px-3 py-2.5 rounded-lg border border-neutral-200 text-sm bg-white"
                >
                  {tenants.length === 0 ? (
                    <option value="">No workshops found</option>
                  ) : (
                    tenants.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))
                  )}
                </select>
              </div>
            )}

            {fetchError && (
              <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                {fetchError}
              </div>
            )}

            <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 sm:gap-4">
              {[
                { label: "Total activities", value: stats.totalActivities, icon: "fa-list-check", color: "text-neutral-700", bg: "bg-neutral-100" },
                { label: "Calls logged", value: stats.totalCalls, icon: "fa-phone", color: "text-blue-700", bg: "bg-blue-100" },
                { label: "With agent note", value: stats.answered, icon: "fa-phone-volume", color: "text-emerald-700", bg: "bg-emerald-100" },
                { label: "With recording", value: stats.withRecording, icon: "fa-microphone", color: "text-violet-700", bg: "bg-violet-100" },
                { label: "Agents", value: stats.activeAgents, icon: "fa-clock", color: "text-amber-700", bg: "bg-amber-100" },
              ].map((card) => (
                <div key={card.label} className="bg-white rounded-xl border border-neutral-200 p-4 shadow-sm">
                  <div className={`w-9 h-9 rounded-lg ${card.bg} flex items-center justify-center mb-3`}>
                    <i className={`fas ${card.icon} ${card.color}`} />
                  </div>
                  <p className="text-2xl font-bold text-neutral-900">{card.value}</p>
                  <p className="text-xs text-neutral-500 mt-0.5">{card.label}</p>
                </div>
              ))}
            </div>

            <div className="bg-white rounded-xl border border-neutral-200 shadow-sm p-4 sm:p-5 space-y-4">
              <div className="flex flex-col lg:flex-row gap-3">
                <div className="relative flex-1">
                  <i className="fas fa-search absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400 text-sm" />
                  <input
                    type="text"
                    placeholder="Search agent, caller, call ID, queue, DID…"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full pl-9 pr-4 py-2.5 rounded-lg border border-neutral-200 text-sm focus:outline-none focus:ring-2 focus:ring-neutral-900/10 focus:border-neutral-400"
                  />
                </div>
                <select
                  value={filterAgent}
                  onChange={(e) => setFilterAgent(e.target.value)}
                  className="px-3 py-2.5 rounded-lg border border-neutral-200 text-sm bg-white min-w-[160px]"
                >
                  {agentFilterOptions.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="overflow-x-auto -mx-4 sm:mx-0">
                <table className="w-full min-w-[980px] text-sm">
                  <thead>
                    <tr className="border-b border-neutral-200 text-left text-xs font-semibold uppercase tracking-wide text-neutral-500">
                      <th className="px-4 py-3">Call</th>
                      <th className="px-4 py-3">Agent</th>
                      <th className="px-4 py-3">Caller</th>
                      <th className="px-4 py-3">Branch</th>
                      <th className="px-4 py-3">Queue / DID</th>
                      <th className="px-4 py-3">Recording</th>
                      <th className="px-4 py-3">Time</th>
                      <th className="px-4 py-3 w-10" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-neutral-100">
                    {loading ? (
                      <tr>
                        <td colSpan={8} className="px-4 py-12 text-center text-neutral-500">
                          <i className="fas fa-spinner fa-spin mr-2" />
                          Loading activities…
                        </td>
                      </tr>
                    ) : filteredActivities.length === 0 ? (
                      <tr>
                        <td colSpan={8} className="px-4 py-12 text-center text-neutral-500">
                          {activeOwnerId
                            ? "No agent activities for this workshop yet."
                            : "Select a workshop to view activities."}
                        </td>
                      </tr>
                    ) : (
                      filteredActivities.map((activity) => {
                        const typeConfig = ACTIVITY_TYPE_CONFIG[activity.type as AgentActivityType];
                        return (
                          <tr
                            key={activity.id}
                            className="hover:bg-neutral-50 cursor-pointer transition"
                            onClick={() => setPreviewActivity(activity)}
                          >
                            <td className="px-4 py-3">
                              <div className="flex items-center gap-2.5">
                                <span
                                  className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${typeConfig.bgColor}`}
                                >
                                  <i className={`fas ${typeConfig.icon} ${typeConfig.color} text-xs`} />
                                </span>
                                <div className="min-w-0">
                                  <p className="font-medium text-neutral-900 truncate">{typeConfig.label}</p>
                                  <p className="text-xs text-neutral-500 truncate font-mono">{activity.callId}</p>
                                </div>
                              </div>
                            </td>
                            <td className="px-4 py-3">
                              <p className="font-medium text-neutral-800">{activity.agentName}</p>
                              <p className="text-xs text-neutral-400 truncate max-w-[180px]">
                                {activity.agentEmail || activity.agentUserId}
                              </p>
                            </td>
                            <td className="px-4 py-3">
                              <p className="text-neutral-800">{activity.customerName}</p>
                              <p className="text-xs text-neutral-500">{activity.customerPhone}</p>
                            </td>
                            <td className="px-4 py-3 text-neutral-700 max-w-[160px] truncate">
                              {activity.branchName || "—"}
                            </td>
                            <td className="px-4 py-3 text-neutral-600 text-xs max-w-[140px]">
                              <p className="truncate">{activity.queueName || "—"}</p>
                              <p className="text-neutral-400 truncate">{activity.didNumber || ""}</p>
                            </td>
                            <td className="px-4 py-3">
                              {activity.recordingUrl ? (
                                <span className="inline-flex items-center gap-1.5 rounded-full bg-violet-50 px-2 py-1 text-xs font-medium text-violet-700">
                                  <i className="fas fa-circle-play" />
                                  Available
                                </span>
                              ) : (
                                <span className="text-neutral-400">—</span>
                              )}
                            </td>
                            <td className="px-4 py-3 text-neutral-500 text-xs whitespace-nowrap">
                              {formatInTimezone(activity.timestamp.toISOString(), ownerTimezone, "d MMM yyyy, h:mm a")}
                            </td>
                            <td className="px-4 py-3 text-neutral-400">
                              <i className="fas fa-chevron-right text-xs" />
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>

              <p className="text-xs text-neutral-400 pt-1">
                Showing {filteredActivities.length} of {activities.length} records
                {activeOwnerId ? ` · ownerId ${activeOwnerId}` : ""}
              </p>
            </div>
          </div>
        </main>
      </div>

      {previewActivity && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => setPreviewActivity(null)}
            aria-hidden
          />
          <div className="relative bg-white w-full sm:max-w-lg sm:rounded-2xl rounded-t-2xl shadow-xl max-h-[90vh] overflow-y-auto">
            <div className="sticky top-0 bg-white border-b border-neutral-200 px-5 py-4 flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <span
                    className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium ${ACTIVITY_TYPE_CONFIG.call_answered.bgColor} ${ACTIVITY_TYPE_CONFIG.call_answered.color}`}
                  >
                    <i className="fas fa-phone-volume" />
                    Call activity
                  </span>
                </div>
                <h2 className="text-lg font-bold text-neutral-900">{previewActivity.agentName}</h2>
                <p className="text-sm text-neutral-500">{activeWorkshopName}</p>
              </div>
              <button
                type="button"
                onClick={() => setPreviewActivity(null)}
                className="p-2 rounded-lg hover:bg-neutral-100 text-neutral-500"
                aria-label="Close"
              >
                <i className="fas fa-times" />
              </button>
            </div>

            <div className="p-5 space-y-5">
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div className="bg-neutral-50 rounded-lg p-3">
                  <p className="text-xs text-neutral-500 mb-0.5">Agent</p>
                  <p className="font-medium text-neutral-900">{previewActivity.agentName}</p>
                  <p className="text-xs text-neutral-500 mt-0.5">{previewActivity.agentEmail || previewActivity.agentUserId}</p>
                  {previewActivity.agentRole && (
                    <p className="text-xs text-neutral-400 mt-0.5 capitalize">{previewActivity.agentRole.replace(/_/g, " ")}</p>
                  )}
                </div>
                <div className="bg-neutral-50 rounded-lg p-3">
                  <p className="text-xs text-neutral-500 mb-0.5">Caller</p>
                  <p className="font-medium text-neutral-900">{previewActivity.customerName}</p>
                  <p className="text-xs text-neutral-500 mt-0.5">{previewActivity.customerPhone}</p>
                </div>
                <div className="bg-neutral-50 rounded-lg p-3">
                  <p className="text-xs text-neutral-500 mb-0.5">Workshop</p>
                  <p className="font-medium text-neutral-900">{previewActivity.ownerName || activeWorkshopName}</p>
                </div>
                <div className="bg-neutral-50 rounded-lg p-3">
                  <p className="text-xs text-neutral-500 mb-0.5">When</p>
                  <p className="font-medium text-neutral-900 text-xs leading-relaxed">
                    {formatInTimezone(
                      previewActivity.timestamp.toISOString(),
                      ownerTimezone,
                      "EEEE d MMMM yyyy 'at' h:mm:ss a"
                    )}
                  </p>
                </div>
                <div className="bg-neutral-50 rounded-lg p-3">
                  <p className="text-xs text-neutral-500 mb-0.5">Call ID</p>
                  <p className="font-medium text-neutral-900 font-mono text-xs">{previewActivity.callId}</p>
                </div>
                <div className="bg-neutral-50 rounded-lg p-3">
                  <p className="text-xs text-neutral-500 mb-0.5">Branch</p>
                  <p className="font-medium text-neutral-900">{previewActivity.branchName || "—"}</p>
                </div>
                <div className="bg-neutral-50 rounded-lg p-3">
                  <p className="text-xs text-neutral-500 mb-0.5">Queue</p>
                  <p className="font-medium text-neutral-900">{previewActivity.queueName || "—"}</p>
                </div>
                <div className="bg-neutral-50 rounded-lg p-3">
                  <p className="text-xs text-neutral-500 mb-0.5">DID</p>
                  <p className="font-medium text-neutral-900">{previewActivity.didNumber || "—"}</p>
                </div>
              </div>

              {previewActivity && activeOwnerId && (
                <CallRecordingPanel activity={previewActivity} ownerId={activeOwnerId} />
              )}

              {previewActivity.agentNote && (
                <div>
                  <h3 className="text-sm font-semibold text-neutral-900 mb-2 flex items-center gap-2">
                    <i className="fas fa-note-sticky text-neutral-500" />
                    Agent note
                  </h3>
                  <p className="text-sm text-neutral-600 leading-relaxed bg-neutral-50 border border-neutral-200 rounded-xl p-4">
                    {previewActivity.agentNote}
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
