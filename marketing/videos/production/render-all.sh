#!/bin/bash
# Render every marketing video from a freshly seeded world, then transcode.
set -u
cd "$(dirname "$0")"
take() { ./reset-world.sh >/dev/null && echo "── $*" && node "$@" 2>&1 | grep -E "VIDEO:|Error|error" ; }
take full-demo.mjs
take product-75.mjs
take clips.mjs approval
take clips.mjs blocked
take clips.mjs search
./finalize.sh
echo "ALL DONE"
