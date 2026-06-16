/**
 * Video Intelligence Component
 * Extracts: text, creator, content, websites, formulas from video URLs
 * Supports: YouTube, Facebook, TikTok, Instagram, direct URLs
 *
 * Optional audio pipeline (audioEnabled: true):
 *   Uses yt-dlp (download m4a/webm) + OpenAI Whisper (STT) + Claude (analysis)
 *   Requires: OPENAI_API_KEY in .env
 *   Failure is graceful — visual analysis always completes independently.
 *
 * Environment notes (checked 2026-06-06):
 *   ffmpeg: present but non-functional (libcaca.so.0 missing)
 *   yt-dlp: functional (2026.03.17), downloads m4a/webm without ffmpeg
 *   playwright: available, Chromium installed
 */

"use strict";

const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const https = require("https");
const http = require("http");
const Anthropic = require("@anthropic-ai/sdk");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const DATA_DIR = path.join(__dirname, "../../../data/video-intelligence/jobs");

// ─── Step logger ──────────────────────────────────────────────────────────────
// Writes to console and to data/{jobId}/log.json.
// Never prints API key values.

function makeLogger(jobId) {
  const logPath = path.join(DATA_DIR, jobId, "log.json");

  return function log(step, message) {
    const entry = { step, message, ts: new Date().toISOString() };
    console.log(`[video-intel][${jobId}][${step}] ${message}`);
    let logs = [];
    try { logs = JSON.parse(fs.readFileSync(logPath, "utf8")); } catch (_) {}
    logs.push(entry);
    try { fs.writeFileSync(logPath, JSON.stringify(logs, null, 2)); } catch (_) {}
  };
}

// ─── Main Entry Point ────────────────────────────────────────────────────────

async function analyzeVideo({
  url,
  intervalSeconds = 15,
  maxFrames = 12,
  audioEnabled = false,
}) {
  const jobId = `${Date.now()}`;
  const jobDir = path.join(DATA_DIR, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  const log = makeLogger(jobId);
  log("init", `Job started — url: ${url} | interval: ${intervalSeconds}s | frames: ${maxFrames} | audio: ${audioEnabled}`);

  const result = {
    jobId,
    url,
    startedAt: new Date().toISOString(),
    status: "running",
    metadata: {},
    frames: [],
    visual: null,
    audio: { status: audioEnabled ? "pending" : "disabled" },
    merged: null,
  };

  saveJob(jobDir, result);

  // ── Visual pipeline ──────────────────────────────────────────────────────
  try {
    log("metadata", "Fetching video metadata via yt-dlp...");
    result.metadata = await getVideoMetadata(url, jobDir, log);
    log("metadata", `Done — creator: ${result.metadata.creator || "unknown"}, title: ${(result.metadata.title || "").slice(0, 60)}`);
    saveJob(jobDir, result);

    log("frames:thumbnails", "Downloading platform thumbnails...");
    result.frames = await downloadThumbnails(result.metadata.thumbnails, jobDir, log);
    log("frames:thumbnails", `${result.frames.length} thumbnail(s) downloaded`);
    saveJob(jobDir, result);

    log("frames:playwright", "Launching headless browser for frame capture...");
    const playwrightFrames = await capturePlaywrightFrames(url, jobDir, intervalSeconds, maxFrames, log);
    result.frames = [...result.frames, ...playwrightFrames];
    log("frames:playwright", `${playwrightFrames.length} playwright frame(s) captured — total: ${result.frames.length}`);
    saveJob(jobDir, result);

    log("vision", `Sending ${result.frames.length} frame(s) to Claude Vision...`);
    result.visual = await extractIntelligence(result.frames, result.metadata, log);

    // Save visual artifact separately
    fs.writeFileSync(path.join(jobDir, "visual.json"), JSON.stringify(result.visual, null, 2));
    log("vision", `Vision complete — text: ${result.visual.text.length}, websites: ${result.visual.websites.length}, formulas: ${result.visual.formulas.length}`);
    saveJob(jobDir, result);

  } catch (err) {
    log("error", `Visual pipeline failed: ${err.message}`);
    result.status = "error";
    result.error = err.message;
    saveJob(jobDir, result);
    return result;
  }

  // ── Audio pipeline (optional, non-blocking on failure) ───────────────────
  if (audioEnabled) {
    log("audio:start", "Starting audio pipeline...");
    const audioPipeline = require("./audio-pipeline");
    const audioResult = await audioPipeline.runAudioPipeline(url, jobDir, result.metadata, log);

    if (audioResult.status === "done") {
      // Save transcript as separate artifact
      const transcriptPath = path.join(jobDir, "transcript.json");
      fs.writeFileSync(transcriptPath, JSON.stringify(audioResult.transcript, null, 2));
      result.audio = {
        status: "done",
        transcriptPath,
        analysis: audioResult.analysis,
      };
      log("audio:done", `Audio pipeline complete — spoken words: ${(audioResult.analysis.spokenText || "").split(/\s+/).length}`);
    } else {
      result.audio = { status: audioResult.status, reason: audioResult.reason };
    }
    saveJob(jobDir, result);

    // Merge visual + audio if both succeeded
    if (result.audio.status === "done") {
      log("merge", "Merging visual and audio analysis...");
      result.merged = mergeAnalysis(result.visual, result.audio.analysis, log);
      fs.writeFileSync(path.join(jobDir, "merged.json"), JSON.stringify(result.merged, null, 2));
      log("merge", `Merge complete — allWebsites: ${result.merged.allWebsites.length}, allFormulas: ${result.merged.allFormulas.length}, confirmedByBoth: ${result.merged.inferredFromBoth.websites.length} sites`);
      saveJob(jobDir, result);
    }
  }

  result.status = "done";
  result.completedAt = new Date().toISOString();
  log("done", `Job complete — status: done`);
  saveJob(jobDir, result);

  return result;
}

// ─── Step 1: yt-dlp Metadata ────────────────────────────────────────────────

async function getVideoMetadata(url, jobDir, log) {
  try {
    const raw = execSync(
      `yt-dlp --no-check-certificate --dump-json --no-download --no-playlist "${url}"`,
      { timeout: 30000, encoding: "utf8" }
    );
    const info = JSON.parse(raw);

    // Collect thumbnail URLs sorted by resolution (storyboards give frame coverage)
    const thumbnails = (info.thumbnails || [])
      .filter((t) => t.url)
      .sort((a, b) => (b.width || 0) - (a.width || 0))
      .slice(0, 6)
      .map((t) => t.url);

    if (info.thumbnail && !thumbnails.includes(info.thumbnail)) {
      thumbnails.unshift(info.thumbnail);
    }

    const meta = {
      title: info.title || null,
      creator: info.uploader || info.channel || info.creator || null,
      creatorUrl: info.uploader_url || info.channel_url || null,
      description: (info.description || "").slice(0, 3000),
      duration: info.duration || null,
      uploadDate: info.upload_date || null,
      viewCount: info.view_count || null,
      platform: info.extractor || null,
      tags: (info.tags || []).slice(0, 30),
      categories: info.categories || [],
      thumbnails,
    };

    fs.writeFileSync(path.join(jobDir, "metadata.json"), JSON.stringify(meta, null, 2));
    return meta;
  } catch (err) {
    log("metadata", `yt-dlp failed (${err.message.slice(0, 80)}) — continuing with empty metadata`);
    return { title: null, creator: null, description: "", thumbnails: [], error: err.message };
  }
}

// ─── Step 2: Download Thumbnails ─────────────────────────────────────────────

async function downloadThumbnails(urls, jobDir, log) {
  const frames = [];
  for (let i = 0; i < urls.length; i++) {
    const ext = urls[i].includes(".webp") ? "webp" : "jpg";
    const dest = path.join(jobDir, `thumb_${i}.${ext}`);
    try {
      await downloadFile(urls[i], dest);
      if (fs.existsSync(dest) && fs.statSync(dest).size > 1000) {
        frames.push({ path: dest, source: "thumbnail", url: urls[i] });
      }
    } catch (e) {
      log("frames:thumbnails", `Thumb ${i} failed: ${e.message.slice(0, 60)}`);
    }
  }
  return frames;
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith("https") ? https : http;
    const file = fs.createWriteStream(dest);
    proto
      .get(url, (res) => {
        res.pipe(file);
        file.on("finish", () => file.close(resolve));
      })
      .on("error", (e) => {
        fs.unlink(dest, () => {});
        reject(e);
      });
  });
}

// ─── Step 3: Playwright Frame Capture ────────────────────────────────────────

async function capturePlaywrightFrames(url, jobDir, intervalSeconds, maxFrames, log) {
  const frames = [];
  let browser;
  try {
    const { chromium } = require("playwright");
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
    });
    const page = await ctx.newPage();

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(3000);

    // Dismiss cookie banners
    for (const sel of [
      "[aria-label*='Accept']", "[aria-label*='accept']",
      "button:has-text('Accept all')", "button:has-text('Accept')", "#accept-button",
    ]) {
      try { await page.click(sel, { timeout: 1000 }); await page.waitForTimeout(500); break; } catch (_) {}
    }

    // Start playback
    for (const sel of ["video", ".ytp-play-button", "[data-testid='play-button']", "[aria-label='Play']"]) {
      try { await page.click(sel, { timeout: 1500 }); await page.waitForTimeout(1000); break; } catch (_) {}
    }

    for (let i = 0; i < maxFrames; i++) {
      const framePath = path.join(jobDir, `frame_${String(i).padStart(3, "0")}.jpg`);
      await page.screenshot({ path: framePath, type: "jpeg", quality: 82, fullPage: false });
      if (fs.existsSync(framePath) && fs.statSync(framePath).size > 5000) {
        frames.push({ path: framePath, source: "playwright", index: i });
        log("frames:playwright", `Frame ${i + 1}/${maxFrames} captured`);
      }
      if (i < maxFrames - 1) {
        try {
          await page.evaluate((secs) => {
            const v = document.querySelector("video");
            if (v) v.currentTime += secs;
          }, intervalSeconds);
        } catch (_) {}
        await page.waitForTimeout(1500);
      }
    }
  } catch (err) {
    log("frames:playwright", `Playwright failed (${err.message.slice(0, 80)}) — using thumbnails only`);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
  return frames;
}

// ─── Step 4: Claude Vision Intelligence Extraction ───────────────────────────

async function extractIntelligence(frames, metadata, log) {
  const text = new Set();
  const websites = new Set();
  const formulas = new Set();
  const frameDescriptions = [];

  const imagePaths = frames
    .filter((f) => f.path && fs.existsSync(f.path))
    .map((f) => f.path);

  log("vision", `Processing ${imagePaths.length} image(s) in batches of 4...`);

  for (let i = 0; i < imagePaths.length; i += 4) {
    const batch = imagePaths.slice(i, i + 4);
    const batchNum = Math.floor(i / 4) + 1;
    log("vision", `Batch ${batchNum} — frames ${i + 1}–${i + batch.length}`);

    const content = [];
    for (const imgPath of batch) {
      const ext = imgPath.endsWith(".webp") ? "image/webp" : "image/jpeg";
      const data = fs.readFileSync(imgPath).toString("base64");
      content.push({ type: "image", source: { type: "base64", media_type: ext, data } });
    }
    content.push({
      type: "text",
      text: `These are frames from a video. Extract ALL visible information and return ONLY valid JSON:
{
  "text": ["every word, phrase, sentence visible in the frames"],
  "websites": ["any URLs, domain names, @handles, or web addresses"],
  "formulas": ["any mathematical, business, financial, or scientific formulas or equations"],
  "frame_descriptions": ["brief description of each frame"]
}
Be thorough — capture all text even if partially visible. Include prices, percentages, contact info.`,
    });

    try {
      const resp = await anthropic.messages.create({
        model: "claude-opus-4-8",
        max_tokens: 2048,
        messages: [{ role: "user", content }],
      });
      const raw = resp.content[0].text;
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        (parsed.text || []).forEach((t) => text.add(t));
        (parsed.websites || []).forEach((w) => websites.add(w));
        (parsed.formulas || []).forEach((f) => formulas.add(f));
        (parsed.frame_descriptions || []).forEach((d) => frameDescriptions.push(d));
      }
    } catch (e) {
      log("vision", `Batch ${batchNum} failed: ${e.message.slice(0, 80)}`);
    }
  }

  // Extract from description text as well
  if (metadata.description && metadata.description.length > 100) {
    log("vision", "Extracting intelligence from video description...");
    const descIntel = await extractFromDescription(metadata.description);
    descIntel.websites.forEach((w) => websites.add(w));
    descIntel.formulas.forEach((f) => formulas.add(f));
    descIntel.text.forEach((t) => text.add(t));
  }

  const lead = buildLeadProfile(metadata, text, websites, formulas);

  return {
    creator: metadata.creator,
    title: metadata.title,
    platform: metadata.platform,
    text: [...text],
    websites: [...websites],
    formulas: [...formulas],
    frameDescriptions,
    lead,
  };
}

async function extractFromDescription(description) {
  try {
    const resp = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      messages: [{
        role: "user",
        content: `Extract from this video description. Return ONLY JSON:
{
  "websites": ["all URLs, domains, links"],
  "formulas": ["any formulas, equations, pricing formulas"],
  "text": ["key phrases, offers, calls to action, contact info"]
}

Description:
${description}`,
      }],
    });
    const raw = resp.content[0].text;
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
  } catch (_) {}
  return { websites: [], formulas: [], text: [] };
}

function buildLeadProfile(metadata, text, websites, formulas) {
  const textArr = [...text];
  const websitesArr = [...websites];
  const score = Math.min(
    100,
    (websitesArr.length > 0 ? 20 : 0) +
    (formulas.size > 0 ? 15 : 0) +
    (metadata.creator ? 20 : 0) +
    (textArr.length > 10 ? 25 : textArr.length * 2) +
    (metadata.viewCount ? Math.min(20, Math.floor(metadata.viewCount / 10000)) : 0)
  );
  return {
    source: "video_intelligence",
    creator: metadata.creator,
    creatorUrl: metadata.creatorUrl,
    title: metadata.title,
    platform: metadata.platform,
    viewCount: metadata.viewCount,
    score,
    keyWebsites: websitesArr.slice(0, 10),
    keyFormulas: [...formulas].slice(0, 10),
    tags: metadata.tags || [],
    uploadDate: metadata.uploadDate,
  };
}

// ─── Step 5: Merge Analysis ───────────────────────────────────────────────────
// Combines visual (Claude Vision) and audio (Whisper + Claude) findings.
// Clearly distinguishes: seenInFrames | spokenInAudio | inferredFromBoth | gaps

function mergeAnalysis(visual, audioAnalysis) {
  const seenInFrames = {
    text: visual.text || [],
    websites: visual.websites || [],
    formulas: visual.formulas || [],
    frameDescriptions: visual.frameDescriptions || [],
  };

  const spokenInAudio = {
    websites: audioAnalysis.websites || [],
    formulas: audioAnalysis.formulas || [],
    keyPoints: audioAnalysis.keyPoints || [],
    products: audioAnalysis.products || [],
    contacts: audioAnalysis.contacts || [],
    transcript: audioAnalysis.spokenText || "",
  };

  // Items that appear confirmed in both sources (fuzzy match)
  function confirmedInBoth(visualArr, audioArr) {
    return visualArr.filter((v) =>
      audioArr.some(
        (a) =>
          a.toLowerCase().includes(v.toLowerCase()) ||
          v.toLowerCase().includes(a.toLowerCase())
      )
    );
  }

  const inferredFromBoth = {
    websites: confirmedInBoth(seenInFrames.websites, spokenInAudio.websites),
    formulas: confirmedInBoth(seenInFrames.formulas, spokenInAudio.formulas),
  };

  // Items only in one source (potential gaps or errors)
  const gaps = {
    seenButNotSpoken: {
      websites: seenInFrames.websites.filter((w) => !inferredFromBoth.websites.includes(w)),
      formulas: seenInFrames.formulas.filter((f) => !inferredFromBoth.formulas.includes(f)),
    },
    spokenButNotSeen: {
      websites: spokenInAudio.websites.filter((w) => !inferredFromBoth.websites.includes(w)),
      formulas: spokenInAudio.formulas.filter((f) => !inferredFromBoth.formulas.includes(f)),
    },
  };

  // Deduplicated union across both sources
  const allWebsites = [...new Set([...seenInFrames.websites, ...spokenInAudio.websites])];
  const allFormulas = [...new Set([...seenInFrames.formulas, ...spokenInAudio.formulas])];

  return {
    seenInFrames,
    spokenInAudio,
    inferredFromBoth,
    gaps,
    allWebsites,
    allFormulas,
    mergedAt: new Date().toISOString(),
  };
}

// ─── Scheduler ───────────────────────────────────────────────────────────────

const watchList = [];
let schedulerRunning = false;

function addToWatchList(url, intervalMinutes = 60, audioEnabled = false) {
  const existing = watchList.find((w) => w.url === url);
  if (existing) {
    existing.intervalMinutes = intervalMinutes;
    existing.audioEnabled = audioEnabled;
    return existing;
  }
  const entry = { url, intervalMinutes, audioEnabled, lastScanned: null, results: [] };
  watchList.push(entry);
  if (!schedulerRunning) startScheduler();
  return entry;
}

function startScheduler() {
  schedulerRunning = true;
  setInterval(async () => {
    const now = Date.now();
    for (const entry of watchList) {
      const due = !entry.lastScanned || now - entry.lastScanned > entry.intervalMinutes * 60 * 1000;
      if (due) {
        entry.lastScanned = now;
        try {
          const result = await analyzeVideo({ url: entry.url, audioEnabled: entry.audioEnabled });
          entry.results.push({ jobId: result.jobId, scannedAt: result.completedAt, intelligence: result.visual });
          if (entry.results.length > 20) entry.results.shift();
        } catch (_) {}
      }
    }
  }, 60 * 1000);
}

function getWatchList() { return watchList; }

// ─── Utilities ───────────────────────────────────────────────────────────────

function saveJob(jobDir, data) {
  fs.writeFileSync(path.join(jobDir, "result.json"), JSON.stringify(data, null, 2));
}

function getJob(jobId) {
  const p = path.join(DATA_DIR, jobId, "result.json");
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function getJobLog(jobId) {
  const p = path.join(DATA_DIR, jobId, "log.json");
  if (!fs.existsSync(p)) return [];
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function listJobs() {
  if (!fs.existsSync(DATA_DIR)) return [];
  return fs
    .readdirSync(DATA_DIR)
    .filter((d) => fs.existsSync(path.join(DATA_DIR, d, "result.json")))
    .map((d) => {
      const r = JSON.parse(fs.readFileSync(path.join(DATA_DIR, d, "result.json"), "utf8"));
      return {
        jobId: r.jobId,
        url: r.url,
        status: r.status,
        creator: r.visual?.creator,
        title: r.visual?.title,
        audioStatus: r.audio?.status,
        completedAt: r.completedAt,
      };
    })
    .sort((a, b) => b.jobId.localeCompare(a.jobId));
}

module.exports = {
  analyzeVideo,
  addToWatchList,
  getWatchList,
  getJob,
  getJobLog,
  listJobs,
};
