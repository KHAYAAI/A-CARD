"use client";

/**
 * Sell on A-CARD: open signup for a shop to list itself in A-MERCHANT and
 * upload its catalogue from a spreadsheet. No login: the signup returns a
 * merchant key (shown once) that the upload uses. A new store is
 * `pending_kyb`, which means agents cannot find it and nobody can order from
 * it until A-CARD verifies the business. The page says so plainly.
 * Needs the API to run with ACARD_SELF_SERVE_STORES=true.
 */

import { useMemo, useState } from "react";

const API_URL = process.env.NEXT_PUBLIC_ACARD_API_URL ?? "http://localhost:8787";

const CATEGORIES: [string, string][] = [
  ["5411", "Groceries"], ["5211", "Building supplies"], ["5734", "Software"], ["5812", "Restaurants"],
  ["5942", "Books and stationery"], ["5999", "Other retail"],
];
const TEMPLATE = "sku,name,description,unit,price,currency,availability,quantity,lead_time_days\nMILK-1L,Full cream milk 1L,Fresh,each,18.99,ZAR,in_stock,120,1\nEGGS-12,Large eggs 12 pack,Free range,each,54.50,ZAR,in_stock,60,1\n";

interface Signup { merchant: { id: string; name: string }; secret: string; status: string; next: string }
interface Upload { synced: number; failed: number; errors: { row: number; sku?: string; error: string }[] }

/** A small CSV peek so the owner sees what will be imported before sending it. */
function peek(text: string): { head: string[]; rows: string[][] } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 6);
  const cells = lines.map((l) => l.split(",").map((c) => c.replace(/^"|"$/g, "")));
  return { head: cells[0] ?? [], rows: cells.slice(1) };
}

export default function Sell() {
  const [f, setF] = useState({ name: "", trading: "", mcc: "5411", address: "", city: "", province: "Gauteng", radius: "25", reg: "", vat: "", email: "", phone: "" });
  const [geo, setGeo] = useState<{ lat: number; lng: number }>({ lat: -26.2041, lng: 28.0473 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [signup, setSignup] = useState<Signup | null>(null);
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState("");
  const [upload, setUpload] = useState<Upload | null>(null);
  const [copied, setCopied] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((p) => ({ ...p, [k]: e.target.value }));
  const preview = useMemo(() => (csv ? peek(csv) : null), [csv]);
  const ready = f.name.trim() && f.address.trim() && f.city.trim() && f.reg.trim() && /\S+@\S+\.\S+/.test(f.email);

  async function submit() {
    setBusy(true); setError("");
    try {
      const res = await fetch(`${API_URL}/v1/merchant-api/signup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: f.name.trim(), trading_name: f.trading.trim() || undefined, merchant_category_code: f.mcc,
          address: { lat: geo.lat, lng: geo.lng, addressLine: f.address.trim(), city: f.city.trim(), province: f.province.trim(), country: "ZA" },
          service_radius_km: Number(f.radius) || 0, currency: "ZAR",
          kyb: { registration_number: f.reg.trim(), vat_number: f.vat.trim() || undefined, contact_email: f.email.trim(), contact_phone: f.phone.trim() || undefined },
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 404) throw new Error("Store signup isn't switched on for this A-CARD deployment yet.");
      if (res.status === 429) throw new Error("Too many applications from your network. Please try again later.");
      if (!res.ok) throw new Error(body?.error?.message ?? "We couldn't submit that. Check the details and try again.");
      setSignup(body);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  async function send() {
    if (!signup || !csv) return;
    setBusy(true); setError(""); setUpload(null);
    try {
      const res = await fetch(`${API_URL}/v1/merchant-api/catalog/csv`, { method: "PUT", headers: { authorization: `Bearer ${signup.secret}`, "content-type": "text/csv" }, body: csv });
      const body = await res.json().catch(() => ({}));
      if (res.status !== 200 && res.status !== 207) throw new Error(body?.error?.message ?? "The upload failed.");
      setUpload(body);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  function download() {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([TEMPLATE], { type: "text/csv" }));
    a.download = "a-card-catalogue-template.csv";
    a.click();
  }
  const locate = () => navigator.geolocation?.getCurrentPosition((p) => setGeo({ lat: +p.coords.latitude.toFixed(5), lng: +p.coords.longitude.toFixed(5) }), () => setError("Couldn't read your location. We'll use Johannesburg; you can ask us to correct it."));

  const step = !signup ? 1 : upload && upload.synced > 0 ? 3 : 2;
  return (
    <main style={{ maxWidth: 760, margin: "0 auto", padding: "28px 18px 80px" }}>
      <div className="wordmark" style={{ marginBottom: 6 }}>a<span className="dot">·</span>card <span style={{ color: "var(--muted)", fontWeight: 400 }}>/ sell</span></div>
      <h1 className="login-title" style={{ marginTop: 14 }}>Put your shop in front of <span className="em">buyers' agents</span>.</h1>
      <p className="login-sub" style={{ maxWidth: 560 }}>Upload your products from a spreadsheet. Once we've verified your business, AI agents can search your stock, compare your price and pay you by card, wallet or stablecoin.</p>

      <ol className="seg" style={{ display: "flex", gap: 8, listStyle: "none", padding: 0, margin: "20px 0", flexWrap: "wrap" }}>
        {["Your shop", "Your products", "Verification"].map((s, i) => (
          <li key={s} className={step === i + 1 ? "sel" : ""} style={{ padding: "6px 14px", borderRadius: 999, border: "1px solid var(--border)", fontSize: 13, background: step === i + 1 ? "var(--green-bg)" : "transparent", color: step > i ? "var(--ink)" : "var(--muted)" }}>{i + 1}. {s}</li>
        ))}
      </ol>

      {error && <div role="alert" style={{ background: "var(--red-bg)", color: "var(--red)", padding: "10px 14px", borderRadius: 12, margin: "0 0 16px", fontSize: 14 }}>{error}</div>}

      {!signup && (
        <section className="panel panel-pad" aria-label="Your shop">
          <div className="field"><label>STORE NAME (REGISTERED)</label><input value={f.name} onChange={set("name")} placeholder="Corner Dairy (Pty) Ltd" /></div>
          <div className="field"><label>TRADING NAME (OPTIONAL)</label><input value={f.trading} onChange={set("trading")} placeholder="Corner Dairy" /></div>
          <div className="field"><label>WHAT YOU SELL</label><select value={f.mcc} onChange={set("mcc")}>{CATEGORIES.map(([c, l]) => <option key={c} value={c}>{l} ({c})</option>)}</select></div>
          <div className="field"><label>STREET ADDRESS</label><input value={f.address} onChange={set("address")} placeholder="1 Main Road" autoComplete="street-address" /></div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div className="field"><label>CITY</label><input value={f.city} onChange={set("city")} placeholder="Johannesburg" /></div>
            <div className="field"><label>PROVINCE</label><input value={f.province} onChange={set("province")} /></div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 12, alignItems: "end" }}>
            <div className="field"><label>HOW FAR YOU DELIVER (KM)</label><input inputMode="numeric" value={f.radius} onChange={set("radius")} /></div>
            <button type="button" className="btn btn-outline" onClick={locate} style={{ marginBottom: 1 }}>Use my location</button>
          </div>
          <div className="field"><label>COMPANY REGISTRATION NUMBER</label><input value={f.reg} onChange={set("reg")} placeholder="2020/123456/07" /></div>
          <div className="field"><label>VAT NUMBER (OPTIONAL)</label><input value={f.vat} onChange={set("vat")} /></div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div className="field"><label>CONTACT EMAIL</label><input type="email" value={f.email} onChange={set("email")} placeholder="owner@yourshop.co.za" autoComplete="email" /></div>
            <div className="field"><label>PHONE (OPTIONAL)</label><input type="tel" value={f.phone} onChange={set("phone")} autoComplete="tel" /></div>
          </div>
          <button className="btn btn-green" style={{ marginTop: 22 }} disabled={!ready || busy} onClick={submit}>{busy ? "Submitting…" : "Create my store"}</button>
          <p style={{ color: "var(--muted)", fontSize: 12.5, marginTop: 12 }}>We use these details only to verify your business. Your registration number and contact details are never shown to buyers or agents.</p>
        </section>
      )}

      {signup && (
        <>
          <section className="panel panel-pad" style={{ marginBottom: 18 }} aria-label="Store created">
            <div className="eyebrow">STORE CREATED</div>
            <h2 style={{ margin: "6px 0 4px", fontSize: 20 }}>{signup.merchant.name}</h2>
            <p style={{ color: "var(--muted)", fontSize: 14, margin: "0 0 14px" }}>{signup.next}</p>
            <div className="field" style={{ marginTop: 0 }}>
              <label>YOUR STORE KEY: SHOWN ONCE. SAVE IT NOW.</label>
              <div style={{ display: "flex", gap: 8 }}>
                <input readOnly value={signup.secret} onFocus={(e) => e.currentTarget.select()} style={{ fontFamily: "var(--font-mono)", fontSize: 13 }} />
                <button className="btn btn-outline" onClick={() => { navigator.clipboard?.writeText(signup.secret); setCopied(true); setTimeout(() => setCopied(false), 1800); }}>{copied ? "Copied" : "Copy"}</button>
              </div>
              <p style={{ color: "var(--muted)", fontSize: 12.5, marginTop: 8 }}>This key lets a till or spreadsheet job update your products and stock. We can't show it again. Treat it like a password.</p>
            </div>
          </section>

          <section className="panel panel-pad" aria-label="Upload products">
            <div className="eyebrow">UPLOAD YOUR PRODUCTS</div>
            <p style={{ color: "var(--muted)", fontSize: 14, margin: "6px 0 14px" }}>A spreadsheet saved as CSV. Needs <b>sku</b>, <b>name</b> and <b>price</b> (in rands). Quantity, availability and lead time are optional. Upload again any time: the same SKU just updates.</p>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
              <label className="btn btn-outline" style={{ cursor: "pointer" }}>
                Choose a CSV file
                <input type="file" accept=".csv,text/csv" hidden onChange={async (e) => { const file = e.target.files?.[0]; if (!file) return; if (file.size > 2_000_000) { setError("That file is over 2 MB."); return; } setError(""); setUpload(null); setFileName(file.name); setCsv(await file.text()); }} />
              </label>
              <button className="btn btn-outline" onClick={download}>Download a template</button>
            </div>
            {preview && (
              <div style={{ overflowX: "auto", marginBottom: 14 }}>
                <div style={{ fontSize: 12.5, color: "var(--muted)", marginBottom: 6 }}>{fileName} · first rows</div>
                <table className="tbl" style={{ width: "100%", fontSize: 13 }}>
                  <thead><tr>{preview.head.map((h) => <th key={h} style={{ textAlign: "left", padding: "4px 10px 4px 0" }}>{h}</th>)}</tr></thead>
                  <tbody>{preview.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} style={{ padding: "4px 10px 4px 0" }}>{c}</td>)}</tr>)}</tbody>
                </table>
              </div>
            )}
            <button className="btn btn-green" disabled={!csv || busy} onClick={send}>{busy ? "Uploading…" : "Upload products"}</button>
            {upload && (
              <div role="status" style={{ marginTop: 16 }}>
                <b>{upload.synced} product{upload.synced === 1 ? "" : "s"} imported.</b>
                {upload.failed > 0 && <span style={{ color: "var(--amber)" }}> {upload.failed} row{upload.failed === 1 ? " needs" : "s need"} fixing:</span>}
                {upload.errors.length > 0 && <ul style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 13.5, color: "var(--muted)" }}>{upload.errors.slice(0, 10).map((e, i) => <li key={i}>Row {e.row}{e.sku ? ` (${e.sku})` : ""}: {e.error}</li>)}</ul>}
              </div>
            )}
          </section>

          {upload && upload.synced > 0 && (
            <section className="panel panel-pad" style={{ marginTop: 18 }} aria-label="What happens next">
              <div className="eyebrow">WHAT HAPPENS NEXT</div>
              <ol style={{ margin: "8px 0 0", paddingLeft: 18, color: "var(--muted)", fontSize: 14, lineHeight: 1.7 }}>
                <li>We check your business registration (KYB). You'll hear from us on {f.email || "your email"}.</li>
                <li>Once verified, your products show up when agents search near you.</li>
                <li>When an agent buys, you get the order to accept and fulfil. Keep your stock fresh: restating it often ranks you higher.</li>
              </ol>
            </section>
          )}
        </>
      )}
    </main>
  );
}
