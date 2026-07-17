"use client";

import { auth } from "@/lib/firebase";
import { onAuthStateChanged, type User } from "firebase/auth";
import { useEffect, useState } from "react";

export function useAuthUser(): { user: User | null; ready: boolean } {
  const [user, setUser] = useState<User | null>(auth.currentUser);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (nextUser) => {
      setUser(nextUser);
      setReady(true);
    });
    return () => unsub();
  }, []);

  return { user, ready };
}

export async function authFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const user = auth.currentUser;
  if (!user) return { ok: false, error: "Please sign in again." };
  const token = await user.getIdToken();
  const res = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(options.headers ?? {}),
    },
    cache: "no-store",
  });
  const text = await res.text();
  let body: (T & { ok?: boolean; error?: string }) | null = null;
  if (text.trim()) {
    try {
      body = JSON.parse(text) as T & { ok?: boolean; error?: string };
    } catch {
      return { ok: false, error: "Invalid response from server." };
    }
  }
  if (!res.ok || !body || body.ok === false) {
    return { ok: false, error: body?.error ?? `Request failed (${res.status}).` };
  }
  return { ok: true, data: body };
}
