"use client";

import Link from "next/link";
import Sidebar from "@/components/Sidebar";
import { useRouter } from "next/navigation";
import { onAuthStateChanged } from "firebase/auth";
import React, { useEffect, useState } from "react";

type Variant = "quotation" | "invoice";

type VariantConfig = {
  title: string;
  subtitle: string;
  heroIcon: string;
  createHref: string;
  createLabel: string;
  emptyTitle: string;
  emptyBody: string;
  columns: string[];
};

const VARIANT_CONFIG: Record<Variant, VariantConfig> = {
  quotation: {
    title: "Quotations",
    subtitle: "Create and manage quotes sent to your customers.",
    heroIcon: "fa-file-lines",
    createHref: "/quotations/create",
    createLabel: "New Quotation",
    emptyTitle: "No quotations yet",
    emptyBody: "Create your first quotation and send it to a customer.",
    columns: ["Quote", "Customer", "Date", "Amount", "Status"],
  },
  invoice: {
    title: "Invoices",
    subtitle: "Create and send invoices to your customers.",
    heroIcon: "fa-file-invoice-dollar",
    createHref: "/invoices/create",
    createLabel: "New Invoice",
    emptyTitle: "No invoices yet",
    emptyBody: "Create your first invoice and send it to a customer.",
    columns: ["Invoice", "Customer", "Date", "Amount", "Status"],
  },
};

export default function DocumentListPage({ variant }: { variant: Variant }) {
  const config = VARIANT_CONFIG[variant];
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    let unsub: (() => void) | undefined;
    (async () => {
      const { auth } = await import("@/lib/firebase");
      unsub = onAuthStateChanged(auth, (user) => {
        if (!user) router.replace("/login");
      });
    })();
    return () => {
      if (unsub) unsub();
    };
  }, [router]);

  return (
    <div id="app" className="flex h-screen overflow-hidden bg-white">
      <Sidebar />
      <div className="flex-1 flex flex-col overflow-hidden">
        <main className="flex-1 overflow-auto p-4 sm:p-6 lg:p-8 bg-neutral-50">
          {/* Mobile menu */}
          <div className="md:hidden mb-4">
            <button
              className="inline-flex items-center gap-2 rounded-lg border border-neutral-200 px-3 py-2 text-neutral-700 shadow-sm hover:bg-neutral-50 bg-white"
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

          {/* Hero header */}
          <div className="mb-6">
            <div className="relative rounded-2xl bg-neutral-900 text-white p-6 shadow-sm overflow-hidden">
              <div className="absolute top-0 right-0 w-32 h-32 bg-white/5 rounded-full -translate-y-1/2 translate-x-1/2" />
              <div className="absolute bottom-0 left-1/3 w-20 h-20 bg-white/5 rounded-full translate-y-1/2" />
              <div className="relative">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-white/10 flex items-center justify-center">
                    <i className={`fas ${config.heroIcon} text-amber-400`} />
                  </div>
                  <h1 className="text-2xl font-bold">{config.title}</h1>
                </div>
                <p className="text-sm text-neutral-400 mt-2">{config.subtitle}</p>
              </div>
            </div>
          </div>

          {/* Toolbar */}
          <div className="mb-4 flex items-center justify-end">
            <Link
              href={config.createHref}
              className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg text-sm font-semibold bg-neutral-900 text-white hover:bg-neutral-800 transition shadow-sm"
            >
              <i className="fas fa-plus" />
              {config.createLabel}
            </Link>
          </div>

          {/* List card */}
          <div className="bg-white rounded-2xl border border-neutral-200 shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-neutral-50 border-b border-neutral-200 text-xs font-semibold uppercase tracking-wider text-neutral-600">
                  <tr>
                    {config.columns.map((col) => (
                      <th key={col} className="px-6 py-4">
                        {col}
                      </th>
                    ))}
                    <th className="px-6 py-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td colSpan={config.columns.length + 1}>
                      <div className="flex flex-col items-center justify-center gap-4 px-6 py-16 text-center">
                        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-neutral-100">
                          <i className={`fas ${config.heroIcon} text-xl text-neutral-400`} />
                        </div>
                        <div>
                          <p className="text-base font-semibold text-neutral-900">{config.emptyTitle}</p>
                          <p className="mt-1 text-sm text-neutral-500">{config.emptyBody}</p>
                        </div>
                        <Link
                          href={config.createHref}
                          className="inline-flex items-center gap-2 rounded-lg bg-neutral-900 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-neutral-800"
                        >
                          <i className="fas fa-plus" />
                          {config.createLabel}
                        </Link>
                      </div>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
