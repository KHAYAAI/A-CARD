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

/* ------------------------------------------------------------------ attached cards */
interface AttachedCardRow { id: string; brand: string; last4: string; exp_month: number; exp_year: number; label: string | null }
interface AttachedPurchaseRow { id: string; amount: number; currency: string; merchant_name: string; status: string; reason: string | null; approved_by: string | null; release: { release_ref: string } | null; created_at: string }
const BRAND: Record<string, string> = { visa: "Visa", mastercard: "Mastercard", amex: "Amex" };
const TEST_REFS = ["test_tok_visa_4242_1230", "test_tok_mastercard_4444_1230", "test_tok_amex_0005_1230"];

/**
 * Cards the holder already has, used by agents without ever exposing them.
 * The card is held by a certified vault or as a network token: A-CARD only
 * keeps a reference. Bigger purchases need a passkey signature from the
 * holder's own device.
 */
export function AttachedCards({ call, flash, mode = "full" }: { call: Call; flash: (m: string) => void; mode?: "full" | "security" | "approvals" }) {
  const [state, setState] = useState<{ cards: AttachedCardRow[]; settings: { autoApproveUnder: number; maxPerPurchase: number }; provider: { name: string; kind: string } } | null>(null);
  const [purchases, setPurchases] = useState<AttachedPurchaseRow[]>([]);
  const [passkeys, setPasskeys] = useState<{ id: string; created_at: string }[] | null>(null);
  const [security, setSecurity] = useState<{ recovery_codes: { total: number; unused: number }; cooldown_until: string | null; events: { kind: string; at: string }[] } | null>(null);
  const [newCodes, setNewCodes] = useState<string[] | null>(null);
  const [showRecover, setShowRecover] = useState(false);
  const [recCode, setRecCode] = useState("");
  const [recPassword, setRecPassword] = useState("");
  const [off, setOff] = useState("");
  const [busy, setBusy] = useState(false);
  const [auto, setAuto] = useState("");
  const [max, setMax] = useState("");

  const load = useCallback(async () => {
    try {
      const s = await call("/v1/attached-cards");
      setState(s); setAuto(String(s.settings.autoApproveUnder / 100)); setMax(String(s.settings.maxPerPurchase / 100));
      setPurchases((await call("/v1/attached-cards/purchases")).purchases ?? []);
      setOff("");
    } catch (e) { setOff((e as Error).message.includes("404") || /not found/i.test((e as Error).message) ? "Attached cards aren't enabled on this deployment." : (e as Error).message); }
    try { const st = await call("/v1/passkeys"); setPasskeys(st.passkeys); setSecurity(st); } catch { setPasskeys(null); setSecurity(null); }
  }, [call]);
  useEffect(() => { void load(); }, [load]);

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try { await fn(); if (ok) flash(ok); await load(); } catch (e) { flash((e as Error).message); } finally { setBusy(false); }
  };

  const addPasskey = () => run(async () => {
    const { startRegistration } = await import("@simplewebauthn/browser");
    const { options } = await call("/v1/passkeys/registration-options", { method: "POST", body: "{}" });
    const response = await startRegistration({ optionsJSON: options });
    const r = await call("/v1/passkeys/registration", { method: "POST", body: JSON.stringify({ passkey_response: response }) });
    if (r.recovery_codes) setNewCodes(r.recovery_codes);
  }, "Passkey added on this device.");

  const removePasskey = (id: string) => run(async () => {
    const { startAuthentication } = await import("@simplewebauthn/browser");
    const { options } = await call(`/v1/passkeys/${id}/removal-options`, { method: "POST", body: "{}" });
    const response = await startAuthentication({ optionsJSON: options });
    await call(`/v1/passkeys/${id}/remove`, { method: "POST", body: JSON.stringify({ passkey_response: response }) });
  }, "Passkey removed. That device can't approve anything now.");

  const freshCodes = () => run(async () => {
    const { startAuthentication } = await import("@simplewebauthn/browser");
    const { options } = await call("/v1/passkeys/recovery-codes/options", { method: "POST", body: "{}" });
    const response = await startAuthentication({ optionsJSON: options });
    setNewCodes((await call("/v1/passkeys/recovery-codes", { method: "POST", body: JSON.stringify({ passkey_response: response }) })).recovery_codes);
  }, "New recovery codes issued. The old ones no longer work.");

  const recover = () => run(async () => {
    const r = await call("/v1/passkeys/recover", { method: "POST", body: JSON.stringify({ recovery_code: recCode, password: recPassword }) });
    setRecCode(""); setRecPassword(""); setShowRecover(false);
    flash(`Recovered: ${r.passkeys_removed} passkey${r.passkeys_removed === 1 ? "" : "s"} removed. Add a passkey on your new phone. Approvals are paused until ${new Date(r.cooldown_until).toLocaleString()}.`);
  });

  const approve = (id: string) => run(async () => {
    const { startAuthentication } = await import("@simplewebauthn/browser");
    const { options } = await call(`/v1/attached-cards/purchases/${id}/approval-options`, { method: "POST", body: "{}" });
    const response = await startAuthentication({ optionsJSON: options });
    const r = await call(`/v1/attached-cards/purchases/${id}/approve`, { method: "POST", body: JSON.stringify({ passkey_response: response }) });
    flash(r.purchase.status === "paid" ? "Approved with your passkey. Paid on your card." : `Purchase ${r.purchase.status}.`);
  });

  if (off) return mode === "approvals" ? null : <div className="panel panel-pad"><div style={empty}>{mode === "security" ? "Passkeys aren't enabled on this deployment yet." : off}</div></div>;
  if (!state) return mode === "approvals" ? null : <div className="panel panel-pad"><div style={empty}>Loading…</div></div>;
  const waiting = purchases.filter((p) => p.status === "awaiting_approval");
  const isTest = state.provider.kind === "test";
  const show = (section: "intro" | "passkey" | "waiting" | "rest") => mode === "full" || (mode === "security" && section === "passkey") || (mode === "approvals" && section === "waiting");
  if (mode === "approvals" && waiting.length === 0) return null;
  return (
    <div>
      {show("intro") && <div className="panel panel-pad" style={{ marginBottom: 18 }}>
        <div className="eyebrow">YOUR OWN CARDS</div>
        <p style={{ color: "var(--muted)", fontSize: 14, margin: "6px 0 0" }}>Let agents pay with a card you already have, without ever seeing it. The card is held by {isTest ? "a test vault (development only)" : `your card vault (${state.provider.name})`}, never by A-CARD. Your rules run first; anything over your auto-approve amount needs your passkey; then a single-use credential is released for that merchant and amount only.</p>
      </div>}

      {show("passkey") && <div className="panel panel-pad" style={{ marginBottom: 18 }}>
        <div className="eyebrow">PASSKEY</div>
        {passkeys === null ? <p style={{ color: "var(--muted)", fontSize: 14 }}>Sign in with your email and password to use passkeys. An API key can't approve purchases.</p> : (
          <>
            <p style={{ color: "var(--muted)", fontSize: 14, margin: "6px 0 10px" }}>{passkeys.length ? `${passkeys.length} passkey${passkeys.length === 1 ? "" : "s"} registered. You'll be asked for Face ID, fingerprint or your device PIN to approve purchases.` : "Add a passkey on this device so you can approve purchases with Face ID, fingerprint or your device PIN."}</p>
            {security?.cooldown_until && <div role="alert" style={{ background: "var(--amber-bg)", color: "var(--amber)", padding: "10px 14px", borderRadius: 12, margin: "0 0 12px", fontSize: 14 }}>A passkey recovery happened recently. To protect you if it wasn't you, approvals and raising limits are paused until {new Date(security.cooldown_until).toLocaleString()}.</div>}
            {newCodes && (
              <div style={{ border: "1px solid var(--border)", borderRadius: 14, padding: 14, margin: "0 0 12px", background: "var(--surface-2)" }}>
                <b>Save your recovery codes now.</b> <span style={{ color: "var(--muted)", fontSize: 13 }}>Each works once, if you lose your phone. We won't show them again.</span>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(130px,1fr))", gap: 6, margin: "10px 0", fontFamily: "var(--font-mono)", fontSize: 14 }}>{newCodes.map((c) => <span key={c}>{c}</span>)}</div>
                <div style={{ display: "flex", gap: 8 }}><button className="btn btn-outline" onClick={() => navigator.clipboard?.writeText(newCodes.join("\n"))}>Copy</button><button className="btn btn-green" onClick={() => setNewCodes(null)}>I've saved them</button></div>
              </div>
            )}
            {passkeys.map((k, i) => (
              <div key={k.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderTop: "1px solid var(--border-soft)", fontSize: 14 }}>
                <span>Passkey {i + 1} <span style={{ color: "var(--muted)" }}>added {new Date(k.created_at).toLocaleDateString()}</span></span>
                {passkeys.length > 1 && <button className="btn btn-outline" disabled={busy} onClick={() => removePasskey(k.id)}>Remove (lost device)</button>}
              </div>
            ))}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
              <button className="btn btn-outline" disabled={busy} onClick={addPasskey}>{passkeys.length ? "Add another passkey" : "Add a passkey"}</button>
              {passkeys.length > 0 && <button className="btn btn-outline" disabled={busy} onClick={freshCodes}>New recovery codes</button>}
              <button className="btn btn-outline" disabled={busy} onClick={() => setShowRecover(!showRecover)}>Lost your phone?</button>
            </div>
            {security && passkeys.length > 0 && <p style={{ color: "var(--muted)", fontSize: 12.5, marginTop: 8 }}>{security.recovery_codes.unused} of {security.recovery_codes.total} recovery codes left. Tip: add a passkey on a second device too, so a lost phone is a one-click fix.</p>}
            {showRecover && (
              <div style={{ border: "1px solid var(--border)", borderRadius: 14, padding: 14, marginTop: 12 }}>
                <p style={{ margin: "0 0 8px", fontSize: 14 }}>If you still have another device with a passkey, remove the lost one above instead. Otherwise use one of your recovery codes: <b>every</b> passkey will be removed, and approvals pause for 24 hours.</p>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: 12 }}>
                  <div className="field"><label>RECOVERY CODE</label><input value={recCode} onChange={(e) => setRecCode(e.target.value)} placeholder="ABCDE-FGHJK" autoComplete="one-time-code" /></div>
                  <div className="field"><label>YOUR PASSWORD</label><input type="password" value={recPassword} onChange={(e) => setRecPassword(e.target.value)} autoComplete="current-password" /></div>
                </div>
                <button className="btn btn-green" style={{ marginTop: 12 }} disabled={busy || !recCode || !recPassword} onClick={recover}>Recover my account</button>
              </div>
            )}
            {security && security.events.length > 0 && (
              <details style={{ marginTop: 12 }}><summary style={{ cursor: "pointer", fontSize: 13, color: "var(--muted)" }}>Recent passkey activity</summary>
                <ul style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 13, color: "var(--muted)" }}>{security.events.slice(0, 10).map((e, i) => <li key={i}>{new Date(e.at).toLocaleString()}: {e.kind.replace(/_/g, " ")}</li>)}</ul>
              </details>
            )}
          </>
        )}
      </div>}

      {show("waiting") && waiting.length > 0 && (
        <div className="panel panel-pad" style={{ marginBottom: 18 }}>
          <div className="eyebrow">{mode === "approvals" ? "PURCHASES ON YOUR OWN CARD: WAITING FOR YOUR PASSKEY" : "WAITING FOR YOUR PASSKEY"}</div>
          {waiting.map((p) => (
            <div key={p.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, padding: "12px 0", borderTop: "1px solid var(--border-soft)", flexWrap: "wrap" }}>
              <div><b>{money(p.amount, p.currency)}</b> at {p.merchant_name}</div>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn btn-green" disabled={busy || !passkeys?.length} onClick={() => approve(p.id)}>Approve with passkey</button>
                <button className="btn btn-outline" disabled={busy} onClick={() => run(() => call(`/v1/attached-cards/purchases/${p.id}/deny`, { method: "POST", body: "{}" }), "Declined. Nothing was charged.")}>Deny</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {show("rest") && <>
      <div className="panel panel-pad" style={{ marginBottom: 18 }}>
        <div className="eyebrow">ATTACHED CARDS</div>
        {state.cards.length === 0 ? <div style={empty}>No cards attached yet.</div> : state.cards.map((c) => (
          <div key={c.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderTop: "1px solid var(--border-soft)" }}>
            <div><b>{BRAND[c.brand] ?? c.brand} •••• {c.last4}</b> <span style={{ color: "var(--muted)", fontSize: 13 }}>exp {String(c.exp_month).padStart(2, "0")}/{String(c.exp_year).slice(-2)}{c.label ? ` · ${c.label}` : ""}</span></div>
            <button className="btn btn-outline" disabled={busy} onClick={() => run(() => call(`/v1/attached-cards/${c.id}`, { method: "DELETE" }), "Card removed.")}>Remove</button>
          </div>
        ))}
        <div style={{ marginTop: 14 }}>
          {isTest ? (
            <>
              <p style={{ color: "var(--muted)", fontSize: 13, margin: "0 0 8px" }}>Development only: attach a test card reference. In production your card vault's own secure form opens here, and A-CARD never sees the number.</p>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>{TEST_REFS.map((ref) => <button key={ref} className="btn btn-outline" disabled={busy} onClick={() => run(() => call("/v1/attached-cards", { method: "POST", body: JSON.stringify({ provider_ref: ref }) }), "Test card attached.")}>{ref.split("_")[2]} •••• {ref.split("_")[3]}</button>)}</div>
            </>
          ) : <p style={{ color: "var(--muted)", fontSize: 13 }}>Adding a card opens your card vault's secure form. (Not connected yet: no vault partner is configured.)</p>}
        </div>
      </div>

      <div className="panel panel-pad" style={{ marginBottom: 18 }}>
        <div className="eyebrow">YOUR RULES</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: 12 }}>
          <div className="field"><label>APPROVE WITHOUT PASSKEY UP TO</label><input inputMode="decimal" value={auto} onChange={(e) => setAuto(e.target.value)} /></div>
          <div className="field"><label>REFUSE ANYTHING OVER</label><input inputMode="decimal" value={max} onChange={(e) => setMax(e.target.value)} /></div>
        </div>
        <button className="btn btn-outline" style={{ marginTop: 14 }} disabled={busy} onClick={() => run(() => call("/v1/attached-cards/settings", { method: "PUT", body: JSON.stringify({ auto_approve_under: Math.round(Number(auto) * 100), max_per_purchase: Math.round(Number(max) * 100) }) }), "Rules saved.")}>Save rules</button>
        <p style={{ color: "var(--muted)", fontSize: 12.5, marginTop: 10 }}>Your organisation's blocked categories also apply.</p>
      </div>

      <div className="panel panel-pad">
        <div className="eyebrow">PURCHASES ON YOUR CARDS</div>
        {purchases.length === 0 ? <div style={empty}>None yet.</div> : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr><th style={th}>Merchant</th><th style={{ ...th, textAlign: "right" }}>Amount</th><th style={th}>Status</th><th style={th}>Approved by</th></tr></thead>
              <tbody>{purchases.map((p) => (
                <tr key={p.id}><td style={td}>{p.merchant_name}</td><td style={{ ...td, textAlign: "right", fontFamily: "var(--font-mono)" }}>{money(p.amount, p.currency)}</td>
                  <td style={td}><span className={`pill ${p.status === "paid" ? "completed" : p.status === "awaiting_approval" ? "pending" : "declined"}`}>{p.status === "awaiting_approval" ? "waiting" : p.status}</span>{p.reason ? <div style={{ color: "var(--muted)", fontSize: 12 }}>{p.reason.replace(/_/g, " ")}</div> : null}</td>
                  <td style={td}>{p.approved_by === "auto_approve_rule" ? "your rule" : p.approved_by ?? "—"}</td></tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </div>
      </>}
    </div>
  );
}
