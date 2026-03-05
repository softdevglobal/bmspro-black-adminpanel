import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";
import { fetchImageBuffer } from "@/lib/fetchImageForPdf";

export const runtime = "nodejs";

/**
 * Debug API: Test if we can fetch an image for PDF generation.
 * GET /api/debug/fetch-pdf-image?url=ENCODED_IMAGE_URL
 * Or: GET /api/debug/fetch-pdf-image?bookingId=XXX (inspects booking and returns image URLs found)
 * Returns the image if successful, or JSON with error details.
 * Uses the same fetchImageBuffer as PDF generation for consistency.
 */
export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url");
  const bookingId = req.nextUrl.searchParams.get("bookingId");

  // Inspect booking: return image URLs found in tasks
  if (bookingId && !url) {
    try {
      const snap = await adminDb().collection("bookings").doc(bookingId).get();
      if (!snap.exists) {
        return NextResponse.json({ error: "Booking not found" }, { status: 404 });
      }
      const data = snap.data() as any;
      const imageUrls: string[] = [];
      const collect = (task: any) => {
        if (task?.done) {
          const u = task.imageUrl || task.image;
          if (u && typeof u === "string" && u.trim()) imageUrls.push(u.trim());
        }
      };
      for (const t of data?.tasks || []) collect(t);
      for (const svc of data?.services || []) {
        for (const item of (svc.checklist || svc.tasks) || []) collect(item);
      }
      const fsUrl = data?.finalSubmission?.imageUrl || data?.finalSubmission?.image;
      if (fsUrl && typeof fsUrl === "string" && fsUrl.trim()) imageUrls.push(fsUrl.trim());
      const tasks = data?.tasks || [];
      return NextResponse.json({
        bookingId,
        taskCount: tasks.length,
        doneCount: tasks.filter((t: any) => t.done).length,
        imageUrlsFound: imageUrls.length,
        imageUrls: imageUrls.map((u) => u.slice(0, 100) + (u.length > 100 ? "..." : "")),
        firstFullUrl: imageUrls[0] || null,
        hint: imageUrls.length === 0 ? "No image URLs in this booking. Complete a task with a photo in the app, then try again." : "Copy firstFullUrl and test with ?url=ENCODED_URL or use the debug page.",
      });
    } catch (e: any) {
      return NextResponse.json({ error: e?.message }, { status: 500 });
    }
  }

  if (!url) {
    return NextResponse.json({
      error: "Missing url or bookingId parameter",
      usage: "?url=IMAGE_URL or ?bookingId=BOOKING_ID to inspect",
    }, { status: 400 });
  }

  const buf = await fetchImageBuffer(url);
  if (buf && buf.length > 0) {
    const isPng = buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    const contentType = isPng ? "image/png" : "image/jpeg";
    return new NextResponse(new Uint8Array(buf), {
      headers: { "Content-Type": contentType },
    });
  }

  return NextResponse.json({
    error: "Could not fetch image",
    url_preview: url.slice(0, 100) + "...",
  }, { status: 500 });
}
