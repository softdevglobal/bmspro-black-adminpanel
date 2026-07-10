import { NextRequest } from "next/server";
import {
  handleDeleteSalesDocument,
  handleGetSalesDocument,
  handleUpdateSalesDocument,
} from "@/lib/salesDocuments";

export const runtime = "nodejs";

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return handleGetSalesDocument(req, "quotation", id);
}

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return handleUpdateSalesDocument(req, "quotation", id);
}

export async function DELETE(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return handleDeleteSalesDocument(req, "quotation", id);
}
