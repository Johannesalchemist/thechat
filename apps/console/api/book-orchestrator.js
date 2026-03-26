'use strict';
/**
 * Book Room Orchestration Layer
 * Event sourcing + state machine + Art Director + provenance + loop detection
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ── Constants ──────────────────────────────────────────────────────────────────
const EVENTS_DIR  = path.join(__dirname, '../../../data/books');
const THRESHOLDS  = { T1: 30, T2: 55, T3: 80 }; // stability thresholds

// Validate T1 < T2 < T3 at init
if (!(THRESHOLDS.T1 < THRESHOLDS.T2 && THRESHOLDS.T2 < THRESHOLDS.T3)) {
  throw new Error('[BookOrchestrator] Invalid thresholds: T1 < T2 < T3 required');
}

// ── State Machine ──────────────────────────────────────────────────────────────
const STATES = {
  DRAFT:        'DRAFT',
  SHAPING:      'SHAPING',
  REFINING:     'REFINING',
  PRE_PUBLISH:  'PRE_PUBLISH',
  LOCKED:       'LOCKED',
  PUBLISHED:    'PUBLISHED',
  STAGNANT:     'STAGNANT',
  BLOCKED:      'BLOCKED',
  DIVERGED:     'DIVERGED',
};

const VALID_TRANSITIONS = {
  DRAFT:        ['SHAPING', 'BLOCKED'],
  SHAPING:      ['REFINING', 'STAGNANT', 'DIVERGED', 'BLOCKED'],
  REFINING:     ['PRE_PUBLISH', 'SHAPING', 'STAGNANT', 'DIVERGED', 'BLOCKED'],
  PRE_PUBLISH:  ['LOCKED', 'REFINING'],
  LOCKED:       ['PUBLISHED'],
  PUBLISHED:    [], // immutable — no direct transitions; use fork()
  STAGNANT:     ['SHAPING', 'REFINING', 'BLOCKED'],
  BLOCKED:      ['DRAFT', 'SHAPING'],
  DIVERGED:     ['REFINING', 'SHAPING'],
};

function validateTransition(from, to) {
  const allowed = VALID_TRANSITIONS[from];
  if (!allowed) throw new Error(`[StateMachine] Unknown state: ${from}`);
  if (!allowed.includes(to)) {
    throw new Error(`[StateMachine] Invalid transition: ${from} → ${to}. Allowed: ${allowed.join(', ')}`);
  }
}

// ── Event Sourcing ─────────────────────────────────────────────────────────────
const EVENT_TYPES = {
  USER_MESSAGE:         'USER_MESSAGE',
  AGENT_RESPONSE:       'AGENT_RESPONSE',
  SYNTHESIS_COMMIT:     'SYNTHESIS_COMMIT',
  STATE_TRANSITION:     'STATE_TRANSITION',
  ART_DIRECTOR_DECISION:'ART_DIRECTOR_DECISION',
  LOOP_DETECTED:        'LOOP_DETECTED',
  FORK_CREATED:         'FORK_CREATED',
};

function hashEvent(payload, prevHash) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(payload) + (prevHash || ''))
    .digest('hex');
}

function buildEvent(type, payload, source, prevHash) {
  const ev = {
    id:        crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    type,
    payload,
    source,
    prevHash:  prevHash || null,
  };
  ev.hash = hashEvent(ev.payload, ev.prevHash);
  return ev;
}

function verifyChain(events) {
  for (let i = 1; i < events.length; i++) {
    const expected = hashEvent(events[i].payload, events[i].prevHash);
    if (events[i].hash !== expected) {
      throw new Error(`[Provenance] Hash mismatch at event ${i} (id: ${events[i].id})`);
    }
    if (events[i].prevHash !== events[i - 1].hash) {
      throw new Error(`[Provenance] Chain broken at event ${i}: prevHash does not match prior event hash`);
    }
  }
  return true;
}

// ── Book State Store ───────────────────────────────────────────────────────────
function getBookDir(bookId) {
  const dir = path.join(EVENTS_DIR, bookId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getEventLogPath(bookId) {
  return path.join(getBookDir(bookId), 'events.jsonl');
}

function getStatePath(bookId) {
  return path.join(getBookDir(bookId), 'state.json');
}

function appendEvent(bookId, event) {
  const logPath = getEventLogPath(bookId);
  fs.appendFileSync(logPath, JSON.stringify(event) + '\n');
}

function readEvents(bookId) {
  const logPath = getEventLogPath(bookId);
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf8')
    .split('\n').filter(Boolean)
    .map(line => JSON.parse(line));
}

function readState(bookId) {
  const p = getStatePath(bookId);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeState(bookId, state) {
  fs.writeFileSync(getStatePath(bookId), JSON.stringify(state, null, 2));
}

// ── Orchestrator ───────────────────────────────────────────────────────────────
class BookOrchestrator {
  constructor(bookId, anthropicCall) {
    this.bookId       = bookId;
    this._anthropic   = anthropicCall;
    this._loopCounters = {};
    this._ensureState();
  }

  _ensureState() {
    if (!readState(this.bookId)) {
      writeState(this.bookId, {
        bookId:    this.bookId,
        state:     STATES.DRAFT,
        version:   1,
        stability: 0,
        sourceBookId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        artDirectorConstraints: [],
      });
    }
  }

  getState() { return readState(this.bookId); }

  _lastEventHash() {
    const events = readEvents(this.bookId);
    return events.length ? events[events.length - 1].hash : null;
  }

  emit(type, payload, source = 'system') {
    const event = buildEvent(type, payload, source, this._lastEventHash());
    appendEvent(this.bookId, event);
    return event;
  }

  transition(toState, reason = '') {
    const s = this.getState();
    validateTransition(s.state, toState); // throws if invalid
    const event = this.emit(EVENT_TYPES.STATE_TRANSITION, {
      from: s.state, to: toState, reason
    }, 'orchestrator');
    const updated = { ...s, state: toState, updatedAt: new Date().toISOString() };
    writeState(this.bookId, updated);
    return event;
  }

  verifyIntegrity() {
    const events = readEvents(this.bookId);
    return verifyChain(events); // throws on failure
  }

  // ── Agent Council ────────────────────────────────────────────────────────────
  async runAgentCouncil(prompt, agents, context = '') {
    const responses = {};
    const systemPrompts = {
      Muse:      `You are Muse — emotional resonance, imagery, tone. Respond to the writer's input with feeling and impression. 2-3 sentences.`,
      Alchemist: `You are Alchemist — transformation, structure, depth. Identify what the raw material wants to become. 2-3 sentences.`,
      Sage:      `You are Sage — clarity, wisdom, argument. Find the clear foothold, name what the text knows. 2-3 sentences.`,
      Critic:    `You are Critic — weakness, contradiction, what is missing. Be exact, not cruel. 2-3 sentences.`,
    };

    for (const agent of agents) {
      if (!systemPrompts[agent]) continue;
      const system = systemPrompts[agent] + (context ? `\n\nContext:\n${context}` : '');
      try {
        const reply = await this._anthropic(system, [{ role: 'user', content: prompt }], 'claude-haiku-4-5-20251001', 200);
        responses[agent] = reply;
        this.emit(EVENT_TYPES.AGENT_RESPONSE, { agent, prompt: prompt.slice(0, 200), reply: reply.slice(0, 500) }, agent);
      } catch (e) {
        responses[agent] = null;
      }
    }
    return responses;
  }

  // ── Art Director ─────────────────────────────────────────────────────────────
  async artDirector(agentOutputs, currentState, reason = '') {
    const entries = Object.entries(agentOutputs)
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n\n');

    const prompt = `You are the Art Director — a directive authority, NOT a generative agent.
You resolve creative conflicts and define narrative constraints.

Current book state: ${currentState.state}
Stability: ${currentState.stability}%
Reason for Art Director intervention: ${reason}

Agent outputs:
${entries}

Your task:
1. Identify the dominant tension or divergence between agents.
2. Provide a clear creative direction that resolves it.
3. Define 2-3 constraints the SynthesisAgent must respect.
4. Set the tone for the next synthesis pass.

Respond ONLY as JSON in this exact format:
{
  "direction": "...",
  "tone": "...",
  "constraints": ["...", "..."],
  "priority": "..."
}`;

    try {
      const raw = await this._anthropic('', [{ role: 'user', content: prompt }], 'claude-haiku-4-5-20251001', 400);
      const match = raw.match(/\{[\s\S]*?\}/);
      const decision = match ? JSON.parse(match[0]) : { direction: raw, tone: 'neutral', constraints: [], priority: 'cohesion' };

      const event = this.emit(EVENT_TYPES.ART_DIRECTOR_DECISION, {
        reason, decision, agentsSeen: Object.keys(agentOutputs)
      }, 'art_director');

      // Apply constraints to state
      const s = this.getState();
      writeState(this.bookId, {
        ...s,
        artDirectorConstraints: decision.constraints || [],
        updatedAt: new Date().toISOString(),
      });

      return { decision, event };
    } catch (e) {
      return { decision: { direction: '', tone: 'neutral', constraints: [], priority: 'cohesion' }, event: null };
    }
  }

  // ── Synthesis ────────────────────────────────────────────────────────────────
  async synthesize(agentOutputs, chapterContent, artDirectorDecision) {
    const s = this.getState();
    const constraints = (artDirectorDecision?.constraints || s.artDirectorConstraints || []).join('; ');

    const combinedAgentInsights = Object.entries(agentOutputs)
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n\n');

    const prompt = `You are the Synthesis Agent. Your job is to produce an improved version of the chapter content below.

Current chapter content:
${chapterContent || '(empty)'}

Agent insights:
${combinedAgentInsights}

Art Director direction: ${artDirectorDecision?.direction || 'none'}
Art Director tone: ${artDirectorDecision?.tone || 'neutral'}
Constraints: ${constraints || 'none'}

Produce a refined version of the chapter that:
- Preserves the author's voice
- Integrates the strongest insights
- Respects all constraints
- Advances toward the Art Director's direction

Output ONLY the revised chapter text — no preamble, no explanation.`;

    const revised = await this._anthropic(
      'You are a synthesis agent for literary collaboration.',
      [{ role: 'user', content: prompt }],
      'claude-haiku-4-5-20251001', 600
    );

    // Build source_chain for provenance
    const events   = readEvents(this.bookId);
    const lastHash = events.length ? events[events.length - 1].hash : null;
    const sourceChain = events.slice(-6).map(e => ({ id: e.id, type: e.type, hash: e.hash }));

    const event = this.emit(EVENT_TYPES.SYNTHESIS_COMMIT, {
      source_chain: sourceChain,
      inputs: { agentKeys: Object.keys(agentOutputs), hasArtDirector: !!artDirectorDecision },
      outputHash: crypto.createHash('sha256').update(revised).digest('hex'),
    }, 'synthesis');

    return { revised, event, sourceChain };
  }

  // ── Loop Detection ───────────────────────────────────────────────────────────
  detectLoops() {
    const events = readEvents(this.bookId);
    const detected = [];

    // Type 1: Agent loop — same agent output repeated ≥3 times
    const agentOutputs = events
      .filter(e => e.type === EVENT_TYPES.AGENT_RESPONSE)
      .map(e => `${e.payload.agent}:${e.payload.reply?.slice(0, 80)}`);

    const agentFreq = {};
    for (const key of agentOutputs) {
      agentFreq[key] = (agentFreq[key] || 0) + 1;
    }
    for (const [key, count] of Object.entries(agentFreq)) {
      if (count >= 3) {
        detected.push({ type: 1, key, count, response: 'suppress_agent' });
        this.emit(EVENT_TYPES.LOOP_DETECTED, { loopType: 1, key, count }, 'orchestrator');
      }
    }

    // Type 2: Content loop — synthesis outputs oscillating (same hash appearing twice)
    const synthHashes = events
      .filter(e => e.type === EVENT_TYPES.SYNTHESIS_COMMIT)
      .map(e => e.payload.outputHash);
    const seenHashes = new Set();
    for (const h of synthHashes) {
      if (seenHashes.has(h)) {
        detected.push({ type: 2, hash: h, response: 'force_reframe' });
        this.emit(EVENT_TYPES.LOOP_DETECTED, { loopType: 2, hash: h }, 'orchestrator');
        break;
      }
      seenHashes.add(h);
    }

    // Type 3: Engagement loop — no USER_MESSAGE in last 10 events
    const recentTypes = events.slice(-10).map(e => e.type);
    if (recentTypes.length >= 10 && !recentTypes.includes(EVENT_TYPES.USER_MESSAGE)) {
      detected.push({ type: 3, response: 'escalate_to_user' });
      this.emit(EVENT_TYPES.LOOP_DETECTED, { loopType: 3 }, 'orchestrator');
    }

    return detected;
  }

  resolveLoop(loop, artDirectorDecision = null) {
    if (loop.type === 1) {
      // Suppress agent by returning its key to caller (caller removes from active set)
      return { action: 'suppress', agentKey: loop.key.split(':')[0] };
    }
    if (loop.type === 2) {
      if (artDirectorDecision) {
        this.transition(STATES.REFINING, 'Art Director resolved content loop');
        return { action: 'reframe', direction: artDirectorDecision.direction };
      }
      this.transition(STATES.DIVERGED, 'Content loop — Art Director needed');
      return { action: 'needs_art_director' };
    }
    if (loop.type === 3) {
      return { action: 'escalate_to_user', message: 'The room has been quiet. What do you want to explore next?' };
    }
  }

  // ── Divergence Resolution ────────────────────────────────────────────────────
  async resolveDivergence(agentOutputs) {
    const { decision } = await this.artDirector(agentOutputs, this.getState(), 'Agent divergence detected');
    this.transition(STATES.REFINING, 'Art Director resolved divergence');
    return decision;
  }

  detectDivergence(agentOutputs) {
    // Simple heuristic: Muse and Critic both responded and their outputs share < 20% word overlap
    const { Muse, Critic } = agentOutputs;
    if (!Muse || !Critic) return false;
    const museWords   = new Set(Muse.toLowerCase().split(/\s+/));
    const criticWords = new Set(Critic.toLowerCase().split(/\s+/));
    const intersection = [...museWords].filter(w => criticWords.has(w)).length;
    const union = new Set([...museWords, ...criticWords]).size;
    const overlap = intersection / union;
    return overlap < 0.15; // very little shared language = divergence
  }

  // ── Publish / Fork ───────────────────────────────────────────────────────────
  publish() {
    const s = this.getState();
    if (s.state !== STATES.LOCKED && s.state !== STATES.PRE_PUBLISH) {
      throw new Error(`[BookOrchestrator] Cannot publish from state: ${s.state}`);
    }
    if (s.state === STATES.PRE_PUBLISH) this.transition(STATES.LOCKED, 'pre-publish check passed');
    this.transition(STATES.PUBLISHED, 'published');
    return this.getState();
  }

  fork(newBookId) {
    const s = this.getState();
    const forkedState = {
      bookId:       newBookId,
      state:        STATES.DRAFT,
      version:      (s.version || 1) + 1,
      stability:    0,
      sourceBookId: this.bookId,
      createdAt:    new Date().toISOString(),
      updatedAt:    new Date().toISOString(),
      artDirectorConstraints: [],
    };
    writeState(newBookId, forkedState);
    this.emit(EVENT_TYPES.FORK_CREATED, { sourceBookId: this.bookId, newBookId, version: forkedState.version }, 'orchestrator');
    return forkedState;
  }

  // ── Full orchestration run ───────────────────────────────────────────────────
  async run({ userMessage, chapterContent, activeAgents, currentStability }) {
    // 1. Emit user message
    this.emit(EVENT_TYPES.USER_MESSAGE, { message: userMessage.slice(0, 400) }, 'user');

    // 2. Detect loops before proceeding
    const loops = this.detectLoops();
    const suppressedAgents = new Set(
      loops.filter(l => l.type === 1).map(l => l.key.split(':')[0])
    );
    const effectiveAgents = activeAgents.filter(a => !suppressedAgents.has(a));

    // 3. Run agent council
    const agentOutputs = await this.runAgentCouncil(userMessage, effectiveAgents, chapterContent);

    // 4. Check divergence
    let artDirectorDecision = null;
    const s = this.getState();
    if (this.detectDivergence(agentOutputs)) {
      try { this.transition(STATES.DIVERGED, 'Muse/Critic divergence detected'); } catch {}
      artDirectorDecision = await this.resolveDivergence(agentOutputs);
    } else if (Object.values(agentOutputs).filter(Boolean).length >= 3) {
      // Run Art Director proactively when 3+ agents respond
      const result = await this.artDirector(agentOutputs, this.getState(), 'Council synthesis');
      artDirectorDecision = result.decision;
    }

    // 5. Type 2/3 loop responses
    for (const loop of loops) {
      if (loop.type === 2) {
        const resolution = this.resolveLoop(loop, artDirectorDecision);
        if (resolution.action === 'needs_art_director') {
          artDirectorDecision = (await this.artDirector(agentOutputs, this.getState(), 'Content loop resolution')).decision;
        }
      }
    }

    // 6. State advancement based on stability
    const newStability = Math.min(100, (currentStability || 0) + 5);
    const st = this.getState();
    try {
      if (st.state === STATES.DRAFT && newStability >= THRESHOLDS.T1) {
        this.transition(STATES.SHAPING, 'Stability crossed T1');
      } else if (st.state === STATES.SHAPING && newStability >= THRESHOLDS.T2) {
        this.transition(STATES.REFINING, 'Stability crossed T2');
      } else if (st.state === STATES.REFINING && newStability >= THRESHOLDS.T3) {
        this.transition(STATES.PRE_PUBLISH, 'Stability crossed T3');
      }
    } catch {} // invalid transitions are silently skipped

    // Update stability in state
    const finalState = this.getState();
    writeState(this.bookId, { ...finalState, stability: newStability, updatedAt: new Date().toISOString() });

    return {
      agentOutputs,
      artDirectorDecision,
      suppressedAgents: [...suppressedAgents],
      loops,
      state: this.getState(),
      stability: newStability,
    };
  }
}

module.exports = { BookOrchestrator, STATES, EVENT_TYPES, THRESHOLDS, verifyChain, readEvents };
