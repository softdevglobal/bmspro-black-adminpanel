/**
 * Simple in-memory rate limiter for API routes
 * 
 * Note: This is suitable for single-instance deployments.
 * For multi-instance deployments (e.g., Vercel serverless), consider using
 * Redis or Upstash for distributed rate limiting.
 */

interface RateLimitEntry {
  count: number;
  resetTime: number;
}

// In-memory store for rate limits
const rateLimitStore = new Map<string, RateLimitEntry>();

// Cleanup old entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitStore.entries()) {
    if (entry.resetTime < now) {
      rateLimitStore.delete(key);
    }
  }
}, 5 * 60 * 1000);

export interface RateLimitConfig {
  /** Maximum number of requests allowed in the window */
  maxRequests: number;
  /** Time window in milliseconds */
  windowMs: number;
  /** Identifier for the rate limit (e.g., "booking", "auth") */
  identifier: string;
}

export interface RateLimitResult {
  success: boolean;
  remaining: number;
  resetTime: number;
  retryAfter?: number; // seconds until reset
}

/**
 * Check if a request is within rate limits
 * 
 * @param clientIdentifier - Unique identifier for the client (e.g., IP address, user ID)
 * @param config - Rate limit configuration
 * @returns RateLimitResult indicating if request is allowed
 */
export function checkRateLimit(
  clientIdentifier: string,
  config: RateLimitConfig
): RateLimitResult {
  const key = `${config.identifier}:${clientIdentifier}`;
  const now = Date.now();
  
  let entry = rateLimitStore.get(key);
  
  // If no entry or window has expired, create new entry
  if (!entry || entry.resetTime < now) {
    entry = {
      count: 0,
      resetTime: now + config.windowMs,
    };
  }
  
  // Increment count
  entry.count++;
  rateLimitStore.set(key, entry);
  
  const remaining = Math.max(0, config.maxRequests - entry.count);
  const retryAfter = Math.ceil((entry.resetTime - now) / 1000);
  
  if (entry.count > config.maxRequests) {
    return {
      success: false,
      remaining: 0,
      resetTime: entry.resetTime,
      retryAfter,
    };
  }
  
  return {
    success: true,
    remaining,
    resetTime: entry.resetTime,
  };
}

/**
 * Get a unique identifier for the client from request headers
 * 
 * @param req - Request object
 * @returns Client identifier string
 */
export function getClientIdentifier(req: Request): string {
  // Try to get IP from various headers (in order of preference)
  const forwardedFor = req.headers.get("x-forwarded-for");
  if (forwardedFor) {
    // Take the first IP if there are multiple
    return forwardedFor.split(",")[0].trim();
  }
  
  const realIp = req.headers.get("x-real-ip");
  if (realIp) {
    return realIp;
  }
  
  // Fallback to a hash of user-agent + accept-language (not ideal but better than nothing)
  const userAgent = req.headers.get("user-agent") || "unknown";
  const acceptLanguage = req.headers.get("accept-language") || "unknown";
  
  // Simple hash function
  const combined = `${userAgent}:${acceptLanguage}`;
  let hash = 0;
  for (let i = 0; i < combined.length; i++) {
    const char = combined.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return `hash:${hash}`;
}

/**
 * Pre-configured rate limiters for different endpoint types
 */
export const RateLimiters = {
  // Booking operations (more restrictive)
  booking: {
    maxRequests: 30,
    windowMs: 5 * 60 * 1000, // 5 minutes
    identifier: "booking",
  } as RateLimitConfig,
  
  // Staff auth operations (very restrictive - sensitive)
  staffAuth: {
    maxRequests: 10,
    windowMs: 15 * 60 * 1000, // 15 minutes
    identifier: "staff-auth",
  } as RateLimitConfig,
  
  // Audit log operations
  auditLog: {
    maxRequests: 100,
    windowMs: 60 * 1000, // 1 minute
    identifier: "audit-log",
  } as RateLimitConfig,
  
  // General API operations (more lenient)
  general: {
    maxRequests: 200,
    windowMs: 60 * 1000, // 1 minute
    identifier: "general",
  } as RateLimitConfig,
  
  // Status updates (moderate)
  statusUpdate: {
    maxRequests: 50,
    windowMs: 60 * 1000, // 1 minute
    identifier: "status-update",
  } as RateLimitConfig,
};
