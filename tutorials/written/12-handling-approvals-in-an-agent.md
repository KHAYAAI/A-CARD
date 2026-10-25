# 12 — Handling approvals in an agent

**You'll build:** an agent that, when a purchase needs a human, waits for the decision, retries exactly once if approved, and stops cleanly if not.
**Time:** 10 minutes · **Prereqs:** [11](11-finding-supply-with-a-merchant.md)

Episode 5 showed approvals from the human's side. This is the agent's side, and it's the part agents most often get wrong.

## The one decline that expects a retry

Every decline reason means *stop*, except `pending_human_approval`, which means *wait*. A charge at or above an approval threshold (the card's own, or the org's) is declined and an approval request opens at the same moment:

```ts
const purchase = { card_id: card.id, amount: 5_750_000, merchant: { name: "Rand Build Supply", category: "5211" } };
const paid = await acard.sandbox.purchase(purchase);
// { approved: false, decline_reason: "pending_human_approval", approval_id: "appr_…" }
```

## Wait, then retry once

```ts
import { isAwaitingApproval } from "@acard/sdk";

let result = await acard.sandbox.purchase(purchase);

if (isAwaitingApproval(result)) {
  console.log(`Held for approval (${result.approval_id}). Waiting for a human.`);
  const decision = await acard.approvals.waitForDecision(result.approval_id!, { timeoutMs: 15 * 60_000 });

  if (decision.status !== "approved") {
    await acard.cards.close(card.id); // nothing to spend it on now
    return console.log(`Denied by ${decision.decidedBy}.`);
  }
  result = await acard.sandbox.purchase(purchase); // exactly once
}
```

From a real run of the procurement example, where the R57 500 order was above the org's R25 000 threshold:

```
Held for approval (appr_ablldva765avxgkkphia). Waiting for a human — approve in the dashboard, Slack link or `acard approvals`.
Approved by example-1792946401403@khaya.example. Retrying once on the grant.
Paid R57 500,00. Wallet available: R442 500,00
```

## Why exactly once

Approving doesn't raise a limit or unlock the card. It mints a **grant** for this card and this merchant, up to the approved amount. The retried charge consumes it. Charge the same thing again and it's held again, because the approval was spent. One approval, one purchase.

So retry the **same charge**. A different merchant, or a larger amount, doesn't match the grant and opens a new approval. A smaller amount at the same merchant does match, and uses the grant up.

## Things that go wrong

| Mistake | What happens | Do instead |
|---|---|---|
| Re-charging in a loop to "check" if it's approved yet | Each attempt is a full authorization. A-CARD reuses the one pending approval rather than opening duplicates, but every attempt lands in the audit log as another held charge. | Wait with `waitForDecision`, then retry once |
| Retrying with a higher amount or a different merchant | No grant matches, so a new approval opens | Retry the identical charge |
| Treating `pending_human_approval` like any other decline | The purchase is abandoned even though a human was about to approve it | Wait |
| Waiting forever | A stuck agent | Set `timeoutMs`; on timeout, report and close the card |

## Where the human approves

- the dashboard's **Approvals** tab
- Slack: set `SLACK_APPROVALS_WEBHOOK_URL` and each held charge posts with a link to the queue
- the CLI: `acard approvals`
- the API: `POST /v1/approvals/{id}/approve`

`waitForDecision` polls (every 3 seconds by default), because A-CARD doesn't push approval events to account holders yet.

**Runnable versions:** [`examples/03-procurement-agent.ts`](../../examples/03-procurement-agent.ts) (TypeScript, SDK) and [`examples/04-approval-aware-agent.py`](../../examples/04-approval-aware-agent.py) (Python, standard library only)
**Next:** [13 — Connecting a merchant's till](13-connecting-a-merchant-pos.md)
