# Recording settings

The aim is footage that stays sharp at 1920×1080, and that holds up when it's cropped to a square or vertical social cut.

## Screen

- **Resolution:** record a 1920×1080 area. On a Retina or 4K display, either set the display to "looks like 1920×1080", or record at 2× (3840×2160) and let the edit scale it down. Don't record a 1440×900 laptop screen and upscale it.
- **One app full-screen per shot.** Claude Desktop maximised, or the dashboard's Chrome window maximised. No overlapping windows.
- **Text size:** zoom Claude Desktop and Chrome to 110–125% (⌘+ / Ctrl+). Small text is the most common reason screen recordings are unusable on a phone.
- **Theme:** pick light or dark and keep it for every shot. The A-CARD dashboard follows the system theme. Dark matches the other A-CARD videos.
- **Notifications off:** macOS Focus / Do Not Disturb; Windows Focus assist. Also quit Slack, Mail, Messages and anything else that can pop up.
- **Clean desktop:**
  - hide the Dock or taskbar (auto-hide);
  - close other tabs;
  - use a fresh Chrome profile with no bookmarks bar and no extensions except Claude in Chrome;
  - turn off the browser's password and autofill suggestions.
- **Mouse:** move it slowly and deliberately, and park it outside the action when you're not using it. A click-highlight tool is optional. The edit doesn't depend on one.

## Recorder

Any of these works. Use what you know.

**macOS screenshot toolbar (⌘⇧5):**

- Choose "Record Selected Portion" sized to the app window.
- Under Options, turn microphone off unless narrating, and turn "Show Mouse Clicks" on.
- Files are `.mov`. Upload them as they are.

**OBS Studio (macOS / Windows), for the most control:**

| Setting | Value |
|---|---|
| Canvas and output resolution | 1920×1080, or 3840×2160 on a 4K display |
| Frame rate | 30 fps (60 is fine; the edit outputs 30) |
| Recording format | `mkv`, then File → Remux Recordings to `mp4`. An mkv survives a crash; an mp4 doesn't |
| Encoder | Hardware (Apple VT / NVENC / QuickSync) or x264 |
| Quality | CQP/CRF 18–20, or 15–25 Mbps |
| Audio | Off, unless the customer narrates (then a separate mic track at 48 kHz) |

**Windows Game Bar (Win+Alt+R):** fine for a single app window. Set video quality to "High" in Settings → Gaming → Captures.

## Audio

The finished videos work muted: the edit adds burned-in captions. If the customer talks (S0-01), use a real microphone rather than the laptop's, and record in a quiet room. Tell the editor which shots have audio to keep.

## Privacy on screen

- The dashboard sign-in email and the org name are visible. Use the demo values you started the kit with, not anyone's real inbox.
- `create_card` results show a **sandbox** card number (it starts `4242`). It's a test number and can't be used anywhere, but blur it in public cuts so nobody thinks otherwise. Tell the editor the timestamps, or let the edit find them.
- Never show the terminal while the kit prints its startup banner if you've passed a real password. Use the default.

## Handing over

1. Name files by shot (`S2-01.mov`). If a shot has several takes, add `-t2`, `-t3`.
2. Add a short `notes.txt`: which take is best, anything to cut ("Claude paused 40 s at 1:10"), anything to blur, and which audio to keep.
3. Upload the files to the Claude Code session doing the edit (attach them in the chat). If an upload fails because a file is too big, re-export at a lower bitrate (around 8 Mbps) or split it by shot.
4. Keep the originals until the final cut is approved.
