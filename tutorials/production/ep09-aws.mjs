import { studio, titleCard, endCard, terminal, finish } from "./lib.mjs";

const { browser, ctx, page } = await studio("ep09");

await titleCard(page, {
  kicker: "Episode 9 of 9",
  title: "Deploying to AWS",
  sub: "One CDK stack: 98 resources, a Multi-AZ database, a WAF, three autoscaling services, and TLS on your own domain.",
  hold: 6800,
});

// --- the shape of the stack ------------------------------------------------------
await page.setContent(`<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;
  background:#05080d;color:#eef4fb;display:flex;align-items:center;justify-content:center;
  font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif">
  <div style="max-width:1000px;padding:0 60px;width:100%">
    <h2 style="font-size:31px;margin:0 0 26px;letter-spacing:-.8px">What gets built</h2>
    <div style="font:15px/2.0 ui-monospace,SFMono-Regular,Menlo,monospace;color:#b3c3d4;
      background:#0a1017;border:1px solid #1d2836;border-radius:13px;padding:24px 30px">
Internet <span style="color:#3d5266">──▶</span> <span style="color:#facc15">WAF</span> <span style="color:#3d5266">──▶</span> <span style="color:#4ade80">ALB</span> <span style="color:#5f7488">(public subnets)</span><br>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;├─▶ <span style="color:#4ade80">/v1/*, /webhooks/*</span> → api <span style="color:#5f7488">(private, ×2–6)</span><br>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;├─▶ <span style="color:#4ade80">/mcp*</span> → mcp <span style="color:#5f7488">(private)</span><br>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└─▶ <span style="color:#4ade80">/*</span> → dashboard <span style="color:#5f7488">(private)</span><br>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<span style="color:#3d5266">│</span><br>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<span style="color:#4ade80">RDS Postgres, Multi-AZ</span> <span style="color:#5f7488">(isolated subnets)</span>
    </div>
    <p style="font-size:17px;color:#8fa3b8;margin:24px 0 0;line-height:1.6">
      Only the load balancer has a public route in. The database is unreachable from the internet.</p>
  </div></body>`);
await page.waitForTimeout(17000);

// --- real synth facts -------------------------------------------------------------
await terminal(page, [
  { cmd: "cd infra/cdk && npm install", out: "up to date, audited 3 packages in 1s", hold: 1400 },
  { cmd: "npx cdk ls", out: "AcardStack", hold: 1900 },
  {
    cmd: "npx cdk synth --quiet && ./count-resources.sh",
    out: `98 resources across 38 types

    9  AWS::SecretsManager::Secret
    7  AWS::IAM::Role
    6  AWS::EC2::Subnet
    4  AWS::Logs::LogGroup
    3  AWS::ECS::Service
    3  AWS::ApplicationAutoScaling::ScalableTarget
    2  AWS::EC2::NatGateway
    1  AWS::RDS::DBInstance
    1  AWS::WAFv2::WebACL
    1  AWS::CloudTrail::Trail
    1  AWS::GuardDuty::Detector`,
    think: 2400,
    hold: 5200,
  },
], { title: "bash — inspecting the stack" });

// --- bootstrap + deploy -------------------------------------------------------------
await terminal(page, [
  { cmd: "aws sts get-caller-identity", out: `{\n    "Account": "123456789012",\n    "Arn": "arn:aws:iam::123456789012:user/deploy"\n}`, hold: 2100 },
  { cmd: "npx cdk bootstrap aws://123456789012/af-south-1", out: " ✅  Environment aws://123456789012/af-south-1 bootstrapped.", think: 1900, hold: 2400 },
  {
    cmd: `npx cdk deploy \\\n  --parameters IssuerWebhookSecret="$(openssl rand -hex 32)" \\\n  --parameters PayFastMerchantId="..." \\\n  --parameters PayFastMerchantKey="..." \\\n  --parameters PayFastPassphrase="..." \\\n  -c domain=app.yourdomain.com \\\n  -c hostedZoneId=Z0123456789ABCDEFGHIJ \\\n  -c hostedZoneName=yourdomain.com`,
    out: ` ✅  AcardStack

Outputs:
AcardStack.DashboardUrl = https://app.yourdomain.com
AcardStack.ApiUrl       = https://app.yourdomain.com
AcardStack.McpUrl       = https://app.yourdomain.com/mcp
AcardStack.PublicOrigin = https://app.yourdomain.com`,
    think: 3200,
    hold: 6000,
  },
], { title: "bash — deploying" });

// --- parameters ----------------------------------------------------------------------
await page.setContent(`<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;
  background:#05080d;color:#eef4fb;display:flex;align-items:center;justify-content:center;
  font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif">
  <div style="max-width:1010px;padding:0 60px;width:100%">
    <h2 style="font-size:31px;margin:0 0 12px;letter-spacing:-.8px">The deploy parameters</h2>
    <p style="font-size:17px;color:#8fa3b8;margin:0 0 26px">
      All <code style="color:#a7f3d0">noEcho</code>, all stored in Secrets Manager, all injected as
      container secrets — never baked into an image or a log line.</p>
    <table style="width:100%;border-collapse:collapse;font-size:16.5px">
      ${[
        ["IssuerWebhookSecret", "required", "#f87171", "HMAC secret for /webhooks/issuer."],
        ["PayFastMerchantId / Key / Passphrase", "optional", "#5f7488", "Real wallet funding and subscription billing. Blank = instant sandbox top-ups."],
        ["PayFastSandbox", "optional", "#5f7488", "\"true\" targets sandbox.payfast.co.za. Test here first."],
        ["WorkOsApiKey / WorkOsClientId", "optional", "#5f7488", "Enterprise SSO. Purely additive to password + MFA."],
        ["SlackApprovalsWebhookUrl", "optional", "#5f7488", "Push approval requests to Slack."],
      ].map(([a, tag, c, b]) => `<tr>
        <td style="padding:13px 18px 13px 0;color:#4ade80;font:600 14.5px ui-monospace,Menlo,monospace;
          vertical-align:top;border-bottom:1px solid #17202c">${a}<br>
          <span style="color:${c};font-size:12px;letter-spacing:.6px;text-transform:uppercase">${tag}</span></td>
        <td style="padding:13px 0;color:#b3c3d4;line-height:1.55;border-bottom:1px solid #17202c">${b}</td></tr>`).join("")}
    </table>
    <p style="font-size:16px;color:#8fa3b8;margin:22px 0 0">
      RDS credentials and the assembled <code style="color:#a7f3d0">DATABASE_URL</code> are generated
      automatically — you never handle them.</p>
  </div></body>`);
await page.waitForTimeout(20000);

// --- hardening ------------------------------------------------------------------------
await page.setContent(`<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;
  background:#05080d;color:#eef4fb;display:flex;align-items:center;justify-content:center;
  font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif">
  <div style="max-width:1000px;padding:0 60px;width:100%">
    <h2 style="font-size:31px;margin:0 0 12px;letter-spacing:-.8px">On by default</h2>
    <p style="font-size:17px;color:#8fa3b8;margin:0 0 26px">Not a production checklist you work through later.</p>
    <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:15px">
      ${[
        ["Multi-AZ RDS", "Synchronous standby, automatic failover on a zone outage."],
        ["Two NAT gateways", "One per AZ — no single-zone outbound failure point."],
        ["CPU autoscaling", "All three services scale out; desiredCount is a floor, not a fixed count."],
        ["WAF", "Managed rulesets, a global flood limit, and a tighter rule scoped to /v1/auth/login."],
        ["CloudTrail + GuardDuty", "Every API call recorded; account activity analysed for threats."],
        ["Durable request logs", "Full WAF and ALB logs to encrypted S3 via Kinesis Firehose."],
      ].map(([h, p]) => `<div style="background:#0c131c;border:1px solid #1d2836;border-radius:13px;padding:19px 22px">
        <div style="color:#4ade80;font-size:16.5px;font-weight:700;margin-bottom:7px">${h}</div>
        <div style="color:#a9bacd;font-size:15px;line-height:1.5">${p}</div></div>`).join("")}
    </div>
    <p style="font-size:16.5px;color:#8fa3b8;margin:24px 0 0;line-height:1.55">
      Roughly <b style="color:#eef4fb">$195–330/month</b> at rest in af-south-1. Turning these on is not
      the same as someone watching them — alerting and an on-call runbook are still yours to add.</p>
  </div></body>`);
await page.waitForTimeout(21000);

// --- the real gate ----------------------------------------------------------------------
await page.setContent(`<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;
  background:#05080d;color:#eef4fb;display:flex;align-items:center;justify-content:center;
  font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif">
  <div style="max-width:960px;padding:0 60px">
    <h2 style="font-size:31px;margin:0 0 22px;letter-spacing:-.8px">Two different bars</h2>
    <p style="font-size:20px;line-height:1.68;color:#c3d2e2;margin:0 0 20px">
      <b style="color:#4ade80">Public developer sandbox: ready.</b> Deploy this, put it on a real domain,
      let people sign up, create cards, and simulate purchases. That is a legitimate public beta.</p>
    <p style="font-size:20px;line-height:1.68;color:#c3d2e2;margin:0 0 20px">
      <b style="color:#facc15">Real cardholder money: not yet.</b> A-CARD decides authorizations; it does
      not issue cards on Visa or Mastercard. That needs a contracted, BIN-sponsored issuing partner —
      a commercial and regulatory relationship, not an engineering task.</p>
    <p style="font-size:20px;line-height:1.68;color:#c3d2e2;margin:0">
      The integration point is already built and tested. The day a partner signs, it's a wiring job.</p>
  </div></body>`);
await page.waitForTimeout(19000);

await endCard(page, {
  title: "The series, end to end",
  lines: [
    "<b>1–2</b> — What A-CARD is, and running it locally",
    "<b>3–5</b> — Wallets, cards, the authorization engine, human approvals",
    "<b>6–7</b> — Roles and access; enterprise departments, policy and audit",
    "<b>8–9</b> — Connecting an AI agent, and deploying to AWS",
    "Full written companion: <code>tutorials/README.md</code>",
  ],
  hold: 8500,
});

console.log("VIDEO:", await finish(browser, ctx, page, "ep09"));
