import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";
import { mapSalesDocument } from "@/lib/salesDocuments";

export const runtime = "nodejs";

/**
 * GET /api/book-now/sales-documents?customerId=…
 *
 * Lists quotations and invoices that were sent to this customer portal account.
 */
export async function GET(req: NextRequest) {
  const customerId = (req.nextUrl.searchParams.get("customerId") || "").trim();
  if (!customerId) {
    return NextResponse.json({ ok: false, error: "Missing customerId" }, { status: 400 });
  }

  try {
    const db = adminDb();
    const [quotesSnap, invoicesSnap] = await Promise.all([
      db.collection("quotations").where("customerId", "==", customerId).limit(50).get(),
      db.collection("invoices").where("customerId", "==", customerId).limit(50).get(),
    ]);

    const documents = [
      ...quotesSnap.docs.map((doc) => ({
        ...mapSalesDocument(doc.id, doc.data()),
        kind: "quotation" as const,
      })),
      ...invoicesSnap.docs.map((doc) => ({
        ...mapSalesDocument(doc.id, doc.data()),
        kind: "invoice" as const,
      })),
    ]
      .filter((doc) => doc.status === "sent" || Boolean(doc.sentAt))
      .sort((a, b) => (b.sentAt ?? b.createdAt ?? 0) - (a.sentAt ?? a.createdAt ?? 0));

    return NextResponse.json({ ok: true, documents });
  } catch (error: unknown) {
    console.error("[book-now/sales-documents GET] Error:", error);
    return NextResponse.json(
      { ok: false, error: "Could not load quotations and invoices." },
      { status: 500 }
    );
  }
}
