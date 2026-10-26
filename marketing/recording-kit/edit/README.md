# Editing the raw recordings

```bash
cd marketing/videos/production && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install   # once: Playwright + ffmpeg
node marketing/recording-kit/edit/edit.mjs path/to/edl.json
```

An **edit decision list** (EDL) says what goes into the cut. The script turns it into one 1920×1080, 30 fps H.264 MP4: title card → clips → end card. The footage is encoded once.

Field reference ([`edl.example.json`](edl.example.json) uses them all):

| Field | Meaning |
|---|---|
| `output` | Output file, relative to the EDL |
| `privacy` | `"public"` (default) or `"private"`. Private adds a red **Private client demo · not for publication** badge to every frame. Use it for anything not cleared for publication (see the consent form). |
| `badgePosition` | `"top-right"` (default; stays clear of the macOS title bar) or `"top-left"` |
| `audio` | `false` (default) drops all sound. `true` keeps each clip's audio, adds silence where a clip or card has none, and keeps sped-up audio in sync. |
| `title` | `{ kicker, title, sub, seconds }`. HTML allowed (`<br>`, `<b>`) |
| `clips[]` | One entry per piece of footage, in order (fields below) |
| `clips[].file` | Raw recording, relative to the EDL |
| `clips[].in` / `out` | Trim points in the raw file: `"1:02.5"` or seconds |
| `clips[].speed` | e.g. `2` for waiting stretches. Sped-up clips carry a visible **▶▶ 2× speed** marker, so time compression is never hidden. |
| `clips[].captions[]` | `{ at, dur, text }`. `at` is seconds into the **edited** clip (after speed-up). `dur` defaults from the text length. `<b>` renders green, `<code>` renders monospace. |
| `clips[].blur[]` | `{ x, y, w, h, from, to, strength }`, in **1920×1080 output pixels**. Use it for emails, card numbers and anything personal. `from` and `to` are seconds into the edited clip; omit them to blur the whole clip. |
| `clips[].mute` | `true` silences one clip when `audio` is on |
| `end` | `{ line, note, seconds }`. The end card always carries "Sandbox shown. Live card issuance launches with our issuing partner." |
| `keepWork` | `true` keeps the intermediate files in `.edit-work/` for debugging |

## Rules the pipeline enforces

These aren't settings, so a cut can't drop them:

- Every frame of footage carries **Sandbox · demo data**.
- Every sped-up stretch is marked.
- The end card states that it's a sandbox and that live issuance launches with the issuing partner.

## Workflow once footage is uploaded

1. List the files and durations, and read `notes.txt`.
2. Make a contact sheet per shot (one frame every 5 s), to find in/out points, waits worth speeding up, and anything to blur (emails, `4242…` card numbers).
3. Write `edl.json`. Captions describe only what's on screen, in plain words, and never claim more than happened.
4. Render, review frames at each caption and blur, fix, re-render.
5. Deliver the MP4. Public cuts go in `marketing/videos/`. Private cuts go in the git-ignored `marketing/videos/private/`.
