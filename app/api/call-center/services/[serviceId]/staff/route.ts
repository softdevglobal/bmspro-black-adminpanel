import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";
import {
  verifyCallCenterOrTenantAdminAuth,
  canAccessWorkshopForAuth,
  CORS_HEADERS,
} from "@/lib/callCenterAuth";
import { serializeCallCenterServicePricing } from "@/lib/callCenterServicePricing";

export const runtime = "nodejs";

export async function OPTIONS() {
  return NextResponse.json({}, { headers: CORS_HEADERS });
}

/** Which user roles are allowed to take assignments on bookings. */
const STAFF_ROLES = new Set(["staff", "branch_admin"]);

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/**
 * Derive weekday name (e.g. "Tuesday") from a YYYY-MM-DD date string, treating
 * the date as UTC midnight so the weekday does not shift with the server TZ.
 */
function dayNameFromDate(date: string | null): string | null {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return DAY_NAMES[d.getUTCDay()];
}

/**
 * Decide whether a staff member works at `branchId` on `dayName`. Mirrors the
 * filter used by the admin panel + mobile app so the call-center picker shows
 * exactly the same shortlist as the workshop admin would see.
 *
 * Rules (in order):
 *   1. No branch filter → always works.
 *   2. If the staff has a `weeklySchedule`:
 *      • No entry for `dayName` → staff is OFF that day.
 *      • `{ closed: true }` → OFF.
 *      • Has `branchId` / `branchName` → must match.
 *      • Hours-only entry → falls back to the primary branch.
 *   3. No weeklySchedule → primary `branchId` / `branch` must match.
 */
function staffWorksAtBranch(
  staff: Record<string, unknown>,
  branchId: string,
  dayName: string | null,
  branchName: string,
): boolean {
  if (!branchId) return true;

  const staffBranchId = String(staff.branchId || "").trim();
  const staffBranchName = String(staff.branch || "").trim();

  if (dayName) {
    const schedule = staff.weeklySchedule as
      | Record<string, unknown>
      | null
      | undefined;
    if (schedule && typeof schedule === "object") {
      const daySchedule = schedule[dayName];
      if (daySchedule == null) return false;
      if (typeof daySchedule === "object") {
        const ds = daySchedule as Record<string, unknown>;
        if (ds.closed === true) return false;

        const scheduledBranchId = String(ds.branchId || "").trim();
        const scheduledBranchName = String(ds.branchName || "").trim();

        if (scheduledBranchId || scheduledBranchName) {
          return (
            scheduledBranchId === branchId ||
            (!!branchName &&
              !!scheduledBranchName &&
              scheduledBranchName === branchName)
          );
        }
        return (
          staffBranchId === branchId ||
          (!!branchName && !!staffBranchName && staffBranchName === branchName)
        );
      }
      return false;
    }
  }

  return (
    staffBranchId === branchId ||
    (!!branchName && !!staffBranchName && staffBranchName === branchName)
  );
}

/**
 * GET /api/call-center/services/[serviceId]/staff
 *
 * Returns staff who are eligible to perform this specific service right now.
 * Mirrors the staff-assignment picker shown inside the admin panel and mobile
 * app, so the call-center agent sees the same shortlist the workshop admin
 * would see when picking who to put on a service for a booking.
 *
 * Filters applied server-side:
 *   • Role must be `staff` or `branch_admin`.
 *   • Staff must not be `Suspended`.
 *   • If the service has a `staffIds[]` allow-list, the staff must be in it.
 *   • When `branchId` is provided, the staff must work at that branch
 *     (either via their primary `branchId` / `branch`, or via their weekly
 *     schedule for the supplied `date`).
 *   • When `date` is provided, the staff must not be OFF that weekday.
 *
 * Query:
 *   branchId?    — scope to a branch (recommended when a booking has one)
 *   date?        — YYYY-MM-DD (enables day-of-week schedule filtering)
 *
 * Auth: call-center agent JWT, or BMS workshop-owner / branch-admin JWT with
 * access to the service's workshop.
 */
export async function GET(
  req: NextRequest,
  context: { params: Promise<{ serviceId: string }> },
) {
  const gate = await verifyCallCenterOrTenantAdminAuth(req);
  if (!gate.success) {
    return NextResponse.json(
      { error: gate.error },
      { status: gate.status || 401, headers: CORS_HEADERS },
    );
  }

  const { serviceId } = await context.params;
  if (!serviceId) {
    return NextResponse.json(
      { error: "Missing serviceId" },
      { status: 400, headers: CORS_HEADERS },
    );
  }

  const branchId = (req.nextUrl.searchParams.get("branchId") || "").trim();
  const date = (req.nextUrl.searchParams.get("date") || "").trim() || null;
  const dayName = dayNameFromDate(date);
  if (date && !dayName) {
    return NextResponse.json(
      { error: "`date` must be a valid YYYY-MM-DD date." },
      { status: 400, headers: CORS_HEADERS },
    );
  }

  try {
    const db = adminDb();

    // ── Load the service ──────────────────────────────────────────────────
    const serviceDoc = await db.doc(`services/${serviceId}`).get();
    if (!serviceDoc.exists) {
      return NextResponse.json(
        { error: "Service not found" },
        { status: 404, headers: CORS_HEADERS },
      );
    }
    const service = serviceDoc.data() as Record<string, unknown>;
    const ownerUid = String(service.ownerUid ?? "").trim();
    if (!ownerUid) {
      return NextResponse.json(
        { error: "Service is missing owner information" },
        { status: 422, headers: CORS_HEADERS },
      );
    }

    if (!canAccessWorkshopForAuth(gate.auth, ownerUid)) {
      return NextResponse.json(
        { error: "Access denied" },
        { status: 403, headers: CORS_HEADERS },
      );
    }

    const allowedStaffIds: string[] = Array.isArray(service.staffIds)
      ? (service.staffIds as unknown[]).map(String)
      : [];
    const allowedStaffSet = new Set(allowedStaffIds);
    const serviceHasAllowList = allowedStaffSet.size > 0;

    // Resolve branch name once (used by the weekly-schedule matcher as a
    // fallback when staff docs only store the branch name, not its id).
    let branchName = "";
    if (branchId) {
      const branchSnap = await db.doc(`branches/${branchId}`).get();
      if (branchSnap.exists) {
        branchName = String(branchSnap.data()?.name || "").trim();
      }
    }

    // ── Load workshop staff and filter ────────────────────────────────────
    const usersSnap = await db
      .collection("users")
      .where("ownerUid", "==", ownerUid)
      .get();

    type StaffPayload = {
      id: string;
      uid: string;
      name: string;
      email: string;
      role: string;
      staffRole: string;
      branchId: string | null;
      branchName: string | null;
      status: string;
      avatar: string | null;
      inServiceAllowList: boolean;
    };

    const staff: StaffPayload[] = [];
    for (const doc of usersSnap.docs) {
      const d = doc.data() as Record<string, unknown>;
      const role = String(d.role || "").toLowerCase();
      if (!STAFF_ROLES.has(role)) continue;

      const status = String(d.status || "Active");
      if (status === "Suspended" || status === "suspended") continue;

      const id = doc.id;
      if (serviceHasAllowList && !allowedStaffSet.has(id)) continue;

      if (!staffWorksAtBranch(d, branchId, dayName, branchName)) continue;

      staff.push({
        id,
        uid: String(d.uid || id),
        name: String(d.displayName || d.name || "Staff"),
        email: String(d.email || ""),
        role,
        staffRole: String(d.staffRole || ""),
        branchId: (d.branchId as string | null | undefined) || null,
        branchName: (d.branch as string | null | undefined) || null,
        status,
        avatar: (d.avatar as string | null | undefined) || null,
        inServiceAllowList: serviceHasAllowList
          ? allowedStaffSet.has(id)
          : true,
      });
    }

    // Prefer staff whose home branch matches (when a branch filter is set),
    // then sort alphabetically for a predictable picker order.
    staff.sort((a, b) => {
      if (branchId) {
        const aMatches = a.branchId === branchId ? 0 : 1;
        const bMatches = b.branchId === branchId ? 0 : 1;
        if (aMatches !== bMatches) return aMatches - bMatches;
      }
      return a.name.localeCompare(b.name);
    });

    const pricing = serializeCallCenterServicePricing(service);

    return NextResponse.json(
      {
        service: {
          id: serviceDoc.id,
          name: String(service.name || ""),
          hasStaffAllowList: serviceHasAllowList,
          staffIds: allowedStaffIds,
          ...pricing,
        },
        filter: {
          branchId: branchId || null,
          branchName: branchName || null,
          date: date || null,
          dayName: dayName || null,
        },
        staff,
        total: staff.length,
      },
      { headers: CORS_HEADERS },
    );
  } catch (error) {
    console.error("[call-center/services/[id]/staff] Error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500, headers: CORS_HEADERS },
    );
  }
}
