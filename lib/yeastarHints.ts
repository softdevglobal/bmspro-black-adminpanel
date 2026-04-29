/**
 * Yeastar P-Series error codes we surface to API clients (see Yeastar error-code docs).
 */

export function parseYeastarErrcode(message: string): number | null {
  const m = message.match(/errcode[=:](\d+)/i);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

/** Human-readable fix hints for operators (PBX admin / networking). */
export function yeastarHintForErrcode(errcode: number): string | undefined {
  switch (errcode) {
    case 60002:
      return (
        "MAX LIMITATION EXCEEDED (60002): the PBX has reached the concurrent OpenAPI access_token cap. " +
        "Revoke idle API sessions in the Yeastar web UI, wait for tokens to expire, or ensure only one backend " +
        "instance issues tokens (this app caches via Firestore across Vercel/serverless workers)."
      );
    case 10001:
      return (
        "INTERFACE NOT EXISTED (10001): this firmware/edition does not expose the push/set OpenAPI on your PBX. " +
        "Linkus in-app (foreground) calling can still work; background push wake may require a different API or PBX option."
      );
    case 70087:
      return (
        "IP FORBIDDEN (70087): Yeastar OpenAPI has IP restriction enabled and blocked this server's address. " +
        "Fix in PBX web UI: Integrations → API (or Settings → PBX → General → API) → either disable IP restriction for API, " +
        "or add allowed IPs for your hosting provider. Vercel uses many rotating egress IPs — whitelist Vercel ranges " +
        "(see https://vercel.com/guides/how-to-allowlist-deployment-ip-address ) or use a fixed-IP proxy. " +
        "Alternatively keep token/sign calls only from the mobile app (device IP), not from Vercel."
      );
    default:
      return undefined;
  }
}

export function yeastarProbeHint(message: string): string | undefined {
  const code = parseYeastarErrcode(message);
  return code != null ? yeastarHintForErrcode(code) : undefined;
}
