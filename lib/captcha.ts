/**
 * Google reCAPTCHA v3 Verification
 * 
 * This module provides server-side verification for reCAPTCHA tokens
 * to prevent bots from spamming public endpoints like booking creation.
 * 
 * @requires Environment variables:
 * - RECAPTCHA_SECRET_KEY: Your Google reCAPTCHA v3 secret key
 * 
 * Get your keys from: https://www.google.com/recaptcha/admin
 * 
 * Usage in your booking engine (client-side):
 * ```javascript
 * // Load reCAPTCHA script in your HTML
 * <script src="https://www.google.com/recaptcha/api.js?render=YOUR_SITE_KEY"></script>
 * 
 * // Before submitting booking, get token
 * const token = await grecaptcha.execute('YOUR_SITE_KEY', { action: 'booking' });
 * 
 * // Send token with your booking request
 * fetch('/api/bookings', {
 *   method: 'POST',
 *   body: JSON.stringify({ ...bookingData, recaptchaToken: token })
 * });
 * ```
 */

export interface RecaptchaVerificationResult {
  success: boolean;
  score?: number;
  action?: string;
  challenge_ts?: string;
  hostname?: string;
  error?: string;
  errorCodes?: string[];
}

/**
 * Verify a reCAPTCHA token with Google's servers
 * 
 * @param token - The reCAPTCHA token from the client
 * @param expectedAction - The expected action name (e.g., 'booking', 'login')
 * @param minimumScore - Minimum score to accept (0.0 to 1.0, default 0.5)
 * @returns Verification result
 */
export async function verifyRecaptcha(
  token: string,
  expectedAction?: string,
  minimumScore: number = 0.5
): Promise<RecaptchaVerificationResult> {
  const secretKey = process.env.RECAPTCHA_SECRET_KEY;
  
  // If no secret key configured, skip verification in development
  if (!secretKey) {
    if (process.env.NODE_ENV === 'development') {
      console.warn('[CAPTCHA] No RECAPTCHA_SECRET_KEY configured. Skipping verification in development.');
      return { success: true, score: 1.0 };
    }
    console.error('[CAPTCHA] No RECAPTCHA_SECRET_KEY configured!');
    return { 
      success: false, 
      error: 'reCAPTCHA not configured on server' 
    };
  }
  
  if (!token) {
    return { 
      success: false, 
      error: 'No reCAPTCHA token provided' 
    };
  }
  
  try {
    const response = await fetch('https://www.google.com/recaptcha/api/siteverify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `secret=${secretKey}&response=${token}`,
    });
    
    if (!response.ok) {
      console.error('[CAPTCHA] Google API returned error:', response.status);
      return { 
        success: false, 
        error: 'Failed to verify with Google' 
      };
    }
    
    const data = await response.json();
    
    // Check if verification succeeded
    if (!data.success) {
      console.warn('[CAPTCHA] Verification failed:', data['error-codes']);
      return {
        success: false,
        error: 'Verification failed',
        errorCodes: data['error-codes'],
      };
    }
    
    // Check action matches (if specified)
    if (expectedAction && data.action !== expectedAction) {
      console.warn(`[CAPTCHA] Action mismatch. Expected: ${expectedAction}, Got: ${data.action}`);
      return {
        success: false,
        error: 'Action mismatch',
        action: data.action,
      };
    }
    
    // Check score meets minimum
    if (data.score < minimumScore) {
      console.warn(`[CAPTCHA] Score too low: ${data.score} < ${minimumScore}`);
      return {
        success: false,
        score: data.score,
        error: 'Score too low - suspected bot',
      };
    }
    
    // All checks passed!
    return {
      success: true,
      score: data.score,
      action: data.action,
      challenge_ts: data.challenge_ts,
      hostname: data.hostname,
    };
    
  } catch (error) {
    console.error('[CAPTCHA] Verification error:', error);
    return { 
      success: false, 
      error: 'Verification request failed' 
    };
  }
}

/**
 * Middleware helper for API routes to verify CAPTCHA
 * Returns null if verification passes, error response if it fails
 */
export async function requireRecaptcha(
  req: Request,
  action: string = 'submit',
  minimumScore: number = 0.5
): Promise<{ error: string; status: number } | null> {
  // Skip CAPTCHA for authenticated requests from admin panel
  // Only require for truly public/anonymous requests
  const authHeader = req.headers.get('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    // Authenticated request - CAPTCHA not required
    return null;
  }
  
  try {
    const body = await req.clone().json();
    const token = body.recaptchaToken;
    
    // If CAPTCHA is not configured, allow in development
    if (!process.env.RECAPTCHA_SECRET_KEY) {
      if (process.env.NODE_ENV === 'development') {
        return null; // Allow in development
      }
      // In production without config, you can choose to block or allow
      console.warn('[CAPTCHA] Production without RECAPTCHA_SECRET_KEY');
      return null; // Or return error to block
    }
    
    if (!token) {
      return { 
        error: 'Security verification required. Please complete the CAPTCHA.', 
        status: 400 
      };
    }
    
    const result = await verifyRecaptcha(token, action, minimumScore);
    
    if (!result.success) {
      // Log for security monitoring
      console.warn('[CAPTCHA] Blocked request:', {
        action,
        error: result.error,
        score: result.score,
      });
      
      return { 
        error: result.score !== undefined && result.score < minimumScore
          ? 'Automated requests are not allowed. Please try again.'
          : 'Security verification failed. Please refresh and try again.', 
        status: 403 
      };
    }
    
    return null; // Verification passed
    
  } catch (error) {
    console.error('[CAPTCHA] Error processing request:', error);
    // On error, you can choose to fail open or closed
    // Fail open (allow) in development, fail closed (block) in production
    if (process.env.NODE_ENV === 'development') {
      return null;
    }
    return { 
      error: 'Security verification error. Please try again.', 
      status: 500 
    };
  }
}

/**
 * Score thresholds and their typical meanings:
 * 
 * 0.0 - 0.3: Very likely a bot
 * 0.3 - 0.5: Suspicious - might be a bot
 * 0.5 - 0.7: Uncertain - could be either
 * 0.7 - 0.9: Likely human
 * 0.9 - 1.0: Very likely human
 * 
 * Recommended thresholds:
 * - 0.5 for general forms (default)
 * - 0.7 for sensitive operations (payments, account creation)
 * - 0.3 for high-traffic, low-risk pages
 */
export const CAPTCHA_THRESHOLDS = {
  LOW: 0.3,      // Allow more through, catch obvious bots
  MEDIUM: 0.5,   // Balanced (default)
  HIGH: 0.7,     // Stricter for sensitive operations
  STRICT: 0.9,   // Very strict for critical operations
} as const;
