import PDFDocument from "pdfkit";
import { adminDb } from "./firebaseAdmin";
import { fetchImageBuffer } from "./fetchImageForPdf";
import type { BookingTask, BookingFinalSubmission } from "./bookingTypes";
import { formatInTimezone } from "./timezone";

interface BookingPDFData {
  id: string;
  bookingCode?: string;
  client: string;
  clientEmail?: string;
  clientPhone?: string;
  vehicleNumber?: string | null;
  vehicleBodyType?: string | null;
  vehicleColour?: string | null;
  vehicleVinChassis?: string | null;
  vehicleEngineNumber?: string | null;
  vehicleMileage?: string | null;  // Customer-added at booking
  mileage?: string | null;         // Staff-recorded when starting job
  mileageRecordedBy?: string | null;
  mileageRecordedByStaffName?: string | null;
  fuelLevel?: string | null;       // Staff-recorded at vehicle check-in
  existingDamageNotes?: string | null;  // Staff-recorded at vehicle check-in
  existingDamageImages?: string[] | null;  // URLs of damage photos
  date: string;
  time: string;
  pickupTime?: string | null;
  duration?: number;
  price?: number;
  branchName?: string;
  branchTimezone?: string;
  serviceName?: string;
  staffName?: string;
  status?: string;
  notes?: string;
  completedAt?: any;
  completedByStaffName?: string;
  services?: Array<{
    id?: string | number;
    name?: string;
    staffName?: string | null;
    time?: string;
    duration?: number;
    price?: number;
    completionStatus?: string;
    completedAt?: any;
    completedByStaffName?: string;
  }>;
  tasks?: BookingTask[];
  taskProgress?: number;
  finalSubmission?: BookingFinalSubmission | null;
  additionalIssues?: Array<{
    id: string;
    issueTitle: string;
    description?: string;
    recommendedRepair?: string;
    partsRequired?: string;
    labourTimeHours?: number;
    price?: number | null;
    imageUrl?: string | null;
    reportedByStaffName?: string;
    customerResponse?: "accept" | "reject" | null;
    completionStatus?: "pending" | "completed";
    completionImageUrl?: string | null;
    completionNote?: string | null;
    completedByStaffName?: string | null;
  }> | null;
  salonName?: string;
}

function formatTime12h(time: string): string {
  if (!time) return "";
  if (time.toUpperCase().includes("AM") || time.toUpperCase().includes("PM")) return time;
  try {
    const parts = time.split(":");
    if (parts.length >= 2) {
      let hour = parseInt(parts[0], 10);
      const minute = parts[1];
      const period = hour >= 12 ? "PM" : "AM";
      if (hour > 12) hour -= 12;
      if (hour === 0) hour = 12;
      return `${hour}:${minute} ${period}`;
    }
  } catch {
    /* ignore */
  }
  return time;
}

function formatDuration(minutes?: number): string {
  if (!minutes) return "";
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function formatTimestamp(ts: any): string {
  return formatTimestampInTimezone(ts, undefined);
}

/**
 * Format a timestamp for display, optionally in a specific timezone (e.g. branch timezone).
 * When timezone is provided, the time is shown in that timezone (e.g. Asia/Colombo for Kaduwela).
 */
function formatTimestampInTimezone(ts: any, timezone?: string): string {
  if (!ts) return "N/A";
  try {
    let d: Date | null = null;
    if (typeof ts === "string") {
      d = new Date(ts);
    } else if (ts.toDate) {
      d = ts.toDate();
    } else if (ts._seconds) {
      d = new Date(ts._seconds * 1000);
    } else if (ts.seconds) {
      d = new Date(ts.seconds * 1000);
    }
    if (d) {
      const iso = d.toISOString();
      if (timezone) {
        return formatInTimezone(iso, timezone, "d MMM yyyy, h:mm a");
      }
      return d.toLocaleString("en-AU", {
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    }
  } catch {
    /* ignore */
  }
  return String(ts);
}

const COLORS = {
  primary: "#1a1a1a" as const,
  accent: "#4f46e5" as const,
  green: "#059669" as const,
  greenLight: "#d1fae5" as const,
  amber: "#d97706" as const,
  blueLight: "#dbeafe" as const,
  blue: "#2563eb" as const,
  muted: "#6b7280" as const,
  border: "#e5e7eb" as const,
  background: "#f9fafb" as const,
  white: "#ffffff" as const,
};

const PAGE_MARGIN = 40;
const FOOTER_RESERVE = 52;
const TASK_IMAGE_SIZE = 140;
const FINAL_IMAGE_SIZE = 240;
const DAMAGE_IMAGE_SIZE = 120;

/** Normalize URL for Map lookup - strip query params so tokens don't cause mismatches */
function normalizeImageUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
}

/**
 * Generate a comprehensive job task PDF for a booking.
 * Returns a Buffer containing the PDF data.
 */
export async function generateBookingPDF(bookingId: string): Promise<{ buffer: Buffer; filename: string }> {
  const db = adminDb();
  const bookingSnap = await db.collection("bookings").doc(bookingId).get();

  if (!bookingSnap.exists) {
    throw new Error("Booking not found");
  }

  const data = bookingSnap.data() as any;

  let salonName = "Workshop";
  try {
    const ownerDoc = await db.doc(`users/${data.ownerUid}`).get();
    if (ownerDoc.exists) {
      const od = ownerDoc.data();
      salonName = od?.salonName || od?.workshopName || od?.name || od?.businessName || od?.displayName || "Workshop";
    }
  } catch {
    /* ignore */
  }

  // Fetch branch timezone for correct timestamp display (e.g. Asia/Colombo for Kaduwela)
  let branchTimezone = data.branchTimezone || null;
  if (!branchTimezone && data.branchId) {
    try {
      const branchDoc = await db.collection("branches").doc(data.branchId).get();
      if (branchDoc.exists) {
        const bd = branchDoc.data();
        branchTimezone = bd?.timezone || null;
      }
    } catch {
      /* ignore */
    }
  }

  const booking: BookingPDFData = {
    id: bookingId,
    bookingCode: data.bookingCode,
    client: data.client || data.clientName || "Customer",
    clientEmail: data.clientEmail,
    clientPhone: data.clientPhone,
    vehicleNumber: data.vehicleNumber || null,
    vehicleBodyType: data.vehicleBodyType || null,
    vehicleColour: data.vehicleColour || null,
    vehicleVinChassis: data.vehicleVinChassis || null,
    vehicleEngineNumber: data.vehicleEngineNumber || null,
    vehicleMileage: data.vehicleMileage || null,
    mileage: data.mileage || null,
    mileageRecordedBy: data.mileageRecordedBy || null,
    mileageRecordedByStaffName: data.mileageRecordedByStaffName || null,
    fuelLevel: data.fuelLevel || null,
    existingDamageNotes: data.existingDamageNotes || null,
    existingDamageImages: Array.isArray(data.existingDamageImages) ? data.existingDamageImages : null,
    date: data.date || "",
    time: data.time || "",
    pickupTime: data.pickupTime,
    duration: data.duration,
    price: data.price,
    branchName: data.branchName,
    branchTimezone: branchTimezone || undefined,
    serviceName: data.serviceName,
    staffName: data.staffName,
    status: data.status,
    notes: data.notes,
    completedAt: data.completedAt,
    completedByStaffName: data.completedByStaffName,
    services: data.services || [],
    tasks: data.tasks || [],
    taskProgress: data.taskProgress,
    finalSubmission: data.finalSubmission || null,
    additionalIssues: Array.isArray(data.additionalIssues) ? data.additionalIssues : null,
    salonName,
  };

  // Resolve mileageRecordedByStaffName from uid if not already set
  if (booking.mileage && data.mileageRecordedBy && !booking.mileageRecordedByStaffName) {
    try {
      const staffDoc = await db.doc(`users/${data.mileageRecordedBy}`).get();
      if (staffDoc.exists) {
        const sd = staffDoc.data();
        booking.mileageRecordedByStaffName =
          sd?.displayName || sd?.name || sd?.staffName || null;
      }
    } catch {
      /* ignore */
    }
  }

  // Pre-fetch all images (task-wise and overall)
  // Collect from root tasks AND from services[].checklist (multi-service bookings)
  const imageUrls = new Set<string>();
  const collectTaskImage = (task: any) => {
    if (task?.done) {
      const url = (task as any).imageUrl || (task as any).image;
      if (url && typeof url === "string" && url.trim().length > 0) imageUrls.add(url.trim());
    }
  };
  for (const task of booking.tasks || []) {
    collectTaskImage(task);
  }
  for (const svc of booking.services || []) {
    const checklist = (svc as any).checklist || (svc as any).tasks;
    if (Array.isArray(checklist)) {
      for (const item of checklist) collectTaskImage(item);
    }
  }
  const fsImage = (booking.finalSubmission as any)?.imageUrl || (booking.finalSubmission as any)?.image;
  if (fsImage && typeof fsImage === "string" && fsImage.trim().length > 0) imageUrls.add(fsImage.trim());
  for (const url of booking.existingDamageImages || []) {
    if (url && typeof url === "string" && url.trim().length > 0) imageUrls.add(url.trim());
  }
  for (const issue of booking.additionalIssues || []) {
    const url = (issue as any).imageUrl || (issue as any).image;
    if (url && typeof url === "string" && url.trim().length > 0) imageUrls.add(url.trim());
    const completionUrl = (issue as any).completionImageUrl || (issue as any).completionImage;
    if (completionUrl && typeof completionUrl === "string" && completionUrl.trim().length > 0) imageUrls.add(completionUrl.trim());
  }
  const DEBUG_PDF = process.env.DEBUG_PDF_IMAGES === "1";
  if (imageUrls.size === 0) {
    console.warn("[PDF] No image URLs found in booking", bookingId, "- tasks:", (booking.tasks || []).length, "done:", (booking.tasks || []).filter((t: any) => t.done).length);
  } else {
    console.log("[PDF] Fetching", imageUrls.size, "images for booking", bookingId);
    if (DEBUG_PDF) {
      const first = Array.from(imageUrls)[0];
      console.log("[PDF] First URL (truncated):", first?.slice(0, 120) + (first && first.length > 120 ? "..." : ""));
    }
  }
  const imageBuffers = new Map<string, Buffer>();
  const failedUrls: string[] = [];

  for (const url of imageUrls) {
    const buf = await fetchImageBuffer(url);
    if (buf && buf.length > 0) {
      imageBuffers.set(url, buf);
      imageBuffers.set(normalizeImageUrl(url), buf);
      try {
        imageBuffers.set(new URL(url).href, buf);
      } catch {
        /* ignore */
      }
    } else if (url) {
      failedUrls.push(url);
    }
  }
  if (failedUrls.length > 0) {
    const firstFailed = failedUrls[0] || "";
    console.warn("[PDF] Failed to fetch", failedUrls.length, "images for booking", bookingId);
    console.warn("[PDF] First failed URL (truncated):", firstFailed.slice(0, 100) + (firstFailed.length > 100 ? "..." : ""));
    console.warn("[PDF] Test: /api/debug/fetch-pdf-image?url=" + encodeURIComponent(firstFailed));
    console.warn("[PDF] Enable DEBUG_PDF_IMAGES=1 in .env.local for detailed fetch logs.");
  }

  const getImageBuffer = (url: string): Buffer | undefined => {
    if (!url || typeof url !== "string") return undefined;
    return imageBuffers.get(url) ?? imageBuffers.get(normalizeImageUrl(url)) ?? (() => {
      try {
        return imageBuffers.get(new URL(url).href);
      } catch {
        return undefined;
      }
    })();
  };

  const pdfBuffer = await buildPDF(booking, getImageBuffer);
  const code = booking.bookingCode || bookingId.substring(0, 8);
  const filename = `Job-Report-${code}.pdf`;
  return { buffer: pdfBuffer, filename };
}

function ensureSpace(doc: PDFKit.PDFDocument, y: number, needed: number): number {
  const pageBottom = doc.page.height - PAGE_MARGIN - FOOTER_RESERVE;
  if (y + needed > pageBottom) {
    doc.addPage();
    return PAGE_MARGIN;
  }
  return y;
}

async function buildPDF(
  booking: BookingPDFData,
  getImageBuffer: (url: string) => Buffer | undefined
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margin: 40,
      bufferPages: true,
      info: {
        Title: `Job Report - ${booking.bookingCode || booking.id}`,
        Author: booking.salonName || "BMS PRO BLACK",
        Subject: "Booking Job Task Report",
      },
    });

    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const pageWidth = doc.page.width - 80;
    const leftMargin = 40;

    // ─── HEADER ───────────────────────────────────────────────
    doc.rect(0, 0, doc.page.width, 90).fill(COLORS.primary);

    doc.fontSize(20).fill(COLORS.white)
      .text(booking.salonName || "BMS PRO BLACK", leftMargin, 20, { width: pageWidth });

    doc.fontSize(10).fillColor("#9ca3af")
      .text("JOB TASK REPORT", leftMargin, 48, { width: pageWidth });

    const codeText = booking.bookingCode || booking.id.substring(0, 8);
    doc.fontSize(10).fillColor(COLORS.white)
      .text(codeText, leftMargin, 65, { width: pageWidth, align: "right" });

    let y = 105;

    // ─── STATUS BANNER ────────────────────────────────────────
    const isCompleted = booking.status === "Completed";
    const bannerColor = isCompleted ? COLORS.green : COLORS.accent;
    const bannerBg = isCompleted ? COLORS.greenLight : COLORS.blueLight;
    const statusText = isCompleted ? "BOOKING COMPLETED - READY TO PICK UP" : `Status: ${booking.status || "Unknown"}`;

    doc.roundedRect(leftMargin, y, pageWidth, 30, 5).fill(bannerBg);
    doc.fontSize(11).fillColor(bannerColor)
      .text(statusText, leftMargin + 12, y + 9, { width: pageWidth - 24 });
    y += 42;

    // ─── BOOKING DETAILS ──────────────────────────────────────
    y = drawSectionHeader(doc, "Booking Details", leftMargin, y, pageWidth);

    const details: [string, string][] = [
      ["Booking Code", booking.bookingCode || "N/A"],
      ["Customer", booking.client],
    ];
    if (booking.clientEmail) details.push(["Email", booking.clientEmail]);
    if (booking.clientPhone) details.push(["Phone", booking.clientPhone]);
    if (booking.vehicleNumber) details.push(["Registration", booking.vehicleNumber]);
    if (booking.vehicleBodyType) details.push(["Body Type", booking.vehicleBodyType]);
    if (booking.vehicleColour) details.push(["Colour", booking.vehicleColour]);
    if (booking.vehicleVinChassis) details.push(["VIN/Chassis", booking.vehicleVinChassis]);
    if (booking.vehicleEngineNumber) details.push(["Engine Number", booking.vehicleEngineNumber]);
    if (booking.vehicleMileage) details.push(["Customer Mileage", booking.vehicleMileage]);
    if (booking.mileage) {
      const mileageLabel = booking.mileageRecordedByStaffName
        ? `Mileage (recorded by staff: ${booking.mileageRecordedByStaffName})`
        : "Mileage (recorded by staff)";
      details.push([mileageLabel, booking.mileage]);
    }
    if (booking.fuelLevel) details.push(["Fuel Level", booking.fuelLevel]);
    if (booking.existingDamageNotes) details.push(["Existing Damage", booking.existingDamageNotes]);
    details.push(["Date", booking.date || "N/A"]);
    details.push(["Drop-off Time", booking.time ? formatTime12h(booking.time) : "N/A"]);
    if (booking.pickupTime) details.push(["Pick-up Time", formatTime12h(booking.pickupTime)]);
    if (booking.branchName) details.push(["Branch", booking.branchName]);
    if (booking.duration) details.push(["Duration", formatDuration(booking.duration)]);
    // Price breakdown: Service Price, Additional Work, Total (when we have additional issues or price)
    // Only include completed additional work (✔) - undone items (X) are not relevant to the final bill
    const pdfBillableIssues = (booking.additionalIssues || []).filter(
      (i: any) =>
        i.status === "approved" &&
        i.price != null &&
        i.customerResponse !== "reject" &&
        i.customerResponse !== "rejected" &&
        ((i.completionStatus || "").toLowerCase() === "completed")
    );
    const pdfAdditionalTotal = pdfBillableIssues.reduce((sum: number, i: any) => sum + (Number(i.price) || 0), 0);
    const pdfServicesList = booking.services && booking.services.length > 0 ? booking.services : [];
    const pdfServicesSubtotal = pdfServicesList.reduce((sum: number, s: any) => sum + (Number(s.price) || 0), 0) || Number(booking.price) || 0;
    const pdfGrandTotal = pdfServicesSubtotal + pdfAdditionalTotal || Number(booking.price) || 0;
    const hasPriceBreakdown = pdfGrandTotal > 0 || pdfBillableIssues.length > 0;
    const hasSinglePrice = !hasPriceBreakdown && booking.price !== undefined && booking.price !== null;
    if (hasPriceBreakdown) {
      details.push(["Service Price", `$${pdfServicesSubtotal.toFixed(2)}`]);
      for (const issue of pdfBillableIssues) {
        const name = issue.issueTitle || "Issue";
        const price = issue.price != null ? `$${Number(issue.price).toFixed(2)}` : "";
        details.push([`Additional Work: ${name}`, price]);
      }
    }
    if (booking.completedAt) details.push(["Completed At", formatTimestampInTimezone(booking.completedAt, booking.branchTimezone)]);
    if (booking.completedByStaffName) details.push(["Completed By", booking.completedByStaffName]);

    y = drawKeyValueTable(doc, details, leftMargin, y, pageWidth);
    if (hasPriceBreakdown) {
      y = drawProminentTotal(doc, `$${(pdfGrandTotal || Number(booking.price) || 0).toFixed(2)}`, leftMargin, y, pageWidth);
    } else if (hasSinglePrice) {
      y = drawProminentTotal(doc, `$${Number(booking.price).toFixed(2)}`, leftMargin, y, pageWidth);
    }
    y += 8;

    // ─── EXISTING DAMAGE (customer reference - images + recorded time) ──────
    const damageImages = (booking.existingDamageImages || []).filter((u): u is string => !!u && typeof u === "string" && u.trim().length > 0);
    if (damageImages.length > 0 || booking.existingDamageNotes) {
      const damageSectionH = 50 + (booking.existingDamageNotes ? 30 : 0) + (damageImages.length > 0 ? 20 + Math.ceil(damageImages.length / 2) * (DAMAGE_IMAGE_SIZE + 30) : 0);
      y = ensureSpace(doc, y, damageSectionH);
      y = drawSectionHeader(doc, "Existing Damage (Customer Reference)", leftMargin, y, pageWidth);
      const recordedTime = booking.date && booking.time
        ? `${booking.date} at ${formatTime12h(booking.time)}`
        : booking.date || "—";
      doc.fontSize(8).fillColor(COLORS.muted)
        .text(`Recorded at drop-off: ${recordedTime}`, leftMargin, y, { width: pageWidth });
      y += 14;
      if (booking.existingDamageNotes) {
        doc.fontSize(9).fillColor(COLORS.primary)
          .text(booking.existingDamageNotes, leftMargin, y, { width: pageWidth });
        y += doc.heightOfString(booking.existingDamageNotes, { width: pageWidth }) + 10;
      }
      if (damageImages.length > 0) {
        doc.fontSize(8).fillColor(COLORS.muted).text("Photos:", leftMargin, y, { width: pageWidth });
        y += 14;
        const imagesPerRow = 2;
        const imgWidth = (pageWidth - 20) / imagesPerRow;
        for (let i = 0; i < damageImages.length; i++) {
          const col = i % imagesPerRow;
          const row = Math.floor(i / imagesPerRow);
          const imgX = leftMargin + col * (imgWidth + 10);
          const imgY = y + row * (DAMAGE_IMAGE_SIZE + 24);
          const imgBuf = getImageBuffer(damageImages[i]);
          if (imgBuf && imgBuf.length > 0) {
            try {
              doc.image(imgBuf, imgX, imgY, { fit: [DAMAGE_IMAGE_SIZE, DAMAGE_IMAGE_SIZE] });
              doc.fontSize(7).fillColor(COLORS.muted)
                .text(`Photo ${i + 1}`, imgX, imgY + DAMAGE_IMAGE_SIZE + 4, { width: DAMAGE_IMAGE_SIZE });
            } catch (imgErr) {
              doc.fontSize(7).fillColor("#9ca3af").text(`[Photo ${i + 1} unavailable]`, imgX, imgY + 4, { width: DAMAGE_IMAGE_SIZE });
            }
          } else {
            doc.roundedRect(imgX, imgY, DAMAGE_IMAGE_SIZE, DAMAGE_IMAGE_SIZE, 4).fill(COLORS.background).stroke(COLORS.border);
            doc.fontSize(7).fillColor("#9ca3af").text(`[Photo ${i + 1}]`, imgX, imgY + DAMAGE_IMAGE_SIZE / 2 - 6, { width: DAMAGE_IMAGE_SIZE, align: "center" });
          }
        }
        y += Math.ceil(damageImages.length / imagesPerRow) * (DAMAGE_IMAGE_SIZE + 28);
      }
      y += 12;
    }

    // ─── SERVICES (start on page 2) ────────────────────────────
    doc.addPage();
    y = PAGE_MARGIN;
    const services = booking.services && booking.services.length > 0
      ? booking.services
      : booking.serviceName
        ? [{ name: booking.serviceName, staffName: booking.staffName, duration: booking.duration, price: booking.price }]
        : [];

    if (services.length > 0) {
      y = ensureSpace(doc, y, 70);
      y = drawSectionHeader(doc, "Services", leftMargin, y, pageWidth);

      for (let i = 0; i < services.length; i++) {
        const svc = services[i];
        y = ensureSpace(doc, y, 48);

        doc.roundedRect(leftMargin, y, pageWidth, 40, 4).fill(COLORS.background);
        doc.fontSize(10).fillColor(COLORS.primary)
          .text(`${i + 1}. ${svc.name || "Service"}`, leftMargin + 10, y + 7, { width: pageWidth - 80 });

        const subParts: string[] = [];
        if (svc.staffName) subParts.push(`Staff: ${svc.staffName}`);
        if (svc.time) subParts.push(`Time: ${formatTime12h(svc.time)}`);
        if (svc.duration) subParts.push(formatDuration(svc.duration));
        if (svc.price !== undefined && svc.price !== null) subParts.push(`$${Number(svc.price).toFixed(2)}`);

        if (subParts.length > 0) {
          doc.fontSize(8).fillColor(COLORS.muted)
            .text(subParts.join("  |  "), leftMargin + 10, y + 24, { width: pageWidth - 80 });
        }

        const isServiceDone = (svc as any).completionStatus === "completed";
        if (isServiceDone) {
          const badgeX = leftMargin + pageWidth - 66;
          doc.roundedRect(badgeX, y + 6, 54, 14, 3).fill(COLORS.greenLight);
          doc.fontSize(7).fillColor(COLORS.green).text("COMPLETED", badgeX + 3, y + 10, {
            width: 48,
            align: "center",
            lineBreak: false,
          });
        }

        y += 46;
      }
      y += 4;
    }

    // ─── TASK LIST ────────────────────────────────────────────
    const tasks = booking.tasks || [];
    if (tasks.length > 0) {
      y = ensureSpace(doc, y, 60);
      const doneCount = tasks.filter(t => t.done).length;
      y = drawSectionHeader(doc, `Tasks (${doneCount}/${tasks.length} completed)`, leftMargin, y, pageWidth);

      // Progress bar
      const progressPct = booking.taskProgress || (tasks.length > 0 ? Math.round((doneCount / tasks.length) * 100) : 0);
      doc.roundedRect(leftMargin, y, pageWidth, 7, 3).fill(COLORS.border);
      if (progressPct > 0) {
        const barWidth = Math.max(7, (pageWidth * progressPct) / 100);
        doc.roundedRect(leftMargin, y, barWidth, 7, 3).fill(doneCount === tasks.length ? COLORS.green : COLORS.amber);
      }
      doc.fontSize(8).fillColor(COLORS.muted).text(`${progressPct}%`, leftMargin + pageWidth + 4, y - 1);
      y += 16;

      for (let i = 0; i < tasks.length; i++) {
        const task = tasks[i];
        const taskImageUrl = (task as any).imageUrl || (task as any).image;
        const hasTaskImageSlot = !!(task.done && taskImageUrl); // Reserve space for image or placeholder
        const cardH = measureTaskCard(doc, task, pageWidth, hasTaskImageSlot);
        y = ensureSpace(doc, y, cardH);

        const cardBg = task.done ? "#f0fdf4" : COLORS.white;
        const cardBorder = task.done ? COLORS.green : COLORS.border;

        doc.roundedRect(leftMargin, y, pageWidth, cardH, 5)
          .lineWidth(0.5)
          .fillAndStroke(cardBg, cardBorder);

        // Status circle
        const cx = leftMargin + 16;
        const cy = y + 13;
        if (task.done) {
          doc.circle(cx, cy, 6).fill(COLORS.green);
          doc.fontSize(8).fillColor(COLORS.white).text("✓", cx - 4, cy - 4, { width: 8, align: "center" });
        } else {
          doc.circle(cx, cy, 6).lineWidth(1).stroke(COLORS.border);
          doc.fontSize(7).fillColor(COLORS.muted).text(`${i + 1}`, cx - 4, cy - 3.5, { width: 8, align: "center" });
        }

        // Task name
        doc.fontSize(10).fillColor(COLORS.primary)
          .text(task.name || `Task ${i + 1}`, leftMargin + 30, y + 8, { width: pageWidth - 90 });

        // Service tag
        if (task.serviceName) {
          doc.fontSize(7).fillColor(COLORS.muted)
            .text(task.serviceName, leftMargin + 30, y + 22, { width: pageWidth - 90 });
        }

        // Done badge
        if (task.done) {
          const bx = leftMargin + pageWidth - 46;
          doc.roundedRect(bx, y + 7, 34, 12, 3).fill(COLORS.greenLight);
          doc.fontSize(6).fillColor(COLORS.green).text("DONE", bx + 3, y + 10, { width: 28, align: "center" });
        }

        let iy = y + (task.serviceName ? 34 : 24);

        // Task description
        if (task.description) {
          doc.fontSize(8).fillColor(COLORS.muted)
            .text(task.description, leftMargin + 30, iy, { width: pageWidth - 60 });
          doc.fontSize(8);
          iy += doc.heightOfString(task.description, { width: pageWidth - 60 }) + 4;
        }

        // Staff note
        if (task.staffNote) {
          doc.fontSize(8);
          const noteH = doc.heightOfString(task.staffNote, { width: pageWidth - 80 });
          doc.roundedRect(leftMargin + 30, iy, pageWidth - 60, noteH + 16, 4).fill(COLORS.blueLight);
          doc.fontSize(7).fillColor(COLORS.blue).text("Staff Note:", leftMargin + 36, iy + 3, { width: pageWidth - 80 });
          doc.fontSize(8).fillColor("#1e40af").text(task.staffNote, leftMargin + 36, iy + 13, { width: pageWidth - 80 });
          iy += noteH + 20;

          if (task.completedByStaffName) {
            doc.fontSize(7).fillColor(COLORS.muted)
              .text(`— ${task.completedByStaffName}${task.completedAt ? `, ${formatTimestampInTimezone(task.completedAt, booking.branchTimezone)}` : ""}`,
                leftMargin + 36, iy, { width: pageWidth - 80 });
            iy += 12;
          }
        }

        // Task completion image
        if (task.done && taskImageUrl) {
          const imgBuf = getImageBuffer(taskImageUrl);
          if (imgBuf && imgBuf.length > 0) {
            try {
              doc.fontSize(7).fillColor(COLORS.muted).text("Photo:", leftMargin + 30, iy + 4, { width: pageWidth - 60 });
              iy += 12;
              doc.image(imgBuf, leftMargin + 30, iy, { fit: [TASK_IMAGE_SIZE, TASK_IMAGE_SIZE] });
              iy += TASK_IMAGE_SIZE + 4;
            } catch (imgErr) {
              console.warn("[PDF] Task image render failed:", (imgErr as Error)?.message);
              doc.fontSize(7).fillColor(COLORS.muted).text("[Photo unavailable]", leftMargin + 30, iy + 4, { width: pageWidth - 60 });
              iy += 14;
            }
          } else {
            doc.fontSize(7).fillColor(COLORS.muted).text("Photo:", leftMargin + 30, iy + 4, { width: pageWidth - 60 });
            doc.fontSize(7).fillColor("#9ca3af").text("[Image could not be loaded]", leftMargin + 30, iy + 14, { width: pageWidth - 60 });
            iy += 28;
          }
        }

        y += cardH + 4;
      }
      y += 4;
    }

    // ─── FINAL SUBMISSION ─────────────────────────────────────
    const fsImageUrl = (booking.finalSubmission as any)?.imageUrl || (booking.finalSubmission as any)?.image;
    if (booking.finalSubmission && (booking.finalSubmission.description || fsImageUrl)) {
      const fs = booking.finalSubmission;
      doc.fontSize(10);
      const descH = fs.description ? doc.heightOfString(fs.description, { width: pageWidth - 28 }) : 0;
      const hasFinalImage = !!(fsImageUrl && getImageBuffer(fsImageUrl)?.length);
      let cardH = 10 + descH + 8 + (fs.submittedByStaffName ? 14 : 0) + 10;
      if (hasFinalImage) cardH += 12 + FINAL_IMAGE_SIZE + 8; // "Overall photo:" + image + padding

      y = ensureSpace(doc, y, cardH + 30);
      y = drawSectionHeader(doc, "Final Submission", leftMargin, y, pageWidth);

      doc.roundedRect(leftMargin, y, pageWidth, cardH, 5)
        .lineWidth(0.5)
        .fillAndStroke("#eef2ff", "#c7d2fe");

      let fsY = y + 10;
      if (fs.description) {
        doc.fontSize(10).fillColor("#312e81")
          .text(fs.description, leftMargin + 14, fsY, { width: pageWidth - 28 });
        fsY += descH + 8;
      }

      if (fs.submittedByStaffName) {
        const stamp = `Submitted by ${fs.submittedByStaffName}${fs.submittedAt ? ` on ${formatTimestampInTimezone(fs.submittedAt, booking.branchTimezone)}` : ""}`;
        doc.fontSize(8).fillColor(COLORS.muted).text(stamp, leftMargin + 14, fsY, { width: pageWidth - 28 });
        fsY += 14;
      }

      // Overall/final image
      if (fsImageUrl) {
        const imgBuf = getImageBuffer(fsImageUrl);
        if (imgBuf && imgBuf.length > 0) {
          try {
            doc.fontSize(7).fillColor(COLORS.muted).text("Overall photo:", leftMargin + 14, fsY + 4, { width: pageWidth - 28 });
            fsY += 12;
            doc.image(imgBuf, leftMargin + 14, fsY, { fit: [FINAL_IMAGE_SIZE, FINAL_IMAGE_SIZE] });
          } catch (imgErr) {
            console.warn("[PDF] Final submission image render failed:", (imgErr as Error)?.message);
            doc.fontSize(7).fillColor("#9ca3af").text("[Image could not be loaded]", leftMargin + 14, fsY + 4, { width: pageWidth - 28 });
          }
        } else {
          doc.fontSize(7).fillColor(COLORS.muted).text("Overall photo:", leftMargin + 14, fsY + 4, { width: pageWidth - 28 });
          doc.fontSize(7).fillColor("#9ca3af").text("[Image could not be loaded]", leftMargin + 14, fsY + 14, { width: pageWidth - 28 });
        }
      }

      y += cardH + 8;
    }

    // ─── ADDITIONAL ISSUES FOUND (only completed work - exclude undone items from bill) ──────
    const visibleAdditionalIssues = (booking.additionalIssues || []).filter(
      (i: any) =>
        i.status === "approved" &&
        i.price != null &&
        ((i.completionStatus || "").toLowerCase() === "completed")
    );

    // Cost Summary removed - Total shown only on page 1 (Booking Details)

    // ─── NOTES ────────────────────────────────────────────────
    if (booking.notes) {
      doc.fontSize(9);
      const notesH = doc.heightOfString(booking.notes, { width: pageWidth - 8 });
      y = ensureSpace(doc, y, notesH + 36);
      y = drawSectionHeader(doc, "Additional Notes", leftMargin, y, pageWidth);
      doc.fontSize(9).fillColor(COLORS.muted).text(booking.notes, leftMargin + 4, y, { width: pageWidth - 8 });
      y += notesH + 8;
    }

    // ─── ADDITIONAL ISSUES FOUND (exclude admin rejected) ────────
    const ADDITIONAL_IMG_SIZE = 70;
    if (visibleAdditionalIssues.length > 0) {
      y = ensureSpace(doc, y, 60);
      y = drawSectionHeader(doc, "Additional Issues Found (Technician-Reported)", leftMargin, y, pageWidth);

      for (let i = 0; i < visibleAdditionalIssues.length; i++) {
        const issue = visibleAdditionalIssues[i];
        const issueImageUrl = (issue as any).imageUrl || (issue as any).image;
        const hasImage = !!(issueImageUrl && getImageBuffer(issueImageUrl)?.length);
        let cardH = 44;
        if (issue.description) {
          doc.fontSize(8);
          cardH += doc.heightOfString(issue.description, { width: pageWidth - (hasImage ? ADDITIONAL_IMG_SIZE + 90 : 80) }) + 8;
        }
        if (hasImage) cardH = Math.max(cardH, ADDITIONAL_IMG_SIZE + 24);
        y = ensureSpace(doc, y, cardH);

        doc.roundedRect(leftMargin, y, pageWidth, cardH, 4).fill("#fef3c7");
        doc.fontSize(10).fillColor(COLORS.primary)
          .text(`${i + 1}. ${issue.issueTitle || "Issue"}`, leftMargin + 10, y + 6, { width: pageWidth - (hasImage ? ADDITIONAL_IMG_SIZE + 90 : 80) });

        const subParts: string[] = [];
        if (issue.recommendedRepair) subParts.push(`Repair: ${issue.recommendedRepair}`);
        if (issue.partsRequired) subParts.push(`Parts: ${issue.partsRequired}`);
        if (issue.labourTimeHours != null) subParts.push(`${issue.labourTimeHours} hrs`);
        if (issue.reportedByStaffName) subParts.push(`by ${issue.reportedByStaffName}`);

        let textY = y + 20;
        if (subParts.length > 0) {
          doc.fontSize(8).fillColor(COLORS.muted)
            .text(subParts.join("  |  "), leftMargin + 10, textY, { width: pageWidth - (hasImage ? ADDITIONAL_IMG_SIZE + 90 : 80) });
          textY += 14;
        }
        if (issue.description) {
          doc.fontSize(8).fillColor(COLORS.muted)
            .text(issue.description, leftMargin + 10, textY, { width: pageWidth - (hasImage ? ADDITIONAL_IMG_SIZE + 90 : 80) });
          textY += doc.heightOfString(issue.description, { width: pageWidth - (hasImage ? ADDITIONAL_IMG_SIZE + 90 : 80) }) + 8;
        }

        if (hasImage) {
          const imgX = leftMargin + pageWidth - ADDITIONAL_IMG_SIZE - 10;
          const imgY = y + 8;
          try {
            const imgBuf = getImageBuffer(issueImageUrl);
            if (imgBuf && imgBuf.length > 0) {
              doc.image(imgBuf, imgX, imgY, { fit: [ADDITIONAL_IMG_SIZE, ADDITIONAL_IMG_SIZE] });
            }
          } catch {
            doc.fontSize(7).fillColor(COLORS.muted).text("[Photo]", imgX, imgY + ADDITIONAL_IMG_SIZE / 2 - 4, { width: ADDITIONAL_IMG_SIZE });
          }
        }

        y += cardH + 6;

        // Rejected (by admin or customer)
        const issueStatus = (issue as any).status?.toString()?.toLowerCase() ?? "";
        const customerResponse = (issue as any).customerResponse?.toString()?.toLowerCase() ?? "";
        const isAdminRejected = issueStatus === "rejected";
        const isCustomerRejected = issueStatus === "approved" && (customerResponse === "reject" || customerResponse === "rejected");
        const isRejected = isAdminRejected || isCustomerRejected;
        if (isRejected) {
          const rejectH = 18;
          y = ensureSpace(doc, y, rejectH);
          doc.roundedRect(leftMargin, y, pageWidth, rejectH, 4).fill("#fef2f2");
          doc.fontSize(8).fillColor("#b91c1c")
            .text(isCustomerRejected ? "Customer rejected additional work suggested" : "Additional work not approved", leftMargin + 10, y + 6, { width: pageWidth - 20 });
          y += rejectH + 6;
        }

        // Completion (when customer accepted - work done with photo + description)
        const isCompleted = ((issue as any).completionStatus || "").toLowerCase() === "completed";
        const completionImgUrl = (issue as any).completionImageUrl || (issue as any).completionImage;
        const completionNote = (issue as any).completionNote || "";
        const completedBy = (issue as any).completedByStaffName || "";
        if (isCompleted && (completionImgUrl || completionNote)) {
          const COMPLETION_IMG_SIZE = 60;
          const hasCompletionImg = !!(completionImgUrl && getImageBuffer(completionImgUrl)?.length);
          let completionH = 20;
          if (completionNote) {
            doc.fontSize(8);
            completionH += doc.heightOfString(completionNote, { width: pageWidth - (hasCompletionImg ? COMPLETION_IMG_SIZE + 80 : 40) }) + 8;
          }
          if (completedBy) completionH += 10;
          if (hasCompletionImg) completionH = Math.max(completionH, COMPLETION_IMG_SIZE + 24);
          y = ensureSpace(doc, y, completionH);

          doc.roundedRect(leftMargin, y, pageWidth, completionH, 4).fill("#f0fdf4");
          doc.fontSize(8).fillColor("#166534").text("Work completed:", leftMargin + 10, y + 6, { width: pageWidth - 80 });
          let compY = y + 16;
          if (completionNote) {
            doc.fontSize(8).fillColor(COLORS.muted).text(completionNote, leftMargin + 10, compY, { width: pageWidth - (hasCompletionImg ? COMPLETION_IMG_SIZE + 80 : 40) });
            compY += doc.heightOfString(completionNote, { width: pageWidth - (hasCompletionImg ? COMPLETION_IMG_SIZE + 80 : 40) }) + 6;
          }
          if (completedBy) {
            doc.fontSize(7).fillColor(COLORS.muted).text(`by ${completedBy}`, leftMargin + 10, compY, { width: pageWidth - 80 });
          }
          if (hasCompletionImg) {
            const imgX = leftMargin + pageWidth - COMPLETION_IMG_SIZE - 10;
            try {
              const imgBuf = getImageBuffer(completionImgUrl);
              if (imgBuf && imgBuf.length > 0) {
                doc.image(imgBuf, imgX, y + 8, { fit: [COMPLETION_IMG_SIZE, COMPLETION_IMG_SIZE] });
              }
            } catch {
              doc.fontSize(7).fillColor(COLORS.muted).text("[Photo]", imgX, y + 8 + COMPLETION_IMG_SIZE / 2 - 4, { width: COMPLETION_IMG_SIZE });
            }
          }
          y += completionH + 6;
        }
      }
      y += 8;
    }

    // ─── FOOTER on every page ─────────────────────────────────
    const pageCount = doc.bufferedPageRange().count;
    const footerText = `Generated on ${new Date().toLocaleString("en-AU")} | ${booking.salonName || "BMS PRO BLACK"} | Powered by BMS PRO`;
    for (let i = 0; i < pageCount; i++) {
      doc.switchToPage(i);
      const footerY = doc.page.height - 52;
      doc.fontSize(7).fillColor(COLORS.muted)
        .text(footerText, leftMargin, footerY, {
          width: pageWidth,
          align: "center",
          lineBreak: false,
        });
    }

    doc.end();
  });
}

function drawSectionHeader(doc: PDFKit.PDFDocument, title: string, x: number, y: number, width: number): number {
  // Never start a section title at the page footer boundary.
  const pageBottom = doc.page.height - PAGE_MARGIN - FOOTER_RESERVE;
  if (y + 24 > pageBottom) {
    doc.addPage();
    y = PAGE_MARGIN;
  }
  doc.roundedRect(x, y, 4, 16, 2).fill(COLORS.accent);
  doc.fontSize(12).fillColor(COLORS.primary).text(title, x + 12, y + 1, { width: width - 16 });
  return y + 24;
}

function drawKeyValueTable(doc: PDFKit.PDFDocument, rows: [string, string][], x: number, y: number, width: number): number {
  const colWidth = width / 2;
  for (let i = 0; i < rows.length; i++) {
    const pageBottom = doc.page.height - PAGE_MARGIN - FOOTER_RESERVE;
    if (y + 20 > pageBottom) {
      doc.addPage();
      y = PAGE_MARGIN;
    }
    const [label, value] = rows[i];
    const rowBg = i % 2 === 0 ? COLORS.background : COLORS.white;
    doc.rect(x, y, width, 20).fill(rowBg);
    doc.fontSize(8).fillColor(COLORS.muted).text(label, x + 10, y + 5, { width: colWidth - 20 });
    doc.fontSize(8).fillColor(COLORS.primary).text(value, x + colWidth, y + 5, { width: colWidth - 10, align: "right" });
    y += 20;
  }
  return y;
}

/** Draw a prominent, larger Total row with creative styling */
function drawProminentTotal(doc: PDFKit.PDFDocument, totalAmount: string, x: number, y: number, width: number): number {
  const pageBottom = doc.page.height - PAGE_MARGIN - FOOTER_RESERVE;
  const rowHeight = 36;
  if (y + rowHeight > pageBottom) {
    doc.addPage();
    y = PAGE_MARGIN;
  }
  doc.roundedRect(x, y, width, rowHeight, 6).fill(COLORS.greenLight);
  doc.roundedRect(x, y, width, rowHeight, 6).lineWidth(1).stroke(COLORS.green);
  doc.fontSize(10).fillColor(COLORS.muted).text("TOTAL", x + 14, y + 8, { width: width - 28 });
  doc.fontSize(18).fillColor(COLORS.green).text(totalAmount, x + 14, y + 18, { width: width - 28, align: "right" });
  return y + rowHeight + 6;
}

/**
 * Precisely measure the height a task card will occupy in the PDF.
 * Includes image height when hasTaskImage is true.
 */
function measureTaskCard(doc: PDFKit.PDFDocument, task: BookingTask, pageWidth: number, hasTaskImage?: boolean): number {
  let h = task.serviceName ? 38 : 28;

  if (task.description) {
    doc.fontSize(8);
    h += doc.heightOfString(task.description, { width: pageWidth - 60 }) + 4;
  }

  if (task.staffNote) {
    doc.fontSize(8);
    const noteH = doc.heightOfString(task.staffNote, { width: pageWidth - 80 });
    h += noteH + 20;
    if (task.completedByStaffName) h += 12;
  }

  if (hasTaskImage) {
    h += 12 + TASK_IMAGE_SIZE + 4; // "Photo:" label + image + padding
  }

  return Math.max(h, 32) + 6; // +6 for inner padding
}
