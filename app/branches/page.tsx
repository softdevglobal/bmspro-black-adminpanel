"use client";
import React, { useEffect, useMemo, useState } from "react";
import Sidebar from "@/components/Sidebar";
import { useRouter } from "next/navigation";
import { auth, db } from "@/lib/firebase";
import { onAuthStateChanged } from "firebase/auth";
import { doc, getDoc, collection, query, where, getDocs } from "firebase/firestore";
import { BranchInput, BranchLocation, createBranchForOwner, subscribeBranchesForOwner, syncOwnerBranchCount } from "@/lib/branches";
import { subscribeSalonStaffForOwner } from "@/lib/salonStaff";
import { subscribeServicesForOwner } from "@/lib/services";
import { TIMEZONES } from "@/lib/timezone";
import dynamic from "next/dynamic";
import { DEFAULT_CHECK_IN_RADIUS } from "@/lib/geolocation";

// Dynamically import the location picker to avoid SSR issues with Google Maps
const BranchLocationPicker = dynamic(
  () => import("@/components/branches/BranchLocationPicker"),
  { ssr: false, loading: () => <div className="h-64 bg-slate-100 rounded-xl animate-pulse flex items-center justify-center text-slate-400"><i className="fas fa-spinner fa-spin mr-2" />Loading map...</div> }
);

type Branch = {
  id: string;
  name: string;
  address: string;
  revenue: number;
  phone?: string;
  email?: string;
  timezone?: string;
  staffIds?: string[];
  serviceIds?: string[];
  hours?:
    | string
    | {
        Monday?: { open?: string; close?: string; closed?: boolean };
        Tuesday?: { open?: string; close?: string; closed?: boolean };
        Wednesday?: { open?: string; close?: string; closed?: boolean };
        Thursday?: { open?: string; close?: string; closed?: boolean };
        Friday?: { open?: string; close?: string; closed?: boolean };
        Saturday?: { open?: string; close?: string; closed?: boolean };
        Sunday?: { open?: string; close?: string; closed?: boolean };
      };
  capacity?: number;
  manager?: string;
  adminStaffId?: string;
  status?: "Active" | "Pending" | "Closed";
  // Geolocation fields
  location?: BranchLocation;
  allowedCheckInRadius?: number;
};

type HoursDay = { open?: string; close?: string; closed?: boolean };
type HoursMap = {
  Monday?: HoursDay;
  Tuesday?: HoursDay;
  Wednesday?: HoursDay;
  Thursday?: HoursDay;
  Friday?: HoursDay;
  Saturday?: HoursDay;
  Sunday?: HoursDay;
};

export default function BranchesPage() {
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [ownerUid, setOwnerUid] = useState<string | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [previewBranch, setPreviewBranch] = useState<Branch | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Branch | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState(""); // Added email state
  const [timezone, setTimezone] = useState("Australia/Sydney"); // Default timezone
  const [role, setRole] = useState<string | null>(null); // Added role state
  const [currentUserUid, setCurrentUserUid] = useState<string | null>(null); // Added currentUserUid state
  // structured hours builder state
  const [hoursObj, setHoursObj] = useState<HoursMap>({
    Monday: { open: "09:00", close: "17:00", closed: false },
    Tuesday: { open: "09:00", close: "17:00", closed: false },
    Wednesday: { open: "09:00", close: "17:00", closed: false },
    Thursday: { open: "09:00", close: "17:00", closed: false },
    Friday: { open: "09:00", close: "17:00", closed: false },
    Saturday: { open: "10:00", close: "16:00", closed: false },
    Sunday: { open: "10:00", close: "16:00", closed: true },
  });
  const [capacity, setCapacity] = useState<number | "">("");
  const [adminStaffId, setAdminStaffId] = useState("");
  const [status, setStatus] = useState<"Active" | "Pending" | "Closed">("Active");
  // checklists sourced from services store (if present)
  const [serviceOptions, setServiceOptions] = useState<Array<{ id: string; name: string }>>([]);
  const [staffOptions, setStaffOptions] = useState<Array<{ id: string; name: string; email?: string; status?: string; branch?: string }>>([]);
  const [selectedServiceIds, setSelectedServiceIds] = useState<Record<string, boolean>>({});
  const [selectedStaffIds, setSelectedStaffIds] = useState<Record<string, boolean>>({});
  // Location state for geofencing
  const [branchLocation, setBranchLocation] = useState<BranchLocation | null>(null);
  const [allowedCheckInRadius, setAllowedCheckInRadius] = useState(DEFAULT_CHECK_IN_RADIUS);
  
  // Branch limit state
  const [ownerData, setOwnerData] = useState<{
    branchLimit?: number;
    plan?: string;
  } | null>(null);
  const [showBranchLimitModal, setShowBranchLimitModal] = useState(false);
  const [pendingBranchData, setPendingBranchData] = useState<BranchInput | null>(null);

  // seed defaults (only used when no data in db; not persisted)
  const defaultBranches: Branch[] = useMemo(() => [], []);

  // auth + role guard
  useEffect(() => {
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
        const userData = snap.data();
        const r = (userData?.role || "").toString();
        setRole(r);
        setCurrentUserUid(user.uid); // Store current user UID
        if (r !== "salon_owner" && r !== "salon_branch_admin") {
          router.replace("/dashboard");
          return;
        }
        if (r === "salon_owner") {
          setOwnerUid(user.uid);
          // Store owner's subscription data for branch limit checking
          // Always fetch from subscription plan to get the latest branch limit
          let branchLimit: number | undefined;
          
          // Try to fetch from subscription plan by planId first
          if (userData?.planId) {
            try {
              const planDoc = await getDoc(doc(db, "subscription_plans", userData.planId));
              if (planDoc.exists()) {
                const planData = planDoc.data();
                branchLimit = planData?.branches;
                console.log("Fetched plan data from planId:", { branchLimit, planName: planData?.name });
              }
            } catch (e) {
              console.error("Error fetching plan data:", e);
            }
          }
          
          // If no planId or fetch failed, try to find plan by name
          if (branchLimit === undefined && userData?.plan) {
            try {
              const plansQuery = query(
                collection(db, "subscription_plans"),
                where("name", "==", userData.plan)
              );
              const plansSnapshot = await getDocs(plansQuery);
              if (!plansSnapshot.empty) {
                const planData = plansSnapshot.docs[0].data();
                branchLimit = planData?.branches;
                console.log("Fetched plan data from plan name:", { branchLimit, planName: planData?.name });
              }
            } catch (e) {
              console.error("Error fetching plan by name:", e);
            }
          }
          
          // Fallback to user's stored branchLimit or default to 1
          if (branchLimit === undefined) {
            branchLimit = userData?.branchLimit || 1;
          }
          
          console.log("Final ownerData:", { branchLimit, plan: userData?.plan, planId: userData?.planId });
          
          setOwnerData({
            branchLimit: branchLimit,
            plan: userData?.plan,
          });
        } else {
          setOwnerUid(userData?.ownerUid || null);
          // Fetch owner's subscription data for branch admin
          if (userData?.ownerUid) {
            const ownerSnap = await getDoc(doc(db, "users", userData.ownerUid));
            const ownerUserData = ownerSnap.data();
            
            // Always fetch from subscription plan to get the latest branch limit
            let branchLimit: number | undefined;
            
            // Try to fetch from subscription plan by planId first
            if (ownerUserData?.planId) {
              try {
                const planDoc = await getDoc(doc(db, "subscription_plans", ownerUserData.planId));
                if (planDoc.exists()) {
                  const planData = planDoc.data();
                  branchLimit = planData?.branches;
                  console.log("Fetched plan data from planId (branch admin):", { branchLimit, planName: planData?.name });
                }
              } catch (e) {
                console.error("Error fetching plan data:", e);
              }
            }
            
            // If no planId or fetch failed, try to find plan by name
            if (branchLimit === undefined && ownerUserData?.plan) {
              try {
                const plansQuery = query(
                  collection(db, "subscription_plans"),
                  where("name", "==", ownerUserData.plan)
                );
                const plansSnapshot = await getDocs(plansQuery);
                if (!plansSnapshot.empty) {
                  const planData = plansSnapshot.docs[0].data();
                  branchLimit = planData?.branches;
                  console.log("Fetched plan data from plan name (branch admin):", { branchLimit, planName: planData?.name });
                }
              } catch (e) {
                console.error("Error fetching plan by name:", e);
              }
            }
            
            // Fallback to owner's stored branchLimit or default to 1
            if (branchLimit === undefined) {
              branchLimit = ownerUserData?.branchLimit || 1;
            }
            
            setOwnerData({
              branchLimit: branchLimit,
              plan: ownerUserData?.plan,
            });
          }
        }
      } catch {
        router.replace("/login");
      }
    });
    return () => unsub();
  }, [router]);

  // subscribe to branches for this owner
  useEffect(() => {
    if (!ownerUid) return;
    
    // For branch admins, we need currentUserUid to query by adminStaffId
    if (role === "salon_branch_admin" && !currentUserUid) {
      return;
    }
    
    const unsub = subscribeBranchesForOwner(ownerUid, (rows) => {
      const mapped: Branch[] = rows.map((r) => ({
        id: String(r.id),
        name: String(r.name || ""),
        address: String(r.address || ""),
        revenue: Number(r.revenue || 0),
        phone: r.phone,
        email: r.email,
        timezone: r.timezone,
        // @ts-ignore
        hours: r.hours,
        capacity: r.capacity,
        manager: r.manager,
        adminStaffId: r.adminStaffId, // Map adminStaffId from Firestore
        status: (r.status as any) || "Active",
        staffIds: Array.isArray((r as any).staffIds) ? (r as any).staffIds.map(String) : [],
        serviceIds: Array.isArray((r as any).serviceIds) ? (r as any).serviceIds.map(String) : [],
        // Geolocation fields
        location: r.location as BranchLocation | undefined,
        allowedCheckInRadius: r.allowedCheckInRadius,
      }));
      
      // If branch admin, filter to only show their assigned branch
      if (auth.currentUser) {
         const currentUserUid = auth.currentUser.uid;
         // We can't easily get role here synchronously without prop drilling or context,
         // but we can check if any branch has this user as admin.
         // However, simpler is: if we are NOT the owner (checked by ownerUid !== currentUserUid), filter.
         if (ownerUid && ownerUid !== currentUserUid) {
            const myBranches = mapped.filter(b => b.adminStaffId === currentUserUid);
            setBranches(myBranches);
            
            // Auto-redirect branch admin to their specific branch page
            if (role === "salon_branch_admin" && myBranches.length === 1) {
              router.push(`/branches/${myBranches[0].id}`);
            }
            return;
         }
      }
      
      setBranches(mapped.length ? mapped : defaultBranches);
    }, role || undefined, currentUserUid || undefined);
    return () => unsub();
  }, [ownerUid, defaultBranches, role, router, currentUserUid]);

  // Sync branch count if it doesn't match (for existing users with incorrect counts)
  useEffect(() => {
    if (!ownerUid || role !== "salon_owner") return;
    
    // Use a timeout to ensure branches are loaded
    const timeoutId = setTimeout(() => {
      const syncCount = async () => {
        try {
          const userDoc = await getDoc(doc(db, "users", ownerUid));
          const userData = userDoc.data();
          const storedCount = userData?.currentBranchCount ?? 0;
          const actualCount = branches.length;
          
          if (storedCount !== actualCount) {
            // Count is incorrect, sync it
            console.log(`Branch count mismatch detected: stored=${storedCount}, actual=${actualCount}. Syncing...`);
            await syncOwnerBranchCount(ownerUid);
            console.log(`✅ Synced branch count for ${ownerUid}: ${storedCount} → ${actualCount}`);
          }
        } catch (e) {
          console.error("Failed to sync branch count:", e);
        }
      };
      
      syncCount();
    }, 1000); // Wait 1 second for branches to load
    
    return () => clearTimeout(timeoutId);
  }, [ownerUid, role, branches.length]);

  // Real-time services and staff lists for assignment checklists
  useEffect(() => {
    if (!ownerUid) return;
    const unsubStaff = subscribeSalonStaffForOwner(ownerUid, (rows) => {
      setStaffOptions(
        rows.map((s: any) => ({
          id: String(s.id),
          name: String(s.name || s.displayName || "Staff"),
          email: s.email,
          status: s.status,
          branch: s.branchName,
        }))
      );
    });
    const unsubServices = subscribeServicesForOwner(ownerUid, (rows) => {
      setServiceOptions(
        rows.map((s: any) => ({
          id: String(s.id),
          name: String(s.name || "Service"),
        }))
      );
    });
    return () => {
      unsubStaff();
      unsubServices();
    };
  }, [ownerUid]);

  const saveData = (next: Branch[]) => setBranches(next);

  const openModal = () => {
    // Check branch limit before opening modal
    const branchLimit = ownerData?.branchLimit || 1;
    const currentBranchCount = branches.length;

    // If at or exceeding limit, show upgrade modal
    if (currentBranchCount >= branchLimit && branchLimit !== -1) {
      setShowBranchLimitModal(true);
      return;
    }

    // Otherwise, open the branch creation modal directly
    setEditingId(null);
    setName("");
    setAddress("");
    setPhone("");
    setEmail(""); // Reset email state
    setTimezone("Australia/Sydney"); // Reset to default timezone
    setHoursObj({
      Monday: { open: "09:00", close: "17:00", closed: false },
      Tuesday: { open: "09:00", close: "17:00", closed: false },
      Wednesday: { open: "09:00", close: "17:00", closed: false },
      Thursday: { open: "09:00", close: "17:00", closed: false },
      Friday: { open: "09:00", close: "17:00", closed: false },
      Saturday: { open: "10:00", close: "16:00", closed: false },
      Sunday: { open: "10:00", close: "16:00", closed: true },
    });
    setCapacity("");
    setAdminStaffId("");
    setStatus("Active");
    setSelectedServiceIds({});
    setSelectedStaffIds({});
    // Reset location state
    setBranchLocation(null);
    setAllowedCheckInRadius(DEFAULT_CHECK_IN_RADIUS);
    setIsModalOpen(true);
  };
  const closeModal = () => setIsModalOpen(false);

  const openEditModal = (b: Branch) => {
    setEditingId(b.id);
    setName(b.name || "");
    setAddress((b as any).address || "");
    setPhone((b as any).phone || "");
    setEmail(b.email || ""); // Set email state
    setTimezone(b.timezone || "Australia/Sydney"); // Set timezone state
    // prefill assignments
    const staffMap: Record<string, boolean> = {};
    const serviceMap: Record<string, boolean> = {};
    (b.staffIds || []).forEach((id) => (staffMap[id] = true));
    (b.serviceIds || []).forEach((id) => (serviceMap[id] = true));
    setSelectedStaffIds(staffMap);
    setSelectedServiceIds(serviceMap);
    // prefill hours when present as object
    const h = (b as any).hours;
    if (h && typeof h === "object") {
      setHoursObj(h as HoursMap);
    } else {
      setHoursObj({
        Monday: { open: "09:00", close: "17:00", closed: false },
        Tuesday: { open: "09:00", close: "17:00", closed: false },
        Wednesday: { open: "09:00", close: "17:00", closed: false },
        Thursday: { open: "09:00", close: "17:00", closed: false },
        Friday: { open: "09:00", close: "17:00", closed: false },
        Saturday: { open: "10:00", close: "16:00", closed: false },
        Sunday: { open: "10:00", close: "16:00", closed: true },
      });
    }
    setCapacity((b as any).capacity ?? "");
    setAdminStaffId((b as any).adminStaffId || "");
    setStatus(((b as any).status as any) || "Active");
    // Set location state
    setBranchLocation(b.location || null);
    setAllowedCheckInRadius(b.allowedCheckInRadius || DEFAULT_CHECK_IN_RADIUS);
    setIsModalOpen(true);
  };

  // Helper to build branch payload
  const buildBranchPayload = (): BranchInput => {
    let derivedManager: string | undefined = undefined;
    let derivedEmail: string | undefined = undefined;
    if (adminStaffId) {
      const st = staffOptions.find((s) => s.id === adminStaffId);
      if (st) {
        derivedManager = st.name;
        derivedEmail = st.email;
      }
    }

    return {
      name: name.trim(),
      address: branchLocation?.formattedAddress || address.trim(),
      phone: phone.trim() || undefined,
      email: derivedEmail,
      timezone: timezone || "Australia/Sydney",
      staffIds: Object.keys(selectedStaffIds).filter((id) => selectedStaffIds[id]),
      serviceIds: Object.keys(selectedServiceIds).filter((id) => selectedServiceIds[id]),
      hours: hoursObj,
      capacity: typeof capacity === "number" ? capacity : capacity === "" ? undefined : Number(capacity),
      manager: derivedManager,
      adminStaffId: adminStaffId || null,
      status,
      location: branchLocation || undefined,
      allowedCheckInRadius: allowedCheckInRadius,
    };
  };

  // Execute branch creation (after limit check or confirmation)
  const executeBranchCreation = async (payload: BranchInput, managerName?: string) => {
    if (!ownerUid) return;
    setSaving(true);
    try {
      await createBranchForOwner(ownerUid, payload, managerName);
      setIsModalOpen(false);
      setShowBranchLimitModal(false);
      setPendingBranchData(null);
    } catch (err) {
      console.error("Failed to create branch", err);
    } finally {
      setSaving(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!name.trim() || !address.trim() || !ownerUid) return;
    
    const payload = buildBranchPayload();
    const managerName = adminStaffId ? staffOptions.find((s) => s.id === adminStaffId)?.name : undefined;

    if (editingId) {
      // Editing existing branch - no limit check needed
      setSaving(true);
      try {
        await (await import("@/lib/branches")).updateBranch(editingId, payload, managerName);
        setIsModalOpen(false);
      } catch (err) {
        console.error("Failed to update branch", err);
      } finally {
        setSaving(false);
      }
    } else {
      // Creating new branch - check branch limit
      const branchLimit = ownerData?.branchLimit || 1;
      const currentBranchCount = branches.length;

      // Check if exceeding branch limit
      if (currentBranchCount >= branchLimit && branchLimit !== -1) {
        // Show upgrade modal
        setShowBranchLimitModal(true);
        return;
      }
      
      // Within limit - proceed directly
      await executeBranchCreation(payload, managerName);
    }
  };

  // Navigate to subscription page to upgrade package
  const handleUpgradePackage = () => {
    setShowBranchLimitModal(false);
    setPendingBranchData(null);
    router.push("/subscription");
  };

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
              <div className="absolute inset-0 bg-black/40" onClick={() => setMobileOpen(false)} />
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
                      <i className="fas fa-store" />
                    </div>
                    <h1 className="text-2xl font-bold">Branch Management</h1>
                  </div>
                  <p className="text-sm text-white/80 mt-2">Manage your salon.</p>
                </div>
              </div>
            </div>
          </div>

          <div className="max-w-7xl mx-auto">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-6">
              <h2 className="text-2xl font-bold text-slate-800">Branch Locations</h2>
              {role === "salon_owner" && (
                <button
                  onClick={openModal}
                  className="w-full sm:w-auto px-4 py-2 bg-purple-600 text-white rounded-lg text-sm hover:bg-purple-700 font-medium shadow-md transition"
                >
                  <i className="fas fa-plus mr-2" />
                  Add Branch
                </button>
              )}
            </div>

            {/* Branch Limit Info Banner */}
            {role === "salon_owner" && ownerData && (
              <div className="mb-6 bg-gradient-to-r from-pink-50 to-purple-50 border border-pink-200 rounded-xl p-4">
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-lg bg-pink-100 flex items-center justify-center flex-shrink-0">
                    <i className="fas fa-info-circle text-pink-600" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="font-semibold text-slate-900 mb-2">Branch Limit Information</h3>
                    <div className="text-sm text-slate-700 space-y-2">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span>
                          Your <span className="font-semibold text-pink-600">{ownerData.plan || "current plan"}</span> includes{" "}
                          <span className="font-semibold">{ownerData.branchLimit === -1 ? "unlimited" : `${ownerData.branchLimit || 1}`} branch{(ownerData.branchLimit || 1) > 1 || ownerData.branchLimit === -1 ? "es" : ""}</span>.
                        </span>
                        {ownerData.branchLimit !== -1 && (
                          <span className="px-2 py-1 rounded-full bg-white border border-pink-200 text-xs font-medium">
                            {branches.length} / {ownerData.branchLimit || 1} used
                          </span>
                        )}
                      </div>
                      {ownerData.branchLimit !== -1 && branches.length >= (ownerData.branchLimit || 1) && (
                        <p className="text-slate-600">
                          <i className="fas fa-arrow-up text-pink-500 mr-1" />
                          Need more branches? <button onClick={handleUpgradePackage} className="font-semibold text-pink-600 hover:text-pink-700 underline">Upgrade your package</button>
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}

                <div id="branch-grid" className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {branches.map((b) => {
                return (
                  <div key={b.id} className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 overflow-hidden">
                    <div className="flex items-start justify-between gap-3 mb-4">
                      <div className="flex items-center gap-4 min-w-0 flex-1">
                        <div className="w-12 h-12 bg-purple-100 text-purple-600 rounded-xl flex items-center justify-center text-xl flex-shrink-0">
                          <i className="fas fa-building" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <h3 className="font-bold text-lg text-slate-900 truncate">{b.name}</h3>
                          <p className="text-sm text-slate-500 truncate max-w-full" title={b.address}>{b.address}</p>
                          <div className="mt-1 flex items-center gap-2 text-xs text-slate-500 flex-wrap">
                            {b.manager && <span className="inline-flex items-center gap-1 truncate"><i className="fas fa-user-tie" /> {b.manager}</span>}
                            {b.status && (
                              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full flex-shrink-0 ${b.status === "Active" ? "bg-emerald-50 text-emerald-700" : b.status === "Pending" ? "bg-amber-50 text-amber-700" : "bg-rose-50 text-rose-700"}`}>
                                <i className="fas fa-circle text-[6px]" />
                                {b.status}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 text-slate-400 flex-shrink-0">
                        <button onClick={() => router.push(`/branches/${b.id}`)} title="Preview" className="w-8 h-8 rounded-lg hover:bg-slate-100 hover:text-slate-600 flex items-center justify-center transition-colors">
                          <i className="fas fa-eye" />
                        </button>
                        {role === "salon_owner" && (
                          <button onClick={() => openEditModal(b)} title="Edit" className="w-8 h-8 rounded-lg hover:bg-blue-50 hover:text-blue-600 flex items-center justify-center transition-colors">
                            <i className="fas fa-pen" />
                          </button>
                        )}
                        {role === "salon_owner" && (
                          <button onClick={() => setDeleteTarget(b)} title="Delete" className="w-8 h-8 rounded-lg hover:bg-rose-50 hover:text-rose-600 flex items-center justify-center transition-colors">
                            <i className="fas fa-trash" />
                          </button>
                        )}
                      </div>
                    </div>
                    {/* Location & Contact Info */}
                    <div className="pt-4 border-t border-slate-100">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        {/* Geofencing Status */}
                        {b.location?.latitude && b.location?.longitude ? (
                          <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-emerald-50 text-emerald-700">
                            <i className="fas fa-map-marker-alt" />
                            Geofencing: {b.allowedCheckInRadius || 100}m
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-amber-50 text-amber-700">
                            <i className="fas fa-map-marker-alt" />
                            No location set
                          </span>
                        )}
                        {b.phone && (
                          <span className="inline-flex items-center gap-1 text-slate-500">
                            <i className="fas fa-phone" /> {b.phone}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
              {branches.length === 0 && (
                <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-8 text-center">
                  <div className="w-16 h-16 bg-slate-100 rounded-full flex items-center justify-center mx-auto mb-4">
                    <i className="fas fa-store text-3xl text-slate-400" />
                  </div>
                  <h3 className="text-lg font-semibold text-slate-900 mb-2">No branches yet</h3>
                  <p className="text-slate-600 mb-4">Use "Add Branch" to create your first branch.</p>
                  {role === "salon_owner" && ownerData && (
                    <div className="mt-4 pt-4 border-t border-slate-200">
                      <p className="text-sm text-slate-500 mb-2">
                        Your <span className="font-semibold text-pink-600">{ownerData.plan || "current plan"}</span> includes{" "}
                        <span className="font-semibold">{ownerData.branchLimit === -1 ? "unlimited" : `${ownerData.branchLimit || 1}`} branch{(ownerData.branchLimit || 1) > 1 || ownerData.branchLimit === -1 ? "es" : ""}</span>.
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </main>
      </div>

      {/* Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
          <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm transition-opacity" onClick={closeModal} />
          <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-5xl max-h-[90vh] flex flex-col overflow-hidden transform transition-all scale-100">
            
            {/* Creative Header */}
            <div className="relative bg-gradient-to-r from-violet-600 via-purple-600 to-fuchsia-600 px-8 py-6 text-white shrink-0 overflow-hidden">
              <div className="absolute -right-6 -top-6 text-white/10">
                <i className="fas fa-store text-9xl" />
              </div>
              
              {/* Close Button - Absolute Top Right */}
              <button 
                onClick={closeModal}
                className="absolute top-4 right-4 w-10 h-10 bg-white/10 hover:bg-white/20 rounded-full flex items-center justify-center text-white transition-all backdrop-blur-sm z-20"
              >
                <i className="fas fa-times text-lg" />
              </button>

              <div className="relative z-10">
                <h3 className="text-2xl font-bold">{editingId ? "Edit Branch" : "New Branch"}</h3>
                <p className="text-purple-100 text-sm mt-1">
                  {editingId ? "Update branch details and settings." : "Set up a new salon location."}
                </p>
              </div>
            </div>

            <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-6 sm:p-8 bg-slate-50/50">
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                
                {/* Left Column: Core Details */}
                <div className="space-y-6">
                  <div className="bg-white p-5 rounded-xl border border-slate-100 shadow-sm space-y-4">
                    <div className="flex items-center gap-2 text-slate-800 font-semibold border-b border-slate-100 pb-2 mb-2">
                      <i className="fas fa-info-circle text-purple-500" />
                      Basic Information
                    </div>
                    
                    <div className="space-y-4">
                      <div>
                        <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Branch Name</label>
                        <div className="relative">
                          <i className="fas fa-store absolute left-3 top-3 text-slate-400" />
                          <input
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            required
                            className="w-full pl-10 pr-4 py-2.5 bg-slate-50 border border-slate-200 rounded-lg text-sm focus:bg-white focus:border-purple-500 focus:ring-4 focus:ring-purple-500/10 transition-all outline-none"
                            placeholder="e.g. Westside Plaza"
                          />
                        </div>
                      </div>

                      <div>
                        <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Address</label>
                        <div className="relative">
                          <i className="fas fa-map-marker-alt absolute left-3 top-3 text-slate-400" />
                          <input
                            value={address}
                            onChange={(e) => setAddress(e.target.value)}
                            required
                            className="w-full pl-10 pr-4 py-2.5 bg-slate-50 border border-slate-200 rounded-lg text-sm focus:bg-white focus:border-purple-500 focus:ring-4 focus:ring-purple-500/10 transition-all outline-none"
                            placeholder="123 Street Name, City"
                          />
                        </div>
                        <p className="text-xs text-slate-500 mt-1">
                          <i className="fas fa-info-circle mr-1" />
                          This will automatically fill from the Staff Check-in Location below
                        </p>
                      </div>

                      <div>
                        <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Capacity</label>
                        <div className="relative">
                          <i className="fas fa-chair absolute left-3 top-3 text-slate-400" />
                          <input
                            value={capacity}
                            onChange={(e) => setCapacity(e.target.value === "" ? "" : Number(e.target.value))}
                            type="number"
                            className="w-full pl-10 pr-4 py-2.5 bg-slate-50 border border-slate-200 rounded-lg text-sm focus:bg-white focus:border-purple-500 focus:ring-4 focus:ring-purple-500/10 transition-all outline-none"
                            placeholder="e.g. 12 stations"
                          />
                        </div>
                      </div>

                      <div>
                        <label className="block text-xs font-bold text-slate-500 uppercase mb-1">
                          Time Zone <span className="text-rose-500">*</span>
                        </label>
                        <div className="relative">
                          <i className="fas fa-globe absolute left-3 top-3 text-slate-400" />
                          <select
                            value={timezone}
                            onChange={(e) => setTimezone(e.target.value)}
                            required
                            className="w-full pl-10 pr-4 py-2.5 bg-slate-50 border border-slate-200 rounded-lg text-sm focus:bg-white focus:border-purple-500 focus:ring-4 focus:ring-purple-500/10 transition-all outline-none appearance-none"
                          >
                            {TIMEZONES.map((tz) => (
                              <option key={tz.value} value={tz.value}>
                                {tz.label}
                              </option>
                            ))}
                          </select>
                          <div className="absolute right-3 top-3 pointer-events-none text-slate-400">
                            <i className="fas fa-chevron-down" />
                          </div>
                        </div>
                        <p className="text-xs text-slate-500 mt-1">
                          <i className="fas fa-info-circle mr-1" />
                          All booking times will be shown in this timezone
                        </p>
                      </div>
                    </div>
                  </div>

                  {/* Location Section for Geofencing */}
                  <div className="bg-white p-5 rounded-xl border border-slate-100 shadow-sm space-y-4">
                    <div className="flex items-center gap-2 text-slate-800 font-semibold border-b border-slate-100 pb-2 mb-2">
                      <i className="fas fa-map-location-dot text-purple-500" />
                      Staff Check-in Location
                    </div>
                    <p className="text-xs text-slate-500 -mt-2 mb-3">
                      <i className="fas fa-info-circle mr-1" />
                      Set the branch location for staff geofenced check-in. Staff must be within the specified radius to clock in.
                    </p>
                    <BranchLocationPicker
                      initialLocation={branchLocation || undefined}
                      initialRadius={allowedCheckInRadius}
                      onLocationChange={(loc) => {
                        setBranchLocation(loc);
                        // Auto-update address if location changes
                        if (loc?.formattedAddress) {
                          setAddress(loc.formattedAddress);
                        }
                      }}
                      onRadiusChange={setAllowedCheckInRadius}
                      disabled={saving}
                    />
                  </div>

                  <div className="bg-white p-5 rounded-xl border border-slate-100 shadow-sm space-y-4">
                    <div className="flex items-center gap-2 text-slate-800 font-semibold border-b border-slate-100 pb-2 mb-2">
                      <i className="fas fa-address-book text-purple-500" />
                      Contact & Admin
                    </div>

                    <div className="space-y-4">
                      <div>
                        <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Contact Phone</label>
                        <div className="relative">
                          <i className="fas fa-phone absolute left-3 top-3 text-slate-400" />
                          <input
                            value={phone}
                            onChange={(e) => setPhone(e.target.value)}
                            type="tel"
                            className="w-full pl-10 pr-4 py-2.5 bg-slate-50 border border-slate-200 rounded-lg text-sm focus:bg-white focus:border-purple-500 focus:ring-4 focus:ring-purple-500/10 transition-all outline-none"
                            placeholder="+1 234 567 890"
                          />
                        </div>
                      </div>

                      <div className="bg-purple-50 rounded-lg p-4 border border-purple-100">
                        <label className="block text-xs font-bold text-purple-800 uppercase mb-2">Assign Branch Admin</label>
                        <div className="relative">
                          <i className="fas fa-user-shield absolute left-3 top-3 text-purple-400" />
                          <select
                            value={adminStaffId}
                            onChange={(e) => {
                              const val = e.target.value;
                              setAdminStaffId(val);
                              if (val) {
                                const st = staffOptions.find((s) => s.id === val);
                                if (st && st.email) setEmail(st.email);
                              }
                            }}
                            className="w-full pl-10 pr-4 py-2.5 bg-white border border-purple-200 rounded-lg text-sm focus:border-purple-500 focus:ring-4 focus:ring-purple-500/10 transition-all outline-none appearance-none text-slate-700"
                          >
                            <option value="">-- No Admin Assigned --</option>
                            {staffOptions.map((s) => {
                              // Check if this staff is already a branch admin
                              const adminBranch = branches.find(
                                (b) => b.adminStaffId === s.id && b.id !== editingId
                              );
                              const branchName = adminBranch ? adminBranch.name : s.branch;
                              
                              return (
                                <option key={s.id} value={s.id}>
                                  {s.name} {branchName ? `(${branchName})` : ""}
                                </option>
                              );
                            })}
                          </select>
                          <div className="absolute right-3 top-3 pointer-events-none text-purple-400">
                            <i className="fas fa-chevron-down" />
                          </div>
                        </div>
                        <p className="text-xs text-purple-600 mt-2">
                          <i className="fas fa-info-circle mr-1" />
                          User role will become <strong>Branch Admin</strong>.
                        </p>
                        {adminStaffId && (
                          <div className="mt-2 flex items-center gap-2 text-xs text-purple-700 bg-purple-100/50 p-2 rounded">
                            <i className="fas fa-envelope" />
                            Auto-linked email: <strong>{email || "No email found"}</strong>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Right Column: Hours & Status */}
                <div className="space-y-6">
                  <div className="bg-white p-5 rounded-xl border border-slate-100 shadow-sm space-y-4">
                    <div className="flex items-center justify-between border-b border-slate-100 pb-2 mb-2">
                      <div className="flex items-center gap-2 text-slate-800 font-semibold">
                        <i className="fas fa-clock text-purple-500" />
                        Operating Hours
                      </div>
                      <span className="text-xs text-slate-400 font-medium px-2 py-1 bg-slate-100 rounded">Local Time</span>
                    </div>

                    <div className="space-y-3 max-h-[400px] overflow-y-auto pr-2 custom-scrollbar overflow-x-hidden">
                      {["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].map((day) => {
                        const d = day as keyof HoursMap;
                        const row = (hoursObj[d] as HoursDay) || { open: "09:00", close: "17:00", closed: false };
                        const isClosed = Boolean(row.closed);
                        
                        const setRow = (patch: Partial<{ open: string; close: string; closed: boolean }>) =>
                          setHoursObj((prev) => {
                            const base = (prev || {}) as HoursMap;
                            const current = (base[d] as HoursDay) || {};
                            return { ...base, [d]: { ...current, ...patch } };
                          });

                        return (
                          <div 
                            key={day} 
                            className={`flex items-center justify-between gap-2 p-2 rounded-lg border transition-all ${
                              isClosed 
                                ? "bg-slate-50 border-slate-100" 
                                : "bg-white border-slate-200 shadow-sm hover:border-purple-300"
                            }`}
                          >
                            <div className="w-20 font-medium text-sm text-slate-700 shrink-0">{day}</div>
                            
                            <div className="flex items-center justify-center gap-1 flex-1">
                              {!isClosed ? (
                                <>
                                  <input
                                    type="time"
                                    className="bg-slate-50 border border-slate-200 rounded px-1 py-1 text-xs text-slate-600 focus:border-purple-500 focus:ring-0 outline-none w-28 text-center"
                                    value={row.open || ""}
                                    onChange={(e) => setRow({ open: e.target.value })}
                                  />
                                  <span className="text-slate-300 text-xs">-</span>
                                  <input
                                    type="time"
                                    className="bg-slate-50 border border-slate-200 rounded px-1 py-1 text-xs text-slate-600 focus:border-purple-500 focus:ring-0 outline-none w-28 text-center"
                                    value={row.close || ""}
                                    onChange={(e) => setRow({ close: e.target.value })}
                                  />
                                </>
                              ) : (
                                <span className="text-xs font-medium text-slate-400 italic">Closed</span>
                              )}
                            </div>

                            <div className="shrink-0 flex items-center">
                              <label className="relative inline-flex items-center cursor-pointer">
                                <input 
                                  type="checkbox" 
                                  className="sr-only peer" 
                                  checked={!isClosed} 
                                  onChange={() => setRow({ closed: !isClosed })}
                                />
                                <div className="w-9 h-5 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-purple-500"></div>
                              </label>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  <div className="bg-white p-5 rounded-xl border border-slate-100 shadow-sm space-y-4">
                    <div className="flex items-center gap-2 text-slate-800 font-semibold border-b border-slate-100 pb-2 mb-2">
                      <i className="fas fa-server text-purple-500" />
                      System Status
                    </div>
                    <div>
                      <div className="grid grid-cols-3 gap-2">
                        {["Active", "Pending", "Closed"].map((s) => (
                          <button
                            key={s}
                            type="button"
                            onClick={() => setStatus(s as any)}
                            className={`py-2 px-3 rounded-lg text-sm font-medium border transition-all ${
                              status === s
                                ? s === "Active" 
                                  ? "bg-emerald-50 border-emerald-200 text-emerald-700 shadow-sm ring-1 ring-emerald-200"
                                  : s === "Pending"
                                  ? "bg-amber-50 border-amber-200 text-amber-700 shadow-sm ring-1 ring-amber-200"
                                  : "bg-rose-50 border-rose-200 text-rose-700 shadow-sm ring-1 ring-rose-200"
                                : "bg-white border-slate-200 text-slate-600 hover:bg-slate-50"
                            }`}
                          >
                            {s}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </form>

            {/* Footer */}
            <div className="p-6 border-t border-slate-100 bg-white flex items-center justify-end gap-3 shrink-0">
              <button
                onClick={closeModal}
                disabled={saving}
                className="px-6 py-2.5 rounded-xl text-slate-600 font-medium hover:bg-slate-100 transition disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={() => document.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))}
                disabled={saving}
                className="px-8 py-2.5 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700 text-white font-bold rounded-xl shadow-lg shadow-purple-500/30 transform hover:scale-[1.02] active:scale-[0.98] transition-all disabled:opacity-70 disabled:transform-none"
              >
                {saving ? (
                  <span className="flex items-center gap-2">
                    <i className="fas fa-circle-notch fa-spin" />
                    Saving...
                  </span>
                ) : (
                  editingId ? "Save Changes" : "Create Branch"
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Preview Branch Modal */}
      {previewBranch && (
        <div className="fixed inset-0 z-50">
          <div className="absolute inset-0 bg-black/50" onClick={() => setPreviewBranch(null)} />
          <div className="relative flex items-center justify-center min-h-screen p-4">
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl overflow-hidden">
              {/* Header */}
              <div className="bg-gradient-to-r from-purple-600 to-indigo-600 px-6 py-5 text-white flex items-center justify-between">
                <div className="flex items-center gap-4 min-w-0">
                  <div className="w-12 h-12 rounded-xl bg-white/20 flex items-center justify-center text-2xl">
                    <i className="fas fa-building" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-xl font-semibold truncate">{previewBranch.name}</div>
                    <div className="text-sm text-white/80 truncate">{previewBranch.address}</div>
                  </div>
                </div>
                {previewBranch.status && (
                  <div
                    className={`ml-4 shrink-0 inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-semibold ${
                      previewBranch.status === "Active"
                        ? "bg-emerald-100 text-emerald-800"
                        : previewBranch.status === "Pending"
                        ? "bg-amber-100 text-amber-800"
                        : "bg-rose-100 text-rose-800"
                    }`}
                  >
                    <i className="fas fa-circle" />
                    {previewBranch.status}
                  </div>
                )}
              </div>

              {/* Body */}
              <div className="p-6 grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-3">
                  <div className="text-xs font-bold text-slate-600">Contact & Details</div>
                  <div className="text-sm text-slate-700 space-y-2">
                    {previewBranch.phone && (
                      <div className="flex items-center gap-2">
                        <i className="fas fa-phone text-slate-400" /> {previewBranch.phone}
                      </div>
                    )}
                    {previewBranch.email && (
                      <div className="flex items-center gap-2 truncate">
                        <i className="fas fa-envelope text-slate-400" /> {previewBranch.email}
                      </div>
                    )}
                    {previewBranch.manager && (
                      <div className="flex items-center gap-2">
                        <i className="fas fa-user-tie text-slate-400" /> {previewBranch.manager}
                      </div>
                    )}
                    {typeof previewBranch.capacity !== "undefined" && previewBranch.capacity !== null && previewBranch.capacity !== ("" as any) && (
                      <div className="flex items-center gap-2">
                        <i className="fas fa-chair text-slate-400" /> Capacity: {String(previewBranch.capacity)}
                      </div>
                    )}
                    {previewBranch.timezone && (
                      <div className="flex items-center gap-2">
                        <i className="fas fa-globe text-slate-400" /> {previewBranch.timezone}
                      </div>
                    )}
                  </div>
                </div>

                {/* Hours */}
                <div>
                  <div className="text-xs font-bold text-slate-600 mb-2">Operating Hours</div>
                  <div className="border border-slate-200 rounded-lg overflow-hidden bg-slate-50">
                    <div className="max-h-48 overflow-y-auto">
                      {["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"].map((day) => {
                        const d = day as keyof HoursMap;
                        const row = (previewBranch.hours as any)?.[d] as HoursDay | undefined;
                        const text = row
                          ? row.closed
                            ? "Closed"
                            : row.open && row.close
                            ? `${row.open} - ${row.close}`
                            : "—"
                          : "—";
                        const isClosed = row?.closed;
                        return (
                          <div key={day} className="flex items-center justify-between px-3 py-2 text-sm border-b last:border-b-0 border-slate-200 bg-white">
                            <span className="text-slate-600">{day}</span>
                            <span className={`font-medium ${isClosed ? "text-rose-600" : "text-slate-800"}`}>{text}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>

              {/* Footer actions */}
              <div className="px-6 py-4 border-t border-slate-200 bg-slate-50 flex items-center justify-end gap-3">
                {role === "salon_owner" && (
                  <button
                    onClick={() => {
                      setPreviewBranch(null);
                      openEditModal(previewBranch);
                    }}
                    className="px-4 py-2 bg-purple-600 text-white rounded-lg text-sm hover:bg-purple-700 font-medium shadow-md transition"
                  >
                    <i className="fas fa-pen mr-2" /> Edit
                  </button>
                )}
                <button
                  onClick={() => setPreviewBranch(null)}
                  className="px-4 py-2 bg-slate-200 text-slate-800 rounded-lg text-sm hover:bg-slate-300 font-medium transition"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirm Modal */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50">
          <div className="absolute inset-0 bg-black/50" onClick={() => setDeleteTarget(null)} />
          <div className="relative flex items-center justify-center min-h-screen p-4">
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden">
              <div className="p-5 border-b border-slate-100 flex items-center gap-3">
                <div className="w-9 h-9 rounded-full bg-rose-100 text-rose-600 flex items-center justify-center">
                  <i className="fa-solid fa-triangle-exclamation" />
                </div>
                <h3 className="font-semibold text-slate-900">Delete branch?</h3>
              </div>
              <div className="p-5 text-sm text-slate-600">
                This will permanently remove <span className="font-semibold text-slate-800">{deleteTarget.name}</span>.
              </div>
              <div className="px-5 pb-5 flex items-center justify-end gap-3">
                <button
                  onClick={() => setDeleteTarget(null)}
                  disabled={deleting}
                  className="px-4 py-2 rounded-md border border-slate-300 text-slate-700 hover:bg-slate-50 disabled:opacity-60"
                >
                  Cancel
                </button>
                <button
                  onClick={async () => {
                    if (!deleteTarget) return;
                    setDeleting(true);
                    try {
                      await (await import("@/lib/branches")).deleteBranch(deleteTarget.id);
                      setDeleteTarget(null);
                    } finally {
                      setDeleting(false);
                    }
                  }}
                  disabled={deleting}
                  className="px-4 py-2 rounded-md bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-60"
                >
                  {deleting ? (
                    <span className="inline-flex items-center gap-2">
                      <i className="fa-solid fa-circle-notch fa-spin" /> Deleting...
                    </span>
                  ) : (
                    "Delete"
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Upgrade Package Modal */}
      {showBranchLimitModal && (
        <div className="fixed inset-0 z-50">
          <div className="absolute inset-0 bg-black/50" onClick={() => {
            setShowBranchLimitModal(false);
            setPendingBranchData(null);
          }} />
          <div className="relative flex items-center justify-center min-h-screen p-4">
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
              {/* Header */}
              <div className="p-5 border-b border-slate-100 bg-gradient-to-r from-purple-500 to-indigo-600">
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 rounded-full bg-white/20 flex items-center justify-center">
                    <i className="fa-solid fa-arrow-up-right-dots text-white text-xl" />
                  </div>
                  <div>
                    <h3 className="font-bold text-white text-lg">Upgrade Your Package</h3>
                    <p className="text-purple-100 text-sm">Unlock more branches for your business</p>
                  </div>
                </div>
              </div>

              {/* Content */}
              <div className="p-5">
                <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-4">
                  <div className="flex items-start gap-3">
                    <div className="w-8 h-8 rounded-full bg-amber-100 flex items-center justify-center flex-shrink-0">
                      <i className="fa-solid fa-exclamation-triangle text-amber-600" />
                    </div>
                    <div>
                      <p className="text-sm text-amber-800 font-medium">Branch Limit Reached</p>
                      <p className="text-sm text-amber-700 mt-1">
                        You currently have <span className="font-semibold">{branches.length} branch{branches.length > 1 ? 'es' : ''}</span>, which is the maximum included in your <span className="font-semibold">{ownerData?.plan || 'current'}</span> plan.
                      </p>
                    </div>
                  </div>
                </div>

                <div className="bg-gradient-to-br from-purple-50 to-indigo-50 rounded-xl p-4 border border-purple-200">
                  <div className="flex items-center gap-3 mb-3">
                    <div className="w-10 h-10 rounded-lg bg-purple-100 flex items-center justify-center">
                      <i className="fa-solid fa-crown text-purple-600" />
                    </div>
                    <div>
                      <p className="font-semibold text-slate-900">Need More Branches?</p>
                      <p className="text-xs text-slate-500">Upgrade to a higher tier package</p>
                    </div>
                  </div>
                  <ul className="space-y-2 text-sm text-slate-600">
                    <li className="flex items-center gap-2">
                      <i className="fa-solid fa-check text-purple-500 text-xs" />
                      <span>More branch locations</span>
                    </li>
                    <li className="flex items-center gap-2">
                      <i className="fa-solid fa-check text-purple-500 text-xs" />
                      <span>Additional staff members</span>
                    </li>
                    <li className="flex items-center gap-2">
                      <i className="fa-solid fa-check text-purple-500 text-xs" />
                      <span>Premium features included</span>
                    </li>
                  </ul>
                </div>
              </div>

              {/* Actions */}
              <div className="px-5 pb-5 flex items-center gap-3">
                <button
                  onClick={() => {
                    setShowBranchLimitModal(false);
                    setPendingBranchData(null);
                  }}
                  disabled={saving}
                  className="flex-1 px-4 py-2.5 rounded-xl border border-slate-300 text-slate-700 font-medium hover:bg-slate-50 disabled:opacity-60 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleUpgradePackage}
                  disabled={saving}
                  className="flex-1 px-4 py-2.5 rounded-xl bg-gradient-to-r from-purple-500 to-indigo-600 text-white font-medium hover:from-purple-600 hover:to-indigo-700 disabled:opacity-60 transition-all shadow-lg shadow-purple-500/25 whitespace-nowrap"
                >
                  <span className="inline-flex items-center justify-center gap-2">
                    <i className="fa-solid fa-arrow-up" /> <span>View Upgrade Options</span>
                  </span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


