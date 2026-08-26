import { chromium } from "playwright";

export const API = "http://localhost:8787";
export const APP = "http://localhost:3000";
export const OUT = "/home/user/A-CARD/tutorials";

const VIEWPORT = { width: 1280, height: 720 };

/** Launch a recording context. Video is written on ctx.close(). */
export async function studio(name) {
  const browser = await chromium.launch({
    executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    args: ["--no-sandbox", "--force-color-profile=srgb", "--font-render-hinting=none"],
  });
  const ctx = await browser.newContext({
    viewport: VIEWPORT,
    recordVideo: { dir: `${OUT}/.raw/${name}`, size: VIEWPORT },
    deviceScaleFactor: 1,
    colorScheme: "dark",
  });
  const page = await ctx.newPage();
  await installChrome(page);
  return { browser, ctx, page };
}

/** Caption bar + fake cursor + step badge, injected on every navigation. */
async function installChrome(page) {
  await page.addInitScript(() => {
    window.__acard = { ready: false };
    const boot = () => {
      if (document.getElementById("__cap")) return;
      const style = document.createElement("style");
      style.textContent = `
        #__cap{position:fixed;left:0;right:0;bottom:0;z-index:2147483647;
          font:500 19px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
          background:linear-gradient(to top,rgba(6,10,16,.985),rgba(6,10,16,.9));
          color:#f2f6fb;padding:19px 34px 23px;border-top:2px solid #22c55e;
          transform:translateY(110%);transition:transform .4s cubic-bezier(.2,.8,.2,1);
          text-shadow:0 1px 3px rgba(0,0,0,.6);letter-spacing:.1px;
          display:flex;align-items:baseline;gap:15px}
        #__cap.on{transform:translateY(0)}
        #__cap b{color:#4ade80;font-weight:700}
        #__cap code{background:rgba(255,255,255,.13);padding:2px 7px;border-radius:5px;
          font:600 16px/1 ui-monospace,SFMono-Regular,Menlo,monospace;color:#a7f3d0}
        #__badge{flex:none;font:700 11px/1 ui-sans-serif,system-ui,sans-serif;letter-spacing:1.4px;
          text-transform:uppercase;background:#22c55e;color:#04120a;
          padding:7px 12px;border-radius:999px;position:relative;top:-2px;display:none}
        #__badge.on{display:inline-block}
        #__captext{flex:1}
        #__cur{position:fixed;z-index:2147483646;width:22px;height:22px;margin:-11px 0 0 -11px;
          border-radius:50%;border:2.5px solid #22c55e;background:rgba(34,197,94,.28);
          pointer-events:none;opacity:0;transition:opacity .25s;
          box-shadow:0 0 0 5px rgba(34,197,94,.14),0 3px 14px rgba(0,0,0,.5)}
        #__cur.on{opacity:1}
        #__cur.tap{animation:__tap .4s ease-out}
        @keyframes __tap{0%{transform:scale(1)}45%{transform:scale(.55)}100%{transform:scale(1)}}
      `;
      document.head.appendChild(style);
      const cap = document.createElement("div");
      cap.id = "__cap";
      cap.innerHTML = `<span id="__badge"></span><span id="__captext"></span>`;
      document.body.appendChild(cap);
      const cur = document.createElement("div");
      cur.id = "__cur";
      document.body.appendChild(cur);
      window.__acard.ready = true;
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
    else boot();
    // Re-inject if the SPA wipes body children.
    new MutationObserver(() => { if (!document.getElementById("__cap") && document.body) boot(); })
      .observe(document.documentElement, { childList: true, subtree: true });
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Reading time: generous, so a viewer can actually finish the line. */
const readMs = (t) => Math.min(9000, Math.max(2600, t.replace(/<[^>]+>/g, "").length * 62));

export function make(page) {
  const ui = {
    /** Show a caption. `hold` overrides the auto reading time. Hides the cursor so it never sits over the text. */
    async say(html, hold) {
      await page.evaluate((h) => {
        document.getElementById("__cur")?.classList.remove("on");
        const t = document.getElementById("__captext");
        const c = document.getElementById("__cap");
        if (t && c) { t.innerHTML = h; c.classList.add("on"); }
      }, html);
      await wait(hold ?? readMs(html));
    },
    async clear() {
      await page.evaluate(() => {
        document.getElementById("__cap")?.classList.remove("on");
        document.getElementById("__cur")?.classList.remove("on");
      });
      await wait(420);
    },
    async badge(text) {
      await page.evaluate((t) => {
        const b = document.getElementById("__badge");
        if (b) { b.textContent = t; b.classList.add("on"); }
      }, text);
    },
    /** Glide the cursor to an element and click it. */
    async click(sel, { pre = 340, post = 700 } = {}) {
      const el = page.locator(sel).first();
      await el.waitFor({ state: "visible", timeout: 15000 });
      await el.scrollIntoViewIfNeeded();
      await wait(220);
      const b = await el.boundingBox();
      if (b) {
        const x = Math.round(b.x + b.width / 2), y = Math.round(b.y + b.height / 2);
        await page.evaluate(({ x, y }) => {
          const c = document.getElementById("__cur");
          if (c) { c.classList.add("on"); c.style.transition = "left .5s cubic-bezier(.3,.8,.3,1),top .5s cubic-bezier(.3,.8,.3,1),opacity .25s"; c.style.left = x + "px"; c.style.top = y + "px"; }
        }, { x, y });
        await wait(560);
        await page.evaluate(() => {
          const c = document.getElementById("__cur");
          if (c) { c.classList.remove("tap"); void c.offsetWidth; c.classList.add("tap"); }
        });
        await wait(pre);
      }
      await el.click({ force: true });
      await wait(post);
    },
    /** Type like a person, not a paste. */
    async type(sel, text, { delay = 68, post = 480 } = {}) {
      const el = page.locator(sel).first();
      await el.waitFor({ state: "visible", timeout: 15000 });
      await el.scrollIntoViewIfNeeded();
      const b = await el.boundingBox();
      if (b) {
        await page.evaluate(({ x, y }) => {
          const c = document.getElementById("__cur");
          if (c) { c.classList.add("on"); c.style.left = x + "px"; c.style.top = y + "px"; }
        }, { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) });
      }
      await el.click({ force: true });
      await el.fill("");
      await wait(200);
      await el.pressSequentially(text, { delay });
      await wait(post);
    },
    async hideCursor() {
      await page.evaluate(() => document.getElementById("__cur")?.classList.remove("on"));
    },
    /** Ring-highlight an element so the eye lands on it. */
    async spotlight(sel, hold = 2000) {
      await page.evaluate((s) => {
        const e = document.querySelector(s);
        if (!e) return;
        e.scrollIntoView({ block: "center", behavior: "smooth" });
        e.dataset.__prev = e.style.cssText;
        e.style.outline = "3px solid #22c55e";
        e.style.outlineOffset = "4px";
        e.style.borderRadius = "12px";
        e.style.transition = "outline-color .3s";
        e.style.boxShadow = "0 0 0 9999px rgba(2,6,12,.55)";
        e.style.position = e.style.position || "relative";
        e.style.zIndex = "2147483000";
      }, sel);
      await wait(hold);
      await page.evaluate((s) => {
        const e = document.querySelector(s);
        if (e && e.dataset.__prev !== undefined) { e.style.cssText = e.dataset.__prev; delete e.dataset.__prev; }
      }, sel);
      await wait(320);
    },
    pause: wait,
  };
  return ui;
}

/** Title card rendered as a real page, so it records identically. */
export async function titleCard(page, { kicker, title, sub, hold = 4200 }) {
  await page.setContent(`<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;
    background:radial-gradient(1100px 620px at 22% 12%,#0d2a1c 0%,#050a10 62%);
    display:flex;align-items:center;justify-content:center;
    font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#eef4fb">
    <div style="max-width:900px;padding:0 60px">
      <div style="display:inline-block;font:700 12px/1 ui-sans-serif,system-ui,sans-serif;letter-spacing:2.2px;
        text-transform:uppercase;color:#04120a;background:#22c55e;padding:9px 16px;border-radius:999px;
        margin-bottom:30px;opacity:0;animation:a .6s .1s forwards">${kicker}</div>
      <h1 style="font-size:59px;line-height:1.06;margin:0 0 22px;letter-spacing:-1.6px;font-weight:800;
        opacity:0;animation:a .7s .3s forwards">${title}</h1>
      <p style="font-size:22px;line-height:1.55;margin:0;color:#9fb2c8;max-width:730px;
        opacity:0;animation:a .7s .55s forwards">${sub}</p>
    </div>
    <style>@keyframes a{to{opacity:1;transform:none}}
    h1,div,p{transform:translateY(14px)}</style></body>`);
  await wait(hold);
}

/** Closing card. */
export async function endCard(page, { title, lines, hold = 5200 }) {
  await page.setContent(`<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;
    background:radial-gradient(1100px 620px at 78% 88%,#0d2a1c 0%,#050a10 62%);
    display:flex;align-items:center;justify-content:center;
    font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#eef4fb">
    <div style="max-width:860px;padding:0 60px">
      <h1 style="font-size:41px;margin:0 0 30px;letter-spacing:-1px;font-weight:800">${title}</h1>
      <ul style="font-size:20px;line-height:1.95;margin:0;padding-left:26px;color:#c3d2e2">
        ${lines.map((l) => `<li style="margin-bottom:6px">${l}</li>`).join("")}
      </ul>
    </div></body>`);
  await wait(hold);
}

/** Terminal player — replays REAL captured command output, typed then printed. */
export async function terminal(page, blocks, { title = "bash", hold = 1500 } = {}) {
  await page.setContent(`<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;
    background:#05080d;display:flex;align-items:center;justify-content:center;padding:34px;box-sizing:border-box;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace">
    <div style="width:100%;height:100%;background:#0a0f16;border:1px solid #1d2836;border-radius:13px;
      overflow:hidden;display:flex;flex-direction:column;box-shadow:0 26px 70px rgba(0,0,0,.6)">
      <div style="height:40px;background:#111823;border-bottom:1px solid #1d2836;display:flex;align-items:center;
        padding:0 15px;gap:8px;flex:none">
        <span style="width:12px;height:12px;border-radius:50%;background:#ff5f57"></span>
        <span style="width:12px;height:12px;border-radius:50%;background:#febc2e"></span>
        <span style="width:12px;height:12px;border-radius:50%;background:#28c840"></span>
        <span style="margin-left:12px;color:#7d8fa6;font-size:12.5px;letter-spacing:.3px">${title}</span>
      </div>
      <div id="t" style="flex:1;overflow:hidden;padding:20px 24px;font-size:14.5px;line-height:1.72;
        color:#d7e2ef;white-space:pre-wrap;word-break:break-word"></div>
    </div></body>`);

  for (const b of blocks) {
    await page.evaluate(() => {
      const t = document.getElementById("t");
      const l = document.createElement("div");
      l.innerHTML = `<span style="color:#4ade80;font-weight:700">$</span> <span class="cmd"></span><span class="cur" style="background:#4ade80;color:#4ade80">_</span>`;
      t.appendChild(l); t.scrollTop = t.scrollHeight;
    });
    for (const ch of b.cmd) {
      await page.evaluate((c) => {
        const s = document.querySelectorAll("#t .cmd");
        s[s.length - 1].textContent += c;
      }, ch);
      await wait(38);
    }
    await wait(430);
    await page.evaluate(() => {
      const c = document.querySelectorAll("#t .cur");
      c[c.length - 1]?.remove();
    });
    if (b.out) {
      await wait(b.think ?? 520);
      await page.evaluate((o) => {
        const t = document.getElementById("t");
        const d = document.createElement("div");
        d.style.color = "#9db0c6"; d.style.margin = "2px 0 12px";
        d.textContent = o;
        t.appendChild(d); t.scrollTop = t.scrollHeight;
      }, b.out);
    }
    await wait(b.hold ?? hold);
  }
  await wait(1100);
}

/** Fresh account straight off the API — returns creds the video then uses. */
export async function seed({ email, name, password = "supersecret123", accountType = "personal" }) {
  const r = await fetch(`${API}/v1/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, name, password, account_type: accountType }),
  });
  if (!r.ok) throw new Error(`seed failed: ${r.status} ${await r.text()}`);
  return { ...(await r.json()), email, password };
}

export async function api(path, token, init = {}) {
  const r = await fetch(`${API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path} → ${r.status} ${JSON.stringify(body)}`);
  return body;
}

/** Log in through the UI, landing on the dashboard. */
export async function login(page, ui, email, password) {
  await page.goto(APP, { waitUntil: "networkidle" });
  await wait(900);
  await ui.type('input[type="email"]', email, { delay: 42 });
  await ui.type('input[type="password"]', password, { delay: 42 });
  await ui.click('button[type="submit"]');
  await page.waitForSelector(".nav-item", { timeout: 15000 });
  await wait(1400);
}

/**
 * Return to the dashboard after a full-page slide (setContent wipes the SPA).
 * The session token lives in localStorage for this origin, so this lands
 * already signed in.
 */
export async function resume(page) {
  await page.goto(APP, { waitUntil: "networkidle" });
  await page.waitForSelector(".nav-item", { timeout: 15000 });
  await wait(1500);
}

export async function finish(browser, ctx, page, name) {
  const video = page.video();
  await ctx.close();
  const p = await video?.path();
  await browser.close();
  return p;
}
