import fetch from "node-fetch";
import { TELEGRAM_API } from "./config.js";
import { sendMessage } from "./telegramService.js";
import { processMessage } from "../core/messageProcessor.js";

let offset = 0;

async function getUpdates() {
  const url = TELEGRAM_API + "/getUpdates?timeout=100&offset=" + offset;
  const res = await fetch(url);
  const data = await res.json();
  return data.result;
}

async function runBot() {
  console.log("Telegram bot running...");

  while (true) {
    const updates = await getUpdates();

    for (const update of updates) {
      offset = update.update_id + 1;

      if (update.message) {
        const chatId = update.message.chat.id;
        const text = update.message.text;

        const response = await processMessage(text);

        await sendMessage(chatId, response);
      }
    }
  }
}

runBot();
