/**
 * Print helpers for quotation / invoice preview.
 * Prefer PDF print (no browser URL headers/footers). HTML print remains as a fallback.
 */

/** Print a PDF blob in a hidden iframe (matches emailed pdf-lib output). */
export function printPdfBlob(blob: Blob): void {
  if (typeof document === "undefined" || typeof window === "undefined") return;

  const url = URL.createObjectURL(blob);
  const iframe = document.createElement("iframe");
  iframe.setAttribute("title", "Print document");
  iframe.style.position = "fixed";
  iframe.style.right = "0";
  iframe.style.bottom = "0";
  iframe.style.width = "0";
  iframe.style.height = "0";
  iframe.style.border = "0";
  iframe.style.opacity = "0";
  iframe.style.pointerEvents = "none";
  iframe.src = url;
  document.body.appendChild(iframe);

  const cleanup = () => {
    try {
      if (iframe.parentNode) document.body.removeChild(iframe);
    } catch {
      /* ignore */
    }
    URL.revokeObjectURL(url);
  };

  iframe.onload = () => {
    try {
      iframe.contentWindow?.focus();
      iframe.contentWindow?.print();
    } finally {
      // Keep iframe briefly so the print dialog can read the PDF.
      window.setTimeout(cleanup, 60_000);
    }
  };
}

/**
 * Print the live HTML document preview (not a PDF file).
 * Marks body so print CSS can hide everything except `[data-print-document-root]`.
 * Prefer `printPdfBlob` when a PDF is available — HTML print can show the page URL in headers.
 */
export function printDocumentPreview(): void {
  if (typeof document === "undefined" || typeof window === "undefined") return;

  const previousTitle = document.title;
  document.title = " ";

  const cleanup = () => {
    document.body.classList.remove("printing-document");
    document.title = previousTitle;
    window.removeEventListener("afterprint", cleanup);
  };

  document.body.classList.add("printing-document");
  window.addEventListener("afterprint", cleanup);

  // Fallback if afterprint never fires (some browsers).
  window.setTimeout(cleanup, 60_000);

  window.print();
}
