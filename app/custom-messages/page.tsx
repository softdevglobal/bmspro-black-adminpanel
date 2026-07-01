"use client";

import React, { useEffect, useState } from "react";
import Sidebar from "@/components/Sidebar";
import { CustomMessagesBoard } from "@/components/custom-messages-board";
import { useRouter } from "next/navigation";
import { auth } from "@/lib/firebase";
import { fetchCurrentUser } from "@/lib/authClient";
import { onAuthStateChanged } from "firebase/auth";

export default function CustomMessagesPage() {
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        router.replace("/login");
        return;
      }
      try {
        const me = await fetchCurrentUser();
        if (!me?.isSuperAdmin) {
          router.replace("/admin-dashboard");
          return;
        }
        setReady(true);
      } catch {
        router.replace("/login");
      }
    });
    return () => unsub();
  }, [router]);

  if (!ready) {
    return (
      <div id="app" className="flex h-screen overflow-hidden bg-white">
        <Sidebar />
        <div className="flex flex-1 items-center justify-center bg-neutral-50">
          <div className="text-center">
            <i className="fas fa-spinner fa-spin mb-3 text-2xl text-neutral-400" />
            <p className="text-sm text-neutral-500">Loading custom notification…</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div id="app" className="flex h-screen overflow-hidden bg-white">
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <main className="flex-1 overflow-auto bg-neutral-50 p-4 sm:p-6 lg:p-8">
          <div className="mb-4 md:hidden">
            <button
              type="button"
              className="inline-flex items-center gap-2 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-neutral-700 shadow-sm hover:bg-neutral-50"
              onClick={() => setMobileOpen(true)}
            >
              <i className="fas fa-bars" />
              Menu
            </button>
          </div>

          {mobileOpen && (
            <div className="fixed inset-0 z-50 md:hidden">
              <div
                className="absolute inset-0 bg-black/40"
                onClick={() => setMobileOpen(false)}
                aria-hidden
              />
              <div className="absolute bottom-0 left-0 top-0">
                <Sidebar mobile onClose={() => setMobileOpen(false)} />
              </div>
            </div>
          )}

          <div className="mb-8">
            <div className="relative rounded-2xl bg-neutral-900 text-white p-6 shadow-sm overflow-hidden">
              <div className="absolute top-0 right-0 w-32 h-32 bg-white/5 rounded-full -translate-y-1/2 translate-x-1/2" />
              <div className="absolute bottom-0 left-1/3 w-20 h-20 bg-white/5 rounded-full translate-y-1/2" />
              <div className="absolute top-3 right-20 text-white/10 text-3xl">
                <i className="fas fa-bullhorn" />
              </div>
              <div className="relative flex items-center gap-3">
                <div className="w-11 h-11 rounded-xl bg-amber-500/20 flex items-center justify-center border border-amber-500/30">
                  <i className="fas fa-bullhorn text-amber-400" />
                </div>
                <div>
                  <h1 className="text-2xl font-bold">Custom notification</h1>
                  <p className="text-sm text-neutral-400 mt-1">
                    Platform-wide announcements for workshop owners and staff
                  </p>
                </div>
              </div>
            </div>
          </div>

          <div className="mx-auto max-w-7xl">
            <CustomMessagesBoard />
          </div>
        </main>
      </div>
    </div>
  );
}
