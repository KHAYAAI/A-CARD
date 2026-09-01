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
  building: '<rect x="4" y="3" width="16" height="18" rx="1.6"/><path d="M9 7h1M14 7h1M9 11h1M14 11h1M9 15h1M14 15h1"/><path d="M10 21v-3h4v3"/>',
  scale: '<path d="M12 3.5v17M7.5 20.5h9M5 7.5 12 6l7 1.5"/><path d="M5 7.5 2.6 13a2.8 2.8 0 0 0 4.8 0z"/><path d="M19 7.5 16.6 13a2.8 2.8 0 0 0 4.8 0z"/>',
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
interface Holder { id: string; email: string; name: string; currency: string; subscriptionTier: string; accountType?: string; ssoDomain?: string }
interface DeptSpend { department: { id: string; name: string; monthlyBudget: number; lead?: string }; spentThisMonth: number; cardCount: number; currency: string }
interface Policy { blocked_merchant_categories: string[]; approval_threshold?: number }

type Role = "owner" | "admin" | "member" | "viewer";
const RANK: Record<Role, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };
const can = (role: Role | null, min: Role) => !!role && RANK[role] >= RANK[min];

const SYM: Record<string, string> = { ZAR: "R", USD: "$", NGN: "₦", KES: "KSh" };
function fmt(cents: number, ccy: string) {
  return `${SYM[ccy] ?? ccy} ${(cents / 100).toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * PayFast checkout is a signed HTML form POST, not a URL redirect — this
 * builds a throwaway hidden form from the fields `/v1/wallet/fund/checkout`
 * returned and submits it, navigating the browser to PayFast. Nothing here
 * touches the signature; the API already computed it.
 */
function submitPayFastForm(action: string, fields: Record<string, string>) {
  const form = document.createElement("form");
  form.method = "POST";
  form.action = action;
  for (const [name, value] of Object.entries(fields)) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    form.appendChild(input);
  }
  document.body.appendChild(form);
  form.submit();
}

type NavItem = { view: string; label: string; icon: string; crumb?: string; min?: Role; enterprise?: boolean };
const NAV: NavItem[] = [
  { view: "overview", label: "Home", icon: "home", crumb: "Home" },
  { view: "cards", label: "Manage cards", icon: "card", crumb: "Cards" },
  { view: "departments", label: "Departments", icon: "building", enterprise: true },
  { view: "spending", label: "Track spending", icon: "swap", crumb: "Spending" },
  { view: "wallet", label: "Wallet", icon: "wallet" },
  { view: "approvals", label: "Approvals", icon: "shieldCheck" },
  { view: "policies", label: "Policies", icon: "scale", enterprise: true, min: "admin" },
  { view: "audit", label: "Audit log", icon: "book", crumb: "Audit log", enterprise: true },
  { view: "connect", label: "Connect agents", icon: "cpu" },
  { view: "merchants", label: "Merchants", icon: "building", crumb: "Merchants", min: "admin" },
  { view: "team", label: "Team", icon: "users", min: "admin" },
];
const MCC_LABEL: Record<string, string> = {
  "5411": "Groceries", "5734": "Software", "4816": "Cloud", "7311": "Advertising",
  "4511": "Airlines", "5812": "Restaurants", "7995": "Gambling", "6051": "Crypto",
};

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
  const [departments, setDepartments] = useState<DeptSpend[]>([]);
  const [policy, setPolicy] = useState<Policy>({ blocked_merchant_categories: [] });
  const [audit, setAudit] = useState<Txn[]>([]);

  // auth form
  const [mode, setMode] = useState<"login" | "register" | "apikey">("login");
  const [workspace, setWorkspace] = useState<"personal" | "enterprise">("personal");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [apiKeyInput, setApiKeyInput] = useState("");
  /** Open MFA challenge from a login that needs a second factor, and the code being entered. */
  const [challenge, setChallenge] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  /** Work email typed into the "Sign in with SSO" box. */
  const [ssoEmail, setSsoEmail] = useState("");
  const [ssoMode, setSsoMode] = useState(false);

  // modals & inputs
  const [showCreate, setShowCreate] = useState(false);
  const [showFund, setShowFund] = useState(false);
  const [cardLabel, setCardLabel] = useState("");
  const [cardCcy, setCardCcy] = useState("ZAR");
  const [cardDept, setCardDept] = useState("");
  const [deptName, setDeptName] = useState("");
  const [deptBudget, setDeptBudget] = useState("5000000");
  const [deptLead, setDeptLead] = useState("");
  const [policyBlocked, setPolicyBlocked] = useState("");
  const [policyThreshold, setPolicyThreshold] = useState("");
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
      const hld: Holder | null = me?.account_holder ?? null;
      const isEnt = hld?.accountType === "enterprise";
      setRole(currentRole);
      setHolder(hld);
      const reqs: Promise<any>[] = [call("/v1/wallet"), call("/v1/cards"), call("/v1/transactions"), call("/v1/approvals?status=pending")];
      if (can(currentRole, "admin")) reqs.push(call("/v1/auth/members").catch(() => ({ members: [] })));
      else reqs.push(Promise.resolve({ members: [] }));
      if (isEnt) reqs.push(call("/v1/departments").catch(() => ({ departments: [] })), call("/v1/policy").catch(() => ({ policy: {} })), call("/v1/audit").catch(() => ({ audit: [] })));
      const [w, c, t, a, m, d, p, au] = await Promise.all(reqs);
      setWallets(w.wallets ?? (w.wallet ? [w.wallet] : []));
      setCards(c.cards ?? []);
      setTxns(t.transactions ?? []);
      setApprovals(a.approvals ?? []);
      setMembers(m?.members ?? []);
      setDepartments(d?.departments ?? []);
      if (p?.policy) setPolicy({ blocked_merchant_categories: p.policy.blocked_merchant_categories ?? [], approval_threshold: p.policy.approval_threshold });
      setAudit(au?.audit ?? []);
      setConnected(true);
      setError("");
    } catch (e) {
      setConnected(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [call, token]);

  useEffect(() => {
    setPolicyBlocked(policy.blocked_merchant_categories.join(", "));
    setPolicyThreshold(policy.approval_threshold ? String(policy.approval_threshold) : "");
  }, [policy]);
  useEffect(() => {
    // Landing back from the WorkOS SSO callback: the API redirects here with
    // the session token in the query string (the dashboard keeps its session
    // in localStorage, not a cookie — see the `call` helper below).
    const params = new URLSearchParams(window.location.search);
    const ssoToken = params.get("sso_token");
    if (ssoToken) {
      setToken(ssoToken);
      window.history.replaceState({}, "", window.location.pathname);
      return;
    }
    // Landing back from a PayFast checkout (return_url / cancel_url both
    // point here — see PayFastClient.buildCheckout's returnUrl/cancelUrl).
    const funded = params.get("funded");
    if (funded !== null) {
      flash(funded === "1" ? "Funds received — updating wallet." : "Payment cancelled.");
      window.history.replaceState({}, "", window.location.pathname);
    }
    const s = localStorage.getItem("acard_token");
    if (s) setToken(s);
  }, []);
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
      // MFA users get a challenge instead of a session: hold it and ask for the code.
      if (body.mfa_required) { setChallenge(body.challenge_token); return; }
      setToken(body.session_token);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const submitMfaCode = async () => {
    setError("");
    try {
      const res = await fetch(`${API_URL}/v1/auth/mfa/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ challenge_token: challenge, code: mfaCode.trim() }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error?.message ?? `request failed (${res.status})`);
      setChallenge(""); setMfaCode(""); setToken(body.session_token);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const [ssoSetupBusy, setSsoSetupBusy] = useState(false);
  const [ssoPortalUrl, setSsoPortalUrl] = useState("");
  const setupSso = async () => {
    setError(""); setSsoSetupBusy(true);
    try {
      const res = await call("/v1/sso/setup", { method: "POST", body: "{}" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error?.message ?? `request failed (${res.status})`);
      setSsoPortalUrl(body.portal_url);
      await refresh(); // pick up the newly set ssoDomain on the account holder
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setSsoSetupBusy(false); }
  };
  const startSso = async () => {
    setError("");
    try {
      const res = await fetch(`${API_URL}/v1/auth/sso/authorize`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: ssoEmail.trim() }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error?.message ?? `request failed (${res.status})`);
      window.location.href = body.redirect_url;
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
  const isEnt = holder?.accountType === "enterprise";
  const nav = NAV.filter((n) => (!n.enterprise || isEnt) && (!n.min || can(role, n.min)));
  const primaryCcy = holder?.currency ?? "ZAR";
  const primaryWallet = useMemo(
    () => wallets.find((w) => w.currency === primaryCcy) ?? wallets[0],
    [wallets, primaryCcy],
  );
  const activeCards = cards.filter((c) => c.status === "active").length;
  const origin = API_URL;

  const doCreateCard = async () => {
    try {
      await call("/v1/cards", {
        method: "POST",
        body: JSON.stringify({ label: cardLabel || undefined, currency: cardCcy, single_use: true, department_id: cardDept || undefined }),
      });
      setShowCreate(false); setCardLabel(""); setCardDept(""); refresh(); flash("Card created."); setView("cards");
    } catch (e) { flash(e instanceof Error ? e.message : "Could not create card"); }
  };
  const doCreateDept = async () => {
    try {
      await call("/v1/departments", { method: "POST", body: JSON.stringify({ name: deptName, monthly_budget: parseInt(deptBudget, 10), lead: deptLead || undefined }) });
      setDeptName(""); setDeptLead(""); refresh(); flash("Department created.");
    } catch (e) { flash(e instanceof Error ? e.message : "Could not create department"); }
  };
  const doSavePolicy = async () => {
    try {
      const blocked = policyBlocked.split(",").map((s) => s.trim()).filter(Boolean);
      const threshold = parseInt(policyThreshold, 10);
      await call("/v1/policy", { method: "PUT", body: JSON.stringify({ blocked_merchant_categories: blocked, approval_threshold: threshold > 0 ? threshold : undefined }) });
      refresh(); flash("Policy saved.");
    } catch (e) { flash(e instanceof Error ? e.message : "Could not save policy"); }
  };
  const doFund = async () => {
    try {
      const amt = parseInt(fundAmt, 10);
      if (!(amt > 0)) { setShowFund(false); return; }

      // PayFast only ever settles ZAR — every other currency stays on the
      // instant sandbox credit regardless of whether real funding is live.
      if (fundCcy !== "ZAR") {
        await call("/v1/wallet/fund", { method: "POST", body: JSON.stringify({ amount: amt, currency: fundCcy }) });
        flash(`Added ${fmt(amt, fundCcy)}.`);
        setShowFund(false); refresh();
        return;
      }

      // Try the real PayFast checkout first; a 501 means this deployment
      // hasn't configured PayFast, so fall back to the instant credit —
      // the dashboard doesn't need to know ahead of time which mode it's in.
      const res = await fetch(`${API_URL}/v1/wallet/fund/checkout`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ amount: amt }),
      });
      if (res.status === 501) {
        await call("/v1/wallet/fund", { method: "POST", body: JSON.stringify({ amount: amt, currency: fundCcy }) });
        flash(`Added ${fmt(amt, fundCcy)}.`);
        setShowFund(false); refresh();
        return;
      }
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error?.message ?? `request failed (${res.status})`);
      submitPayFastForm(body.action, body.fields); // navigates away to PayFast — nothing left to do here
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

          <div className="seg" style={{ marginTop: 18, display: challenge || ssoMode ? "none" : undefined }}>
            <button className={mode === "login" ? "sel" : ""} onClick={() => setMode("login")}>Sign in</button>
            <button className={mode === "register" ? "sel" : ""} onClick={() => setMode("register")}>Create account</button>
            <button className={mode === "apikey" ? "sel" : ""} onClick={() => setMode("apikey")}>API key</button>
          </div>

          {challenge ? (
            <form onSubmit={(e) => { e.preventDefault(); submitMfaCode(); }}>
              <div className="field">
                <label>authentication code</label>
                <input
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="123456"
                  value={mfaCode}
                  onChange={(e) => setMfaCode(e.target.value)}
                />
                <div className="hint" style={{ marginTop: 6 }}>From your authenticator app, or one of your recovery codes.</div>
              </div>
              <button type="submit" className="btn btn-green login-btn">Verify</button>
              <button
                type="button"
                className="btn login-btn"
                style={{ marginTop: 8 }}
                onClick={() => { setChallenge(""); setMfaCode(""); setError(""); }}
              >
                Back
              </button>
            </form>
          ) : mode === "apikey" ? (
            <form onSubmit={(e) => { e.preventDefault(); setToken(apiKeyInput.trim()); }}>
              <div className="field"><label>api key</label><input type="password" placeholder="ak_live_…" value={apiKeyInput} onChange={(e) => setApiKeyInput(e.target.value)} /></div>
              <button type="submit" className="btn btn-green login-btn">Connect</button>
            </form>
          ) : mode === "login" && ssoMode ? (
            <form onSubmit={(e) => { e.preventDefault(); startSso(); }}>
              <div className="field">
                <label>work email</label>
                <input type="email" placeholder="you@yourcompany.com" value={ssoEmail} onChange={(e) => setSsoEmail(e.target.value)} />
                <div className="hint" style={{ marginTop: 6 }}>Your organisation's identity provider handles the rest.</div>
              </div>
              <button type="submit" className="btn btn-green login-btn">Continue with SSO</button>
              <button type="button" className="btn login-btn" style={{ marginTop: 8 }} onClick={() => { setSsoMode(false); setError(""); }}>
                Back to password sign-in
              </button>
            </form>
          ) : (
            <form onSubmit={(e) => { e.preventDefault(); mode === "register" ? authenticate("/v1/auth/register", { email, name, password, account_type: workspace }) : authenticate("/v1/auth/login", { email, password }); }}>
              {mode === "register" && (
                <>
                  <div className="field">
                    <label>workspace</label>
                    <div className="seg">
                      <button type="button" className={workspace === "personal" ? "sel" : ""} onClick={() => setWorkspace("personal")}>Personal</button>
                      <button type="button" className={workspace === "enterprise" ? "sel" : ""} onClick={() => setWorkspace("enterprise")}>Enterprise</button>
                    </div>
                    <div className="hint" style={{ marginTop: 6 }}>
                      {workspace === "enterprise" ? "Departments, budgets, org policies, and an audit log." : "A wallet and cards for your own agents."}
                    </div>
                  </div>
                  <div className="field"><label>{workspace === "enterprise" ? "organisation name" : "your name"}</label><input value={name} onChange={(e) => setName(e.target.value)} /></div>
                </>
              )}
              <div className="field"><label>work email</label><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
              <div className="field"><label>password{mode === "register" ? " (min 8 chars)" : ""}</label><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></div>
              <button type="submit" className="btn btn-green login-btn">{mode === "register" ? "Create workspace" : "Sign in"}</button>
              {mode === "login" && (
                <button type="button" className="btn login-btn" style={{ marginTop: 8 }} onClick={() => { setSsoMode(true); setError(""); }}>
                  Sign in with SSO instead
                </button>
              )}
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
          <div className="who"><div className="n">{holder?.name ?? "Account"} {isEnt && <span className="badge-ent" style={{ fontSize: 9 }}>Ent</span>}</div><div className="e">{holder?.email ?? ""}</div></div>
          <span className="chev"><Icon name="updown" /></span>
        </div>
        <nav className="side-nav">
          {nav.map((n) => (
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
                {isEnt && departments.length > 0 && (
                  <div className="panel panel-pad">
                    <div className="panel-head"><h2>Spend by department</h2><span className="tag">this month</span></div>
                    <DeptBars rows={departments} />
                  </div>
                )}
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

          {/* DEPARTMENTS */}
          {view === "departments" && isEnt && (
            <>
              <div className="page-head"><div className="page-title">Departments</div><div className="page-sub">Each team gets its own budget, its own agents, and its own scope.</div></div>
              <div className="stack">
                {can(role, "admin") && (
                  <div className="panel panel-pad">
                    <div className="panel-head"><h2>New department</h2></div>
                    <div className="filters">
                      <input placeholder="Department name" value={deptName} onChange={(e) => setDeptName(e.target.value)} />
                      <input className="mono" placeholder="Monthly budget (cents)" value={deptBudget} onChange={(e) => setDeptBudget(e.target.value)} />
                      <input placeholder="Lead (optional)" value={deptLead} onChange={(e) => setDeptLead(e.target.value)} />
                      <button className="btn btn-green" onClick={doCreateDept}><Icon name="plus" /> Add</button>
                    </div>
                  </div>
                )}
                {departments.length === 0 ? (
                  <div className="panel panel-pad"><div className="empty">No departments yet. Create one to give a team its own budget and agents.</div></div>
                ) : (
                  <div className="dept-grid">
                    {departments.map((d) => {
                      const pct = Math.round((d.spentThisMonth / d.department.monthlyBudget) * 100);
                      return (
                        <div className="dept-card" key={d.department.id}>
                          <div className="dept-top"><div className="dept-ico" style={{ color: "var(--green)" }}><Icon name="building" /></div><div><div className="dept-name">{d.department.name}</div>{d.department.lead && <div className="dept-lead">Lead · {d.department.lead}</div>}</div></div>
                          <div className="dept-meta"><span>Agents <b>{d.cardCount}</b></span><span>Spent <b>{fmt(d.spentThisMonth, d.currency)}</b></span><span>Budget <b>{fmt(d.department.monthlyBudget, d.currency)}</b></span></div>
                          <div className="budget-bar"><div className={`budget-fill ${pct > 85 ? "over" : pct > 65 ? "warn" : ""}`} style={{ width: `${Math.min(100, pct)}%` }} /></div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </>
          )}

          {/* POLICIES */}
          {view === "policies" && isEnt && can(role, "admin") && (
            <>
              <div className="page-head"><div className="page-title">Policies &amp; controls</div><div className="page-sub">One rulebook, enforced on every authorization before a cent moves.</div></div>
              <div className="panel panel-pad" style={{ maxWidth: 640 }}>
                <div className="field"><label>blocked merchant categories (MCC, comma-separated)</label><input className="mono" placeholder="7995, 6051" value={policyBlocked} onChange={(e) => setPolicyBlocked(e.target.value)} /><div className="hint" style={{ marginTop: 5 }}>e.g. 7995 = gambling, 6051 = crypto. Declined org-wide regardless of card rules.</div></div>
                <div className="field" style={{ marginTop: 14 }}><label>org approval threshold (cents, blank for none)</label><input className="mono" placeholder="10000000" value={policyThreshold} onChange={(e) => setPolicyThreshold(e.target.value)} /><div className="hint" style={{ marginTop: 5 }}>Charges at/above this route to a human even if the card has no threshold.</div></div>
                <div style={{ marginTop: 18 }}><button className="btn btn-green" onClick={doSavePolicy}>Save policy</button></div>
                {policy.blocked_merchant_categories.length > 0 && (
                  <div className="hint" style={{ marginTop: 16 }}>Currently blocking: {policy.blocked_merchant_categories.map((m) => MCC_LABEL[m] ? `${MCC_LABEL[m]} (${m})` : m).join(", ")}.</div>
                )}
              </div>
            </>
          )}

          {/* AUDIT */}
          {view === "audit" && isEnt && (
            <>
              <div className="page-head"><div className="page-title">Audit log</div><div className="page-sub">Every authorization decision — approved, declined, or held — with the reason.</div></div>
              <div className="panel panel-pad">
                {audit.length === 0 ? <div className="empty">No decisions yet.</div> : (
                  <div>
                    {audit.slice(0, 60).map((t) => {
                      const d = t.status === "declined" ? (t.declineReason === "pending_human_approval" ? ["hold", "held"] : ["no", "declined"]) : ["ok", "approved"];
                      return (
                        <div className="audit-row" key={t.id} style={{ gridTemplateColumns: "170px 1fr auto" }}>
                          <div className="audit-when">{new Date(t.createdAt).toLocaleString()}</div>
                          <div><div className="audit-main">{t.merchantName}</div>{t.declineReason && t.status === "declined" && <div className="audit-sub">{t.declineReason}</div>}</div>
                          <div style={{ display: "flex", alignItems: "center", gap: 10, justifyContent: "flex-end" }}><span className="audit-amt">{fmt(t.amount, t.currency)}</span><span className={`decision ${d[0]}`}>{d[1]}</span></div>
                        </div>
                      );
                    })}
                  </div>
                )}
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

          {/* MERCHANTS (A-MERCHANT operator console) */}
          {view === "merchants" && can(role, "admin") && <MerchantsPanel call={call} flash={flash} />}

          {/* TEAM */}
          {view === "team" && can(role, "admin") && (
            <>
              <div className="page-head"><div className="page-title">Team</div><div className="page-sub">People with access to this account, and what they can do.</div></div>
              <div className="stack">
                {can(role, "owner") && (
                  <div className="panel panel-pad">
                    <div className="panel-head"><h2>Single sign-on</h2></div>
                    {holder?.ssoDomain ? (
                      <>
                        <div className="hint">
                          Configured for <strong>{holder.ssoDomain}</strong> — anyone with that work email can sign in via your identity provider.
                        </div>
                        <button className="btn btn-outline" style={{ marginTop: 12 }} onClick={setupSso} disabled={ssoSetupBusy}>
                          Reopen setup portal
                        </button>
                      </>
                    ) : (
                      <>
                        <div className="hint">
                          Let your team sign in through your own identity provider (Okta, Azure AD, Google Workspace, and others) instead of a password.
                        </div>
                        <button className="btn btn-green" style={{ marginTop: 12 }} onClick={setupSso} disabled={ssoSetupBusy}>
                          {ssoSetupBusy ? "Setting up…" : "Enable SSO"}
                        </button>
                      </>
                    )}
                    {ssoPortalUrl && (
                      <div className="hint" style={{ marginTop: 10 }}>
                        Send this link to whoever administers your identity provider — they configure the connection themselves, no A-CARD login needed:
                        <br />
                        <a href={ssoPortalUrl} target="_blank" rel="noreferrer">{ssoPortalUrl}</a>
                      </div>
                    )}
                  </div>
                )}
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
            {isEnt && departments.length > 0 && (
              <div className="field" style={{ marginTop: 12 }}><label>department</label>
                <select value={cardDept} onChange={(e) => setCardDept(e.target.value)} style={{ width: "100%", padding: "10px 12px", borderRadius: 10, background: "var(--surface-2)", border: "1px solid var(--border)", color: "var(--ink)", fontSize: 14 }}>
                  <option value="">No department</option>
                  {departments.map((d) => <option key={d.department.id} value={d.department.id}>{d.department.name}</option>)}
                </select>
                <div className="hint" style={{ marginTop: 5 }}>The card draws from this department&apos;s monthly budget.</div>
              </div>
            )}
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

/* ---------------------------------------------------- department bars */
function DeptBars({ rows }: { rows: DeptSpend[] }) {
  return (
    <div>
      {rows.map((d) => {
        const pct = Math.round((d.spentThisMonth / d.department.monthlyBudget) * 100);
        return (
          <div className="bar-row" key={d.department.id}>
            <div className="bar-name"><span className="dot" style={{ background: "var(--green)" }} />{d.department.name}</div>
            <div className="budget-bar"><div className={`budget-fill ${pct > 85 ? "over" : pct > 65 ? "warn" : ""}`} style={{ width: `${Math.min(100, pct)}%` }} /></div>
            <div className="bar-amt"><b>{fmt(d.spentThisMonth, d.currency)}</b> / {fmt(d.department.monthlyBudget, d.currency)}</div>
          </div>
        );
      })}
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

/* ============================================================ A-MERCHANT */
interface MerchantAddress { addressLine: string; city: string; province: string; country: string; lat: number; lng: number }
interface MerchantRow {
  id: string; name: string; tradingName?: string; merchantCategoryCode: string; address: MerchantAddress;
  serviceRadiusKm: number; currency: string; status: "pending_kyb" | "verified" | "suspended"; verified: boolean; createdAt: string;
}
interface CatalogItemRow {
  id: string; sku: string; name: string; unit: string; unitPriceCents: number; currency: string;
  availability: string; quantityAvailable?: number; leadTimeDays: number; inventoryUpdatedAt: string;
}
interface OfferRow {
  merchant: MerchantRow; item: CatalogItemRow; quantity: number; totalCents: number; currency: string;
  distanceKm?: number; leadTimeDays: number; freshness: "fresh" | "aging" | "stale"; score: number; matchReasons: string[];
}
interface ExclusionRow { merchantId: string; itemId?: string; reason: string }

const MERCHANT_STATUS_PILL: Record<string, string> = { verified: "active", pending_kyb: "pending", suspended: "declined" };
const FRESHNESS_PILL: Record<string, string> = { fresh: "active", aging: "pending", stale: "declined" };

function MerchantsPanel({ call, flash }: { call: (path: string, init?: RequestInit) => Promise<any>; flash: (m: string) => void }) {
  const [tab, setTab] = useState<"directory" | "search">("directory");
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [merchants, setMerchants] = useState<MerchantRow[]>([]);
  const [selected, setSelected] = useState<MerchantRow | null>(null);
  const [items, setItems] = useState<CatalogItemRow[]>([]);
  const [health, setHealth] = useState<{ items: number; fresh: number; aging: number; stale: number; medianInventoryAgeHours: number } | null>(null);
  const [inviteUrl, setInviteUrl] = useState("");
  const [kybNote, setKybNote] = useState("");
  const [showAdd, setShowAdd] = useState(false);

  // onboarding form
  const [fName, setFName] = useState("");
  const [fMcc, setFMcc] = useState("5211");
  const [fAddr, setFAddr] = useState("");
  const [fCity, setFCity] = useState("");
  const [fProvince, setFProvince] = useState("Gauteng");
  const [fLat, setFLat] = useState("-26.2041");
  const [fLng, setFLng] = useState("28.0473");
  const [fRadius, setFRadius] = useState("30");
  const [fRegNo, setFRegNo] = useState("");
  const [fEmail, setFEmail] = useState("");

  // discovery form
  const [sQuery, setSQuery] = useState("cement");
  const [sLat, setSLat] = useState("-26.2041");
  const [sLng, setSLng] = useState("28.0473");
  const [sRadius, setSRadius] = useState("15");
  const [sQty, setSQty] = useState("1");
  const [sBudget, setSBudget] = useState("");
  const [sLeadDays, setSLeadDays] = useState("");
  const [sOffers, setSOffers] = useState<OfferRow[]>([]);
  const [sExcluded, setSExcluded] = useState<ExclusionRow[]>([]);
  const [sSearched, setSSearched] = useState(false);
  const [sBusy, setSBusy] = useState(false);

  const loadMerchants = useCallback(async () => {
    try {
      const res = await call("/v1/merchants");
      setMerchants(res.merchants ?? []);
      setEnabled(true);
    } catch {
      setEnabled(false);
    } finally {
      setLoading(false);
    }
  }, [call]);

  useEffect(() => { loadMerchants(); }, [loadMerchants]);

  const openMerchant = useCallback(
    async (m: MerchantRow) => {
      setSelected(m);
      setInviteUrl("");
      setKybNote("");
      try {
        const [detail, h] = await Promise.all([call(`/v1/merchants/${m.id}`), call(`/v1/merchants/${m.id}/health`).catch(() => null)]);
        setItems(detail.items ?? []);
        setHealth(h);
      } catch (e) {
        flash(e instanceof Error ? e.message : "Could not load merchant.");
      }
    },
    [call, flash],
  );

  const addMerchant = async () => {
    if (!fName.trim() || !fAddr.trim() || !fCity.trim() || !fRegNo.trim() || !fEmail.trim()) {
      flash("Fill in name, address, registration number, and contact email.");
      return;
    }
    try {
      await call("/v1/merchants", {
        method: "POST",
        body: JSON.stringify({
          name: fName,
          merchant_category_code: fMcc,
          address: { addressLine: fAddr, city: fCity, province: fProvince, country: "ZA", lat: Number(fLat), lng: Number(fLng) },
          service_radius_km: Number(fRadius) || 0,
          kyb: { registration_number: fRegNo, contact_email: fEmail },
        }),
      });
      flash(`${fName} added — pending KYB review.`);
      setShowAdd(false);
      setFName(""); setFAddr(""); setFCity(""); setFRegNo(""); setFEmail("");
      loadMerchants();
    } catch (e) {
      flash(e instanceof Error ? e.message : "Could not add merchant.");
    }
  };

  const decideKyb = async (status: "verified" | "suspended") => {
    if (!selected) return;
    try {
      const res = await call(`/v1/merchants/${selected.id}/kyb`, { method: "POST", body: JSON.stringify({ status, note: kybNote || undefined }) });
      flash(status === "verified" ? `${selected.name} verified — now discoverable by agents.` : `${selected.name} suspended.`);
      setSelected(res.merchant);
      setKybNote("");
      loadMerchants();
    } catch (e) {
      flash(e instanceof Error ? e.message : "Could not record the decision.");
    }
  };

  const generateInvite = async () => {
    if (!selected) return;
    try {
      const res = await call(`/v1/merchants/${selected.id}/portal-invites`, { method: "POST", body: JSON.stringify({}) });
      setInviteUrl(res.invite_url);
    } catch (e) {
      flash(e instanceof Error ? e.message : "Portal login isn't configured on this deployment yet.");
    }
  };

  const runSearch = async () => {
    setSBusy(true);
    try {
      const params = new URLSearchParams();
      if (sQuery.trim()) params.set("q", sQuery.trim());
      if (sLat && sLng) { params.set("lat", sLat); params.set("lng", sLng); if (sRadius) params.set("radius_km", sRadius); }
      if (sQty) params.set("quantity", sQty);
      if (sBudget) params.set("max_total_cents", String(Math.round(Number(sBudget) * 100)));
      if (sLeadDays) params.set("max_lead_time_days", sLeadDays);
      const res = await call(`/v1/merchants/search?${params.toString()}`);
      setSOffers(res.offers ?? []);
      setSExcluded(res.excluded ?? []);
      setSSearched(true);
    } catch (e) {
      flash(e instanceof Error ? e.message : "Search failed.");
    } finally {
      setSBusy(false);
    }
  };

  if (loading) return <div className="panel panel-pad"><div className="hint">Loading…</div></div>;

  if (!enabled) {
    return (
      <>
        <div className="page-head"><div className="page-title">Merchants</div><div className="page-sub">A-MERCHANT — the supply side agents buy from.</div></div>
        <div className="panel"><div className="empty-box" style={{ border: "none", padding: "40px 24px" }}>
          <div className="empty-ico"><Icon name="building" size={24} /></div>
          <div className="empty-t">A-MERCHANT isn&apos;t enabled on this deployment</div>
          <div className="empty-s">The merchant directory has no Postgres adapter yet — it runs on the in-memory / snapshot persistence path (ACARD_PERSISTENCE=snapshot). See the README.</div>
        </div></div>
      </>
    );
  }

  return (
    <>
      <div className="page-head">
        <div className="page-title">Merchants</div>
        <div className="page-sub">Onboard suppliers, decide KYB, and see exactly what an agent&apos;s search would return.</div>
      </div>
      <div className="connect-tabs" style={{ marginBottom: 16 }}>
        <button className={`ctab ${tab === "directory" ? "sel" : ""}`} onClick={() => setTab("directory")}><Icon name="building" /> Directory</button>
        <button className={`ctab ${tab === "search" ? "sel" : ""}`} onClick={() => setTab("search")}><Icon name="upRight" /> Search preview</button>
      </div>

      {tab === "directory" && (
        <div className="cols">
          <div className="panel panel-pad">
            <div className="panel-head"><h2>Directory</h2><button className="btn btn-green" onClick={() => setShowAdd(true)}><Icon name="plus" /> Add merchant</button></div>
            {merchants.length === 0 ? (
              <div className="empty-box" style={{ border: "none", padding: "34px 16px" }}>
                <div className="empty-ico"><Icon name="building" size={24} /></div>
                <div className="empty-t">No merchants yet</div>
                <div className="empty-s">Add the first one — it stays invisible to agents until you verify its KYB.</div>
              </div>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table className="grid">
                  <thead><tr><th>Name</th><th>MCC</th><th>City</th><th>Status</th></tr></thead>
                  <tbody>
                    {merchants.map((m) => (
                      <tr key={m.id} onClick={() => openMerchant(m)} style={{ cursor: "pointer" }} className={selected?.id === m.id ? "row-sel" : ""}>
                        <td>{m.name}</td>
                        <td className="mono">{m.merchantCategoryCode}</td>
                        <td>{m.address.city}</td>
                        <td><span className={`pill ${MERCHANT_STATUS_PILL[m.status]}`}>{m.status.replace("_", " ")}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="panel panel-pad">
            {!selected ? (
              <div className="empty-box" style={{ border: "none", padding: "40px 16px" }}>
                <div className="empty-t">Select a merchant</div>
                <div className="empty-s">Review its catalog, decide KYB, or send a portal invite.</div>
              </div>
            ) : (
              <>
                <div className="panel-head"><h2>{selected.name}</h2><span className={`pill ${MERCHANT_STATUS_PILL[selected.status]}`}>{selected.status.replace("_", " ")}</span></div>
                <div className="hint">{selected.address.addressLine}, {selected.address.city} · MCC {selected.merchantCategoryCode} · delivers within {selected.serviceRadiusKm}km</div>

                {health && (
                  <div className="stats" style={{ marginTop: 16 }}>
                    <div className="stat"><div className="head"><span className="lbl">Catalog</span></div><div className="val">{health.items}</div><div className="foot">items listed</div></div>
                    <div className="stat"><div className="head"><span className="lbl">Fresh stock</span></div><div className="val">{health.fresh}/{health.items}</div><div className="foot">confirmed in 24h</div></div>
                    <div className="stat"><div className="head"><span className="lbl">Median age</span></div><div className="val">{health.medianInventoryAgeHours}h</div><div className="foot">since last count</div></div>
                  </div>
                )}

                <div style={{ marginTop: 20 }}>
                  <div className="panel-head"><h2>KYB decision</h2></div>
                  <div className="field"><label>note (recorded against your name)</label><input value={kybNote} onChange={(e) => setKybNote(e.target.value)} placeholder="e.g. CIPC docs on file" /></div>
                  <div className="filters" style={{ marginTop: 10 }}>
                    <button className="btn btn-green" onClick={() => decideKyb("verified")} disabled={selected.status === "verified"}><Icon name="check" /> Verify</button>
                    <button className="btn btn-outline" onClick={() => decideKyb("suspended")} disabled={selected.status === "suspended"}><Icon name="x" /> Suspend</button>
                  </div>
                </div>

                <div style={{ marginTop: 20 }}>
                  <div className="panel-head"><h2>Merchant portal</h2></div>
                  <div className="hint">Generate a one-time login link so the merchant can restate their own stock — the single highest-value action in A-MERCHANT.</div>
                  <button className="btn btn-outline" style={{ marginTop: 10 }} onClick={generateInvite}>Generate invite link</button>
                  {inviteUrl && (
                    <div className="cmd" style={{ marginTop: 10 }}>
                      <span>{inviteUrl}</span>
                      <button className="cmd-copy" onClick={() => { navigator.clipboard?.writeText(inviteUrl).catch(() => {}); flash("Copied."); }}><Icon name="copy" /></button>
                    </div>
                  )}
                </div>

                <div style={{ marginTop: 20 }}>
                  <div className="panel-head"><h2>Catalog ({items.length})</h2></div>
                  {items.length === 0 ? (
                    <div className="hint">No items listed yet — the merchant adds these from their own portal.</div>
                  ) : (
                    <div style={{ overflowX: "auto" }}>
                      <table className="grid">
                        <thead><tr><th>Item</th><th>Price</th><th>Stock</th><th>Freshness</th></tr></thead>
                        <tbody>
                          {items.map((it) => (
                            <tr key={it.id}>
                              <td>{it.name}</td>
                              <td>{fmt(it.unitPriceCents, it.currency)} / {it.unit}</td>
                              <td>{it.availability.replace("_", " ")}{it.quantityAvailable !== undefined ? ` (${it.quantityAvailable})` : ""}</td>
                              <td><span className="hint">{new Date(it.inventoryUpdatedAt).toLocaleString()}</span></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {tab === "search" && (
        <div className="cols">
          <div className="panel panel-pad">
            <div className="panel-head"><h2>Run a search</h2></div>
            <div className="field"><label>what an agent is looking for</label><input value={sQuery} onChange={(e) => setSQuery(e.target.value)} placeholder="cement 50kg" /></div>
            <div className="field" style={{ marginTop: 12 }}><label>quantity</label><input className="mono" value={sQty} onChange={(e) => setSQty(e.target.value)} /></div>
            <div className="field" style={{ marginTop: 12 }}><label>near (lat, lng, radius km)</label>
              <div className="filters">
                <input className="mono" value={sLat} onChange={(e) => setSLat(e.target.value)} />
                <input className="mono" value={sLng} onChange={(e) => setSLng(e.target.value)} />
                <input className="mono" value={sRadius} onChange={(e) => setSRadius(e.target.value)} />
              </div>
            </div>
            <div className="field" style={{ marginTop: 12 }}><label>max budget (optional)</label><input className="mono" value={sBudget} onChange={(e) => setSBudget(e.target.value)} placeholder="e.g. 60000" /></div>
            <div className="field" style={{ marginTop: 12 }}><label>max lead time, days (optional)</label><input className="mono" value={sLeadDays} onChange={(e) => setSLeadDays(e.target.value)} /></div>
            <button className="btn btn-green" style={{ marginTop: 16 }} onClick={runSearch} disabled={sBusy}>{sBusy ? "Searching…" : "Search"}</button>
          </div>

          <div className="panel panel-pad">
            <div className="panel-head"><h2>What an agent would see</h2></div>
            {!sSearched ? (
              <div className="hint">Run a search to see ranked offers, exactly as `find_offers` returns them over MCP.</div>
            ) : sOffers.length === 0 ? (
              <div className="empty-box" style={{ border: "none", padding: "30px 16px" }}>
                <div className="empty-t">No offers matched</div>
                <div className="empty-s">See the exclusion reasons below — a search that finds nothing always says why.</div>
              </div>
            ) : (
              <div className="feed">
                {sOffers.map((o, i) => (
                  <div className="feed-row" key={`${o.merchant.id}-${o.item.id}`}>
                    <div className={`feed-ico ok`}>{i + 1}</div>
                    <div>
                      <div className="feed-main">{o.merchant.name} — {o.item.name}</div>
                      <div className="feed-meta">
                        <span className={`pill ${FRESHNESS_PILL[o.freshness]}`}>{o.freshness}</span>
                        {" · "}{o.leadTimeDays === 0 ? "same day" : `${o.leadTimeDays}d lead`}
                        {o.distanceKm !== undefined ? ` · ${o.distanceKm}km` : ""}
                        {o.matchReasons.length > 0 ? ` · ${o.matchReasons.join(", ")}` : ""}
                      </div>
                    </div>
                    <div className="feed-amt">{fmt(o.totalCents, o.currency)}</div>
                  </div>
                ))}
              </div>
            )}
            {sSearched && sExcluded.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <div className="hint">Excluded ({sExcluded.length}):</div>
                {sExcluded.map((e, i) => <div key={i} className="hint" style={{ marginTop: 4 }}>– {e.reason}</div>)}
              </div>
            )}
          </div>
        </div>
      )}

      {showAdd && (
        <div className="modal-back on" onClick={(e) => { if (e.target === e.currentTarget) setShowAdd(false); }}>
          <div className="modal">
            <h3>Add a merchant</h3>
            <div className="hint" style={{ margin: "6px 0 16px" }}>Stays invisible to agents until you verify its KYB.</div>
            <div className="field"><label>business name</label><input value={fName} onChange={(e) => setFName(e.target.value)} /></div>
            <div className="field" style={{ marginTop: 12 }}><label>merchant category code</label><input className="mono" value={fMcc} onChange={(e) => setFMcc(e.target.value)} placeholder="5211 = hardware" /></div>
            <div className="field" style={{ marginTop: 12 }}><label>address</label><input value={fAddr} onChange={(e) => setFAddr(e.target.value)} placeholder="street" /></div>
            <div className="filters" style={{ marginTop: 12 }}>
              <input value={fCity} onChange={(e) => setFCity(e.target.value)} placeholder="city" />
              <input value={fProvince} onChange={(e) => setFProvince(e.target.value)} placeholder="province" />
            </div>
            <div className="filters" style={{ marginTop: 12 }}>
              <input className="mono" value={fLat} onChange={(e) => setFLat(e.target.value)} placeholder="lat" />
              <input className="mono" value={fLng} onChange={(e) => setFLng(e.target.value)} placeholder="lng" />
              <input className="mono" value={fRadius} onChange={(e) => setFRadius(e.target.value)} placeholder="delivery radius km" />
            </div>
            <div className="field" style={{ marginTop: 12 }}><label>registration number</label><input value={fRegNo} onChange={(e) => setFRegNo(e.target.value)} placeholder="CIPC / company registration" /></div>
            <div className="field" style={{ marginTop: 12 }}><label>contact email</label><input value={fEmail} onChange={(e) => setFEmail(e.target.value)} /></div>
            <div className="hint" style={{ marginTop: 10 }}>Registration documents are collected and filed outside this console for now — record what was submitted in the KYB note when you verify.</div>
            <div className="modal-actions"><button className="btn btn-outline" style={{ flex: "0 0 auto" }} onClick={() => setShowAdd(false)}>Cancel</button><button className="btn btn-green" onClick={addMerchant}>Add merchant</button></div>
          </div>
        </div>
      )}
    </>
  );
}
