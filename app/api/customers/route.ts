import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";
import { verifyAdminAuth } from "@/lib/authHelpers";

export const runtime = "nodejs";

const READ_ROLES = ["workshop_owner", "branch_admin"];
const SCAN_LIMIT = 2000;
const RESULT_LIMIT = 25;

type CustomerRow = {
  id: string;
  name: string;
  email: string;
  phone: string;
  address: {
    street: string;
    suburb: string;
    state: string;
    postcode: string;
  } | null;
};

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function mapAddress(raw: unknown): CustomerRow["address"] {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const street = asString(record.street);
  const suburb = asString(record.suburb);
  const state = asString(record.state);
  const postcode = asString(record.postcode).replace(/\D/g, "").slice(0, 4);
  if (!street && !suburb && !state && !postcode) return null;
  return { street, suburb, state, postcode };
}

function mapCustomer(id: string, data: FirebaseFirestore.DocumentData): CustomerRow {
  return {
    id,
    name: asString(data.name || data.client),
    email: asString(data.email).toLowerCase(),
    phone: asString(data.phone || data.clientPhone),
    address: mapAddress(data.address ?? data.billingAddress),
  };
}

/**
 * GET /api/customers?q=searchTerm
 *
 * Search workshop customers by name, email, or phone for quote/invoice autofill.
 * Without `q`, returns a short recent list for browsing.
 */
export async function GET(req: NextRequest) {
  const auth = await verifyAdminAuth(req, READ_ROLES);
  if (!auth.success || !auth.userData) {
    return NextResponse.json(
      { ok: false, error: auth.error },
      { status: auth.status || 401 },
    );
  }

  const q = (req.nextUrl.searchParams.get("q") || "").trim().toLowerCase();
  const normalizedQ = q.replace(/[\s\-()]/g, "");

  try {
    const snap = await adminDb()
      .collection("customers")
      .where("ownerUid", "==", auth.userData.ownerUid)
      .limit(SCAN_LIMIT)
      .get();

    const customers: CustomerRow[] = [];

    for (const doc of snap.docs) {
      const row = mapCustomer(doc.id, doc.data());
      if (!row.name && !row.email && !row.phone) continue;

      if (q) {
        const name = row.name.toLowerCase();
        const email = row.email.toLowerCase();
        const phone = row.phone.replace(/[\s\-()]/g, "");
        const matched =
          (name && name.includes(q)) ||
          (email && email.includes(q)) ||
          (phone && normalizedQ.length > 0 && phone.includes(normalizedQ));
        if (!matched) continue;
      }

      customers.push(row);
      if (customers.length >= RESULT_LIMIT) break;
    }

    customers.sort((a, b) => a.name.localeCompare(b.name) || a.email.localeCompare(b.email));

    return NextResponse.json({ ok: true, customers, total: customers.length });
  } catch (error) {
    console.error("[customers GET] Error:", error);
    return NextResponse.json(
      { ok: false, error: "Could not load customers." },
      { status: 500 },
    );
  }
}
