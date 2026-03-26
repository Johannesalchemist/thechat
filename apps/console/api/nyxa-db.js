'use strict';
// ── Nyxa DB — SQLite persistence layer ────────────────────────────────────────
// Implements the persistence contract:
//   - Sessions are the primary entity
//   - State is always fully hydrated before rule engine runs
//   - Writes are explicit and atomic
//   - Avoidance write-lock persists across turns

const Database = require('better-sqlite3');
const path = require('path');
const fs   = require('fs');

const DB_DIR  = path.join(__dirname, '../../../data');
const DB_PATH = path.join(DB_DIR, 'nyxa.sqlite');

if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const db = new Database(DB_PATH);

// ── Schema ────────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    session_id      TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL DEFAULT 'guest',
    session_state   TEXT NOT NULL DEFAULT '{}',
    behavior_state  TEXT NOT NULL DEFAULT '{}',
    curriculum_state TEXT NOT NULL DEFAULT '{}',
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

  CREATE TABLE IF NOT EXISTS learner_profiles (
    user_id     TEXT PRIMARY KEY,
    profile     TEXT NOT NULL DEFAULT '{}',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS curriculum_progress (
    key             TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL,
    curriculum_id   TEXT NOT NULL,
    progress        TEXT NOT NULL DEFAULT '{}',
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_progress_user ON curriculum_progress(user_id);
`);

// ── Prepared statements ───────────────────────────────────────────────────────
const stmts = {
  getSession:    db.prepare('SELECT * FROM sessions WHERE session_id = ?'),
  upsertSession: db.prepare(`
    INSERT INTO sessions (session_id, user_id, session_state, behavior_state, curriculum_state, created_at, updated_at)
    VALUES (@session_id, @user_id, @session_state, @behavior_state, @curriculum_state, @created_at, @updated_at)
    ON CONFLICT(session_id) DO UPDATE SET
      session_state    = excluded.session_state,
      behavior_state   = excluded.behavior_state,
      curriculum_state = excluded.curriculum_state,
      updated_at       = excluded.updated_at
  `),
  getUserSessions: db.prepare('SELECT session_id, user_id, created_at, updated_at FROM sessions WHERE user_id = ? ORDER BY updated_at DESC LIMIT 20'),

  getLearner:    db.prepare('SELECT * FROM learner_profiles WHERE user_id = ?'),
  upsertLearner: db.prepare(`
    INSERT INTO learner_profiles (user_id, profile, created_at, updated_at)
    VALUES (@user_id, @profile, @created_at, @updated_at)
    ON CONFLICT(user_id) DO UPDATE SET
      profile    = excluded.profile,
      updated_at = excluded.updated_at
  `),

  getProgress:    db.prepare('SELECT * FROM curriculum_progress WHERE key = ?'),
  upsertProgress: db.prepare(`
    INSERT INTO curriculum_progress (key, user_id, curriculum_id, progress, created_at, updated_at)
    VALUES (@key, @user_id, @curriculum_id, @progress, @created_at, @updated_at)
    ON CONFLICT(key) DO UPDATE SET
      progress   = excluded.progress,
      updated_at = excluded.updated_at
  `)
};

const now = () => new Date().toISOString();

// ── Default session state ─────────────────────────────────────────────────────
function defaultSessionState() {
  return {
    cluster: null, depth: 'low', confidence: 0, stability: 'stable',
    environment_tone: 'neutral', stability_indicator: 0.5,
    subtype: null, tick_rate_modifier: 1.0, intent: null,
    behavior_signals: { verbosity: 0, certainty: 0.5, repetition: 0, hesitation: 0 },
    avoidance: { detected: false, type: 'none', strength: 0, pattern: 'none' },
    avoidance_state: 'NORMAL', write_locked: false,
    classification_metadata: { model_confidence: 0, fallback_used: true }
  };
}

function defaultBehaviorState() {
  return { tone: 'neutral', pace: 'moderate', guidance_level: 'medium', response_style: 'reflective' };
}

function defaultCurriculumState() {
  return { level_name: null, current_node: null, completed_nodes: [], mastery: {} };
}

// ── Hydration + validation ────────────────────────────────────────────────────
function parse(raw, fallback) {
  try { return JSON.parse(raw) || fallback; } catch { return fallback; }
}

function hydrateSession(row) {
  const ss = { ...defaultSessionState(), ...parse(row.session_state, {}) };
  const bs = { ...defaultBehaviorState(), ...parse(row.behavior_state, {}) };
  const cs = { ...defaultCurriculumState(), ...parse(row.curriculum_state, {}) };
  return {
    session_id:       row.session_id,
    user_id:          row.user_id,
    session_state:    ss,
    behavior_state:   bs,
    curriculum_state: cs,
    created_at:       row.created_at,
    updated_at:       row.updated_at
  };
}

function validateHydration(session) {
  const ss = session.session_state;
  if (!ss.avoidance || typeof ss.write_locked === 'undefined') {
    // Patch instead of throw — partial state is recoverable
    session.session_state = { ...defaultSessionState(), ...ss };
  }
  return session;
}

// ── Public API ────────────────────────────────────────────────────────────────
function getSession(sessionId) {
  const row = stmts.getSession.get(sessionId);
  if (!row) return null;
  return validateHydration(hydrateSession(row));
}

function upsertSession(sessionId, userId, { session_state, behavior_state, curriculum_state }) {
  stmts.upsertSession.run({
    session_id:       sessionId,
    user_id:          userId || 'guest',
    session_state:    JSON.stringify(session_state || {}),
    behavior_state:   JSON.stringify(behavior_state || {}),
    curriculum_state: JSON.stringify(curriculum_state || {}),
    created_at:       now(),
    updated_at:       now()
  });
}

function getUserSessions(userId) {
  return stmts.getUserSessions.all(userId);
}

// checkAvoidanceLock — must be called after hydration, before rule engine
// Returns lock status so caller can gate state mutations
function checkAvoidanceLock(session) {
  const ss = session && session.session_state || {};
  return {
    locked:          ss.write_locked === true,
    avoidance_state: ss.avoidance_state || 'NORMAL',
    subtype:         ss.subtype || null
  };
}

// commitSession — atomic SQLite transaction for all three state columns
// Use this instead of upsertSession whenever session_state, behavior_state,
// and curriculum_state must be written as a single consistent unit.
const _txCommit = db.transaction((params) => {
  stmts.upsertSession.run(params);
});

function commitSession(sessionId, userId, { session_state, behavior_state, curriculum_state }) {
  _txCommit({
    session_id:       sessionId,
    user_id:          userId || 'guest',
    session_state:    JSON.stringify(session_state || {}),
    behavior_state:   JSON.stringify(behavior_state || {}),
    curriculum_state: JSON.stringify(curriculum_state || {}),
    created_at:       now(),
    updated_at:       now()
  });
}

// Assessment write path — returns { session, delta }; never writes to DB directly.
// Caller is responsible for committing delta inside an atomic upsert.
function applyAssessment(session, assessmentResult) {
  const cs = { ...session.curriculum_state };
  const nodeId = assessmentResult.node_id;
  const previousNode = cs.current_node;
  if (!cs.mastery)          cs.mastery = {};
  if (!cs.completed_nodes)  cs.completed_nodes = [];

  cs.mastery[nodeId] = assessmentResult.mastery;
  let advanced = false;

  if (assessmentResult.passed && !cs.completed_nodes.includes(nodeId)) {
    cs.completed_nodes.push(nodeId);
    if (assessmentResult.next_node && assessmentResult.next_node !== cs.current_node) {
      cs.current_node = assessmentResult.next_node;
      advanced = true;
    }
  }

  return {
    session: { ...session, curriculum_state: cs },
    delta: {
      node_id:        nodeId,
      mastery:        assessmentResult.mastery,
      advanced,
      previous_node:  previousNode,
      current_node:   cs.current_node,
      completed_nodes: cs.completed_nodes
    }
  };
}

// Learner profile
function getLearner(userId) {
  const row = stmts.getLearner.get(userId);
  if (!row) return null;
  return parse(row.profile, {});
}

function upsertLearner(userId, profileData) {
  const existing = getLearner(userId) || {};
  stmts.upsertLearner.run({
    user_id:    userId,
    profile:    JSON.stringify({ ...existing, ...profileData, updated_at: now() }),
    created_at: now(),
    updated_at: now()
  });
}

// Curriculum progress (proxies existing contract)
function getProgress(userId, curriculumId) {
  const key = `${userId}::${curriculumId}`;
  const row = stmts.getProgress.get(key);
  if (!row) return null;
  return parse(row.progress, {});
}

function upsertProgress(userId, curriculumId, progress) {
  const key = `${userId}::${curriculumId}`;
  stmts.upsertProgress.run({
    key, user_id: userId, curriculum_id: curriculumId,
    progress:   JSON.stringify(progress),
    created_at: now(), updated_at: now()
  });
}


// ── Session-type evolution ────────────────────────────────────────────────────
// Session-type is a fixed anchor at cold-start, but can evolve when the
// dominant cluster has shifted and stability is sustained for 3+ turns.
// Returns { session_state, evolved, previous_type, new_type }

const CLUSTER_TO_SESSION_TYPE = {
  exploration: 'exploratory',
  friction:    'uncertain',
  analytical:  'task',
  reflective:  'learning'
};

function evolveSessionType(session, qce) {
  if (!session || !qce) return { session_state: session?.session_state, evolved: false };

  const ss = { ...session.session_state };
  const currentType  = ss.inferred_session_type || 'exploratory';

  // B — Single evolution lock: no-op if already evolved once
  if (ss.type_locked) {
    return { session_state: ss, evolved: false, previous_type: currentType, new_type: currentType };
  }

  const stability    = qce.stability_indicator  || 0;
  const cluster      = qce.cluster              || null;
  const impliedType  = CLUSTER_TO_SESSION_TYPE[cluster];

  // Increment or reset stable-turn counter
  if (stability >= 0.8 && impliedType && impliedType !== currentType) {
    ss.stable_turns_toward = (ss.stable_turns_toward || 0) + 1;
  } else {
    ss.stable_turns_toward = 0;
  }

  // Evolution threshold: 3 consecutive stable turns with a shifted type
  if (ss.stable_turns_toward >= 3 && impliedType && impliedType !== currentType) {
    const previous_type = currentType;
    ss.inferred_session_type = impliedType;
    ss.stable_turns_toward   = 0;
    ss.type_locked           = true;   // lock after first evolution
    return { session_state: ss, evolved: true, previous_type, new_type: impliedType };
  }

  return { session_state: ss, evolved: false, previous_type: currentType, new_type: currentType };
}

module.exports = {
  getSession, upsertSession, getUserSessions,
  commitSession, checkAvoidanceLock,
  applyAssessment, evolveSessionType,
  getLearner, upsertLearner,
  getProgress, upsertProgress,
  hydrateSession, validateHydration, defaultSessionState, defaultBehaviorState, defaultCurriculumState
};
