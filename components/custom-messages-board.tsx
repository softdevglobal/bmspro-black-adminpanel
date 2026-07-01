"use client";

import { DeleteConfirmModal } from "@/components/delete-confirm-modal";
import { auth } from "@/lib/firebase";
import {
  BROADCAST_AUDIENCE_LABELS,
  type BroadcastAudience,
  type BroadcastRecord,
} from "@/lib/broadcasts/types";
import { useCallback, useEffect, useMemo, useState } from "react";

const INPUT_CLASS =
  "w-full rounded-lg border border-neutral-300 bg-white px-3.5 py-2.5 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-900 focus:outline-none focus:ring-2 focus:ring-neutral-900/10";

const MAX_TITLE_LENGTH = 120;
const MAX_BODY_LENGTH = 2000;

type FetchResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

async function authFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<FetchResult<T>> {
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

function relativeTime(timestamp: number): string {
  if (!timestamp) return "";
  return new Date(timestamp).toLocaleString("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function platformLabel(record: BroadcastRecord): string {
  const parts: string[] = [];
  if (record.platforms.admin) parts.push("Admin panel");
  if (record.platforms.mobile) parts.push("Mobile app");
  return parts.length ? parts.join(" + ") : "—";
}

function PlatformToggle({
  active,
  onClick,
  icon,
  title,
  description,
}: {
  active: boolean;
  onClick: () => void;
  icon: string;
  title: string;
  description: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-start gap-3 rounded-xl border p-4 text-left transition-all ${
        active
          ? "border-violet-300 bg-violet-50 shadow-sm ring-1 ring-violet-200"
          : "border-neutral-200 bg-white hover:border-neutral-300 hover:bg-neutral-50"
      }`}
    >
      <div
        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${
          active ? "bg-violet-600 text-white" : "bg-neutral-100 text-neutral-500"
        }`}
      >
        <i className={`fas ${icon}`} />
      </div>
      <div className="min-w-0 flex-1">
        <p className={`text-sm font-semibold ${active ? "text-violet-900" : "text-neutral-900"}`}>
          {title}
        </p>
        <p className="mt-0.5 text-xs text-neutral-500">{description}</p>
      </div>
      <div
        className={`mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${
          active ? "border-violet-600 bg-violet-600 text-white" : "border-neutral-300 bg-white"
        }`}
      >
        {active ? <i className="fas fa-check text-[10px]" /> : null}
      </div>
    </button>
  );
}

function AudienceOption({
  active,
  onClick,
  icon,
  label,
  hint,
}: {
  active: boolean;
  onClick: () => void;
  icon: string;
  label: string;
  hint: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-left transition-all ${
        active
          ? "border-neutral-900 bg-neutral-900 text-white shadow-md"
          : "border-neutral-200 bg-white text-neutral-800 hover:border-neutral-300 hover:bg-neutral-50"
      }`}
    >
      <i className={`fas ${icon} ${active ? "text-amber-400" : "text-neutral-400"}`} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">{label}</p>
        <p className={`text-xs ${active ? "text-neutral-300" : "text-neutral-500"}`}>{hint}</p>
      </div>
    </button>
  );
}

export function CustomMessagesBoard() {
  const [broadcasts, setBroadcasts] = useState<BroadcastRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [targetAdmin, setTargetAdmin] = useState(true);
  const [targetMobile, setTargetMobile] = useState(true);
  const [audience, setAudience] = useState<BroadcastAudience>("owners");
  const [sending, setSending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<BroadcastRecord | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const result = await authFetch<{ broadcasts: BroadcastRecord[] }>(
      "/api/admin/broadcasts",
    );
    if (result.ok) {
      setBroadcasts(result.data.broadcasts ?? []);
      setListError(null);
    } else {
      setListError(result.error);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const stats = useMemo(() => {
    const active = broadcasts.filter((b) => b.active).length;
    const recalled = broadcasts.filter((b) => !b.active).length;
    const withPush = broadcasts.filter((b) => (b.mobilePushCount ?? 0) > 0).length;
    return { total: broadcasts.length, active, recalled, withPush };
  }, [broadcasts]);

  const canSubmit = useMemo(
    () =>
      title.trim().length > 0 &&
      body.trim().length > 0 &&
      (targetAdmin || targetMobile) &&
      !sending,
    [title, body, targetAdmin, targetMobile, sending],
  );

  const previewTitle = title.trim() || "Announcement title";
  const previewBody =
    body.trim() || "Your message will appear here in the notification bell and mobile app.";

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setFormError(null);
    setSuccessMessage(null);

    if (!title.trim() || !body.trim()) {
      setFormError("Add a title and a message.");
      return;
    }
    if (!targetAdmin && !targetMobile) {
      setFormError("Choose at least one platform.");
      return;
    }

    setSending(true);
    const result = await authFetch<{ mobilePushCount: number }>(
      "/api/admin/broadcasts",
      {
        method: "POST",
        body: JSON.stringify({
          title: title.trim(),
          body: body.trim(),
          platforms: { admin: targetAdmin, mobile: targetMobile },
          audience,
        }),
      },
    );
    setSending(false);

    if (!result.ok) {
      setFormError(result.error);
      return;
    }

    const pushCount = result.data.mobilePushCount ?? 0;
    setSuccessMessage(
      targetMobile
        ? `Message sent. Push notification delivered to ${pushCount} device${
            pushCount === 1 ? "" : "s"
          }.`
        : "Message sent.",
    );
    setTitle("");
    setBody("");
    void load();
  }

  async function toggleActive(record: BroadcastRecord) {
    setBusyId(record.id);
    const result = await authFetch(`/api/admin/broadcasts/${record.id}`, {
      method: "PATCH",
      body: JSON.stringify({ active: !record.active }),
    });
    setBusyId(null);
    if (result.ok) {
      setBroadcasts((current) =>
        current.map((item) =>
          item.id === record.id ? { ...item, active: !item.active } : item,
        ),
      );
    }
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    const result = await authFetch(`/api/admin/broadcasts/${pendingDelete.id}`, {
      method: "DELETE",
    });
    setDeleting(false);
    if (result.ok) {
      setBroadcasts((current) =>
        current.filter((item) => item.id !== pendingDelete.id),
      );
    }
    setPendingDelete(null);
  }

  return (
    <div className="space-y-6">
      {/* Stats */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {[
          { label: "Total sent", value: stats.total, icon: "fa-paper-plane", color: "bg-neutral-900" },
          { label: "Active", value: stats.active, icon: "fa-circle-check", color: "bg-emerald-500" },
          { label: "Recalled", value: stats.recalled, icon: "fa-eye-slash", color: "bg-amber-500" },
          { label: "With push", value: stats.withPush, icon: "fa-bell", color: "bg-violet-600" },
        ].map((item) => (
          <div
            key={item.label}
            className="rounded-xl border border-neutral-200 bg-white p-4 shadow-sm"
          >
            <div className="flex items-center gap-3">
              <div
                className={`flex h-10 w-10 items-center justify-center rounded-lg ${item.color}`}
              >
                <i className={`fas ${item.icon} text-white`} />
              </div>
              <div>
                <div className="text-2xl font-bold tabular-nums text-neutral-900">
                  {item.value}
                </div>
                <div className="text-xs text-neutral-500">{item.label}</div>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.15fr_0.85fr]">
        {/* Compose */}
        <form
          onSubmit={handleSubmit}
          className="rounded-2xl border border-neutral-200 bg-white shadow-sm"
        >
          <div className="border-b border-neutral-100 px-5 py-4 sm:px-6">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-violet-100 text-violet-700">
                <i className="fas fa-pen-to-square" />
              </div>
              <div>
                <h2 className="text-base font-bold text-neutral-900">Compose message</h2>
                <p className="text-xs text-neutral-500">Recipients see this in their notification center</p>
              </div>
            </div>
          </div>

          <div className="space-y-5 p-5 sm:p-6">
            <div>
              <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-neutral-500">
                Title
              </label>
              <input
                type="text"
                value={title}
                maxLength={MAX_TITLE_LENGTH}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="e.g. Scheduled maintenance tonight"
                className={INPUT_CLASS}
              />
              <p className="mt-1 text-right text-[11px] text-neutral-400">
                {title.length}/{MAX_TITLE_LENGTH}
              </p>
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-neutral-500">
                Message
              </label>
              <textarea
                value={body}
                maxLength={MAX_BODY_LENGTH}
                onChange={(event) => setBody(event.target.value)}
                rows={5}
                placeholder="Write the announcement recipients will see as a notification."
                className={`${INPUT_CLASS} resize-y min-h-[120px]`}
              />
              <p className="mt-1 text-right text-[11px] text-neutral-400">
                {body.length}/{MAX_BODY_LENGTH}
              </p>
            </div>

            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
                Show on
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <PlatformToggle
                  active={targetAdmin}
                  onClick={() => setTargetAdmin((v) => !v)}
                  icon="fa-desktop"
                  title="Admin panel"
                  description="Web notification bell for owners & branch admins"
                />
                <PlatformToggle
                  active={targetMobile}
                  onClick={() => setTargetMobile((v) => !v)}
                  icon="fa-mobile-screen"
                  title="Mobile app"
                  description="Push notification + in-app inbox"
                />
              </div>
            </div>

            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
                Send to
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <AudienceOption
                  active={audience === "owners"}
                  onClick={() => setAudience("owners")}
                  icon="fa-user-tie"
                  label={BROADCAST_AUDIENCE_LABELS.owners}
                  hint="Workshop owners & branch admins"
                />
                <AudienceOption
                  active={audience === "all"}
                  onClick={() => setAudience("all")}
                  icon="fa-users"
                  label={BROADCAST_AUDIENCE_LABELS.all}
                  hint="Owners, admins, and staff"
                />
              </div>
            </div>

            {formError ? (
              <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700">
                <i className="fas fa-circle-exclamation mt-0.5 shrink-0" />
                <span>{formError}</span>
              </div>
            ) : null}
            {successMessage ? (
              <div className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm text-emerald-800">
                <i className="fas fa-circle-check mt-0.5 shrink-0" />
                <span>{successMessage}</span>
              </div>
            ) : null}

            <div className="flex justify-end border-t border-neutral-100 pt-4">
              <button
                type="submit"
                disabled={!canSubmit}
                className="inline-flex h-11 items-center gap-2 rounded-xl bg-neutral-900 px-6 text-sm font-semibold text-white shadow-sm transition-all hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <i className={`fas ${sending ? "fa-spinner fa-spin" : "fa-paper-plane"}`} />
                {sending ? "Sending…" : "Send message"}
              </button>
            </div>
          </div>
        </form>

        {/* Preview + tips */}
        <div className="space-y-4">
          <div className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm sm:p-6">
            <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-500">
              Preview
            </p>
            <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-4">
              <div className="flex items-start gap-3">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-purple-600 text-white shadow-sm">
                  <i className="fas fa-bullhorn" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate font-bold text-neutral-900">{previewTitle}</p>
                    <span className="shrink-0 rounded-full bg-amber-500 px-2 py-0.5 text-[10px] font-bold uppercase text-white">
                      New
                    </span>
                  </div>
                  <p className="mt-1 line-clamp-4 text-sm leading-relaxed text-neutral-600">
                    {previewBody}
                  </p>
                </div>
              </div>
            </div>
            <p className="mt-3 text-xs text-neutral-500">
              Read-only system message — no reply action. Staff only see this when audience is
              &ldquo;All staff &amp; owners&rdquo;.
            </p>
          </div>

          <div className="rounded-2xl border border-dashed border-neutral-300 bg-white/80 p-5">
            <h3 className="text-sm font-semibold text-neutral-800">Tips</h3>
            <ul className="mt-3 space-y-2 text-sm text-neutral-600">
              <li className="flex gap-2">
                <i className="fas fa-check mt-1 text-emerald-500 text-xs" />
                Keep titles short and action-oriented
              </li>
              <li className="flex gap-2">
                <i className="fas fa-check mt-1 text-emerald-500 text-xs" />
                Recall hides a message without deleting it
              </li>
              <li className="flex gap-2">
                <i className="fas fa-check mt-1 text-emerald-500 text-xs" />
                Mobile push is best-effort — inbox always has the full history
              </li>
            </ul>
          </div>
        </div>
      </div>

      {/* History */}
      <div className="rounded-2xl border border-neutral-200 bg-white shadow-sm">
        <div className="flex flex-col gap-3 border-b border-neutral-100 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-neutral-100 text-neutral-700">
              <i className="fas fa-clock-rotate-left" />
            </div>
            <div>
              <h2 className="text-base font-bold text-neutral-900">Sent messages</h2>
              <p className="text-xs text-neutral-500">Newest first · up to 100 shown</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="inline-flex items-center gap-2 self-start rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm font-medium text-neutral-700 shadow-sm transition-colors hover:bg-neutral-50 disabled:opacity-50"
          >
            <i className={`fas fa-rotate-right ${loading ? "fa-spin" : ""}`} />
            Refresh
          </button>
        </div>

        <div className="p-5 sm:p-6">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-16">
              <i className="fas fa-spinner fa-spin mb-3 text-2xl text-neutral-300" />
              <p className="text-sm text-neutral-500">Loading messages…</p>
            </div>
          ) : listError ? (
            <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-8 text-center">
              <i className="fas fa-triangle-exclamation mb-2 text-red-500" />
              <p className="text-sm text-red-700">{listError}</p>
            </div>
          ) : broadcasts.length === 0 ? (
            <div className="rounded-xl border border-dashed border-neutral-200 bg-neutral-50 px-6 py-16 text-center">
              <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-white shadow-sm">
                <i className="fas fa-inbox text-2xl text-neutral-300" />
              </div>
              <p className="font-semibold text-neutral-800">No messages sent yet</p>
              <p className="mx-auto mt-1 max-w-sm text-sm text-neutral-500">
                Compose your first platform announcement above. It will appear here with delivery
                stats.
              </p>
            </div>
          ) : (
            <ul className="space-y-3">
              {broadcasts.map((record) => (
                <li
                  key={record.id}
                  className={`rounded-xl border p-4 transition-colors sm:p-5 ${
                    record.active
                      ? "border-neutral-200 bg-white hover:border-neutral-300"
                      : "border-neutral-100 bg-neutral-50/80"
                  }`}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="font-bold text-neutral-900">{record.title}</h3>
                        <span
                          className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                            record.active
                              ? "bg-emerald-100 text-emerald-700"
                              : "bg-neutral-200 text-neutral-600"
                          }`}
                        >
                          {record.active ? "Active" : "Recalled"}
                        </span>
                      </div>
                      <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-neutral-600">
                        {record.body}
                      </p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <span className="inline-flex items-center gap-1.5 rounded-lg bg-neutral-100 px-2.5 py-1 text-xs font-medium text-neutral-700">
                          <i className="fas fa-desktop text-neutral-400" />
                          {platformLabel(record)}
                        </span>
                        <span className="inline-flex items-center gap-1.5 rounded-lg bg-neutral-100 px-2.5 py-1 text-xs font-medium text-neutral-700">
                          <i className="fas fa-users text-neutral-400" />
                          {BROADCAST_AUDIENCE_LABELS[record.audience]}
                        </span>
                        {record.platforms.mobile && record.mobilePushCount != null ? (
                          <span className="inline-flex items-center gap-1.5 rounded-lg bg-violet-50 px-2.5 py-1 text-xs font-medium text-violet-700">
                            <i className="fas fa-bell" />
                            {record.mobilePushCount} push
                          </span>
                        ) : null}
                        <span className="inline-flex items-center gap-1.5 rounded-lg bg-neutral-100 px-2.5 py-1 text-xs text-neutral-500">
                          <i className="fas fa-clock" />
                          {relativeTime(record.createdAt)}
                        </span>
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        onClick={() => void toggleActive(record)}
                        disabled={busyId === record.id}
                        title={record.active ? "Recall (hide from recipients)" : "Re-activate"}
                        className="flex h-9 w-9 items-center justify-center rounded-lg border border-neutral-200 bg-white text-neutral-500 transition-colors hover:bg-neutral-50 hover:text-neutral-800 disabled:opacity-60"
                      >
                        <i
                          className={`fas ${
                            busyId === record.id
                              ? "fa-spinner fa-spin"
                              : record.active
                                ? "fa-eye-slash"
                                : "fa-eye"
                          }`}
                        />
                      </button>
                      <button
                        type="button"
                        onClick={() => setPendingDelete(record)}
                        title="Delete permanently"
                        className="flex h-9 w-9 items-center justify-center rounded-lg border border-neutral-200 bg-white text-neutral-500 transition-colors hover:border-red-200 hover:bg-red-50 hover:text-red-600"
                      >
                        <i className="fas fa-trash" />
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <DeleteConfirmModal
        open={pendingDelete != null}
        title="Delete message?"
        description="This permanently removes the message. Recipients who already saw it keep their copy, but it will no longer be delivered to anyone new."
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => void confirmDelete()}
        isLoading={deleting}
      />
    </div>
  );
}
