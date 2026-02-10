"use client";
import React from "react";

export type WeeklySchedule = {
  Monday?: { branchId: string; branchName: string } | null;
  Tuesday?: { branchId: string; branchName: string } | null;
  Wednesday?: { branchId: string; branchName: string } | null;
  Thursday?: { branchId: string; branchName: string } | null;
  Friday?: { branchId: string; branchName: string } | null;
  Saturday?: { branchId: string; branchName: string } | null;
  Sunday?: { branchId: string; branchName: string } | null;
};

type Branch = {
  id: string;
  name: string;
};

type WeeklyScheduleSelectorProps = {
  branches: Branch[];
  schedule: WeeklySchedule;
  onChange: (schedule: WeeklySchedule) => void;
};

const DAYS = [
  { key: "Monday", label: "Monday", icon: "☀️", color: "from-yellow-400 to-orange-500" },
  { key: "Tuesday", label: "Tuesday", icon: "🌤️", color: "from-blue-400 to-cyan-500" },
  { key: "Wednesday", label: "Wednesday", icon: "🌻", color: "from-emerald-400 to-teal-500" },
  { key: "Thursday", label: "Thursday", icon: "🌸", color: "from-pink-400 to-rose-500" },
  { key: "Friday", label: "Friday", icon: "🎉", color: "from-purple-400 to-indigo-500" },
  { key: "Saturday", label: "Saturday", icon: "🎨", color: "from-fuchsia-400 to-purple-500" },
  { key: "Sunday", label: "Sunday", icon: "🌙", color: "from-slate-400 to-slate-600" },
] as const;

export default function WeeklyScheduleSelector({
  branches,
  schedule,
  onChange,
}: WeeklyScheduleSelectorProps) {
  const handleDayChange = (day: keyof WeeklySchedule, branchId: string) => {
    const branch = branches.find((b) => b.id === branchId);
    const newSchedule = { ...schedule };
    
    if (branchId === "") {
      // Off day
      newSchedule[day] = null;
    } else if (branch) {
      newSchedule[day] = {
        branchId: branch.id,
        branchName: branch.name,
      };
    }
    
    onChange(newSchedule);
  };

  return (
    <div className="space-y-2 sm:space-y-3">
      <div className="flex items-start sm:items-center justify-between mb-2 sm:mb-3 gap-2">
        <div className="flex-1 min-w-0">
          <label className="block text-xs sm:text-sm font-bold text-slate-700 flex items-center gap-2">
            <i className="fas fa-calendar-week text-purple-600" />
            <span className="truncate">Weekly Branch Schedule</span>
          </label>
          <p className="text-[10px] text-slate-500 mt-0.5 sm:mt-1">
            Assign branches for each day
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            if (branches.length > 0) {
              const firstBranch = branches[0];
              const allDaysSchedule: WeeklySchedule = {};
              DAYS.forEach((day) => {
                allDaysSchedule[day.key] = {
                  branchId: firstBranch.id,
                  branchName: firstBranch.name,
                };
              });
              onChange(allDaysSchedule);
            }
          }}
          className="text-[10px] sm:text-xs text-purple-600 hover:text-purple-700 font-semibold bg-white px-2 sm:px-3 py-1 sm:py-1.5 rounded-lg border border-purple-200 hover:bg-purple-50 transition-all shrink-0 whitespace-nowrap"
        >
          <i className="fas fa-magic mr-1" />
          <span className="hidden xs:inline">Auto-fill</span>
          <span className="xs:hidden">Auto</span>
        </button>
      </div>

      <div className="grid grid-cols-1 gap-1.5 sm:gap-2 max-h-[240px] sm:max-h-[300px] overflow-y-auto pr-0.5 sm:pr-1 custom-scrollbar">
        {DAYS.map((day) => {
          const assignment = schedule[day.key];
          const selectedBranchId = assignment?.branchId || "";
          
          return (
            <div
              key={day.key}
              className="group relative rounded-md sm:rounded-lg border border-slate-200 hover:border-purple-300 transition-all bg-white overflow-hidden hover:shadow-sm"
            >
              {/* Gradient accent bar */}
              <div className={`absolute left-0 top-0 bottom-0 w-0.5 sm:w-1 bg-gradient-to-b ${day.color}`} />
              
              <div className="flex items-center gap-1.5 sm:gap-2 p-2 sm:p-2.5 pl-2 sm:pl-3">
                {/* Day icon and name */}
                <div className="flex items-center gap-1 sm:gap-2 min-w-[90px] sm:min-w-[100px]">
                  <span className="text-sm sm:text-lg">{day.icon}</span>
                  <div>
                    <div className="text-[10px] sm:text-xs font-semibold text-slate-800">
                      {day.label}
                    </div>
                  </div>
                </div>

                {/* Branch selector */}
                <div className="flex-1 min-w-0">
                  <select
                    value={selectedBranchId}
                    onChange={(e) => handleDayChange(day.key, e.target.value)}
                    className="w-full border border-slate-200 rounded-md px-1.5 sm:px-2 py-1 sm:py-1.5 text-[10px] sm:text-xs bg-white focus:ring-2 focus:ring-purple-400 focus:border-purple-400 focus:outline-none transition"
                  >
                    <option value="">🏖️ Off Day</option>
                    {branches.map((branch) => (
                      <option key={branch.id} value={branch.id}>
                        🏢 {branch.name}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Status indicator */}
                <div className="shrink-0">
                  {assignment ? (
                    <div className="w-2 h-2 sm:w-2.5 sm:h-2.5 rounded-full bg-emerald-400" />
                  ) : (
                    <div className="w-2 h-2 sm:w-2.5 sm:h-2.5 rounded-full bg-slate-300" />
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Summary */}
      <div className="mt-2 sm:mt-3 pt-2 sm:pt-3 border-t border-purple-100">
        <div className="flex items-center justify-between text-[10px] sm:text-xs gap-2">
          <div className="flex items-center gap-1.5 sm:gap-3 flex-wrap">
            <div className="flex items-center gap-1 sm:gap-1.5 px-1.5 sm:px-2 py-0.5 sm:py-1 bg-emerald-50 rounded-md">
              <div className="w-1.5 h-1.5 sm:w-2 sm:h-2 rounded-full bg-emerald-400" />
              <span className="text-emerald-700 font-medium whitespace-nowrap">
                {Object.values(schedule).filter((s) => s !== null && s !== undefined).length} Working
              </span>
            </div>
            <div className="flex items-center gap-1 sm:gap-1.5 px-1.5 sm:px-2 py-0.5 sm:py-1 bg-slate-50 rounded-md">
              <div className="w-1.5 h-1.5 sm:w-2 sm:h-2 rounded-full bg-slate-300" />
              <span className="text-slate-600 font-medium whitespace-nowrap">
                {7 - Object.values(schedule).filter((s) => s !== null && s !== undefined).length} Off
              </span>
            </div>
          </div>
          
          <button
            type="button"
            onClick={() => onChange({})}
            className="text-rose-600 hover:text-rose-700 font-semibold hover:bg-rose-50 px-1.5 sm:px-2 py-0.5 sm:py-1 rounded-md transition-all shrink-0 whitespace-nowrap"
          >
            <i className="fas fa-times-circle mr-0.5 sm:mr-1" />
            <span className="hidden xs:inline">Clear All</span>
            <span className="xs:hidden">Clear</span>
          </button>
        </div>
      </div>
    </div>
  );
}

