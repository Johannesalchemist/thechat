import fs   from "fs";
import path  from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, "roomState.json");

// ── Room definitions ──────────────────────────────────────────────────────────

export const ROOMS = {
  mystik: {
    label:  "Mystik",
    icon:   "◈",
    prompt: "Du antwortest bildhaft, tief, symbolisch und emotional. Nutze Metaphern und Resonanz. Sprich mit Seele.",
  },
  mythos: {
    label:  "Mythos",
    icon:   "⟡",
    prompt: "Du antwortest strukturiert, argumentativ und narrativ. Gliedere deine Antwort in eine klare Geschichte.",
  },
  system: {
    label:  "System",
    icon:   "◉",
    prompt: "Du antwortest analytisch, logisch und klar nummeriert. Halte dich an Fakten und Strukturen.",
  },
  programm: {
    label:  "Programm",
    icon:   "✦",
    prompt: "Du antwortest technisch präzise, knapp und lösungsorientiert. Code bevorzugt.",
  },
  integrity: {
    label:  "Integrity",
    icon:   "⚖",
    prompt: "Du prüfst Aussagen auf Widersprüche, Risiken und implizite Annahmen. Sei kritisch und ehrlich.",
  },
};

export const DEFAULT_ROOM = "mystik";

// ── State persistence ─────────────────────────────────────────────────────────

function loadState() {
  try   { return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")); }
  catch { return {}; }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export function getUserRoom(userId) {
  return loadState()[userId] ?? DEFAULT_ROOM;
}

export function setUserRoom(userId, room) {
  if (!ROOMS[room]) return false;
  const state = loadState();
  state[userId] = room;
  saveState(state);
  return true;
}

export function getRoomPrompt(userId) {
  const room = getUserRoom(userId);
  return ROOMS[room]?.prompt ?? ROOMS[DEFAULT_ROOM].prompt;
}
