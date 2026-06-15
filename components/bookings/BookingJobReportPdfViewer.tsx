"use client";

import { useEffect, useState } from "react";
import { auth } from "@/lib/firebase";

type Props = {
  bookingId: string;
  filename: string;
  className?: string;
};

/** Matches `app/dashboard/page.tsx` auth loading (thin arc + caption). */
function JobReportPdfLoader({ message = "Loading job report..." }: { message?: string }) {
  return (
    <div className="text-center" role="status" aria-live="polite">
      <div
        className="mx-auto mb-4 h-12 w-12 animate-spin rounded-full border-b-2 border-neutral-900"
        aria-hidden
      />
      <p className="text-neutral-600">{message}</p>
    </div>
  );
}

/**
 * Same-origin PDF preview in an iframe. Blob/embed was unreliable in Chrome; this loads
 * `/api/bookings/.../pdf?inline=1&token=...` with `Content-Disposition: inline`.
 * Requires the PDF route to set its own CSP so nested previews stay same-origin only.
 */
export default function BookingJobReportPdfViewer({ bookingId, filename, className }: Props) {
  const [src, setSrc] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /** Iframe has fired load (PDF viewer ready). */
  const [frameReady, setFrameReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setErr(null);
    setSrc(null);
    setFrameReady(false);
    (async () => {
      const user = auth.currentUser;
      if (!user) {
        if (!cancelled) setErr("Sign in to preview this PDF.");
        return;
      }
      try {
        const token = await user.getIdToken();
        if (cancelled) return;
        const u = new URL(`/api/bookings/${encodeURIComponent(bookingId)}/pdf`, window.location.origin);
        u.searchParams.set("inline", "1");
        u.searchParams.set("token", token);
        setSrc(u.toString());
      } catch {
        if (!cancelled) setErr("Could not load this PDF.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bookingId]);

  useEffect(() => {
    if (!src) return;
    setFrameReady(false);
    const failSafe = window.setTimeout(() => setFrameReady(true), 12_000);
    return () => clearTimeout(failSafe);
  }, [src]);

  if (err) {
    return (
      <div
        className={`flex h-full min-h-[200px] w-full items-center justify-center bg-neutral-100 px-4 text-center text-sm text-red-600 ${className ?? ""}`}
      >
        {err}
      </div>
    );
  }

  if (!src) {
    return (
      <div
        className={`flex h-full min-h-[200px] w-full flex-col items-center justify-center bg-neutral-50 ${className ?? ""}`}
      >
        <JobReportPdfLoader message="Loading job report..." />
      </div>
    );
  }

  return (
    <div className={`relative h-full min-h-0 w-full ${className ?? ""}`}>
      <iframe
        key={src}
        src={src}
        title={filename ? `Job report: ${filename}` : "Job report PDF"}
        referrerPolicy="no-referrer"
        onLoad={() => setFrameReady(true)}
        className="block h-full min-h-0 w-full border-0 bg-white"
      />
      {!frameReady && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-neutral-50">
          <JobReportPdfLoader message="Loading job report..." />
        </div>
      )}
    </div>
  );
}
