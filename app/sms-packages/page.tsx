"use client";

import React, { useEffect, useState } from "react";
import Sidebar from "@/components/Sidebar";
import { SmsPackagesBoard } from "@/components/sms-packages-board";
import { useRouter } from "next/navigation";
import { auth } from "@/lib/firebase";
import { onAuthStateChanged } from "firebase/auth";
import { fetchCurrentUser } from "@/lib/authClient";

function SuperAdminSmsShell({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        router.replace("/login");
        return;
      }
      const me = await fetchCurrentUser();
      if (!me?.isSuperAdmin) {
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
          {children}
        </main>
      </div>
    </div>
  );
}

export default function SmsPackagesPage() {
  return (
    <SuperAdminSmsShell>
      <SmsPackagesBoard />
    </SuperAdminSmsShell>
  );
}
