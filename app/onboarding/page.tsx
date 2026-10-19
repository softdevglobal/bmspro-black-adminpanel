"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export default function OnboardingReferencePage() {
  const [reference, setReference] = useState("");
  const router = useRouter();
  const valid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(reference.trim());
  return <main className="min-h-screen bg-slate-50 px-5 py-16 text-slate-900"><div className="mx-auto max-w-lg rounded-2xl bg-white p-8 shadow-sm">
    <p className="text-sm font-semibold text-slate-500">BMS PRO BLACK</p><h1 className="mt-3 text-3xl font-semibold">Review your workshop setup</h1>
    <p className="mt-4 text-slate-600">Enter the setup reference from your onboarding call. You will sign in and verify your email before viewing any business details.</p>
    <form className="mt-6 space-y-4" onSubmit={event => { event.preventDefault(); if (valid) router.push(`/onboarding/${reference.trim()}`); }}>
      <label className="block text-sm font-medium" htmlFor="reference">Setup reference</label>
      <input id="reference" value={reference} onChange={event => setReference(event.target.value)} className="w-full rounded-lg border p-3" autoComplete="off" required />
      <button disabled={!valid} className="w-full rounded-lg bg-slate-900 p-3 text-white disabled:opacity-40">Continue</button>
    </form>
  </div></main>;
}
