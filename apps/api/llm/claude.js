const axios = require("axios");

async function callClaude(systemPrompt, message) {
  const response = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: "claude-3-opus-20240229",
      max_tokens: 1000,
      messages: [
        { role: "user", content: message }
      ],
      system: systemPrompt
    },
    {
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      }
    }
  );

  return response.data.content[0].text;
}

module.exports = { callClaude };
