import fetch from "node-fetch";
import { ANTHROPIC_KEY } from "../../config/env.js";

const ANTHROPIC_MODEL = "claude-sonnet-4-6";
const ANTHROPIC_URL   = "https://api.anthropic.com/v1/messages";
const OLLAMA_URL      = "http://localhost:11434/api/chat";
const OLLAMA_MODEL    = "qwen2.5:3b";

export async function askLLM(messages, systemPrompt = "") {
  // Try Anthropic first
  if (ANTHROPIC_KEY) {
    try {
      const body = {
        model:      ANTHROPIC_MODEL,
        max_tokens: 1024,
        messages,
      };
      if (systemPrompt) body.system = systemPrompt;
      const res = await fetch(ANTHROPIC_URL, {
        method:  "POST",
        headers: {
          "Content-Type":      "application/json",
          "x-api-key":         ANTHROPIC_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
        timeout: 30000,
      });
      if (res.ok) {
        const data = await res.json();
        return data.content?.[0]?.text || "[no response]";
      }
      const err = await res.json().catch(() => ({}));
      console.warn("[LLM] Anthropic failed:", res.status, err.error?.message || "");
    } catch (e) {
      console.warn("[LLM] Anthropic error:", e.message);
    }
  }

  // Fallback: Ollama
  console.log("[LLM] Falling back to Ollama...");
  try {
    const ollamaMessages = systemPrompt
      ? [{ role: "system", content: systemPrompt }, ...messages]
      : messages;
    const res = await fetch(OLLAMA_URL, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model:    OLLAMA_MODEL,
        messages: ollamaMessages,
        stream:   false,
      }),
      timeout: 120000,
    });
    if (res.ok) {
      const data = await res.json();
      return data.message?.content || "[no response]";
    }
  } catch (e) {
    console.error("[LLM] Ollama error:", e.message);
  }

  return "[Oracle antwortet gleich — einen Moment.]";
}
