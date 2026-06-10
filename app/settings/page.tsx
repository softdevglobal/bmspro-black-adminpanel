"use client";
import React, { useEffect, useState } from "react";
import Sidebar from "@/components/Sidebar";
import { useRouter } from "next/navigation";
import { onAuthStateChanged } from "firebase/auth";
import { db } from "@/lib/firebase";
import { doc, getDoc } from "firebase/firestore";

export default function SettingsPage() {
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    (async () => {
      const { auth } = await import("@/lib/firebase");
      const unsub = onAuthStateChanged(auth, async (user) => {
        if (!user) {
          router.replace("/login");
          return;
        }
        try {
          const token = await user.getIdToken();
          if (typeof window !== "undefined") localStorage.setItem("idToken", token);
        } catch {
          router.replace("/login");
          return;
        }
        try {
          const snap = await getDoc(doc(db, "users", user.uid));
          const role = (snap.data()?.role || "").toString();
          if (role === "branch_admin") {
            router.replace("/branches");
            return;
          }
          if (role !== "super_admin") {
            router.replace("/dashboard");
            return;
          }
          setMounted(true);
        } catch {
          router.replace("/login");
        }
      });
      return () => unsub();
    })();
  }, [router]);

  return (
    <div id="app" className="flex h-screen overflow-hidden bg-white">
      <Sidebar />
      <div className="flex-1 flex flex-col overflow-hidden">
        <main className="flex-1 overflow-auto p-4 sm:p-6 lg:p-8">
          <div className="md:hidden mb-4">
            <button
              className="inline-flex items-center gap-2 rounded-lg border border-neutral-200 px-3 py-2 text-neutral-700 shadow-sm hover:bg-neutral-50"
              onClick={() => setMobileOpen(true)}
            >
              <i className="fas fa-bars" />
              Menu
            </button>
          </div>

          {mobileOpen && (
            <div className="fixed inset-0 z-50 md:hidden">
              <div className="absolute inset-0 bg-black/40" onClick={() => setMobileOpen(false)} />
              <div className="absolute left-0 top-0 bottom-0">
                <Sidebar mobile onClose={() => setMobileOpen(false)} />
              </div>
            </div>
          )}

          {mounted && (
            <>
              <div className="mb-8">
                <div className="relative rounded-2xl bg-neutral-900 text-white p-6 shadow-sm overflow-hidden">
                  <div className="absolute top-0 right-0 w-32 h-32 bg-white/5 rounded-full -translate-y-1/2 translate-x-1/2" />
                  <div className="absolute bottom-0 left-1/3 w-20 h-20 bg-white/5 rounded-full translate-y-1/2" />
                  <div className="absolute top-3 right-20 text-white/10 text-3xl"><i className="fas fa-gear" /></div>
                  <div className="absolute bottom-2 right-40 text-white/10 text-xl"><i className="fas fa-wrench" /></div>
                  <div className="relative flex items-center gap-3">
                    <div className="w-11 h-11 rounded-xl bg-amber-500/20 flex items-center justify-center border border-amber-500/30">
                      <i className="fas fa-cog text-amber-400" />
                    </div>
                    <div>
                      <h1 className="text-2xl font-bold">Platform Settings</h1>
                      <p className="text-sm text-neutral-400 mt-1">Branding, email, and security for the whole platform</p>
                    </div>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <section className="lg:col-span-2 space-y-6">
                  <div className="bg-white border border-neutral-200 rounded-2xl p-6">
                    <h2 className="text-lg font-semibold text-neutral-900 mb-4">General</h2>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-neutral-700 mb-2">Product Name</label>
                        <input
                          placeholder="BMS PRO WORKSHOP"
                          className="w-full px-4 py-3 border border-neutral-300 rounded-lg focus:ring-2 focus:ring-neutral-900 focus:border-transparent"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-neutral-700 mb-2">Support Email</label>
                        <input
                          type="email"
                          placeholder="support@bmspro.au"
                          className="w-full px-4 py-3 border border-neutral-300 rounded-lg focus:ring-2 focus:ring-neutral-900 focus:border-transparent"
                        />
                      </div>
                      <div className="sm:col-span-2">
                        <label className="block text-sm font-medium text-neutral-700 mb-2">Company Address</label>
                        <textarea
                          rows={3}
                          placeholder="Street, City, Postcode, Country"
                          className="w-full px-4 py-3 border border-neutral-300 rounded-lg focus:ring-2 focus:ring-neutral-900 focus:border-transparent"
                        />
                      </div>
                    </div>
                    <div className="mt-4 flex justify-end">
                      <button className="px-5 py-2.5 bg-neutral-900 text-white rounded-lg font-semibold hover:bg-neutral-800">
                        Save General
                      </button>
                    </div>
                  </div>

                  <div className="bg-white border border-neutral-200 rounded-2xl p-6">
                    <h2 className="text-lg font-semibold text-neutral-900 mb-4">Email Provider</h2>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-neutral-700 mb-2">Provider</label>
                        <select className="w-full px-4 py-3 border border-neutral-300 rounded-lg focus:ring-2 focus:ring-neutral-900 focus:border-transparent bg-white">
                          <option>SendGrid</option>
                          <option>Postmark</option>
                          <option>Amazon SES</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-neutral-700 mb-2">API Key</label>
                        <input
                          type="password"
                          placeholder="********"
                          className="w-full px-4 py-3 border border-neutral-300 rounded-lg focus:ring-2 focus:ring-neutral-900 focus:border-transparent"
                        />
                      </div>
                    </div>
                    <div className="mt-4 flex justify-end">
                      <button className="px-5 py-2.5 bg-neutral-900 text-white rounded-lg font-semibold hover:bg-neutral-800">
                        Save Email
                      </button>
                    </div>
                  </div>

                  <div className="bg-white border border-neutral-200 rounded-2xl p-6">
                    <h2 className="text-lg font-semibold text-neutral-900 mb-4">Security</h2>
                    <div className="space-y-4">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="font-medium text-neutral-900">Require 2FA for admins</p>
                          <p className="text-sm text-neutral-500">Enforce two-factor authentication for all admin users</p>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer">
                          <input type="checkbox" className="sr-only peer" />
                          <div className="w-11 h-6 bg-neutral-300 peer-focus:ring-2 peer-focus:ring-neutral-900 rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-neutral-900"></div>
                        </label>
                      </div>
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="font-medium text-neutral-900">Session timeout</p>
                          <p className="text-sm text-neutral-500">Auto sign-out after inactivity</p>
                        </div>
                        <select className="px-3 py-2 border border-neutral-300 rounded-lg bg-white">
                          <option>30 minutes</option>
                          <option>1 hour</option>
                          <option>2 hours</option>
                        </select>
                      </div>
                    </div>
                  </div>
                </section>

                <aside className="space-y-6">
                  <div className="bg-white border border-neutral-200 rounded-2xl p-6">
                    <h3 className="text-base font-semibold text-neutral-900 mb-4">Branding</h3>
                    <div className="space-y-4">
                      <div>
                        <label className="block text-sm font-medium text-neutral-700 mb-2">Logo</label>
                        <div className="flex items-center justify-center border border-dashed border-neutral-300 rounded-xl h-28 text-neutral-500">
                          <i className="fas fa-upload mr-2" />
                          Upload PNG/SVG
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="bg-white border border-neutral-200 rounded-2xl p-6">
                    <h3 className="text-base font-semibold text-neutral-900 mb-2">Danger Zone</h3>
                    <p className="text-sm text-neutral-500 mb-4">Actions that can have serious consequences.</p>
                    <button className="w-full px-5 py-2.5 bg-rose-600 text-white rounded-lg font-semibold hover:bg-rose-700">
                      Reset Platform Cache
                    </button>
                  </div>
                </aside>
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}



