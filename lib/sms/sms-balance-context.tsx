"use client";

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { auth } from "@/lib/firebase";
import { fetchCurrentUser } from "@/lib/authClient";
import { SMS_LOW_BALANCE_THRESHOLD } from "@/lib/sms-packages/balance";

type SmsBalanceState = {
  remaining: number | null;
  unlimited: boolean;
  isLow: boolean;
  loading: boolean;
  refresh: () => Promise<void>;
};

const SmsBalanceContext = createContext<SmsBalanceState | null>(null);

export function SmsBalanceProvider({
  children,
  enabled = true,
}: {
  children: React.ReactNode;
  enabled?: boolean;
}) {
  const [remaining, setRemaining] = useState<number | null>(null);
  const [unlimited, setUnlimited] = useState(false);
  const [loading, setLoading] = useState(true);
  const [isWorkshopOwner, setIsWorkshopOwner] = useState(false);

  const refresh = useCallback(async () => {
    if (!enabled || !isWorkshopOwner) {
      setLoading(false);
      return;
    }
    const user = auth.currentUser;
    if (!user) {
      setRemaining(null);
      setUnlimited(false);
      setLoading(false);
      return;
    }

    try {
      const token = await user.getIdToken();
      const res = await fetch("/api/business/sms", {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      const body = await res.json();
      if (res.ok && body.ok) {
        setRemaining(body.balance?.remaining ?? null);
        setUnlimited(!!body.balance?.unlimited);
      }
    } catch (error) {
      console.error("[SmsBalanceProvider]", error);
    } finally {
      setLoading(false);
    }
  }, [enabled, isWorkshopOwner]);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }

    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        setIsWorkshopOwner(false);
        setRemaining(null);
        setUnlimited(false);
        setLoading(false);
        return;
      }

      try {
        const me = await fetchCurrentUser();
        const owner = me?.role === "workshop_owner";
        setIsWorkshopOwner(owner);
        if (!owner) {
          setRemaining(null);
          setUnlimited(false);
          setLoading(false);
        }
      } catch {
        setIsWorkshopOwner(false);
        setLoading(false);
      }
    });

    return () => unsub();
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !isWorkshopOwner) return;
    void refresh();
    const interval = setInterval(() => void refresh(), 60_000);
    return () => clearInterval(interval);
  }, [enabled, isWorkshopOwner, refresh]);

  const value = useMemo(
    () => ({
      remaining,
      unlimited,
      isLow: !unlimited && remaining !== null && remaining < SMS_LOW_BALANCE_THRESHOLD,
      loading,
      refresh,
    }),
    [remaining, unlimited, loading, refresh],
  );

  return <SmsBalanceContext.Provider value={value}>{children}</SmsBalanceContext.Provider>;
}

export function useSmsBalance(): SmsBalanceState {
  const ctx = useContext(SmsBalanceContext);
  if (!ctx) {
    return {
      remaining: null,
      unlimited: false,
      isLow: false,
      loading: false,
      refresh: async () => {},
    };
  }
  return ctx;
}
