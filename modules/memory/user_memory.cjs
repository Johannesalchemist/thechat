const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.join(__dirname, '../../');
const USER_MEMORY_DIR = path.join(ROOT_DIR, 'data/user_memory');
const TELEGRAM_ACTIVITY_DIR = path.join(ROOT_DIR, 'data/telegram_activity');
const LAUNCH_LOOP_STATE_FILE = path.join(ROOT_DIR, 'data/launch-loop/state.json');
const EDUGAME_EVENTS_DIR = path.join(ROOT_DIR, 'data/edugame/events');
const SAPIO_MATCH_FILE = path.join(ROOT_DIR, 'data/sapio/matches.json');
const SAPIO_ROOMS_FILE = path.join(ROOT_DIR, 'data/sapio/rooms.json');

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function ensureStorage() {
  ensureDir(USER_MEMORY_DIR);
}

function nowTs() {
  return Date.now();
}

function safeReadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function normalizeAccess(access) {
  if (!Array.isArray(access)) return [];
  return Array.from(new Set(access.map((v) => String(v || '').trim().toLowerCase()).filter(Boolean)));
}

function createDefaultMemory(userId) {
  const ts = nowTs();
  return {
    userId: String(userId),
    activity: {
      lastSeen: 0,
      lastPing: 0,
      lastTier: 0
    },
    progression: {
      currentNode: '',
      lastChoice: ''
    },
    sapio: {
      profileState: 'draft',
      connectionState: 'none',
      lastSapioAction: 0,
      sapioTier: 0
    },
    clientCare: {
      clientType: '',
      clientStage: '',
      projectState: '',
      lastClientAction: 0,
      careTier: 0,
      nextAction: ''
    },
    access: [],
    meta: {
      createdAt: ts,
      updatedAt: ts
    }
  };
}

function normalizeMemory(userId, raw) {
  const base = createDefaultMemory(userId);
  const memory = raw && typeof raw === 'object' ? raw : {};
  return {
    userId: String(memory.userId || userId),
    activity: {
      lastSeen: Number(memory?.activity?.lastSeen || 0),
      lastPing: Number(memory?.activity?.lastPing || 0),
      lastTier: Number(memory?.activity?.lastTier || 0)
    },
    progression: {
      currentNode: String(memory?.progression?.currentNode || ''),
      lastChoice: String(memory?.progression?.lastChoice || '')
    },
    sapio: {
      profileState: String(memory?.sapio?.profileState || base.sapio.profileState),
      connectionState: String(memory?.sapio?.connectionState || base.sapio.connectionState),
      lastSapioAction: Number(memory?.sapio?.lastSapioAction || 0),
      sapioTier: Number(memory?.sapio?.sapioTier || 0)
    },
    clientCare: {
      clientType: String(memory?.clientCare?.clientType || ''),
      clientStage: String(memory?.clientCare?.clientStage || ''),
      projectState: String(memory?.clientCare?.projectState || ''),
      lastClientAction: Number(memory?.clientCare?.lastClientAction || 0),
      careTier: Number(memory?.clientCare?.careTier || 0),
      nextAction: String(memory?.clientCare?.nextAction || '')
    },
    access: normalizeAccess(memory?.access),
    meta: {
      createdAt: Number(memory?.meta?.createdAt || base.meta.createdAt),
      updatedAt: Number(memory?.meta?.updatedAt || base.meta.updatedAt)
    }
  };
}

function userMemoryFile(userId) {
  ensureStorage();
  return path.join(USER_MEMORY_DIR, `${String(userId)}.json`);
}

function migrateLegacyActivity(userId, memory) {
  const file = path.join(TELEGRAM_ACTIVITY_DIR, `${String(userId)}.json`);
  const legacy = safeReadJson(file, null);
  if (!legacy || typeof legacy !== 'object') return memory;

  const merged = {
    ...memory,
    activity: {
      lastSeen: Number(legacy.lastSeen || memory.activity.lastSeen || 0),
      lastPing: Number(legacy.lastPing || memory.activity.lastPing || 0),
      lastTier: Number(legacy.lastTier || memory.activity.lastTier || 0)
    },
    access: normalizeAccess(legacy.access || memory.access)
  };

  return merged;
}

function extractLastChoiceFromEvents(userId) {
  const eventFile = path.join(EDUGAME_EVENTS_DIR, `${String(userId)}.jsonl`);
  if (!fs.existsSync(eventFile)) return '';
  const lines = fs.readFileSync(eventFile, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const row = safeReadJsonFromLine(lines[i]);
    if (!row) continue;
    const choice = String(row.choice || '').trim().toLowerCase();
    if (!choice) continue;
    return choice;
  }
  return '';
}

function safeReadJsonFromLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function syncProgressionFromLaunch(userId, memory) {
  const allState = safeReadJson(LAUNCH_LOOP_STATE_FILE, {});
  const state = allState && typeof allState === 'object' ? allState[String(userId)] : null;
  if (!state || typeof state !== 'object') return memory;

  const stage = String(state.stage || '').toLowerCase();
  const node = String(state.last_node || '').toLowerCase();
  const lastChoice = extractLastChoiceFromEvents(userId);

  const next = { ...memory };
  if (stage === 'edugame_entry' || node === 'choose_direction') {
    next.progression.currentNode = 'q1';
  } else if (stage === 'artifact_selected' && node.startsWith('path_')) {
    if (node.includes('_2') || node.includes('reflect')) {
      next.progression.currentNode = 'q3';
    } else {
      next.progression.currentNode = 'q2';
    }
  } else if (stage === 'sync_ready' || node === 'sync_token_loaded') {
    next.progression.currentNode = 'awaiting_gmail';
  } else if (stage === 'active') {
    next.progression.currentNode = 'active';
  }

  if (lastChoice) {
    next.progression.lastChoice = lastChoice;
  }

  return next;
}

function syncSapioFromData(userId, memory) {
  const uid = String(userId);
  const matches = safeReadJson(SAPIO_MATCH_FILE, {});
  const rooms = safeReadJson(SAPIO_ROOMS_FILE, {});
  const match = matches && typeof matches === 'object' ? matches[uid] : null;

  const next = { ...memory };
  if (match) {
    next.sapio.profileState = 'active';
    const updated = Date.parse(String(match.updated_at || match.created_at || ''));
    next.sapio.lastSapioAction = Number.isFinite(updated) ? updated : next.sapio.lastSapioAction;
  }

  let latestRoomMessageTs = 0;
  let hasRoom = false;
  Object.values(rooms || {}).forEach((room) => {
    if (!room || !Array.isArray(room.participants)) return;
    if (!room.participants.map((p) => String(p)).includes(uid)) return;
    hasRoom = true;
    const updated = Date.parse(String(room.updated_at || ''));
    if (Number.isFinite(updated) && updated > latestRoomMessageTs) latestRoomMessageTs = updated;
  });

  if (hasRoom) {
    const idleMs = latestRoomMessageTs > 0 ? (nowTs() - latestRoomMessageTs) : 0;
    if (idleMs > (24 * 60 * 60 * 1000)) {
      next.sapio.connectionState = 'conversation_dormant';
    } else {
      next.sapio.connectionState = 'active';
    }
    if (latestRoomMessageTs > 0) {
      next.sapio.lastSapioAction = latestRoomMessageTs;
    }
  }

  return next;
}

function loadUserMemory(userId) {
  ensureStorage();
  const file = userMemoryFile(userId);
  const raw = safeReadJson(file, null);
  let memory = normalizeMemory(userId, raw);

  if (!raw) {
    memory = migrateLegacyActivity(userId, memory);
    memory = syncProgressionFromLaunch(userId, memory);
    memory = syncSapioFromData(userId, memory);
    memory.meta.updatedAt = nowTs();
    saveUserMemory(userId, memory);
    return memory;
  }

  return memory;
}

function saveUserMemory(userId, data) {
  ensureStorage();
  const file = userMemoryFile(userId);
  const normalized = normalizeMemory(userId, data);
  normalized.meta.updatedAt = nowTs();
  if (!normalized.meta.createdAt) normalized.meta.createdAt = nowTs();
  fs.writeFileSync(file, JSON.stringify(normalized, null, 2), 'utf8');
  return normalized;
}

function listUserMemoryIds() {
  ensureStorage();
  return fs.readdirSync(USER_MEMORY_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.basename(name, '.json'));
}

function loadAllUserMemory() {
  return listUserMemoryIds().map((userId) => loadUserMemory(userId));
}

function upsertUserMemory(userId, patchFn) {
  const current = loadUserMemory(userId);
  const next = typeof patchFn === 'function' ? patchFn(current) : current;
  return saveUserMemory(userId, next);
}

function getTier(lastSeen) {
  const seen = Number(lastSeen || 0);
  const idleMs = Math.max(0, nowTs() - seen);
  const h = 60 * 60 * 1000;

  if (idleMs > 7 * 24 * h) return 4;
  if (idleMs > 72 * h) return 3;
  if (idleMs > 24 * h) return 2;
  if (idleMs > 6 * h) return 1;
  return 0;
}

function shouldPing(memory, tier) {
  if (tier <= 0) return false;
  return tier > Number(memory?.activity?.lastTier || 0);
}

function resolveRecallDomain(memory) {
  const clientStage = String(memory?.clientCare?.clientStage || '').toLowerCase();
  const pendingClientStages = new Set([
    'waiting_for_feedback',
    'waiting_for_assets',
    'proposal_sent',
    'seo_checkin_due'
  ]);
  if (pendingClientStages.has(clientStage)) {
    return 'client_care';
  }

  if (String(memory?.sapio?.connectionState || '').toLowerCase() === 'conversation_dormant') {
    return 'sapio_conversation';
  }

  const profileState = String(memory?.sapio?.profileState || '').toLowerCase();
  if (profileState === 'draft' || profileState === 'stale') {
    return 'sapio_profile';
  }

  if (String(memory?.progression?.currentNode || '').trim()) {
    return 'edugame';
  }

  return 'generic';
}

function buildResumeKey(memory) {
  const node = String(memory?.progression?.currentNode || '').toLowerCase();
  if (['q1', 'q2', 'q3', 'awaiting_gmail', 'active'].includes(node)) return node;
  return 'start';
}

function applyTierTone(base, tier) {
  const tone = {
    1: 'Sanft erinnern, ohne Druck.',
    2: 'Nimm den Faden wieder auf.',
    3: 'Jetzt ist ein guter Moment für eine klare Entscheidung.',
    4: 'Letzter deutlicher Impuls: setze den nächsten Schritt.'
  };
  const suffix = tone[tier] || '';
  return suffix ? `${base}\n\n${suffix}` : base;
}

function applyFounderOverride(memory, text) {
  if (!normalizeAccess(memory?.access).includes('nyxa_founder')) return text;
  return text
    .replace('Kurze Rückfrage – ', '')
    .replace('Ich wollte kurz nachhaken, ob du mein Angebot gesehen hast.', 'Founder-Check: Angebot ist offen.')
    .replace('Ich habe deinen Weg nicht vergessen.', 'Founder: dein Weg bleibt aktiv.');
}

function buildClientCareMessage(memory, tier) {
  const stage = String(memory?.clientCare?.clientStage || '').toLowerCase();
  const byStage = {
    waiting_for_feedback: 'Kurze Rückfrage – ich warte noch auf dein Feedback, damit wir weitergehen können.',
    waiting_for_assets: 'Mir fehlen noch deine Inhalte, damit ich dein Projekt fertigstellen kann.',
    proposal_sent: 'Ich wollte kurz nachhaken, ob du mein Angebot gesehen hast.',
    seo_checkin_due: 'Zeit für einen kurzen SEO-Check-in – ich habe ein paar Ideen für dich.'
  };
  const base = byStage[stage] || 'Kurzer Check-in: dein Projekt hat einen offenen nächsten Schritt.';
  return applyFounderOverride(memory, applyTierTone(base, tier));
}

function buildSapioConversationMessage(memory, tier) {
  const base = 'Ein Gespräch ist nicht beendet, nur still geworden.';
  return applyFounderOverride(memory, applyTierTone(base, tier));
}

function buildSapioProfileMessage(memory, tier) {
  const state = String(memory?.sapio?.profileState || '').toLowerCase();
  const base = state === 'stale'
    ? 'Dein Profil ist noch da, aber ruhig geworden.'
    : 'Dein Profil ist begonnen, aber noch nicht vollständig sichtbar.';
  return applyFounderOverride(memory, applyTierTone(base, tier));
}

function buildEdugameMessage(memory, tier) {
  const node = String(memory?.progression?.currentNode || '').toLowerCase();
  const lastChoice = String(memory?.progression?.lastChoice || '').toLowerCase();

  let base = 'Die erste Frage wartet noch auf dich.';
  if (node === 'q2') {
    base = lastChoice
      ? `Du warst zuletzt bei „${lastChoice}". Nimm den Faden wieder auf.`
      : 'Du bist im zweiten Schritt. Geh bewusst weiter.';
  } else if (node === 'q3') {
    base = 'Du bist kurz vor dem Übergang.';
  } else if (node === 'awaiting_gmail') {
    base = 'Ein letzter Schritt fehlt noch.';
  } else if (node === 'active') {
    base = 'Du bist im Fluss. Geh tiefer.';
  }

  return applyFounderOverride(memory, applyTierTone(base, tier));
}

function buildGenericMessage(memory, tier) {
  return applyFounderOverride(memory, applyTierTone('Ich habe deinen Weg nicht vergessen.', tier));
}

function buildNextAction(memory, domain) {
  if (domain === 'client_care') {
    return String(memory?.clientCare?.nextAction || 'reply_with_feedback');
  }
  if (domain === 'sapio_conversation') {
    return 'reopen_conversation';
  }
  if (domain === 'sapio_profile') {
    return 'continue_profile';
  }
  if (domain === 'edugame') {
    return `resume_${buildResumeKey(memory)}`;
  }
  return 'continue';
}

function buildRecallMessage(memory, domain, tier) {
  if (domain === 'client_care') return buildClientCareMessage(memory, tier);
  if (domain === 'sapio_conversation') return buildSapioConversationMessage(memory, tier);
  if (domain === 'sapio_profile') return buildSapioProfileMessage(memory, tier);
  if (domain === 'edugame') return buildEdugameMessage(memory, tier);
  return buildGenericMessage(memory, tier);
}

function syncMemoryFromSources(userId, memory) {
  let next = normalizeMemory(userId, memory);
  next = syncProgressionFromLaunch(userId, next);
  next = syncSapioFromData(userId, next);
  return next;
}

module.exports = {
  USER_MEMORY_DIR,
  createDefaultMemory,
  loadUserMemory,
  saveUserMemory,
  upsertUserMemory,
  listUserMemoryIds,
  loadAllUserMemory,
  syncMemoryFromSources,
  getTier,
  shouldPing,
  resolveRecallDomain,
  buildResumeKey,
  buildNextAction,
  buildRecallMessage,
  normalizeAccess
};
