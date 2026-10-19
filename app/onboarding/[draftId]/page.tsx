"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { onAuthStateChanged, sendEmailVerification, signInWithEmailAndPassword, signOut, type User } from "firebase/auth";
import { auth } from "@/lib/firebase";

type Configuration = {
  setupMode?: string; product?: string; branchName?: string; capacity?: number; bookingLimitPerDay?: number;
  business?: { tradingName?: string; legalName?: string; website?: string; abn?: string; gstRegistered?: boolean; ownerName?: string; ownerEmail?: string; ownerPhone?: string; address?: string; timezone?: string };
  businessHours?: Array<{ day: number; opens: string; closes: string }>;
  services?: Array<{ name: string; priceBasis: string; durationMinutes: number; gstInclusive?: boolean; vehicleTypePricing?: Record<string, { price: number; duration: number }> }>;
  staff?: Array<{ name: string; email?: string; skills: string[]; workingDays?: number[]; serviceNames?: string[] }>;
  faqs?: Array<{ question: string; answer: string }>;
  cancellationPolicy?: string; receptionistName?: string; did?: string;
  escalation?: { name: string; phone: string; afterHoursAction: string };
  bookingPolicy?: string;
  terms?: { version: string; billingSummary: string; privacySummary: string; recording: string; retentionDays: number; marketingEnabled: false };
};
type Review = { version: number; status: string; configuration: Configuration; provisioningResult?: { status?: string; branchId?: string; serviceIds?: string[]; staffIds?: string[] }; nextAction: string };
const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const vehicleLabels: Record<string, string> = { small_car: "Small car", sedan_wagon: "Sedan / wagon", suv: "SUV", ute_van_4wd: "Ute / van / 4WD", performance_large: "Performance / large" };

export default function OwnerOnboardingReviewPage() {
  const { draftId } = useParams<{ draftId: string }>();
  const [user, setUser] = useState<User | null>(null), [review, setReview] = useState<Review | null>(null);
  const [email, setEmail] = useState(""), [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false), [accepted, setAccepted] = useState(false), [message, setMessage] = useState("");
  useEffect(() => onAuthStateChanged(auth, current => { setUser(current); setReview(null); setAccepted(false); }), []);
  async function run(work: () => Promise<void>) {
    setBusy(true); setMessage("");
    try { await work(); } catch (error) { setMessage(error instanceof Error ? error.message : "Please try again."); }
    finally { setBusy(false); }
  }
  async function readReview() {
    const current = auth.currentUser;
    if (!current) throw new Error("Sign in first.");
    await current.reload();
    if (!current.emailVerified) throw new Error("Verify your email using the link in your inbox, then refresh this page.");
    const token = await current.getIdToken(true);
    const response = await fetch(`/api/onboarding/${draftId}`, { cache: "no-store", headers: { Authorization: `Bearer ${token}` } });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "This setup is not available to this account. Use the owner email supplied during the call.");
    setReview(data); setAccepted(false);
  }
  async function login(create: boolean) {
    await run(async () => {
      if (create) {
        const response = await fetch("/api/onboarding/account", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
        const data = await response.json(); if (!response.ok) throw new Error(data.error);
      }
      const result = await signInWithEmailAndPassword(auth, email.trim(), password); setPassword("");
      if (create) { await sendEmailVerification(result.user); setMessage("Verification email sent. Open the link in your inbox, then select Refresh setup."); }
      else if (!result.user.emailVerified) setMessage("Verify your email before loading the setup. You can request a verification email below.");
      else await readReview();
    });
  }
  const c = review?.configuration;
  const button = "rounded-lg bg-slate-900 px-5 py-3 text-sm font-medium text-white disabled:opacity-40";
  const secondary = "rounded-lg border px-4 py-3 text-sm disabled:opacity-40";
  const card = "rounded-2xl border border-slate-200 bg-white p-6";
  return <main className="min-h-screen bg-slate-50 px-5 py-10 text-slate-900"><div className="mx-auto max-w-4xl space-y-6">
    <header><p className="text-sm font-semibold text-slate-500">BMS PRO BLACK</p><h1 className="mt-2 text-3xl font-semibold">Your workshop setup</h1>
      <p className="mt-3 text-slate-600">Review the details collected during your call. Approving this setup prepares the workshop for testing; launch and financial authorization are separate steps.</p></header>
    {message && <p role="status" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm">{message}</p>}
    {!user ? <section className={card}><h2 className="text-xl font-semibold">Sign in with the owner email</h2><p className="mt-2 text-sm text-slate-600">Use the email you provided during onboarding. New owners can create a login here; this does not start a subscription.</p>
      <form className="mt-5 space-y-4" onSubmit={event => { event.preventDefault(); void login(false); }}>
        <label className="block text-sm">Email<input type="email" value={email} onChange={event => setEmail(event.target.value)} className="mt-1 w-full rounded-lg border p-3" required autoComplete="email" /></label>
        <label className="block text-sm">Password<input type="password" value={password} onChange={event => setPassword(event.target.value)} className="mt-1 w-full rounded-lg border p-3" required autoComplete="current-password" /></label>
        <div className="flex flex-wrap gap-3"><button disabled={busy} className={button}>Sign in</button><button type="button" disabled={busy || !email || password.length < 12} className={secondary} onClick={() => void login(true)}>Create login &amp; send verification</button></div>
        <p className="text-xs text-slate-500">New passwords need at least 12 characters. Enter passwords only here, never during the call.</p>
      </form></section> : <section className={`${card} flex flex-wrap items-center justify-between gap-3`}><p className="text-sm">Signed in as <strong>{user.email}</strong></p>
        <div className="flex flex-wrap gap-2"><button disabled={busy} className={secondary} onClick={() => void run(readReview)}>Refresh setup</button>
          {!user.emailVerified && <button disabled={busy} className={secondary} onClick={() => void run(async () => { if (auth.currentUser) await sendEmailVerification(auth.currentUser); setMessage("Verification email sent."); })}>Send verification email</button>}
          <button disabled={busy} className={secondary} onClick={() => void run(() => signOut(auth))}>Sign out</button></div></section>}
    {review && c && <>
      <section className={card}><h2 className="text-xl font-semibold">{c.business?.tradingName}</h2>
        <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-2">{[
          ["Owner", `${c.business?.ownerName ?? ""} · ${c.business?.ownerEmail ?? ""}`], ["Phone", c.business?.ownerPhone], ["Address", c.business?.address],
          ["Timezone", c.business?.timezone], ["ABN", c.business?.abn ?? "Not supplied"], ["Branch", c.branchName],
          ["GST registered", c.business?.gstRegistered === undefined ? "Not supplied" : c.business.gstRegistered ? "Yes" : "No"],
          ["Legal name", c.business?.legalName ?? "Not supplied"], ["Website", c.business?.website ?? "Not supplied"],
          ["Workshop capacity", c.capacity], ["Daily booking limit", c.bookingLimitPerDay], ["Setup", c.setupMode === "new_business" ? "New workshop" : "Existing workshop receptionist"],
        ].map(([label, value]) => <div key={String(label)}><dt className="text-slate-500">{label}</dt><dd className="mt-1 font-medium">{value ?? "Not supplied"}</dd></div>)}</dl>
        <h3 className="mt-6 font-semibold">Opening hours</h3><div className="mt-2 space-y-1 text-sm">{days.map((day, index) => { const hours = c.businessHours?.find(value => value.day === index); return <p key={day}>{day}: {hours ? `${hours.opens}–${hours.closes}` : "Closed"}</p>; })}</div>
      </section>
      <section className={card}><h2 className="text-xl font-semibold">Services and prices</h2>{c.services?.map(service => <div key={service.name} className="mt-4 border-t pt-4"><h3 className="font-medium">{service.name}</h3><p className="mt-1 text-sm text-slate-600">{service.priceBasis}</p>
        {service.gstInclusive !== undefined && <p className="text-sm">{service.gstInclusive ? "Prices include GST" : "Prices exclude GST"}</p>}
        {Object.entries(service.vehicleTypePricing ?? {}).map(([type, value]) => <p key={type} className="mt-1 text-sm">{vehicleLabels[type] ?? type}: {value.price} · {value.duration} minutes</p>)}
      </div>)}</section>
      <section className={card}><h2 className="text-xl font-semibold">Staff and schedules</h2>{c.staff?.map(member => <div key={member.email ?? member.name} className="mt-4 border-t pt-4 text-sm"><h3 className="font-medium">{member.name}</h3><p>{member.email}</p><p className="mt-1">Skills: {member.skills.join(", ")}</p>
        <p>Working days: {member.workingDays?.map(day => days[day]).join(", ") ?? "Not supplied"}</p><p>Services: {member.serviceNames?.join(", ") ?? "Not supplied"}</p></div>)}</section>
      <section className={card}><h2 className="text-xl font-semibold">Receptionist and business policies</h2><div className="mt-4 space-y-3 text-sm"><p>Name: {c.receptionistName}</p><p>Business number: {c.did}</p><p>Bookings require staff approval.</p><p>Cancellation: {c.cancellationPolicy}</p>
        <p>Escalation: {c.escalation?.name}, {c.escalation?.phone}; after hours: {c.escalation?.afterHoursAction}</p>{c.faqs?.map(faq => <div key={faq.question}><strong>{faq.question}</strong><p className="whitespace-pre-wrap">{faq.answer}</p></div>)}</div></section>
      <section className={card}><h2 className="text-xl font-semibold">Terms and data choices</h2><div className="mt-4 space-y-3 text-sm"><p className="whitespace-pre-wrap">{c.terms?.billingSummary}</p><p className="whitespace-pre-wrap">{c.terms?.privacySummary}</p><p>Recording: {c.terms?.recording.replaceAll("_", " ")}</p><p>Retention: {c.terms?.retentionDays} days</p><p>Marketing campaigns: disabled</p><p className="text-slate-500">Terms version: {c.terms?.version}</p></div></section>
      <section className={card}><p className="text-sm">Current status: <strong>{review.status.replaceAll("_", " ")}</strong></p><p className="mt-2 text-sm text-slate-600">{review.nextAction}</p>
        {review.status === "owner_review" && <><label className="mt-5 flex items-start gap-3 text-sm"><input type="checkbox" checked={accepted} onChange={event => setAccepted(event.target.checked)} className="mt-1" />I am authorized to act for this business. I have reviewed and approve the setup and terms shown above.</label>
          <button disabled={!accepted || busy} className={`${button} mt-5`} onClick={() => void run(async () => {
            const token = await auth.currentUser!.getIdToken(true);
            const response = await fetch(`/api/onboarding/${draftId}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ expectedVersion: review.version, accepted: true }) });
            const data = await response.json(); if (!response.ok) throw new Error(data.error || "The setup changed. Refresh and review again.");
            setReview(data); setAccepted(false); setMessage("Setup approved. You can tell the AI assistant to continue while you stay on the call.");
          })}>Approve this setup</button></>}
        {review.provisioningResult?.status === "TEST_MODE" && <p className="mt-4 rounded-lg bg-green-50 p-4 text-sm">Your workshop, branch, {review.provisioningResult.serviceIds?.length} services and {review.provisioningResult.staffIds?.length} staff records are prepared for testing. Billing, staff invitations and phone activation still need completion.</p>}
      </section>
    </>}
  </div></main>;
}
