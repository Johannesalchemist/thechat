const fetch = global.fetch;

async function generateRunwayVideo(prompt) {
  const apiKey = process.env.RUNWAY_API_KEY;
  if (!apiKey) throw new Error("RUNWAY_API_KEY not set");

  const response = await fetch("https://api.runwayml.com/v1/video/generations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": Bearer 
    },
    body: JSON.stringify({
      model: "gen3",
      prompt: prompt,
      duration: 5
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error("Runway error: " + text);
  }

  const data = await response.json();
  return data;
}

module.exports = { generateRunwayVideo };
