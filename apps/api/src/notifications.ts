import type { Platform } from "@acard/core";

/**
 * Push approval requests to Slack via an Incoming Webhook — the same
 * channel HumanLayer uses. Deliberately the simplest possible transport
 * (one POST, no bot token, no OAuth) so it can be wired up in minutes:
 * see the "external dependencies" list for how to create one.
 */
export function attachSlackNotifications(platform: Platform, webhookUrl: string, dashboardUrl?: string): void {
  platform.onEvent((event) => {
    if (event.type !== "approval.requested") return;
    const { approvalId, cardId, amount } = event.data as { approvalId: string; cardId: string; amount: number };
    const text = [
      `:bank: *A-CARD approval needed*`,
      `Card \`${cardId}\` wants to charge *${(amount / 100).toFixed(2)}* — waiting on a human decision.`,
      dashboardUrl ? `<${dashboardUrl}|Open the approvals queue>` : `Approval id: \`${approvalId}\``,
    ].join("\n");

    fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    }).catch((error) => {
      console.error("acard: failed to post Slack notification", error);
    });
  });
}
