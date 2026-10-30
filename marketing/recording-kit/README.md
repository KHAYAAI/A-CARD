# Recording kit: Claude Desktop + A-CARD

This kit is for recording a real Claude Desktop session that uses A-CARD. Nothing on screen is scripted: Claude chooses its own tool calls, A-CARD gives the real answers, and the person approving in the dashboard really clicks Approve. The only thing that isn't real is the money. The kit runs the A-CARD sandbox, so no card can be charged at a real store.

| File | What it's for |
|---|---|
| [`PROMPTS.md`](PROMPTS.md) | What to type in each scene, what Claude should do, and how to recover when it does something else |
| [`SHOT-LIST.md`](SHOT-LIST.md) | Every shot, in recording order, with target lengths |
| [`RECORDING-SETTINGS.md`](RECORDING-SETTINGS.md) | Screen, app and recorder settings, and how to hand the files over |
| [`CONSENT-FORM.md`](CONSENT-FORM.md) | Release form for a customer who appears on screen or on the mic. Have it reviewed before use |
| `kit.ts` | `npm run recording-kit`: the API, a seeded org, the dashboard, and optionally the demo stores |
| `mcp-launcher.ts` | What Claude Desktop runs. It reads the current take's key, then starts A-CARD's MCP server |
| `rehearse.ts` | `npm run recording-kit:check`: a pre-flight check that connects the way Claude Desktop does |
| [`edit/`](edit/) | The editing pipeline for the raw recordings (cuts, captions, blur, badges, title and end cards) |

## 1. One-time setup (about 15 minutes)

You need:

- **Node.js 22** (`node -v`). The repo supports Node 20 and up, but the kit was tested on 22.
- **Claude Desktop** for macOS or Windows, signed in.
- **Google Chrome** for the dashboard. If you'll record the optional store scene, you also need Claude in Chrome.
- This repository, cloned and installed:

```bash
git clone <this repo> a-card && cd a-card
npm install
```

## 2. Start a take

```bash
npm run recording-kit -- --org "Acme Freight" --email ops@acme.example --install-claude
```

- `--org` is the name shown in the dashboard and in Claude's answers. Use the customer's company name if they've agreed to it, or a neutral name if not.
- `--email` and `--password` are the dashboard sign-in. Use a demo address, not someone's real inbox, because it shows on screen. The default password is `sandbox-demo-2026`.
- `--install-claude` adds an `acard` entry to Claude Desktop's config file, keeping your other servers and backing the old file up next to it. You only need it the first time. It's safe to repeat.
- `--stores` also starts the fictional demo stores on `:4400`, for the optional Claude in Chrome scene.
- Ports: the API uses `:8787` and the dashboard `:3000`. `--api-port` and `--dashboard-port` change them.

The kit prints the dashboard address and sign-in details. Leave that terminal open: **Ctrl+C stops everything and wipes the world**, and starting again gives a clean take.

What's in the world when it starts:

- Wallets of R500 000 and $10 000.
- Three departments.
- An org policy: casinos (MCC 7995) are blocked, and anything from R25 000 up needs a person's approval.
- Three existing agent cards.
- A small A-MERCHANT market of verified Johannesburg-area suppliers: cement, plaster sand, diesel and truck tyres.

The supplier names and department leads are fictional.

## 3. Connect Claude Desktop

1. **Quit Claude Desktop completely and reopen it.** Closing the window isn't enough: on macOS press ⌘Q, and on Windows use Quit from the tray icon. **Do this after every kit restart**, because each take has a new key.
2. Check that A-CARD is connected. In Claude Desktop's settings, the Developer section lists `acard` as running, and the tools menu in the chat box lists its 10 tools.
3. Run the pre-flight check in a second terminal:

```bash
npm run recording-kit:check
```

It starts the MCP server exactly as Claude Desktop does (same command, bare PATH, a different working directory), lists the tools and reads the wallet. It changes nothing.

`npm run recording-kit:check -- --full` also plays every scene in `PROMPTS.md` and checks each outcome: held for approval, approved after the click, declined at the wrong store. Use it when you've changed anything. It spends sandbox money, so **restart the kit afterwards**.

**Why the key isn't in Claude's config:** the config entry runs `mcp-launcher.ts`, which reads the current key from `marketing/recording-kit/.kit/state.json` (git-ignored). So no secret ever appears if the config file is shown on screen, and the entry never changes between takes.

## 4. Record

Follow [`SHOT-LIST.md`](SHOT-LIST.md), typing the prompts from [`PROMPTS.md`](PROMPTS.md). Set up the screen per [`RECORDING-SETTINGS.md`](RECORDING-SETTINGS.md) first.

Claude Desktop asks permission the first time it uses each tool. Decide before the take whether to show that. It makes a good trust moment once, as in "the agent asks before it touches money", so allow the first one on camera and choose "always allow" after that.

## 5. Hand over the footage

Upload the raw files to the Claude Code session that's editing the video. [`RECORDING-SETTINGS.md`](RECORDING-SETTINGS.md#handing-over) explains how. Everything else happens in [`edit/`](edit/).

## Troubleshooting

| Symptom | Fix |
|---|---|
| `acard` doesn't appear in Claude Desktop | Quit it fully and reopen. Check the config the kit printed. Read Claude's MCP log: `~/Library/Logs/Claude/mcp-server-acard.log` on macOS, or `%APPDATA%\Claude\logs\` on Windows. |
| Log says "recording kit isn't running" | Start the kit first, then restart Claude Desktop. |
| Tool calls fail with `unauthorized` | You restarted the kit but not Claude Desktop, so it still has the old key. Restart Claude Desktop. |
| `Port 8787 is busy` | Something else is on that port. Stop it, or pass `--api-port 8790`. |
| The dashboard shows a product chooser | Pick **A-CARD**. |
| Claude picked a different supplier, amount or category than `PROMPTS.md` expects | That's Claude deciding. If A-CARD still did the right thing, keep the take. If the scene's point got lost, see "When Claude goes off script" in `PROMPTS.md`. |
| A take went wrong halfway | Ctrl+C the kit, start it again, restart Claude Desktop, and re-record from the start of the scene. |

## What you can and can't say about these recordings

- **You can say:** "a real Claude Desktop session", "Claude chose these steps itself", "A-CARD approved, held and declined these payments live", "a person approved it in the dashboard".
- **Say clearly:** it's the **sandbox**. No real money moved, and no card was usable at a real store. Live card issuance launches with our issuing partner. The editing pipeline adds the badge and end card that say so.
- **Don't** show or imply a real retailer's checkout unless that retailer is a partner. The demo stores are fictional on purpose.
