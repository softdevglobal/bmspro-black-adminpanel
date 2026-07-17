import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/broadcasts/auth";
import { listSmsLogs } from "@/lib/sms/sms-log-server";
import { listTenantSmsUsage } from "@/lib/sms-packages/server";
import { formatSmsLogSource, formatSmsStatusDetail } from "@/lib/sms/sms-log-display";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  try {
    const [rawLogs, tenants] = await Promise.all([listSmsLogs(200), listTenantSmsUsage()]);

    const tenantByUid = new Map(
      tenants.map((tenant) => [
        tenant.ownerUid,
        { name: tenant.name, email: tenant.email },
      ]),
    );

    const logs = rawLogs.map((log) => {
      const tenant = log.ownerUid ? tenantByUid.get(log.ownerUid) : null;
      return {
        ...log,
        createdAt: log.createdAt?.toISOString() ?? null,
        tenantName: tenant?.name ?? null,
        tenantEmail: tenant?.email ?? null,
        sourceLabel: formatSmsLogSource(log.source),
        statusLabel: formatSmsStatusDetail(log.statusDetail),
      };
    });

    return NextResponse.json({ ok: true, logs });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to load SMS logs";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
