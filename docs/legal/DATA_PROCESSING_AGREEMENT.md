# Data Processing Agreement (Operator Agreement)

**DRAFT FOR COUNSEL REVIEW.** Between the customer named in the order or account ("**Responsible Party**") and [COMPANY NAME] ("**Operator**"). Forms part of the Terms of Service. Required by POPIA sections 20 and 21.

## 1. Scope
1.1 Applies where the Operator processes personal information on the Responsible Party's behalf: e.g. a merchant's customers' order details in A-MERCHANT, or a business customer's staff whose Agents use A-CARD.
1.2 Schedule 1 describes the processing.

## 2. Operator's duties
The Operator will:
1. process only on the Responsible Party's documented instructions (these terms and the service configuration), unless the law requires otherwise, in which case it will say so first if lawful;
2. keep the information confidential and ensure staff with access are bound to confidentiality;
3. apply the security measures in Schedule 2 (POPIA s19);
4. use sub-operators only as listed in `SUBPROCESSORS.md`, give 30 days' notice of changes (the Responsible Party may object and terminate), and bind them to equivalent terms;
5. notify the Responsible Party **without undue delay and within 48 hours** of becoming aware of a security compromise (s21(2)), with what is known, and help it notify the Regulator and data subjects;
6. help the Responsible Party respond to data subject requests (access, correction, deletion, objection);
7. transfer outside South Africa only with the safeguards of POPIA s72;
8. on termination, delete or return the information within 30 days, except where the law requires retention;
9. make available information needed to show compliance, and allow one audit a year on 30 days' notice (or rely on independent reports).

## 3. Responsible Party's duties
It confirms it has a lawful basis to share the information, has given data subjects the notices POPIA requires, and will not instruct processing that breaks the law.

## 4. Liability
As in the Terms of Service, except that neither party limits liability for breach of this agreement caused by gross negligence or wilful misconduct.

## Schedule 1: processing
| Item | Detail |
|---|---|
| Subject matter | providing A-CARD and A-MERCHANT |
| Data subjects | Responsible Party's customers, staff, Agent operators |
| Categories | names, contact details, order and delivery details, transaction records, Agent activity |
| Special information | none, unless the Responsible Party submits it (not permitted without written agreement) |
| Duration | term of the agreement + retention required by law |

## Schedule 2: security measures
TLS for all traffic; encryption at rest; field-level encryption for sensitive references; no card numbers stored (Basis Theory vault); wallet keys in AWS KMS; passkeys for approvals; role-based least-privilege access; MFA for staff; logging and monitoring; daily backups with restore tests; vulnerability management and annual penetration test; incident response per `BREACH_RESPONSE.md`.
