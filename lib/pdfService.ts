import PDFDocument from "pdfkit/js/pdfkit.standalone";
import { adminDb, adminStorage } from "./firebaseAdmin";
import type { BookingTask, BookingFinalSubmission } from "./bookingTypes";

interface BookingPDFData {
  id: string;
  bookingCode?: string;
  client: string;
  clientEmail?: string;
  clientPhone?: string;
  vehicleNumber?: string | null;
  mileage?: string | null;
  date: string;
  time: string;
  pickupTime?: string | null;
  duration?: number;
  price?: number;
  branchName?: string;
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
  if (!ts) return "N/A";
  try {
    let d: Date | null = null;
    if (typeof ts === "string") {
      d = new Date(ts);
    } else if (ts.toDate) {
      d = ts.toDate();
    } else if (ts._seconds) {
      d = new Date(ts._seconds * 1000);
    }
    if (d) {
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
const TASK_IMAGE_SIZE = 72;
const FINAL_IMAGE_SIZE = 160;

/**
 * Parse Firebase Storage URL to get bucket name and file path.
 * Supports: firebasestorage.googleapis.com and storage.googleapis.com formats.
 */
function parseFirebaseStorageUrl(url: string): { bucket: string; path: string } | null {
  try {
    const u = new URL(url);
    // https://firebasestorage.googleapis.com/v0/b/BUCKET/o/ENCODED_PATH?alt=media&token=...
    if (u.hostname.includes("firebasestorage.googleapis.com")) {
      const match = u.pathname.match(/^\/v0\/b\/([^/]+)\/o\/(.+)$/);
      if (match) {
        const path = decodeURIComponent(match[2]);
        return { bucket: match[1], path };
      }
    }
    // https://storage.googleapis.com/BUCKET/path/to/file
    if (u.hostname.includes("storage.googleapis.com") || u.hostname.includes("googleapis.com")) {
      const parts = u.pathname.replace(/^\//, "").split("/");
      if (parts.length >= 2) {
        const bucket = parts[0];
        const path = parts.slice(1).join("/");
        return { bucket, path };
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

async function fetchImageBuffer(url: string): Promise<Buffer | null> {
  if (!url || typeof url !== "string" || !url.startsWith("http")) return null;

  // Use Firebase Admin Storage for Firebase Storage URLs (more reliable than fetch with tokens)
  const parsed = parseFirebaseStorageUrl(url);
  if (parsed) {
    try {
      const storage = adminStorage();
      const bucket = storage.bucket(parsed.bucket);
      const file = bucket.file(parsed.path);
      const [buf] = await file.download();
      return buf && buf.length > 0 ? buf : null;
    } catch {
      /* fall through to fetch */
    }
  }

  // Fallback: fetch for non-Firebase URLs or when Admin download fails
  try {
    const res = await fetch(url, { headers: { "User-Agent": "BMS-PRO-PDF/1.0" } });
    if (!res.ok) return null;
    const arr = await res.arrayBuffer();
    return Buffer.from(arr);
  } catch {
    return null;
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

  let salonName = "Salon";
  try {
    const ownerDoc = await db.doc(`users/${data.ownerUid}`).get();
    if (ownerDoc.exists) {
      const od = ownerDoc.data();
      salonName = od?.salonName || od?.workshopName || od?.name || od?.businessName || od?.displayName || "Salon";
    }
  } catch {
    /* ignore */
  }

  const booking: BookingPDFData = {
    id: bookingId,
    bookingCode: data.bookingCode,
    client: data.client || data.clientName || "Customer",
    clientEmail: data.clientEmail,
    clientPhone: data.clientPhone,
    vehicleNumber: data.vehicleNumber || null,
    mileage: data.mileage || null,
    date: data.date || "",
    time: data.time || "",
    pickupTime: data.pickupTime,
    duration: data.duration,
    price: data.price,
    branchName: data.branchName,
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
    salonName,
  };

  // Pre-fetch all images (task-wise and overall)
  const imageUrls = new Set<string>();
  for (const task of booking.tasks || []) {
    if (task.done) {
      const url = (task as any).imageUrl || (task as any).image;
      if (url && typeof url === "string") imageUrls.add(url);
    }
  }
  const fsImage = (booking.finalSubmission as any)?.imageUrl || (booking.finalSubmission as any)?.image;
  if (fsImage && typeof fsImage === "string") imageUrls.add(fsImage);
  const imageBuffers = new Map<string, Buffer>();
  await Promise.all(
    Array.from(imageUrls).map(async (url) => {
      const buf = await fetchImageBuffer(url);
      if (buf) imageBuffers.set(url, buf);
    })
  );

  const pdfBuffer = await buildPDF(booking, imageBuffers);
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

async function buildPDF(booking: BookingPDFData, imageBuffers: Map<string, Buffer>): Promise<Buffer> {
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
    if (booking.vehicleNumber) details.push(["Vehicle Number", booking.vehicleNumber]);
    if (booking.mileage) details.push(["Mileage", booking.mileage]);
    details.push(["Date", booking.date || "N/A"]);
    details.push(["Drop-off Time", booking.time ? formatTime12h(booking.time) : "N/A"]);
    if (booking.pickupTime) details.push(["Pick-up Time", formatTime12h(booking.pickupTime)]);
    if (booking.branchName) details.push(["Branch", booking.branchName]);
    if (booking.duration) details.push(["Duration", formatDuration(booking.duration)]);
    if (booking.price !== undefined && booking.price !== null) details.push(["Total Price", `$${Number(booking.price).toFixed(2)}`]);
    if (booking.completedAt) details.push(["Completed At", formatTimestamp(booking.completedAt)]);
    if (booking.completedByStaffName) details.push(["Completed By", booking.completedByStaffName]);

    y = drawKeyValueTable(doc, details, leftMargin, y, pageWidth);
    y += 8;

    // ─── SERVICES ─────────────────────────────────────────────
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
        const hasTaskImage = !!(task.done && taskImageUrl && imageBuffers.has(taskImageUrl));
        const cardH = measureTaskCard(doc, task, pageWidth, hasTaskImage);
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
              .text(`— ${task.completedByStaffName}${task.completedAt ? `, ${formatTimestamp(task.completedAt)}` : ""}`,
                leftMargin + 36, iy, { width: pageWidth - 80 });
          }
        }

        // Task completion image
        if (hasTaskImage && taskImageUrl) {
          const imgBuf = imageBuffers.get(taskImageUrl);
          if (imgBuf && imgBuf.length > 0) {
            try {
              doc.fontSize(7).fillColor(COLORS.muted).text("Photo:", leftMargin + 30, iy + 4, { width: pageWidth - 60 });
              iy += 12;
              doc.image(imgBuf, leftMargin + 30, iy, { width: TASK_IMAGE_SIZE, height: TASK_IMAGE_SIZE });
              iy += TASK_IMAGE_SIZE + 4;
            } catch {
              /* skip if image fails to render */
            }
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
      const hasFinalImage = !!(fsImageUrl && imageBuffers.has(fsImageUrl));
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
        const stamp = `Submitted by ${fs.submittedByStaffName}${fs.submittedAt ? ` on ${formatTimestamp(fs.submittedAt)}` : ""}`;
        doc.fontSize(8).fillColor(COLORS.muted).text(stamp, leftMargin + 14, fsY, { width: pageWidth - 28 });
        fsY += 14;
      }

      // Overall/final image
      if (hasFinalImage && fsImageUrl) {
        const imgBuf = imageBuffers.get(fsImageUrl);
        if (imgBuf && imgBuf.length > 0) {
          try {
            doc.fontSize(7).fillColor(COLORS.muted).text("Overall photo:", leftMargin + 14, fsY + 4, { width: pageWidth - 28 });
            fsY += 12;
            doc.image(imgBuf, leftMargin + 14, fsY, { width: FINAL_IMAGE_SIZE, height: FINAL_IMAGE_SIZE });
          } catch {
            /* skip if image fails to render */
          }
        }
      }

      y += cardH + 8;
    }

    // ─── NOTES ────────────────────────────────────────────────
    if (booking.notes) {
      doc.fontSize(9);
      const notesH = doc.heightOfString(booking.notes, { width: pageWidth - 8 });
      y = ensureSpace(doc, y, notesH + 36);
      y = drawSectionHeader(doc, "Additional Notes", leftMargin, y, pageWidth);
      doc.fontSize(9).fillColor(COLORS.muted).text(booking.notes, leftMargin + 4, y, { width: pageWidth - 8 });
      y += notesH + 8;
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
