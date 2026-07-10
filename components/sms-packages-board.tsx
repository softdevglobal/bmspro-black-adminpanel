"use client";

import { useCallback, useEffect, useState } from "react";
import { SmsPackageBuildModal } from "@/components/sms-package-build-modal";
import { authFetch, useAuthUser } from "@/lib/sms/client-auth";

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
  plan_key?: string | null;
  stripePriceId?: string | null;
  stripeProductId?: string | null;
};

const COLOR_STYLES: Record<
  string,
  { iconBg: string; dot: string; shadow: string; badge: string; iconClass: string }
> = {
  blue: {
    iconBg: "bg-blue-500",
    dot: "bg-blue-500",
    shadow: "shadow-[0_12px_40px_rgba(59,130,246,0.22)]",
    badge: "bg-blue-50 text-blue-600",
    iconClass: "fa-comment-dots",
  },
  purple: {
    iconBg: "bg-violet-500",
    dot: "bg-violet-500",
    shadow: "shadow-[0_12px_40px_rgba(139,92,246,0.24)]",
    badge: "bg-violet-50 text-violet-600",
    iconClass: "fa-comment-dots",
  },
  pink: {
    iconBg: "bg-neutral-800",
    dot: "bg-neutral-700",
    shadow: "shadow-[0_12px_40px_rgba(64,64,64,0.18)]",
    badge: "bg-neutral-100 text-neutral-700",
    iconClass: "fa-comment-dots",
  },
  green: {
    iconBg: "bg-emerald-500",
    dot: "bg-emerald-500",
    shadow: "shadow-[0_12px_40px_rgba(16,185,129,0.22)]",
    badge: "bg-emerald-50 text-emerald-700",
    iconClass: "fa-comment-dots",
  },
  orange: {
    iconBg: "bg-orange-500",
    dot: "bg-orange-500",
    shadow: "shadow-[0_12px_40px_rgba(249,115,22,0.22)]",
    badge: "bg-orange-50 text-orange-700",
    iconClass: "fa-comment-dots",
  },
  teal: {
    iconBg: "bg-teal-500",
    dot: "bg-teal-500",
    shadow: "shadow-[0_12px_40px_rgba(20,184,166,0.22)]",
    badge: "bg-teal-50 text-teal-700",
    iconClass: "fa-comment-dots",
  },
};

function packageStyles(color?: string) {
  return COLOR_STYLES[color ?? "blue"] ?? COLOR_STYLES.blue;
}

function formatDisplayPrice(pkg: SmsPackage): string {
  const label = (pkg.priceLabel || "").trim();
  if (label) {
    const match = label.match(/(?:AU\$|A\$|\$|USD\s?)?[\d,]+(?:\.\d{1,2})?/i);
    if (match) {
      const raw = match[0].replace(/USD\s?/i, "").trim();
      if (/^(AU\$|A\$|\$)/i.test(raw)) return raw.replace(/^A\$/, "AU$");
      return `AU$${raw}`;
    }
  }
  const amount = pkg.price % 1 === 0 ? pkg.price.toFixed(0) : pkg.price.toFixed(2);
  return `AU$${amount}`;
}

function defaultFeatures(pkg: SmsPackage): string[] {
  if (pkg.features?.length) return pkg.features;
  const quota = pkg.messageQuota < 0 ? "Unlimited" : `${pkg.messageQuota.toLocaleString()}`;
  return [`${quota} SMS messages`, "Transactional notifications", "Customer alerts"];
}

export function SmsPackagesBoard() {
  const { ready: authReady } = useAuthUser();
  const [packages, setPackages] = useState<SmsPackage[]>([]);
  const [tenantCounts, setTenantCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<SmsPackage | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const result = await authFetch<{ packages: SmsPackage[]; tenantCounts: Record<string, number> }>(
      "/api/sms-packages",
    );
    if (!result.ok) {
      setError(result.error);
      setPackages([]);
    } else {
      setPackages(result.data.packages ?? []);
      setTenantCounts(result.data.tenantCounts ?? {});
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!authReady) return;
    void load();
  }, [authReady, load]);

  const remove = async (id: string) => {
    if (!confirm("Delete this SMS package?")) return;
    const result = await authFetch<{ ok: boolean }>(`/api/sms-packages?id=${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    if (!result.ok) {
      setError(result.error);
      return;
    }
    void load();
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4 rounded-2xl bg-gradient-to-r from-neutral-900 to-neutral-700 p-6 text-white">
        <div>
          <h1 className="text-2xl font-bold">SMS Packages</h1>
          <p className="mt-1 text-sm text-neutral-300">
            Manage purchasable SMS credit packs for workshop owners.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setEditing(null);
            setModalOpen(true);
          }}
          className="rounded-xl bg-white px-4 py-2.5 text-sm font-semibold text-neutral-900 hover:bg-neutral-100"
        >
          <i className="fas fa-plus mr-2" />
          Build New Package
        </button>
      </div>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-red-700">{error}</div>
      )}

      {loading ? (
        <div className="rounded-2xl border border-neutral-200 bg-white p-10 text-center text-neutral-500">
          <i className="fas fa-spinner fa-spin mr-2" />
          Loading packages…
        </div>
      ) : packages.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-neutral-300 bg-white p-10 text-center">
          <i className="fas fa-comment-sms mb-3 text-3xl text-neutral-300" />
          <h2 className="text-lg font-semibold text-neutral-900">No SMS packages yet</h2>
          <p className="mt-1 text-sm text-neutral-500">
            Create your first package so workshop owners can top up SMS credits.
          </p>
          <button
            type="button"
            onClick={() => {
              setEditing(null);
              setModalOpen(true);
            }}
            className="mt-4 rounded-xl bg-neutral-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-neutral-800"
          >
            <i className="fas fa-plus mr-2" />
            Build New Package
          </button>
        </div>
      ) : (
        <section>
          <div className="mb-6">
            <h2 className="font-serif text-3xl font-bold text-neutral-900">Available SMS Plans</h2>
            <p className="mt-2 max-w-2xl text-sm text-neutral-500">
              These packages appear on the owner SMS Credits page for top-ups.
            </p>
          </div>

          <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
            {packages.map((pkg) => {
              const styles = packageStyles(pkg.color);
              const displayPrice = formatDisplayPrice(pkg);
              const quotaLabel =
                pkg.messageQuota < 0 ? "Unlimited" : pkg.messageQuota.toLocaleString();
              const features = defaultFeatures(pkg);
              const tenants = tenantCounts[pkg.id] ?? 0;

              return (
                <article
                  key={pkg.id}
                  className={`group relative flex flex-col overflow-hidden rounded-2xl border border-neutral-100 bg-white ${styles.shadow} transition-all duration-300 ease-out hover:-translate-y-1.5 hover:scale-[1.015] hover:shadow-[0_20px_50px_rgba(15,23,42,0.16)]`}
                >
                  <div className="flex items-start gap-3 px-5 pb-3 pt-5">
                    <div
                      className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-white transition-transform duration-300 group-hover:scale-110 ${styles.iconBg}`}
                    >
                      <i className={`fas ${pkg.icon || styles.iconClass} text-lg`} />
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <h3 className="truncate text-lg font-bold text-neutral-900">{pkg.name}</h3>
                          {pkg.plan_key && (
                            <p className="mt-0.5 text-xs font-semibold uppercase tracking-wider text-neutral-400">
                              {pkg.plan_key}
                            </p>
                          )}
                        </div>

                        <div className="flex shrink-0 items-start gap-2">
                          <div
                            className={`rounded-xl px-3 py-1.5 text-center leading-tight transition-transform duration-300 group-hover:scale-105 ${styles.badge}`}
                          >
                            <div className="text-[10px] font-bold uppercase tracking-wide">Top-up</div>
                            <div className="text-sm font-bold">{displayPrice}</div>
                          </div>
                          <button
                            type="button"
                            onClick={() => {
                              setEditing(pkg);
                              setModalOpen(true);
                            }}
                            className="mt-0.5 rounded-lg p-1.5 text-neutral-300 opacity-60 transition-all duration-200 hover:bg-neutral-100 hover:text-neutral-700 hover:opacity-100 group-hover:opacity-100"
                            title="Edit package"
                          >
                            <i className="fas fa-pen text-xs" />
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-1.5 px-5 pb-3">
                    {pkg.popular && (
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-800">
                        Popular
                      </span>
                    )}
                    {!pkg.active && (
                      <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-neutral-600">
                        Inactive
                      </span>
                    )}
                    {pkg.hidden && (
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-800">
                        Hidden
                      </span>
                    )}
                    {pkg.stripePriceId ? (
                      <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-indigo-800">
                        Stripe linked
                      </span>
                    ) : (
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-800">
                        Stripe not linked
                      </span>
                    )}
                  </div>

                  <div className="px-5 pb-4">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-neutral-400">
                      Messages
                    </p>
                    <p className="mt-1 text-4xl font-bold leading-none text-neutral-900">{quotaLabel}</p>
                    {pkg.description && (
                      <p className="mt-3 text-sm text-neutral-500">{pkg.description}</p>
                    )}
                  </div>

                  <div className="mx-5 border-t border-dashed border-neutral-200" />

                  <ul className="space-y-2.5 px-5 py-4">
                    {features.slice(0, 5).map((feature) => (
                      <li key={feature} className="flex items-start gap-2.5 text-sm text-neutral-600">
                        <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${styles.dot}`} />
                        <span>{feature}</span>
                      </li>
                    ))}
                  </ul>

                  <div className="mt-auto flex items-center justify-between gap-3 px-5 pb-5 pt-1">
                    <p className="text-xs text-neutral-400">
                      {tenants} tenant{tenants === 1 ? "" : "s"} linked
                    </p>
                    <div className="flex items-center gap-3">
                      <p className="text-xs text-neutral-400">
                        {pkg.messageQuota < 0 ? "Unlimited" : `${quotaLabel} messages`}
                      </p>
                      <button
                        type="button"
                        onClick={() => void remove(pkg.id)}
                        className="rounded-lg border border-red-200 px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-50"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      )}

      <SmsPackageBuildModal
        open={modalOpen}
        initial={editing}
        onClose={() => {
          setModalOpen(false);
          setEditing(null);
        }}
        onSaved={() => {
          setModalOpen(false);
          setEditing(null);
          void load();
        }}
      />
    </div>
  );
}
