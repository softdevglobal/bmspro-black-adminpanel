import sgMail from "@sendgrid/mail";
import { adminDb } from "./firebaseAdmin";
import { FieldValue } from "firebase-admin/firestore";
import type { BookingStatus } from "./bookingTypes";
import { VEHICLE_TYPE_LABELS, isVehicleType, type VehicleType } from "./services";
import { appendBookNowMyBookingsDeepLink } from "./customerAccount";

// Initialize SendGrid
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || "booking@bmspros.com.au";
const ADMIN_FROM_EMAIL = "noreply@bmspros.com.au"; // For admin/system emails

if (SENDGRID_API_KEY) {
  sgMail.setApiKey(SENDGRID_API_KEY);
}

/**
 * Get workshop name from ownerUid
 */
async function getWorkshopName(ownerUid: string): Promise<string> {
  try {
    const db = adminDb();
    const ownerDoc = await db.doc(`users/${ownerUid}`).get();
    if (ownerDoc.exists) {
      const data = ownerDoc.data();
      return data?.workshopName || data?.salonName || data?.name || data?.businessName || data?.displayName || "Workshop";
    }
  } catch (error) {
    console.error("Error fetching workshop name:", error);
  }
  return "Workshop";
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
  /** Canonical size class the booking was priced against (so the email can call out the tier). */
  vehicleType?: VehicleType | null;
  vehicleNumber?: string | null;
  vehicleMake?: string | null;
  vehicleModel?: string | null;
  services?: Array<{
    name?: string;
    staffName?: string | null;
    time?: string;
    duration?: number;
    price?: number;
    /** Per-line tier; falls back to booking-level `vehicleType` when rendering. */
    vehicleType?: VehicleType | null;
  }>;
  staffName?: string | null;
  ownerUid: string;
  salonName?: string;
  additionalIssues?: Array<{
    id?: string;
    issueTitle?: string;
    status?: string;
    price?: number | null;
    customerResponse?: string | null;
  }> | null;
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
  const workshopName = data.salonName || "Workshop";
  
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

  // Resolve the vehicle-type tier once — used both to label each service line
  // and to surface a "priced for …" chip in the vehicle block.
  const bookingVehicleType: VehicleType | null = isVehicleType(data.vehicleType)
    ? (data.vehicleType as VehicleType)
    : null;
  const vehicleTypeLabel = bookingVehicleType ? VEHICLE_TYPE_LABELS[bookingVehicleType] : null;

  // Build services list (includes per-line price + vehicle-type tier when available)
  let servicesList = "";
  if (data.services && data.services.length > 0) {
    const services = data.services;
    servicesList = "<table style='width: 100%; border-collapse: collapse; margin: 15px 0;'>";
    services.forEach((service, index) => {
      const serviceTime = service.time ? ` at ${service.time}` : "";
      const serviceDuration = service.duration ? ` (${formatDuration(service.duration)})` : "";
      const serviceHasStaff = service.staffName && !isAnyStaff(service.staffName);
      const staffInfo = serviceHasStaff ? ` with ${service.staffName}` : "";
      const borderBottom = index < services.length - 1 ? "border-bottom: 1px solid #e5e7eb;" : "";
      const hasPrice = typeof service.price === "number" && !Number.isNaN(service.price);
      const priceHtml = hasPrice
        ? `<td style='padding: 12px 0; color: #111827; font-size: 15px; font-weight: 600; text-align: right; white-space: nowrap;'>${formatPrice(service.price as number)}</td>`
        : "";
      const lineType: VehicleType | null = isVehicleType(service.vehicleType)
        ? (service.vehicleType as VehicleType)
        : bookingVehicleType;
      const tierNote = lineType
        ? `<div style='margin-top:4px;color:#b45309;font-size:12px;font-weight:500;'>Priced for ${VEHICLE_TYPE_LABELS[lineType]}</div>`
        : "";
      servicesList += `
        <tr style='${borderBottom}'>
          <td style='padding: 12px 0; color: #374151; font-size: 15px;'>
            <strong style='color: #111827;'>${service.name || "Service"}</strong>${serviceTime}${serviceDuration}${staffInfo}
            ${tierNote}
          </td>
          ${priceHtml}
        </tr>
      `;
    });
    servicesList += "</table>";
  } else if (data.serviceName) {
    const tierNote = vehicleTypeLabel
      ? `<div style='margin-top:4px;color:#b45309;font-size:12px;font-weight:500;'>Priced for ${vehicleTypeLabel}</div>`
      : "";
    servicesList = `<p style='margin: 12px 0; color: #374151; font-size: 15px;'><strong style='color: #111827;'>${data.serviceName}</strong>${tierNote}</p>`;
  }

  // Build vehicle summary block when we know anything about the vehicle.
  const vehicleTitle = [data.vehicleMake, data.vehicleModel].filter(Boolean).join(" ").trim();
  const hasVehicleInfo = !!(vehicleTitle || data.vehicleNumber || vehicleTypeLabel);
  const vehicleInfoHtml = hasVehicleInfo
    ? `
      <tr>
        <td colspan="2" style='padding: 0 0 8px 0;'>
          <div style='background-color:#fffbeb;border:1px solid #fcd34d;border-radius:8px;padding:12px 14px;'>
            <div style='color:#92400e;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;'>Vehicle</div>
            <div style='margin-top:4px;color:#111827;font-size:15px;font-weight:600;'>${vehicleTitle || "Vehicle"}</div>
            <div style='margin-top:6px;display:block;color:#78350f;font-size:13px;'>
              ${data.vehicleNumber ? `<span style='display:inline-block;margin-right:10px;'><strong>Rego:</strong> ${data.vehicleNumber}</span>` : ""}
              ${vehicleTypeLabel ? `<span style='display:inline-block;'><strong>Type:</strong> ${vehicleTypeLabel} <em style='color:#b45309;font-style:normal;'>(pricing class)</em></span>` : ""}
            </div>
          </div>
        </td>
      </tr>
    `
    : "";
  
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
  
  // For Completed status: show Services, Additional work (if any), then Total
  // Include all accepted additional work (admin approved + customer accepted)
  const acceptedAdditionalIssues = (data.additionalIssues || []).filter(
    (i: any) =>
      i.status === "approved" &&
      i.price != null &&
      (i.customerResponse === "accept" || i.customerResponse === "accepted")
  );
  const additionalWorkTotal = acceptedAdditionalIssues.reduce((sum: number, i: any) => sum + (Number(i.price) || 0), 0);
  const servicesListForPrice = data.services && data.services.length > 0 ? data.services : [];
  const servicesSubtotalFromServices = servicesListForPrice.reduce((sum: number, s: any) => sum + (Number(s.price) || 0), 0);
  const rawPrice = data.price != null && data.price !== undefined ? Number(data.price) : 0;
  const servicesSubtotal = servicesSubtotalFromServices > 0
    ? servicesSubtotalFromServices
    : rawPrice;
  const grandTotal = servicesSubtotal + additionalWorkTotal;
  const hasVisibleAdditionalIssues = acceptedAdditionalIssues.length > 0;
  const showPriceBreakdown = status === "Completed" && (grandTotal > 0 || hasVisibleAdditionalIssues);

  const priceInfo = grandTotal > 0 || hasVisibleAdditionalIssues || rawPrice > 0 ? (
    showPriceBreakdown ? `
    <tr>
      <td style='padding: 8px 0; color: #6b7280; font-size: 14px;'>Service Price</td>
      <td style='padding: 8px 0; color: #111827; font-size: 14px; font-weight: 500; text-align: right;'>${formatPrice(servicesSubtotal)}</td>
    </tr>
    ${hasVisibleAdditionalIssues ? `<tr>
      <td style='padding: 8px 0; color: #6b7280; font-size: 14px;'>Additional Work</td>
      <td style='padding: 8px 0; color: #111827; font-size: 14px; font-weight: 500; text-align: right;'>${formatPrice(additionalWorkTotal)}</td>
    </tr>` : ""}
    <tr>
      <td style='padding: 8px 0; color: #6b7280; font-size: 14px;'>Total</td>
      <td style='padding: 8px 0; color: #111827; font-size: 16px; font-weight: 600; text-align: right;'>${formatPrice(grandTotal)}</td>
    </tr>
  ` : `
    <tr>
      <td style='padding: 8px 0; color: #6b7280; font-size: 14px;'>Total Price</td>
      <td style='padding: 8px 0; color: #111827; font-size: 16px; font-weight: 600; text-align: right;'>${formatPrice(rawPrice || 0)}</td>
    </tr>
  `
  ) : "";
  
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
      subject = `Booking Request Received - ${workshopName}`;
      title = "Booking Request Received";
      message = `Thank you for your booking request! We have received your request and will confirm it shortly.`;
      icon = "📋";
      color = "#f59e0b";
      bgColor = "#fffbeb";
      break;
    case "Confirmed":
      subject = `Booking Confirmed - ${workshopName}`;
      title = "Booking Confirmed";
      message = `Great news! Your booking has been confirmed. We look forward to seeing you soon!`;
      icon = "✅";
      color = "#10b981";
      bgColor = "#ecfdf5";
      break;
    case "Completed":
      subject = `Booking Completed – Ready to Pick Up - ${workshopName}`;
      title = "Booking Completed – Ready to Pick Up";
      message = `Great news! Your booking at ${workshopName} has been completed and is ready for pick up. Please find the full job task report attached to this email. You can also download it from your customer portal at any time.`;
      icon = "✅";
      color = "#059669";
      bgColor = "#ecfdf5";
      break;
    case "Canceled":
      subject = `Booking Cancelled - ${workshopName}`;
      title = "Booking Cancelled";
      message = `Your booking has been cancelled. If you have any questions or would like to reschedule, please contact us.`;
      icon = "❌";
      color = "#ef4444";
      bgColor = "#fef2f2";
      break;
    default:
      subject = `Booking Update - ${workshopName}`;
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
          
          <!-- Workshop Header -->
          <tr>
            <td style="padding: 0; background: linear-gradient(135deg, ${color} 0%, ${color}dd 100%);">
              <!-- Workshop Name Bar -->
              <div style="padding: 20px 40px; background-color: rgba(0,0,0,0.1); text-align: center;">
                <h1 style="margin: 0; color: #ffffff; font-size: 20px; font-weight: 600; letter-spacing: 0.5px;">${workshopName}</h1>
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
                ${vehicleInfoHtml ? `<table style="width: 100%; border-collapse: collapse; margin-top: 16px;"><tbody>${vehicleInfoHtml}</tbody></table>` : ""}
                ${staffAssignmentMessage}
                
                ${servicesList ? `
                  <div style="margin-top: 20px; padding-top: 20px; border-top: 1px solid ${color}30;">
                    <p style="margin: 0 0 10px; color: #6b7280; font-size: 14px; font-weight: 500;">Services</p>
                    ${servicesList}
                  </div>
                ` : ""}
                ${status === "Completed" && acceptedAdditionalIssues.length > 0 ? `
                  <div style="margin-top: 20px; padding-top: 20px; border-top: 1px solid ${color}30;">
                    <p style="margin: 0 0 10px; color: #6b7280; font-size: 14px; font-weight: 500;">Additional Work</p>
                    ${acceptedAdditionalIssues.map((i: any) => {
                      const isAccepted = i.status === "approved" && i.price != null && i.customerResponse !== "reject" && i.customerResponse !== "rejected";
                      const priceStr = isAccepted && i.price != null ? formatPrice(Number(i.price)) : "Declined";
                      return `<div style="margin-bottom: 8px; padding: 10px 12px; background: ${isAccepted ? "#ecfdf5" : "#fef2f2"}; border-radius: 6px; display: flex; justify-content: space-between; align-items: center;">
                        <span style="color: #111827; font-size: 14px;">${(i.issueTitle || "Issue").replace(/</g, "&lt;")}</span>
                        <span style="color: ${isAccepted ? "#059669" : "#b91c1c"}; font-size: 14px; font-weight: 500;">${isAccepted ? priceStr : "Declined"}</span>
                      </div>`;
                    }).join("")}
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
              <p style="margin: 0 0 8px; color: #111827; font-size: 14px; font-weight: 600;">${workshopName}</p>
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
    // Fetch workshop name if not provided
    if (!data.salonName) {
      data.salonName = await getWorkshopName(data.ownerUid);
    }
    
    const html = generateEmailHTML(data.status, data);
    const workshopName = data.salonName || "Workshop";
    const statusSubjectMap: Record<string, string> = {
      Pending: "Booking Request Received",
      Confirmed: "Booking Confirmed",
      Completed: "Booking Completed – Ready to Pick Up",
      Canceled: "Booking Cancelled",
    };
    const statusLabel = statusSubjectMap[data.status] || `Booking ${data.status}`;
    const subject = data.bookingCode
      ? `${statusLabel} - ${workshopName} (${data.bookingCode})`
      : `${statusLabel} - ${workshopName}`;
    
    const msg: any = {
      to: email,
      from: FROM_EMAIL,
      subject: subject,
      html: html,
    };

    // Attach PDF for completed bookings - REQUIRED (email promises the attachment)
    if (data.status === "Completed" && data.bookingId) {
      try {
        const { generateBookingPDF } = await import("./pdfService");
        const { buffer, filename } = await generateBookingPDF(data.bookingId);
        if (!buffer || buffer.length === 0) {
          console.error(`[EMAIL] PDF generated but buffer is empty for booking ${data.bookingId}`);
          return { success: false, error: "PDF generation produced empty file" };
        }
        msg.attachments = [
          {
            content: buffer.toString("base64"),
            filename,
            type: "application/pdf",
            disposition: "attachment",
          },
        ];
        console.log(`[EMAIL] PDF attachment generated for booking ${data.bookingId}: ${filename} (${buffer.length} bytes)`);
      } catch (pdfError: any) {
        console.error(`[EMAIL] Failed to generate PDF attachment for booking ${data.bookingId}:`, pdfError);
        return {
          success: false,
          error: `PDF generation failed: ${pdfError?.message || String(pdfError)}. The job report could not be attached.`,
        };
      }
    }
    
    console.log(`[EMAIL] Sending email via SendGrid:`, {
      to: email,
      from: FROM_EMAIL,
      subject: subject,
      bookingId: data.bookingId,
      status: data.status,
      workshopName: workshopName,
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
  
  // Get workshop name
  const workshopName = await getWorkshopName(ownerUid);
  
  const result = await sendBookingEmail({
    bookingId,
    bookingCode: bookingCode || undefined,
    customerEmail,
    customerName,
    status: "Pending",
    ownerUid,
    salonName: workshopName,
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
    vehicleType?: VehicleType | null;
    vehicleNumber?: string | null;
    vehicleMake?: string | null;
    vehicleModel?: string | null;
    services?: Array<{
      name?: string;
      staffName?: string | null;
      time?: string;
      duration?: number;
      price?: number;
      vehicleType?: VehicleType | null;
    }>;
    staffName?: string | null;
    additionalIssues?: Array<{
      id?: string;
      issueTitle?: string;
      status?: string;
      price?: number | null;
      customerResponse?: string | null;
    }> | null;
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
  
  // Get workshop name
  const workshopName = await getWorkshopName(ownerUid);

  // Hydrate vehicle info from Firestore when the caller didn't pass it, so
  // every status-change email (Confirmed / Completed / Canceled) consistently
  // shows the vehicle and its pricing class without every call site having to
  // thread those fields through.
  let hydratedVehicleType: VehicleType | null = bookingData.vehicleType ?? null;
  let hydratedVehicleNumber: string | null = bookingData.vehicleNumber ?? null;
  let hydratedVehicleMake: string | null = bookingData.vehicleMake ?? null;
  let hydratedVehicleModel: string | null = bookingData.vehicleModel ?? null;
  let hydratedServices = bookingData.services;
  try {
    if (
      !hydratedVehicleType ||
      !hydratedVehicleNumber ||
      !hydratedVehicleMake ||
      !hydratedVehicleModel ||
      !Array.isArray(hydratedServices)
    ) {
      const snap = await adminDb().doc(`bookings/${bookingId}`).get();
      if (snap.exists) {
        const d = snap.data() as Record<string, unknown>;
        if (!hydratedVehicleType && isVehicleType(d.vehicleType)) {
          hydratedVehicleType = d.vehicleType as VehicleType;
        }
        if (!hydratedVehicleNumber && typeof d.vehicleNumber === "string") {
          hydratedVehicleNumber = d.vehicleNumber;
        }
        if (!hydratedVehicleMake && typeof d.vehicleMake === "string") {
          hydratedVehicleMake = d.vehicleMake;
        }
        if (!hydratedVehicleModel && typeof d.vehicleModel === "string") {
          hydratedVehicleModel = d.vehicleModel;
        }
        if (!Array.isArray(hydratedServices) && Array.isArray(d.services)) {
          hydratedServices = (d.services as Array<Record<string, unknown>>).map((s) => ({
            name: typeof s.name === "string" ? s.name : "Service",
            staffName: typeof s.staffName === "string" ? s.staffName : null,
            time: typeof s.time === "string" ? s.time : undefined,
            duration: typeof s.duration === "number" ? s.duration : undefined,
            price: typeof s.price === "number" ? s.price : undefined,
            vehicleType: isVehicleType(s.vehicleType) ? (s.vehicleType as VehicleType) : null,
          }));
        } else if (Array.isArray(hydratedServices) && Array.isArray(d.services)) {
          // Carry forward vehicleType / price from Firestore onto each line when
          // the caller supplied a stripped-down services array.
          const byName = new Map<string, Record<string, unknown>>();
          for (const s of d.services as Array<Record<string, unknown>>) {
            if (typeof s.name === "string") byName.set(s.name, s);
          }
          hydratedServices = hydratedServices.map((s) => {
            const match = byName.get(s.name || "");
            return {
              ...s,
              price:
                typeof s.price === "number"
                  ? s.price
                  : match && typeof match.price === "number"
                  ? (match.price as number)
                  : undefined,
              vehicleType:
                s.vehicleType ??
                (match && isVehicleType(match.vehicleType) ? (match.vehicleType as VehicleType) : null),
            };
          });
        }
      }
    }
  } catch (hydrateErr) {
    console.warn(`[EMAIL] Failed to hydrate vehicle/service info for booking ${bookingId}:`, hydrateErr);
  }

  const result = await sendBookingEmail({
    bookingId,
    bookingCode: bookingData.bookingCode || undefined,
    customerEmail,
    customerName,
    status: newStatus,
    ownerUid,
    salonName: workshopName,
    ...bookingData,
    vehicleType: hydratedVehicleType,
    vehicleNumber: hydratedVehicleNumber,
    vehicleMake: hydratedVehicleMake,
    vehicleModel: hydratedVehicleModel,
    services: hydratedServices,
  });
  
  if (!result.success) {
    console.error(`[EMAIL] Failed to send booking status change email:`, result.error);
  }
}

/**
 * Generate HTML for workshop owner welcome email with login credentials and optional payment link
 * If trialDays > 0, the account is active immediately without payment (card-free trial)
 */
function generateWelcomeEmailHTML(
  ownerEmail: string,
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
                <p style="margin: 15px 0 0; color: rgba(255,255,255,0.9); font-size: 16px;">Your workshop account has been created</p>
              </div>
            </td>
          </tr>
          
          <!-- Greeting -->
          <tr>
            <td style="padding: 30px 40px 20px;">
              <p style="margin: 0 0 15px; color: #374151; font-size: 16px; line-height: 1.6;">Hello,</p>
              <p style="margin: 0 0 25px; color: #374151; font-size: 16px; line-height: 1.6;">
                Your workshop <strong>${businessName}</strong> has been successfully onboarded to BMS PRO BLACK. ${hasFreeTrial ? `<strong>Your ${trialDays}-day free trial is now active!</strong> You can start using all features immediately - no payment required during your trial.` : (paymentUrl ? '<strong>To activate your account, please complete your subscription payment below.</strong>' : 'You can now access your workshop management dashboard using the login credentials below.')}
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
                    <td style='padding: 12px 0; color: #111827; font-size: 14px; font-weight: 500; text-align: right;'>${ownerEmail}</td>
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
                  <li style="margin-bottom: 10px;">Complete your workshop profile and settings</li>
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
 * Send welcome email to workshop owner with login credentials and optional payment link
 * If trialDays > 0, the email will reflect card-free trial activation
 */
export async function sendSalonOwnerWelcomeEmail(
  workshopOwnerEmail: string,
  password: string,
  businessName: string,
  planName?: string,
  planPrice?: string,
  paymentUrl?: string,
  trialDays?: number,
  bookingEngineUrl?: string
): Promise<{ success: boolean; error?: string }> {
  console.log(`[EMAIL] Attempting to send welcome email to workshop owner: ${workshopOwnerEmail}`);
  
  // Validate email
  if (!workshopOwnerEmail || !workshopOwnerEmail.trim()) {
    console.error(`[EMAIL] No workshop owner email provided`);
    return { success: false, error: "No workshop owner email provided" };
  }
  
  const email = workshopOwnerEmail.trim().toLowerCase();
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
  role: string, // 'staff' or 'branch_admin'
  workshopName?: string,
  branchName?: string
): string {
  const isBranchAdmin = role === 'branch_admin';
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
                ${workshopName ? `You have been added as a <strong>${roleDisplayName}</strong> to <strong>${workshopName}</strong>.` : `You have been added as a <strong>${roleDisplayName}</strong>.`}
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
                  If you have any questions or need assistance, please contact your workshop administrator.
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
  role: string, // 'staff' or 'branch_admin'
  workshopName?: string,
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
    const html = generateStaffWelcomeEmailHTML(email, password, staffName, role, workshopName, branchName);
    const roleDisplayName = role === 'branch_admin' ? 'Branch Administrator' : 'Staff Member';
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
      workshopName: workshopName,
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
 * Generate HTML for the customer welcome email sent when a customer account is
 * auto-created as part of a booking (by an Admin, Owner, or Staff member).
 * Contains login link to the Booking Engine, username (email) and the default
 * password along with a prompt to change it after the first login.
 */
function generateCustomerWelcomeEmailHTML(params: {
  customerEmail: string;
  password: string;
  customerName: string;
  workshopName: string;
  bookingEngineUrl: string;
}): string {
  const { customerEmail, password, customerName, workshopName, bookingEngineUrl } = params;
  const greetingName = customerName?.trim() || "there";

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Your ${workshopName} Booking Account</title>
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
                <h1 style="margin: 0; color: #ffffff; font-size: 26px; font-weight: 700; letter-spacing: -0.3px;">Welcome to ${workshopName}</h1>
                <p style="margin: 15px 0 0; color: rgba(255,255,255,0.9); font-size: 16px;">Your booking account has been created</p>
              </div>
            </td>
          </tr>

          <!-- Greeting -->
          <tr>
            <td style="padding: 30px 40px 20px;">
              <p style="margin: 0 0 15px; color: #374151; font-size: 16px; line-height: 1.6;">Hello ${greetingName},</p>
              <p style="margin: 0 0 25px; color: #374151; font-size: 16px; line-height: 1.6;">
                A booking has just been created for you at <strong>${workshopName}</strong>. To make it easy for you to view your bookings and book future services yourself, we've also set up an account on our online Booking Engine — no sign-up required.
              </p>
            </td>
          </tr>

          <!-- Login Credentials Card -->
          <tr>
            <td style="padding: 0 40px 30px;">
              <div style="background-color: #fef3c7; border: 2px solid #f59e0b; border-radius: 10px; padding: 25px; margin-bottom: 20px;">
                <h3 style="margin: 0 0 20px; color: #78350f; font-size: 18px; font-weight: 600;">
                  <span style="display: inline-block; width: 4px; height: 20px; background-color: #f59e0b; border-radius: 2px; margin-right: 10px; vertical-align: middle;"></span>
                  Your Login Details
                </h3>

                <table style="width: 100%; border-collapse: collapse;">
                  <tr>
                    <td style='padding: 12px 0; color: #78350f; font-size: 14px; font-weight: 600;'>Username (Email):</td>
                    <td style='padding: 12px 0; color: #111827; font-size: 14px; font-weight: 500; text-align: right; word-break: break-all;'>${customerEmail}</td>
                  </tr>
                  <tr>
                    <td style='padding: 12px 0; color: #78350f; font-size: 14px; font-weight: 600;'>Default Password:</td>
                    <td style='padding: 12px 0; color: #111827; font-size: 16px; font-weight: 700; text-align: right; font-family: monospace; letter-spacing: 2px;'>${password}</td>
                  </tr>
                </table>

                <div style="background-color: #fff7ed; border-left: 3px solid #f59e0b; padding: 12px 16px; border-radius: 6px; margin-top: 20px;">
                  <p style='margin: 0; color: #92400e; font-size: 13px; line-height: 1.6;'>
                    <strong style='color: #78350f;'>⚠️ Important:</strong> This is a default password. For your security, please change it immediately after your first login.
                  </p>
                </div>
              </div>
            </td>
          </tr>

          <!-- Login Button -->
          <tr>
            <td style="padding: 0 40px 30px; text-align: center;">
              <a href="${bookingEngineUrl}" style="display: inline-block; padding: 14px 32px; background: linear-gradient(135deg, #ec4899 0%, #8b5cf6 100%); color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; box-shadow: 0 4px 6px rgba(236, 72, 153, 0.3);">
                Log in to Booking Engine
              </a>
              <p style="margin: 15px 0 0; color: #6b7280; font-size: 12px; word-break: break-all;">
                <a href="${bookingEngineUrl}" style="color: #7c3aed; text-decoration: underline;">${bookingEngineUrl}</a>
              </p>
            </td>
          </tr>

          <!-- What You Can Do -->
          <tr>
            <td style="padding: 0 40px 30px;">
              <div style="background-color: #eef2ff; border: 2px solid #6366f1; border-radius: 10px; padding: 25px;">
                <h3 style="margin: 0 0 15px; color: #312e81; font-size: 18px; font-weight: 600;">
                  <span style="display: inline-block; width: 4px; height: 20px; background-color: #6366f1; border-radius: 2px; margin-right: 10px; vertical-align: middle;"></span>
                  What you can do next
                </h3>
                <ol style="margin: 0; padding-left: 20px; color: #374151; font-size: 15px; line-height: 1.8;">
                  <li style="margin-bottom: 8px;">Log in with the credentials above</li>
                  <li style="margin-bottom: 8px;"><strong>Change your default password</strong> from your account settings</li>
                  <li style="margin-bottom: 8px;">View your current and past bookings</li>
                  <li>Book future services online 24/7</li>
                </ol>
              </div>
            </td>
          </tr>

          <!-- Additional Info -->
          <tr>
            <td style="padding: 0 40px 30px;">
              <div style="background-color: #f9fafb; border-radius: 8px; padding: 20px; text-align: center;">
                <p style="margin: 0; color: #6b7280; font-size: 14px; line-height: 1.6;">
                  You'll receive a separate email shortly confirming your upcoming booking details. If you did not request this, please contact ${workshopName} directly.
                </p>
              </div>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding: 25px 40px; background-color: #f9fafb; border-top: 1px solid #e5e7eb; text-align: center;">
              <p style="margin: 0 0 8px; color: #111827; font-size: 14px; font-weight: 600;">${workshopName}</p>
              <p style="margin: 0; color: #6b7280; font-size: 12px; line-height: 1.5;">
                Powered by BMS PRO BLACK.<br>
                This is an automated email — please do not reply.
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
 * Send welcome email to a customer whose account was auto-created while a
 * booking was being made on their behalf. Provides the Booking Engine login
 * URL, the customer's email (username) and the default password.
 */
export async function sendCustomerWelcomeEmail(params: {
  customerEmail: string;
  password: string;
  customerName: string;
  workshopName?: string;
  bookingEngineUrl: string;
}): Promise<{ success: boolean; error?: string }> {
  const { customerEmail, password, customerName } = params;
  const workshopName = params.workshopName?.trim() || "Workshop";
  const bookingEngineUrl = params.bookingEngineUrl?.trim() ||
    process.env.NEXT_PUBLIC_APP_URL ||
    "https://black.bmspros.com.au";

  console.log(`[EMAIL] Attempting to send customer welcome email to: ${customerEmail}`);

  if (!customerEmail || !customerEmail.trim()) {
    console.error(`[EMAIL] No customer email provided for welcome email`);
    return { success: false, error: "No customer email provided" };
  }

  const email = customerEmail.trim().toLowerCase();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    console.error(`[EMAIL] Invalid customer email address: ${email}`);
    return { success: false, error: "Invalid email address" };
  }

  if (!SENDGRID_API_KEY || SENDGRID_API_KEY === "") {
    console.error(`[EMAIL] SendGrid API key not configured — cannot send customer welcome email`);
    return { success: false, error: "SendGrid API key not configured" };
  }

  try {
    const html = generateCustomerWelcomeEmailHTML({
      customerEmail: email,
      password,
      customerName,
      workshopName,
      bookingEngineUrl,
    });

    const subject = `Welcome to ${workshopName} - Your Booking Account Details`;

    const msg = {
      to: email,
      from: FROM_EMAIL,
      subject,
      html,
      trackingSettings: {
        clickTracking: {
          enable: false,
        },
      },
    };

    console.log(`[EMAIL] Sending customer welcome email via SendGrid:`, {
      to: email,
      from: FROM_EMAIL,
      subject,
      workshopName,
      bookingEngineUrl,
      clickTracking: false,
    });

    await sgMail.send(msg);

    console.log(`[EMAIL] ✅ Customer welcome email sent successfully to ${email}`);
    return { success: true };
  } catch (error: any) {
    console.error(`[EMAIL] ❌ Error sending customer welcome email to ${email}:`, error);
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
  workshopName?: string
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
                ${workshopName ? `You have been assigned as the <strong>Branch Administrator</strong> for the <strong>${branchName}</strong> branch at <strong>${workshopName}</strong>.` : `You have been assigned as the <strong>Branch Administrator</strong> for the <strong>${branchName}</strong> branch.`}
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
                  If you have any questions about your new role, please contact your workshop administrator.
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
  workshopName?: string
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
    const html = generateBranchAdminAssignmentEmailHTML(staffName, branchName, workshopName);
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
      workshopName: workshopName,
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
  <title>New Workshop Signup - BMS PRO BLACK</title>
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
                <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 700; letter-spacing: -0.3px;">New Workshop Signup!</h1>
                <p style="margin: 15px 0 0; color: rgba(255,255,255,0.9); font-size: 16px;">A new business has joined BMS PRO BLACK</p>
              </div>
            </td>
          </tr>
          
          <!-- Main Content -->
          <tr>
            <td style="padding: 30px 40px 20px;">
              <p style="margin: 0 0 25px; color: #374151; font-size: 16px; line-height: 1.6;">
                A new workshop has signed up for BMS PRO BLACK. Here are the details:
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
 * Send email to customer when admin sets price for an additional issue (quote ready for approval)
 */
export async function sendAdditionalIssuePriceSetEmail(data: {
  to: string;
  customerName: string;
  issueTitle: string;
  price: number;
  bookingCode?: string | null;
  workshopName?: string;
  viewUrl?: string;
  imageUrl?: string | null;
}): Promise<{ success: boolean; error?: string }> {
  const email = data.to?.trim()?.toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { success: false, error: "Invalid email address" };
  }
  if (!SENDGRID_API_KEY || SENDGRID_API_KEY === "") {
    console.error(`[EMAIL] SendGrid API key not configured!`);
    return { success: false, error: "SendGrid API key not configured" };
  }
  try {
    const viewUrl = appendBookNowMyBookingsDeepLink(
      data.viewUrl?.trim() ||
        process.env.NEXT_PUBLIC_APP_URL ||
        "https://black.bmspros.com.au",
    );
    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f3f4f6;">
  <table role="presentation" style="width: 100%; border-collapse: collapse; background-color: #f3f4f6;">
    <tr><td style="padding: 40px 20px;">
      <table role="presentation" style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); overflow: hidden;">
        <tr>
          <td style="padding: 0; background: linear-gradient(135deg, #f59e0b 0%, #ea580c 100%);">
            <div style="padding: 30px; text-align: center;">
              <div style="font-size: 48px; margin-bottom: 10px;">🔧</div>
              <h1 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 700;">Additional Work Quote Ready</h1>
              <p style="margin: 10px 0 0; color: rgba(255,255,255,0.9); font-size: 14px;">Your mechanic found extra work needed</p>
            </div>
          </td>
        </tr>
        <tr>
          <td style="padding: 30px 40px;">
            <p style="margin: 0 0 15px; color: #374151; font-size: 16px;">Hello ${data.customerName || "there"},</p>
            <p style="margin: 0 0 20px; color: #374151; font-size: 16px;">During your service, our technician identified additional work that may be needed. We've prepared a quote for your approval.</p>
            <div style="background: #fef3c7; border: 2px solid #f59e0b; border-radius: 10px; padding: 20px; margin-bottom: 20px;">
              <h3 style="margin: 0 0 12px; color: #92400e; font-size: 18px;">${data.issueTitle}</h3>
              <p style="margin: 0; color: #374151; font-size: 20px; font-weight: 700;">Cost: $${data.price.toFixed(2)}</p>
              ${data.bookingCode ? `<p style="margin: 8px 0 0; color: #6b7280; font-size: 14px;">Booking: ${data.bookingCode}</p>` : ""}
              ${data.imageUrl && data.imageUrl.trim() ? `<p style="margin: 12px 0 0; color: #6b7280; font-size: 12px; font-weight: 600;">Photo of the issue:</p><a href="${data.imageUrl}" target="_blank" style="display: inline-block; margin-top: 8px;"><img src="${data.imageUrl}" alt="Issue photo" width="240" style="max-width: 100%; height: auto; border-radius: 8px; border: 1px solid #e5e7eb;" /></a>` : ""}
            </div>
            <p style="margin: 0 0 12px; color: #6b7280; font-size: 14px;">Please review and approve or decline this additional work.</p>
            <div style="background: #f9fafb; border-radius: 8px; padding: 16px; margin-bottom: 20px; border: 1px solid #e5e7eb;">
              <p style="margin: 0 0 8px; color: #374151; font-size: 14px; font-weight: 600;">How to accept or reject:</p>
              <ol style="margin: 0; padding-left: 20px; color: #4b5563; font-size: 14px; line-height: 1.6;">
                <li>Click the button below to open your booking page.</li>
                <li>Find the additional work quote (${data.issueTitle}) in your booking details.</li>
                <li>Click <strong>Accept</strong> (✓) to approve the work, or <strong>Decline</strong> (✗) to reject it.</li>
              </ol>
            </div>
            <a href="${viewUrl}" style="display: inline-block; padding: 12px 24px; background: linear-gradient(135deg, #f59e0b 0%, #ea580c 100%); color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 600;">View & Approve / Decline</a>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
    const msg = { to: email, from: ADMIN_FROM_EMAIL, subject: `Additional Work Quote: ${data.issueTitle} - $${data.price.toFixed(2)}`, html };
    await sgMail.send(msg);
    console.log(`[EMAIL] ✅ Additional issue price-set email sent to ${email}`);
    return { success: true };
  } catch (error: any) {
    console.error(`[EMAIL] ❌ Error sending additional issue price-set email:`, error);
    return { success: false, error: error?.message || "Unknown error" };
  }
}

/**
 * Send email to owner/branch admin when technician reports an additional issue
 */
export async function sendAdditionalIssueNotificationEmail(data: {
  to: string;
  recipientName?: string;
  staffName: string;
  issueTitle: string;
  description?: string;
  recommendedRepair?: string;
  partsRequired?: string;
  labourTimeHours?: number;
  clientName: string;
  bookingCode?: string | null;
  branchName?: string | null;
  bookingDate?: string | null;
  bookingTime?: string | null;
}): Promise<{ success: boolean; error?: string }> {
  const email = data.to?.trim()?.toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { success: false, error: "Invalid email address" };
  }
  if (!SENDGRID_API_KEY || SENDGRID_API_KEY === "") {
    console.error(`[EMAIL] SendGrid API key not configured!`);
    return { success: false, error: "SendGrid API key not configured" };
  }
  try {
    const loginUrl = process.env.NEXT_PUBLIC_APP_URL || "https://black.bmspros.com.au";
    const details: string[] = [];
    if (data.description) details.push(`<p style="margin: 0 0 8px; color: #4b5563; font-size: 14px;"><strong>Description:</strong> ${data.description}</p>`);
    if (data.recommendedRepair) details.push(`<p style="margin: 0 0 8px; color: #4b5563; font-size: 14px;"><strong>Recommended Repair:</strong> ${data.recommendedRepair}</p>`);
    if (data.partsRequired) details.push(`<p style="margin: 0 0 8px; color: #4b5563; font-size: 14px;"><strong>Parts Required:</strong> ${data.partsRequired}</p>`);
    if (data.labourTimeHours != null) details.push(`<p style="margin: 0 0 8px; color: #4b5563; font-size: 14px;"><strong>Labour Time:</strong> ${data.labourTimeHours} hrs</p>`);
    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f3f4f6;">
  <table role="presentation" style="width: 100%; border-collapse: collapse; background-color: #f3f4f6;">
    <tr><td style="padding: 40px 20px;">
      <table role="presentation" style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); overflow: hidden;">
        <tr>
          <td style="padding: 0; background: linear-gradient(135deg, #f59e0b 0%, #ea580c 100%);">
            <div style="padding: 30px; text-align: center;">
              <div style="font-size: 48px; margin-bottom: 10px;">⚠️</div>
              <h1 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 700;">Additional Issue Reported</h1>
              <p style="margin: 10px 0 0; color: rgba(255,255,255,0.9); font-size: 14px;">Technician found extra work needed</p>
            </div>
          </td>
        </tr>
        <tr>
          <td style="padding: 30px 40px;">
            <p style="margin: 0 0 15px; color: #374151; font-size: 16px;">Hello ${data.recipientName || "there"},</p>
            <p style="margin: 0 0 20px; color: #374151; font-size: 16px;">${data.staffName} has reported an additional issue during the service for <strong>${data.clientName}</strong>${data.bookingCode ? ` (${data.bookingCode})` : ""}.</p>
            <div style="background: #fef3c7; border: 2px solid #f59e0b; border-radius: 10px; padding: 20px; margin-bottom: 20px;">
              <h3 style="margin: 0 0 12px; color: #92400e; font-size: 18px;">${data.issueTitle}</h3>
              ${details.join("")}
            </div>
            <p style="margin: 0 0 20px; color: #6b7280; font-size: 14px;">${data.branchName ? `Branch: ${data.branchName}` : ""}${data.bookingDate ? ` • ${data.bookingDate}${data.bookingTime ? ` at ${data.bookingTime}` : ""}` : ""}</p>
            <a href="${loginUrl}" style="display: inline-block; padding: 12px 24px; background: linear-gradient(135deg, #f59e0b 0%, #ea580c 100%); color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 600;">View Booking & Set Price</a>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
    const msg = { to: email, from: ADMIN_FROM_EMAIL, subject: `⚠️ Additional Issue: ${data.issueTitle} (${data.clientName})`, html };
    await sgMail.send(msg);
    console.log(`[EMAIL] ✅ Additional issue notification sent to ${email}`);
    return { success: true };
  } catch (error: any) {
    console.error(`[EMAIL] ❌ Error sending additional issue email:`, error);
    return { success: false, error: error?.message || "Unknown error" };
  }
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
    const subject = `🎉 New Workshop Signup: ${businessName}${hasFreeTrial ? ` (${trialDays}-Day Trial)` : ''}`;
    
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
 * Generate HTML for customer booking engine password reset email
 */
function generateCustomerPasswordResetEmailHTML(
  userName: string,
  resetCode: string,
  workshopName: string
): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Reset Your Password - ${workshopName}</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f3f4f6;">
  <table role="presentation" style="width: 100%; border-collapse: collapse; background-color: #f3f4f6;">
    <tr>
      <td style="padding: 40px 20px;">
        <table role="presentation" style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); overflow: hidden;">
          <tr>
            <td style="padding: 0; background: linear-gradient(135deg, #f59e0b 0%, #ea580c 100%);">
              <div style="padding: 30px; text-align: center;">
                <div style="font-size: 48px; margin-bottom: 10px;">🔐</div>
                <h1 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 700;">Reset Your Password</h1>
                <p style="margin: 10px 0 0; color: rgba(255,255,255,0.9); font-size: 14px;">${workshopName}</p>
              </div>
            </td>
          </tr>
          <tr>
            <td style="padding: 30px 40px 20px;">
              <p style="margin: 0 0 15px; color: #374151; font-size: 16px; line-height: 1.6;">Hello ${userName},</p>
              <p style="margin: 0 0 25px; color: #374151; font-size: 16px; line-height: 1.6;">
                We received a request to reset your password for ${workshopName}. Use the 6-digit code below when prompted on the booking page.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding: 0 40px 30px; text-align: center;">
              <div style="background: linear-gradient(135deg, #fef3c7 0%, #fef9e7 100%); border: 2px solid #f59e0b; border-radius: 16px; padding: 25px;">
                <p style="margin: 0 0 10px; color: #78350f; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px;">Your Verification Code</p>
                <div style="font-size: 42px; font-weight: 700; letter-spacing: 8px; color: #92400e; font-family: monospace;">${resetCode}</div>
                <p style="margin: 15px 0 0; color: #92400e; font-size: 13px;">Enter this code on the sign-in page to reset your password</p>
              </div>
            </td>
          </tr>
          <tr>
            <td style="padding: 0 40px 30px;">
              <div style="background-color: #fff7ed; border-left: 3px solid #f59e0b; padding: 12px 16px; border-radius: 6px;">
                <p style="margin: 0; color: #92400e; font-size: 13px; line-height: 1.6;">
                  <strong>Important:</strong> This code expires in 15 minutes. If you didn't request this, you can safely ignore this email.
                </p>
              </div>
            </td>
          </tr>
          <tr>
            <td style="padding: 25px 40px; background-color: #f9fafb; border-top: 1px solid #e5e7eb; text-align: center;">
              <p style="margin: 0; color: #6b7280; font-size: 12px;">This is an automated email from ${workshopName}.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`.trim();
}

/**
 * Send password reset email to booking engine customer with 6-digit code
 */
export async function sendCustomerPasswordResetEmail(
  email: string,
  userName: string,
  resetCode: string,
  workshopName: string
): Promise<{ success: boolean; error?: string }> {
  if (!SENDGRID_API_KEY || SENDGRID_API_KEY === "") {
    return { success: false, error: "SendGrid not configured" };
  }
  try {
    const html = generateCustomerPasswordResetEmailHTML(userName, resetCode, workshopName);
    const msg = {
      to: email.trim().toLowerCase(),
      from: FROM_EMAIL,
      subject: `Reset Your Password - ${workshopName}`,
      html,
    };
    await sgMail.send(msg);
    return { success: true };
  } catch (error: any) {
    console.error("[EMAIL] Customer password reset send failed:", error);
    return { success: false, error: error?.message || "Failed to send email" };
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

/**
 * Send estimate request notification email to salon/workshop owner
 */
export async function sendEstimateRequestEmail(
  ownerUid: string,
  estimateData: {
    customerName: string;
    customerPhone: string;
    customerEmail: string;
    vehicleMake?: string;
    vehicleModel?: string;
    vehicleYear?: string;
    rego?: string;
    mileage?: string;
    description: string;
    branchName?: string | null;
    imageUrls?: string[];
  }
): Promise<{ success: boolean; error?: string }> {
  try {
    const db = adminDb();
    const ownerDoc = await db.collection("users").doc(ownerUid).get();
    if (!ownerDoc.exists) {
      return { success: false, error: "Owner not found" };
    }
    const ownerData = ownerDoc.data();
    const ownerEmail = ownerData?.email || ownerData?.workEmail || ownerData?.ownerEmail;
    const salonName = ownerData?.workshopName || ownerData?.displayName || ownerData?.name || "Workshop";

    if (!ownerEmail?.trim()) {
      console.warn(`[EMAIL] Owner ${ownerUid} has no email in users collection (fields: email, workEmail, ownerEmail)`);
      return { success: false, error: "Owner email not found" };
    }

    if (!SENDGRID_API_KEY) {
      return { success: false, error: "SendGrid API key not configured" };
    }

    const vehicleInfo = [estimateData.vehicleYear, estimateData.vehicleMake, estimateData.vehicleModel]
      .filter(Boolean).join(" ");

    const customerImagesHtml = estimateData.imageUrls && estimateData.imageUrls.length > 0
      ? `<tr><td colspan="2" style="padding:16px 0;border-top:1px solid #f4f4f5;">
          <p style="margin:0 0 12px;font-size:11px;color:#a3a3a3;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;">Customer Photos (${estimateData.imageUrls.length})</p>
          ${estimateData.imageUrls.map(url => `<a href="${url}" target="_blank" style="display:inline-block;margin:0 8px 8px 0;text-decoration:none;"><img src="${url}" alt="Customer photo" width="180" style="width:180px;height:auto;border-radius:8px;border:1px solid #e5e5e5;display:block;" /></a>`).join("")}
        </td></tr>`
      : "";

    const html = `
<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:32px 16px;">
<tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
  <tr><td style="background:#171717;padding:28px 32px;">
    <h1 style="margin:0;color:#ffffff;font-size:20px;font-weight:700;">New Estimate Request</h1>
    <p style="margin:6px 0 0;color:#a3a3a3;font-size:13px;">A customer has requested an estimate${estimateData.branchName ? ` at ${estimateData.branchName}` : ""}.</p>
  </td></tr>
  <tr><td style="padding:28px 32px;">
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr><td colspan="2" style="padding-bottom:16px;border-bottom:1px solid #f4f4f5;">
        <p style="margin:0 0 2px;font-size:11px;color:#a3a3a3;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;">Customer</p>
        <p style="margin:0;font-size:16px;color:#171717;font-weight:700;">${estimateData.customerName}</p>
        <p style="margin:4px 0 0;font-size:13px;color:#525252;">${estimateData.customerPhone} &nbsp;|&nbsp; ${estimateData.customerEmail}</p>
      </td></tr>
      ${vehicleInfo || estimateData.rego || estimateData.mileage ? `
      <tr><td colspan="2" style="padding:16px 0;border-bottom:1px solid #f4f4f5;">
        <p style="margin:0 0 2px;font-size:11px;color:#a3a3a3;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;">Vehicle</p>
        <p style="margin:0;font-size:14px;color:#171717;font-weight:600;">${vehicleInfo || "-"}</p>
        ${estimateData.rego ? `<p style="margin:4px 0 0;font-size:13px;color:#525252;">Registration Number: ${estimateData.rego}</p>` : ""}
        ${estimateData.mileage ? `<p style="margin:4px 0 0;font-size:13px;color:#525252;">Mileage: ${estimateData.mileage}</p>` : ""}
      </td></tr>` : ""}
      <tr><td colspan="2" style="padding:16px 0;">
        <p style="margin:0 0 2px;font-size:11px;color:#a3a3a3;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;">Description</p>
        <p style="margin:0;font-size:14px;color:#171717;line-height:1.6;white-space:pre-wrap;">${estimateData.description}</p>
      </td></tr>
      ${customerImagesHtml}
    </table>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:20px;">
      <tr>
        <td align="center" style="padding:14px 24px;background:#171717;border-radius:12px;">
          <a href="mailto:${estimateData.customerEmail}" style="color:#ffffff;font-size:14px;font-weight:700;text-decoration:none;">Reply to Customer</a>
        </td>
      </tr>
    </table>
  </td></tr>
  <tr><td style="padding:20px 32px;background:#fafafa;border-top:1px solid #f4f4f5;">
    <p style="margin:0;font-size:11px;color:#a3a3a3;text-align:center;">This estimate request was submitted via your ${salonName} online booking page.<br/>Powered by <strong>BMS PRO</strong></p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;

    const msg = {
      to: ownerEmail,
      from: FROM_EMAIL,
      subject: `New Estimate Request from ${estimateData.customerName} — ${salonName}`,
      html,
    };

    console.log(`[EMAIL] Sending estimate request email to owner: ${ownerEmail}`);
    await sgMail.send(msg);
    console.log(`[EMAIL] ✅ Estimate request email sent to ${ownerEmail}`);
    return { success: true };
  } catch (error: any) {
    console.error(`[EMAIL] ❌ Error sending estimate request email:`, error);
    return { success: false, error: error?.message || "Unknown error" };
  }
}

/**
 * Send estimate reply notification email to customer
 */
export async function sendEstimateReplyEmail(data: {
  customerEmail: string;
  customerName: string;
  workshopName?: string;
  salonName?: string;
  message: string;
  imageUrls?: string[];
  vehicleInfo?: string;
  rego?: string;
}): Promise<{ success: boolean; error?: string }> {
  try {
    if (!data.customerEmail?.trim()) {
      return { success: false, error: "No customer email" };
    }

    if (!SENDGRID_API_KEY) {
      return { success: false, error: "SendGrid API key not configured" };
    }

    const businessName = data.workshopName ?? data.salonName ?? "Workshop";

    const imagesHtml = data.imageUrls && data.imageUrls.length > 0
      ? `<tr><td colspan="2" style="padding:16px 0;border-top:1px solid #f4f4f5;">
          <p style="margin:0 0 12px;font-size:11px;color:#a3a3a3;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;">Attached Images</p>
          ${data.imageUrls.map(url => `<a href="${url}" target="_blank" style="display:inline-block;margin:0 8px 8px 0;text-decoration:none;"><img src="${url}" alt="Attachment" width="180" style="width:180px;height:auto;border-radius:8px;border:1px solid #e5e5e5;display:block;" /></a>`).join("")}
        </td></tr>`
      : "";

    const html = `
<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:32px 16px;">
<tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
  <tr><td style="background:#171717;padding:28px 32px;">
    <h1 style="margin:0;color:#ffffff;font-size:20px;font-weight:700;">Reply to Your Estimate</h1>
    <p style="margin:6px 0 0;color:#a3a3a3;font-size:13px;">${businessName} has responded to your estimate request.</p>
  </td></tr>
  <tr><td style="padding:28px 32px;">
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr><td colspan="2" style="padding-bottom:16px;">
        <p style="margin:0 0 2px;font-size:11px;color:#a3a3a3;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;">Message from ${businessName}</p>
        <div style="margin-top:10px;padding:16px;background:#f9fafb;border:1px solid #f4f4f5;border-radius:12px;">
          <p style="margin:0;font-size:14px;color:#171717;line-height:1.7;white-space:pre-wrap;">${data.message}</p>
        </div>
      </td></tr>
      ${imagesHtml}
      ${data.vehicleInfo ? `
      <tr><td colspan="2" style="padding:12px 0 0;border-top:1px solid #f4f4f5;">
        <p style="margin:0;font-size:11px;color:#a3a3a3;"><strong>Vehicle:</strong> ${data.vehicleInfo}${data.rego ? ` (Reg: ${data.rego})` : ""}</p>
      </td></tr>` : ""}
    </table>
  </td></tr>
  <tr><td style="padding:20px 32px;background:#fafafa;border-top:1px solid #f4f4f5;">
    <p style="margin:0;font-size:11px;color:#a3a3a3;text-align:center;">This reply was sent from ${businessName}.<br/>Powered by <strong>BMS PRO</strong></p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;

    const msg = {
      to: data.customerEmail.trim().toLowerCase(),
      from: FROM_EMAIL,
      subject: `${businessName} replied to your estimate request`,
      html,
    };

    console.log(`[EMAIL] Sending estimate reply email to customer: ${data.customerEmail}`);
    await sgMail.send(msg);
    console.log(`[EMAIL] ✅ Estimate reply email sent to ${data.customerEmail}`);
    return { success: true };
  } catch (error: any) {
    console.error(`[EMAIL] ❌ Error sending estimate reply email:`, error);
    return { success: false, error: error?.message || "Unknown error" };
  }
}

/**
 * Send email to the customer when an admin/owner reschedules the booking.
 * Unlike status-change emails, this does NOT check/write the hasEmailBeenSent
 * dedupe record because a booking can be rescheduled multiple times and every
 * reschedule should trigger a fresh notification.
 */
export async function sendBookingRescheduledEmail(data: {
  bookingId: string;
  bookingCode?: string | null;
  customerEmail: string | null | undefined;
  customerName?: string | null;
  ownerUid: string;
  branchName?: string | null;
  previousDate?: string | null;
  previousTime?: string | null;
  previousPickupTime?: string | null;
  newDate: string;
  newTime: string;
  newPickupTime?: string | null;
  reason?: string | null;
  serviceName?: string | null;
  services?: Array<{
    name?: string;
    staffName?: string | null;
    time?: string;
    duration?: number;
    price?: number;
  }>;
  staffName?: string | null;
  duration?: number | null;
  price?: number | null;
}): Promise<{ success: boolean; error?: string }> {
  const email = data.customerEmail?.trim()?.toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.log(`[EMAIL] sendBookingRescheduledEmail: invalid/missing email for booking ${data.bookingId}`);
    return { success: false, error: "Invalid or missing customer email" };
  }
  if (!SENDGRID_API_KEY || SENDGRID_API_KEY === "") {
    console.error(`[EMAIL] SendGrid API key not configured!`);
    return { success: false, error: "SendGrid API key not configured" };
  }

  try {
    const workshopName = (await getWorkshopName(data.ownerUid)) || "Workshop";
    const customerName = (data.customerName || "there").trim();

    const fmtDate = (s?: string | null) => {
      if (!s) return "";
      try {
        const d = new Date(s);
        if (isNaN(d.getTime())) return s;
        return d.toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
      } catch {
        return s;
      }
    };

    const prevLine =
      data.previousDate || data.previousTime
        ? `${fmtDate(data.previousDate)}${data.previousTime ? ` · Drop-off ${data.previousTime}` : ""}${data.previousPickupTime ? ` · Pick-up ${data.previousPickupTime}` : ""}`
        : "";
    const newLine = `${fmtDate(data.newDate)} · Drop-off ${data.newTime}${data.newPickupTime ? ` · Pick-up ${data.newPickupTime}` : ""}`;

    const servicesHtml = Array.isArray(data.services) && data.services.length > 0
      ? `
        <div style="margin-top:18px;padding:14px 16px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;">
          <p style="margin:0 0 8px;color:#111827;font-size:13px;font-weight:600;">Services</p>
          ${data.services
            .map(
              (s) =>
                `<p style="margin:2px 0;color:#374151;font-size:13px;">• ${s?.name || "Service"}${s?.staffName ? ` <span style=\"color:#6b7280;\">— ${s.staffName}</span>` : ""}</p>`
            )
            .join("")}
        </div>`
      : data.serviceName
        ? `<p style="margin:16px 0 0;color:#374151;font-size:14px;"><strong>Service:</strong> ${data.serviceName}${data.staffName ? ` <span style=\"color:#6b7280;\">— ${data.staffName}</span>` : ""}</p>`
        : "";

    const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background-color:#f3f4f6;">
  <table role="presentation" style="width:100%;border-collapse:collapse;background:#f3f4f6;">
    <tr><td style="padding:40px 20px;">
      <table role="presentation" style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:12px;box-shadow:0 4px 6px rgba(0,0,0,0.08);overflow:hidden;">
        <tr>
          <td style="padding:0;background:linear-gradient(135deg,#1d4ed8 0%,#2563eb 100%);">
            <div style="padding:28px 32px;text-align:center;">
              <div style="font-size:40px;margin-bottom:6px;">📅</div>
              <h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;">Your booking has been rescheduled</h1>
              ${data.bookingCode ? `<p style="margin:8px 0 0;color:rgba(255,255,255,0.9);font-size:13px;">Booking ${data.bookingCode}</p>` : ""}
            </div>
          </td>
        </tr>
        <tr>
          <td style="padding:26px 32px;">
            <p style="margin:0 0 14px;color:#111827;font-size:15px;">Hi ${customerName},</p>
            <p style="margin:0 0 18px;color:#374151;font-size:14px;line-height:1.55;">
              We've updated the schedule for your booking at <strong>${data.branchName || workshopName}</strong>.
              Here are the new details:
            </p>

            <div style="background:#eff6ff;border:2px solid #93c5fd;border-radius:10px;padding:16px 18px;margin-bottom:14px;">
              <p style="margin:0 0 6px;color:#1e3a8a;font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;">New schedule</p>
              <p style="margin:0;color:#1e3a8a;font-size:16px;font-weight:700;">${newLine}</p>
            </div>

            ${
              prevLine
                ? `<div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;padding:12px 16px;margin-bottom:14px;">
                     <p style="margin:0 0 4px;color:#6b7280;font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;">Previously</p>
                     <p style="margin:0;color:#6b7280;font-size:13px;text-decoration:line-through;">${prevLine}</p>
                   </div>`
                : ""
            }

            ${
              data.reason
                ? `<div style="background:#fffbeb;border:1px solid #fcd34d;border-radius:10px;padding:12px 16px;margin-bottom:14px;">
                     <p style="margin:0 0 4px;color:#92400e;font-size:12px;font-weight:700;">Reason</p>
                     <p style="margin:0;color:#78350f;font-size:13px;">${data.reason}</p>
                   </div>`
                : ""
            }

            ${servicesHtml}

            <p style="margin:22px 0 0;color:#6b7280;font-size:13px;line-height:1.55;">
              If this new time doesn't work for you, please reply to this email or contact ${data.branchName || workshopName} and we'll be happy to find another slot.
            </p>
          </td>
        </tr>
        <tr>
          <td style="padding:18px 32px;background:#fafafa;border-top:1px solid #f4f4f5;text-align:center;">
            <p style="margin:0;font-size:11px;color:#9ca3af;">This message was sent by ${workshopName}.<br/>Powered by <strong>BMS PRO</strong></p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

    const subject = data.bookingCode
      ? `Booking rescheduled - ${workshopName} (${data.bookingCode})`
      : `Booking rescheduled - ${workshopName}`;

    await sgMail.send({ to: email, from: FROM_EMAIL, subject, html });
    console.log(`[EMAIL] ✅ Reschedule email sent to ${email} for booking ${data.bookingId}`);
    return { success: true };
  } catch (error: any) {
    console.error(`[EMAIL] ❌ Error sending reschedule email for ${data.bookingId}:`, error);
    const errorMessage = error?.response?.body?.errors?.[0]?.message || error?.message || "Unknown error";
    return { success: false, error: errorMessage };
  }
}
