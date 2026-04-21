import { existsSync } from "fs";
import puppeteer from "puppeteer-core";
import { adminDb } from "./firebaseAdmin";
import { fetchImageBuffer } from "./fetchImageForPdf";
import type { BookingTask, BookingFinalSubmission } from "./bookingTypes";
import { bookingJobReportPdfFilename } from "./bookingPdfFilename";
import { formatInTimezone } from "./timezone";
import { PDFDocument as PDFLibDocument } from "pdf-lib";
import sharp from "sharp";
import {
  type ChecklistSection,
  CHECKLIST_SECTION_LABELS,
  DEFAULT_AREA_ORDER,
  isChecklistSection,
  normalizeAreaOrder,
} from "./services";
import { taskConditionOption } from "./taskCondition";

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
  vehicleMake: string | null;
  vehicleModel: string | null;
  vehicleYear: string | null;
  vehicleVinChassis?: string | null;
  vehicleEngineNumber?: string | null;
  vehicleMileage?: string | null;
  mileage?: string | null;
  mileageRecordedBy?: string | null;
  mileageRecordedByStaffName?: string | null;
  mileageRecordedAt?: any;
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
    /** Owner-defined vehicle-area ordering. Snapshotted at booking creation, with a live-lookup fallback for legacy bookings. */
    areaOrder?: ChecklistSection[];
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
    status?: "pending" | "approved" | "rejected";
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
    vehicleMake: data.vehicleMake,
    vehicleModel: data.vehicleModel,
    vehicleYear: data.vehicleYear,
    vehicleNumber: data.vehicleNumber || null,
    vehicleBodyType: data.vehicleBodyType || null,
    vehicleColour: data.vehicleColour || null,
    vehicleVinChassis: data.vehicleVinChassis || null,
    vehicleEngineNumber: data.vehicleEngineNumber || null,
    vehicleMileage: data.vehicleMileage || null,
    mileage: data.mileage || null,
    mileageRecordedBy: data.mileageRecordedBy || null,
    mileageRecordedByStaffName: data.mileageRecordedByStaffName || null,
    mileageRecordedAt: data.mileageRecordedAt ?? null,
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
    services: Array.isArray(data.services)
      ? data.services.map((s: any) => {
          const raw = s?.areaOrder;
          const normalized =
            Array.isArray(raw) && raw.length > 0 ? normalizeAreaOrder(raw) : undefined;
          return { ...s, areaOrder: normalized };
        })
      : [],
    tasks: data.tasks || [],
    taskProgress: data.taskProgress,
    finalSubmission: data.finalSubmission || null,
    finalSubmissionsByService:
      data.finalSubmissionsByService && typeof data.finalSubmissionsByService === "object"
        ? data.finalSubmissionsByService
        : null,
    additionalIssues: Array.isArray(data.additionalIssues) ? data.additionalIssues : null,
    salonName,
  };

  // Legacy-fallback: for services whose snapshot lacks `areaOrder` (created
  // before we snapshotted it onto the booking), look it up live from
  // `services/{id}` so the PDF still groups tasks in the owner's preferred
  // area order instead of the fixed default.
  {
    const missingIds = new Set<string>();
    for (const s of booking.services || []) {
      if (!Array.isArray(s.areaOrder) || s.areaOrder.length === 0) {
        const id = s.id != null ? String(s.id).trim() : "";
        if (id) missingIds.add(id);
      }
    }
    if (missingIds.size > 0) {
      const liveOrders = new Map<string, ChecklistSection[]>();
      await Promise.all(
        Array.from(missingIds).map(async (id) => {
          try {
            const snap = await db.collection("services").doc(id).get();
            if (!snap.exists) return;
            const raw = (snap.data() || {}).areaOrder;
            if (!Array.isArray(raw) || raw.length === 0) return;
            liveOrders.set(id, normalizeAreaOrder(raw));
          } catch {
            /* ignore */
          }
        })
      );
      if (liveOrders.size > 0 && Array.isArray(booking.services)) {
        booking.services = booking.services.map((s) => {
          if (Array.isArray(s.areaOrder) && s.areaOrder.length > 0) return s;
          const id = s.id != null ? String(s.id).trim() : "";
          const live = id ? liveOrders.get(id) : undefined;
          return live ? { ...s, areaOrder: live } : s;
        });
      }
    }
  }

  const hasVehicleCheckInData =
    Boolean(booking.mileage) ||
    Boolean(booking.fuelLevel) ||
    Boolean(String(booking.existingDamageNotes || "").trim()) ||
    (Array.isArray(booking.existingDamageImages) && booking.existingDamageImages.length > 0);

  if (hasVehicleCheckInData && data.mileageRecordedBy && !booking.mileageRecordedByStaffName) {
    try {
      const staffDoc = await db.doc(`users/${data.mileageRecordedBy}`).get();
      if (staffDoc.exists) {
        const sd = staffDoc.data();
        booking.mileageRecordedByStaffName = sd?.displayName || sd?.name || sd?.staffName || null;
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
  const fsImage =
    (booking.finalSubmission as any)?.imageUrl || (booking.finalSubmission as any)?.image;
  if (fsImage && typeof fsImage === "string" && fsImage.trim().length > 0) imageUrls.add(fsImage.trim());
  const byServiceImgs = booking.finalSubmissionsByService as
    | Record<string, { imageUrl?: string; image?: string }>
    | undefined;
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
    if (completionUrl && typeof completionUrl === "string" && completionUrl.trim().length > 0)
      imageUrls.add(completionUrl.trim());
  }

  const DEBUG_PDF = process.env.DEBUG_PDF_IMAGES === "1";
  if (imageUrls.size === 0) {
    console.warn(
      "[PDF] No image URLs found in booking",
      bookingId,
      "- tasks:",
      (booking.tasks || []).length,
      "done:",
      (booking.tasks || []).filter((t: any) => t.done).length
    );
  } else {
    console.log("[PDF] Fetching", imageUrls.size, "images for booking", bookingId);
    if (DEBUG_PDF) {
      const first = Array.from(imageUrls)[0];
      console.log(
        "[PDF] First URL (truncated):",
        first?.slice(0, 120) + (first && first.length > 120 ? "..." : "")
      );
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
    console.warn(
      "[PDF] First failed URL (truncated):",
      firstFailed.slice(0, 100) + (firstFailed.length > 100 ? "..." : "")
    );
    console.warn(
      "[PDF] Test: /api/debug/fetch-pdf-image?url=" + encodeURIComponent(firstFailed)
    );
    console.warn("[PDF] Enable DEBUG_PDF_IMAGES=1 in .env.local for detailed fetch logs.");
  }

  const getImageBuffer = (url: string): Buffer | undefined => {
    if (!url || typeof url !== "string") return undefined;
    return (
      imageBuffers.get(url) ??
      imageBuffers.get(normalizeImageUrl(url)) ??
      (() => {
        try {
          return imageBuffers.get(new URL(url).href);
        } catch {
          return undefined;
        }
      })()
    );
  };

  const pdfBuffer = await buildPDF(booking, getImageBuffer);
  const filename = bookingJobReportPdfFilename(data.bookingCode, bookingId);
  return { buffer: pdfBuffer, filename };
}

// ─── PUPPETEER HTML BUILDER ──────────────────────────────────────────────────

async function buildHTML(
  booking: BookingPDFData,
  getImageBuffer: (url: string) => Buffer | undefined
): Promise<string> {

  const safeStr = (str: any) => {
    if (str === null || str === undefined) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  };

  // Images are served as-is — we only strip EXIF orientation (auto-rotate based
  // on EXIF then discard the tag) so the browser renders them right-side-up
  // without re-encoding or changing the format/quality.
  const getBase64Image = async (url: string | undefined, quality = 70, maxWidth = 800): Promise<string> => {
    if (!url) return "";
    const buf = getImageBuffer(url);
    if (!buf || buf.length === 0) return "";
    try {
      // .rotate() with no angle reads EXIF orientation and physically rotates
      // the pixels to match, then strips the EXIF tag — no colour/quality loss.
      const correctedBuffer = await sharp(buf)
        .rotate()                                         // auto-orient via EXIF
        .resize({ width: maxWidth, withoutEnlargement: true })
        .toBuffer({ resolveWithObject: true });
      const { data, info } = correctedBuffer;
      const mime =
        info.format === "png"  ? "image/png"  :
        info.format === "webp" ? "image/webp" :
        info.format === "gif"  ? "image/gif"  : "image/jpeg";
      return `data:${mime};base64,${data.toString("base64")}`;
    } catch (err) {
      console.error("Error processing image:", err);
      return `data:image/jpeg;base64,${buf.toString("base64")}`;
    }
  };

  // ─── SERVICES & PRICING ───
  const pdfServicesList = booking.services && booking.services.length > 0 ? booking.services : [];

  const pdfServicesSubtotal =
    pdfServicesList.reduce((sum: number, s: any) => sum + (Number(s.price) || 0), 0) ||
    Number(booking.price) ||
    0;

  // Billable = admin approved + customer accepted + completed (for price total only)
  const pdfBillableIssues = (booking.additionalIssues || []).filter(
    (i: any) =>
      i.status === "approved" &&
      i.price != null &&
      i.customerResponse === "accept" &&
      (i.completionStatus || "").toLowerCase() === "completed"
  );

  const pdfAdditionalTotal = pdfBillableIssues.reduce(
    (sum: number, i: any) => sum + (Number(i.price) || 0),
    0
  );

  const pdfGrandTotal = pdfServicesSubtotal + pdfAdditionalTotal || Number(booking.price) || 0;

  const completedByFromServices = [
    ...new Set(
      (booking.services || []).map((s: any) => s.completedByStaffName).filter(Boolean)
    ),
  ] as string[];
  const jobReportCompletedByLine =
    (completedByFromServices.length > 0 ? completedByFromServices.join(", ") : "") ||
    (booking.completedByStaffName || "");

  const hasVehicleCheckIn =
    Boolean(booking.mileage) ||
    Boolean(booking.fuelLevel) ||
    Boolean(String(booking.existingDamageNotes || "").trim()) ||
    (Array.isArray(booking.existingDamageImages) && booking.existingDamageImages.length > 0);

  const vehicleCheckInBy = (booking.mileageRecordedByStaffName || "").trim();
  const vehicleCheckInAtFormatted = booking.mileageRecordedAt
    ? formatTimestampInTimezone(booking.mileageRecordedAt, booking.branchTimezone)
    : "";
  const vehicleCheckInAtOk =
    Boolean(vehicleCheckInAtFormatted) && vehicleCheckInAtFormatted !== "N/A";

  const hasPriceBreakdown = pdfGrandTotal > 0 || pdfBillableIssues.length > 0;
  const hasSinglePrice = !hasPriceBreakdown && booking.price !== undefined && booking.price !== null;

  const totalAmountStr = `$${pdfGrandTotal.toFixed(2)}`;

  // ─── PRE-RENDER ALL ASYNC IMAGES ───────────────────────────────────────────
  // FIX 2: Resolve every image to a base64 string up-front so the template
  // literals below can stay synchronous. Previously the template called
  // getBase64Image(...) inline without await, returning raw Promises.

  // Damage photos
  const damageImageSrcs: string[] = await Promise.all(
    (booking.existingDamageImages || []).map(async (img: any) => {
      const url = typeof img === "string" ? img : img?.imageUrl;
      return getBase64Image(url, 70);
    })
  );

  // Task images: keyed by task index within each service block
  // We'll build a flat map of imageUrl -> base64 to look up in the template
  const taskImageMap = new Map<string, string>();
  for (const task of booking.tasks || []) {
    const url = (task as any).imageUrl || (task as any).image;
    if (url && typeof url === "string") {
      const src = await getBase64Image(url, 70);
      taskImageMap.set(url, src);
    }
  }

  // Additional issue images
  const issueImageMap = new Map<string, string>();
  for (const issue of booking.additionalIssues || []) {
    const requestUrl = issue.imageUrl;
    if (requestUrl) {
      issueImageMap.set(requestUrl, await getBase64Image(requestUrl, 70));
    }
    const completionUrl = issue.completionImageUrl;
    if (completionUrl) {
      issueImageMap.set(completionUrl, await getBase64Image(completionUrl, 70));
    }
  }

  // Final submission images
  const finalSubmissionImageMap = new Map<string, string>();
  const fsImage =
    (booking.finalSubmission as any)?.imageUrl || (booking.finalSubmission as any)?.image;
  if (fsImage) {
    finalSubmissionImageMap.set(fsImage, await getBase64Image(fsImage, 70));
  }
  if (booking.finalSubmissionsByService) {
    for (const sub of Object.values(booking.finalSubmissionsByService as any)) {
      const url = (sub as any)?.imageUrl || (sub as any)?.image;
      if (url) finalSubmissionImageMap.set(url, await getBase64Image(url, 70));
    }
  }

  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <title>Job Report - ${safeStr(booking.bookingCode || booking.id)}</title>
      <link href="https://fonts.googleapis.com/css2?family=Cabinet+Grotesk:wght@400;500;600;700;800&family=Fira+Code:wght@300;400;500&family=Lora:ital,wght@0,400;0,500;1,400&display=swap" rel="stylesheet">
      <style>
  :root {
    --bg:          #f4f2ee;
    --bg2:         #ede9e2;
    --surface:     #ffffff;
    --surface2:    #faf9f7;
    --surface3:    #f0ede7;
    --border:      #e2ddd6;
    --border-soft: #ece8e1;
    --accent:      #1a6b4a;
    --accent-lt:   #e8f5ee;
    --accent2:     #2563a8;
    --accent2-lt:  #e8f0fa;
    --warn:        #b45309;
    --warn-lt:     #fef3e2;
    --danger:      #be3455;
    --danger-lt:   #fde8ee;
    --text:        #1c1917;
    --text-mid:    #57534e;
    --text-muted:  #a8a29e;
    --text-faint:  #d6d3cf;
    --shadow-sm:   0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04);
    --shadow:      0 4px 16px rgba(0,0,0,0.07), 0 1px 4px rgba(0,0,0,0.04);
    --radius:      14px;
    --radius-sm:   9px;
    --radius-xs:   6px;
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    background: var(--bg);
    color: var(--text);
    font-family: 'Cabinet Grotesk', sans-serif;
    font-size: 14px;
    line-height: 1.6;
    min-height: 100vh;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }

  .report-header {
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    padding: 32px 52px 28px;
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 24px;
    position: relative;
  }

  .header-top-bar {
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 4px;
    background: linear-gradient(90deg, var(--accent) 0%, #34d399 45%, var(--accent2) 100%);
  }

  .brand-block { display: flex; flex-direction: column; gap: 5px; }

  .brand-name {
    font-size: 26px;
    font-weight: 800;
    letter-spacing: -0.8px;
    color: var(--text);
  }

  .brand-name span { color: var(--accent); }

  .brand-sub {
    font-family: 'Fira Code', monospace;
    font-size: 10.5px;
    letter-spacing: 0.18em;
    color: var(--text-muted);
    text-transform: uppercase;
  }

  .header-meta {
    text-align: right;
    display: flex;
    flex-direction: column;
    gap: 8px;
    align-items: flex-end;
  }

  .status-badge {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    background: var(--accent-lt);
    border: 1.5px solid #a7dfbf;
    color: var(--accent);
    font-family: 'Fira Code', monospace;
    font-size: 10.5px;
    font-weight: 500;
    letter-spacing: 0.1em;
    padding: 5px 14px;
    border-radius: 100px;
    text-transform: uppercase;
  }

  .status-dot {
    width: 6px; height: 6px;
    background: var(--accent);
    border-radius: 50%;
  }

  .booking-code {
    font-family: 'Fira Code', monospace;
    font-size: 12.5px;
    color: var(--text-mid);
    letter-spacing: 0.04em;
  }

  .gen-date {
    font-size: 11px;
    color: var(--text-muted);
    font-family: 'Fira Code', monospace;
  }

  .report-body {
    max-width: 1080px;
    margin: 0 auto;
    padding: 36px 52px 64px;
    display: flex;
    flex-direction: column;
    gap: 28px;
  }

  .section-label {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 12px;
  }

  .section-label-dot {
    width: 8px; height: 8px;
    border-radius: 2px;
    background: var(--accent);
    flex-shrink: 0;
  }

  .section-label h2 {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.2em;
    text-transform: uppercase;
    color: var(--text-muted);
    white-space: nowrap;
  }

  .section-label::after {
    content: '';
    flex: 1;
    height: 1px;
    background: var(--border);
  }

  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow-sm);
  }

  .keep-together {
    page-break-inside: avoid;
    break-inside: avoid;
  }

  .keep-together .detail-cell {
    padding: 12px 14px;
    font-size: 12px;
  }

  .details-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 1px;
    background: var(--border);
  }

  .detail-cell {
    background: var(--surface);
    padding: 16px 18px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .detail-label {
    font-family: 'Fira Code', monospace;
    font-size: 9.5px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--text-muted);
  }

  .detail-value { font-size: 14px; font-weight: 600; color: var(--text); }
  .detail-value.code { color: var(--accent2); font-family: 'Fira Code', monospace; font-size: 16px; }
  .detail-value.warn { color: var(--warn); }

  .timing-strip {
    display: flex;
    align-items: center;
    padding: 18px 28px;
    background: var(--surface2);
    border-top: 1px solid var(--border-soft);
  }

  .timing-node { display: flex; flex-direction: column; align-items: center; gap: 3px; }
  .t-label { font-family: 'Fira Code', monospace; font-size: 9.5px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--text-muted); }
  .t-val { font-size: 20px; font-weight: 800; color: var(--text); letter-spacing: -0.5px; }
  .t-sub { font-size: 11px; color: var(--text-muted); }

  .timing-connector {
    flex: 1;
    height: 2px;
    background: var(--border);
    margin: 0 18px;
    position: relative;
    border-radius: 2px;
    min-width: 48px;
  }

  .timing-connector::after {
    content: '';
    position: absolute;
    left: 0; top: 0; bottom: 0;
    width: 55%;
    background: linear-gradient(90deg, var(--accent), #34d399);
    border-radius: 2px;
  }

  .duration-pill {
    background: var(--accent-lt);
    border: 1.5px solid #a7dfbf;
    color: var(--accent);
    font-family: 'Fira Code', monospace;
    font-size: 11px;
    padding: 3px 12px;
    border-radius: 100px;
  }

  .completed-by-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 13px 20px;
    background: var(--surface2);
    border-top: 1px solid var(--border-soft);
    flex-wrap: wrap;
  }

  .cb-label {
    font-family: 'Fira Code', monospace;
    font-size: 9.5px;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--text-muted);
  }

  .staff-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 100px;
    padding: 4px 12px 4px 5px;
    font-size: 12.5px;
    font-weight: 600;
    box-shadow: var(--shadow-sm);
  }

  .staff-avatar {
    width: 22px; height: 22px;
    border-radius: 50%;
    background: linear-gradient(135deg, var(--accent) 0%, var(--accent2) 100%);
    display: flex; align-items: center; justify-content: center;
    font-size: 9px; font-weight: 800; color: #fff;
    font-family: 'Fira Code', monospace;
  }

  .damage-inner {
    display: flex;
    gap: 16px;
    padding: 20px;
    flex-wrap: wrap;
  }

  .damage-info {
    flex: 1;
    min-width: 180px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .damage-pill {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    background: var(--warn-lt);
    border: 1.5px solid #f6c87a;
    color: var(--warn);
    font-weight: 700;
    font-size: 13px;
    padding: 6px 14px;
    border-radius: 100px;
    align-self: flex-start;
  }

  .damage-ts { font-family: 'Fira Code', monospace; font-size: 10.5px; color: var(--text-muted); }
  .damage-desc { font-size: 12.5px; color: var(--text-mid); line-height: 1.5; }

  .services-list {
    display: flex;
    flex-direction: column;
    gap: 1px;
    background: var(--border);
  }

  .service-row {
    background: var(--surface);
    display: flex;
    align-items: center;
    padding: 15px 22px;
    gap: 14px;
  }

  .service-row.additional { background: #f0faf5; }

  .svc-index {
    width: 26px; height: 26px;
    border-radius: 50%;
    background: var(--surface3);
    border: 1.5px solid var(--border);
    display: flex; align-items: center; justify-content: center;
    font-family: 'Fira Code', monospace;
    font-size: 11px;
    color: var(--text-muted);
    flex-shrink: 0;
  }

  .svc-index.extra {
    background: var(--accent-lt);
    border-color: #a7dfbf;
    color: var(--accent);
    font-size: 14px;
  }

  .svc-name { font-weight: 600; font-size: 14px; flex: 1; }
  .svc-meta { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }

  .chip {
    display: inline-flex;
    align-items: center;
    background: var(--surface3);
    border: 1px solid var(--border);
    border-radius: var(--radius-xs);
    padding: 2px 9px;
    font-family: 'Fira Code', monospace;
    font-size: 9px;
    color: var(--text-muted);
  }

  .chip.staff { background: var(--accent2-lt); border-color: #bfd5f5; color: var(--accent2); }

  .done-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    background: var(--accent-lt);
    border: 1.5px solid #a7dfbf;
    color: var(--accent);
    font-family: 'Fira Code', monospace;
    font-size: 10px;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    padding: 3px 10px;
    border-radius: 100px;
  }

  .svc-price { font-size: 16px; font-weight: 800; color: var(--text); min-width: 76px; text-align: right; letter-spacing: -0.3px; }

  .total-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 18px 22px;
    background: var(--accent);
  }

  .total-bar .total-label { font-family: 'Fira Code', monospace; font-size: 10px; letter-spacing: 0.16em; text-transform: uppercase; color: rgba(255,255,255,0.65); }
  .total-bar .total-sub { font-size: 11px; color: rgba(255,255,255,0.5); margin-top: 2px; }
  .total-amount { font-size: 30px; font-weight: 800; color: #fff; letter-spacing: -1px; }

  .service-block { margin-bottom: 14px; }

  .service-block-header {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius) var(--radius) 0 0;
    padding: 15px 20px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
  }

  .sbh-title { font-size: 15px; font-weight: 700; }
  .sbh-staff { font-family: 'Fira Code', monospace; font-size: 11px; color: var(--text-muted); margin-top: 2px; }

  .progress-wrap { display: flex; align-items: center; gap: 10px; }
  .progress-track { width: 90px; height: 5px; background: var(--border); border-radius: 5px; overflow: hidden; }
  .progress-fill { height: 100%; background: linear-gradient(90deg, var(--accent), #34d399); border-radius: 5px; }
  .progress-text { font-family: 'Fira Code', monospace; font-size: 11px; color: var(--accent); white-space: nowrap; }

  .tasks-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(270px, 1fr));
    gap: 10px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-top: none;
    border-radius: 0 0 var(--radius) var(--radius);
    padding: 14px;
  }

  /* Area-grouped tasks: one card body with multiple area sections stacked. */
  .tasks-body {
    background: var(--surface);
    border: 1px solid var(--border);
    border-top: none;
    border-radius: 0 0 var(--radius) var(--radius);
    padding: 10px 14px 14px;
  }
  .area-group { margin-top: 12px; page-break-inside: avoid; break-inside: avoid; }
  .area-group:first-child { margin-top: 2px; }
  .area-group-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 0 8px;
    border-bottom: 1px dashed var(--border-soft);
    margin-bottom: 10px;
  }
  .area-dot {
    width: 7px;
    height: 7px;
    border-radius: 999px;
    background: var(--accent);
    box-shadow: 0 0 0 3px rgba(0,0,0,0.04);
  }
  .area-title {
    font-family: 'Space Grotesk', sans-serif;
    font-size: 11px;
    font-weight: 700;
    color: var(--text-muted);
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }
  .area-count {
    margin-left: auto;
    font-family: 'Fira Code', monospace;
    font-size: 10px;
    color: var(--text-muted);
  }
  .area-group .tasks-grid {
    background: transparent;
    border: none;
    padding: 0;
    border-radius: 0;
  }

  /* Task condition pill (Urgent / Advisory / Good Condition) */
  .cond-pill {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    margin: 6px 10px 0;
    padding: 2px 8px;
    border-radius: 999px;
    border: 1px solid;
    font-family: 'Space Grotesk', sans-serif;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.02em;
    line-height: 1.4;
  }
  .cond-pill .cond-dot {
    width: 6px;
    height: 6px;
    border-radius: 999px;
  }
  .cond-urgent   { background: #FEF2F2; color: #B91C1C; border-color: #FECACA; }
  .cond-urgent   .cond-dot { background: #EF4444; }
  .cond-advisory { background: #FFFBEB; color: #B45309; border-color: #FDE68A; }
  .cond-advisory .cond-dot { background: #F59E0B; }
  .cond-good     { background: #ECFDF5; color: #047857; border-color: #A7F3D0; }
  .cond-good     .cond-dot { background: #10B981; }

  .task-card {
    background: var(--surface2);
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-sm);
  }

  .task-card-noimage {
  /* Tighten padding when there's no photo at the bottom */
  padding-bottom: 4px;
  align-self: start;
}


  .task-card-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 13px 14px 8px;
    gap: 8px;
  }

  .task-name { font-weight: 700; font-size: 13px; flex: 1; }

  .task-done {
    font-family: 'Fira Code', monospace;
    font-size: 9.5px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    background: var(--accent-lt);
    border: 1px solid #a7dfbf;
    color: var(--accent);
    border-radius: 100px;
    padding: 2px 9px;
    white-space: nowrap;
  }

  .task-desc { padding: 0 14px 8px; font-size: 11.5px; color: var(--text-muted); font-style: italic; }

  .staff-note {
    margin: 0 10px 10px;
    background: var(--surface);
    border: 1px solid var(--border-soft);
    border-left: 3px solid var(--accent2);
    border-radius: 0 var(--radius-xs) var(--radius-xs) 0;
    padding: 7px 11px;
  }

  .note-label { font-family: 'Fira Code', monospace; font-size: 9px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--accent2); margin-bottom: 3px; }
  .note-text { font-size: 12px; color: var(--text); }
  .note-meta { font-family: 'Fira Code', monospace; font-size: 9.5px; color: var(--text-muted); margin-top: 4px; }

  .task-photo-wrap {
    width: 100%;
    height: 180px;
    background: var(--surface3);
    border-top: 1px solid var(--border-soft);
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  }

  .task-photo {
    max-width: 100%;
    max-height: 180px;
    width: auto;
    height: auto;
    display: block;
    object-fit: contain;
  }

  .photo-placeholder { width: 100%; height: 120px; background: var(--surface3); border-top: 1px solid var(--border-soft); display: flex; align-items: center; justify-content: center; color: var(--text-faint); font-family: 'Fira Code', monospace; font-size: 10px; }

  .issues-container { display: flex; flex-direction: column; gap: 1px; background: var(--border); }

  .issue-block { background: var(--surface); }
  .issue-block.accepted { border-left: 4px solid var(--accent); }
  .issue-block.rejected { border-left: 4px solid var(--danger); }

  .issue-main { display: flex; align-items: flex-start; gap: 16px; padding: 18px 20px 16px; }

  .issue-status-badge {
    font-family: 'Fira Code', monospace;
    font-size: 9.5px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    padding: 4px 11px;
    border-radius: 100px;
    white-space: nowrap;
    flex-shrink: 0;
    margin-top: 2px;
  }

  .issue-status-badge.accepted { background: var(--accent-lt); border: 1.5px solid #a7dfbf; color: var(--accent); }
  .issue-status-badge.rejected { background: var(--danger-lt); border: 1.5px solid #f4a8b8; color: var(--danger); }

  .issue-content { flex: 1; }
  .issue-title { font-size: 15px; font-weight: 700; margin-bottom: 8px; }
  .issue-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }

  .issue-note {
    font-size: 12.5px;
    color: var(--text-muted);
    font-family: 'Lora', serif;
    font-style: italic;
    padding: 6px 10px;
    background: var(--surface2);
    border-radius: var(--radius-xs);
    display: inline-block;
  }

  .issue-outcome { margin-top: 8px; font-size: 12px; font-weight: 600; }
  .issue-outcome.accepted { color: var(--accent); }
  .issue-outcome.rejected { color: var(--danger); }

  .issue-price-col { font-size: 17px; font-weight: 800; color: var(--text); text-align: right; flex-shrink: 0; padding-top: 2px; }
  .issue-price-col.rejected { text-decoration: line-through; color: var(--text-muted); }

  .issue-photos-section { border-top: 1px solid var(--border-soft); background: var(--surface2); }

  .issue-photos-header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 20px 8px;
    border-bottom: 1px solid var(--border-soft);
  }

  .issue-photos-header-label {
    font-family: 'Fira Code', monospace;
    font-size: 9.5px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--text-muted);
  }

  .issue-photos-row {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 12px;
    padding: 14px 20px 16px;
  }

  .issue-photo-wrap {
    border-radius: var(--radius-sm);
    background: var(--surface3);
    border: 1px solid var(--border);
  }

  .issue-photo-wrap .img-box {
    width: 100%;
    height: 160px;
    background: var(--surface3);
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  }

  .issue-photo-wrap .img-box img {
    max-width: 100%;
    max-height: 160px;
    width: auto;
    height: auto;
    display: block;
    object-fit: contain;
  }

  .issue-photo-caption {
    padding: 6px 10px;
    font-family: 'Fira Code', monospace;
    font-size: 9.5px;
    color: var(--text-muted);
    background: var(--surface);
    border-top: 1px solid var(--border-soft);
    letter-spacing: 0.04em;
  }

  .issue-photo-empty {
    height: 80px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-faint);
    font-family: 'Fira Code', monospace;
    font-size: 10px;
    text-align: center;
    padding: 12px;
  }

  .issue-photo-caption.no-work { color: var(--danger); background: var(--danger-lt); }

  /* ─── NOTES ─── */
  .notes-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 18px 22px;
    box-shadow: var(--shadow-sm);
    font-size: 14px;
    color: var(--text-mid);
    line-height: 1.7;
    border-left: 4px solid var(--accent2);
  }

  /* ─── FINAL SUBMISSIONS ─── */
  .submissions-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 14px;
    padding: 18px;
    background: var(--surface);
  }

  .sub-card {
    background: var(--surface2);
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-sm);
    box-shadow: var(--shadow-sm);
  }

  .sub-card-header {
    padding: 13px 15px;
    border-bottom: 1px solid var(--border-soft);
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 8px;
  }

  .sub-service-name { font-weight: 700; font-size: 13.5px; }
  .sub-by { font-family: 'Fira Code', monospace; font-size: 10px; color: var(--text-muted); margin-top: 2px; }

  .sub-note {
    padding: 10px 15px;
    font-size: 12.5px;
    color: var(--text-muted);
    font-family: 'Lora', serif;
    font-style: italic;
    border-bottom: 1px solid var(--border-soft);
  }

  .sub-photo-wrap {
    width: 100%;
    height: 180px;
    background: var(--surface3);
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  }

  .sub-photo {
    max-width: 100%;
    max-height: 180px;
    width: auto;
    height: auto;
    display: block;
    object-fit: contain;
  }

  .sub-photo-placeholder {
    width: 100%;
    height: 80px;
    background: var(--surface3);
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-faint);
    font-family: 'Fira Code', monospace;
    font-size: 10px;
  }

  .report-footer {
    background: var(--surface);
    border-top: 1px solid var(--border);
    padding: 18px 52px 40px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 8px;
  }

  .footer-brand { font-size: 14px; font-weight: 700; color: var(--text-muted); }
  .footer-brand span { color: var(--accent); }
  .footer-meta { font-family: 'Fira Code', monospace; font-size: 10.5px; color: var(--text-faint); }

  @media (max-width: 820px) {
    .report-header, .report-body, .report-footer { padding-left: 20px; padding-right: 20px; }
    .details-grid { grid-template-columns: 1fr 1fr; }
    .timing-strip { flex-wrap: wrap; gap: 12px; }
    .timing-connector { display: none; }
  }

  @media print {
    body { background: #fff; min-height: auto; }
    .card, .task-card, .sub-card { box-shadow: none; }
  }

  /* ─── PAGE BREAK RULES ─── */

  /* Cards never split mid-content — if not enough room, push to next page */
  .card,
  .task-card,
  .sub-card,
  .issue-block,
  .service-block,
  .notes-card {
    page-break-inside: avoid;
    break-inside: avoid;
  }

  /* Keep section label glued to its card */
  .section-label {
    page-break-after: avoid;
    break-after: avoid;
  }

  /* First section may break across pages to avoid empty space on page 1 */
  .report-body > section:first-child .card {
    page-break-inside: auto;
    break-inside: auto;
  }
      </style>
    </head>
    <body>

      <!-- ══ HEADER ══ -->
      <header class="report-header">
        <div class="header-top-bar"></div>
        <div class="brand-block">
          <div class="brand-name">${safeStr(booking.salonName || "BMS PRO BLACK")}</div>
          <div class="brand-sub">Job Task Report · BMS Pro</div>
        </div>
        <div class="header-meta">
          <div class="status-badge"><div class="status-dot"></div>Booking Completed – Ready to Pick Up</div>
          <div class="booking-code">${safeStr(booking.bookingCode || (booking.id || "").substring(0, 8))}</div>
          <div class="gen-date">Generated ${safeStr(booking.date)}</div>
        </div>
      </header>

      <!-- ══ BODY ══ -->
      <main class="report-body">

        <!-- ── BOOKING DETAILS ── -->
        <section>
          <div class="section-label">
            <div class="section-label-dot"></div>
            <h2>Booking Details</h2>
          </div>
          <div class="card">
            <div class="details-grid">
              <div class="detail-cell">
                <div class="detail-label">Booking Code</div>
                <div class="detail-value code">${safeStr(booking.bookingCode)}</div>
              </div>
              <div class="detail-cell">
                <div class="detail-label">Customer</div>
                <div class="detail-value">${safeStr(booking.client)}</div>
              </div>
              ${booking.clientEmail ? `
              <div class="detail-cell">
                <div class="detail-label">Email</div>
                <div class="detail-value">${safeStr(booking.clientEmail)}</div>
              </div>` : ""}
              ${booking.clientPhone ? `
              <div class="detail-cell">
                <div class="detail-label">Phone</div>
                <div class="detail-value">${safeStr(booking.clientPhone)}</div>
              </div>` : ""}
              ${booking.vehicleMake ? `
              <div class="detail-cell">
                <div class="detail-label">Make</div>
                <div class="detail-value">${safeStr(booking.vehicleMake)}</div>
              </div>
              <div class="detail-cell">
                <div class="detail-label">Model</div>
                <div class="detail-value">${safeStr(booking.vehicleModel)}</div>
              </div>
              <div class="detail-cell">
                <div class="detail-label">Year</div>
                <div class="detail-value">${safeStr(booking.vehicleYear)}</div>
              </div>` : ""}
              ${booking.vehicleNumber ? `
              <div class="detail-cell">
                <div class="detail-label">Registration</div>
                <div class="detail-value code">${safeStr(booking.vehicleNumber)}</div>
              </div>` : ""}
              ${booking.vehicleBodyType ? `
              <div class="detail-cell">
                <div class="detail-label">Body Type</div>
                <div class="detail-value">${safeStr(booking.vehicleBodyType)}</div>
              </div>` : ""}
              ${booking.vehicleColour ? `
              <div class="detail-cell">
                <div class="detail-label">Colour</div>
                <div class="detail-value">${safeStr(booking.vehicleColour)}</div>
              </div>` : ""}
              ${booking.branchName ? `
              <div class="detail-cell">
                <div class="detail-label">Branch</div>
                <div class="detail-value">${safeStr(booking.branchName)}</div>
              </div>` : ""}
              ${booking.vehicleVinChassis ? `
              <div class="detail-cell">
                <div class="detail-label">VIN / Chassis</div>
                <div class="detail-value code">${safeStr(booking.vehicleVinChassis)}</div>
              </div>` : ""}
              ${booking.vehicleEngineNumber ? `
              <div class="detail-cell">
                <div class="detail-label">Engine Number</div>
                <div class="detail-value code">${safeStr(booking.vehicleEngineNumber)}</div>
              </div>` : ""}
              ${booking.fuelLevel ? `
              <div class="detail-cell">
                <div class="detail-label">Fuel Level</div>
                <div class="detail-value">${safeStr(booking.fuelLevel)}</div>
              </div>` : ""}
              ${booking.existingDamageNotes ? `
              <div class="detail-cell">
                <div class="detail-label">Existing Damage</div>
                <div class="detail-value warn">${safeStr(booking.existingDamageNotes)}</div>
              </div>` : ""}
              ${booking.vehicleMileage ? `
              <div class="detail-cell">
                <div class="detail-label">Customer Mileage</div>
                <div class="detail-value warn">${safeStr(booking.vehicleMileage)}</div>
              </div>` : ""}
              ${booking.mileage ? `
              <div class="detail-cell">
                <div class="detail-label">Recorded Mileage</div>
                <div class="detail-value warn">${safeStr(booking.mileage)}</div>
              </div>` : ""}
              ${hasVehicleCheckIn && (vehicleCheckInBy || vehicleCheckInAtOk) ? `
              ${vehicleCheckInBy ? `
              <div class="detail-cell">
                <div class="detail-label">Check-In Recorded By</div>
                <div class="detail-value">${safeStr(vehicleCheckInBy)}</div>
              </div>` : ""}
              ${vehicleCheckInAtOk ? `
              <div class="detail-cell">
                <div class="detail-label">Check-In Recorded At</div>
                <div class="detail-value">${safeStr(vehicleCheckInAtFormatted)}</div>
              </div>` : ""}
              ` : ""}
              ${booking.date ? `
              <div class="detail-cell">
                <div class="detail-label">Date</div>
                <div class="detail-value">${safeStr(booking.date)}</div>
              </div>` : ""}
              ${booking.completedAt ? `
              <div class="detail-cell">
                <div class="detail-label">Completed At</div>
                <div class="detail-value">${safeStr(formatTimestampInTimezone(booking.completedAt, booking.branchTimezone))}</div>
              </div>` : ""}
              ${jobReportCompletedByLine ? `
              <div class="detail-cell">
                <div class="detail-label">Completed By</div>
                <div class="detail-value">
                  ${safeStr(jobReportCompletedByLine)}
                </div>
              </div>` : ""}
            </div>

            <div class="timing-strip">
              <div class="timing-node">
                <div class="t-label">Drop-off</div>
                <div class="t-val">${safeStr(booking.time)}</div>
                <div class="t-sub">Check-in</div>
              </div>
              <div class="timing-connector"></div>
              ${booking.duration ? `
              <div class="timing-node">
                <div class="t-label">Duration</div>
                <div class="t-val"><span class="duration-pill">${safeStr(formatDuration(booking.duration))}</span></div>
                <div class="t-sub">&nbsp;</div>
              </div>
              <div class="timing-connector"></div>` : ""}
              <div class="timing-node">
                <div class="t-label">Pick-up</div>
                <div class="t-val">${safeStr(booking.pickupTime)}</div>
                <div class="t-sub">Ready</div>
              </div>
            </div>

            ${jobReportCompletedByLine ? `
            <div class="completed-by-row">
              <span class="cb-label">Completed by</span>
              ${(booking.services || [])
                .filter(s => s.completedByStaffName)
                .map(s => `
                  <div class="staff-pill">
                    <div class="staff-avatar">${safeStr(s.completedByStaffName!.charAt(0) + (s.completedByStaffName!.length > 1 ? s.completedByStaffName!.charAt(1) : ""))}</div>
                    ${safeStr(s.completedByStaffName)}
                  </div>
                `).join("") || `
                  <div class="staff-pill">
                    <div class="staff-avatar">${safeStr(jobReportCompletedByLine.charAt(0) + (jobReportCompletedByLine.length > 1 ? jobReportCompletedByLine.charAt(1) : ""))}</div>
                    ${safeStr(jobReportCompletedByLine)}
                  </div>`}
            </div>` : ""}
          </div>
        </section>


        <!-- ── NOTES ── -->
        ${booking.notes ? `
        <section>
          <div class="section-label">
            <div class="section-label-dot"></div>
            <h2>Additional Notes</h2>
          </div>
          <div class="notes-card">${safeStr(booking.notes)}</div>
        </section>` : ""}




        <!-- ── EXISTING DAMAGE ── -->
        ${(booking.existingDamageImages || []).length > 0 ? `
        <section>
          <div class="section-label">
            <div class="section-label-dot" style="background:var(--warn)"></div>
            <h2>Existing Damage – Customer Reference</h2>
          </div>
          <div class="card">
            <div class="damage-inner">
              <div class="damage-info">
                <div class="damage-pill">⚠ ${safeStr(booking.existingDamageNotes)}</div>
                ${vehicleCheckInBy ? `<div class="damage-ts">Recorded by: ${safeStr(vehicleCheckInBy)}</div>` : ""}
                <div class="damage-ts">Recorded at: ${vehicleCheckInAtOk ? safeStr(vehicleCheckInAtFormatted) : `${safeStr(booking.date)} at ${safeStr(booking.time)}`}</div>
                <div class="damage-desc">Pre-existing damage documented at vehicle drop-off. Customer has been informed; no liability assigned for listed damage.</div>
              </div>
              ${damageImageSrcs.map((src, index) => `
                <div style="
                  width: 200px;
                  height: 180px;
                  background: var(--surface3);
                  border: 1px solid var(--border);
                  border-radius: 8px;
                  overflow: hidden;
                  display: flex;
                  flex-direction: column;
                  flex-shrink: 0;
                ">
                  <div style="
                    flex: 1;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    overflow: hidden;
                    padding: 6px;
                  ">
                    ${src
                      ? `<img src="${src}" alt="Damage Photo ${index + 1}" style="max-width:100%;max-height:100%;width:auto;height:auto;display:block;object-fit:contain;">`
                      : `<span style="font-family:'Fira Code',monospace;font-size:11px;color:var(--text-faint);">No Photo</span>`
                    }
                  </div>
                  <div style="
                    padding: 5px 10px;
                    font-family: 'Fira Code', monospace;
                    font-size: 10px;
                    color: var(--text-muted);
                    background: var(--surface);
                    border-top: 1px solid var(--border-soft);
                    text-align: center;
                  ">Photo ${index + 1}</div>
                </div>
              `).join("")}
            </div>
          </div>
        </section>` : ""}

        <!-- ── SERVICES ── -->
        ${(pdfServicesList.length > 0 || pdfBillableIssues.length > 0) ? `
        <section>
          <div class="section-label">
            <div class="section-label-dot"></div>
            <h2>Services – Collaborative Booking</h2>
          </div>
          <div class="card">
            <div class="services-list">
              ${pdfServicesList.map((svc, index) => `
                <div class="service-row">
                  <div class="svc-index">${index + 1}</div>
                  <div class="svc-name">${safeStr(svc.name || "Service")}</div>
                  <div class="svc-meta">
                    <span class="chip staff">${safeStr(svc.staffName || "N/A")}</span>
                    ${svc.completedAt ? `<span class="chip">${safeStr(formatTimestampInTimezone(svc.completedAt, booking.branchTimezone))}</span>` : ""}
                    ${svc.duration ? `<span class="chip">${safeStr(formatDuration(svc.duration))}</span>` : ""}
                    ${(svc.completionStatus || "").toLowerCase() === "completed" ? `<span class="done-badge">✓ Completed</span>` : ""}
                  </div>
                  <div class="svc-price">$${(Number(svc.price) || 0).toFixed(2)}</div>
                </div>
              `).join("")}
              ${pdfBillableIssues.map(issue => `
                <div class="service-row additional">
                  <div class="svc-index extra">+</div>
                  <div class="svc-name">
                    ${safeStr(issue.issueTitle || "Additional Work")}
                    <span style="font-size:11px;font-weight:500;color:var(--text-muted);margin-left:6px;">Customer accepted additional work</span>
                  </div>
                  <div class="svc-meta">
                    <span class="chip staff">${safeStr(issue.completedByStaffName || "N/A")}</span>
                    ${(issue.completionStatus || "").toLowerCase() === "completed" ? `<span class="done-badge">✓ Completed</span>` : ""}
                  </div>
                  <div class="svc-price" style="color:var(--accent)">$${(Number(issue.price) || 0).toFixed(2)}</div>
                </div>
              `).join("")}
            </div>
            <div class="total-bar">
              <div>
                <div class="total-label">Total Amount Due</div>
                <div class="total-sub">${pdfServicesList.length + pdfBillableIssues.length} items${pdfBillableIssues.length > 0 ? " · incl. additional work" : ""}</div>
              </div>
              <div class="total-amount">${totalAmountStr}</div>
            </div>
          </div>
        </section>` : ""}

        <!-- ── TASK DETAILS ── -->
        ${(booking.tasks || []).length > 0 ? `
        <section>
          <div class="section-label">
            <div class="section-label-dot"></div>
            <h2>Task Details</h2>
          </div>
          ${(() => {
            const tasks = booking.tasks || [];
            const services = booking.services || [];
            const tasksByService = new Map<string, any[]>();

            services.forEach(svc => {
              if (svc.id) tasksByService.set(String(svc.id), []);
            });

            const unassigned: any[] = [];
            tasks.forEach((task: any) => {
              const sid = task.serviceId ? String(task.serviceId) : "";
              if (sid && tasksByService.has(sid)) {
                tasksByService.get(sid)!.push(task);
              } else {
                unassigned.push(task);
              }
            });

            if (unassigned.length > 0) {
              const firstKey = [...tasksByService.keys()][0] || "_other";
              if (!tasksByService.has(firstKey)) tasksByService.set(firstKey, []);
              tasksByService.set(firstKey, [...tasksByService.get(firstKey)!, ...unassigned]);
            }

            const renderTaskCard = (task: any) => {
              // FIX 3: Use the pre-resolved taskImageMap instead of calling
              // getBase64Image(...) inline (which would return a Promise string).
              const imageUrl = task.imageUrl || task.image;
              const taskImg = typeof imageUrl === "string" ? imageUrl : imageUrl?.imageUrl;
              const taskImgSrc = taskImg ? (taskImageMap.get(taskImg) || "") : "";

              // Condition flag (urgent/advisory/good) set by the staff member
              // when completing the task. Mirrors the pill used in the admin
              // panel, owner app and customer booking engine.
              const condOpt = taskConditionOption(task?.condition);
              const condHtml = condOpt
                ? `<span class="cond-pill cond-${condOpt.value}"><span class="cond-dot"></span>${safeStr(condOpt.label)}</span>`
                : "";

              return `
<div class="task-card ${!taskImgSrc ? 'task-card-noimage' : ''}">
  <div class="task-card-top">
    <div class="task-name">${safeStr(task.name || "Task")}</div>
    <div class="task-done ${task.done ? 'status-done' : 'status-pending'}">${task.done ? "Done" : "Pending"}</div>
  </div>
  ${task.description ? `<div class="task-desc">${safeStr(task.description)}</div>` : ""}
  ${condHtml}
  ${task.staffNote ? `
    <div class="staff-note">
      <div class="note-label">Staff Note</div>
      <div class="note-text">${safeStr(task.staffNote)}</div>
      <div class="note-meta">
        — ${safeStr(task.completedByStaffName || "Staff")}
        ${task.completedAt ? `, ${safeStr(formatTimestampInTimezone(task.completedAt, booking.branchTimezone))}` : ""}
      </div>
    </div>` : ""}
  ${task.done && taskImgSrc ? `
    <div class="task-photo-wrap">
      <img class="task-photo" src="${taskImgSrc}" alt="Task photo">
    </div>` : ""}
</div>`;
            };

            return [...tasksByService.entries()].map(([sid, serviceTasks]) => {
              if (!serviceTasks.length) return "";

              const svc: any = services.find(s => String(s.id) === sid) || {};
              const svcName = svc.name || "Service";
              const staffName = svc.staffName || "N/A";
              const done = serviceTasks.filter((t: any) => t.done).length;
              const total = serviceTasks.length;
              const pct = total > 0 ? Math.round((done / total) * 100) : 0;

              // Resolve the owner-defined area order for this service, falling
              // back to the default Interior → Engine Bay → Underbody → Exterior
              // sequence when no order has been customised.
              const resolvedOrder: ChecklistSection[] =
                Array.isArray(svc.areaOrder) && svc.areaOrder.length > 0
                  ? normalizeAreaOrder(svc.areaOrder)
                  : [...DEFAULT_AREA_ORDER];

              // Bucket tasks by section, preserving insertion order within each.
              const buckets = new Map<ChecklistSection, any[]>();
              for (const s of resolvedOrder) buckets.set(s, []);
              const unsectioned: any[] = [];
              for (const t of serviceTasks) {
                if (isChecklistSection(t?.section) && buckets.has(t.section)) {
                  buckets.get(t.section)!.push(t);
                } else {
                  unsectioned.push(t);
                }
              }

              // Only render an area block if it has at least one task. Legacy
              // tasks without a section fall through to a tail "Other" group.
              const areaBlocks: string[] = [];
              for (const s of resolvedOrder) {
                const items = buckets.get(s) || [];
                if (items.length === 0) continue;
                const segDone = items.filter((t: any) => t.done).length;
                areaBlocks.push(`
                <div class="area-group">
                  <div class="area-group-header">
                    <span class="area-dot"></span>
                    <span class="area-title">${safeStr(CHECKLIST_SECTION_LABELS[s])}</span>
                    <span class="area-count">${segDone}/${items.length}</span>
                  </div>
                  <div class="tasks-grid">
                    ${items.map(renderTaskCard).join("")}
                  </div>
                </div>`);
              }
              if (unsectioned.length > 0) {
                const segDone = unsectioned.filter((t: any) => t.done).length;
                areaBlocks.push(`
                <div class="area-group">
                  <div class="area-group-header">
                    <span class="area-dot"></span>
                    <span class="area-title">Other</span>
                    <span class="area-count">${segDone}/${unsectioned.length}</span>
                  </div>
                  <div class="tasks-grid">
                    ${unsectioned.map(renderTaskCard).join("")}
                  </div>
                </div>`);
              }

              return `
              <div class="service-block">
                <div class="service-block-header">
                  <div>
                    <div class="sbh-title">${safeStr(svcName)}</div>
                    <div class="sbh-staff">Staff: ${safeStr(staffName)}</div>
                  </div>
                  <div class="progress-wrap">
                    <div class="progress-track">
                      <div class="progress-fill" style="width:${pct}%"></div>
                    </div>
                    <span class="progress-text">${done}/${total} · ${pct}%</span>
                  </div>
                </div>
                <div class="tasks-body">
                  ${areaBlocks.join("")}
                </div>
              </div>`;
            }).join("");
          })()}
        </section>` : ""}

        <!-- ── ADDITIONAL ISSUES ── -->
        ${(booking.additionalIssues || []).length > 0 ? `
        <section>
          <div class="section-label">
            <div class="section-label-dot" style="background:var(--warn)"></div>
            <h2>Additional Issues Found – Technician Reported</h2>
          </div>
          <div class="card">
            <div style="padding:10px 20px;background:var(--surface2);border-bottom:1px solid var(--border-soft);">
              <span style="font-family:'Fira Code',monospace;font-size:10.5px;color:var(--text-muted);">
                ${(booking.additionalIssues || []).filter(i => i.status === "approved" && i.customerResponse === "accept" && i.completionStatus === "completed").length}
                of ${(booking.additionalIssues || []).filter(i => i.status === "approved").length} issues accepted &amp; completed
              </span>
            </div>
            <div class="issues-container">
              ${(booking.additionalIssues || []).filter(i => i.status === "approved").map(issue => {
                const isAccepted = issue.customerResponse === "accept";
                const isRejected = issue.customerResponse === "reject";

                // FIX 4: Use the pre-resolved issueImageMap instead of calling
                // getBase64Image(...) inline without await.
                const requestImg = issue.imageUrl
                  ? (typeof issue.imageUrl === "string" ? issue.imageUrl : (issue.imageUrl as any).imageUrl)
                  : null;
                const completionImg = issue.completionImageUrl
                  ? (typeof issue.completionImageUrl === "string" ? issue.completionImageUrl : (issue.completionImageUrl as any).imageUrl)
                  : null;

                const requestImgSrc = requestImg ? (issueImageMap.get(requestImg) || "") : "";
                const completionImgSrc = completionImg ? (issueImageMap.get(completionImg) || "") : "";

                return `
                <div class="issue-block ${isAccepted ? "accepted" : "rejected"}">
                  <div class="issue-main">
                    <div class="issue-status-badge ${isAccepted ? "accepted" : "rejected"}">
                      ${isAccepted ? "✓ Accepted" : "✕ Rejected"}
                    </div>
                    <div class="issue-content">
                      <div class="issue-title">${safeStr(issue.issueTitle || "Issue")}</div>
                      <div class="issue-chips">
                        ${issue.recommendedRepair ? `<span class="chip">Repair: ${safeStr(issue.recommendedRepair)}</span>` : ""}
                        ${issue.partsRequired ? `<span class="chip">Parts: ${safeStr(issue.partsRequired)}</span>` : ""}
                        ${issue.labourTimeHours ? `<span class="chip">${issue.labourTimeHours} hrs</span>` : ""}
                        <span class="chip staff">${safeStr(issue.reportedByStaffName || "N/A")}</span>
                      </div>
                      ${issue.description ? `<div class="issue-note">${safeStr(issue.description)}</div>` : ""}
                      <div class="issue-outcome ${isAccepted ? "accepted" : "rejected"}">
                        ${isAccepted
                          ? `✓ Customer accepted · Completed by ${safeStr(issue.completedByStaffName || issue.reportedByStaffName || "")}`
                          : `✕ Customer rejected – work not carried out`}
                      </div>
                    </div>
                    <div class="issue-price-col ${isRejected ? "rejected" : ""}">
                      $${(Number(issue.price) || 0).toFixed(2)}
                    </div>
                  </div>
                  <div class="issue-photos-section">
                    <div class="issue-photos-header">
                      <div class="issue-photos-header-label">Issue Photos</div>
                    </div>
                    <div class="issue-photos-row">
                      <div class="issue-photo-wrap">
                        ${requestImgSrc
                          ? `<div class="img-box"><img src="${requestImgSrc}" alt="Issue photo"></div>`
                          : `<div class="issue-photo-empty">No Photo</div>`}
                        <div class="issue-photo-caption">📷 Reported by ${safeStr(issue.reportedByStaffName || "")}</div>
                      </div>
                      <div class="issue-photo-wrap">
                        ${isAccepted && completionImgSrc
                          ? `<div class="img-box"><img src="${completionImgSrc}" alt="Completion photo"></div>
                             <div class="issue-photo-caption">✓ After completion · ${safeStr(issue.completedByStaffName || "")}</div>`
                          : `<div class="issue-photo-empty">${isRejected ? "Work not completed" : "No completion photo"}</div>
                             <div class="issue-photo-caption no-work">${isRejected ? "✕ Rejected – no completion photo" : ""}</div>`}
                      </div>
                    </div>
                  </div>
                </div>`;
              }).join("")}
            </div>
          </div>
        </section>` : ""}

        <!-- ── FINAL SUBMISSIONS ── -->
        ${(() => {
          const byService = booking.finalSubmissionsByService as Record<string, any> | undefined;
          const finalSubsToRender: Array<{ serviceName?: string; fs: any }> = [];

          if (byService && typeof byService === "object" && Object.keys(byService).length > 0) {
            const svcs = booking.services || [];
            for (const [sid, sub] of Object.entries(byService)) {
              if (!sub || typeof sub !== "object") continue;
              const svc = svcs.find((s: any) => String(s?.id) === String(sid));
              finalSubsToRender.push({ serviceName: (svc as any)?.name || "Service", fs: sub });
            }
          }
          if (finalSubsToRender.length === 0 && booking.finalSubmission) {
            finalSubsToRender.push({ fs: booking.finalSubmission });
          }

          if (finalSubsToRender.length === 0) return "";

          return `
          <section>
            <div class="section-label">
              <div class="section-label-dot"></div>
              <h2>Final Submissions</h2>
            </div>
            <div class="card">
              <div class="submissions-grid">
                ${finalSubsToRender.map(({ serviceName, fs }) => {
                  const fsImageUrl = (fs as any)?.imageUrl || (fs as any)?.image;
                  const fsImgSrc = fsImageUrl ? (finalSubmissionImageMap.get(fsImageUrl) || "") : "";
                  const submittedBy = (fs as any)?.submittedByStaffName || (fs as any)?.staffName || "";
                  const submittedAt = (fs as any)?.submittedAt
                    ? formatTimestampInTimezone((fs as any).submittedAt, booking.branchTimezone)
                    : "";
                  const description = (fs as any)?.description || (fs as any)?.note || "";

                  return `
                 <div class="sub-card ${!fsImgSrc ? 'sub-card-noimage' : ''}">
  <div class="sub-card-header">
    <div>
      <div class="sub-service-name">${safeStr(serviceName || "Final Submission")}</div>
      ${(submittedBy || submittedAt) ? `
      <div class="sub-by">${safeStr(submittedBy)}${submittedBy && submittedAt ? " · " : ""}${safeStr(submittedAt)}</div>` : ""}
    </div>
    <span class="done-badge">✓ Done</span>
  </div>
  ${description ? `<div class="sub-note">${safeStr(description)}</div>` : ""}
  ${fsImgSrc
    ? `<div class="sub-photo-wrap"><img class="sub-photo" src="${fsImgSrc}" alt="Final submission photo"></div>`
    : ""}
</div>`;
                }).join("")}
              </div>
            </div>
          </section>`;
        })()}

    
      </main>

      <!-- ══ FOOTER ══ -->
      <footer class="report-footer">
        <div class="footer-brand">${safeStr(booking.salonName || "BMS PRO BLACK")} · <span>Powered by BMS PRO</span></div>
        <div class="footer-meta">Generated ${safeStr(booking.date)} · Branch: ${safeStr(booking.branchName || "N/A")}</div>
      </footer>

    </body>
    </html>
  `;
}

/** Vercel, AWS Lambda, Netlify, etc. — no system Chrome; use bundled serverless Chromium. */
function isServerlessPdfEnvironment(): boolean {
  const awsExec = process.env.AWS_EXECUTION_ENV || "";
  return (
    process.env.VERCEL === "1" ||
    !!process.env.AWS_LAMBDA_FUNCTION_NAME ||
    awsExec.startsWith("AWS_Lambda") ||
    !!process.env.NETLIFY
  );
}

/** Local/Docker: resolve Chrome/Chromium on disk (not used on Vercel — see `launchBrowserForPdf`). */
function resolveChromiumExecutableSync(): string {
  const fromEnv = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;

  if (process.platform === "darwin") {
    const candidates = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ];
    for (const p of candidates) {
      if (existsSync(p)) return p;
    }
  }

  if (process.platform === "linux") {
    const candidates = [
      process.env.CHROME_BIN,
      "/usr/bin/google-chrome-stable",
      "/usr/bin/google-chrome",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
    ].filter(Boolean) as string[];
    for (const p of candidates) {
      if (existsSync(p)) return p;
    }
  }

  if (process.platform === "win32") {
    const pf = process.env["ProgramFiles"] || "C:\\Program Files";
    const pfx86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    const candidates = [
      `${pf}\\Google\\Chrome\\Application\\chrome.exe`,
      `${pfx86}\\Google\\Chrome\\Application\\chrome.exe`,
      `${pf}\\Microsoft\\Edge\\Application\\msedge.exe`,
    ];
    for (const p of candidates) {
      if (existsSync(p)) return p;
    }
  }

  throw new Error(
    "PDF generation requires Chrome or Chromium. Install Google Chrome, or set PUPPETEER_EXECUTABLE_PATH to the browser binary."
  );
}

async function launchBrowserForPdf() {
  const fromEnv = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH;
  if (fromEnv && existsSync(fromEnv)) {
    return puppeteer.launch({
      headless: true,
      executablePath: fromEnv,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--font-render-hinting=none"],
    });
  }

  if (isServerlessPdfEnvironment()) {
    const chromium = (await import("@sparticuz/chromium")).default;
    const executablePath = await chromium.executablePath();
    return puppeteer.launch({
      args: puppeteer.defaultArgs({ args: chromium.args, headless: "shell" }),
      defaultViewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
      executablePath,
      headless: "shell",
    });
  }

  return puppeteer.launch({
    headless: true,
    executablePath: resolveChromiumExecutableSync(),
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--font-render-hinting=none"],
  });
}

async function buildPDF(
  booking: BookingPDFData,
  getImageBuffer: (url: string) => Buffer | undefined
): Promise<Buffer> {
  const html = await buildHTML(booking, getImageBuffer);

  const browser = await launchBrowserForPdf();

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });

    const generatedAt = booking.branchTimezone
      ? formatInTimezone(new Date().toISOString(), booking.branchTimezone, "d/MM/yyyy, h:mm:ss a")
      : new Date().toLocaleString("en-AU");

    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: `<div></div>`,
      footerTemplate: `
        <div style="
          font-family: 'Fira Code', monospace;
          font-size: 12px;
          color: #7d7d7d;
          width: 100%;
          padding: 0 36px;
          text-align: center;
        ">
          Generated ${generatedAt} • ${booking.salonName || "BMS PRO BLACK"} • Powered by BMS PRO
        </div>
      `,
      margin: { top: "36px", right: "36px", bottom: "90px", left: "36px" },
    });

    return Buffer.from(pdfBuffer);
  } finally {
    await browser.close();
  }
}
