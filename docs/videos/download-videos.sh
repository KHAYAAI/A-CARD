#!/bin/bash
# Download A-CARD platform walkthrough videos

set -e

REPO_URL="https://github.com/KHAYAAI/A-CARD/raw/claude/agentcard-platform-build-affhcj/docs/videos"
OUTPUT_DIR="${1:-.}"

echo "Downloading A-CARD platform videos to $OUTPUT_DIR..."
mkdir -p "$OUTPUT_DIR"

videos=(
  "A-CARD-full-walkthrough.mp4"
  "A-CARD-personal-console.mp4"
  "A-CARD-enterprise-console.mp4"
)

for video in "${videos[@]}"; do
  echo "Downloading $video..."
  curl -L -o "$OUTPUT_DIR/$video" "$REPO_URL/$video"
  size=$(du -h "$OUTPUT_DIR/$video" | cut -f1)
  echo "✓ $video ($size)"
done

echo "Done. Videos saved to $OUTPUT_DIR"
