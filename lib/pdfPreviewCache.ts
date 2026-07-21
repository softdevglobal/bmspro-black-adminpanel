/** In-memory cache for draft PDF preview bytes (per browser tab). */
const cache = new Map<string, Uint8Array>();
const MAX_ENTRIES = 8;

function clonePdfBytes(source: Uint8Array): Uint8Array {
  return new Uint8Array(source);
}

export function getPdfPreviewCache(key: string): Uint8Array | null {
  const hit = cache.get(key);
  return hit ? clonePdfBytes(hit) : null;
}

export function setPdfPreviewCache(key: string, bytes: Uint8Array): void {
  cache.set(key, clonePdfBytes(bytes));
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (!oldest) break;
    cache.delete(oldest);
  }
}

export function preloadPdfJsWorker(): void {
  if (typeof window === "undefined") return;
  void import("pdfjs-dist").then((pdfjs) => {
    pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
  });
}
