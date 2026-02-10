/**
 * Firebase App Check Integration
 * 
 * App Check verifies that requests to your Firebase backend come from
 * your actual, genuine app - not from malicious scripts or attackers.
 * 
 * HOW IT WORKS:
 * 1. Client-side: App Check generates an attestation token
 * 2. Token proves the request comes from your actual app
 * 3. Server-side: We verify this token before processing requests
 * 
 * SETUP STEPS:
 * 
 * 1. Enable App Check in Firebase Console:
 *    - Go to Firebase Console > App Check
 *    - Register your web app
 *    - Choose reCAPTCHA Enterprise (recommended for web)
 * 
 * 2. Add to your booking engine (client-side):
 *    ```javascript
 *    import { initializeApp } from 'firebase/app';
 *    import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'firebase/app-check';
 *    
 *    const app = initializeApp(firebaseConfig);
 *    
 *    const appCheck = initializeAppCheck(app, {
 *      provider: new ReCaptchaEnterpriseProvider('YOUR_RECAPTCHA_ENTERPRISE_SITE_KEY'),
 *      isTokenAutoRefreshEnabled: true
 *    });
 *    ```
 * 
 * 3. For admin panel (this app), enable debug tokens in development:
 *    - Set self.FIREBASE_APPCHECK_DEBUG_TOKEN = true in browser console
 *    - Or use a debug token from Firebase Console
 * 
 * @requires Environment variable:
 * - FIREBASE_APPCHECK_DEBUG_TOKEN (optional, for development)
 */

import { getApps } from "firebase-admin/app";
import { getAppCheck } from "firebase-admin/app-check";
import { getAdminApp } from "./firebaseAdmin";

/**
 * Verify an App Check token from the client
 * 
 * @param appCheckToken - The App Check token from X-Firebase-AppCheck header
 * @returns Object with verification result
 */
export async function verifyAppCheckToken(
  appCheckToken: string | null
): Promise<{ valid: boolean; error?: string }> {
  // Skip App Check in development unless explicitly enabled
  if (process.env.NODE_ENV === 'development' && !process.env.ENFORCE_APP_CHECK) {
    console.log('[AppCheck] Skipping verification in development');
    return { valid: true };
  }
  
  if (!appCheckToken) {
    return { 
      valid: false, 
      error: 'Missing App Check token. Request may not be from authorized app.' 
    };
  }
  
  try {
    // Ensure Firebase Admin is initialized
    const app = getAdminApp();
    const appCheck = getAppCheck(app);
    
    // Verify the token
    const result = await appCheck.verifyToken(appCheckToken);
    
    // Token is valid
    console.log('[AppCheck] Token verified successfully');
    return { valid: true };
    
  } catch (error: any) {
    console.error('[AppCheck] Verification failed:', error.message);
    
    // Distinguish between different error types
    if (error.code === 'app-check/invalid-argument') {
      return { valid: false, error: 'Invalid App Check token format' };
    }
    if (error.code === 'app-check/app-check-token-expired') {
      return { valid: false, error: 'App Check token expired' };
    }
    
    return { valid: false, error: 'App Check verification failed' };
  }
}

/**
 * Extract App Check token from request headers
 */
export function getAppCheckToken(req: Request): string | null {
  return req.headers.get('X-Firebase-AppCheck');
}

/**
 * Middleware helper to require App Check verification
 * Returns null if verification passes, error response if it fails
 * 
 * Usage in API routes:
 * ```typescript
 * export async function POST(req: NextRequest) {
 *   const appCheckError = await requireAppCheck(req);
 *   if (appCheckError) {
 *     return NextResponse.json(appCheckError, { status: 403 });
 *   }
 *   // ... rest of your handler
 * }
 * ```
 */
export async function requireAppCheck(
  req: Request
): Promise<{ error: string } | null> {
  // Check if App Check is enabled
  if (!process.env.ENABLE_APP_CHECK) {
    // App Check not enabled - allow request
    return null;
  }
  
  const token = getAppCheckToken(req);
  const result = await verifyAppCheckToken(token);
  
  if (!result.valid) {
    console.warn('[AppCheck] Blocked unauthorized request:', result.error);
    return { error: result.error || 'Unauthorized app' };
  }
  
  return null;
}

/**
 * Integration instructions for your booking engine:
 * 
 * CLIENT-SIDE (Booking Engine):
 * 
 * 1. Install Firebase:
 *    npm install firebase
 * 
 * 2. Initialize App Check:
 *    ```javascript
 *    import { initializeApp } from 'firebase/app';
 *    import { initializeAppCheck, ReCaptchaV3Provider } from 'firebase/app-check';
 *    
 *    const app = initializeApp(firebaseConfig);
 *    
 *    // For production - use reCAPTCHA v3
 *    const appCheck = initializeAppCheck(app, {
 *      provider: new ReCaptchaV3Provider('YOUR_RECAPTCHA_V3_SITE_KEY'),
 *      isTokenAutoRefreshEnabled: true
 *    });
 *    
 *    // For development - enable debug mode
 *    if (process.env.NODE_ENV === 'development') {
 *      self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
 *    }
 *    ```
 * 
 * 3. Get token for API calls:
 *    ```javascript
 *    import { getToken } from 'firebase/app-check';
 *    
 *    async function makeAPICall() {
 *      const appCheckToken = await getToken(appCheck, false);
 *      
 *      fetch('/api/bookings', {
 *        method: 'POST',
 *        headers: {
 *          'X-Firebase-AppCheck': appCheckToken.token,
 *          'Content-Type': 'application/json',
 *        },
 *        body: JSON.stringify(bookingData),
 *      });
 *    }
 *    ```
 * 
 * SERVER-SIDE (This Admin Panel):
 * 
 * 1. Set environment variable:
 *    ENABLE_APP_CHECK=true
 * 
 * 2. Use the middleware in API routes:
 *    ```typescript
 *    import { requireAppCheck } from '@/lib/appCheck';
 *    
 *    export async function POST(req: NextRequest) {
 *      const appCheckError = await requireAppCheck(req);
 *      if (appCheckError) {
 *        return NextResponse.json(appCheckError, { status: 403 });
 *      }
 *      // Continue with your logic...
 *    }
 *    ```
 */

export const APP_CHECK_HEADER = 'X-Firebase-AppCheck';
