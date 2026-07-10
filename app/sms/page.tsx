"use client";

import React, { Suspense, useEffect, useState } from "react";
import Sidebar from "@/components/Sidebar";
import { OwnerSmsBoard } from "@/components/owner-sms-board";
import { useRouter } from "next/navigation";
import { auth, db } from "@/lib/firebase";
import { onAuthStateChanged } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";

export default function OwnerSmsPage() {
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
          <i className="fas fa-spinner fa-spin text-2xl text-neutral-400" />
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
              onClick={() => setMobileOpen(true)}
              className="rounded-lg border border-neutral-300 px-3 py-2 text-sm"
            >
              <i className="fas fa-bars mr-2" />
              Menu
            </button>
            {mobileOpen && <Sidebar mobile onClose={() => setMobileOpen(false)} />}
          </div>
          <Suspense
            fallback={
              <div className="rounded-2xl border border-neutral-200 bg-white p-10 text-center text-neutral-500">
                <i className="fas fa-spinner fa-spin mr-2" />
                Loading SMS balance…
              </div>
            }
          >
            <OwnerSmsBoard />
          </Suspense>
        </main>
      </div>
    </div>
  );
}
