const { generateRunwayVideo } = require("./runway");

async function routeVideo(provider, prompt) {
  if (provider === "runway") {
    return await generateRunwayVideo(prompt);
  }

  // Platzhalter für zukünftige Fallbacks
  if (provider === "pika") {
    throw new Error("Pika not implemented yet");
  }

  if (provider === "kaiber") {
    throw new Error("Kaiber not implemented yet");
  }

  throw new Error("Unknown video provider");
}

module.exports = { routeVideo };
