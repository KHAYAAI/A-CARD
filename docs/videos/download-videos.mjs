#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import { URL } from "node:url";

const REPO = "https://github.com/KHAYAAI/A-CARD/raw/claude/agentcard-platform-build-affhcj";
const VIDEOS = [
  "A-CARD-full-walkthrough.mp4",
  "A-CARD-personal-console.mp4",
  "A-CARD-enterprise-console.mp4",
];

const outputDir = process.argv[2] || ".";

async function download(url, filepath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(filepath);
    const urlObj = new URL(url);
    const protocol = url.startsWith("https") ? https : https;

    protocol
      .get(url, (response) => {
        if (response.statusCode === 301 || response.statusCode === 302) {
          file.close();
          fs.unlinkSync(filepath);
          download(response.headers.location, filepath).then(resolve).catch(reject);
          return;
        }
        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode}`));
          return;
        }

        const len = parseInt(response.headers["content-length"], 10);
        let cur = 0;
        response.on("data", (chunk) => {
          cur += chunk.length;
          const pct = ((cur / len) * 100).toFixed(1);
          process.stdout.write(`\r  ${pct}%`);
        });
        response.pipe(file);
      })
      .on("error", reject);

    file.on("finish", () => {
      file.close();
      console.log("");
      resolve();
    });
    file.on("error", (err) => {
      fs.unlink(filepath, () => reject(err));
    });
  });
}

async function main() {
  console.log(`Downloading A-CARD platform videos to ${outputDir}...\n`);
  fs.mkdirSync(outputDir, { recursive: true });

  for (const video of VIDEOS) {
    const url = `${REPO}/docs/videos/${video}`;
    const filepath = path.join(outputDir, video);
    try {
      process.stdout.write(`Downloading ${video}... `);
      await download(url, filepath);
      const stat = fs.statSync(filepath);
      const size = (stat.size / 1024 / 1024).toFixed(1);
      console.log(`✓ ${size} MB`);
    } catch (err) {
      console.error(`✗ Failed: ${err.message}`);
      process.exit(1);
    }
  }

  console.log(`\nDone. Videos saved to ${outputDir}`);
}

main();
