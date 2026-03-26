const express = require("express");
const cors = require("cors");

const { routeLLM } = require("./llm/router");
const { routeVideo } = require("./video/router");

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(API läuft auf Port ));
