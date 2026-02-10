"use client";

import { useState } from "react";
import { createUserWithEmailAndPassword, signInWithEmailAndPassword } from "firebase/auth";
import { doc, setDoc } from "firebase/firestore";
import { auth, db } from "@/lib/firebase";

export default function SetupPage() {
  const [status, setStatus] = useState<string>("Ready to create super admin");
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string>("");
  const [useClientSide, setUseClientSide] = useState(true); // Default to client-side since Admin SDK needs configuration

  const EMAIL = "bmspro@black.com";
  const PASSWORD = "admin@119";
  const DISPLAY_NAME = "Super Admin";

  // Method 1: Server-side API (requires properly configured Firebase Admin SDK)
  const createViaAPI = async () => {
    setLoading(true);
    setStatus("Creating super admin via server API...");
    setError("");

    try {
      const response = await fetch("/api/setup/create-super-admin", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: EMAIL,
          password: PASSWORD,
          displayName: DISPLAY_NAME,
          secretKey: "dev-setup-key-allow",
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        if (response.status === 409) {
          setStatus("Super Admin already exists! You can login.");
          setSuccess(true);
          return;
        }
        throw new Error(data.error || data.hint || "Failed to create super admin");
      }

      setStatus("Super Admin created successfully!");
      setSuccess(true);
    } catch (err: any) {
      console.error("API Error:", err);
      setError(err.message || "Unknown error");
      setStatus("Failed - Try client-side method below");
    } finally {
      setLoading(false);
    }
  };

  // Method 2: Client-side (requires temporary Firestore rule allowing super_admins writes)
  const createViaClient = async () => {
    setLoading(true);
    setStatus("Creating super admin via client...");
    setError("");

    try {
      let userUid: string;

      // Step 1: Create or sign in Firebase Auth user
      try {
        setStatus("Step 1/2: Creating Firebase Auth user...");
        const cred = await createUserWithEmailAndPassword(auth, EMAIL, PASSWORD);
        userUid = cred.user.uid;
        setStatus(`Auth user created! UID: ${userUid}`);
      } catch (createError: any) {
        if (createError.code === "auth/email-already-in-use") {
          setStatus("User exists, signing in...");
          const cred = await signInWithEmailAndPassword(auth, EMAIL, PASSWORD);
          userUid = cred.user.uid;
          setStatus(`Signed in! UID: ${userUid}`);
        } else {
          throw createError;
        }
      }

      // Small delay to ensure auth state is fully propagated
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Step 2: Create Firestore document (use merge to handle existing docs)
      setStatus("Step 2/2: Creating super_admins document...");
      const docRef = doc(db, "super_admins", userUid);
      
      await setDoc(docRef, {
        uid: userUid,
        email: EMAIL,
        displayName: DISPLAY_NAME,
        role: "super_admin",
        provider: "password",
        createdAt: new Date(),
        updatedAt: new Date(),
      }, { merge: true }); // merge: true prevents errors if doc exists

      setStatus("Super Admin created successfully!");
      setSuccess(true);
    } catch (err: any) {
      console.error("Client Error:", err);
      
      // Provide specific error messages
      if (err.code === "permission-denied") {
        setError("Permission denied. Please update Firestore rules (see instructions above) and make sure rules are published.");
      } else if (err.message?.includes("offline")) {
        setError("Firestore connection issue. Please check: 1) Internet connection, 2) Firebase Console - Firestore database exists, 3) Database name matches 'bmspro-blackdb'");
      } else {
        setError(err.message || "Unknown error");
      }
      setStatus("Failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-neutral-50 to-neutral-100 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl p-8 max-w-lg w-full">
        <h1 className="text-2xl font-bold text-neutral-900 mb-2">Super Admin Setup</h1>
        <p className="text-neutral-500 text-sm mb-6">Create the initial super admin account</p>
        
        <div className="bg-neutral-50 rounded-xl p-4 mb-6">
          <p className="text-sm text-neutral-600"><strong>Email:</strong> {EMAIL}</p>
          <p className="text-sm text-neutral-600"><strong>Password:</strong> {PASSWORD}</p>
        </div>

        {/* Status Display */}
        {loading && (
          <div className="flex flex-col items-center py-6 mb-4">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-neutral-900 mb-4"></div>
            <p className="text-neutral-600 text-sm">{status}</p>
          </div>
        )}

        {/* Success State */}
        {success && (
          <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-6 text-center">
            <div className="w-16 h-16 bg-emerald-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg className="w-8 h-8 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <p className="text-emerald-700 font-semibold text-lg mb-4">Super Admin Created!</p>
            <div className="bg-white rounded-lg p-4 text-left mb-4 border border-emerald-100">
              <p className="text-sm text-neutral-700"><strong>Email:</strong> {EMAIL}</p>
              <p className="text-sm text-neutral-700"><strong>Password:</strong> {PASSWORD}</p>
            </div>
            <a 
              href="/login" 
              className="inline-block w-full py-3 px-6 bg-emerald-500 text-white font-semibold rounded-xl hover:bg-emerald-600 transition-colors text-center"
            >
              Go to Login
            </a>
          </div>
        )}

        {/* Error Display */}
        {error && !loading && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-4 mb-4">
            <p className="text-red-700 font-semibold mb-2">Error</p>
            <p className="text-red-600 text-sm">{error}</p>
          </div>
        )}

        {/* Action Buttons */}
        {!success && !loading && (
          <div className="space-y-4">
            {!useClientSide ? (
              <>
                <button
                  onClick={createViaAPI}
                  className="w-full py-3 px-6 bg-neutral-900 text-white font-semibold rounded-xl hover:bg-neutral-800 transition-colors"
                >
                  Create Super Admin (Server API)
                </button>
                <button
                  onClick={() => setUseClientSide(true)}
                  className="w-full py-2 px-4 text-neutral-600 text-sm hover:text-neutral-800 transition-colors"
                >
                  Having issues? Try client-side method →
                </button>
              </>
            ) : (
              <>
                <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 mb-4">
                  <p className="text-blue-800 font-semibold text-sm mb-2">📋 Before clicking, update Firestore rules:</p>
                  <p className="text-blue-700 text-xs mb-2">
                    In Firebase Console → Firestore → Rules, find <code className="bg-blue-100 px-1">super_admins</code> and change to:
                  </p>
                  <code className="block bg-neutral-800 text-green-400 p-3 rounded text-xs mb-2 overflow-x-auto">
                    {`match /super_admins/{adminId} {`}<br/>
                    {`  allow read: if request.auth != null;`}<br/>
                    {`  allow create: if request.auth != null && adminId == request.auth.uid;`}<br/>
                    {`  allow update, delete: if false;`}<br/>
                    {`}`}
                  </code>
                  <p className="text-blue-700 text-xs">
                    ✅ Publish rules, then click the button below. After success, revert to <code className="bg-blue-100 px-1">allow create: if false;</code>
                  </p>
                </div>
                <button
                  onClick={createViaClient}
                  className="w-full py-3 px-6 bg-neutral-900 text-white font-semibold rounded-xl hover:bg-neutral-800 transition-colors"
                >
                  Create Super Admin
                </button>
                <button
                  onClick={() => setUseClientSide(false)}
                  className="w-full py-2 px-4 text-neutral-600 text-sm hover:text-neutral-800 transition-colors"
                >
                  Use Server API method instead →
                </button>
              </>
            )}
          </div>
        )}

        {/* Status Message */}
        {!loading && !success && status !== "Ready to create super admin" && (
          <p className="text-center text-neutral-500 text-sm mt-4">{status}</p>
        )}
      </div>
    </div>
  );
}
