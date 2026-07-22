"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

const API_URL = process.env.NEXT_PUBLIC_ACARD_API_URL ?? "http://localhost:8787";

/* ------------------------------------------------------------------ icons */
const ICONS: Record<string, string> = {
  home: '<path d="M3 9.6 12 3l9 6.6"/><path d="M5 9.5V21h14V9.5"/><path d="M9.5 21v-6h5v6"/>',
  card: '<rect x="2.5" y="5" width="19" height="14" rx="2.4"/><path d="M2.5 9.5h19"/>',
  swap: '<path d="M7 4 3 8l4 4"/><path d="M3 8h13"/><path d="M17 20l4-4-4-4"/><path d="M21 16H8"/>',
  wallet: '<rect x="3" y="6" width="18" height="13" rx="2.4"/><path d="M3 10.5h18"/><circle cx="16.5" cy="14.5" r="1.2"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2.2"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/><path d="M9 2.5v3M15 2.5v3M9 18.5v3M15 18.5v3M2.5 9h3M2.5 15h3M18.5 9h3M18.5 15h3"/>',
  shieldCheck: '<path d="M12 3l7 3v5c0 4.6-3 7.6-7 9-4-1.4-7-4.4-7-9V6z"/><path d="M9 12l2 2 4-4"/>',
  users: '<circle cx="9" cy="8" r="3.2"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 5.2a3.2 3.2 0 0 1 0 6.1"/><path d="M17.5 14.2A6.5 6.5 0 0 1 21.5 20"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  upRight: '<path d="M7 17 17 7"/><path d="M8 7h9v9"/>',
  check: '<path d="M5 12.5l4.4 4.4L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5l3 2"/>',
  updown: '<path d="M8 9l4-4 4 4"/><path d="M16 15l-4 4-4-4"/>',
  right: '<path d="M9 6l6 6-6 6"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  copy: '<rect x="9" y="9" width="11.5" height="11.5" rx="2.2"/><path d="M5 15a2 2 0 0 1-2-2V5.5a2 2 0 0 1 2-2h7.5a2 2 0 0 1 2 2"/>',
  spark: '<path d="M12 3l1.7 4.6L18.4 9l-4.7 1.4L12 15l-1.7-4.6L5.6 9l4.7-1.4z"/><path d="M19 14l.7 1.9 2 .6-2 .7L19 20l-.7-1.8-2-.7 2-.6z"/>',
  book: '<path d="M12 6.2C10.6 5.2 8.2 4.7 6.2 4.7S2.9 5.1 2.5 5.6v13c.4-.5 2.4-.9 3.7-.9s4.4.5 5.8 1.5c1.4-1 3.9-1.5 5.8-1.5s3.3.4 3.7.9v-13c-.4-.5-2.4-.9-3.7-.9S13.4 5.2 12 6.2z"/><path d="M12 6.2v13"/>',
  help: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.3"/><path d="M4.9 4.9 8 8M16 16l3.1 3.1M16 8l3.1-3.1M4.9 19.1 8 16"/>',
  code: '<path d="M8.5 8 4.5 12l4 4"/><path d="M15.5 8l4 4-4 4"/>',
  bot: '<rect x="4" y="8" width="16" height="11" rx="3"/><path d="M12 4.5v3.5"/><circle cx="12" cy="3.4" r="1.1"/><circle cx="9.2" cy="13" r="1.1" fill="currentColor" stroke="none"/><circle cx="14.8" cy="13" r="1.1" fill="currentColor" stroke="none"/><path d="M2.5 12v3M21.5 12v3"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M5 5l1.4 1.4M17.6 17.6 19 19M2.5 12h2M19.5 12h2M5 19l1.4-1.4M17.6 6.4 19 5"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  asterisk: '<path d="M12 4v16M4.8 7.6l14.4 8.8M19.2 7.6 4.8 16.4"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2.2"/><path d="M7 9l3 3-3 3M13 15h4"/>',
  box: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4.3 7.7 12 12l7.7-4.3M12 12v9"/>',
  plug: '<path d="M9 3v5M15 3v5"/><path d="M7 8h10v3a5 5 0 0 1-10 0z"/><path d="M12 16.5V21"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>',
};
function Icon({ name, size }: { name: string; size?: number }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: ICONS[name] ?? "" }}
    />
  );
}

/* ------------------------------------------------------------------ types */
interface Wallet { available: number; posted: number; held: number; currency: string }
interface Card { id: string; label?: string; last4: string; status: string; currency: string; singleUse: boolean; createdAt: string }
interface Txn { id: string; merchantName: string; amount: number; currency: string; status: string; declineReason?: string; createdAt: string }
interface Approval { id: string; merchantName: string; amount: number; currency: string; reason: string; createdAt: string }
interface Member { user: { id: string; email: string; name: string }; role: string }
interface Holder { id: string; email: string; name: string; currency: string; subscriptionTier: string }

type Role = "owner" | "admin" | "member" | "viewer";
const RANK: Record<Role, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };
const can = (role: Role | null, min: Role) => !!role && RANK[role] >= RANK[min];

const SYM: Record<string, string> = { ZAR: "R", USD: "$", NGN: "₦", KES: "KSh" };
function fmt(cents: number, ccy: string) {
  return `${SYM[ccy] ?? ccy} ${(cents / 100).toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const NAV: { view: string; label: string; icon: string; crumb?: string; min?: Role }[] = [
  { view: "overview", label: "Home", icon: "home", crumb: "Home" },
  { view: "cards", label: "Manage cards", icon: "card", crumb: "Cards" },
  { view: "spending", label: "Track spending", icon: "swap", crumb: "Spending" },
  { view: "wallet", label: "Wallet", icon: "wallet" },
  { view: "approvals", label: "Approvals", icon: "shieldCheck" },
  { view: "connect", label: "Connect agents", icon: "cpu" },
  { view: "team", label: "Team", icon: "users", min: "admin" },
];

const CONNECT: Record<string, { icon: string; cmd: (o: string) => string }> = {
  Claude: { icon: "asterisk", cmd: (o) => `claude mcp add --transport http acard ${o}/mcp` },
  Codex: { icon: "terminal", cmd: (o) => `codex mcp add acard --url ${o}/mcp` },
  Cursor: { icon: "box", cmd: (o) => `{ "acard": { "url": "${o}/mcp" } }` },
  Other: { icon: "plug", cmd: (o) => `Authorization: Bearer ak_live_…  →  ${o}/mcp` },
};

/* ================================================================== app */
export default function Dashboard() {
  const [token, setToken] = useState("");
  const [role, setRole] = useState<Role | null>(null);
  const [holder, setHolder] = useState<Holder | null>(null);
  const [connected, setConnected] = useState(false);
  const [view, setView] = useState("overview");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [error, setError] = useState("");

  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [cards, setCards] = useState<Card[]>([]);
  const [txns, setTxns] = useState<Txn[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [members, setMembers] = useState<Member[]>([]);

  // auth form
  const [mode, setMode] = useState<"login" | "register" | "apikey">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [apiKeyInput, setApiKeyInput] = useState("");

  // modals & inputs
  const [showCreate, setShowCreate] = useState(false);
  const [showFund, setShowFund] = useState(false);
  const [cardLabel, setCardLabel] = useState("");
  const [cardCcy, setCardCcy] = useState("ZAR");
  const [fundCcy, setFundCcy] = useState("ZAR");
  const [fundAmt, setFundAmt] = useState("500000");
  const [inviteEmail, setInviteEmail] = useState("");
  const [invitePassword, setInvitePassword] = useState("");
  const [inviteRole, setInviteRole] = useState<Role>("member");
  const [spendQ, setSpendQ] = useState("");
  const [spendStatus, setSpendStatus] = useState("");
  const [connectTab, setConnectTab] = useState("Claude");
  const [toast, setToast] = useState("");

  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(""), 3000); };

  const call = useCallback(
    async (path: string, init: RequestInit = {}, authToken = token) => {
      const res = await fetch(`${API_URL}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${authToken}`, "content-type": "application/json", ...(init.headers ?? {}) },
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
      const me = await call("/v1/auth/me").catch(() => null);
      const currentRole: Role = me?.role ?? "owner";
      setRole(currentRole);
      setHolder(me?.account_holder ?? null);
      const reqs: Promise<any>[] = [call("/v1/wallet"), call("/v1/cards"), call("/v1/transactions"), call("/v1/approvals?status=pending")];
      if (can(currentRole, "admin")) reqs.push(call("/v1/auth/members").catch(() => ({ members: [] })));
      const [w, c, t, a, m] = await Promise.all(reqs);
      setWallets(w.wallets ?? (w.wallet ? [w.wallet] : []));
      setCards(c.cards ?? []);
      setTxns(t.transactions ?? []);
      setApprovals(a.approvals ?? []);
      setMembers(m?.members ?? []);
      setConnected(true);
      setError("");
    } catch (e) {
      setConnected(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [call, token]);

  useEffect(() => { const s = localStorage.getItem("acard_token"); if (s) setToken(s); }, []);
  useEffect(() => {
    if (!token) return;
    localStorage.setItem("acard_token", token);
    refresh();
    const id = setInterval(refresh, 6000);
    return () => clearInterval(id);
  }, [token, refresh]);

  const authenticate = async (path: string, payload: object) => {
    setError("");
    try {
      const res = await fetch(`${API_URL}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error?.message ?? `request failed (${res.status})`);
      setToken(body.session_token);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const signOut = async () => {
    if (token.startsWith("sess_")) await call("/v1/auth/logout", { method: "POST" }).catch(() => {});
    localStorage.removeItem("acard_token");
    setToken(""); setRole(null); setConnected(false); setHolder(null); setView("overview");
  };

  const toggleTheme = () => {
    const root = document.documentElement;
    const cur = root.getAttribute("data-theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    root.setAttribute("data-theme", cur === "dark" ? "light" : "dark");
  };

  const readOnly = !can(role, "member");
  const primaryCcy = holder?.currency ?? "ZAR";
  const primaryWallet = useMemo(
    () => wallets.find((w) => w.currency === primaryCcy) ?? wallets[0],
    [wallets, primaryCcy],
  );
  const activeCards = cards.filter((c) => c.status === "active").length;
  const origin = API_URL;

  const doCreateCard = async () => {
    try {
      await call("/v1/cards", { method: "POST", body: JSON.stringify({ label: cardLabel || undefined, currency: cardCcy, single_use: true }) });
      setShowCreate(false); setCardLabel(""); refresh(); flash("Card created."); setView("cards");
    } catch (e) { flash(e instanceof Error ? e.message : "Could not create card"); }
  };
  const doFund = async () => {
    try {
      const amt = parseInt(fundAmt, 10);
      if (amt > 0) { await call("/v1/wallet/fund", { method: "POST", body: JSON.stringify({ amount: amt, currency: fundCcy }) }); flash(`Added ${fmt(amt, fundCcy)}.`); }
      setShowFund(false); refresh();
    } catch (e) { flash(e instanceof Error ? e.message : "Could not add funds"); }
  };
  const decide = async (id: string, ok: boolean) => {
    try { await call(`/v1/approvals/${id}/${ok ? "approve" : "deny"}`, { method: "POST" }); refresh(); flash(ok ? "Approved." : "Denied."); }
    catch (e) { flash(e instanceof Error ? e.message : "Could not update approval"); }
  };
  const invite = async () => {
    try {
      await call("/v1/auth/members", { method: "POST", body: JSON.stringify({ email: inviteEmail, password: invitePassword, role: inviteRole }) });
      setInviteEmail(""); setInvitePassword(""); refresh(); flash("Member added.");
    } catch (e) { flash(e instanceof Error ? e.message : "Could not add member"); }
  };

  const goto = (v: string) => { setView(v); setSidebarOpen(false); window.scrollTo({ top: 0 }); };
  const crumb = NAV.find((n) => n.view === view)?.crumb ?? NAV.find((n) => n.view === view)?.label ?? "Home";
  const orgInitial = (holder?.name ?? "A").slice(0, 1).toUpperCase();

  /* -------------------------------------------------- login screen */
  if (!connected) {
    return (
      <section id="login">
        <span className="login-chip lc1">budget <span className="g">R500</span></span>
        <span className="login-chip lc2">one-time use</span>
        <span className="login-chip lc3">groceries only</span>
        <span className="login-chip lc4">ask me over <span className="a">R250</span></span>
        <div className="login-card">
          <div className="wordmark">a<span className="dot">·</span>card</div>
          <div className="login-title">Give your agent<br />a <span className="em">card</span>.</div>
          <div className="login-sub">Sign in to your console.</div>

          <div className="seg" style={{ marginTop: 18 }}>
            <button className={mode === "login" ? "sel" : ""} onClick={() => setMode("login")}>Sign in</button>
            <button className={mode === "register" ? "sel" : ""} onClick={() => setMode("register")}>Create account</button>
            <button className={mode === "apikey" ? "sel" : ""} onClick={() => setMode("apikey")}>API key</button>
          </div>

          {mode === "apikey" ? (
            <form onSubmit={(e) => { e.preventDefault(); setToken(apiKeyInput.trim()); }}>
              <div className="field"><label>api key</label><input type="password" placeholder="ak_live_…" value={apiKeyInput} onChange={(e) => setApiKeyInput(e.target.value)} /></div>
              <button type="submit" className="btn btn-green login-btn">Connect</button>
            </form>
          ) : (
            <form onSubmit={(e) => { e.preventDefault(); mode === "register" ? authenticate("/v1/auth/register", { email, name, password }) : authenticate("/v1/auth/login", { email, password }); }}>
              {mode === "register" && <div className="field"><label>your name</label><input value={name} onChange={(e) => setName(e.target.value)} /></div>}
              <div className="field"><label>work email</label><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
              <div className="field"><label>password{mode === "register" ? " (min 8 chars)" : ""}</label><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></div>
              <button type="submit" className="btn btn-green login-btn">{mode === "register" ? "Create account" : "Sign in"}</button>
            </form>
          )}
          {error && <div className="login-note" style={{ color: "var(--red)" }}>{error}</div>}
          <div className="login-note">Connect the API (<strong>npm run dev:api</strong>) and sign in, or paste an API key.</div>
        </div>
      </section>
    );
  }

  /* -------------------------------------------------- connect panel */
  const connectPanel = (
    <>
      <div className="panel-head"><h2>Connect your agent</h2></div>
      <div className="connect-tabs">
        {Object.keys(CONNECT).map((k) => (
          <button key={k} className={`ctab ${k === connectTab ? "sel" : ""}`} onClick={() => setConnectTab(k)}>
            <Icon name={CONNECT[k].icon} /> {k}
          </button>
        ))}
      </div>
      <div className="hint" style={{ marginTop: 12 }}>One command, then ask it to create cards for you.</div>
      <div className="cmd">
        <span>{CONNECT[connectTab].cmd(origin)}</span>
        <button className="cmd-copy" onClick={() => { navigator.clipboard?.writeText(CONNECT[connectTab].cmd(origin)).catch(() => {}); flash("Copied."); }}><Icon name="copy" /></button>
      </div>
      <div className="hint" style={{ marginTop: 12 }}>Then run <span className="mono" style={{ color: "var(--ink)" }}>/mcp</span> to authenticate.</div>
    </>
  );

  /* -------------------------------------------------- views */
  const pendingCount = approvals.length;

  return (
    <div id="app" className="on">
      <aside className={`sidebar${sidebarOpen ? " open" : ""}`}>
        <div className="side-acct">
          <div className="acct-badge">{orgInitial}</div>
          <div className="who"><div className="n">{holder?.name ?? "Account"}</div><div className="e">{holder?.email ?? ""}</div></div>
          <span className="chev"><Icon name="updown" /></span>
        </div>
        <nav className="side-nav">
          {NAV.filter((n) => !n.min || can(role, n.min)).map((n) => (
            <button key={n.view} className={`nav-item${view === n.view ? " active" : ""}`} onClick={() => goto(n.view)}>
              <Icon name={n.icon} /><span>{n.label}</span>
              {n.view === "approvals" && pendingCount > 0 && (
                <span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: 11, background: "var(--amber-bg)", color: "var(--amber)", borderRadius: 999, padding: "1px 7px" }}>{pendingCount}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="side-spacer" />
        <div className="side-wallet">
          <div className="top"><span>Wallet · {primaryCcy}</span><span><Icon name="wallet" size={16} /></span></div>
          <div className="amt mono">{primaryWallet ? fmt(primaryWallet.available, primaryWallet.currency) : fmt(0, primaryCcy)}</div>
          {!readOnly && <button className="add" onClick={() => goto("wallet")}>Add funds</button>}
        </div>
        <div className="side-foot">
          <button className="foot-item"><Icon name="spark" /> What&apos;s new</button>
          <button className="foot-item"><Icon name="book" /> Read the docs</button>
          <button className="foot-item"><Icon name="help" /> Get help</button>
        </div>
        <div className="side-divider" />
        <button className="side-acct" style={{ width: "100%", background: "none", border: "none" }} onClick={signOut}>
          <div className="acct-badge grey"><Icon name="logout" size={16} /></div>
          <div className="who"><div className="n">Sign out</div><div className="e">{holder?.email ?? ""}</div></div>
        </button>
      </aside>

      <div className="main-col">
        <header className="topbar">
          <button className="icon-btn menu-btn" onClick={() => setSidebarOpen((v) => !v)} aria-label="Menu"><Icon name="menu" size={16} /></button>
          <div className="crumbs"><span>{holder?.name ?? "Personal"}</span><span className="sep"><Icon name="right" size={14} /></span><span className="cur">{crumb}</span></div>
          <div className="spacer" />
          <button className="icon-btn" onClick={toggleTheme} title="Toggle theme"><Icon name="moon" size={16} /></button>
          <button className="btn btn-dark" onClick={signOut}>Sign out</button>
        </header>

        <main className="main">
          {error && <div className="panel panel-pad" style={{ marginBottom: 18, color: "var(--red)" }}>{error}</div>}

          {/* OVERVIEW */}
          {view === "overview" && (
            <>
              <div className="page-head"><div className="page-title">Home</div><div className="page-sub">Your cards, balance, and agent activity at a glance.</div></div>
              <div className="stack">
                <div className="stats">
                  <div className="stat"><div className="head"><span className="lbl">Wallet · {primaryCcy}</span></div><div className="val">{primaryWallet ? fmt(primaryWallet.available, primaryWallet.currency) : fmt(0, primaryCcy)}</div><div className="foot">{wallets.filter((w) => w.currency !== primaryCcy).map((w) => `${w.currency} ${fmt(w.available, w.currency)} available`).join(" · ") || "Prepaid balance"}</div></div>
                  <div className="stat"><div className="head"><span className="lbl">Active cards</span></div><div className="val">{activeCards}</div><div className="foot">{cards.length} issued in total</div></div>
                  <div className="stat"><div className="head"><span className="lbl">Plan</span></div><div className="val serif" style={{ textTransform: "capitalize" }}>{holder?.subscriptionTier ?? "Free"}</div><div className="foot">Subscription tier</div></div>
                </div>
                <div className="cols">
                  <div className="panel panel-pad">
                    <div className="panel-head"><h2>Recent activity</h2></div>
                    {txns.length === 0 ? (
                      <div className="empty-box" style={{ border: "none", padding: "34px 16px" }}>
                        <div className="empty-ico"><Icon name="swap" size={24} /></div>
                        <div className="empty-t">No activity yet</div>
                        <div className="empty-s">Charges appear here the moment one of your cards is used.</div>
                      </div>
                    ) : <Feed rows={txns.slice(0, 6)} cards={cards} />}
                  </div>
                  <div className="panel panel-pad">{connectPanel}</div>
                </div>
              </div>
            </>
          )}

          {/* CARDS */}
          {view === "cards" && (
            <>
              <div className="page-head">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 16, flexWrap: "wrap" }}>
                  <div><div className="page-title">Cards</div><div className="page-sub">Virtual cards, funded from your balance.</div></div>
                  {!readOnly && <button className="btn btn-green" onClick={() => setShowCreate(true)}><Icon name="plus" /> Create card</button>}
                </div>
              </div>
              <div className="panel panel-pad">
                {cards.length === 0 ? (
                  <div className="empty-box">
                    <div className="empty-ico"><Icon name="card" size={24} /></div>
                    <div className="empty-t">No cards yet</div>
                    <div className="empty-s">Create one and hand it to your agent, or ask your agent to create it for you.</div>
                    {!readOnly && <button className="btn btn-green" onClick={() => setShowCreate(true)}><Icon name="plus" /> Create card</button>}
                  </div>
                ) : (
                  <div style={{ overflowX: "auto" }}>
                    <table className="grid">
                      <thead><tr><th>Card</th><th>Agent</th><th>Ccy</th><th>Type</th><th>Status</th></tr></thead>
                      <tbody>
                        {cards.map((c) => (
                          <tr key={c.id}>
                            <td><div className={`card-mini ${c.currency === "USD" ? "usd" : ""}`}><div className="cm-chip" /><div className="cm-brand">a·card</div><div className="cm-num">•{c.last4}</div></div></td>
                            <td><div style={{ fontWeight: 600 }}>{c.label ?? <span className="tag">—</span>}</div><div className="tag">•••• {c.last4}</div></td>
                            <td className="mono">{c.currency}</td>
                            <td className="tag">{c.singleUse ? "single-use" : "multi-use"}</td>
                            <td><span className={`pill ${c.status}`}>{c.status}</span></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </>
          )}

          {/* SPENDING */}
          {view === "spending" && (
            <>
              <div className="page-head"><div className="page-title">Spending</div><div className="page-sub">Every charge across your cards, newest first.</div></div>
              <div className="filters">
                <input placeholder="Filter by merchant…" value={spendQ} onChange={(e) => setSpendQ(e.target.value)} />
                <select value={spendStatus} onChange={(e) => setSpendStatus(e.target.value)}>
                  <option value="">All statuses</option><option value="completed">Completed</option><option value="declined">Declined</option><option value="pending">Pending</option>
                </select>
              </div>
              <div className="panel panel-pad">
                {(() => {
                  const rows = txns.filter((t) => t.merchantName.toLowerCase().includes(spendQ.toLowerCase()) && (!spendStatus || t.status === spendStatus));
                  return rows.length === 0
                    ? <div className="empty">No activity yet. Charges appear here the moment one of your cards is used.</div>
                    : <Feed rows={rows.slice(0, 40)} cards={cards} />;
                })()}
              </div>
            </>
          )}

          {/* WALLET */}
          {view === "wallet" && (
            <>
              <div className="page-head">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 16, flexWrap: "wrap" }}>
                  <div><div className="page-title">Wallet</div><div className="page-sub">Prepaid balance, one wallet per currency.</div></div>
                  {!readOnly && <button className="btn btn-green" onClick={() => setShowFund(true)}><Icon name="plus" /> Add funds</button>}
                </div>
              </div>
              <div className="panel panel-pad">
                <div className="wallets">
                  {(wallets.length ? wallets : [{ available: 0, posted: 0, held: 0, currency: primaryCcy }]).map((w) => (
                    <div className="wallet" key={w.currency}>
                      <div className="ccy"><div><span className="ccy-tag">{w.currency}</span> <span className="ccy-name">{w.currency === "USD" ? "US Dollar" : w.currency === "ZAR" ? "South African Rand" : w.currency}</span></div></div>
                      <div className="avail">{fmt(w.available, w.currency)}</div>
                      <div className="sub"><span>On hold <b>{fmt(w.held, w.currency)}</b></span><span>Posted <b>{fmt(w.posted, w.currency)}</b></span></div>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}

          {/* APPROVALS */}
          {view === "approvals" && (
            <>
              <div className="page-head"><div className="page-title">Approvals</div><div className="page-sub">Charges above a card&apos;s threshold wait here for your decision.</div></div>
              <div className="panel panel-pad">
                {approvals.length === 0 ? (
                  <div className="empty">Nothing waiting on you. Charges above a card&apos;s threshold land here.</div>
                ) : (
                  <div style={{ display: "grid", gap: 12 }}>
                    {approvals.map((a) => (
                      <div className="approval" key={a.id}>
                        <div className="a-top"><div><div className="a-amt">{fmt(a.amount, a.currency)}</div><div className="a-why">{a.merchantName}</div></div><span className="pill pending">review</span></div>
                        <div className="a-why">{a.reason}</div>
                        <div className="a-actions">
                          <button className="btn-sm btn-approve" disabled={readOnly} onClick={() => decide(a.id, true)}><Icon name="check" /> Approve</button>
                          <button className="btn-sm btn-deny" disabled={readOnly} onClick={() => decide(a.id, false)}><Icon name="x" /> Deny</button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}

          {/* CONNECT */}
          {view === "connect" && (
            <>
              <div className="page-head"><div className="page-title">Connect agents</div><div className="page-sub">Apps and agents you&apos;ve authorized. Each one only ever sees the cards it created.</div></div>
              <div className="cols">
                <div className="panel"><div className="empty-box" style={{ border: "none", padding: "40px 24px" }}>
                  <div className="empty-ico"><Icon name="bot" size={24} /></div>
                  <div className="empty-t">No connected agents yet</div>
                  <div className="empty-s">Connect Claude or any MCP client and it can create and manage cards for you by chat.</div>
                </div></div>
                <div className="panel panel-pad">{connectPanel}</div>
              </div>
            </>
          )}

          {/* TEAM */}
          {view === "team" && can(role, "admin") && (
            <>
              <div className="page-head"><div className="page-title">Team</div><div className="page-sub">People with access to this account, and what they can do.</div></div>
              <div className="stack">
                <div className="panel panel-pad">
                  <div className="panel-head"><h2>Add a member</h2></div>
                  <div className="filters">
                    <input placeholder="teammate email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} />
                    <input type="password" placeholder="starting password" value={invitePassword} onChange={(e) => setInvitePassword(e.target.value)} />
                    <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value as Role)}>
                      <option value="viewer">viewer</option><option value="member">member</option><option value="admin">admin</option><option value="owner">owner</option>
                    </select>
                    <button className="btn btn-green" onClick={invite}><Icon name="plus" /> Add</button>
                  </div>
                </div>
                <div className="panel panel-pad">
                  <div style={{ overflowX: "auto" }}>
                    <table className="grid">
                      <thead><tr><th>Email</th><th>Name</th><th>Role</th></tr></thead>
                      <tbody>
                        {members.map((m) => (
                          <tr key={m.user.id}><td>{m.user.email}</td><td>{m.user.name}</td><td><span className="pill active">{m.role}</span></td></tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </>
          )}
        </main>
      </div>

      {/* CREATE CARD MODAL */}
      {showCreate && (
        <div className="modal-back on" onClick={(e) => { if (e.target === e.currentTarget) setShowCreate(false); }}>
          <div className="modal">
            <h3>Create a card</h3>
            <div className="hint" style={{ margin: "6px 0 16px" }}>A single-use virtual card, funded from your balance.</div>
            <div className="field"><label>agent / purpose</label><input value={cardLabel} onChange={(e) => setCardLabel(e.target.value)} placeholder="e.g. Grocery agent" /></div>
            <div className="field" style={{ marginTop: 12 }}><label>currency</label>
              <div className="seg">{["ZAR", "USD"].map((c) => <button key={c} className={cardCcy === c ? "sel" : ""} onClick={() => setCardCcy(c)}>{c}</button>)}</div>
            </div>
            <div className="modal-actions"><button className="btn btn-outline" style={{ flex: "0 0 auto" }} onClick={() => setShowCreate(false)}>Cancel</button><button className="btn btn-green" onClick={doCreateCard}>Create card</button></div>
          </div>
        </div>
      )}

      {/* FUND MODAL */}
      {showFund && (
        <div className="modal-back on" onClick={(e) => { if (e.target === e.currentTarget) setShowFund(false); }}>
          <div className="modal">
            <h3>Add funds</h3>
            <div className="hint" style={{ margin: "6px 0 16px" }}>Top up a prepaid wallet.</div>
            <div className="field"><label>currency</label><div className="seg">{["ZAR", "USD"].map((c) => <button key={c} className={fundCcy === c ? "sel" : ""} onClick={() => setFundCcy(c)}>{c}</button>)}</div></div>
            <div className="field" style={{ marginTop: 12 }}><label>amount</label><input className="mono" value={fundAmt} onChange={(e) => setFundAmt(e.target.value)} /><div className="hint" style={{ marginTop: 4 }}>In cents. 500000 = {fmt(500000, fundCcy)}</div></div>
            <div className="modal-actions"><button className="btn btn-outline" style={{ flex: "0 0 auto" }} onClick={() => setShowFund(false)}>Cancel</button><button className="btn btn-green" onClick={doFund}>Add funds</button></div>
          </div>
        </div>
      )}

      {toast && <div id="toast" className="on">{toast}</div>}
    </div>
  );
}

/* ---------------------------------------------------------- feed helper */
function Feed({ rows, cards }: { rows: Txn[]; cards: Card[] }) {
  const icon = (t: Txn): [string, string] =>
    t.status === "declined" ? (t.declineReason === "pending_human_approval" ? ["hold", "clock"] : ["no", "x"]) : ["ok", "check"];
  return (
    <div className="feed">
      {rows.map((t) => {
        const [cls, ic] = icon(t);
        return (
          <div className="feed-row" key={t.id}>
            <div className={`feed-ico ${cls}`}><Icon name={ic} size={16} /></div>
            <div>
              <div className="feed-main">{t.merchantName}</div>
              <div className="feed-meta"><span className={`pill ${t.status}`}>{t.status}</span>{t.declineReason && t.status === "declined" ? ` · ${t.declineReason}` : ""}</div>
            </div>
            <div className="feed-amt">{fmt(t.amount, t.currency)}</div>
          </div>
        );
      })}
    </div>
  );
}
