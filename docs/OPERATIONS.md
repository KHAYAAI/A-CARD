# Operations: monitoring, backups, on-call, incidents, support

For the sandbox launch: test money only. Revisit every section before real money.

## 1. Deploy check
After every deploy: `bash scripts/check-deploy.sh` (set `API_URL`, `DASHBOARD_URL`, `SANDBOX_URL` if your names differ). It checks the API, the API's database (`/health/ready`), the API reference, the dashboard, the sandbox, and that the dashboard was built against this API.

## 2. Monitoring and alerts
| What | How | Alert goes to |
|---|---|---|
| Up/down, every 10 min | `.github/workflows/uptime.yml` (runs `check-deploy.sh`) | GitHub email to watchers; Slack if `ALERT_SLACK_WEBHOOK` secret set |
| Machine restarts, health check failing | Fly `[[http_service.checks]]` on `/health` | Fly dashboard → app → Monitoring |
| CPU, memory, response codes, latency | Fly metrics (built-in Grafana: `fly dashboard metrics -a acard-api`) | Set alert rules in Fly Grafana |
| Errors in logs | `fly logs -a acard-api` | Optional: ship logs with `fly-log-shipper` to Better Stack / Grafana Cloud |
| Platform events (signups, declines) | `SLACK_WEBHOOK_URL` on the API | Slack |

Setup: in GitHub repo Settings → Variables add `ACARD_API_URL`, `ACARD_DASHBOARD_URL`, `ACARD_SANDBOX_URL`; in Secrets add `ALERT_SLACK_WEBHOOK`. Scheduled workflows only run from the default branch.

## 3. Backups and restore
- **Automatic:** Fly takes a daily volume snapshot of the Postgres machine. Keep 30 days: `fly volumes list -a acard-db`, then `fly volumes update <vol-id> --snapshot-retention 30 -a acard-db`.
- **Off-Fly copy (weekly, and before every migration):**
  ```
  fly proxy 15432:5432 -a acard-db &
  pg_dump "postgres://postgres:<password>@localhost:15432/acard_api" -Fc -f acard-$(date +%F).dump
  ```
  Store the dump encrypted (e.g. S3 with SSE-KMS, af-south-1). Never in the repo.
- **Restore drill (monthly):** `fly postgres create --snapshot-id <id> --name acard-db-restore`, point a staging API at it, run `check-deploy.sh`, delete it. Write down how long it took.
- `ACARD_ENCRYPTION_KEY` and `PROVIDER_*` keys are part of the backup: without them restored data can't be decrypted. Keep them in a password manager with two owners.

## 4. On-call
- **Rota:** one primary, one backup, weekly. With a team of one or two: primary = founder, backup = the other, and say so publicly ("support hours 08:00–20:00 SAST").
- **Pager:** uptime alerts → Slack `#acard-alerts` with mobile notifications on. Upgrade to PagerDuty / Better Stack on-call before real money.
- **Response targets (sandbox):** SEV1 acknowledge in 30 min during support hours; SEV2 next business day.
- **Access the on-call person needs:** Fly org, GitHub, Slack, AWS (read-only + KMS view), Didit, the password manager.

## 5. Incident process
| Severity | Example |
|---|---|
| SEV1 | API or dashboard down; data exposed; wrong balances; a key compromised |
| SEV2 | One feature broken (stores, passkeys, screening); slow but up |
| SEV3 | Cosmetic, docs, single-user issue |

Steps:
1. **Declare:** post in `#acard-incidents`: what, when, severity, who's leading.
2. **Stabilise first:** `fly releases -a acard-api` then `fly deploy --image <previous image>` to roll back; `fly scale count 0` to take it offline if data is at risk. Suspected key or data exposure: rotate secrets (`fly secrets set`), disable keys (`aws kms disable-key`), revoke API keys.
3. **Tell users:** status note on the dashboard banner / status page within 1 hour for SEV1. Personal-data breach: POPIA section 22 requires notifying the Information Regulator and affected people as soon as reasonably possible; call counsel the same day.
4. **Close:** write a blameless review within 5 days: timeline, cause, what changes. File in `docs/incidents/YYYY-MM-DD-title.md`.

## 6. Support
- **Channel:** one shared inbox (e.g. support@a-card.cc) plus the dashboard's help link. Answer within 1 business day.
- **Triage:** bug → GitHub issue with label `support`; anything that looks like fraud, a security report or a data request → escalate the same day.
- **Security reports:** publish `security@a-card.cc` and a `/.well-known/security.txt`; acknowledge within 2 business days.
- **POPIA requests** (access, correction, deletion): log them, answer within 30 days.
- **Saved replies to write first:** "this is a sandbox, no real money", "reset my passkey" (recovery codes, 24 h cooldown), "my agent was declined" (check policy limits), "how do I delete my account".
