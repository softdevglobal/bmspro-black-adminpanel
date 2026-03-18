import PDFDocument from "pdfkit";
import { PDFDocument as PDFLibDocument } from "pdf-lib";
import { adminDb } from "./firebaseAdmin";
import { fetchImageBuffer } from "./fetchImageForPdf";
import type { BookingTask, BookingFinalSubmission } from "./bookingTypes";
import { formatInTimezone } from "./timezone";

/** Remove trailing pages that only contain footer/minimal content */
async function removeBlankTrailingPages(pdfBuffer: Buffer): Promise<Buffer> {
  try {
    const srcDoc = await PDFLibDocument.load(pdfBuffer);
    let pageCount = srcDoc.getPageCount();
    const getObjectContentSize = (obj: any): number => {
      if (!obj) return 0;
      if (typeof obj.getContentsSize === "function") return obj.getContentsSize();
      if (typeof obj.size === "function" && typeof obj.lookup === "function") {
        let total = 0;
        for (let i = 0; i < obj.size(); i++) total += getObjectContentSize(obj.lookup(i));
        return total;
      }
      return 0;
    };
    while (pageCount > 1) {
      const lastPage = srcDoc.getPage(pageCount - 1);
      const contentSize = getObjectContentSize(lastPage.node.Contents());
      if (contentSize > 350) break;
      srcDoc.removePage(pageCount - 1);
      pageCount = srcDoc.getPageCount();
    }
    return Buffer.from(await srcDoc.save());
  } catch {
    return pdfBuffer;
  }
}

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
  vehicleMileage?: string | null;
  mileage?: string | null;
  mileageRecordedBy?: string | null;
  mileageRecordedByStaffName?: string | null;
  fuelLevel?: string | null;
  existingDamageNotes?: string | null;
  existingDamageImages?: string[] | null;
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
  finalSubmissionsByService?: Record<string, BookingFinalSubmission> | null;
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

// ─── MECHANICS THEME COLORS ──────────────────────────────────────
const C = {
  steel: "#2d3436",
  darkSteel: "#1e272e",
  charcoal: "#0a0a0a",
  orange: "#e17055",
  orangeLight: "#fab1a0",
  orangeBg: "#fff5f2",
  yellow: "#fdcb6e",
  yellowDark: "#e2b04a",
  yellowBg: "#fef9ed",
  green: "#00b894",
  greenDark: "#00a381",
  greenBg: "#eafaf6",
  greenLight: "#d4f5ed",
  blue: "#0984e3",
  blueBg: "#e8f4fd",
  blueLight: "#dfe6e9",
  red: "#d63031",
  redBg: "#ffeaea",
  muted: "#636e72",
  mutedLight: "#b2bec3",
  border: "#dfe6e9",
  bgLight: "#f5f6fa",
  bgCard: "#fafafa",
  white: "#ffffff",
} as const;

const PAGE_MARGIN = 36;
const FOOTER_RESERVE = 36;
const CONTENT_WIDTH_CALC = (doc: PDFKit.PDFDocument) => doc.page.width - PAGE_MARGIN * 2;
const TASK_IMAGE_SIZE = 80;
const FINAL_IMAGE_SIZE = 130;
const DAMAGE_IMAGE_SIZE = 75;

function normalizeImageUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
}

/** Truncate long text to prevent PDFKit from auto-adding pages on overflow */
function truncateText(s: string | null | undefined, maxLen: number): string {
  if (!s || typeof s !== "string") return "";
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 3) + "...";
}

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
    finalSubmissionsByService: data.finalSubmissionsByService && typeof data.finalSubmissionsByService === "object" ? data.finalSubmissionsByService : null,
    additionalIssues: Array.isArray(data.additionalIssues) ? data.additionalIssues : null,
    salonName,
  };

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
  const byServiceImgs = booking.finalSubmissionsByService as Record<string, { imageUrl?: string; image?: string }> | undefined;
  if (byServiceImgs && typeof byServiceImgs === "object") {
    for (const sub of Object.values(byServiceImgs)) {
      const url = sub?.imageUrl || sub?.image;
      if (url && typeof url === "string" && url.trim().length > 0) imageUrls.add(url.trim());
    }
  }
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

  let pdfBuffer = await buildPDF(booking, getImageBuffer);
  pdfBuffer = await removeBlankTrailingPages(pdfBuffer);
  const code = booking.bookingCode || bookingId.substring(0, 8);
  const filename = `Job-Report-${code}.pdf`;
  return { buffer: pdfBuffer, filename };
}

// ─── DRAWING HELPERS (Mechanics-themed decorative elements) ──────

function drawGear(doc: PDFKit.PDFDocument, cx: number, cy: number, outerR: number, innerR: number, teeth: number, color: string) {
  doc.save();
  const toothDepth = outerR - innerR;
  const toothWidth = (2 * Math.PI) / (teeth * 2);

  doc.translate(cx, cy);
  doc.moveTo(innerR * Math.cos(0), innerR * Math.sin(0));

  for (let i = 0; i < teeth; i++) {
    const angle1 = (i * 2 * Math.PI) / teeth;
    const angle2 = angle1 + toothWidth * 0.3;
    const angle3 = angle1 + toothWidth;
    const angle4 = angle1 + toothWidth * 1.7;
    const angle5 = ((i + 1) * 2 * Math.PI) / teeth;

    doc.lineTo(innerR * Math.cos(angle1), innerR * Math.sin(angle1));
    doc.lineTo((innerR + toothDepth) * Math.cos(angle2), (innerR + toothDepth) * Math.sin(angle2));
    doc.lineTo((innerR + toothDepth) * Math.cos(angle3), (innerR + toothDepth) * Math.sin(angle3));
    doc.lineTo(innerR * Math.cos(angle4), innerR * Math.sin(angle4));
    doc.lineTo(innerR * Math.cos(angle5), innerR * Math.sin(angle5));
  }

  doc.closePath();
  doc.lineWidth(1).fillOpacity(0.08).fill(color);
  doc.restore();

  doc.save();
  doc.translate(cx, cy);
  doc.circle(0, 0, innerR * 0.4).fillOpacity(0.05).fill(color);
  doc.restore();

  doc.fillOpacity(1);
}

function drawWrenchIcon(doc: PDFKit.PDFDocument, x: number, y: number, size: number, color: string) {
  doc.save();
  const s = size / 20;
  doc.translate(x, y);
  doc.scale(s, s);

  doc.path("M4.5 17.5L2.5 19.5L0.5 17.5L2.5 15.5L10 8C9.2 6 9.5 3.7 11 2.2C12.8 0.4 15.5 0.1 17.5 1.2L14 4.7L14.7 7.3L17.3 8L20.8 4.5C21.9 6.5 21.6 9.2 19.8 11C18.3 12.5 16 12.8 14 12L6.5 19.5L4.5 17.5Z")
    .fillOpacity(0.12).fill(color);

  doc.restore();
  doc.fillOpacity(1);
}

function drawDashedLine(doc: PDFKit.PDFDocument, x1: number, y1: number, x2: number, _y2: number, color: string) {
  doc.save();
  doc.strokeColor(color).lineWidth(0.5).dash(4, { space: 3 });
  doc.moveTo(x1, y1).lineTo(x2, _y2).stroke();
  doc.undash();
  doc.restore();
}

/** Blueprint-style corner bracket (mechanics drawing) */
function drawBlueprintCorner(doc: PDFKit.PDFDocument, x: number, y: number, size: number, color: string) {
  doc.save();
  doc.strokeColor(color).lineWidth(1).dash(3, { space: 2 });
  doc.moveTo(x, y).lineTo(x + size, y).stroke();
  doc.moveTo(x, y).lineTo(x, y + size).stroke();
  doc.undash();
  doc.restore();
}

/** Nut/bolt head shape (hex outline) */
function drawNutIcon(doc: PDFKit.PDFDocument, cx: number, cy: number, r: number, color: string) {
  doc.save();
  doc.translate(cx, cy);
  const sides = 6;
  for (let i = 0; i < sides; i++) {
    const a1 = (i * 2 * Math.PI) / sides - Math.PI / 2;
    const a2 = ((i + 1) * 2 * Math.PI) / sides - Math.PI / 2;
    const x1 = r * Math.cos(a1), y1 = r * Math.sin(a1);
    const x2 = r * Math.cos(a2), y2 = r * Math.sin(a2);
    if (i === 0) doc.moveTo(x1, y1);
    doc.lineTo(x2, y2);
  }
  doc.closePath().lineWidth(0.8).stroke(color);
  doc.restore();
}

function drawCheckboxIcon(doc: PDFKit.PDFDocument, x: number, y: number, checked: boolean) {
  if (checked) {
    doc.roundedRect(x, y, 12, 12, 2.5).fill(C.green);
    doc.fontSize(8).fillColor(C.white).text("\u2713", x + 2, y + 1.5, { width: 8, align: "center", lineBreak: false });
  } else {
    doc.roundedRect(x, y, 12, 12, 2.5).lineWidth(1).stroke(C.mutedLight);
  }
}

// ─── LAYOUT HELPERS ──────────────────────────────────────────────

function getPageBottom(doc: PDFKit.PDFDocument): number {
  return doc.page.height - PAGE_MARGIN - FOOTER_RESERVE;
}

function ensureSpace(doc: PDFKit.PDFDocument, y: number, needed: number): number {
  const pageBottom = getPageBottom(doc);
  const usableHeight = pageBottom - PAGE_MARGIN;
  const cappedNeeded = Math.min(needed, usableHeight);

  if (y < PAGE_MARGIN + 20) return y;

  if (y + cappedNeeded > pageBottom) {
    doc.addPage();
    return PAGE_MARGIN + 4;
  }
  return y;
}

function drawSectionTitle(doc: PDFKit.PDFDocument, title: string, x: number, y: number, pageWidth: number): number {
  y = ensureSpace(doc, y, 24);

  drawNutIcon(doc, x + 10, y + 10, 6, C.orange);
  doc.roundedRect(x + 22, y + 2, 3, 12, 1.5).fill(C.orange);

  doc.fontSize(9.5).fillColor(C.darkSteel).text(title.toUpperCase(), x + 32, y + 1, { width: pageWidth - 36, characterSpacing: 0.6 });

  const lineY = y + 18;
  drawDashedLine(doc, x, lineY, x + pageWidth, lineY, C.mutedLight);

  return y + 22;
}

function startDecoratedSectionPage(
  doc: PDFKit.PDFDocument,
  title: string,
  x: number,
  pageWidth: number
): number {
  doc.addPage();
  const y = PAGE_MARGIN + 8;
  drawBlueprintCorner(doc, x, y, 24, C.orange);
  drawBlueprintCorner(doc, x + pageWidth - 24, y, 24, C.orange);
  drawGear(doc, x + pageWidth / 2, y + 13, 18, 12, 8, C.orange);
  drawNutIcon(doc, x + 28, y + 13, 8, C.orange);
  drawNutIcon(doc, x + pageWidth - 28, y + 13, 8, C.orange);
  doc.fontSize(10).fillColor(C.darkSteel)
    .text(title.toUpperCase(), x, y + 6, {
      width: pageWidth,
      align: "center",
      characterSpacing: 1.4,
    });
  drawDashedLine(doc, x, y + 30, x + pageWidth, y + 30, C.mutedLight);
  return y + 40;
}

function drawKeyValueRows(doc: PDFKit.PDFDocument, rows: [string, string][], x: number, y: number, pageWidth: number): number {
  const labelCol = pageWidth * 0.40;
  const valueCol = pageWidth - labelCol;

  for (let i = 0; i < rows.length; i++) {
    y = ensureSpace(doc, y, 22);
    const [label, value] = rows[i];
    const rowH = 22;
    const bg = i % 2 === 0 ? C.bgLight : C.white;

    doc.rect(x, y, pageWidth, rowH).fill(bg);
    doc.rect(x, y, 2, rowH).fill(i % 2 === 0 ? C.orangeLight : C.blueLight);

    doc.fontSize(7.8).fillColor(C.muted).text(label, x + 10, y + 6, { width: labelCol - 16, lineBreak: false });
    doc.fontSize(8.6).fillColor(C.darkSteel).text(value, x + labelCol, y + 6, { width: valueCol - 8, align: "right", lineBreak: false });

    y += rowH;
  }
  return y;
}

function drawTotalBanner(doc: PDFKit.PDFDocument, totalAmount: string, x: number, y: number, pageWidth: number): number {
  y = ensureSpace(doc, y, 32);
  const h = 28;

  doc.save();
  doc.roundedRect(x, y, pageWidth, h, 5).fill(C.darkSteel);

  drawGear(doc, x + pageWidth - 24, y + h / 2, 14, 9, 8, C.white);

  doc.fontSize(7.5).fillColor(C.mutedLight).text("TOTAL AMOUNT", x + 12, y + 5, { width: pageWidth - 24 });
  doc.fontSize(16).fillColor(C.white).text(totalAmount, x + 12, y + 3, { width: pageWidth - 28, align: "right" });
  doc.restore();

  doc.fillOpacity(1);
  return y + h + 4;
}

function measureTaskCard(doc: PDFKit.PDFDocument, task: BookingTask, pageWidth: number, hasTaskImage?: boolean): number {
  let h = task.serviceName ? 32 : 24;

  if (task.description) {
    doc.fontSize(7.5);
    h += doc.heightOfString(truncateText(task.description, 400), { width: pageWidth - 60 }) + 4;
  }

  if (task.staffNote) {
    doc.fontSize(7.5);
    const noteH = doc.heightOfString(truncateText(task.staffNote, 400), { width: pageWidth - 80 });
    h += noteH + 18;
    if (task.completedByStaffName) h += 10;
  }

  if (hasTaskImage) {
    h += 12 + TASK_IMAGE_SIZE + 4;
  }

  return Math.max(h, 28) + 6;
}

// ─── MAIN BUILD ──────────────────────────────────────────────────

async function buildPDF(
  booking: BookingPDFData,
  getImageBuffer: (url: string) => Buffer | undefined
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margin: PAGE_MARGIN,
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

    const pageWidth = CONTENT_WIDTH_CALC(doc);
    const lm = PAGE_MARGIN;

    // ═══════════════════════════════════════════════════════════════
    // HEADER — Dark industrial banner with gear decorations
    // ═══════════════════════════════════════════════════════════════
    const headerH = 72;
    doc.rect(0, 0, doc.page.width, headerH).fill(C.charcoal);
    doc.rect(0, headerH - 2, doc.page.width, 2).fill(C.orange);

    drawGear(doc, doc.page.width - 50, 36, 30, 20, 9, C.white);
    drawGear(doc, doc.page.width - 90, 18, 16, 11, 7, C.orange);

    drawWrenchIcon(doc, lm, 14, 22, C.orange);

    doc.fontSize(18).fillColor(C.white)
      .text((booking.salonName || "BMS PRO BLACK").toUpperCase(), lm + 28, 14, { width: pageWidth - 120, characterSpacing: 1 });

    doc.fontSize(8).fillColor(C.orangeLight)
      .text("JOB TASK REPORT", lm + 28, 36, { width: pageWidth - 120, characterSpacing: 1.5 });

    const codeText = booking.bookingCode || booking.id.substring(0, 8);
    doc.fontSize(8).fillColor(C.mutedLight)
      .text(`# ${codeText}`, lm, 52, { width: pageWidth, align: "right" });

    let y = headerH + 8;

    // ═══════════════════════════════════════════════════════════════
    // STATUS BANNER
    // ═══════════════════════════════════════════════════════════════
    const isCompleted = booking.status === "Completed";
    const bannerBg = isCompleted ? C.greenBg : C.yellowBg;
    const bannerColor = isCompleted ? C.greenDark : C.yellowDark;
    const bannerAccent = isCompleted ? C.green : C.yellow;
    const statusText = isCompleted ? "BOOKING COMPLETED \u2014 READY TO PICK UP" : `STATUS: ${(booking.status || "Unknown").toUpperCase()}`;

    doc.roundedRect(lm, y, pageWidth, 22, 4).fill(bannerBg);
    doc.roundedRect(lm, y, 3, 22, 1.5).fill(bannerAccent);

    if (isCompleted) {
      drawCheckboxIcon(doc, lm + 8, y + 5, true);
      doc.fontSize(8.5).fillColor(bannerColor)
        .text(statusText, lm + 24, y + 6, { width: pageWidth - 36, characterSpacing: 0.3 });
    } else {
      doc.fontSize(8.5).fillColor(bannerColor)
        .text(statusText, lm + 10, y + 6, { width: pageWidth - 20, characterSpacing: 0.3 });
    }
    y += 30;

    // ═══════════════════════════════════════════════════════════════
    // BOOKING DETAILS
    // ═══════════════════════════════════════════════════════════════
    y = drawSectionTitle(doc, "Booking Details", lm, y, pageWidth);

    const details: [string, string][] = [
      ["Booking Code", booking.bookingCode || "N/A"],
      ["Customer", booking.client],
    ];
    if (booking.clientEmail) details.push(["Email", booking.clientEmail]);
    if (booking.clientPhone) details.push(["Phone", booking.clientPhone]);
    if (booking.vehicleNumber) details.push(["Registration", booking.vehicleNumber]);
    if (booking.vehicleBodyType) details.push(["Body Type", booking.vehicleBodyType]);
    if (booking.vehicleColour) details.push(["Colour", booking.vehicleColour]);
    if (booking.vehicleVinChassis) details.push(["VIN / Chassis", booking.vehicleVinChassis]);
    if (booking.vehicleEngineNumber) details.push(["Engine Number", booking.vehicleEngineNumber]);
    if (booking.vehicleMileage) details.push(["Customer Mileage", booking.vehicleMileage]);
    if (booking.mileage) {
      const mileageLabel = booking.mileageRecordedByStaffName
        ? `Mileage (staff: ${booking.mileageRecordedByStaffName})`
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
      if (pdfServicesList.length > 1) {
        for (const svc of pdfServicesList) {
          const svcName = svc.name || "Service";
          const staffName = svc.staffName || "\u2014";
          const price = Number(svc.price) || 0;
          details.push([`${svcName} (Staff: ${staffName})`, `$${price.toFixed(2)}`]);
        }
      } else if (pdfServicesList.length === 1) {
        const svc = pdfServicesList[0];
        const staffName = svc.staffName ? ` (Staff: ${svc.staffName})` : "";
        details.push([`Service${staffName}`, `$${(Number(svc.price) || 0).toFixed(2)}`]);
      } else {
        details.push(["Service Price", `$${pdfServicesSubtotal.toFixed(2)}`]);
      }
      for (const issue of pdfBillableIssues) {
        const name = issue.issueTitle || "Issue";
        const price = issue.price != null ? `$${Number(issue.price).toFixed(2)}` : "";
        details.push([`Additional: ${name}`, price]);
      }
    }
    if (booking.completedAt) details.push(["Completed At", formatTimestampInTimezone(booking.completedAt, booking.branchTimezone)]);
    if (booking.completedByStaffName || (pdfServicesList.length > 1 && pdfServicesList.some((s: any) => s.completedByStaffName))) {
      const completedBy = pdfServicesList.length > 1
        ? [...new Set(pdfServicesList.map((s: any) => s.completedByStaffName).filter(Boolean))].join(", ") || booking.completedByStaffName
        : booking.completedByStaffName;
      if (completedBy) details.push(["Completed By", completedBy]);
    }

    y = drawKeyValueRows(doc, details, lm, y, pageWidth);

    if (hasPriceBreakdown) {
      y = drawTotalBanner(doc, `$${(pdfGrandTotal || Number(booking.price) || 0).toFixed(2)}`, lm, y + 2, pageWidth);
    } else if (hasSinglePrice) {
      y = drawTotalBanner(doc, `$${Number(booking.price).toFixed(2)}`, lm, y + 2, pageWidth);
    }

    // ═══════════════════════════════════════════════════════════════
    // EXISTING DAMAGE SECTION
    // ═══════════════════════════════════════════════════════════════
    const damageImages = (booking.existingDamageImages || []).filter((u): u is string => !!u && typeof u === "string" && u.trim().length > 0);
    if (damageImages.length > 0 || booking.existingDamageNotes) {
      y = startDecoratedSectionPage(doc, "Vehicle Check-In Record", lm, pageWidth);
      y = drawSectionTitle(doc, "Existing Damage (Vehicle Check-in)", lm, y, pageWidth);

      const recordedTime = booking.date && booking.time
        ? `${booking.date} at ${formatTime12h(booking.time)}`
        : booking.date || "\u2014";
      doc.fontSize(7).fillColor(C.muted)
        .text(`Recorded at drop-off: ${recordedTime}`, lm, y, { width: pageWidth });
      y += 10;

      if (booking.existingDamageNotes) {
        const damageNotes = truncateText(booking.existingDamageNotes, 500);
        doc.fontSize(8).fillColor(C.darkSteel)
          .text(damageNotes, lm + 4, y, { width: pageWidth - 8 });
        y += doc.heightOfString(damageNotes, { width: pageWidth - 8 }) + 6;
      }

      if (damageImages.length > 0) {
        const imagesPerRow = 4;
        const gap = 8;
        const imgW = (pageWidth - gap * (imagesPerRow - 1)) / imagesPerRow;
        const imgDisplaySize = Math.min(DAMAGE_IMAGE_SIZE, imgW);

        for (let i = 0; i < damageImages.length; i++) {
          const col = i % imagesPerRow;
          if (col === 0 && i > 0) {
            y += imgDisplaySize + 14;
          }
          if (col === 0) {
            y = ensureSpace(doc, y, imgDisplaySize + 14);
          }
          const imgX = lm + col * (imgW + gap);
          const imgBuf = getImageBuffer(damageImages[i]);
          if (imgBuf && imgBuf.length > 0) {
            try {
              doc.save();
              doc.roundedRect(imgX, y, imgDisplaySize, imgDisplaySize, 3).clip();
              doc.image(imgBuf, imgX, y, { fit: [imgDisplaySize, imgDisplaySize], align: "center", valign: "center" });
              doc.restore();
              doc.roundedRect(imgX, y, imgDisplaySize, imgDisplaySize, 3).lineWidth(0.5).stroke(C.border);
            } catch {
              doc.fontSize(6).fillColor(C.mutedLight).text(`[${i + 1}]`, imgX, y + 4, { width: imgDisplaySize });
            }
          } else {
            doc.roundedRect(imgX, y, imgDisplaySize, imgDisplaySize, 3).fill(C.bgLight);
            doc.roundedRect(imgX, y, imgDisplaySize, imgDisplaySize, 3).lineWidth(0.5).stroke(C.border);
            doc.fontSize(6).fillColor(C.mutedLight).text(`[${i + 1}]`, imgX, y + imgDisplaySize / 2 - 4, { width: imgDisplaySize, align: "center" });
          }
        }
        y += imgDisplaySize + 16;
      }
      y += 4;
    }

    // ═══════════════════════════════════════════════════════════════
    // SERVICES (no forced new page — flows naturally)
    // ═══════════════════════════════════════════════════════════════
    const services = booking.services && booking.services.length > 0
      ? booking.services
      : booking.serviceName
        ? [{ name: booking.serviceName, staffName: booking.staffName, duration: booking.duration, price: booking.price }]
        : [];

    const isCollaborativeBooking = services.length > 1;

    if (services.length > 0) {
      y = startDecoratedSectionPage(doc, "Services & Staff Allocation", lm, pageWidth);
      const servicesTitle = isCollaborativeBooking
        ? `Services (${services.length} \u2014 Collaborative)`
        : "Services";
      y = drawSectionTitle(doc, servicesTitle, lm, y, pageWidth);

      if (isCollaborativeBooking) {
        const uniqueStaff = new Set<string>();
        for (const svc of services) {
          if (svc.staffName) uniqueStaff.add(svc.staffName);
        }
        if (uniqueStaff.size > 1) {
          y = ensureSpace(doc, y, 18);
          doc.roundedRect(lm, y, pageWidth, 16, 3).fill(C.blueBg);
          doc.roundedRect(lm, y, 2, 16, 1).fill(C.blue);
          doc.fontSize(7).fillColor(C.blue)
            .text(`Team: ${Array.from(uniqueStaff).join("  \u2022  ")}`, lm + 10, y + 4, { width: pageWidth - 20 });
          y += 20;
        }
      }

      for (let i = 0; i < services.length; i++) {
        const svc = services[i];
        const completedByName = (svc as any).completedByStaffName || "";
        const hasCompletedBy = completedByName && completedByName !== svc.staffName;
        const cardH = hasCompletedBy ? 42 : 32;
        y = ensureSpace(doc, y, cardH + 4);

        doc.roundedRect(lm, y, pageWidth, cardH, 4).fill(C.bgCard);
        doc.roundedRect(lm, y, pageWidth, cardH, 4).lineWidth(0.5).stroke(C.border);
        doc.roundedRect(lm, y, 3, cardH, 1.5).fill(C.orange);

        doc.save();
        doc.circle(lm + 18, y + 11, 8).fill(C.orangeBg);
        doc.fontSize(7.5).fillColor(C.orange).text(`${i + 1}`, lm + 13, y + 8, { width: 10, align: "center" });
        doc.restore();

        doc.fontSize(9).fillColor(C.darkSteel)
          .text(svc.name || "Service", lm + 32, y + 5, { width: pageWidth - 100 });

        const subParts: string[] = [];
        if (svc.staffName) subParts.push(`Staff: ${svc.staffName}`);
        if (svc.time) subParts.push(formatTime12h(svc.time));
        if (svc.duration) subParts.push(formatDuration(svc.duration));
        if (svc.price !== undefined && svc.price !== null) subParts.push(`$${Number(svc.price).toFixed(2)}`);

        if (subParts.length > 0) {
          doc.fontSize(7).fillColor(C.muted)
            .text(subParts.join("  \u2022  "), lm + 32, y + 18, { width: pageWidth - 100 });
        }

        if (hasCompletedBy) {
          doc.fontSize(6.5).fillColor(C.green)
            .text(`\u2713 Completed by: ${completedByName}`, lm + 32, y + 30, { width: pageWidth - 100 });
        }

        const isServiceDone = (svc as any).completionStatus === "completed";
        if (isServiceDone) {
          const badgeW = 52;
          const badgeX = lm + pageWidth - badgeW - 8;
          doc.roundedRect(badgeX, y + 5, badgeW, 14, 3).fill(C.greenBg);
          doc.fontSize(6).fillColor(C.greenDark).text("COMPLETED", badgeX + 3, y + 9, {
            width: badgeW - 6,
            align: "center",
            lineBreak: false,
          });
        }

        y += cardH + 3;
      }
      y += 4;
    }

    // ═══════════════════════════════════════════════════════════════
    // TASK LIST (grouped by service)
    // ═══════════════════════════════════════════════════════════════
    const tasks = booking.tasks || [];
    if (tasks.length > 0) {
      y = startDecoratedSectionPage(doc, "Task Checklist", lm, pageWidth);
      const servicesForTasks = booking.services && booking.services.length > 0 ? booking.services : [];
      const isMultiService = servicesForTasks.length > 1;

      const tasksByService = new Map<string, typeof tasks>();
      const serviceOrder: string[] = [];
      for (const svc of servicesForTasks) {
        const sid = String((svc as any)?.id ?? "");
        if (sid && !tasksByService.has(sid)) {
          tasksByService.set(sid, []);
          serviceOrder.push(sid);
        }
      }
      if (serviceOrder.length === 0 && tasks.length > 0) {
        serviceOrder.push("_single");
        tasksByService.set("_single", []);
      }
      const unassignedTasks: typeof tasks = [];
      for (const task of tasks) {
        const sid = (task as any).serviceId ? String((task as any).serviceId) : "";
        if (sid && tasksByService.has(sid)) {
          tasksByService.get(sid)!.push(task);
        } else {
          unassignedTasks.push(task);
        }
      }
      if (unassignedTasks.length > 0 && serviceOrder.length > 0) {
        tasksByService.set(serviceOrder[0], [...(tasksByService.get(serviceOrder[0]) || []), ...unassignedTasks]);
      } else if (unassignedTasks.length > 0) {
        tasksByService.set("_other", unassignedTasks);
        serviceOrder.push("_other");
      }

      const doneCount = tasks.filter(t => t.done).length;
      const progressPct = booking.taskProgress || (tasks.length > 0 ? Math.round((doneCount / tasks.length) * 100) : 0);

      for (const sid of serviceOrder) {
        const serviceTasks = tasksByService.get(sid) || [];
        if (serviceTasks.length === 0) continue;

        const svc = servicesForTasks.find((s: any) => String(s?.id) === sid);
        const svcName = (svc as any)?.name || "Service";
        const staffName = (svc as any)?.staffName || "";
        const sectionTitle = isMultiService && staffName
          ? `Tasks: ${svcName} (${staffName})`
          : isMultiService
            ? `Tasks: ${svcName}`
            : `Tasks (${doneCount}/${tasks.length} completed)`;

        y = ensureSpace(doc, y, 40);
        y = drawSectionTitle(doc, sectionTitle, lm, y, pageWidth);

        // Progress bar
        const barH = 6;
        let currentPct: number;
        let currentDone: number;
        let currentTotal: number;
        if (!isMultiService || serviceOrder.length === 1) {
          currentPct = progressPct;
          currentDone = doneCount;
          currentTotal = tasks.length;
        } else {
          const svcDone = serviceTasks.filter(t => t.done).length;
          currentPct = serviceTasks.length > 0 ? Math.round((svcDone / serviceTasks.length) * 100) : 0;
          currentDone = svcDone;
          currentTotal = serviceTasks.length;
        }

        doc.roundedRect(lm, y, pageWidth - 46, barH, 3).fill(C.bgLight);
        if (currentPct > 0) {
          const barW = Math.max(6, ((pageWidth - 46) * currentPct) / 100);
          const barColor = currentDone === currentTotal ? C.green : C.orange;
          doc.roundedRect(lm, y, barW, barH, 3).fill(barColor);
        }
        doc.fontSize(6.5).fillColor(C.muted)
          .text(`${currentDone}/${currentTotal} (${currentPct}%)`, lm + pageWidth - 44, y - 1, { width: 42, align: "right" });
        y += barH + 8;

        // Task cards
        for (let i = 0; i < serviceTasks.length; i++) {
          const task = serviceTasks[i];
          const taskImageUrl = (task as any).imageUrl || (task as any).image;
          const hasTaskImageSlot = !!(task.done && taskImageUrl);
          const cardH = measureTaskCard(doc, task, pageWidth, hasTaskImageSlot);
          y = ensureSpace(doc, y, cardH);

          const cardBg = task.done ? "#f0fdf4" : C.white;
          const cardBorder = task.done ? C.green : C.border;

          doc.roundedRect(lm, y, pageWidth, cardH, 4)
            .lineWidth(0.5)
            .fillAndStroke(cardBg, cardBorder);

          doc.roundedRect(lm, y, 3, cardH, 1.5).fill(task.done ? C.green : C.mutedLight);

          drawCheckboxIcon(doc, lm + 10, y + 5, task.done);
          if (!task.done) {
            doc.fontSize(6).fillColor(C.muted).text(`${i + 1}`, lm + 13, y + 8, { width: 8, align: "center" });
          }

          doc.fontSize(8.5).fillColor(C.darkSteel)
            .text(task.name || `Task ${i + 1}`, lm + 30, y + 6, { width: pageWidth - 86 });

          if (task.serviceName) {
            doc.fontSize(6.5).fillColor(C.muted)
              .text(task.serviceName, lm + 30, y + 18, { width: pageWidth - 86 });
          }

          if (task.done) {
            const bx = lm + pageWidth - 40;
            doc.roundedRect(bx, y + 5, 30, 12, 3).fill(C.greenBg);
            doc.fontSize(5.5).fillColor(C.greenDark).text("DONE", bx + 3, y + 8, { width: 24, align: "center" });
          }

          let iy = y + (task.serviceName ? 28 : 20);

          if (task.description) {
            const desc = truncateText(task.description, 400);
            doc.fontSize(7.5).fillColor(C.muted)
              .text(desc, lm + 30, iy, { width: pageWidth - 60 });
            doc.fontSize(7.5);
            iy += doc.heightOfString(desc, { width: pageWidth - 60 }) + 4;
          }

          if (task.staffNote) {
          const noteText = truncateText(task.staffNote, 400);
            doc.fontSize(7.5);
          const noteH = doc.heightOfString(noteText, { width: pageWidth - 80 });
            doc.roundedRect(lm + 30, iy, pageWidth - 60, noteH + 14, 3).fill(C.blueBg);
            doc.roundedRect(lm + 30, iy, 2, noteH + 14, 1).fill(C.blue);
            doc.fontSize(6.5).fillColor(C.blue).text("Staff Note:", lm + 38, iy + 3, { width: pageWidth - 86 });
          doc.fontSize(7.5).fillColor(C.darkSteel).text(noteText, lm + 38, iy + 11, { width: pageWidth - 86 });
            iy += noteH + 16;

            if (task.completedByStaffName) {
              doc.fontSize(6.5).fillColor(C.muted)
                .text(`\u2014 ${task.completedByStaffName}${task.completedAt ? `, ${formatTimestampInTimezone(task.completedAt, booking.branchTimezone)}` : ""}`,
                  lm + 38, iy, { width: pageWidth - 86 });
              iy += 10;
            }
          }

          if (task.done && taskImageUrl) {
            const imgBuf = getImageBuffer(taskImageUrl);
            if (imgBuf && imgBuf.length > 0) {
              try {
                doc.fontSize(6.5).fillColor(C.muted).text("Photo:", lm + 30, iy + 2, { width: pageWidth - 60 });
                iy += 10;
                doc.save();
                doc.roundedRect(lm + 30, iy, TASK_IMAGE_SIZE, TASK_IMAGE_SIZE, 3).clip();
                doc.image(imgBuf, lm + 30, iy, { fit: [TASK_IMAGE_SIZE, TASK_IMAGE_SIZE], align: "center", valign: "center" });
                doc.restore();
                doc.roundedRect(lm + 30, iy, TASK_IMAGE_SIZE, TASK_IMAGE_SIZE, 3).lineWidth(0.5).stroke(C.border);
              } catch (imgErr) {
                console.warn("[PDF] Task image render failed:", (imgErr as Error)?.message);
                doc.fontSize(6.5).fillColor(C.mutedLight).text("[Photo unavailable]", lm + 30, iy + 2, { width: pageWidth - 60 });
              }
            } else {
              doc.fontSize(6.5).fillColor(C.mutedLight).text("[Image could not be loaded]", lm + 30, iy + 2, { width: pageWidth - 60 });
            }
          }

          y += cardH + 3;
        }
        y += 4;
      }
    }

    // ═══════════════════════════════════════════════════════════════
    // FINAL SUBMISSION (per-service or single)
    // ═══════════════════════════════════════════════════════════════
    const byService = booking.finalSubmissionsByService as Record<string, BookingFinalSubmission> | undefined;
    const finalSubsToRender: Array<{ serviceName?: string; fs: BookingFinalSubmission }> = [];
    if (byService && typeof byService === "object" && Object.keys(byService).length > 0) {
      const svcs = booking.services || [];
      for (const [sid, sub] of Object.entries(byService)) {
        if (!sub || typeof sub !== "object") continue;
        const svc = Array.isArray(svcs) ? svcs.find((s: any) => String(s?.id) === String(sid)) : null;
        finalSubsToRender.push({ serviceName: (svc as any)?.name || "Service", fs: sub });
      }
    }
    if (finalSubsToRender.length === 0 && booking.finalSubmission) {
      finalSubsToRender.push({ fs: booking.finalSubmission });
    }

    if (finalSubsToRender.length > 0) {
      y = startDecoratedSectionPage(doc, "Final Submission", lm, pageWidth);
    }
    for (const { serviceName, fs } of finalSubsToRender) {
      const fsImageUrl = (fs as any)?.imageUrl || (fs as any)?.image;
      if (!fs.description && !fsImageUrl) continue;

      const finalDesc = truncateText(fs.description, 500);
      doc.fontSize(8.5);
      const descH = finalDesc ? doc.heightOfString(finalDesc, { width: pageWidth - 28 }) : 0;
      const hasFinalImage = !!(fsImageUrl && getImageBuffer(fsImageUrl)?.length);
      let cardH = 8 + descH + 6 + (fs.submittedByStaffName ? 12 : 0) + 8;
      if (hasFinalImage) cardH += 10 + FINAL_IMAGE_SIZE + 6;

      y = ensureSpace(doc, y, Math.min(cardH + 24, 200));
      const sectionTitle = serviceName ? `Final Submission: ${serviceName}` : "Final Submission";
      y = drawSectionTitle(doc, sectionTitle, lm, y, pageWidth);

      doc.roundedRect(lm, y, pageWidth, cardH, 4).fill(C.orangeBg);
      doc.roundedRect(lm, y, pageWidth, cardH, 4).lineWidth(0.5).stroke(C.orangeLight);
      doc.roundedRect(lm, y, 3, cardH, 1.5).fill(C.orange);

      let fsY = y + 8;
      if (finalDesc) {
        doc.fontSize(8.5).fillColor(C.darkSteel)
          .text(finalDesc, lm + 12, fsY, { width: pageWidth - 28 });
        fsY += descH + 6;
      }

      if (fs.submittedByStaffName) {
        const stamp = `Submitted by ${fs.submittedByStaffName}${fs.submittedAt ? ` on ${formatTimestampInTimezone(fs.submittedAt, booking.branchTimezone)}` : ""}`;
        doc.fontSize(6.5).fillColor(C.muted).text(stamp, lm + 12, fsY, { width: pageWidth - 28 });
        fsY += 12;
      }

      if (fsImageUrl) {
        const imgBuf = getImageBuffer(fsImageUrl);
        if (imgBuf && imgBuf.length > 0) {
          try {
            fsY = ensureSpace(doc, fsY, FINAL_IMAGE_SIZE + 14);
            doc.fontSize(6.5).fillColor(C.muted).text("Final photo:", lm + 12, fsY + 2, { width: pageWidth - 28 });
            fsY += 10;
            doc.save();
            doc.roundedRect(lm + 12, fsY, FINAL_IMAGE_SIZE, FINAL_IMAGE_SIZE, 4).clip();
            doc.image(imgBuf, lm + 12, fsY, { fit: [FINAL_IMAGE_SIZE, FINAL_IMAGE_SIZE], align: "center", valign: "center" });
            doc.restore();
            doc.roundedRect(lm + 12, fsY, FINAL_IMAGE_SIZE, FINAL_IMAGE_SIZE, 4).lineWidth(0.5).stroke(C.orangeLight);
          } catch (imgErr) {
            console.warn("[PDF] Final submission image render failed:", (imgErr as Error)?.message);
            doc.fontSize(6.5).fillColor(C.mutedLight).text("[Image could not be loaded]", lm + 12, fsY + 2, { width: pageWidth - 28 });
          }
        } else {
          doc.fontSize(6.5).fillColor(C.mutedLight).text("[Image could not be loaded]", lm + 12, fsY + 2, { width: pageWidth - 28 });
        }
      }

      y += cardH + 6;
    }

    // ═══════════════════════════════════════════════════════════════
    // ADDITIONAL ISSUES
    // ═══════════════════════════════════════════════════════════════
    const ADDITIONAL_IMG_SIZE = 50;
    const allAdditionalIssues = (booking.additionalIssues || []).filter(
      (i: any) => i.status === "approved" && i.price != null
    );

    if (allAdditionalIssues.length > 0) {
      y = startDecoratedSectionPage(doc, "Additional Issues", lm, pageWidth);
      const completedIssueCount = allAdditionalIssues.filter((i: any) => ((i.completionStatus || "").toLowerCase() === "completed")).length;
      const issuesSectionTitle = `Additional Issues \u2014 ${completedIssueCount}/${allAdditionalIssues.length} completed`;
      y = drawSectionTitle(doc, issuesSectionTitle, lm, y, pageWidth);

      for (let i = 0; i < allAdditionalIssues.length; i++) {
        const issue = allAdditionalIssues[i];
        const issueImageUrl = (issue as any).imageUrl || (issue as any).image;
        const hasImage = !!(issueImageUrl && getImageBuffer(issueImageUrl)?.length);

        const customerResponse = (issue as any).customerResponse?.toString()?.toLowerCase() ?? "";
        const issueCompleted = ((issue as any).completionStatus || "").toLowerCase() === "completed";
        const isCustomerRejected = customerResponse === "reject" || customerResponse === "rejected";
        const isCustomerAccepted = customerResponse === "accept" || customerResponse === "accepted";

        let statusLabel = "Pending";
        let statusColor = C.yellowDark;
        let cardBg = C.yellowBg;
        let accentColor = C.yellow;
        if (issueCompleted && isCustomerAccepted) {
          statusLabel = "Accepted";
          statusColor = C.greenDark;
          cardBg = C.greenBg;
          accentColor = C.green;
        } else if (isCustomerRejected) {
          statusLabel = "Rejected";
          statusColor = C.red;
          cardBg = C.redBg;
          accentColor = C.red;
        } else if (isCustomerAccepted) {
          statusLabel = "In progress";
          statusColor = C.blue;
          cardBg = C.blueBg;
          accentColor = C.blue;
        }

        const badgeW = 60;
        const contentWidth = pageWidth - (hasImage ? ADDITIONAL_IMG_SIZE + 70 : badgeW + 18);
        let cardH = 36;
        if (issue.description) {
          doc.fontSize(7);
          cardH += doc.heightOfString(truncateText(issue.description, 400), { width: contentWidth }) + 6;
        }
        if (hasImage) cardH = Math.max(cardH, ADDITIONAL_IMG_SIZE + 20);
        y = ensureSpace(doc, y, cardH + 4);

        doc.roundedRect(lm, y, pageWidth, cardH, 4).fill(cardBg);
        doc.roundedRect(lm, y, pageWidth, cardH, 4).lineWidth(0.5).stroke(C.border);
        doc.roundedRect(lm, y, 3, cardH, 1.5).fill(accentColor);

        doc.fontSize(8.5).fillColor(C.darkSteel)
          .text(`${i + 1}. ${issue.issueTitle || "Issue"}`, lm + 10, y + 5, { width: contentWidth });

        const badgeX = lm + pageWidth - badgeW - 8;
        doc.roundedRect(badgeX, y + 4, badgeW, 12, 3).fill(issueCompleted ? C.greenLight : (isCustomerRejected ? "#fecaca" : C.blueBg));
        doc.fontSize(5.5).fillColor(statusColor).text(statusLabel, badgeX + 3, y + 7, {
          width: badgeW - 6,
          align: "center",
          lineBreak: false,
        });

        const subParts: string[] = [];
        if (issue.recommendedRepair) subParts.push(`Repair: ${issue.recommendedRepair}`);
        if (issue.partsRequired) subParts.push(`Parts: ${issue.partsRequired}`);
        if (issue.labourTimeHours != null) subParts.push(`${issue.labourTimeHours}h`);
        if (issue.reportedByStaffName) subParts.push(`By: ${issue.reportedByStaffName}`);
        if (issue.price != null) subParts.push(`$${Number(issue.price).toFixed(2)}`);

        let textY = y + 18;
        if (subParts.length > 0) {
          doc.fontSize(6.5).fillColor(C.muted)
            .text(subParts.join("  \u2022  "), lm + 10, textY, { width: contentWidth });
          textY += 10;
        }
        if (issue.description) {
          const desc = truncateText(issue.description, 400);
          doc.fontSize(7).fillColor(C.muted)
            .text(desc, lm + 10, textY, { width: contentWidth });
          textY += doc.heightOfString(desc, { width: contentWidth }) + 6;
        }

        if (hasImage) {
          const imgX = lm + pageWidth - ADDITIONAL_IMG_SIZE - 10;
          const imgY = y + 6;
          try {
            const imgBuf = getImageBuffer(issueImageUrl);
            if (imgBuf && imgBuf.length > 0) {
              doc.save();
              doc.roundedRect(imgX, imgY, ADDITIONAL_IMG_SIZE, ADDITIONAL_IMG_SIZE, 3).clip();
              doc.image(imgBuf, imgX, imgY, { fit: [ADDITIONAL_IMG_SIZE, ADDITIONAL_IMG_SIZE], align: "center", valign: "center" });
              doc.restore();
              doc.roundedRect(imgX, imgY, ADDITIONAL_IMG_SIZE, ADDITIONAL_IMG_SIZE, 3).lineWidth(0.5).stroke(C.border);
            }
          } catch {
            doc.fontSize(6).fillColor(C.mutedLight).text("[Photo]", imgX, imgY + ADDITIONAL_IMG_SIZE / 2 - 3, { width: ADDITIONAL_IMG_SIZE });
          }
        }

        y += cardH + 4;

        // Completion details
        const completionImgUrl = (issue as any).completionImageUrl || (issue as any).completionImage;
        const completionNote = (issue as any).completionNote || "";
        const completedBy = (issue as any).completedByStaffName || "";
        if (issueCompleted && (completionImgUrl || completionNote)) {
          const COMPLETION_IMG_SIZE = 40;
          const hasCompletionImg = !!(completionImgUrl && getImageBuffer(completionImgUrl)?.length);
          const compNote = truncateText(completionNote, 400);
          const compNoteWidth = pageWidth - (hasCompletionImg ? COMPLETION_IMG_SIZE + 60 : 30);
          let completionH = 16;
          if (completionNote) {
            doc.fontSize(7);
            completionH += doc.heightOfString(compNote, { width: compNoteWidth }) + 6;
          }
          if (completedBy) completionH += 10;
          if (hasCompletionImg) completionH = Math.max(completionH, COMPLETION_IMG_SIZE + 18);
          y = ensureSpace(doc, y, completionH);

          doc.roundedRect(lm, y, pageWidth, completionH, 4).fill(C.greenBg);
          doc.roundedRect(lm, y, 3, completionH, 1.5).fill(C.green);

          doc.fontSize(6.5).fillColor(C.greenDark).text("\u2713 Work completed:", lm + 10, y + 4, { width: pageWidth - 60 });
          let compY = y + 14;
          if (completionNote) {
            doc.fontSize(7).fillColor(C.muted).text(compNote, lm + 10, compY, { width: compNoteWidth });
            compY += doc.heightOfString(compNote, { width: compNoteWidth }) + 4;
          }
          if (completedBy) {
            doc.fontSize(6.5).fillColor(C.muted).text(`by ${completedBy}`, lm + 10, compY, { width: pageWidth - 60 });
          }
          if (hasCompletionImg) {
            const imgX = lm + pageWidth - COMPLETION_IMG_SIZE - 10;
            try {
              const imgBuf = getImageBuffer(completionImgUrl);
              if (imgBuf && imgBuf.length > 0) {
                doc.save();
                doc.roundedRect(imgX, y + 6, COMPLETION_IMG_SIZE, COMPLETION_IMG_SIZE, 3).clip();
                doc.image(imgBuf, imgX, y + 6, { fit: [COMPLETION_IMG_SIZE, COMPLETION_IMG_SIZE], align: "center", valign: "center" });
                doc.restore();
                doc.roundedRect(imgX, y + 6, COMPLETION_IMG_SIZE, COMPLETION_IMG_SIZE, 3).lineWidth(0.5).stroke(C.green);
              }
            } catch {
              doc.fontSize(6).fillColor(C.mutedLight).text("[Photo]", imgX, y + 6 + COMPLETION_IMG_SIZE / 2 - 3, { width: COMPLETION_IMG_SIZE });
            }
          }
          y += completionH + 4;
        }
      }
      y += 4;
    }

    // ═══════════════════════════════════════════════════════════════
    // NOTES
    // ═══════════════════════════════════════════════════════════════
    if (booking.notes) {
      const notesText = truncateText(booking.notes, 600);
      doc.fontSize(8);
      const notesH = doc.heightOfString(notesText, { width: pageWidth - 16 });
      y = startDecoratedSectionPage(doc, "Additional Notes", lm, pageWidth);
      y = drawSectionTitle(doc, "Additional Notes", lm, y, pageWidth);

      doc.roundedRect(lm, y, pageWidth, notesH + 12, 4).fill(C.bgLight);
      doc.roundedRect(lm, y, 2, notesH + 12, 1).fill(C.muted);
      doc.fontSize(7.5).fillColor(C.darkSteel).text(notesText, lm + 10, y + 6, { width: pageWidth - 20 });
      y += notesH + 16;
    }

    // ═══════════════════════════════════════════════════════════════
    // FOOTER on every page — industrial style
    // ═══════════════════════════════════════════════════════════════
    const totalPages = doc.bufferedPageRange().count;
    const generatedAt = booking.branchTimezone
      ? formatInTimezone(new Date().toISOString(), booking.branchTimezone, "d/MM/yyyy, h:mm:ss a")
      : new Date().toLocaleString("en-AU");

    for (let i = 0; i < totalPages; i++) {
      doc.switchToPage(i);
      const footerY = doc.page.height - FOOTER_RESERVE;

      drawDashedLine(doc, lm, footerY, lm + pageWidth, footerY, C.mutedLight);

      drawGear(doc, lm + 8, footerY + 14, 6, 4, 6, C.muted);

      doc.fontSize(6).fillColor(C.muted)
        .text(
          `Generated ${generatedAt}  \u2022  ${booking.salonName || "BMS PRO BLACK"}  \u2022  Powered by BMS PRO`,
          lm + 18,
          footerY + 10,
          { width: pageWidth - 56, lineBreak: false }
        );

      doc.fontSize(6).fillColor(C.muted)
        .text(`Page ${i + 1}`, lm, footerY + 10, { width: pageWidth, align: "right" });
    }

    doc.end();
  });
}
