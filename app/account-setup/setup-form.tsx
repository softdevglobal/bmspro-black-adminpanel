"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { confirmPasswordReset, verifyPasswordResetCode } from "firebase/auth";
import { auth } from "@/lib/firebase";

export default function AccountSetupForm() {
  const codeRef = useRef<string | null>(null);
  const startedRef = useRef(false);
  const [ready, setReady] = useState(false);
  const [message, setMessage] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [complete, setComplete] = useState(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    const params = new URLSearchParams(window.location.hash.slice(1));
    const code = params.get("code");
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    if (!code) {
      setMessage("This password setup link is missing or has already been used. Request a new password link or contact support.");
      return;
    }
    void verifyPasswordResetCode(auth, code).then(() => {
      codeRef.current = code;
      setReady(true);
    }).catch(() => {
      setMessage("This password setup link is invalid or has expired. Request a new password link or contact support.");
    });
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    if (!codeRef.current) return setMessage("This password setup link is no longer available. Request a new link or contact support.");
    if (password.length < 8) return setMessage("Use a password with at least 8 characters.");
    if (password !== confirm) return setMessage("The passwords do not match.");
    setBusy(true);
    try {
      await confirmPasswordReset(auth, codeRef.current, password);
      codeRef.current = null;
      setComplete(true);
    } catch {
      setMessage("We could not set your password. The link may have expired or already been used. Request a new link or contact support.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-10 text-slate-900">
      <section className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-7 shadow-sm">
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-700">BMS Pro Black</p>
        <h1 className="mt-3 text-2xl font-bold">Set your account password</h1>
        {complete ? (
          <div className="mt-5 space-y-4">
            <p>Your password is set. Sign in to continue to your dashboard. You can add your services, prices, staff and schedules there before taking bookings.</p>
            <Link className="inline-flex rounded-lg bg-blue-700 px-4 py-2.5 font-semibold text-white" href="/login">Go to sign in</Link>
          </div>
        ) : (
          <form className="mt-5 space-y-4" onSubmit={submit}>
            {!ready && !message && <p className="text-sm text-slate-600">Checking your secure setup link…</p>}
            {ready && <>
              <label className="block text-sm font-medium">New password
                <input className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5" type="password" autoComplete="new-password" minLength={8} required value={password} onChange={event => setPassword(event.target.value)} />
              </label>
              <label className="block text-sm font-medium">Confirm password
                <input className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5" type="password" autoComplete="new-password" minLength={8} required value={confirm} onChange={event => setConfirm(event.target.value)} />
              </label>
              <button className="w-full rounded-lg bg-blue-700 px-4 py-2.5 font-semibold text-white disabled:opacity-60" disabled={busy} type="submit">{busy ? "Saving…" : "Set password"}</button>
            </>}
            {message && <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-950" role="alert">{message}</p>}
            <p className="text-sm text-slate-600">Already set your password? <Link className="font-semibold text-blue-700 underline" href="/login">Sign in</Link></p>
          </form>
        )}
      </section>
    </main>
  );
}
