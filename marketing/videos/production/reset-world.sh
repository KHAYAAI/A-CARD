#!/bin/bash
# Restart the recording harness so a take starts from a freshly seeded demo world.
set -u
cd "$(dirname "$0")"
for pid in $(pgrep -f "demo-serve[r].ts"); do kill "$pid" 2>/dev/null; done
for i in $(seq 1 30); do curl -sf -m 1 localhost:8787/health >/dev/null || break; sleep 0.3; done
rm -f world.json
: > "${SLACK_LOG:-/tmp/claude-0/-home-user-A-CARD/12752dbb-0d8d-5953-b406-38ef64f1dc47/scratchpad/slack.log}"
setsid nohup ../../../node_modules/.bin/tsx demo-server.ts > /tmp/acard-demo-server.log 2>&1 &
for i in $(seq 1 60); do [ -f world.json ] && break; sleep 0.5; done
[ -f world.json ] && echo "world ready" || { echo "harness failed"; cat /tmp/acard-demo-server.log; exit 1; }
