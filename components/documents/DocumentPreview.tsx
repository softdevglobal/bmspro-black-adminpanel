"use client";

import React from "react";
import {
  DOCUMENT_KIND_META,
  documentAddressLine,
  documentBusinessContact,
  documentGstTaxableBase,
  documentItemDiscountTotalAud,
  documentItemsGrossAud,
  documentLineDiscountAud,
  documentLineNet,
  formatDocumentAud,
  formatDocumentDateHuman,
  type DocumentData,
} from "@/lib/documentData";

type Props = {
  data: DocumentData;
  className?: string;
};

/**
 * Live HTML preview that visually mirrors the pdf-lib layout.
 * This is styled HTML — not a PDF file. Use Print on the create page to print the pdf-lib PDF.
 */
export default function DocumentPreview({ data, className = "" }: Props) {
  const meta = DOCUMENT_KIND_META[data.kind];
  const isInvoice = data.kind === "invoice";
  const addressLine = documentAddressLine(data.address);
  const businessContact = documentBusinessContact(data.business);
  const gstTaxableBase = documentGstTaxableBase(data);
  const itemDiscountAud = documentItemDiscountTotalAud(data.lineItems);
  const subtotalDisplay =
    itemDiscountAud > 0 ? documentItemsGrossAud(data.lineItems) : data.subtotalAud;

  const showDeposit =
    data.kind === "quotation" &&
    data.depositRequested === true &&
    (data.depositAud ?? 0) > 0;
  const depositLabel =
    data.depositMode === "percent" && (data.depositValue ?? 0) > 0
      ? `Deposit requested (${Math.min(100, data.depositValue ?? 0)}%)`
      : "Deposit requested";

  const showPayment =
    data.kind === "invoice" &&
    (data.paymentRecorded === true || (data.amountPaidAud ?? 0) > 0) &&
    (data.amountPaidAud ?? 0) > 0;

  const styleVars = {
    ["--doc-accent" as string]: meta.accent,
    ["--doc-accent-lt" as string]: meta.accentLt,
    ["--doc-accent-border" as string]: meta.accentBorder,
    ["--doc-gradient-mid" as string]: meta.gradientMid,
  };

  return (
    <div
      data-print-document-root
      className={`document-preview-root ${className}`}
      style={styleVars}
    >
      <header className="doc-header">
        <div className="doc-header-bar" />
        <div className="doc-brand">
          <div className="doc-brand-name">{data.business.name || "Workshop"}</div>
          <div className="doc-brand-sub">{meta.tagline}</div>
          {businessContact ? (
            <div className="doc-brand-contact">{businessContact}</div>
          ) : null}
        </div>
        <div className="doc-header-meta">
          <div className="doc-status">
            <span className="doc-status-dot" />
            {meta.docLabel}
          </div>
          <div className="doc-type">{meta.docLabel} No.</div>
          <div className="doc-code">{data.code || "DRAFT"}</div>
        </div>
      </header>

      <main className="doc-body">
        <section>
          <div className="doc-section-label">
            <span className="doc-section-dot" />
            <h2>{isInvoice ? "Invoice For" : "Prepared For"}</h2>
          </div>
          <div className="doc-card">
            <div className="doc-parties">
              <div className="doc-party">
                <div className="doc-plabel">Bill To</div>
                <div className="doc-pname">{data.customer.fullName || "—"}</div>
                {data.customer.email ? (
                  <div className="doc-pmeta">{data.customer.email}</div>
                ) : null}
                {data.customer.phone ? (
                  <div className="doc-pmeta">{data.customer.phone}</div>
                ) : null}
                {addressLine ? <div className="doc-pmeta">{addressLine}</div> : null}
              </div>
              <div className="doc-party">
                <div className="doc-plabel">From</div>
                <div className="doc-pname">{data.business.name || "—"}</div>
                {data.business.email ? (
                  <div className="doc-pmeta">{data.business.email}</div>
                ) : null}
                {data.business.phone ? (
                  <div className="doc-pmeta">{data.business.phone}</div>
                ) : null}
              </div>
            </div>
            <div className="doc-meta-grid">
              <div className="doc-meta-cell">
                <div className="doc-meta-label">{meta.dateLabel}</div>
                <div className="doc-meta-value">
                  {formatDocumentDateHuman(data.documentDate)}
                </div>
              </div>
              <div className="doc-meta-cell">
                <div className="doc-meta-label">{meta.dueLabel}</div>
                <div className="doc-meta-value">
                  {formatDocumentDateHuman(data.dueDate)}
                </div>
              </div>
              <div className="doc-meta-cell">
                <div className="doc-meta-label">Payment Terms</div>
                <div className="doc-meta-value">{data.paymentTermsLabel || "—"}</div>
              </div>
            </div>
          </div>
        </section>

        {(data.jobTitle || data.jobDescription) && (
          <section>
            <div className="doc-section-label">
              <span className="doc-section-dot" />
              <h2>Job Details</h2>
            </div>
            <div className="doc-card doc-job">
              {data.jobTitle ? <div className="doc-job-title">{data.jobTitle}</div> : null}
              {data.jobDescription ? (
                <div className="doc-job-desc whitespace-pre-wrap">{data.jobDescription}</div>
              ) : null}
            </div>
          </section>
        )}

        <section>
          <div className="doc-section-label">
            <span className="doc-section-dot" />
            <h2>Items</h2>
          </div>
          <div className="doc-card overflow-x-auto">
            <table className="doc-items">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Item</th>
                  <th className="num">Qty</th>
                  <th className="num">Rate</th>
                  <th className="num">Disc</th>
                  <th className="num">GST</th>
                  <th className="num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {data.lineItems.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="doc-empty">
                      No line items yet — add items in the Create tab.
                    </td>
                  </tr>
                ) : (
                  data.lineItems.map((item, index) => {
                    const discAud = documentLineDiscountAud(item);
                    const gstLabel =
                      data.gstEnabled && item.applyGst
                        ? `${data.gstPercentage}%`
                        : "—";
                    return (
                      <tr key={`${item.name}-${index}`}>
                        <td className="doc-li-index">{index + 1}</td>
                        <td>
                          <div className="doc-li-name">{item.name}</div>
                          {item.code ? (
                            <span className="doc-li-code">{item.code}</span>
                          ) : null}
                          {item.description ? (
                            <div className="doc-li-desc">{item.description}</div>
                          ) : null}
                        </td>
                        <td className="num">{item.quantity}</td>
                        <td className="num">{formatDocumentAud(item.rate)}</td>
                        <td className="num">
                          {discAud > 0 ? `−${formatDocumentAud(discAud)}` : "—"}
                        </td>
                        <td className="num">{gstLabel}</td>
                        <td className="num strong">
                          {formatDocumentAud(documentLineNet(item))}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="doc-summary-section">
          <div className="doc-summary">
            <div className="doc-summary-inner">
              <div className="doc-tot-row">
                <span>Subtotal</span>
                <span>{formatDocumentAud(subtotalDisplay)}</span>
              </div>
              {itemDiscountAud > 0 ? (
                <div className="doc-tot-row">
                  <span>Item discount</span>
                  <span>−{formatDocumentAud(itemDiscountAud)}</span>
                </div>
              ) : null}
              {data.discountAud > 0 ? (
                <div className="doc-tot-row">
                  <span>Discount</span>
                  <span>−{formatDocumentAud(data.discountAud)}</span>
                </div>
              ) : null}
              {data.gstEnabled ? (
                <div className="doc-tot-row">
                  <span>
                    GST ({data.gstPercentage}%)
                    {data.gstPricing === "inclusive" ? " · incl." : ""}
                    {data.discountAud > 0
                      ? ` on ${formatDocumentAud(gstTaxableBase)}`
                      : ""}
                  </span>
                  <span>{formatDocumentAud(data.gstAud)}</span>
                </div>
              ) : null}
              <div className="doc-grand-total">
                <span className="doc-gt-label">{showPayment ? "Total" : meta.totalLabel}</span>
                <span className="doc-gt-value">{formatDocumentAud(data.totalAud)}</span>
              </div>
              {showDeposit ? (
                <div className="doc-deposit-block">
                  <div className="doc-tot-row">
                    <span>{depositLabel}</span>
                    <span>{formatDocumentAud(data.depositAud ?? 0)}</span>
                  </div>
                  {data.depositDueDate ? (
                    <div className="doc-tot-row">
                      <span>Deposit due</span>
                      <span>{formatDocumentDateHuman(data.depositDueDate)}</span>
                    </div>
                  ) : null}
                </div>
              ) : null}
              {showPayment ? (
                <div className="doc-deposit-block">
                  <div className="doc-tot-row">
                    <span>Amount paid</span>
                    <span>{formatDocumentAud(data.amountPaidAud ?? 0)}</span>
                  </div>
                  <div className="doc-tot-row doc-balance-due">
                    <span>Balance due</span>
                    <span>
                      {formatDocumentAud(
                        data.balanceDueAud ??
                          Math.max(0, data.totalAud - (data.amountPaidAud ?? 0)),
                      )}
                    </span>
                  </div>
                  {data.balanceDueDate ? (
                    <div className="doc-tot-row">
                      <span>Balance due date</span>
                      <span>{formatDocumentDateHuman(data.balanceDueDate)}</span>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        </section>

        {(data.comment || data.terms) && (
          <section>
            <div className="doc-section-label">
              <span className="doc-section-dot" />
              <h2>Notes &amp; Terms</h2>
            </div>
            <div className="doc-card doc-job">
              <div className="doc-notes-grid">
                {data.comment ? (
                  <div>
                    <div className="doc-nlabel">Notes</div>
                    <div className="doc-nbody whitespace-pre-wrap">{data.comment}</div>
                  </div>
                ) : null}
                {data.terms ? (
                  <div>
                    <div className="doc-nlabel">Terms &amp; Conditions</div>
                    <div className="doc-nbody doc-terms whitespace-pre-wrap">
                      {data.terms}
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
