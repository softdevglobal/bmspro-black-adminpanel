import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";
import { verifyAdminAuth } from "@/lib/authHelpers";
import { parseItemInput } from "@/lib/itemsCatalog";

export const runtime = "nodejs";

const ITEM_COLLECTION = "items";
const WRITE_ROLES = ["workshop_owner", "branch_admin"];

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

function mapItem(id: string, data: FirebaseFirestore.DocumentData) {
  const toMillis = (value: unknown): number | null => {
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
  };
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

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await verifyAdminAuth(req, WRITE_ROLES);
  if (!auth.success || !auth.userData) {
    return NextResponse.json(
      { ok: false, error: auth.error },
      { status: auth.status || 401 },
    );
  }

  const { id } = await context.params;

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
    const ref = db.collection(ITEM_COLLECTION).doc(id);
    const snap = await ref.get();
    if (!snap.exists || snap.data()?.ownerUid !== auth.userData.ownerUid) {
      return NextResponse.json(
        { ok: false, error: "Item not found." },
        { status: 404 },
      );
    }

    await ref.set(
      {
        name: input.name,
        nameLower: normalizeName(input.name),
        code: input.code,
        description: input.description,
        priceAud: input.priceAud,
        updatedAt: new Date(),
      },
      { merge: true },
    );
    const fresh = await ref.get();
    return NextResponse.json({ ok: true, item: mapItem(ref.id, fresh.data()!) });
  } catch (error) {
    console.error("[items PATCH] Error:", error);
    return NextResponse.json(
      { ok: false, error: "Could not update item." },
      { status: 500 },
    );
  }
}

export async function DELETE(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await verifyAdminAuth(req, WRITE_ROLES);
  if (!auth.success || !auth.userData) {
    return NextResponse.json(
      { ok: false, error: auth.error },
      { status: auth.status || 401 },
    );
  }

  const { id } = await context.params;

  try {
    const db = adminDb();
    const ref = db.collection(ITEM_COLLECTION).doc(id);
    const snap = await ref.get();
    if (!snap.exists || snap.data()?.ownerUid !== auth.userData.ownerUid) {
      return NextResponse.json(
        { ok: false, error: "Item not found." },
        { status: 404 },
      );
    }

    await ref.delete();
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[items DELETE] Error:", error);
    return NextResponse.json(
      { ok: false, error: "Could not delete item." },
      { status: 500 },
    );
  }
}
