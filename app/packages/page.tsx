"use client";
import React, { useEffect, useState } from "react";
import Sidebar from "@/components/Sidebar";
import { useRouter } from "next/navigation";
import { onAuthStateChanged } from "firebase/auth";
import { auth, db, storage } from "@/lib/firebase";
import { doc, getDoc, collection, query, where, onSnapshot, updateDoc, serverTimestamp } from "firebase/firestore";
import { ref as storageRef, uploadBytes, getDownloadURL } from "firebase/storage";
import { logTenantPlanChanged } from "@/lib/auditLog";

type SubscriptionPlan = {
  id: string;
  name: string;
  price: number;
  priceLabel: string;
  features: string[];
  popular?: boolean;
  color: string;
  image?: string;
  icon?: string; // Keep for backward compatibility
  active?: boolean;
  hidden?: boolean; // Hidden packages are not shown in subscription page for upgrade/downgrade
  stripePriceId?: string; // Stripe Price ID for payment processing
  trialDays?: number; // Free trial period in days (0 = no trial)
  plan_key?: string; // Internal plan identifier (e.g., SOLO, TEAM5)
};

export default function PackagesPage() {
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [packagesLoading, setPackagesLoading] = useState(true);
  const [plans, setPlans] = useState<SubscriptionPlan[]>([]);
  const [tenants, setTenants] = useState<any[]>([]);
  const [selectedTenant, setSelectedTenant] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);
  const [confirmingPlan, setConfirmingPlan] = useState<SubscriptionPlan | null>(null);
  const [currentAdmin, setCurrentAdmin] = useState<{ uid: string; name: string } | null>(null);
  
  // Package management states
  const [showPackageForm, setShowPackageForm] = useState(false);
  const [editingPackage, setEditingPackage] = useState<SubscriptionPlan | null>(null);
  const [deletingPackage, setDeletingPackage] = useState<SubscriptionPlan | null>(null);
  const [savingPackage, setSavingPackage] = useState(false);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  
  // Form state
  const [formData, setFormData] = useState({
    name: "",
    price: "",
    priceLabel: "",
    features: "",
    popular: false,
    color: "blue",
    image: "",
    active: true,
    hidden: false, // Hidden packages are not shown in subscription page for upgrade/downgrade
    stripePriceId: "",
    trialDays: "0", // Free trial period in days
    plan_key: "", // Internal plan identifier
  });

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        router.replace("/login");
        return;
      }
      try {
        const token = await user.getIdToken();
        if (typeof window !== "undefined") localStorage.setItem("idToken", token);

        // Check if user is super admin
        const superAdminDoc = await getDoc(doc(db, "super_admins", user.uid));
        
        if (!superAdminDoc.exists()) {
          router.replace("/dashboard");
          return;
        }

        const superAdminData = superAdminDoc.data();
        setCurrentAdmin({
          uid: user.uid,
          name: superAdminData?.displayName || superAdminData?.name || user.email || "Super Admin"
        });

        setLoading(false);
      } catch (error) {
        console.error("Error checking auth:", error);
        router.replace("/login");
      }
    });
    return () => unsub();
  }, [router]);

  // Fetch packages from API
  useEffect(() => {
    if (loading) return;
    
    const fetchPackages = async () => {
      try {
        setPackagesLoading(true);
        const token = await auth.currentUser?.getIdToken();
        const response = await fetch("/api/packages", {
          headers: {
            "Authorization": `Bearer ${token}`,
          },
        });
        
        if (response.ok) {
          const data = await response.json();
          if (data.success) {
            setPlans(data.plans || []);
          }
        } else {
          console.error("Failed to fetch packages");
        }
      } catch (error) {
        console.error("Error fetching packages:", error);
      } finally {
        setPackagesLoading(false);
      }
    };

    fetchPackages();
  }, [loading]);

  // Fetch all tenants
  useEffect(() => {
    if (loading) return;

    const tenantsQuery = query(collection(db, "users"), where("role", "==", "workshop_owner"));
    const unsub = onSnapshot(
      tenantsQuery,
      (snapshot) => {
        const tenantList = snapshot.docs.map(doc => ({
          id: doc.id,
          ...doc.data()
        }));
        setTenants(tenantList);
      },
      (error) => {
        if (error.code === "permission-denied") {
          console.warn("Permission denied for tenants query.");
          setTenants([]);
        } else {
          console.error("Error in tenants snapshot:", error);
        }
      }
    );

    return () => unsub();
  }, [loading]);

  const handlePlanChange = (tenantId: string, plan: SubscriptionPlan) => {
    setConfirmingPlan(plan);
  };

  const confirmPlanChange = async () => {
    if (!selectedTenant || !confirmingPlan || updating) return;
    
    setUpdating(true);
    try {
      const tenant = tenants.find(t => t.id === selectedTenant);
      const previousPlan = tenant?.plan || "None";
      
      await updateDoc(doc(db, "users", selectedTenant), {
        plan: confirmingPlan.name,
        price: confirmingPlan.priceLabel,
        updatedAt: serverTimestamp(),
      });
      
      // Log plan change to super admin audit logs
      if (currentAdmin) {
        try {
          await logTenantPlanChanged(
            selectedTenant,
            tenant?.name || "Unknown Tenant",
            previousPlan,
            confirmingPlan.name,
            currentAdmin
          );
        } catch (auditError) {
          console.warn("Failed to create audit log:", auditError);
        }
      }
      
      setConfirmingPlan(null);
      setSelectedTenant(null);
    } catch (error: any) {
      console.error("Error updating plan:", error);
      alert(`Failed to update plan: ${error.message}`);
    } finally {
      setUpdating(false);
    }
  };

  const cancelPlanChange = () => {
    setConfirmingPlan(null);
  };

  // Package CRUD functions
  const openCreatePackage = () => {
    setFormData({
      name: "",
      price: "",
      priceLabel: "",
      features: "",
      popular: false,
      color: "blue",
      image: "",
      active: true,
      hidden: false,
      stripePriceId: "",
      trialDays: "0",
      plan_key: "",
    });
    setImageFile(null);
    setImagePreview(null);
    setEditingPackage(null);
    setShowPackageForm(true);
  };

  const openEditPackage = (pkg: SubscriptionPlan) => {
    setFormData({
      name: pkg.name,
      price: pkg.price.toString(),
      priceLabel: pkg.priceLabel,
      features: pkg.features.join("\n"),
      popular: pkg.popular || false,
      color: pkg.color,
      image: pkg.image || "",
      active: pkg.active !== false,
      hidden: pkg.hidden === true,
      stripePriceId: pkg.stripePriceId || "",
      trialDays: (pkg.trialDays || 0).toString(),
      plan_key: pkg.plan_key || "",
    });
    setImageFile(null);
    setImagePreview(pkg.image || null);
    setEditingPackage(pkg);
    setShowPackageForm(true);
  };

  const uploadImage = async (): Promise<string | null> => {
    if (!imageFile || !auth.currentUser) return null;
    
    setUploadingImage(true);
    try {
      const timestamp = Date.now();
      const fileName = `packages/${timestamp}_${imageFile.name}`;
      const imageRef = storageRef(storage, fileName);
      
      await uploadBytes(imageRef, imageFile);
      const downloadURL = await getDownloadURL(imageRef);
      
      return downloadURL;
    } catch (error) {
      console.error('Error uploading image:', error);
      alert('Failed to upload image');
      return null;
    } finally {
      setUploadingImage(false);
    }
  };

  const handleSavePackage = async () => {
    if (!formData.name || !formData.price || !formData.priceLabel) {
      alert("Please fill in all required fields (Name, Price, Price Label)");
      return;
    }

    setSavingPackage(true);
    try {
      const token = await auth.currentUser?.getIdToken();
      const featuresArray = formData.features
        .split("\n")
        .map(f => f.trim())
        .filter(f => f.length > 0);

      // Upload image if a new file is selected
      let finalImageUrl = formData.image;
      if (imageFile) {
        const uploadedUrl = await uploadImage();
        if (uploadedUrl) {
          finalImageUrl = uploadedUrl;
        } else {
          setSavingPackage(false);
          return;
        }
      }

      const payload = {
        ...(editingPackage ? { id: editingPackage.id } : {}),
        name: formData.name.trim(),
        price: parseFloat(formData.price),
        priceLabel: formData.priceLabel.trim(),
        branches: -1,
        staff: -1,
        features: featuresArray,
        popular: formData.popular,
        color: formData.color,
        image: finalImageUrl,
        active: formData.active,
        hidden: formData.hidden,
        stripePriceId: formData.stripePriceId.trim() || undefined,
        trialDays: parseInt(formData.trialDays, 10) || 0,
        plan_key: formData.plan_key.trim() || undefined,
      };

      const url = editingPackage ? "/api/packages" : "/api/packages";
      const method = editingPackage ? "PUT" : "POST";

      const response = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      });

      const data = await response.json();

      if (data.success) {
        // Refresh packages
        const refreshResponse = await fetch("/api/packages", {
          headers: { "Authorization": `Bearer ${token}` },
        });
        if (refreshResponse.ok) {
          const refreshData = await refreshResponse.json();
          if (refreshData.success) {
            setPlans(refreshData.plans || []);
          }
        }
        
        setShowPackageForm(false);
        setEditingPackage(null);
        setImageFile(null);
        setImagePreview(null);
      } else {
        alert(`Failed to ${editingPackage ? "update" : "create"} package: ${data.error}`);
      }
    } catch (error: any) {
      console.error("Error saving package:", error);
      alert(`Error: ${error.message}`);
    } finally {
      setSavingPackage(false);
    }
  };

  const handleDeletePackage = async () => {
    if (!deletingPackage) return;

    setSavingPackage(true);
    try {
      const token = await auth.currentUser?.getIdToken();
      const response = await fetch(`/api/packages?id=${deletingPackage.id}`, {
        method: "DELETE",
        headers: {
          "Authorization": `Bearer ${token}`,
        },
      });

      const data = await response.json();

      if (data.success) {
        // Refresh packages
        const refreshResponse = await fetch("/api/packages", {
          headers: { "Authorization": `Bearer ${token}` },
        });
        if (refreshResponse.ok) {
          const refreshData = await refreshResponse.json();
          if (refreshData.success) {
            setPlans(refreshData.plans || []);
          }
        }
        
        setDeletingPackage(null);
      } else {
        alert(`Failed to delete package: ${data.error}`);
      }
    } catch (error: any) {
      console.error("Error deleting package:", error);
      alert(`Error: ${error.message}`);
    } finally {
      setSavingPackage(false);
    }
  };

  const activePlans = plans.filter(p => p.active !== false);

  return (
    <div id="app" className="flex h-screen overflow-hidden bg-white">
      <Sidebar />
      <div className="flex-1 flex flex-col overflow-hidden">
        <main className="flex-1 overflow-auto p-4 sm:p-6 lg:p-8 bg-neutral-50">
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

          {loading || packagesLoading ? (
            <div className="flex items-center justify-center" style={{ minHeight: 'calc(100vh - 120px)' }}>
              <div className="text-center">
                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-neutral-900 mx-auto mb-4"></div>
                <p className="text-neutral-600">Loading packages...</p>
              </div>
            </div>
          ) : (
            <>
              {/* Header */}
              <div className="mb-8">
                <div className="rounded-2xl bg-neutral-900 text-white p-6 shadow-lg relative overflow-hidden">
                  <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-amber-500 via-amber-400 to-amber-500" />
                  <div className="flex items-center gap-4 pt-1">
                    <div className="w-14 h-14 rounded-xl bg-amber-500/15 border border-amber-500/20 flex items-center justify-center">
                      <i className="fas fa-box text-2xl text-amber-400" />
                    </div>
                    <div>
                      <h1 className="text-2xl font-bold">Subscription Packages</h1>
                      <p className="text-sm text-neutral-400 mt-1">Manage subscription plans for workshops</p>
                    </div>
                  </div>
                  <div className="absolute top-0 right-0 -mr-10 -mt-10 w-64 h-64 rounded-full bg-amber-500 opacity-[0.04] blur-3xl" />
                </div>
              </div>

              {/* Stats Cards */}
              {activePlans.length > 0 && (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
                  {activePlans.slice(0, 3).map((plan) => {
                    const planTenants = tenants.filter((t: any) => (t.plan || "").toLowerCase() === plan.name.toLowerCase());
                    const gradientClass = plan.color === "blue" ? "from-blue-500 to-indigo-600" 
                      : plan.color === "pink" ? "from-neutral-700 to-neutral-900" 
                      : plan.color === "purple" ? "from-purple-500 to-violet-600" 
                      : plan.color === "green" ? "from-emerald-500 to-teal-600"
                      : plan.color === "orange" ? "from-orange-500 to-amber-600"
                      : plan.color === "teal" ? "from-teal-500 to-cyan-600"
                      : "from-neutral-500 to-neutral-600";
                    return (
                      <div key={plan.id} className="group relative bg-white rounded-2xl border border-neutral-200 shadow-sm overflow-hidden hover:shadow-xl transition-all duration-300">
                        <div className={`absolute top-0 left-0 right-0 h-1 bg-gradient-to-r ${gradientClass}`} />
                        <div className="p-6">
                          <div className="flex items-center justify-between mb-4">
                            <div className={`w-14 h-14 rounded-xl flex items-center justify-center overflow-hidden shadow-lg ring-4 ring-white bg-gradient-to-br ${gradientClass}`}>
                              {plan.image ? (
                                <img src={plan.image} alt={plan.name} className="w-full h-full object-cover" />
                              ) : (
                                <i className="fas fa-box text-white text-lg" />
                              )}
                            </div>
                            <span className={`px-3 py-1.5 rounded-full text-xs font-bold bg-gradient-to-r ${gradientClass} text-white shadow-sm`}>
                              {planTenants.length} {planTenants.length === 1 ? "Tenant" : "Tenants"}
                            </span>
                          </div>
                          <h3 className="text-xl font-bold text-neutral-900 mb-1">{plan.name}</h3>
                          <p className={`text-2xl font-bold bg-gradient-to-r ${gradientClass} bg-clip-text text-transparent mb-2`}>{plan.priceLabel}</p>
                          <p className="text-sm text-neutral-500">
                            {plan.features.length} {plan.features.length === 1 ? "Feature" : "Features"}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Divider between Stats and Available Plans */}
              <hr className="my-10 border-neutral-200" />

              {/* Subscription Plans */}
              <div className="mb-8">
                <div className="flex items-center justify-between mb-6">
                  <h2 className="text-xl font-bold text-neutral-900">Available Plans</h2>
                  <button
                    onClick={openCreatePackage}
                    className="px-5 py-2.5 bg-neutral-900 hover:bg-neutral-800 text-white rounded-xl font-semibold transition-all shadow-lg shadow-neutral-900/25 flex items-center gap-2"
                  >
                    <i className="fas fa-plus" />
                    {activePlans.length === 0 ? "Create First Package" : "New Package"}
                  </button>
                </div>
                {activePlans.length === 0 ? (
                  <div className="bg-white rounded-2xl border-2 border-dashed border-neutral-300 p-12 text-center">
                    <i className="fas fa-box-open text-5xl text-neutral-400 mb-4" />
                    <h3 className="text-xl font-semibold text-neutral-700 mb-2">No Packages Yet</h3>
                    <p className="text-neutral-500 mb-6">Create your first subscription package to get started.</p>
                    <button
                      onClick={openCreatePackage}
                      className="px-6 py-3 bg-neutral-900 hover:bg-neutral-800 text-white rounded-xl font-semibold transition inline-flex items-center gap-2"
                    >
                      <i className="fas fa-plus" />
                      Create Package
                    </button>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
                    {activePlans.map((plan) => {
                      const gradientClass = plan.color === "blue" ? "from-blue-500 via-blue-600 to-indigo-600" 
                        : plan.color === "pink" ? "from-neutral-700 via-neutral-800 to-neutral-900" 
                        : plan.color === "purple" ? "from-purple-500 via-violet-500 to-indigo-600" 
                        : plan.color === "green" ? "from-emerald-500 via-green-500 to-teal-600"
                        : plan.color === "orange" ? "from-orange-500 via-amber-500 to-yellow-500"
                        : plan.color === "teal" ? "from-teal-500 via-cyan-500 to-blue-500"
                        : "from-neutral-500 via-neutral-600 to-neutral-700";
                      const lightBgClass = plan.color === "blue" ? "bg-blue-50" 
                        : plan.color === "pink" ? "bg-neutral-50" 
                        : plan.color === "purple" ? "bg-purple-50" 
                        : plan.color === "green" ? "bg-emerald-50"
                        : plan.color === "orange" ? "bg-orange-50"
                        : plan.color === "teal" ? "bg-teal-50"
                        : "bg-neutral-50";
                      return (
                        <div
                          key={plan.id}
                          className={`group relative bg-white rounded-3xl overflow-hidden shadow-lg hover:shadow-2xl transition-all duration-500 transform hover:-translate-y-2 ${
                            plan.popular ? "ring-2 ring-neutral-900 ring-offset-2" : ""
                          }`}
                        >
                          {/* Gradient Header */}
                          <div className={`relative h-32 bg-gradient-to-br ${gradientClass} overflow-visible`}>
                            {/* Decorative circles */}
                            <div className="absolute -top-10 -right-10 w-40 h-40 bg-white/10 rounded-full" />
                            <div className="absolute -bottom-10 -left-10 w-32 h-32 bg-white/10 rounded-full" />
                            <div className="absolute top-4 left-4 w-16 h-16 bg-white/10 rounded-full" />
                            
                            {/* Edit/Delete buttons */}
                            <div className="absolute top-3 right-3 flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity duration-300 z-10">
                              <button
                                onClick={() => openEditPackage(plan)}
                                className="w-8 h-8 rounded-full bg-white/20 backdrop-blur-sm hover:bg-white/40 flex items-center justify-center transition"
                                title="Edit Package"
                              >
                                <i className="fas fa-edit text-xs text-white" />
                              </button>
                              <button
                                onClick={() => setDeletingPackage(plan)}
                                className="w-8 h-8 rounded-full bg-white/20 backdrop-blur-sm hover:bg-rose-500 flex items-center justify-center transition"
                                title="Delete Package"
                              >
                                <i className="fas fa-trash text-xs text-white" />
                              </button>
                            </div>
                            
                            {/* Popular badge */}
                            {plan.popular && (
                              <div className="absolute top-3 left-3 bg-white/20 backdrop-blur-sm text-white text-xs font-bold px-3 py-1.5 rounded-full flex items-center gap-1.5 z-10">
                                <i className="fas fa-crown text-yellow-300" />
                                Most Popular
                              </div>
                            )}
                            
                            {/* Hidden badge - bottom left */}
                            {plan.hidden && (
                              <div className="absolute bottom-3 left-3 bg-amber-500/90 text-white text-[10px] font-semibold px-2 py-0.5 rounded flex items-center gap-1 z-10">
                                <i className="fas fa-eye-slash text-[8px]" />
                                Hidden
                              </div>
                            )}
                            
                            {/* Package Image/Icon - half in colored area, half in white */}
                            <div className="absolute -bottom-12 left-1/2 -translate-x-1/2 z-20">
                              <div className={`w-24 h-24 rounded-2xl flex items-center justify-center overflow-hidden shadow-xl ring-4 ring-white ${lightBgClass}`}>
                                {plan.image ? (
                                  <img src={plan.image} alt={plan.name} className="w-full h-full object-cover" />
                                ) : (
                                  <i className={`fas fa-box text-3xl bg-gradient-to-br ${gradientClass} bg-clip-text text-transparent`} />
                                )}
                              </div>
                            </div>
                          </div>
                          
                          {/* Card Content */}
                          <div className="pt-16 pb-6 px-6">
                            <div className="text-center mb-6">
                              <h3 className="text-2xl font-bold text-neutral-900 mb-2">{plan.name}</h3>
                              <div className={`text-4xl font-extrabold bg-gradient-to-r ${gradientClass} bg-clip-text text-transparent mb-2`}>
                                {plan.priceLabel}
                              </div>
                              <div className="flex items-center justify-center gap-3 text-sm text-neutral-500">
                                <span className="flex items-center gap-1">
                                  <i className="fas fa-list-check text-xs" />
                                  {plan.features.length} {plan.features.length === 1 ? "Feature" : "Features"}
                                </span>
                              </div>
                            </div>
                            
                            {/* Divider */}
                            <div className={`h-px bg-gradient-to-r from-transparent via-neutral-200 to-transparent mb-6`} />
                            
                            {/* Features */}
                            <ul className="space-y-3">
                              {plan.features.map((feature, idx) => (
                                <li key={idx} className="flex items-start gap-3">
                                  <div className={`w-5 h-5 rounded-full bg-gradient-to-br ${gradientClass} flex items-center justify-center flex-shrink-0 mt-0.5`}>
                                    <i className="fas fa-check text-white text-[10px]" />
                                  </div>
                                  <span className="text-sm text-neutral-600">{feature}</span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Tenant Plan Management */}
              <div className="bg-white rounded-2xl border border-neutral-200 shadow-sm">
                <div className="p-6 border-b border-neutral-200">
                  <h2 className="text-xl font-bold text-neutral-900">Manage Workshop Subscriptions</h2>
                  <p className="text-sm text-neutral-500 mt-1">Update subscription plans for individual workshops</p>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead className="bg-neutral-50 border-b border-neutral-200">
                      <tr>
                        <th className="px-6 py-4 text-left text-xs font-semibold text-neutral-600 uppercase">Tenant</th>
                        <th className="px-6 py-4 text-left text-xs font-semibold text-neutral-600 uppercase">Current Plan</th>
                        <th className="px-6 py-4 text-left text-xs font-semibold text-neutral-600 uppercase">Status</th>
                        <th className="px-6 py-4 text-right text-xs font-semibold text-neutral-600 uppercase">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-neutral-200">
                      {tenants.length === 0 ? (
                        <tr>
                          <td colSpan={4} className="px-6 py-8 text-center text-neutral-500">
                            No tenants found
                          </td>
                        </tr>
                      ) : (
                        tenants.map((tenant: any) => {
                          const initials = (tenant.name || "?")
                            .split(" ")
                            .map((s: string) => s[0])
                            .filter(Boolean)
                            .slice(0, 2)
                            .join("")
                            .toUpperCase();
                          const currentPlan = activePlans.find(p => p.name.toLowerCase() === (tenant.plan || "").toLowerCase());
                          const statusLower = (tenant.status || "").toLowerCase();
                          const statusCls = statusLower.includes("suspend")
                            ? "bg-rose-50 text-rose-700"
                            : statusLower.includes("active")
                            ? "bg-emerald-50 text-emerald-700"
                            : "bg-amber-50 text-amber-700";

                          return (
                            <tr key={tenant.id} className="hover:bg-neutral-50 transition">
                              <td className="px-6 py-4">
                                <div className="flex items-center gap-3">
                                  <div className="w-10 h-10 bg-gradient-to-br from-neutral-700 to-neutral-900 rounded-lg flex items-center justify-center">
                                    <span className="text-white font-semibold text-sm">{initials}</span>
                                  </div>
                                  <div>
                                    <p className="font-medium text-neutral-900">{tenant.name || "Unknown"}</p>
                                    <p className="text-xs text-neutral-500">{tenant.email || ""}</p>
                                  </div>
                                </div>
                              </td>
                              <td className="px-6 py-4">
                                {currentPlan ? (
                                  <div className="flex items-center gap-2">
                                    <span className={`px-3 py-1 rounded-lg text-sm font-semibold ${
                                      currentPlan.color === "blue" ? "bg-blue-50 text-blue-700" : 
                                      currentPlan.color === "pink" ? "bg-neutral-50 text-neutral-800" : 
                                      currentPlan.color === "purple" ? "bg-purple-50 text-purple-700" : "bg-neutral-50 text-neutral-700"
                                    }`}>
                                      {currentPlan.name}
                                    </span>
                                    <span className="text-sm text-neutral-500">{tenant.price || currentPlan.priceLabel}</span>
                                  </div>
                                ) : (
                                  <span className="text-sm text-neutral-400">No plan assigned</span>
                                )}
                              </td>
                              <td className="px-6 py-4">
                                <span className={`px-3 py-1 ${statusCls} rounded-lg text-sm font-medium`}>
                                  {tenant.status || "Active"}
                                </span>
                              </td>
                              <td className="px-6 py-4 text-right">
                                <button
                                  onClick={() => setSelectedTenant(selectedTenant === tenant.id ? null : tenant.id)}
                                  className="px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50 rounded-lg transition"
                                >
                                  {selectedTenant === tenant.id ? "Cancel" : "Change Plan"}
                                </button>
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Package Form Modal */}
              {showPackageForm && (() => {
                const colorOptions = [
                  { value: "blue", label: "Blue", gradient: "from-blue-500 to-indigo-600", ring: "ring-blue-400", bg: "bg-blue-500", accent: "text-blue-400" },
                  { value: "pink", label: "Dark", gradient: "from-neutral-600 to-neutral-800", ring: "ring-neutral-400", bg: "bg-neutral-700", accent: "text-neutral-300" },
                  { value: "purple", label: "Purple", gradient: "from-purple-500 to-violet-600", ring: "ring-purple-400", bg: "bg-purple-500", accent: "text-purple-400" },
                  { value: "green", label: "Green", gradient: "from-emerald-500 to-teal-600", ring: "ring-emerald-400", bg: "bg-emerald-500", accent: "text-emerald-400" },
                  { value: "orange", label: "Orange", gradient: "from-orange-500 to-amber-600", ring: "ring-orange-400", bg: "bg-orange-500", accent: "text-orange-400" },
                  { value: "teal", label: "Teal", gradient: "from-teal-500 to-cyan-600", ring: "ring-teal-400", bg: "bg-teal-500", accent: "text-teal-400" },
                ];
                const selectedColor = colorOptions.find(c => c.value === formData.color) || colorOptions[0];
                const previewFeatures = formData.features.split("\n").map(f => f.trim()).filter(f => f.length > 0);

                return (
                <div className="fixed inset-0 z-50">
                  <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => !savingPackage && setShowPackageForm(false)} />
                  <div className="absolute inset-0 flex items-center justify-center p-4 overflow-y-auto">
                    <div className="bg-white rounded-3xl shadow-2xl w-full max-w-5xl my-auto relative max-h-[92vh] overflow-hidden flex flex-col">
                      
                      {/* Header — black top */}
                      <div className="relative flex-shrink-0 bg-neutral-900 rounded-t-3xl">
                        <div className="px-6 pt-6 pb-5">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-4">
                              <div className="w-12 h-12 rounded-2xl bg-white/10 border border-white/10 flex items-center justify-center">
                                <i className={`fas ${editingPackage ? "fa-pen-to-square" : "fa-wrench"} text-lg text-amber-400`} />
                              </div>
                              <div>
                                <h3 className="text-xl font-bold text-white tracking-tight">
                                  {editingPackage ? "Edit Package" : "Build New Package"}
                                </h3>
                                <p className="text-sm text-neutral-400 mt-0.5">
                                  {editingPackage ? "Update your workshop subscription plan" : "Create a subscription plan for workshops"}
                                </p>
                              </div>
                            </div>
                            <button
                              onClick={() => !savingPackage && setShowPackageForm(false)}
                              disabled={savingPackage}
                              className="w-10 h-10 rounded-xl bg-white/10 hover:bg-white/20 flex items-center justify-center transition-all disabled:opacity-50"
                            >
                              <i className="fas fa-xmark text-white/70" />
                            </button>
                          </div>
                        </div>
                      </div>

                      {/* Content area with side-by-side layout */}
                      <div className="flex-1 overflow-y-auto">
                        <div className="grid grid-cols-1 lg:grid-cols-5 gap-0">
                          
                          {/* Left: Form fields (3 cols) */}
                          <div className="lg:col-span-3 p-6 space-y-6">
                            
                            {/* Section: Basic Info */}
                            <div>
                              <div className="flex items-center gap-2.5 mb-4">
                                <div className="w-7 h-7 rounded-lg bg-neutral-900 flex items-center justify-center">
                                  <i className="fas fa-tag text-[10px] text-white" />
                                </div>
                                <h4 className="text-xs font-bold text-neutral-800 uppercase tracking-widest">Basic Info</h4>
                              </div>
                              <div className="bg-neutral-50 rounded-2xl border border-neutral-200 p-5 space-y-4">
                                <div>
                                  <label className="block text-[11px] font-semibold text-neutral-500 uppercase tracking-wider mb-2">
                                    Package Name <span className="text-rose-500">*</span>
                                  </label>
                                  <div className="relative">
                                    <div className="absolute inset-y-0 left-0 flex items-center pl-3.5 pointer-events-none">
                                      <i className="fas fa-box-open text-neutral-400 text-sm" />
                                    </div>
                                    <input
                                      type="text"
                                      value={formData.name}
                                      onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                                      className="w-full pl-10 pr-4 py-3 bg-white border border-neutral-200 rounded-xl text-neutral-900 placeholder-neutral-400 focus:ring-2 focus:ring-neutral-900 focus:border-transparent transition-all text-sm font-medium"
                                      placeholder="e.g., Starter, Pro, Enterprise"
                                    />
                                  </div>
                                </div>
                                <div className="grid grid-cols-2 gap-3">
                                  <div>
                                    <label className="block text-[11px] font-semibold text-neutral-500 uppercase tracking-wider mb-2">
                                      Price (AUD) <span className="text-rose-500">*</span>
                                    </label>
                                    <div className="relative">
                                      <div className="absolute inset-y-0 left-0 flex items-center pl-3.5 pointer-events-none">
                                        <span className="text-neutral-900 text-sm font-bold">$</span>
                                      </div>
                                      <input
                                        type="number"
                                        step="0.01"
                                        value={formData.price}
                                        onChange={(e) => {
                                          const priceValue = e.target.value;
                                          let priceLabel = "";
                                          if (priceValue && !isNaN(parseFloat(priceValue))) {
                                            const numPrice = parseFloat(priceValue);
                                            if (numPrice % 1 === 0) {
                                              priceLabel = `AU$${numPrice}/mo`;
                                            } else {
                                              priceLabel = `AU$${numPrice.toFixed(2)}/mo`;
                                            }
                                          }
                                          setFormData({ ...formData, price: priceValue, priceLabel });
                                        }}
                                        className="w-full pl-9 pr-4 py-3 bg-white border border-neutral-200 rounded-xl text-neutral-900 placeholder-neutral-400 focus:ring-2 focus:ring-neutral-900 focus:border-transparent transition-all text-sm font-medium [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                                        placeholder="99.00"
                                      />
                                    </div>
                                  </div>
                                  <div>
                                    <label className="block text-[11px] font-semibold text-neutral-500 uppercase tracking-wider mb-2">
                                      Display Label <span className="text-rose-500">*</span>
                                    </label>
                                    <input
                                      type="text"
                                      value={formData.priceLabel}
                                      onChange={(e) => setFormData({ ...formData, priceLabel: e.target.value })}
                                      className="w-full px-4 py-3 bg-white border border-neutral-200 rounded-xl text-neutral-900 placeholder-neutral-400 focus:ring-2 focus:ring-neutral-900 focus:border-transparent transition-all text-sm font-medium"
                                      placeholder="AU$99/mo"
                                    />
                                  </div>
                                </div>
                              </div>
                            </div>

                            {/* Section: Plan Settings */}
                            <div>
                              <div className="flex items-center gap-2.5 mb-4">
                                <div className="w-7 h-7 rounded-lg bg-neutral-900 flex items-center justify-center">
                                  <i className="fas fa-gears text-[10px] text-white" />
                                </div>
                                <h4 className="text-xs font-bold text-neutral-800 uppercase tracking-widest">Plan Settings</h4>
                              </div>
                              <div className="bg-neutral-50 rounded-2xl border border-neutral-200 p-5 space-y-4">
                                <div className="grid grid-cols-2 gap-3">
                                  <div>
                                    <label className="block text-[11px] font-semibold text-neutral-500 uppercase tracking-wider mb-2">
                                      Free Trial
                                    </label>
                                    <div className="relative">
                                      <div className="absolute inset-y-0 left-0 flex items-center pl-3.5 pointer-events-none">
                                        <i className="fas fa-clock text-neutral-400 text-sm" />
                                      </div>
                                      <input
                                        type="number"
                                        min="0"
                                        value={formData.trialDays}
                                        onChange={(e) => setFormData({ ...formData, trialDays: e.target.value })}
                                        className="w-full pl-10 pr-16 py-3 bg-white border border-neutral-200 rounded-xl text-neutral-900 placeholder-neutral-400 focus:ring-2 focus:ring-neutral-900 focus:border-transparent transition-all text-sm font-medium [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                                        placeholder="0"
                                      />
                                      <div className="absolute inset-y-0 right-0 flex items-center pr-3.5 pointer-events-none">
                                        <span className="text-[11px] text-neutral-400 font-medium">days</span>
                                      </div>
                                    </div>
                                  </div>
                                  <div>
                                    <label className="block text-[11px] font-semibold text-neutral-500 uppercase tracking-wider mb-2">
                                      Plan Key
                                    </label>
                                    <div className="relative">
                                      <div className="absolute inset-y-0 left-0 flex items-center pl-3.5 pointer-events-none">
                                        <i className="fas fa-key text-neutral-400 text-sm" />
                                      </div>
                                      <input
                                        type="text"
                                        value={formData.plan_key}
                                        onChange={(e) => setFormData({ ...formData, plan_key: e.target.value.toUpperCase() })}
                                        className="w-full pl-10 pr-4 py-3 bg-white border border-neutral-200 rounded-xl text-neutral-900 placeholder-neutral-400 focus:ring-2 focus:ring-neutral-900 focus:border-transparent transition-all text-sm font-mono font-medium"
                                        placeholder="SOLO"
                                      />
                                    </div>
                                  </div>
                                </div>

                                {/* Stripe Price ID */}
                                <div>
                                  <label className="block text-[11px] font-semibold text-neutral-500 uppercase tracking-wider mb-2">
                                    Stripe Price ID
                                  </label>
                                  <div className="relative">
                                    <div className="absolute inset-y-0 left-0 flex items-center pl-3.5 pointer-events-none">
                                      <i className="fab fa-stripe-s text-neutral-400 text-sm" />
                                    </div>
                                    <input
                                      type="text"
                                      value={formData.stripePriceId}
                                      onChange={(e) => setFormData({ ...formData, stripePriceId: e.target.value })}
                                      className="w-full pl-10 pr-4 py-3 bg-white border border-neutral-200 rounded-xl text-neutral-900 placeholder-neutral-400 focus:ring-2 focus:ring-neutral-900 focus:border-transparent transition-all text-sm font-mono font-medium"
                                      placeholder="price_1234..."
                                    />
                                  </div>
                                </div>
                              </div>
                            </div>

                            {/* Section: Features */}
                            <div>
                              <div className="flex items-center gap-2.5 mb-4">
                                <div className="w-7 h-7 rounded-lg bg-neutral-900 flex items-center justify-center">
                                  <i className="fas fa-list-check text-[10px] text-white" />
                                </div>
                                <h4 className="text-xs font-bold text-neutral-800 uppercase tracking-widest">Features</h4>
                                {previewFeatures.length > 0 && (
                                  <span className="ml-auto text-[10px] text-neutral-600 font-semibold bg-neutral-100 border border-neutral-200 px-2.5 py-0.5 rounded-full">
                                    {previewFeatures.length} {previewFeatures.length === 1 ? "feature" : "features"}
                                  </span>
                                )}
                              </div>
                              <div className="bg-neutral-50 rounded-2xl border border-neutral-200 p-5">
                                <textarea
                                  value={formData.features}
                                  onChange={(e) => setFormData({ ...formData, features: e.target.value })}
                                  rows={5}
                                  className="w-full px-4 py-3 bg-white border border-neutral-200 rounded-xl text-neutral-900 placeholder-neutral-400 focus:ring-2 focus:ring-neutral-900 focus:border-transparent transition-all text-sm resize-none"
                                  placeholder={"Unlimited Job Cards\nInvoice & Quotation\nInventory Management\nCustomer Management\nReporting & Analytics"}
                                />
                                <p className="text-[10px] text-neutral-400 mt-2 flex items-center gap-1.5">
                                  <i className="fas fa-info-circle" />
                                  One feature per line — each becomes a bullet point
                                </p>
                              </div>
                            </div>

                            {/* Section: Appearance */}
                            <div>
                              <div className="flex items-center gap-2.5 mb-4">
                                <div className="w-7 h-7 rounded-lg bg-neutral-900 flex items-center justify-center">
                                  <i className="fas fa-palette text-[10px] text-white" />
                                </div>
                                <h4 className="text-xs font-bold text-neutral-800 uppercase tracking-widest">Appearance</h4>
                              </div>
                              <div className="bg-neutral-50 rounded-2xl border border-neutral-200 p-5 space-y-5">
                                {/* Color Picker Swatches */}
                                <div>
                                  <label className="block text-[11px] font-semibold text-neutral-500 uppercase tracking-wider mb-3">
                                    Theme Color
                                  </label>
                                  <div className="flex items-center gap-3">
                                    {colorOptions.map((color) => (
                                      <button
                                        key={color.value}
                                        type="button"
                                        onClick={() => setFormData({ ...formData, color: color.value })}
                                        className={`group relative w-11 h-11 rounded-xl bg-gradient-to-br ${color.gradient} transition-all duration-200 hover:scale-110 ${
                                          formData.color === color.value
                                            ? `ring-2 ring-neutral-900 ring-offset-2 scale-110 shadow-lg`
                                            : "ring-1 ring-black/10 hover:shadow-md"
                                        }`}
                                        title={color.label}
                                      >
                                        {formData.color === color.value && (
                                          <div className="absolute inset-0 flex items-center justify-center">
                                            <i className="fas fa-check text-white text-xs drop-shadow-md" />
                                          </div>
                                        )}
                                      </button>
                                    ))}
                                  </div>
                                </div>

                                {/* Image Upload */}
                                <div>
                                  <label className="block text-[11px] font-semibold text-neutral-500 uppercase tracking-wider mb-3">
                                    Package Image
                                  </label>
                                  {imagePreview ? (
                                    <div className="flex items-center gap-4 p-3.5 bg-white rounded-xl border border-neutral-200">
                                      <div className="relative w-20 h-20 rounded-xl overflow-hidden flex-shrink-0 border border-neutral-200 shadow-md">
                                        <img
                                          src={imagePreview}
                                          alt="Package preview"
                                          className="w-full h-full object-cover"
                                        />
                                      </div>
                                      <div className="flex-1 min-w-0">
                                        <p className="text-sm font-semibold text-neutral-700 truncate">
                                          {imageFile?.name || "Current image"}
                                        </p>
                                        <p className="text-xs text-neutral-400 mt-0.5">
                                          {imageFile ? `${(imageFile.size / 1024).toFixed(1)} KB` : "Uploaded"}
                                        </p>
                                        <button
                                          type="button"
                                          onClick={() => {
                                            setImagePreview(null);
                                            setImageFile(null);
                                            setFormData({ ...formData, image: "" });
                                          }}
                                          className="mt-2 text-xs text-rose-500 hover:text-rose-600 font-semibold flex items-center gap-1 transition"
                                        >
                                          <i className="fas fa-trash-can text-[10px]" />
                                          Remove
                                        </button>
                                      </div>
                                    </div>
                                  ) : (
                                    <label className="group cursor-pointer block">
                                      <div className="border-2 border-dashed border-neutral-300 rounded-xl p-6 text-center hover:border-neutral-400 hover:bg-white transition-all">
                                        <div className="w-14 h-14 rounded-xl bg-neutral-100 group-hover:bg-neutral-200 transition-colors flex items-center justify-center mx-auto mb-3">
                                          <i className="fas fa-cloud-arrow-up text-xl text-neutral-400 group-hover:text-neutral-600 transition-colors" />
                                        </div>
                                        <p className="text-sm font-semibold text-neutral-500 group-hover:text-neutral-700 transition-colors">Click to upload image</p>
                                        <p className="text-[10px] text-neutral-400 mt-1">PNG, JPG, WebP or GIF • Max 5MB</p>
                                      </div>
                                      <input
                                        type="file"
                                        accept="image/*"
                                        onChange={(e) => {
                                          const file = e.target.files?.[0];
                                          if (file) {
                                            const validTypes = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif'];
                                            if (!validTypes.includes(file.type)) {
                                              alert("Please upload a valid image file (PNG, JPG, WebP, or GIF)");
                                              return;
                                            }
                                            if (file.size > 5 * 1024 * 1024) {
                                              alert("File size must be less than 5MB");
                                              return;
                                            }
                                            setImageFile(file);
                                            const reader = new FileReader();
                                            reader.onloadend = () => {
                                              setImagePreview(reader.result as string);
                                            };
                                            reader.readAsDataURL(file);
                                          }
                                        }}
                                        className="hidden"
                                        disabled={uploadingImage || savingPackage}
                                      />
                                    </label>
                                  )}
                                </div>
                              </div>
                            </div>

                            {/* Section: Options */}
                            <div>
                              <div className="flex items-center gap-2.5 mb-4">
                                <div className="w-7 h-7 rounded-lg bg-neutral-900 flex items-center justify-center">
                                  <i className="fas fa-sliders text-[10px] text-white" />
                                </div>
                                <h4 className="text-xs font-bold text-neutral-800 uppercase tracking-widest">Options</h4>
                              </div>
                              <div className="space-y-2">
                                {/* Active Toggle */}
                                <div className={`rounded-xl border p-4 flex items-center justify-between transition-all ${formData.active ? "bg-emerald-50 border-emerald-200" : "bg-neutral-50 border-neutral-200"}`}>
                                  <div className="flex items-center gap-3">
                                    <div className={`w-9 h-9 rounded-lg flex items-center justify-center transition-all ${formData.active ? "bg-emerald-100" : "bg-neutral-100"}`}>
                                      <i className={`fas fa-power-off text-xs ${formData.active ? "text-emerald-600" : "text-neutral-400"}`} />
                                    </div>
                                    <div>
                                      <p className={`text-sm font-semibold ${formData.active ? "text-neutral-900" : "text-neutral-500"}`}>Active</p>
                                      <p className="text-[10px] text-neutral-400">{formData.active ? "Package is live and available" : "Package is disabled"}</p>
                                    </div>
                                  </div>
                                  <button
                                    type="button"
                                    onClick={() => setFormData({ ...formData, active: !formData.active })}
                                    className={`relative w-12 h-7 rounded-full transition-all duration-300 ${formData.active ? "bg-emerald-500" : "bg-neutral-300"}`}
                                  >
                                    <div className={`absolute top-0.5 w-6 h-6 rounded-full shadow-md transition-all duration-300 ${formData.active ? "left-[21px] bg-white" : "left-0.5 bg-white"}`} />
                                  </button>
                                </div>

                                {/* Popular Toggle */}
                                <div className={`rounded-xl border p-4 flex items-center justify-between transition-all ${formData.popular ? "bg-amber-50 border-amber-200" : "bg-neutral-50 border-neutral-200"}`}>
                                  <div className="flex items-center gap-3">
                                    <div className={`w-9 h-9 rounded-lg flex items-center justify-center transition-all ${formData.popular ? "bg-amber-100" : "bg-neutral-100"}`}>
                                      <i className={`fas fa-crown text-xs ${formData.popular ? "text-amber-500" : "text-neutral-400"}`} />
                                    </div>
                                    <div>
                                      <p className={`text-sm font-semibold ${formData.popular ? "text-neutral-900" : "text-neutral-500"}`}>Most Popular</p>
                                      <p className="text-[10px] text-neutral-400">{formData.popular ? "Highlighted with a badge" : "Standard display"}</p>
                                    </div>
                                  </div>
                                  <button
                                    type="button"
                                    onClick={() => setFormData({ ...formData, popular: !formData.popular })}
                                    className={`relative w-12 h-7 rounded-full transition-all duration-300 ${formData.popular ? "bg-amber-500" : "bg-neutral-300"}`}
                                  >
                                    <div className={`absolute top-0.5 w-6 h-6 rounded-full shadow-md transition-all duration-300 ${formData.popular ? "left-[21px] bg-white" : "left-0.5 bg-white"}`} />
                                  </button>
                                </div>

                                {/* Hidden Toggle */}
                                <div className={`rounded-xl border p-4 flex items-center justify-between transition-all ${formData.hidden ? "bg-rose-50 border-rose-200" : "bg-neutral-50 border-neutral-200"}`}>
                                  <div className="flex items-center gap-3">
                                    <div className={`w-9 h-9 rounded-lg flex items-center justify-center transition-all ${formData.hidden ? "bg-rose-100" : "bg-neutral-100"}`}>
                                      <i className={`fas fa-eye-slash text-xs ${formData.hidden ? "text-rose-500" : "text-neutral-400"}`} />
                                    </div>
                                    <div>
                                      <p className={`text-sm font-semibold ${formData.hidden ? "text-neutral-900" : "text-neutral-500"}`}>Hidden Plan</p>
                                      <p className="text-[10px] text-neutral-400">
                                        {formData.hidden ? "Only assignable by super admin" : "Visible to all workshops"}
                                      </p>
                                    </div>
                                  </div>
                                  <button
                                    type="button"
                                    onClick={() => setFormData({ ...formData, hidden: !formData.hidden })}
                                    className={`relative w-12 h-7 rounded-full transition-all duration-300 ${formData.hidden ? "bg-rose-500" : "bg-neutral-300"}`}
                                  >
                                    <div className={`absolute top-0.5 w-6 h-6 rounded-full shadow-md transition-all duration-300 ${formData.hidden ? "left-[21px] bg-white" : "left-0.5 bg-white"}`} />
                                  </button>
                                </div>
                              </div>
                            </div>
                          </div>

                          {/* Right: Live Preview (2 cols) */}
                          <div className="lg:col-span-2 bg-neutral-50 border-l border-neutral-200 p-6 flex flex-col">
                            <div className="flex items-center gap-2.5 mb-5">
                              <div className="w-7 h-7 rounded-lg bg-neutral-900 flex items-center justify-center">
                                <i className="fas fa-eye text-[10px] text-white" />
                              </div>
                              <h4 className="text-xs font-bold text-neutral-800 uppercase tracking-widest">Live Preview</h4>
                              <div className="ml-auto flex items-center gap-1.5">
                                <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                                <span className="text-[9px] text-neutral-400 font-medium uppercase tracking-wider">Live</span>
                              </div>
                            </div>

                            {/* Preview Card */}
                            <div className="bg-white rounded-2xl shadow-xl border border-neutral-200 flex-shrink-0 overflow-visible">
                              {/* Gradient top + floating icon */}
                              <div className="relative">
                                <div className={`h-28 bg-gradient-to-br ${selectedColor.gradient} overflow-hidden rounded-t-2xl relative`}>
                                  <div className="absolute -top-8 -right-8 w-32 h-32 bg-white/10 rounded-full" />
                                  <div className="absolute -bottom-8 -left-8 w-28 h-28 bg-white/10 rounded-full" />
                                  <div className="absolute top-4 right-12 w-10 h-10 bg-white/5 rounded-full" />
                                  {formData.popular && (
                                    <div className="absolute top-3 left-3 bg-white/20 backdrop-blur-sm text-white text-[9px] font-bold px-2.5 py-1 rounded-full flex items-center gap-1">
                                      <i className="fas fa-crown text-yellow-300 text-[8px]" />
                                      Popular
                                    </div>
                                  )}
                                  {formData.hidden && (
                                    <div className="absolute top-3 right-3 bg-black/30 backdrop-blur-sm text-white text-[9px] font-semibold px-2.5 py-1 rounded-full flex items-center gap-1">
                                      <i className="fas fa-eye-slash text-[8px]" />
                                      Hidden
                                    </div>
                                  )}
                                </div>
                                {/* Image/Icon — outside gradient so it won't be clipped */}
                                <div className="absolute -bottom-9 left-1/2 -translate-x-1/2 z-10">
                                  <div className="w-[72px] h-[72px] rounded-2xl flex items-center justify-center overflow-hidden shadow-xl ring-4 ring-white bg-white">
                                    {imagePreview ? (
                                      <img src={imagePreview} alt="Preview" className="w-full h-full object-cover" />
                                    ) : (
                                      <i className={`fas fa-wrench text-xl bg-gradient-to-br ${selectedColor.gradient} bg-clip-text text-transparent`} />
                                    )}
                                  </div>
                                </div>
                              </div>

                              <div className="pt-12 pb-6 px-5">
                                <div className="text-center mb-5">
                                  <h3 className="text-lg font-bold text-neutral-900 mb-1">
                                    {formData.name || "Package Name"}
                                  </h3>
                                  <div className={`text-3xl font-extrabold bg-gradient-to-r ${selectedColor.gradient} bg-clip-text text-transparent`}>
                                    {formData.priceLabel || "AU$0/mo"}
                                  </div>
                                  {formData.trialDays && parseInt(formData.trialDays) > 0 && (
                                    <p className="text-[10px] text-emerald-600 font-semibold mt-2 bg-emerald-50 border border-emerald-200 px-3 py-1 rounded-full inline-flex items-center gap-1">
                                      <i className="fas fa-gift text-[8px]" />{formData.trialDays}-day free trial
                                    </p>
                                  )}
                                </div>

                                <div className="h-px bg-gradient-to-r from-transparent via-neutral-200 to-transparent mb-4" />

                                {previewFeatures.length > 0 ? (
                                  <ul className="space-y-2.5">
                                    {previewFeatures.slice(0, 6).map((feature, idx) => (
                                      <li key={idx} className="flex items-start gap-2.5">
                                        <div className={`min-w-[18px] min-h-[18px] w-[18px] h-[18px] rounded-full bg-gradient-to-br ${selectedColor.gradient} flex items-center justify-center flex-shrink-0 mt-0.5`}>
                                          <i className="fas fa-check text-white text-[7px]" />
                                        </div>
                                        <span className="text-xs text-neutral-600 leading-relaxed">{feature}</span>
                                      </li>
                                    ))}
                                    {previewFeatures.length > 6 && (
                                      <li className="text-[10px] text-neutral-400 pl-7">
                                        +{previewFeatures.length - 6} more features...
                                      </li>
                                    )}
                                  </ul>
                                ) : (
                                  <div className="text-center py-6">
                                    <div className="w-12 h-12 rounded-xl bg-neutral-100 flex items-center justify-center mx-auto mb-3">
                                      <i className="fas fa-list text-neutral-300 text-lg" />
                                    </div>
                                    <p className="text-[10px] text-neutral-400">Add features to see them here</p>
                                  </div>
                                )}
                              </div>
                            </div>

                            {/* Status indicators */}
                            <div className="mt-5 space-y-2.5 bg-white rounded-xl border border-neutral-200 p-4">
                              <p className="text-[9px] font-bold text-neutral-400 uppercase tracking-widest mb-2">Status</p>
                              <div className="flex items-center gap-2.5 text-[11px]">
                                <div className={`w-2 h-2 rounded-full ${formData.active ? "bg-emerald-500" : "bg-neutral-300"}`} />
                                <span className="text-neutral-500">{formData.active ? "Active — visible to workshops" : "Inactive — not available"}</span>
                              </div>
                              {formData.plan_key && (
                                <div className="flex items-center gap-2.5 text-[11px]">
                                  <div className="w-2 h-2 rounded-full bg-neutral-900" />
                                  <span className="text-neutral-500">Key: <span className="font-mono font-bold text-neutral-800">{formData.plan_key}</span></span>
                                </div>
                              )}
                              {formData.popular && (
                                <div className="flex items-center gap-2.5 text-[11px]">
                                  <div className="w-2 h-2 rounded-full bg-amber-500" />
                                  <span className="text-neutral-500">Marked as popular</span>
                                </div>
                              )}
                              {formData.hidden && (
                                <div className="flex items-center gap-2.5 text-[11px]">
                                  <div className="w-2 h-2 rounded-full bg-rose-500" />
                                  <span className="text-neutral-500">Hidden from workshops</span>
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* Footer */}
                      <div className="flex-shrink-0 px-6 py-4 border-t border-neutral-100 bg-white flex items-center justify-between gap-3 rounded-b-3xl">
                        <p className="text-[10px] text-neutral-400 flex items-center gap-1.5 max-sm:hidden">
                          <i className="fas fa-shield-halved text-neutral-300" />
                          Changes are saved securely to your database
                        </p>
                        <div className="flex items-center gap-3 ml-auto">
                          <button
                            onClick={() => !savingPackage && setShowPackageForm(false)}
                            disabled={savingPackage}
                            className="px-5 py-2.5 rounded-xl text-neutral-500 hover:text-neutral-700 hover:bg-neutral-100 text-sm font-semibold transition-all disabled:opacity-50"
                          >
                            Cancel
                          </button>
                          <button
                            onClick={handleSavePackage}
                            disabled={savingPackage || uploadingImage}
                            className="px-7 py-2.5 rounded-xl bg-neutral-900 hover:bg-neutral-800 text-white text-sm font-bold transition-all shadow-lg shadow-neutral-900/20 disabled:opacity-50 flex items-center gap-2"
                          >
                            {(savingPackage || uploadingImage) ? (
                              <>
                                <i className="fas fa-circle-notch fa-spin" />
                                {uploadingImage ? "Uploading..." : "Saving..."}
                              </>
                            ) : (
                              <>
                                <i className={`fas ${editingPackage ? "fa-save" : "fa-plus"}`} />
                                {editingPackage ? "Update Package" : "Create Package"}
                              </>
                            )}
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
                );
              })()}

              {/* Delete Confirmation Modal */}
              {deletingPackage && (
                <div className="fixed inset-0 z-[60]">
                  <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={() => !savingPackage && setDeletingPackage(null)} />
                  <div className="absolute inset-0 flex items-center justify-center p-4">
                    <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md">
                      <div className="p-6 border-b border-neutral-200">
                        <div className="flex items-center gap-3">
                          <div className="w-12 h-12 rounded-xl bg-rose-100 flex items-center justify-center">
                            <i className="fas fa-exclamation-triangle text-rose-600 text-xl" />
                          </div>
                          <div>
                            <h3 className="text-lg font-bold text-neutral-900">Delete Package</h3>
                            <p className="text-sm text-neutral-500">Are you sure you want to delete this package?</p>
                          </div>
                        </div>
                      </div>
                      
                      <div className="p-6">
                        <div className="bg-neutral-50 rounded-xl p-4">
                          <p className="font-semibold text-neutral-900">{deletingPackage.name}</p>
                          <p className="text-sm text-neutral-500">{deletingPackage.priceLabel}</p>
                        </div>
                        <div className="mt-4 bg-amber-50 border border-amber-200 rounded-xl p-4">
                          <div className="flex items-start gap-2">
                            <i className="fas fa-info-circle text-amber-600 mt-0.5" />
                            <p className="text-sm text-amber-800">
                              This action cannot be undone. The package will be permanently deleted.
                            </p>
                          </div>
                        </div>
                      </div>

                      <div className="p-6 border-t border-neutral-200 flex items-center justify-end gap-3">
                        <button
                          onClick={() => !savingPackage && setDeletingPackage(null)}
                          disabled={savingPackage}
                          className="px-5 py-2.5 rounded-xl text-neutral-700 hover:bg-neutral-100 text-sm font-semibold transition disabled:opacity-50"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={handleDeletePackage}
                          disabled={savingPackage}
                          className="px-5 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-sm font-semibold transition-all shadow-lg shadow-rose-500/25 disabled:opacity-50 flex items-center gap-2"
                        >
                          {savingPackage ? (
                            <>
                              <i className="fas fa-circle-notch fa-spin" />
                              Deleting...
                            </>
                          ) : (
                            <>
                              <i className="fas fa-trash" />
                              Delete Package
                            </>
                          )}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Plan Selection Modal (for tenants) */}
              {selectedTenant && (
                <div className="fixed inset-0 z-50">
                  <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => !updating && setSelectedTenant(null)} />
                  <div className="absolute inset-0 flex items-center justify-center p-4 overflow-y-auto">
                    <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl my-auto relative">
                      <div className="bg-neutral-900 text-white p-5 rounded-t-2xl">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-lg bg-white/20 backdrop-blur-sm flex items-center justify-center">
                              <i className="fas fa-crown" />
                            </div>
                            <div>
                              <h3 className="text-lg font-bold">Change Subscription Plan</h3>
                              <p className="text-xs text-white/80 mt-0.5">
                                {tenants.find(t => t.id === selectedTenant)?.name || "Tenant"}
                              </p>
                            </div>
                          </div>
                          <button
                            onClick={() => !updating && setSelectedTenant(null)}
                            disabled={updating}
                            className="w-9 h-9 rounded-lg bg-white/20 hover:bg-white/30 backdrop-blur-sm flex items-center justify-center transition disabled:opacity-50"
                          >
                            <i className="fas fa-times text-sm" />
                          </button>
                        </div>
                      </div>

                      <div className="px-6 py-3 border-b border-neutral-200 bg-neutral-50">
                        {(() => {
                          const tenant = tenants.find(t => t.id === selectedTenant);
                          const currentPlan = activePlans.find(p => p.name.toLowerCase() === (tenant?.plan || "").toLowerCase());
                          return currentPlan ? (
                            <div className="flex items-center gap-2">
                              <div className={`w-8 h-8 rounded-lg flex items-center justify-center overflow-hidden ${
                                currentPlan.color === "blue" ? "bg-blue-100" : currentPlan.color === "pink" ? "bg-neutral-100" : currentPlan.color === "purple" ? "bg-purple-100" : "bg-neutral-100"
                              }`}>
                                {currentPlan.image ? (
                                  <img src={currentPlan.image} alt={currentPlan.name} className="w-full h-full object-cover" />
                                ) : currentPlan.icon ? (
                                  <i className={`fas ${currentPlan.icon} text-xs ${
                                    currentPlan.color === "blue" ? "text-blue-600" : currentPlan.color === "pink" ? "text-neutral-700" : currentPlan.color === "purple" ? "text-purple-600" : "text-neutral-600"
                                  }`} />
                                ) : (
                                  <i className={`fas fa-box text-xs ${
                                    currentPlan.color === "blue" ? "text-blue-600" : currentPlan.color === "pink" ? "text-neutral-700" : currentPlan.color === "purple" ? "text-purple-600" : "text-neutral-600"
                                  }`} />
                                )}
                              </div>
                              <span className="text-xs text-neutral-500">Current:</span>
                              <span className="font-semibold text-neutral-900">{currentPlan.name}</span>
                              <span className="text-xs text-neutral-500">•</span>
                              <span className="text-sm text-neutral-600">{tenant?.price || currentPlan.priceLabel}</span>
                            </div>
                          ) : (
                            <div className="text-xs text-neutral-500">No plan currently assigned</div>
                          );
                        })()}
                      </div>

                      <div className="p-6">
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                          {activePlans.map((plan) => {
                            const tenant = tenants.find(t => t.id === selectedTenant);
                            const isCurrentPlan = (tenant?.plan || "").toLowerCase() === plan.name.toLowerCase();
                            
                            return (
                              <div
                                key={plan.id}
                                className={`relative rounded-xl border-2 transition-all ${
                                  isCurrentPlan
                                    ? "border-neutral-900 bg-gradient-to-br from-neutral-50 to-neutral-100 shadow-md"
                                    : plan.popular
                                    ? "border-neutral-400 bg-white hover:border-neutral-900 hover:shadow-lg"
                                    : "border-neutral-200 bg-white hover:border-neutral-400 hover:shadow-md"
                                }`}
                              >
                                {plan.popular && !isCurrentPlan && (
                                  <div className="absolute -top-2.5 left-1/2 -translate-x-1/2 bg-neutral-900 text-white text-[10px] font-bold px-3 py-0.5 rounded-full shadow-md">
                                    Popular
                                  </div>
                                )}
                                {isCurrentPlan && (
                                  <div className="absolute -top-2.5 left-1/2 -translate-x-1/2 bg-neutral-500 text-white text-[10px] font-bold px-3 py-0.5 rounded-full shadow-md flex items-center gap-1">
                                    <i className="fas fa-check-circle text-[8px]" />
                                    Current
                                  </div>
                                )}
                                
                                <div className="p-4">
                                  <div className="text-center mb-4">
                                    <div className={`w-12 h-12 rounded-xl flex items-center justify-center mx-auto mb-2 overflow-hidden ${
                                      plan.color === "blue" ? "bg-blue-100" : plan.color === "pink" ? "bg-neutral-100" : plan.color === "purple" ? "bg-purple-100" : "bg-neutral-100"
                                    }`}>
                                      {plan.image ? (
                                        <img src={plan.image} alt={plan.name} className="w-full h-full object-cover" />
                                      ) : plan.icon ? (
                                        <i className={`fas ${plan.icon} ${
                                          plan.color === "blue" ? "text-blue-600" : plan.color === "pink" ? "text-neutral-700" : plan.color === "purple" ? "text-purple-600" : "text-neutral-600"
                                        }`} />
                                      ) : (
                                        <i className={`fas fa-box ${
                                          plan.color === "blue" ? "text-blue-600" : plan.color === "pink" ? "text-neutral-700" : plan.color === "purple" ? "text-purple-600" : "text-neutral-600"
                                        }`} />
                                      )}
                                    </div>
                                    <h4 className="text-lg font-bold text-neutral-900 mb-1">{plan.name}</h4>
                                    <div className="mb-2">
                                      <span className="text-3xl font-bold text-neutral-900">{plan.priceLabel}</span>
                                    </div>
                                    <div className="text-xs text-neutral-600">
                                      {plan.features.length} {plan.features.length === 1 ? "Feature" : "Features"} included
                                    </div>
                                  </div>

                                  {isCurrentPlan ? (
                                    <div className="w-full py-2.5 px-4 rounded-lg bg-neutral-100 text-neutral-500 text-xs font-semibold text-center cursor-not-allowed">
                                      Current Plan
                                    </div>
                                  ) : (
                                    <button
                                      onClick={() => handlePlanChange(selectedTenant!, plan)}
                                      disabled={updating}
                                      className="w-full py-2.5 px-4 rounded-lg bg-neutral-900 hover:bg-neutral-800 text-white text-xs font-semibold transition-all shadow-md shadow-neutral-900/20 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
                                    >
                                      <i className="fas fa-arrow-right text-[10px]" />
                                      Switch to {plan.name}
                                    </button>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>

                      <div className="px-6 pb-5">
                        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
                          <div className="flex items-start gap-2">
                            <i className="fas fa-info-circle text-amber-600 text-xs mt-0.5" />
                            <p className="text-xs text-amber-800">
                              <span className="font-semibold">Note:</span> Changes take effect immediately. Tenant will be notified.
                            </p>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Confirmation Modal */}
              {confirmingPlan && selectedTenant && (
                <div className="fixed inset-0 z-[60]">
                  <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={cancelPlanChange} />
                  <div className="absolute inset-0 flex items-center justify-center p-4">
                    <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md">
                      <div className="p-6 border-b border-neutral-200">
                        <div className="flex items-center gap-3">
                          <div className="w-12 h-12 rounded-xl bg-amber-100 flex items-center justify-center">
                            <i className="fas fa-exclamation-triangle text-amber-600 text-xl" />
                          </div>
                          <div>
                            <h3 className="text-lg font-bold text-neutral-900">Confirm Plan Change</h3>
                            <p className="text-sm text-neutral-500">Are you sure you want to change the subscription plan?</p>
                          </div>
                        </div>
                      </div>
                      
                      <div className="p-6">
                        {(() => {
                          const tenant = tenants.find(t => t.id === selectedTenant);
                          const currentPlan = activePlans.find(p => p.name.toLowerCase() === (tenant?.plan || "").toLowerCase());
                          
                          return (
                            <div className="space-y-4">
                              <div className="bg-neutral-50 rounded-xl p-4">
                                <p className="text-xs text-neutral-500 uppercase tracking-wide mb-2">Tenant</p>
                                <p className="font-semibold text-neutral-900">{tenant?.name || "Unknown"}</p>
                              </div>
                              
                              <div className="flex items-center justify-between p-4 bg-neutral-50 rounded-xl">
                                <div>
                                  <p className="text-xs text-neutral-500 mb-1">Current Plan</p>
                                  <p className="font-semibold text-neutral-900">{currentPlan?.name || "No Plan"}</p>
                                  <p className="text-sm text-neutral-500">{currentPlan?.priceLabel || "—"}</p>
                                </div>
                                <i className="fas fa-arrow-right text-neutral-400 text-xl mx-4" />
                                <div>
                                  <p className="text-xs text-neutral-500 mb-1">New Plan</p>
                                  <p className="font-semibold text-neutral-900">{confirmingPlan.name}</p>
                                  <p className="text-sm text-neutral-500">{confirmingPlan.priceLabel}</p>
                                </div>
                              </div>

                              <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
                                <div className="flex items-start gap-2">
                                  <i className="fas fa-info-circle text-blue-600 mt-0.5" />
                                  <p className="text-sm text-blue-800">
                                    This change will take effect immediately. The tenant will be notified of the plan update.
                                  </p>
                                </div>
                              </div>
                            </div>
                          );
                        })()}
                      </div>

                      <div className="p-6 border-t border-neutral-200 flex items-center justify-end gap-3">
                        <button
                          onClick={cancelPlanChange}
                          disabled={updating}
                          className="px-5 py-2.5 rounded-xl text-neutral-700 hover:bg-neutral-100 text-sm font-semibold transition disabled:opacity-50"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={confirmPlanChange}
                          disabled={updating}
                          className="px-5 py-2.5 rounded-xl bg-neutral-900 hover:bg-neutral-800 text-white text-sm font-semibold transition-all shadow-lg shadow-neutral-900/25 disabled:opacity-50 flex items-center gap-2"
                        >
                          {updating ? (
                            <>
                              <i className="fas fa-circle-notch fa-spin" />
                              Updating...
                            </>
                          ) : (
                            <>
                              <i className="fas fa-check" />
                              Confirm Change
                            </>
                          )}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
