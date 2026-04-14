import fetch from "node-fetch";
import { NYXA_API } from "../../config/env.js";
import { ROOMS, getUserRoom, setUserRoom } from "../rooms/roomsService.js";
import {
  appendEdugameEvent,
  createSyncToken,
  getLaunchBundle,
  getLaunchState,
  replaySession,
  resetLaunchBundle,
  upsertLaunchMatch,
  upsertLaunchProfile,
  upsertLaunchRoom,
  upsertLaunchState
} from "./launchLoopStore.js";
import {
  EDU_MAP,
  getNodeMeta,
  NODE_TEXT,
  getAllowedChoicesForNode,
  normalizeEdugameNode,
  resolveNextNode
} from "./edugameMap.js";

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
  "/choice": handleChoice,
  "/help":   handleHelp,
  "/status": handleStatus,
  "/agents": handleAgents,
  "/join":   handleJoin,
  "/leads":  handleLeads,
  "/room":   handleRoom,
  "/rooms":  handleRooms,
  "/artifact": handleArtifact,
  "/sync": handleSync,
  "/resume": handleResume,
  "/edugame_reset": handleEdugameReset,
  "/edugame_replay": handleEdugameReplay,
};

function buildChoiceGuidance(node) {
  const normalizedNode = normalizeEdugameNode(node);
  const nodeMeta = getNodeMeta(normalizedNode);
  const allowed = getAllowedChoicesForNode(normalizedNode);
  const lines = [
    `Aktiver EduGame-Knoten: ${normalizedNode}`,
    NODE_TEXT[normalizedNode] || "Knoten geladen."
  ];

  if (!nodeMeta.allow_choices) {
    lines.push(nodeMeta.invalid_choice_guidance || "Für diesen Knoten sind keine Choice-Transitions definiert.");
    return lines.join("\n");
  }

  if (!allowed.length) {
    lines.push("Für diesen Knoten sind keine Choice-Transitions definiert.");
  } else {
    lines.push("Wähle mit /choice A | B | C:");
    lines.push("/choice A  (silence)");
    lines.push("/choice B  (fire)");
    lines.push("/choice C  (mirror)");
  }

  return lines.join("\n");
}

export async function routeCommand(chatId, text, userName) {
  const parts   = text.trim().split(/\s+/);
  const rawCmd  = parts[0].toLowerCase();
  const normalizedCmd = rawCmd
    .replace(/^\/start@[\w_]+$/, "/start")
    .replace(/[^\w/@-]/g, "");
  const cmdAlias = {
    "start": "/start",
    "start_flow": "/start"
  };
  const cmd = cmdAlias[normalizedCmd] || normalizedCmd;
  const args    = parts.slice(1);

  if (COMMANDS[cmd]) {
    if (cmd === "/start") {
      console.log(`[PHONE-AGENT] /start routed for chat ${chatId} (mode: ${args[0] || "default"}, input: ${rawCmd}, normalized: ${normalizedCmd})`);
    }
    return COMMANDS[cmd](chatId, args, userName);
  }

  return null; // not a command → pass to LLM
}

export async function routeEdugameSelection(chatId, text, userName) {
  const state = getLaunchState(chatId);
  if (!state || state.stage !== "edugame_entry") {
    return null;
  }

  const normalized = normalizeArtifactChoice(text);
  if (!normalized) return null;

  console.log(`[PHONE-AGENT] EduGame direct selection routed for chat ${chatId}: ${normalized}`);
  return handleArtifact(chatId, [normalized], userName);
}

// ── /start ────────────────────────────────────────────────────────────────────

async function handleStart(chatId, args, userName) {
  const mode = String(args[0] || "").toLowerCase();
  if (mode.startsWith("resume_")) {
    return handleStartResume(chatId, mode.slice("resume_".length), userName);
  }
  const state = getLaunchState(chatId);
  const hasState = !!state;
  if (state?.stage === "artifact_selected" || state?.stage === "sync_ready") {
    const bundle = getLaunchBundle(chatId);
    return [
      `Nyxa remembers your path, ${userName || "traveler"}.`,
      "",
      `Current artifact path: ${bundle.match?.artifact_path || "not set"}`,
      `Sapio track: ${bundle.match?.sapio_track || "not set"}`,
      "",
      "Return to web with /sync",
      "or change path with /choice A | B | C"
    ].join("\n");
  }

  if (!hasState) {
    upsertLaunchState(chatId, {
      stage: "edugame_entry",
      last_node: "choose_direction",
      last_command: "/start"
    });
    upsertLaunchProfile(chatId, {
      visitor_name: userName || "Guest",
      identity_tag: "telegram-entry"
    });
    upsertLaunchRoom(chatId, {
      guided_intro_done: false
    });
  } else {
    upsertLaunchState(chatId, {
      last_command: "/start",
      start_mode: mode || "default"
    });
  }

  return [
    `Nyxa online. EduGame node loaded for ${userName || "you"}.`,
    mode ? `Start mode: ${mode}` : "Start mode: default",
    "",
    "Node 1: Choose your first artifact direction.",
    "",
    "Use one command:",
    "/choice A  (silence)",
    "/choice B  (fire)",
    "/choice C  (mirror)"
  ].join("\n");
}

function isEdugameResumeKey(key) {
  return ["q1", "q2", "q3", "awaiting_gmail", "active", "start"].includes(String(key || "").toLowerCase());
}

function mapEdugameResumeState(existingState, key) {
  const current = existingState || {};
  const resumeKey = String(key || "start").toLowerCase();

  if (resumeKey === "start" || resumeKey === "q1") {
    return { stage: "edugame_entry", last_node: "choose_direction" };
  }

  if (resumeKey === "q2") {
    const keepNode = String(current.last_node || "").startsWith("path_") ? current.last_node : "path_fire_1";
    return { stage: "artifact_selected", last_node: keepNode };
  }

  if (resumeKey === "q3") {
    const keepNode = String(current.last_node || "").startsWith("path_") ? current.last_node : "path_fire_2";
    return { stage: "artifact_selected", last_node: keepNode };
  }

  if (resumeKey === "awaiting_gmail") {
    return { stage: "sync_ready", last_node: "sync_token_loaded" };
  }

  if (resumeKey === "active") {
    const keepNode = String(current.last_node || "").trim() || "sync_token_loaded";
    const keepStage = String(current.stage || "").trim() || "sync_ready";
    return { stage: keepStage, last_node: keepNode };
  }

  return { stage: "edugame_entry", last_node: "choose_direction" };
}

async function resumeEdugame(chatId, key) {
  const normalized = String(key || "").trim().toLowerCase();
  const existingState = getLaunchState(chatId);
  const mapped = mapEdugameResumeState(existingState, normalized);
  upsertLaunchState(chatId, {
    stage: mapped.stage,
    last_node: mapped.last_node,
    last_command: `/start resume_${normalized || "start"}`,
    resume_key: normalized || "start"
  });

  if (normalized === "q1" || normalized === "start") return "Die erste Frage wartet auf dich.";
  if (normalized === "q2") return "Deine letzte Entscheidung führt dich weiter.";
  if (normalized === "q3") return "Du bist kurz vor dem Übergang.";
  if (normalized === "awaiting_gmail") return "Ein letzter Schritt fehlt noch.";
  if (normalized === "active") return "Du bist im Fluss. Geh tiefer.";
  return "Ich führe dich zurück zu deinem Weg.";
}

async function resumeClientCare(chatId, key) {
  const normalized = String(key || "").trim().toLowerCase();
  upsertLaunchState(chatId, {
    last_command: `/start resume_${normalized}`,
    resume_key: normalized
  });
  if (normalized === "client_feedback") {
    return "Ich warte noch auf dein Feedback. Du kannst mir hier direkt antworten oder den nächsten Schritt freigeben.";
  }
  if (normalized === "client_assets") {
    return "Bitte sende mir die fehlenden Inhalte, damit ich dein Projekt abschließen kann.";
  }
  if (normalized === "client_proposal") {
    return "Hattest du schon Zeit, das Angebot anzuschauen? Ich kann dir offene Punkte direkt erklären.";
  }
  return "Wir setzen dein Projekt an der richtigen Stelle fort.";
}

async function resumeSapio(chatId, key) {
  const normalized = String(key || "").trim().toLowerCase();
  upsertLaunchState(chatId, {
    last_command: `/start resume_${normalized}`,
    resume_key: normalized
  });
  if (normalized === "sapio_profile") {
    return "Dein Profil ist noch nicht vollständig. Lass uns das gemeinsam abschließen.";
  }
  if (normalized === "sapio_conversation") {
    return "Ein Gespräch ist offen. Willst du es wieder aufnehmen?";
  }
  return "Ich führe dich zurück in deinen Sapio-Bereich.";
}

export async function handleResumeEntry({ chatId, key, userName }) {
  const resumeKey = String(key || "").trim().toLowerCase();

  upsertLaunchProfile(chatId, {
    visitor_name: userName || "Guest",
    identity_tag: "telegram-edugame"
  });

  if (isEdugameResumeKey(resumeKey)) {
    return resumeEdugame(chatId, resumeKey);
  }
  if (resumeKey.startsWith("client_")) {
    return resumeClientCare(chatId, resumeKey);
  }
  if (resumeKey.startsWith("sapio_")) {
    return resumeSapio(chatId, resumeKey);
  }

  upsertLaunchState(chatId, {
    last_command: `/start resume_${resumeKey || "start"}`,
    resume_key: resumeKey || "start"
  });
  return "Ich habe deinen Einstieg nicht mehr ganz gefunden. Ich starte mit dir am letzten stabilen Punkt.";
}

async function handleStartResume(chatId, resumeKey, userName) {
  return handleResumeEntry({ chatId, key: resumeKey, userName });
}

function buildMatchPayload(artifactPath) {
  const normalized = String(artifactPath || "").toLowerCase();
  if (normalized === "fire") {
    return {
      artifact_path: "fire",
      sapio_track: "sapio-fire",
      match_path: "runner+claudecode",
      recommended_agents: ["runner", "claudecode", "watcher"],
      level_hint: "builder"
    };
  }
  if (normalized === "mirror") {
    return {
      artifact_path: "mirror",
      sapio_track: "sapio-mirror",
      match_path: "codex+mentor",
      recommended_agents: ["codex", "mentor", "watcher"],
      level_hint: "reflective"
    };
  }
  return {
    artifact_path: "silence",
    sapio_track: "sapio-silence",
    match_path: "sophia+oracle",
    recommended_agents: ["sophia", "oracle", "watcher"],
    level_hint: "foundation"
  };
}

function normalizeArtifactChoice(choice) {
  const v = String(choice || "").trim().toLowerCase();
  const token = v
    .replace(/^\/choice\s+/, "")
    .replace(/^\/artifact\s+/, "")
    .replace(/^choice[:_\-]/, "")
    .replace(/^artifact[:_\-]/, "");
  if (token === "a" || token === "silence") return "silence";
  if (token === "b" || token === "fire") return "fire";
  if (token === "c" || token === "mirror") return "mirror";
  if (token === "sapio") return "silence";
  if (token === "knowledge") return "mirror";
  if (token === "creation") return "fire";
  return null;
}

export async function routeLaunchStatePrompt(chatId, text) {
  const state = getLaunchState(chatId);
  if (!state) return null;

  const stage = String(state.stage || "").toLowerCase();
  const lastNode = String(state.last_node || "").toLowerCase();
  const normalized = String(text || "").trim().toLowerCase();

  if (stage === "edugame_entry") {
    console.log(`[PHONE-AGENT] routing_handler_selected=launch_state_prompt stage=${stage} last_node=${lastNode} source=edugame_entry_guard`);
    if (!normalizeArtifactChoice(normalized)) {
      return [
        "Du bist noch im EduGame Einstieg.",
        buildChoiceGuidance(lastNode)
      ].join("\n");
    }
    return null;
  }

  if (stage === "artifact_selected" && lastNode.startsWith("path_")) {
    console.log(`[PHONE-AGENT] routing_handler_selected=launch_state_prompt stage=${stage} last_node=${lastNode} source=artifact_selected_guard`);
    if (!normalized.startsWith("/sync") && !normalized.startsWith("/choice") && !normalized.startsWith("/artifact")) {
      return [
        `Aktiver Pfad: ${lastNode}`,
        "Nächster Schritt: /sync",
        "Oder Pfad wechseln mit /choice A | B | C"
      ].join("\n");
    }
    return null;
  }

  if (stage === "sync_ready") {
    console.log(`[PHONE-AGENT] routing_handler_selected=launch_state_prompt stage=${stage} last_node=${lastNode} source=sync_ready_guard`);
    if (!normalized.startsWith("/sync")) {
      return [
        "Sync ist bereit.",
        "Öffne den Gateway-Link aus /sync oder erzeuge ihn erneut mit /sync."
      ].join("\n");
    }
    return null;
  }

  return null;
}

async function handleChoice(chatId, args, userName) {
  const state = getLaunchState(chatId);
  const nodeBefore = normalizeEdugameNode(state?.last_node || "choose_direction");
  const nodeMeta = getNodeMeta(nodeBefore);
  const rawChoice = String(args[0] || "");
  const choice = normalizeArtifactChoice(args[0]);

  if (!nodeMeta.allow_choices) {
    appendEdugameEvent(chatId, {
      node_before: nodeBefore,
      choice: choice || rawChoice || "",
      node_after: nodeBefore,
      valid: false
    });
    if (choice && nodeMeta.choice_entry_node) {
      console.log(`[PHONE-AGENT] non-decision node choice remap chat=${chatId} node=${nodeBefore} remap_to=${nodeMeta.choice_entry_node} choice=${choice}`);
      upsertLaunchState(chatId, {
        stage: "artifact_selected",
        last_node: nodeMeta.choice_entry_node,
        last_command: `/choice ${choice}`
      });
      return handleArtifact(chatId, [choice], userName);
    }
    return nodeMeta.invalid_choice_guidance || buildChoiceGuidance(nodeBefore);
  }

  if (!choice) {
    appendEdugameEvent(chatId, {
      node_before: nodeBefore,
      choice: rawChoice,
      node_after: nodeBefore,
      valid: false
    });
    return [
      "Diese Option ist hier nicht verfügbar.",
      buildChoiceGuidance(nodeBefore)
    ].join("\n");
  }

  return handleArtifact(chatId, [choice], userName);
}

async function handleArtifact(chatId, args, userName) {
  const choice = normalizeArtifactChoice(args[0]);
  if (!choice) return "Diese Option ist hier nicht verfügbar.";

  const stateBefore = getLaunchState(chatId);
  const nodeBefore = normalizeEdugameNode(stateBefore?.last_node || "choose_direction");
  const nextNode = resolveNextNode(nodeBefore, choice);
  const nodeAfter = nextNode || nodeBefore;
  const hasNodeMap = !!EDU_MAP[nodeBefore];
  const transitionReason = !hasNodeMap ? "unknown_node" : (!nextNode ? "invalid_choice" : "ok");

  console.log(`[PHONE-AGENT] EduGame transition node_before=${nodeBefore} choice=${choice} node_after=${nodeAfter} transition_reason=${transitionReason}`);
  appendEdugameEvent(chatId, {
    node_before: nodeBefore,
    choice,
    node_after: nodeAfter,
    valid: !!nextNode && nextNode !== nodeBefore
  });

  if (!hasNodeMap || !nextNode) {
    console.error(`[PHONE-AGENT] INVALID TRANSITION chat=${chatId} node=${nodeBefore} choice=${choice} reason=${transitionReason}`);
    return [
      "Diese Option ist hier nicht verfügbar.",
      buildChoiceGuidance(nodeBefore)
    ].join("\n");
  }

  if (nextNode === nodeBefore) {
    console.error(`[PHONE-AGENT] LOOP DETECTED chat=${chatId} node=${nodeBefore} choice=${choice}`);
    const fallbackState = upsertLaunchState(chatId, {
      stage: "edugame_entry",
      last_node: "choose_direction",
      last_command: `/artifact ${choice}`,
      last_error: "loop_detected"
    });
    appendEdugameEvent(chatId, {
      node_before: nodeBefore,
      choice,
      node_after: fallbackState.last_node,
      valid: false
    });
    return [
      "Loop detected in transition. Restarting node safely.",
      "",
      buildChoiceGuidance("choose_direction")
    ].join("\n");
  }

  const match = buildMatchPayload(choice);
  const savedState = upsertLaunchState(chatId, {
    stage: "artifact_selected",
    last_node: nextNode,
    last_command: `/artifact ${choice}`
  });
  upsertLaunchProfile(chatId, {
    visitor_name: userName || "Guest",
    personalization_mode: choice,
    identity_tag: "telegram-edugame"
  });
  upsertLaunchMatch(chatId, match);
  upsertLaunchRoom(chatId, {
    guided_intro_done: false,
    room_target: "dashboard-room"
  });
  appendEdugameEvent(chatId, {
    node_before: nodeBefore,
    choice,
    node_after: savedState.last_node,
    valid: true
  });

  console.log(`[PHONE-AGENT] EduGame state saved chat=${chatId} stage=${savedState?.stage} last_node=${savedState?.last_node}`);

  return [
    `Artifact path set: ${match.artifact_path}`,
    `Node: ${nextNode}`,
    `Node text: ${NODE_TEXT[nextNode] || "Knoten aktiv."}`,
    `Sapio track: ${match.sapio_track}`,
    `Matching lane: ${match.match_path}`,
    "",
    "Next step: generate your sync token with /sync",
    "Then continue in web Gateway."
  ].join("\n");
}

async function handleSync(chatId) {
  const bundle = getLaunchBundle(chatId);
  if (!bundle.match) {
    return "Select your path first: /choice A | B | C";
  }

  const sync = createSyncToken(chatId);
  upsertLaunchState(chatId, {
    stage: "sync_ready",
    last_node: "sync_token_loaded",
    last_command: "/sync"
  });

  const gatewayUrl = `https://intothe.future24.eu/?token=${encodeURIComponent(sync.token)}`;
  return [
    "Sync token created.",
    `Token: ${sync.token}`,
    "",
    `Gateway: ${gatewayUrl}`,
    "",
    "Open the link, load profile/state, then continue to Room."
  ].join("\n");
}

async function handleResume(chatId) {
  const bundle = getLaunchBundle(chatId);
  if (!bundle.state) {
    return "No active launch state. Start with /start";
  }
  return [
    `Stage: ${bundle.state.stage || "unknown"}`,
    `Node: ${bundle.state.last_node || "n/a"}`,
    `Artifact: ${bundle.match?.artifact_path || "n/a"}`,
    `Sapio: ${bundle.match?.sapio_track || "n/a"}`,
    `Match: ${bundle.match?.match_path || "n/a"}`
  ].join("\n");
}

async function handleEdugameReset(chatId) {
  resetLaunchBundle(chatId);
  upsertLaunchState(chatId, {
    stage: "edugame_entry",
    last_node: "choose_direction",
    last_command: "/edugame_reset"
  });
  upsertLaunchRoom(chatId, {
    guided_intro_done: false
  });
  return [
    "EduGame state reset.",
    "Node 1: Choose your first artifact direction.",
    "/choice A  (silence)",
    "/choice B  (fire)",
    "/choice C  (mirror)"
  ].join("\n");
}

async function handleEdugameReplay(chatId, args) {
  const limitRaw = Number.parseInt(String(args?.[0] || "10"), 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 30) : 10;
  const replay = replaySession(chatId, { limit });
  const state = getLaunchState(chatId);

  if (!replay.history.length) {
    return "No EduGame events yet. Start with /start";
  }

  const lines = replay.history.map((event) => {
    const validity = event.valid ? "ok" : "invalid";
    return `${event.ts} | ${event.node_before} --${event.choice}--> ${event.node_after} [${validity}]`;
  });
  const lastChoice = replay.history[replay.history.length - 1]?.choice || "n/a";

  return [
    `EduGame Replay (last ${replay.history.length})`,
    `Current node: ${state?.last_node || replay.final_node || "n/a"}`,
    `Last choice: ${lastChoice}`,
    "",
    ...lines
  ].join("\n");
}

// ── /help ─────────────────────────────────────────────────────────────────────

async function handleHelp() {
  return `/start   — Wake up Nyxa
/start dialog | /start path — explicit start mode
/choice <A|B|C> — choose first artifact path
/artifact <silence|fire|mirror> — artifact alias
/sync    — create one-time gateway token
/resume  — show current launch node
/edugame_reset — reset EduGame node/state
/edugame_replay [N] — show last transitions
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
