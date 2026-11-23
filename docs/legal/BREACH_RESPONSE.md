# Security Compromise (Breach) Response

**DRAFT FOR COUNSEL REVIEW.** POPIA section 22. Works alongside the incident process in `docs/OPERATIONS.md`.

## 1. What counts
Reasonable grounds to believe personal information has been accessed or acquired by an unauthorised person: e.g. leaked database or backup, stolen staff credentials used on customer data, a misconfigured endpoint, an operator's breach affecting our data, card data appearing in our systems.

## 2. First 24 hours
1. **Contain:** revoke credentials and keys, take endpoints offline, rotate secrets, disable affected KMS keys, preserve logs (do not delete evidence).
2. **Assess:** what data, how many people, which people, since when, is it still exposed, was it encrypted (and were keys also exposed).
3. **Tell:** Information Officer and directors immediately; counsel the same day; affected partners (Basis Theory, VALR, Didit, issuer) as contracts require; if card data: Basis Theory and acquirer/card brands.
4. **Log** every step with times in `docs/incidents/`.

## 3. Notifications (POPIA s22)
| To | When | How |
|---|---|---|
| Information Regulator | as soon as reasonably possible after discovery | the Regulator's prescribed security compromise form (eServices portal) |
| Affected people | as soon as reasonably possible, unless a public body responsible for crime detection says it would impede an investigation | email to the address on file, plus dashboard notice; website notice or news media if contact details aren't enough |
| FIC / SAPS | if fraud, theft or a reportable transaction is involved | per FICA s29 / police case |
| Partners and responsible parties (when we're operator) | within 48 hours (DPA 2.5) | email to their contact |

The notice to people must give: enough detail to understand what happened and the possible consequences; what we're doing about it; what they should do (e.g. revoke Agent keys, watch statements, reset passkeys); and, if known, who accessed the information.

## 4. Afterwards
Blameless review within 5 business days; fixes tracked to closure; update the risk register and this procedure.

## 5. Contacts
Information Officer [NAME, phone]; security owner [NAME, phone]; counsel [FIRM, phone]; Information Regulator: inforegulator.org.za.

[⚖️ Counsel: confirm current Regulator form and portal, and UAE notification duties if applicable.]
