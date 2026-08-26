#!/bin/bash
# Move the newest recording of each episode into tutorials/ under a clean name,
# and report real durations.
set -u
OUT=/home/user/A-CARD/tutorials
FF=/opt/pw-browsers/ffmpeg-1011/ffmpeg-linux

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
  [ -z "$src" ] && { echo "MISSING  $ep"; continue; }
  dst="$OUT/${NAMES[$ep]}.webm"
  cp "$src" "$dst"
  dur=$("$FF" -i "$dst" 2>&1 | grep -o 'Duration: [0-9:.]*' | cut -d' ' -f2)
  secs=$(echo "$dur" | awk -F: '{print int($1*3600+$2*60+$3)}')
  total=$((total + secs))
  size=$(du -h "$dst" | cut -f1)
  printf '%-32s %s  %6s\n' "${NAMES[$ep]}.webm" "${dur%.*}" "$size"
done
printf '\nTotal runtime: %d min %d sec\n' $((total / 60)) $((total % 60))
