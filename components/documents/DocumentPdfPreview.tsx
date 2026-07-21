"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  getPdfPreviewCache,
  preloadPdfJsWorker,
  setPdfPreviewCache,
} from "@/lib/pdfPreviewCache";

type Props = {
  active: boolean;
  refreshKey: string;
  fetchPdf: () => Promise<Blob>;
  className?: string;
};

function clonePdfBytes(source: Uint8Array): Uint8Array {
  return new Uint8Array(source);
}

let pdfJsReady: Promise<typeof import("pdfjs-dist")> | null = null;

function loadPdfJs() {
  if (!pdfJsReady) {
    pdfJsReady = import("pdfjs-dist").then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
      return pdfjs;
    });
  }
  return pdfJsReady;
}

/**
 * Inline pdf.js preview for the create/edit Preview tab.
 * Only displays content that matches the current refreshKey.
 */
export default function DocumentPdfPreview({
  active,
  refreshKey,
  fetchPdf,
  className = "",
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [displayKey, setDisplayKey] = useState<string | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const bytesRef = useRef<Uint8Array | null>(null);
  const requestRef = useRef(0);
  const renderRef = useRef(0);
  const lastScaleRef = useRef<number | null>(null);
  const fetchRef = useRef(fetchPdf);
  fetchRef.current = fetchPdf;

  useEffect(() => {
    preloadPdfJsWorker();
  }, []);

  const renderPdf = useCallback(async (data: Uint8Array, hostWidth: number, key: string) => {
    const host = hostRef.current;
    if (!host) return;

    const renderId = ++renderRef.current;
    const pdfjs = await loadPdfJs();
    const pdfData = clonePdfBytes(data);
    const pdf = await pdfjs.getDocument({ data: pdfData }).promise;
    if (renderId !== renderRef.current) return;

    const firstPage = await pdf.getPage(1);
    const baseViewport = firstPage.getViewport({ scale: 1 });
    const scale = Math.min(1.35, hostWidth / baseViewport.width);
    lastScaleRef.current = scale;

    const fragment = document.createDocumentFragment();

    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      if (renderId !== renderRef.current) return;
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      canvas.className =
        "mx-auto block max-w-full rounded-sm border border-neutral-200 bg-white shadow-md";
      canvas.setAttribute("aria-label", `Page ${pageNum}`);
      const context = canvas.getContext("2d");
      if (!context) continue;
      await page.render({ canvasContext: context, viewport }).promise;
      fragment.appendChild(canvas);
      if (pageNum < pdf.numPages) {
        const gap = document.createElement("div");
        gap.className = "h-4";
        fragment.appendChild(gap);
      }
    }

    if (renderId !== renderRef.current) return;
    host.replaceChildren(fragment);
    setPageCount(pdf.numPages);
    setDisplayKey(key);
  }, []);

  const measureHostWidth = useCallback(() => {
    const container = containerRef.current;
    if (!container) return 640;
    return Math.max(280, container.clientWidth - 32);
  }, []);

  const loadPreview = useCallback(
    async (key: string) => {
      const requestId = ++requestRef.current;
      setLoading(true);
      setError(null);
      setDisplayKey(null);
      if (hostRef.current) hostRef.current.replaceChildren();

      try {
        let bytes = getPdfPreviewCache(key);
        if (!bytes) {
          const blob = await fetchRef.current();
          if (requestId !== requestRef.current) return;
          const buffer = await blob.arrayBuffer();
          bytes = clonePdfBytes(new Uint8Array(buffer));
          setPdfPreviewCache(key, bytes);
        }

        if (requestId !== requestRef.current) return;
        bytesRef.current = bytes;
        await renderPdf(bytes, measureHostWidth(), key);
      } catch (err) {
        if (requestId !== requestRef.current) return;
        setError(err instanceof Error ? err.message : "Could not load preview.");
      } finally {
        if (requestId === requestRef.current) setLoading(false);
      }
    },
    [measureHostWidth, renderPdf],
  );

  useEffect(() => {
    if (!active) return;
    if (displayKey === refreshKey) return;

    const timer = window.setTimeout(() => {
      void loadPreview(refreshKey);
    }, 150);
    return () => window.clearTimeout(timer);
  }, [active, refreshKey, displayKey, loadPreview]);

  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    let resizeTimer: number | undefined;
    const ro = new ResizeObserver(() => {
      if (!bytesRef.current || displayKey !== refreshKey) return;
      const hostWidth = measureHostWidth();
      const nextScale = Math.min(1.35, hostWidth / 595.28);
      const prev = lastScaleRef.current;
      if (prev !== null && Math.abs(prev - nextScale) < 0.04) return;

      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        void renderPdf(bytesRef.current!, hostWidth, refreshKey);
      }, 300);
    });
    ro.observe(container);
    return () => {
      ro.disconnect();
      window.clearTimeout(resizeTimer);
    };
  }, [active, displayKey, refreshKey, measureHostWidth, renderPdf]);

  const showContent = displayKey === refreshKey;

  return (
    <div
      ref={containerRef}
      className={`custom-scrollbar relative h-full min-h-0 overflow-auto bg-neutral-200/80 ${className}`}
    >
      {(loading || !showContent) && !error && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-neutral-200/80">
          <div className="flex flex-col items-center gap-3 text-sm text-neutral-500">
            <i className="fas fa-spinner fa-spin text-xl text-neutral-400" />
            {displayKey ? "Updating preview…" : "Loading preview…"}
          </div>
        </div>
      )}
      {error && (
        <div className="flex min-h-[280px] items-center justify-center p-6">
          <div className="max-w-sm rounded-xl border border-amber-200 bg-amber-50 px-4 py-5 text-center">
            <i className="fas fa-triangle-exclamation mb-2 text-lg text-amber-500" />
            <p className="text-sm text-neutral-700">{error}</p>
          </div>
        </div>
      )}
      {showContent && pageCount > 0 && (
        <p className="sr-only">{`${pageCount} page${pageCount === 1 ? "" : "s"}`}</p>
      )}
      <div
        ref={hostRef}
        className={`flex flex-col items-center px-4 py-5 ${showContent ? "" : "invisible"}`}
      />
    </div>
  );
}
