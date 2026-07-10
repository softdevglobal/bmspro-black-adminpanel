import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";
import { verifyAdminAuth } from "@/lib/authHelpers";
import { parseItemInput } from "@/lib/itemsCatalog";

export const runtime = "nodejs";

const ITEM_COLLECTION = "items";
const READ_ROLES = ["workshop_owner", "branch_admin"];
const WRITE_ROLES = ["workshop_owner", "branch_admin"];

type ItemDoc = {
  ownerUid: string;
  name: string;
  nameLower: string;
  code: string | null;
  description: string | null;
  priceAud: number;
  createdAt?: FirebaseFirestore.Timestamp | Date | null;
  updatedAt?: FirebaseFirestore.Timestamp | Date | null;
};

function toMillis(value: unknown): number | null {
  if (!value) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "object" && value !== null && "toMillis" in value) {
    try {
      return (value as FirebaseFirestore.Timestamp).toMillis();
    } catch {
      return null;
    }
  }
  return null;
}

function mapItem(id: string, data: FirebaseFirestore.DocumentData) {
  return {
    id,
    name: (data.name as string) ?? "",
    code: (data.code as string | null) ?? null,
    description: (data.description as string | null) ?? null,
    priceAud: typeof data.priceAud === "number" ? data.priceAud : 0,
    createdAt: toMillis(data.createdAt),
    updatedAt: toMillis(data.updatedAt),
  };
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

export async function GET(req: NextRequest) {
  const auth = await verifyAdminAuth(req, READ_ROLES);
  if (!auth.success || !auth.userData) {
    return NextResponse.json(
      { ok: false, error: auth.error },
      { status: auth.status || 401 },
    );
  }

  try {
    const snap = await adminDb()
      .collection(ITEM_COLLECTION)
      .where("ownerUid", "==", auth.userData.ownerUid)
      .get();

    const items = snap.docs
      .map((doc) => mapItem(doc.id, doc.data()))
      .sort((a, b) => a.name.localeCompare(b.name));

    return NextResponse.json({ ok: true, items });
  } catch (error) {
    console.error("[items GET] Error:", error);
    return NextResponse.json(
      { ok: false, error: "Could not load items." },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  const auth = await verifyAdminAuth(req, WRITE_ROLES);
  if (!auth.success || !auth.userData) {
    return NextResponse.json(
      { ok: false, error: auth.error },
      { status: auth.status || 401 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid request body." },
      { status: 400 },
    );
  }

  const input = parseItemInput(body);
  if (!input) {
    return NextResponse.json(
      { ok: false, error: "Provide a valid item name and price." },
      { status: 400 },
    );
  }

  try {
    const db = adminDb();
    const ownerUid = auth.userData.ownerUid;
    const nameLower = normalizeName(input.name);
    const now = new Date();

    // Dedup by normalized name within this owner's catalog.
    const existing = await db
      .collection(ITEM_COLLECTION)
      .where("ownerUid", "==", ownerUid)
      .where("nameLower", "==", nameLower)
      .limit(1)
      .get();

    if (!existing.empty) {
      const docRef = existing.docs[0].ref;
      await docRef.set(
        {
          name: input.name,
          nameLower,
          code: input.code,
          description: input.description,
          priceAud: input.priceAud,
          updatedAt: now,
        },
        { merge: true },
      );
      const fresh = await docRef.get();
      return NextResponse.json({ ok: true, item: mapItem(docRef.id, fresh.data()!) });
    }

    const payload: ItemDoc = {
      ownerUid,
      name: input.name,
      nameLower,
      code: input.code,
      description: input.description,
      priceAud: input.priceAud,
      createdAt: now,
      updatedAt: now,
    };
    const ref = await db.collection(ITEM_COLLECTION).add(payload);
    const fresh = await ref.get();
    return NextResponse.json(
      { ok: true, item: mapItem(ref.id, fresh.data()!) },
      { status: 201 },
    );
  } catch (error) {
    console.error("[items POST] Error:", error);
    return NextResponse.json(
      { ok: false, error: "Could not save item." },
      { status: 500 },
    );
  }
}
