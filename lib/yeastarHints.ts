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
