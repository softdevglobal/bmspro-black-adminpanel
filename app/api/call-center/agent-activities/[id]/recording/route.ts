import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";
import {
  verifyCallCenterOrTenantAdminAuth,
  canAccessWorkshopForAuth,
  CORS_HEADERS,
} from "@/lib/callCenterAuth";
import { fetchRecordingBuffer, resolveRecordingFields } from "@/lib/agentActivityRecording";

export const runtime = "nodejs";

const COLLECTION = "agent_activities";

export async function OPTIONS() {
  return NextResponse.json({}, { headers: CORS_HEADERS });
}

/**
 * GET /api/call-center/agent-activities/{id}/recording?ownerId=<uid>&download=1
 *
 * Streams the call recording for an agent activity. Uses the stored recording URL
 * (https, gs://, or Firebase Storage) server-side so the admin panel can play and
 * download without CORS issues.
 */
export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const gate = await verifyCallCenterOrTenantAdminAuth(req);
  if (!gate.success) {
    return NextResponse.json(
      { error: gate.error },
      { status: gate.status || 401, headers: CORS_HEADERS }
    );
  }

  const { id } = await context.params;
  const ownerId =
    req.nextUrl.searchParams.get("ownerId")?.trim() ||
    req.nextUrl.searchParams.get("ownerUid")?.trim() ||
    "";
  const download = req.nextUrl.searchParams.get("download") === "1";

  if (!id) {
    return NextResponse.json({ error: "Missing activity id" }, { status: 400, headers: CORS_HEADERS });
  }
  if (!ownerId) {
    return NextResponse.json({ error: "Missing ownerId query parameter" }, { status: 400, headers: CORS_HEADERS });
  }
  if (!canAccessWorkshopForAuth(gate.auth, ownerId)) {
    return NextResponse.json({ error: "Access denied for this workshop" }, { status: 403, headers: CORS_HEADERS });
  }

  try {
    const db = adminDb();
    const snap = await db.collection(COLLECTION).doc(id).get();
    if (!snap.exists) {
      return NextResponse.json({ error: "Activity not found" }, { status: 404, headers: CORS_HEADERS });
    }

    const data = snap.data()!;
    if (String(data.ownerId || "") !== ownerId) {
      return NextResponse.json({ error: "Activity not found" }, { status: 404, headers: CORS_HEADERS });
    }

    const { recordingUrl, recordingFileName } = resolveRecordingFields(data, String(data.callId || ""));
    if (!recordingUrl) {
      return NextResponse.json({ error: "No recording for this activity" }, { status: 404, headers: CORS_HEADERS });
    }

    const { buffer, contentType } = await fetchRecordingBuffer(recordingUrl, recordingFileName);
    const baseName = recordingFileName.replace(/[^\w.\-()+ ]/g, "_") || `recording-${id}`;
    const safeName =
      contentType === "audio/wav" && !/\.(wav|wave)$/i.test(baseName)
        ? `${baseName}.wav`
        : baseName;
    const disposition = download
      ? `attachment; filename="${safeName}"`
      : `inline; filename="${safeName}"`;

    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        ...CORS_HEADERS,
        "Content-Type": contentType,
        "Content-Disposition": disposition,
        "Content-Length": String(buffer.length),
        "Cache-Control": "private, max-age=300",
      },
    });
  } catch (error: unknown) {
    console.error("[call-center/agent-activities/recording GET] Error:", error);
    const message = error instanceof Error ? error.message : "Failed to load recording";
    const unsupported =
      message.includes("Unsupported") ||
      message.includes("browsers cannot play") ||
      message.includes("not audio");
    return NextResponse.json(
      { error: message },
      { status: unsupported ? 415 : 502, headers: CORS_HEADERS }
    );
  }
}
