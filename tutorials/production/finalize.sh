#!/bin/bash
# Take the newest raw WebM of each episode, transcode it to H.264/MP4, and
# write it into tutorials/ under its published name.
#
# Playwright records VP8/WebM. MP4 is what actually plays everywhere, and it
# lands at roughly half the size, so the published cut is always MP4.
set -u
OUT="$(cd "$(dirname "$0")/.." && pwd)"
FF="${FFMPEG:-$(node -e "process.stdout.write(require('ffmpeg-static'))" 2>/dev/null)}"

if [ -z "$FF" ] || [ ! -x "$FF" ]; then
  echo "No ffmpeg with H.264. Install one: npm install ffmpeg-static" >&2
  echo "(or set FFMPEG=/path/to/ffmpeg)" >&2
  exit 1
fi

declare -A NAMES=(
  [ep01]="01-what-acard-is"
  [ep02]="02-setup-and-first-run"
  [ep03]="03-wallet-and-first-card"
  [ep04]="04-the-authorization-engine"
  [ep05]="05-human-approvals"
  [ep06]="06-team-roles-and-access"
  [ep07]="07-enterprise"
  [ep08]="08-connecting-an-agent"
  [ep09]="09-deploying-to-aws"
)

total=0
for ep in $(printf '%s\n' "${!NAMES[@]}" | sort); do
  src=$(ls -t "$OUT/.raw/$ep"/*.webm 2>/dev/null | head -1)
  if [ -z "$src" ]; then echo "MISSING  $ep"; continue; fi
  dst="$OUT/${NAMES[$ep]}.mp4"

  # CRF 20 keeps terminal text crisp; faststart lets playback begin early.
  "$FF" -hide_banner -loglevel error -y -i "$src" \
    -c:v libx264 -crf 20 -preset medium -pix_fmt yuv420p \
    -movflags +faststart "$dst" || { echo "FAILED   $ep"; continue; }

  dur=$("$FF" -hide_banner -i "$dst" 2>&1 | grep -o 'Duration: [0-9:.]*' | cut -d' ' -f2)
  secs=$(echo "$dur" | awk -F: '{print int($1*3600+$2*60+$3)}')
  total=$((total + secs))
  printf '%-34s %s  %6s\n' "${NAMES[$ep]}.mp4" "${dur%.*}" "$(du -h "$dst" | cut -f1)"
done

printf '\nTotal runtime: %d min %d sec\n' $((total / 60)) $((total % 60))
