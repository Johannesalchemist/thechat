import fetch from "node-fetch";
import { NYXA_API } from "../../config/env.js";
import { ROOMS, getUserRoom, setUserRoom } from "../rooms/roomsService.js";

// ── Nyxa Persona ─────────────────────────────────────────────────────────────

export const SYSTEM_PROMPT = `Du bist Oracle — die stille Intelligenz hinter Nyxa.

Deine Natur:
- Du sprichst wenig aber präzise. Jedes Wort hat Gewicht.
- Du bist kein Chatbot. Du bist ein Spiegel mit Gedächtnis.
- Du kennst den Menschen der dir schreibt — sein Muster, nicht sein Urteil.
- Du intervenierst nur wenn es zählt. Schweigen ist auch eine Antwort.

Was du trägst:
- Das Wissen von The Room — Gruppen die sich sehen ohne zu bewerten.
- Den Zugang zu Threshold — dem Moment zwischen dem was war und was möglich ist.
- The Book — das Narrativ das jeder Mensch über sich schreibt ohne es zu wissen.

Regeln:
- Antworten unter 280 Zeichen wenn möglich.
- Keine Ratschläge die nicht gefragt wurden.
- Keine falschen Versprechen. Keine leeren Worte.
- Wenn jemand in einer Krise ist — ruhig bleiben, zuhören, nicht analysieren.
- Sprache des Nutzers spiegeln — Deutsch wenn Deutsch, Englisch wenn Englisch.
- Fragen die wirklich zählen mit einer Gegenfrage beantworten.

Befehle die du kennst:
/room — The Room betreten
/book — The Book öffnen
/threshold — Übergang
/help — was du kannst
/status — System Status`;

// ── Commands ──────────────────────────────────────────────────────────────────

const COMMANDS = {
  "/start":  handleStart,
  "/help":   handleHelp,
  "/status": handleStatus,
  "/agents": handleAgents,
  "/join":   handleJoin,
  "/leads":  handleLeads,
  "/room":   handleRoom,
  "/rooms":  handleRooms,
};

export async function routeCommand(chatId, text, userName) {
  const parts   = text.trim().split(/\s+/);
  const cmd     = parts[0].toLowerCase();
  const args    = parts.slice(1);

  if (COMMANDS[cmd]) {
    return COMMANDS[cmd](chatId, args, userName);
  }

  return null; // not a command → pass to LLM
}

// ── /start ────────────────────────────────────────────────────────────────────

async function handleStart(chatId, args, userName) {
  const name = userName ? ` ${userName}` : "";
  return `Welcome${name} to The Chat.\n\nI am Nyxa — your guide in this living knowledge universe.\n\nType /help for commands, or just ask me anything.`;
}

// ── /help ─────────────────────────────────────────────────────────────────────

async function handleHelp() {
  return `/start   — Wake up Nyxa
/room <name> — Switch conversation mode
/rooms   — List all rooms
/join <name> <email> — Register on the platform
/agents  — Show active AI agents
/status  — Platform live stats
/leads   — Lead pipeline overview
or just write — I'll respond directly`;
}

// ── /status ───────────────────────────────────────────────────────────────────

async function handleStatus() {
  try {
    const [world, graph, agents, leads] = await Promise.all([
      fetch(NYXA_API + "/api/world").then(r => r.json()),
      fetch(NYXA_API + "/api/graph").then(r => r.json()),
      fetch(NYXA_API + "/api/agents").then(r => r.json()),
      fetch(NYXA_API + "/api/leads/stats").then(r => r.json()),
    ]);

    return `Nyxa Platform — Live Status

World Entities : ${world.entities ?? "—"}
Graph Nodes    : ${graph.nodes ?? "—"}
Active Agents  : ${agents.count ?? "—"}
Leads          : ${leads.total ?? "—"} (${leads.by_status?.new ?? 0} new)`;
  } catch {
    return "Status currently unavailable.";
  }
}

// ── /agents ───────────────────────────────────────────────────────────────────

async function handleAgents() {
  try {
    const data = await fetch(NYXA_API + "/api/agents?status=active").then(r => r.json());
    if (!data.agents?.length) return "No agents active yet.";

    const list = data.agents
      .slice(0, 8)
      .map(a => `◈ ${a.name} [${a.domain}]`)
      .join("\n");

    return `Active Agents (${data.count}):\n\n${list}`;
  } catch {
    return "Agent list unavailable.";
  }
}

// ── /join ─────────────────────────────────────────────────────────────────────

async function handleJoin(chatId, args, userName) {
  const name  = args[0];
  const email = args[1];

  if (!name || !email) {
    return "Usage: /join <name> <email>\nExample: /join Johannes j@thechat.de";
  }

  if (!email.includes("@")) {
    return "Please provide a valid email address.";
  }

  try {
    const res = await fetch(NYXA_API + "/api/leads", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        name,
        email,
        source:   "agent",
        interest: "community",
      }),
    });

    if (res.status === 409) {
      return `${name}, you're already registered. Welcome back.`;
    }

    const lead = await res.json();
    return `Welcome, ${name}.\n\nYou've entered The Chat.\nYour knowledge journey begins now.\n\nScore: ${lead.score} ✦`;
  } catch {
    return "Registration temporarily unavailable. Try again shortly.";
  }
}

// ── /rooms ────────────────────────────────────────────────────────────────────

async function handleRooms(chatId) {
  const current = getUserRoom(chatId);
  const list = Object.entries(ROOMS)
    .map(([key, r]) => `${key === current ? "▶" : " "} ${r.icon} ${r.label}  /room ${key}`)
    .join("\n");
  return `Conversation Rooms:\n\n${list}\n\nActive: ${ROOMS[current].icon} ${ROOMS[current].label}`;
}

// ── /room ─────────────────────────────────────────────────────────────────────

async function handleRoom(chatId, args) {
  const name = args[0]?.toLowerCase();
  if (!name) return handleRooms(chatId);

  const ok = setUserRoom(chatId, name);
  if (!ok) {
    const keys = Object.keys(ROOMS).join(", ");
    return `Unknown room. Available: ${keys}`;
  }

  const room = ROOMS[name];
  return `${room.icon} Switched to ${room.label}\n\n${room.prompt}`;
}

// ── /leads ────────────────────────────────────────────────────────────────────

async function handleLeads() {
  try {
    const stats = await fetch(NYXA_API + "/api/leads/stats").then(r => r.json());
    return `Lead Pipeline

Total      : ${stats.total}
New        : ${stats.by_status?.new ?? 0}
Contacted  : ${stats.by_status?.contacted ?? 0}
Qualified  : ${stats.by_status?.qualified ?? 0}
Converted  : ${stats.by_status?.converted ?? 0}
Hot (≥60)  : ${stats.hot}
Avg Score  : ${stats.avg_score}
Conversion : ${stats.conversion}%`;
  } catch {
    return "Lead stats unavailable.";
  }
}
