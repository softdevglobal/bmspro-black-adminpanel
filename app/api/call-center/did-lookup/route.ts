import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";
import {
  verifyCallCenterAuth,
  CORS_HEADERS,
} from "@/lib/callCenterAuth";

export const runtime = "nodejs";

export async function OPTIONS() {
  return NextResponse.json({}, { headers: CORS_HEADERS });
}

/**
 * GET /api/call-center/did-lookup?did=+61412345678
 *
 * Resolves an incoming DID (phone number) to a workshop tenant.
 * Looks up `did_mappings` collection where each doc maps a DID to an ownerUid.
 * Falls back to searching `branches` by phone number.
 *
 * Returns: workshop profile, branches, and matched DID info.
 */
export async function GET(req: NextRequest) {
  const auth = await verifyCallCenterAuth(req);
  if (!auth.success || !auth.user) {
    return NextResponse.json(
      { error: auth.error },
      { status: auth.status || 401, headers: CORS_HEADERS }
    );
  }

  const did = req.nextUrl.searchParams.get("did")?.trim();
  if (!did) {
    return NextResponse.json(
      { error: "Missing 'did' query parameter" },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  try {
    const db = adminDb();

    // Strategy 1: Check the did_mappings collection (pre-configured)
    const mappingSnap = await db
      .collection("did_mappings")
      .where("did", "==", did)
      .where("active", "==", true)
      .limit(1)
      .get();

    if (!mappingSnap.empty) {
      const mapping = mappingSnap.docs[0].data();
      const ownerUid = mapping.ownerUid;

      const workshopDoc = await db.doc(`users/${ownerUid}`).get();
      if (!workshopDoc.exists) {
        return NextResponse.json(
          { error: "Mapped workshop not found" },
          { status: 404, headers: CORS_HEADERS }
        );
      }

      const ws = workshopDoc.data()!;
      return NextResponse.json(
        {
          matched: true,
          source: "did_mapping",
          workshop: {
            ownerUid,
            name: ws.name || ws.displayName || "",
            slug: ws.slug || "",
            logoUrl: ws.logoUrl || "",
            contactPhone: ws.contactPhone || "",
            email: ws.email || "",
            timezone: ws.timezone || "Australia/Sydney",
          },
          did: mapping.did,
          branchId: mapping.branchId || null,
          branchName: mapping.branchName || null,
          label: mapping.label || null,
        },
        { headers: CORS_HEADERS }
      );
    }

    // Strategy 2: Search branches by phone number
    const normalizedDid = did.replace(/[\s\-\(\)]/g, "");
    const branchesSnap = await db.collection("branches").get();
    let matchedBranch: any = null;
    let matchedOwnerUid: string | null = null;

    for (const doc of branchesSnap.docs) {
      const data = doc.data();
      const branchPhone = (data.phone || "").replace(/[\s\-\(\)]/g, "");
      if (branchPhone && branchPhone === normalizedDid) {
        matchedBranch = { id: doc.id, ...data };
        matchedOwnerUid = data.ownerUid;
        break;
      }
    }

    if (matchedBranch && matchedOwnerUid) {
      const workshopDoc = await db.doc(`users/${matchedOwnerUid}`).get();
      const ws = workshopDoc.exists ? workshopDoc.data()! : {};

      return NextResponse.json(
        {
          matched: true,
          source: "branch_phone",
          workshop: {
            ownerUid: matchedOwnerUid,
            name: ws.name || ws.displayName || "",
            slug: ws.slug || "",
            logoUrl: ws.logoUrl || "",
            contactPhone: ws.contactPhone || "",
            email: ws.email || "",
            timezone: ws.timezone || "Australia/Sydney",
          },
          did,
          branchId: matchedBranch.id,
          branchName: matchedBranch.name || "",
          label: null,
        },
        { headers: CORS_HEADERS }
      );
    }

    return NextResponse.json(
      { matched: false, did, message: "No workshop found for this DID" },
      { status: 404, headers: CORS_HEADERS }
    );
  } catch (error: any) {
    console.error("[call-center/did-lookup] Error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}

/**
 * POST /api/call-center/did-lookup
 *
 * Create or update a DID → Workshop mapping.
 * Only call_center_admin can do this.
 *
 * Body: { did, ownerUid, branchId?, branchName?, label? }
 */
export async function POST(req: NextRequest) {
  const auth = await verifyCallCenterAuth(req);
  if (!auth.success || !auth.user) {
    return NextResponse.json(
      { error: auth.error },
      { status: auth.status || 401, headers: CORS_HEADERS }
    );
  }

  if (!auth.user.isCCAdmin) {
    return NextResponse.json(
      { error: "Only call center admins can create DID mappings" },
      { status: 403, headers: CORS_HEADERS }
    );
  }

  try {
    const body = await req.json();
    const { did, ownerUid, branchId, branchName, label } = body;

    if (!did || !ownerUid) {
      return NextResponse.json(
        { error: "Missing required fields: did, ownerUid" },
        { status: 400, headers: CORS_HEADERS }
      );
    }

    const db = adminDb();

    // Verify the workshop exists
    const workshopDoc = await db.doc(`users/${ownerUid}`).get();
    if (!workshopDoc.exists) {
      return NextResponse.json(
        { error: "Workshop not found" },
        { status: 404, headers: CORS_HEADERS }
      );
    }

    // Upsert: check if mapping already exists
    const existingSnap = await db
      .collection("did_mappings")
      .where("did", "==", did)
      .limit(1)
      .get();

    const mappingData = {
      did,
      ownerUid,
      branchId: branchId || null,
      branchName: branchName || null,
      label: label || null,
      active: true,
      updatedAt: new Date(),
      updatedBy: auth.user.uid,
    };

    if (!existingSnap.empty) {
      await existingSnap.docs[0].ref.update(mappingData);
      return NextResponse.json(
        { success: true, id: existingSnap.docs[0].id, action: "updated" },
        { headers: CORS_HEADERS }
      );
    }

    const newDoc = await db.collection("did_mappings").add({
      ...mappingData,
      createdAt: new Date(),
      createdBy: auth.user.uid,
    });

    return NextResponse.json(
      { success: true, id: newDoc.id, action: "created" },
      { status: 201, headers: CORS_HEADERS }
    );
  } catch (error: any) {
    console.error("[call-center/did-lookup POST] Error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
