"use client";

import { useCallback, useEffect, useState } from "react";
import { SmsDeliveryLog, type SmsLogRow } from "@/components/sms-delivery-log";
import { authFetch, useAuthUser } from "@/lib/sms/client-auth";

export function SmsLogBoard({ variant }: { variant: "admin" | "tenant" }) {
  const { ready: authReady } = useAuthUser();
  const [logs, setLogs] = useState<SmsLogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const path = variant === "admin" ? "/api/sms/log" : "/api/business/sms-log";
    const result = await authFetch<{ logs: SmsLogRow[] }>(path);
    if (!result.ok) {
      setError(result.error);
      setLogs([]);
    } else {
      setLogs(
        (result.data.logs ?? []).map((row) => ({
          ...row,
          createdAt:
            typeof row.createdAt === "string"
              ? row.createdAt
              : row.createdAt
                ? new Date(row.createdAt as unknown as string).toISOString()
                : null,
        })),
      );
    }
    setLoading(false);
  }, [variant]);

  useEffect(() => {
    if (!authReady) return;
    void load();
  }, [authReady, load, variant]);

  return (
    <div className="space-y-6">
      <div className="rounded-2xl bg-gradient-to-r from-neutral-900 to-neutral-700 p-6 text-white">
        <h1 className="text-2xl font-bold">SMS Delivery Log</h1>
        <p className="mt-1 text-sm text-neutral-300">
          {variant === "admin"
            ? "All outbound SMS attempts across tenants."
            : "Outbound SMS attempts for your workshop."}
        </p>
      </div>

      {loading ? (
        <div className="rounded-2xl border border-neutral-200 bg-white p-10 text-center text-neutral-500">
          <i className="fas fa-spinner fa-spin mr-2" />
          Loading SMS logs…
        </div>
      ) : error ? (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-6 text-red-700">{error}</div>
      ) : (
        <SmsDeliveryLog logs={logs} showBusinessId={variant === "admin"} />
      )}
    </div>
  );
}
