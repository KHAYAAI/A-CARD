#!/usr/bin/env python3
"""
An approval-aware purchasing agent in plain Python (standard library only).

It shows the one decline that expects a retry: `pending_human_approval`.

    1. try to pay
    2. if the charge is held for a human, poll the approval until it is decided
    3. approved -> retry the same charge exactly once (it consumes a single-use grant)
       denied   -> stop
    4. any other decline -> stop and report the reason; don't retry

    npx tsx seed-demo-world.ts   # prints ACARD_API_KEY and the procurement-bot-03 card id
    ACARD_API_KEY=ak_... CARD_ID=card_... python3 04-approval-aware-agent.py

Approve while it waits: the dashboard's Approvals tab, `acard approvals`, or
POST /v1/approvals/{id}/approve.
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid

BASE_URL = os.environ.get("ACARD_API_URL", "http://localhost:8787").rstrip("/")
API_KEY = os.environ.get("ACARD_API_KEY", "")


class AcardError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(f"{status} {code}: {message}")
        self.status, self.code = status, code


def call(method: str, path: str, body: dict | None = None, idempotency_key: str | None = None) -> dict:
    headers = {"Authorization": f"Bearer {API_KEY}", "Accept": "application/json"}
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode()
    if method != "GET":
        # The same key on a retry of the same operation means it can never apply twice.
        headers["Idempotency-Key"] = idempotency_key or str(uuid.uuid4())
    request = urllib.request.Request(BASE_URL + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as error:
        payload = json.loads(error.read() or b"{}").get("error", {})
        raise AcardError(error.code, payload.get("code", "unknown"), payload.get("message", "")) from None


def wait_for_decision(approval_id: str, timeout_s: float = 900, interval_s: float = 3) -> dict:
    deadline = time.monotonic() + timeout_s
    while True:
        approvals = call("GET", "/v1/approvals")["approvals"]
        approval = next((a for a in approvals if a["id"] == approval_id), None)
        if approval and approval["status"] != "pending":
            return approval
        if time.monotonic() + interval_s > deadline:
            raise TimeoutError(f"approval {approval_id} was not decided in time")
        time.sleep(interval_s)


def buy(card_id: str, amount_cents: int, merchant: str, mcc: str, timeout_s: float = 900, interval_s: float = 3) -> dict:
    purchase = {"card_id": card_id, "amount": amount_cents, "merchant": {"name": merchant, "category": mcc}}
    rands = f"R{amount_cents / 100:,.2f}"
    print(f"Paying {rands} at {merchant} (MCC {mcc})")

    result = call("POST", "/v1/simulate/purchase", purchase)
    if not result["approved"] and result.get("decline_reason") == "pending_human_approval":
        approval_id = result["approval_id"]
        print(f"Held for a human: approval {approval_id}. Waiting...")
        decision = wait_for_decision(approval_id, timeout_s, interval_s)
        if decision["status"] != "approved":
            print(f"Denied by {decision.get('decidedBy', 'a human')}. Stopping.")
            return {"outcome": "denied"}
        print(f"Approved by {decision.get('decidedBy')}. Retrying once on the grant.")
        result = call("POST", "/v1/simulate/purchase", purchase)

    if result["approved"]:
        print(f"Paid. Wallet available: R{result['wallet']['available'] / 100:,.2f}")
        return {"outcome": "paid", "authorization_id": result["authorization_id"]}

    # Any other decline is final for this charge. Report it, don't retry it.
    print(f"Declined: {result.get('decline_reason')}. Not retrying.")
    return {"outcome": "declined", "reason": result.get("decline_reason")}


if __name__ == "__main__":
    card_id = os.environ.get("CARD_ID")
    if not API_KEY or not card_id:
        sys.exit("Set ACARD_API_KEY and CARD_ID (seed-demo-world.ts prints both; use the procurement-bot-03 card).")
    amount = int(os.environ.get("AMOUNT_CENTS", "1840000"))  # R18 400: over the card's R8 000 approval threshold
    outcome = buy(card_id, amount, os.environ.get("MERCHANT", "Rand Build Supply"), os.environ.get("MCC", "5211"))
    print(json.dumps(outcome))
