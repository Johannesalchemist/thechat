import { createRequire } from "module";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const {
  loadUserMemory,
  saveUserMemory,
  loadAllUserMemory,
  normalizeAccess
} = require("../../memory/user_memory.cjs");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(__dirname, "../../../");
const LEGACY_ACTIVITY_DIR = path.join(ROOT_DIR, "data/telegram_activity");
const EDUGAME_DIR = path.join(ROOT_DIR, "data/edugame");

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function ensureStorage() {
  ensureDir(LEGACY_ACTIVITY_DIR);
  ensureDir(EDUGAME_DIR);
}

function legacyActivityFile(chatId) {
  ensureStorage();
  return path.join(LEGACY_ACTIVITY_DIR, `${String(chatId)}.json`);
}

function writeLegacyActivity(chatId, memory) {
  ensureStorage();
  const payload = {
    lastSeen: Number(memory?.activity?.lastSeen || 0),
    lastPing: Number(memory?.activity?.lastPing || 0),
    lastTier: Number(memory?.activity?.lastTier || 0),
    access: normalizeAccess(memory?.access)
  };
  fs.writeFileSync(legacyActivityFile(chatId), JSON.stringify(payload, null, 2), "utf8");
  return payload;
}

export function readActivity(chatId) {
  const memory = loadUserMemory(chatId);
  return {
    lastSeen: Number(memory?.activity?.lastSeen || 0),
    lastPing: Number(memory?.activity?.lastPing || 0),
    lastTier: Number(memory?.activity?.lastTier || 0),
    access: normalizeAccess(memory?.access)
  };
}

export function writeActivity(chatId, data) {
  const memory = loadUserMemory(chatId);
  const next = {
    ...memory,
    activity: {
      ...memory.activity,
      lastSeen: Number(data?.lastSeen || memory.activity.lastSeen || 0),
      lastPing: Number(data?.lastPing || memory.activity.lastPing || 0),
      lastTier: Number(data?.lastTier || memory.activity.lastTier || 0)
    },
    access: normalizeAccess(data?.access ?? memory.access)
  };
  const saved = saveUserMemory(chatId, next);
  writeLegacyActivity(chatId, saved);
  return {
    lastSeen: saved.activity.lastSeen,
    lastPing: saved.activity.lastPing,
    lastTier: saved.activity.lastTier,
    access: saved.access
  };
}

export function touchTelegramActivity(chatId, options = {}) {
  const memory = loadUserMemory(chatId);
  const next = {
    ...memory,
    activity: {
      ...memory.activity,
      lastSeen: Date.now(),
      lastTier: 0
    },
    access: options?.resetAccess
      ? []
      : normalizeAccess(options?.access ?? memory.access)
  };
  const saved = saveUserMemory(chatId, next);
  writeLegacyActivity(chatId, saved);
  return {
    lastSeen: saved.activity.lastSeen,
    lastPing: saved.activity.lastPing,
    lastTier: saved.activity.lastTier,
    access: saved.access
  };
}

export function setTelegramAccess(chatId, access = []) {
  const memory = loadUserMemory(chatId);
  const next = {
    ...memory,
    access: normalizeAccess(access)
  };
  const saved = saveUserMemory(chatId, next);
  writeLegacyActivity(chatId, saved);
  return {
    lastSeen: saved.activity.lastSeen,
    lastPing: saved.activity.lastPing,
    lastTier: saved.activity.lastTier,
    access: saved.access
  };
}

export function markTelegramPing(chatId, tier) {
  const memory = loadUserMemory(chatId);
  const next = {
    ...memory,
    activity: {
      ...memory.activity,
      lastPing: Date.now(),
      lastTier: Number(tier || 0)
    }
  };
  const saved = saveUserMemory(chatId, next);
  writeLegacyActivity(chatId, saved);
  return {
    lastSeen: saved.activity.lastSeen,
    lastPing: saved.activity.lastPing,
    lastTier: saved.activity.lastTier,
    access: saved.access
  };
}

export function loadActivityUsers() {
  const all = loadAllUserMemory();
  return all.map((memory) => ({
    chatId: String(memory.userId),
    lastSeen: Number(memory?.activity?.lastSeen || 0),
    lastPing: Number(memory?.activity?.lastPing || 0),
    lastTier: Number(memory?.activity?.lastTier || 0),
    access: normalizeAccess(memory?.access)
  }));
}

export function loadEduState(chatId) {
  ensureStorage();
  const file = path.join(EDUGAME_DIR, `${String(chatId)}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export const telegramActivityPaths = {
  root: ROOT_DIR,
  activityDir: LEGACY_ACTIVITY_DIR,
  edugameDir: EDUGAME_DIR,
  userMemoryDir: path.join(ROOT_DIR, "data/user_memory")
};
