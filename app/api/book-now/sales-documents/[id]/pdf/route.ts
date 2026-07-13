import { NextRequest } from "next/server";
import {
  handleCustomerSalesDocumentPdf,
  type SalesDocKind,
} from "@/lib/salesDocuments";

export const runtime = "nodejs";
export const maxDuration = 60;

function parseKind(value: string | null): SalesDocKind | null {
  if (value === "quotation" || value === "invoice") return value;
  return null;
}

/**
 * GET /api/book-now/sales-documents/[id]/pdf?customerId=…&kind=quotation|invoice
 *
 * Lets a logged-in booking-engine customer view a quotation/invoice PDF that
 * was sent to them (matched via the document's `customerId`).
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const kind = parseKind(req.nextUrl.searchParams.get("kind"));
  if (!kind) {
    return Response.json(
      { ok: false, error: "Missing or invalid kind. Use quotation or invoice." },
      { status: 400 }
    );
  }
  return handleCustomerSalesDocumentPdf(req, kind, id);
}
