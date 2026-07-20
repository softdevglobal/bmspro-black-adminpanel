"use client";

import { useState } from "react";
import Sidebar from "@/components/Sidebar";
import ServiceReminderSettingsPanel from "@/components/bookings/ServiceReminderSettingsPanel";

export default function ServiceReminderPage() {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="flex h-screen overflow-hidden bg-white">
      {sidebarOpen && (
        <div className="fixed inset-0 z-[100] md:hidden">
          <div
            className="absolute inset-0 bg-black/50 backdrop-blur-sm"
            onClick={() => setSidebarOpen(false)}
          />
          <div className="relative h-full w-64 bg-neutral-900 shadow-2xl">
            <Sidebar mobile onClose={() => setSidebarOpen(false)} />
          </div>
        </div>
      )}

      <Sidebar />

      <div className="flex-1 flex flex-col overflow-hidden">
        <main className="flex-1 overflow-auto p-4 sm:p-6 lg:p-8 bg-neutral-50">
          <div className="max-w-7xl mx-auto">
            <div className="mb-8">
              <div className="relative rounded-2xl bg-neutral-900 text-white p-6 shadow-sm overflow-hidden">
                <div className="absolute top-0 right-0 w-32 h-32 bg-white/5 rounded-full -translate-y-1/2 translate-x-1/2" />
                <div className="absolute bottom-0 left-1/3 w-20 h-20 bg-white/5 rounded-full translate-y-1/2" />
                <div className="absolute top-3 right-20 text-white/10 text-3xl">
                  <i className="fas fa-bell" />
                </div>

                <div className="relative flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setSidebarOpen(true)}
                    className="md:hidden p-2 -ml-2 hover:bg-white/20 rounded-lg transition-colors"
                  >
                    <i className="fas fa-bars text-xl" />
                  </button>
                  <div className="w-11 h-11 rounded-xl bg-amber-500/20 flex items-center justify-center border border-amber-500/30">
                    <i className="fas fa-bell text-amber-400" />
                  </div>
                  <div>
                    <h1 className="text-xl sm:text-2xl font-bold">Service Reminder</h1>
                    <p className="text-neutral-400 text-xs mt-0.5">
                      Set how long after each service customers should be reminded
                    </p>
                  </div>
                </div>
              </div>
            </div>

            <ServiceReminderSettingsPanel />
          </div>
        </main>
      </div>
    </div>
  );
}
