/**
 * Video Intelligence Component
 * Extracts: text, creator, content, websites, formulas from video URLs
 * Supports: YouTube, Facebook, TikTok, Instagram, direct URLs
 */

const { execSync, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const https = require("https");
const http = require("http");
const Anthropic = require("@anthropic-ai/sdk");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const DATA_DIR = path.join(__dirname, "../../../data/video-intelligence/jobs");

// ─── Main Entry Point ────────────────────────────────────────────────────────

async function analyzeVideo({ url, intervalSeconds = 15, maxFrames = 12 }) {
  const jobId = `${Date.now()}`;
  const jobDir = path.join(DATA_DIR, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  const result = {
    jobId,
    url,
    startedAt: new Date().toISOString(),
    status: "running",
    metadata: {},
    frames: [],
    intelligence: {},
  };

  saveJob(jobDir, result);

  try {
    // 1. Metadata + thumbnails via yt-dlp
    result.metadata = await getVideoMetadata(url, jobDir);

    // 2. Download thumbnail frames for Vision analysis
    result.frames = await downloadThumbnails(result.metadata.thumbnails, jobDir);

    // 3. Playwright frame capture for richer frame coverage
    const playwrightFrames = await capturePlaywrightFrames(
      url,
      jobDir,
      intervalSeconds,
      maxFrames
    );
    result.frames = [...result.frames, ...playwrightFrames];

    // 4. Claude Vision analysis on all frames
    result.intelligence = await extractIntelligence(
      result.frames,
      result.metadata
    );

    result.status = "done";
    result.completedAt = new Date().toISOString();
  } catch (err) {
    result.status = "error";
    result.error = err.message;
  }

  saveJob(jobDir, result);
  return result;
}

// ─── Step 1: yt-dlp Metadata ────────────────────────────────────────────────

async function getVideoMetadata(url, jobDir) {
  try {
    const raw = execSync(
      `yt-dlp --no-check-certificate --dump-json --no-download --no-playlist "${url}"`,
      { timeout: 30000, encoding: "utf8" }
    );
    const info = JSON.parse(raw);

    // Collect thumbnail URLs (prefer storyboards for frame coverage)
    const thumbnails = (info.thumbnails || [])
      .filter((t) => t.url)
      .sort((a, b) => (b.width || 0) - (a.width || 0))
      .slice(0, 6)
      .map((t) => t.url);

    // Main thumbnail
    if (info.thumbnail && !thumbnails.includes(info.thumbnail)) {
      thumbnails.unshift(info.thumbnail);
    }

    return {
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
      rawPath: path.join(jobDir, "metadata.json"),
    };
  } catch (err) {
    // Not a supported platform — return minimal
    return {
      title: null,
      creator: null,
      description: "",
      thumbnails: [],
      error: err.message,
    };
  }
}

// ─── Step 2: Download Thumbnails ─────────────────────────────────────────────

async function downloadThumbnails(urls, jobDir) {
  const frames = [];
  for (let i = 0; i < urls.length; i++) {
    const ext = urls[i].includes(".webp") ? "webp" : "jpg";
    const dest = path.join(jobDir, `thumb_${i}.${ext}`);
    try {
      await downloadFile(urls[i], dest);
      if (fs.existsSync(dest) && fs.statSync(dest).size > 1000) {
        frames.push({ path: dest, source: "thumbnail", url: urls[i] });
      }
    } catch (_) {}
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

async function capturePlaywrightFrames(url, jobDir, intervalSeconds, maxFrames) {
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
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
    });
    const page = await ctx.newPage();

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(3000);

    // Try to accept cookie banners
    for (const sel of [
      "[aria-label*='Accept']",
      "[aria-label*='accept']",
      "button:has-text('Accept all')",
      "button:has-text('Accept')",
      "#accept-button",
    ]) {
      try {
        await page.click(sel, { timeout: 1000 });
        await page.waitForTimeout(500);
        break;
      } catch (_) {}
    }

    // Try to start video playback
    for (const sel of [
      "video",
      ".ytp-play-button",
      "[data-testid='play-button']",
      "[aria-label='Play']",
    ]) {
      try {
        await page.click(sel, { timeout: 1500 });
        await page.waitForTimeout(1000);
        break;
      } catch (_) {}
    }

    // Capture screenshots at intervals
    for (let i = 0; i < maxFrames; i++) {
      const framePath = path.join(
        jobDir,
        `frame_${String(i).padStart(3, "0")}.jpg`
      );
      await page.screenshot({
        path: framePath,
        type: "jpeg",
        quality: 82,
        fullPage: false,
      });
      if (fs.existsSync(framePath) && fs.statSync(framePath).size > 5000) {
        frames.push({ path: framePath, source: "playwright", index: i });
      }

      if (i < maxFrames - 1) {
        // Advance video in browser
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
    // playwright not installed or page failed — skip silently
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
  return frames;
}

// ─── Step 4: Claude Vision Intelligence Extraction ───────────────────────────

async function extractIntelligence(frames, metadata) {
  const text = new Set();
  const websites = new Set();
  const formulas = new Set();
  const frameDescriptions = [];

  // Analyze frames in batches of 4
  const imagePaths = frames
    .filter((f) => f.path && fs.existsSync(f.path))
    .map((f) => f.path);

  for (let i = 0; i < imagePaths.length; i += 4) {
    const batch = imagePaths.slice(i, i + 4);
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
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        (parsed.text || []).forEach((t) => text.add(t));
        (parsed.websites || []).forEach((w) => websites.add(w));
        (parsed.formulas || []).forEach((f) => formulas.add(f));
        (parsed.frame_descriptions || []).forEach((d) =>
          frameDescriptions.push(d)
        );
      }
    } catch (_) {}
  }

  // Also extract from description text via Claude
  if (metadata.description && metadata.description.length > 100) {
    const descIntel = await extractFromDescription(metadata.description);
    descIntel.websites.forEach((w) => websites.add(w));
    descIntel.formulas.forEach((f) => formulas.add(f));
    descIntel.text.forEach((t) => text.add(t));
  }

  // Build lead profile
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
      messages: [
        {
          role: "user",
          content: `Extract from this video description. Return ONLY JSON:
{
  "websites": ["all URLs, domains, links"],
  "formulas": ["any formulas, equations, pricing formulas"],
  "text": ["key phrases, offers, calls to action, contact info"]
}

Description:
${description}`,
        },
      ],
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

  // Simple lead scoring
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

// ─── Scheduler (for periodic scanning) ──────────────────────────────────────

const watchList = [];
let schedulerRunning = false;

function addToWatchList(url, intervalMinutes = 60) {
  const existing = watchList.find((w) => w.url === url);
  if (existing) {
    existing.intervalMinutes = intervalMinutes;
    return existing;
  }
  const entry = {
    url,
    intervalMinutes,
    lastScanned: null,
    results: [],
  };
  watchList.push(entry);
  if (!schedulerRunning) startScheduler();
  return entry;
}

function startScheduler() {
  schedulerRunning = true;
  setInterval(async () => {
    const now = Date.now();
    for (const entry of watchList) {
      const due =
        !entry.lastScanned ||
        now - entry.lastScanned > entry.intervalMinutes * 60 * 1000;
      if (due) {
        entry.lastScanned = now;
        try {
          const result = await analyzeVideo({ url: entry.url });
          entry.results.push({
            jobId: result.jobId,
            scannedAt: result.completedAt,
            intelligence: result.intelligence,
          });
          // Keep last 20 results
          if (entry.results.length > 20) entry.results.shift();
        } catch (_) {}
      }
    }
  }, 60 * 1000); // Check every minute
}

function getWatchList() {
  return watchList;
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function saveJob(jobDir, data) {
  fs.writeFileSync(path.join(jobDir, "result.json"), JSON.stringify(data, null, 2));
}

function getJob(jobId) {
  const resultPath = path.join(DATA_DIR, jobId, "result.json");
  if (!fs.existsSync(resultPath)) return null;
  return JSON.parse(fs.readFileSync(resultPath, "utf8"));
}

function listJobs() {
  if (!fs.existsSync(DATA_DIR)) return [];
  return fs
    .readdirSync(DATA_DIR)
    .filter((d) => fs.existsSync(path.join(DATA_DIR, d, "result.json")))
    .map((d) => {
      const r = JSON.parse(
        fs.readFileSync(path.join(DATA_DIR, d, "result.json"), "utf8")
      );
      return {
        jobId: r.jobId,
        url: r.url,
        status: r.status,
        creator: r.intelligence?.creator,
        title: r.intelligence?.title,
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
  listJobs,
};
