"use client";

import { useEffect, useMemo, useState } from "react";
import { authFetch } from "@/lib/sms/client-auth";

type SmsPackage = {
  id: string;
  name: string;
  price: number;
  priceLabel: string;
  messageQuota: number;
  description?: string;
  features: string[];
  active: boolean;
  hidden: boolean;
  popular?: boolean;
  color?: string;
  icon?: string;
  plan_key?: string;
};

const COLOR_OPTIONS = [
  { value: "blue", label: "Blue", gradient: "from-blue-500 to-indigo-600" },
  { value: "pink", label: "Dark", gradient: "from-neutral-600 to-neutral-800" },
  { value: "purple", label: "Purple", gradient: "from-purple-500 to-violet-600" },
  { value: "green", label: "Green", gradient: "from-emerald-500 to-teal-600" },
  { value: "orange", label: "Orange", gradient: "from-orange-500 to-amber-600" },
  { value: "teal", label: "Teal", gradient: "from-teal-500 to-cyan-600" },
];

function suggestSmsPriceLabel(price: string): string {
  const n = parseFloat(price);
  if (!Number.isFinite(n) || n <= 0) return "";
  const formatted = n % 1 === 0 ? n.toFixed(0) : n.toFixed(2);
  return `AU$${formatted} one-time`;
}

const INPUT_CLASS =
  "w-full bg-white border border-neutral-200 rounded-xl text-neutral-900 placeholder-neutral-400 focus:ring-2 focus:ring-neutral-900 focus:border-transparent transition-all text-sm font-medium";

export function SmsPackageBuildModal({
  open,
  initial,
  onClose,
  onSaved,
}: {
  open: boolean;
  initial: SmsPackage | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: "",
    price: "",
    priceLabel: "",
    messageQuota: "",
    unlimitedQuota: false,
    description: "",
    features: "",
    active: true,
    hidden: false,
    popular: false,
    color: "blue",
    plan_key: "",
  });

  useEffect(() => {
    if (!open) return;
    setError(null);
    if (initial) {
      const unlimited = initial.messageQuota < 0;
      setForm({
        name: initial.name,
        price: String(initial.price),
        priceLabel: initial.priceLabel,
        messageQuota: unlimited ? "1000" : String(initial.messageQuota),
        unlimitedQuota: unlimited,
        description: initial.description ?? "",
        features: (initial.features ?? []).join("\n"),
        active: initial.active,
        hidden: initial.hidden,
        popular: !!initial.popular,
        color: initial.color ?? "blue",
        plan_key: initial.plan_key ?? "",
      });
    } else {
      setForm({
        name: "",
        price: "",
        priceLabel: "",
        messageQuota: "100",
        unlimitedQuota: false,
        description: "",
        features: "",
        active: true,
        hidden: false,
        popular: false,
        color: "blue",
        plan_key: "",
      });
    }
  }, [open, initial]);

  const selectedColor = COLOR_OPTIONS.find((c) => c.value === form.color) || COLOR_OPTIONS[0];
  const previewFeatures = useMemo(
    () =>
      form.features
        .split("\n")
        .map((f) => f.trim())
        .filter(Boolean),
    [form.features],
  );

  const quotaDisplay = form.unlimitedQuota
    ? "Unlimited"
    : form.messageQuota || "0";

  if (!open) return null;

  const save = async () => {
    setSaving(true);
    setError(null);

    if (!form.name.trim() || !form.priceLabel.trim() || form.price === "") {
      setError("Package name, price, and display label are required.");
      setSaving(false);
      return;
    }

    const messageQuota = form.unlimitedQuota ? -1 : Number(form.messageQuota);
    if (!form.unlimitedQuota && (!Number.isFinite(messageQuota) || messageQuota <= 0)) {
      setError("Message quota must be a positive number, or enable unlimited.");
      setSaving(false);
      return;
    }

    const payload = {
      ...(initial ? { id: initial.id } : {}),
      name: form.name.trim(),
      price: Number(form.price),
      priceLabel: form.priceLabel.trim(),
      messageQuota,
      description: form.description.trim(),
      features: previewFeatures,
      active: form.active,
      hidden: form.hidden,
      popular: form.popular,
      color: form.color,
      icon: "fa-comment-sms",
      plan_key: form.plan_key.trim() || undefined,
    };

    const result = await authFetch("/api/sms-packages", {
      method: initial ? "PUT" : "POST",
      body: JSON.stringify(payload),
    });
    setSaving(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onSaved();
  };

  return (
    <div className="fixed inset-0 z-50">
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={() => !saving && onClose()}
      />
      <div className="absolute inset-0 flex items-center justify-center p-4 overflow-y-auto">
        <div className="relative my-auto flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-3xl bg-white shadow-2xl">
          {/* Header */}
          <div className="relative flex-shrink-0 rounded-t-3xl bg-neutral-900">
            <div className="px-6 pb-5 pt-6">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-white/10 bg-white/10">
                    <i
                      className={`fas ${initial ? "fa-pen-to-square" : "fa-comment-sms"} text-lg text-amber-400`}
                    />
                  </div>
                  <div>
                    <h3 className="text-xl font-bold tracking-tight text-white">
                      {initial ? "Edit SMS Package" : "Build New SMS Package"}
                    </h3>
                    <p className="mt-0.5 text-sm text-neutral-400">
                      {initial
                        ? "Update this SMS credit pack for workshop owners"
                        : "Create an SMS credit pack owners can purchase"}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => !saving && onClose()}
                  disabled={saving}
                  className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/10 transition-all hover:bg-white/20 disabled:opacity-50"
                >
                  <i className="fas fa-xmark text-white/70" />
                </button>
              </div>
            </div>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto">
            <div className="grid grid-cols-1 gap-0 lg:grid-cols-5">
              {/* Form */}
              <div className="space-y-6 p-6 lg:col-span-3">
                {/* Basic Info */}
                <div>
                  <div className="mb-4 flex items-center gap-2.5">
                    <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-neutral-900">
                      <i className="fas fa-tag text-[10px] text-white" />
                    </div>
                    <h4 className="text-xs font-bold uppercase tracking-widest text-neutral-800">Basic Info</h4>
                  </div>
                  <div className="space-y-4 rounded-2xl border border-neutral-200 bg-neutral-50 p-5">
                    <div>
                      <label className="mb-2 block text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
                        Package Name <span className="text-rose-500">*</span>
                      </label>
                      <div className="relative">
                        <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3.5">
                          <i className="fas fa-box-open text-sm text-neutral-400" />
                        </div>
                        <input
                          type="text"
                          value={form.name}
                          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                          className={`${INPUT_CLASS} pl-10 pr-4 py-3`}
                          placeholder="e.g., Starter, Growth, Pro"
                        />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="mb-2 block text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
                          Price (AUD) <span className="text-rose-500">*</span>
                        </label>
                        <div className="relative">
                          <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3.5">
                            <span className="text-sm font-bold text-neutral-900">$</span>
                          </div>
                          <input
                            type="number"
                            step="0.01"
                            value={form.price}
                            onChange={(e) => {
                              const priceValue = e.target.value;
                              setForm((f) => ({
                                ...f,
                                price: priceValue,
                                priceLabel: priceValue ? suggestSmsPriceLabel(priceValue) : f.priceLabel,
                              }));
                            }}
                            className={`${INPUT_CLASS} py-3 pl-9 pr-4 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none`}
                            placeholder="29.00"
                          />
                        </div>
                      </div>
                      <div>
                        <label className="mb-2 block text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
                          Display Label <span className="text-rose-500">*</span>
                        </label>
                        <input
                          type="text"
                          value={form.priceLabel}
                          onChange={(e) => setForm((f) => ({ ...f, priceLabel: e.target.value }))}
                          className={`${INPUT_CLASS} px-4 py-3`}
                          placeholder="AU$29 one-time"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="mb-2 block text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
                        Description
                      </label>
                      <textarea
                        value={form.description}
                        onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                        rows={2}
                        className={`${INPUT_CLASS} resize-none px-4 py-3`}
                        placeholder="Short summary shown on the owner top-up page"
                      />
                    </div>
                  </div>
                </div>

                {/* SMS Limits */}
                <div>
                  <div className="mb-4 flex items-center gap-2.5">
                    <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-neutral-900">
                      <i className="fas fa-sliders text-[10px] text-white" />
                    </div>
                    <h4 className="text-xs font-bold uppercase tracking-widest text-neutral-800">SMS Limits</h4>
                  </div>
                  <div className="space-y-4 rounded-2xl border border-neutral-200 bg-neutral-50 p-5">
                    <div>
                      <label className="mb-2 block text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
                        Message Quota
                      </label>
                      <div className="relative">
                        <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3.5">
                          <i className="fas fa-comment-sms text-sm text-neutral-400" />
                        </div>
                        <input
                          type="text"
                          inputMode="numeric"
                          value={form.unlimitedQuota ? "unlimited" : form.messageQuota}
                          onChange={(e) => {
                            if (!form.unlimitedQuota) {
                              const value = e.target.value.replace(/[^0-9]/g, "");
                              setForm((f) => ({ ...f, messageQuota: value }));
                            }
                          }}
                          disabled={form.unlimitedQuota}
                          className={`${INPUT_CLASS} py-3 pl-10 pr-4 disabled:cursor-not-allowed disabled:bg-neutral-100`}
                          placeholder="100"
                        />
                      </div>
                      <label className="mt-2 flex cursor-pointer items-center gap-2">
                        <input
                          type="checkbox"
                          checked={form.unlimitedQuota}
                          onChange={(e) =>
                            setForm((f) => ({
                              ...f,
                              unlimitedQuota: e.target.checked,
                            }))
                          }
                          className="h-4 w-4 rounded border-neutral-300 text-neutral-900 focus:ring-neutral-900"
                        />
                        <span className="text-xs text-neutral-600">Unlimited SMS credits</span>
                      </label>
                    </div>
                    <div>
                      <label className="mb-2 block text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
                        Plan Key <span className="font-normal normal-case text-neutral-400">(optional)</span>
                      </label>
                      <div className="relative">
                        <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3.5">
                          <i className="fas fa-key text-sm text-neutral-400" />
                        </div>
                        <input
                          type="text"
                          value={form.plan_key}
                          onChange={(e) =>
                            setForm((f) => ({ ...f, plan_key: e.target.value.toUpperCase() }))
                          }
                          className={`${INPUT_CLASS} py-3 pl-10 pr-4 font-mono`}
                          placeholder="SMS100"
                        />
                      </div>
                    </div>
                  </div>
                </div>

                {/* Features */}
                <div>
                  <div className="mb-4 flex items-center gap-2.5">
                    <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-neutral-900">
                      <i className="fas fa-list-check text-[10px] text-white" />
                    </div>
                    <h4 className="text-xs font-bold uppercase tracking-widest text-neutral-800">Features</h4>
                    {previewFeatures.length > 0 && (
                      <span className="ml-auto rounded-full border border-neutral-200 bg-neutral-100 px-2.5 py-0.5 text-[10px] font-semibold text-neutral-600">
                        {previewFeatures.length} {previewFeatures.length === 1 ? "feature" : "features"}
                      </span>
                    )}
                  </div>
                  <div className="rounded-2xl border border-neutral-200 bg-neutral-50 p-5">
                    <textarea
                      value={form.features}
                      onChange={(e) => setForm((f) => ({ ...f, features: e.target.value }))}
                      rows={5}
                      className={`${INPUT_CLASS} resize-none px-4 py-3`}
                      placeholder={"100 SMS credits\nNever expires\nDelivery log included\nCustom messages"}
                    />
                    <p className="mt-2 flex items-center gap-1.5 text-[10px] text-neutral-400">
                      <i className="fas fa-info-circle" />
                      One feature per line — each becomes a bullet point
                    </p>
                  </div>
                </div>

                {/* Appearance */}
                <div>
                  <div className="mb-4 flex items-center gap-2.5">
                    <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-neutral-900">
                      <i className="fas fa-palette text-[10px] text-white" />
                    </div>
                    <h4 className="text-xs font-bold uppercase tracking-widest text-neutral-800">Appearance</h4>
                  </div>
                  <div className="rounded-2xl border border-neutral-200 bg-neutral-50 p-5">
                    <label className="mb-3 block text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
                      Theme Color
                    </label>
                    <div className="flex flex-wrap items-center gap-3">
                      {COLOR_OPTIONS.map((color) => (
                        <button
                          key={color.value}
                          type="button"
                          onClick={() => setForm((f) => ({ ...f, color: color.value }))}
                          className={`group relative h-11 w-11 rounded-xl bg-gradient-to-br ${color.gradient} transition-all duration-200 hover:scale-110 ${
                            form.color === color.value
                              ? "scale-110 shadow-lg ring-2 ring-neutral-900 ring-offset-2"
                              : "ring-1 ring-black/10 hover:shadow-md"
                          }`}
                          title={color.label}
                        >
                          {form.color === color.value && (
                            <div className="absolute inset-0 flex items-center justify-center">
                              <i className="fas fa-check text-xs text-white drop-shadow-md" />
                            </div>
                          )}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Options */}
                <div>
                  <div className="mb-4 flex items-center gap-2.5">
                    <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-neutral-900">
                      <i className="fas fa-gears text-[10px] text-white" />
                    </div>
                    <h4 className="text-xs font-bold uppercase tracking-widest text-neutral-800">Options</h4>
                  </div>
                  <div className="space-y-2">
                    <ToggleRow
                      active={form.active}
                      onToggle={() => setForm((f) => ({ ...f, active: !f.active }))}
                      activeClass="bg-emerald-50 border-emerald-200"
                      icon="fa-power-off"
                      iconActiveClass="bg-emerald-100 text-emerald-600"
                      title="Active"
                      subtitle={form.active ? "Package is live and available" : "Package is disabled"}
                      toggleClass="bg-emerald-500"
                    />
                    <ToggleRow
                      active={form.popular}
                      onToggle={() => setForm((f) => ({ ...f, popular: !f.popular }))}
                      activeClass="bg-amber-50 border-amber-200"
                      icon="fa-crown"
                      iconActiveClass="bg-amber-100 text-amber-500"
                      title="Most Popular"
                      subtitle={form.popular ? "Highlighted with a badge" : "Standard display"}
                      toggleClass="bg-amber-500"
                    />
                    <ToggleRow
                      active={form.hidden}
                      onToggle={() => setForm((f) => ({ ...f, hidden: !f.hidden }))}
                      activeClass="bg-rose-50 border-rose-200"
                      icon="fa-eye-slash"
                      iconActiveClass="bg-rose-100 text-rose-500"
                      title="Hidden"
                      subtitle={
                        form.hidden
                          ? "Excluded from owner top-up list"
                          : "Visible to workshop owners"
                      }
                      toggleClass="bg-rose-500"
                    />
                  </div>
                </div>

                {error && (
                  <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                    {error}
                  </div>
                )}
              </div>

              {/* Live Preview */}
              <div className="flex flex-col border-l border-neutral-200 bg-neutral-50 p-6 lg:col-span-2">
                <div className="mb-5 flex items-center gap-2.5">
                  <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-neutral-900">
                    <i className="fas fa-eye text-[10px] text-white" />
                  </div>
                  <h4 className="text-xs font-bold uppercase tracking-widest text-neutral-800">Live Preview</h4>
                  <div className="ml-auto flex items-center gap-1.5">
                    <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
                    <span className="text-[9px] font-medium uppercase tracking-wider text-neutral-400">Live</span>
                  </div>
                </div>

                <div className="flex-shrink-0 overflow-visible rounded-2xl border border-neutral-200 bg-white shadow-xl">
                  <div className="relative">
                    <div
                      className={`relative h-28 overflow-hidden rounded-t-2xl bg-gradient-to-br ${selectedColor.gradient}`}
                    >
                      <div className="absolute -right-8 -top-8 h-32 w-32 rounded-full bg-white/10" />
                      <div className="absolute -bottom-8 -left-8 h-28 w-28 rounded-full bg-white/10" />
                      {form.popular && (
                        <div className="absolute left-3 top-3 flex items-center gap-1 rounded-full bg-white/20 px-2.5 py-1 text-[9px] font-bold text-white backdrop-blur-sm">
                          <i className="fas fa-crown text-[8px] text-yellow-300" />
                          Popular
                        </div>
                      )}
                      {form.hidden && (
                        <div className="absolute right-3 top-3 flex items-center gap-1 rounded-full bg-black/30 px-2.5 py-1 text-[9px] font-semibold text-white backdrop-blur-sm">
                          <i className="fas fa-eye-slash text-[8px]" />
                          Hidden
                        </div>
                      )}
                    </div>
                    <div className="absolute -bottom-9 left-1/2 z-10 -translate-x-1/2">
                      <div className="flex h-[72px] w-[72px] items-center justify-center overflow-hidden rounded-2xl bg-white shadow-xl ring-4 ring-white">
                        <i
                          className={`fas fa-comment-sms bg-gradient-to-br text-xl ${selectedColor.gradient} bg-clip-text text-transparent`}
                        />
                      </div>
                    </div>
                  </div>

                  <div className="px-5 pb-6 pt-12">
                    <div className="mb-5 text-center">
                      <h3 className="mb-1 text-lg font-bold text-neutral-900">
                        {form.name || "Package Name"}
                      </h3>
                      <div
                        className={`bg-gradient-to-r text-3xl font-extrabold ${selectedColor.gradient} bg-clip-text text-transparent`}
                      >
                        {form.priceLabel || "AU$0 one-time"}
                      </div>
                      <p className="mt-1 text-[11px] font-semibold text-neutral-600">One-time SMS top-up</p>
                      <div className="mt-2 flex items-center justify-center gap-2 text-[11px] text-neutral-500">
                        <span className="flex items-center gap-1">
                          <i className="fas fa-comment-sms text-[9px]" />
                          {quotaDisplay} SMS
                        </span>
                      </div>
                    </div>

                    <div className="mb-4 h-px bg-gradient-to-r from-transparent via-neutral-200 to-transparent" />

                    {previewFeatures.length > 0 ? (
                      <ul className="space-y-2.5">
                        {previewFeatures.slice(0, 6).map((feature, idx) => (
                          <li key={idx} className="flex items-start gap-2.5">
                            <div
                              className={`flex h-[18px] w-[18px] min-h-[18px] min-w-[18px] flex-shrink-0 items-center justify-center rounded-full bg-gradient-to-br ${selectedColor.gradient} mt-0.5`}
                            >
                              <i className="fas fa-check text-[7px] text-white" />
                            </div>
                            <span className="text-xs leading-relaxed text-neutral-600">{feature}</span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <div className="py-6 text-center">
                        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-neutral-100">
                          <i className="fas fa-list text-lg text-neutral-300" />
                        </div>
                        <p className="text-[10px] text-neutral-400">Add features to see them here</p>
                      </div>
                    )}
                  </div>
                </div>

                <div className="mt-5 space-y-2.5 rounded-xl border border-neutral-200 bg-white p-4">
                  <p className="mb-2 text-[9px] font-bold uppercase tracking-widest text-neutral-400">Status</p>
                  <StatusDot
                    active={form.active}
                    activeLabel="Active — visible to owners"
                    inactiveLabel="Inactive — not available"
                  />
                  {form.plan_key && (
                    <div className="flex items-center gap-2.5 text-[11px]">
                      <div className="h-2 w-2 rounded-full bg-neutral-900" />
                      <span className="text-neutral-500">
                        Key: <span className="font-mono font-bold text-neutral-800">{form.plan_key}</span>
                      </span>
                    </div>
                  )}
                  {form.popular && (
                    <div className="flex items-center gap-2.5 text-[11px]">
                      <div className="h-2 w-2 rounded-full bg-amber-500" />
                      <span className="text-neutral-500">Marked as popular</span>
                    </div>
                  )}
                  {form.hidden && (
                    <div className="flex items-center gap-2.5 text-[11px]">
                      <div className="h-2 w-2 rounded-full bg-rose-500" />
                      <span className="text-neutral-500">Hidden from owners</span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="flex flex-shrink-0 items-center justify-between gap-3 rounded-b-3xl border-t border-neutral-100 bg-white px-6 py-4">
            <p className="flex max-sm:hidden items-center gap-1.5 text-[10px] text-neutral-400">
              <i className="fas fa-shield-halved text-neutral-300" />
              Changes are saved securely to your database
            </p>
            <div className="ml-auto flex items-center gap-3">
              <button
                type="button"
                onClick={() => !saving && onClose()}
                disabled={saving}
                className="rounded-xl px-5 py-2.5 text-sm font-semibold text-neutral-500 transition-all hover:bg-neutral-100 hover:text-neutral-700 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={() => void save()}
                className="flex items-center gap-2 rounded-xl bg-neutral-900 px-7 py-2.5 text-sm font-bold text-white shadow-lg shadow-neutral-900/20 transition-all hover:bg-neutral-800 disabled:opacity-50"
              >
                {saving ? (
                  <>
                    <i className="fas fa-circle-notch fa-spin" />
                    Saving…
                  </>
                ) : (
                  <>
                    <i className={`fas ${initial ? "fa-save" : "fa-plus"}`} />
                    {initial ? "Update Package" : "Create Package"}
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ToggleRow({
  active,
  onToggle,
  activeClass,
  icon,
  iconActiveClass,
  title,
  subtitle,
  toggleClass,
}: {
  active: boolean;
  onToggle: () => void;
  activeClass: string;
  icon: string;
  iconActiveClass: string;
  title: string;
  subtitle: string;
  toggleClass: string;
}) {
  return (
    <div
      className={`flex items-center justify-between rounded-xl border p-4 transition-all ${
        active ? activeClass : "border-neutral-200 bg-neutral-50"
      }`}
    >
      <div className="flex items-center gap-3">
        <div
          className={`flex h-9 w-9 items-center justify-center rounded-lg transition-all ${
            active ? iconActiveClass : "bg-neutral-100"
          }`}
        >
          <i className={`fas ${icon} text-xs ${active ? "" : "text-neutral-400"}`} />
        </div>
        <div>
          <p className={`text-sm font-semibold ${active ? "text-neutral-900" : "text-neutral-500"}`}>{title}</p>
          <p className="text-[10px] text-neutral-400">{subtitle}</p>
        </div>
      </div>
      <button
        type="button"
        onClick={onToggle}
        className={`relative h-7 w-12 rounded-full transition-all duration-300 ${
          active ? toggleClass : "bg-neutral-300"
        }`}
      >
        <div
          className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow-md transition-all duration-300 ${
            active ? "left-[21px]" : "left-0.5"
          }`}
        />
      </button>
    </div>
  );
}

function StatusDot({
  active,
  activeLabel,
  inactiveLabel,
}: {
  active: boolean;
  activeLabel: string;
  inactiveLabel: string;
}) {
  return (
    <div className="flex items-center gap-2.5 text-[11px]">
      <div className={`h-2 w-2 rounded-full ${active ? "bg-emerald-500" : "bg-neutral-300"}`} />
      <span className="text-neutral-500">{active ? activeLabel : inactiveLabel}</span>
    </div>
  );
}
