"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";

type Props = {
  open: boolean;
  title: string;
  /** Authenticated URL that returns application/pdf bytes. */
  pdfUrl?: string | null;
  /**
   * Pre-fetched PDF bytes (avoids re-fetching blob: URLs, which CSP connect-src
   * often blocks). When set, `pdfUrl` is ignored for loading.
   */
  pdfBytes?: Uint8Array | null;
  /** Optional pre-built headers (e.g. Authorization). */
  fetchHeaders?: HeadersInit;
  onClose: () => void;
  filename?: string;
};

/**
 * PDF viewer: loads bytes from an auth API route or from pre-fetched bytes,
 * then draws each page on `<canvas>` with pdfjs-dist.
 */
export default function SalesDocumentPdfViewer({
  open,
  title,
  pdfUrl = null,
  pdfBytes = null,
  fetchHeaders,
  onClose,
  filename = "document.pdf",
}: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const blobRef = useRef<string | null>(null);
  const bytesRef = useRef<Uint8Array | null>(null);

  const revokeBlob = useCallback(() => {
    if (blobRef.current) {
      URL.revokeObjectURL(blobRef.current);
      blobRef.current = null;
    }
    setBlobUrl(null);
  }, []);

  const renderPages = useCallback(async (data: Uint8Array) => {
    const host = canvasHostRef.current;
    if (!host) return;

    host.innerHTML = "";
    const pdfjs = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

    const pdf = await pdfjs.getDocument({ data }).promise;
    setPageCount(pdf.numPages);

    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const viewport = page.getViewport({ scale: 1.35 });
      const canvas = document.createElement("canvas");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      canvas.className =
        "mx-auto mb-4 max-w-full rounded border border-neutral-200 bg-white shadow-sm";
      canvas.setAttribute("aria-label", `Page ${pageNum}`);
      const context = canvas.getContext("2d");
      if (!context) continue;
      await page.render({ canvasContext: context, viewport }).promise;
      host.appendChild(canvas);
    }
  }, []);

  const applyBytes = useCallback(
    async (source: Uint8Array) => {
      // Copy so pdf.js owns a detached buffer and we keep a stable download copy.
      const bytes = new Uint8Array(source);
      bytesRef.current = bytes;
      const url = URL.createObjectURL(
        new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)], {
          type: "application/pdf",
        }),
      );
      blobRef.current = url;
      setBlobUrl(url);
      await renderPages(bytes);
    },
    [renderPages],
  );

  useEffect(() => {
    if (!open) return;
    if (!pdfBytes && !pdfUrl) return;

    let cancelled = false;
    setLoading(true);
    setError(null);
    setPageCount(0);
    revokeBlob();
    bytesRef.current = null;
    if (canvasHostRef.current) canvasHostRef.current.innerHTML = "";

    (async () => {
      try {
        if (pdfBytes && pdfBytes.byteLength > 0) {
          if (cancelled) return;
          await applyBytes(pdfBytes);
          return;
        }

        if (!pdfUrl) {
          throw new Error("No PDF to display.");
        }

        const res = await fetch(pdfUrl, {
          headers: fetchHeaders,
          cache: "no-store",
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(
            (body as { error?: string }).error || `Could not load PDF (${res.status}).`,
          );
        }
        const buffer = await res.arrayBuffer();
        if (cancelled) return;
        await applyBytes(new Uint8Array(buffer));
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Could not load PDF.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, pdfUrl, pdfBytes, fetchHeaders, renderPages, revokeBlob, applyBytes]);

  useEffect(() => {
    if (!open) {
      revokeBlob();
      bytesRef.current = null;
      if (canvasHostRef.current) canvasHostRef.current.innerHTML = "";
    }
  }, [open, revokeBlob]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  function download() {
    if (!blobUrl) return;
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = filename.replace(/[^\w.-]+/g, "_") || "document.pdf";
    a.click();
  }

  function openInNewTab() {
    if (!blobUrl) return;
    window.open(blobUrl, "_blank", "noopener,noreferrer");
  }

  function printPdf() {
    if (!blobUrl) return;
    const iframe = document.createElement("iframe");
    iframe.style.position = "fixed";
    iframe.style.right = "0";
    iframe.style.bottom = "0";
    iframe.style.width = "0";
    iframe.style.height = "0";
    iframe.style.border = "0";
    iframe.src = blobUrl;
    document.body.appendChild(iframe);
    iframe.onload = () => {
      try {
        iframe.contentWindow?.focus();
        iframe.contentWindow?.print();
      } finally {
        window.setTimeout(() => {
          document.body.removeChild(iframe);
        }, 1000);
      }
    };
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-200 px-4 py-3">
          <div>
            <h3 className="text-sm font-bold text-neutral-900">{title}</h3>
            <p className="text-xs text-neutral-500">
              {loading
                ? "Loading PDF…"
                : error
                  ? "Could not open PDF"
                  : pageCount
                    ? `${pageCount} page${pageCount === 1 ? "" : "s"}`
                    : "PDF viewer"}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {blobUrl && (
              <>
                <button
                  type="button"
                  onClick={openInNewTab}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-300 px-3 py-1.5 text-xs font-semibold text-neutral-700 hover:bg-neutral-50"
                >
                  <i className="fas fa-up-right-from-square" />
                  Open
                </button>
                <button
                  type="button"
                  onClick={download}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-300 px-3 py-1.5 text-xs font-semibold text-neutral-700 hover:bg-neutral-50"
                >
                  <i className="fas fa-download" />
                  Download
                </button>
                <button
                  type="button"
                  onClick={printPdf}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-300 px-3 py-1.5 text-xs font-semibold text-neutral-700 hover:bg-neutral-50"
                >
                  <i className="fas fa-print" />
                  Print
                </button>
              </>
            )}
            <button
              type="button"
              onClick={onClose}
              className="inline-flex items-center gap-1.5 rounded-lg bg-neutral-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-neutral-800"
            >
              Close
            </button>
          </div>
        </div>

        <div className="custom-scrollbar flex-1 overflow-auto bg-neutral-100 px-4 py-4">
          {loading && (
            <div className="flex flex-col items-center justify-center gap-3 py-24 text-sm text-neutral-500">
              <i className="fas fa-spinner fa-spin text-xl" />
              Rendering PDF…
            </div>
          )}
          {error && !loading && (
            <div className="mx-auto max-w-md rounded-xl border border-amber-200 bg-amber-50 px-4 py-6 text-center">
              <i className="fas fa-triangle-exclamation mb-2 text-xl text-amber-500" />
              <p className="text-sm text-neutral-700">{error}</p>
            </div>
          )}
          <div ref={canvasHostRef} />
        </div>
      </div>
    </div>
  );
}
