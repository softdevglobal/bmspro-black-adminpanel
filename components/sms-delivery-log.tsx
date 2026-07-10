"use client";

import { useMemo, useState } from "react";
import { formatSmsLogSource, formatSmsStatusDetail } from "@/lib/sms/sms-log-display";

export type SmsLogRow = {
  id: string;
  ownerUid?: string | null;
  businessId?: string | null;
  tenantName?: string | null;
  tenantEmail?: string | null;
  senderName: string;
  receiverPhone: string;
  receiverName?: string | null;
  message: string;
  status: "sent" | "failed" | "skipped";
  statusDetail: string;
  statusLabel?: string;
  source: string;
  sourceLabel?: string;
  createdAt: string | null;
};

const PAGE_SIZE = 15;

function statusClass(status: SmsLogRow["status"]): string {
  if (status === "sent") return "bg-emerald-50 text-emerald-700";
  if (status === "failed") return "bg-red-50 text-red-700";
  return "bg-amber-50 text-amber-700";
}

export function SmsDeliveryLog({
  logs,
  showBusinessId = false,
}: {
  logs: SmsLogRow[];
  showBusinessId?: boolean;
}) {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return logs;
    return logs.filter((row) =>
      [
        row.senderName,
        row.receiverPhone,
        row.receiverName,
        row.message,
        row.status,
        row.statusDetail,
        row.statusLabel,
        row.source,
        row.sourceLabel,
        row.tenantName,
        row.tenantEmail,
        row.ownerUid,
        row.businessId,
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(q)),
    );
  }, [logs, search]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageRows = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  return (
    <div className="rounded-2xl border border-neutral-200 bg-white shadow-sm">
      <div className="border-b border-neutral-200 p-4">
        <input
          type="search"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
          placeholder="Search sender, phone, message, status, source…"
          className="w-full rounded-lg border border-neutral-300 px-3.5 py-2.5 text-sm focus:border-neutral-900 focus:outline-none focus:ring-2 focus:ring-neutral-900/10"
        />
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-left text-sm">
          <thead className="bg-neutral-50 text-xs uppercase tracking-wide text-neutral-500">
            <tr>
              <th className="px-4 py-3">When</th>
              {showBusinessId && <th className="px-4 py-3">Tenant</th>}
              <th className="px-4 py-3">Sender</th>
              <th className="px-4 py-3">Recipient</th>
              <th className="px-4 py-3">Message</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Source</th>
            </tr>
          </thead>
          <tbody>
            {pageRows.length === 0 ? (
              <tr>
                <td colSpan={showBusinessId ? 7 : 6} className="px-4 py-10 text-center text-neutral-500">
                  No SMS log entries found.
                </td>
              </tr>
            ) : (
              pageRows.map((row) => (
                <tr key={row.id} className="border-t border-neutral-100 align-top">
                  <td className="px-4 py-3 whitespace-nowrap text-neutral-600">
                    {row.createdAt ? new Date(row.createdAt).toLocaleString() : "—"}
                  </td>
                  {showBusinessId && (
                    <td className="px-4 py-3">
                      {row.tenantName ? (
                        <div>
                          <div className="font-medium text-neutral-900">{row.tenantName}</div>
                          {row.tenantEmail && (
                            <div className="text-xs text-neutral-500">{row.tenantEmail}</div>
                          )}
                        </div>
                      ) : row.senderName && row.senderName !== "System" ? (
                        <div className="font-medium text-neutral-900">{row.senderName}</div>
                      ) : (
                        <span className="text-neutral-400">—</span>
                      )}
                    </td>
                  )}
                  <td className="px-4 py-3">{row.senderName}</td>
                  <td className="px-4 py-3">
                    <div>{row.receiverPhone}</div>
                    {row.receiverName && (
                      <div className="text-xs text-neutral-500">{row.receiverName}</div>
                    )}
                  </td>
                  <td className="max-w-md px-4 py-3 text-neutral-700">
                    <p className="whitespace-pre-wrap break-words">{row.message}</p>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${statusClass(row.status)}`}>
                      {row.status}
                    </span>
                    {(row.statusLabel || row.statusDetail) && (
                      <div className="mt-1 text-xs text-neutral-500">
                        {row.statusLabel || formatSmsStatusDetail(row.statusDetail)}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-neutral-600">
                    {row.sourceLabel || formatSmsLogSource(row.source)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between border-t border-neutral-200 px-4 py-3 text-sm text-neutral-600">
        <span>
          Showing {(currentPage - 1) * PAGE_SIZE + 1}–
          {Math.min(currentPage * PAGE_SIZE, filtered.length)} of {filtered.length} entr
          {filtered.length === 1 ? "y" : "ies"}
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={currentPage <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            className="rounded-lg border border-neutral-300 px-3 py-1.5 disabled:opacity-40"
          >
            Previous
          </button>
          <span>
            Page {currentPage} of {totalPages}
          </span>
          <button
            type="button"
            disabled={currentPage >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            className="rounded-lg border border-neutral-300 px-3 py-1.5 disabled:opacity-40"
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}
