/**
 * Post-completion condition flag a staff member attaches to a task. Persisted
 * on `BookingTask.condition` and rendered across the admin panel, the owner
 * mobile app, and the customer booking engine.
 */
export type TaskCondition = "urgent" | "advisory" | "good";

export type TaskConditionOption = {
  value: TaskCondition;
  label: string;
  emoji: string;
  /** Tailwind classes for a solid dot. */
  dotClass: string;
  /** Tailwind classes for a pill badge (bg + text + border). */
  badgeClass: string;
};

export const TASK_CONDITION_OPTIONS: TaskConditionOption[] = [
  {
    value: "urgent",
    label: "Urgent",
    emoji: "🔴",
    dotClass: "bg-rose-500",
    badgeClass: "bg-rose-50 text-rose-700 border-rose-200",
  },
  {
    value: "advisory",
    label: "Advisory",
    emoji: "🟡",
    dotClass: "bg-amber-500",
    badgeClass: "bg-amber-50 text-amber-700 border-amber-200",
  },
  {
    value: "good",
    label: "Good Condition",
    emoji: "🟢",
    dotClass: "bg-emerald-500",
    badgeClass: "bg-emerald-50 text-emerald-700 border-emerald-200",
  },
];

export function isTaskCondition(v: unknown): v is TaskCondition {
  return v === "urgent" || v === "advisory" || v === "good";
}

export function taskConditionOption(
  v: string | null | undefined
): TaskConditionOption | null {
  if (!v) return null;
  return TASK_CONDITION_OPTIONS.find((o) => o.value === v) ?? null;
}
