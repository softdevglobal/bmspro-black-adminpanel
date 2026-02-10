import { NextRequest, NextResponse } from "next/server";
import { createAuditLogServer } from "@/lib/auditLogServer";
import { verifyAdminAuth, ADMIN_ROLES, verifyTenantAccess } from "@/lib/authHelpers";
import { checkRateLimit, getClientIdentifier, RateLimiters, getRateLimitHeaders } from "@/lib/rateLimiterDistributed";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    // Security: Distributed rate limiting to prevent audit log spam
    const clientId = getClientIdentifier(req);
    const rateLimitResult = await checkRateLimit(clientId, RateLimiters.auditLog);
    
    if (!rateLimitResult.success) {
      return NextResponse.json(
        { 
          error: "Too many requests. Please try again later.",
          retryAfter: rateLimitResult.retryAfter,
        },
        { 
          status: 429,
          headers: getRateLimitHeaders(rateLimitResult),
        }
      );
    }

    // Security: Verify authentication - allow staff, branch admins, and owners to create audit logs
    // Allow salon_staff for logging check-ins from the mobile app
    const allowedRoles = [...ADMIN_ROLES, "salon_staff"];
    const authResult = await verifyAdminAuth(req, allowedRoles);
    if (!authResult.success) {
      return NextResponse.json(
        { error: authResult.error },
        { status: authResult.status }
      );
    }

    const { userData } = authResult;
    
    const body = await req.json();
    const {
      ownerUid,
      action,
      actionType,
      entityType,
      entityId,
      entityName,
      performedBy,
      performedByName,
      performedByRole,
      details,
      previousValue,
      newValue,
      branchId,
      branchName,
      metadata,
    } = body;

    // Validate required fields
    if (!ownerUid || !action || !actionType || !entityType || !performedBy) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      );
    }

    // Security: Verify tenant isolation - users can only create audit logs for their own salon
    if (!verifyTenantAccess(ownerUid, userData.ownerUid)) {
      return NextResponse.json(
        { error: "You can only create audit logs for your own salon" },
        { status: 403 }
      );
    }

    // Security: Override performedBy fields with authenticated user's data
    // This prevents spoofing of who performed the action
    const securePerformedBy = userData.uid;
    const securePerformedByName = userData.name || performedByName || "Unknown User";
    const securePerformedByRole = userData.role || performedByRole;

    const logId = await createAuditLogServer({
      ownerUid: userData.ownerUid, // Use verified ownerUid
      action,
      actionType,
      entityType,
      entityId,
      entityName,
      performedBy: securePerformedBy, // Use authenticated user's UID
      performedByName: securePerformedByName, // Use authenticated user's name
      performedByRole: securePerformedByRole, // Use authenticated user's role
      details,
      previousValue,
      newValue,
      branchId,
      branchName,
      metadata,
    });

    if (!logId) {
      return NextResponse.json(
        { error: "Failed to create audit log" },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true, logId }, { status: 200 });
  } catch (err: any) {
    console.error("API Error:", err);
    const message = process.env.NODE_ENV === "production" 
      ? "Internal Server Error" 
      : err?.message || "Internal Server Error";
    return NextResponse.json(
      { error: message },
      { status: 500 }
    );
  }
}
