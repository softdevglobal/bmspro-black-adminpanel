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
  stripePriceId?: string | null;
  stripeProductId?: string | null;
};

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
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {packages.map((pkg) => (
            <div key={pkg.id} className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-lg font-semibold">{pkg.name}</h3>
                  <p className="text-sm text-neutral-500">{pkg.priceLabel}</p>
                </div>
                <div className="flex flex-col items-end gap-1 text-xs">
                  {pkg.stripePriceId ? (
                    <span className="rounded-full bg-indigo-100 px-2 py-1 text-indigo-800">
                      <i className="fab fa-stripe-s mr-1" />
                      Stripe linked
                    </span>
                  ) : (
                    <span className="rounded-full bg-amber-100 px-2 py-1 text-amber-800">Stripe not linked</span>
                  )}
                  {!pkg.active && <span className="rounded-full bg-neutral-100 px-2 py-1">Inactive</span>}
                  {pkg.hidden && <span className="rounded-full bg-amber-100 px-2 py-1 text-amber-800">Hidden</span>}
                  {pkg.popular && (
                    <span className="rounded-full bg-emerald-100 px-2 py-1 text-emerald-800">Popular</span>
                  )}
                </div>
              </div>
              <p className="mt-3 text-xl font-bold">
                {pkg.messageQuota < 0 ? "Unlimited" : `${pkg.messageQuota} credits`}
              </p>
              {pkg.description && <p className="mt-2 text-sm text-neutral-600">{pkg.description}</p>}
              <p className="mt-2 text-sm text-neutral-600">
                {tenantCounts[pkg.id] ?? 0} tenant{(tenantCounts[pkg.id] ?? 0) === 1 ? "" : "s"} linked
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setEditing(pkg);
                    setModalOpen(true);
                  }}
                  className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => void remove(pkg.id)}
                  className="rounded-lg border border-red-200 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
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
