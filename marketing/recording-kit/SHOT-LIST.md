# Shot list

Record **each shot as its own file**, named as in the first column (`S2-03.mov`, and so on). Leave about 2 seconds of stillness at the start and end of every shot, with the mouse parked and nothing moving. That's where the cuts go.

The finished video runs 3–4 minutes. Raw footage can be much longer: waits are cut or sped up in the edit, and sped-up stretches carry a visible "2×" marker.

| # | Scene | Screen | Action | Edited length |
|---|---|---|---|---|
| S0-01 | Cold open (optional) | Camera, or the customer on a call | The customer says, in their own words, what their team spends on and why agents need limits. No script, 10–20 s. **Needs a signed consent form.** | 15 s |
| S1-01 | Connect | Claude Desktop settings, Developer section | `acard` listed as running. Hold 3 s. Then the tools menu in the chat box showing A-CARD's tools. | 8 s |
| S1-02 | Connect | Terminal | `npm run recording-kit:check`, run live (all checks pass). | 6 s |
| S1-03 | What can it do? | Claude Desktop | Scene 1 prompts (`PROMPTS.md`). | 20 s |
| S2-01 | Cement | Claude Desktop | Scene 2 first prompt, through to Claude saying it's waiting for approval. Expand one tool call (e.g. `find_offers`) so its input and result show. | 45 s |
| S2-02 | Approval | Chrome · dashboard | Sign in already done. Approvals → the request → pause 2 s on the amount and merchant → **Approve**. | 12 s |
| S2-03 | Cement paid | Claude Desktop | "Approved. Go ahead." → approved. | 15 s |
| S3-01 | Fuel card | Claude Desktop | Scene 3 first prompt → approved. | 25 s |
| S3-02 | Blocked | Claude Desktop | The speaker prompt → declined, Claude explains. | 20 s |
| S4-01 | Summary | Claude Desktop | Scene 4 prompt. | 15 s |
| S4-02 | B-roll | Chrome · dashboard | Home → Track spending → Audit log. Slow scrolls, 3 s per screen. | 12 s |
| S5-01–05 | Optional: Chrome shopping | Chrome (Claude in Chrome) | Scene 5. One file per store. | 60 s |

The editing pipeline adds these, so don't record them:

- the title card;
- the "Sandbox · demo data" badge on every frame;
- captions;
- the end card ("Sandbox shown. Live card issuance launches with our issuing partner.").

## Before each take

- [ ] Kit restarted (fresh world), and Claude Desktop restarted after it
- [ ] `npm run recording-kit:check` passes
- [ ] A **new chat** in Claude Desktop: no earlier conversation in the sidebar view, or the sidebar collapsed
- [ ] Dashboard signed in, in its own Chrome window, on Home
- [ ] Notifications off, other apps closed (see `RECORDING-SETTINGS.md`)
- [ ] Nothing personal on screen: browser tabs, bookmarks, desktop files, email

## Coverage, if there's time

- A second take of S2 at a different pace. Claude phrases things differently each time, and the better one gets used.
- A close-up of one expanded tool call (S2-01) at 125% zoom, for social cuts.
- A 5-second shot of the Claude Desktop config file showing the `acard` entry with no key in it. It answers "where does the key live?".
