"use client";

import {
  formatServiceReminderDueDate,
  type BookingServiceReminderSnapshot,
} from "@/lib/serviceReminders/types";

type Props = {
  clientName: string;
  serviceReminder: BookingServiceReminderSnapshot | null;
};

export default function CompletedBookingReminderCard({
  clientName,
  serviceReminder,
}: Props) {
  const status = serviceReminder?.status;
  const isSent = status === "sent";
  const isScheduled = status === "pending" && !!serviceReminder?.dueAt;
  const advancePending =
    serviceReminder?.advanceStatus === "pending" && !!serviceReminder?.advanceDueAt;
  const advanceSent = serviceReminder?.advanceStatus === "sent";

  return (
    <div className="relative overflow-hidden rounded-2xl border border-amber-200/80 bg-gradient-to-br from-amber-50 via-white to-orange-50 shadow-sm">
      <div className="absolute top-0 right-0 w-20 h-20 bg-amber-400/10 rounded-full -translate-y-1/2 translate-x-1/2" />
      <div className="p-4 space-y-3 relative">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-amber-500/15 flex items-center justify-center">
            <i className="fas fa-bell text-amber-600 text-sm" />
          </div>
          <div>
            <h4 className="font-semibold text-neutral-900 text-sm">Next service reminder</h4>
            <p className="text-[11px] text-neutral-500">
              Automatic reminder for {clientName || "customer"} — intervals from Service Reminder
            </p>
          </div>
        </div>

        {isSent ? (
          <div className="rounded-lg bg-emerald-50 border border-emerald-100 px-3 py-2 text-xs text-emerald-800">
            <i className="fas fa-check-circle mr-1" />
            Main reminder sent
            {serviceReminder?.sentAt
              ? ` on ${formatServiceReminderDueDate(serviceReminder.sentAt)}`
              : ""}
          </div>
        ) : isScheduled ? (
          <div className="space-y-2">
            {advancePending && (
              <div className="rounded-lg bg-sky-50 border border-sky-100 px-3 py-2 text-xs text-sky-900">
                <i className="fas fa-bell mr-1" />
                1-week heads-up on {formatServiceReminderDueDate(serviceReminder!.advanceDueAt!)}
              </div>
            )}
            {advanceSent && serviceReminder?.advanceSentAt && (
              <div className="rounded-lg bg-sky-50/80 border border-sky-100 px-3 py-2 text-xs text-sky-800">
                <i className="fas fa-check mr-1" />
                1-week heads-up sent on {formatServiceReminderDueDate(serviceReminder.advanceSentAt)}
              </div>
            )}
            <div className="rounded-lg bg-white/80 border border-amber-100 px-3 py-2 text-xs text-neutral-700">
              <i className="fas fa-clock mr-1 text-amber-600" />
              Main reminder on {formatServiceReminderDueDate(serviceReminder!.dueAt)}
              <span className="text-neutral-400">
                {" "}
                · {serviceReminder!.intervalDays} days after service completed
              </span>
            </div>
          </div>
        ) : (
          <p className="text-xs text-neutral-500">
            Not scheduled yet. Save intervals on the Service Reminder page, then open a completed
            booking that uses that service.
          </p>
        )}

      </div>
    </div>
  );
}
