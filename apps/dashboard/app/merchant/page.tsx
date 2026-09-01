"use client";

/**
 * The merchant self-service portal — a wholly separate app from the A-CARD
 * console at `/`. Different identity (WorkOS AuthKit via `/v1/merchant-auth/*`
 * and `/v1/merchant-portal/*`, not an A-CARD API key or session), different
 * token storage key, no shared component state with `page.tsx`. That
 * separation is deliberate: nothing a bug here does can reach a wallet, a
 * card, or an A-CARD login, and nothing here needed to touch that file.
 *
 * Built mobile-first on purpose. The single highest-value action in
 * A-MERCHANT is a shop owner confirming "yes, still in stock" from a phone —
 * everything else on this page is secondary to that one tap.
 */

import { useCallback, useEffect, useState } from "react";

const API_URL = process.env.NEXT_PUBLIC_ACARD_API_URL ?? "http://localhost:8787";
const TOKEN_KEY = "acard_merchant_portal_token";

interface Merchant { id: string; name: string; address: { city: string }; status: string; verified: boolean }
interface MerchantUser { id: string; email: string; name: string; role: "owner" | "staff" }
interface Item {
  id: string; sku: string; name: string; unit: string; unitPriceCents: number; currency: string;
  availability: "in_stock" | "low_stock" | "out_of_stock" | "made_to_order"; quantityAvailable?: number;
  leadTimeDays: number; inventoryUpdatedAt: string;
}
interface Health { items: number; fresh: number; aging: number; stale: number; medianInventoryAgeHours: number }
interface TeamInvite { id: string; role: "owner" | "staff"; issuedBy: string; expiresAt: string; createdAt: string }

const SYM: Record<string, string> = { ZAR: "R", USD: "$", NGN: "₦", KES: "KSh" };
const fmt = (cents: number, ccy: string) => `${SYM[ccy] ?? ccy} ${(cents / 100).toLocaleString("en-ZA", { minimumFractionDigits: 2 })}`;

function freshLabel(iso: string): { text: string; cls: string } {
  const hours = (Date.now() - Date.parse(iso)) / 3_600_000;
  if (hours <= 24) return { text: "confirmed today", cls: "active" };
  if (hours <= 24 * 7) return { text: `confirmed ${Math.round(hours / 24)}d ago`, cls: "pending" };
  return { text: `not confirmed in ${Math.round(hours / 24)}d`, cls: "declined" };
}

export default function MerchantPortal() {
  const [token, setToken] = useState("");
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [merchant, setMerchant] = useState<Merchant | null>(null);
  const [user, setUser] = useState<MerchantUser | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [toast, setToast] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [busyItem, setBusyItem] = useState("");
  const [showTeam, setShowTeam] = useState(false);
  const [team, setTeam] = useState<{ users: MerchantUser[]; invites: TeamInvite[] } | null>(null);
  const [teamInviteUrl, setTeamInviteUrl] = useState("");

  // add-item form
  const [nSku, setNSku] = useState("");
  const [nName, setNName] = useState("");
  const [nUnit, setNUnit] = useState("each");
  const [nPrice, setNPrice] = useState("");
  const [nQty, setNQty] = useState("");
  const [nLead, setNLead] = useState("0");

  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(""), 3000); };

  const call = useCallback(
    async (path: string, init: RequestInit = {}) => {
      const res = await fetch(`${API_URL}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error?.message ?? `request failed (${res.status})`);
      return body;
    },
    [token],
  );

  const refresh = useCallback(async () => {
    if (!token) return;
    try {
      const [me, i, h] = await Promise.all([
        call("/v1/merchant-portal/me"),
        call("/v1/merchant-portal/items"),
        call("/v1/merchant-portal/health"),
      ]);
      setMerchant(me.merchant);
      setUser(me.user);
      setItems(i.items ?? []);
      setHealth(h);
      setConnected(true);
      setError("");
    } catch (e) {
      setConnected(false);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [call, token]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const portalToken = params.get("portal_token");
    const portalError = params.get("portal_error");
    if (portalToken) {
      setToken(portalToken);
      window.history.replaceState({}, "", window.location.pathname);
      return;
    }
    if (portalError) {
      setError(portalError);
      setLoading(false);
      window.history.replaceState({}, "", window.location.pathname);
      return;
    }
    const stored = localStorage.getItem(TOKEN_KEY);
    if (stored) setToken(stored);
    else setLoading(false);
  }, []);

  useEffect(() => {
    if (!token) return;
    localStorage.setItem(TOKEN_KEY, token);
    refresh();
  }, [token, refresh]);

  const restate = async (item: Item, availability: Item["availability"], quantity?: number) => {
    setBusyItem(item.id);
    try {
      await call(`/v1/merchant-portal/items/${item.id}/restate`, {
        method: "POST",
        body: JSON.stringify({ availability, quantity_available: quantity }),
      });
      flash(`${item.name} updated.`);
      refresh();
    } catch (e) {
      flash(e instanceof Error ? e.message : "Could not update.");
    } finally {
      setBusyItem("");
    }
  };

  const addItem = async () => {
    if (!nName.trim() || !nSku.trim() || !nPrice) { flash("Name, SKU, and price are required."); return; }
    try {
      await call("/v1/merchant-portal/items", {
        method: "PUT",
        body: JSON.stringify({
          sku: nSku, name: nName, unit: nUnit,
          unit_price_cents: Math.round(Number(nPrice) * 100),
          quantity_available: nQty ? Number(nQty) : undefined,
          lead_time_days: Number(nLead) || 0,
        }),
      });
      flash("Item added.");
      setShowAdd(false);
      setNSku(""); setNName(""); setNPrice(""); setNQty(""); setNLead("0");
      refresh();
    } catch (e) {
      flash(e instanceof Error ? e.message : "Could not add item.");
    }
  };

  const loadTeam = async () => {
    try {
      const res = await call("/v1/merchant-portal/team");
      setTeam({ users: res.users ?? [], invites: res.invites ?? [] });
      setShowTeam(true);
    } catch (e) {
      flash(e instanceof Error ? e.message : "Could not load your team.");
    }
  };

  const inviteStaff = async () => {
    try {
      const res = await call("/v1/merchant-portal/team/invites", { method: "POST", body: JSON.stringify({ role: "staff" }) });
      setTeamInviteUrl(res.invite_url);
      loadTeam();
    } catch (e) {
      flash(e instanceof Error ? e.message : "Could not create an invite.");
    }
  };

  const logout = async () => {
    try { await call("/v1/merchant-portal/logout", { method: "POST" }); } catch { /* best effort */ }
    localStorage.removeItem(TOKEN_KEY);
    setToken("");
    setConnected(false);
    setMerchant(null);
  };

  if (loading) return <div><div className="hint" style={{ padding: 40 }}>Loading…</div></div>;

  if (!connected) {
    return (
      <div>
        <div style={{ maxWidth: 420, margin: "80px auto", padding: "0 20px" }}>
          <div className="panel panel-pad">
            <h2 style={{ marginTop: 0 }}>A-MERCHANT portal</h2>
            <div className="hint">
              {error
                ? `Couldn't sign you in: ${error}`
                : "There's no self-serve signup — ask A-CARD for an invite link to your shop's portal."}
            </div>
            <button
              className="hint"
              style={{ display: "inline-block", marginTop: 14, background: "none", border: "none", padding: 0, cursor: "pointer", textDecoration: "underline" }}
              onClick={() => { localStorage.removeItem("acard_last_product"); window.location.href = "/"; }}
            >
              ← Not a merchant? Go to A-CARD
            </button>
          </div>
        </div>
        {toast && <div id="toast" className="on">{toast}</div>}
      </div>
    );
  }

  return (
    <div>
      <div style={{ maxWidth: 640, margin: "0 auto", padding: "24px 16px 100px" }}>
        <div className="page-head">
          <div className="page-title">{merchant?.name}</div>
          <div className="page-sub">{user?.name} · {user?.role} · {merchant?.address.city}</div>
        </div>

        {health && (
          <div className="stats" style={{ marginBottom: 20 }}>
            <div className="stat"><div className="head"><span className="lbl">Items</span></div><div className="val">{health.items}</div></div>
            <div className="stat"><div className="head"><span className="lbl">Fresh</span></div><div className="val">{health.fresh}/{health.items}</div><div className="foot">confirmed in 24h</div></div>
            <div className="stat"><div className="head"><span className="lbl">Stale</span></div><div className="val">{health.stale}</div><div className="foot">need confirming</div></div>
          </div>
        )}

        <div className="panel-head"><h2>Your catalog</h2><button className="btn btn-green" onClick={() => setShowAdd(true)}>+ Add item</button></div>

        {items.length === 0 ? (
          <div className="panel"><div className="empty-box" style={{ border: "none", padding: "40px 20px" }}>
            <div className="empty-t">No items yet</div>
            <div className="empty-s">Add what you sell — agents can only find items you've listed.</div>
          </div></div>
        ) : (
          <div className="stack">
            {items.map((item) => {
              const fresh = freshLabel(item.inventoryUpdatedAt);
              const busy = busyItem === item.id;
              return (
                <div className="panel panel-pad" key={item.id}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start", gap: 12 }}>
                    <div>
                      <div style={{ fontWeight: 600 }}>{item.name}</div>
                      <div className="hint">{fmt(item.unitPriceCents, item.currency)} / {item.unit}{item.quantityAvailable !== undefined ? ` · ${item.quantityAvailable} on hand` : ""}</div>
                    </div>
                    <span className={`pill ${fresh.cls}`}>{fresh.text}</span>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginTop: 14 }}>
                    <button
                      className="btn btn-green"
                      style={{ padding: "14px 8px", opacity: item.availability === "in_stock" ? 1 : 0.55 }}
                      disabled={busy}
                      onClick={() => restate(item, "in_stock", item.quantityAvailable)}
                    >
                      In stock
                    </button>
                    <button
                      className="btn btn-outline"
                      style={{ padding: "14px 8px", opacity: item.availability === "low_stock" ? 1 : 0.55 }}
                      disabled={busy}
                      onClick={() => restate(item, "low_stock", item.quantityAvailable)}
                    >
                      Low stock
                    </button>
                    <button
                      className="btn btn-outline"
                      style={{ padding: "14px 8px", opacity: item.availability === "out_of_stock" ? 1 : 0.55 }}
                      disabled={busy}
                      onClick={() => restate(item, "out_of_stock", 0)}
                    >
                      Out of stock
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {user?.role === "owner" && (
          <div className="panel panel-pad" style={{ marginTop: 20 }}>
            <div className="panel-head"><h2>Team</h2><button className="btn btn-outline" onClick={loadTeam}>Manage</button></div>
            <div className="hint">Invite whoever else needs to update stock — a shop assistant doesn&apos;t need you to do it for them.</div>
          </div>
        )}

        <button className="btn btn-outline" style={{ marginTop: 24 }} onClick={logout}>Sign out</button>
      </div>

      {showAdd && (
        <div className="modal-back on" onClick={(e) => { if (e.target === e.currentTarget) setShowAdd(false); }}>
          <div className="modal">
            <h3>Add an item</h3>
            <div className="field"><label>name</label><input value={nName} onChange={(e) => setNName(e.target.value)} placeholder="Cement 50kg" /></div>
            <div className="field" style={{ marginTop: 12 }}><label>SKU</label><input value={nSku} onChange={(e) => setNSku(e.target.value)} placeholder="CEM-50" /></div>
            <div className="filters" style={{ marginTop: 12 }}>
              <input value={nUnit} onChange={(e) => setNUnit(e.target.value)} placeholder="unit (bag, each…)" />
              <input className="mono" value={nPrice} onChange={(e) => setNPrice(e.target.value)} placeholder="price (R)" />
            </div>
            <div className="filters" style={{ marginTop: 12 }}>
              <input className="mono" value={nQty} onChange={(e) => setNQty(e.target.value)} placeholder="qty on hand" />
              <input className="mono" value={nLead} onChange={(e) => setNLead(e.target.value)} placeholder="lead time (days)" />
            </div>
            <div className="modal-actions"><button className="btn btn-outline" style={{ flex: "0 0 auto" }} onClick={() => setShowAdd(false)}>Cancel</button><button className="btn btn-green" onClick={addItem}>Add</button></div>
          </div>
        </div>
      )}

      {showTeam && (
        <div className="modal-back on" onClick={(e) => { if (e.target === e.currentTarget) { setShowTeam(false); setTeamInviteUrl(""); } }}>
          <div className="modal">
            <h3>Team</h3>
            <div className="hint" style={{ margin: "6px 0 16px" }}>Everyone who can sign in and update your catalog.</div>
            {team && team.users.length > 0 && (
              <div className="stack" style={{ marginBottom: team.invites.length > 0 ? 16 : 0 }}>
                {team.users.map((u) => (
                  <div key={u.id} style={{ display: "flex", justifyContent: "space-between" }}>
                    <span>{u.name} <span className="hint">{u.email}</span></span>
                    <span className="pill active">{u.role}</span>
                  </div>
                ))}
              </div>
            )}
            {team && team.invites.length > 0 && (
              <div className="stack">
                {team.invites.map((i) => (
                  <div key={i.id} style={{ display: "flex", justifyContent: "space-between" }}>
                    <span className="hint">invited by {i.issuedBy}</span>
                    <span className="pill pending">pending</span>
                  </div>
                ))}
              </div>
            )}
            <button className="btn btn-green" style={{ marginTop: 16 }} onClick={inviteStaff}>Invite a colleague</button>
            {teamInviteUrl && (
              <div className="cmd" style={{ marginTop: 10 }}>
                <span>{teamInviteUrl}</span>
                <button className="cmd-copy" onClick={() => { navigator.clipboard?.writeText(teamInviteUrl).catch(() => {}); flash("Copied."); }}><Icon2 /></button>
              </div>
            )}
            <div className="modal-actions"><button className="btn btn-outline" style={{ flex: "0 0 auto" }} onClick={() => { setShowTeam(false); setTeamInviteUrl(""); }}>Close</button></div>
          </div>
        </div>
      )}

      {toast && <div id="toast" className="on">{toast}</div>}
    </div>
  );
}

/** Tiny inline copy icon — this page deliberately carries no icon system of its own. */
function Icon2() {
  return (
    <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="11.5" height="11.5" rx="2.2" />
      <path d="M5 15a2 2 0 0 1-2-2V5.5a2 2 0 0 1 2-2h7.5a2 2 0 0 1 2 2" />
    </svg>
  );
}
