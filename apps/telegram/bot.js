import fetch from "node-fetch";
import { TELEGRAM_TOKEN } from "../../config/env.js";
import { handleMessage }  from "../core/conversationEngine.js";

const API = "https://api.telegram.org/bot" + TELEGRAM_TOKEN;

let offset = 0;

async function send(chatId, text) {
  await fetch(API + "/sendMessage", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id:    chatId,
      text,
      parse_mode: "Markdown",
    }),
  });
}

async function getUpdates() {
  const res  = await fetch(`${API}/getUpdates?timeout=30&offset=${offset}`, { timeout: 35000 });
  const data = await res.json();
  if (!data.ok) return [];
  return data.result;
}

async function run() {
  if (!TELEGRAM_TOKEN || TELEGRAM_TOKEN === "PUT_YOUR_TOKEN_HERE") {
    console.error("[PHONE-AGENT] TELEGRAM_TOKEN not set — bot cannot start");
    process.exit(1);
  }

  console.log("[PHONE-AGENT] Nyxa Phone Agent running...");

  while (true) {
    let updates;
    try {
      updates = await getUpdates();
    } catch (e) {
      console.error("[PHONE-AGENT] Poll error:", e.message);
      await sleep(5000);
      continue;
    }

    for (const u of updates) {
      offset = u.update_id + 1;

      if (!u.message?.text) continue;

      const chatId   = u.message.chat.id;
      const text     = u.message.text;
      const userName = u.message.from?.first_name || "";

      console.log(`[PHONE-AGENT] ${userName} (${chatId}): ${text}`);

      try {
        const result = await handleMessage(chatId, text, userName);

        await send(chatId, result.response);

        if (result.resonance) {
          await sleep(800);
          await send(chatId, `_${result.resonance}_`);
        }
      } catch (e) {
        console.error("[PHONE-AGENT] Handler error:", e.message);
        await send(chatId, "Something went wrong. Please try again.");
      }
    }
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

run();
