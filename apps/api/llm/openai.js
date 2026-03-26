const OpenAI = require(" openai\);
let client = null;
function getClient() {
 const key = process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY;
 if (!key) throw new Error(\No LLM API key set\);
 if (!client) {
 client = new OpenAI({
 apiKey: key,
 baseURL: process.env.OPENROUTER_API_KEY ? \https://openrouter.ai/api/v1\ : undefined,
 });
 }
 return client;
}
async function callOpenAI(systemPrompt, message) {
 const openai = getClient();
 const model = process.env.OPENROUTER_API_KEY
 ? \google/gemini-flash-1.5\
 : \gpt-4o-mini\;
 const completion = await openai.chat.completions.create({
 model,
 messages: [
 { role: \system\, content: systemPrompt },
 { role: \user\, content: message }
 ],
 });
 return completion.choices[0].message.content;
}
module.exports = { callOpenAI };
