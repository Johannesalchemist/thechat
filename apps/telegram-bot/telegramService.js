import fetch from "node-fetch";
import { TELEGRAM_API } from "./config.js";

export async function sendMessage(chatId, text) {
  const url = TELEGRAM_API + "/sendMessage";

  const body = {
    chat_id: chatId,
    text: text,
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  return res.json();
}
