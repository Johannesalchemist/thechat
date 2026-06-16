const express = require("express");
const {
  analyzeVideo,
  addToWatchList,
  getWatchList,
  getJob,
  getJobLog,
  listJobs,
} = require("./intelligence");

const router = express.Router();

// POST /video/intelligence/analyze
// Body: { url, intervalSeconds?, maxFrames?, audioEnabled? }
// Returns jobId immediately; analysis runs in background.
router.post("/analyze", async (req, res) => {
  const { url, intervalSeconds = 15, maxFrames = 12, audioEnabled = false } = req.body;
  if (!url) return res.status(400).json({ error: "url required" });

  const jobId = `${Date.now()}`;
  res.json({ jobId, status: "started", audioEnabled, message: "Analysis running in background" });

  analyzeVideo({ url, intervalSeconds, maxFrames, audioEnabled }).catch(() => {});
});

// POST /video/intelligence/analyze/sync
// Waits for full completion. Suitable for short videos or testing.
router.post("/analyze/sync", async (req, res) => {
  const { url, intervalSeconds = 10, maxFrames = 6, audioEnabled = false } = req.body;
  if (!url) return res.status(400).json({ error: "url required" });
  try {
    const result = await analyzeVideo({ url, intervalSeconds, maxFrames, audioEnabled });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /video/intelligence/jobs
router.get("/jobs", (_req, res) => {
  res.json(listJobs());
});

// GET /video/intelligence/jobs/:jobId
router.get("/jobs/:jobId", (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json(job);
});

// GET /video/intelligence/jobs/:jobId/log
// Returns the step-by-step log for a job.
router.get("/jobs/:jobId/log", (req, res) => {
  const log = getJobLog(req.params.jobId);
  res.json(log);
});

// GET /video/intelligence/jobs/:jobId/visual
// Returns only the visual (Claude Vision) artifact.
router.get("/jobs/:jobId/visual", (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  if (!job.visual) return res.status(404).json({ error: "Visual analysis not yet available" });
  res.json(job.visual);
});

// GET /video/intelligence/jobs/:jobId/audio
// Returns the audio analysis artifact (Whisper transcript analysis).
router.get("/jobs/:jobId/audio", (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  if (!job.audio) return res.status(404).json({ error: "Audio analysis not available" });
  res.json(job.audio);
});

// GET /video/intelligence/jobs/:jobId/merged
// Returns the merged analysis (visual + audio combined).
router.get("/jobs/:jobId/merged", (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  if (!job.merged) return res.status(404).json({ error: "Merged analysis not available — run with audioEnabled: true" });
  res.json(job.merged);
});

// POST /video/intelligence/watch
// Body: { url, intervalMinutes?, audioEnabled? }
router.post("/watch", (req, res) => {
  const { url, intervalMinutes = 60, audioEnabled = false } = req.body;
  if (!url) return res.status(400).json({ error: "url required" });
  const entry = addToWatchList(url, intervalMinutes, audioEnabled);
  res.json({ message: "Added to watch list", entry });
});

// GET /video/intelligence/watch
router.get("/watch", (_req, res) => {
  res.json(getWatchList());
});

module.exports = router;
