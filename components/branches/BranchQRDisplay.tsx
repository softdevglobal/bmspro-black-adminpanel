"use client";

import React, { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";

const QR_PREFIX = "bmspro://clockin/";

export default function BranchQRDisplay({
  branchId,
  branchName,
  className = "",
  compact = false,
}: {
  branchId: string;
  branchName: string;
  className?: string;
  compact?: boolean;
}) {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  // Generate QR on mount
  useEffect(() => {
    const payload = `${QR_PREFIX}${branchId}`;
    QRCode.toDataURL(payload, {
      width: 256,
      margin: 2,
      color: { dark: "#000000", light: "#ffffff" },
    })
      .then(setQrDataUrl)
      .catch((err) => console.error("QR generation failed:", err));
  }, [branchId]);

  const handleDownload = useCallback(async () => {
    const payload = `${QR_PREFIX}${branchId}`;
    try {
      const url = await QRCode.toDataURL(payload, {
        width: 512,
        margin: 2,
        color: { dark: "#000000", light: "#ffffff" },
      });
      const link = document.createElement("a");
      link.download = `clockin-qr-${branchName.replace(/\s+/g, "-")}.png`;
      link.href = url;
      link.click();
    } catch (err) {
      console.error("QR generation failed:", err);
    }
  }, [branchId, branchName]);

  return (
    <div className={`rounded-xl border border-neutral-100 shadow-sm overflow-hidden bg-white inline-flex flex-col ${compact ? "border-0 shadow-none" : ""} ${className}`}>
      {!compact && (
        <div className="px-4 py-2.5 bg-neutral-900 text-white flex items-center gap-2">
          <i className="fas fa-qrcode text-xs" />
          <span className="text-xs font-semibold">Clock In / Out QR</span>
        </div>
      )}
      <div className={`flex flex-col items-center ${compact ? "p-0" : "p-3"}`}>
        {qrDataUrl ? (
          <img src={qrDataUrl} alt="Branch QR Code" className={`rounded ${compact ? "w-32 h-32" : "w-24 h-24"}`} />
        ) : (
          <div className={`bg-neutral-100 rounded flex items-center justify-center ${compact ? "w-32 h-32" : "w-24 h-24"}`}>
            <i className="fas fa-spinner fa-spin text-neutral-400 text-lg" />
          </div>
        )}
        <button
          type="button"
          onClick={handleDownload}
          className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md bg-neutral-800 hover:bg-neutral-700 text-white transition-colors ${compact ? "mt-1.5" : "mt-2"}`}
          title="Download QR code"
        >
          <i className="fas fa-download text-[10px]" />
          Download
        </button>
      </div>
    </div>
  );
}
