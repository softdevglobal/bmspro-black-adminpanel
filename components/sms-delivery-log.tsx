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
const PREVIEW_LENGTH = 90;

function statusClass(status: SmsLogRow["status"]): string {
  if (status === "sent") return "bg-emerald-50 text-emerald-700";
  if (status === "failed") return "bg-red-50 text-red-700";
  return "bg-amber-50 text-amber-700";
}

function formatWhen(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function MessageCell({ message }: { message: string }) {
  const [expanded, setExpanded] = useState(false);
  const needsTruncate = message.length > PREVIEW_LENGTH;
  const shown =
    !needsTruncate || expanded ? message : `${message.slice(0, PREVIEW_LENGTH).trim()}…`;

  return (
    <div className="max-w-[28rem]">
      <p
        className={`text-sm leading-snug text-neutral-700 ${expanded ? "whitespace-pre-wrap break-words" : "line-clamp-2"}`}
        title={!expanded ? message : undefined}
      >
        {shown}
      </p>
      {needsTruncate && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 text-xs font-semibold text-blue-600 hover:text-blue-700 hover:underline"
        >
          {expanded ? "Less" : "More"}
        </button>
      )}
    </div>
  );
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
    <div className="overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-sm">
      <div className="border-b border-neutral-200 p-4">
        <div className="relative max-w-lg">
          <i className="fas fa-search pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-sm text-neutral-400" />
          <input
            type="search"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Search sender, phone, message, status, source…"
            className="w-full rounded-xl border border-neutral-300 py-2.5 pl-10 pr-3.5 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-900 focus:outline-none focus:ring-2 focus:ring-neutral-900/10"
          />
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="min-w-full text-left text-sm">
          <thead className="sticky top-0 bg-neutral-50 text-xs uppercase tracking-wide text-neutral-500">
            <tr>
              <th className="whitespace-nowrap px-4 py-3 font-semibold">When</th>
              {showBusinessId && (
                <th className="whitespace-nowrap px-4 py-3 font-semibold">Tenant</th>
              )}
              <th className="whitespace-nowrap px-4 py-3 font-semibold">Sender</th>
              <th className="whitespace-nowrap px-4 py-3 font-semibold">Recipient</th>
              <th className="px-4 py-3 font-semibold">Message</th>
              <th className="whitespace-nowrap px-4 py-3 font-semibold">Status</th>
              <th className="whitespace-nowrap px-4 py-3 font-semibold">Source</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100">
            {pageRows.length === 0 ? (
              <tr>
                <td
                  colSpan={showBusinessId ? 7 : 6}
                  className="px-4 py-12 text-center text-neutral-500"
                >
                  No SMS log entries found.
                </td>
              </tr>
            ) : (
              pageRows.map((row) => {
                const source = row.sourceLabel || formatSmsLogSource(row.source);
                const detail = row.statusLabel || formatSmsStatusDetail(row.statusDetail);

                return (
                  <tr key={row.id} className="align-middle hover:bg-neutral-50/70">
                    <td className="whitespace-nowrap px-4 py-3.5 text-neutral-600">
                      {formatWhen(row.createdAt)}
                    </td>
                    {showBusinessId && (
                      <td className="px-4 py-3.5">
                        {row.tenantName ? (
                          <div>
                            <div className="font-medium text-neutral-900">{row.tenantName}</div>
                            {row.tenantEmail && (
                              <div className="max-w-[10rem] truncate text-xs text-neutral-500">
                                {row.tenantEmail}
                              </div>
                            )}
                          </div>
                        ) : (
                          <span className="text-neutral-400">—</span>
                        )}
                      </td>
                    )}
                    <td className="whitespace-nowrap px-4 py-3.5 font-medium text-neutral-900">
                      {row.senderName || "—"}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3.5">
                      <div className="font-medium text-neutral-900">{row.receiverPhone}</div>
                      {row.receiverName && (
                        <div className="text-xs text-neutral-500">{row.receiverName}</div>
                      )}
                    </td>
                    <td className="px-4 py-3.5">
                      <MessageCell message={row.message} />
                    </td>
                    <td className="whitespace-nowrap px-4 py-3.5">
                      <span
                        className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold capitalize ${statusClass(row.status)}`}
                      >
                        {row.status}
                      </span>
                      {detail && (
                        <div className="mt-1 max-w-[8rem] truncate text-xs text-neutral-400" title={detail}>
                          {detail}
                        </div>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3.5">
                      <span className="rounded-md bg-neutral-100 px-2 py-1 text-xs font-medium text-neutral-700">
                        {source}
                      </span>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-neutral-200 px-4 py-3 text-sm text-neutral-600">
        <span>
          {filtered.length === 0
            ? "0 entries"
            : `Showing ${(currentPage - 1) * PAGE_SIZE + 1}–${Math.min(currentPage * PAGE_SIZE, filtered.length)} of ${filtered.length} entr${filtered.length === 1 ? "y" : "ies"}`}
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
