"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const { generateRunwayVideo } = require("./runway");

const REPO_ROOT = path.join(__dirname, "../../..");
const jobs = new Map();

function projectToSpecPath(project) {
  const m = project.match(/^(.+?)_episode_(\d+)$/);
  if (!m) throw new Error(`Cannot resolve spec for project "${project}". Expected format: name_episode_NNN`);
  const [, name, num] = m;
  return path.join(REPO_ROOT, "content", name, `episode-${num}`, "spec.yaml");
}

function parseSegments(specPath) {
  const raw = fs.readFileSync(specPath, "utf8");
  const segments = [];
  const blocks = raw.split(/^  - id:/m).slice(1);
  for (const block of blocks) {
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

function downloadFile(url, destPath) {
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

function makeJobId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function createJob(project) {
  const jobId = makeJobId();
  const job = {
    id: jobId,
    project,
    status: "pending",
    segments: [],
    log: [],
    listeners: [],
  };
  jobs.set(jobId, job);
  return job;
}

function emit(job, event, data) {
  const entry = { event, data, ts: new Date().toISOString() };
  job.log.push(entry);
  for (const res of job.listeners) {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch (_) {}
  }
}

async function runJob(job, specPath) {
  const outputDir = path.join(path.dirname(specPath), "output");
  fs.mkdirSync(outputDir, { recursive: true });

  let segments;
  try {
    segments = parseSegments(specPath);
  } catch (err) {
    job.status = "failed";
    emit(job, "error", { message: err.message });
    return;
  }

  job.status = "running";
  emit(job, "start", { project: job.project, totalSegments: segments.length });

  const segmentFiles = [];

  for (const seg of segments) {
    emit(job, "segment_start", { id: seg.id, label: seg.label });
    try {
      const result = await generateRunwayVideo({
        prompt: seg.prompt,
        negative_prompt: seg.negative_prompt,
        duration: 10,
        ratio: "720:1280",
        wait: true,
      });

      if (!result.url) throw new Error(`No output URL from Runway for segment ${seg.id}`);

      const outPath = path.join(outputDir, `segment-${seg.id}.mp4`);
      emit(job, "segment_download", { id: seg.id, url: result.url });
      await downloadFile(result.url, outPath);

      segmentFiles.push({ id: seg.id, file: `segment-${seg.id}.mp4`, url: result.url });
      job.segments.push({ id: seg.id, status: "done", file: outPath });
      emit(job, "segment_done", { id: seg.id, file: `segment-${seg.id}.mp4` });
    } catch (err) {
      job.status = "failed";
      emit(job, "error", { message: `Segment ${seg.id} failed: ${err.message}` });
      return;
    }
  }

  const manifest = {
    project: job.project,
    jobId: job.id,
    rendered_at: new Date().toISOString(),
    segments: segmentFiles,
    subtitle_file: "episode-001.srt",
    caption_file: "caption.txt",
    thumbnail_prompt: "thumbnail-prompt.txt",
    assembly_note:
      "Concatenate segments in order. Add voiceover. Burn subtitles for review. " +
      "Extract thumbnail from segment-2 at ~5s.",
    review_gate: "REQUIRED before publish",
    publish: false,
  };
  const manifestPath = path.join(outputDir, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  job.status = "done";
  emit(job, "done", { manifest });

  for (const res of job.listeners) {
    try { res.end(); } catch (_) {}
  }
  job.listeners = [];
}

function startRender(project) {
  const specPath = projectToSpecPath(project);
  if (!fs.existsSync(specPath)) {
    throw new Error(`Spec not found: ${specPath}`);
  }
  const job = createJob(project);
  setImmediate(() => runJob(job, specPath));
  return job.id;
}

function getJob(jobId) {
  return jobs.get(jobId) || null;
}

function subscribeToJob(jobId, res) {
  const job = jobs.get(jobId);
  if (!job) return false;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  for (const entry of job.log) {
    res.write(`event: ${entry.event}\ndata: ${JSON.stringify(entry.data)}\n\n`);
  }

  if (job.status === "done" || job.status === "failed") {
    res.end();
    return true;
  }

  job.listeners.push(res);
  res.on("close", () => {
    job.listeners = job.listeners.filter((r) => r !== res);
  });
  return true;
}

module.exports = { startRender, getJob, subscribeToJob };
