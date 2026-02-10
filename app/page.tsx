"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { onAuthStateChanged } from "firebase/auth";
import { auth, db } from "@/lib/firebase";
import { doc, getDoc } from "firebase/firestore";

export default function Home() {
  const router = useRouter();

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        router.replace("/login");
        return;
      }
      
      try {
        // Check super_admins collection first
        const superAdminSnap = await getDoc(doc(db, "super_admins", user.uid));
        let role: string;
        
        if (superAdminSnap.exists()) {
          router.replace("/admin-dashboard");
        } else {
          // Check users collection
          const snap = await getDoc(doc(db, "users", user.uid));
          const role = snap.data()?.role || "";
          
          if (role === "salon_branch_admin") {
            router.replace("/branches");
          } else {
            router.replace("/dashboard");
          }
        }
      } catch {
        router.replace("/dashboard");
      }
    });

    return () => unsub();
  }, [router]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-white">
      <div className="text-center">
        <div className="inline-block w-12 h-12 border-4 border-pink-500 border-t-transparent rounded-full animate-spin" />
        <p className="mt-4 text-slate-600">Loading...</p>
      </div>
    </div>
  );
}
