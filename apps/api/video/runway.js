"use strict";

const RUNWAY_BASE = "https://api.runwayml.com/v1";
const RUNWAY_VERSION = "2024-11-06";
const POLL_INTERVAL_MS = 8000;
const POLL_TIMEOUT_MS = 600000;

function getApiKey() {
  const key = process.env.RUNWAY_API_KEY;
  if (!key) throw new Error("RUNWAY_API_KEY not set");
  return key;
}

async function runwayPost(endpoint, body) {
  const response = await fetch(`${RUNWAY_BASE}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${getApiKey()}`,
      "X-Runway-Version": RUNWAY_VERSION,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Runway ${endpoint} error ${response.status}: ${text}`);
  }
  return response.json();
}

async function runwayGet(endpoint) {
  const response = await fetch(`${RUNWAY_BASE}${endpoint}`, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${getApiKey()}`,
      "X-Runway-Version": RUNWAY_VERSION,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Runway GET ${endpoint} error ${response.status}: ${text}`);
  }
  return response.json();
}

async function pollTask(taskId) {
  const start = Date.now();
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    const task = await runwayGet(`/tasks/${taskId}`);
    if (task.status === "SUCCEEDED") return task;
    if (task.status === "FAILED" || task.status === "CANCELLED") {
      throw new Error(`Task ${taskId} ${task.status}: ${task.failure || ""}`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`Task ${taskId} timed out`);
}

/**
 * Generate a video from a text prompt using Runway Gen-3 Alpha Turbo.
 * @param {object} opts
 * @param {string} opts.prompt
 * @param {string} [opts.negative_prompt]
 * @param {number} [opts.duration] - 5 or 10 seconds
 * @param {string} [opts.ratio] - e.g. "720:1280" for 9:16 vertical
 * @param {boolean} [opts.wait] - if true, polls until complete and returns output URL
 */
async function generateRunwayVideo({ prompt, negative_prompt, duration = 10, ratio = "1280:720", wait = false }) {
  const task = await runwayPost("/text_to_video", {
    model: "gen3a_turbo",
    prompt_text: prompt,
    ...(negative_prompt ? { negative_prompt } : {}),
    duration,
    ratio,
  });

  if (!wait) return task;

  const completed = await pollTask(task.id);
  return {
    taskId: task.id,
    status: completed.status,
    url: completed.output?.[0] ?? null,
  };
}

/**
 * Get the status of a previously submitted task.
 */
async function getTaskStatus(taskId) {
  return runwayGet(`/tasks/${taskId}`);
}

module.exports = { generateRunwayVideo, getTaskStatus, pollTask };
