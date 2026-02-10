"use client";
import React, { useMemo, useState, useEffect } from "react";
import Sidebar from "@/components/Sidebar";
import { useRouter } from "next/navigation";
import { onAuthStateChanged } from "firebase/auth";

type TabKey = "invoices" | "plans" | "settings";
type Period = "monthly" | "yearly";

export default function BillingPage() {
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<TabKey>("invoices");
  const [period, setPeriod] = useState<Period>("monthly");
  const [invoiceModalOpen, setInvoiceModalOpen] = useState(false);

  const price = useMemo(
    () => ({
      starter: period === "monthly" ? 99 : 99 * 10, // 2 months free
      pro: period === "monthly" ? 149 : 149 * 10,
      enterprise: period === "monthly" ? 299 : 299 * 10,
      suffix: period === "monthly" ? "/month" : "/year",
    }),
    [period]
  );

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
          // Resolve ownerUid based on role
          const { getDoc, doc } = await import("firebase/firestore");
          const { db } = await import("@/lib/firebase");
          const snap = await getDoc(doc(db, "users", user.uid));
          const role = (snap.data()?.role || "").toString();

          if (role === "salon_branch_admin") {
            router.replace("/branches");
            return;
          }
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
              className="inline-flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-slate-700 shadow-sm hover:bg-slate-50"
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
              />
              <div className="absolute left-0 top-0 bottom-0">
                <Sidebar mobile onClose={() => setMobileOpen(false)} />
              </div>
            </div>
          )}

          <div className="mb-8">
            <div className="rounded-2xl bg-gradient-to-r from-pink-500 via-fuchsia-600 to-indigo-600 text-white p-6 shadow-sm">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-white/20 flex items-center justify-center">
                      <i className="fas fa-credit-card" />
                    </div>
                    <h1 className="text-2xl font-bold">Billing & Invoices</h1>
                  </div>
                  <p className="text-sm text-white/80 mt-2">
                    Manage invoices, plans, and payment settings
                  </p>
                </div>
              </div>
            </div>
          </div>

          <div id="financial-overview" className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-6 mb-8 min-w-0">
            <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm min-w-0">
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm font-medium text-slate-600">Outstanding (Due)</span>
                <div className="w-10 h-10 bg-rose-50 rounded-xl flex items-center justify-center">
                  <i className="fas fa-exclamation-triangle text-rose-500" />
                </div>
              </div>
              <div className="mb-2">
                <h3 className="text-3xl font-bold text-rose-600">AU$ 4,250</h3>
              </div>
              <div className="flex items-center space-x-2">
                <span className="px-2 py-1 bg-rose-50 text-rose-700 rounded-lg text-xs font-semibold">8 overdue invoices</span>
              </div>
            </div>
            <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm min-w-0">
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm font-medium text-slate-600">Collected (This Month)</span>
                <div className="w-10 h-10 bg-emerald-50 rounded-xl flex items-center justify-center">
                  <i className="fas fa-dollar-sign text-emerald-500" />
                </div>
              </div>
              <div className="mb-2">
                <h3 className="text-3xl font-bold text-emerald-600">AU$ 48,900</h3>
              </div>
              <div className="flex items-center space-x-2">
                <span className="px-2 py-1 bg-emerald-50 text-emerald-700 rounded-lg text-xs font-semibold flex items-center">
                  <i className="fas fa-arrow-up text-xs mr-1" />
                  +18%
                </span>
                <span className="text-xs text-slate-500">vs last month</span>
              </div>
            </div>
            <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm min-w-0">
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm font-medium text-slate-600">Next Payout</span>
                <div className="w-10 h-10 bg-blue-50 rounded-xl flex items-center justify-center">
                  <i className="fas fa-calendar-check text-blue-500" />
                </div>
              </div>
              <div className="mb-2">
                <h3 className="text-3xl font-bold text-slate-900">AU$ 12,680</h3>
              </div>
              <div className="flex items-center space-x-2">
                <span className="text-xs text-slate-500">Est. 15 Jan 2025</span>
              </div>
            </div>
            <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm min-w-0">
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm font-medium text-slate-600">Active Subscriptions</span>
                <div className="w-10 h-10 bg-pink-50 rounded-xl flex items-center justify-center">
                  <i className="fas fa-users text-pink-500" />
                </div>
              </div>
              <div className="mb-2">
                <h3 className="text-3xl font-bold text-slate-900">142</h3>
              </div>
              <div className="flex items-center space-x-2">
                <span className="px-2 py-1 bg-emerald-50 text-emerald-700 rounded-lg text-xs font-semibold flex items-center">
                  <i className="fas fa-plus text-xs mr-1" />
                  +5
                </span>
                <span className="text-xs text-slate-500">this week</span>
              </div>
            </div>
          </div>

          <div id="main-content-section" className="bg-white rounded-2xl border border-slate-200 shadow-sm">
            <div className="border-b border-slate-200">
              <div className="flex items-center space-x-4 sm:space-x-8 px-4 sm:px-8 overflow-x-auto whitespace-nowrap">
                <button
                  onClick={() => setActiveTab("invoices")}
                  className={`py-4 text-sm font-medium transition ${activeTab === "invoices" ? "text-pink-600 border-b-2 border-pink-600" : "text-slate-600 hover:text-pink-500"}`}
                >
                  Invoices
                </button>
                <button
                  onClick={() => setActiveTab("plans")}
                  className={`py-4 text-sm font-medium transition ${activeTab === "plans" ? "text-pink-600 border-b-2 border-pink-600" : "text-slate-600 hover:text-pink-500"}`}
                >
                  Subscription Plans
                </button>
                <button
                  onClick={() => setActiveTab("settings")}
                  className={`py-4 text-sm font-medium transition ${activeTab === "settings" ? "text-pink-600 border-b-2 border-pink-600" : "text-slate-600 hover:text-pink-500"}`}
                >
                  Payment Settings
                </button>
              </div>
            </div>

            {activeTab === "invoices" && (
              <div id="invoices-tab" className="p-4 sm:p-8">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-6">
                  <div className="w-full flex flex-col sm:flex-row sm:flex-wrap sm:items-center gap-3">
                    <select className="w-full sm:w-auto px-4 py-2.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-pink-500 focus:border-transparent">
                      <option>All Status</option>
                      <option>Paid</option>
                      <option>Unpaid</option>
                      <option>Overdue</option>
                    </select>
                    <input type="date" className="w-full sm:w-auto px-4 py-2.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-pink-500 focus:border-transparent" />
                    <span className="hidden sm:inline text-slate-400">to</span>
                    <input type="date" className="w-full sm:w-auto px-4 py-2.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-pink-500 focus:border-transparent" />
                  </div>
                  <button
                    onClick={() => setInvoiceModalOpen(true)}
                    className="w-full sm:w-auto h-12 sm:h-10 px-6 sm:px-5 py-3 sm:py-2.5 bg-gradient-to-r from-pink-500 to-pink-600 text-white font-semibold rounded-lg hover:from-pink-600 hover:to-pink-700 transition flex items-center justify-center sm:justify-start space-x-2 shadow-lg whitespace-nowrap"
                  >
                    <i className="fas fa-plus text-sm" />
                    <span className="whitespace-nowrap">New Invoice</span>
                  </button>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead className="bg-slate-50 border-b border-slate-200">
                      <tr>
                        <th className="px-6 py-4 text-left text-xs font-semibold text-slate-600 uppercase tracking-wider">Invoice ID</th>
                        <th className="px-6 py-4 text-left text-xs font-semibold text-slate-600 uppercase tracking-wider">Tenant</th>
                        <th className="px-6 py-4 text-left text-xs font-semibold text-slate-600 uppercase tracking-wider">Date Issued</th>
                        <th className="px-6 py-4 text-left text-xs font-semibold text-slate-600 uppercase tracking-wider">Amount</th>
                        <th className="px-6 py-4 text-left text-xs font-semibold text-slate-600 uppercase tracking-wider">Status</th>
                        <th className="px-6 py-4 text-right text-xs font-semibold text-slate-600 uppercase tracking-wider">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200">
                      {[
                        {
                          id: "#INV-2025-001",
                          abbr: "BG",
                          name: "Bondi Glow Studio",
                          date: "05 Jan 2025",
                          amount: "$149.00",
                          status: { label: "Paid", cls: "bg-emerald-50 text-emerald-700", icon: "fa-check-circle" },
                          colors: "from-pink-400 to-pink-600",
                        },
                        {
                          id: "#INV-2025-002",
                          abbr: "MC",
                          name: "Melbourne Cuts Pty Ltd",
                          date: "03 Jan 2025",
                          amount: "$299.00",
                          status: { label: "Overdue", cls: "bg-rose-50 text-rose-700", icon: "fa-exclamation-circle" },
                          colors: "from-purple-400 to-purple-600",
                        },
                        {
                          id: "#INV-2025-003",
                          abbr: "GC",
                          name: "Gold Coast Beauty Bar",
                          date: "08 Jan 2025",
                          amount: "$99.00",
                          status: { label: "Pending", cls: "bg-amber-50 text-amber-700", icon: "fa-clock" },
                          colors: "from-amber-400 to-amber-600",
                        },
                      ].map((r) => (
                        <tr key={r.id} className="hover:bg-slate-50 transition">
                          <td className="px-6 py-4">
                            <span className="font-mono text-sm font-semibold text-slate-900">{r.id}</span>
                          </td>
                          <td className="px-6 py-4">
                            <div className="flex items-center space-x-3">
                              <div className={`w-8 h-8 bg-gradient-to-br ${r.colors} rounded-lg flex items-center justify-center`}>
                                <span className="text-white font-semibold text-xs">{r.abbr}</span>
                              </div>
                              <span className="font-medium text-slate-900">{r.name}</span>
                            </div>
                          </td>
                          <td className="px-6 py-4 text-sm text-slate-600">{r.date}</td>
                          <td className="px-6 py-4">
                            <div className="font-semibold text-slate-900">{r.amount}</div>
                            <div className="text-xs text-slate-500">inc. GST</div>
                          </td>
                          <td className="px-6 py-4">
                            <span className={`px-3 py-1 ${r.status.cls} rounded-lg text-sm font-medium flex items-center w-fit`}>
                              <i className={`fas ${r.status.icon} text-xs mr-1.5`} />
                              {r.status.label}
                            </span>
                          </td>
                          <td className="px-6 py-4 text-right">
                            <div className="flex items-center justify-end space-x-2">
                              <button className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition" title="Download PDF">
                                <i className="fas fa-download text-sm" />
                              </button>
                              <button className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition" title="Resend Email">
                                <i className="fas fa-envelope text-sm" />
                              </button>
                              {r.status.label !== "Paid" && (
                                <button className="p-2 text-rose-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition" title="Send Reminder">
                                  <i className="fas fa-bell text-sm" />
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {activeTab === "plans" && (
              <div id="plans-tab" className="p-8">
                <div className="flex items-center justify-between mb-8">
                  <div>
                    <h3 className="text-xl font-bold text-slate-900">Subscription Plans</h3>
                    <p className="text-sm text-slate-500 mt-1">Manage pricing tiers and features</p>
                  </div>
                  <div className="flex items-center space-x-3 bg-slate-100 rounded-lg p-1">
                    <button
                      onClick={() => setPeriod("monthly")}
                      className={`px-4 py-2 rounded-md text-sm font-semibold ${period === "monthly" ? "bg-white text-slate-900 shadow-sm" : "text-slate-600"}`}
                    >
                      Monthly
                    </button>
                    <button
                      onClick={() => setPeriod("yearly")}
                      className={`px-4 py-2 rounded-md text-sm font-semibold ${period === "yearly" ? "bg-white text-slate-900 shadow-sm" : "text-slate-600"}`}
                    >
                      Yearly
                    </button>
                  </div>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  <div className="plan-card bg-white border-2 border-slate-200 rounded-2xl p-8 hover:border-blue-400">
                    <div className="text-center mb-6">
                      <div className="w-16 h-16 bg-blue-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
                        <i className="fas fa-star text-blue-600 text-2xl" />
                      </div>
                      <h4 className="text-2xl font-bold text-slate-900 mb-2">Starter</h4>
                      <div className="mb-4">
                        <span className="text-4xl font-bold text-slate-900">${price.starter}</span>
                        <span className="text-slate-500 text-sm">{price.suffix}</span>
                      </div>
                      <p className="text-sm text-slate-600">Perfect for small salons</p>
                    </div>
                    <ul className="space-y-3 mb-8">
                      <li className="flex items-center text-sm text-slate-700"><i className="fas fa-check text-emerald-500 mr-3" />1 Location</li>
                      <li className="flex items-center text-sm text-slate-700"><i className="fas fa-check text-emerald-500 mr-3" />Basic Scheduling</li>
                      <li className="flex items-center text-sm text-slate-700"><i className="fas fa-check text-emerald-500 mr-3" />Client Management</li>
                      <li className="flex items-center text-sm text-slate-700"><i className="fas fa-check text-emerald-500 mr-3" />Email Support</li>
                    </ul>
                    <button className="w-full py-3 border-2 border-slate-300 text-slate-700 font-semibold rounded-lg hover:bg-slate-50 transition">Edit Plan</button>
                  </div>
                  <div className="plan-card bg-gradient-to-br from-pink-50 to-pink-100 border-2 border-pink-400 rounded-2xl p-8 relative">
                    <div className="absolute top-4 right-4">
                      <span className="px-3 py-1 bg-pink-500 text-white text-xs font-bold rounded-full">POPULAR</span>
                    </div>
                    <div className="text-center mb-6">
                      <div className="w-16 h-16 bg-pink-500 rounded-2xl flex items-center justify-center mx-auto mb-4">
                        <i className="fas fa-crown text-white text-2xl" />
                      </div>
                      <h4 className="text-2xl font-bold text-slate-900 mb-2">Pro</h4>
                      <div className="mb-4">
                        <span className="text-4xl font-bold text-slate-900">${price.pro}</span>
                        <span className="text-slate-600 text-sm">{price.suffix}</span>
                      </div>
                      <p className="text-sm text-slate-700">Most popular choice</p>
                    </div>
                    <ul className="space-y-3 mb-8">
                      <li className="flex items-center text-sm text-slate-800"><i className="fas fa-check text-pink-600 mr-3" />3 Locations</li>
                      <li className="flex items-center text-sm text-slate-800"><i className="fas fa-check text-pink-600 mr-3" />Advanced Scheduling</li>
                      <li className="flex items-center text-sm text-slate-800"><i className="fas fa-check text-pink-600 mr-3" />Marketing Tools</li>
                      <li className="flex items-center text-sm text-slate-800"><i className="fas fa-check text-pink-600 mr-3" />Priority Support</li>
                      <li className="flex items-center text-sm text-slate-800"><i className="fas fa-check text-pink-600 mr-3" />Analytics Dashboard</li>
                    </ul>
                    <button className="w-full py-3 bg-pink-500 text-white font-semibold rounded-lg hover:bg-pink-600 transition shadow-lg">Edit Plan</button>
                  </div>
                  <div className="plan-card bg-white border-2 border-slate-200 rounded-2xl p-8 hover:border-amber-400">
                    <div className="text-center mb-6">
                      <div className="w-16 h-16 bg-amber-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
                        <i className="fas fa-building text-amber-600 text-2xl" />
                      </div>
                      <h4 className="text-2xl font-bold text-slate-900 mb-2">Enterprise</h4>
                      <div className="mb-4">
                        <span className="text-4xl font-bold text-slate-900">${price.enterprise}</span>
                        <span className="text-slate-500 text-sm">{price.suffix}</span>
                      </div>
                      <p className="text-sm text-slate-600">Best for large organizations</p>
                    </div>
                    <ul className="space-y-3 mb-8">
                      <li className="flex items-center text-sm text-slate-700"><i className="fas fa-check text-emerald-500 mr-3" />Unlimited</li>
                      <li className="flex items-center text-sm text-slate-700"><i className="fas fa-check text-emerald-500 mr-3" />SLA & Priority Support</li>
                      <li className="flex items-center text-sm text-slate-700"><i className="fas fa-check text-emerald-500 mr-3" />Dedicated Success Manager</li>
                    </ul>
                    <button className="w-full py-3 border-2 border-slate-300 text-slate-700 font-semibold rounded-lg hover:bg-slate-50 transition">Edit Plan</button>
                  </div>
                </div>
              </div>
            )}

            {activeTab === "settings" && (
              <div id="settings-tab" className="p-8">
                <h3 className="text-xl font-bold text-slate-900 mb-4">Payment Settings</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="bg-white border border-slate-200 rounded-xl p-6">
                    <h4 className="font-semibold text-slate-900 mb-3">Payout Account</h4>
                    <p className="text-sm text-slate-600 mb-4">Update your bank details for payouts.</p>
                    <button className="px-4 py-2 border border-slate-300 rounded-lg hover:bg-slate-50 text-sm">Update</button>
                  </div>
                  <div className="bg-white border border-slate-200 rounded-xl p-6">
                    <h4 className="font-semibold text-slate-900 mb-3">Tax Settings</h4>
                    <p className="text-sm text-slate-600 mb-4">Configure GST and region-specific tax rules.</p>
                    <button className="px-4 py-2 border border-slate-300 rounded-lg hover:bg-slate-50 text-sm">Configure</button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </main>
      </div>

      {invoiceModalOpen && (
        <div className="fixed inset-0 z-50">
          <div className="absolute inset-0 bg-black/50" onClick={() => setInvoiceModalOpen(false)} />
          <div className="relative flex items-start md:items-center justify-center min-h-screen p-4 overflow-y-auto">
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-xl max-h-[90vh] flex flex-col">
              <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
                <h3 className="text-lg font-bold text-slate-900">New Invoice</h3>
                <button onClick={() => setInvoiceModalOpen(false)} className="p-2 hover:bg-slate-100 rounded-lg transition">
                  <i className="fas fa-times text-slate-400" />
                </button>
              </div>
              <div className="p-6 space-y-4 flex-1 overflow-y-auto">
                <div>
                  <label className="block text-sm font-semibold text-slate-700 mb-2">Tenant</label>
                  <input className="w-full px-4 py-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-pink-500 focus:border-transparent" placeholder="Tenant name" />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-semibold text-slate-700 mb-2">Amount</label>
                    <input className="w-full px-4 py-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-pink-500 focus:border-transparent" placeholder="149.00" />
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-slate-700 mb-2">Date</label>
                    <input type="date" className="w-full px-4 py-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-pink-500 focus:border-transparent" />
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-semibold text-slate-700 mb-2">Notes</label>
                  <textarea rows={3} className="w-full px-4 py-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-pink-500 focus:border-transparent" placeholder="Optional notes" />
                </div>
              </div>
              <div className="px-6 py-4 border-t border-slate-200 flex items-center justify-end">
                <button onClick={() => setInvoiceModalOpen(false)} className="px-6 py-3 text-slate-700 font-semibold hover:bg-slate-100 rounded-lg transition mr-3">Cancel</button>
                <button onClick={() => setInvoiceModalOpen(false)} className="px-6 py-3 bg-pink-600 text-white font-semibold rounded-lg hover:bg-pink-700 transition">Create Invoice</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


