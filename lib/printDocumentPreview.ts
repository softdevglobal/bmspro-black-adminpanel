/**
 * Print the live HTML document preview (not a PDF file).
 * Marks body so print CSS can hide everything except `[data-print-document-root]`.
 */
export function printDocumentPreview(): void {
  if (typeof document === "undefined" || typeof window === "undefined") return;

  const cleanup = () => {
    document.body.classList.remove("printing-document");
    window.removeEventListener("afterprint", cleanup);
  };

  document.body.classList.add("printing-document");
  window.addEventListener("afterprint", cleanup);

  // Fallback if afterprint never fires (some browsers).
  window.setTimeout(cleanup, 60_000);

  window.print();
}
