const express = require("express");
const { analyzeVideo, addToWatchList, getWatchList, getJob, listJobs } = require("./intelligence");

const router = express.Router();

// POST /video/intelligence/analyze
// Body: { url, intervalSeconds?, maxFrames? }
router.post("/analyze", async (req, res) => {
  const { url, intervalSeconds = 15, maxFrames = 12 } = req.body;
  if (!url) return res.status(400).json({ error: "url required" });

  // Start async — return jobId immediately
  const jobId = Date.now().toString();
  res.json({ jobId, status: "started", message: "Analysis running in background" });

  // Run analysis (non-blocking response already sent)
  analyzeVideo({ url, intervalSeconds, maxFrames }).catch(() => {});
});

// POST /video/intelligence/analyze/sync
// Waits for completion (use for small/fast videos)
router.post("/analyze/sync", async (req, res) => {
  const { url, intervalSeconds = 10, maxFrames = 6 } = req.body;
  if (!url) return res.status(400).json({ error: "url required" });
  try {
    const result = await analyzeVideo({ url, intervalSeconds, maxFrames });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /video/intelligence/jobs
router.get("/jobs", (req, res) => {
  res.json(listJobs());
});

// GET /video/intelligence/jobs/:jobId
router.get("/jobs/:jobId", (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json(job);
});

// POST /video/intelligence/watch
// Body: { url, intervalMinutes? }
// Adds a URL to the periodic watch list
router.post("/watch", (req, res) => {
  const { url, intervalMinutes = 60 } = req.body;
  if (!url) return res.status(400).json({ error: "url required" });
  const entry = addToWatchList(url, intervalMinutes);
  res.json({ message: "Added to watch list", entry });
});

// GET /video/intelligence/watch
router.get("/watch", (req, res) => {
  res.json(getWatchList());
});

module.exports = router;
