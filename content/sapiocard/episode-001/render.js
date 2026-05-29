#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");

const SPEC_PATH = path.join(__dirname, "spec.yaml");
const OUTPUT_DIR = path.join(__dirname, "output");

const RUNWAY_API_KEY = process.env.RUNWAY_API_KEY;
const RUNWAY_BASE = "https://api.runwayml.com/v1";
const POLL_INTERVAL_MS = 8000;
const POLL_TIMEOUT_MS = 600000;

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

async function apiPost(endpoint, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const options = {
      hostname: "api.runwayml.com",
      path: `/v1${endpoint}`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${RUNWAY_API_KEY}`,
        "X-Runway-Version": "2024-11-06",
        "Content-Length": Buffer.byteLength(payload),
      },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode >= 400) {
          reject(new Error(`Runway API ${res.statusCode}: ${data}`));
        } else {
          resolve(JSON.parse(data));
        }
      });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function apiGet(endpoint) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.runwayml.com",
      path: `/v1${endpoint}`,
      method: "GET",
      headers: {
        "Authorization": `Bearer ${RUNWAY_API_KEY}`,
        "X-Runway-Version": "2024-11-06",
      },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode >= 400) {
          reject(new Error(`Runway API ${res.statusCode}: ${data}`));
        } else {
          resolve(JSON.parse(data));
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

async function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        https.get(res.headers.location, (r) => r.pipe(file));
        file.on("finish", () => file.close(resolve));
        return;
      }
      res.pipe(file);
      file.on("finish", () => file.close(resolve));
    }).on("error", (err) => {
      fs.unlink(destPath, () => {});
      reject(err);
    });
  });
}

async function pollTask(taskId) {
  const start = Date.now();
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    const task = await apiGet(`/tasks/${taskId}`);
    log(`  Task ${taskId} status: ${task.status}`);
    if (task.status === "SUCCEEDED") return task;
    if (task.status === "FAILED" || task.status === "CANCELLED") {
      throw new Error(`Task ${taskId} ${task.status}: ${task.failure || ""}`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`Task ${taskId} timed out after ${POLL_TIMEOUT_MS / 1000}s`);
}

async function renderSegment(segment) {
  log(`Submitting segment ${segment.id}: "${segment.label}"`);

  const task = await apiPost("/text_to_video", {
    model: "gen3a_turbo",
    prompt_text: segment.prompt,
    negative_prompt: segment.negative_prompt,
    duration: 10,
    ratio: "720:1280",
  });

  log(`  Task created: ${task.id}`);
  const completed = await pollTask(task.id);

  const outputUrl = completed.output?.[0];
  if (!outputUrl) throw new Error(`No output URL for segment ${segment.id}`);

  const outPath = path.join(OUTPUT_DIR, `segment-${segment.id}.mp4`);
  log(`  Downloading to ${outPath}`);
  await downloadFile(outputUrl, outPath);
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
  if (!RUNWAY_API_KEY) {
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
    const outPath = await renderSegment(seg);
    segmentPaths.push(outPath);
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
