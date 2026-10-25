#!/bin/bash
# Transcode the newest raw take of each marketing video to H.264/MP4 in marketing/videos/.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$(cd "$HERE/.." && pwd)"
FF="${FFMPEG:-$HERE/node_modules/ffmpeg-static/ffmpeg}"

declare -A NAMES=(
  [full-demo]="A-CARD-demo-full"
  [product-75]="A-CARD-product-75s"
  [clip-approval]="A-CARD-clip-approval"
  [clip-blocked]="A-CARD-clip-blocked"
  [clip-search]="A-CARD-clip-search"
)

for take in "${!NAMES[@]}"; do
  src=$(ls -t "$OUT/.raw/$take"/*.webm 2>/dev/null | head -1)
  [ -z "$src" ] && continue
  dst="$OUT/${NAMES[$take]}.mp4"
  # CRF 21 keeps terminal text crisp at 1080p; faststart lets playback begin before download completes.
  "$FF" -hide_banner -loglevel error -y -i "$src" \
    -c:v libx264 -crf 21 -preset medium -pix_fmt yuv420p -r 30 \
    -movflags +faststart "$dst" || { echo "FAILED   $take"; continue; }
  dur=$("$FF" -hide_banner -i "$dst" 2>&1 | grep -o 'Duration: [0-9:.]*' | cut -d' ' -f2)
  res=$("$FF" -hide_banner -i "$dst" 2>&1 | grep -o ', [0-9]*x[0-9]*' | head -1 | tr -d ', ')
  printf '%-28s %s  %-10s %6s\n' "${NAMES[$take]}.mp4" "${dur%.*}" "$res" "$(du -h "$dst" | cut -f1)"
done
