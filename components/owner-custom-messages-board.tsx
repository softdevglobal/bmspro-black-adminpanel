"use client";

import { auth } from "@/lib/firebase";
import {
  GREETING_AUDIENCE_LABELS,
  MAX_GREETING_MESSAGE_LENGTH,
  type GreetingAudience,
} from "@/lib/greetingMessages/types";
import { useCallback, useEffect, useMemo, useState } from "react";

const INPUT_CLASS =
  "w-full rounded-lg border border-neutral-300 bg-white px-3.5 py-2.5 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-900 focus:outline-none focus:ring-2 focus:ring-neutral-900/10";

type RecipientPreview = {
  audience: GreetingAudience;
  audienceLabel: string;
  total: number;
  customers: number;
  staff: number;
  smsConfigured: boolean;
};

type SendResult = {
  sent: number;
  failed: number;
  skipped: number;
  total: number;
  errors: string[];
};

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

const TEMPLATES = [
  {
    label: "Blank",
    text: "",
    group: "custom",
  },
  {
    label: "General greeting",
    text: "Hi {name}, thank you for being part of our workshop family. We appreciate you!",
    group: "greeting",
  },
  {
    label: "Holiday wishes",
    text: "Hi {name}, warm holiday wishes from our team. Thank you for your continued support!",
    group: "greeting",
  },
  {
    label: "New year",
    text: "Hi {name}, happy new year from all of us! Wishing you a great year ahead.",
    group: "greeting",
  },
  {
    label: "Special offer",
    text: "Hi {name}, we have a special offer running this week. Contact us or book online to learn more.",
    group: "custom",
  },
  {
    label: "Service reminder",
    text: "Hi {name}, friendly reminder that your vehicle service is due soon. Book a time that suits you.",
    group: "custom",
  },
  {
    label: "Workshop update",
    text: "Hi {name}, quick update from our team: [add your message here]. Thank you for your patience.",
    group: "custom",
  },
] as const;

function AudienceOption({
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
          ? "border-amber-300 bg-amber-50 shadow-sm ring-1 ring-amber-200"
          : "border-neutral-200 bg-white hover:border-neutral-300 hover:bg-neutral-50"
      }`}
    >
      <div
        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${
          active ? "bg-amber-600 text-white" : "bg-neutral-100 text-neutral-500"
        }`}
      >
        <i className={`fas ${icon}`} />
      </div>
      <div>
        <p className="text-sm font-semibold text-neutral-900">{title}</p>
        <p className="mt-0.5 text-xs text-neutral-500">{description}</p>
      </div>
    </button>
  );
}

export function OwnerCustomMessagesBoard() {
  const [audience, setAudience] = useState<GreetingAudience>("both");
  const [message, setMessage] = useState("");
  const [preview, setPreview] = useState<RecipientPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sendResult, setSendResult] = useState<SendResult | null>(null);

  const charsLeft = MAX_GREETING_MESSAGE_LENGTH - message.length;
  const canSend = message.trim().length > 0 && charsLeft >= 0 && (preview?.total ?? 0) > 0;

  const previewSummary = useMemo(() => {
    if (!preview) return null;
    if (audience === "customers") {
      return `${preview.customers} customer${preview.customers === 1 ? "" : "s"} with a valid phone number`;
    }
    if (audience === "staff") {
      return `${preview.staff} staff member${preview.staff === 1 ? "" : "s"} with a valid phone number`;
    }
    return `${preview.total} recipient${preview.total === 1 ? "" : "s"} (${preview.customers} customers, ${preview.staff} staff)`;
  }, [audience, preview]);

  const loadPreview = useCallback(async (nextAudience: GreetingAudience) => {
    setPreviewLoading(true);
    setPreviewError(null);
    const result = await authFetch<RecipientPreview>(
      `/api/greeting-messages/recipients?audience=${encodeURIComponent(nextAudience)}`,
    );
    setPreviewLoading(false);
    if (!result.ok) {
      setPreview(null);
      setPreviewError(result.error);
      return;
    }
    setPreview(result.data);
  }, []);

  useEffect(() => {
    void loadPreview(audience);
  }, [audience, loadPreview]);

  const handleSend = async () => {
    setSending(true);
    setSendError(null);
    setSendResult(null);
    const result = await authFetch<SendResult>("/api/greeting-messages/send", {
      method: "POST",
      body: JSON.stringify({ message: message.trim(), audience }),
    });
    setSending(false);
    setConfirmOpen(false);
    if (!result.ok) {
      setSendError(result.error);
      return;
    }
    setSendResult(result.data);
    void loadPreview(audience);
  };

  const greetingTemplates = TEMPLATES.filter((t) => t.group === "greeting");
  const customTemplates = TEMPLATES.filter((t) => t.group === "custom");

  return (
    <div className="space-y-6">
      {!preview?.smsConfigured && preview && !previewLoading && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <i className="fas fa-triangle-exclamation mr-2" />
          SMS is not configured on the server. Add <code className="text-xs">TEXTBEE_API_KEY</code> and{" "}
          <code className="text-xs">TEXTBEE_DEVICE_ID</code> to your environment.
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-5">
        <div className="space-y-6 lg:col-span-3">
          <section className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm sm:p-6">
            <h2 className="text-base font-semibold text-neutral-900">Audience</h2>
            <p className="mt-1 text-sm text-neutral-500">
              Choose who should receive your custom SMS.
            </p>
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <AudienceOption
                active={audience === "customers"}
                onClick={() => setAudience("customers")}
                icon="fa-user-group"
                title="Customers"
                description="Saved customers with a mobile number"
              />
              <AudienceOption
                active={audience === "staff"}
                onClick={() => setAudience("staff")}
                icon="fa-users"
                title="Staff"
                description="Active staff and branch admins"
              />
              <AudienceOption
                active={audience === "both"}
                onClick={() => setAudience("both")}
                icon="fa-people-group"
                title="Both"
                description="Customers and staff together"
              />
            </div>
          </section>

          <section className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm sm:p-6">
            <div>
              <h2 className="text-base font-semibold text-neutral-900">Custom message</h2>
              <p className="mt-1 text-sm text-neutral-500">
                Write any SMS you like — greetings, promotions, reminders, or updates. Use{" "}
                <code className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs">{"{name}"}</code> to
                personalize each message.
              </p>
            </div>

            <div className="mt-4 space-y-3">
              <div>
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-neutral-400">
                  Greeting templates
                </p>
                <div className="flex flex-wrap gap-2">
                  {greetingTemplates.map((preset) => (
                    <button
                      key={preset.label}
                      type="button"
                      onClick={() => setMessage(preset.text)}
                      className="rounded-full border border-neutral-200 bg-neutral-50 px-3 py-1.5 text-xs font-medium text-neutral-700 transition hover:border-neutral-300 hover:bg-white"
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-neutral-400">
                  Custom templates
                </p>
                <div className="flex flex-wrap gap-2">
                  {customTemplates.map((preset) => (
                    <button
                      key={preset.label}
                      type="button"
                      onClick={() => setMessage(preset.text)}
                      className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-800 transition hover:border-amber-300 hover:bg-amber-100"
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={6}
              maxLength={MAX_GREETING_MESSAGE_LENGTH + 50}
              placeholder="Write your custom SMS here. Example: Hi {name}, we're open this Saturday for walk-ins."
              className={`${INPUT_CLASS} mt-4 resize-y`}
            />
            <p
              className={`mt-2 text-right text-xs font-medium ${
                charsLeft < 0 ? "text-red-600" : charsLeft < 40 ? "text-amber-600" : "text-neutral-400"
              }`}
            >
              {charsLeft} characters left
            </p>
          </section>
        </div>

        <div className="space-y-6 lg:col-span-2">
          <section className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm sm:p-6">
            <h2 className="text-base font-semibold text-neutral-900">Delivery preview</h2>
            <p className="mt-1 text-sm text-neutral-500">
              Review audience and recipient count before sending.
            </p>

            <div className="mt-5 rounded-xl bg-neutral-50 p-4">
              {previewLoading ? (
                <div className="flex items-center gap-2 text-sm text-neutral-500">
                  <i className="fas fa-spinner fa-spin" />
                  Counting recipients…
                </div>
              ) : previewError ? (
                <p className="text-sm text-red-600">{previewError}</p>
              ) : preview ? (
                <div className="space-y-3">
                  <div>
                    <p className="text-xs font-medium uppercase tracking-wide text-neutral-400">Audience</p>
                    <p className="mt-1 text-sm font-semibold text-neutral-900">
                      {GREETING_AUDIENCE_LABELS[audience]}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs font-medium uppercase tracking-wide text-neutral-400">Recipients</p>
                    <p className="mt-1 text-2xl font-bold text-neutral-900">{preview.total}</p>
                    <p className="mt-1 text-sm text-neutral-500">{previewSummary}</p>
                  </div>
                  <div className="rounded-lg border border-neutral-200 bg-white p-3">
                    <p className="text-xs font-medium uppercase tracking-wide text-neutral-400">Sample</p>
                    <p className="mt-2 whitespace-pre-wrap text-sm text-neutral-700">
                      {message.trim().replace(/\{name\}/gi, "Alex") || "Your message will appear here."}
                    </p>
                  </div>
                </div>
              ) : null}
            </div>

            <button
              type="button"
              disabled={!canSend || sending || previewLoading || !preview?.smsConfigured}
              onClick={() => setConfirmOpen(true)}
              className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-neutral-900 px-4 py-3 text-sm font-semibold text-white transition hover:bg-neutral-800 disabled:cursor-not-allowed disabled:bg-neutral-300"
            >
              <i className="fas fa-paper-plane" />
              Send custom message
            </button>
          </section>

          {sendResult && (
            <section className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5 text-sm text-emerald-900">
              <p className="font-semibold">Custom message sent</p>
              <p className="mt-2">
                Delivered to {sendResult.sent} of {sendResult.total} recipient
                {sendResult.total === 1 ? "" : "s"}.
              </p>
              {sendResult.failed > 0 && (
                <p className="mt-1 text-emerald-800">{sendResult.failed} failed to send.</p>
              )}
              {sendResult.errors.length > 0 && (
                <ul className="mt-2 list-disc space-y-1 pl-5 text-emerald-800">
                  {sendResult.errors.map((err) => (
                    <li key={err}>{err}</li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {sendError && (
            <section className="rounded-2xl border border-red-200 bg-red-50 p-5 text-sm text-red-800">
              <p className="font-semibold">Could not send custom message</p>
              <p className="mt-2">{sendError}</p>
            </section>
          )}
        </div>
      </div>

      {confirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
            <h3 className="text-lg font-semibold text-neutral-900">Send custom message?</h3>
            <p className="mt-2 text-sm text-neutral-600">
              This will send your SMS to {preview?.total ?? 0} recipient
              {(preview?.total ?? 0) === 1 ? "" : "s"}. This action cannot be undone.
            </p>
            <div className="mt-5 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setConfirmOpen(false)}
                disabled={sending}
                className="rounded-lg border border-neutral-200 px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleSend()}
                disabled={sending}
                className="inline-flex items-center gap-2 rounded-lg bg-neutral-900 px-4 py-2 text-sm font-semibold text-white hover:bg-neutral-800 disabled:bg-neutral-400"
              >
                {sending ? (
                  <>
                    <i className="fas fa-spinner fa-spin" />
                    Sending…
                  </>
                ) : (
                  "Confirm send"
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
