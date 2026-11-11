"use client";

import { useCallback, useEffect, useState } from "react";

type Call = (path: string, init?: RequestInit) => Promise<any>;
type Chain = "ethereum" | "polygon" | "solana";
interface CryptoWallet { id: string; kind: "embedded" | "external"; chain: Chain; address: string; connector?: string; label?: string; isDefault: boolean }
interface Scored { rail: string; score: number; finality: { kind: string; windowDays?: number; delaySeconds?: number }; quote: { costCents: number; etaSeconds: number }; matchReasons: string[] }
interface Decision { scored: Scored[]; rejected: { rail: string; reason: string }[] }
interface Tx { id: string; rail: string; amount: number; currency: string; status: string; railReference?: string; purpose?: string; createdAt: string }

const RAIL: Record<string, string> = { card: "Card", x402: "x402 (pay an API)", stablecoin: "Stablecoin (USDC)" };
const short = (a: string) => (a.length > 14 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a);
const money = (cents: number, ccy: string) => `${ccy === "ZAR" ? "R" : "$"}${(cents / 100).toLocaleString("en-ZA", { minimumFractionDigits: 2 })}`;
const finality = (f: Scored["finality"]) =>
  f.kind === "instant" ? "Final once confirmed" : f.kind === "reversal_window" ? `Can be reversed for ${f.windowDays ?? 120} days` : `Settles after ~${f.delaySeconds ?? 0}s`;
const CONNECTORS = ["metamask", "walletconnect", "coinbase", "other"];

const empty = { padding: "26px 8px", color: "var(--muted)", fontSize: 14, textAlign: "center" as const };
const th = { textAlign: "left" as const, fontSize: 12, color: "var(--muted)", fontWeight: 500, padding: "6px 10px 6px 0" };
const td = { padding: "10px 10px 10px 0", borderTop: "1px solid var(--border-soft)", fontSize: 14, verticalAlign: "top" as const };

/** Linked crypto wallets: the embedded wallet made at signup, plus any the user links. */
export function CryptoWallets({ call, flash, readOnly }: { call: Call; flash: (m: string) => void; readOnly: boolean }) {
  const [wallets, setWallets] = useState<CryptoWallet[] | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [chain, setChain] = useState<Chain>("ethereum");
  const [address, setAddress] = useState("");
  const [connector, setConnector] = useState("metamask");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setWallets((await call("/v1/wallets/crypto")).wallets ?? []); setUnavailable(false); }
    catch { setUnavailable(true); setWallets([]); }
  }, [call]);
  useEffect(() => { void load(); }, [load]);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try { await fn(); flash(ok); await load(); } catch (e) { flash((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div>
      <div className="panel panel-pad" style={{ marginBottom: 18 }}>
        <div className="eyebrow">CRYPTO WALLETS</div>
        <p style={{ color: "var(--muted)", fontSize: 14, margin: "6px 0 12px" }}>Every account gets an embedded wallet at signup. You can also link your own (MetaMask, WalletConnect, Coinbase, Solana). Your agent can read these balances; it cannot move funds from them without your policy and approval.</p>
        {wallets === null ? <div style={empty}>Loading…</div> : wallets.length === 0 ? (
          <div style={empty}>{unavailable ? "Crypto wallets aren't enabled on this deployment." : "No wallets linked yet."}</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr><th style={th}>Wallet</th><th style={th}>Chain</th><th style={th}>Address</th><th style={th} /></tr></thead>
              <tbody>
                {wallets.map((w) => (
                  <tr key={w.id}>
                    <td style={td}><b>{w.label ?? (w.kind === "embedded" ? "Embedded wallet" : w.connector ?? "External")}</b> {w.isDefault && <span className="pill active">default</span>}<div style={{ color: "var(--muted)", fontSize: 12.5 }}>{w.kind === "embedded" ? "Created for you" : "Linked by you"}</div></td>
                    <td style={td}>{w.chain}</td>
                    <td style={{ ...td, fontFamily: "var(--font-mono)", fontSize: 13 }} title={w.address}>{short(w.address)}</td>
                    <td style={{ ...td, textAlign: "right", whiteSpace: "nowrap" }}>
                      {!readOnly && !w.isDefault && <button className="btn btn-outline" disabled={busy} onClick={() => act(() => call(`/v1/wallets/crypto/${w.id}/default`, { method: "POST", body: "{}" }), "Default wallet updated.")}>Make default</button>}{" "}
                      {!readOnly && w.kind === "external" && <button className="btn btn-outline" disabled={busy} onClick={() => act(() => call(`/v1/wallets/crypto/${w.id}`, { method: "DELETE" }), "Wallet unlinked.")}>Unlink</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {!readOnly && !unavailable && (
        <div className="panel panel-pad">
          <div className="eyebrow">LINK YOUR OWN WALLET</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))", gap: 12 }}>
            <div className="field"><label>CHAIN</label><select value={chain} onChange={(e) => setChain(e.target.value as Chain)}><option value="ethereum">Ethereum</option><option value="polygon">Polygon</option><option value="solana">Solana</option></select></div>
            <div className="field"><label>APP</label><select value={connector} onChange={(e) => setConnector(e.target.value)}>{CONNECTORS.map((c) => <option key={c} value={c}>{c}</option>)}</select></div>
            <div className="field"><label>NAME (OPTIONAL)</label><input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Treasury" /></div>
          </div>
          <div className="field"><label>ADDRESS</label><input value={address} onChange={(e) => setAddress(e.target.value)} placeholder={chain === "solana" ? "Solana address" : "0x…"} style={{ fontFamily: "var(--font-mono)" }} /></div>
          <button className="btn btn-green" style={{ marginTop: 16 }} disabled={busy || !address.trim()} onClick={() => act(async () => { await call("/v1/wallets/crypto/link", { method: "POST", body: JSON.stringify({ chain, address: address.trim(), connector, label: label.trim() || undefined }) }); setAddress(""); setLabel(""); }, "Wallet linked.")}>Link wallet</button>
          <p style={{ color: "var(--muted)", fontSize: 12.5, marginTop: 10 }}>This only records the address so you and your agent can see it. A-CARD never holds the keys to a wallet you link.</p>
        </div>
      )}
    </div>
  );
}

/** AFP: say what you want to pay; every rail quotes it; pick one; the ledger keeps one record. */
export function PayRouting({ call, flash, readOnly }: { call: Call; flash: (m: string) => void; readOnly: boolean }) {
  const [amount, setAmount] = useState("25");
  const [currency, setCurrency] = useState("USD");
  const [purpose, setPurpose] = useState("Supplier payment");
  const [counterparty, setCounterparty] = useState("0x000000000000000000000000000000000000dEaD");
  const [intentId, setIntentId] = useState("");
  const [decision, setDecision] = useState<Decision | null>(null);
  const [result, setResult] = useState<{ tx?: Tx; error?: string } | null>(null);
  const [ledger, setLedger] = useState<Tx[]>([]);
  const [off, setOff] = useState(false);
  const [busy, setBusy] = useState(false);

  const loadLedger = useCallback(async () => {
    try { setLedger(((await call("/v1/afp/transactions")).transactions ?? []).slice(0, 12)); setOff(false); }
    catch { setOff(true); }
  }, [call]);
  useEffect(() => { void loadLedger(); }, [loadLedger]);

  const quote = async () => {
    setBusy(true); setResult(null); setDecision(null);
    try {
      const cents = Math.round(Number(amount) * 100);
      if (!(cents > 0)) throw new Error("Enter an amount above zero.");
      const r = await call("/v1/afp/intents", { method: "POST", body: JSON.stringify({ amount: cents, currency, purpose: purpose || "Payment", counterparty }) });
      setIntentId(r.intent.id); setDecision(r.decision);
    } catch (e) { flash((e as Error).message); } finally { setBusy(false); }
  };
  const pay = async (rail: string) => {
    setBusy(true);
    try {
      const r = await call(`/v1/afp/intents/${intentId}/execute`, { method: "POST", headers: { "idempotency-key": `ui-${intentId}-${rail}` }, body: JSON.stringify({ rail }) });
      setResult({ tx: r.transaction }); flash(r.transaction.status === "settled" ? "Settled." : `Ledger: ${r.transaction.status}`); await loadLedger();
    } catch (e) { setResult({ error: (e as Error).message }); } finally { setBusy(false); }
  };

  if (off) return <div className="panel panel-pad"><div style={empty}>Payment routing (AFP) isn't enabled on this deployment.</div></div>;
  return (
    <div>
      <div className="panel panel-pad" style={{ marginBottom: 18 }}>
        <div className="eyebrow">PAY FROM ANY WALLET</div>
        <p style={{ color: "var(--muted)", fontSize: 14, margin: "6px 0 12px" }}>Say what you want to pay. Each rail is asked whether it can carry it, scored on cost, speed and how final it is, and the reasons are kept.</p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 12 }}>
          <div className="field"><label>AMOUNT</label><input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
          <div className="field"><label>CURRENCY</label><select value={currency} onChange={(e) => setCurrency(e.target.value)}><option value="USD">USD</option><option value="ZAR">ZAR</option></select></div>
          <div className="field"><label>FOR</label><input value={purpose} onChange={(e) => setPurpose(e.target.value)} /></div>
        </div>
        <div className="field"><label>PAYEE (WALLET ADDRESS, API URL OR MERCHANT)</label><input value={counterparty} onChange={(e) => setCounterparty(e.target.value)} style={{ fontFamily: "var(--font-mono)" }} /></div>
        <button className="btn btn-green" style={{ marginTop: 16 }} disabled={busy || readOnly} onClick={quote}>Compare routes</button>
      </div>

      {decision && (
        <div className="panel panel-pad" style={{ marginBottom: 18 }}>
          <div className="eyebrow">ROUTING DECISION</div>
          {decision.scored.map((s, i) => (
            <div key={s.rail} style={{ margin: "12px 0", padding: "14px 16px", borderRadius: 14, border: "1px solid var(--border)", background: i === 0 ? "var(--green-bg)" : "var(--surface-2)", display: "flex", justifyContent: "space-between", gap: 14, flexWrap: "wrap" }}>
              <div>
                <b>{RAIL[s.rail] ?? s.rail}</b> {i === 0 && <span className="pill active">best fit</span>}
                <div style={{ color: "var(--muted)", fontSize: 13.5, marginTop: 4 }}>{finality(s.finality)} · fee {money(s.quote.costCents, "USD")} · about {s.quote.etaSeconds}s</div>
                <div style={{ color: "var(--muted)", fontSize: 12.5, marginTop: 6 }}>{s.matchReasons.join(" · ")}</div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 18 }}>{s.score.toFixed(2)}</div>
                {!readOnly && <button className={`btn ${i === 0 ? "btn-green" : "btn-outline"}`} style={{ marginTop: 8 }} disabled={busy} onClick={() => pay(s.rail)}>Pay with this</button>}
              </div>
            </div>
          ))}
          {decision.rejected.map((x) => <div key={x.rail} style={{ color: "var(--muted)", fontSize: 13.5, padding: "4px 2px" }}><b>{RAIL[x.rail] ?? x.rail}</b> can't carry this: {x.reason}</div>)}
          {decision.scored.length === 0 && <div style={empty}>No rail can carry this payment as stated.</div>}
          {result?.error && <div role="alert" style={{ color: "var(--red)", marginTop: 10, fontSize: 14 }}>{result.error}</div>}
          {result?.tx && <div role="status" style={{ marginTop: 10, fontSize: 14 }}>Ledger status: <b>{result.tx.status}</b>{result.tx.railReference ? <> · ref <span style={{ fontFamily: "var(--font-mono)" }}>{short(result.tx.railReference)}</span></> : null}</div>}
        </div>
      )}

      <div className="panel panel-pad">
        <div className="eyebrow">UNIFIED LEDGER</div>
        {ledger.length === 0 ? <div style={empty}>No payments yet.</div> : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr><th style={th}>Rail</th><th style={th}>For</th><th style={{ ...th, textAlign: "right" }}>Amount</th><th style={th}>Status</th></tr></thead>
              <tbody>{ledger.map((t) => (
                <tr key={t.id}><td style={td}>{RAIL[t.rail] ?? t.rail}</td><td style={td}>{t.purpose ?? "—"}</td><td style={{ ...td, textAlign: "right", fontFamily: "var(--font-mono)" }}>{money(t.amount, t.currency)}</td><td style={td}><span className={`pill ${t.status === "settled" ? "completed" : t.status === "failed" || t.status === "reversed" ? "declined" : "pending"}`}>{t.status}</span></td></tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
