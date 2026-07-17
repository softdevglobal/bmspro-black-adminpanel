import { NextRequest } from "next/server";
import {
  handleCreateSalesDocument,
  handleListSalesDocuments,
} from "@/lib/salesDocuments";

export const runtime = "nodejs";
/** Sending generates a PDF (Chromium) before emailing — give it room on Vercel. */
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  return handleListSalesDocuments(req, "quotation");
}

export async function POST(req: NextRequest) {
  return handleCreateSalesDocument(req, "quotation");
}
