"use client";

import React, { useEffect, useState } from "react";
import Sidebar from "@/components/Sidebar";
import { SmsLogBoard } from "@/components/sms-log-board";
import { useRouter } from "next/navigation";
import { auth, db } from "@/lib/firebase";
import { onAuthStateChanged } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";

export default function OwnerSmsLogPage() {
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        router.replace("/login");
        return;
      }
      const snap = await getDoc(doc(db, "users", user.uid));
      const role = (snap.data()?.role || "").toString();
      if (role !== "workshop_owner") {
        router.replace("/dashboard");
        return;
      }
      setReady(true);
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
            <p className="text-sm text-neutral-500">Loading SMS log…</p>
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
            <div className="relative overflow-hidden rounded-2xl bg-neutral-900 p-6 text-white shadow-sm">
              <div className="absolute top-0 right-0 h-32 w-32 translate-x-1/2 -translate-y-1/2 rounded-full bg-white/5" />
              <div className="absolute bottom-0 left-1/3 h-20 w-20 translate-y-1/2 rounded-full bg-white/5" />
              <div className="absolute right-20 top-3 text-3xl text-white/10">
                <i className="fas fa-list" />
              </div>
              <div className="relative flex items-center gap-3">
                <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-amber-500/30 bg-amber-500/20">
                  <i className="fas fa-list text-amber-400" />
                </div>
                <div>
                  <h1 className="text-2xl font-bold">SMS Log</h1>
                  <p className="mt-1 text-sm text-neutral-400">
                    Outbound SMS delivery history for your workshop
                  </p>
                </div>
              </div>
            </div>
          </div>

          <div className="mx-auto max-w-7xl">
            <SmsLogBoard variant="tenant" />
          </div>
        </main>
      </div>
    </div>
  );
}
