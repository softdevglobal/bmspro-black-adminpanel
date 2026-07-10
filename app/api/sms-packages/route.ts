import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/broadcasts/auth";
import {
  countTenantsBySmsPackage,
  createSmsPackage,
  deleteSmsPackage,
  isStripeConfiguredForSms,
  listSmsPackages,
  updateSmsPackage,
} from "@/lib/sms-packages/server";
import { syncSmsPackageToStripe } from "@/lib/stripe/fulfill";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  try {
    const packages = await listSmsPackages({ includeInactive: true });
    const tenantCounts = await countTenantsBySmsPackage();
    return NextResponse.json({ ok: true, packages, tenantCounts });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to list SMS packages";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  try {
    const body = await req.json();
    if (!body.name || body.price == null || !body.priceLabel || body.messageQuota == null) {
      return NextResponse.json(
        { ok: false, error: "name, price, priceLabel, and messageQuota are required" },
        { status: 400 },
      );
    }

    const pkg = await createSmsPackage({
      name: String(body.name),
      price: Number(body.price),
      priceLabel: String(body.priceLabel),
      messageQuota: Number(body.messageQuota),
      description: body.description,
      features: body.features,
      active: body.active,
      hidden: body.hidden,
      popular: body.popular,
      color: body.color,
      icon: body.icon,
      plan_key: body.plan_key,
    });

    let saved = pkg;
    if (isStripeConfiguredForSms() && pkg.active && !pkg.hidden) {
      try {
        saved = await syncSmsPackageToStripe(pkg.id);
      } catch (syncError) {
        console.error("[SMS PACKAGES] Stripe sync failed on create:", syncError);
      }
    }

    return NextResponse.json({ ok: true, package: saved });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to create SMS package";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  try {
    const body = await req.json();
    const id = String(body.id ?? "").trim();
    if (!id) {
      return NextResponse.json({ ok: false, error: "id is required" }, { status: 400 });
    }

    const pkg = await updateSmsPackage(id, body);

    let saved = pkg;
    if (isStripeConfiguredForSms() && pkg.active && !pkg.hidden) {
      try {
        saved = await syncSmsPackageToStripe(pkg.id);
      } catch (syncError) {
        console.error("[SMS PACKAGES] Stripe sync failed on update:", syncError);
      }
    }

    return NextResponse.json({ ok: true, package: saved });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to update SMS package";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  try {
    const id = req.nextUrl.searchParams.get("id")?.trim();
    if (!id) {
      return NextResponse.json({ ok: false, error: "id query param is required" }, { status: 400 });
    }
    await deleteSmsPackage(id);
    return NextResponse.json({ ok: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to delete SMS package";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
