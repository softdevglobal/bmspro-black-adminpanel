"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { authFetch, useAuthUser } from "@/lib/sms/client-auth";

const PAGE_SIZE = 15;

type TenantUsage = {
  ownerUid: string;
  name: string;
  email: string;
  balance: {
    limit: number;
    used: number;
    remaining: number | null;
    unlimited: boolean;
    smsPackageId: string | null;
    smsPackage: {
      id: string;
      name: string;
      priceLabel?: string;
      messageQuota?: number;
    } | null;
  };
};

type Purchase = {
  id: string;
  ownerUid?: string;
  tenantName?: string | null;
  tenantEmail?: string | null;
  smsPackageName?: string;
  messageQuota?: number | null;
  amountTotal?: number | null;
  currency?: string;
  fulfilledAt?: string | null;
};

export function AdminSmsUsageBoard() {
  const { ready: authReady } = useAuthUser();
  const [tenants, setTenants] = useState<TenantUsage[]>([]);
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tenantPage, setTenantPage] = useState(1);
  const [workshopSearch, setWorkshopSearch] = useState("");

  const filteredTenants = useMemo(() => {
    const q = workshopSearch.trim().toLowerCase();
    if (!q) return tenants;
    return tenants.filter(
      (tenant) =>
        tenant.name.toLowerCase().includes(q) ||
        tenant.email.toLowerCase().includes(q),
    );
  }, [tenants, workshopSearch]);

  const tenantTotalPages = Math.max(1, Math.ceil(filteredTenants.length / PAGE_SIZE));
  const tenantCurrentPage = Math.min(tenantPage, tenantTotalPages);

  const pagedTenants = useMemo(
    () =>
      filteredTenants.slice(
        (tenantCurrentPage - 1) * PAGE_SIZE,
        tenantCurrentPage * PAGE_SIZE,
      ),
    [filteredTenants, tenantCurrentPage],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const result = await authFetch<{ tenants: TenantUsage[]; purchases: Purchase[] }>(
      "/api/sms-packages/usage",
    );
    if (!result.ok) {
      setError(result.error);
    } else {
      setTenants(result.data.tenants ?? []);
      setPurchases(result.data.purchases ?? []);
      setTenantPage(1);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!authReady) return;
    void load();
  }, [authReady, load]);

  return (
    <div className="space-y-6">
      <div className="rounded-2xl bg-gradient-to-r from-neutral-900 to-neutral-700 p-6 text-white">
        <h1 className="text-2xl font-bold">SMS Usage</h1>
        <p className="mt-1 text-sm text-neutral-300">Per-tenant limits, usage, and Stripe top-up history.</p>
      </div>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-red-700">{error}</div>
      )}

      {loading ? (
        <div className="rounded-2xl border border-neutral-200 bg-white p-10 text-center text-neutral-500">
          <i className="fas fa-spinner fa-spin mr-2" />
          Loading usage…
        </div>
      ) : (
        <>
          <div className="overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-sm">
            <div className="border-b border-neutral-200 p-4">
              <div className="relative max-w-md">
                <i className="fas fa-search pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-sm text-neutral-400" />
                <input
                  type="search"
                  value={workshopSearch}
                  onChange={(e) => {
                    setWorkshopSearch(e.target.value);
                    setTenantPage(1);
                  }}
                  placeholder="Search workshop name…"
                  className="w-full rounded-xl border border-neutral-300 py-2.5 pl-10 pr-3.5 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-900 focus:outline-none focus:ring-2 focus:ring-neutral-900/10"
                />
              </div>
            </div>
            <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="bg-neutral-50 text-xs uppercase tracking-wide text-neutral-500">
                <tr>
                  <th className="px-4 py-3">Workshop</th>
                  <th className="px-4 py-3">Limit</th>
                  <th className="px-4 py-3">Used</th>
                  <th className="px-4 py-3">Remaining</th>
                  <th className="px-4 py-3">Package</th>
                </tr>
              </thead>
              <tbody>
                {filteredTenants.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-neutral-500">
                      {workshopSearch.trim()
                        ? "No workshops match your search."
                        : "No workshop tenants found."}
                    </td>
                  </tr>
                ) : (
                  pagedTenants.map((tenant) => (
                    <tr key={tenant.ownerUid} className="border-t border-neutral-100">
                      <td className="px-4 py-3">
                        <div className="font-medium text-neutral-900">{tenant.name}</div>
                        <div className="text-xs text-neutral-500">{tenant.email}</div>
                      </td>
                      <td className="px-4 py-3">
                        {tenant.balance.unlimited ? "Unlimited" : tenant.balance.limit}
                      </td>
                      <td className="px-4 py-3">{tenant.balance.used}</td>
                      <td className="px-4 py-3">
                        {tenant.balance.unlimited ? "Unlimited" : (tenant.balance.remaining ?? 0)}
                      </td>
                      <td className="px-4 py-3">
                        {tenant.balance.smsPackage?.name ? (
                          <div>
                            <div className="font-medium text-neutral-900">
                              {tenant.balance.smsPackage.name}
                            </div>
                            {tenant.balance.smsPackage.messageQuota != null && (
                              <div className="text-xs text-neutral-500">
                                {tenant.balance.smsPackage.messageQuota < 0
                                  ? "Unlimited quota"
                                  : `${tenant.balance.smsPackage.messageQuota} messages`}
                              </div>
                            )}
                          </div>
                        ) : (
                          <span className="text-neutral-400">—</span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
            </div>
            {filteredTenants.length > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-neutral-200 px-4 py-3 text-sm text-neutral-600">
                <span>
                  Showing {(tenantCurrentPage - 1) * PAGE_SIZE + 1}–
                  {Math.min(tenantCurrentPage * PAGE_SIZE, filteredTenants.length)} of{" "}
                  {filteredTenants.length} workshop{filteredTenants.length === 1 ? "" : "s"}
                  {workshopSearch.trim() ? ` (filtered from ${tenants.length})` : ""}
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={tenantCurrentPage <= 1}
                    onClick={() => setTenantPage((p) => Math.max(1, p - 1))}
                    className="rounded-lg border border-neutral-300 px-3 py-1.5 disabled:opacity-40"
                  >
                    Previous
                  </button>
                  <span>
                    Page {tenantCurrentPage} of {tenantTotalPages}
                  </span>
                  <button
                    type="button"
                    disabled={tenantCurrentPage >= tenantTotalPages}
                    onClick={() => setTenantPage((p) => Math.min(tenantTotalPages, p + 1))}
                    className="rounded-lg border border-neutral-300 px-3 py-1.5 disabled:opacity-40"
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </div>

          <div>
            <h2 className="mb-3 text-lg font-semibold">Recent Stripe top-ups</h2>
            <div className="overflow-x-auto rounded-2xl border border-neutral-200 bg-white shadow-sm">
              <table className="min-w-full text-left text-sm">
                <thead className="bg-neutral-50 text-xs uppercase tracking-wide text-neutral-500">
                  <tr>
                    <th className="px-4 py-3">When</th>
                    <th className="px-4 py-3">Tenant</th>
                    <th className="px-4 py-3">Package</th>
                    <th className="px-4 py-3">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {purchases.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="px-4 py-8 text-center text-neutral-500">
                        No Stripe SMS top-ups yet.
                      </td>
                    </tr>
                  ) : (
                    purchases.map((purchase) => (
                      <tr key={purchase.id} className="border-t border-neutral-100">
                        <td className="px-4 py-3">
                          {purchase.fulfilledAt
                            ? new Date(purchase.fulfilledAt).toLocaleString()
                            : "—"}
                        </td>
                        <td className="px-4 py-3">
                          {purchase.tenantName ? (
                            <div>
                              <div className="font-medium text-neutral-900">{purchase.tenantName}</div>
                              {purchase.tenantEmail && (
                                <div className="text-xs text-neutral-500">{purchase.tenantEmail}</div>
                              )}
                            </div>
                          ) : (
                            <span className="font-mono text-xs text-neutral-500">
                              {purchase.ownerUid ?? "—"}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          {purchase.smsPackageName ? (
                            <div>
                              <div className="font-medium text-neutral-900">
                                {purchase.smsPackageName}
                              </div>
                              {purchase.messageQuota != null && (
                                <div className="text-xs text-neutral-500">
                                  {purchase.messageQuota < 0
                                    ? "Unlimited messages"
                                    : `${purchase.messageQuota.toLocaleString()} messages`}
                                </div>
                              )}
                            </div>
                          ) : (
                            <span className="text-neutral-400">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          {purchase.amountTotal != null
                            ? `${(purchase.amountTotal / 100).toFixed(2)} ${(purchase.currency ?? "aud").toUpperCase()}`
                            : "—"}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
