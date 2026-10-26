import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

/**
 * Turns raw screen recordings into a finished A-CARD video, from an edit
 * decision list (EDL):
 *
 *   node edit.mjs edl.json
 *
 * Per clip: trim, speed up (with a visible "2×" marker, so a viewer knows time
 * was compressed), scale to 1920×1080, blur regions, captions. On every frame:
 * the SANDBOX badge, and for private cuts a "not for publication" badge. Then a
 * title card and the end card, all concatenated to one H.264 MP4.
 *
 * Overlays are drawn by Chromium (same look as the other A-CARD videos) as
 * transparent PNGs and composited by ffmpeg, so footage is re-encoded once.
 * See edl.example.json for every field.
 */

const run = promisify(execFile);
const PRODUCTION = resolve(dirname(new URL(import.meta.url).pathname), "../../videos/production");
const req = createRequire(join(PRODUCTION, "package.json"));
const { chromium } = req("playwright");
const FFMPEG = req("ffmpeg-static");
const W = 1920;
const H = 1080;
const FPS = 30;
const FONT = "ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif";

const edlPath = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("usage: node edit.mjs <edl.json>");
const edl = JSON.parse(readFileSync(edlPath, "utf8"));
const base = dirname(edlPath);
const at = (p) => (isAbsolute(p) ? p : join(base, p));
const work = join(base, ".edit-work");
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

/** "1:02.5" / "62.5" / 62.5 → seconds */
const secs = (t) => (typeof t === "number" ? t : String(t).split(":").reduce((acc, part) => acc * 60 + Number(part), 0));
const esc = (s) => String(s).replace(/&(?![a-z#0-9]+;)/gi, "&amp;");

// ---- overlays, drawn by Chromium ---------------------------------------------------
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" }).catch(() => chromium.launch());
const page = await browser.newPage({ viewport: { width: W, height: H } });
async function png(name, html, { transparent = true } = {}) {
  await page.setContent(`<!doctype html><meta charset="utf-8"><body style="margin:0;width:${W}px;height:${H}px;overflow:hidden;background:${transparent ? "transparent" : "#050a10"};font-family:${FONT}">${html}</body>`);
  await page.evaluate(() => document.fonts.ready);
  const path = join(work, `${name}.png`);
  await page.screenshot({ path, omitBackground: transparent });
  return path;
}

const pill = (text, color, bg, border) =>
  `<span style="display:inline-block;font:700 16px/1 ${FONT};letter-spacing:2.4px;text-transform:uppercase;color:${color};background:${bg};border:1.5px solid ${border};padding:9px 16px;border-radius:999px;margin-left:10px">${text}</span>`;
const badges = await png(
  "badges",
  `<div style="position:absolute;${edl.badgePosition === "top-left" ? "left" : "right"}:24px;top:20px">
    ${edl.privacy === "private" ? pill("Private client demo · not for publication", "#fecaca", "rgba(40,6,6,.88)", "rgba(248,113,113,.6)") : ""}
    ${pill("Sandbox · demo data", "#facc15", "rgba(20,16,4,.86)", "rgba(250,204,21,.5)")}</div>`,
);
const speedBadge = (speed) =>
  png(
    `speed-${speed}`,
    `<div style="position:absolute;${edl.badgePosition === "top-left" ? "left" : "right"}:24px;top:72px;font:800 18px/1 ${FONT};color:#e2e8f0;background:rgba(6,10,16,.82);border:1.5px solid rgba(148,163,184,.5);padding:8px 14px;border-radius:10px">▶▶ ${speed}× speed</div>`,
  );
const caption = (name, text) =>
  png(
    name,
    `<div style="position:absolute;left:0;right:0;bottom:0;background:linear-gradient(to top,rgba(6,10,16,.97),rgba(6,10,16,.88));border-top:3px solid #22c55e;padding:26px 48px 32px;color:#f2f6fb;font:500 30px/1.45 ${FONT};text-shadow:0 1px 3px rgba(0,0,0,.6)">
      <style>b{color:#4ade80;font-weight:700} code{background:rgba(255,255,255,.13);padding:2px 9px;border-radius:6px;font:600 25px ui-monospace,Menlo,monospace;color:#a7f3d0}</style>${esc(text)}</div>`,
  );
const card = (name, inner) =>
  png(
    name,
    `<div style="position:fixed;inset:0;background:radial-gradient(1650px 930px at 22% 12%,#0d2a1c 0%,#050a10 62%);display:flex;align-items:center;justify-content:center;color:#eef4fb">${inner}</div>`,
    { transparent: false },
  );

// ---- clips ---------------------------------------------------------------------------
const hasAudio = async (file) => {
  const { stderr } = await run(FFMPEG, ["-hide_banner", "-i", file], { maxBuffer: 1 << 24 }).catch((e) => e);
  return /Stream #.*Audio:/.test(stderr ?? "");
};
/** atempo accepts 0.5–2, so chain it for bigger speed-ups. */
const atempo = (speed) => {
  const parts = [];
  let s = speed;
  while (s > 2) { parts.push("atempo=2"); s /= 2; }
  parts.push(`atempo=${s}`);
  return parts.join(",");
};
const encode = ["-c:v", "libx264", "-preset", "medium", "-crf", "19", "-pix_fmt", "yuv420p", "-r", String(FPS)];
const audioOut = ["-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2"];
const silence = ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"];

const parts = [];
let n = 0;

async function stillClip(name, image, seconds) {
  const out = join(work, `${String(n++).padStart(3, "0")}-${name}.mp4`);
  const args = ["-y", "-loop", "1", "-t", String(seconds), "-i", image];
  if (edl.audio) args.push(...silence);
  args.push("-vf", `fade=in:st=0:d=0.5,fade=out:st=${seconds - 0.5}:d=0.5,format=yuv420p`, ...encode);
  if (edl.audio) args.push(...audioOut, "-shortest");
  await run(FFMPEG, [...args, out], { maxBuffer: 1 << 24 });
  parts.push(out);
}

if (edl.title) {
  const t = edl.title;
  const image = await card(
    "title",
    `<div style="max-width:1440px;padding:0 90px">
      ${t.kicker ? `<div style="display:inline-block;font:700 18px/1 ${FONT};letter-spacing:3.3px;text-transform:uppercase;color:#04120a;background:#22c55e;padding:13px 24px;border-radius:999px;margin-bottom:42px">${esc(t.kicker)}</div>` : ""}
      <h1 style="font-size:87px;line-height:1.06;margin:0 0 33px;letter-spacing:-2.4px;font-weight:800">${esc(t.title)}</h1>
      ${t.sub ? `<p style="font-size:33px;line-height:1.55;margin:0;color:#9fb2c8;max-width:1140px">${esc(t.sub)}</p>` : ""}</div>`,
  );
  await stillClip("title", image, t.seconds ?? 4.5);
}

for (const [i, clip] of edl.clips.entries()) {
  const file = at(clip.file);
  const start = secs(clip.in ?? 0);
  const speed = clip.speed ?? 1;
  const inputs = ["-ss", String(start)];
  if (clip.out !== undefined) inputs.push("-t", String(secs(clip.out) - start));
  inputs.push("-i", file, "-i", badges);
  let idx = 2;
  const chain = [];
  let v = "v0";
  chain.push(
    `[0:v]setpts=(PTS-STARTPTS)/${speed},scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=0x05080d,fps=${FPS},format=yuv420p[${v}]`,
  );
  for (const [j, b] of (clip.blur ?? []).entries()) {
    const from = b.from ?? 0;
    const to = b.to ?? 1e9;
    chain.push(`[${v}]split[bm${j}][bs${j}]`, `[bs${j}]crop=${b.w}:${b.h}:${b.x}:${b.y},boxblur=lr='min(${b.strength ?? 18},min(w,h)/2-1)':lp=2:cr='min(${b.strength ?? 18},min(cw,ch)/2-1)':cp=2[bb${j}]`);
    chain.push(`[bm${j}][bb${j}]overlay=${b.x}:${b.y}:enable='between(t,${from},${to})'[vb${j}]`);
    v = `vb${j}`;
  }
  chain.push(`[${v}][1:v]overlay=0:0[vbadge]`);
  v = "vbadge";
  if (speed !== 1) {
    inputs.push("-i", await speedBadge(speed));
    chain.push(`[${v}][${idx++}:v]overlay=0:0[vspeed]`);
    v = "vspeed";
  }
  for (const [j, c] of (clip.captions ?? []).entries()) {
    inputs.push("-i", await caption(`cap-${i}-${j}`, c.text));
    const from = c.at ?? 0;
    const to = from + (c.dur ?? Math.min(8.5, Math.max(2.4, c.text.replace(/<[^>]+>/g, "").length * 0.058)));
    chain.push(`[${v}][${idx++}:v]overlay=0:0:enable='between(t,${from},${to})'[vc${j}]`);
    v = `vc${j}`;
  }
  const out = join(work, `${String(n++).padStart(3, "0")}-clip${i}.mp4`);
  const args = ["-y", ...inputs];
  let audioMap = [];
  if (edl.audio) {
    if (clip.mute !== true && (await hasAudio(file))) {
      chain.push(`[0:a]asetpts=PTS-STARTPTS,${atempo(speed)},aresample=48000[aout]`);
      audioMap = ["-map", "[aout]"];
    } else {
      args.push(...silence);
      audioMap = ["-map", `${idx++}:a`, "-shortest"];
    }
  }
  args.push("-filter_complex", chain.join(";"), "-map", `[${v}]`, ...audioMap, ...encode);
  if (edl.audio) args.push(...audioOut);
  else args.push("-an");
  await run(FFMPEG, [...args, out], { maxBuffer: 1 << 26 }).catch((e) => {
    throw new Error(`clip ${i} (${clip.file}) failed:\n${String(e.stderr).slice(-1500)}`);
  });
  parts.push(out);
  console.log(`clip ${i + 1}/${edl.clips.length}  ${clip.file}`);
}

const end = edl.end ?? {};
const endImage = await card(
  "end",
  `<div style="text-align:center;padding:0 90px">
    <div style="font:800 60px ${FONT};letter-spacing:1.5px;margin-bottom:27px">A‑CARD</div>
    <p style="font-size:36px;color:#9fb2c8;margin:0 0 45px">${esc(end.line ?? "Let agents buy. Keep the say.")}</p>
    <p style="font-size:21px;color:#6b7f95;margin:0">Sandbox shown. Live card issuance launches with our issuing partner.</p>
    ${end.note ? `<p style="font-size:20px;color:${edl.privacy === "private" ? "#fca5a5" : "#6b7f95"};margin:21px 0 0">${esc(end.note)}</p>` : ""}</div>`,
);
await stillClip("end", endImage, end.seconds ?? 5);
await browser.close();

// ---- join ------------------------------------------------------------------------------
const list = join(work, "parts.txt");
writeFileSync(list, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"));
const output = at(edl.output ?? "edited.mp4");
await run(FFMPEG, ["-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", output], { maxBuffer: 1 << 24 });
const { stderr } = await run(FFMPEG, ["-hide_banner", "-i", output]).catch((e) => e);
console.log(`\n${output}  ${(/Duration: ([0-9:.]+)/.exec(stderr) ?? [])[1] ?? ""}`);
if (!edl.keepWork) rmSync(work, { recursive: true, force: true });
