#!/usr/bin/env bash
# Checks a deployed A-CARD: API (and its database), API reference, dashboard, sandbox.
# Usage: API_URL=https://acard-api.fly.dev DASHBOARD_URL=https://acard-dash-za.fly.dev bash scripts/check-deploy.sh
set -u
API_URL="${API_URL:-https://acard-api.fly.dev}"
DASHBOARD_URL="${DASHBOARD_URL:-https://acard-dash-za.fly.dev}"
SANDBOX_URL="${SANDBOX_URL:-https://acard-sandbox.fly.dev}"
fail=0
check() { # name url expected-text
  local body code
  body=$(curl -sS -m 15 -w '\n%{http_code}' "$2" 2>&1); code=${body##*$'\n'}; body=${body%$'\n'*}
  if [[ "$code" == 200 && "$body" == *"$3"* ]]; then echo "ok    $1"; else echo "FAIL  $1 ($2 -> HTTP $code)"; fail=1; fi
}
check "api"            "$API_URL/health"        '"ok":true'
check "api + database" "$API_URL/health/ready"  '"ok":true'
check "api reference"  "$API_URL/openapi.json"  '"openapi"'
check "dashboard"      "$DASHBOARD_URL/"        '<html'
[[ -n "$SANDBOX_URL" ]] && check "sandbox" "$SANDBOX_URL/" '<html'
# The dashboard must point at this API, or sign-in silently breaks.
if curl -sS -m 15 "$DASHBOARD_URL/" | grep -q "acard-api" || curl -sS -m 15 "$DASHBOARD_URL/" | grep -oE '/_next/static/chunks/[^"]+\.js' | head -20 | while read -r p; do curl -sS -m 15 "$DASHBOARD_URL$p"; done | grep -qF "${API_URL#https://}"; then
  echo "ok    dashboard points at $API_URL"
else
  echo "FAIL  dashboard is not built against $API_URL (redeploy it with the right NEXT_PUBLIC_ACARD_API_URL)"; fail=1
fi
exit $fail
