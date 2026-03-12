"use client";

import React, { useCallback } from "react";
import QRCode from "qrcode";

const QR_PREFIX = "bmspro://clockin/";

export default function BranchQRDownload({
  branchId,
  branchName,
  className = "",
}: {
  branchId: string;
  branchName: string;
  className?: string;
}) {
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
    <button
      type="button"
      onClick={handleDownload}
      className={`inline-flex items-center gap-2 px-3 py-1.5 text-xs font-semibold rounded-lg bg-neutral-800 hover:bg-neutral-700 text-white transition-colors ${className}`}
      title="Download QR code for staff clock in/out"
    >
      <i className="fas fa-qrcode" />
      Download QR
    </button>
  );
}
