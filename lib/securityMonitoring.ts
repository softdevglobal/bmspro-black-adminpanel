/**
 * Security Monitoring and Alerting System
 * 
 * This module provides comprehensive security event logging, monitoring,
 * and alerting capabilities for production environments.
 * 
 * Features:
 * - Structured security event logging
 * - Failed login attempt tracking
 * - Rate limit trigger monitoring
 * - Suspicious activity detection
 * - Integration with external alerting services
 * 
 * INTEGRATION OPTIONS:
 * 
 * 1. Vercel Logs: Events are logged to console (captured by Vercel)
 *    - View in Vercel Dashboard > Logs
 *    - Set up Log Drains to external services
 * 
 * 2. Firebase/Firestore: Store events for analysis
 *    - Enable by setting SECURITY_LOG_TO_FIRESTORE=true
 * 
 * 3. External Services (Webhook):
 *    - Slack: Set SECURITY_SLACK_WEBHOOK_URL
 *    - Discord: Set SECURITY_DISCORD_WEBHOOK_URL
 *    - Custom: Set SECURITY_WEBHOOK_URL
 * 
 * 4. Email Alerts (via webhook services like Zapier):
 *    - Configure webhook to trigger email
 */

// ============================================================
// SECURITY EVENT TYPES
// ============================================================

export type SecurityEventType =
  | "login_failed"
  | "login_success"
  | "rate_limit_triggered"
  | "rate_limit_warning"
  | "suspicious_request"
  | "payload_too_large"
  | "captcha_failed"
  | "app_check_failed"
  | "unauthorized_access"
  | "permission_denied"
  | "data_breach_attempt"
  | "sql_injection_attempt"
  | "xss_attempt"
  | "csrf_attempt"
  | "brute_force_detected"
  | "account_lockout"
  | "password_reset_abuse"
  | "api_abuse"
  | "security_config_change";

export type SecurityEventSeverity = "low" | "medium" | "high" | "critical";

export interface SecurityEvent {
  type: SecurityEventType;
  severity: SecurityEventSeverity;
  timestamp: string;
  message: string;
  details?: Record<string, any>;
  ip?: string;
  userId?: string;
  userEmail?: string;
  userAgent?: string;
  path?: string;
  method?: string;
  ownerUid?: string;
}

// ============================================================
// SEVERITY CLASSIFICATION
// ============================================================

const EVENT_SEVERITY: Record<SecurityEventType, SecurityEventSeverity> = {
  login_failed: "low",
  login_success: "low",
  rate_limit_warning: "low",
  rate_limit_triggered: "medium",
  suspicious_request: "medium",
  payload_too_large: "low",
  captcha_failed: "low",
  app_check_failed: "medium",
  unauthorized_access: "medium",
  permission_denied: "medium",
  data_breach_attempt: "critical",
  sql_injection_attempt: "high",
  xss_attempt: "high",
  csrf_attempt: "medium",
  brute_force_detected: "high",
  account_lockout: "medium",
  password_reset_abuse: "medium",
  api_abuse: "medium",
  security_config_change: "high",
};

// ============================================================
// BRUTE FORCE DETECTION
// ============================================================

interface FailedAttempt {
  count: number;
  firstAttempt: number;
  lastAttempt: number;
}

const failedLoginAttempts = new Map<string, FailedAttempt>();

// Clean up old entries every 30 minutes
if (typeof setInterval !== 'undefined') {
  setInterval(() => {
    const cutoff = Date.now() - 60 * 60 * 1000; // 1 hour
    for (const [key, value] of failedLoginAttempts.entries()) {
      if (value.lastAttempt < cutoff) {
        failedLoginAttempts.delete(key);
      }
    }
  }, 30 * 60 * 1000);
}

/**
 * Track a failed login attempt and detect brute force attacks
 */
export function trackFailedLogin(
  identifier: string,
  details?: Record<string, any>
): { isBruteForce: boolean; attemptCount: number } {
  const now = Date.now();
  const windowMs = 15 * 60 * 1000; // 15 minutes
  const maxAttempts = 5;
  
  let attempts = failedLoginAttempts.get(identifier);
  
  if (!attempts || (now - attempts.firstAttempt) > windowMs) {
    attempts = { count: 0, firstAttempt: now, lastAttempt: now };
  }
  
  attempts.count++;
  attempts.lastAttempt = now;
  failedLoginAttempts.set(identifier, attempts);
  
  const isBruteForce = attempts.count >= maxAttempts;
  
  if (isBruteForce) {
    logSecurityEvent({
      type: "brute_force_detected",
      severity: "high",
      message: `Brute force attack detected: ${attempts.count} failed attempts in ${Math.round((now - attempts.firstAttempt) / 1000 / 60)} minutes`,
      details: {
        ...details,
        attemptCount: attempts.count,
        windowMinutes: Math.round((now - attempts.firstAttempt) / 1000 / 60),
      },
    });
  }
  
  return { isBruteForce, attemptCount: attempts.count };
}

/**
 * Clear failed login attempts after successful login
 */
export function clearFailedLogins(identifier: string): void {
  failedLoginAttempts.delete(identifier);
}

// ============================================================
// CORE LOGGING FUNCTION
// ============================================================

/**
 * Log a security event
 */
export async function logSecurityEvent(event: Partial<SecurityEvent> & { type: SecurityEventType; message: string }): Promise<void> {
  const fullEvent: SecurityEvent = {
    severity: EVENT_SEVERITY[event.type] || "medium",
    timestamp: new Date().toISOString(),
    ...event,
  };
  
  // 1. Always log to console (captured by Vercel/cloud logs)
  const logPrefix = `[Security ${fullEvent.severity.toUpperCase()}]`;
  const logMessage = `${logPrefix} ${fullEvent.type}: ${fullEvent.message}`;
  
  switch (fullEvent.severity) {
    case "critical":
    case "high":
      console.error(logMessage, fullEvent.details || {});
      break;
    case "medium":
      console.warn(logMessage, fullEvent.details || {});
      break;
    default:
      console.log(logMessage, fullEvent.details || {});
  }
  
  // 2. Send alerts for high/critical events
  if (fullEvent.severity === "high" || fullEvent.severity === "critical") {
    await sendSecurityAlert(fullEvent);
  }
  
  // 3. Store in Firestore (if enabled)
  if (process.env.SECURITY_LOG_TO_FIRESTORE === "true") {
    await storeSecurityEventInFirestore(fullEvent);
  }
}

// ============================================================
// ALERTING
// ============================================================

/**
 * Send security alert to configured channels
 */
async function sendSecurityAlert(event: SecurityEvent): Promise<void> {
  const alertPromises: Promise<void>[] = [];
  
  // Slack webhook
  if (process.env.SECURITY_SLACK_WEBHOOK_URL) {
    alertPromises.push(sendSlackAlert(event));
  }
  
  // Discord webhook
  if (process.env.SECURITY_DISCORD_WEBHOOK_URL) {
    alertPromises.push(sendDiscordAlert(event));
  }
  
  // Custom webhook
  if (process.env.SECURITY_WEBHOOK_URL) {
    alertPromises.push(sendWebhookAlert(event));
  }
  
  // Wait for all alerts (don't block the main flow)
  await Promise.allSettled(alertPromises);
}

/**
 * Send alert to Slack
 */
async function sendSlackAlert(event: SecurityEvent): Promise<void> {
  const webhookUrl = process.env.SECURITY_SLACK_WEBHOOK_URL;
  if (!webhookUrl) return;
  
  try {
    const color = event.severity === "critical" ? "#FF0000" : 
                  event.severity === "high" ? "#FF6600" : "#FFCC00";
    
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        attachments: [{
          color,
          title: `🚨 Security Alert: ${event.type}`,
          text: event.message,
          fields: [
            { title: "Severity", value: event.severity.toUpperCase(), short: true },
            { title: "Time", value: event.timestamp, short: true },
            ...(event.ip ? [{ title: "IP", value: event.ip, short: true }] : []),
            ...(event.path ? [{ title: "Path", value: event.path, short: true }] : []),
            ...(event.userId ? [{ title: "User ID", value: event.userId, short: true }] : []),
          ],
          footer: "BMSPro Black Security Monitor",
        }],
      }),
    });
  } catch (error) {
    console.error("[Security] Failed to send Slack alert:", error);
  }
}

/**
 * Send alert to Discord
 */
async function sendDiscordAlert(event: SecurityEvent): Promise<void> {
  const webhookUrl = process.env.SECURITY_DISCORD_WEBHOOK_URL;
  if (!webhookUrl) return;
  
  try {
    const color = event.severity === "critical" ? 0xFF0000 : 
                  event.severity === "high" ? 0xFF6600 : 0xFFCC00;
    
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        embeds: [{
          title: `🚨 Security Alert: ${event.type}`,
          description: event.message,
          color,
          fields: [
            { name: "Severity", value: event.severity.toUpperCase(), inline: true },
            { name: "Time", value: event.timestamp, inline: true },
            ...(event.ip ? [{ name: "IP", value: event.ip, inline: true }] : []),
            ...(event.path ? [{ name: "Path", value: event.path, inline: true }] : []),
          ],
          footer: { text: "BMSPro Black Security Monitor" },
        }],
      }),
    });
  } catch (error) {
    console.error("[Security] Failed to send Discord alert:", error);
  }
}

/**
 * Send alert to custom webhook
 */
async function sendWebhookAlert(event: SecurityEvent): Promise<void> {
  const webhookUrl = process.env.SECURITY_WEBHOOK_URL;
  if (!webhookUrl) return;
  
  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: event.type,
        severity: event.severity,
        message: event.message,
        timestamp: event.timestamp,
        details: event.details,
        ip: event.ip,
        userId: event.userId,
        path: event.path,
        source: "BMSPro Black Admin Panel",
      }),
    });
  } catch (error) {
    console.error("[Security] Failed to send webhook alert:", error);
  }
}

// ============================================================
// FIRESTORE STORAGE
// ============================================================

/**
 * Store security event in Firestore for analysis
 */
async function storeSecurityEventInFirestore(event: SecurityEvent): Promise<void> {
  try {
    // Dynamic import to avoid initialization issues
    const { adminDb } = await import("./firebaseAdmin");
    const db = adminDb();
    
    await db.collection("securityLogs").add({
      ...event,
      createdAt: new Date(),
    });
  } catch (error) {
    console.error("[Security] Failed to store event in Firestore:", error);
  }
}

// ============================================================
// HELPER FUNCTIONS FOR COMMON SCENARIOS
// ============================================================

/**
 * Log a rate limit trigger event
 */
export function logRateLimitTriggered(
  ip: string,
  endpoint: string,
  limiterType: string,
  requestCount?: number
): void {
  logSecurityEvent({
    type: "rate_limit_triggered",
    message: `Rate limit triggered for ${limiterType} on ${endpoint}`,
    ip,
    path: endpoint,
    details: {
      limiterType,
      requestCount,
    },
  });
}

/**
 * Log a failed authentication attempt
 */
export function logAuthFailure(
  ip: string,
  email?: string,
  reason?: string,
  userAgent?: string
): void {
  const bruteForceResult = trackFailedLogin(ip);
  
  logSecurityEvent({
    type: "login_failed",
    message: `Authentication failed${email ? ` for ${email}` : ""}${reason ? `: ${reason}` : ""}`,
    ip,
    userEmail: email,
    userAgent,
    details: {
      reason,
      attemptNumber: bruteForceResult.attemptCount,
      isBruteForce: bruteForceResult.isBruteForce,
    },
  });
}

/**
 * Log successful authentication
 */
export function logAuthSuccess(
  ip: string,
  userId: string,
  email?: string,
  userAgent?: string
): void {
  clearFailedLogins(ip);
  
  logSecurityEvent({
    type: "login_success",
    message: `Successful login for ${email || userId}`,
    ip,
    userId,
    userEmail: email,
    userAgent,
  });
}

/**
 * Log a suspicious request
 */
export function logSuspiciousRequest(
  ip: string,
  path: string,
  method: string,
  reason: string,
  userAgent?: string
): void {
  logSecurityEvent({
    type: "suspicious_request",
    message: `Suspicious request detected: ${reason}`,
    ip,
    path,
    method,
    userAgent,
    details: { reason },
  });
}

/**
 * Log unauthorized access attempt
 */
export function logUnauthorizedAccess(
  ip: string,
  path: string,
  userId?: string,
  reason?: string
): void {
  logSecurityEvent({
    type: "unauthorized_access",
    message: `Unauthorized access attempt to ${path}${reason ? `: ${reason}` : ""}`,
    ip,
    path,
    userId,
    details: { reason },
  });
}

// ============================================================
// SECURITY DASHBOARD DATA
// ============================================================

/**
 * Get security statistics (for dashboard display)
 * Note: This requires Firestore logging to be enabled
 */
export async function getSecurityStats(
  ownerUid: string,
  hoursBack: number = 24
): Promise<{
  totalEvents: number;
  criticalEvents: number;
  highEvents: number;
  rateLimitTriggers: number;
  failedLogins: number;
}> {
  if (process.env.SECURITY_LOG_TO_FIRESTORE !== "true") {
    return {
      totalEvents: 0,
      criticalEvents: 0,
      highEvents: 0,
      rateLimitTriggers: 0,
      failedLogins: 0,
    };
  }
  
  try {
    const { adminDb } = await import("./firebaseAdmin");
    const db = adminDb();
    
    const cutoffTime = new Date(Date.now() - hoursBack * 60 * 60 * 1000);
    
    const snapshot = await db
      .collection("securityLogs")
      .where("ownerUid", "==", ownerUid)
      .where("createdAt", ">=", cutoffTime)
      .get();
    
    const events = snapshot.docs.map(doc => doc.data() as SecurityEvent);
    
    return {
      totalEvents: events.length,
      criticalEvents: events.filter(e => e.severity === "critical").length,
      highEvents: events.filter(e => e.severity === "high").length,
      rateLimitTriggers: events.filter(e => e.type === "rate_limit_triggered").length,
      failedLogins: events.filter(e => e.type === "login_failed").length,
    };
  } catch (error) {
    console.error("[Security] Failed to get stats:", error);
    return {
      totalEvents: 0,
      criticalEvents: 0,
      highEvents: 0,
      rateLimitTriggers: 0,
      failedLogins: 0,
    };
  }
}
