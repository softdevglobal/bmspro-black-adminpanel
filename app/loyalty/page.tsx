"use client";
import React, { useEffect, useState } from "react";
import Sidebar from "@/components/Sidebar";
import { useRouter } from "next/navigation";
import { onAuthStateChanged } from "firebase/auth";
import { auth, db } from "@/lib/firebase";
import { doc, getDoc, setDoc, collection, query, where, onSnapshot, serverTimestamp, orderBy, limit } from "firebase/firestore";

type ACSUData = {
  balance: number;
  conversionRate: number;
  currency: string;
  isEnabled: boolean;
};

type ACSUTransaction = {
  id?: string;
  email: string;
  name: string;
  staff: string;
  branch: string;
  service: string;
  value: number;
  points: number;
  date: string;
  bookingId?: string;
  ownerUid: string;
};

export default function LoyaltyPage() {
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [ownerUid, setOwnerUid] = useState<string | null>(null);
  const [acsuData, setAcsuData] = useState<ACSUData>({
    balance: 0,
    conversionRate: 10,
    currency: "AUD",
    isEnabled: true,
  });
  const [transactions, setTransactions] = useState<ACSUTransaction[]>([]);
  const [showTopupModal, setShowTopupModal] = useState(false);
  const [topupAmount, setTopupAmount] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        router.replace("/login");
        return;
      }
      try {
        const token = await user.getIdToken();
        if (typeof window !== "undefined") localStorage.setItem("idToken", token);

        const snap = await getDoc(doc(db, "users", user.uid));
        const data = snap.data();
        const role = (data?.role || "").toString();

        // Only salon_owner can access this page
        if (role !== "salon_owner") {
          router.replace("/dashboard");
          return;
        }

        const uid = user.uid;
        setOwnerUid(uid);
        await loadACSUData(uid);
        await loadTransactions(uid);
        setLoading(false);
      } catch (error) {
        console.error("Error checking auth:", error);
        router.replace("/login");
      }
    });
    return () => unsub();
  }, [router]);

  const loadACSUData = async (uid: string) => {
    try {
      const acsuDoc = await getDoc(doc(db, "owners", uid, "acsu", "settings"));
      if (acsuDoc.exists()) {
        const data = acsuDoc.data();
        setAcsuData({
          balance: data.balance || 0,
          conversionRate: data.conversionRate || 10,
          currency: data.currency || "AUD",
          isEnabled: data.isEnabled !== false,
        });
      } else {
        // Create default settings
        const defaultData: ACSUData = {
          balance: 0,
          conversionRate: 10,
          currency: "AUD",
          isEnabled: true,
        };
        await setDoc(doc(db, "owners", uid, "acsu", "settings"), {
          ...defaultData,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        setAcsuData(defaultData);
      }
    } catch (error) {
      console.error("Error loading ACSU data:", error);
    }
  };

  const loadTransactions = async (uid: string) => {
    try {
      const transactionsQuery = query(
        collection(db, "owners", uid, "acsu_transactions"),
        orderBy("date", "desc"),
        limit(100)
      );
      
      const unsub = onSnapshot(transactionsQuery, (snapshot) => {
        const trans = snapshot.docs.map((doc) => ({
          id: doc.id,
          ...doc.data(),
        })) as ACSUTransaction[];
        setTransactions(trans);
      });

      return () => unsub();
    } catch (error) {
      console.error("Error loading transactions:", error);
    }
  };

  const handleACSUToggle = async (enabled: boolean) => {
    if (!ownerUid) return;
    
    setSaving(true);
    try {
      await setDoc(
        doc(db, "owners", ownerUid, "acsu", "settings"),
        {
          ...acsuData,
          isEnabled: enabled,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
      setAcsuData({ ...acsuData, isEnabled: enabled });
      showToast(enabled ? "Loyalty Integration Active" : "Loyalty Integration Disabled");
    } catch (error) {
      console.error("Error updating ACSU toggle:", error);
      showToast("Failed to update settings");
    } finally {
      setSaving(false);
    }
  };

  const handleACSUTopup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ownerUid || !topupAmount) return;

    const amount = parseInt(topupAmount);
    if (isNaN(amount) || amount <= 0) {
      showToast("Please enter a valid amount");
      return;
    }

    setSaving(true);
    try {
      const newBalance = acsuData.balance + amount;
      await setDoc(
        doc(db, "owners", ownerUid, "acsu", "settings"),
        {
          balance: newBalance,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );

      // Create transaction record
      await setDoc(doc(db, "owners", ownerUid, "acsu_transactions", `topup_${Date.now()}`), {
        email: "admin",
        name: "Admin Top Up",
        staff: "System",
        branch: "N/A",
        service: "Top Up",
        value: 0,
        points: amount,
        date: new Date().toISOString(),
        ownerUid,
        type: "topup",
        createdAt: serverTimestamp(),
      });

      setAcsuData({ ...acsuData, balance: newBalance });
      setTopupAmount("");
      setShowTopupModal(false);
      showToast(`Success! Added ${amount.toLocaleString()} points to wallet.`);
    } catch (error) {
      console.error("Error processing topup:", error);
      showToast("Failed to process topup");
    } finally {
      setSaving(false);
    }
  };

  const saveACSUSettings = async () => {
    if (!ownerUid) return;

    const conversionRate = parseInt((document.getElementById("acsu-point-value") as HTMLInputElement)?.value || "10");
    const currency = (document.getElementById("acsu-currency") as HTMLSelectElement)?.value || "AUD";

    if (isNaN(conversionRate) || conversionRate <= 0) {
      showToast("Please enter a valid conversion rate");
      return;
    }

    setSaving(true);
    try {
      await setDoc(
        doc(db, "owners", ownerUid, "acsu", "settings"),
        {
          conversionRate,
          currency,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
      setAcsuData({ ...acsuData, conversionRate, currency });
      showToast("Formula Updated");
    } catch (error) {
      console.error("Error saving ACSU settings:", error);
      showToast("Failed to update formula");
    } finally {
      setSaving(false);
    }
  };

  const showToast = (msg: string) => {
    // Simple toast notification
    const toast = document.createElement("div");
    toast.className = "fixed bottom-4 right-4 bg-slate-900 text-white px-6 py-3 rounded-lg shadow-lg flex items-center gap-3 z-50 animate-slide-in";
    toast.innerHTML = `<i class="fas fa-gem text-pink-500"></i><span>${msg}</span>`;
    document.body.appendChild(toast);
    setTimeout(() => {
      toast.style.animation = "fade-out 0.3s ease-out";
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  };

  return (
    <div id="app" className="flex h-screen overflow-hidden bg-white">
      <Sidebar />
      <div className="flex-1 flex flex-col overflow-hidden">
        <main className="flex-1 overflow-auto p-4 sm:p-6 lg:p-8 bg-slate-50">
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
              <div className="absolute inset-0 bg-black/40" onClick={() => setMobileOpen(false)} />
              <div className="absolute left-0 top-0 bottom-0">
                <Sidebar mobile onClose={() => setMobileOpen(false)} />
              </div>
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center h-64">
              <div className="flex flex-col items-center gap-3">
                <i className="fas fa-circle-notch fa-spin text-4xl text-pink-500" />
                <p className="text-slate-500 font-medium">Loading loyalty settings...</p>
              </div>
            </div>
          ) : (
            <>
              {/* Header */}
              <header className="flex justify-between items-center mb-6">
                <div></div>
                <div className="bg-white px-4 py-2 rounded-full border border-slate-200 flex items-center gap-3 shadow-sm">
                  <i className="fas fa-gem text-pink-500"></i>
                  <span className="text-sm font-bold text-slate-700">
                    {acsuData.balance.toLocaleString()} Points
                  </span>
                </div>
              </header>

              {/* Main Content */}
              <section>
                <div className="flex justify-between items-center mb-6">
                  <div>
                    <h2 className="text-2xl font-bold text-slate-800">ACSU Loyalty</h2>
                    <p className="text-sm text-slate-500">Configure your reward logic and track distributed points.</p>
                  </div>
                  <div className="flex items-center gap-3 bg-white p-3 rounded-xl border border-slate-200">
                    <span className="text-xs font-bold text-slate-500 uppercase">ACSU Integration:</span>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input
                        type="checkbox"
                        checked={acsuData.isEnabled}
                        onChange={(e) => handleACSUToggle(e.target.checked)}
                        disabled={saving}
                        className="sr-only peer"
                      />
                      <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-pink-600"></div>
                    </label>
                  </div>
                </div>

                {/* Stats Cards */}
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
                  <div className="bg-slate-900 text-white rounded-2xl p-6 border-none flex flex-col justify-between overflow-hidden relative">
                    <div className="relative z-10">
                      <p className="text-slate-400 text-xs font-bold uppercase tracking-wider">ACSU Points Balance</p>
                      <h3 className="text-4xl font-black mt-1">{acsuData.balance.toLocaleString()}</h3>
                    </div>
                    <button
                      onClick={() => setShowTopupModal(true)}
                      className="relative z-10 w-full mt-6 bg-pink-600 hover:bg-pink-700 text-white py-2.5 rounded-lg text-sm font-bold transition"
                    >
                      <i className="fas fa-circle-plus mr-2"></i> Top Up Points
                    </button>
                    <i className="fas fa-gem absolute -bottom-4 -right-4 text-white opacity-5 text-9xl"></i>
                  </div>

                  <div className="bg-white rounded-2xl p-6 border border-slate-200 shadow-sm lg:col-span-2">
                    <h3 className="font-bold text-slate-800 mb-4">Dollar to ACSU Point Value</h3>
                    <div className="grid grid-cols-1 md:grid-cols-12 gap-4">
                      <div className="md:col-span-4">
                        <label className="block text-xs font-bold text-slate-500 mb-1 uppercase">Currency</label>
                        <div className="relative">
                          <select
                            id="acsu-currency"
                            defaultValue={acsuData.currency}
                            disabled={!acsuData.isEnabled || saving}
                            className="w-full border border-slate-200 rounded-lg p-2 pr-10 text-sm outline-none focus:ring-2 focus:ring-pink-500 disabled:opacity-50 disabled:cursor-not-allowed appearance-none"
                          >
                            <option value="AUD">AUD - Australian Dollar</option>
                            <option value="USD">USD - US Dollar</option>
                            <option value="LKR">LKR - Sri Lankan Rupee</option>
                          </select>
                          <i className="fas fa-chevron-down absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none text-xs" />
                        </div>
                      </div>
                      <div className="md:col-span-5">
                        <label className="block text-xs font-bold text-slate-500 mb-1 uppercase">Points per $1.00 Value</label>
                        <input
                          type="number"
                          id="acsu-point-value"
                          defaultValue={acsuData.conversionRate}
                          disabled={!acsuData.isEnabled || saving}
                          className="w-full border border-slate-200 rounded-lg p-2 text-sm outline-none focus:ring-2 focus:ring-pink-500 disabled:opacity-50 disabled:cursor-not-allowed"
                          placeholder="10"
                        />
                      </div>
                      <div className="md:col-span-3 flex items-end">
                        <button
                          onClick={saveACSUSettings}
                          disabled={!acsuData.isEnabled || saving}
                          className="w-full bg-slate-800 text-white px-4 py-2 rounded-lg text-sm font-bold hover:bg-black transition disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          Update Formula
                        </button>
                      </div>
                    </div>
                    <div className="mt-4 p-3 bg-blue-50 border border-blue-100 rounded-lg">
                      <p className="text-[11px] text-blue-700 leading-relaxed">
                        <i className="fas fa-info-circle mr-1"></i>
                        This formula determines how many ACSU points are awarded to customers upon booking completion. For example, if set to 10, a $50 booking awards 500 points.
                      </p>
                    </div>
                  </div>
                </div>

                {/* Transactions Table */}
                <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
                  <div className="p-4 border-b border-slate-100 bg-slate-50">
                    <h3 className="font-bold text-slate-800">Transaction Records</h3>
                  </div>
                  {transactions.length === 0 ? (
                    <div className="p-16 text-center text-slate-300">
                      <i className="fas fa-receipt text-5xl mb-4 opacity-10"></i>
                      <p className="font-medium">No loyalty transactions found.</p>
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-sm whitespace-nowrap">
                        <thead className="bg-white text-slate-400 font-bold border-b uppercase text-[10px] tracking-widest">
                          <tr>
                            <th className="p-4">Customer Email</th>
                            <th className="p-4">Customer Name</th>
                            <th className="p-4">Awarded By</th>
                            <th className="p-4">Branch</th>
                            <th className="p-4">Service</th>
                            <th className="p-4">Value</th>
                            <th className="p-4 text-pink-600">ACSU Points</th>
                            <th className="p-4 text-right">Date</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-50">
                          {transactions.map((t) => (
                            <tr key={t.id} className="hover:bg-slate-50 transition border-b border-slate-50 last:border-none">
                              <td className="p-4 text-slate-400 font-mono text-[11px]">{t.email}</td>
                              <td className="p-4 font-bold text-slate-800">{t.name}</td>
                              <td className="p-4 text-slate-600">{t.staff}</td>
                              <td className="p-4">
                                <span className="bg-slate-100 px-2 py-0.5 rounded text-[10px] font-bold">{t.branch}</span>
                              </td>
                              <td className="p-4 text-slate-600">{t.service}</td>
                              <td className="p-4 font-medium">
                                {acsuData.currency} ${t.value}
                              </td>
                              <td className="p-4 font-black text-pink-600">+{t.points.toLocaleString()}</td>
                              <td className="p-4 text-right text-slate-400 text-xs">
                                {new Date(t.date).toLocaleString()}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </section>

              {/* Top Up Modal */}
              {showTopupModal && (
                <div className="fixed inset-0 z-50">
                  <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => !saving && setShowTopupModal(false)} />
                  <div className="absolute inset-0 flex items-center justify-center p-4">
                    <div className="bg-white rounded-xl shadow-2xl w-full max-w-md overflow-hidden">
                      <div className="bg-slate-900 p-4 text-white flex justify-between items-center">
                        <h3 className="font-bold">Top Up ACSU Points</h3>
                        <button
                          onClick={() => !saving && setShowTopupModal(false)}
                          disabled={saving}
                          className="hover:text-red-400 disabled:opacity-50"
                        >
                          <i className="fas fa-xmark"></i>
                        </button>
                      </div>
                      <form onSubmit={handleACSUTopup} className="p-6 space-y-4">
                        {/* Current Balance Info */}
                        <div className="bg-slate-50 rounded-lg p-4 border border-slate-200">
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-xs font-bold text-slate-500 uppercase">Current Balance</span>
                            <span className="text-2xl font-black text-slate-900">{acsuData.balance.toLocaleString()}</span>
                          </div>
                          {topupAmount && !isNaN(parseInt(topupAmount)) && parseInt(topupAmount) > 0 && (
                            <div className="flex items-center justify-between pt-2 border-t border-slate-200">
                              <span className="text-xs font-bold text-slate-500 uppercase">New Balance</span>
                              <span className="text-xl font-bold text-pink-600">
                                {(acsuData.balance + parseInt(topupAmount)).toLocaleString()}
                              </span>
                            </div>
                          )}
                        </div>

                        {/* Point Amount Input */}
                        <div>
                          <label className="block text-[10px] font-bold text-slate-400 mb-1 uppercase tracking-wider">
                            Point Amount
                          </label>
                          <input
                            type="text"
                            inputMode="numeric"
                            pattern="[0-9]*"
                            value={topupAmount}
                            onChange={(e) => {
                              const value = e.target.value.replace(/[^0-9]/g, '');
                              setTopupAmount(value);
                            }}
                            required
                            disabled={saving}
                            className="w-full border border-slate-300 rounded-lg p-3 text-2xl font-black text-center focus:ring-2 focus:ring-pink-500 outline-none disabled:opacity-50 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                            placeholder="1000"
                          />
                        </div>

                        {/* Additional Details */}
                        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
                          <div className="flex items-start gap-2">
                            <i className="fas fa-info-circle text-blue-600 mt-0.5"></i>
                            <div className="text-xs text-blue-800 space-y-1">
                              <p className="font-semibold">Top Up Information:</p>
                              <ul className="list-disc list-inside space-y-0.5 ml-2">
                                <li>Points are added immediately to your wallet</li>
                                <li>Transaction will be recorded in your transaction history</li>
                                <li>Points can be awarded to customers based on your conversion rate</li>
                                <li>Current rate: {acsuData.conversionRate} points per {acsuData.currency} $1.00</li>
                              </ul>
                            </div>
                          </div>
                        </div>

                        <button
                          type="submit"
                          disabled={saving || !topupAmount || isNaN(parseInt(topupAmount)) || parseInt(topupAmount) <= 0}
                          className="w-full bg-slate-900 text-white font-bold py-3 rounded-lg shadow-lg hover:bg-black transition disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {saving ? (
                            <>
                              <i className="fas fa-circle-notch fa-spin mr-2"></i>
                              Processing...
                            </>
                          ) : (
                            <>
                              <i className="fas fa-circle-plus mr-2"></i>
                              Confirm Purchase
                            </>
                          )}
                        </button>
                      </form>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </main>
      </div>

      <style jsx>{`
        @keyframes slide-in {
          from {
            transform: translateX(100%);
            opacity: 0;
          }
          to {
            transform: translateX(0);
            opacity: 1;
          }
        }
        @keyframes fade-out {
          from {
            opacity: 1;
          }
          to {
            opacity: 0;
          }
        }
        .animate-slide-in {
          animation: slide-in 0.3s ease-out;
        }
      `}</style>
    </div>
  );
}
