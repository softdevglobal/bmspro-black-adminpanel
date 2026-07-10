export type CatalogItemInput = {
  name: string;
  priceAud: number;
  code: string | null;
  description: string | null;
};

export function parseItemInput(body: unknown): CatalogItemInput | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;

  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (!name || name.length > 200) return null;

  const rawPrice =
    typeof record.priceAud === "number"
      ? record.priceAud
      : typeof record.amountAud === "number"
        ? record.amountAud
        : Number.parseFloat(String(record.priceAud ?? record.amountAud ?? ""));
  if (!Number.isFinite(rawPrice) || rawPrice < 0) return null;

  const codeRaw = record.code;
  const code =
    typeof codeRaw === "string" && codeRaw.trim() ? codeRaw.trim().slice(0, 50) : null;

  const descRaw = record.description;
  const description =
    typeof descRaw === "string" && descRaw.trim() ? descRaw.trim().slice(0, 500) : null;

  return { name, priceAud: Math.round(rawPrice * 100) / 100, code, description };
}

export function normalizeItemName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}
