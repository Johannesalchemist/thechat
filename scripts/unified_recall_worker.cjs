#!/usr/bin/env node
const path = require('path');
require('dotenv').config();

const {
  loadAllUserMemory,
  loadUserMemory,
  saveUserMemory,
  syncMemoryFromSources,
  getTier,
  shouldPing,
  resolveRecallDomain,
  buildResumeKey,
  buildNextAction,
  buildRecallMessage,
  normalizeAccess
} = require('../modules/memory/user_memory.cjs');

const fetchFn = global.fetch || require('node-fetch');

function buildKeyboard(botName, domain, resumeKey) {
  const safeBot = String(botName || '').replace(/^@/, '').trim();
  if (!safeBot) return null;

  let key = 'start';
  if (domain === 'edugame') {
    key = resumeKey;
  } else if (domain === 'sapio_conversation' || domain === 'sapio_profile') {
    key = 'active';
  } else if (domain === 'client_care') {
    key = 'start';
  }

  return {
    inline_keyboard: [[
      {
        text: 'Weitergehen',
        url: `https://t.me/${safeBot}?start=resume_${encodeURIComponent(String(key || 'start'))}`
      }
    ]]
  };
}

function withNextAction(message, nextAction) {
  const next = String(nextAction || '').trim();
  if (!next) return message;
  return `${message}\n\nNächster Schritt: ${next}`;
}

async function getBotIdentity(apiBase) {
  const res = await fetchFn(`${apiBase}/getMe`, { method: 'GET' });
  const data = await res.json();
  if (!data.ok || !data.result?.username) {
    throw new Error(data.description || 'getMe failed');
  }
  return {
    username: String(data.result.username),
    id: data.result.id
  };
}

async function sendRecall(apiBase, userId, text, keyboard) {
  const payload = {
    chat_id: String(userId),
    text: String(text || '').trim(),
    reply_markup: keyboard || undefined
  };
  const res = await fetchFn(`${apiBase}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (!data.ok) {
    throw new Error(data.description || 'sendMessage failed');
  }
  return data;
}

async function run() {
  const token = String(process.env.TELEGRAM_TOKEN || '').trim();
  if (!token) {
    console.error('[UNIFIED-RECALL] TELEGRAM_TOKEN missing');
    process.exitCode = 1;
    return;
  }

  const apiBase = `https://api.telegram.org/bot${token}`;
  const bot = await getBotIdentity(apiBase);
  console.log(`[UNIFIED-RECALL] bot=@${bot.username} id=${bot.id}`);

  const users = loadAllUserMemory();
  console.log(`[UNIFIED-RECALL] users_loaded=${users.length}`);

  for (const mem of users) {
    const userId = String(mem.userId || '').trim();
    if (!userId) {
      console.error('[UNIFIED-RECALL] skip: missing userId');
      continue;
    }

    // Always refresh memory from existing systems before deciding.
    let memory = syncMemoryFromSources(userId, mem);

    const tier = getTier(memory?.activity?.lastSeen || 0);
    if (!shouldPing(memory, tier)) {
      console.log(`[UNIFIED-RECALL] skip user=${userId} tier=${tier} lastTier=${memory?.activity?.lastTier || 0}`);
      saveUserMemory(userId, memory);
      continue;
    }

    const domain = resolveRecallDomain(memory);
    const resumeKey = buildResumeKey(memory);
    const nextAction = buildNextAction(memory, domain);
    const message = withNextAction(buildRecallMessage(memory, domain, tier), nextAction);

    const keyboard = buildKeyboard(bot.username, domain, resumeKey);

    try {
      await sendRecall(apiBase, userId, message, keyboard);

      memory.activity.lastPing = Date.now();
      memory.activity.lastTier = tier;

      if (domain === 'client_care') {
        memory.clientCare.careTier = tier;
      }
      if (domain === 'sapio_conversation' || domain === 'sapio_profile') {
        memory.sapio.sapioTier = tier;
      }

      memory.access = normalizeAccess(memory.access);
      saveUserMemory(userId, memory);
      console.log(`[UNIFIED-RECALL] sent user=${userId} domain=${domain} tier=${tier} resume=${resumeKey}`);
    } catch (error) {
      console.error(`[UNIFIED-RECALL] send_failed user=${userId} domain=${domain} tier=${tier}: ${error.message}`);
      // Persist synced state even on send failure, but keep lastTier unchanged to retry deterministically.
      saveUserMemory(userId, memory);
    }
  }
}

run().catch((error) => {
  console.error(`[UNIFIED-RECALL] fatal: ${error.message}`);
  process.exitCode = 1;
});
