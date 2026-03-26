const { callOpenAI } = require("./openai");
const { callClaude } = require("./claude");

async function routeLLM(provider, systemPrompt, message) {
  if (provider === "claude") {
    return await callClaude(systemPrompt, message);
  }

  return await callOpenAI(systemPrompt, message);
}

module.exports = { routeLLM };
