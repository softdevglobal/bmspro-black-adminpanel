"use client";
import React, { useEffect, useState, useRef } from "react";
import Sidebar from "@/components/Sidebar";
import { useRouter } from "next/navigation";
import { auth, db } from "@/lib/firebase";
import { onAuthStateChanged } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { getStorage, ref as storageRef, uploadBytes, getDownloadURL } from "firebase/storage";
import { subscribeBranchesForOwner } from "@/lib/branches";
import { subscribeSalonStaffForOwner } from "@/lib/salonStaff";
import { createServiceForOwner, deleteService as deleteServiceDoc, subscribeServicesForOwner, updateService } from "@/lib/services";

type Service = {
  id: string;
  name: string;
  price: number;
  duration: number;
  icon?: string;
  imageUrl?: string;
  reviews?: number;
  staffIds: string[];
  branches: string[];
};

type Staff = { id: string; name: string; role: string; branch: string; status: "Active" | "Suspended"; avatar: string };
type Branch = { id: string; name: string };

export default function ServicesPage() {
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [ownerUid, setOwnerUid] = useState<string | null>(null);

  const [services, setServices] = useState<Service[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);

  // modal/form
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editingServiceId, setEditingServiceId] = useState<string | null>(null);
  const [previewService, setPreviewService] = useState<Service | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Service | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [name, setName] = useState("");
  const [price, setPrice] = useState<number | "">("");
  const [duration, setDuration] = useState<number | "">("");
  const [imageUrl, setImageUrl] = useState("");
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [selectedStaff, setSelectedStaff] = useState<Record<string, boolean>>({});
  const [selectedBranches, setSelectedBranches] = useState<Record<string, boolean>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);

  // guard
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
        const role = (snap.data()?.role || "").toString();
        if (role === "salon_branch_admin") {
          router.replace("/branches");
          return;
        }
        if (role !== "workshop_owner") {
          router.replace("/dashboard");
          return;
        }
        setOwnerUid(user.uid);
      } catch {
        router.replace("/login");
      }
    });
    return () => unsub();
  }, [router]);

  // live Firestore data for this owner
  useEffect(() => {
    if (!ownerUid) return;
    const unsubBranches = subscribeBranchesForOwner(ownerUid, (rows) => {
      setBranches(rows.map((r) => ({ id: String(r.id), name: String(r.name || "") })));
    });
    const unsubStaff = subscribeSalonStaffForOwner(ownerUid, (rows) => {
      setStaff(
        rows.map((r) => ({
          id: String(r.id),
          name: String(r.name || ""),
          role: String(r.role || ""),
          branch: String(r.branchName || ""),
          status: (r.status as any) === "Suspended" ? "Suspended" : "Active",
          avatar: String(r.avatar || r.name || ""),
        }))
      );
    });
    const unsubServices = subscribeServicesForOwner(ownerUid, (rows) => {
      setServices(
        rows.map((r) => ({
          id: String(r.id),
          name: String(r.name || ""),
          price: Number(r.price || 0),
          duration: Number(r.duration || 0),
          icon: String(r.icon || ""),
          imageUrl: String((r as any).imageUrl || ""),
          reviews: Number(r.reviews || 0),
          branches: (Array.isArray(r.branches) ? r.branches : []).map(String),
          staffIds: (Array.isArray(r.staffIds) ? r.staffIds : []).map(String),
        }))
      );
    });
    return () => {
      unsubBranches();
      unsubStaff();
      unsubServices();
    };
  }, [ownerUid]);

  // toast
  const [toasts, setToasts] = useState<Array<{ id: string; text: string }>>([]);
  const showToast = (text: string) => {
    const id = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    setToasts((t) => [...t, { id, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3000);
  };

  const openModal = () => {
    setEditingServiceId(null);
    setName("");
    setPrice("");
    setDuration("");
    setImageUrl("");
    setImageFile(null);
    setImagePreview(null);
    const staffMap: Record<string, boolean> = {};
    const branchMap: Record<string, boolean> = {};
    staff.forEach((s) => (staffMap[s.id] = false));
    branches.forEach((b) => (branchMap[b.id] = false));
    setSelectedStaff(staffMap);
    setSelectedBranches(branchMap);
    setIsModalOpen(true);
  };
  const closeModal = () => {
    setIsModalOpen(false);
    setImageFile(null);
    setImagePreview(null);
  };

  const openEdit = (svc: Service) => {
    setEditingServiceId(svc.id);
    setName(svc.name);
    setPrice(svc.price);
    setDuration(svc.duration);
    setImageUrl(svc.imageUrl || "");
    setImagePreview(svc.imageUrl || null);
    setImageFile(null);
    const staffMap: Record<string, boolean> = {};
    const branchMap: Record<string, boolean> = {};
    staff.forEach((s) => (staffMap[s.id] = svc.staffIds?.includes(s.id) || false));
    branches.forEach((b) => (branchMap[b.id] = svc.branches?.includes(b.id) || false));
    setSelectedStaff(staffMap);
    setSelectedBranches(branchMap);
    setIsModalOpen(true);
  };

  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      // Validate file type
      if (!file.type.startsWith('image/')) {
        showToast('Please select an image file');
        return;
      }
      // Validate file size (max 5MB)
      if (file.size > 5 * 1024 * 1024) {
        showToast('Image size should be less than 5MB');
        return;
      }
      setImageFile(file);
      // Create preview
      const reader = new FileReader();
      reader.onloadend = () => {
        setImagePreview(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  const uploadImage = async (): Promise<string | null> => {
    if (!imageFile || !ownerUid) return null;
    
    setUploading(true);
    try {
      const storage = getStorage();
      const timestamp = Date.now();
      const fileName = `services/${ownerUid}/${timestamp}_${imageFile.name}`;
      const imageRef = storageRef(storage, fileName);
      
      await uploadBytes(imageRef, imageFile);
      const downloadURL = await getDownloadURL(imageRef);
      
      return downloadURL;
    } catch (error) {
      console.error('Error uploading image:', error);
      showToast('Failed to upload image');
      return null;
    } finally {
      setUploading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!name.trim() || !price || !duration) return;
    const qualifiedStaff = Object.keys(selectedStaff).filter((id) => selectedStaff[id]);
    const selectedBrs = Object.keys(selectedBranches).filter((id) => selectedBranches[id]);
    if (!ownerUid) return;
    
    // Validate that at least one branch is selected
    if (selectedBrs.length === 0) {
      showToast("Please select at least one branch for this service");
      return;
    }
    
    setSaving(true);
    try {
      // Upload image if a new file is selected
      let finalImageUrl = imageUrl;
      if (imageFile) {
        const uploadedUrl = await uploadImage();
        if (uploadedUrl) {
          finalImageUrl = uploadedUrl;
        } else {
          showToast("Failed to upload image");
          setSaving(false);
          return;
        }
      }
      
      if (editingServiceId) {
        await updateService(editingServiceId, {
          name: name.trim(),
          price: Number(price),
          duration: Number(duration),
          imageUrl: finalImageUrl || "",
          staffIds: qualifiedStaff,
          branches: selectedBrs,
        });
      } else {
        await createServiceForOwner(ownerUid, {
          name: name.trim(),
          price: Number(price),
          duration: Number(duration),
          imageUrl: finalImageUrl || "",
          reviews: 0,
          staffIds: qualifiedStaff,
          branches: selectedBrs,
        });
      }
      setIsModalOpen(false);
      setEditingServiceId(null);
      setImageFile(null);
      setImagePreview(null);
      showToast(editingServiceId ? "Service updated." : "Service added to catalog!");
    } catch (error) {
      console.error('Error saving service:', error);
      showToast(editingServiceId ? "Failed to update service" : "Failed to add service");
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteClick = (service: Service) => {
    setDeleteTarget(service);
  };

  const confirmDeleteService = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteServiceDoc(deleteTarget.id);
      showToast("Service removed.");
      setDeleteTarget(null);
    } catch {
      showToast("Failed to remove service.");
    } finally {
      setDeleting(false);
    }
  };

  const totalBranches = branches.length;

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

          <div className="mb-8">
            <div className="relative rounded-2xl bg-neutral-900 text-white p-6 shadow-sm overflow-hidden">
              <div className="absolute top-0 right-0 w-32 h-32 bg-white/5 rounded-full -translate-y-1/2 translate-x-1/2" />
              <div className="absolute bottom-0 left-1/3 w-20 h-20 bg-white/5 rounded-full translate-y-1/2" />
              <div className="absolute top-3 right-20 text-white/10 text-3xl"><i className="fas fa-gear" /></div>
              <div className="absolute bottom-2 right-40 text-white/10 text-xl"><i className="fas fa-wrench" /></div>
              <div className="relative flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="flex items-center gap-3">
                    <div className="w-11 h-11 rounded-xl bg-amber-500/20 flex items-center justify-center border border-amber-500/30">
                      <i className="fas fa-tags text-amber-400" />
                    </div>
                    <h1 className="text-2xl font-bold">Services</h1>
                  </div>
                  <p className="text-sm text-neutral-400 mt-2">Manage your workshop service catalog</p>
                </div>
              </div>
            </div>
          </div>

          <div className="max-w-7xl mx-auto">
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
              <h2 className="text-2xl font-bold text-neutral-800">Services</h2>
              <button
                onClick={openModal}
                className="w-full sm:w-auto px-4 py-2 bg-neutral-800 text-white rounded-lg text-sm hover:bg-neutral-700 font-medium shadow-md transition flex items-center justify-center gap-2"
              >
                <i className="fa-solid fa-plus" />
                Add New Service
              </button>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {services.map((s) => {
                const staffCount = s.staffIds?.length || 0;
                const branchCount = s.branches?.length || 0;
                const branchLabel = branchCount === totalBranches ? "All Branches" : `${branchCount} Branches`;
                return (
                  <div key={s.id} className="group bg-white rounded-xl overflow-hidden hover:shadow-xl transition-all duration-300 border border-neutral-200 hover:border-neutral-300">
                    {/* Service Image */}
                    <div className="relative w-full h-48 bg-gradient-to-br from-neutral-100 via-neutral-50 to-neutral-100 overflow-hidden">
                      {s.imageUrl ? (
                        <img 
                          src={s.imageUrl} 
                          alt={s.name}
                          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center">
                          <i className="fas fa-wrench text-6xl text-neutral-300/50" />
                        </div>
                      )}
                      
                      {/* Price badge */}
                      <div className="absolute top-3 left-3 bg-neutral-900 text-white px-3 py-1.5 rounded-lg shadow-lg">
                        <span className="text-lg font-bold">${s.price}</span>
                      </div>
                      
                      {/* Action buttons - always visible with backdrop for light images */}
                      <div className="absolute top-3 right-3 flex items-center gap-1.5">
                        <button 
                          onClick={() => setPreviewService(s)} 
                          className="w-8 h-8 rounded-lg flex items-center justify-center bg-neutral-900/70 backdrop-blur-sm text-white hover:bg-neutral-700 transition-all shadow-lg"
                          title="View Details"
                        >
                          <i className="fas fa-eye" />
                        </button>
                        <button 
                          onClick={() => openEdit(s)} 
                          className="w-8 h-8 rounded-lg flex items-center justify-center bg-neutral-900/70 backdrop-blur-sm text-white hover:bg-blue-600 transition-all shadow-lg"
                          title="Edit Service"
                        >
                          <i className="fas fa-pen" />
                        </button>
                        <button 
                          onClick={() => handleDeleteClick(s)} 
                          className="w-8 h-8 rounded-lg flex items-center justify-center bg-neutral-900/70 backdrop-blur-sm text-white hover:bg-rose-600 transition-all shadow-lg"
                          title="Delete Service"
                        >
                          <i className="fas fa-trash" />
                        </button>
                      </div>
                    </div>
                    
                    {/* Service Details */}
                    <div className="p-4">
                      <h3 className="font-bold text-lg text-neutral-900 mb-2 line-clamp-1">{s.name}</h3>
                      
                      <div className="flex items-center gap-3 text-sm text-neutral-600 mb-3">
                        <span className="flex items-center gap-1">
                          <i className="fas fa-clock text-neutral-500" />
                          {s.duration} min
                        </span>
                        <span className="text-neutral-300">•</span>
                        <span className="text-neutral-600 font-medium">{branchLabel}</span>
                      </div>
                      
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1">
                          <i className="fas fa-star text-amber-400 text-xs" />
                          <span className="text-xs text-neutral-500">({s.reviews || 0})</span>
                        </div>
                        <div className="flex items-center gap-1 text-xs bg-emerald-50 text-emerald-700 px-2 py-1 rounded-full font-medium">
                          <i className="fas fa-users text-xs" />
                          <span>{staffCount}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </main>
      </div>

      {/* Toasts */}
      <div id="toast-container" className="fixed bottom-5 right-5 z-50 space-y-2">
        {toasts.map((t) => (
          <div key={t.id} className="toast bg-neutral-800 text-white px-4 py-3 rounded-lg shadow-md border-l-4 border-amber-500 flex items-center gap-2">
            <i className="fas fa-circle-check text-amber-500" />
            <span className="text-sm">{t.text}</span>
          </div>
        ))}
      </div>

      {/* Add Service Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 bg-neutral-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-2 sm:p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[85vh] sm:max-h-[90vh] flex flex-col">
            <div className="relative bg-neutral-900 p-3 sm:p-5 border-b border-neutral-700 flex justify-between items-center rounded-t-xl shrink-0 overflow-hidden">
              <div className="absolute top-0 right-0 w-24 h-24 bg-white/5 rounded-full -translate-y-1/2 translate-x-1/2" />
              <div className="absolute top-2 right-20 text-white/10 text-xl"><i className="fas fa-gear" /></div>
              <div className="relative flex items-center gap-2 sm:gap-3">
                <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-lg bg-amber-500/20 flex items-center justify-center border border-amber-500/30">
                  <i className="fa-solid fa-tags text-amber-400 text-sm sm:text-base" />
                </div>
                <h3 className="font-bold text-white text-sm sm:text-lg">{editingServiceId ? "Edit Service" : "Add New Service"}</h3>
              </div>
              <button 
                type="button"
                onClick={closeModal}
                className="text-white/60 hover:text-white transition w-8 h-8 rounded-lg hover:bg-white/10 flex items-center justify-center"
              >
                <i className="fa-solid fa-xmark text-xl" />
              </button>
            </div>
            <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto custom-scrollbar">
              <div className="p-3 sm:p-6 space-y-3 sm:space-y-4">
                {/* Basic Service Information */}
                <div className="bg-neutral-50 rounded-lg sm:rounded-xl p-3 sm:p-4 border border-neutral-200">
                  <h4 className="text-xs sm:text-sm font-bold text-neutral-700 mb-2 sm:mb-3 flex items-center gap-2">
                    <i className="fas fa-sparkles text-amber-500" />
                    Service Details
                  </h4>
                  <div className="space-y-2.5 sm:space-y-3">
                    <div>
                      <label className="block text-xs font-bold text-neutral-600 mb-1">Service Name</label>
                      <input value={name} onChange={(e) => setName(e.target.value)} required className="w-full border border-neutral-300 rounded-lg p-2 sm:p-2.5 text-xs sm:text-sm focus:ring-2 focus:ring-neutral-900 focus:outline-none" placeholder="e.g. Deep Tissue Massage" />
                    </div>
                    <div className="grid grid-cols-2 gap-2.5 sm:gap-3">
                      <div>
                        <label className="block text-xs font-bold text-neutral-600 mb-1">Duration (mins)</label>
                        <select 
                          value={duration} 
                          onChange={(e) => setDuration(e.target.value === "" ? "" : Number(e.target.value))} 
                          required 
                          className="w-full border border-neutral-300 rounded-lg p-2 sm:p-2.5 text-xs sm:text-sm focus:ring-2 focus:ring-neutral-900 focus:outline-none bg-white"
                        >
                          <option value="">Select Duration</option>
                          <option value="15">15 mins</option>
                          <option value="30">30 mins</option>
                          <option value="45">45 mins</option>
                          <option value="60">60 mins</option>
                          <option value="75">75 mins</option>
                          <option value="90">90 mins</option>
                          <option value="105">105 mins</option>
                          <option value="120">120 mins</option>
                          <option value="135">135 mins</option>
                          <option value="150">150 mins</option>
                          <option value="165">165 mins</option>
                          <option value="180">180 mins</option>
                          <option value="195">195 mins</option>
                          <option value="210">210 mins</option>
                          <option value="225">225 mins</option>
                          <option value="240">240 mins</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs font-bold text-neutral-600 mb-1">Price ($)</label>
                        <input value={price} onChange={(e) => setPrice(e.target.value === "" ? "" : Number(e.target.value))} type="number" required className="w-full border border-neutral-300 rounded-lg p-2 sm:p-2.5 text-xs sm:text-sm focus:ring-2 focus:ring-neutral-900 focus:outline-none" placeholder="120" />
                      </div>
                    </div>
                  </div>
                </div>
                {/* Service Image Upload */}
                <div className="bg-neutral-50 rounded-lg sm:rounded-xl p-3 sm:p-4 border border-neutral-200">
                  <h4 className="text-xs sm:text-sm font-bold text-neutral-700 mb-2 sm:mb-3 flex items-center gap-2">
                    <i className="fas fa-image text-neutral-600" />
                    Service Image
                  </h4>
                  <div className="space-y-3">
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*"
                      onChange={handleImageChange}
                      className="hidden"
                    />
                    
                    {/* Image Preview */}
                    <div className="flex flex-col sm:flex-row items-center gap-3">
                      <div className="w-32 h-32 sm:w-40 sm:h-40 rounded-xl bg-neutral-100 border-2 border-dashed border-neutral-300 flex items-center justify-center overflow-hidden shadow-inner">
                        {imagePreview ? (
                          <img 
                            src={imagePreview} 
                            alt="Service preview" 
                            className="w-full h-full object-cover"
                          />
                        ) : (
                          <div className="text-center text-neutral-400">
                            <i className="fas fa-image text-4xl mb-2 block" />
                            <p className="text-xs">No image selected</p>
                          </div>
                        )}
                      </div>
                      
                      <div className="flex-1 space-y-2 w-full">
                        <button
                          type="button"
                          onClick={() => fileInputRef.current?.click()}
                          className="w-full px-4 py-2.5 text-sm rounded-lg bg-neutral-900 text-white hover:bg-neutral-800 shadow-md transition-all font-medium flex items-center justify-center gap-2"
                        >
                          <i className="fas fa-upload" />
                          {imagePreview ? "Change Image" : "Upload Image"}
                        </button>
                        
                        {imagePreview && (
                          <button
                            type="button"
                            onClick={() => {
                              setImageFile(null);
                              setImagePreview(null);
                              setImageUrl("");
                              if (fileInputRef.current) fileInputRef.current.value = "";
                            }}
                            className="w-full px-4 py-2 text-xs rounded-lg bg-neutral-100 text-neutral-600 hover:bg-neutral-200 transition-all font-medium flex items-center justify-center gap-2"
                          >
                            <i className="fas fa-trash" />
                            Remove Image
                          </button>
                        )}
                        
                        <div className="text-[10px] text-neutral-500 space-y-1">
                          <p><i className="fas fa-info-circle mr-1" />Recommended: 500x500px or larger</p>
                          <p><i className="fas fa-info-circle mr-1" />Max size: 5MB</p>
                          <p><i className="fas fa-info-circle mr-1" />Formats: JPG, PNG, GIF, WebP</p>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
                {/* Available Branches */}
                <div className="bg-blue-50 rounded-lg sm:rounded-xl p-3 sm:p-4 border border-blue-200">
                  <h4 className="text-xs sm:text-sm font-bold text-neutral-700 mb-2 sm:mb-3 flex items-center gap-2">
                    <i className="fas fa-store text-blue-600" />
                    Available Branches
                  </h4>
                  <div className="grid grid-cols-1 gap-1.5 max-h-48 overflow-y-auto border-2 border-blue-200 rounded-lg p-2 sm:p-3 bg-white custom-scrollbar">
                    {branches.length > 0 ? (
                      branches.map((b) => (
                        <label key={b.id} className="flex items-center gap-2 p-2 hover:bg-blue-50 rounded-md cursor-pointer transition group">
                          <input
                            type="checkbox"
                            checked={!!selectedBranches[b.id]}
                            onChange={(e) => setSelectedBranches((m) => ({ ...m, [b.id]: e.target.checked }))}
                            className="rounded border-blue-300 text-blue-600 focus:ring-blue-500 w-4 h-4"
                          />
                          <span className="text-xs sm:text-sm text-neutral-700 font-medium group-hover:text-blue-700">
                            <i className="fas fa-building text-blue-400 mr-1.5" />
                            {b.name}
                          </span>
                        </label>
                      ))
                    ) : (
                      <div className="text-xs text-neutral-400 text-center py-3">
                        <i className="fas fa-store-slash mb-1 block text-neutral-300" />
                        No Branches Configured.
                      </div>
                    )}
                  </div>
                  <p className="text-[10px] text-blue-600 mt-1.5">
                    <i className="fas fa-info-circle mr-1" />
                    Select which locations offer this service
                  </p>
                </div>
                {/* Qualified Staff */}
                <div className="bg-emerald-50 rounded-lg sm:rounded-xl p-3 sm:p-4 border border-emerald-200">
                  <h4 className="text-xs sm:text-sm font-bold text-neutral-700 mb-2 sm:mb-3 flex items-center gap-2">
                    <i className="fas fa-user-check text-emerald-600" />
                    Qualified Staff
                  </h4>
                  <div className="grid grid-cols-1 gap-1.5 max-h-64 overflow-y-auto border-2 border-emerald-200 rounded-lg p-2 sm:p-3 bg-white custom-scrollbar">
                    {staff.filter((s) => s.status === "Active").length > 0 ? (
                      staff
                        .filter((s) => s.status === "Active")
                        .map((s) => (
                          <label key={s.id} className="flex items-center gap-2 p-2 hover:bg-emerald-50 rounded-md cursor-pointer transition group">
                            <input
                              type="checkbox"
                              checked={!!selectedStaff[s.id]}
                              onChange={(e) => setSelectedStaff((m) => ({ ...m, [s.id]: e.target.checked }))}
                              className="rounded border-emerald-300 text-emerald-600 focus:ring-emerald-500 w-4 h-4"
                            />
                            <img
                              src={`https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(s.avatar)}`}
                              alt={s.name}
                              className="w-6 h-6 rounded-full bg-neutral-100"
                            />
                            <div className="flex-1 min-w-0">
                              <span className="text-xs sm:text-sm text-neutral-700 font-medium group-hover:text-emerald-700 block truncate">{s.name}</span>
                              <span className="text-[10px] text-neutral-500">{s.role}</span>
                            </div>
                          </label>
                        ))
                    ) : (
                      <div className="text-xs text-neutral-400 text-center py-3">
                        <i className="fas fa-user-slash mb-1 block text-neutral-300" />
                        No Active Staff Found.
                      </div>
                    )}
                  </div>
                  <p className="text-[10px] text-emerald-600 mt-1.5">
                    <i className="fas fa-info-circle mr-1" />
                    Only selected staff can perform this service
                  </p>
                </div>
                </div>
                
                {/* Footer with Submit Button */}
                <div className="p-3 sm:p-4 bg-neutral-50 border-t border-neutral-200 rounded-b-xl shrink-0">
                  <button
                    type="submit"
                    disabled={saving}
                    className={`w-full bg-neutral-900 text-white font-bold py-2.5 sm:py-3 rounded-lg shadow-lg transition-all text-sm sm:text-base ${
                      saving ? "opacity-60 cursor-not-allowed" : "hover:bg-neutral-800 hover:shadow-xl transform active:scale-95 sm:hover:scale-[1.02]"
                    }`}
                  >
                    {saving ? (
                      <span className="inline-flex items-center justify-center gap-2">
                        <i className="fa-solid fa-circle-notch fa-spin" />
                        Saving...
                      </span>
                    ) : (
                      <span className="inline-flex items-center justify-center gap-2">
                        <i className="fa-solid fa-save" />
                        {editingServiceId ? "Save Changes" : "Add Service"}
                      </span>
                    )}
                  </button>
                </div>
              </form>
            </div>
          </div>
      )}

      {/* Preview Service Sidebar */}
      <div
        className={`fixed inset-0 z-50 ${previewService ? "pointer-events-auto" : "pointer-events-none"}`}
        aria-hidden={!previewService}
      >
        <div
          onClick={() => setPreviewService(null)}
          className={`absolute inset-0 bg-black/50 transition-opacity duration-200 ${previewService ? "opacity-100" : "opacity-0"}`}
        />
        <aside
          className={`absolute top-0 h-full right-0 w-[92vw] sm:w-[28rem] bg-white shadow-2xl border-l border-neutral-200 transform transition-transform duration-300 ${previewService ? "translate-x-0" : "translate-x-full"}`}
        >
      {previewService && (
            <div className="flex h-full flex-col">
              {/* Fixed Header */}
              <div className="shrink-0 relative bg-neutral-900 p-5 overflow-hidden">
                <div className="absolute top-0 right-0 w-24 h-24 bg-white/5 rounded-full -translate-y-1/2 translate-x-1/2" />
                <div className="absolute top-2 right-16 text-white/10 text-xl"><i className="fas fa-gear" /></div>
                <div className="relative flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-amber-500/20 flex items-center justify-center border border-amber-500/30">
                      <i className="fas fa-eye text-amber-400"></i>
                    </div>
                    <div>
                      <h3 className="text-lg font-bold text-white">Service Details</h3>
                      <p className="text-white/80 text-sm">{previewService.name}</p>
                    </div>
                  </div>
                  <button 
                    onClick={() => setPreviewService(null)}
                    className="w-9 h-9 bg-white/20 backdrop-blur-sm hover:bg-white/30 rounded-full flex items-center justify-center text-white transition-all"
                  >
                    <i className="fas fa-times text-lg" />
                  </button>
                </div>
              </div>

              {/* Scrollable Content (including image) */}
              <div className="flex-1 overflow-y-auto">
                {/* Service Image */}
                <div className="relative w-full h-64 bg-gradient-to-br from-neutral-100 via-neutral-50 to-neutral-100">
              {previewService.imageUrl ? (
                <img 
                  src={previewService.imageUrl} 
                  alt={previewService.name}
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <i className="fas fa-wrench text-8xl text-neutral-300/50" />
                </div>
              )}
              
              {/* Gradient overlay */}
                  <div className="absolute inset-0 bg-gradient-to-t from-black/40 via-transparent to-transparent" />
                </div>
              
                {/* Content */}
                <div className="p-5 space-y-5">
                {/* Price and Duration */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-neutral-50 rounded-xl p-4 border-2 border-neutral-200">
                    <div className="flex items-center gap-2 mb-2">
                      <div className="w-8 h-8 rounded-lg bg-neutral-100 flex items-center justify-center">
                        <i className="fas fa-dollar-sign text-amber-500" />
              </div>
                      <div className="text-xs text-neutral-600 font-semibold">Price</div>
            </div>
                    <div className="text-3xl font-bold bg-neutral-900 bg-clip-text text-transparent">
                    ${previewService.price}
                  </div>
                </div>
                  <div className="bg-gradient-to-br from-blue-50 to-indigo-50 rounded-xl p-4 border-2 border-blue-200">
                    <div className="flex items-center gap-2 mb-2">
                      <div className="w-8 h-8 rounded-lg bg-blue-100 flex items-center justify-center">
                        <i className="fas fa-clock text-blue-600" />
                  </div>
                      <div className="text-xs text-neutral-600 font-semibold">Duration</div>
                    </div>
                    <div className="text-3xl font-bold text-blue-600">
                      {previewService.duration}<span className="text-lg">min</span>
                    </div>
                </div>
              </div>
              
                {/* Stats */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-white border-2 border-neutral-200 rounded-xl p-4">
                    <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-amber-100 flex items-center justify-center">
                        <i className="fas fa-star text-amber-500 text-lg" />
                  </div>
                  <div>
                        <div className="text-xs text-neutral-500 font-medium">Rating</div>
                        <div className="text-lg font-bold text-neutral-900">{previewService.reviews || 0}</div>
                        <div className="text-xs text-neutral-400">reviews</div>
                  </div>
                </div>
                  </div>
                  <div className="bg-white border-2 border-neutral-200 rounded-xl p-4">
                    <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-emerald-100 flex items-center justify-center">
                        <i className="fas fa-users text-emerald-600 text-lg" />
                  </div>
                  <div>
                        <div className="text-xs text-neutral-500 font-medium">Staff</div>
                        <div className="text-lg font-bold text-neutral-900">{previewService.staffIds?.length || 0}</div>
                        <div className="text-xs text-neutral-400">qualified</div>
                      </div>
                  </div>
                </div>
              </div>

                {/* Qualified Staff Members */}
                {previewService.staffIds && previewService.staffIds.length > 0 && (
                  <div className="bg-gradient-to-br from-emerald-50 to-teal-50 rounded-xl p-4 border-2 border-emerald-200">
                    <h3 className="text-sm font-bold text-neutral-800 mb-3 flex items-center gap-2">
                      <i className="fas fa-user-check text-emerald-600" />
                      Qualified Staff Members
                    </h3>
                    <div className="space-y-2">
                      {previewService.staffIds.map((staffId) => {
                        const staffMember = staff.find((s) => s.id === staffId);
                        if (!staffMember) return null;
                        return (
                          <div key={staffId} className="flex items-center gap-3 bg-white rounded-lg p-3 border border-emerald-100">
                            <div className="w-10 h-10 rounded-full overflow-hidden border-2 border-emerald-200 flex-shrink-0">
                              <img
                                src={`https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(staffMember.avatar)}`}
                                alt={staffMember.name}
                                className="w-full h-full object-cover"
                              />
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="font-semibold text-neutral-800 text-sm truncate">{staffMember.name}</p>
                              <p className="text-xs text-neutral-500 truncate">{staffMember.role}</p>
                            </div>
                            <div className="flex-shrink-0">
                              <span className="text-xs bg-emerald-50 text-emerald-700 px-2 py-1 rounded-full font-medium">
                                <i className="fas fa-store text-[10px] mr-1"></i>
                                {staffMember.branch}
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              
              {/* Available Branches */}
                <div className="bg-neutral-50 rounded-xl p-4 border-2 border-neutral-200">
                  <h3 className="text-sm font-bold text-neutral-800 mb-3 flex items-center gap-2">
                    <i className="fas fa-map-marker-alt text-neutral-600" />
                  Available Locations
                </h3>
                <div className="flex flex-wrap gap-2">
                  {previewService.branches.length > 0 ? (
                    previewService.branches.map((bid) => {
                      const b = branches.find((x) => x.id === bid);
                      return (
                        <span 
                          key={bid} 
                            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-white border border-neutral-300 text-neutral-700 text-sm font-medium shadow-sm"
                        >
                            <i className="fas fa-store text-xs" />
                          {b?.name || bid}
                        </span>
                      );
                    })
                  ) : (
                      <span className="text-sm text-neutral-500 italic">No branches assigned yet</span>
                  )}
                  </div>
                </div>
                </div>
              </div>
              
              {/* Footer Actions */}
              <div className="shrink-0 border-t border-neutral-200 p-4 bg-white flex gap-3">
                <button
                  onClick={() => setPreviewService(null)}
                  className="flex-1 px-4 py-2.5 bg-neutral-200 text-neutral-700 rounded-lg font-semibold hover:bg-neutral-300 transition-all text-sm"
                >
                  <i className="fas fa-times mr-2" />
                  Close
                </button>
                <button
                  onClick={() => {
                    const serviceToEdit = previewService;
                    setPreviewService(null);
                    openEdit(serviceToEdit);
                  }}
                  className="flex-1 px-4 py-2.5 bg-neutral-900 text-white rounded-lg font-semibold hover:bg-neutral-800 shadow-lg hover:shadow-xl transition-all text-sm"
                >
                  <i className="fas fa-pen mr-2" />
                  Edit Service
                </button>
          </div>
        </div>
      )}
        </aside>
      </div>

      {/* Delete Confirmation Modal */}
      {deleteTarget && (
        <div className="fixed inset-0 bg-neutral-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0" onClick={() => !deleting && setDeleteTarget(null)} />
          <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
            <div className="p-6 border-b border-neutral-100 flex items-center gap-3">
              <div className="w-12 h-12 rounded-full bg-rose-100 text-rose-600 flex items-center justify-center shrink-0">
                <i className="fa-solid fa-triangle-exclamation text-xl" />
              </div>
              <h3 className="font-semibold text-neutral-900 text-lg">Delete Service?</h3>
            </div>
            <div className="p-6 text-sm text-neutral-600">
              Are you sure you want to delete <span className="font-semibold text-neutral-800">"{deleteTarget.name}"</span>? This action cannot be undone.
            </div>
            <div className="px-6 pb-6 flex items-center justify-end gap-3">
              <button
                onClick={() => setDeleteTarget(null)}
                disabled={deleting}
                className="px-5 py-2.5 rounded-lg border border-neutral-300 text-neutral-700 hover:bg-neutral-50 disabled:opacity-60 font-medium transition-all"
              >
                Cancel
              </button>
              <button
                onClick={confirmDeleteService}
                disabled={deleting}
                className="px-5 py-2.5 rounded-lg bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-60 font-medium transition-all shadow-md hover:shadow-lg"
              >
                {deleting ? (
                  <span className="inline-flex items-center gap-2">
                    <i className="fa-solid fa-circle-notch fa-spin" />
                    Deleting...
                  </span>
                ) : (
                  <span>
                    <i className="fa-solid fa-trash mr-2" />
                    Delete Service
                  </span>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


