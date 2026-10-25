import { chromium } from "playwright";

/**
 * Recording harness for the marketing videos. Same approach as the tutorial
 * series (tutorials/production/lib.mjs) — a real browser driving the real
 * dashboard, slides rendered as pages, a terminal player — with three
 * differences:
 *
 *   - Sharp output: the page renders at the delivery resolution with CSS zoom,
 *     so a 1280-wide layout is drawn with 1920 real pixels rather than
 *     upscaled. (Playwright records at CSS-pixel size; device scale factor
 *     adds nothing.)
 *   - A "SANDBOX · demo data" badge on every frame.
 *   - The Next.js dev-mode badge is hidden.
 */

export const API = "http://localhost:8787";
export const APP = "http://localhost:3000";
export const RAW = "/home/user/A-CARD/marketing/videos/.raw";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
export { wait };

/** 16:9 at 1920×1080 (zoom 1.5 → 1280×720 layout), or square 1080×1080 (zoom 1.35 → 800×800). */
export const FORMATS = {
  wide: { width: 1920, height: 1080, zoom: 1.5 },
  square: { width: 1080, height: 1080, zoom: 1.35 },
};

export async function studio(name, format = FORMATS.wide) {
  const browser = await chromium.launch({
    executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    args: ["--no-sandbox", "--force-color-profile=srgb", "--font-render-hinting=none"],
  });
  const viewport = { width: format.width, height: format.height };
  const ctx = await browser.newContext({
    viewport,
    recordVideo: { dir: `${RAW}/${name}`, size: viewport },
    colorScheme: "dark",
  });
  await ctx.addInitScript(chromeScript, { zoom: format.zoom });
  const page = await ctx.newPage();
  page.__zoom = format.zoom;
  return { browser, ctx, page };
}

/** Injected into every page: zoom, caption bar, cursor, SANDBOX badge. Runs before the DOM exists, so it waits for it. */
function chromeScript({ zoom }) {
  const boot = () => {
    if (!document.head || !document.body || document.getElementById("__mstyle")) return;
    const style = document.createElement("style");
    style.id = "__mstyle";
    style.textContent = `
      html{zoom:${zoom} !important}
      nextjs-portal{display:none !important}
      #__cap{position:fixed;left:0;right:0;bottom:0;z-index:2147483647;
        font:500 19px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
        background:linear-gradient(to top,rgba(6,10,16,.985),rgba(6,10,16,.9));
        color:#f2f6fb;padding:17px 32px 21px;border-top:2px solid #22c55e;
        transform:translateY(110%);transition:transform .4s cubic-bezier(.2,.8,.2,1);
        text-shadow:0 1px 3px rgba(0,0,0,.6);display:flex;align-items:baseline;gap:14px}
      #__cap.on{transform:translateY(0)}
      #__cap b{color:#4ade80;font-weight:700}
      #__cap code{background:rgba(255,255,255,.13);padding:2px 7px;border-radius:5px;
        font:600 16px/1 ui-monospace,SFMono-Regular,Menlo,monospace;color:#a7f3d0}
      #__captext{flex:1}
      #__sbx{position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;
        font:700 10.5px/1 ui-sans-serif,system-ui,sans-serif;letter-spacing:1.6px;text-transform:uppercase;
        color:#facc15;background:rgba(20,16,4,.82);border:1px solid rgba(250,204,21,.45);
        padding:6px 11px;border-radius:999px;pointer-events:none}
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
    cap.innerHTML = `<span id="__captext"></span>`;
    document.body.appendChild(cap);
    const sbx = document.createElement("div");
    sbx.id = "__sbx";
    sbx.textContent = "Sandbox · demo data";
    document.body.appendChild(sbx);
    const cur = document.createElement("div");
    cur.id = "__cur";
    document.body.appendChild(cur);
  };
  const start = () => {
    boot();
    new MutationObserver(() => {
      if (!document.getElementById("__cap") || !document.getElementById("__mstyle")) {
        document.getElementById("__mstyle")?.remove();
        boot();
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
}

const readMs = (t) => Math.min(8500, Math.max(2400, t.replace(/<[^>]+>/g, "").length * 58));

export function make(page) {
  const z = () => page.__zoom ?? 1;
  const moveCursor = async (box) => {
    if (!box) return;
    // Bounding boxes are in device pixels; the overlay lives inside the zoomed document.
    const x = Math.round((box.x + box.width / 2) / z());
    const y = Math.round((box.y + box.height / 2) / z());
    await page.evaluate(({ x, y }) => {
      const c = document.getElementById("__cur");
      if (c) {
        c.classList.add("on");
        c.style.transition = "left .5s cubic-bezier(.3,.8,.3,1),top .5s cubic-bezier(.3,.8,.3,1),opacity .25s";
        c.style.left = x + "px";
        c.style.top = y + "px";
      }
    }, { x, y });
  };
  const ui = {
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
      await wait(380);
    },
    async click(target, { pre = 300, post = 650 } = {}) {
      const el = typeof target === "string" ? page.locator(target).first() : target;
      await el.waitFor({ state: "visible", timeout: 15000 });
      await el.scrollIntoViewIfNeeded();
      await wait(180);
      await moveCursor(await el.boundingBox());
      await wait(540);
      await page.evaluate(() => {
        const c = document.getElementById("__cur");
        if (c) { c.classList.remove("tap"); void c.offsetWidth; c.classList.add("tap"); }
      });
      await wait(pre);
      await el.click({ force: true });
      await wait(post);
    },
    async type(target, text, { delay = 55, post = 420 } = {}) {
      const el = typeof target === "string" ? page.locator(target).first() : target;
      await el.waitFor({ state: "visible", timeout: 15000 });
      await moveCursor(await el.boundingBox());
      await el.click({ force: true });
      await el.fill("");
      await wait(160);
      await el.pressSequentially(text, { delay });
      await wait(post);
    },
    async nav(name) {
      await ui.click(page.locator(".nav-item", { hasText: name }).first(), { post: 1100 });
    },
    /** Ring-highlight an element so the eye lands on it. */
    async spotlight(target, hold = 2000) {
      const el = typeof target === "string" ? page.locator(target).first() : target;
      // Short timeout: a spotlight is decoration, and must never stall a take.
      await el.evaluate((e) => {
        e.scrollIntoView({ block: "center", behavior: "smooth" });
        e.dataset.__prev = e.style.cssText;
        e.style.outline = "3px solid #22c55e";
        e.style.outlineOffset = "4px";
        e.style.borderRadius = "12px";
        e.style.boxShadow = "0 0 0 9999px rgba(2,6,12,.5)";
        e.style.position = e.style.position || "relative";
        e.style.zIndex = "2147483000";
      }, undefined, { timeout: 3000 });
      await wait(hold);
      await el.evaluate((e) => {
        if (e.dataset.__prev !== undefined) { e.style.cssText = e.dataset.__prev; delete e.dataset.__prev; }
      }, undefined, { timeout: 3000 });
      await wait(260);
    },
    pause: wait,
  };
  return ui;
}

const SLIDE_BG = "radial-gradient(1100px 620px at 22% 12%,#0d2a1c 0%,#050a10 62%)";
const FONT = "ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif";

/** A full-frame slide. `inner` is HTML; `hold` is how long it stays. */
export async function slide(page, inner, hold = 4000, { bg = SLIDE_BG } = {}) {
  // position:fixed + inset:0 fills the frame exactly under CSS zoom; vh units don't.
  await page.setContent(`<!doctype html><meta charset="utf-8"><body style="margin:0;overflow:hidden;background:#050a10">
    <div style="position:fixed;inset:0;background:${bg};display:flex;align-items:center;justify-content:center;font-family:${FONT};color:#eef4fb">
    ${inner}</div>
    <style>@keyframes a{to{opacity:1;transform:none}} .in{opacity:0;transform:translateY(12px);animation:a .6s forwards}
    .d1{animation-delay:.15s}.d2{animation-delay:.35s}.d3{animation-delay:.55s}.d4{animation-delay:.75s}.d5{animation-delay:.95s}.d6{animation-delay:1.15s}</style>
    </body>`);
  await page.evaluate(chromeScript, { zoom: page.__zoom ?? 1 });
  await wait(hold);
}

export async function titleCard(page, { kicker, title, sub, hold = 4200 }) {
  await slide(
    page,
    `<div style="max-width:960px;padding:0 60px">
      ${kicker ? `<div class="in" style="display:inline-block;font:700 12px/1 ${FONT};letter-spacing:2.2px;text-transform:uppercase;color:#04120a;background:#22c55e;padding:9px 16px;border-radius:999px;margin-bottom:28px">${kicker}</div>` : ""}
      <h1 class="in d1" style="font-size:58px;line-height:1.06;margin:0 0 22px;letter-spacing:-1.6px;font-weight:800">${title}</h1>
      ${sub ? `<p class="in d2" style="font-size:22px;line-height:1.55;margin:0;color:#9fb2c8;max-width:760px">${sub}</p>` : ""}
    </div>`,
    hold,
  );
}

/** Terminal player. Each block's `out` is the REAL output of a command that ran moments earlier. */
export async function terminal(page, blocks, { title = "bash", hold = 1400, typeMs = 30 } = {}) {
  await page.setContent(`<!doctype html><meta charset="utf-8"><body style="margin:0;overflow:hidden;background:#05080d">
    <div style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center;padding:52px 30px 30px;box-sizing:border-box;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace">
    <div style="width:100%;height:100%;background:#0a0f16;border:1px solid #1d2836;border-radius:13px;
      overflow:hidden;display:flex;flex-direction:column;box-shadow:0 26px 70px rgba(0,0,0,.6)">
      <div style="height:38px;background:#111823;border-bottom:1px solid #1d2836;display:flex;align-items:center;padding:0 15px;gap:8px;flex:none">
        <span style="width:12px;height:12px;border-radius:50%;background:#ff5f57"></span>
        <span style="width:12px;height:12px;border-radius:50%;background:#febc2e"></span>
        <span style="width:12px;height:12px;border-radius:50%;background:#28c840"></span>
        <span style="margin-left:12px;color:#7d8fa6;font-size:12.5px;letter-spacing:.3px">${title}</span>
      </div>
      <div id="t" style="flex:1;overflow:hidden;padding:18px 22px;font-size:14px;line-height:1.66;color:#d7e2ef;white-space:pre-wrap;word-break:break-word"></div>
    </div></div></body>`);
  await page.evaluate(chromeScript, { zoom: page.__zoom ?? 1 });
  for (const b of blocks) {
    if (b.comment) {
      await page.evaluate((c) => {
        const t = document.getElementById("t");
        const l = document.createElement("div");
        l.style.color = "#5f7488";
        l.textContent = `# ${c}`;
        t.appendChild(l);
        t.scrollTop = t.scrollHeight;
      }, b.comment);
      await wait(b.hold ?? 900);
      continue;
    }
    await page.evaluate((prompt) => {
      const t = document.getElementById("t");
      const l = document.createElement("div");
      l.innerHTML = `<span style="color:#4ade80;font-weight:700">${prompt}</span> <span class="cmd"></span><span class="cur" style="background:#4ade80;color:#4ade80">_</span>`;
      t.appendChild(l);
      t.scrollTop = t.scrollHeight;
    }, b.prompt ?? "$");
    for (const ch of b.cmd) {
      await page.evaluate((c) => {
        const s = document.querySelectorAll("#t .cmd");
        s[s.length - 1].textContent += c;
      }, ch);
      await wait(typeMs);
    }
    await wait(380);
    await page.evaluate(() => document.querySelectorAll("#t .cur").forEach((c) => c.remove()));
    if (b.out) {
      await wait(b.think ?? 450);
      await page.evaluate(({ o, color }) => {
        const t = document.getElementById("t");
        const d = document.createElement("div");
        d.style.color = color;
        d.style.margin = "2px 0 12px";
        d.textContent = o;
        t.appendChild(d);
        t.scrollTop = t.scrollHeight;
      }, { o: b.out, color: b.color ?? "#9db0c6" });
    }
    await wait(b.hold ?? hold);
  }
  await wait(900);
}

/** Sign in to the A-CARD console, choosing it on the product chooser if shown. */
export async function login(page, ui, email, password) {
  await page.goto(APP, { waitUntil: "networkidle" });
  await wait(700);
  const chooser = page.getByText("A-CARD", { exact: true }).first();
  if (!(await page.locator('input[type="email"]').count()) && (await chooser.count())) {
    await ui.click(chooser, { post: 900 });
  }
  await ui.type('input[type="email"]', email, { delay: 34 });
  await ui.type('input[type="password"]', password, { delay: 34 });
  await ui.click('button[type="submit"]');
  await page.waitForSelector(".nav-item", { timeout: 15000 });
  await wait(1100);
}

/** Return to the console after a slide replaced the page. */
export async function resume(page) {
  await page.goto(APP, { waitUntil: "networkidle" });
  await page.waitForSelector(".nav-item", { timeout: 15000 });
  await wait(900);
}

export async function finish(browser, ctx, page) {
  const video = page.video();
  await ctx.close();
  const path = await video?.path();
  await browser.close();
  return path;
}

/** Open the console already signed in, from a session token (for short formats with no time for a login). */
export async function signedIn(page, token) {
  await page.goto(APP, { waitUntil: "domcontentloaded" });
  await page.evaluate((t) => {
    localStorage.setItem("acard_token", t);
    localStorage.setItem("acard_last_product", "acard");
  }, token);
  await page.goto(APP, { waitUntil: "networkidle" });
  await page.waitForSelector(".nav-item", { timeout: 15000 });
  await wait(600);
}
