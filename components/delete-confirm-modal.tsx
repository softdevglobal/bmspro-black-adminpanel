"use client";

import { useEffect } from "react";

type Props = {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onCancel: () => void;
  onConfirm: () => void;
  isLoading?: boolean;
};

export function DeleteConfirmModal({
  open,
  title,
  description,
  confirmLabel = "Yes, delete",
  cancelLabel = "No, cancel",
  onCancel,
  onConfirm,
  isLoading = false,
}: Props) {
  useEffect(() => {
    if (!open) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !isLoading) onCancel();
    }

    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, onCancel, isLoading]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close dialog"
        onClick={onCancel}
        disabled={isLoading}
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
      />
      <div
        role="alertdialog"
        aria-modal="true"
        className="relative w-full max-w-[420px] overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-2xl"
      >
        <div className="px-6 pt-6 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-red-100 text-red-600">
            <i className="fas fa-trash text-xl" />
          </div>
          <h2 className="text-lg font-bold text-neutral-900">{title}</h2>
          <p className="mt-2 text-sm text-neutral-600">{description}</p>
        </div>
        <div className="mt-6 flex flex-col-reverse gap-2 border-t border-neutral-100 bg-neutral-50 px-6 py-4 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={onCancel}
            disabled={isLoading}
            className="flex h-11 items-center justify-center rounded-xl border border-neutral-200 bg-white px-5 text-sm font-semibold text-neutral-700 transition-colors hover:bg-neutral-50 disabled:opacity-60"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isLoading}
            className="flex h-11 items-center justify-center gap-2 rounded-xl bg-red-600 px-5 text-sm font-semibold text-white transition-all hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-70"
          >
            {isLoading ? (
              <>
                <i className="fas fa-spinner fa-spin" />
                Deleting...
              </>
            ) : (
              confirmLabel
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
