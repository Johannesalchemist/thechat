const express = require("express");
const cors = require("cors");

const { routeLLM } = require("./llm/router");
const { routeVideo } = require("./video/router");
const { startRender, getJob, subscribeToJob } = require("./video/render-job");

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.post("/ai/:room", async (req, res) => {
  try {
    const { room } = req.params;
    const { message, provider = "openai" } = req.body;

    const result = await routeLLM(room, message, provider);
    res.json(result);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "LLM call failed" });
  }
});

app.post("/video/generate", async (req, res) => {
  try {
    const { prompt, provider = "runway" } = req.body;

    const result = await routeVideo(provider, prompt);
    res.json(result);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Video generation failed" });
  }
});

// POST /video/render — start a render job, returns { jobId }
app.post("/video/render", (req, res) => {
  const { project } = req.body;
  if (!project) return res.status(400).json({ error: "project is required" });
  try {
    const jobId = startRender(project);
    res.json({ jobId, stream: `/video/render/${jobId}/stream` });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /video/render/:jobId — poll job status
app.get("/video/render/:jobId", (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json({
    jobId: job.id,
    project: job.project,
    status: job.status,
    segments: job.segments,
    log: job.log,
  });
});

// GET /video/render/:jobId/stream — SSE stream of render progress
app.get("/video/render/:jobId/stream", (req, res) => {
  const found = subscribeToJob(req.params.jobId, res);
  if (!found) res.status(404).json({ error: "Job not found" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API läuft auf Port ${PORT}`));
