import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/broadcasts/auth";
import { listSmsPackages, listTenantSmsUsage } from "@/lib/sms-packages/server";
import { adminDb } from "@/lib/firebaseAdmin";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  try {
    const [tenants, packages] = await Promise.all([
      listTenantSmsUsage(),
      listSmsPackages({ includeInactive: true }),
    ]);
    let purchases: Array<Record<string, unknown>> = [];

    try {
      const purchasesSnap = await adminDb()
        .collection("stripe_fulfilled_sessions")
        .where("type", "==", "sms_topup")
        .orderBy("fulfilledAt", "desc")
        .limit(100)
        .get();

      purchases = purchasesSnap.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
        fulfilledAt:
          doc.data().fulfilledAt?.toDate?.()?.toISOString?.() ??
          doc.data().fulfilledAt ??
          null,
      }));
    } catch (error) {
      console.warn("[SMS usage] purchases fallback (no index):", error);
      const purchasesSnap = await adminDb()
        .collection("stripe_fulfilled_sessions")
        .where("type", "==", "sms_topup")
        .limit(100)
        .get();
      purchases = purchasesSnap.docs
        .map((doc) => ({
          id: doc.id,
          ...doc.data(),
          fulfilledAt:
            doc.data().fulfilledAt?.toDate?.()?.toISOString?.() ??
            doc.data().fulfilledAt ??
            null,
        }))
        .sort((a, b) => {
          const aTime = a.fulfilledAt ? new Date(String(a.fulfilledAt)).getTime() : 0;
          const bTime = b.fulfilledAt ? new Date(String(b.fulfilledAt)).getTime() : 0;
          return bTime - aTime;
        });
    }

    const tenantByUid = new Map(
      tenants.map((tenant) => [
        tenant.ownerUid,
        { name: tenant.name, email: tenant.email },
      ]),
    );

    const packageById = new Map(packages.map((pkg) => [pkg.id, pkg]));

    purchases = purchases.map((purchase) => {
      const ownerUid = String(purchase.ownerUid ?? purchase.businessId ?? "");
      const tenant = tenantByUid.get(ownerUid);
      const packageId = String(purchase.smsPackageId ?? "");
      const pkg = packageId ? packageById.get(packageId) : null;
      const storedQuota =
        typeof purchase.messageQuota === "number" ? purchase.messageQuota : null;
      const messageQuota = storedQuota ?? pkg?.messageQuota ?? null;

      return {
        ...purchase,
        ownerUid: ownerUid || null,
        tenantName: tenant?.name ?? null,
        tenantEmail: tenant?.email ?? null,
        smsPackageName: purchase.smsPackageName ?? pkg?.name ?? null,
        messageQuota,
      };
    });

    return NextResponse.json({ ok: true, tenants, purchases });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to load SMS usage";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
