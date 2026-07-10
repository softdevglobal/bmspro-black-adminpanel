import { NextRequest } from "next/server";
import {
  handleCreateSalesDocument,
  handleListSalesDocuments,
} from "@/lib/salesDocuments";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  return handleListSalesDocuments(req, "invoice");
}

export async function POST(req: NextRequest) {
  return handleCreateSalesDocument(req, "invoice");
}
