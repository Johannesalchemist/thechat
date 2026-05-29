#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const { generateRunwayVideo } = require("../../../apps/api/video/runway");

const SPEC_PATH = path.join(__dirname, "spec.yaml");
const OUTPUT_DIR = path.join(__dirname, "output");

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function parseYamlSegments() {
  const raw = fs.readFileSync(SPEC_PATH, "utf8");
  const segments = [];
  const segmentBlocks = raw.split(/^  - id:/m).slice(1);
  for (const block of segmentBlocks) {
    const idMatch = block.match(/^(\d+)/);
    const labelMatch = block.match(/label: "([^"]+)"/);
    const promptMatch = block.match(/prompt: \|\n([\s\S]+?)(?=\n    negative_prompt:)/);
    const negMatch = block.match(/negative_prompt: \|\n([\s\S]+?)(?=\n  - id:|\nrunway:|$)/);

    if (!idMatch || !promptMatch) continue;
    segments.push({
      id: parseInt(idMatch[1]),
      label: labelMatch ? labelMatch[1] : `Segment ${idMatch[1]}`,
      prompt: promptMatch[1].trim().replace(/\n      /g, " ").replace(/\n/g, " "),
      negative_prompt: negMatch ? negMatch[1].trim().replace(/\n      /g, " ").replace(/\n/g, " ") : "",
    });
  }
  return segments;
}

async function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const get = (u) =>
      https.get(u, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          file.close();
          get(res.headers.location);
          return;
        }
        res.pipe(file);
        file.on("finish", () => file.close(resolve));
      }).on("error", (err) => {
        fs.unlink(destPath, () => {});
        reject(err);
      });
    get(url);
  });
}

async function renderSegment(segment) {
  log(`Submitting segment ${segment.id}: "${segment.label}"`);

  const result = await generateRunwayVideo({
    prompt: segment.prompt,
    negative_prompt: segment.negative_prompt,
    duration: 10,
    ratio: "720:1280",
    wait: true,
  });

  if (!result.url) throw new Error(`No output URL for segment ${segment.id}`);

  const outPath = path.join(OUTPUT_DIR, `segment-${segment.id}.mp4`);
  log(`  Downloading to ${outPath}`);
  await downloadFile(result.url, outPath);
  log(`  Segment ${segment.id} done.`);
  return outPath;
}

function writeManifest(segmentPaths) {
  const manifest = {
    project: "sapiocard_episode_001",
    rendered_at: new Date().toISOString(),
    segments: segmentPaths.map((p, i) => ({ id: i + 1, file: path.basename(p) })),
    subtitle_file: "episode-001.srt",
    caption_file: "caption.txt",
    thumbnail_prompt: "thumbnail-prompt.txt",
    assembly_note:
      "Concatenate segment-1.mp4 → segment-2.mp4 → segment-3.mp4 in order. " +
      "Add voiceover audio track. Burn episode-001.srt for preview. " +
      "Extract frame at 00:00:15 of segment-2 for thumbnail.",
    review_gate: "REQUIRED before publish",
    publish: false,
  };
  const manifestPath = path.join(OUTPUT_DIR, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  log(`Manifest written: ${manifestPath}`);
}

async function main() {
  if (!process.env.RUNWAY_API_KEY) {
    console.error("ERROR: RUNWAY_API_KEY is not set in environment.");
    console.error("Export it: export RUNWAY_API_KEY=your_key_here");
    process.exit(1);
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  log("=== SapioCard Episode 1 — Render Start ===");
  const segments = parseYamlSegments();
  log(`Parsed ${segments.length} segments from spec.yaml`);

  const segmentPaths = [];
  for (const seg of segments) {
    segmentPaths.push(await renderSegment(seg));
  }

  writeManifest(segmentPaths);

  log("=== Render Complete ===");
  log("Next steps:");
  log("  1. Review segments in output/");
  log("  2. Assemble: ffmpeg -i segment-1.mp4 -i segment-2.mp4 -i segment-3.mp4 \\");
  log("               -filter_complex concat=n=3:v=1:a=0 -c:v libx264 master.mp4");
  log("  3. Add voiceover track");
  log("  4. Burn subtitles for review");
  log("  5. Extract thumbnail from segment-2 at ~5s");
  log("  6. Pass review gate, then publish");
}

main().catch((err) => {
  console.error("RENDER FAILED:", err.message);
  process.exit(1);
});
