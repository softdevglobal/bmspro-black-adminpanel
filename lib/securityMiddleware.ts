/**
 * Security Middleware Utilities
 * 
 * Comprehensive security checks for API endpoints including:
 * - Payload size validation (CVE-2025-55184 protection)
 * - Request sanitization
 * - Security headers
 * 
 * This module provides utilities for securing API routes against
 * common attacks and known vulnerabilities.
 */

import { NextRequest, NextResponse } from "next/server";

// ============================================================
// PAYLOAD SIZE LIMITS
// ============================================================

/**
 * Payload size limits in bytes
 */
export const PAYLOAD_LIMITS = {
  // Standard API requests (bookings, updates)
  DEFAULT: 1024 * 1024, // 1MB
  
  // File uploads (if any)
  FILE_UPLOAD: 10 * 1024 * 1024, // 10MB
  
  // Small operations (status updates, simple CRUD)
  SMALL: 100 * 1024, // 100KB
  
  // RSC endpoints (Next.js React Server Components)
  RSC: 1024 * 1024, // 1MB
  
  // Server Actions
  SERVER_ACTION: 1024 * 1024, // 1MB
} as const;

/**
 * Check if request payload exceeds the limit
 * Returns an error response if payload is too large, null otherwise
 */
export function checkPayloadSize(
  req: NextRequest,
  maxSize: number = PAYLOAD_LIMITS.DEFAULT
): NextResponse | null {
  const contentLength = req.headers.get("content-length");
  
  if (contentLength && parseInt(contentLength, 10) > maxSize) {
    console.warn(`[Security] Blocked oversized payload: ${contentLength} bytes (limit: ${maxSize})`);
    
    return new NextResponse(
      JSON.stringify({
        error: "Request payload too large",
        maxSize: maxSize,
        received: parseInt(contentLength, 10),
      }),
      {
        status: 413,
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
  }
  
  return null;
}

// ============================================================
// INPUT SANITIZATION
// ============================================================

/**
 * Common dangerous patterns to filter
 */
const DANGEROUS_PATTERNS = [
  // SQL injection patterns
  /(\bUNION\b.*\bSELECT\b|\bDROP\b.*\bTABLE\b|\bINSERT\b.*\bINTO\b)/i,
  
  // NoSQL injection patterns (for MongoDB/Firestore)
  /\$where|\$gt|\$lt|\$ne|\$regex|\$or|\$and/i,
  
  // Script injection
  /<script\b[^>]*>[\s\S]*?<\/script>/gi,
  
  // Event handlers
  /\bon\w+\s*=/gi,
  
  // Data URIs that could contain scripts
  /data:text\/html/i,
  /javascript:/i,
];

/**
 * Check if a string contains potentially dangerous content
 */
export function containsDangerousContent(value: string): boolean {
  if (typeof value !== "string") return false;
  
  return DANGEROUS_PATTERNS.some(pattern => pattern.test(value));
}

/**
 * Sanitize a string value (basic HTML entity encoding)
 */
export function sanitizeString(value: string): string {
  if (typeof value !== "string") return value;
  
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

/**
 * Deep sanitize an object's string values
 */
export function sanitizeObject<T>(obj: T): T {
  if (obj === null || obj === undefined) return obj;
  
  if (typeof obj === "string") {
    return sanitizeString(obj) as T;
  }
  
  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeObject(item)) as T;
  }
  
  if (typeof obj === "object") {
    const sanitized: any = {};
    for (const [key, value] of Object.entries(obj)) {
      sanitized[sanitizeString(key)] = sanitizeObject(value);
    }
    return sanitized;
  }
  
  return obj;
}

// ============================================================
// SECURITY HEADERS
// ============================================================

/**
 * Security headers for API responses
 */
export const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Cache-Control": "no-store, no-cache, must-revalidate",
  "Pragma": "no-cache",
};

/**
 * Add security headers to a response
 */
export function addSecurityHeaders(response: NextResponse): NextResponse {
  Object.entries(SECURITY_HEADERS).forEach(([key, value]) => {
    response.headers.set(key, value);
  });
  return response;
}

// ============================================================
// COMBINED SECURITY CHECK
// ============================================================

export interface SecurityCheckResult {
  passed: boolean;
  error?: string;
  response?: NextResponse;
}

/**
 * Comprehensive security check for API requests
 */
export async function performSecurityCheck(
  req: NextRequest,
  options: {
    maxPayloadSize?: number;
    validateBody?: boolean;
  } = {}
): Promise<SecurityCheckResult> {
  const { maxPayloadSize = PAYLOAD_LIMITS.DEFAULT, validateBody = true } = options;
  
  // 1. Check payload size
  const payloadError = checkPayloadSize(req, maxPayloadSize);
  if (payloadError) {
    return { passed: false, error: "Payload too large", response: payloadError };
  }
  
  // 2. Validate request body for dangerous content (optional)
  if (validateBody && req.method !== "GET") {
    try {
      const body = await req.clone().json();
      const bodyString = JSON.stringify(body);
      
      if (containsDangerousContent(bodyString)) {
        console.warn("[Security] Blocked request with dangerous content");
        return {
          passed: false,
          error: "Request contains potentially dangerous content",
          response: NextResponse.json(
            { error: "Invalid request content" },
            { status: 400 }
          ),
        };
      }
    } catch {
      // Body parsing failed or not JSON - that's okay
    }
  }
  
  return { passed: true };
}

// ============================================================
// CVE-2025-55184 SPECIFIC PROTECTION
// ============================================================

/**
 * Paths that are vulnerable to CVE-2025-55184
 * These need special payload size checking
 */
export const CVE_2025_VULNERABLE_PATHS = [
  "/_next/rsc",
  "/_next/server-actions",
  // Server action invocations
  "/_next/forms",
];

/**
 * Check if a path is vulnerable to CVE-2025-55184
 */
export function isVulnerablePath(pathname: string): boolean {
  return CVE_2025_VULNERABLE_PATHS.some(path => pathname.startsWith(path));
}

/**
 * Protect against CVE-2025-55184 specifically
 */
export function protectAgainstCVE2025(req: NextRequest): NextResponse | null {
  const pathname = req.nextUrl.pathname;
  
  if (isVulnerablePath(pathname)) {
    return checkPayloadSize(req, PAYLOAD_LIMITS.RSC);
  }
  
  // Also protect all API routes
  if (pathname.startsWith("/api/")) {
    return checkPayloadSize(req, PAYLOAD_LIMITS.DEFAULT);
  }
  
  return null;
}

/**
 * Log security event for monitoring
 */
export function logSecurityEvent(
  event: string,
  details: Record<string, any>
): void {
  const logEntry = {
    timestamp: new Date().toISOString(),
    event,
    ...details,
  };
  
  // In production, this should go to a security monitoring service
  // For now, we log to console (can be captured by Vercel logs, etc.)
  console.log("[Security Event]", JSON.stringify(logEntry));
}
