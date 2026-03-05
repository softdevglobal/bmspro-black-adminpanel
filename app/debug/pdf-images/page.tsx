"use client";

import { useState } from "react";

export default function DebugPdfImagesPage() {
  const [bookingId, setBookingId] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [result, setResult] = useState<string>("");
  const [loading, setLoading] = useState(false);

  const inspectBooking = async () => {
    if (!bookingId.trim()) return;
    setLoading(true);
    setResult("");
    try {
      const res = await fetch(`/api/debug/fetch-pdf-image?bookingId=${encodeURIComponent(bookingId.trim())}`);
      const data = await res.json();
      setResult(JSON.stringify(data, null, 2));
      if (data.firstFullUrl) {
        setImageUrl(data.firstFullUrl);
      }
    } catch (e: any) {
      setResult("Error: " + (e?.message || String(e)));
    } finally {
      setLoading(false);
    }
  };

  const testImageUrl = async () => {
    const urlToTest = imageUrl.trim() || document.querySelector<HTMLInputElement>("#fullUrl")?.value?.trim();
    if (!urlToTest) return;
    setLoading(true);
    setResult("");
    try {
      const res = await fetch(`/api/debug/fetch-pdf-image?url=${encodeURIComponent(urlToTest)}`);
      const contentType = res.headers.get("content-type") || "";
      if (contentType.includes("image")) {
        const blob = await res.blob();
        const objectUrl = URL.createObjectURL(blob);
        setResult(`SUCCESS! Image loaded (${blob.size} bytes). Preview:`);
        const img = document.getElementById("preview-img") as HTMLImageElement;
        if (img) {
          img.src = objectUrl;
          img.style.display = "block";
        }
      } else {
        const data = await res.json();
        setResult(JSON.stringify(data, null, 2));
      }
    } catch (e: any) {
      setResult("Error: " + (e?.message || String(e)));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-neutral-100 p-8">
      <div className="max-w-2xl mx-auto space-y-6">
        <h1 className="text-2xl font-bold text-neutral-900">PDF Image Debug</h1>

        {/* Step 1: Inspect booking */}
        <div className="bg-white rounded-xl p-6 shadow-sm border border-neutral-200">
          <h2 className="font-semibold text-neutral-800 mb-2">1. Inspect booking (find image URLs)</h2>
          <p className="text-sm text-neutral-500 mb-3">Enter a booking ID (from Firestore, e.g. the document ID)</p>
          <div className="flex gap-2">
            <input
              type="text"
              placeholder="e.g. abc123xyz or full doc ID"
              value={bookingId}
              onChange={(e) => setBookingId(e.target.value)}
              className="flex-1 px-3 py-2 border border-neutral-200 rounded-lg"
            />
            <button
              onClick={inspectBooking}
              disabled={loading}
              className="px-4 py-2 bg-neutral-900 text-white rounded-lg font-medium disabled:opacity-50"
            >
              {loading ? "..." : "Inspect"}
            </button>
          </div>
        </div>

        {/* Step 2: Test image URL */}
        <div className="bg-white rounded-xl p-6 shadow-sm border border-neutral-200">
          <h2 className="font-semibold text-neutral-800 mb-2">2. Test image fetch</h2>
          <p className="text-sm text-neutral-500 mb-3">Paste a full image URL (from step 1 or Firestore)</p>
          <input
            id="fullUrl"
            type="text"
            placeholder="https://firebasestorage.googleapis.com/v0/b/..."
            value={imageUrl}
            onChange={(e) => setImageUrl(e.target.value)}
            className="w-full px-3 py-2 border border-neutral-200 rounded-lg mb-2 font-mono text-sm"
          />
          <button
            onClick={testImageUrl}
            disabled={loading}
            className="px-4 py-2 bg-emerald-600 text-white rounded-lg font-medium disabled:opacity-50"
          >
            {loading ? "..." : "Test fetch"}
          </button>
        </div>

        {/* Result */}
        <div className="bg-white rounded-xl p-6 shadow-sm border border-neutral-200">
          <h2 className="font-semibold text-neutral-800 mb-2">Result</h2>
          {result && (
            <>
              <pre className="text-sm text-neutral-700 bg-neutral-50 p-4 rounded-lg overflow-auto max-h-60 whitespace-pre-wrap">
                {result}
              </pre>
              <img
                id="preview-img"
                alt="Preview"
                className="mt-4 max-w-xs rounded-lg border hidden"
                style={{ display: "none" }}
              />
            </>
          )}
          {!result && <p className="text-neutral-400 text-sm">Run step 1 or 2 above.</p>}
        </div>
      </div>
    </div>
  );
}
