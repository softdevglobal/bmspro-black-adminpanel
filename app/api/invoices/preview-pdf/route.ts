import { NextRequest } from "next/server";
import { handleSalesDocumentPreviewPdf } from "@/lib/salesDocuments";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  return handleSalesDocumentPreviewPdf(req, "invoice");
}
