import fetch from "node-fetch";
import { TELEGRAM_TOKEN } from "../../config/env.js";
import { handleMessage }  from "../core/conversationEngine.js";
import { touchTelegramActivity } from "../../modules/telegram-agent/router/router.js";
import { handleResumeEntry } from "../core/phoneAgent.js";

const API = "https://api.telegram.org/bot" + TELEGRAM_TOKEN;
const BOT_RUNTIME_ID = process.env.BOT_RUNTIME_ID || `nyxa-bot-${process.pid}-${Date.now()}`;
const DEFAULT_REPLY_KEYBOARD = {
  keyboard: [[{ text: "Start" }]],
  resize_keyboard: true,
  one_time_keyboard: false
};

let offset = 0;

function isResumeEntry(text) {
  const normalized = String(text || "").trim().toLowerCase();
  return normalized.startsWith("/start resume_");
}

function extractResumeKey(text) {
  return String(text || "")
    .trim()
    .replace(/^\/start\s+resume_/i, "")
    .trim()
    .toLowerCase();
}

async function send(chatId, text, options = {}) {
  const replyMarkup = options.reply_markup || DEFAULT_REPLY_KEYBOARD;
  const outgoingText = String(text || "").trim();
  const safeText = outgoingText || "Nyxa is online. Send /start to begin.";
  if (!outgoingText) {
    console.error(`[PHONE-AGENT] Empty response text for ${chatId}; sending safe fallback text`);
  }

  const payload = {
    chat_id:    chatId,
    text: safeText,
    parse_mode: "Markdown",
    reply_markup: replyMarkup
  };
  console.log(`[BOT SEND] chat=${chatId} text="${safeText.slice(0, 120)}"`);

  const res = await fetch(API + "/sendMessage", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!data.ok) {
    console.error(`[PHONE-AGENT] Reply failed to ${chatId}: ${data.description || "unknown Telegram error"}`);
    // Retry without Markdown if Telegram entity parsing failed.
    const retryPayload = { ...payload };
    delete retryPayload.parse_mode;
    const retryRes = await fetch(API + "/sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(retryPayload)
    });
    const retryData = await retryRes.json();
    if (!retryData.ok) {
      console.error(`[PHONE-AGENT] Retry failed to ${chatId}: ${retryData.description || "unknown Telegram error"}`);
      return;
    }
    console.log(`[PHONE-AGENT] Reply sent to ${chatId} (retry/plain)`);
    return;
  }
  console.log(`[PHONE-AGENT] Reply sent to ${chatId}`);
}

async function answerCallback(callbackId) {
  try {
    await fetch(API + "/answerCallbackQuery", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackId })
    });
  } catch (e) {
    console.error("[PHONE-AGENT] answerCallbackQuery failed:", e.message);
  }
}

async function getUpdates() {
  const res  = await fetch(`${API}/getUpdates?timeout=30&offset=${offset}`, { timeout: 35000 });
  const data = await res.json();
  if (!data.ok) return [];
  return data.result;
}

async function run() {
  console.log(`[PHONE-AGENT] BOT INSTANCE STARTED runtime_id=${BOT_RUNTIME_ID} pid=${process.pid} entrypoint=apps/telegram/bot.js`);
  console.log("[PHONE-AGENT] TELEGRAM_TOKEN loaded:", TELEGRAM_TOKEN ? "yes" : "no");
  if (!TELEGRAM_TOKEN || TELEGRAM_TOKEN === "PUT_YOUR_TOKEN_HERE") {
    console.error("[PHONE-AGENT] TELEGRAM_TOKEN not set — bot cannot start");
    process.exit(1);
  }

  try {
    const meRes = await fetch(`${API}/getMe`);
    const me = await meRes.json();
    if (me.ok) {
      console.log(`[PHONE-AGENT] Connected bot username: @${me.result?.username || "unknown"}`);
    } else {
      console.error(`[PHONE-AGENT] getMe failed: ${me.description || "unknown error"}`);
    }
  } catch (e) {
    console.error("[PHONE-AGENT] getMe error:", e.message);
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

      let chatId = null;
      let text = null;
      let userName = "";

      if (u.callback_query) {
        const callbackData = String(u.callback_query.data || "").trim();
        chatId = u.callback_query.message?.chat?.id ?? null;
        userName = u.callback_query.from?.first_name || "";
        text = callbackData;
        console.log(`[PHONE-AGENT] Callback received from ${userName} (${chatId}): ${callbackData}`);
        await answerCallback(u.callback_query.id);
      } else if (u.message?.text) {
        chatId = u.message.chat.id;
        text = u.message.text;
        userName = u.message.from?.first_name || "";
        console.log(`[PHONE-AGENT] Update received from ${userName} (${chatId}): ${text}`);
      }

      if (!chatId || !text) {
        continue;
      }

      const normalizedText = String(text).trim();
      console.log(`[PHONE-AGENT] normalized_input chat=${chatId} value="${normalizedText}" source=${u.callback_query ? "callback_query" : "message"}`);

      try {
        try {
          const activity = touchTelegramActivity(chatId);
          console.log(`[RETURN-SYSTEM] activity_touch chat=${chatId} lastSeen=${activity.lastSeen} lastTier=${activity.lastTier}`);
        } catch (activityError) {
          console.error(`[RETURN-SYSTEM] activity_touch_failed chat=${chatId}: ${activityError.message}`);
        }

        if (isResumeEntry(normalizedText)) {
          const key = extractResumeKey(normalizedText);
          console.log(`[RESUME ENTRY] chat=${chatId} key=${key}`);
          try {
            const reply = await handleResumeEntry({ chatId, key, userName });
            const replyText = String(reply || "").trim();
            if (!replyText) {
              console.warn(`[RESUME EMPTY REPLY] chat=${chatId} key=${key}`);
              await send(
                chatId,
                "Ich habe deinen Wiedereinstieg erkannt, aber der nächste Schritt ist gerade nicht verfügbar. Ich starte mit dir neu."
              );
              continue;
            }
            await send(chatId, replyText);
            continue;
          } catch (resumeErr) {
            console.error(`[RESUME ERROR] chat=${chatId} key=${key}: ${resumeErr.message}`);
            await send(
              chatId,
              "Dein Wiedereinstieg wurde erkannt, aber ist gerade nicht sauber durchgelaufen. Versuch es bitte noch einmal."
            );
            continue;
          }
        }

        const result = await handleMessage(chatId, normalizedText, userName);
        const responseText = String(result?.response || "").trim();
        if (!responseText) {
          console.error(`[PHONE-AGENT] Empty handler response for chat ${chatId}; injecting fallback text`);
        }
        await send(chatId, responseText || "Nyxa is online. Send /start to begin.");

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
