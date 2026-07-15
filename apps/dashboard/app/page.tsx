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

function cents(amount: number, currency: string) {
  return `${currency} ${(amount / 100).toFixed(2)}`;
}

export default function Dashboard() {
  const [apiKey, setApiKey] = useState("");
  const [connected, setConnected] = useState(false);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [cards, setCards] = useState<Card[]>([]);
  const [txns, setTxns] = useState<Txn[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [error, setError] = useState("");
  const [fundAmount, setFundAmount] = useState("50000");
  const [cardLabel, setCardLabel] = useState("");

  const call = useCallback(
    async (path: string, init: RequestInit = {}) => {
      const response = await fetch(`${API_URL}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          ...(init.headers ?? {}),
        },
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error?.message ?? `request failed (${response.status})`);
      return body;
    },
    [apiKey],
  );

  const refresh = useCallback(async () => {
    try {
      const [w, c, t, a] = await Promise.all([
        call("/v1/wallet"),
        call("/v1/cards"),
        call("/v1/transactions"),
        call("/v1/approvals?status=pending"),
      ]);
      setWallet(w.wallet);
      setCards(c.cards);
      setTxns(t.transactions);
      setApprovals(a.approvals);
      setConnected(true);
      setError("");
    } catch (e) {
      setConnected(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [call]);

  useEffect(() => {
    const saved = localStorage.getItem("acard_api_key");
    if (saved) setApiKey(saved);
  }, []);

  useEffect(() => {
    if (!apiKey) return;
    localStorage.setItem("acard_api_key", apiKey);
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [apiKey, refresh]);

  return (
    <main>
      <div className="topbar">
        <div>
          <h1>A-CARD</h1>
          <div className="muted">Virtual cards for AI agents — sandbox console</div>
        </div>
        <form
          className="inline"
          onSubmit={(e) => {
            e.preventDefault();
            refresh();
          }}
        >
          <input
            type="password"
            placeholder="API key (ak_live_...)"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            style={{ width: 280 }}
          />
          <button type="submit">Connect</button>
        </form>
      </div>

      {error && (
        <section>
          <div className="panel" style={{ color: "var(--red)" }}>
            {error} — make sure the API is running (`npm run dev:api`) and the key is valid.
          </div>
        </section>
      )}

      {connected && wallet && (
        <>
          <section>
            <h2>Wallet</h2>
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
            <form
              className="inline"
              style={{ marginTop: 12 }}
              onSubmit={async (e) => {
                e.preventDefault();
                await call("/v1/wallet/fund", { method: "POST", body: JSON.stringify({ amount: Number(fundAmount) }) });
                refresh();
              }}
            >
              <input value={fundAmount} onChange={(e) => setFundAmount(e.target.value)} style={{ width: 120 }} />
              <button type="submit">Fund (cents, sandbox)</button>
            </form>
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
                            onClick={async () => {
                              await call(`/v1/approvals/${a.id}/approve`, { method: "POST" });
                              refresh();
                            }}
                          >
                            Approve
                          </button>
                          <button
                            className="danger"
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
            <form
              className="inline"
              style={{ marginBottom: 12 }}
              onSubmit={async (e) => {
                e.preventDefault();
                await call("/v1/cards", {
                  method: "POST",
                  body: JSON.stringify({ label: cardLabel || undefined, single_use: true }),
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
              <button type="submit">New single-use card</button>
            </form>
            <div className="panel">
              {cards.length === 0 ? (
                <span className="muted">No cards yet.</span>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Card</th>
                      <th>Label</th>
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
                        <td>
                          <span className={`pill ${card.status}`}>{card.status}</span>
                        </td>
                        <td className="muted">{card.singleUse ? "single-use" : "multi-use"}</td>
                        <td>
                          {card.status === "active" && (
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
        </>
      )}
    </main>
  );
}
