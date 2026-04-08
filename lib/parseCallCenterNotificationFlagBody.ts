import { NextRequest } from "next/server";

export type ParseFlagResult =
  | { ok: true; value: boolean }
  | { ok: false; error: string; status: number };

/**
 * Reads optional JSON `{ [key]: boolean }`.
 * Missing key or empty body → `defaultValue` (e.g. POST with no body still marks reviewed/called as true).
 */
export async function parseOptionalBooleanFlag(
  req: NextRequest,
  key: string,
  defaultValue: boolean
): Promise<ParseFlagResult> {
  const ct = req.headers.get("content-type") || "";
  if (!ct.includes("application/json")) {
    return { ok: true, value: defaultValue };
  }
  const text = await req.text();
  if (!text.trim()) {
    return { ok: true, value: defaultValue };
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, error: "Invalid JSON body", status: 400 };
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Body must be a JSON object", status: 400 };
  }
  const o = body as Record<string, unknown>;
  if (!(key in o)) {
    return { ok: true, value: defaultValue };
  }
  const v = o[key];
  if (typeof v !== "boolean") {
    return { ok: false, error: `${key} must be a boolean`, status: 400 };
  }
  return { ok: true, value: v };
}
