# Information Security Policy

**DRAFT.** Owner: [CTO]. Approved by: [DIRECTOR]. Meets POPIA s19 (identify risks, set safeguards, verify, update). Reviewed every 12 months.

## 1. Scope
All systems, staff, contractors and operators handling A-CARD data.

## 2. Roles
- **Information Officer** [NAME]: POPIA compliance, data subject requests, Regulator contact.
- **Security owner** [NAME]: this policy, access reviews, incidents.
- Everyone: report anything suspicious to [security@a-card.cc] at once.

## 3. Risk register (reviewed quarterly)
Top risks: credential theft (staff, API keys); compromised Agent keys; prompt injection causing unwanted purchases; database exposure; wallet key compromise; card data leaking into our systems; operator breach; outage. Each has an owner, control, and test in `docs/OPERATIONS.md` / the risk sheet.

## 4. Controls
| Area | Control |
|---|---|
| Access | least privilege; MFA (passkey or app) on Fly, GitHub, AWS, Didit, Basis Theory, VALR, email; access reviewed quarterly and removed on exit within 24 h |
| Secrets | in Fly secrets / password manager only; never in code or chat; rotated on staff exit or suspicion |
| Encryption | TLS 1.2+ everywhere; disk encryption; field-level AES-256-GCM for sensitive references (`ACARD_ENCRYPTION_KEY`) |
| Keys | wallet keys generated and used inside AWS KMS, never exported; IAM limits who may sign; deletion denied to the app role |
| Card data | never held (see `CARD_DATA_POLICY.md`) |
| Customer auth | passwords hashed; passkeys (WebAuthn) for approvals; recovery codes hashed; 24 h cooldown after recovery |
| Application | input validation; card-number guard; rate limits; dependency licence and vulnerability checks; code review for every change; automated tests |
| Infrastructure | managed hosting (Fly.io, Johannesburg); private database network; daily snapshots + weekly off-site backups; monthly restore test |
| Monitoring | uptime checks every 10 min; logs kept 12 months; alerts to on-call |
| Operators | due diligence before use; written agreements; annual review of their security reports (SOC 2 / PCI AOC / ISO 27001) |
| Staff | confidentiality agreements; security and POPIA training on joining and yearly |
| Testing | independent penetration test yearly and before live money; security audit of wallet and signing code |

## 5. Data minimisation
Collect only what a purpose in the Privacy Policy needs. De-identify analytics. Delete per the retention table.

## 6. Incidents
Follow `BREACH_RESPONSE.md`.

## 7. Exceptions
In writing, approved by the security owner, time-limited, logged.
