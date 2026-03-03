import { NextRequest, NextResponse } from "next/server";
import { adminStorage } from "@/lib/firebaseAdmin";

export const runtime = "nodejs";

/**
 * Debug API: Test if we can fetch an image for PDF generation.
 * GET /api/debug/fetch-pdf-image?url=ENCODED_IMAGE_URL
 * Returns the image if successful, or JSON with error details.
 * Remove or protect this route in production.
 */
export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url");
  if (!url) {
    return NextResponse.json({ error: "Missing url parameter" }, { status: 400 });
  }

  const results: Record<string, string> = {};

  // 1. Try HTTP fetch
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "BMS-PRO-PDF/1.0" },
      cache: "no-store",
    });
    results.http_fetch = `status=${res.status} ok=${res.ok}`;
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      results.http_fetch_success = `got ${buf.length} bytes`;
      return new NextResponse(buf, {
        headers: { "Content-Type": "image/jpeg" },
      });
    }
  } catch (e: any) {
    results.http_fetch_error = e?.message || String(e);
  }

  // 2. Try Firebase Admin Storage
  try {
    const match = url.match(/\/v0\/b\/([^/]+)\/o\/(.+?)(\?|$)/);
    if (match) {
      const bucketName = decodeURIComponent(match[1]);
      let path = match[2];
      try {
        path = decodeURIComponent(path.replace(/\+/g, " "));
      } catch {
        path = match[2];
      }
      const storage = adminStorage();
      const bucket = storage.bucket(bucketName);
      const file = bucket.file(path);
      const [buf] = await file.download();
      results.admin_storage = `bucket=${bucketName} path=${path} bytes=${buf?.length || 0}`;
      if (buf && buf.length > 0) {
        return new NextResponse(buf, {
          headers: { "Content-Type": "image/jpeg" },
        });
      }
    } else {
      results.admin_storage = "URL did not match Firebase pattern";
    }
  } catch (e: any) {
    results.admin_storage_error = e?.message || String(e);
  }

  return NextResponse.json({
    error: "Could not fetch image",
    url_preview: url.slice(0, 100) + "...",
    results,
  }, { status: 500 });
}
