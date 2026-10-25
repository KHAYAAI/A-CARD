#!/usr/bin/env bash
# The whole A-CARD loop in curl: sign up, fund, issue a card, buy, get declined.
#
#   npm run dev:api                      # in another terminal
#   bash examples/01-curl-quickstart.sh
#
# Needs curl and jq. Point ACARD_API_URL at another deployment to run it there.
set -euo pipefail

API="${ACARD_API_URL:-http://localhost:8787}"
say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

say "1. Sign up — returns an API key, shown once"
SIGNUP=$(curl -sS -X POST "$API/v1/signup" -H 'content-type: application/json' \
  -d "{\"email\":\"quickstart-$(date +%s)@khaya.example\",\"name\":\"Khaya Logistics\",\"currency\":\"ZAR\"}")
KEY=$(echo "$SIGNUP" | jq -r .api_key)
echo "api key: ${KEY:0:16}…"
auth=(-H "authorization: Bearer $KEY" -H 'content-type: application/json')

say "2. Fund the sandbox wallet with R10 000.00 (amounts are integer cents)"
curl -sS -X POST "$API/v1/wallet/fund" "${auth[@]}" -d '{"amount":1000000}' | jq '.wallet'

say "3. Issue a fuel-only card: R5 000 per fill, R40 000 total"
CARD=$(curl -sS -X POST "$API/v1/cards" "${auth[@]}" -H "idempotency-key: quickstart-card-1" -d '{
  "label": "fleet-agent-07",
  "single_use": false,
  "limits": { "per_transaction": 500000, "total": 4000000 },
  "allowed_merchant_categories": ["5541", "5542"]
}')
CARD_ID=$(echo "$CARD" | jq -r .card.id)
echo "$CARD" | jq '{id: .card.id, last4: .card.last4, limits: .card.limits, allowed: .card.allowedMerchantCategories}'

say "4. Buy R1 850 of diesel — approved"
curl -sS -X POST "$API/v1/simulate/purchase" "${auth[@]}" \
  -d "{\"card_id\":\"$CARD_ID\",\"amount\":185000,\"merchant\":{\"name\":\"Highveld Tyre & Fuel\",\"category\":\"5541\"}}" \
  | jq '{approved, decline_reason, available: .wallet.available}'

say "5. Try to buy a TV on the fuel card — declined, with a reason"
curl -sS -X POST "$API/v1/simulate/purchase" "${auth[@]}" \
  -d "{\"card_id\":\"$CARD_ID\",\"amount\":90000,\"merchant\":{\"name\":\"Game Electronics\",\"category\":\"5732\"}}" \
  | jq '{approved, decline_reason}'

say "6. Try R6 000 of diesel — over the per-fill limit"
curl -sS -X POST "$API/v1/simulate/purchase" "${auth[@]}" \
  -d "{\"card_id\":\"$CARD_ID\",\"amount\":600000,\"merchant\":{\"name\":\"Highveld Tyre & Fuel\",\"category\":\"5541\"}}" \
  | jq '{approved, decline_reason}'

say "7. The audit trail: every decision and its reason"
curl -sS "$API/v1/transactions?card_id=$CARD_ID" "${auth[@]}" \
  | jq -r '.transactions[] | "\(.type)\t\(.status)\t\(.amount)\t\(.merchantName)\t\(.declineReason // "")"'

say "Done. Your key: $KEY"
