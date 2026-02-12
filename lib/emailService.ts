import sgMail from "@sendgrid/mail";
import { adminDb } from "./firebaseAdmin";
import { FieldValue } from "firebase-admin/firestore";
import type { BookingStatus } from "./bookingTypes";

// Initialize SendGrid
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || "booking@bmspros.com.au";
const ADMIN_FROM_EMAIL = "noreply@bmspros.com.au"; // For admin/system emails

if (SENDGRID_API_KEY) {
  sgMail.setApiKey(SENDGRID_API_KEY);
}

/**
 * Get salon name from ownerUid
 */
async function getSalonName(ownerUid: string): Promise<string> {
  try {
    const db = adminDb();
    const ownerDoc = await db.doc(`users/${ownerUid}`).get();
    if (ownerDoc.exists) {
      const data = ownerDoc.data();
      return data?.salonName || data?.name || data?.businessName || data?.displayName || "Salon";
    }
  } catch (error) {
    console.error("Error fetching salon name:", error);
  }
  return "Salon";
}

interface BookingEmailData {
  bookingId: string;
  bookingCode?: string | null;
  customerEmail: string;
  customerName: string;
  status: BookingStatus;
  branchName?: string | null;
  bookingDate?: string | null;
  bookingTime?: string | null;
  duration?: number | null;
  price?: number | null;
  serviceName?: string | null;
  services?: Array<{
    name?: string;
    staffName?: string | null;
    time?: string;
    duration?: number;
  }>;
  staffName?: string | null;
  ownerUid: string;
  salonName?: string;
}

/**
 * Check if an email has already been sent for this booking and status
 */
async function hasEmailBeenSent(bookingId: string, status: BookingStatus): Promise<boolean> {
  try {
    const db = adminDb();
    const emailLogQuery = await db.collection("bookingEmails")
      .where("bookingId", "==", bookingId)
      .where("status", "==", status)
      .limit(1)
      .get();
    
    return !emailLogQuery.empty;
  } catch (error) {
    console.error("Error checking email log:", error);
    // If we can't check, allow sending to avoid blocking emails
    return false;
  }
}

/**
 * Log that an email was sent to prevent duplicates
 */
async function logEmailSent(bookingId: string, status: BookingStatus, customerEmail: string): Promise<void> {
  try {
    const db = adminDb();
    await db.collection("bookingEmails").add({
      bookingId,
      status,
      customerEmail,
      sentAt: FieldValue.serverTimestamp(),
      createdAt: FieldValue.serverTimestamp(),
    });
  } catch (error) {
    console.error("Error logging email:", error);
    // Don't throw - logging failure shouldn't block email sending
  }
}

/**
 * Format booking date and time for display
 */
function formatBookingDateTime(date?: string | null, time?: string | null): string {
  if (!date) return "Not specified";
  
  try {
    const dateObj = new Date(date);
    const dateStr = dateObj.toLocaleDateString("en-AU", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    
    if (time) {
      return `${dateStr} at ${time}`;
    }
    return dateStr;
  } catch (error) {
    return date || "Not specified";
  }
}

/**
 * Format price for display
 */
function formatPrice(price?: number | null): string {
  if (price === null || price === undefined) return "Not specified";
  return `$${price.toFixed(2)}`;
}

/**
 * Format duration for display
 */
function formatDuration(duration?: number | null): string {
  if (duration === null || duration === undefined) return "Not specified";
  if (duration < 60) return `${duration} minutes`;
  const hours = Math.floor(duration / 60);
  const minutes = duration % 60;
  if (minutes === 0) return `${hours} hour${hours > 1 ? "s" : ""}`;
  return `${hours} hour${hours > 1 ? "s" : ""} ${minutes} minute${minutes > 1 ? "s" : ""}`;
}

/**
 * Generate HTML email template
 */
function generateEmailHTML(
  status: BookingStatus,
  data: BookingEmailData
): string {
  const bookingDateTime = formatBookingDateTime(data.bookingDate, data.bookingTime);
  const bookingCode = data.bookingCode || "N/A";
  const salonName = data.salonName || "Salon";
  
  // Helper function to check if staff is "Any Available"
  const isAnyStaff = (staffName?: string | null): boolean => {
    if (!staffName) return true;
    const name = staffName.toLowerCase();
    return name.includes("any available") || name.includes("any staff") || name.includes("not assigned yet") || name === "any" || name.trim() === "";
  };

  // Check if any service has unassigned staff
  let hasUnassignedStaff = false;
  if (data.services && data.services.length > 0) {
    hasUnassignedStaff = data.services.some(s => isAnyStaff(s.staffName));
  } else {
    hasUnassignedStaff = isAnyStaff(data.staffName);
  }

  // Build services list
  let servicesList = "";
  if (data.services && data.services.length > 0) {
    const services = data.services; // Store reference to avoid repeated checks
    servicesList = "<table style='width: 100%; border-collapse: collapse; margin: 15px 0;'>";
    services.forEach((service, index) => {
      const serviceTime = service.time ? ` at ${service.time}` : "";
      const serviceDuration = service.duration ? ` (${formatDuration(service.duration)})` : "";
      const serviceHasStaff = service.staffName && !isAnyStaff(service.staffName);
      const staffInfo = serviceHasStaff ? ` with ${service.staffName}` : "";
      const borderBottom = index < services.length - 1 ? "border-bottom: 1px solid #e5e7eb;" : "";
      servicesList += `
        <tr style='${borderBottom}'>
          <td style='padding: 12px 0; color: #374151; font-size: 15px;'>
            <strong style='color: #111827;'>${service.name || "Service"}</strong>${serviceTime}${serviceDuration}${staffInfo}
          </td>
        </tr>
      `;
    });
    servicesList += "</table>";
  } else if (data.serviceName) {
    servicesList = `<p style='margin: 12px 0; color: #374151; font-size: 15px;'><strong style='color: #111827;'>${data.serviceName}</strong></p>`;
  }
  
  // Staff info - only show if staff is assigned, otherwise show appropriate message
  const staffInfo = data.staffName && !isAnyStaff(data.staffName) ? `
    <tr>
      <td style='padding: 8px 0; color: #6b7280; font-size: 14px;'>Staff Member</td>
      <td style='padding: 8px 0; color: #111827; font-size: 14px; font-weight: 500; text-align: right;'>${data.staffName}</td>
    </tr>
  ` : "";
  
  // Staff assignment message for unassigned staff
  // Exclude from cancellation emails
  const staffAssignmentMessage = (hasUnassignedStaff && status !== "Canceled") ? `
    <tr>
      <td colspan="2" style='padding: 12px 0;'>
        <div style='background-color: #fef3c7; border-left: 3px solid #f59e0b; padding: 12px 16px; border-radius: 6px; margin-top: 8px;'>
          <p style='margin: 0; color: #92400e; font-size: 13px; line-height: 1.5;'>
            <strong style='color: #78350f;'>ℹ️ Staff Assignment:</strong><br>
            ${status === "Pending" 
              ? "After confirming your booking, we will assign the best available staff member for your service." 
              : status === "Confirmed"
              ? "A staff member will be assigned to your booking and you will be notified once confirmed."
              : "Staff will be assigned to your booking."}
          </p>
        </div>
      </td>
    </tr>
  ` : "";
  
  const branchInfo = data.branchName ? `
    <tr>
      <td style='padding: 8px 0; color: #6b7280; font-size: 14px;'>Branch</td>
      <td style='padding: 8px 0; color: #111827; font-size: 14px; font-weight: 500; text-align: right;'>${data.branchName}</td>
    </tr>
  ` : "";
  
  const priceInfo = data.price !== null && data.price !== undefined ? `
    <tr>
      <td style='padding: 8px 0; color: #6b7280; font-size: 14px;'>Total Price</td>
      <td style='padding: 8px 0; color: #111827; font-size: 16px; font-weight: 600; text-align: right;'>${formatPrice(data.price)}</td>
    </tr>
  ` : "";
  
  const durationInfo = data.duration ? `
    <tr>
      <td style='padding: 8px 0; color: #6b7280; font-size: 14px;'>Duration</td>
      <td style='padding: 8px 0; color: #111827; font-size: 14px; font-weight: 500; text-align: right;'>${formatDuration(data.duration)}</td>
    </tr>
  ` : "";
  
  let subject = "";
  let title = "";
  let message = "";
  let icon = "";
  let color = "#6366f1";
  let bgColor = "#f0f9ff";
  
  switch (status) {
    case "Pending":
      subject = `Booking Request Received - ${salonName}`;
      title = "Booking Request Received";
      message = `Thank you for your booking request! We have received your request and will confirm it shortly.`;
      icon = "📋";
      color = "#f59e0b";
      bgColor = "#fffbeb";
      break;
    case "Confirmed":
      subject = `Booking Confirmed - ${salonName}`;
      title = "Booking Confirmed";
      message = `Great news! Your booking has been confirmed. We look forward to seeing you soon!`;
      icon = "✅";
      color = "#10b981";
      bgColor = "#ecfdf5";
      break;
    case "Completed":
      subject = `Thank You - ${salonName}`;
      title = "Booking Completed";
      message = `Thank you for visiting ${salonName}! We hope you had a wonderful experience and look forward to seeing you again.`;
      icon = "✨";
      color = "#6366f1";
      bgColor = "#eef2ff";
      break;
    case "Canceled":
      subject = `Booking Cancelled - ${salonName}`;
      title = "Booking Cancelled";
      message = `Your booking has been cancelled. If you have any questions or would like to reschedule, please contact us.`;
      icon = "❌";
      color = "#ef4444";
      bgColor = "#fef2f2";
      break;
    default:
      subject = `Booking Update - ${salonName}`;
      title = "Booking Update";
      message = `Your booking status has been updated.`;
      icon = "ℹ️";
  }
  
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${subject}</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f3f4f6;">
  <table role="presentation" style="width: 100%; border-collapse: collapse; background-color: #f3f4f6;">
    <tr>
      <td style="padding: 40px 20px;">
        <table role="presentation" style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); overflow: hidden;">
          
          <!-- Salon Header -->
          <tr>
            <td style="padding: 0; background: linear-gradient(135deg, ${color} 0%, ${color}dd 100%);">
              <!-- Salon Name Bar -->
              <div style="padding: 20px 40px; background-color: rgba(0,0,0,0.1); text-align: center;">
                <h1 style="margin: 0; color: #ffffff; font-size: 20px; font-weight: 600; letter-spacing: 0.5px;">${salonName}</h1>
              </div>
              <!-- Status Section -->
              <div style="padding: 35px 40px; text-align: center;">
                <div style="font-size: 56px; margin-bottom: 15px; line-height: 1;">${icon}</div>
                <h2 style="margin: 0; color: #ffffff; font-size: 26px; font-weight: 700; letter-spacing: -0.3px;">${title}</h2>
              </div>
            </td>
          </tr>
          
          <!-- Greeting -->
          <tr>
            <td style="padding: 30px 40px 20px;">
              <p style="margin: 0 0 15px; color: #374151; font-size: 16px; line-height: 1.6;">Hello ${data.customerName},</p>
              <p style="margin: 0 0 25px; color: #374151; font-size: 16px; line-height: 1.6;">${message}</p>
            </td>
          </tr>
          
          <!-- Booking Details Card -->
          <tr>
            <td style="padding: 0 40px 30px;">
              <div style="background-color: ${bgColor}; border: 2px solid ${color}20; border-radius: 10px; padding: 25px; margin-bottom: 20px;">
                <h3 style="margin: 0 0 20px; color: #111827; font-size: 18px; font-weight: 600; display: flex; align-items: center;">
                  <span style="display: inline-block; width: 4px; height: 20px; background-color: ${color}; border-radius: 2px; margin-right: 10px;"></span>
                  Booking Details
                </h3>
                
                <table style="width: 100%; border-collapse: collapse;">
                  <tr>
                    <td style='padding: 8px 0; color: #6b7280; font-size: 14px;'>Booking Code</td>
                    <td style='padding: 8px 0; color: #111827; font-size: 14px; font-weight: 600; text-align: right; font-family: monospace;'>${bookingCode}</td>
                  </tr>
                  <tr>
                    <td style='padding: 8px 0; color: #6b7280; font-size: 14px;'>Date & Time</td>
                    <td style='padding: 8px 0; color: #111827; font-size: 14px; font-weight: 500; text-align: right;'>${bookingDateTime}</td>
                  </tr>
                  ${branchInfo}
                  ${durationInfo}
                  ${staffInfo}
                  ${priceInfo}
                </table>
                ${staffAssignmentMessage}
                
                ${servicesList ? `
                  <div style="margin-top: 20px; padding-top: 20px; border-top: 1px solid ${color}30;">
                    <p style="margin: 0 0 10px; color: #6b7280; font-size: 14px; font-weight: 500;">Services</p>
                    ${servicesList}
                  </div>
                ` : ""}
              </div>
            </td>
          </tr>
          
          <!-- Additional Message -->
          <tr>
            <td style="padding: 0 40px 30px;">
              <div style="background-color: #f9fafb; border-radius: 8px; padding: 20px; text-align: center;">
                <p style="margin: 0; color: #6b7280; font-size: 14px; line-height: 1.6;">
                  If you have any questions or need to make changes to your booking, please don't hesitate to contact us.
                </p>
              </div>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="padding: 25px 40px; background-color: #f9fafb; border-top: 1px solid #e5e7eb; text-align: center;">
              <p style="margin: 0 0 8px; color: #111827; font-size: 14px; font-weight: 600;">${salonName}</p>
              <p style="margin: 0; color: #6b7280; font-size: 12px; line-height: 1.5;">
                This is an automated email. Please do not reply to this message.<br>
                If you need assistance, please contact us directly.
              </p>
            </td>
          </tr>
          
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();
}

/**
 * Send booking email to customer
 * Only sends if email hasn't been sent for this booking and status
 */
export async function sendBookingEmail(data: BookingEmailData): Promise<{ success: boolean; error?: string }> {
  console.log(`[EMAIL] Attempting to send email for booking ${data.bookingId}, status: ${data.status}, to: ${data.customerEmail}`);
  
  // Validate email
  if (!data.customerEmail || !data.customerEmail.trim()) {
    console.error(`[EMAIL] No customer email provided for booking ${data.bookingId}`);
    return { success: false, error: "No customer email provided" };
  }
  
  const email = data.customerEmail.trim().toLowerCase();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    console.error(`[EMAIL] Invalid email address: ${email} for booking ${data.bookingId}`);
    return { success: false, error: "Invalid email address" };
  }
  
  // Check if email should be sent for this status
  const emailStatuses: BookingStatus[] = ["Pending", "Confirmed", "Completed", "Canceled"];
  if (!emailStatuses.includes(data.status)) {
    console.log(`[EMAIL] Email not configured for status: ${data.status} (booking ${data.bookingId})`);
    return { success: false, error: `Email not configured for status: ${data.status}` };
  }
  
  // Check if email has already been sent
  const alreadySent = await hasEmailBeenSent(data.bookingId, data.status);
  if (alreadySent) {
    console.log(`[EMAIL] ⚠️ Email already sent for booking ${data.bookingId} with status ${data.status} - skipping duplicate`);
    console.log(`[EMAIL] This is expected if the status was already ${data.status} before, or if email was sent in a previous request`);
    return { success: false, error: "Email already sent for this status" };
  }
  
  console.log(`[EMAIL] ✅ No duplicate found - proceeding to send email for booking ${data.bookingId}, status: ${data.status}`);
  
  // Verify SendGrid is configured
  if (!SENDGRID_API_KEY || SENDGRID_API_KEY === "") {
    console.error(`[EMAIL] SendGrid API key not configured!`);
    return { success: false, error: "SendGrid API key not configured" };
  }
  
  try {
    // Fetch salon name if not provided
    if (!data.salonName) {
      data.salonName = await getSalonName(data.ownerUid);
    }
    
    const html = generateEmailHTML(data.status, data);
    const salonName = data.salonName || "Salon";
    const subject = data.bookingCode 
      ? `${data.status === "Pending" ? "Booking Request Received" : data.status === "Confirmed" ? "Booking Confirmed" : data.status === "Completed" ? "Thank You" : "Booking " + data.status} - ${salonName} (${data.bookingCode})`
      : `${data.status === "Pending" ? "Booking Request Received" : data.status === "Confirmed" ? "Booking Confirmed" : data.status === "Completed" ? "Thank You" : "Booking " + data.status} - ${salonName}`;
    
    const msg = {
      to: email,
      from: FROM_EMAIL,
      subject: subject,
      html: html,
    };
    
    console.log(`[EMAIL] Sending email via SendGrid:`, {
      to: email,
      from: FROM_EMAIL,
      subject: subject,
      bookingId: data.bookingId,
      status: data.status,
      salonName: salonName,
    });
    
    await sgMail.send(msg);
    
    // Log that email was sent
    await logEmailSent(data.bookingId, data.status, email);
    
    console.log(`[EMAIL] ✅ Booking email sent successfully: ${data.bookingId} - ${data.status} to ${email}`);
    return { success: true };
  } catch (error: any) {
    console.error(`[EMAIL] ❌ Error sending booking email for ${data.bookingId}:`, error);
    console.error(`[EMAIL] Error details:`, {
      message: error?.message,
      code: error?.code,
      response: error?.response?.body,
      statusCode: error?.response?.statusCode,
    });
    const errorMessage = error?.response?.body?.errors?.[0]?.message || error?.message || "Unknown error";
    return { success: false, error: errorMessage };
  }
}

/**
 * Send email when booking is created (Request Received)
 */
export async function sendBookingRequestReceivedEmail(
  bookingId: string,
  bookingCode: string | null | undefined,
  customerEmail: string | null | undefined,
  customerName: string,
  ownerUid: string,
  bookingData: {
    branchName?: string | null;
    bookingDate?: string | null;
    bookingTime?: string | null;
    duration?: number | null;
    price?: number | null;
    serviceName?: string | null;
    services?: Array<{
      name?: string;
      staffName?: string | null;
      time?: string;
      duration?: number;
    }>;
    staffName?: string | null;
  }
): Promise<void> {
  console.log(`[EMAIL] sendBookingRequestReceivedEmail called for booking ${bookingId}`, {
    customerEmail,
    customerName,
    bookingCode,
  });
  
  if (!customerEmail) {
    console.log(`[EMAIL] No email provided for booking ${bookingId}, skipping email`);
    return;
  }
  
  // Get salon name
  const salonName = await getSalonName(ownerUid);
  
  const result = await sendBookingEmail({
    bookingId,
    bookingCode: bookingCode || undefined,
    customerEmail,
    customerName,
    status: "Pending",
    ownerUid,
    salonName,
    ...bookingData,
  });
  
  if (!result.success) {
    console.error(`[EMAIL] Failed to send booking request received email:`, result.error);
  }
}

/**
 * Send email when booking status changes to Confirmed, Completed, or Canceled
 */
export async function sendBookingStatusChangeEmail(
  bookingId: string,
  newStatus: BookingStatus,
  customerEmail: string | null | undefined,
  customerName: string,
  ownerUid: string,
  bookingData: {
    bookingCode?: string | null;
    branchName?: string | null;
    bookingDate?: string | null;
    bookingTime?: string | null;
    duration?: number | null;
    price?: number | null;
    serviceName?: string | null;
    services?: Array<{
      name?: string;
      staffName?: string | null;
      time?: string;
      duration?: number;
    }>;
    staffName?: string | null;
  }
): Promise<void> {
  console.log(`[EMAIL] sendBookingStatusChangeEmail called for booking ${bookingId}`, {
    newStatus,
    customerEmail,
    customerName,
  });
  
  // Only send emails for specific statuses
  const emailStatuses: BookingStatus[] = ["Confirmed", "Completed", "Canceled"];
  if (!emailStatuses.includes(newStatus)) {
    console.log(`[EMAIL] Status ${newStatus} does not require email, skipping`);
    return;
  }
  
  if (!customerEmail) {
    console.log(`[EMAIL] No email provided for booking ${bookingId}, skipping email`);
    return;
  }
  
  // Get salon name
  const salonName = await getSalonName(ownerUid);
  
  const result = await sendBookingEmail({
    bookingId,
    bookingCode: bookingData.bookingCode || undefined,
    customerEmail,
    customerName,
    status: newStatus,
    ownerUid,
    salonName,
    ...bookingData,
  });
  
  if (!result.success) {
    console.error(`[EMAIL] Failed to send booking status change email:`, result.error);
  }
}

/**
 * Generate HTML for salon owner welcome email with login credentials and optional payment link
 * If trialDays > 0, the account is active immediately without payment (card-free trial)
 */
function generateWelcomeEmailHTML(
  salonOwnerEmail: string,
  password: string,
  businessName: string,
  planName?: string,
  planPrice?: string,
  paymentUrl?: string,
  trialDays?: number,
  bookingEngineUrl?: string
): string {
  const loginUrl = process.env.NEXT_PUBLIC_APP_URL || "https://black.bmspros.com.au";
  const hasFreeTrial = trialDays && trialDays > 0;
  
  // Free trial section HTML - show if has free trial (card-free trial flow)
  const trialSection = hasFreeTrial ? `
          <!-- FREE TRIAL ACTIVE -->
          <tr>
            <td style="padding: 0 40px 30px;">
              <div style="background: linear-gradient(135deg, #d1fae5 0%, #a7f3d0 100%); border: 2px solid #059669; border-radius: 10px; padding: 25px; margin-bottom: 20px;">
                <h3 style="margin: 0 0 15px; color: #065f46; font-size: 18px; font-weight: 600; text-align: center;">
                  🎁 Your ${trialDays}-Day Free Trial is Active!
                </h3>
                <p style="margin: 0 0 15px; color: #047857; font-size: 15px; line-height: 1.6; text-align: center;">
                  Good news! Your account is <strong>fully active</strong> and you can start using all features right away.
                  No credit card required during your trial period.
                </p>
                ${planName && planPrice ? `
                <div style="background-color: rgba(255,255,255,0.7); border-radius: 8px; padding: 15px; margin-bottom: 15px;">
                  <table style="width: 100%; border-collapse: collapse;">
                    <tr>
                      <td style='padding: 8px 0; color: #065f46; font-size: 14px; font-weight: 600;'>Selected Plan:</td>
                      <td style='padding: 8px 0; color: #111827; font-size: 14px; font-weight: 600; text-align: right;'>${planName}</td>
                    </tr>
                    <tr>
                      <td style='padding: 8px 0; color: #065f46; font-size: 14px; font-weight: 600;'>After Trial:</td>
                      <td style='padding: 8px 0; color: #111827; font-size: 16px; font-weight: 700; text-align: right;'>${planPrice}</td>
                    </tr>
                    <tr>
                      <td style='padding: 8px 0; color: #065f46; font-size: 14px; font-weight: 600;'>Free Trial:</td>
                      <td style='padding: 8px 0; color: #059669; font-size: 14px; font-weight: 700; text-align: right;'>${trialDays} days</td>
                    </tr>
                  </table>
                </div>
                ` : ''}
                <div style="background-color: #fef3c7; border-left: 3px solid #f59e0b; padding: 12px 16px; border-radius: 6px;">
                  <p style='margin: 0; color: #92400e; font-size: 13px; line-height: 1.6;'>
                    <strong style='color: #78350f;'>⏰ Reminder:</strong> We'll notify you 2 days before your trial ends.
                    To continue using the platform after your trial, simply add your payment details in the subscription settings.
                  </p>
                </div>
              </div>
            </td>
          </tr>
  ` : '';
  
  // Payment section HTML - only show if payment is required AND no free trial
  const paymentSection = (paymentUrl && !hasFreeTrial) ? `
          <!-- IMPORTANT: Payment Required -->
          <tr>
            <td style="padding: 0 40px 30px;">
              <div style="background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%); border: 2px solid #f59e0b; border-radius: 10px; padding: 25px; margin-bottom: 20px;">
                <h3 style="margin: 0 0 15px; color: #78350f; font-size: 18px; font-weight: 600; text-align: center;">
                  💳 Complete Your Subscription
                </h3>
                <p style="margin: 0 0 20px; color: #92400e; font-size: 15px; line-height: 1.6; text-align: center;">
                  To activate your account and access all features, please complete your subscription payment.
                </p>
                ${planName && planPrice ? `
                <div style="background-color: rgba(255,255,255,0.7); border-radius: 8px; padding: 15px; margin-bottom: 20px;">
                  <table style="width: 100%; border-collapse: collapse;">
                    <tr>
                      <td style='padding: 8px 0; color: #78350f; font-size: 14px; font-weight: 600;'>Selected Plan:</td>
                      <td style='padding: 8px 0; color: #111827; font-size: 14px; font-weight: 600; text-align: right;'>${planName}</td>
                    </tr>
                    <tr>
                      <td style='padding: 8px 0; color: #78350f; font-size: 14px; font-weight: 600;'>Price:</td>
                      <td style='padding: 8px 0; color: #111827; font-size: 16px; font-weight: 700; text-align: right;'>${planPrice}</td>
                    </tr>
                  </table>
                </div>
                ` : ''}
                <table cellpadding="0" cellspacing="0" border="0" align="center" style="margin: 0 auto 20px;">
                  <tr>
                    <td align="center" style="background-color: #059669; padding: 18px 44px; border-radius: 8px;">
                      <a href="${paymentUrl}" style="color: #ffffff; text-decoration: none; font-weight: 700; font-size: 16px;">Pay Now &amp; Activate Account</a>
                    </td>
                  </tr>
                </table>
                <p style="margin: 15px 0 0; color: #92400e; font-size: 12px; text-align: center;">
                  Your account will be activated immediately after payment
                </p>
              </div>
            </td>
          </tr>
  ` : '';

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Welcome to BMS PRO BLACK</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f3f4f6;">
  <table role="presentation" style="width: 100%; border-collapse: collapse; background-color: #f3f4f6;">
    <tr>
      <td style="padding: 40px 20px;">
        <table role="presentation" style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); overflow: hidden;">
          
          <!-- Header -->
          <tr>
            <td style="padding: 0; background: linear-gradient(135deg, #ec4899 0%, #8b5cf6 100%);">
              <div style="padding: 40px; text-align: center;">
                <div style="font-size: 56px; margin-bottom: 15px; line-height: 1;">🎉</div>
                <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 700; letter-spacing: -0.3px;">Welcome to BMS PRO BLACK</h1>
                <p style="margin: 15px 0 0; color: rgba(255,255,255,0.9); font-size: 16px;">Your salon account has been created</p>
              </div>
            </td>
          </tr>
          
          <!-- Greeting -->
          <tr>
            <td style="padding: 30px 40px 20px;">
              <p style="margin: 0 0 15px; color: #374151; font-size: 16px; line-height: 1.6;">Hello,</p>
              <p style="margin: 0 0 25px; color: #374151; font-size: 16px; line-height: 1.6;">
                Your salon <strong>${businessName}</strong> has been successfully onboarded to BMS PRO BLACK. ${hasFreeTrial ? `<strong>Your ${trialDays}-day free trial is now active!</strong> You can start using all features immediately - no payment required during your trial.` : (paymentUrl ? '<strong>To activate your account, please complete your subscription payment below.</strong>' : 'You can now access your salon management dashboard using the login credentials below.')}
              </p>
            </td>
          </tr>
          
          ${trialSection}
          ${paymentSection}
          
          <!-- Login Credentials Card -->
          <tr>
            <td style="padding: 0 40px 30px;">
              <div style="background-color: #fef3c7; border: 2px solid #f59e0b; border-radius: 10px; padding: 25px; margin-bottom: 20px;">
                <h3 style="margin: 0 0 20px; color: #78350f; font-size: 18px; font-weight: 600; display: flex; align-items: center;">
                  <span style="display: inline-block; width: 4px; height: 20px; background-color: #f59e0b; border-radius: 2px; margin-right: 10px;"></span>
                  Your Login Credentials
                </h3>
                
                <table style="width: 100%; border-collapse: collapse;">
                  <tr>
                    <td style='padding: 12px 0; color: #78350f; font-size: 14px; font-weight: 600;'>Email Address:</td>
                    <td style='padding: 12px 0; color: #111827; font-size: 14px; font-weight: 500; text-align: right;'>${salonOwnerEmail}</td>
                  </tr>
                  <tr>
                    <td style='padding: 12px 0; color: #78350f; font-size: 14px; font-weight: 600;'>Temporary Password:</td>
                    <td style='padding: 12px 0; color: #111827; font-size: 14px; font-weight: 600; text-align: right; font-family: monospace; letter-spacing: 1px;'>${password}</td>
                  </tr>
                </table>
                
                <div style="background-color: #fff7ed; border-left: 3px solid #f59e0b; padding: 12px 16px; border-radius: 6px; margin-top: 20px;">
                  <p style='margin: 0; color: #92400e; font-size: 13px; line-height: 1.6;'>
                    <strong style='color: #78350f;'>⚠️ Important:</strong> This is a temporary password. For security reasons, please change your password immediately after your first login.
                  </p>
                </div>
              </div>
            </td>
          </tr>
          
          ${bookingEngineUrl ? `
          <!-- Booking Engine Link -->
          <tr>
            <td style="padding: 0 40px 30px;">
              <div style="background: linear-gradient(135deg, #ede9fe 0%, #ddd6fe 100%); border: 2px solid #7c3aed; border-radius: 10px; padding: 25px; text-align: center;">
                <div style="font-size: 40px; margin-bottom: 12px; line-height: 1;">🌐</div>
                <h3 style="margin: 0 0 10px; color: #4c1d95; font-size: 18px; font-weight: 700;">Your Online Booking Page is Live!</h3>
                <p style="margin: 0 0 20px; color: #5b21b6; font-size: 14px; line-height: 1.6;">
                  Share this link with your clients so they can book appointments 24/7
                </p>
                <table cellpadding="0" cellspacing="0" border="0" align="center" style="margin: 0 auto 15px;">
                  <tr>
                    <td align="center" style="background: linear-gradient(135deg, #7c3aed 0%, #6d28d9 100%); padding: 14px 36px; border-radius: 8px;">
                      <a href="${bookingEngineUrl}" style="color: #ffffff; text-decoration: none; font-weight: 700; font-size: 15px;">Open Booking Page</a>
                    </td>
                  </tr>
                </table>
                <p style="margin: 0; color: #6d28d9; font-size: 13px; word-break: break-all;">
                  <a href="${bookingEngineUrl}" style="color: #6d28d9; text-decoration: underline;">${bookingEngineUrl}</a>
                </p>
                <div style="background-color: rgba(255,255,255,0.6); border-radius: 8px; padding: 12px 16px; margin-top: 15px;">
                  <p style="margin: 0; color: #5b21b6; font-size: 12px; line-height: 1.5;">
                    <strong>Tip:</strong> Add this link to your Instagram bio, Facebook page, Google Business listing, and business cards to get more bookings!
                  </p>
                </div>
              </div>
            </td>
          </tr>
          ` : ''}

          <!-- Next Steps -->
          <tr>
            <td style="padding: 0 40px 30px;">
              <div style="background-color: #eef2ff; border: 2px solid #6366f1; border-radius: 10px; padding: 25px;">
                <h3 style="margin: 0 0 15px; color: #312e81; font-size: 18px; font-weight: 600; display: flex; align-items: center;">
                  <span style="display: inline-block; width: 4px; height: 20px; background-color: #6366f1; border-radius: 2px; margin-right: 10px;"></span>
                  Next Steps
                </h3>
                <ol style="margin: 0; padding-left: 20px; color: #374151; font-size: 15px; line-height: 1.8;">
                  ${(paymentUrl && !hasFreeTrial) ? '<li style="margin-bottom: 10px;"><strong>Complete your subscription payment</strong> using the button above</li>' : ''}
                  <li style="margin-bottom: 10px;">Log in to your dashboard using the credentials above</li>
                  <li style="margin-bottom: 10px;">Change your temporary password to a secure one</li>
                  <li style="margin-bottom: 10px;">Complete your salon profile and settings</li>
                  <li style="margin-bottom: 10px;">Start managing your bookings, staff, and services</li>
                  ${hasFreeTrial ? `<li>Add payment details before your trial ends to continue uninterrupted</li>` : ''}
                </ol>
              </div>
            </td>
          </tr>
          
          <!-- Login Button -->
          <tr>
            <td style="padding: 0 40px 30px; text-align: center;">
              <a href="${loginUrl}/" style="display: inline-block; padding: 14px 32px; background: linear-gradient(135deg, #ec4899 0%, #8b5cf6 100%); color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; box-shadow: 0 4px 6px rgba(236, 72, 153, 0.3);">
                Log in to Dashboard
              </a>
            </td>
          </tr>
          
          <!-- Additional Info -->
          <tr>
            <td style="padding: 0 40px 30px;">
              <div style="background-color: #f9fafb; border-radius: 8px; padding: 20px; text-align: center;">
                <p style="margin: 0; color: #6b7280; font-size: 14px; line-height: 1.6;">
                  If you have any questions or need assistance, please don't hesitate to contact our support team.
                </p>
              </div>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="padding: 25px 40px; background-color: #f9fafb; border-top: 1px solid #e5e7eb; text-align: center;">
              <p style="margin: 0 0 8px; color: #111827; font-size: 14px; font-weight: 600;">BMS PRO BLACK</p>
              <p style="margin: 0; color: #6b7280; font-size: 12px; line-height: 1.5;">
                This is an automated email from BMS PRO BLACK.<br>
                Please do not reply to this message.
              </p>
            </td>
          </tr>
          
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();
}

/**
 * Send welcome email to salon owner with login credentials and optional payment link
 * If trialDays > 0, the email will reflect card-free trial activation
 */
export async function sendSalonOwnerWelcomeEmail(
  salonOwnerEmail: string,
  password: string,
  businessName: string,
  planName?: string,
  planPrice?: string,
  paymentUrl?: string,
  trialDays?: number,
  bookingEngineUrl?: string
): Promise<{ success: boolean; error?: string }> {
  console.log(`[EMAIL] Attempting to send welcome email to salon owner: ${salonOwnerEmail}`);
  
  // Validate email
  if (!salonOwnerEmail || !salonOwnerEmail.trim()) {
    console.error(`[EMAIL] No salon owner email provided`);
    return { success: false, error: "No salon owner email provided" };
  }
  
  const email = salonOwnerEmail.trim().toLowerCase();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    console.error(`[EMAIL] Invalid email address: ${email}`);
    return { success: false, error: "Invalid email address" };
  }
  
  // Verify SendGrid is configured
  if (!SENDGRID_API_KEY || SENDGRID_API_KEY === "") {
    console.error(`[EMAIL] SendGrid API key not configured!`);
    return { success: false, error: "SendGrid API key not configured" };
  }
  
  try {
    const html = generateWelcomeEmailHTML(email, password, businessName, planName, planPrice, paymentUrl, trialDays, bookingEngineUrl);
    const hasFreeTrial = trialDays && trialDays > 0;
    const subject = hasFreeTrial
      ? `Welcome to BMS PRO BLACK - Your ${trialDays}-Day Free Trial is Active!`
      : (paymentUrl 
        ? `Welcome to BMS PRO BLACK - Complete Your Subscription`
        : `Welcome to BMS PRO BLACK - Your Account is Ready`);
    
    const msg = {
      to: email,
      from: ADMIN_FROM_EMAIL,
      subject: subject,
      html: html,
      trackingSettings: {
        clickTracking: {
          enable: false, // Disable click tracking so links go directly to destination
        },
      },
    };
    
    console.log(`[EMAIL] Sending welcome email via SendGrid:`, {
      to: email,
      from: ADMIN_FROM_EMAIL,
      subject: subject,
      businessName: businessName,
      planName: planName,
      hasPaymentUrl: !!paymentUrl,
      clickTracking: false,
    });
    
    await sgMail.send(msg);
    
    console.log(`[EMAIL] ✅ Welcome email sent successfully to ${email}`);
    return { success: true };
  } catch (error: any) {
    console.error(`[EMAIL] ❌ Error sending welcome email to ${email}:`, error);
    console.error(`[EMAIL] Error details:`, {
      message: error?.message,
      code: error?.code,
      response: error?.response?.body,
      statusCode: error?.response?.statusCode,
    });
    const errorMessage = error?.response?.body?.errors?.[0]?.message || error?.message || "Unknown error";
    return { success: false, error: errorMessage };
  }
}

/**
 * Generate HTML for staff welcome email with login credentials
 */
function generateStaffWelcomeEmailHTML(
  staffEmail: string,
  password: string,
  staffName: string,
  role: string, // 'salon_staff' or 'salon_branch_admin'
  salonName?: string,
  branchName?: string
): string {
  const isBranchAdmin = role === 'salon_branch_admin';
  const roleDisplayName = isBranchAdmin ? 'Branch Administrator' : 'Staff Member';
  const loginUrl = process.env.NEXT_PUBLIC_APP_URL || "https://black.bmspros.com.au";
  
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Welcome to BMS PRO BLACK</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f3f4f6;">
  <table role="presentation" style="width: 100%; border-collapse: collapse; background-color: #f3f4f6;">
    <tr>
      <td style="padding: 40px 20px;">
        <table role="presentation" style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); overflow: hidden;">
          
          <!-- Header -->
          <tr>
            <td style="padding: 0; background: linear-gradient(135deg, #ec4899 0%, #8b5cf6 100%);">
              <div style="padding: 40px; text-align: center;">
                <div style="font-size: 56px; margin-bottom: 15px; line-height: 1;">🎉</div>
                <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 700; letter-spacing: -0.3px;">Welcome to BMS PRO BLACK</h1>
                <p style="margin: 15px 0 0; color: rgba(255,255,255,0.9); font-size: 16px;">Your ${roleDisplayName} account has been created</p>
              </div>
            </td>
          </tr>
          
          <!-- Greeting -->
          <tr>
            <td style="padding: 30px 40px 20px;">
              <p style="margin: 0 0 15px; color: #374151; font-size: 16px; line-height: 1.6;">Hello ${staffName},</p>
              <p style="margin: 0 0 25px; color: #374151; font-size: 16px; line-height: 1.6;">
                ${salonName ? `You have been added as a <strong>${roleDisplayName}</strong> to <strong>${salonName}</strong>.` : `You have been added as a <strong>${roleDisplayName}</strong>.`}
                ${branchName && isBranchAdmin ? ` You have been assigned as the administrator for the <strong>${branchName}</strong> branch.` : ''}
                You can now access the BMS PRO BLACK system using the login credentials below.
              </p>
            </td>
          </tr>
          
          <!-- Login Credentials Card -->
          <tr>
            <td style="padding: 0 40px 30px;">
              <div style="background-color: #fef3c7; border: 2px solid #f59e0b; border-radius: 10px; padding: 25px; margin-bottom: 20px;">
                <h3 style="margin: 0 0 20px; color: #78350f; font-size: 18px; font-weight: 600; display: flex; align-items: center;">
                  <span style="display: inline-block; width: 4px; height: 20px; background-color: #f59e0b; border-radius: 2px; margin-right: 10px;"></span>
                  Your Login Credentials
                </h3>
                
                <table style="width: 100%; border-collapse: collapse;">
                  <tr>
                    <td style='padding: 12px 0; color: #78350f; font-size: 14px; font-weight: 600;'>Email Address:</td>
                    <td style='padding: 12px 0; color: #111827; font-size: 14px; font-weight: 500; text-align: right;'>${staffEmail}</td>
                  </tr>
                  <tr>
                    <td style='padding: 12px 0; color: #78350f; font-size: 14px; font-weight: 600;'>Temporary Password:</td>
                    <td style='padding: 12px 0; color: #111827; font-size: 14px; font-weight: 600; text-align: right; font-family: monospace; letter-spacing: 1px;'>${password}</td>
                  </tr>
                </table>
                
                <div style="background-color: #fff7ed; border-left: 3px solid #f59e0b; padding: 12px 16px; border-radius: 6px; margin-top: 20px;">
                  <p style='margin: 0; color: #92400e; font-size: 13px; line-height: 1.6;'>
                    <strong style='color: #78350f;'>⚠️ Important:</strong> This is a temporary password. For security reasons, please change your password immediately after your first login.
                  </p>
                </div>
              </div>
            </td>
          </tr>
          
          <!-- Role Information -->
          ${isBranchAdmin ? `
          <tr>
            <td style="padding: 0 40px 30px;">
              <div style="background-color: #e0e7ff; border: 2px solid #6366f1; border-radius: 10px; padding: 25px;">
                <h3 style="margin: 0 0 15px; color: #312e81; font-size: 18px; font-weight: 600; display: flex; align-items: center;">
                  <span style="display: inline-block; width: 4px; height: 20px; background-color: #6366f1; border-radius: 2px; margin-right: 10px;"></span>
                  Branch Administrator Role
                </h3>
                <p style="margin: 0; color: #374151; font-size: 15px; line-height: 1.8;">
                  As a Branch Administrator, you have access to manage bookings, staff, and services for your assigned branch. You can also view reports and analytics for your branch.
                </p>
              </div>
            </td>
          </tr>
          ` : ''}
          
          <!-- Next Steps -->
          <tr>
            <td style="padding: 0 40px 30px;">
              <div style="background-color: #eef2ff; border: 2px solid #6366f1; border-radius: 10px; padding: 25px;">
                <h3 style="margin: 0 0 15px; color: #312e81; font-size: 18px; font-weight: 600; display: flex; align-items: center;">
                  <span style="display: inline-block; width: 4px; height: 20px; background-color: #6366f1; border-radius: 2px; margin-right: 10px;"></span>
                  Next Steps
                </h3>
                <ol style="margin: 0; padding-left: 20px; color: #374151; font-size: 15px; line-height: 1.8;">
                  <li style="margin-bottom: 10px;">Log in using the credentials above</li>
                  <li style="margin-bottom: 10px;">Change your temporary password to a secure one</li>
                  <li style="margin-bottom: 10px;">Complete your profile</li>
                  <li>Start using the BMS PRO BLACK system</li>
                </ol>
              </div>
            </td>
          </tr>
          
          <!-- Login Button -->
          <tr>
            <td style="padding: 0 40px 30px; text-align: center;">
              <a href="${loginUrl}/login" style="display: inline-block; padding: 14px 32px; background: linear-gradient(135deg, #ec4899 0%, #8b5cf6 100%); color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; box-shadow: 0 4px 6px rgba(236, 72, 153, 0.3);">
                Log in to System
              </a>
            </td>
          </tr>
          
          <!-- Additional Info -->
          <tr>
            <td style="padding: 0 40px 30px;">
              <div style="background-color: #f9fafb; border-radius: 8px; padding: 20px; text-align: center;">
                <p style="margin: 0; color: #6b7280; font-size: 14px; line-height: 1.6;">
                  If you have any questions or need assistance, please contact your salon administrator.
                </p>
              </div>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="padding: 25px 40px; background-color: #f9fafb; border-top: 1px solid #e5e7eb; text-align: center;">
              <p style="margin: 0 0 8px; color: #111827; font-size: 14px; font-weight: 600;">BMS PRO BLACK</p>
              <p style="margin: 0; color: #6b7280; font-size: 12px; line-height: 1.5;">
                This is an automated email from BMS PRO BLACK.<br>
                Please do not reply to this message.
              </p>
            </td>
          </tr>
          
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();
}

/**
 * Send welcome email to staff member with login credentials
 */
export async function sendStaffWelcomeEmail(
  staffEmail: string,
  password: string,
  staffName: string,
  role: string, // 'salon_staff' or 'salon_branch_admin'
  salonName?: string,
  branchName?: string
): Promise<{ success: boolean; error?: string }> {
  console.log(`[EMAIL] Attempting to send welcome email to staff: ${staffEmail}`);
  
  // Validate email
  if (!staffEmail || !staffEmail.trim()) {
    console.error(`[EMAIL] No staff email provided`);
    return { success: false, error: "No staff email provided" };
  }
  
  const email = staffEmail.trim().toLowerCase();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    console.error(`[EMAIL] Invalid email address: ${email}`);
    return { success: false, error: "Invalid email address" };
  }
  
  // Verify SendGrid is configured
  if (!SENDGRID_API_KEY || SENDGRID_API_KEY === "") {
    console.error(`[EMAIL] SendGrid API key not configured!`);
    return { success: false, error: "SendGrid API key not configured" };
  }
  
  try {
    const html = generateStaffWelcomeEmailHTML(email, password, staffName, role, salonName, branchName);
    const roleDisplayName = role === 'salon_branch_admin' ? 'Branch Administrator' : 'Staff Member';
    const subject = `Welcome to BMS PRO BLACK - Your ${roleDisplayName} Account is Ready`;
    
    const msg = {
      to: email,
      from: ADMIN_FROM_EMAIL,
      subject: subject,
      html: html,
      trackingSettings: {
        clickTracking: {
          enable: false, // Disable click tracking so links go directly to destination
        },
      },
    };
    
    console.log(`[EMAIL] Sending staff welcome email via SendGrid:`, {
      to: email,
      from: ADMIN_FROM_EMAIL,
      subject: subject,
      staffName: staffName,
      role: role,
      salonName: salonName,
      branchName: branchName,
      clickTracking: false,
    });
    
    await sgMail.send(msg);
    
    console.log(`[EMAIL] ✅ Staff welcome email sent successfully to ${email}`);
    return { success: true };
  } catch (error: any) {
    console.error(`[EMAIL] ❌ Error sending staff welcome email to ${email}:`, error);
    console.error(`[EMAIL] Error details:`, {
      message: error?.message,
      code: error?.code,
      response: error?.response?.body,
      statusCode: error?.response?.statusCode,
    });
    const errorMessage = error?.response?.body?.errors?.[0]?.message || error?.message || "Unknown error";
    return { success: false, error: errorMessage };
  }
}

/**
 * Generate HTML for branch admin assignment notification email
 */
function generateBranchAdminAssignmentEmailHTML(
  staffName: string,
  branchName: string,
  salonName?: string
): string {
  const loginUrl = process.env.NEXT_PUBLIC_APP_URL || "https://black.bmspros.com.au";
  
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Branch Administrator Assignment - BMS PRO BLACK</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f3f4f6;">
  <table role="presentation" style="width: 100%; border-collapse: collapse; background-color: #f3f4f6;">
    <tr>
      <td style="padding: 40px 20px;">
        <table role="presentation" style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); overflow: hidden;">
          
          <!-- Header -->
          <tr>
            <td style="padding: 0; background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);">
              <div style="padding: 40px; text-align: center;">
                <div style="font-size: 56px; margin-bottom: 15px; line-height: 1;">🎯</div>
                <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 700; letter-spacing: -0.3px;">Branch Administrator Assignment</h1>
                <p style="margin: 15px 0 0; color: rgba(255,255,255,0.9); font-size: 16px;">You have been assigned as Branch Administrator</p>
              </div>
            </td>
          </tr>
          
          <!-- Greeting -->
          <tr>
            <td style="padding: 30px 40px 20px;">
              <p style="margin: 0 0 15px; color: #374151; font-size: 16px; line-height: 1.6;">Hello ${staffName},</p>
              <p style="margin: 0 0 25px; color: #374151; font-size: 16px; line-height: 1.6;">
                ${salonName ? `You have been assigned as the <strong>Branch Administrator</strong> for the <strong>${branchName}</strong> branch at <strong>${salonName}</strong>.` : `You have been assigned as the <strong>Branch Administrator</strong> for the <strong>${branchName}</strong> branch.`}
              </p>
            </td>
          </tr>
          
          <!-- Role Information -->
          <tr>
            <td style="padding: 0 40px 30px;">
              <div style="background-color: #e0e7ff; border: 2px solid #6366f1; border-radius: 10px; padding: 25px;">
                <h3 style="margin: 0 0 15px; color: #312e81; font-size: 18px; font-weight: 600; display: flex; align-items: center;">
                  <span style="display: inline-block; width: 4px; height: 20px; background-color: #6366f1; border-radius: 2px; margin-right: 10px;"></span>
                  Your New Responsibilities
                </h3>
                <ul style="margin: 0; padding-left: 20px; color: #374151; font-size: 15px; line-height: 1.8;">
                  <li style="margin-bottom: 10px;">Manage bookings for your branch</li>
                  <li style="margin-bottom: 10px;">Oversee staff schedules and assignments</li>
                  <li style="margin-bottom: 10px;">Manage branch services and settings</li>
                  <li>View reports and analytics for your branch</li>
                </ul>
              </div>
            </td>
          </tr>
          
          <!-- Action Button -->
          <tr>
            <td style="padding: 0 40px 30px; text-align: center;">
              <a href="${loginUrl}/login" style="display: inline-block; padding: 14px 32px; background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%); color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; box-shadow: 0 4px 6px rgba(99, 102, 241, 0.3);">
                Access Branch Dashboard
              </a>
            </td>
          </tr>
          
          <!-- Additional Info -->
          <tr>
            <td style="padding: 0 40px 30px;">
              <div style="background-color: #f9fafb; border-radius: 8px; padding: 20px; text-align: center;">
                <p style="margin: 0; color: #6b7280; font-size: 14px; line-height: 1.6;">
                  If you have any questions about your new role, please contact your salon administrator.
                </p>
              </div>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="padding: 25px 40px; background-color: #f9fafb; border-top: 1px solid #e5e7eb; text-align: center;">
              <p style="margin: 0 0 8px; color: #111827; font-size: 14px; font-weight: 600;">BMS PRO BLACK</p>
              <p style="margin: 0; color: #6b7280; font-size: 12px; line-height: 1.5;">
                This is an automated email from BMS PRO BLACK.<br>
                Please do not reply to this message.
              </p>
            </td>
          </tr>
          
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();
}

/**
 * Send branch admin assignment notification email to existing staff member
 */
export async function sendBranchAdminAssignmentEmail(
  staffEmail: string,
  staffName: string,
  branchName: string,
  salonName?: string
): Promise<{ success: boolean; error?: string }> {
  console.log(`[EMAIL] Attempting to send branch admin assignment email to: ${staffEmail}`);
  
  // Validate email
  if (!staffEmail || !staffEmail.trim()) {
    console.error(`[EMAIL] No staff email provided`);
    return { success: false, error: "No staff email provided" };
  }
  
  const email = staffEmail.trim().toLowerCase();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    console.error(`[EMAIL] Invalid email address: ${email}`);
    return { success: false, error: "Invalid email address" };
  }
  
  // Verify SendGrid is configured
  if (!SENDGRID_API_KEY || SENDGRID_API_KEY === "") {
    console.error(`[EMAIL] SendGrid API key not configured!`);
    return { success: false, error: "SendGrid API key not configured" };
  }
  
  try {
    const html = generateBranchAdminAssignmentEmailHTML(staffName, branchName, salonName);
    const subject = `Branch Administrator Assignment - ${branchName}`;
    
    const msg = {
      to: email,
      from: ADMIN_FROM_EMAIL,
      subject: subject,
      html: html,
      trackingSettings: {
        clickTracking: {
          enable: false, // Disable click tracking so links go directly to destination
        },
      },
    };
    
    console.log(`[EMAIL] Sending branch admin assignment email via SendGrid:`, {
      to: email,
      from: ADMIN_FROM_EMAIL,
      subject: subject,
      staffName: staffName,
      branchName: branchName,
      salonName: salonName,
      clickTracking: false,
    });
    
    await sgMail.send(msg);
    
    console.log(`[EMAIL] ✅ Branch admin assignment email sent successfully to ${email}`);
    return { success: true };
  } catch (error: any) {
    console.error(`[EMAIL] ❌ Error sending branch admin assignment email to ${email}:`, error);
    console.error(`[EMAIL] Error details:`, {
      message: error?.message,
      code: error?.code,
      response: error?.response?.body,
      statusCode: error?.response?.statusCode,
    });
    const errorMessage = error?.response?.body?.errors?.[0]?.message || error?.message || "Unknown error";
    return { success: false, error: errorMessage };
  }
}

/**
 * Generate HTML for password reset email with 6-digit code
 */
function generatePasswordResetEmailHTML(
  userName: string,
  resetCode: string
): string {
  const resetPageUrl = `${process.env.NEXT_PUBLIC_APP_URL || "https://black.bmspros.com.au"}/reset-password`;
  
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Reset Your Password - BMS PRO BLACK</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f3f4f6;">
  <table role="presentation" style="width: 100%; border-collapse: collapse; background-color: #f3f4f6;">
    <tr>
      <td style="padding: 40px 20px;">
        <table role="presentation" style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); overflow: hidden;">
          
          <!-- Header -->
          <tr>
            <td style="padding: 0; background: linear-gradient(135deg, #ec4899 0%, #8b5cf6 100%);">
              <div style="padding: 40px; text-align: center;">
                <div style="font-size: 56px; margin-bottom: 15px; line-height: 1;">🔐</div>
                <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 700; letter-spacing: -0.3px;">Reset Your Password</h1>
                <p style="margin: 15px 0 0; color: rgba(255,255,255,0.9); font-size: 16px;">BMS PRO BLACK</p>
              </div>
            </td>
          </tr>
          
          <!-- Greeting -->
          <tr>
            <td style="padding: 30px 40px 20px;">
              <p style="margin: 0 0 15px; color: #374151; font-size: 16px; line-height: 1.6;">Hello ${userName},</p>
              <p style="margin: 0 0 25px; color: #374151; font-size: 16px; line-height: 1.6;">
                We received a request to reset your password for your BMS PRO BLACK account. Use the 6-digit code below to verify your identity and reset your password.
              </p>
            </td>
          </tr>
          
          <!-- Verification Code -->
          <tr>
            <td style="padding: 0 40px 30px; text-align: center;">
              <div style="background: linear-gradient(135deg, #fef3c7 0%, #fef9e7 100%); border: 2px solid #f59e0b; border-radius: 16px; padding: 30px; margin-bottom: 20px;">
                <p style="margin: 0 0 15px; color: #78350f; font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px;">Your Verification Code</p>
                <div style="font-size: 48px; font-weight: 700; letter-spacing: 8px; color: #92400e; font-family: monospace; margin: 15px 0;">
                  ${resetCode}
                </div>
                <p style="margin: 15px 0 0; color: #92400e; font-size: 13px;">Enter this code on the password reset page</p>
              </div>
            </td>
          </tr>
          
          <!-- Reset Button -->
          <tr>
            <td style="padding: 0 40px 30px; text-align: center;">
              <a href="${resetPageUrl}" style="display: inline-block; padding: 14px 32px; background: linear-gradient(135deg, #ec4899 0%, #8b5cf6 100%); color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; box-shadow: 0 4px 6px rgba(236, 72, 153, 0.3);">
                Go to Reset Password Page
              </a>
            </td>
          </tr>
          
          <!-- Warning -->
          <tr>
            <td style="padding: 0 40px 30px;">
              <div style="background-color: #fff7ed; border-left: 3px solid #f59e0b; padding: 12px 16px; border-radius: 6px;">
                <p style='margin: 0; color: #92400e; font-size: 13px; line-height: 1.6;'>
                  <strong style='color: #78350f;'>⚠️ Important:</strong> This code will expire in 15 minutes. If you didn't request a password reset, please ignore this email or contact support if you have concerns.
                </p>
              </div>
            </td>
          </tr>
          
          <!-- Instructions -->
          <tr>
            <td style="padding: 0 40px 30px;">
              <div style="background-color: #eef2ff; border-radius: 8px; padding: 20px;">
                <p style="margin: 0 0 12px; color: #312e81; font-size: 14px; font-weight: 600;">How to reset your password:</p>
                <ol style="margin: 0; padding-left: 20px; color: #374151; font-size: 14px; line-height: 1.8;">
                  <li style="margin-bottom: 8px;">Click the button above or go to the reset password page</li>
                  <li style="margin-bottom: 8px;">Enter your email address and the 6-digit code</li>
                  <li style="margin-bottom: 8px;">Create a new secure password</li>
                  <li>Sign in with your new password</li>
                </ol>
              </div>
            </td>
          </tr>
          
          <!-- Additional Info -->
          <tr>
            <td style="padding: 0 40px 30px;">
              <div style="background-color: #f9fafb; border-radius: 8px; padding: 20px; text-align: center;">
                <p style="margin: 0; color: #6b7280; font-size: 14px; line-height: 1.6;">
                  If you have any questions or need assistance, please don't hesitate to contact our support team.
                </p>
              </div>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="padding: 25px 40px; background-color: #f9fafb; border-top: 1px solid #e5e7eb; text-align: center;">
              <p style="margin: 0 0 8px; color: #111827; font-size: 14px; font-weight: 600;">BMS PRO BLACK</p>
              <p style="margin: 0; color: #6b7280; font-size: 12px; line-height: 1.5;">
                This is an automated email from BMS PRO BLACK.<br>
                Please do not reply to this message.
              </p>
            </td>
          </tr>
          
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();
}

/**
 * Generate HTML for admin notification email when a new salon signs up
 */
function generateAdminSignupNotificationEmailHTML(
  businessName: string,
  ownerEmail: string,
  planName?: string,
  planPrice?: string,
  businessType?: string,
  state?: string,
  phone?: string,
  abn?: string,
  trialDays?: number
): string {
  const signupDate = new Date().toLocaleString("en-AU", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Australia/Sydney",
  });

  const hasFreeTrial = trialDays && trialDays > 0;
  
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>New Salon Signup - BMS PRO BLACK</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f3f4f6;">
  <table role="presentation" style="width: 100%; border-collapse: collapse; background-color: #f3f4f6;">
    <tr>
      <td style="padding: 40px 20px;">
        <table role="presentation" style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); overflow: hidden;">
          
          <!-- Header -->
          <tr>
            <td style="padding: 0; background: linear-gradient(135deg, #10b981 0%, #059669 100%);">
              <div style="padding: 40px; text-align: center;">
                <div style="font-size: 56px; margin-bottom: 15px; line-height: 1;">🎉</div>
                <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 700; letter-spacing: -0.3px;">New Salon Signup!</h1>
                <p style="margin: 15px 0 0; color: rgba(255,255,255,0.9); font-size: 16px;">A new business has joined BMS PRO BLACK</p>
              </div>
            </td>
          </tr>
          
          <!-- Main Content -->
          <tr>
            <td style="padding: 30px 40px 20px;">
              <p style="margin: 0 0 25px; color: #374151; font-size: 16px; line-height: 1.6;">
                A new salon has signed up for BMS PRO BLACK. Here are the details:
              </p>
            </td>
          </tr>
          
          <!-- Business Details Card -->
          <tr>
            <td style="padding: 0 40px 30px;">
              <div style="background-color: #ecfdf5; border: 2px solid #10b981; border-radius: 10px; padding: 25px;">
                <h3 style="margin: 0 0 20px; color: #065f46; font-size: 18px; font-weight: 600;">
                  <span style="display: inline-block; width: 4px; height: 20px; background-color: #10b981; border-radius: 2px; margin-right: 10px; vertical-align: middle;"></span>
                  Business Details
                </h3>
                
                <table style="width: 100%; border-collapse: collapse;">
                  <tr>
                    <td style='padding: 10px 0; color: #065f46; font-size: 14px; font-weight: 600; width: 40%;'>Business Name:</td>
                    <td style='padding: 10px 0; color: #111827; font-size: 14px; font-weight: 600;'>${businessName}</td>
                  </tr>
                  <tr>
                    <td style='padding: 10px 0; color: #065f46; font-size: 14px; font-weight: 600;'>Owner Email:</td>
                    <td style='padding: 10px 0; color: #111827; font-size: 14px;'><a href="mailto:${ownerEmail}" style="color: #059669;">${ownerEmail}</a></td>
                  </tr>
                  ${businessType ? `
                  <tr>
                    <td style='padding: 10px 0; color: #065f46; font-size: 14px; font-weight: 600;'>Business Type:</td>
                    <td style='padding: 10px 0; color: #111827; font-size: 14px;'>${businessType}</td>
                  </tr>
                  ` : ''}
                  ${state ? `
                  <tr>
                    <td style='padding: 10px 0; color: #065f46; font-size: 14px; font-weight: 600;'>State:</td>
                    <td style='padding: 10px 0; color: #111827; font-size: 14px;'>${state}</td>
                  </tr>
                  ` : ''}
                  ${phone ? `
                  <tr>
                    <td style='padding: 10px 0; color: #065f46; font-size: 14px; font-weight: 600;'>Phone:</td>
                    <td style='padding: 10px 0; color: #111827; font-size: 14px;'>${phone}</td>
                  </tr>
                  ` : ''}
                  ${abn ? `
                  <tr>
                    <td style='padding: 10px 0; color: #065f46; font-size: 14px; font-weight: 600;'>ABN:</td>
                    <td style='padding: 10px 0; color: #111827; font-size: 14px; font-family: monospace;'>${abn}</td>
                  </tr>
                  ` : ''}
                </table>
              </div>
            </td>
          </tr>
          
          <!-- Plan Details Card -->
          <tr>
            <td style="padding: 0 40px 30px;">
              <div style="background-color: #eef2ff; border: 2px solid #6366f1; border-radius: 10px; padding: 25px;">
                <h3 style="margin: 0 0 20px; color: #312e81; font-size: 18px; font-weight: 600;">
                  <span style="display: inline-block; width: 4px; height: 20px; background-color: #6366f1; border-radius: 2px; margin-right: 10px; vertical-align: middle;"></span>
                  Subscription Details
                </h3>
                
                <table style="width: 100%; border-collapse: collapse;">
                  ${planName ? `
                  <tr>
                    <td style='padding: 10px 0; color: #312e81; font-size: 14px; font-weight: 600; width: 40%;'>Plan:</td>
                    <td style='padding: 10px 0; color: #111827; font-size: 14px; font-weight: 600;'>${planName}</td>
                  </tr>
                  ` : ''}
                  ${planPrice ? `
                  <tr>
                    <td style='padding: 10px 0; color: #312e81; font-size: 14px; font-weight: 600;'>Price:</td>
                    <td style='padding: 10px 0; color: #111827; font-size: 16px; font-weight: 700;'>${planPrice}</td>
                  </tr>
                  ` : ''}
                  <tr>
                    <td style='padding: 10px 0; color: #312e81; font-size: 14px; font-weight: 600;'>Status:</td>
                    <td style='padding: 10px 0;'>
                      <span style="display: inline-block; padding: 4px 12px; border-radius: 20px; font-size: 13px; font-weight: 600; ${
                        hasFreeTrial 
                          ? 'background-color: #d1fae5; color: #065f46;'
                          : 'background-color: #fef3c7; color: #92400e;'
                      }">
                        ${hasFreeTrial ? `${trialDays}-Day Free Trial` : 'Pending Payment'}
                      </span>
                    </td>
                  </tr>
                  <tr>
                    <td style='padding: 10px 0; color: #312e81; font-size: 14px; font-weight: 600;'>Signup Date:</td>
                    <td style='padding: 10px 0; color: #111827; font-size: 14px;'>${signupDate}</td>
                  </tr>
                </table>
              </div>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="padding: 25px 40px; background-color: #f9fafb; border-top: 1px solid #e5e7eb; text-align: center;">
              <p style="margin: 0 0 8px; color: #111827; font-size: 14px; font-weight: 600;">BMS PRO BLACK - Admin Notification</p>
              <p style="margin: 0; color: #6b7280; font-size: 12px; line-height: 1.5;">
                This is an automated notification email.<br>
                New customer signup details for your records.
              </p>
            </td>
          </tr>
          
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();
}

/**
 * Send admin notification email when a new salon signs up
 */
export async function sendAdminSignupNotificationEmail(
  businessName: string,
  ownerEmail: string,
  planName?: string,
  planPrice?: string,
  businessType?: string,
  state?: string,
  phone?: string,
  abn?: string,
  trialDays?: number
): Promise<{ success: boolean; error?: string }> {
  const ADMIN_NOTIFICATION_EMAIL = "admin@bmspros.com.au";
  
  console.log(`[EMAIL] Sending admin signup notification for: ${businessName}`);
  
  // Verify SendGrid is configured
  if (!SENDGRID_API_KEY || SENDGRID_API_KEY === "") {
    console.error(`[EMAIL] SendGrid API key not configured!`);
    return { success: false, error: "SendGrid API key not configured" };
  }
  
  try {
    const html = generateAdminSignupNotificationEmailHTML(
      businessName,
      ownerEmail,
      planName,
      planPrice,
      businessType,
      state,
      phone,
      abn,
      trialDays
    );
    
    const hasFreeTrial = trialDays && trialDays > 0;
    const subject = `🎉 New Salon Signup: ${businessName}${hasFreeTrial ? ` (${trialDays}-Day Trial)` : ''}`;
    
    const msg = {
      to: ADMIN_NOTIFICATION_EMAIL,
      from: ADMIN_FROM_EMAIL,
      subject: subject,
      html: html,
    };
    
    console.log(`[EMAIL] Sending admin notification email via SendGrid:`, {
      to: ADMIN_NOTIFICATION_EMAIL,
      from: ADMIN_FROM_EMAIL,
      subject: subject,
      businessName: businessName,
      ownerEmail: ownerEmail,
    });
    
    await sgMail.send(msg);
    
    console.log(`[EMAIL] ✅ Admin signup notification sent successfully for ${businessName}`);
    return { success: true };
  } catch (error: any) {
    console.error(`[EMAIL] ❌ Error sending admin signup notification:`, error);
    console.error(`[EMAIL] Error details:`, {
      message: error?.message,
      code: error?.code,
      response: error?.response?.body,
      statusCode: error?.response?.statusCode,
    });
    const errorMessage = error?.response?.body?.errors?.[0]?.message || error?.message || "Unknown error";
    return { success: false, error: errorMessage };
  }
}

/**
 * Send password reset email to user with 6-digit code
 */
export async function sendPasswordResetEmail(
  email: string,
  userName: string,
  resetCode: string
): Promise<{ success: boolean; error?: string }> {
  console.log(`[EMAIL] Attempting to send password reset email to: ${email}`);
  
  // Validate email
  if (!email || !email.trim()) {
    console.error(`[EMAIL] No email provided`);
    return { success: false, error: "No email provided" };
  }
  
  const emailAddress = email.trim().toLowerCase();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(emailAddress)) {
    console.error(`[EMAIL] Invalid email address: ${emailAddress}`);
    return { success: false, error: "Invalid email address" };
  }
  
  // Verify SendGrid is configured
  if (!SENDGRID_API_KEY || SENDGRID_API_KEY === "") {
    console.error(`[EMAIL] SendGrid API key not configured!`);
    return { success: false, error: "SendGrid API key not configured" };
  }
  
  try {
    const html = generatePasswordResetEmailHTML(userName, resetCode);
    const subject = `Reset Your Password - BMS PRO BLACK`;
    
    const msg = {
      to: emailAddress,
      from: ADMIN_FROM_EMAIL,
      subject: subject,
      html: html,
      trackingSettings: {
        clickTracking: {
          enable: false, // Disable click tracking so links go directly to destination
        },
      },
    };
    
    console.log(`[EMAIL] Sending password reset email via SendGrid:`, {
      to: emailAddress,
      from: ADMIN_FROM_EMAIL,
      subject: subject,
    });
    
    await sgMail.send(msg);
    
    console.log(`[EMAIL] ✅ Password reset email sent successfully to ${emailAddress}`);
    return { success: true };
  } catch (error: any) {
    console.error(`[EMAIL] ❌ Error sending password reset email to ${emailAddress}:`, error);
    console.error(`[EMAIL] Error details:`, {
      message: error?.message,
      code: error?.code,
      response: error?.response?.body,
      statusCode: error?.response?.statusCode,
    });
    const errorMessage = error?.response?.body?.errors?.[0]?.message || error?.message || "Unknown error";
    return { success: false, error: errorMessage };
  }
}
