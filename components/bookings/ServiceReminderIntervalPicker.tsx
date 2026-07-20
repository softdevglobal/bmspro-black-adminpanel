"use client";

import { useEffect, useState } from "react";
import {
  MAX_SERVICE_REMINDER_INTERVAL_DAYS,
  MIN_SERVICE_REMINDER_INTERVAL_DAYS,
  SERVICE_REMINDER_INTERVAL_OPTIONS,
  isPresetIntervalDays,
  isValidServiceReminderIntervalDays,
} from "@/lib/serviceReminders/types";

const CUSTOM_OPTION = "custom";

type Props = {
  intervalDays: number;
  onChange: (days: number) => void;
  inputClass?: string;
  /** Hide labels — for compact table/row use */
  inline?: boolean;
  label?: string;
};

export function validateCustomIntervalInput(raw: string): { ok: true; days: number } | { ok: false; error: string } {
  const digits = raw.replace(/\D/g, "").trim();
  if (!digits) {
    return { ok: false, error: "Enter a number of days for the custom interval." };
  }
  const n = Number(digits);
  if (!isValidServiceReminderIntervalDays(n)) {
    return {
      ok: false,
      error: `Custom interval must be between ${MIN_SERVICE_REMINDER_INTERVAL_DAYS} and ${MAX_SERVICE_REMINDER_INTERVAL_DAYS} days.`,
    };
  }
  return { ok: true, days: Math.round(n) };
}

export default function ServiceReminderIntervalPicker({
  intervalDays,
  onChange,
  inputClass = "w-full rounded-lg border border-neutral-300 bg-white px-3.5 py-2.5 text-sm text-neutral-900 focus:border-neutral-900 focus:outline-none focus:ring-2 focus:ring-neutral-900/10",
  inline = false,
  label = "Reminder interval",
}: Props) {
  const [customMode, setCustomMode] = useState(!isPresetIntervalDays(intervalDays));
  const [customDays, setCustomDays] = useState(
    !isPresetIntervalDays(intervalDays) ? String(intervalDays) : "",
  );

  useEffect(() => {
    const custom = !isPresetIntervalDays(intervalDays);
    setCustomMode(custom);
    if (custom) {
      setCustomDays(String(intervalDays));
    }
  }, [intervalDays]);

  const selectValue = customMode ? CUSTOM_OPTION : String(intervalDays);

  const handleSelectChange = (value: string) => {
    if (value === CUSTOM_OPTION) {
      setCustomMode(true);
      if (customDays.trim()) {
        const parsed = validateCustomIntervalInput(customDays);
        if (parsed.ok) onChange(parsed.days);
      }
      return;
    }
    setCustomMode(false);
    setCustomDays("");
    onChange(Number(value));
  };

  const handleCustomDaysChange = (raw: string) => {
    const digits = raw.replace(/\D/g, "");
    setCustomDays(digits);
    if (!digits) return;
    const n = Number(digits);
    if (isValidServiceReminderIntervalDays(n)) {
      onChange(Math.round(n));
    }
  };

  if (inline) {
    return (
      <div className="flex items-center gap-2 flex-wrap justify-end">
        <select
          value={selectValue}
          onChange={(e) => handleSelectChange(e.target.value)}
          className={inputClass}
          aria-label="Reminder interval"
        >
          {SERVICE_REMINDER_INTERVAL_OPTIONS.map((opt) => (
            <option key={opt.days} value={opt.days}>
              {opt.label}
            </option>
          ))}
          <option value={CUSTOM_OPTION}>Custom…</option>
        </select>
        {customMode && (
          <div className="flex items-center gap-1.5">
            <input
              type="text"
              inputMode="numeric"
              value={customDays}
              onChange={(e) => handleCustomDaysChange(e.target.value)}
              placeholder="Days"
              className={`${inputClass} w-20`}
              aria-label="Custom interval days"
            />
            <span className="text-xs text-neutral-500">days</span>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div>
        <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wide mb-1.5">
          {label}
        </label>
        <select
          value={selectValue}
          onChange={(e) => handleSelectChange(e.target.value)}
          className={inputClass}
        >
          {SERVICE_REMINDER_INTERVAL_OPTIONS.map((opt) => (
            <option key={opt.days} value={opt.days}>
              {opt.label} ({opt.days} days)
            </option>
          ))}
          <option value={CUSTOM_OPTION}>Custom interval…</option>
        </select>
      </div>

      {customMode && (
        <div>
          <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wide mb-1.5">
            Custom days after service completed
          </label>
          <div className="flex items-center gap-2">
            <input
              type="text"
              inputMode="numeric"
              value={customDays}
              onChange={(e) => handleCustomDaysChange(e.target.value)}
              placeholder={`e.g. 45 (${MIN_SERVICE_REMINDER_INTERVAL_DAYS}–${MAX_SERVICE_REMINDER_INTERVAL_DAYS})`}
              className={inputClass}
              autoFocus
            />
            <span className="text-sm text-neutral-500 shrink-0">days</span>
          </div>
        </div>
      )}
    </div>
  );
}
