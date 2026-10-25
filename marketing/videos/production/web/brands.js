// Brand sets for the demo stores. `public` is fictional and safe to publish.
// `private` recreates the look of real South African retailers for PRIVATE
// client demos only: names and colours, no logos or copied assets, and every
// page shows a "not affiliated" strip. Never publish a `private` render.
window.BRANDS = {
  public: {
    note: "",
    grocery: { name: "FreshCart", mark: 'fresh<i style="font-style:normal;color:#84cc16">cart</i>', domain: "freshcart.demo", primary: "#15803d", accent: "#84cc16", header: "#ffffff", headerInk: "#15803d", pill: "" },
    market: { name: "Shoply", mark: "shoply", domain: "shoply.demo", primary: "#4338ca", accent: "#f59e0b", header: "#4338ca", headerInk: "#ffffff", buy: "#16a34a" },
    airline: { name: "SkyHop", mark: "SkyHop", domain: "skyhop.demo", primary: "#0c2340", accent: "#f97316", header: "#0c2340", headerInk: "#ffffff", code: "SH" },
  },
  private: {
    note: "Illustrative recreation for a private client demo · not affiliated with or endorsed by",
    grocery: { name: "Checkers Sixty60", mark: 'Checkers <span style="background:#e30613;color:#fff;border-radius:999px;padding:2px 9px;font-size:13px;letter-spacing:0;vertical-align:3px">Sixty60</span>', domain: "checkers.co.za/sixty60", primary: "#00205b", accent: "#e30613", header: "#00205b", headerInk: "#ffffff", owner: "Checkers" },
    market: { name: "Takealot", mark: "takealot", domain: "takealot.com", primary: "#0b79bf", accent: "#f5a623", header: "#0b79bf", headerInk: "#ffffff", buy: "#3bb54a", owner: "Takealot" },
    airline: { name: "FlySafair", mark: "FlySafair", domain: "flysafair.co.za", primary: "#0b1f3a", accent: "#f26c1d", header: "#ffffff", headerInk: "#0b1f3a", code: "FA", owner: "FlySafair" },
  },
};

window.brandFor = (kind) => {
  const set = new URLSearchParams(location.search).get("set") === "private" ? "private" : "public";
  return { set, b: window.BRANDS[set][kind], note: window.BRANDS[set].note };
};

/** The strip every private-set page carries. */
window.affiliationStrip = (b, note) =>
  note ? `<div style="background:#111827;color:#fbbf24;font:600 11px/1 ui-sans-serif,system-ui,sans-serif;letter-spacing:.3px;text-align:center;padding:6px 10px">${note} ${b.owner}</div>` : "";

/** Rands, South African style: R1 234.50 */
window.R = (c) => "R" + (c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/,/g, " ");

/** Pay through the sandbox card network; the decision comes from A-CARD. */
window.payWithCard = async ({ pan, amount, merchant, category }) =>
  fetch("/api/pay", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pan, amount, merchant, category }) }).then((r) => r.json());

window.paymentResult = (box, res, okHtml) => {
  if (res.approved) { box.className = "result ok"; box.innerHTML = okHtml; }
  else if (res.decline_reason === "pending_human_approval") {
    box.className = "result held";
    box.innerHTML = `<b>Payment awaiting approval</b> from your organisation.<br><code>${res.decline_reason}</code>`;
  } else {
    box.className = "result bad";
    box.innerHTML = `<b>Payment declined by your card issuer</b><br><code>${res.decline_reason}</code>`;
  }
};
