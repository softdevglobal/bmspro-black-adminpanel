import "server-only";

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import {
  DOCUMENT_KIND_META,
  documentAddressLine,
  documentBusinessContact,
  documentGstTaxableBase,
  documentLineDiscountAud,
  documentLineNet,
  formatDocumentAud,
  formatDocumentDateHuman,
  normalizeDocumentKind,
  salesDocumentPdfFilename,
  type DocumentData,
  type DocumentKindAlias,
  type DocumentLineItem,
} from "@/lib/documentData";

/** A4 in points */
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN_X = 40;
const MARGIN_TOP = 36;
const MARGIN_BOTTOM = 48;
const CONTENT_W = PAGE_W - MARGIN_X * 2;

type Rgb = { r: number; g: number; b: number };

function hexToRgb(hex: string): Rgb {
  const h = hex.replace("#", "");
  return {
    r: parseInt(h.slice(0, 2), 16) / 255,
    g: parseInt(h.slice(2, 4), 16) / 255,
    b: parseInt(h.slice(4, 6), 16) / 255,
  };
}

function color(c: Rgb) {
  return rgb(c.r, c.g, c.b);
}

type DrawCtx = {
  doc: PDFDocument;
  page: PDFPage;
  font: PDFFont;
  fontBold: PDFFont;
  y: number;
  accent: Rgb;
  accentLt: Rgb;
  text: Rgb;
  textMid: Rgb;
  textMuted: Rgb;
  border: Rgb;
  surface2: Rgb;
};

/** StandardFonts (Helvetica) are WinAnsi — strip characters they cannot encode. */
function toWinAnsi(text: string): string {
  return String(text ?? "")
    .replace(/\u2212/g, "-") // minus sign
    .replace(/\u2013|\u2014/g, "-") // en/em dash
    .replace(/\u2026/g, "...") // ellipsis
    .replace(/\u2022/g, "-") // bullet
    .replace(/\u00A0/g, " ") // nbsp
    .replace(/[^\x00-\x7E\xA0-\xFF]/g, "?");
}

function ensureSpace(ctx: DrawCtx, needed: number) {
  if (ctx.y - needed >= MARGIN_BOTTOM) return;
  ctx.page = ctx.doc.addPage([PAGE_W, PAGE_H]);
  ctx.y = PAGE_H - MARGIN_TOP;
  // Thin accent bar on continuation pages
  ctx.page.drawRectangle({
    x: 0,
    y: PAGE_H - 4,
    width: PAGE_W,
    height: 4,
    color: color(ctx.accent),
  });
  ctx.y -= 12;
}

function drawText(
  ctx: DrawCtx,
  text: string,
  x: number,
  y: number,
  opts: { size?: number; bold?: boolean; c?: Rgb; maxWidth?: number } = {}
) {
  const size = opts.size ?? 10;
  const font = opts.bold ? ctx.fontBold : ctx.font;
  const original = toWinAnsi(text || "");
  let value = original;
  if (opts.maxWidth) {
    while (value.length > 1 && font.widthOfTextAtSize(value, size) > opts.maxWidth) {
      value = value.slice(0, -1);
    }
    if (value !== original && value.length > 1) value = `${value.slice(0, -1)}...`;
  }
  ctx.page.drawText(value, {
    x,
    y,
    size,
    font,
    color: color(opts.c ?? ctx.text),
  });
}

function wrapLines(
  font: PDFFont,
  text: string,
  size: number,
  maxWidth: number
): string[] {
  const raw = toWinAnsi(text || "")
    .replace(/\r\n/g, "\n")
    .split("\n");
  const lines: string[] = [];
  for (const paragraph of raw) {
    if (!paragraph.trim()) {
      lines.push("");
      continue;
    }
    const words = paragraph.split(/\s+/);
    let current = "";
    for (const word of words) {
      const next = current ? `${current} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) <= maxWidth) {
        current = next;
      } else {
        if (current) lines.push(current);
        current = word;
        while (font.widthOfTextAtSize(current, size) > maxWidth && current.length > 1) {
          lines.push(current.slice(0, -1));
          current = current.slice(-1);
        }
      }
    }
    if (current) lines.push(current);
  }
  return lines.length ? lines : [""];
}

function drawSectionLabel(ctx: DrawCtx, label: string) {
  ensureSpace(ctx, 28);
  const size = 9;
  drawText(ctx, label.toUpperCase(), MARGIN_X + 14, ctx.y - 10, {
    size,
    bold: true,
    c: ctx.textMuted,
  });
  ctx.page.drawRectangle({
    x: MARGIN_X,
    y: ctx.y - 12,
    width: 8,
    height: 8,
    color: color(ctx.accent),
  });
  const labelW = ctx.fontBold.widthOfTextAtSize(label.toUpperCase(), size);
  ctx.page.drawLine({
    start: { x: MARGIN_X + 14 + labelW + 8, y: ctx.y - 8 },
    end: { x: MARGIN_X + CONTENT_W, y: ctx.y - 8 },
    thickness: 0.6,
    color: color(ctx.border),
  });
  ctx.y -= 24;
}

function drawHeader(ctx: DrawCtx, data: DocumentData) {
  const meta = DOCUMENT_KIND_META[data.kind];
  ctx.page.drawRectangle({
    x: 0,
    y: PAGE_H - 4,
    width: PAGE_W,
    height: 4,
    color: color(ctx.accent),
  });

  const businessContact = documentBusinessContact(data.business);
  drawText(ctx, data.business.name || "Workshop", MARGIN_X, PAGE_H - 40, {
    size: 18,
    bold: true,
  });
  drawText(ctx, meta.tagline, MARGIN_X, PAGE_H - 54, {
    size: 8,
    c: ctx.textMuted,
  });
  if (businessContact) {
    drawText(ctx, businessContact, MARGIN_X, PAGE_H - 68, {
      size: 8,
      c: ctx.textMid,
      maxWidth: CONTENT_W * 0.55,
    });
  }

  const rightX = MARGIN_X + CONTENT_W;
  const badge = meta.docLabel.toUpperCase();
  const badgeW = ctx.fontBold.widthOfTextAtSize(badge, 8) + 20;
  ctx.page.drawRectangle({
    x: rightX - badgeW,
    y: PAGE_H - 48,
    width: badgeW,
    height: 18,
    color: color(ctx.accentLt),
    borderColor: color(ctx.accent),
    borderWidth: 1,
  });
  drawText(ctx, badge, rightX - badgeW + 10, PAGE_H - 43, {
    size: 8,
    bold: true,
    c: ctx.accent,
  });

  const codeLabel = `${meta.docLabel} No.`;
  const codeLabelW = ctx.font.widthOfTextAtSize(codeLabel, 8);
  drawText(ctx, codeLabel, rightX - codeLabelW, PAGE_H - 64, {
    size: 8,
    c: ctx.textMuted,
  });
  const code = data.code || "DRAFT";
  const codeW = ctx.fontBold.widthOfTextAtSize(code, 14);
  drawText(ctx, code, rightX - codeW, PAGE_H - 82, {
    size: 14,
    bold: true,
    c: ctx.accent,
  });

  ctx.y = PAGE_H - 100;
}

function drawParties(ctx: DrawCtx, data: DocumentData) {
  const meta = DOCUMENT_KIND_META[data.kind];
  drawSectionLabel(ctx, data.kind === "invoice" ? "Invoice For" : "Prepared For");
  ensureSpace(ctx, 110);

  const colW = (CONTENT_W - 12) / 2;
  const boxH = 78;
  const boxY = ctx.y - boxH;

  // Bill to
  ctx.page.drawRectangle({
    x: MARGIN_X,
    y: boxY,
    width: colW,
    height: boxH,
    borderColor: color(ctx.border),
    borderWidth: 0.8,
  });
  drawText(ctx, "BILL TO", MARGIN_X + 10, ctx.y - 14, {
    size: 7,
    bold: true,
    c: ctx.textMuted,
  });
  drawText(ctx, data.customer.fullName || "—", MARGIN_X + 10, ctx.y - 28, {
    size: 11,
    bold: true,
    maxWidth: colW - 20,
  });
  let ty = ctx.y - 42;
  for (const line of [
    data.customer.email,
    data.customer.phone,
    documentAddressLine(data.address),
  ].filter(Boolean)) {
    drawText(ctx, line, MARGIN_X + 10, ty, {
      size: 8,
      c: ctx.textMid,
      maxWidth: colW - 20,
    });
    ty -= 11;
  }

  // From
  const fromX = MARGIN_X + colW + 12;
  ctx.page.drawRectangle({
    x: fromX,
    y: boxY,
    width: colW,
    height: boxH,
    borderColor: color(ctx.border),
    borderWidth: 0.8,
  });
  drawText(ctx, "FROM", fromX + 10, ctx.y - 14, {
    size: 7,
    bold: true,
    c: ctx.textMuted,
  });
  drawText(ctx, data.business.name || "—", fromX + 10, ctx.y - 28, {
    size: 11,
    bold: true,
    maxWidth: colW - 20,
  });
  ty = ctx.y - 42;
  for (const line of [data.business.email, data.business.phone].filter(Boolean) as string[]) {
    drawText(ctx, line, fromX + 10, ty, {
      size: 8,
      c: ctx.textMid,
      maxWidth: colW - 20,
    });
    ty -= 11;
  }

  ctx.y = boxY - 10;

  // Meta row
  ensureSpace(ctx, 42);
  const metaH = 36;
  const metaY = ctx.y - metaH;
  const cellW = CONTENT_W / 3;
  const cells = [
    { label: meta.dateLabel, value: formatDocumentDateHuman(data.documentDate) },
    { label: meta.dueLabel, value: formatDocumentDateHuman(data.dueDate) },
    { label: "Payment Terms", value: data.paymentTermsLabel || "—" },
  ];
  cells.forEach((cell, i) => {
    const x = MARGIN_X + i * cellW;
    ctx.page.drawRectangle({
      x,
      y: metaY,
      width: cellW,
      height: metaH,
      borderColor: color(ctx.border),
      borderWidth: 0.8,
    });
    drawText(ctx, cell.label.toUpperCase(), x + 8, ctx.y - 12, {
      size: 7,
      bold: true,
      c: ctx.textMuted,
    });
    drawText(ctx, cell.value, x + 8, ctx.y - 26, {
      size: 10,
      bold: true,
      maxWidth: cellW - 16,
    });
  });
  ctx.y = metaY - 16;
}

function drawJob(ctx: DrawCtx, data: DocumentData) {
  if (!data.jobTitle && !data.jobDescription) return;
  drawSectionLabel(ctx, "Job Details");
  const titleLines = data.jobTitle
    ? wrapLines(ctx.fontBold, data.jobTitle, 11, CONTENT_W - 20)
    : [];
  const descLines = data.jobDescription
    ? wrapLines(ctx.font, data.jobDescription, 9, CONTENT_W - 20)
    : [];
  const boxH = 16 + titleLines.length * 14 + descLines.length * 12 + 8;
  ensureSpace(ctx, boxH + 8);
  const boxY = ctx.y - boxH;
  ctx.page.drawRectangle({
    x: MARGIN_X,
    y: boxY,
    width: CONTENT_W,
    height: boxH,
    borderColor: color(ctx.border),
    borderWidth: 0.8,
  });
  let y = ctx.y - 16;
  for (const line of titleLines) {
    drawText(ctx, line, MARGIN_X + 10, y, { size: 11, bold: true });
    y -= 14;
  }
  for (const line of descLines) {
    drawText(ctx, line, MARGIN_X + 10, y, { size: 9, c: ctx.textMid });
    y -= 12;
  }
  ctx.y = boxY - 16;
}

type Col = { key: string; label: string; width: number; align: "left" | "right" };

const COLS: Col[] = [
  { key: "#", label: "#", width: 22, align: "left" },
  { key: "item", label: "Item", width: 190, align: "left" },
  { key: "qty", label: "Qty", width: 36, align: "right" },
  { key: "rate", label: "Rate", width: 62, align: "right" },
  { key: "disc", label: "Disc", width: 58, align: "right" },
  { key: "gst", label: "GST", width: 40, align: "right" },
  { key: "amt", label: "Amount", width: 68, align: "right" },
];

function drawItemsTable(ctx: DrawCtx, data: DocumentData) {
  drawSectionLabel(ctx, "Items");
  const headerH = 22;

  const drawTableHeader = () => {
    ensureSpace(ctx, headerH + 20);
    ctx.page.drawRectangle({
      x: MARGIN_X,
      y: ctx.y - headerH,
      width: CONTENT_W,
      height: headerH,
      color: color(ctx.surface2),
      borderColor: color(ctx.border),
      borderWidth: 0.6,
    });
    let x = MARGIN_X;
    for (const col of COLS) {
      const labelW = ctx.font.widthOfTextAtSize(col.label.toUpperCase(), 7);
      const tx =
        col.align === "right" ? x + col.width - labelW - 6 : x + 6;
      drawText(ctx, col.label.toUpperCase(), tx, ctx.y - 14, {
        size: 7,
        bold: true,
        c: ctx.textMuted,
      });
      x += col.width;
    }
    ctx.y -= headerH;
  };

  drawTableHeader();

  const items = data.lineItems.length
    ? data.lineItems
    : ([
        {
          code: "",
          name: "No items",
          description: "",
          quantity: 0,
          rate: 0,
          discountPercent: 0,
          applyGst: false,
        },
      ] as DocumentLineItem[]);

  items.forEach((item, index) => {
    const nameLines = wrapLines(ctx.fontBold, item.name || "—", 9, COLS[1].width - 12);
    const codeLine = item.code ? ` ${item.code}` : "";
    const descLines = item.description
      ? wrapLines(ctx.font, item.description, 8, COLS[1].width - 12)
      : [];
    const rowH = Math.max(28, 10 + nameLines.length * 11 + (codeLine ? 10 : 0) + descLines.length * 10);

    if (ctx.y - rowH < MARGIN_BOTTOM + 40) {
      ctx.page = ctx.doc.addPage([PAGE_W, PAGE_H]);
      ctx.y = PAGE_H - MARGIN_TOP;
      ctx.page.drawRectangle({
        x: 0,
        y: PAGE_H - 4,
        width: PAGE_W,
        height: 4,
        color: color(ctx.accent),
      });
      ctx.y -= 12;
      drawTableHeader();
    }

    const rowY = ctx.y - rowH;
    ctx.page.drawRectangle({
      x: MARGIN_X,
      y: rowY,
      width: CONTENT_W,
      height: rowH,
      borderColor: color(ctx.border),
      borderWidth: 0.5,
    });

    const discAud = documentLineDiscountAud(item);
    const gstLabel =
      data.gstEnabled && item.applyGst ? `${data.gstPercentage}%` : "-";
    const cells: Record<string, string> = {
      "#": String(index + 1),
      qty: String(item.quantity),
      rate: formatDocumentAud(item.rate),
      disc: discAud > 0 ? `-${formatDocumentAud(discAud)}` : "-",
      gst: gstLabel,
      amt: formatDocumentAud(documentLineNet(item)),
    };

    let x = MARGIN_X;
    for (const col of COLS) {
      if (col.key === "item") {
        let ty = ctx.y - 12;
        for (const line of nameLines) {
          drawText(ctx, line, x + 6, ty, { size: 9, bold: true, maxWidth: col.width - 12 });
          ty -= 11;
        }
        if (item.code) {
          drawText(ctx, item.code, x + 6, ty, {
            size: 7,
            c: ctx.textMuted,
            maxWidth: col.width - 12,
          });
          ty -= 10;
        }
        for (const line of descLines) {
          drawText(ctx, line, x + 6, ty, {
            size: 8,
            c: ctx.textMid,
            maxWidth: col.width - 12,
          });
          ty -= 10;
        }
      } else {
        const value = toWinAnsi(cells[col.key] || "");
        const tw = ctx.font.widthOfTextAtSize(value, 8);
        const tx = col.align === "right" ? x + col.width - tw - 6 : x + 6;
        drawText(ctx, value, tx, ctx.y - 12, {
          size: 8,
          bold: col.key === "amt",
          c: col.key === "#" ? ctx.textMuted : ctx.text,
        });
      }
      x += col.width;
    }
    ctx.y = rowY;
  });

  ctx.y -= 16;
}

function drawTotals(ctx: DrawCtx, data: DocumentData) {
  const meta = DOCUMENT_KIND_META[data.kind];
  const boxW = 220;
  const rows: { label: string; value: string; strong?: boolean }[] = [
    { label: "Subtotal", value: formatDocumentAud(data.subtotalAud) },
  ];
  if (data.discountAud > 0) {
    rows.push({ label: "Discount", value: `-${formatDocumentAud(data.discountAud)}` });
  }
  if (data.gstEnabled) {
    const taxable = documentGstTaxableBase(data);
    const gstLabel = `GST (${data.gstPercentage}%)${
      data.gstPricing === "inclusive" ? " · incl." : ""
    }${data.discountAud > 0 ? ` on ${formatDocumentAud(taxable)}` : ""}`;
    rows.push({ label: gstLabel, value: formatDocumentAud(data.gstAud) });
  }

  const showDeposit =
    data.kind === "quotation" &&
    data.depositRequested === true &&
    (data.depositAud ?? 0) > 0;
  const showPayment =
    data.kind === "invoice" &&
    (data.paymentRecorded === true || (data.amountPaidAud ?? 0) > 0) &&
    (data.amountPaidAud ?? 0) > 0;

  const depositDueLabel = showDeposit && data.depositDueDate ? 1 : 0;
  const paymentDueLabel = showPayment && data.balanceDueDate ? 1 : 0;
  // Payment uses a taller Balance due bar (~1.6 rows) plus Amount paid.
  const extraRows =
    (showDeposit ? 1 + depositDueLabel : 0) + (showPayment ? 2.6 + paymentDueLabel : 0);
  const needed = 20 + rows.length * 16 + 36 + extraRows * 16;
  ensureSpace(ctx, needed);

  const x0 = MARGIN_X + CONTENT_W - boxW;
  let y = ctx.y;
  for (const row of rows) {
    drawText(ctx, row.label, x0, y - 12, { size: 9, c: ctx.textMid, maxWidth: boxW - 80 });
    const value = toWinAnsi(row.value);
    const vw = ctx.fontBold.widthOfTextAtSize(value, 9);
    drawText(ctx, value, x0 + boxW - vw, y - 12, { size: 9, bold: true });
    y -= 16;
  }

  // Grand total bar
  y -= 4;
  ctx.page.drawRectangle({
    x: x0,
    y: y - 28,
    width: boxW,
    height: 28,
    color: rgb(0.11, 0.1, 0.09),
  });
  const totalLabel = showPayment ? "Total" : meta.totalLabel;
  drawText(ctx, totalLabel.toUpperCase(), x0 + 10, y - 18, {
    size: 7,
    bold: true,
    c: { r: 1, g: 1, b: 1 },
  });
  // Use near-white for contrast on dark bar
  const totalStr = toWinAnsi(formatDocumentAud(data.totalAud));
  const tw = ctx.fontBold.widthOfTextAtSize(totalStr, 12);
  ctx.page.drawText(totalStr, {
    x: x0 + boxW - tw - 10,
    y: y - 20,
    size: 12,
    font: ctx.fontBold,
    color: rgb(1, 1, 1),
  });
  y -= 36;

  if (showDeposit || showPayment) {
    // drawTotals tracks position in local `y`; sync before page-break checks
    // so payment/deposit rows are not drawn below the bottom margin.
    ctx.y = y;
    const followRows =
      (showDeposit ? 1 + (data.depositDueDate ? 1 : 0) : 0) +
      (showPayment ? 1 + 1.6 + (data.balanceDueDate ? 1 : 0) : 0);
    ensureSpace(ctx, followRows * 16 + 12);
    y = ctx.y;
  }

  if (showDeposit) {
    const depositLabel =
      data.depositMode === "percent" && (data.depositValue ?? 0) > 0
        ? `Deposit requested (${Math.min(100, data.depositValue ?? 0)}%)`
        : "Deposit requested";
    drawText(ctx, depositLabel, x0, y - 12, { size: 9, c: ctx.textMid, maxWidth: boxW - 80 });
    const dv = toWinAnsi(formatDocumentAud(data.depositAud ?? 0));
    drawText(ctx, dv, x0 + boxW - ctx.fontBold.widthOfTextAtSize(dv, 9), y - 12, {
      size: 9,
      bold: true,
    });
    y -= 16;
    if (data.depositDueDate) {
      const dueStr = toWinAnsi(formatDocumentDateHuman(data.depositDueDate));
      drawText(ctx, "Deposit due", x0, y - 12, { size: 9, c: ctx.textMid });
      drawText(ctx, dueStr, x0 + boxW - ctx.fontBold.widthOfTextAtSize(dueStr, 9), y - 12, {
        size: 9,
        bold: true,
      });
      y -= 16;
    }
  }

  if (showPayment) {
    const paid = toWinAnsi(formatDocumentAud(data.amountPaidAud ?? 0));
    drawText(ctx, "Amount paid", x0, y - 12, { size: 9, c: ctx.textMid });
    drawText(ctx, paid, x0 + boxW - ctx.fontBold.widthOfTextAtSize(paid, 9), y - 12, {
      size: 9,
      bold: true,
    });
    y -= 16;

    const due = toWinAnsi(
      formatDocumentAud(
        data.balanceDueAud ?? Math.max(0, data.totalAud - (data.amountPaidAud ?? 0))
      )
    );
    // Strong callout bar so Balance due stands out like the Total row.
    const barH = 26;
    ctx.page.drawRectangle({
      x: x0,
      y: y - barH,
      width: boxW,
      height: barH,
      color: rgb(0.71, 0.33, 0.04),
    });
    drawText(ctx, "BALANCE DUE", x0 + 10, y - 17, {
      size: 7,
      bold: true,
      c: { r: 1, g: 0.97, b: 0.93 },
    });
    const dueW = ctx.fontBold.widthOfTextAtSize(due, 11);
    ctx.page.drawText(due, {
      x: x0 + boxW - dueW - 10,
      y: y - 18,
      size: 11,
      font: ctx.fontBold,
      color: rgb(1, 1, 1),
    });
    y -= barH + 4;

    if (data.balanceDueDate) {
      const dueStr = toWinAnsi(formatDocumentDateHuman(data.balanceDueDate));
      drawText(ctx, "Balance due date", x0, y - 12, { size: 9, c: ctx.textMid });
      drawText(ctx, dueStr, x0 + boxW - ctx.fontBold.widthOfTextAtSize(dueStr, 9), y - 12, {
        size: 9,
        bold: true,
      });
      y -= 16;
    }
  }

  ctx.y = y - 12;
}

function drawNotes(ctx: DrawCtx, data: DocumentData) {
  if (!data.comment && !data.terms) return;
  drawSectionLabel(ctx, "Notes & Terms");

  const blocks: { label: string; body: string }[] = [];
  if (data.comment) blocks.push({ label: "Notes", body: data.comment });
  if (data.terms) blocks.push({ label: "Terms & Conditions", body: data.terms });

  for (const block of blocks) {
    const lines = wrapLines(ctx.font, block.body, 9, CONTENT_W - 20);
    const boxH = 22 + lines.length * 12;
    ensureSpace(ctx, boxH + 10);
    const boxY = ctx.y - boxH;
    ctx.page.drawRectangle({
      x: MARGIN_X,
      y: boxY,
      width: CONTENT_W,
      height: boxH,
      borderColor: color(ctx.border),
      borderWidth: 0.8,
    });
    drawText(ctx, block.label.toUpperCase(), MARGIN_X + 10, ctx.y - 14, {
      size: 7,
      bold: true,
      c: ctx.textMuted,
    });
    let y = ctx.y - 28;
    for (const line of lines) {
      drawText(ctx, line, MARGIN_X + 10, y, { size: 9, c: ctx.textMid });
      y -= 12;
    }
    ctx.y = boxY - 12;
  }
}

function drawFooters(doc: PDFDocument, businessName: string, font: PDFFont) {
  const pages = doc.getPages();
  const generatedAt = new Date().toLocaleString("en-AU");
  const footer = toWinAnsi(`Generated ${generatedAt} - ${businessName} - Powered by BMS PRO`);
  pages.forEach((page, i) => {
    const label = toWinAnsi(`${footer}  |  ${i + 1}/${pages.length}`);
    const size = 7;
    const w = font.widthOfTextAtSize(label, size);
    page.drawText(label, {
      x: (PAGE_W - w) / 2,
      y: 22,
      size,
      font,
      color: rgb(0.55, 0.55, 0.55),
    });
  });
}

/**
 * Generate an A4 Quote / Tax Invoice PDF with pdf-lib.
 * Shared by preview-pdf (if used), send/email, Storage upload, and download APIs.
 */
export async function generateDocumentPdf(
  data: DocumentData,
  kind?: DocumentKindAlias
): Promise<{ buffer: Buffer; filename: string }> {
  const normalizedKind = normalizeDocumentKind(kind ?? data.kind);
  const input: DocumentData = { ...data, kind: normalizedKind };
  const meta = DOCUMENT_KIND_META[normalizedKind];
  const accent = hexToRgb(meta.accent);
  const accentLt = hexToRgb(meta.accentLt);

  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([PAGE_W, PAGE_H]);

  const ctx: DrawCtx = {
    doc,
    page,
    font,
    fontBold,
    y: PAGE_H - MARGIN_TOP,
    accent,
    accentLt,
    text: { r: 0.11, g: 0.1, b: 0.09 },
    textMid: { r: 0.34, g: 0.33, b: 0.31 },
    textMuted: { r: 0.66, g: 0.64, b: 0.62 },
    border: { r: 0.89, g: 0.87, b: 0.84 },
    surface2: { r: 0.98, g: 0.976, b: 0.969 },
  };

  drawHeader(ctx, input);
  drawParties(ctx, input);
  drawJob(ctx, input);
  drawItemsTable(ctx, input);
  drawTotals(ctx, input);
  drawNotes(ctx, input);
  drawFooters(doc, input.business.name || "Workshop", font);

  const bytes = await doc.save();
  return {
    buffer: Buffer.from(bytes),
    filename: salesDocumentPdfFilename(normalizedKind, input.code),
  };
}
