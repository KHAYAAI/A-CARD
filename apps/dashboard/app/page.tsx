"use client";

import { useCallback, useEffect, useState } from "react";

const API_URL = process.env.NEXT_PUBLIC_ACARD_API_URL ?? "http://localhost:8787";

interface Wallet {
  available: number;
  posted: number;
  held: number;
  currency: string;
}

interface Card {
  id: string;
  label?: string;
  last4: string;
  status: string;
  currency: string;
  singleUse: boolean;
  createdAt: string;
}

interface Txn {
  id: string;
  merchantName: string;
  amount: number;
  currency: string;
  status: string;
  declineReason?: string;
  createdAt: string;
}

interface Approval {
  id: string;
  merchantName: string;
  amount: number;
  currency: string;
  reason: string;
  createdAt: string;
}

interface Member {
  user: { id: string; email: string; name: string };
  role: string;
  createdAt: string;
}

type Role = "owner" | "admin" | "member" | "viewer";
const RANK: Record<Role, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };
const can = (role: Role | null, min: Role) => !!role && RANK[role] >= RANK[min];

function cents(amount: number, currency: string) {
  return `${currency} ${(amount / 100).toFixed(2)}`;
}

export default function Dashboard() {
  // token is either a session token (sess_...) or a programmatic API key (ak_...).
  const [token, setToken] = useState("");
  const [role, setRole] = useState<Role | null>(null);
  const [connected, setConnected] = useState(false);
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [cards, setCards] = useState<Card[]>([]);
  const [txns, setTxns] = useState<Txn[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [error, setError] = useState("");
  const [fundAmount, setFundAmount] = useState("50000");
  const [fundCurrency, setFundCurrency] = useState("ZAR");
  const [cardLabel, setCardLabel] = useState("");
  const [cardCurrency, setCardCurrency] = useState("ZAR");

  const CURRENCIES = ["ZAR", "USD"];

  // login/register form
  const [mode, setMode] = useState<"login" | "register" | "apikey">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [invitePassword, setInvitePassword] = useState("");
  const [inviteRole, setInviteRole] = useState<Role>("member");

  const call = useCallback(
    async (path: string, init: RequestInit = {}, authToken = token) => {
      const response = await fetch(`${API_URL}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${authToken}`,
          "content-type": "application/json",
          ...(init.headers ?? {}),
        },
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error?.message ?? `request failed (${response.status})`);
      return body;
    },
    [token],
  );

  const refresh = useCallback(async () => {
    if (!token) return;
    try {
      const me = await call("/v1/auth/me").catch(() => null);
      const currentRole: Role = me?.role ?? "owner"; // api keys report owner via /me too
      setRole(currentRole);

      const requests: Promise<any>[] = [call("/v1/wallet"), call("/v1/cards"), call("/v1/transactions"), call("/v1/approvals?status=pending")];
      if (can(currentRole, "admin")) requests.push(call("/v1/auth/members").catch(() => ({ members: [] })));
      const [w, c, t, a, m] = await Promise.all(requests);
      setWallets(w.wallets ?? (w.wallet ? [w.wallet] : []));
      setCards(c.cards);
      setTxns(t.transactions);
      setApprovals(a.approvals);
      setMembers(m?.members ?? []);
      setConnected(true);
      setError("");
    } catch (e) {
      setConnected(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [call, token]);

  useEffect(() => {
    const saved = localStorage.getItem("acard_token");
    if (saved) setToken(saved);
  }, []);

  useEffect(() => {
    if (!token) return;
    localStorage.setItem("acard_token", token);
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [token, refresh]);

  const authenticate = async (path: string, payload: object) => {
    setError("");
    try {
      const res = await fetch(`${API_URL}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error?.message ?? `request failed (${res.status})`);
      setToken(body.session_token);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const signOut = async () => {
    if (token.startsWith("sess_")) await call("/v1/auth/logout", { method: "POST" }).catch(() => {});
    localStorage.removeItem("acard_token");
    setToken("");
    setRole(null);
    setConnected(false);
    setWallets([]);
  };

  const readOnly = !can(role, "member");

  return (
    <main>
      <div className="topbar">
        <div>
          <h1>A-CARD</h1>
          <div className="muted">
            Virtual cards for AI agents{role ? ` — signed in as ${role}` : " — console"}
          </div>
        </div>
        {connected && (
          <button className="secondary" onClick={signOut}>
            Sign out
          </button>
        )}
      </div>

      {error && (
        <section>
          <div className="panel" style={{ color: "var(--red)" }}>
            {error}
          </div>
        </section>
      )}

      {!connected && (
        <section>
          <div className="inline" style={{ marginBottom: 12, gap: 8 }}>
            <button className={mode === "login" ? "" : "secondary"} onClick={() => setMode("login")}>
              Sign in
            </button>
            <button className={mode === "register" ? "" : "secondary"} onClick={() => setMode("register")}>
              Create account
            </button>
            <button className={mode === "apikey" ? "" : "secondary"} onClick={() => setMode("apikey")}>
              Use API key
            </button>
          </div>

          {mode === "apikey" ? (
            <form
              className="panel"
              onSubmit={(e) => {
                e.preventDefault();
                setToken(apiKeyInput.trim());
              }}
            >
              <p className="muted">Paste a programmatic API key (ak_live_…). Full owner-level access.</p>
              <div className="inline">
                <input type="password" placeholder="ak_live_…" value={apiKeyInput} onChange={(e) => setApiKeyInput(e.target.value)} style={{ width: 320 }} />
                <button type="submit">Connect</button>
              </div>
            </form>
          ) : (
            <form
              className="panel"
              onSubmit={(e) => {
                e.preventDefault();
                if (mode === "register") authenticate("/v1/auth/register", { email, name, password });
                else authenticate("/v1/auth/login", { email, password });
              }}
            >
              {mode === "register" && (
                <div style={{ marginBottom: 8 }}>
                  <input placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} style={{ width: 320 }} />
                </div>
              )}
              <div style={{ marginBottom: 8 }}>
                <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} style={{ width: 320 }} />
              </div>
              <div style={{ marginBottom: 8 }}>
                <input
                  type="password"
                  placeholder={mode === "register" ? "Password (min 8 chars)" : "Password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  style={{ width: 320 }}
                />
              </div>
              <button type="submit">{mode === "register" ? "Create account" : "Sign in"}</button>
            </form>
          )}
        </section>
      )}

      {connected && (
        <>
          <section>
            <h2>Wallets</h2>
            {wallets.map((wallet) => (
              <div key={wallet.currency} style={{ marginBottom: 12 }}>
                <div className="muted" style={{ marginBottom: 6 }}>{wallet.currency}</div>
                <div className="stat-row">
                  <div className="panel stat">
                    <div className="label">Available</div>
                    <div className="value">{cents(wallet.available, wallet.currency)}</div>
                  </div>
                  <div className="panel stat">
                    <div className="label">On hold</div>
                    <div className="value">{cents(wallet.held, wallet.currency)}</div>
                  </div>
                  <div className="panel stat">
                    <div className="label">Posted</div>
                    <div className="value">{cents(wallet.posted, wallet.currency)}</div>
                  </div>
                </div>
              </div>
            ))}
            {!readOnly && (
              <form
                className="inline"
                style={{ marginTop: 12, gap: 8 }}
                onSubmit={async (e) => {
                  e.preventDefault();
                  await call("/v1/wallet/fund", {
                    method: "POST",
                    body: JSON.stringify({ amount: Number(fundAmount), currency: fundCurrency }),
                  });
                  refresh();
                }}
              >
                <input value={fundAmount} onChange={(e) => setFundAmount(e.target.value)} style={{ width: 120 }} />
                <select value={fundCurrency} onChange={(e) => setFundCurrency(e.target.value)}>
                  {CURRENCIES.map((ccy) => (
                    <option key={ccy} value={ccy}>{ccy}</option>
                  ))}
                </select>
                <button type="submit">Fund (cents, sandbox)</button>
              </form>
            )}
          </section>

          <section>
            <h2>Pending approvals {approvals.length > 0 && `(${approvals.length})`}</h2>
            <div className="panel">
              {approvals.length === 0 ? (
                <span className="muted">Nothing waiting on you.</span>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Merchant</th>
                      <th>Amount</th>
                      <th>Reason</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {approvals.map((a) => (
                      <tr key={a.id}>
                        <td>{a.merchantName}</td>
                        <td>{cents(a.amount, a.currency)}</td>
                        <td className="muted">{a.reason}</td>
                        <td style={{ display: "flex", gap: 8 }}>
                          <button
                            disabled={readOnly}
                            onClick={async () => {
                              await call(`/v1/approvals/${a.id}/approve`, { method: "POST" });
                              refresh();
                            }}
                          >
                            Approve
                          </button>
                          <button
                            className="danger"
                            disabled={readOnly}
                            onClick={async () => {
                              await call(`/v1/approvals/${a.id}/deny`, { method: "POST" });
                              refresh();
                            }}
                          >
                            Deny
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>

          <section>
            <h2>Cards</h2>
            {!readOnly && (
              <form
                className="inline"
                style={{ marginBottom: 12 }}
                onSubmit={async (e) => {
                  e.preventDefault();
                  await call("/v1/cards", {
                    method: "POST",
                    body: JSON.stringify({ label: cardLabel || undefined, currency: cardCurrency, single_use: true }),
                  });
                  setCardLabel("");
                  refresh();
                }}
              >
                <input
                  placeholder="card label (e.g. agent groceries)"
                  value={cardLabel}
                  onChange={(e) => setCardLabel(e.target.value)}
                  style={{ width: 260 }}
                />
                <select value={cardCurrency} onChange={(e) => setCardCurrency(e.target.value)}>
                  {CURRENCIES.map((ccy) => (
                    <option key={ccy} value={ccy}>{ccy}</option>
                  ))}
                </select>
                <button type="submit">New single-use card</button>
              </form>
            )}
            <div className="panel">
              {cards.length === 0 ? (
                <span className="muted">No cards yet.</span>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Card</th>
                      <th>Label</th>
                      <th>Currency</th>
                      <th>Status</th>
                      <th>Type</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {cards.map((card) => (
                      <tr key={card.id}>
                        <td>•••• {card.last4}</td>
                        <td>{card.label ?? <span className="muted">—</span>}</td>
                        <td className="muted">{card.currency}</td>
                        <td>
                          <span className={`pill ${card.status}`}>{card.status}</span>
                        </td>
                        <td className="muted">{card.singleUse ? "single-use" : "multi-use"}</td>
                        <td>
                          {card.status === "active" && !readOnly && (
                            <button
                              className="secondary"
                              onClick={async () => {
                                await call(`/v1/cards/${card.id}/close`, { method: "POST" });
                                refresh();
                              }}
                            >
                              Close
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>

          <section>
            <h2>Transactions</h2>
            <div className="panel">
              {txns.length === 0 ? (
                <span className="muted">No transactions yet.</span>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Merchant</th>
                      <th>Amount</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {txns.map((t) => (
                      <tr key={t.id}>
                        <td className="muted">{new Date(t.createdAt).toLocaleString()}</td>
                        <td>{t.merchantName}</td>
                        <td>{cents(t.amount, t.currency)}</td>
                        <td>
                          <span className={`pill ${t.status}`}>
                            {t.status}
                            {t.declineReason ? ` · ${t.declineReason}` : ""}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>

          {can(role, "admin") && (
            <section>
              <h2>Team</h2>
              <form
                className="inline"
                style={{ marginBottom: 12, gap: 8, flexWrap: "wrap" }}
                onSubmit={async (e) => {
                  e.preventDefault();
                  await call("/v1/auth/members", {
                    method: "POST",
                    body: JSON.stringify({ email: inviteEmail, password: invitePassword, role: inviteRole }),
                  });
                  setInviteEmail("");
                  setInvitePassword("");
                  refresh();
                }}
              >
                <input placeholder="teammate email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} style={{ width: 220 }} />
                <input
                  type="password"
                  placeholder="starting password"
                  value={invitePassword}
                  onChange={(e) => setInvitePassword(e.target.value)}
                  style={{ width: 180 }}
                />
                <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value as Role)}>
                  <option value="viewer">viewer</option>
                  <option value="member">member</option>
                  <option value="admin">admin</option>
                  <option value="owner">owner</option>
                </select>
                <button type="submit">Add member</button>
              </form>
              <div className="panel">
                <table>
                  <thead>
                    <tr>
                      <th>Email</th>
                      <th>Name</th>
                      <th>Role</th>
                    </tr>
                  </thead>
                  <tbody>
                    {members.map((m) => (
                      <tr key={m.user.id}>
                        <td>{m.user.email}</td>
                        <td>{m.user.name}</td>
                        <td>
                          <span className="pill">{m.role}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}
    </main>
  );
}
