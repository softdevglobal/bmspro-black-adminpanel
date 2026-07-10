import "server-only";

import { renderHtmlToPdfBuffer } from "@/lib/pdfService";

export type SalesDocKind = "quotation" | "invoice";

export type SalesDocPdfLineItem = {
  code: string;
  name: string;
  description: string;
  quantity: number;
  rate: number;
  discountPercent: number;
  applyGst: boolean;
};

export type SalesDocPdfInput = {
  kind: SalesDocKind;
  code: string;
  status: string;
  business: {
    name: string;
    email?: string | null;
    phone?: string | null;
    address?: string | null;
  };
  customer: { fullName: string; email: string; phone: string };
  address: { street: string; suburb: string; state: string; postcode: string };
  jobTitle: string;
  jobDescription: string;
  lineItems: SalesDocPdfLineItem[];
  discountAud: number;
  gstEnabled: boolean;
  gstPercentage: number;
  gstPricing: "exclusive" | "inclusive";
  subtotalAud: number;
  gstAud: number;
  totalAud: number;
  documentDate: string;
  dueDate: string;
  paymentTermsLabel: string;
  terms: string;
  comment: string;
};

const KIND_META: Record<
  SalesDocKind,
  { docLabel: string; dateLabel: string; dueLabel: string; totalLabel: string; tagline: string }
> = {
  quotation: {
    docLabel: "Quotation",
    dateLabel: "Quote Date",
    dueLabel: "Valid Until",
    totalLabel: "Total Estimate",
    tagline: "Quotation · BMS Pro",
  },
  invoice: {
    docLabel: "Invoice",
    dateLabel: "Invoice Date",
    dueLabel: "Due Date",
    totalLabel: "Total Due",
    tagline: "Tax Invoice · BMS Pro",
  },
};

function escapeHtml(value: string | null | undefined): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function nl2br(value: string | null | undefined): string {
  return escapeHtml(value).replace(/\n/g, "<br />");
}

function formatAud(value: number): string {
  return `AU$ ${(value ?? 0).toFixed(2)}`;
}

function formatDateHuman(iso: string): string {
  const [y, m, d] = (iso || "").split("-").map(Number);
  if (!y || !m || !d) return iso || "—";
  return new Date(y, m - 1, d).toLocaleDateString("en-AU", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function lineNet(item: SalesDocPdfLineItem): number {
  return Math.round(item.quantity * item.rate * (1 - item.discountPercent / 100) * 100) / 100;
}

function buildSalesDocumentHtml(input: SalesDocPdfInput): string {
  const meta = KIND_META[input.kind];
  const isInvoice = input.kind === "invoice";
  // Quotations lean green (like the booking report accent); invoices lean blue.
  const accent = isInvoice ? "#2563a8" : "#1a6b4a";
  const accentLt = isInvoice ? "#e8f0fa" : "#e8f5ee";
  const accentBorder = isInvoice ? "#a9c6e8" : "#a7dfbf";
  const gradientMid = isInvoice ? "#5b9bd5" : "#34d399";

  const addressLine = [
    input.address.street,
    input.address.suburb,
    input.address.state,
    input.address.postcode,
  ]
    .filter(Boolean)
    .join(", ");

  const businessContact = [input.business.email, input.business.phone, input.business.address]
    .filter(Boolean)
    .join("  ·  ");

  const itemRows = input.lineItems
    .map((item, index) => {
      const meta2 = [
        item.code ? `<span class="li-code">${escapeHtml(item.code)}</span>` : "",
        item.description ? `<div class="li-desc">${escapeHtml(item.description)}</div>` : "",
      ]
        .filter(Boolean)
        .join("");
      const discountTag =
        item.discountPercent > 0
          ? `<span class="li-tag">−${item.discountPercent}%</span>`
          : "";
      return `
        <tr>
          <td class="li-index">${index + 1}</td>
          <td>
            <div class="li-name">${escapeHtml(item.name)} ${discountTag}</div>
            ${meta2}
          </td>
          <td class="num">${item.quantity}</td>
          <td class="num">${formatAud(item.rate)}</td>
          <td class="num strong">${formatAud(lineNet(item))}</td>
        </tr>`;
    })
    .join("");

  const totalsRows = [
    `<div class="tot-row"><span>Subtotal</span><span>${formatAud(input.subtotalAud)}</span></div>`,
    input.discountAud > 0
      ? `<div class="tot-row"><span>Discount</span><span>−${formatAud(input.discountAud)}</span></div>`
      : "",
    input.gstEnabled
      ? `<div class="tot-row"><span>GST (${input.gstPercentage}%)${
          input.gstPricing === "inclusive" ? " · incl." : ""
        }</span><span>${formatAud(input.gstAud)}</span></div>`
      : "",
  ]
    .filter(Boolean)
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>${meta.docLabel} ${escapeHtml(input.code)}</title>
  <link href="https://fonts.googleapis.com/css2?family=Cabinet+Grotesk:wght@400;500;600;700;800&family=Fira+Code:wght@300;400;500&family=Lora:ital,wght@0,400;1,400&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #f4f2ee;
      --surface: #ffffff;
      --surface2: #faf9f7;
      --surface3: #f0ede7;
      --border: #e2ddd6;
      --border-soft: #ece8e1;
      --accent: ${accent};
      --accent-lt: ${accentLt};
      --accent-border: ${accentBorder};
      --text: #1c1917;
      --text-mid: #57534e;
      --text-muted: #a8a29e;
      --radius: 14px;
      --radius-sm: 9px;
      --shadow-sm: 0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: 'Cabinet Grotesk', sans-serif;
      font-size: 14px;
      line-height: 1.6;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    .report-header {
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      padding: 34px 52px 26px;
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 24px;
      position: relative;
    }
    .header-top-bar {
      position: absolute; top: 0; left: 0; right: 0;
      height: 4px;
      background: linear-gradient(90deg, var(--accent) 0%, ${gradientMid} 55%, var(--accent) 100%);
    }
    .brand-block { display: flex; flex-direction: column; gap: 6px; max-width: 60%; }
    .brand-name { font-size: 26px; font-weight: 800; letter-spacing: -0.8px; color: var(--text); }
    .brand-sub {
      font-family: 'Fira Code', monospace;
      font-size: 10.5px; letter-spacing: 0.18em;
      color: var(--text-muted); text-transform: uppercase;
    }
    .brand-contact { font-size: 11.5px; color: var(--text-mid); margin-top: 2px; }
    .header-meta { text-align: right; display: flex; flex-direction: column; gap: 8px; align-items: flex-end; }
    .doc-type {
      font-family: 'Fira Code', monospace;
      font-size: 11px; letter-spacing: 0.24em;
      text-transform: uppercase; color: var(--text-muted);
    }
    .doc-code { font-size: 22px; font-weight: 800; letter-spacing: -0.4px; color: var(--accent); font-family: 'Fira Code', monospace; }
    .status-badge {
      display: inline-flex; align-items: center; gap: 7px;
      background: var(--accent-lt);
      border: 1.5px solid var(--accent-border);
      color: var(--accent);
      font-family: 'Fira Code', monospace;
      font-size: 10px; font-weight: 500; letter-spacing: 0.1em;
      padding: 5px 13px; border-radius: 100px; text-transform: uppercase;
    }
    .status-dot { width: 6px; height: 6px; background: var(--accent); border-radius: 50%; }
    .report-body {
      max-width: 1080px; margin: 0 auto;
      padding: 34px 52px 56px;
      display: flex; flex-direction: column; gap: 26px;
    }
    .section-label { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
    .section-label-dot { width: 8px; height: 8px; border-radius: 2px; background: var(--accent); flex-shrink: 0; }
    .section-label h2 {
      font-size: 11px; font-weight: 700; letter-spacing: 0.2em;
      text-transform: uppercase; color: var(--text-muted); white-space: nowrap;
    }
    .section-label::after { content: ''; flex: 1; height: 1px; background: var(--border); }
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: var(--shadow-sm);
      overflow: hidden;
    }
    .parties { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; background: var(--border); }
    .party { background: var(--surface); padding: 20px 22px; }
    .party .plabel {
      font-family: 'Fira Code', monospace; font-size: 9.5px; letter-spacing: 0.14em;
      text-transform: uppercase; color: var(--text-muted); margin-bottom: 8px;
    }
    .party .pname { font-size: 15px; font-weight: 700; }
    .party .pmeta { font-size: 12.5px; color: var(--text-mid); margin-top: 3px; }
    .meta-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px; background: var(--border); }
    .meta-cell { background: var(--surface); padding: 15px 18px; display: flex; flex-direction: column; gap: 4px; }
    .meta-label {
      font-family: 'Fira Code', monospace; font-size: 9.5px; letter-spacing: 0.14em;
      text-transform: uppercase; color: var(--text-muted);
    }
    .meta-value { font-size: 14px; font-weight: 600; }
    .job-card { padding: 20px 22px; }
    .job-title { font-size: 16px; font-weight: 700; margin-bottom: 6px; }
    .job-desc { font-size: 13px; color: var(--text-mid); font-family: 'Lora', serif; }
    table.items { width: 100%; border-collapse: collapse; }
    table.items thead th {
      background: var(--surface2);
      font-family: 'Fira Code', monospace;
      font-size: 9.5px; letter-spacing: 0.12em; text-transform: uppercase;
      color: var(--text-muted); font-weight: 500;
      text-align: left; padding: 12px 14px;
      border-bottom: 1px solid var(--border);
    }
    table.items thead th.num { text-align: right; }
    table.items tbody td { padding: 14px; border-bottom: 1px solid var(--border-soft); vertical-align: top; font-size: 13px; }
    table.items tbody tr:last-child td { border-bottom: none; }
    .li-index { color: var(--text-muted); font-family: 'Fira Code', monospace; font-size: 11px; width: 34px; }
    .li-name { font-weight: 700; color: var(--text); }
    .li-code { font-family: 'Fira Code', monospace; font-size: 10.5px; color: var(--text-muted); display: block; margin-top: 2px; }
    .li-desc { font-size: 12px; color: var(--text-mid); margin-top: 3px; }
    .li-tag {
      display: inline-block; font-family: 'Fira Code', monospace; font-size: 9.5px;
      background: var(--accent-lt); color: var(--accent); border: 1px solid var(--accent-border);
      padding: 1px 7px; border-radius: 100px; vertical-align: middle; margin-left: 4px;
    }
    td.num { text-align: right; white-space: nowrap; }
    td.num.strong { font-weight: 700; }
    .summary { display: flex; justify-content: flex-end; }
    .summary-inner { width: 320px; }
    .tot-row { display: flex; justify-content: space-between; padding: 8px 4px; font-size: 13px; color: var(--text-mid); border-bottom: 1px dashed var(--border); }
    .tot-row span:last-child { font-weight: 600; color: var(--text); }
    .grand-total {
      display: flex; justify-content: space-between; align-items: center;
      margin-top: 12px; padding: 16px 18px;
      background: var(--text); color: #fff; border-radius: var(--radius-sm);
    }
    .grand-total .gt-label { font-family: 'Fira Code', monospace; font-size: 10.5px; letter-spacing: 0.14em; text-transform: uppercase; color: rgba(255,255,255,0.7); }
    .grand-total .gt-value { font-size: 22px; font-weight: 800; letter-spacing: -0.4px; }
    .notes-grid { display: flex; flex-direction: column; gap: 16px; }
    .note-block .nlabel {
      font-family: 'Fira Code', monospace; font-size: 9.5px; letter-spacing: 0.14em;
      text-transform: uppercase; color: var(--text-muted); margin-bottom: 6px;
    }
    .note-block .nbody { font-size: 12.5px; color: var(--text-mid); }
    .terms .nbody { font-family: 'Lora', serif; }
  </style>
</head>
<body>
  <header class="report-header">
    <div class="header-top-bar"></div>
    <div class="brand-block">
      <div class="brand-name">${escapeHtml(input.business.name)}</div>
      <div class="brand-sub">${meta.tagline}</div>
      ${businessContact ? `<div class="brand-contact">${escapeHtml(businessContact)}</div>` : ""}
    </div>
    <div class="header-meta">
      <div class="status-badge"><span class="status-dot"></span>${meta.docLabel}</div>
      <div class="doc-type">${meta.docLabel} No.</div>
      <div class="doc-code">${escapeHtml(input.code)}</div>
    </div>
  </header>

  <main class="report-body">
    <section>
      <div class="section-label"><span class="section-label-dot"></span><h2>${
        isInvoice ? "Invoice For" : "Prepared For"
      }</h2></div>
      <div class="card">
        <div class="parties">
          <div class="party">
            <div class="plabel">Bill To</div>
            <div class="pname">${escapeHtml(input.customer.fullName)}</div>
            ${input.customer.email ? `<div class="pmeta">${escapeHtml(input.customer.email)}</div>` : ""}
            ${input.customer.phone ? `<div class="pmeta">${escapeHtml(input.customer.phone)}</div>` : ""}
            ${addressLine ? `<div class="pmeta">${escapeHtml(addressLine)}</div>` : ""}
          </div>
          <div class="party">
            <div class="plabel">From</div>
            <div class="pname">${escapeHtml(input.business.name)}</div>
            ${input.business.email ? `<div class="pmeta">${escapeHtml(input.business.email)}</div>` : ""}
            ${input.business.phone ? `<div class="pmeta">${escapeHtml(input.business.phone)}</div>` : ""}
          </div>
        </div>
        <div class="meta-grid">
          <div class="meta-cell">
            <div class="meta-label">${meta.dateLabel}</div>
            <div class="meta-value">${formatDateHuman(input.documentDate)}</div>
          </div>
          <div class="meta-cell">
            <div class="meta-label">${meta.dueLabel}</div>
            <div class="meta-value">${formatDateHuman(input.dueDate)}</div>
          </div>
          <div class="meta-cell">
            <div class="meta-label">Payment Terms</div>
            <div class="meta-value">${escapeHtml(input.paymentTermsLabel)}</div>
          </div>
        </div>
      </div>
    </section>

    ${
      input.jobTitle || input.jobDescription
        ? `<section>
      <div class="section-label"><span class="section-label-dot"></span><h2>Job Details</h2></div>
      <div class="card job-card">
        ${input.jobTitle ? `<div class="job-title">${escapeHtml(input.jobTitle)}</div>` : ""}
        ${input.jobDescription ? `<div class="job-desc">${nl2br(input.jobDescription)}</div>` : ""}
      </div>
    </section>`
        : ""
    }

    <section>
      <div class="section-label"><span class="section-label-dot"></span><h2>Items</h2></div>
      <div class="card">
        <table class="items">
          <thead>
            <tr>
              <th>#</th>
              <th>Item</th>
              <th class="num">Qty</th>
              <th class="num">Rate</th>
              <th class="num">Amount</th>
            </tr>
          </thead>
          <tbody>
            ${itemRows}
          </tbody>
        </table>
      </div>
    </section>

    <section>
      <div class="summary">
        <div class="summary-inner">
          ${totalsRows}
          <div class="grand-total">
            <span class="gt-label">${meta.totalLabel}</span>
            <span class="gt-value">${formatAud(input.totalAud)}</span>
          </div>
        </div>
      </div>
    </section>

    ${
      input.comment || input.terms
        ? `<section>
      <div class="section-label"><span class="section-label-dot"></span><h2>Notes &amp; Terms</h2></div>
      <div class="card job-card">
        <div class="notes-grid">
          ${
            input.comment
              ? `<div class="note-block"><div class="nlabel">Notes</div><div class="nbody">${nl2br(input.comment)}</div></div>`
              : ""
          }
          ${
            input.terms
              ? `<div class="note-block terms"><div class="nlabel">Terms &amp; Conditions</div><div class="nbody">${nl2br(input.terms)}</div></div>`
              : ""
          }
        </div>
      </div>
    </section>`
        : ""
    }
  </main>
</body>
</html>`;
}

export function salesDocumentPdfFilename(kind: SalesDocKind, code: string): string {
  const safeCode = (code || KIND_META[kind].docLabel).replace(/[^a-zA-Z0-9-_]/g, "-");
  return `${KIND_META[kind].docLabel}-${safeCode}.pdf`;
}

export async function generateSalesDocumentPdf(
  input: SalesDocPdfInput
): Promise<{ buffer: Buffer; filename: string }> {
  const html = buildSalesDocumentHtml(input);
  const generatedAt = new Date().toLocaleString("en-AU");
  const buffer = await renderHtmlToPdfBuffer(html, {
    footerText: `Generated ${generatedAt} • ${escapeHtml(input.business.name)} • Powered by BMS PRO`,
  });
  return { buffer, filename: salesDocumentPdfFilename(input.kind, input.code) };
}
