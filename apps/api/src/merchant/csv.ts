/**
 * Catalogue CSV import. A shop owner exporting from a spreadsheet or a till
 * gets a CSV, not JSON, so this is the on-ramp that needs no developer.
 *
 * Columns (header row required, any order, case-insensitive):
 *   sku, name            required
 *   price                required: in major units, e.g. 12.50 (or unit_price_cents)
 *   description, unit, currency, availability, quantity, lead_time_days   optional
 * Per-row errors, never all-or-nothing: one bad row must not drop the rest.
 */
export interface CsvItem {
  sku: string;
  name: string;
  description?: string;
  unit?: string;
  unit_price_cents: number;
  currency?: "ZAR" | "USD";
  availability?: "in_stock" | "low_stock" | "out_of_stock" | "made_to_order";
  quantity_available?: number;
  lead_time_days?: number;
}

export interface CsvRowError {
  row: number;
  sku?: string;
  error: string;
}

export const MAX_CSV_ROWS = 500;

/** RFC 4180-ish: quoted fields, doubled quotes, commas and newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

const AVAIL: Record<string, CsvItem["availability"]> = {
  in_stock: "in_stock", "in stock": "in_stock", instock: "in_stock", yes: "in_stock",
  low_stock: "low_stock", "low stock": "low_stock", low: "low_stock",
  out_of_stock: "out_of_stock", "out of stock": "out_of_stock", out: "out_of_stock", no: "out_of_stock",
  made_to_order: "made_to_order", "made to order": "made_to_order",
};

export function parseCatalogCsv(text: string): { items: (CsvItem & { row: number })[]; errors: CsvRowError[] } {
  const rows = parseCsv(text);
  if (rows.length < 2) return { items: [], errors: [{ row: 1, error: "the file needs a header row and at least one product" }] };
  const header = rows[0]!.map((h) => h.trim().toLowerCase().replace(/[\s-]+/g, "_"));
  const col = (...names: string[]) => header.findIndex((h) => names.includes(h));
  const iSku = col("sku", "code", "product_code");
  const iName = col("name", "product", "product_name", "title");
  const iPrice = col("price", "unit_price", "price_zar", "price_usd");
  const iCents = col("unit_price_cents", "price_cents");
  const missing = [iSku < 0 && "sku", iName < 0 && "name", iPrice < 0 && iCents < 0 && "price"].filter(Boolean);
  if (missing.length) return { items: [], errors: [{ row: 1, error: `missing required column: ${missing.join(", ")}` }] };
  const iDesc = col("description", "desc");
  const iUnit = col("unit", "uom");
  const iCur = col("currency");
  const iAvail = col("availability", "stock_status", "status");
  const iQty = col("quantity", "quantity_available", "qty", "stock");
  const iLead = col("lead_time_days", "lead_time");

  const items: (CsvItem & { row: number })[] = [];
  const errors: CsvRowError[] = [];
  const seen = new Set<string>();
  const body = rows.slice(1);
  if (body.length > MAX_CSV_ROWS) errors.push({ row: MAX_CSV_ROWS + 2, error: `only the first ${MAX_CSV_ROWS} rows are imported per upload` });
  body.slice(0, MAX_CSV_ROWS).forEach((r, idx) => {
    const row = idx + 2;
    const get = (i: number) => (i >= 0 ? (r[i] ?? "").trim() : "");
    const sku = get(iSku);
    const fail = (error: string) => errors.push({ row, sku: sku || undefined, error });
    if (!sku) return fail("sku is empty");
    if (seen.has(sku)) return fail(`duplicate sku ${sku} in this file`);
    seen.add(sku);
    const name = get(iName);
    if (!name) return fail("name is empty");
    let cents: number;
    if (iCents >= 0 && get(iCents) !== "") {
      cents = Number(get(iCents));
    } else {
      const raw = get(iPrice).replace(/^(R|ZAR|\$|USD)\s*/i, "").replace(/[\s ]/g, "").replace(",", ".");
      cents = Math.round(Number(raw) * 100);
      if (raw === "" || !Number.isFinite(Number(raw))) return fail(`price "${get(iPrice)}" is not a number`);
    }
    if (!Number.isSafeInteger(cents) || cents < 0) return fail("price must be zero or more");
    const item: CsvItem & { row: number } = { row, sku, name, unit_price_cents: cents };
    if (get(iDesc)) item.description = get(iDesc).slice(0, 500);
    if (get(iUnit)) item.unit = get(iUnit);
    if (get(iCur)) {
      const cur = get(iCur).toUpperCase();
      if (cur !== "ZAR" && cur !== "USD") return fail(`currency must be ZAR or USD, got ${get(iCur)}`);
      item.currency = cur;
    }
    if (get(iAvail)) {
      const a = AVAIL[get(iAvail).toLowerCase()];
      if (!a) return fail(`availability "${get(iAvail)}" is not one of in_stock, low_stock, out_of_stock, made_to_order`);
      item.availability = a;
    }
    if (get(iQty)) {
      const q = Number(get(iQty));
      if (!Number.isInteger(q) || q < 0) return fail("quantity must be a whole number, zero or more");
      item.quantity_available = q;
    }
    if (get(iLead)) {
      const l = Number(get(iLead));
      if (!Number.isInteger(l) || l < 0) return fail("lead_time_days must be a whole number, zero or more");
      item.lead_time_days = l;
    }
    items.push(item);
  });
  return { items, errors };
}

export const CSV_TEMPLATE = "sku,name,description,unit,price,currency,availability,quantity,lead_time_days\nMILK-1L,Full cream milk 1L,Fresh,each,18.99,ZAR,in_stock,120,1\nEGGS-12,Large eggs 12 pack,Free range,each,54.50,ZAR,in_stock,60,1\n";
