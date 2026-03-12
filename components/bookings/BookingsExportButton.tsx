"use client";

import React, { useState } from "react";
import BookingsExportModal from "./BookingsExportModal";

export default function BookingsExportButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="w-full px-4 py-2 rounded-lg bg-white/10 hover:bg-white/20 text-white text-sm font-medium border border-white/20 flex items-center justify-center gap-2 transition"
      >
        <i className="fas fa-file-csv" />
        Export Bookings to CSV
      </button>
      <BookingsExportModal open={open} onClose={() => setOpen(false)} />
    </>
  );
}
