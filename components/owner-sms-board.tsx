"use client";



import { authFetch, useAuthUser } from "@/lib/sms/client-auth";
import { useSmsBalance } from "@/lib/sms/sms-balance-context";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";



type SmsPackage = {

  id: string;

  name: string;

  price: number;

  priceLabel: string;

  messageQuota: number;

  description?: string;

  features: string[];

  popular?: boolean;

  color?: string;

  icon?: string;

  plan_key?: string | null;

};



type Balance = {

  limit: number;

  used: number;

  remaining: number | null;

  unlimited: boolean;

  isLow: boolean;

};



const COLOR_STYLES: Record<

  string,

  { iconBg: string; dot: string; shadow: string; iconClass: string }

> = {

  blue: {

    iconBg: "bg-blue-500",

    dot: "bg-blue-500",

    shadow: "shadow-[0_12px_40px_rgba(59,130,246,0.22)]",

    iconClass: "fa-comment-dots",

  },

  purple: {

    iconBg: "bg-violet-500",

    dot: "bg-violet-500",

    shadow: "shadow-[0_12px_40px_rgba(139,92,246,0.24)]",

    iconClass: "fa-comment-dots",

  },

  pink: {

    iconBg: "bg-neutral-800",

    dot: "bg-neutral-700",

    shadow: "shadow-[0_12px_40px_rgba(64,64,64,0.18)]",

    iconClass: "fa-comment-dots",

  },

  green: {

    iconBg: "bg-emerald-500",

    dot: "bg-emerald-500",

    shadow: "shadow-[0_12px_40px_rgba(16,185,129,0.22)]",

    iconClass: "fa-comment-dots",

  },

  orange: {

    iconBg: "bg-orange-500",

    dot: "bg-orange-500",

    shadow: "shadow-[0_12px_40px_rgba(249,115,22,0.22)]",

    iconClass: "fa-comment-dots",

  },

  teal: {

    iconBg: "bg-teal-500",

    dot: "bg-teal-500",

    shadow: "shadow-[0_12px_40px_rgba(20,184,166,0.22)]",

    iconClass: "fa-comment-dots",

  },

};



function packageStyles(color?: string) {

  return COLOR_STYLES[color ?? "blue"] ?? COLOR_STYLES.blue;

}



function formatDisplayPrice(pkg: SmsPackage): string {

  const label = pkg.priceLabel.trim();

  if (label) {

    const match = label.match(/(?:AU\$|A\$|\$|USD\s?)?[\d,]+(?:\.\d{1,2})?/i);

    if (match) {

      const raw = match[0].replace(/USD\s?/i, "").trim();

      if (/^(AU\$|A\$|\$)/i.test(raw)) return raw.replace(/^A\$/, "AU$");

      return `AU$${raw}`;

    }

  }

  const amount = pkg.price % 1 === 0 ? pkg.price.toFixed(0) : pkg.price.toFixed(2);

  return `AU$${amount}`;

}



function defaultFeatures(pkg: SmsPackage): string[] {

  if (pkg.features?.length) return pkg.features;

  const quota =

    pkg.messageQuota < 0 ? "Unlimited" : `${pkg.messageQuota.toLocaleString()}`;

  return [

    `${quota} SMS messages`,

    "Transactional notifications",

    "Customer alerts",

  ];

}



export function OwnerSmsBoard() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { ready } = useAuthUser();
  const { refresh: refreshSidebarBalance } = useSmsBalance();

  const [balance, setBalance] = useState<Balance | null>(null);

  const [packages, setPackages] = useState<SmsPackage[]>([]);

  const [stripeRequired, setStripeRequired] = useState(false);

  const [loading, setLoading] = useState(true);

  const [error, setError] = useState<string | null>(null);

  const [purchasingId, setPurchasingId] = useState<string | null>(null);

  const [message, setMessage] = useState<string | null>(null);

  const [confirmPackage, setConfirmPackage] = useState<SmsPackage | null>(null);
  const [confirmingCheckout, setConfirmingCheckout] = useState(false);

  const applyBalance = useCallback((next: Balance) => {
    setBalance(next);
  }, []);

  const load = useCallback(async (options?: { silent?: boolean }) => {
    if (!options?.silent) {
      setLoading(true);
    }
    setError(null);

    const result = await authFetch<{
      balance: Balance;
      packages: SmsPackage[];
      stripeRequired: boolean;
    }>("/api/business/sms");

    if (!result.ok) {
      setError(result.error);
    } else {
      setBalance(result.data.balance);
      setPackages(result.data.packages ?? []);
      setStripeRequired(!!result.data.stripeRequired);
    }

    if (!options?.silent) {
      setLoading(false);
    }
  }, []);



  useEffect(() => {

    if (!ready) return;

    void load();

  }, [load, ready]);



  useEffect(() => {
    if (!ready) return;

    const checkout = searchParams.get("checkout");
    const sessionId = searchParams.get("session_id");
    if (!checkout) return;

    if (checkout === "cancelled") {
      setError("Stripe checkout was cancelled. No credits were added.");
      router.replace("/sms");
      return;
    }

    if (checkout !== "success") return;

    if (!sessionId) {
      setError("Payment received, but the session could not be verified. Please refresh this page.");
      router.replace("/sms");
      return;
    }

    const processedKey = `sms_checkout_processed_${sessionId}`;
    if (typeof window !== "undefined" && sessionStorage.getItem(processedKey) === "1") {
      router.replace("/sms");
      return;
    }

    let cancelled = false;

    void (async () => {
      setConfirmingCheckout(true);
      setMessage(null);
      setError(null);

      const result = await authFetch<{ fulfilled: boolean; balance: Balance }>(
        "/api/stripe/checkout/sms/confirm",
        {
          method: "POST",
          body: JSON.stringify({ sessionId }),
        },
      );

      if (cancelled) return;

      setConfirmingCheckout(false);

      if (!result.ok) {
        setError(result.error);
        void load({ silent: true });
        router.replace("/sms");
        return;
      }

      applyBalance(result.data.balance);
      await refreshSidebarBalance();
      sessionStorage.setItem(processedKey, "1");

      setMessage(
        result.data.fulfilled
          ? `Payment successful — your balance is now ${result.data.balance.unlimited ? "Unlimited" : (result.data.balance.remaining ?? 0).toLocaleString()} messages remaining.`
          : "Payment received. Your SMS balance will update shortly.",
      );

      router.replace("/sms");
      void load({ silent: true });
    })();

    return () => {
      cancelled = true;
    };
  }, [ready, router, searchParams, applyBalance, load, refreshSidebarBalance]);



  useEffect(() => {
    const resetStuckRedirect = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      setPurchasingId(null);
      setConfirmPackage(null);
    };

    window.addEventListener("pageshow", resetStuckRedirect);
    return () => window.removeEventListener("pageshow", resetStuckRedirect);
  }, []);



  const purchase = async (pkg: SmsPackage) => {

    setPurchasingId(pkg.id);

    setMessage(null);

    setError(null);



    if (stripeRequired) {

      const checkout = await authFetch<{ url: string }>("/api/stripe/checkout/sms", {

        method: "POST",

        body: JSON.stringify({ packageId: pkg.id }),

      });

      if (!checkout.ok) {

        setError(checkout.error);

        setPurchasingId(null);

        setConfirmPackage(null);

        return;

      }

      window.location.href = checkout.data.url;

      return;

    }



    const result = await authFetch<{ balance: Balance }>("/api/business/sms", {

      method: "POST",

      body: JSON.stringify({ packageId: pkg.id }),

    });

    setPurchasingId(null);

    setConfirmPackage(null);

    if (!result.ok) {

      setError(result.error);

      return;

    }

    setBalance(result.data.balance);
    setMessage("SMS credits added successfully.");
    await refreshSidebarBalance();
    void load({ silent: true });
  };



  const openPurchase = (pkg: SmsPackage) => {

    setError(null);

    setConfirmPackage(pkg);

  };



  return (
    <div className="space-y-6">
      {loading ? (
        <div className="rounded-2xl border border-neutral-200 bg-white p-10 text-center text-neutral-500 shadow-sm">
          <i className="fas fa-spinner fa-spin mr-2" />
          Loading SMS balance…
        </div>
      ) : (
        <>
          <section className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm sm:p-6">
            <h2 className="text-base font-semibold text-neutral-900">Balance overview</h2>
            <p className="mt-1 text-sm text-neutral-500">
              Current SMS usage and remaining credits on your account.
            </p>
            <div className="mt-5 grid gap-4 sm:grid-cols-3">
              <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-4">
                <p className="text-xs font-medium uppercase tracking-wide text-neutral-400">Remaining</p>
                <p className="mt-2 text-3xl font-bold text-neutral-900">
                  {balance?.unlimited ? "Unlimited" : (balance?.remaining ?? 0).toLocaleString()}
                </p>
                {balance?.isLow && !balance.unlimited && (
                  <p className="mt-2 text-sm text-amber-700">Low balance — consider topping up.</p>
                )}
              </div>
              <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-4">
                <p className="text-xs font-medium uppercase tracking-wide text-neutral-400">Used</p>
                <p className="mt-2 text-3xl font-bold text-neutral-900">
                  {(balance?.used ?? 0).toLocaleString()}
                </p>
              </div>
              <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-4">
                <p className="text-xs font-medium uppercase tracking-wide text-neutral-400">Limit</p>
                <p className="mt-2 text-3xl font-bold text-neutral-900">
                  {balance?.unlimited ? "Unlimited" : (balance?.limit ?? 0).toLocaleString()}
                </p>
              </div>
            </div>
          </section>

          {confirmingCheckout && (
            <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
              <i className="fas fa-spinner fa-spin mr-2" />
              Applying your SMS credits…
            </div>
          )}

          {message && (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
              {message}
            </div>
          )}

          {error && (
            <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}

          <section className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm sm:p-6">
            <div className="mb-6">
              <h2 className="text-base font-semibold text-neutral-900">Top up SMS</h2>
              <p className="mt-1 text-sm text-neutral-500">
                Add more messages to your balance. Top-ups stay on your account across subscription
                renewals.
              </p>
            </div>

            {packages.length === 0 ? (
              <p className="text-sm text-neutral-500">No SMS packages are available right now.</p>
            ) : (
              <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
                {packages.map((pkg) => {

                  const styles = packageStyles(pkg.color);

                  const displayPrice = formatDisplayPrice(pkg);

                  const quotaLabel =

                    pkg.messageQuota < 0 ? "Unlimited" : pkg.messageQuota.toLocaleString();

                  const features = defaultFeatures(pkg);



                  return (

                    <article

                      key={pkg.id}

                      className={`flex flex-col overflow-hidden rounded-2xl border border-neutral-100 bg-white ${styles.shadow}`}

                    >

                      <div className="flex items-start gap-3 px-5 pb-4 pt-5">

                        <div

                          className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-white ${styles.iconBg}`}

                        >

                          <i className={`fas ${pkg.icon || styles.iconClass} text-lg`} />

                        </div>

                        <div className="min-w-0 flex-1">

                          <div className="flex items-start justify-between gap-2">

                            <h3 className="truncate text-lg font-bold text-neutral-900">{pkg.name}</h3>

                            {pkg.popular && (

                              <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-800">

                                Popular

                              </span>

                            )}

                          </div>

                          {pkg.plan_key && (

                            <p className="mt-0.5 text-xs font-semibold uppercase tracking-wider text-neutral-400">

                              {pkg.plan_key}

                            </p>

                          )}

                        </div>

                      </div>



                      <div className="px-5 pb-4">

                        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-neutral-400">

                          Messages

                        </p>

                        <p className="mt-1 text-4xl font-bold leading-none text-neutral-900">

                          {quotaLabel}

                        </p>

                        {pkg.description && (

                          <p className="mt-3 text-sm text-neutral-500">{pkg.description}</p>

                        )}

                      </div>



                      <div className="mx-5 border-t border-dashed border-neutral-200" />



                      <ul className="space-y-2.5 px-5 py-4">

                        {features.slice(0, 5).map((feature) => (

                          <li key={feature} className="flex items-start gap-2.5 text-sm text-neutral-600">

                            <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${styles.dot}`} />

                            <span>{feature}</span>

                          </li>

                        ))}

                      </ul>



                      <div className="mt-auto p-4 pt-0">

                        <button

                          type="button"

                          disabled={purchasingId === pkg.id}

                          onClick={() => openPurchase(pkg)}

                          className="flex w-full items-center justify-between rounded-xl bg-neutral-900 px-4 py-3.5 text-sm font-semibold text-white transition hover:bg-neutral-800 disabled:opacity-60"

                        >

                          <span className="flex items-center gap-2">

                            <i className="fas fa-money-bill-wave text-base opacity-90" />

                            Top up package

                          </span>

                          <span className="text-base font-bold">{displayPrice}</span>

                        </button>

                      </div>

                    </article>

                  );

                })}

              </div>
            )}
          </section>
        </>
      )}



      {confirmPackage && (

        <div className="fixed inset-0 z-50">

          <div

            className="absolute inset-0 bg-black/45 backdrop-blur-[2px]"

            onClick={() => !purchasingId && setConfirmPackage(null)}

          />

          <div className="relative flex min-h-screen items-center justify-center p-4">

            <div

              className="w-full max-w-md rounded-2xl bg-white p-8 shadow-2xl"

              role="dialog"

              aria-labelledby="sms-topup-title"

            >

              <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full bg-blue-50">

                <i className="fas fa-comment-dots text-2xl text-blue-500" />

              </div>

              <h3

                id="sms-topup-title"

                className="text-center text-xl font-bold text-neutral-900"

              >

                Confirm SMS top-up

              </h3>

              <p className="mt-4 text-center text-sm leading-relaxed text-neutral-600">

                Purchase{" "}

                <span className="font-semibold text-neutral-900">{confirmPackage.name}</span> for{" "}

                <span className="font-semibold text-neutral-900">

                  {formatDisplayPrice(confirmPackage)}

                </span>

                ? This adds{" "}

                <span className="font-semibold text-neutral-900">

                  {confirmPackage.messageQuota < 0

                    ? "unlimited"

                    : confirmPackage.messageQuota.toLocaleString()}{" "}

                  messages

                </span>{" "}

                to your SMS balance.

                {stripeRequired && (

                  <> You will be redirected to Stripe to complete payment.</>

                )}

              </p>

              <div className="mt-8 flex justify-end gap-3">

                <button

                  type="button"

                  disabled={!!purchasingId}

                  onClick={() => setConfirmPackage(null)}

                  className="rounded-xl border border-neutral-200 px-5 py-2.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"

                >

                  Cancel

                </button>

                <button

                  type="button"

                  disabled={!!purchasingId}

                  onClick={() => void purchase(confirmPackage)}

                  className="rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60"

                >

                  {purchasingId === confirmPackage.id ? (

                    <>

                      <i className="fas fa-spinner fa-spin mr-2" />

                      Redirecting…

                    </>

                  ) : (

                    "Top up now"

                  )}

                </button>

              </div>

            </div>

          </div>

        </div>

      )}

    </div>

  );

}

