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
        if (role !== "salon_owner") {
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
          userData.name || userData.email || "Salon Owner", // userName
          {
            uid: userData.uid,
            name: userData.name || userData.email || "Salon Owner",
            role: userData.role || "salon_owner",
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
          userData.name || userData.email || "Salon Owner", // userName
          {
            uid: userData.uid,
            name: userData.name || userData.email || "Salon Owner",
            role: userData.role || "salon_owner",
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
        const userRole = userData.role || "salon_owner";
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

          {loading ? (
            <div className="flex items-center justify-center h-64">
              <div className="flex flex-col items-center gap-3">
                <i className="fas fa-circle-notch fa-spin text-4xl text-pink-500" />
                <p className="text-slate-500 font-medium">Loading settings...</p>
              </div>
            </div>
          ) : mounted && userData && (
            <>
              <div className="mb-8">
                <div className="rounded-2xl bg-gradient-to-r from-pink-500 via-fuchsia-600 to-indigo-600 text-white p-6 shadow-sm">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-xl bg-white/20 flex items-center justify-center">
                        <i className="fas fa-cog" />
                      </div>
                      <div>
                        <h1 className="text-2xl font-bold">Salon Settings</h1>
                        <p className="text-sm text-white/80 mt-1">Business profile, branding, booking rules, notifications</p>
                      </div>
                    </div>
                    <div className="hidden sm:flex items-center gap-2 bg-white/20 px-3 py-1.5 rounded-full">
                      <i className="fas fa-user-tie text-sm" />
                      <span className="text-sm font-medium">{userData.email}</span>
                    </div>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <section className="lg:col-span-2 space-y-6">
                  {/* Business Profile */}
                  <div className="bg-white border border-slate-200 rounded-2xl p-6">
                    <h2 className="text-lg font-semibold text-slate-900 mb-4">Business Profile</h2>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-slate-700 mb-2">Salon Name</label>
                        <input 
                          className="w-full px-4 py-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-pink-500 focus:border-transparent" 
                          placeholder="Your Salon Name"
                          value={salonName}
                          onChange={(e) => setSalonName(e.target.value)}
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-slate-700 mb-2">ABN</label>
                        <input 
                          className="w-full px-4 py-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-pink-500 focus:border-transparent font-mono tracking-wide" 
                          placeholder="00 000 000 000"
                          maxLength={14}
                          value={abn}
                          onChange={(e) => setAbn(formatAbn(e.target.value))}
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-slate-700 mb-2">Phone</label>
                        <input 
                          className="w-full px-4 py-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-pink-500 focus:border-transparent" 
                          placeholder="+61 xxx xxx xxx"
                          value={phone}
                          onChange={(e) => setPhone(e.target.value)}
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-slate-700 mb-2">Email</label>
                        <input 
                          className="w-full px-4 py-3 border border-slate-300 rounded-lg bg-slate-50 text-slate-500 cursor-not-allowed" 
                          value={userData.email}
                          disabled
                          title="Email cannot be changed"
                        />
                      </div>
                      <div className="sm:col-span-2">
                        <label className="block text-sm font-medium text-slate-700 mb-2">Address</label>
                        <textarea 
                          rows={3} 
                          className="w-full px-4 py-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-pink-500 focus:border-transparent" 
                          placeholder="Street, City, Postcode"
                          value={address}
                          onChange={(e) => setAddress(e.target.value)}
                        />
                      </div>
                      <div className="sm:col-span-2">
                        <label className="block text-sm font-medium text-slate-700 mb-2">
                          <i className="fas fa-globe mr-2 text-slate-400" />
                          Time Zone
                        </label>
                        <div className="relative">
                          <select
                            value={timezone}
                            onChange={(e) => setTimezone(e.target.value)}
                            className="w-full px-4 py-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-pink-500 focus:border-transparent appearance-none pr-10"
                          >
                            {TIMEZONES.map((tz) => (
                              <option key={tz.value} value={tz.value}>
                                {tz.label}
                              </option>
                            ))}
                          </select>
                          <i className="fas fa-chevron-down absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
                        </div>
                        <p className="mt-1 text-xs text-slate-500">
                          <i className="fas fa-info-circle mr-1" />
                          This timezone will be used for all bookings and operations across your salon
                        </p>
                      </div>
                    </div>
                    <div className="mt-4 flex justify-end">
                      <button 
                        onClick={handleSaveProfile}
                        disabled={saving === "profile"}
                        className="px-5 py-2.5 bg-pink-600 text-white rounded-lg font-semibold hover:bg-pink-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
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

                  {/* Change Password */}
                  <div className="bg-white border border-slate-200 rounded-2xl p-6">
                    <div className="flex items-center gap-3 mb-4">
                      <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-rose-500 to-pink-600 text-white flex items-center justify-center">
                        <i className="fas fa-lock" />
                      </div>
                      <div>
                        <h2 className="text-lg font-semibold text-slate-900">Change Password</h2>
                        <p className="text-sm text-slate-500">Update your account password for better security</p>
                      </div>
                    </div>
                    
                    <div className="space-y-4">
                      <div>
                        <label className="block text-sm font-medium text-slate-700 mb-2">
                          Current Password
                        </label>
                        <div className="relative">
                          <input
                            type={showPasswords.current ? "text" : "password"}
                            className="w-full px-4 py-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-rose-500 focus:border-transparent pr-10"
                            placeholder="Enter your current password"
                            value={currentPassword}
                            onChange={(e) => setCurrentPassword(e.target.value)}
                            disabled={saving === "password"}
                          />
                          <button
                            type="button"
                            onClick={() => setShowPasswords({ ...showPasswords, current: !showPasswords.current })}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                          >
                            <i className={`fas ${showPasswords.current ? "fa-eye-slash" : "fa-eye"}`} />
                          </button>
                        </div>
                      </div>
                      
                      <div>
                        <label className="block text-sm font-medium text-slate-700 mb-2">
                          New Password
                        </label>
                        <div className="relative">
                          <input
                            type={showPasswords.new ? "text" : "password"}
                            className={`w-full px-4 py-3 border rounded-lg focus:ring-2 focus:ring-rose-500 focus:border-transparent pr-10 ${
                              newPassword && passwordErrors.length > 0
                                ? "border-red-300 bg-red-50"
                                : newPassword && passwordErrors.length === 0
                                ? "border-green-300 bg-green-50"
                                : "border-slate-300"
                            }`}
                            placeholder="Enter your new password"
                            value={newPassword}
                            onChange={(e) => handleNewPasswordChange(e.target.value)}
                            disabled={saving === "password"}
                          />
                          <button
                            type="button"
                            onClick={() => setShowPasswords({ ...showPasswords, new: !showPasswords.new })}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                          >
                            <i className={`fas ${showPasswords.new ? "fa-eye-slash" : "fa-eye"}`} />
                          </button>
                        </div>
                        {newPassword && (
                          <div className="mt-2">
                            <p className="text-xs font-medium text-slate-600 mb-1">Password must contain:</p>
                            <ul className="text-xs space-y-1">
                              <li className={`flex items-center gap-2 ${newPassword.length >= 8 ? "text-green-600" : "text-slate-500"}`}>
                                <i className={`fas ${newPassword.length >= 8 ? "fa-check-circle" : "fa-circle"} text-xs`} />
                                At least 8 characters
                              </li>
                              <li className={`flex items-center gap-2 ${/[A-Z]/.test(newPassword) ? "text-green-600" : "text-slate-500"}`}>
                                <i className={`fas ${/[A-Z]/.test(newPassword) ? "fa-check-circle" : "fa-circle"} text-xs`} />
                                One uppercase letter
                              </li>
                              <li className={`flex items-center gap-2 ${/[a-z]/.test(newPassword) ? "text-green-600" : "text-slate-500"}`}>
                                <i className={`fas ${/[a-z]/.test(newPassword) ? "fa-check-circle" : "fa-circle"} text-xs`} />
                                One lowercase letter
                              </li>
                              <li className={`flex items-center gap-2 ${/[0-9]/.test(newPassword) ? "text-green-600" : "text-slate-500"}`}>
                                <i className={`fas ${/[0-9]/.test(newPassword) ? "fa-check-circle" : "fa-circle"} text-xs`} />
                                One number
                              </li>
                              <li className={`flex items-center gap-2 ${/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(newPassword) ? "text-green-600" : "text-slate-500"}`}>
                                <i className={`fas ${/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(newPassword) ? "fa-check-circle" : "fa-circle"} text-xs`} />
                                One special character (!@#$%^&*...)
                              </li>
                            </ul>
                          </div>
                        )}
                      </div>
                      
                      <div>
                        <label className="block text-sm font-medium text-slate-700 mb-2">
                          Confirm New Password
                        </label>
                        <div className="relative">
                          <input
                            type={showPasswords.confirm ? "text" : "password"}
                            className={`w-full px-4 py-3 border rounded-lg focus:ring-2 focus:ring-rose-500 focus:border-transparent pr-10 ${
                              confirmPassword && newPassword && confirmPassword !== newPassword
                                ? "border-red-300 bg-red-50"
                                : confirmPassword && confirmPassword === newPassword && newPassword.length > 0
                                ? "border-green-300 bg-green-50"
                                : "border-slate-300"
                            }`}
                            placeholder="Confirm your new password"
                            value={confirmPassword}
                            onChange={(e) => setConfirmPassword(e.target.value)}
                            disabled={saving === "password"}
                          />
                          <button
                            type="button"
                            onClick={() => setShowPasswords({ ...showPasswords, confirm: !showPasswords.confirm })}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                          >
                            <i className={`fas ${showPasswords.confirm ? "fa-eye-slash" : "fa-eye"}`} />
                          </button>
                        </div>
                        {confirmPassword && newPassword && confirmPassword !== newPassword && (
                          <p className="mt-1 text-xs text-red-600 flex items-center gap-1">
                            <i className="fas fa-exclamation-circle" />
                            Passwords do not match
                          </p>
                        )}
                        {confirmPassword && confirmPassword === newPassword && newPassword.length > 0 && passwordErrors.length === 0 && (
                          <p className="mt-1 text-xs text-green-600 flex items-center gap-1">
                            <i className="fas fa-check-circle" />
                            Passwords match
                          </p>
                        )}
                      </div>
                    </div>
                    
                    <div className="mt-4 flex justify-end">
                      <button 
                        onClick={handleChangePassword}
                        disabled={saving === "password"}
                        className="px-5 py-2.5 bg-rose-600 text-white rounded-lg font-semibold hover:bg-rose-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
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

                  {/* Terms and Conditions */}
                  <div className="bg-white border border-slate-200 rounded-2xl p-6">
                    <div className="flex items-center gap-3 mb-4">
                      <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 text-white flex items-center justify-center">
                        <i className="fas fa-file-contract" />
                      </div>
                      <div>
                        <h2 className="text-lg font-semibold text-slate-900">Terms & Conditions</h2>
                        <p className="text-sm text-slate-500">Set your booking terms that customers must agree to</p>
                      </div>
                    </div>
                    
                    <div className="space-y-4">
                      <div>
                        <label className="block text-sm font-medium text-slate-700 mb-2">
                          Terms & Conditions Text
                        </label>
                        <textarea 
                          rows={8} 
                          className="w-full px-4 py-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent text-sm"
                          placeholder="Enter your salon's terms and conditions here...

Example:
• Cancellations must be made at least 24 hours in advance
• Late arrivals may result in shortened service time
• A deposit may be required for certain services
• We reserve the right to refuse service
• All prices are subject to change without notice"
                          value={termsAndConditions}
                          onChange={(e) => setTermsAndConditions(e.target.value)}
                        />
                        <p className="mt-2 text-xs text-slate-500">
                          <i className="fas fa-info-circle mr-1" />
                          These terms will be shown to customers during the booking process
                        </p>
                      </div>
                      
                      {termsAndConditions && (
                        <div className="bg-slate-50 border border-slate-200 rounded-xl p-4">
                          <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2 flex items-center gap-2">
                            <i className="fas fa-eye" />
                            Preview
                          </h4>
                          <div className="text-sm text-slate-700 whitespace-pre-wrap max-h-40 overflow-y-auto">
                            {termsAndConditions}
                          </div>
                        </div>
                      )}
                    </div>
                    
                    <div className="mt-4 flex justify-end">
                      <button 
                        onClick={handleSaveTerms}
                        disabled={saving === "terms"}
                        className="px-5 py-2.5 bg-indigo-600 text-white rounded-lg font-semibold hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
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

                </section>

                <aside className="space-y-6">
                  {/* Account Info Card */}
                  <div className="bg-gradient-to-br from-pink-50 to-purple-50 border border-pink-100 rounded-2xl p-6">
                    <div className="flex items-center gap-3 mb-4">
                      {logoUrl ? (
                        <div className="w-12 h-12 rounded-full border-2 border-pink-200 overflow-hidden bg-white">
                          <img src={logoUrl} alt="Salon Logo" className="w-full h-full object-cover" />
                        </div>
                      ) : (
                        <div className="w-12 h-12 rounded-full bg-gradient-to-br from-pink-500 to-purple-600 text-white flex items-center justify-center font-bold text-lg">
                          {salonName ? salonName.slice(0, 2).toUpperCase() : "SA"}
                        </div>
                      )}
                      <div>
                        <h3 className="font-semibold text-slate-900">{salonName || "Your Salon"}</h3>
                        <p className="text-xs text-slate-500">{userData.email}</p>
                      </div>
                    </div>
                    <div className="space-y-2 text-sm">
                      <div className="flex items-center justify-between py-2 border-b border-pink-100">
                        <span className="text-slate-600">Role</span>
                        <span className="px-2 py-0.5 bg-pink-100 text-pink-700 rounded-full text-xs font-medium">Salon Owner</span>
                      </div>
                      {abn && (
                        <div className="flex items-center justify-between py-2 border-b border-pink-100">
                          <span className="text-slate-600">ABN</span>
                          <span className="text-slate-800 font-medium">{abn}</span>
                        </div>
                      )}
                      {phone && (
                        <div className="flex items-center justify-between py-2 border-b border-pink-100">
                          <span className="text-slate-600">Phone</span>
                          <span className="text-slate-800">{phone}</span>
                        </div>
                      )}
                      {address && (
                        <div className="py-2 border-b border-pink-100">
                          <span className="text-slate-600 block mb-1">Address</span>
                          <span className="text-slate-800 text-xs">{address}</span>
                        </div>
                      )}
                      {userData.businessStructure && (
                        <div className="flex items-center justify-between py-2 border-b border-pink-100">
                          <span className="text-slate-600">Structure</span>
                          <span className="text-slate-800">{userData.businessStructure}</span>
                        </div>
                      )}
                      {userData.state && (
                        <div className="flex items-center justify-between py-2 border-b border-pink-100">
                          <span className="text-slate-600">State</span>
                          <span className="text-slate-800">{userData.state}</span>
                        </div>
                      )}
                      <div className="flex items-center justify-between py-2 border-b border-pink-100">
                        <span className="text-slate-600">
                          <i className="fas fa-globe mr-1 text-slate-400" />
                          Time Zone
                        </span>
                        <span className="text-slate-800 text-xs">{timezone || "Australia/Sydney"}</span>
                      </div>
                      <div className="flex items-center justify-between py-2 border-b border-pink-100">
                        <span className="text-slate-600">GST Registered</span>
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${userData.gstRegistered ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-600'}`}>
                          {userData.gstRegistered ? 'Yes' : 'No'}
                        </span>
                      </div>
                      {userData.plan && (
                        <div className="flex items-center justify-between py-2">
                          <span className="text-slate-600">Plan</span>
                          <span className="px-2 py-0.5 bg-emerald-100 text-emerald-700 rounded-full text-xs font-medium">
                            {userData.plan} {userData.price ? `(${userData.price})` : ""}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Branding - Logo Upload */}
                  <div className="bg-white border border-slate-200 rounded-2xl p-6">
                    <h3 className="text-base font-semibold text-slate-900 mb-4">Salon Logo</h3>
                    <div className="space-y-4">
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
                            <div className="relative w-full h-32 rounded-xl border border-slate-200 overflow-hidden bg-slate-50">
                              <img 
                                src={logoUrl} 
                                alt="Salon Logo" 
                                className="w-full h-full object-contain p-2"
                              />
                            </div>
                            <div className="flex gap-2">
                              <button
                                onClick={() => logoInputRef.current?.click()}
                                disabled={uploadingLogo}
                                className="flex-1 px-4 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                              >
                                {uploadingLogo ? (
                                  <>
                                    <i className="fas fa-spinner fa-spin" />
                                    Uploading...
                                  </>
                                ) : (
                                  <>
                                    <i className="fas fa-sync-alt" />
                                    Change Logo
                                  </>
                                )}
                              </button>
                              <button
                                onClick={handleRemoveLogo}
                                disabled={uploadingLogo}
                                className="px-4 py-2 border border-red-200 rounded-lg text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed"
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
                                ? 'border-pink-300 bg-pink-50' 
                                : 'border-slate-300 hover:border-pink-400 hover:bg-pink-50'
                            }`}
                          >
                            {uploadingLogo ? (
                              <div className="text-center text-pink-600">
                                <i className="fas fa-spinner fa-spin text-2xl mb-2" />
                                <p className="text-sm font-medium">Uploading...</p>
                              </div>
                            ) : (
                              <div className="text-center text-slate-500">
                                <i className="fas fa-cloud-upload-alt text-2xl mb-2" />
                                <p className="text-sm font-medium">Click to upload logo</p>
                                <p className="text-xs text-slate-400 mt-1">PNG, JPG, SVG or WebP (max 5MB)</p>
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
          <div className="absolute inset-0 bg-black/40" onClick={() => setShowRemoveLogoModal(false)} />
          <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden animate-slide-in">
            {/* Header */}
            <div className="bg-gradient-to-r from-rose-500 to-pink-600 p-5">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-xl bg-white/20 flex items-center justify-center">
                  <i className="fas fa-trash-alt text-white text-xl" />
                </div>
                <div>
                  <h3 className="font-bold text-white text-lg">Remove Logo</h3>
                  <p className="text-white/80 text-sm">This action cannot be undone</p>
                </div>
              </div>
            </div>
            
            {/* Content */}
            <div className="p-6">
              <div className="flex items-center gap-4 mb-4">
                {logoUrl && (
                  <div className="w-16 h-16 rounded-xl border-2 border-slate-200 overflow-hidden bg-slate-50 flex-shrink-0">
                    <img src={logoUrl} alt="Current Logo" className="w-full h-full object-contain p-1" />
                  </div>
                )}
                <p className="text-slate-600">
                  Are you sure you want to remove your salon logo? Your profile will display default initials instead.
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
                className="px-5 py-2.5 rounded-xl border border-slate-300 text-slate-700 font-medium hover:bg-slate-50 transition"
              >
                Cancel
              </button>
              <button
                onClick={confirmRemoveLogo}
                className="px-5 py-2.5 rounded-xl bg-rose-600 text-white font-semibold hover:bg-rose-700 transition flex items-center gap-2"
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
            className={`bg-slate-800 text-white px-4 py-3 rounded-lg shadow-lg border-l-4 flex items-center gap-2 animate-slide-in ${
              t.type === 'error' ? 'border-red-500' : 'border-pink-500'
            }`}
          >
            <i className={`fas ${t.type === 'error' ? 'fa-circle-xmark text-red-500' : 'fa-circle-check text-pink-500'}`} />
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
