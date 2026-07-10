import { NextRequest, NextResponse } from "next/server";
import { verifyAdminAuth } from "@/lib/authHelpers";
import { listSmsLogsForBusiness } from "@/lib/sms/sms-log-server";
import { formatSmsLogSource, formatSmsStatusDetail } from "@/lib/sms/sms-log-display";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const auth = await verifyAdminAuth(req, ["workshop_owner"]);
  if (!auth.success || !auth.userData) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status ?? 401 });
  }

  try {
    const rawLogs = await listSmsLogsForBusiness(auth.userData.ownerUid, 100);
    const logs = rawLogs.map((log) => ({
      ...log,
      createdAt: log.createdAt?.toISOString() ?? null,
      sourceLabel: formatSmsLogSource(log.source),
      statusLabel: formatSmsStatusDetail(log.statusDetail),
    }));
    return NextResponse.json({ ok: true, logs });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to load SMS logs";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
