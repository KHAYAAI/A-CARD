"use client";

import { useCallback, useEffect, useState } from "react";

type Call = (path: string, init?: RequestInit) => Promise<any>;
type Flash = (m: string) => void;

const money = (cents: number, ccy: string) => `${ccy === "USD" ? "$" : "R"}${(cents / 100).toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const when = (iso?: string) => (iso ? new Date(iso).toLocaleString() : "—");
const empty = { padding: "26px 8px", color: "var(--muted)", fontSize: 14, textAlign: "center" as const };
const th = { textAlign: "left" as const, fontSize: 12, color: "var(--muted)", fontWeight: 500, padding: "6px 10px 6px 0" };
const td = { padding: "10px 10px 10px 0", borderTop: "1px solid var(--border-soft)", fontSize: 14, verticalAlign: "top" as const };
const notEnabled = (e: unknown) => /404|not found|not configured|501/i.test((e as Error).message);

function Head({ title, sub }: { title: string; sub: string }) {
  return <div className="page-head"><div className="page-title">{title}</div><div className="page-sub">{sub}</div></div>;
}
function Off({ text }: { text: string }) {
  return <div className="panel panel-pad"><div style={empty}>{text}</div></div>;
}

/* =============================================================== agents and API keys */
interface KeyRow { id: string; name: string; prefix: string; scope: string; spendCapCents?: number; provisionedCents: number; createdAt: string; revokedAt?: string }

export function AgentsPanel({ call, flash }: { call: Call; flash: Flash }) {
  const [keys, setKeys] = useState<KeyRow[] | null>(null);
  const [err, setErr] = useState("");
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"full" | "read_only">("full");
  const [cap, setCap] = useState("");
  const [secret, setSecret] = useState<{ name: string; value: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try { setKeys((await call("/v1/keys")).keys ?? []); setErr(""); } catch (e) { setErr((e as Error).message); }
  }, [call]);
  useEffect(() => { void load(); }, [load]);
  const create = async () => {
    setBusy(true);
    try {
      const r = await call("/v1/keys", { method: "POST", body: JSON.stringify({ name: name.trim() || "agent", scope, spend_cap_cents: cap ? Math.round(Number(cap) * 100) : undefined }) });
      setSecret({ name: name.trim() || "agent", value: r.api_key }); setName(""); setCap(""); await load();
    } catch (e) { flash((e as Error).message); } finally { setBusy(false); }
  };
  const revoke = async (k: KeyRow) => {
    if (!window.confirm(`Revoke "${k.name}"? Any agent using it stops working immediately.`)) return;
    try { await call(`/v1/keys/${k.id}`, { method: "DELETE" }); flash("Key revoked."); await load(); } catch (e) { flash((e as Error).message); }
  };
  const active = (keys ?? []).filter((k) => !k.revokedAt);
  return (
    <>
      <Head title="Agents and API keys" sub="Each agent gets its own key, with its own scope and an optional budget it can never exceed." />
      {err ? <Off text={err} /> : (
        <div className="stack">
          {secret && (
            <div className="panel panel-pad" style={{ border: "1px solid var(--green)" }}>
              <div className="eyebrow">COPY THIS KEY NOW: IT WON&apos;T BE SHOWN AGAIN</div>
              <p style={{ margin: "6px 0 10px", fontSize: 14 }}>Key for <b>{secret.name}</b>. Paste it into the agent&apos;s settings (Claude, Codex, the SDK or the MCP server). Treat it like a password.</p>
              <div style={{ display: "flex", gap: 8 }}><input readOnly value={secret.value} onFocus={(e) => e.currentTarget.select()} style={{ flex: 1, fontFamily: "var(--font-mono)", padding: "10px 12px", borderRadius: 10, border: "1px solid var(--border)", background: "var(--surface-2)", color: "var(--ink)" }} />
                <button className="btn btn-outline" onClick={() => { navigator.clipboard?.writeText(secret.value); flash("Copied."); }}>Copy</button><button className="btn btn-green" onClick={() => setSecret(null)}>Done</button></div>
            </div>
          )}
          <div className="panel panel-pad">
            <div className="eyebrow">NEW AGENT KEY</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 12 }}>
              <div className="field"><label>AGENT NAME</label><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Procurement agent" /></div>
              <div className="field"><label>WHAT IT CAN DO</label><select value={scope} onChange={(e) => setScope(e.target.value as "full" | "read_only")}><option value="full">Create cards and pay</option><option value="read_only">Read only</option></select></div>
              <div className="field"><label>TOTAL BUDGET (OPTIONAL)</label><input inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} placeholder="e.g. 5000" /></div>
            </div>
            <button className="btn btn-green" style={{ marginTop: 14 }} disabled={busy} onClick={create}>Create key</button>
            <p style={{ color: "var(--muted)", fontSize: 12.5, marginTop: 10 }}>The budget caps the total card value this key can ever create. Card rules, policies and approvals still apply to every purchase.</p>
          </div>
          <div className="panel panel-pad">
            <div className="eyebrow">KEYS ({active.length} ACTIVE)</div>
            {keys === null ? <div style={empty}>Loading…</div> : keys.length === 0 ? <div style={empty}>No keys yet.</div> : (
              <div style={{ overflowX: "auto" }}><table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead><tr><th style={th}>Agent</th><th style={th}>Scope</th><th style={{ ...th, textAlign: "right" }}>Budget used</th><th style={th}>Created</th><th style={th} /></tr></thead>
                <tbody>{keys.map((k) => (
                  <tr key={k.id} style={{ opacity: k.revokedAt ? 0.55 : 1 }}>
                    <td style={td}><b>{k.name}</b><div style={{ color: "var(--muted)", fontSize: 12, fontFamily: "var(--font-mono)" }}>{k.prefix}…</div></td>
                    <td style={td}>{k.scope === "read_only" ? "Read only" : "Cards and payments"}</td>
                    <td style={{ ...td, textAlign: "right", fontFamily: "var(--font-mono)" }}>{money(k.provisionedCents, "ZAR")}{k.spendCapCents ? ` of ${money(k.spendCapCents, "ZAR")}` : " (no cap)"}</td>
                    <td style={td}>{new Date(k.createdAt).toLocaleDateString()}</td>
                    <td style={{ ...td, textAlign: "right" }}>{k.revokedAt ? <span className="pill closed">revoked</span> : <button className="btn btn-outline" onClick={() => revoke(k)}>Revoke</button>}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

/* =============================================================== orders (A-MERCHANT) */
interface OrderRow { id: string; merchantId: string; lines: { name?: string; sku?: string; quantity: number; unitPriceCents?: number }[]; totalCents: number; currency: string; status: string; fulfilment: { method: string; address?: string; neededBy?: string; promisedAt?: string }; createdAt: string }

export function OrdersPanel({ call, flash }: { call: Call; flash: Flash }) {
  const [orders, setOrders] = useState<OrderRow[] | null>(null);
  const [off, setOff] = useState("");
  const [names, setNames] = useState<Record<string, string>>({});
  const load = useCallback(async () => {
    try {
      const o: OrderRow[] = (await call("/v1/orders")).orders ?? [];
      setOrders(o);
      const ids = [...new Set(o.map((x) => x.merchantId))];
      const got = await Promise.all(ids.map((id) => call(`/v1/merchants/${id}`).then((r) => [id, r.merchant?.name ?? id] as const).catch(() => [id, id] as const)));
      setNames(Object.fromEntries(got));
    } catch (e) { setOff(notEnabled(e) ? "A-MERCHANT orders aren't enabled on this deployment." : (e as Error).message); }
  }, [call]);
  useEffect(() => { void load(); }, [load]);
  const cancel = async (o: OrderRow) => {
    if (!window.confirm("Cancel this order? The supplier is told straight away.")) return;
    try { await call(`/v1/orders/${o.id}/cancel`, { method: "POST", body: "{}" }); flash("Order cancelled."); await load(); } catch (e) { flash((e as Error).message); }
  };
  const open = (orders ?? []).filter((o) => !["delivered", "cancelled", "rejected"].includes(o.status));
  return (
    <>
      <Head title="Orders" sub="Orders your agents placed with A-MERCHANT suppliers, and where each one is." />
      {off ? <Off text={off} /> : (
        <div className="panel panel-pad">
          <div className="eyebrow">{open.length} OPEN</div>
          {orders === null ? <div style={empty}>Loading…</div> : orders.length === 0 ? <div style={empty}>No orders yet. When an agent orders from a supplier, it shows up here.</div> : (
            <div style={{ overflowX: "auto" }}><table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr><th style={th}>Supplier</th><th style={th}>Items</th><th style={{ ...th, textAlign: "right" }}>Total</th><th style={th}>Fulfilment</th><th style={th}>Status</th><th style={th} /></tr></thead>
              <tbody>{orders.map((o) => (
                <tr key={o.id}>
                  <td style={td}><b>{names[o.merchantId] ?? "…"}</b><div style={{ color: "var(--muted)", fontSize: 12 }}>{new Date(o.createdAt).toLocaleDateString()}</div></td>
                  <td style={td}>{o.lines.map((l, i) => <div key={i}>{l.quantity} × {l.name ?? l.sku}</div>)}</td>
                  <td style={{ ...td, textAlign: "right", fontFamily: "var(--font-mono)" }}>{money(o.totalCents, o.currency)}</td>
                  <td style={td}>{o.fulfilment.method}{o.fulfilment.promisedAt ? <div style={{ color: "var(--muted)", fontSize: 12 }}>promised {when(o.fulfilment.promisedAt)}</div> : null}</td>
                  <td style={td}><span className={`pill ${o.status === "delivered" ? "completed" : ["cancelled", "rejected"].includes(o.status) ? "declined" : "pending"}`}>{o.status}</span></td>
                  <td style={{ ...td, textAlign: "right" }}>{o.status === "placed" && <button className="btn btn-outline" onClick={() => cancel(o)}>Cancel</button>}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </div>
      )}
    </>
  );
}

/* =============================================================== verification (KYC/KYB) */
export function VerificationPanel({ call, flash }: { call: Call; flash: Flash }) {
  const [me, setMe] = useState<{ status: string; can_move_money: boolean; enforced: boolean; provider: string; verification: { verificationUrl?: string; updatedAt?: string } | null } | null>(null);
  const [off, setOff] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try { setMe(await call("/v1/compliance/me")); } catch (e) { setOff(notEnabled(e) ? "Identity verification isn't enabled on this deployment yet." : (e as Error).message); }
  }, [call]);
  useEffect(() => { void load(); }, [load]);
  const start = async () => {
    setBusy(true);
    try {
      const r = await call("/v1/compliance/verify", { method: "POST", body: "{}" });
      const url = r.verification?.verificationUrl;
      if (url) window.open(url, "_blank", "noopener"); else flash("Verification started.");
      await load();
    } catch (e) { flash((e as Error).message); } finally { setBusy(false); }
  };
  const label: Record<string, string> = { not_started: "Not started", pending: "In review", in_progress: "In progress", approved: "Verified", verified: "Verified", declined: "Declined", expired: "Expired" };
  return (
    <>
      <Head title="Verification" sub="Who you are, checked once, so real money can move. Required by law before live cards." />
      {off ? <Off text={off} /> : !me ? <Off text="Loading…" /> : (
        <div className="panel panel-pad">
          <div className="eyebrow">STATUS</div>
          <div style={{ fontSize: 22, margin: "6px 0" }} className="serif">{label[me.status] ?? me.status}</div>
          <p style={{ color: "var(--muted)", fontSize: 14, margin: "0 0 12px" }}>
            {me.can_move_money ? "Your account can move money." : "Money movement is paused until verification completes."} {me.enforced ? "Verification is enforced on this deployment." : "Verification is recorded but not yet enforced on this deployment."} Checks are run by {me.provider}.
          </p>
          {!["approved", "verified"].includes(me.status) && <button className="btn btn-green" disabled={busy} onClick={start}>{me.verification?.verificationUrl ? "Continue verification" : "Start verification"}</button>}
          <p style={{ color: "var(--muted)", fontSize: 12.5, marginTop: 12 }}>You&apos;ll check your ID and take a quick selfie on the verification provider&apos;s secure page. A-CARD stores the result, not your ID images.</p>
        </div>
      )}
    </>
  );
}

/* =============================================================== plan and billing */
export function PlanPanel({ call, flash, current }: { call: Call; flash: Flash; current?: string }) {
  const [plans, setPlans] = useState<Record<string, { cardsPerMonth: number; priceUsdCents: number; perCardCapCents: number | null }> | null>(null);
  useEffect(() => { call("/v1/billing/plans").then((r) => setPlans(r.plans)).catch(() => setPlans({})); }, [call]);
  const upgrade = async (tier: string) => {
    try {
      const r = await call("/v1/billing/checkout", { method: "POST", body: JSON.stringify({ tier }) });
      if (r.action && r.fields) {
        const form = document.createElement("form"); form.method = "POST"; form.action = r.action;
        for (const [k, v] of Object.entries(r.fields as Record<string, string>)) { const i = document.createElement("input"); i.type = "hidden"; i.name = k; i.value = v; form.appendChild(i); }
        document.body.appendChild(form); form.submit();
      } else flash("Checkout started.");
    } catch (e) { flash(/501|not configured/i.test((e as Error).message) ? "Paid plans aren't switched on for this deployment yet." : (e as Error).message); }
  };
  return (
    <>
      <Head title="Plan and billing" sub="What your plan includes, and upgrading when you need more." />
      {!plans ? <Off text="Loading…" /> : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: 14 }}>
          {Object.entries(plans).map(([tier, p]) => (
            <div key={tier} className="panel panel-pad" style={{ border: tier === current ? "1px solid var(--green)" : undefined }}>
              <div className="eyebrow">{tier.toUpperCase()}{tier === current ? " · CURRENT" : ""}</div>
              <div className="serif" style={{ fontSize: 26, margin: "6px 0" }}>{p.priceUsdCents === 0 ? "Free" : `$${(p.priceUsdCents / 100).toLocaleString()}/mo`}</div>
              <ul style={{ margin: "0 0 12px", paddingLeft: 18, color: "var(--muted)", fontSize: 14 }}>
                <li>{p.cardsPerMonth >= 100_000 ? "Unlimited cards" : `${p.cardsPerMonth} cards a month`}</li>
                <li>{p.perCardCapCents === null ? "No per-card cap" : `Up to $${(p.perCardCapCents / 100).toLocaleString()} per card`}</li>
              </ul>
              {tier !== current && tier !== "free" && <button className="btn btn-outline" onClick={() => upgrade(tier)}>Choose {tier}</button>}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/* =============================================================== needs attention (Home) */
export function NeedsAttention({ call, goto, cardApprovals }: { call: Call; goto: (v: string) => void; cardApprovals: number }) {
  const [s, setS] = useState<{ passkey: number; orders: number; verify: string | null; cooldown: string | null }>({ passkey: 0, orders: 0, verify: null, cooldown: null });
  useEffect(() => {
    (async () => {
      const [p, o, v, k] = await Promise.all([
        call("/v1/attached-cards/purchases").catch(() => ({ purchases: [] })),
        call("/v1/orders").catch(() => ({ orders: [] })),
        call("/v1/compliance/me").catch(() => null),
        call("/v1/passkeys").catch(() => null),
      ]);
      setS({
        passkey: (p.purchases ?? []).filter((x: any) => x.status === "awaiting_approval").length,
        orders: (o.orders ?? []).filter((x: any) => !["delivered", "cancelled", "rejected"].includes(x.status)).length,
        verify: v && !v.can_move_money ? v.status : null,
        cooldown: k?.cooldown_until ?? null,
      });
    })();
  }, [call, cardApprovals]);
  const items = [
    cardApprovals > 0 && { text: `${cardApprovals} card charge${cardApprovals === 1 ? "" : "s"} waiting for approval`, view: "approvals" },
    s.passkey > 0 && { text: `${s.passkey} purchase${s.passkey === 1 ? "" : "s"} on your own card waiting for your passkey`, view: "approvals" },
    s.orders > 0 && { text: `${s.orders} supplier order${s.orders === 1 ? "" : "s"} in progress`, view: "orders" },
    s.verify && { text: "Verify your identity to move real money", view: "verification" },
    s.cooldown && { text: `Passkey recovered recently: approvals pause until ${new Date(s.cooldown).toLocaleString()}`, view: "security" },
  ].filter(Boolean) as { text: string; view: string }[];
  if (!items.length) return null;
  return (
    <div className="panel panel-pad">
      <div className="panel-head"><h2>Needs your attention</h2></div>
      {items.map((i) => (
        <button key={i.text} onClick={() => goto(i.view)} style={{ display: "flex", width: "100%", justifyContent: "space-between", padding: "10px 0", border: "none", borderTop: "1px solid var(--border-soft)", background: "transparent", color: "var(--ink)", fontSize: 14, cursor: "pointer", textAlign: "left" }}>
          <span>{i.text}</span><span style={{ color: "var(--green)" }}>Open →</span>
        </button>
      ))}
    </div>
  );
}

/* =============================================================== white label */
type Branding = { white_label: boolean; brand: { display_name: string; logo_url: string | null; primary_color: string | null; support_email: string | null; support_url: string | null } };

/** The partner's brand for its customers (and itself); nothing for ordinary accounts. */
export function BrandBar({ call }: { call: Call }) {
  const [b, setB] = useState<Branding | null>(null);
  useEffect(() => { call("/v1/branding").then(setB).catch(() => setB(null)); }, [call]);
  useEffect(() => {
    const c = b?.white_label ? b.brand.primary_color : null;
    if (c) document.documentElement.style.setProperty("--brand", c);
    return () => { document.documentElement.style.removeProperty("--brand"); };
  }, [b]);
  if (!b?.white_label) return null;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderBottom: "1px solid var(--border-soft)", borderLeft: `4px solid ${b.brand.primary_color ?? "var(--green)"}` }}>
      {b.brand.logo_url && <img src={b.brand.logo_url} alt="" style={{ height: 22, maxWidth: 90, objectFit: "contain" }} />}
      <div style={{ lineHeight: 1.2 }}>
        <div style={{ fontWeight: 600, fontSize: 14 }}>{b.brand.display_name}</div>
        <div style={{ fontSize: 11, color: "var(--muted)" }}>Powered by A-CARD{b.brand.support_email ? ` · ${b.brand.support_email}` : ""}</div>
      </div>
    </div>
  );
}

/* =============================================================== partner program */
export function PartnerPanel({ call, flash }: { call: Call; flash: Flash }) {
  const [p, setP] = useState<any | null | undefined>(undefined);
  const [customers, setCustomers] = useState<any[]>([]);
  const [rev, setRev] = useState<any | null>(null);
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [name, setName] = useState("");
  const [brand, setBrand] = useState({ display_name: "", logo_url: "", primary_color: "#1f8f5f", support_email: "" });
  const [cust, setCust] = useState({ name: "", email: "", external_ref: "" });
  const load = useCallback(async () => {
    try {
      const me = await call("/v1/partner");
      setP(me);
      setBrand({ display_name: me.brand.display_name ?? "", logo_url: me.brand.logo_url ?? "", primary_color: me.brand.primary_color ?? "#1f8f5f", support_email: me.brand.support_email ?? "" });
      setCustomers((await call("/v1/partner/customers")).data ?? []);
    } catch { setP(null); }
  }, [call]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (p) call(`/v1/partner/revenue?month=${month}`).then(setRev).catch(() => setRev(null)); }, [p, month, call]);
  const clean = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v.trim() !== ""));
  const enroll = async () => {
    try { await call("/v1/partner", { method: "POST", body: JSON.stringify({ name, brand: { display_name: name } }) }); flash("You're a partner. Add your brand and first customer."); load(); }
    catch (e) { flash((e as Error).message); }
  };
  const saveBrand = async () => {
    try { setP(await call("/v1/partner/brand", { method: "PUT", body: JSON.stringify(clean(brand)) })); flash("Brand saved. Your customers now see it."); }
    catch (e) { flash((e as Error).message); }
  };
  const addCustomer = async () => {
    try { const r = await call("/v1/partner/customers", { method: "POST", body: JSON.stringify(clean(cust)) }); flash(`Customer created: act for them with A-Card-Customer: ${r.customer.external_ref ?? r.customer.account_holder_id}`); setCust({ name: "", email: "", external_ref: "" }); load(); }
    catch (e) { flash((e as Error).message); }
  };
  const fmt = (o: Record<string, number> | undefined) => (o && Object.keys(o).length ? Object.entries(o).map(([c, v]) => money(v, c)).join(" + ") : "—");

  if (p === undefined) return <Off text="Loading…" />;
  if (p === null) return (
    <>
      <Head title="Partner program" sub="Embed A-CARD in your platform: create your own customers, put your brand on it, and share in the revenue." />
      <div className="panel panel-pad" style={{ maxWidth: 520 }}>
        <ul style={{ margin: "0 0 14px", paddingLeft: 18, color: "var(--muted)", fontSize: 14 }}>
          <li>One contract and one API key for all your users</li>
          <li>Your name, logo and colour on approvals and the dashboard</li>
          <li>Monthly revenue statements per customer</li>
        </ul>
        <div className="field"><label>PLATFORM NAME</label><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your platform" /></div>
        <button className="btn btn-green" disabled={name.trim().length < 2} onClick={enroll}>Become a partner</button>
      </div>
    </>
  );
  return (
    <>
      <Head title="Partner program" sub={`${p.name} · ${customers.length} customer${customers.length === 1 ? "" : "s"} · fees ${p.terms.volume_bps / 100}% of card volume`} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))", gap: 14 }}>
        <div className="panel panel-pad">
          <div className="eyebrow">YOUR BRAND</div>
          <div className="field"><label>DISPLAY NAME</label><input value={brand.display_name} onChange={(e) => setBrand({ ...brand, display_name: e.target.value })} /></div>
          <div className="field"><label>LOGO URL (HTTPS)</label><input value={brand.logo_url} onChange={(e) => setBrand({ ...brand, logo_url: e.target.value })} placeholder="https://…/logo.png" /></div>
          <div className="field"><label>COLOUR</label><div style={{ display: "flex", gap: 10, alignItems: "center" }}><input type="color" value={brand.primary_color} onChange={(e) => setBrand({ ...brand, primary_color: e.target.value })} style={{ width: 52, height: 40, padding: 2, flex: "none", cursor: "pointer" }} /><span className="mono" style={{ fontSize: 13 }}>{brand.primary_color}</span></div></div>
          <div className="field"><label>SUPPORT EMAIL</label><input value={brand.support_email} onChange={(e) => setBrand({ ...brand, support_email: e.target.value })} /></div>
          <button className="btn btn-green" onClick={saveBrand}>Save brand</button>
        </div>
        <div className="panel panel-pad">
          <div className="eyebrow">ADD A CUSTOMER</div>
          <div className="field"><label>NAME</label><input value={cust.name} onChange={(e) => setCust({ ...cust, name: e.target.value })} /></div>
          <div className="field"><label>EMAIL</label><input value={cust.email} onChange={(e) => setCust({ ...cust, email: e.target.value })} /></div>
          <div className="field"><label>YOUR REFERENCE (OPTIONAL)</label><input value={cust.external_ref} onChange={(e) => setCust({ ...cust, external_ref: e.target.value })} placeholder="user-42" /></div>
          <button className="btn btn-green" disabled={!cust.name || !cust.email} onClick={addCustomer}>Create customer</button>
          <p style={{ fontSize: 12, color: "var(--muted)", marginTop: 10 }}>Then call any API route with your key and the header <span className="mono">A-Card-Customer</span>.</p>
        </div>
      </div>
      <div className="panel panel-pad" style={{ marginTop: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div className="eyebrow">REVENUE STATEMENT</div>
          <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
        </div>
        {!rev ? <Off text="No statement yet." /> : (
          <>
            <div style={{ display: "flex", gap: 24, flexWrap: "wrap", margin: "10px 0" }}>
              <div><div style={th}>Card volume</div><div className="serif" style={{ fontSize: 22 }}>{fmt(rev.volume)}</div></div>
              <div><div style={th}>Active cards</div><div className="serif" style={{ fontSize: 22 }}>{rev.active_cards}</div></div>
              <div><div style={th}>A-CARD fees</div><div className="serif" style={{ fontSize: 22 }}>{fmt(rev.fees.total)}</div></div>
            </div>
            {rev.fees.minimum_top_up > 0 && <p style={{ fontSize: 12, color: "var(--muted)" }}>Includes {money(rev.fees.minimum_top_up, rev.terms.currency)} to reach the monthly minimum of {money(rev.terms.monthly_minimum, rev.terms.currency)}.</p>}
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr><th style={th}>Customer</th><th style={th}>Volume</th><th style={th}>Active cards</th><th style={th}>Transactions</th></tr></thead>
              <tbody>{rev.customers.map((c: any) => {
                const who = customers.find((x) => x.account_holder_id === c.account_holder_id);
                return <tr key={c.account_holder_id}><td style={td}>{who?.name ?? c.account_holder_id}<div style={{ fontSize: 12, color: "var(--muted)" }}>{c.external_ref ?? ""}</div></td><td style={td}>{fmt(c.volume)}</td><td style={td}>{c.active_cards}</td><td style={td}>{c.transactions}</td></tr>;
              })}</tbody>
            </table>
          </>
        )}
      </div>
    </>
  );
}
