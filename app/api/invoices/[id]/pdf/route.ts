import { NextRequest } from "next/server";
import { handleSalesDocumentPdf } from "@/lib/salesDocuments";

export const runtime = "nodejs";
/** Allow time for Chromium + PDF render on Vercel (raise on Pro if needed). */
export const maxDuration = 60;

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return handleSalesDocumentPdf(req, "invoice", id);
}
