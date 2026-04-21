import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";
import {
  verifyCallCenterOrTenantAdminAuth,
  canAccessWorkshopForAuth,
  getTenantId,
  CORS_HEADERS,
} from "@/lib/callCenterAuth";

export const runtime = "nodejs";

export async function OPTIONS() {
  return NextResponse.json({}, { headers: CORS_HEADERS });
}

/** Keep only the roles that represent people who can handle bookings. */
const STAFF_ROLES = new Set(["staff", "branch_admin"]);

type StaffPayload = {
  id: string;
  uid: string;
  name: string;
  email: string;
  mobile: string;
  role: string;
  staffRole: string;
  branchId: string;
  branchName: string;
  status: string;
  avatar: string | null;
  timezone: string | null;
  weeklySchedule: Record<string, unknown> | null;
  training: Record<string, unknown> | null;
  createdAt: unknown;
  updatedAt: unknown;
};

function resolveBranchIdsForStaff(staff: Record<string, unknown>): string[] {
  const ids = new Set<string>();
  const direct = typeof staff.branchId === "string" ? staff.branchId.trim() : "";
  if (direct) ids.add(direct);
  const ws = staff.weeklySchedule;
  if (ws && typeof ws === "object") {
    for (const day of Object.values(ws as Record<string, unknown>)) {
      if (day && typeof day === "object") {
        const b = (day as Record<string, unknown>).branchId;
        if (typeof b === "string" && b.trim()) ids.add(b.trim());
      }
    }
  }
  return [...ids];
}

/**
 * GET /api/call-center/staff
 *
 * Required: pass workshop owner via either
 *   Header:  X-Tenant-Id: <ownerUid>
 *   or query: ?ownerUid=<ownerUid>
 *
 * Optional query:
 *   branchId=<id>            Only return staff whose home branch OR weekly
 *                            schedule includes this branch.
 *   role=staff|branch_admin  Filter by role (default returns both).
 *   status=Active|Suspended  Filter by status (default returns all).
 *
 * List active workshop staff (role: `staff` or `branch_admin`) for the given
 * workshop. Used by call center agents to pick the right staff member when
 * creating or assigning a booking.
 */
export async function GET(req: NextRequest) {
  const gate = await verifyCallCenterOrTenantAdminAuth(req);
  if (!gate.success) {
    return NextResponse.json(
      { error: gate.error },
      { status: gate.status || 401, headers: CORS_HEADERS }
    );
  }

  const ownerUid = getTenantId(req);
  if (!ownerUid) {
    return NextResponse.json(
      { error: "Missing ownerUid (X-Tenant-Id header or ?ownerUid=)" },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  if (!canAccessWorkshopForAuth(gate.auth, ownerUid)) {
    return NextResponse.json(
      { error: "Access denied" },
      { status: 403, headers: CORS_HEADERS }
    );
  }

  const branchId = (req.nextUrl.searchParams.get("branchId") || "").trim();
  const roleFilter = (req.nextUrl.searchParams.get("role") || "").trim().toLowerCase();
  const statusFilter = (req.nextUrl.searchParams.get("status") || "").trim();

  if (roleFilter && !STAFF_ROLES.has(roleFilter)) {
    return NextResponse.json(
      { error: "role must be one of: staff, branch_admin" },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  try {
    const db = adminDb();
    const snap = await db
      .collection("users")
      .where("ownerUid", "==", ownerUid)
      .get();

    const staff: StaffPayload[] = [];
    for (const doc of snap.docs) {
      const d = doc.data() as Record<string, unknown>;
      const role = String(d.role || "").toLowerCase();
      if (!STAFF_ROLES.has(role)) continue;
      if (roleFilter && role !== roleFilter) continue;

      const status = String(d.status || "Active");
      if (statusFilter && status !== statusFilter) continue;

      if (branchId) {
        const branchIds = resolveBranchIdsForStaff(d);
        if (!branchIds.includes(branchId)) continue;
      }

      staff.push({
        id: doc.id,
        uid: String(d.uid || doc.id),
        name: String(d.name || d.displayName || "Staff"),
        email: String(d.email || ""),
        mobile: String(d.mobile || ""),
        role,
        staffRole: String(d.staffRole || ""),
        branchId: String(d.branchId || ""),
        branchName: String(d.branchName || ""),
        status,
        avatar: (d.avatar as string | null | undefined) || null,
        timezone: (d.timezone as string | null | undefined) || null,
        weeklySchedule:
          (d.weeklySchedule as Record<string, unknown> | null | undefined) || null,
        training:
          (d.training as Record<string, unknown> | null | undefined) || null,
        createdAt: d.createdAt ?? null,
        updatedAt: d.updatedAt ?? null,
      });
    }

    staff.sort((a, b) => a.name.localeCompare(b.name));

    return NextResponse.json(
      { staff, total: staff.length },
      { headers: CORS_HEADERS }
    );
  } catch (error) {
    console.error("[call-center/staff GET] Error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
