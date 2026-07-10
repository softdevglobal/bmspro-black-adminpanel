import { NextRequest } from "next/server";
import { handleSalesDocumentPdf } from "@/lib/salesDocuments";

export const runtime = "nodejs";

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return handleSalesDocumentPdf(req, "quotation", id);
}
