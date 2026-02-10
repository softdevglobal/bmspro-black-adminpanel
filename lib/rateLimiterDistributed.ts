/**
 * Distributed Rate Limiter using Upstash Redis
 * 
 * This provides production-ready rate limiting that works across all
 * serverless instances (Vercel, AWS Lambda, etc.)
 * 
 * For development: Falls back to in-memory rate limiting
 * For production: Uses Upstash Redis for distributed state
 * 
 * @requires Environment variables:
 * - UPSTASH_REDIS_REST_URL: Your Upstash Redis REST URL
 * - UPSTASH_REDIS_REST_TOKEN: Your Upstash Redis REST token
 * 
 * Get these from: https://console.upstash.com/
 */

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

// ============================================================
// IN-MEMORY FALLBACK (for development or when Redis unavailable)
// ============================================================

interface RateLimitEntry {
  count: number;
  resetTime: number;
}

const inMemoryStore = new Map<string, RateLimitEntry>();

// Cleanup old entries every 5 minutes
if (typeof setInterval !== 'undefined') {
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of inMemoryStore.entries()) {
      if (entry.resetTime < now) {
        inMemoryStore.delete(key);
      }
    }
  }, 5 * 60 * 1000);
}

function checkRateLimitInMemory(
  clientIdentifier: string,
  config: RateLimitConfig
): RateLimitResult {
  const key = `${config.identifier}:${clientIdentifier}`;
  const now = Date.now();
  
  let entry = inMemoryStore.get(key);
  
  if (!entry || entry.resetTime < now) {
    entry = {
      count: 0,
      resetTime: now + config.windowMs,
    };
  }
  
  entry.count++;
  inMemoryStore.set(key, entry);
  
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

// ============================================================
// UPSTASH REDIS DISTRIBUTED RATE LIMITER
// ============================================================

/**
 * Check rate limit using Upstash Redis (distributed)
 * Uses sliding window algorithm for accurate rate limiting
 */
async function checkRateLimitRedis(
  clientIdentifier: string,
  config: RateLimitConfig
): Promise<RateLimitResult> {
  const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
  const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
  
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    console.warn('[RateLimit] Upstash credentials not configured, falling back to in-memory');
    return checkRateLimitInMemory(clientIdentifier, config);
  }
  
  const key = `ratelimit:${config.identifier}:${clientIdentifier}`;
  const now = Date.now();
  const windowStart = now - config.windowMs;
  
  try {
    // Use Upstash REST API with sliding window algorithm
    // 1. Remove old entries outside the window
    // 2. Add current request timestamp
    // 3. Count requests in window
    // 4. Set expiration on the key
    
    const pipeline = [
      // Remove old entries (ZREMRANGEBYSCORE key -inf windowStart)
      ["ZREMRANGEBYSCORE", key, "0", String(windowStart)],
      // Add current timestamp (ZADD key now now)
      ["ZADD", key, String(now), `${now}:${Math.random()}`],
      // Count entries in window (ZCARD key)
      ["ZCARD", key],
      // Set expiration (EXPIRE key windowSeconds)
      ["EXPIRE", key, String(Math.ceil(config.windowMs / 1000))],
    ];
    
    const response = await fetch(`${UPSTASH_URL}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${UPSTASH_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(pipeline),
    });
    
    if (!response.ok) {
      console.error('[RateLimit] Upstash request failed:', response.status);
      return checkRateLimitInMemory(clientIdentifier, config);
    }
    
    const results = await response.json();
    
    // ZCARD result is at index 2
    const count = results[2]?.result || 0;
    const remaining = Math.max(0, config.maxRequests - count);
    const resetTime = now + config.windowMs;
    const retryAfter = Math.ceil(config.windowMs / 1000);
    
    if (count > config.maxRequests) {
      return {
        success: false,
        remaining: 0,
        resetTime,
        retryAfter,
      };
    }
    
    return {
      success: true,
      remaining,
      resetTime,
    };
  } catch (error) {
    console.error('[RateLimit] Redis error, falling back to in-memory:', error);
    return checkRateLimitInMemory(clientIdentifier, config);
  }
}

// ============================================================
// PUBLIC API
// ============================================================

/**
 * Check if a request is within rate limits
 * Automatically uses Redis in production, in-memory in development
 * 
 * @param clientIdentifier - Unique identifier for the client (e.g., IP address, user ID)
 * @param config - Rate limit configuration
 * @returns Promise<RateLimitResult> indicating if request is allowed
 */
export async function checkRateLimit(
  clientIdentifier: string,
  config: RateLimitConfig
): Promise<RateLimitResult> {
  const useRedis = process.env.UPSTASH_REDIS_REST_URL && 
                   process.env.UPSTASH_REDIS_REST_TOKEN;
  
  if (useRedis) {
    return checkRateLimitRedis(clientIdentifier, config);
  }
  
  // Fallback to in-memory for development
  return checkRateLimitInMemory(clientIdentifier, config);
}

/**
 * Synchronous rate limit check (uses in-memory only)
 * Use this when you need synchronous checking (e.g., middleware)
 * 
 * @deprecated Prefer async checkRateLimit() for production
 */
export function checkRateLimitSync(
  clientIdentifier: string,
  config: RateLimitConfig
): RateLimitResult {
  return checkRateLimitInMemory(clientIdentifier, config);
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
  
  const cfConnectingIp = req.headers.get("cf-connecting-ip");
  if (cfConnectingIp) {
    return cfConnectingIp;
  }
  
  // Fallback to a hash of user-agent + accept-language
  const userAgent = req.headers.get("user-agent") || "unknown";
  const acceptLanguage = req.headers.get("accept-language") || "unknown";
  
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
 * These limits are enforced globally across all server instances
 */
export const RateLimiters = {
  // Booking operations (restrictive - public endpoint)
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
  
  // Login attempts (very restrictive to prevent brute force)
  login: {
    maxRequests: 5,
    windowMs: 15 * 60 * 1000, // 15 minutes
    identifier: "login",
  } as RateLimitConfig,
  
  // Password reset (prevent abuse)
  passwordReset: {
    maxRequests: 3,
    windowMs: 60 * 60 * 1000, // 1 hour
    identifier: "password-reset",
  } as RateLimitConfig,
};

/**
 * Helper to create rate limit response headers
 */
export function getRateLimitHeaders(result: RateLimitResult): Record<string, string> {
  return {
    'X-RateLimit-Remaining': String(result.remaining),
    'X-RateLimit-Reset': String(result.resetTime),
    ...(result.retryAfter ? { 'Retry-After': String(result.retryAfter) } : {}),
  };
}
