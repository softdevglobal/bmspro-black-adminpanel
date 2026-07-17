import { NextRequest } from "next/server";
import { handleSalesDocumentPreviewPdf } from "@/lib/salesDocuments";

export const runtime = "nodejs";
/** Allow time for Chromium + PDF render on Vercel (raise on Pro if needed). */
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  return handleSalesDocumentPreviewPdf(req, "invoice");
}
