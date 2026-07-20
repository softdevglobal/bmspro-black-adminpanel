import "server-only";

/**
 * Sales document PDF entry points.
 * Generation is pdf-lib via `generateDocumentPdf` (not Puppeteer / HTML).
 */

import { generateDocumentPdf } from "@/lib/generateDocumentPdf";
import {
  salesDocumentPdfFilename,
  type DocumentData,
  type DocumentKind,
  type DocumentLineItem,
} from "@/lib/documentData";

export type SalesDocKind = DocumentKind;
export type SalesDocPdfLineItem = DocumentLineItem;
export type SalesDocPdfInput = DocumentData;

export { salesDocumentPdfFilename };

export async function generateSalesDocumentPdf(
  input: SalesDocPdfInput
): Promise<{ buffer: Buffer; filename: string }> {
  return generateDocumentPdf(input, input.kind);
}
