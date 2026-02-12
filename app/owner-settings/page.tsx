"use client";
import React, { useEffect, useState, useRef } from "react";
import Sidebar from "@/components/Sidebar";
import { useRouter } from "next/navigation";
import { onAuthStateChanged, signInWithEmailAndPassword } from "firebase/auth";
import { auth, db, storage } from "@/lib/firebase";
import { doc, getDoc, updateDoc, serverTimestamp } from "firebase/firestore";
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { TIMEZONES } from "@/lib/timezone";
import { logPasswordChanged, logProfilePictureChanged } from "@/lib/auditLog";

type UserData = {
  uid: string;
  name: string;
  email: string;
  phone?: string;
  contactPhone?: string;
  abn?: string;
  address?: string;
  locationText?: string;
  businessStructure?: string;
  gstRegistered?: boolean;
  state?: string;
  timezone?: string; // IANA timezone (e.g., 'Australia/Sydney')
  plan?: string;
  price?: string;
  role: string;
  logoUrl?: string;
  termsAndConditions?: string;
  bookingEngineUrl?: string;
  slug?: string;
};

// Format ABN as XX XXX XXX XXX
const formatAbn = (value: string) => {
  const digits = value.replace(/\D/g, '').slice(0, 11);
  if (digits.length <= 2) return digits;
  if (digits.length <= 5) return `${digits.slice(0, 2)} ${digits.slice(2)}`;
  if (digits.length <= 8) return `${digits.slice(0, 2)} ${digits.slice(2, 5)} ${digits.slice(5)}`;
  return `${digits.slice(0, 2)} ${digits.slice(2, 5)} ${digits.slice(5, 8)} ${digits.slice(8)}`;
};

export default function OwnerSettingsPage() {
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [userData, setUserData] = useState<UserData | null>(null);

  // Form states
  const [salonName, setSalonName] = useState("");
  const [abn, setAbn] = useState("");
  const [address, setAddress] = useState("");
  const [phone, setPhone] = useState("");
  const [timezone, setTimezone] = useState("Australia/Sydney");
  const [logoUrl, setLogoUrl] = useState("");
  const [termsAndConditions, setTermsAndConditions] = useState("");
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [showRemoveLogoModal, setShowRemoveLogoModal] = useState(false);
  const logoInputRef = useRef<HTMLInputElement>(null);
  
  // Password change states
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPasswords, setShowPasswords] = useState({ current: false, new: false, confirm: false });
  const [passwordErrors, setPasswordErrors] = useState<string[]>([]);

  // Toast notifications
  const [toasts, setToasts] = useState<{ id: number; message: string; type: 'success' | 'error' }[]>([]);

  const showToast = (message: string, type: 'success' | 'error' = 'success') => {
    const id = Date.now();
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 3000);
  };

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        router.replace("/login");
        return;
      }
      try {
        const token = await user.getIdToken();
        if (typeof window !== "undefined") localStorage.setItem("idToken", token);
        
        // Fetch user data
        const snap = await getDoc(doc(db, "users", user.uid));
        const data = snap.data();
        const role = (data?.role || "").toString();
        
        if (role === "salon_branch_admin") {
          router.replace("/branches");
          return;
        }
        if (role !== "workshop_owner") {
          router.replace("/dashboard");
          return;
        }

        // Set user data - use locationText as address and contactPhone as phone
        const userData: UserData = {
          uid: user.uid,
          name: data?.name || data?.displayName || "",
          email: user.email || data?.email || "",
          phone: data?.contactPhone || data?.phone || "",
          contactPhone: data?.contactPhone || "",
          abn: data?.abn || "",
          address: data?.locationText || data?.address || "",
          locationText: data?.locationText || "",
          businessStructure: data?.businessStructure || "",
          gstRegistered: data?.gstRegistered ?? false,
          state: data?.state || "",
          timezone: data?.timezone || "Australia/Sydney",
          plan: data?.plan || "",
          price: data?.price || "",
          role: role,
          logoUrl: data?.logoUrl || "",
          termsAndConditions: data?.termsAndConditions || "",
          bookingEngineUrl: data?.bookingEngineUrl || "",
          slug: data?.slug || "",
        };
        
        setUserData(userData);
        
        // Initialize form fields - use locationText for address and contactPhone for phone
        setSalonName(userData.name);
        setAbn(formatAbn(userData.abn || ""));
        setAddress(userData.locationText || userData.address || "");
        setPhone(userData.contactPhone || userData.phone || "");
        setTimezone(userData.timezone || "Australia/Sydney");
        setLogoUrl(userData.logoUrl || "");
        setTermsAndConditions(userData.termsAndConditions || "");
        
        setMounted(true);
        setLoading(false);
      } catch (error) {
        console.error("Error fetching user data:", error);
        router.replace("/login");
      }
    });
    return () => unsub();
  }, [router]);

  const handleSaveProfile = async () => {
    if (!userData) return;
    setSaving("profile");
    try {
      await updateDoc(doc(db, "users", userData.uid), {
        name: salonName,
        displayName: salonName,
        abn: abn.replace(/\s/g, '').trim() || null,
        locationText: address,
        contactPhone: phone,
        timezone: timezone,
        updatedAt: serverTimestamp(),
      });
      setUserData({ ...userData, name: salonName, abn: abn.replace(/\s/g, '').trim() || "", address, locationText: address, phone, contactPhone: phone, timezone });
      showToast("Profile saved successfully!");
    } catch (error) {
      console.error("Error saving profile:", error);
      showToast("Failed to save profile. Please try again.", "error");
    } finally {
      setSaving(null);
    }
  };

  const handleSaveTerms = async () => {
    if (!userData) return;
    setSaving("terms");
    try {
      await updateDoc(doc(db, "users", userData.uid), {
        termsAndConditions: termsAndConditions,
        updatedAt: serverTimestamp(),
      });
      setUserData({ ...userData, termsAndConditions });
      showToast("Terms & Conditions saved successfully!");
    } catch (error) {
      console.error("Error saving terms:", error);
      showToast("Failed to save terms. Please try again.", "error");
    } finally {
      setSaving(null);
    }
  };

  const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !userData) return;

    // Validate file type
    const validTypes = ['image/png', 'image/jpeg', 'image/jpg', 'image/svg+xml', 'image/webp'];
    if (!validTypes.includes(file.type)) {
      showToast("Please upload a valid image file (PNG, JPG, SVG, or WebP)", "error");
      return;
    }

    // Validate file size (max 5MB)
    if (file.size > 5 * 1024 * 1024) {
      showToast("File size must be less than 5MB", "error");
      return;
    }

    setUploadingLogo(true);
    try {
      // Create a unique filename
      const fileExtension = file.name.split('.').pop();
      const fileName = `salon-logos/${userData.uid}/logo-${Date.now()}.${fileExtension}`;
      const storageRef = ref(storage, fileName);

      // Upload the file
      await uploadBytes(storageRef, file);

      // Get the download URL
      const downloadUrl = await getDownloadURL(storageRef);

      // Save URL to Firestore
      await updateDoc(doc(db, "users", userData.uid), {
        logoUrl: downloadUrl,
        updatedAt: serverTimestamp(),
      });

      setLogoUrl(downloadUrl);
      setUserData({ ...userData, logoUrl: downloadUrl });
      
      // Log audit trail
      try {
        await logProfilePictureChanged(
          userData.uid, // ownerUid (salon owner owns their own profile)
          userData.uid, // userId
          userData.name || userData.email || "Workshop Owner", // userName
          {
            uid: userData.uid,
            name: userData.name || userData.email || "Workshop Owner",
            role: userData.role || "workshop_owner",
          },
          "logo" // pictureType
        );
      } catch (auditError) {
        console.error("Failed to log profile picture change:", auditError);
        // Don't block the upload if audit logging fails
      }
      
      showToast("Logo uploaded successfully!");
    } catch (error) {
      console.error("Error uploading logo:", error);
      showToast("Failed to upload logo. Please try again.", "error");
    } finally {
      setUploadingLogo(false);
      // Reset the input
      if (logoInputRef.current) {
        logoInputRef.current.value = "";
      }
    }
  };

  const handleRemoveLogo = () => {
    if (!userData) return;
    setShowRemoveLogoModal(true);
  };

  const confirmRemoveLogo = async () => {
    if (!userData) return;
    setShowRemoveLogoModal(false);
    setUploadingLogo(true);
    try {
      await updateDoc(doc(db, "users", userData.uid), {
        logoUrl: "",
        updatedAt: serverTimestamp(),
      });
      setLogoUrl("");
      setUserData({ ...userData, logoUrl: "" });
      
      // Log audit trail
      try {
        await logProfilePictureChanged(
          userData.uid, // ownerUid (salon owner owns their own profile)
          userData.uid, // userId
          userData.name || userData.email || "Workshop Owner", // userName
          {
            uid: userData.uid,
            name: userData.name || userData.email || "Workshop Owner",
            role: userData.role || "workshop_owner",
          },
          "logo" // pictureType
        );
      } catch (auditError) {
        console.error("Failed to log profile picture removal:", auditError);
        // Don't block the removal if audit logging fails
      }
      
      showToast("Logo removed successfully!");
    } catch (error) {
      console.error("Error removing logo:", error);
      showToast("Failed to remove logo. Please try again.", "error");
    } finally {
      setUploadingLogo(false);
    }
  };

  // Password validation function
  const validatePassword = (password: string): string[] => {
    const errors: string[] = [];
    
    if (password.length < 8) {
      errors.push("At least 8 characters");
    }
    
    if (!/[A-Z]/.test(password)) {
      errors.push("One uppercase letter");
    }
    
    if (!/[a-z]/.test(password)) {
      errors.push("One lowercase letter");
    }
    
    if (!/[0-9]/.test(password)) {
      errors.push("One number");
    }
    
    if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) {
      errors.push("One special character");
    }
    
    return errors;
  };

  // Validate password on change
  const handleNewPasswordChange = (value: string) => {
    setNewPassword(value);
    if (value.length > 0) {
      const errors = validatePassword(value);
      setPasswordErrors(errors);
    } else {
      setPasswordErrors([]);
    }
  };

  const handleChangePassword = async () => {
    if (!userData || !auth.currentUser) {
      showToast("You must be logged in to change your password.", "error");
      return;
    }

    // Validation
    if (!currentPassword || !newPassword || !confirmPassword) {
      showToast("Please fill in all password fields.", "error");
      return;
    }

    // Validate password strength
    const validationErrors = validatePassword(newPassword);
    if (validationErrors.length > 0) {
      showToast(`Password must contain: ${validationErrors.join(", ")}`, "error");
      return;
    }

    if (newPassword !== confirmPassword) {
      showToast("New passwords do not match.", "error");
      return;
    }

    if (currentPassword === newPassword) {
      showToast("New password must be different from your current password.", "error");
      return;
    }

    setSaving("password");
    try {
      // First, verify the current password by attempting to sign in
      try {
        await signInWithEmailAndPassword(auth, userData.email, currentPassword);
      } catch (error: any) {
        if (error?.code === "auth/wrong-password" || error?.code === "auth/invalid-credential") {
          showToast("Current password is incorrect.", "error");
          setSaving(null);
          return;
        }
        throw error;
      }

      // If verification succeeds, call API to update password
      const token = await auth.currentUser?.getIdToken();
      const response = await fetch("/api/user/change-password", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          uid: userData.uid,
          newPassword: newPassword,
        }),
      });

      const result = await response.json();

      if (!response.ok) {
        showToast(result.error || "Failed to change password. Please try again.", "error");
        return;
      }

      // Clear password fields
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setPasswordErrors([]);
      
      // Create audit log for password change
      try {
        const ownerUid = userData.uid; // For salon owners, ownerUid is their own uid
        const userName = userData.name || userData.email || "Unknown User";
        const userRole = userData.role || "workshop_owner";
        await logPasswordChanged(ownerUid, userData.uid, userName, userRole);
      } catch (auditError) {
        console.error("Failed to create password change audit log:", auditError);
        // Don't fail the password change if audit log fails
      }
      
      showToast("Password changed successfully!");
    } catch (error: any) {
      console.error("Error changing password:", error);
      showToast(error?.message || "Failed to change password. Please try again.", "error");
    } finally {
      setSaving(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-white">
        <div className="flex flex-col items-center gap-3">
          <i className="fas fa-circle-notch fa-spin text-4xl text-neutral-900" />
          <p className="text-neutral-500 font-medium">Loading...</p>
        </div>
      </div>
    );
  }

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

          {mounted && userData && (
            <>
              {/* Header Banner */}
              <div className="mb-8">
                <div className="relative rounded-2xl bg-neutral-900 text-white p-6 shadow-lg overflow-hidden">
                  {/* Decorative Background Elements */}
                  <div className="absolute inset-0 overflow-hidden">
                    <div className="absolute -top-6 -right-6 w-32 h-32 rounded-full bg-amber-500/10" />
                    <div className="absolute -bottom-8 -left-8 w-40 h-40 rounded-full bg-amber-500/5" />
                    <div className="absolute top-1/2 right-1/4 w-2 h-2 rounded-full bg-amber-400/30" />
                    <div className="absolute bottom-4 right-1/3 w-1.5 h-1.5 rounded-full bg-amber-400/20" />
                    {/* Subtle gear pattern */}
                    <i className="fas fa-gear absolute -right-2 -bottom-2 text-[80px] text-white/[0.03] rotate-12" />
                    <i className="fas fa-gear absolute right-16 -top-4 text-[50px] text-white/[0.03] -rotate-6" />
                  </div>
                  <div className="relative flex items-center justify-between">
                    <div className="flex items-center gap-4">
                      <div className="w-12 h-12 rounded-2xl bg-amber-500/20 border border-amber-500/30 flex items-center justify-center">
                        <i className="fas fa-screwdriver-wrench text-lg text-amber-400" />
                      </div>
                      <div>
                        <h1 className="text-2xl font-bold tracking-tight">Workshop Settings</h1>
                        <p className="text-sm text-neutral-400 mt-0.5">Business profile, branding, service terms & security</p>
                      </div>
                    </div>
                    <div className="hidden sm:flex items-center gap-2 bg-white/10 border border-white/10 px-4 py-2 rounded-xl">
                      <i className="fas fa-user-gear text-sm text-amber-400" />
                      <span className="text-sm font-medium text-neutral-300">{userData.email}</span>
                    </div>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <section className="lg:col-span-2 space-y-6">
                  {/* Business Profile */}
                  <div className="bg-white border border-neutral-200 rounded-2xl overflow-hidden">
                    <div className="flex items-center gap-3 px-6 py-4 border-b border-neutral-100 bg-neutral-50/50">
                      <div className="w-9 h-9 rounded-xl bg-neutral-900 flex items-center justify-center">
                        <i className="fas fa-building text-sm text-amber-400" />
                      </div>
                      <div>
                        <h2 className="text-base font-bold text-neutral-900">Business Profile</h2>
                        <p className="text-xs text-neutral-500">Workshop details and contact information</p>
                      </div>
                    </div>
                    <div className="p-6">
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div>
                          <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-2">Workshop Name</label>
                          <div className="relative">
                            <i className="fas fa-warehouse absolute left-3.5 top-1/2 -translate-y-1/2 text-neutral-400 text-sm" />
                            <input 
                              className="w-full pl-10 pr-4 py-3 border border-neutral-200 rounded-xl focus:ring-2 focus:ring-neutral-900 focus:border-transparent bg-white transition-shadow" 
                              placeholder="Your Workshop Name"
                              value={salonName}
                              onChange={(e) => setSalonName(e.target.value)}
                            />
                          </div>
                        </div>
                        <div>
                          <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-2">ABN</label>
                          <div className="relative">
                            <i className="fas fa-hashtag absolute left-3.5 top-1/2 -translate-y-1/2 text-neutral-400 text-sm" />
                            <input 
                              className="w-full pl-10 pr-4 py-3 border border-neutral-200 rounded-xl focus:ring-2 focus:ring-neutral-900 focus:border-transparent font-mono tracking-wide bg-white transition-shadow" 
                              placeholder="00 000 000 000"
                              maxLength={14}
                              value={abn}
                              onChange={(e) => setAbn(formatAbn(e.target.value))}
                            />
                          </div>
                        </div>
                        <div>
                          <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-2">Phone</label>
                          <div className="relative">
                            <i className="fas fa-phone absolute left-3.5 top-1/2 -translate-y-1/2 text-neutral-400 text-sm" />
                            <input 
                              className="w-full pl-10 pr-4 py-3 border border-neutral-200 rounded-xl focus:ring-2 focus:ring-neutral-900 focus:border-transparent bg-white transition-shadow" 
                              placeholder="+61 xxx xxx xxx"
                              value={phone}
                              onChange={(e) => setPhone(e.target.value)}
                            />
                          </div>
                        </div>
                        <div>
                          <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-2">Email</label>
                          <div className="relative">
                            <i className="fas fa-envelope absolute left-3.5 top-1/2 -translate-y-1/2 text-neutral-300 text-sm" />
                            <input 
                              className="w-full pl-10 pr-4 py-3 border border-neutral-200 rounded-xl bg-neutral-50 text-neutral-400 cursor-not-allowed" 
                              value={userData.email}
                              disabled
                              title="Email cannot be changed"
                            />
                          </div>
                        </div>
                        <div className="sm:col-span-2">
                          <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-2">Address</label>
                          <div className="relative">
                            <i className="fas fa-location-dot absolute left-3.5 top-4 text-neutral-400 text-sm" />
                            <textarea 
                              rows={3} 
                              className="w-full pl-10 pr-4 py-3 border border-neutral-200 rounded-xl focus:ring-2 focus:ring-neutral-900 focus:border-transparent bg-white transition-shadow" 
                              placeholder="Street, City, State, Postcode"
                              value={address}
                              onChange={(e) => setAddress(e.target.value)}
                            />
                          </div>
                        </div>
                        <div className="sm:col-span-2">
                          <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-2">
                            <i className="fas fa-globe mr-1.5 text-neutral-400" />
                            Time Zone
                          </label>
                          <div className="relative">
                            <select
                              value={timezone}
                              onChange={(e) => setTimezone(e.target.value)}
                              className="w-full px-4 py-3 border border-neutral-200 rounded-xl focus:ring-2 focus:ring-neutral-900 focus:border-transparent appearance-none pr-10 bg-white"
                            >
                              {TIMEZONES.map((tz) => (
                                <option key={tz.value} value={tz.value}>
                                  {tz.label}
                                </option>
                              ))}
                            </select>
                            <i className="fas fa-chevron-down absolute right-4 top-1/2 -translate-y-1/2 text-neutral-400 pointer-events-none" />
                          </div>
                          <p className="mt-1.5 text-xs text-neutral-400 flex items-center gap-1">
                            <i className="fas fa-info-circle" />
                            Used for all bookings and operations across your workshop
                          </p>
                        </div>
                      </div>
                      <div className="mt-5 flex justify-end">
                        <button 
                          onClick={handleSaveProfile}
                          disabled={saving === "profile"}
                          className="px-6 py-2.5 bg-neutral-900 text-white rounded-xl font-semibold hover:bg-neutral-800 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 transition-colors shadow-sm"
                        >
                          {saving === "profile" ? (
                            <>
                              <i className="fas fa-spinner fa-spin" />
                              Saving...
                            </>
                          ) : (
                            <>
                              <i className="fas fa-save" />
                              Save Profile
                            </>
                          )}
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Change Password */}
                  <div className="bg-white border border-neutral-200 rounded-2xl overflow-hidden">
                    <div className="flex items-center gap-3 px-6 py-4 border-b border-neutral-100 bg-neutral-50/50">
                      <div className="w-9 h-9 rounded-xl bg-neutral-900 flex items-center justify-center">
                        <i className="fas fa-shield-halved text-sm text-amber-400" />
                      </div>
                      <div>
                        <h2 className="text-base font-bold text-neutral-900">Security</h2>
                        <p className="text-xs text-neutral-500">Update your account password for better security</p>
                      </div>
                    </div>
                    <div className="p-6">
                      <div className="space-y-4">
                        <div>
                          <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-2">
                            Current Password
                          </label>
                          <div className="relative">
                            <i className="fas fa-lock absolute left-3.5 top-1/2 -translate-y-1/2 text-neutral-400 text-sm" />
                            <input
                              type={showPasswords.current ? "text" : "password"}
                              className="w-full pl-10 pr-10 py-3 border border-neutral-200 rounded-xl focus:ring-2 focus:ring-neutral-900 focus:border-transparent bg-white transition-shadow"
                              placeholder="Enter your current password"
                              value={currentPassword}
                              onChange={(e) => setCurrentPassword(e.target.value)}
                              disabled={saving === "password"}
                            />
                            <button
                              type="button"
                              onClick={() => setShowPasswords({ ...showPasswords, current: !showPasswords.current })}
                              className="absolute right-3 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-neutral-600"
                            >
                              <i className={`fas ${showPasswords.current ? "fa-eye-slash" : "fa-eye"}`} />
                            </button>
                          </div>
                        </div>
                        
                        <div>
                          <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-2">
                            New Password
                          </label>
                          <div className="relative">
                            <i className="fas fa-key absolute left-3.5 top-1/2 -translate-y-1/2 text-neutral-400 text-sm" />
                            <input
                              type={showPasswords.new ? "text" : "password"}
                              className={`w-full pl-10 pr-10 py-3 border rounded-xl focus:ring-2 focus:ring-neutral-900 focus:border-transparent transition-shadow ${
                                newPassword && passwordErrors.length > 0
                                  ? "border-red-300 bg-red-50"
                                  : newPassword && passwordErrors.length === 0
                                  ? "border-emerald-300 bg-emerald-50"
                                  : "border-neutral-200 bg-white"
                              }`}
                              placeholder="Enter your new password"
                              value={newPassword}
                              onChange={(e) => handleNewPasswordChange(e.target.value)}
                              disabled={saving === "password"}
                            />
                            <button
                              type="button"
                              onClick={() => setShowPasswords({ ...showPasswords, new: !showPasswords.new })}
                              className="absolute right-3 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-neutral-600"
                            >
                              <i className={`fas ${showPasswords.new ? "fa-eye-slash" : "fa-eye"}`} />
                            </button>
                          </div>
                          {newPassword && (
                            <div className="mt-2.5 bg-neutral-50 rounded-xl p-3 border border-neutral-100">
                              <p className="text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-2">Password Requirements</p>
                              <ul className="text-xs space-y-1.5">
                                <li className={`flex items-center gap-2 ${newPassword.length >= 8 ? "text-emerald-600" : "text-neutral-400"}`}>
                                  <i className={`fas ${newPassword.length >= 8 ? "fa-check-circle" : "fa-circle"} text-xs`} />
                                  At least 8 characters
                                </li>
                                <li className={`flex items-center gap-2 ${/[A-Z]/.test(newPassword) ? "text-emerald-600" : "text-neutral-400"}`}>
                                  <i className={`fas ${/[A-Z]/.test(newPassword) ? "fa-check-circle" : "fa-circle"} text-xs`} />
                                  One uppercase letter
                                </li>
                                <li className={`flex items-center gap-2 ${/[a-z]/.test(newPassword) ? "text-emerald-600" : "text-neutral-400"}`}>
                                  <i className={`fas ${/[a-z]/.test(newPassword) ? "fa-check-circle" : "fa-circle"} text-xs`} />
                                  One lowercase letter
                                </li>
                                <li className={`flex items-center gap-2 ${/[0-9]/.test(newPassword) ? "text-emerald-600" : "text-neutral-400"}`}>
                                  <i className={`fas ${/[0-9]/.test(newPassword) ? "fa-check-circle" : "fa-circle"} text-xs`} />
                                  One number
                                </li>
                                <li className={`flex items-center gap-2 ${/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(newPassword) ? "text-emerald-600" : "text-neutral-400"}`}>
                                  <i className={`fas ${/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(newPassword) ? "fa-check-circle" : "fa-circle"} text-xs`} />
                                  One special character (!@#$%^&*...)
                                </li>
                              </ul>
                            </div>
                          )}
                        </div>
                        
                        <div>
                          <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-2">
                            Confirm New Password
                          </label>
                          <div className="relative">
                            <i className="fas fa-lock absolute left-3.5 top-1/2 -translate-y-1/2 text-neutral-400 text-sm" />
                            <input
                              type={showPasswords.confirm ? "text" : "password"}
                              className={`w-full pl-10 pr-10 py-3 border rounded-xl focus:ring-2 focus:ring-neutral-900 focus:border-transparent transition-shadow ${
                                confirmPassword && newPassword && confirmPassword !== newPassword
                                  ? "border-red-300 bg-red-50"
                                  : confirmPassword && confirmPassword === newPassword && newPassword.length > 0
                                  ? "border-emerald-300 bg-emerald-50"
                                  : "border-neutral-200 bg-white"
                              }`}
                              placeholder="Confirm your new password"
                              value={confirmPassword}
                              onChange={(e) => setConfirmPassword(e.target.value)}
                              disabled={saving === "password"}
                            />
                            <button
                              type="button"
                              onClick={() => setShowPasswords({ ...showPasswords, confirm: !showPasswords.confirm })}
                              className="absolute right-3 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-neutral-600"
                            >
                              <i className={`fas ${showPasswords.confirm ? "fa-eye-slash" : "fa-eye"}`} />
                            </button>
                          </div>
                          {confirmPassword && newPassword && confirmPassword !== newPassword && (
                            <p className="mt-1.5 text-xs text-red-600 flex items-center gap-1">
                              <i className="fas fa-exclamation-circle" />
                              Passwords do not match
                            </p>
                          )}
                          {confirmPassword && confirmPassword === newPassword && newPassword.length > 0 && passwordErrors.length === 0 && (
                            <p className="mt-1.5 text-xs text-emerald-600 flex items-center gap-1">
                              <i className="fas fa-check-circle" />
                              Passwords match
                            </p>
                          )}
                        </div>
                      </div>
                      
                      <div className="mt-5 flex justify-end">
                        <button 
                          onClick={handleChangePassword}
                          disabled={saving === "password"}
                          className="px-6 py-2.5 bg-neutral-900 text-white rounded-xl font-semibold hover:bg-neutral-800 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 transition-colors shadow-sm"
                        >
                          {saving === "password" ? (
                            <>
                              <i className="fas fa-spinner fa-spin" />
                              Changing Password...
                            </>
                          ) : (
                            <>
                              <i className="fas fa-key" />
                              Change Password
                            </>
                          )}
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Terms and Conditions */}
                  <div className="bg-white border border-neutral-200 rounded-2xl overflow-hidden">
                    <div className="flex items-center gap-3 px-6 py-4 border-b border-neutral-100 bg-neutral-50/50">
                      <div className="w-9 h-9 rounded-xl bg-neutral-900 flex items-center justify-center">
                        <i className="fas fa-file-contract text-sm text-amber-400" />
                      </div>
                      <div>
                        <h2 className="text-base font-bold text-neutral-900">Terms & Conditions</h2>
                        <p className="text-xs text-neutral-500">Set your service terms that customers must agree to</p>
                      </div>
                    </div>
                    <div className="p-6">
                      <div className="space-y-4">
                        <div>
                          <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-2">
                            Terms & Conditions Text
                          </label>
                          <textarea 
                            rows={8} 
                            className="w-full px-4 py-3 border border-neutral-200 rounded-xl focus:ring-2 focus:ring-neutral-900 focus:border-transparent text-sm bg-white transition-shadow"
                            placeholder="Enter your workshop's terms and conditions here...

Example:
• Cancellations must be made at least 24 hours in advance
• Late arrivals may result in rescheduled service
• A deposit may be required for major repairs
• We reserve the right to refuse service
• All prices are subject to change without notice"
                            value={termsAndConditions}
                            onChange={(e) => setTermsAndConditions(e.target.value)}
                          />
                          <p className="mt-2 text-xs text-neutral-400 flex items-center gap-1">
                            <i className="fas fa-info-circle" />
                            These terms will be shown to customers during the booking process
                          </p>
                        </div>
                        
                        {termsAndConditions && (
                          <div className="bg-neutral-50 border border-neutral-200 rounded-xl p-4">
                            <h4 className="text-xs font-bold text-neutral-500 uppercase tracking-wider mb-2 flex items-center gap-2">
                              <i className="fas fa-eye" />
                              Preview
                            </h4>
                            <div className="text-sm text-neutral-700 whitespace-pre-wrap max-h-40 overflow-y-auto">
                              {termsAndConditions}
                            </div>
                          </div>
                        )}
                      </div>
                      
                      <div className="mt-5 flex justify-end">
                        <button 
                          onClick={handleSaveTerms}
                          disabled={saving === "terms"}
                          className="px-6 py-2.5 bg-neutral-900 text-white rounded-xl font-semibold hover:bg-neutral-800 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 transition-colors shadow-sm"
                        >
                          {saving === "terms" ? (
                            <>
                              <i className="fas fa-spinner fa-spin" />
                              Saving...
                            </>
                          ) : (
                            <>
                              <i className="fas fa-save" />
                              Save Terms
                            </>
                          )}
                        </button>
                      </div>
                    </div>
                  </div>

                </section>

                <aside className="space-y-6">
                  {/* Account Info Card */}
                  <div className="bg-white border border-neutral-200 rounded-2xl overflow-hidden shadow-sm">
                    {/* Card Header */}
                    <div className="relative p-5 pb-4 border-b border-neutral-100 bg-neutral-50">
                      <div className="relative flex items-center gap-3">
                        {logoUrl ? (
                          <div className="w-14 h-14 rounded-2xl border-2 border-neutral-200 overflow-hidden bg-neutral-100">
                            <img src={logoUrl} alt="Workshop Logo" className="w-full h-full object-cover" />
                          </div>
                        ) : (
                          <div className="w-14 h-14 rounded-2xl bg-neutral-900 text-white flex items-center justify-center font-bold text-lg">
                            {salonName ? salonName.slice(0, 2).toUpperCase() : "WS"}
                          </div>
                        )}
                        <div>
                          <h3 className="font-bold text-neutral-900 text-base">{salonName || "Your Workshop"}</h3>
                          <p className="text-xs text-neutral-500">{userData.email}</p>
                        </div>
                      </div>
                    </div>
                    {/* Card Body */}
                    <div className="p-5 space-y-0">
                      <div className="flex items-center justify-between py-2.5 border-b border-neutral-100">
                        <span className="text-sm text-neutral-500 flex items-center gap-2">
                          <i className="fas fa-user-gear text-xs text-neutral-400" />
                          Role
                        </span>
                        <span className="px-2.5 py-1 bg-neutral-900 text-white rounded-lg text-xs font-semibold">Workshop Owner</span>
                      </div>
                      {abn && (
                        <div className="flex items-center justify-between py-2.5 border-b border-neutral-100">
                          <span className="text-sm text-neutral-500 flex items-center gap-2">
                            <i className="fas fa-hashtag text-xs text-neutral-400" />
                            ABN
                          </span>
                          <span className="text-sm text-neutral-800 font-mono font-medium">{abn}</span>
                        </div>
                      )}
                      {phone && (
                        <div className="flex items-center justify-between py-2.5 border-b border-neutral-100">
                          <span className="text-sm text-neutral-500 flex items-center gap-2">
                            <i className="fas fa-phone text-xs text-neutral-400" />
                            Phone
                          </span>
                          <span className="text-sm text-neutral-800">{phone}</span>
                        </div>
                      )}
                      {address && (
                        <div className="py-2.5 border-b border-neutral-100">
                          <span className="text-sm text-neutral-500 flex items-center gap-2 mb-1">
                            <i className="fas fa-location-dot text-xs text-neutral-400" />
                            Address
                          </span>
                          <span className="text-sm text-neutral-800 block pl-5">{address}</span>
                        </div>
                      )}
                      {userData.businessStructure && (
                        <div className="flex items-center justify-between py-2.5 border-b border-neutral-100">
                          <span className="text-sm text-neutral-500 flex items-center gap-2">
                            <i className="fas fa-sitemap text-xs text-neutral-400" />
                            Structure
                          </span>
                          <span className="text-sm text-neutral-800">{userData.businessStructure}</span>
                        </div>
                      )}
                      {userData.state && (
                        <div className="flex items-center justify-between py-2.5 border-b border-neutral-100">
                          <span className="text-sm text-neutral-500 flex items-center gap-2">
                            <i className="fas fa-map text-xs text-neutral-400" />
                            State
                          </span>
                          <span className="text-sm text-neutral-800 font-medium">{userData.state}</span>
                        </div>
                      )}
                      <div className="flex items-center justify-between py-2.5 border-b border-neutral-100">
                        <span className="text-sm text-neutral-500 flex items-center gap-2">
                          <i className="fas fa-globe text-xs text-neutral-400" />
                          Time Zone
                        </span>
                        <span className="text-xs text-neutral-800">{timezone || "Australia/Sydney"}</span>
                      </div>
                      <div className="flex items-center justify-between py-2.5 border-b border-neutral-100">
                        <span className="text-sm text-neutral-500 flex items-center gap-2">
                          <i className="fas fa-receipt text-xs text-neutral-400" />
                          GST Registered
                        </span>
                        <span className={`px-2.5 py-1 rounded-lg text-xs font-semibold ${userData.gstRegistered ? 'bg-emerald-100 text-emerald-700' : 'bg-neutral-100 text-neutral-500'}`}>
                          {userData.gstRegistered ? 'Yes' : 'No'}
                        </span>
                      </div>
                      {userData.plan && (
                        <div className="flex items-center justify-between py-2.5">
                          <span className="text-sm text-neutral-500 flex items-center gap-2">
                            <i className="fas fa-box text-xs text-neutral-400" />
                            Plan
                          </span>
                          <span className="px-2.5 py-1 bg-emerald-100 text-emerald-700 rounded-lg text-xs font-semibold">
                            {userData.plan} {userData.price ? `(${userData.price})` : ""}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Booking Engine URL */}
                  {userData.bookingEngineUrl && (
                    <div className="bg-white border border-neutral-200 rounded-2xl overflow-hidden">
                      <div className="flex items-center gap-3 px-5 py-3.5 border-b border-neutral-100 bg-neutral-50/50">
                        <div className="w-8 h-8 rounded-lg bg-neutral-900 flex items-center justify-center">
                          <i className="fas fa-link text-xs text-amber-400" />
                        </div>
                        <h3 className="text-sm font-bold text-neutral-900">Online Booking Link</h3>
                      </div>
                      <div className="p-5">
                        <p className="text-xs text-neutral-500 mb-3">Share this link with your customers so they can book online.</p>
                        <div className="flex items-center gap-2">
                          <div className="flex-1 bg-neutral-50 border border-neutral-200 rounded-xl px-3.5 py-2.5 text-sm text-neutral-700 font-mono truncate select-all">
                            {userData.bookingEngineUrl}
                          </div>
                          <button
                            onClick={() => {
                              navigator.clipboard.writeText(userData.bookingEngineUrl || "");
                              showToast("Booking link copied!");
                            }}
                            className="flex-shrink-0 w-10 h-10 bg-neutral-900 hover:bg-neutral-800 text-white rounded-xl flex items-center justify-center transition-colors"
                            title="Copy to clipboard"
                          >
                            <i className="fas fa-copy text-sm" />
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Branding - Logo Upload */}
                  <div className="bg-white border border-neutral-200 rounded-2xl overflow-hidden">
                    <div className="flex items-center gap-3 px-5 py-3.5 border-b border-neutral-100 bg-neutral-50/50">
                      <div className="w-8 h-8 rounded-lg bg-neutral-900 flex items-center justify-center">
                        <i className="fas fa-image text-xs text-amber-400" />
                      </div>
                      <h3 className="text-sm font-bold text-neutral-900">Workshop Logo</h3>
                    </div>
                    <div className="p-5">
                      <div>
                        <input
                          ref={logoInputRef}
                          type="file"
                          accept="image/png,image/jpeg,image/jpg,image/svg+xml,image/webp"
                          className="hidden"
                          onChange={handleLogoUpload}
                          disabled={uploadingLogo}
                        />
                        
                        {logoUrl ? (
                          <div className="space-y-3">
                            <div className="relative w-full h-32 rounded-xl border border-neutral-200 overflow-hidden bg-neutral-50">
                              <img 
                                src={logoUrl} 
                                alt="Workshop Logo" 
                                className="w-full h-full object-contain p-2"
                              />
                            </div>
                            <div className="flex gap-2">
                              <button
                                onClick={() => logoInputRef.current?.click()}
                                disabled={uploadingLogo}
                                className="flex-1 px-4 py-2.5 border border-neutral-200 rounded-xl text-sm font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 transition-colors"
                              >
                                {uploadingLogo ? (
                                  <>
                                    <i className="fas fa-spinner fa-spin" />
                                    Uploading...
                                  </>
                                ) : (
                                  <>
                                    <i className="fas fa-sync-alt" />
                                    Change
                                  </>
                                )}
                              </button>
                              <button
                                onClick={handleRemoveLogo}
                                disabled={uploadingLogo}
                                className="px-4 py-2.5 border border-red-200 rounded-xl text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                              >
                                <i className="fas fa-trash" />
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div 
                            onClick={() => !uploadingLogo && logoInputRef.current?.click()}
                            className={`flex flex-col items-center justify-center border-2 border-dashed rounded-xl h-32 transition cursor-pointer ${
                              uploadingLogo 
                                ? 'border-amber-300 bg-amber-50' 
                                : 'border-neutral-300 hover:border-neutral-900 hover:bg-neutral-50'
                            }`}
                          >
                            {uploadingLogo ? (
                              <div className="text-center text-amber-600">
                                <i className="fas fa-spinner fa-spin text-2xl mb-2" />
                                <p className="text-sm font-medium">Uploading...</p>
                              </div>
                            ) : (
                              <div className="text-center text-neutral-500">
                                <i className="fas fa-cloud-upload-alt text-2xl mb-2" />
                                <p className="text-sm font-medium">Click to upload logo</p>
                                <p className="text-xs text-neutral-400 mt-1">PNG, JPG, SVG or WebP (max 5MB)</p>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </aside>
              </div>
            </>
          )}
        </main>
      </div>

      {/* Remove Logo Confirmation Modal */}
      {showRemoveLogoModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setShowRemoveLogoModal(false)} />
          <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden animate-slide-in">
            {/* Header */}
            <div className="bg-neutral-900 p-5">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-xl bg-red-500/20 border border-red-500/30 flex items-center justify-center">
                  <i className="fas fa-trash-alt text-red-400 text-xl" />
                </div>
                <div>
                  <h3 className="font-bold text-white text-lg">Remove Logo</h3>
                  <p className="text-neutral-400 text-sm">This action cannot be undone</p>
                </div>
              </div>
            </div>
            
            {/* Content */}
            <div className="p-6">
              <div className="flex items-center gap-4 mb-4">
                {logoUrl && (
                  <div className="w-16 h-16 rounded-xl border-2 border-neutral-200 overflow-hidden bg-neutral-50 flex-shrink-0">
                    <img src={logoUrl} alt="Current Logo" className="w-full h-full object-contain p-1" />
                  </div>
                )}
                <p className="text-neutral-600">
                  Are you sure you want to remove your workshop logo? Your profile will display default initials instead.
                </p>
              </div>
              
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm text-amber-800 flex items-start gap-2">
                <i className="fas fa-exclamation-triangle mt-0.5" />
                <span>This will remove the logo from your profile and all public-facing pages.</span>
              </div>
            </div>
            
            {/* Actions */}
            <div className="px-6 pb-6 flex items-center justify-end gap-3">
              <button
                onClick={() => setShowRemoveLogoModal(false)}
                className="px-5 py-2.5 rounded-xl border border-neutral-300 text-neutral-700 font-medium hover:bg-neutral-50 transition"
              >
                Cancel
              </button>
              <button
                onClick={confirmRemoveLogo}
                className="px-5 py-2.5 rounded-xl bg-red-600 text-white font-semibold hover:bg-red-700 transition flex items-center gap-2"
              >
                <i className="fas fa-trash-alt" />
                Remove Logo
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast notifications */}
      <div className="fixed bottom-5 right-5 z-50 space-y-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`bg-neutral-900 text-white px-4 py-3 rounded-xl shadow-lg border-l-4 flex items-center gap-2 animate-slide-in ${
              t.type === 'error' ? 'border-red-500' : 'border-amber-500'
            }`}
          >
            <i className={`fas ${t.type === 'error' ? 'fa-circle-xmark text-red-400' : 'fa-circle-check text-amber-400'}`} />
            <span className="text-sm">{t.message}</span>
          </div>
        ))}
      </div>

      <style>{`
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
        .animate-slide-in {
          animation: slide-in 0.3s ease-out;
        }
      `}</style>
    </div>
  );
}
