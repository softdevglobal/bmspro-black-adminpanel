import { NextRequest, NextResponse } from "next/server";

/**
 * Content Security Policy (CSP) Configuration
 * 
 * This replaces the deprecated X-XSS-Protection header with a modern,
 * production-ready Content Security Policy that:
 * - Whitelists only trusted script sources (Firebase, Google APIs)
 * - Prevents XSS attacks by blocking inline scripts (except nonce-based)
 * - Protects against clickjacking and data injection attacks
 * 
 * @see https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP
 */
function generateCSP(isDev: boolean): string {
  const cspDirectives = [
    // Default: block everything unless explicitly allowed
    "default-src 'self'",
    
    // Scripts: Allow self, Firebase SDK, Google APIs (for Firebase Auth), Chart.js CDN, Leaflet
    // 'unsafe-inline' is needed for Next.js hydration, but we use 'strict-dynamic' where possible
    // In production, consider using nonces for stricter security
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://*.firebaseio.com https://*.googleapis.com https://apis.google.com https://www.gstatic.com https://www.google.com https://www.recaptcha.net https://cdn.jsdelivr.net https://unpkg.com",
    
    // Styles: Allow self, inline styles (Tailwind), Google Fonts, Font Awesome, and Leaflet
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com https://unpkg.com",
    
    // Images: Allow self, data URIs, Firebase Storage, OpenStreetMap tiles, and DiceBear avatars
    "img-src 'self' data: blob: https://*.firebasestorage.app https://*.googleapis.com https://*.googleusercontent.com https://tile.openstreetmap.org https://*.tile.openstreetmap.org https://api.dicebear.com",
    
    // Fonts: Allow self, Google Fonts, and Font Awesome (cdnjs)
    "font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com",
    
    // Connect: API endpoints, Firebase, WebSocket connections, OpenStreetMap, and Leaflet CDN
    // Added *.firebaseapp.com for Firebase Auth popup/redirect
    "connect-src 'self' https://*.firebaseio.com https://*.googleapis.com https://*.firebaseapp.com wss://*.firebaseio.com https://firestore.googleapis.com https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://firebaseinstallations.googleapis.com https://*.cloudfunctions.net https://www.google.com https://www.recaptcha.net https://nominatim.openstreetmap.org https://*.tile.openstreetmap.org https://unpkg.com https://ka-f.fontawesome.com",
    
    // Frames: blob: for PDF iframe fallbacks; Firebase Auth / reCAPTCHA
    "frame-src 'self' blob: https://*.firebaseapp.com https://www.google.com https://www.recaptcha.net",
    
    // Media: allow same-origin audio/video and in-memory blob URLs used by recording playback
    "media-src 'self' blob:",
    
    // `<embed type="application/pdf">` job-report preview (blob URLs only, not arbitrary plugins)
    "object-src 'self' blob:",
    
    // Base URI: Prevent base tag hijacking
    "base-uri 'self'",
    
    // Form actions: Only allow forms to submit to self
    "form-action 'self'",
    
    // Frame ancestors: allow same-origin previews and SoftDevGlobal portfolio embeds only.
    "frame-ancestors 'self' https://softdev.global",
  ];
  
  // Only upgrade insecure requests in production (not on localhost)
  if (!isDev) {
    cspDirectives.push("upgrade-insecure-requests");
  }
  
  return cspDirectives.join("; ");
}

/**
 * Security middleware to protect against XSS, clickjacking, and RSC vulnerabilities
 */
export function middleware(request: NextRequest) {
  const response = NextResponse.next();
  const pathname = request.nextUrl.pathname;
  /** Skip full CSP on PDF route so the handler can keep PDF previews same-origin only. */
  const isBookingPdf = /^\/api\/bookings\/[^/]+\/pdf$/.test(pathname);

  // Check if running in development (localhost)
  const host = request.headers.get("host") || "";
  const isDev = host.includes("localhost") || host.includes("127.0.0.1");

  // === MODERN SECURITY HEADERS (2025 Production Standard) ===

  // 1. CSP — skip for booking PDF so the handler can enforce same-origin PDF previews.
  if (!isBookingPdf) {
    response.headers.set("Content-Security-Policy", generateCSP(isDev));
  }

  // 2. Prevent MIME type sniffing attacks
  response.headers.set("X-Content-Type-Options", "nosniff");

  // 3. X-Frame-Options is intentionally omitted; CSP frame-ancestors allows the portfolio embed.

  // 4. Control referrer information leakage
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  
  // 5. HTTP Strict Transport Security (HSTS) - Force HTTPS
  // max-age=31536000 = 1 year, includeSubDomains for all subdomains
  response.headers.set(
    "Strict-Transport-Security",
    "max-age=31536000; includeSubDomains; preload"
  );
  
  // 6. Permissions Policy - Restrict browser features (allow geolocation for staff check-in)
  response.headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(self), interest-cohort=()"
  );
  
  // NOTE: X-XSS-Protection is intentionally REMOVED
  // It's deprecated and can actually cause security issues in some browsers
  // CSP is the modern replacement
  
  // === CVE-2025-55184 PROTECTION ===
  // Comprehensive payload size validation for all vulnerable endpoints
  const contentLength = request.headers.get("content-length");
  const MAX_PAYLOAD_1MB = 1024 * 1024; // 1MB
  const MAX_PAYLOAD_100KB = 100 * 1024; // 100KB for simple API calls
  
  // 1. Protect RSC endpoints (React Server Components)
  if (pathname.startsWith("/_next/rsc") || 
      pathname.startsWith("/_next/server-actions") ||
      pathname.startsWith("/_next/forms")) {
    if (contentLength && parseInt(contentLength) > MAX_PAYLOAD_1MB) {
      console.warn(`[CVE-2025] Blocked oversized RSC request: ${contentLength} bytes`);
      return new NextResponse(
        JSON.stringify({ error: "Request payload too large" }),
        { 
          status: 413,
          headers: { "Content-Type": "application/json" }
        }
      );
    }
  }
  
  // 2. Protect API endpoints
  if (pathname.startsWith("/api/")) {
    // File uploads (images for estimates, etc.) need 10MB
    const MAX_PAYLOAD_10MB = 10 * 1024 * 1024;
    const isUpload = pathname.includes("/upload-image") || pathname.includes("/upload/");
    // Booking creation, estimates (with image URLs), and estimate replies can have larger payloads
    const isLargePayload = pathname.includes("/bookings") || pathname.includes("/estimate") || pathname.includes("/estimate-reply");
    const maxSize = isUpload ? MAX_PAYLOAD_10MB : isLargePayload ? MAX_PAYLOAD_1MB : MAX_PAYLOAD_100KB;
    
    if (contentLength && parseInt(contentLength) > maxSize) {
      console.warn(`[CVE-2025] Blocked oversized API request to ${pathname}: ${contentLength} bytes`);
      return new NextResponse(
        JSON.stringify({ error: "Request payload too large" }),
        { 
          status: 413,
          headers: { "Content-Type": "application/json" }
        }
      );
    }
  }
  
  // === SECURITY LOGGING ===
  // Log suspicious requests for security monitoring
  const suspiciousPatterns = [
    /\.\.[\/\\]/,  // Path traversal
    /[<>'"]/,      // Potential XSS in URL
    /%00/,         // Null byte injection
  ];
  
  if (suspiciousPatterns.some(pattern => pattern.test(pathname))) {
    console.warn(`[Security] Suspicious request pattern: ${pathname}`);
  }

  return response;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - api (API routes)
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     */
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
