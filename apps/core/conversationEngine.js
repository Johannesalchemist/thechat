import { appendMessage, getHistory } from "../memory/memoryService.js";
import { askLLM }                    from "../llm/llmService.js";
import { analyzeConversation }        from "../resonance/resonanceEngine.js";
import { routeCommand, SYSTEM_PROMPT } from "./phoneAgent.js";
import { getRoomPrompt, getUserRoom, ROOMS } from "../rooms/roomsService.js";

export async function handleMessage(user, text, userName = "") {

  // ── Command routing ───────────────────────────────────────────────────────
  if (text.startsWith("/")) {
    const result = await routeCommand(user, text, userName);
    if (result) return { response: result, resonance: null };
  }

  // ── LLM conversation ──────────────────────────────────────────────────────
  const rawHistory = getHistory(user);

  const messages = rawHistory.map((entry, i) => ({
    role:    i % 2 === 0 ? "user" : "assistant",
    content: entry,
  }));

  messages.push({ role: "user", content: text });

  // Combine Nyxa persona with active room personality
  const roomKey    = getUserRoom(user);
  const roomSuffix = `\n\nActive mode: ${ROOMS[roomKey].label}\n${getRoomPrompt(user)}`;
  const systemPrompt = SYSTEM_PROMPT + roomSuffix;

  const response = await askLLM(messages, systemPrompt);

  appendMessage(user, text);
  appendMessage(user, response);

  const resonance = analyzeConversation(getHistory(user));

  return { response, resonance };
}
