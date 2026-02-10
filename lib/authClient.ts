import { auth } from "@/lib/firebase";

// ==================== CLIENT-SIDE AUTH HELPERS ====================

export interface AuthMeResponse {
  uid: string;
  role: string;
  email: string;
  displayName: string;
  isSuperAdmin: boolean;
  suspended?: boolean;
  status?: string;
  ownerUid?: string;
  accountStatus?: string;
  subscriptionStatus?: string;
  stripeSubscriptionId?: string | null;
  trial_end?: any;
  trialDays?: number;
  plan?: string | null;
  price?: string | null;
  planId?: string | null;
  plan_key?: string | null;
  salonName?: string;
}

/**
 * Fetch the current user's role and profile from the server API.
 * Uses Firebase Admin SDK on the server, bypassing Firestore rules.
 * 
 * Safe to use in client components — no server-only imports.
 * 
 * Returns null if not authenticated or request fails.
 */
export async function fetchCurrentUser(): Promise<AuthMeResponse | null> {
  try {
    const user = auth.currentUser;
    if (!user) return null;

    const token = await user.getIdToken();
    
    const res = await fetch("/api/auth/me", {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!res.ok) return null;

    const data: AuthMeResponse = await res.json();
    
    // Cache in localStorage for instant renders
    if (typeof window !== "undefined") {
      localStorage.setItem("role", data.role);
      if (data.displayName) localStorage.setItem("userName", data.displayName);
    }

    return data;
  } catch (err) {
    console.warn("[fetchCurrentUser] Failed:", err);
    return null;
  }
}
