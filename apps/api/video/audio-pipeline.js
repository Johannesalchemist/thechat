/**
 * Audio Pipeline — optional companion to Video Intelligence
 *
 * Requirements from environment check (2026-06-06):
 *   - ffmpeg: present but non-functional (libcaca.so.0 missing)
 *   - yt-dlp: functional, downloads native m4a/webm without ffmpeg
 *   - OpenAI Whisper: accepts m4a, webm, mp3, mp4, wav (25 MB limit)
 *   - openai npm package: installed in apps/api
 *
 * This module is self-contained. It never throws — all errors are returned
 * as structured { ok: false, reason: "..." } objects so the caller can log
 * and continue with visual-only analysis.
 */

"use strict";

const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const OpenAI = require("openai");
const Anthropic = require("@anthropic-ai/sdk");

// ─── Credential check ────────────────────────────────────────────────────────
// Returns { ok, reason }. Never prints key values.

function checkAudioCredentials() {
  const key = (process.env.OPENAI_API_KEY || "").trim();
  if (!key) {
    return {
      ok: false,
      reason: "OPENAI_API_KEY not configured — audio track skipped",
    };
  }
  return { ok: true };
}

// ─── Audio download ───────────────────────────────────────────────────────────
// Downloads best available audio stream without ffmpeg conversion.
// Whisper accepts: m4a, webm, mp3, mp4, mpeg, mpga, wav
// yt-dlp format priority: m4a → webm → any bestaudio
// Returns absolute path to downloaded file, or throws on failure.

async function downloadAudio(url, jobDir, log) {
  log("audio:download", "Starting audio download via yt-dlp...");

  const formats = [
    "bestaudio[ext=m4a]",
    "bestaudio[ext=webm]",
    "bestaudio[ext=mp4]",
    "bestaudio",
  ];

  for (const fmt of formats) {
    const outTemplate = path.join(jobDir, "audio.%(ext)s");
    // Remove any previous partial download for this format
    for (const f of fs.readdirSync(jobDir).filter((n) => n.startsWith("audio."))) {
      try { fs.unlinkSync(path.join(jobDir, f)); } catch (_) {}
    }

    try {
      execSync(
        `yt-dlp --no-check-certificate -f "${fmt}" --no-playlist -o "${outTemplate}" "${url}"`,
        { timeout: 120000, encoding: "utf8", stdio: "pipe" }
      );

      const audioFiles = fs.readdirSync(jobDir).filter((n) => n.startsWith("audio."));
      if (audioFiles.length > 0) {
        const audioPath = path.join(jobDir, audioFiles[0]);
        const sizeMB = (fs.statSync(audioPath).size / 1024 / 1024).toFixed(1);
        log("audio:download", `Downloaded: ${audioFiles[0]} (${sizeMB} MB)`);
        return audioPath;
      }
    } catch (e) {
      const msg = (e.stderr || e.message || "").slice(0, 120).replace(/\n/g, " ");
      log("audio:download", `Format "${fmt}" failed: ${msg}`);
    }
  }

  throw new Error("Could not download audio in any supported format");
}

// ─── Transcription ────────────────────────────────────────────────────────────
// Sends audio file to OpenAI Whisper. Returns verbose_json transcript.
// Whisper hard limit: 25 MB.

async function transcribeAudio(audioPath, log) {
  const sizeMB = (fs.statSync(audioPath).size / 1024 / 1024).toFixed(1);
  log("audio:transcribe", `Sending ${path.basename(audioPath)} (${sizeMB} MB) to Whisper...`);

  if (parseFloat(sizeMB) > 24.5) {
    throw new Error(
      `Audio file ${sizeMB} MB exceeds Whisper 25 MB limit — consider a shorter video`
    );
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const transcript = await openai.audio.transcriptions.create({
    file: fs.createReadStream(audioPath),
    model: "whisper-1",
    response_format: "verbose_json",
    timestamp_granularities: ["segment"],
  });

  const segCount = transcript.segments?.length ?? 0;
  const wordCount = (transcript.text || "").split(/\s+/).length;
  log("audio:transcribe", `Transcription done — ${segCount} segments, ~${wordCount} words`);

  return transcript;
}

// ─── Transcript analysis ──────────────────────────────────────────────────────
// Sends transcript text to Claude Haiku for structured extraction.
// If ANTHROPIC_API_KEY is missing, returns raw transcript with empty analysis.

async function analyzeTranscript(transcript, metadata, log) {
  const text = (transcript.text || "").trim();

  if (!text) {
    log("audio:analyze", "Transcript is empty — skipping analysis");
    return { websites: [], formulas: [], keyPoints: [], products: [], contacts: [], spokenText: "" };
  }

  const anthropicKey = (process.env.ANTHROPIC_API_KEY || "").trim();
  if (!anthropicKey) {
    log("audio:analyze", "ANTHROPIC_API_KEY not set — returning raw transcript without analysis");
    return { websites: [], formulas: [], keyPoints: [], products: [], contacts: [], spokenText: text };
  }

  log("audio:analyze", `Analyzing transcript (${text.length} chars) with Claude...`);

  try {
    const anthropic = new Anthropic({ apiKey: anthropicKey });
    const resp = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1500,
      messages: [
        {
          role: "user",
          content: `Analyze this video transcript. Return ONLY valid JSON — no markdown, no explanation:
{
  "websites": ["URLs, domain names, social handles mentioned verbally"],
  "formulas": ["mathematical, financial, or business formulas and methods explained"],
  "keyPoints": ["main claims, offers, instructions, calls to action"],
  "products": ["products, services, tools, software mentioned"],
  "contacts": ["names, emails, phone numbers, social accounts mentioned"]
}

Video: "${(metadata.title || "unknown").replace(/"/g, "'")}" by ${(metadata.creator || "unknown").replace(/"/g, "'")}

Transcript:
${text.slice(0, 4000)}`,
        },
      ],
    });

    const raw = resp.content[0].text;
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("Claude returned no JSON");

    const parsed = JSON.parse(match[0]);
    log("audio:analyze", "Transcript analysis complete");
    return { ...parsed, spokenText: text };
  } catch (e) {
    log("audio:analyze", `Analysis failed (${e.message.slice(0, 80)}) — returning raw transcript`);
    return { websites: [], formulas: [], keyPoints: [], products: [], contacts: [], spokenText: text };
  }
}

// ─── Full audio pipeline (convenience wrapper) ───────────────────────────────
// Returns { status, audioPath, transcript, analysis } or { status:'skipped'|'error', reason }

async function runAudioPipeline(url, jobDir, metadata, log) {
  const credCheck = checkAudioCredentials();
  if (!credCheck.ok) {
    log("audio:skip", credCheck.reason);
    return { status: "skipped", reason: credCheck.reason };
  }

  let audioPath;
  try {
    audioPath = await downloadAudio(url, jobDir, log);
  } catch (e) {
    log("audio:error", `Download failed: ${e.message} — visual analysis preserved`);
    return { status: "error", reason: e.message };
  }

  let transcript;
  try {
    transcript = await transcribeAudio(audioPath, log);
  } catch (e) {
    log("audio:error", `Transcription failed: ${e.message} — visual analysis preserved`);
    return { status: "error", reason: e.message, audioPath };
  }

  const analysis = await analyzeTranscript(transcript, metadata, log);

  return { status: "done", audioPath, transcript, analysis };
}

module.exports = { checkAudioCredentials, downloadAudio, transcribeAudio, analyzeTranscript, runAudioPipeline };
