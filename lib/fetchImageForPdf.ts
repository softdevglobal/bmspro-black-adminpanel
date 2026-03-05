/**
 * Shared image fetch logic for PDF generation and debug API.
 * Use this module to ensure consistent behavior.
 */
import https from "node:https";
import http from "node:http";
import { adminStorage } from "./firebaseAdmin";

const DEBUG = process.env.DEBUG_PDF_IMAGES === "1";

function nodeFetch(url: string, timeoutMs = 25000): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const protocol = url.startsWith("https") ? https : http;
    const req = protocol.get(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; BMS-PRO-PDF/1.0)" },
    }, (res) => {
      const redirect = res.headers.location;
      if (redirect && res.statusCode && [301, 302, 307, 308].includes(res.statusCode)) {
        nodeFetch(redirect, timeoutMs).then(resolve);
        return;
      }
      if (res.statusCode && res.statusCode >= 400) {
        if (DEBUG) console.warn("[fetchImageForPdf] HTTP", res.statusCode, "for", url.slice(0, 80) + "...");
        resolve(null);
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", () => resolve(null));
    });
    req.on("error", (e) => {
      if (DEBUG) console.warn("[fetchImageForPdf] nodeFetch error:", (e as Error)?.message);
      resolve(null);
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve(null);
    });
  });
}

/** Parse Firebase Storage URL to bucket + path. Supports firebasestorage.googleapis.com and storage.googleapis.com. */
function parseStorageUrl(url: string): { bucket: string; path: string } | null {
  try {
    // https://firebasestorage.googleapis.com/v0/b/BUCKET/o/ENCODED_PATH?alt=media&token=...
    const fbMatch = url.match(/firebasestorage\.googleapis\.com\/v0\/b\/([^/]+)\/o\/([^?]+)/);
    if (fbMatch) {
      const bucket = decodeURIComponent(fbMatch[1]);
      let path = fbMatch[2];
      try {
        path = decodeURIComponent(path.replace(/\+/g, " "));
      } catch {
        path = fbMatch[2];
      }
      return { bucket, path };
    }
    // https://storage.googleapis.com/BUCKET/path/to/file
    const sgMatch = url.match(/storage\.googleapis\.com\/([^/]+)\/(.+)/);
    if (sgMatch) {
      const bucket = decodeURIComponent(sgMatch[1]);
      const path = decodeURIComponent(sgMatch[2]);
      return { bucket, path };
    }
  } catch {
    /* ignore */
  }
  return null;
}

export async function fetchImageBuffer(url: string): Promise<Buffer | null> {
  if (!url || typeof url !== "string") return null;
  const trimmed = url.trim();
  if (!trimmed.startsWith("http")) return null;

  let buf: Buffer | null = null;
  const log = (msg: string) => DEBUG && console.log("[fetchImageForPdf]", msg);

  // 1. Direct HTTP fetch FIRST - Firebase Storage URLs with ?token= are designed for this
  //    Works in serverless, no Admin SDK needed, token authenticates the request
  if (!buf || buf.length === 0) {
    try {
      const res = await fetch(trimmed, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; BMS-PRO-PDF/1.0)" },
        cache: "no-store",
        signal: AbortSignal.timeout(25000),
      });
      if (res.ok) {
        buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > 0) log(`fetch() ok: ${buf.length} bytes`);
      } else if (DEBUG) {
        log(`fetch() failed: ${res.status} ${res.statusText}`);
      }
    } catch (e) {
      log(`fetch() error: ${(e as Error)?.message}`);
    }
  }

  // 2. Node https/http fallback (sometimes more reliable than fetch in Node)
  if (!buf || buf.length === 0) {
    buf = await nodeFetch(trimmed);
    if (buf?.length) log(`nodeFetch ok: ${buf.length} bytes`);
  }

  // 3. Firebase Admin Storage (for when token expired or direct fetch blocked)
  const parsed = parseStorageUrl(trimmed);
  if ((!buf || buf.length === 0) && parsed) {
    try {
      const storage = adminStorage();
      const bucket = storage.bucket(parsed.bucket);
      const file = bucket.file(parsed.path);
      const [downloaded] = await file.download();
      if (downloaded && downloaded.length > 0) {
        buf = downloaded;
        log(`Admin download ok: ${buf.length} bytes`);
      }
    } catch (e) {
      log(`Admin download error: ${(e as Error)?.message}`);
      if (!buf || buf.length === 0) {
        try {
          const storage = adminStorage();
          const defaultBucket = storage.bucket();
          if (defaultBucket?.name && defaultBucket.name !== parsed.bucket) {
            const file = defaultBucket.file(parsed.path);
            const [downloaded] = await file.download();
            if (downloaded?.length) {
              buf = downloaded;
              log(`Admin default bucket ok: ${buf.length} bytes`);
            }
          }
        } catch {
          /* ignore */
        }
      }
      if (!buf?.length) {
        try {
          const storage = adminStorage();
          const bucket = storage.bucket(parsed.bucket);
          const file = bucket.file(parsed.path);
          const [signedUrl] = await file.getSignedUrl({ action: "read", expires: Date.now() + 5 * 60 * 1000 });
          if (signedUrl) buf = await nodeFetch(signedUrl);
        } catch {
          /* ignore */
        }
      }
    }
  }

  // 4. Self-request fallback
  if (!buf || buf.length === 0) {
    try {
      const base = process.env.NEXT_PUBLIC_APP_URL
        || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null)
        || `http://127.0.0.1:${process.env.PORT || 3000}`;
      const apiUrl = `${base}/api/debug/fetch-pdf-image?url=${encodeURIComponent(trimmed)}`;
      const res = await fetch(apiUrl, { cache: "no-store", signal: AbortSignal.timeout(25000) });
      if (res.ok) {
        const ct = res.headers.get("content-type") || "";
        if (ct.includes("image") || ct.includes("octet")) {
          buf = Buffer.from(await res.arrayBuffer());
          log(`Self-request API ok: ${buf?.length ?? 0} bytes`);
        }
      }
    } catch (e) {
      log(`Self-request failed: ${(e as Error)?.message}`);
    }
  }

  if (!buf || buf.length === 0) return null;

  // Reject HTML/error pages (e.g. 404, 500)
  const start = buf.slice(0, 50).toString("utf8").trim().toLowerCase();
  if (start.startsWith("<!") || start.startsWith("<html") || start.startsWith("<?xml")) {
    log("Rejected: response looks like HTML, not image");
    return null;
  }

  const isJpeg = buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const isPng = buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const isWebP = buf.length >= 12 && buf.slice(0, 4).toString() === "RIFF" && buf.slice(8, 12).toString() === "WEBP";

  // PDFKit accepts JPEG and PNG directly - pass through to avoid Sharp failures on serverless
  if (isJpeg || isPng) {
    log(`Pass-through ${isJpeg ? "JPEG" : "PNG"}: ${buf.length} bytes`);
    return Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  }

  // For WebP/HEIC/etc, try Sharp to convert to JPEG
  if (isWebP || buf.length > 12) {
    try {
      const sharp = (await import("sharp")).default;
      buf = await sharp(buf)
        .rotate()
        .jpeg({ quality: 90 })
        .toBuffer();
      log(`Sharp converted to JPEG: ${buf.length} bytes`);
      return buf;
    } catch (e) {
      log(`Sharp conversion failed: ${(e as Error)?.message}`);
    }
  }

  return null;
}
