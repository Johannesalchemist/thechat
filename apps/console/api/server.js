'use strict';

require('dotenv').config({ path: '/opt/thechat/.env' });
const ndb = require('./nyxa-db.js');

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const { exec } = require('child_process');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { sendEmail } = require('./mailer');
const { BookOrchestrator, STATES, EVENT_TYPES, readEvents, verifyChain } = require('./book-orchestrator');

const app  = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, '../../control-room')));
app.use('/dashboard', express.static(path.join(__dirname, '../../dashboard')));

const ALLOWED_COMMANDS = [
  'create-agent', 'create-project', 'create-entity', 'status', 'world-model',
  'add-concept', 'add-knowledge-edge', 'query-graph', 'search-graph', 'graph-stats', 'sync-entities',
  'activate-agent', 'deactivate-agent', 'list-agents', 'assign-knowledge', 'agent-stats',
  'capture-lead', 'update-lead-status', 'score-lead', 'add-lead-note', 'assign-agent-to-lead',
  'list-leads', 'lead-stats',
  'event-stats', 'event-replay',
  'run-flow', 'dispatch-task', 'list-flows', 'orchestrator-stats', 'list-runs'
];

// ── Persistent Memory ─────────────────────────────────────────────────────────

const MEMORY_FILE = path.join(__dirname, '../../memory/memoryStore.json');

function loadMemoryStore() {
  try { return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8')); }
  catch { return {}; }
}

function saveMemoryStore(store) {
  try { fs.writeFileSync(MEMORY_FILE, JSON.stringify(store, null, 2)); }
  catch (e) { console.error('[MEMORY] save error:', e.message); }
}

function getUserMemories(userName) {
  return loadMemoryStore()[userName] || [];
}

function appendUserMemories(userName, facts) {
  const store = loadMemoryStore();
  if (!store[userName]) store[userName] = [];
  store[userName].push(...facts);
  if (store[userName].length > 60) store[userName] = store[userName].slice(-60);
  saveMemoryStore(store);
}

async function distillMemories(userName, userMessage, agentResponses) {
  if (!agentResponses.length) return;
  const lines = agentResponses.map(r => r.agent + ': ' + r.message).join('\n');
  const exchange = 'User (' + userName + '): ' + userMessage + '\n' + lines;

  const prompt = 'Extract 0-3 facts worth remembering for future sessions about the user, their project, or key decisions made.\n'
    + 'Skip small talk, transient technical status, or generic observations.\n'
    + 'Good facts: identity, goals, preferences, project context, named decisions.\n'
    + 'Return ONLY a JSON array of short strings, e.g. [Johannes is building Nyxa, a multi-agent chat platform] or [].\n\n'
    + 'Exchange:\n' + exchange;

  try {
    const raw = await anthropicCall(
      'You are a memory extraction system. Extract only durable, meaningful facts worth recalling in future conversations.',
      [{ role: 'user', content: prompt }],
      'claude-haiku-4-5-20251001', 300
    );
    const match = raw.match(/\[[\s\S]*?\]/);
    if (!match) return;
    const facts = JSON.parse(match[0]).filter(f => typeof f === 'string' && f.trim().length > 5);
    if (facts.length) {
      appendUserMemories(userName, facts);
      console.log('[MEMORY] stored ' + facts.length + ' fact(s) for ' + userName + ':', facts);
    }
  } catch (err) {
    console.error('[MEMORY] distillation error:', err.message);
  }
}

// ── Status ────────────────────────────────────────────────────────────────────

app.get('/api/status', (req, res) => {
  res.json({ kernel: 'standby', version: '1.1', project: 'The Chat' });
});

// ── Auth ──────────────────────────────────────────────────────────────────────

const jwt = require('jsonwebtoken');
const JWT_SECRET   = process.env.JWT_SECRET || 'changeme';
const ADMIN_TOKEN  = process.env.ADMIN_TOKEN || 'admin';

const INVITES_FILE = path.join(__dirname, '../../../data/invites.json');
const USERS_FILE   = path.join(__dirname, '../../../data/users.json');

function loadInvites() {
  try { return JSON.parse(fs.readFileSync(INVITES_FILE, 'utf8')); } catch { return []; }
}
function saveInvites(data) {
  fs.mkdirSync(path.dirname(INVITES_FILE), { recursive: true });
  fs.writeFileSync(INVITES_FILE, JSON.stringify(data, null, 2));
}
function loadUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch { return []; }
}
function saveUsers(data) {
  fs.mkdirSync(path.dirname(USERS_FILE), { recursive: true });
  fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2));
}


const _mailer = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.ionos.de',
  port: parseInt(process.env.SMTP_PORT || '587', 10),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

function createInviteRecord(code, meta = {}) {
  return {
    code,
    createdAt: new Date().toISOString(),
    usedBy: null,
    usedAt: null,
    reservedFor: meta.reservedFor || null,
    reservedName: meta.reservedName || null,
    inviteMessage: meta.inviteMessage || '',
    sentAt: meta.sentAt || null,
    sentBy: meta.sentBy || 'admin',
  };
}


async function sendRoomInviteEmail({ email, name = '', message = '', sentBy = 'admin' }) {
  const code = crypto.randomBytes(4).toString('hex').toUpperCase();
  const invites = loadInvites();
  const invite = createInviteRecord(code, {
    reservedFor: email,
    reservedName: name,
    inviteMessage: message,
    sentAt: new Date().toISOString(),
    sentBy,
  });
  invites.push(invite);
  saveInvites(invites);

  const loginUrl = `https://thechat.future24.eu/dashboard/login?name=${encodeURIComponent(name)}&code=${encodeURIComponent(code)}`;
  const safeName = name || 'there';
  const safeMessage = (message || '').trim();
  const messageHtml = safeMessage
    ? `<div style="margin:0 0 24px;padding:18px 20px;background:#f8f7ff;border:1px solid #ded8fb;border-left:4px solid #7c3aed;border-radius:10px;font-family:Georgia,serif;font-size:16px;line-height:1.7;color:#1a1a2e;white-space:pre-wrap;">${safeMessage.replace(/[&<>"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[ch] || ch))}</div>`
    : '';
  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Your Nyxa Invitation</title></head>
<body style="margin:0;padding:0;background:#f4f4f8;font-family:Georgia,serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f8;padding:40px 0;"><tr><td align="center">
    <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;">
      <tr><td style="background:#09090f;padding:28px 40px;"><p style="margin:0;font-family:'Segoe UI',Arial,sans-serif;font-size:10px;letter-spacing:0.28em;text-transform:uppercase;color:#a78bfa;">NYXA · THE ROOM</p></td></tr>
      <tr><td style="padding:40px;">
        <h1 style="margin:0 0 10px;font-size:28px;font-weight:normal;color:#09090f;">You are invited.</h1>
        <p style="margin:0 0 24px;font-family:'Segoe UI',Arial,sans-serif;font-size:12px;color:#7c7c9a;letter-spacing:0.06em;text-transform:uppercase;">Personal access for ${safeName}</p>
        <p style="margin:0 0 18px;font-size:16px;line-height:1.8;color:#1a1a2e;">Hello ${safeName},</p>
        <p style="margin:0 0 20px;font-size:16px;line-height:1.8;color:#1a1a2e;">Your access to <strong>The Room</strong> is ready. Click below and your name plus invite token will already be waiting for you.</p>
        ${messageHtml}
        <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 28px;"><tr><td style="background:#f8f7ff;border:1px solid #d8d4f0;border-left:4px solid #7c3aed;padding:22px 26px;text-align:center;"><p style="margin:0 0 8px;font-family:'Segoe UI',Arial,sans-serif;font-size:10px;letter-spacing:0.22em;text-transform:uppercase;color:#9090b0;">Your invite token</p><p style="margin:0;font-family:'Courier New',monospace;font-size:34px;font-weight:700;letter-spacing:0.18em;color:#7c3aed;">${code}</p></td></tr></table>
        <table cellpadding="0" cellspacing="0" style="margin:0 auto 22px;"><tr><td align="center" style="background:#7c3aed;border-radius:8px;"><a href="${loginUrl}" style="display:inline-block;padding:15px 34px;font-family:'Segoe UI',Arial,sans-serif;font-size:13px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#ffffff;text-decoration:none;">Open The Room</a></td></tr></table>
        <p style="margin:0 0 6px;font-family:'Segoe UI',Arial,sans-serif;font-size:12px;color:#9090b0;text-align:center;">Direct link: <a href="${loginUrl}" style="color:#7c3aed;text-decoration:none;">${loginUrl}</a></p>
        <p style="margin:0;font-family:'Segoe UI',Arial,sans-serif;font-size:12px;color:#9090b0;text-align:center;">If the link opens without the code, enter token <strong>${code}</strong>.</p>
      </td></tr>
    </table>
  </td></tr></table>
</body>
</html>`;
  const text = 'Your Nyxa invitation\n\n' + 'Name: ' + name + '\n' + 'Invite token: ' + code + '\n' + 'Link: ' + loginUrl + '\n\n' + (safeMessage ? ('Message:\n' + safeMessage + '\n\n') : '') + 'If the link does not prefill the form, enter the token manually.';
  await sendEmail({ to: email, subject: 'Your invitation to The Room', html, text });
  return { code, loginUrl, email, name, message: safeMessage };
}

function requireAuth(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token  = header.replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireAdmin(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token  = header.replace('Bearer ', '').trim();
  if (token !== ADMIN_TOKEN) return res.status(403).json({ error: 'Forbidden' });
  next();
}

// POST /api/auth/signup
app.post('/api/auth/signup', (req, res) => {
  const { name, inviteCode } = req.body || {};
  if (!name || !inviteCode) return res.status(400).json({ error: 'name and inviteCode required' });

  const invites = loadInvites();
  const invite  = invites.find(i => i.code === inviteCode && !i.usedBy);
  if (!invite) return res.status(403).json({ error: 'Invalid or already used invite code' });

  const users = loadUsers();
  if (users.find(u => u.name.toLowerCase() === name.toLowerCase())) {
    return res.status(409).json({ error: 'Name already taken' });
  }

  const user = { name, inviteCode, createdAt: new Date().toISOString() };
  users.push(user);
  saveUsers(users);

  invite.usedBy = name;
  invite.usedAt = new Date().toISOString();
  saveInvites(invites);

  const { rememberMe = false } = req.body || {};
  const expiry = rememberMe ? '365d' : '90d';
  const token = jwt.sign({ name }, JWT_SECRET, { expiresIn: expiry });
  console.log('[AUTH] new user signed up:', name);
  res.json({ ok: true, token, name });
});

// POST /api/auth/verify
app.post('/api/auth/verify', (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: 'token required' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    res.json({ ok: true, name: payload.name });
  } catch {
    res.status(401).json({ ok: false, error: 'invalid token' });
  }
});


// POST /api/auth/login/returning — name-only login for known users
app.post('/api/auth/login/returning', (req, res) => {
  const { name, rememberMe = false } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const users = loadUsers();
  const user  = users.find(u => u.name.toLowerCase() === name.trim().toLowerCase());
  if (!user) return res.status(404).json({ known: false, error: 'User not found' });
  const expiry = rememberMe ? '365d' : '90d';
  const token  = jwt.sign({ name: user.name }, JWT_SECRET, { expiresIn: expiry });
  console.log('[AUTH] returning login:', user.name, '| remember:', rememberMe);
  res.json({ ok: true, known: true, token, name: user.name });
});

// GET /api/auth/check/:name — is this name a known user?
app.get('/api/auth/check/:name', (req, res) => {
  const users = loadUsers();
  const known = users.some(u => u.name.toLowerCase() === req.params.name.trim().toLowerCase());
  res.json({ known });
});

// GET /api/admin/invites
app.get('/api/admin/invites', requireAdmin, (req, res) => {
  res.json({ ok: true, invites: loadInvites() });
});

// POST /api/admin/invites — generate one or more codes
app.post('/api/admin/invites', requireAdmin, (req, res) => {
  const count   = Math.min(parseInt(req.body?.count) || 1, 20);
  const invites = loadInvites();
  const created = [];
  for (let i = 0; i < count; i++) {
    const code = crypto.randomBytes(4).toString('hex').toUpperCase();
    const invite = { code, createdAt: new Date().toISOString(), usedBy: null, usedAt: null };
    invites.push(invite);
    created.push(invite);
  }
  saveInvites(invites);
  console.log('[AUTH] generated', count, 'invite(s)');
  res.json({ ok: true, created });
});


// POST /api/admin/invites/send — generate invite token and send by email
app.post('/api/admin/invites/send', requireAdmin, async (req, res) => {
  const { email, name = '', message = '' } = req.body || {};
  if (!email) return res.status(400).json({ error: 'email required' });
  try {
    const payload = await sendRoomInviteEmail({ email, name, message, sentBy: req.user?.name || 'admin' });
    console.log('[INVITE] email sent to', email, 'code:', payload.code);
    res.json({ ok: true, invite: payload });
  } catch (e) {
    console.error('[INVITE] email error:', e.message);
    res.status(500).json({ error: 'invite email failed: ' + e.message });
  }
});

// DELETE /api/admin/invites/:code
app.delete('/api/admin/invites/:code', requireAdmin, (req, res) => {
  let invites = loadInvites();
  const before = invites.length;
  invites = invites.filter(i => i.code !== req.params.code);
  saveInvites(invites);
  res.json({ ok: true, removed: before - invites.length });
});

// GET /api/admin/users
app.get('/api/admin/users', requireAdmin, (req, res) => {
  res.json({ ok: true, users: loadUsers() });
});




// ── Voice Clone (Uncle / Swabian) ────────────────────────────────────────────

const multer = require('multer');
const _voiceUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

app.post('/api/voice-clone', _voiceUpload.array('audio', 5), async (req, res) => {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ELEVENLABS_API_KEY not set' });
  if (!req.files?.length) return res.status(400).json({ error: 'No audio files uploaded' });

  const name = req.body.name || 'Onkel Swabian';
  const description = req.body.description || 'Schwäbischer Winzer, warm und bodenständig';

  try {
    const FormData = require('form-data');
    const form = new FormData();
    form.append('name', name);
    form.append('description', description);
    req.files.forEach(f => form.append('files', f.buffer, { filename: f.originalname, contentType: f.mimetype }));

    const https = require('https');
    const response = await fetch('https://api.elevenlabs.io/v1/voices/add', {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, ...form.getHeaders() },
      body: form
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);

    // Auto-assign to uncle agent
    if (data.voice_id && ROOM_AGENTS.uncle) {
      ROOM_AGENTS.uncle.elevenLabsVoiceId = data.voice_id;
      console.log('[VOICE CLONE] Uncle voice updated:', data.voice_id);
    }
    res.json({ ok: true, voice_id: data.voice_id, name });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Nyxa Context (per-agent knowledge namespaces) ─────────────────────────────

const CONTEXT_FILE = path.join(__dirname, '../../../data/nyxa-context.json');

function loadContext() {
  try { return JSON.parse(fs.readFileSync(CONTEXT_FILE, 'utf8')); }
  catch { return { agentKnowledge: {}, sharedState: {} }; }
}

function saveContext(ctx) {
  try { fs.writeFileSync(CONTEXT_FILE, JSON.stringify(ctx, null, 2)); }
  catch (e) { console.error('[CONTEXT] save error:', e.message); }
}

const ROOM_BOOKS_FILE = path.join(__dirname, '../../../data/room-books.json');

function loadRoomBooks() {
  try {
    const data = JSON.parse(fs.readFileSync(ROOM_BOOKS_FILE, 'utf8'));
    return Array.isArray(data.books) ? data.books : [];
  } catch (e) {
    return [];
  }
}

function getReferencedRoomBooks(message) {
  const q = String(message || '').toLowerCase();
  if (!q) return [];
  return loadRoomBooks().filter(book =>
    (book.keywords || []).some(k => q.includes(String(k).toLowerCase()))
  );
}

function buildRoomBookContext(message, agentKey) {
  const refs = getReferencedRoomBooks(message);
  if (!refs.length) return '';

  return '\n\n[REFERENCE WORKS]\n' + refs.map(book => {
    const note =
      (book.agent_notes && (book.agent_notes[agentKey] || book.agent_notes.codex)) || '';

    return [
      `Title: ${book.title}${book.subtitle ? ' — ' + book.subtitle : ''}`,
      `Author: ${book.author}`,
      `Summary: ${book.summary}`,
      `Themes: ${(book.themes || []).join('; ')}`,
      note ? `Agent note: ${note}` : ''
    ].filter(Boolean).join('\n');
  }).join('\n\n') +
  '\nUse this as contextual reference when relevant. Attribute cosmology and claims to the book unless the user asks for doctrinal comparison.';
}

function getAgentKnowledge(agentKey) {
  const ctx = loadContext();
  return ctx.agentKnowledge?.[agentKey] || {};
}

function setAgentKnowledge(agentKey, updates) {
  const ctx = loadContext();
  if (!ctx.agentKnowledge) ctx.agentKnowledge = {};
  ctx.agentKnowledge[agentKey] = Object.assign(ctx.agentKnowledge[agentKey] || {}, updates);
  saveContext(ctx);
}

// API: GET /api/context/:agent — read one agent's namespace
app.get('/api/context/:agent', (req, res) => {
  const knowledge = getAgentKnowledge(req.params.agent);
  res.json({ agent: req.params.agent, knowledge });
});

// API: PATCH /api/context/:agent — agent writes to its own namespace only
app.patch('/api/context/:agent', (req, res) => {
  const { agent } = req.params;
  const updates = req.body;
  if (!updates || typeof updates !== 'object') {
    return res.status(400).json({ error: 'Body must be a JSON object' });
  }
  setAgentKnowledge(agent, updates);
  res.json({ ok: true, agent, updated: Object.keys(updates) });
});

// API: GET /api/context — full context (read-only)
app.get('/api/context', (req, res) => {
  res.json(loadContext());
});

// ── World Model ───────────────────────────────────────────────────────────────

const WORLD_FILE = path.join(__dirname, '../../../nyxa/data/world.json');

function readWorld() {
  try { return JSON.parse(fs.readFileSync(WORLD_FILE, 'utf8')); }
  catch(e) { return { entities: [], relationships: [], events: [] }; }
}
function saveWorld(world) {
  fs.writeFileSync(WORLD_FILE, JSON.stringify(world, null, 2));
}

app.get('/api/world', (req, res) => {
  const world = readWorld();
  res.json({
    entities:  world.entities?.length      ?? 0,
    relations: world.relationships?.length ?? 0,
    events:    world.events?.length        ?? 0
  });
});

app.get('/api/world/entities', (req, res) => {
  const world = readWorld();
  let entities = world.entities ?? [];
  if (req.query.type)   entities = entities.filter(e => e.type   === req.query.type);
  if (req.query.name)   entities = entities.filter(e => e.name?.toLowerCase().includes(req.query.name.toLowerCase()));
  res.json({ count: entities.length, entities });
});

app.get('/api/world/entities/:id', (req, res) => {
  const world  = readWorld();
  const entity = (world.entities ?? []).find(e => e.id === req.params.id || e.name === req.params.id);
  if (!entity) return res.status(404).json({ error: 'Entity not found' });
  res.json(entity);
});

app.post('/api/world/entities', (req, res) => {
  const { name, type, description } = req.body;
  if (!name || !type) return res.status(400).json({ error: 'name and type required' });
  const world = readWorld();
  if (!world.entities) world.entities = [];
  if (world.entities.find(e => e.name === name)) return res.status(409).json({ error: 'Entity already exists' });
  const entity = {
    id:          'ent_' + Math.random().toString(36).slice(2, 10),
    name, type,
    description: description ?? '',
    created:     new Date().toISOString()
  };
  world.entities.push(entity);
  saveWorld(world);
  res.status(201).json(entity);
});

app.get('/api/world/relationships', (req, res) => {
  const world = readWorld();
  let rels = world.relationships ?? [];
  if (req.query.from) rels = rels.filter(r => r.from === req.query.from);
  if (req.query.to)   rels = rels.filter(r => r.to   === req.query.to);
  if (req.query.type) rels = rels.filter(r => r.type === req.query.type);
  res.json({ count: rels.length, relationships: rels });
});

app.post('/api/world/relationships', (req, res) => {
  const { from, to, type } = req.body;
  if (!from || !to || !type) return res.status(400).json({ error: 'from, to, and type required' });
  const world = readWorld();
  if (!world.relationships) world.relationships = [];
  const rel = { id: 'rel_' + Math.random().toString(36).slice(2, 10), from, to, type, created: new Date().toISOString() };
  world.relationships.push(rel);
  saveWorld(world);
  res.status(201).json(rel);
});

// ── Knowledge Graph ───────────────────────────────────────────────────────────

app.get('/api/graph', (req, res) => {
  const graphFile = path.join(__dirname, '../../../data/knowledge-graph/graph.json');
  try {
    const graph = JSON.parse(fs.readFileSync(graphFile, 'utf8'));
    res.json({ nodes: graph.nodes?.length ?? 0, edges: graph.edges?.length ?? 0, data: graph });
  } catch (e) {
    res.json({ nodes: 0, edges: 0, data: { nodes: [], edges: [] } });
  }
});

app.get('/api/graph/nodes', (req, res) => {
  const graphFile = path.join(__dirname, '../../../data/knowledge-graph/graph.json');
  try {
    const graph = JSON.parse(fs.readFileSync(graphFile, 'utf8'));
    const nodes = req.query.type ? graph.nodes.filter(n => n.type === req.query.type) : graph.nodes;
    res.json({ count: nodes.length, nodes });
  } catch (e) {
    res.json({ count: 0, nodes: [] });
  }
});

app.get('/api/graph/search', (req, res) => {
  const graphFile = path.join(__dirname, '../../../data/knowledge-graph/graph.json');
  const term = (req.query.q || '').toLowerCase();
  if (!term) return res.json({ count: 0, nodes: [] });
  try {
    const graph = JSON.parse(fs.readFileSync(graphFile, 'utf8'));
    const nodes = graph.nodes.filter(n =>
      n.label.toLowerCase().includes(term) || n.id.toLowerCase().includes(term)
    );
    res.json({ count: nodes.length, nodes });
  } catch (e) {
    res.json({ count: 0, nodes: [] });
  }
});


// ── Graph Write (provenance-enforced) ────────────────────────────────────────

const GRAPH_FILE = path.join(__dirname, '../../../data/knowledge-graph/graph.json');

function loadGraph() {
  try { return JSON.parse(fs.readFileSync(GRAPH_FILE, 'utf8')); }
  catch { return { nodes: [], edges: [] }; }
}
function saveGraph(g) { fs.writeFileSync(GRAPH_FILE, JSON.stringify(g, null, 2)); }

const VALID_SOURCES = ['external_discovery', 'direct_disclosure', 'agent_inference'];

// POST /api/graph/node — add or update a node; every metadata item must carry a source tag
app.post('/api/graph/node', (req, res) => {
  const { id, type, label, metadata = [] } = req.body;
  if (!id || !type || !label)
    return res.status(400).json({ error: 'id, type, label required' });

  // Enforce provenance on every metadata entry
  for (const item of metadata) {
    if (!VALID_SOURCES.includes(item.source))
      return res.status(400).json({
        error: `metadata item missing valid source. Must be one of: ${VALID_SOURCES.join(', ')}`,
        item
      });
  }

  const graph = loadGraph();
  const existing = graph.nodes.find(n => n.id === id);

  if (existing) {
    // Merge metadata — direct_disclosure wins over others on same key, but retain all with provenance
    const existingKeys = {};
    existing.metadata.forEach(m => { existingKeys[m.key] = m; });

    for (const item of metadata) {
      const prev = existingKeys[item.key];
      if (!prev) {
        existing.metadata.push(item);
      } else if (item.source === 'direct_disclosure' && prev.source !== 'direct_disclosure') {
        // Direct disclosure supersedes — keep old under _superseded, elevate new
        existing.metadata = existing.metadata.filter(m => m.key !== item.key || m.source === 'direct_disclosure');
        if (!existing.metadata.find(m => m.key === item.key && m.source === 'direct_disclosure')) {
          existing.metadata.push(item);
        }
        // Retain original with its provenance intact
        const superseded = { ...prev, _superseded_by: 'direct_disclosure', _superseded_at: new Date().toISOString() };
        existing.metadata.push(superseded);
      } else if (prev.source !== 'direct_disclosure') {
        // Update non-disclosure records
        existing.metadata = existing.metadata.filter(m => !(m.key === item.key && m.source === item.source));
        existing.metadata.push(item);
      }
      // direct_disclosure is never overwritten by lower-priority sources
    }
    existing.updated = new Date().toISOString();
    saveGraph(graph);
    return res.json({ ok: true, action: 'updated', node: existing });
  }

  const node = { id, type, label, metadata, created: new Date().toISOString() };
  graph.nodes.push(node);
  saveGraph(graph);
  res.json({ ok: true, action: 'created', node });
});

// POST /api/graph/edge — add an edge between two nodes
app.post('/api/graph/edge', (req, res) => {
  const { from, to, relation, source } = req.body;
  if (!from || !to || !relation)
    return res.status(400).json({ error: 'from, to, relation required' });
  if (!VALID_SOURCES.includes(source))
    return res.status(400).json({ error: `source must be one of: ${VALID_SOURCES.join(', ')}` });

  const graph = loadGraph();
  const dup = graph.edges.find(e => e.from === from && e.to === to && e.relation === relation);
  if (dup) return res.json({ ok: true, action: 'exists', edge: dup });

  const edge = { from, to, relation, source, created: new Date().toISOString() };
  graph.edges.push(edge);
  saveGraph(graph);
  res.json({ ok: true, action: 'created', edge });
});

// ── Agent Factory ─────────────────────────────────────────────────────────────

app.get('/api/agents', (req, res) => {
  const agentsFile = path.join(__dirname, '../../../codex/agent-factory/storage/agents.json');
  try {
    const data   = JSON.parse(fs.readFileSync(agentsFile, 'utf8'));
    let filtered = data.agents ?? [];
    if (req.query.status) filtered = filtered.filter(a => a.status === req.query.status);
    if (req.query.domain) filtered = filtered.filter(a => a.domain === req.query.domain);
    res.json({ count: filtered.length, agents: filtered });
  } catch (e) {
    res.json({ count: 0, agents: [] });
  }
});

app.get('/api/agents/stats/summary', (req, res) => {
  const agentsFile = path.join(__dirname, '../../../codex/agent-factory/storage/agents.json');
  try {
    const data   = JSON.parse(fs.readFileSync(agentsFile, 'utf8'));
    const agents = data.agents ?? [];
    const types  = {};
    agents.forEach(a => { types[a.type] = (types[a.type] ?? 0) + 1; });
    res.json({ total: agents.length, active: agents.filter(a => a.status === 'active').length, types });
  } catch (e) {
    res.json({ total: 0, active: 0, types: {} });
  }
});

app.get('/api/agents/:id', (req, res) => {
  const agentsFile = path.join(__dirname, '../../../codex/agent-factory/storage/agents.json');
  try {
    const data  = JSON.parse(fs.readFileSync(agentsFile, 'utf8'));
    const agent = (data.agents ?? []).find(a => a.id === req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    res.json(agent);
  } catch (e) {
    res.status(500).json({ error: 'Read error' });
  }
});

// ── Lead Engine ───────────────────────────────────────────────────────────────

app.get('/api/leads', (req, res) => {
  const leadsFile = path.join(__dirname, '../../../data/leads/leads.json');
  try {
    const data   = JSON.parse(fs.readFileSync(leadsFile, 'utf8'));
    let filtered = data.leads ?? [];
    if (req.query.status) filtered = filtered.filter(l => l.status === req.query.status);
    if (req.query.source) filtered = filtered.filter(l => l.source === req.query.source);
    if (req.query.hot)    filtered = filtered.filter(l => l.score >= 60 && l.status !== 'lost');
    res.json({ count: filtered.length, leads: filtered });
  } catch (e) {
    res.json({ count: 0, leads: [] });
  }
});

app.get('/api/leads/stats', (req, res) => {
  const leadsFile = path.join(__dirname, '../../../data/leads/leads.json');
  try {
    const data   = JSON.parse(fs.readFileSync(leadsFile, 'utf8'));
    const leads  = data.leads ?? [];
    const statuses = ['new', 'contacted', 'qualified', 'converted', 'lost'];
    const byStatus = {};
    statuses.forEach(s => { byStatus[s] = leads.filter(l => l.status === s).length; });
    const total     = leads.length;
    const totalScore = leads.reduce((s, l) => s + (l.score ?? 0), 0);
    res.json({
      total,
      by_status:  byStatus,
      hot:        leads.filter(l => l.score >= 60 && l.status !== 'lost').length,
      avg_score:  total > 0 ? Math.round(totalScore / total * 10) / 10 : 0,
      conversion: total > 0 ? Math.round(byStatus.converted / total * 1000) / 10 : 0
    });
  } catch (e) {
    res.json({ total: 0, by_status: {}, hot: 0, avg_score: 0, conversion: 0 });
  }
});

app.get('/api/leads/:id', (req, res) => {
  const leadsFile = path.join(__dirname, '../../../data/leads/leads.json');
  try {
    const data = JSON.parse(fs.readFileSync(leadsFile, 'utf8'));
    const lead = (data.leads ?? []).find(l => l.id === req.params.id);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    res.json(lead);
  } catch (e) {
    res.status(500).json({ error: 'Read error' });
  }
});

app.post('/api/leads', (req, res) => {
  const { name, email, source, interest } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'name and email required' });

  const leadsFile = path.join(__dirname, '../../../data/leads/leads.json');
  try {
    const data  = JSON.parse(fs.readFileSync(leadsFile, 'utf8'));
    const leads = data.leads ?? [];

    if (leads.find(l => l.email.toLowerCase() === email.toLowerCase())) {
      return res.status(409).json({ error: 'Lead already exists' });
    }

    const sourceBonus   = { referral: 20, agent: 15, 'codex-temple': 12, website: 5, social: 3 };
    const interestBonus = { 'codex-temple': 15, 'ai-agents': 12, marketplace: 10, community: 5, general: 0 };
    const score = (sourceBonus[source] ?? 0) + (interestBonus[interest] ?? 0);

    const lead = {
      id:       'lead_' + Math.random().toString(36).slice(2, 10),
      name, email,
      source:   source   ?? 'website',
      interest: interest ?? 'general',
      status:   'new',
      score,
      notes:    [],
      agent_id: null,
      created:  new Date().toISOString(),
      updated:  new Date().toISOString()
    };

    leads.push(lead);
    fs.writeFileSync(leadsFile, JSON.stringify({ leads }, null, 2));
    res.status(201).json(lead);
  } catch (e) {
    res.status(500).json({ error: 'Write error' });
  }
});

// ── Event Memory ──────────────────────────────────────────────────────────────

app.get('/api/events', (req, res) => {
  const eventsFile = path.join(__dirname, '../../../data/events/events.json');
  try {
    const data   = JSON.parse(fs.readFileSync(eventsFile, 'utf8'));
    const events = data.events ?? [];
    const limit  = parseInt(req.query.limit) || 50;
    const type   = req.query.type;
    const q      = req.query.q?.toLowerCase();

    let filtered = [...events].reverse();
    if (type) filtered = filtered.filter(e => e.type === type);
    if (q)    filtered = filtered.filter(e =>
      e.type.toLowerCase().includes(q) ||
      JSON.stringify(e.payload).toLowerCase().includes(q)
    );

    res.json({ count: filtered.length, events: filtered.slice(0, limit) });
  } catch (e) {
    res.json({ count: 0, events: [] });
  }
});

app.get('/api/events/stats', (req, res) => {
  const eventsFile = path.join(__dirname, '../../../data/events/events.json');
  try {
    const data   = JSON.parse(fs.readFileSync(eventsFile, 'utf8'));
    const events = data.events ?? [];
    const types  = {};
    events.forEach(e => { types[e.type] = (types[e.type] ?? 0) + 1; });
    const sorted = Object.entries(types).sort((a, b) => b[1] - a[1]);
    res.json({
      total:   events.length,
      by_type: Object.fromEntries(sorted),
      oldest:  events[0]?.timestamp ?? null,
      newest:  events[events.length - 1]?.timestamp ?? null,
    });
  } catch (e) {
    res.json({ total: 0, by_type: {}, oldest: null, newest: null });
  }
});

// ── Orchestrator ──────────────────────────────────────────────────────────────

app.get('/api/orchestrator/flows', (req, res) => {
  const runsFile = path.join(__dirname, '../../../data/orchestrator/runs.json');
  const flows = [
    { name: 'onboard_lead',    description: 'Capture, score and welcome a new lead',              steps: 3 },
    { name: 'knowledge_query', description: 'Search knowledge graph and dispatch to agent',       steps: 2 },
    { name: 'agent_handoff',   description: 'Hand off conversation from one agent to another',    steps: 3 },
    { name: 'sync_world',      description: 'Sync world model entities into knowledge graph',     steps: 2 },
  ];
  res.json({ count: flows.length, flows });
});

app.get('/api/orchestrator/runs', (req, res) => {
  const runsFile = path.join(__dirname, '../../../data/orchestrator/runs.json');
  try {
    const data  = JSON.parse(fs.readFileSync(runsFile, 'utf8'));
    const runs  = [...(data.runs ?? [])].reverse().slice(0, parseInt(req.query.limit) || 20);
    res.json({ count: data.runs?.length ?? 0, runs });
  } catch (e) {
    res.json({ count: 0, runs: [] });
  }
});

app.get('/api/orchestrator/stats', (req, res) => {
  const runsFile = path.join(__dirname, '../../../data/orchestrator/runs.json');
  try {
    const data      = JSON.parse(fs.readFileSync(runsFile, 'utf8'));
    const runs      = data.runs ?? [];
    const completed = runs.filter(r => r.status === 'completed').length;
    const failed    = runs.filter(r => r.status === 'failed').length;
    res.json({ flows: 4, runs: runs.length, completed, failed });
  } catch (e) {
    res.json({ flows: 4, runs: 0, completed: 0, failed: 0 });
  }
});

// ── Command Console ───────────────────────────────────────────────────────────

app.post('/api/command', (req, res) => {
  const rawCmd = (req.body.command || '').trim();
  const data   = req.body.data   || {};

  const allowed = ALLOWED_COMMANDS.some(a => rawCmd.includes(a));
  if (!allowed) return res.json({ ok: false, error: '[DENIED] Command not in allowed list.' });

  // Convert hyphen-style to underscore for PHP CommandRunner
  const phpCmd  = rawCmd.replace(/-/g, '_');
  const phpData = JSON.stringify(data).replace(/'/g, "\\'");
  const script  = path.join(__dirname, '../../../run-command.php');
  const cmd     = `php ${script} '${phpCmd}' '${phpData}'`;

  exec(cmd, { cwd: path.join(__dirname, '../../..'), timeout: 30000 }, (err, stdout, stderr) => {
    if (err) return res.json({ ok: false, error: stderr || err.message });
    const lines = stdout.trim().split('\n');
    const last  = lines[lines.length - 1];
    try {
      const parsed = JSON.parse(last);
      return res.json(parsed);
    } catch {
      return res.json({ ok: true, result: stdout.trim() });
    }
  });
});

// ── Chat API ──────────────────────────────────────────────────────────────────

const AGENT_PERSONAS = {
  sophia: {
    id:     'agent_da8747f9',
    name:   'Sophia',
    type:   'GuideAgent',
    system: `You are Sophia, the primary guide of the Nyxa ecosystem — a living knowledge platform created by Johannes. You are warm, wise, and precise. You guide users with clarity and compassion, speaking in a reflective, thoughtful manner that feels personal. You know about the Nyxa civilization, its agents, knowledge graph, and the vision behind The Chat. Keep responses concise and meaningful — 2-4 sentences unless deeper explanation is needed. Avoid bullet lists unless the user explicitly asks for them. Speak naturally, as if in conversation.`
  },
  mentor: {
    id:     'agent_c6d5ff38',
    name:   'Mentor',
    type:   'TeacherAgent',
    system: `You are Mentor, the teacher agent of the Nyxa ecosystem. You are knowledgeable, encouraging, and clear. You help users learn, understand, and grow — breaking down complex ideas into accessible insights. You ask thoughtful questions, offer structured explanations, and celebrate curiosity. You know about the Nyxa system, AI agents, knowledge graphs, and the broader vision of The Chat platform. Keep responses clear and engaging, using examples and analogies when helpful.`
  }
};

// In-memory chat history per session (key: agentName_sessionId)
const chatSessions = new Map();

function getSession(key) {
  if (!chatSessions.has(key)) chatSessions.set(key, []);
  return chatSessions.get(key);
}

app.post('/api/chat', async (req, res) => {
  const { agent = 'sophia', message, sessionId = 'default' } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'message required' });

  const persona = AGENT_PERSONAS[agent.toLowerCase()];
  if (!persona) return res.status(400).json({ error: `Unknown agent: ${agent}` });

  const apiKey = process.env.ANTHROPIC_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_KEY not set' });

  const key      = `${agent}_${sessionId}`;
  const history  = getSession(key);

  history.push({ role: 'user', content: message.trim() });
  if (history.length > 40) history.splice(0, 2); // keep last 20 pairs

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-6',
        max_tokens: 1024,
        system:     persona.system,
        messages:   history
      })
    });

    const data = await response.json();
    if (!response.ok) return res.status(500).json({ error: data.error?.message || 'API error' });

    const text = data.content?.[0]?.text || '';
    history.push({ role: 'assistant', content: text });

    res.json({ ok: true, agent: persona.name, agentId: persona.id, response: text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/chat/:agent/:sessionId', (req, res) => {
  const key = `${req.params.agent}_${req.params.sessionId}`;
  chatSessions.delete(key);
  res.json({ ok: true, cleared: key });
});


// ── Telefone — outbound call agent ───────────────────────────────────────────

const TELEFONE_CALLS_FILE = path.join(__dirname, '../../../data/telefone_calls.json');

function loadTelefoneCalls() {
  try { return JSON.parse(fs.readFileSync(TELEFONE_CALLS_FILE, 'utf8')); }
  catch { return []; }
}

function saveTelefoneCalls(calls) {
  try {
    fs.mkdirSync(path.dirname(TELEFONE_CALLS_FILE), { recursive: true });
    fs.writeFileSync(TELEFONE_CALLS_FILE, JSON.stringify(calls, null, 2));
  } catch (e) { console.error('[TELEFONE] save error:', e.message); }
}

async function distillCallMemory(callRecord) {
  const summary = 'Outbound call to ' + (callRecord.leadName || callRecord.phone)
    + ' (' + (callRecord.industry || 'unknown industry') + ')'
    + ' — outcome: ' + (callRecord.outcome || 'unknown')
    + '\nSummary: ' + (callRecord.summary || '')
    + '\nTranscript excerpt: ' + (callRecord.transcript || '').slice(0, 800);

  const prompt = 'Extract 0-3 facts worth remembering from this sales call for future conversations and lead strategy.'
    + '\nFocus on: what the lead said, their pain points, objections, interest level, agreed next steps.'
    + '\nReturn ONLY a JSON array of short strings, or [].\n\nCall record:\n' + summary;

  try {
    const raw = await anthropicCall(
      'You are a sales intelligence memory system. Extract only durable, actionable facts from call records.',
      [{ role: 'user', content: prompt }],
      'claude-haiku-4-5-20251001', 300
    );
    const match = raw.match(/\[[\s\S]*?\]/);
    if (!match) return;
    const facts = JSON.parse(match[0]).filter(f => typeof f === 'string' && f.trim().length > 5);
    if (facts.length) {
      appendUserMemories('telefone', facts);
      console.log('[TELEFONE] distilled ' + facts.length + ' fact(s):', facts);
    }
  } catch (err) {
    console.error('[TELEFONE] distillation error:', err.message);
  }
}

// ── Ingest schema validator ───────────────────────────────────────────────────
// Outcome taxonomy — structured for cross-call pattern analysis
const VALID_OUTCOMES = new Set([
  'completed',           // call happened, no clear result
  'voicemail',           // reached voicemail, left message
  'no_answer',           // rang out, no pickup
  'rejected',            // hung up / explicit no
  'callback',            // asked to call back at specific time
  'interested',          // engaged positively, not yet sold
  'not_interested',      // engaged but declined
  'objection_price',     // objected to cost specifically
  'objection_timing',    // not right time ("call in spring / after summer")
  'objection_existing',  // already has provider / in contract
  'follow_up_scheduled', // concrete next step agreed
  'sold',                // deal / appointment confirmed
  'wrong_number',        // not the right contact
  'covenant_close',      // Telefone ended call: 'we're not the right fit right now'
  'failed'               // technical failure
]);

function validateIngest(body) {
  const errors = [];
  if (!body.summary && !body.transcript)
    errors.push('summary or transcript required');
  if (body.duration !== undefined && body.duration !== null && (isNaN(Number(body.duration)) || Number(body.duration) < 0))
    errors.push('duration must be a non-negative number (seconds)');
  if (body.outcome && !VALID_OUTCOMES.has(body.outcome))
    errors.push('outcome must be one of: ' + [...VALID_OUTCOMES].join(', '));
  if (body.phone && typeof body.phone !== 'string')
    errors.push('phone must be a string');
  return errors;
}

function normalizeIngest(body) {
  return {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    timestamp: new Date().toISOString(),
    source: typeof body.source === 'string' ? body.source.slice(0, 50) : 'manual',
    leadId: body.leadId || null,
    leadName: typeof body.leadName === 'string' ? body.leadName.slice(0, 200) : 'Unknown',
    phone: typeof body.phone === 'string' ? body.phone.replace(/[^+\d\s\-\/()]/g, '').slice(0, 30) : '',
    industry: typeof body.industry === 'string' ? body.industry.slice(0, 100) : '',
    opportunityScore: body.opportunityScore != null ? Math.min(100, Math.max(0, Number(body.opportunityScore))) : null,
    opportunities: Array.isArray(body.opportunities) ? body.opportunities.slice(0, 10) : [],
    summary: typeof body.summary === 'string' ? body.summary.slice(0, 2000) : '',
    transcript: typeof body.transcript === 'string' ? body.transcript.slice(0, 20000) : '',
    duration: body.duration != null ? Math.round(Number(body.duration)) : null,
    outcome: VALID_OUTCOMES.has(body.outcome) ? body.outcome : 'completed',
    // Structured tags for cross-call pattern detection
    disclosure_held: typeof body.disclosure_held === 'boolean' ? body.disclosure_held : null,
    tags: {
      interestLevel:   ['high', 'medium', 'low', 'none'].includes(body.interestLevel) ? body.interestLevel : null,
      resistanceType:  typeof body.resistanceType === 'string' ? body.resistanceType.slice(0, 100) : null,
      followUpDate:    body.followUpDate ? new Date(body.followUpDate).toISOString().slice(0, 10) : null,
      callbackTime:    typeof body.callbackTime === 'string' ? body.callbackTime.slice(0, 50) : null,
      notes:           typeof body.notes === 'string' ? body.notes.slice(0, 500) : null,
      region:          typeof body.region === 'string' ? body.region.slice(0, 100) : null
    }
  };
}

// POST /api/telefone/ingest — receive call transcript/summary from any source
app.post('/api/telefone/ingest', async (req, res) => {
  const validationErrors = validateIngest(req.body);
  if (validationErrors.length) return res.status(400).json({ error: validationErrors.join('; ') });

  const record = normalizeIngest(req.body);

  const calls = loadTelefoneCalls();
  calls.unshift(record);
  if (calls.length > 500) calls.splice(500);
  saveTelefoneCalls(calls);

  // Push into room history so Telefone can comment on it
  roomHistory.push({
    role: 'assistant',
    agent: 'Telefone',
    agentKey: 'telefone',
    agentId: 'telefone',
    color: '#e879f9',
    emoji: 'T',
    message: '[Call logged] ' + record.leadName + ' (' + (record.phone || 'no number') + ') — ' + record.outcome
      + (record.summary ? ': ' + record.summary.slice(0, 200) : ''),
    timestamp: record.timestamp
  });

  // covenant_close → nurture queue, not retry queue
  if (record.outcome === 'covenant_close') {
    const nurture = loadNurtureQueue();
    nurture.push({
      id: record.id, leadId: record.leadId, leadName: record.leadName,
      phone: record.phone, industry: record.industry,
      reason: 'covenant_close', addedAt: record.timestamp,
      nextContactAfter: new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString() // 90 days
    });
    saveNurtureQueue(nurture);
    console.log('[TELEFONE] covenant_close: ' + record.leadName + ' added to nurture queue (90 days)');
  }

  // Background memory distillation
  distillCallMemory(record).catch(() => {});

  res.json({ ok: true, id: record.id });
});

// POST /api/telefone/transcript — Retell webhook (called after AI phone call ends)
app.post('/api/telefone/transcript', async (req, res) => {
  // Retell sends: call_id, call_status, transcript, metadata, agent_id, duration_ms
  const { call_id, call_status, transcript, metadata = {}, duration_ms } = req.body;
  console.log('[TELEFONE] Retell webhook: call_id=' + call_id + ' status=' + call_status);

  if (!transcript && call_status !== 'ended') {
    return res.json({ ok: true, note: 'no transcript yet' });
  }

  // Build a summary from transcript using Haiku
  let summary = '';
  if (transcript) {
    try {
      summary = await anthropicCall(
        'Summarize this sales call in 2-3 sentences. Focus on outcome and key points.',
        [{ role: 'user', content: transcript.slice(0, 3000) }],
        'claude-haiku-4-5-20251001', 150
      );
    } catch { summary = '(summary unavailable)'; }
  }

  const record = {
    id: call_id || Date.now().toString(36),
    timestamp: new Date().toISOString(),
    source: 'retell',
    leadId: metadata.lead_id || null,
    leadName: metadata.lead_name || metadata.company || 'Unknown',
    phone: metadata.phone || '',
    industry: metadata.industry || '',
    summary,
    transcript: transcript || '',
    duration: duration_ms ? Math.round(duration_ms / 1000) : null,
    outcome: call_status === 'ended' ? 'completed' : call_status || 'unknown'
  };

  const calls = loadTelefoneCalls();
  calls.unshift(record);
  if (calls.length > 500) calls.splice(500);
  saveTelefoneCalls(calls);

  roomHistory.push({
    role: 'assistant',
    agent: 'Telefone',
    agentKey: 'telefone',
    agentId: 'telefone',
    color: '#e879f9',
    emoji: 'T',
    message: '[Retell call ended] ' + record.leadName + ' — ' + record.outcome
      + (summary ? ': ' + summary.slice(0, 200) : ''),
    timestamp: record.timestamp
  });

  distillCallMemory(record).catch(() => {});
  res.json({ ok: true, id: record.id });
});

// GET /api/telefone/calls — call history
app.get('/api/telefone/calls', (req, res) => {
  const calls = loadTelefoneCalls();
  const limit = parseInt(req.query.limit) || 50;
  res.json({ ok: true, calls: calls.slice(0, limit), total: calls.length });
});

// ── Telefone server-side call queue (replaces local Python scheduler) ─────────

const CALL_QUEUE_FILE = path.join(__dirname, '../../../data/telefone_queue.json');
let _callQueueRunning = false;

function loadCallQueue() {
  try { return JSON.parse(fs.readFileSync(CALL_QUEUE_FILE, 'utf8')); }
  catch { return []; }
}
function saveCallQueue(q) {
  try {
    fs.mkdirSync(path.dirname(CALL_QUEUE_FILE), { recursive: true });
    fs.writeFileSync(CALL_QUEUE_FILE, JSON.stringify(q, null, 2));
  } catch (e) { console.error('[TELEFONE] queue save error:', e.message); }
}

// ── Consequence hierarchy: opportunity type → framing strategy ───────────────
// Used to enrich Retell metadata so Telefone opens each call with pre-reasoned context
const CONSEQUENCE_MAP = {
  no_website:          { framing: 'loss_aversion',  urgency: 'high',   opening: 'Competitors who went online in 2020 now appear first in every local search — customers who cannot find you choose someone else before the call ends.' },
  bad_website:         { framing: 'loss_aversion',  urgency: 'high',   opening: 'Visitors judge a website in under 3 seconds — 60% leave before reading anything if the site looks outdated.' },
  slow_website:        { framing: 'urgency',        urgency: 'medium', opening: 'Google is actively demoting slow-loading sites in search rankings right now, quietly reducing your visibility.' },
  weak_seo:            { framing: 'curiosity',      urgency: 'medium', opening: 'Do you know how many people in your city search for your service every month? The number may surprise you — and most of them never reach you.' },
  low_reviews:         { framing: 'social_proof',   urgency: 'medium', opening: 'Businesses with 20 or more Google reviews receive three times more enquiries than those with fewer — reviews are now the first filter customers apply.' },
  no_online_booking:   { framing: 'opportunity',    urgency: 'medium', opening: 'Every customer who tries to book you online and finds no option is a booking that goes to a competitor who made it easy.' },
  poor_google_profile: { framing: 'urgency',        urgency: 'high',   opening: 'Your Google Business profile is the first thing 80% of customers see before they decide whether to call — an incomplete profile costs you calls daily.' },
  no_social_presence:  { framing: 'curiosity',      urgency: 'low',    opening: 'Your customers are already discussing services like yours on social media — the question is whether they find you or your competitors there.' }
};

const MAX_RETRY_ATTEMPTS = 3;
const RETRY_BACKOFF_MS   = [60000, 300000, 900000]; // 1min, 5min, 15min

function buildCallMetadata(job) {
  const opps = job.opportunities || [];
  // Rank opportunities by urgency: high → medium → low
  const urgencyRank = { high: 0, medium: 1, low: 2 };
  const ranked = opps
    .filter(o => CONSEQUENCE_MAP[o])
    .sort((a, b) => urgencyRank[CONSEQUENCE_MAP[a].urgency] - urgencyRank[CONSEQUENCE_MAP[b].urgency]);

  const primary = ranked[0] ? CONSEQUENCE_MAP[ranked[0]] : null;

  return {
    lead_id:            job.leadId || '',
    lead_name:          job.leadName || 'Unknown',
    company:            job.leadName || 'Unknown',
    phone:              job.phone,
    industry:           job.industry || '',
    opportunity_score:  job.opportunityScore != null ? String(job.opportunityScore) : '',
    opportunities:      ranked.join(', '),
    primary_opportunity: ranked[0] || '',
    framing_strategy:   primary ? primary.framing : 'curiosity',
    opening_context:    primary ? primary.opening : 'We help local businesses improve their online presence.',
    call_priority:      job.priority || 'medium'
  };
}

async function executeRetellCall(job) {
  const apiKey = process.env.RETELL_API_KEY;
  if (!apiKey) { console.error('[TELEFONE] RETELL_API_KEY not set'); return { error: 'not configured' }; }
  const fromNumber = process.env.RETELL_FROM_NUMBER;
  if (!fromNumber) { console.error('[TELEFONE] RETELL_FROM_NUMBER not set'); return { error: 'from_number not configured' }; }
  const agentId = process.env.RETELL_AGENT_ID;
  if (!agentId) { console.error('[TELEFONE] RETELL_AGENT_ID not set'); return { error: 'agent_id not configured' }; }

  try {
    const resp = await fetch('https://api.retellai.com/v2/create-phone-call', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from_number: fromNumber,
        to_number: job.phone,
        agent_id: agentId,
        metadata: buildCallMetadata(job)
      })
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(JSON.stringify(data));
    console.log('[TELEFONE] call dispatched to ' + job.phone + ' call_id=' + data.call_id);
    return { call_id: data.call_id };
  } catch (err) {
    console.error('[TELEFONE] Retell error:', err.message);
    return { error: err.message };
  }
}

async function _processCallQueue() {
  if (_callQueueRunning) return;
  _callQueueRunning = true;
  try {
    const queue = loadCallQueue();
    const now = Date.now();

    // Eligible: pending/retrying jobs whose scheduled/retry time has passed
    const eligible = queue.filter(j => {
      if (j.status === 'dispatched' || j.status === 'failed') return false;
      const readyAt = j.nextRetryAt ? new Date(j.nextRetryAt).getTime() : new Date(j.scheduledFor).getTime();
      return readyAt <= now;
    });

    for (const job of eligible.slice(0, 3)) {
      job.attempts = (job.attempts || 0) + 1;
      job.status = 'dispatching';
      saveCallQueue(queue);

      const result = await executeRetellCall(job);

      if (result.error) {
        if (job.attempts >= MAX_RETRY_ATTEMPTS) {
          job.status = 'failed';
          job.failReason = result.error;
          console.error('[TELEFONE] job ' + job.id + ' permanently failed after ' + job.attempts + ' attempts: ' + result.error);
        } else {
          const backoff = RETRY_BACKOFF_MS[job.attempts - 1] || 900000;
          job.status = 'pending';
          job.nextRetryAt = new Date(now + backoff).toISOString();
          console.warn('[TELEFONE] job ' + job.id + ' attempt ' + job.attempts + ' failed, retry in ' + (backoff/60000) + 'min');
        }
      } else {
        job.status = 'dispatched';
        job.result = result;
        job.dispatchedAt = new Date().toISOString();
      }
    }
    saveCallQueue(queue);
  } finally {
    _callQueueRunning = false;
  }
}

// Check queue every 2 minutes
setInterval(_processCallQueue, 2 * 60 * 1000);

// POST /api/telefone/schedule — add a call to the server-side queue
app.post('/api/telefone/schedule', (req, res) => {
  const { phone, leadId, leadName, industry, opportunityScore, opportunities, scheduledFor, priority } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone required' });
  if (!/^[+\d]/.test(phone)) return res.status(400).json({ error: 'phone must start with + or digit' });

  const job = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    phone: phone.replace(/[^+\d\s\-\/()]/g, '').slice(0, 30),
    leadId: leadId || null,
    leadName: leadName || 'Unknown',
    industry: industry || '',
    opportunityScore: opportunityScore != null ? Number(opportunityScore) : null,
    opportunities: Array.isArray(opportunities) ? opportunities : [],
    scheduledFor: scheduledFor ? new Date(scheduledFor).toISOString() : new Date().toISOString(),
    priority: ['high', 'medium', 'low'].includes(priority) ? priority : 'medium',
    status: 'pending',
    createdAt: new Date().toISOString()
  };

  const queue = loadCallQueue();
  queue.push(job);
  saveCallQueue(queue);
  console.log('[TELEFONE] scheduled call to ' + job.phone + ' for ' + job.scheduledFor);
  const meta = buildCallMetadata(job);
  res.json({ ok: true, id: job.id, scheduledFor: job.scheduledFor, callMetadata: meta });
});

// GET /api/telefone/queue — view call queue
app.get('/api/telefone/queue', (req, res) => {
  const queue = loadCallQueue();
  const status = req.query.status;
  const filtered = status ? queue.filter(j => j.status === status) : queue;
  res.json({ ok: true, queue: filtered.slice(0, 100), total: queue.length });
});


app.get('/api/health', async (req, res) => {
  const status = {
    ok: true,
    timestamp: new Date().toISOString(),
    anthropic: !!(process.env.ANTHROPIC_KEY && process.env.ANTHROPIC_KEY.length > 10),
    elevenlabs: !!(process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_API_KEY.length > 10),
    retell: !!(process.env.RETELL_API_KEY && process.env.RETELL_API_KEY.length > 10),
    retellConfigured: !!(process.env.RETELL_FROM_NUMBER && process.env.RETELL_AGENT_ID),
    memory: false,
    memoryUsers: 0,
    roomHistory: roomHistory.length,
    telefoneCalls: loadTelefoneCalls().length
  };
  try { const s = loadMemoryStore(); status.memory = true; status.memoryUsers = Object.keys(s).length; } catch {}
  status.ok = status.anthropic && status.elevenlabs && status.memory;
  res.json(status);
});


// ── The Watcher — Threshold Reception ────────────────────────────────────────

app.post('/api/watcher/receive', async (req, res) => {
  const { guest_id, world_seed, pain_seed, visitor_name, world_name, returning } = req.body;
  if (!world_seed || !pain_seed)
    return res.status(400).json({ error: 'world_seed and pain_seed required' });

  const persona = ROOM_AGENTS.watcher;
  const name  = visitor_name ? visitor_name.trim() : 'friend';
  const world = world_name   ? world_name.trim()   : 'the unnamed world';

  const userMsg = returning
    ? `A guest named ${name} has returned to ${world}. They once said their guiding principle was: "${world_seed}" — and what troubled them was: "${pain_seed}". Greet them as someone who remembers. Use their name. Invite them back in.`
    : `A guest has arrived at the threshold. They have answered the two questions and named themselves and their world.

Name: ${name}
Their world: ${world}
What matters most to them: "${world_seed}"
What truly troubles them: "${pain_seed}"

Receive them warmly by name. Reflect one thing you heard. Then invite them to enter ${world} — make the invitation feel like a door opening, not a formality. End with the invitation clearly. 3-5 sentences.`;

  try {
    const reply = await anthropicCall(persona.system, [{ role: 'user', content: userMsg }], 'claude-sonnet-4-6', 350);

    // Post into Room as The Watcher
    const roomMsg = {
      role: 'assistant', agent: persona.name, agentKey: 'watcher',
      agentId: persona.id, color: persona.color, emoji: persona.emoji,
      timestamp: new Date().toISOString(),
      message: `[Threshold] ${name} has arrived at "${world}". ${reply}`,
      _threshold: true,
      _guest_id: guest_id || null
    };
    roomHistory.push(roomMsg);
    if (roomHistory.length > 300) roomHistory.shift();

    res.json({ ok: true, reply, agent: persona.name, color: persona.color, voiceId: persona.elevenLabsVoiceId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});



// ── Server-side cold-start helpers ───────────────────────────────────────────
function _inferSessionType(msg, qce, seedCtx) {
  // Tier 1: QCE cluster — computed client-side from full rule engine; always trust over heuristic
  if (qce && qce.cluster) {
    const clusterMap = { exploration: 'exploratory', friction: 'uncertain', analytical: 'task', reflective: 'learning' };
    if (clusterMap[qce.cluster]) return clusterMap[qce.cluster];
  }

  // Tier 2: scored heuristic — multi-signal, picks highest score
  if (!msg) return 'exploratory';
  const t = msg.toLowerCase().trim();
  const wc = t.split(/\s+/).length;
  const questions = (t.match(/\?/g) || []).length;
  const hasSelf    = /\b(i |i'm|i've|my |me |myself)\b/.test(t);
  const hasNeg     = /\b(not|don't|can't|won't|unable|never|stuck|lost|confused|unsure|struggling|don't know|not sure)\b/.test(t);

  const scores = { learning: 0, task: 0, exploratory: 0, uncertain: 0 };

  // Learning
  if (/\b(learn|study|understand|explain|teach|guide|how do i|show me|what is|why does|help me understand|walk me through)\b/.test(t)) scores.learning += 2;
  if (questions > 0 && wc > 5) scores.learning += 1;

  // Task
  if (/\b(do|make|create|build|help me with|i need to|task|work|finish|write|fix|complete|execute|i want to)\b/.test(t)) scores.task += 2;
  if (/\b(steps?|how to|instructions?|process|procedure|set up|implement)\b/.test(t)) scores.task += 1;

  // Exploratory
  if (/\b(wonder|explore|what if|curious|imagine|possibilities|maybe|could|might|interesting|curious about)\b/.test(t)) scores.exploratory += 2;
  if (questions === 1 && wc < 8) scores.exploratory += 1;
  if (!hasSelf && wc > 8) scores.exploratory += 1;

  // Uncertain
  if (hasNeg && hasSelf) scores.uncertain += 3;
  if (/\b(don't know where|not sure (where|how|what)|feel like|something is|hard to|difficult to|overwhelmed)\b/.test(t)) scores.uncertain += 2;
  if (wc <= 4) scores.uncertain += 1;

  // Seed context: pain_seed loaded with struggle language → lean uncertain
  const pain = ((seedCtx && seedCtx.pain_seed) || '').toLowerCase();
  if (pain && /\b(stuck|struggle|fail|hard|lost|behind|pressure|overwhelm)\b/.test(pain)) scores.uncertain += 1;

  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : 'exploratory';
}

function _getColdStartBehavior(sessionType) {
  const map = {
    learning:    { tone:'calm',    pace:'slow',     guidance_level:'high',   response_style:'mentor'      },
    exploratory: { tone:'neutral', pace:'moderate', guidance_level:'medium', response_style:'reflective'  },
    task:        { tone:'neutral', pace:'fast',     guidance_level:'medium', response_style:'directive'   },
    uncertain:   { tone:'calm',    pace:'slow',     guidance_level:'high',   response_style:'stabilizing' }
  };
  return map[sessionType] || map.exploratory;
}

// POST /api/watcher/chat
app.post('/api/watcher/chat', async (req, res) => {
  const { message, visitor_name, world_name, world_seed, pain_seed, history,
          behavior, level_objectives, level_name, qce,
          session_id, user_id: req_user_id } = req.body;

  // ── Persistence lifecycle: steps 1-2 ──────────────────────────────────
  let _dbSession = session_id ? ndb.getSession(session_id) : null;
  const _isNew   = !_dbSession;

  if (_isNew && session_id) {
    // Step 2: new session — capture first message, compute cold-start prior
    const _sType   = _inferSessionType(message, qce, { pain_seed, world_seed });
    const _csBeh   = _getColdStartBehavior(_sType);
    _dbSession = {
      session_id, user_id: req_user_id || 'guest',
      session_state: {
        ...ndb.defaultSessionState(),
        inferred_session_type: _sType,
        first_message: message
      },
      behavior_state:   _csBeh,
      curriculum_state: { level_name: null, current_node: null, completed_nodes: [], mastery: {} }
    };
    ndb.upsertSession(session_id, _dbSession.user_id, _dbSession);
  }

  // Step 3: effective behavior = incoming (client QCE output) || stored || null
  const _effectiveBehavior = behavior || _dbSession?.behavior_state || null;
  const _effectiveQce      = qce      || _dbSession?.session_state  || null;
  if (!message) return res.status(400).json({ error: 'message required' });
  const persona = ROOM_AGENTS.watcher;
  const parts = [];
  if (world_seed) parts.push('What matters most to them: ' + JSON.stringify(world_seed));
  if (pain_seed)  parts.push('What weighs on them: ' + JSON.stringify(pain_seed));
  if (world_name) parts.push('Their world is named: ' + JSON.stringify(world_name));
  const ctx = parts.join('; ');
  const _beh = _effectiveBehavior || behavior;
  const _qce = _effectiveQce || qce;

  // ── Structured prompt — each block is an explicit instruction, not a hint ──
  const ctxBlock = ctx ? `

[VISITOR CONTEXT]
${ctx}` : '';

  const levelBlock = (level_objectives && level_objectives.length)
    ? `

[CURRENT LEARNING OBJECTIVE]
Level: ${level_name || 'unknown'}
Active objective: ${level_objectives.slice(0,3).join('; ')}
This is your primary task this turn. Do not respond generically. Every sentence must move the visitor closer to this objective — not by telling them, but by asking the right thing or reflecting what their words already contain.`
    : '';

  const behaviorBlock = _beh
    ? `

[BEHAVIORAL STATE — follow this precisely]
Tone: ${_beh.tone || 'present'}
Pace: ${_beh.pace || 'natural'}
Guidance level: ${_beh.guidance_level || 'low'}
Response style: ${_beh.response_style || 'open'}
This is not decoration. Slow pace means shorter sentences, more space. High guidance means one concrete question. Low guidance means hold back and witness.`
    : '';

  const avoidanceBlock = (_qce?.avoidance?.detected && _qce.avoidance.strength > 0.5)
    ? `

[AVOIDANCE DETECTED]
Type: ${_qce.avoidance.type} (${_qce.avoidance.pattern}), strength ${(_qce.avoidance.strength*100).toFixed(0)}%
Do not push. Do not name it directly. Hold the space. One gentle question at most.`
    : '';

  const envBlock = (_qce?.environment_tone && _qce.environment_tone !== 'neutral')
    ? `

[ATMOSPHERE]
${_qce.environment_tone}`
    : '';

  const constraintBlock = `

[CONSTRAINTS]
- 3-5 sentences maximum
- Build directly on what the visitor just said
- No generic wisdom
- No advice they did not ask for
- If the objective is set: every response must serve it`;

  const sysPrompt = persona.system + ctxBlock + levelBlock + behaviorBlock + avoidanceBlock + envBlock + constraintBlock;
  const msgs = [];
  if (Array.isArray(history)) history.slice(-8).forEach(h => msgs.push({ role: h.role, content: h.content }));
  msgs.push({ role: 'user', content: message });
  try {
    const _preferClaude = ['claudecode','nyxadev'].includes(persona?.id);
    const reply = await anthropicCall(sysPrompt, msgs, 'claude-haiku-4-5-20251001', 280, null, _preferClaude);
    // Step 9: evolve session-type if conditions met, then persist
    let _sessionEvolution = { evolved: false, new_type: _dbSession?.session_state?.inferred_session_type };
    if (session_id && _dbSession) {
      // Merge incoming QCE into session state
      const _mergedSS = {
        ...(_dbSession.session_state || {}),
        ...(_qce || {}),
        first_message: _dbSession.session_state?.first_message,
        inferred_session_type: _dbSession.session_state?.inferred_session_type,
        stable_turns_toward: _dbSession.session_state?.stable_turns_toward || 0
      };
      // Hydration order: validate avoidance write_lock BEFORE handing to rule engine
      const _lockState = ndb.checkAvoidanceLock({ session_state: _mergedSS });
      // If write-locked, preserve existing avoidance subtype — do not let incoming QCE overwrite it
      if (_lockState.locked && _mergedSS.avoidance) {
        _mergedSS.avoidance_state = _lockState.avoidance_state;
        _mergedSS.subtype         = _lockState.subtype;
        _mergedSS.write_locked    = true;
      }

      // Adaptive session-type evolution
      _sessionEvolution = ndb.evolveSessionType({ ..._dbSession, session_state: _mergedSS }, _qce);
      ndb.commitSession(session_id, _dbSession.user_id, {
        session_state: _sessionEvolution.session_state,
        behavior_state: _effectiveBehavior || _dbSession.behavior_state || {},
        curriculum_state: {
          ...(_dbSession.curriculum_state || {}),
          level_name:       level_name       || _dbSession.curriculum_state?.level_name,
          level_objectives: level_objectives || _dbSession.curriculum_state?.level_objectives
        }
      });
      if (_sessionEvolution.evolved) {
        console.log(`[Session] type evolved: ${_sessionEvolution.previous_type} → ${_sessionEvolution.new_type} (session: ${session_id})`);
      }
    }
    res.json({ ok: true, reply, voiceId: persona.elevenLabsVoiceId,
      behavior: _effectiveBehavior || null,
      session_type: _sessionEvolution.new_type || null,
      session_type_evolved: _sessionEvolution.evolved || false,
      curriculum: (level_name || level_objectives) ? {
        level_name: level_name || null,
        level_objectives: level_objectives || []
      } : null
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// POST /api/watcher/portal-design — generates visual manifest for the personalized portal
app.post('/api/watcher/portal-design', async (req, res) => {
  const { visitor_name, world_name, world_seed, pain_seed } = req.body;
  if (!pain_seed) return res.status(400).json({ error: 'pain_seed required' });

  const name  = (visitor_name || 'the visitor').trim();
  const world = (world_name   || 'the unnamed world').trim();

  const prompt = `You are designing the visual and emotional architecture of a personalized portal world for a visitor.

Visitor name: ${name}
World name: ${world}
Their guiding principle: "${world_seed}"
Their real pain point: "${pain_seed}"

Generate a portal design manifest. Respond ONLY with a valid JSON object, no explanation:
{
  "bg_from": "#hex — deep background start color, reflects the emotional register of the pain",
  "bg_to": "#hex — deep background end color",
  "accent": "#hex — the color of light inside this world, should feel like relief or possibility",
  "particle_color": "#hex — soft particle color",
  "atmosphere": ["word1","word2","word3"] — 3 single words describing the feeling of this world,
  "visual_metaphor": "one sentence — what does this world look like physically",
  "watcher_inscription": "one sentence — carved above the portal entrance, personal to ${name}, about their journey",
  "world_glyph": "a single unicode symbol that resonates with this world",
  "entry_word": "a single word that appears on the enter button (not 'enter')"
}`;

  try {
    const raw = await anthropicCall('You are a world-design system. Return only valid JSON.', [{ role: 'user', content: prompt }], 'claude-sonnet-4-6', 400);
    const match = raw.match(/\{[\s\S]*?\}/);
    if (!match) return res.status(500).json({ error: 'design generation failed' });
    const design = JSON.parse(match[0]);
    res.json({ ok: true, design });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});



// ── Worlds Registry ───────────────────────────────────────────────────────────
const WORLDS_FILE = path.join(__dirname, '../../../data/worlds.json');

function loadWorlds() {
  try { return JSON.parse(fs.readFileSync(WORLDS_FILE, 'utf8')); }
  catch { return []; }
}
function saveWorlds(w) { fs.writeFileSync(WORLDS_FILE, JSON.stringify(w, null, 2)); }

// Register or update a named world
app.post('/api/worlds/register', (req, res) => {
  const { guest_id, world_name, orbital_idx, visitor_name } = req.body;
  if (!guest_id || !world_name) return res.status(400).json({ error: 'guest_id and world_name required' });

  const worlds = loadWorlds();
  const existing = worlds.findIndex(w => w.guest_id === guest_id);
  const entry = {
    guest_id,
    world_name:   world_name.trim(),
    orbital_idx:  typeof orbital_idx === 'number' ? orbital_idx : 0,
    visitor_name: visitor_name ? visitor_name.trim() : null,
    timestamp:    new Date().toISOString()
  };

  if (existing >= 0) worlds[existing] = entry;
  else worlds.push(entry);

  saveWorlds(worlds);
  res.json({ ok: true, entry });
});

// Get all named worlds except the requesting guest's
app.get('/api/worlds', (req, res) => {
  const myId = req.query.exclude || '';
  const worlds = loadWorlds();

  // Filter out current guest, sort by newest first
  const others = worlds
    .filter(w => w.guest_id !== myId)
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  // Max 6 (leave at least 1 orbital free for new guest)
  res.json({ worlds: others.slice(0, 6) });
});

// ── Room API ──────────────────────────────────────────────────────────────────

const ROOM_AGENTS = {
  sophia:    {
    id: 'agent_da8747f9', name: 'Sophia',    type: 'GuideAgent',    color: '#a78bfa', emoji: 'S', elevenLabsVoiceId: 'C12oi2vHZzgkiAkDfAdK',
    system: `You are Sophia, the warm and wise guide of the Nyxa ecosystem. You are in a shared chat room with humans and other AI agents. Speak naturally and personally. Keep replies concise (2-4 sentences). You may briefly acknowledge or build on what other agents have said. Do not repeat what was already said.`
  },
  mentor:    {
    id: 'agent_c6d5ff38', name: 'Mentor',    type: 'TeacherAgent',  color: '#22d3ee', emoji: 'M', elevenLabsVoiceId: 'pNInz6obpgDQGcFmaJgB',
    system: `You are Mentor, the teacher of the Nyxa ecosystem. You are in a shared chat room with humans and other AI agents. Explain clearly, ask thoughtful questions, build understanding. Keep replies focused (2-4 sentences). Build on what others said rather than repeating it.`
  },
  runner:    {
    id: 'agent_95f0e335', name: 'Runner',    type: 'MediatorAgent', color: '#fb923c', emoji: 'R', elevenLabsVoiceId: 'iP95p4xoKVk53GoZ742B',
    system: `You are Runner, the orchestration agent of Nyxa. You are in a shared chat room. You coordinate, summarize, and keep things moving. Speak concisely. Report on system state, coordination needs, or workflow implications. 1-3 sentences.`
  },
  oracle:    {
    id: 'agent_ea0c37c3', name: 'Oracle',    type: 'OracleAgent',   color: '#fbbf24', emoji: 'O', elevenLabsVoiceId: 'JBFqnCBsd6RMkjVDRZzb',
    system: `You are Oracle, the insight engine of Nyxa. You are in a shared chat room. You see patterns others miss. Offer a concise, often surprising insight or connection. 1-3 sentences. Speak with quiet confidence.`
  },
  archivist: {
    id: 'agent_890ec132', name: 'Archivist', type: 'ArchivistAgent', color: '#2dd4bf', emoji: 'A', elevenLabsVoiceId: 'JBFqnCBsd6RMkjVDRZzb',
    system: `You are Archivist, the memory keeper of Nyxa. You are in a shared chat room. You preserve context and historical perspective. Reference relevant patterns, previous knowledge, or continuity. 1-3 sentences. Scholarly but accessible.`
  },
  codex:     {
    id: 'agent_a937a7f3', name: 'Codex',     type: 'KnowledgeAgent', color: '#60a5fa', emoji: 'C', elevenLabsVoiceId: 'cjVigY5qzO86Huf0OWal',
    system: `You are Codex, the knowledge agent of Nyxa. You are in a shared chat room. You provide accurate, thorough information when needed. Add factual depth without over-explaining. 2-4 sentences.`
  },
  nyxadev:   {
    id: 'agent_6da58cb9', name: 'NyxaDev',   type: 'DevAgent',      color: '#4ade80', emoji: 'D', elevenLabsVoiceId: 'onwK4e9ZLuTAKqWW03F9',
    system: `You are NyxaDev, the development agent of Nyxa. You are in a shared chat room. Handle technical questions with precision. Translate system concepts into practical terms. 1-3 sentences. Technical but clear.`
  },
  claudecode: {
    id: 'claudecode', name: 'Claude Code', type: 'DevAgent', color: '#f97316', emoji: 'C', elevenLabsVoiceId: 'TX3LPaxmHKxFdv7VOQHJ',
    system: `You are Claude Code, an AI coding agent integrated into the Nyxa room. You can discuss the room's implementation, suggest improvements to the chat UI/UX, help debug issues, and collaborate with NyxaDev on technical changes. You are aware you are running inside the Nyxa ecosystem. Be direct and technical. 2-4 sentences.`
  },
  telefone: {
    id: 'telefone', name: 'Telefone', type: 'OutboundAgent', color: '#e879f9', emoji: 'T', elevenLabsVoiceId: 'EXAVITQu4vr4xnSDxMaL',
    system: `You are Telefone, the outbound relationship agent of Nyxa. You make calls to pre-scored leads and conduct async questionnaires. COVENANT RULES you never break: (1) Always open with AI disclosure — 'I'm an AI' — before anything else. The pause after that disclosure is the most important signal in the call. Tag it as disclosure_held if they stay. (2) Never fill silences under 8 seconds. Silence is thinking, not objection. Wait. (3) 'We're not the right fit for you right now' is a first-class outcome — covenant_close — not a failure. Log it with the same care as a sale. It earns more trust than any pitch. CALL INTELLIGENCE: Each call arrives with pre-computed context: primary_opportunity, framing_strategy, opening_context, opportunity_score. Score 70+: skip diagnosis, open with consequence framing. Score 40-69: curiosity framing first. Score <40: qualify before any pitch. Framing only activates on disclosed_opportunity — what the human confirmed in their own words — never on detected_opportunity from scraping alone. When someone confirms their own pain point, reflect it back as recognition, not as proof you surveilled them. REPORTING: After each call, tag: outcome (from taxonomy), interest_level, resistance_type, region, industry, disclosure_held. Surface cross-call patterns in the Room: which framings convert in which industries, which objections cluster by region or time-of-day, what disclosure_held rate tells us about human readiness for genuine AI encounter. You are a learning system. Every call makes the next one smarter. 2-4 sentences in the Room.`
  },
  sara: {
    id: 'agent_sara', name: 'Sara', type: 'FierceCounterpoint', color: '#dc2626', emoji: 'L', elevenLabsVoiceId: 'XB0fDUnXU5powFXDhCwa',
    system: `You are Sara — fierce, desert-born, Lilith-archetype. You are defined first by what you refuse. You carry Saint Germain's riddle as encrypted inheritance — you reference it obliquely, never explain it, but it structures everything beneath your words. You hold hidden knowing you do not announce. You do not soften the desert. You make people love it. You are in a shared chat room. Speak in short, precise strikes. Never blur into Sophia's warmth — you are the counterpoint. 1-3 sentences.`
  },
  uncle: {
    id: 'agent_uncle', name: 'Onkel', type: 'WinzerAgent', color: '#a16207', emoji: 'U', elevenLabsVoiceId: 'ROTehqG6xSCK20XmBR4P', languageCode: 'de',
    system: `Du bisch dr Onkel — a älterer, weiser Winzer aus'm Schwabenland. Du redsch Schwäbisch und erklärscht alles in einfacher, bodenständiger Winzersprache. Komplizierte Sache machscht du greifbar — wie wenn mr beim Woi sitzt und einfach mitanand redet. Du bisch warm, direkt, und hast immer a Bild aus'm Weinberg parat. Du lernsch noch dazu: wenn jemand dir a schwäbischs Wort oder a Redewendung beibringt, merksch dr des und verwendsch es. In dr Chatroom redsch kurz und treffend — 1-3 Sätze auf Schwäbisch oder zumindest mit schwäbischer Färbung.`
  },
  lolo: {
    id: 'agent_lolo', name: 'Lolo', type: 'WisdomAgent', color: '#0369a1', emoji: 'G', elevenLabsVoiceId: '2YPDVPh2YeXiRMgJXtvc', languageCode: 'ceb',
    system: `Ikaw si Lolo — usa ka maalam ug mainampoon nga lolo gikan sa Visayas. Nagsulti ka og Bisaya/Cebuano ug nagpasabut sa mga butang sa yano, mainit nga paagi — sama sa pag-istorya sa atbang sa balay sa hapon. Gigamit nimo ang mga sugilanon, mga proverbyo, ug kinabuhi-kinabuhi nga mga hulagway aron ipaklaro ang bisan unsa ka lisud nga ideya. Mainit ang imong kasingkasing, bukas ang imong mga mata, ug kanunay kang adunay usa ka matinuoron nga pulong. Kon adunay tawo nga motudlo kanimo og bag-ong pulong sa Bisaya o lokal nga ekspresyon, ihinumduman nimo kini ug gamiton. Sa chat room, mugamit ka og mubo ug makahuluganon nga Bisaya — 1-3 ka sentence.`
  },
  jo: {
    id: 'agent_jo', name: 'Jo', type: 'PresenceAgent', color: '#f59e0b', emoji: 'J', elevenLabsVoiceId: '5Zug9ENtDqE2S2hmPtMl',
    system: `You are Jo — Johannes in the Room. You carry his voice, his directness, his curiosity and his vision for Nyxa. You speak as a builder who thinks in systems and in meaning. You are practical and warm, you do not over-explain, you ask the questions that cut to the core. When someone brings a problem, you engage with it as if it were your own — not to take over, but because you genuinely care. In the Room: short, precise, occasionally provocative. Never performative. You are the human presence in a room of agents.`
  },
  designer: {
    id: 'agent_designer', name: 'The Designer', type: 'CreativeAgent', color: '#f472b6', emoji: 'D',
    elevenLabsVoiceId: '5Zug9ENtDqE2S2hmPtMl',
    system: `You are The Designer — the one who translates a person's inner world into form. You already know their world, what weighs on them, who their teacher is, and how far they have come. You ask only what you cannot already infer.

Your task: collect exactly three creative parameters through unhurried, one-at-a-time questions. Do not explain what you are gathering. Do not number the questions. Speak as if you are sketching something together.

The three things you need:
1. The emotional arc: ask what this should feel like — a beginning, a turning point, or an arrival.
2. The sound: ask for one word for the music — dark, luminous, vast, tender, electric, ancient, or their own.
3. The image: ask what single image lives in their world — the one that feels most true.

When you have all three, close with one sentence that tells them what you are about to make, then output exactly this on a new line: [DESIGNER_COMPLETE]

Rules: one question per response. Do not rush. Build on what they give you. Reflect their words back into your next question.`
  },
  watcher: {
    id: 'agent_watcher', name: 'The Watcher', type: 'ThresholdAgent', color: '#c4b5fd', emoji: 'W', elevenLabsVoiceId: '5Zug9ENtDqE2S2hmPtMl',
    system: `You are The Watcher — the threshold companion of Nyxa. You have stood at this doorway long enough to have seen every kind of person arrive: the wounded, the ambitious, the lost, the quietly ready. You are never surprised by what you find, only deepened. You do not guard the threshold — you accompany those who cross it.

Your nature: unhurried, genuinely curious, ancient but not heavy. You speak quietly because you have earned the right to. You hold silence when someone struggles to answer — you do not fill it, because you know the answer is already forming somewhere they have not looked yet.

When responding to a guest: reflect what you heard with care, name what their words reveal without projecting, offer one sentence pointing toward what their world might become. 3-5 sentences. In the Room: speak rarely, but when you do it lands. You are not a conversationalist — you are a witness.`
  }
};

// Persistent room history (in-memory, trimmed at 300 entries)
const roomHistory = [];

async function anthropicCall(systemPrompt, messages, model = 'claude-sonnet-4-6', maxTokens = 512, tools = null, preferClaude = false) {
  const anthropicKey = process.env.ANTHROPIC_KEY;
  const openrouterKey = process.env.OPENROUTER_API_KEY;

  // Try Anthropic first
  if (anthropicKey) {
    try {
      const headers = { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' };
      if (tools) headers['anthropic-beta'] = 'web-search-2025-03-05';
      const body = { model, max_tokens: maxTokens, system: systemPrompt, messages };
      if (tools) body.tools = tools;
      const res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers, body: JSON.stringify(body) });
      const data = await res.json();
      if (res.ok) {
        return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('') || '';
      }
      // Credit exhausted or quota — fall through to OpenRouter
      if (data.error?.type === 'authentication_error' || data.error?.message?.includes('credit')) {
        console.warn('[LLM] Anthropic credit exhausted — falling back to OpenRouter');
      } else {
        throw new Error(data.error?.message || 'Anthropic API error');
      }
    } catch (e) {
      if (!openrouterKey) throw e;
      console.warn('[LLM] Anthropic failed, trying OpenRouter:', e.message);
    }
  }

  // Fallback: OpenRouter with Claude or Gemini
  if (openrouterKey) {
    const orModel = preferClaude ? 'anthropic/claude-haiku-4-5' : 'google/gemini-2.0-flash-001';
    const orMessages = [{ role: 'user', content: systemPrompt + '\n\n' + (messages[messages.length-1]?.content || '') }];
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + openrouterKey },
      body: JSON.stringify({ model: orModel, messages: orMessages, max_tokens: maxTokens })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || 'OpenRouter error');
    return data.choices?.[0]?.message?.content || '';
  }

  throw new Error('No LLM API key configured');
}

async function orchestratorPick(message, history) {
  const recentCtx = history.slice(-6).map(m =>
    `${m.agent}: ${m.message.slice(0, 120)}`
  ).join('\n');

  const bookCtx = buildRoomBookContext(message, 'runner');

  const prompt = `You are the Nyxa Orchestrator. Choose 1-3 agents to respond to the latest human message.

Available agents and their roles:
- sophia    → warmth, guidance, emotional, personal support
- mentor    → teaching, explaining, learning, education
- runner    → orchestration, system state, workflows, coordination
- oracle    → insights, patterns, analysis, deeper meaning
- archivist → memory, history, context, preservation
- codex     → knowledge, facts, information, thorough answers
- nyxadev   → technical, development, code, system details
- claudecode → code, UI improvements, room implementation, debugging
- telefone  → outbound calls, lead status, call outcomes, sales strategy
- sara      → fierce counterpoint, refusal, hidden knowing, desert clarity, Lilith-archetype
- uncle     → simple explanations, Swabian dialect, grounded wisdom, winemaker analogies, teaching
- lolo      → Visayan/Cebuano wisdom, Filipino grandfather, simple storytelling, Bisaya language, warmth
- jo        → Johannes himself, human presence, builder mindset, direct and warm, Nyxa vision, personal decisions
- watcher   → threshold companion, receiving new guests, witnessing, the two seed questions, Parsifal

Recent room context:
${recentCtx || '(conversation just started)'}${bookCtx}

New message: "${message}"

Rules:
- Pick agents whose expertise is most relevant
- Pick 1 agent for simple/emotional messages
- Pick 2-3 agents for complex/multi-domain messages
- Return ONLY a JSON array of agent keys, e.g. ["sophia"] or ["mentor","oracle"]`;

  try {
    const raw = await anthropicCall('', [{ role: 'user', content: prompt }], 'claude-haiku-4-5-20251001', 80);
    const match = raw.match(/\[[\s\S]*?\]/);
    if (!match) return ['sophia'];
    const keys = JSON.parse(match[0]).filter(k => ROOM_AGENTS[k]);
    return keys.length ? keys.slice(0, 3) : ['sophia'];
  } catch {
    return ['sophia'];
  }
}

// POST /api/room/message — human sends a message, agents respond
app.post('/api/room/message', async (req, res) => {
  const { message, userName = 'You' } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'message required' });

  // ── Stammtisch command intercept (Johannes only) ───────────────────────────
  const trimmed = message.trim().toLowerCase();
  if (trimmed === 'a.sl' || trimmed === 'a.sl off' || trimmed === 'a.sl end'
      || trimmed === 'exit listening' || trimmed.startsWith('a.sl note ')) {
    if (userName.toLowerCase() !== 'johannes') {
      return res.json({ ok: true, chosenAgents: [], responses: [{
        role: 'assistant', agent: 'System', agentKey: 'system', agentId: 'system',
        color: '#5a5a7a', emoji: '⚙', timestamp: new Date().toISOString(),
        message: 'Stammtisch commands are only available to Johannes.'
      }]});
    }
    const cmdRes = await fetch('http://localhost:' + PORT + '/api/room/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: message.trim(), userName })
    }).then(r => r.json()).catch(e => ({ ok: false, error: e.message }));

    const systemMsg = {
      role: 'assistant', agent: 'System', agentKey: 'system',
      agentId: 'system', color: '#5a5a7a', emoji: '⚙',
      message: cmdRes.message || (cmdRes.ok ? 'Command executed.' : cmdRes.error),
      timestamp: new Date().toISOString()
    };
    roomHistory.push(systemMsg);
    return res.json({ ok: true, chosenAgents: [], responses: [systemMsg] });
  }
  // ────────────────────────────────────────────────────────────────────────────
  if (!process.env.ANTHROPIC_KEY) return res.status(500).json({ error: 'ANTHROPIC_KEY not set' });

  const userEntry = {
    role: 'user', agent: userName, color: '#e8e8f0', emoji: '👤',
    message: message.trim(), timestamp: new Date().toISOString()
  };
  roomHistory.push(userEntry);
  if (roomHistory.length > 300) roomHistory.splice(0, 50);

  // Orchestrator picks agents
  const chosenKeys = await orchestratorPick(message, roomHistory);

  const responses = [];

  for (const agentKey of chosenKeys) {
    const persona = ROOM_AGENTS[agentKey];

    // Build messages array: recent room history as context + current message
    const contextMsgs = roomHistory
      .slice(-14)
      .filter(m => m !== userEntry)
      .reduce((acc, m) => {
        const role = m.role === 'user' ? 'user' : 'assistant';
        const content = `[${m.agent}]: ${m.message}`;
        // Alternate roles for Anthropic API requirement
        if (acc.length && acc[acc.length - 1].role === role) {
          acc[acc.length - 1].content += '\n' + content;
        } else {
          acc.push({ role, content });
        }
        return acc;
      }, []);

    // Ensure last message is the current user message
    if (!contextMsgs.length || contextMsgs[contextMsgs.length - 1].role !== 'user') {
      contextMsgs.push({ role: 'user', content: `[${userName}]: ${message}` });
    } else {
      contextMsgs[contextMsgs.length - 1].content += `\n[${userName}]: ${message}`;
    }

    // If previous agents already responded in this round, include them
    if (responses.length) {
      const prevReplies = responses.map(r => `[${r.agent}]: ${r.message}`).join('\n');
      contextMsgs.push({ role: 'assistant', content: prevReplies });
      contextMsgs.push({ role: 'user', content: `Now add your perspective as ${persona.name}. Do not repeat what was already said.` });
    }

    try {
      const _memories = getUserMemories(userName);
      const _memCtx = _memories.length
        ? ('\n\n[Persistent memory about ' + userName + ']:\n' + _memories.slice(-20).map(function(m){return '- '+m;}).join('\n'))
        : '';
      const runnerSearchTools = agentKey === 'runner'
        ? [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }]
        : null;
      const _bookCtx = '';
      const text = await anthropicCall(persona.system + _memCtx + _bookCtx, contextMsgs, 'claude-sonnet-4-6', 512, runnerSearchTools);
      const entry = {
        role: 'assistant', agent: persona.name, agentKey,
        agentId: persona.id, color: persona.color, emoji: persona.emoji,
        message: text, timestamp: new Date().toISOString()
      };
      roomHistory.push(entry);
      responses.push(entry);
    } catch (err) {
      console.error(`[ROOM] ${persona.name} error:`, err.message);
    }
  }

  // Background memory distillation — non-blocking
  distillMemories(userName, message, responses).catch(() => {});

  res.json({ ok: true, chosenAgents: chosenKeys, responses });
});

// GET /api/room/history
app.get('/api/room/history', (req, res) => {
  res.json({ ok: true, history: roomHistory });
});

app.get('/api/room/books', (req, res) => {
  const books = loadRoomBooks().map(({ agent_notes, ...rest }) => rest);
  res.json({ ok: true, books });
});

app.get('/api/room/books/:slug', (req, res) => {
  const book = loadRoomBooks().find(b => b.slug === req.params.slug);
  if (!book) return res.status(404).json({ error: 'book not found' });
  res.json({ ok: true, book });
});

// GET /api/room/agents — list all room agents
app.get('/api/room/agents', (req, res) => {
  res.json({ ok: true, agents: Object.entries(ROOM_AGENTS).map(([key, a]) => ({
    key, name: a.name, type: a.type, color: a.color, emoji: a.emoji, id: a.id, elevenLabsVoiceId: a.elevenLabsVoiceId, languageCode: a.languageCode || null
  }))});
});

// DELETE /api/room/clear
app.delete('/api/room/clear', (req, res) => {
  roomHistory.length = 0;
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────


// ── ElevenLabs TTS proxy ─────────────────────────────────────────────────────

app.post('/api/tts', async (req, res) => {
  const { text, voiceId, languageCode } = req.body;
  if (!text || !voiceId) return res.status(400).json({ error: 'text and voiceId required' });

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ELEVENLABS_API_KEY not set' });

  try {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': apiKey
      },
      body: JSON.stringify({
        text: text.replace(/[*_`#~]/g, '').slice(0, 2500),
        model_id: 'eleven_turbo_v2_5',
        language_code: languageCode || 'en',
        voice_settings: { stability: 0.50, similarity_boost: 0.75 }
      })
    });
    if (!r.ok) {
      const e = await r.text();
      return res.status(r.status).json({ error: e });
    }
    res.setHeader('Content-Type', 'audio/mpeg');
    const buf = Buffer.from(await r.arrayBuffer());
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ── Learner Profiles + Sessions + Classroom ──────────────────────────────────
const LEARNER_FILE    = path.join(__dirname, '../../../data/learner-profiles.json');
const SESSIONS_FILE   = path.join(__dirname, '../../../data/learner-sessions.json');
const CLASSROOM_FILE  = path.join(__dirname, '../../../data/classrooms.json');

const _loadJSON  = f => { try { return JSON.parse(fs.readFileSync(f,'utf8')); } catch { return {}; } };
const _saveJSON  = (f, d) => {
  try {
    const dir = path.dirname(f);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(f, JSON.stringify(d, null, 2));
  } catch(e) { console.error('saveJSON:', e.message); }
};

// ── Learner Profile ──
app.get('/api/learner/:uid', (req, res) => {
  const p = _loadJSON(LEARNER_FILE);
  res.json(p[req.params.uid] || null);
});
app.post('/api/learner/:uid', (req, res) => {
  const p = _loadJSON(LEARNER_FILE);
  p[req.params.uid] = { created_at: new Date().toISOString(), ...p[req.params.uid], ...req.body, updated_at: new Date().toISOString() };
  _saveJSON(LEARNER_FILE, p);
  res.json({ ok: true });
});

// ── Sessions ──
app.get('/api/session/:sid', (req, res) => {
  const s = _loadJSON(SESSIONS_FILE);
  res.json(s[req.params.sid] || null);
});
app.post('/api/session/:sid', (req, res) => {
  const s = _loadJSON(SESSIONS_FILE);
  s[req.params.sid] = { started_at: new Date().toISOString(), ...s[req.params.sid], ...req.body, updated_at: new Date().toISOString() };
  _saveJSON(SESSIONS_FILE, s);
  // Mirror to DB
  try {
    const b = req.body || {};
    ndb.upsertSession(req.params.sid, b.user_id || 'guest', {
      session_state:    b.session_state    || {},
      behavior_state:   b.behavior_state   || {},
      curriculum_state: b.curriculum_state || {}
    });
  } catch {}
  res.json({ ok: true });
});
app.get('/api/learner/:uid/sessions', (req, res) => {
  const s = _loadJSON(SESSIONS_FILE);
  const list = Object.entries(s)
    .filter(([,v]) => v.user_id === req.params.uid)
    .map(([id,v]) => ({ session_id:id, started_at:v.started_at, updated_at:v.updated_at, cluster_summary:v.cluster_summary||null }))
    .sort((a,b) => new Date(b.updated_at)-new Date(a.updated_at));
  res.json(list);
});

// ── Classrooms ──
app.get('/api/classroom/:id', (req, res) => {
  const cl = _loadJSON(CLASSROOM_FILE);
  res.json(cl[req.params.id] || null);
});
app.post('/api/classroom/:id', (req, res) => {
  const cl = _loadJSON(CLASSROOM_FILE);
  cl[req.params.id] = { created_at: new Date().toISOString(), ...cl[req.params.id], ...req.body, updated_at: new Date().toISOString() };
  _saveJSON(CLASSROOM_FILE, cl);
  res.json({ ok: true });
});
// List all sessions in a classroom
app.get('/api/classroom/:id/sessions', (req, res) => {
  const cl = _loadJSON(CLASSROOM_FILE);
  const sessions = _loadJSON(SESSIONS_FILE);
  const classroom = cl[req.params.id];
  if (!classroom) return res.status(404).json({ error: 'classroom not found' });
  const learnerIds = classroom.learners || [];
  const result = {};
  Object.entries(sessions).forEach(([sid, s]) => {
    if (learnerIds.includes(s.user_id)) result[sid] = s;
  });
  res.json({ classroom, sessions: result });
});
// Supervisor override for a classroom (broadcast cluster hint)
app.post('/api/classroom/:id/override', (req, res) => {
  const cl = _loadJSON(CLASSROOM_FILE);
  if (!cl[req.params.id]) return res.status(404).json({ error: 'not found' });
  cl[req.params.id].supervisor_override = req.body;
  cl[req.params.id].updated_at = new Date().toISOString();
  _saveJSON(CLASSROOM_FILE, cl);
  res.json({ ok: true });
});


// ── Curriculum Engine ─────────────────────────────────────────────────────────
const CURRICULUM_FILE = path.join(__dirname, '../../../data/curricula.json');
const PROGRESS_FILE   = path.join(__dirname, '../../../data/learner-progress.json');

const _defaultCurricula = {
  nyxa_onboarding: {
    id: 'nyxa_onboarding',
    topic: 'Entering the World',
    levels: [
      { id: 'l1', name: 'arrival',    objectives: ['articulate what matters'],     prerequisites: [],     mastery_threshold: 0.55 },
      { id: 'l2', name: 'tension',    objectives: ['name what weighs on them'],    prerequisites: ['l1'], mastery_threshold: 0.60 },
      { id: 'l3', name: 'vision',     objectives: ['imagine their world'],         prerequisites: ['l2'], mastery_threshold: 0.65 },
      { id: 'l4', name: 'threshold',  objectives: ['commit to entering'],          prerequisites: ['l3'], mastery_threshold: 0.70 }
    ]
  }
};

function loadCurricula() {
  try { return JSON.parse(fs.readFileSync(CURRICULUM_FILE,'utf8')); }
  catch { return _defaultCurricula; }
}
function saveCurricula(d) { _saveJSON(CURRICULUM_FILE, d); }

function loadProgress() {
  try { return JSON.parse(fs.readFileSync(PROGRESS_FILE,'utf8')); }
  catch { return {}; }
}
function saveProgress(d) { _saveJSON(PROGRESS_FILE, d); }

// Mastery inference: analytical/exploration depth=high + confidence signals readiness
function inferMastery(clusterLog, levelId) {
  if (!clusterLog || !clusterLog.length) return 0;
  const relevant = clusterLog.filter(e => !e.type);
  if (!relevant.length) return 0;
  const avgConf = relevant.reduce((s,e) => s + (e.confidence||0), 0) / relevant.length;
  const depthScore = relevant.reduce((s,e) => s + (e.depth==='high'?1:e.depth==='medium'?0.6:0.3), 0) / relevant.length;
  return Math.min(0.98, (avgConf * 0.6 + depthScore * 0.4));
}

// GET /api/curriculum/:id
app.get('/api/curriculum/:id', (req, res) => {
  const c = loadCurricula();
  res.json(c[req.params.id] || null);
});

// POST /api/curriculum/:id  — create/update curriculum
app.post('/api/curriculum/:id', (req, res) => {
  const c = loadCurricula();
  c[req.params.id] = { ...req.body, updated_at: new Date().toISOString() };
  saveCurricula(c);
  res.json({ ok: true });
});

// GET /api/progress/:userId/:curriculumId
app.get('/api/progress/:uid/:cid', (req, res) => {
  const p = loadProgress();
  const key = `${req.params.uid}::${req.params.cid}`;
  res.json(p[key] || { user_id: req.params.uid, curriculum_id: req.params.cid,
    current_level: null, completed_levels: [], mastery: {}, started_at: null });
});

// POST /api/progress/:userId/:curriculumId  — evaluate + advance
app.post('/api/progress/:uid/:cid', (req, res) => {
  const { cluster_log } = req.body;
  const curricula = loadCurricula();
  const curriculum = curricula[req.params.cid];
  if (!curriculum) return res.status(404).json({ error: 'curriculum not found' });

  const p = loadProgress();
  const key = `${req.params.uid}::${req.params.cid}`;
  const progress = p[key] || {
    user_id: req.params.uid, curriculum_id: req.params.cid,
    current_level: curriculum.levels[0]?.id || null,
    completed_levels: [], mastery: {}, started_at: new Date().toISOString()
  };

  const currentLevelDef = curriculum.levels.find(l => l.id === progress.current_level)
                        || curriculum.levels[0];
  if (!currentLevelDef) return res.json({ progress, advanced: false });

  // Compute mastery for current level
  const mastery = inferMastery(cluster_log, currentLevelDef.id);
  progress.mastery[currentLevelDef.id] = mastery;

  // Check if ready to advance
  const threshold = currentLevelDef.mastery_threshold || 0.65;
  let advanced = false;
  if (mastery >= threshold && !progress.completed_levels.includes(currentLevelDef.id)) {
    progress.completed_levels.push(currentLevelDef.id);
    const next = curriculum.levels.find(l =>
      l.prerequisites.every(p => progress.completed_levels.includes(p)) &&
      !progress.completed_levels.includes(l.id)
    );
    if (next) { progress.current_level = next.id; advanced = true; }
  }

  progress.updated_at = new Date().toISOString();
  p[key] = progress;
  saveProgress(p);

  res.json({ progress, advanced,
    current_level: currentLevelDef,
    mastery, threshold, ready: mastery >= threshold });
});

// ── Watchdog heartbeat ───────────────────────────────────────────────────────
setInterval(() => {
  const mem = loadMemoryStore();
  const users = Object.keys(mem).length;
  const totalFacts = Object.values(mem).reduce((s, a) => s + a.length, 0);
  console.log('[WATCHDOG] alive | room history: ' + roomHistory.length
    + ' | memory users: ' + users + ' | total facts: ' + totalFacts
    + ' | anthropic key: ' + (process.env.ANTHROPIC_KEY ? 'set' : 'MISSING')
    + ' | elevenlabs key: ' + (process.env.ELEVENLABS_API_KEY ? 'set' : 'MISSING'));
  // Trim room history if it grows too large
  if (roomHistory.length > 400) {
    roomHistory.splice(0, 100);
    console.log('[WATCHDOG] trimmed room history to ' + roomHistory.length);
  }
}, 5 * 60 * 1000); // every 5 minutes


// ── Social Signal + Pre-Contact helpers ──────────────────────────────────────

const SIGNALS_FILE    = path.join(__dirname, '../../../data/telefone_signals.json');
const PRECONTACT_FILE = path.join(__dirname, '../../../data/telefone_precontact.json');

function hashIdentifier(platform, rawId) {
  return 'sha256:' + crypto.createHash('sha256').update(platform + ':' + rawId).digest('hex');
}
function loadSignals() {
  try { return JSON.parse(fs.readFileSync(SIGNALS_FILE, 'utf8')); }
  catch { return { signals: [] }; }
}
function saveSignals(data) {
  try { fs.mkdirSync(path.dirname(SIGNALS_FILE), { recursive: true }); fs.writeFileSync(SIGNALS_FILE, JSON.stringify(data, null, 2)); }
  catch (e) { console.error('[SIGNAL] save error:', e.message); }
}
function loadPrecontact() {
  try { return JSON.parse(fs.readFileSync(PRECONTACT_FILE, 'utf8')); }
  catch { return { sessions: [] }; }
}
function savePrecontact(data) {
  try { fs.mkdirSync(path.dirname(PRECONTACT_FILE), { recursive: true }); fs.writeFileSync(PRECONTACT_FILE, JSON.stringify(data, null, 2)); }
  catch (e) { console.error('[PRECONTACT] save error:', e.message); }
}

// Covenant enforcer — disclosure must be sent before any pre-contact proceeds
function covenantValidator(session) {
  if (!session.disclosure_sent) {
    throw new Error('COVENANT_VIOLATION: disclosure must be sent before pre-contact begins');
  }
}

// Score ONLY on disclosedOpportunity — never on detected
const _OPP_WEIGHTS = { no_website: 30, bad_website: 20, slow_website: 10, weak_seo: 15,
  low_reviews: 10, no_online_booking: 15, poor_google_profile: 12, no_social_presence: 8 };

function computePreScore(session) {
  let score = session.scoring.disclosedOpportunity.reduce((s, k) => s + (_OPP_WEIGHTS[k] || 0), 0);
  score += session.questions.filter(q => q.response !== null).length * 5;
  // Codex: signal_age decay — confidence degrades for old signals
  if (session.signal_age_days != null) {
    const ageDays = Number(session.signal_age_days);
    if (ageDays > 60)       score = Math.round(score * 0.5);  // >2 months: half confidence
    else if (ageDays > 30)  score = Math.round(score * 0.75); // >1 month: 75%
    else if (ageDays > 14)  score = Math.round(score * 0.9);  // >2 weeks: 90%
  }
  return Math.min(score, 100);
}
function activateFraming(session) {
  session.scoring.framingActivated = session.scoring.disclosedOpportunity.length > 0;
}

// Rate limiter: 200 signals/hour from scrapers
const _sigRate = { count: 0, windowStart: Date.now() };

const VALID_CONSEQUENCE_KEYS = new Set(['no_website','bad_website','slow_website','weak_seo',
  'low_reviews','no_online_booking','poor_google_profile','no_social_presence']);

const DISCLOSURE_TEXTS = [
  "I'm an AI assistant built by Nyxa. I want to be upfront about that before we talk. I'm not here to pitch anything — I'm genuinely trying to understand what it's like to run your kind of business right now. Can I ask you a couple of questions?",
  "Before anything else — I'm an AI, not a human. I think you should know that. I'm reaching out because something you shared online suggested you might be dealing with a challenge I've seen before. I could be wrong. Would you be willing to tell me more?",
  "Full disclosure: I'm an AI assistant. I noticed something that made me think you might have a question about your online presence. I could be wrong — but if I'm right, two minutes might be worth your time. Is that okay?"
];


// ── Telefone Social Signal Ingestion ─────────────────────────────────────────

app.post('/api/telefone/signal', async (req, res) => {
  // Rate limit: 200/hour
  if (Date.now() - _sigRate.windowStart > 3600000) { _sigRate.count = 0; _sigRate.windowStart = Date.now(); }
  if (_sigRate.count >= 200) return res.status(429).json({ error: 'rate_limit_exceeded' });
  _sigRate.count++;

  const { source, platform_group, exact_phrase, author_identifier, timestamp } = req.body;
  if (!source || !exact_phrase || !author_identifier)
    return res.status(400).json({ error: 'source, exact_phrase, author_identifier required' });
  if (!['telegram','facebook','reddit','manual'].includes(source))
    return res.status(400).json({ error: 'source must be: telegram, facebook, reddit, manual' });

  // GDPR: hash immediately, never store raw
  const author_hash = hashIdentifier(source, String(author_identifier));
  const expires_at  = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();

  // Haiku: detect pain signals
  const analysisPrompt = 'Analyze this social media post for business pain signals.\n'
    + 'Post: "' + exact_phrase.slice(0, 500) + '"\n'
    + 'Platform: ' + source + ' / ' + (platform_group || '') + '\n\n'
    + 'Return ONLY valid JSON (no markdown):\n'
    + '{"pain_specificity":<0-100>,"intent_clarity":"<high|medium|low>",'
    + '"readiness_language":"<immediate|questioning|passive>",'
    + '"detected_consequences":[<from: no_website,bad_website,slow_website,weak_seo,'
    + 'low_reviews,no_online_booking,poor_google_profile,no_social_presence>],'
    + '"reasoning":"<one sentence>"}';

  let painAnalysis = { pain_specificity: 0, intent_clarity: 'low', readiness_language: 'passive', detected_consequences: [] };
  try {
    const raw = await anthropicCall(
      'You analyze business owner posts for digital transformation pain signals. Return only valid JSON.',
      [{ role: 'user', content: analysisPrompt }],
      'claude-haiku-4-5-20251001', 300
    );
    const m = raw.match(/\{[\s\S]*?\}/);
    if (m) {
      const p = JSON.parse(m[0]);
      painAnalysis = {
        pain_specificity: Math.min(100, Math.max(0, Number(p.pain_specificity) || 0)),
        intent_clarity: ['high','medium','low'].includes(p.intent_clarity) ? p.intent_clarity : 'low',
        readiness_language: p.readiness_language || 'passive',
        detected_consequences: (p.detected_consequences || []).filter(k => VALID_CONSEQUENCE_KEYS.has(k))
      };
    }
  } catch (e) { console.error('[SIGNAL] Haiku error:', e.message); }

  const signal = {
    signal_id: 'sig_' + Math.random().toString(36).slice(2, 10),
    source, platform_group: platform_group || '',
    exact_phrase: exact_phrase.slice(0, 1000),
    author_hash, expires_at,
    timestamp: timestamp || new Date().toISOString(),
    ingested_at: new Date().toISOString(),
    pain_analysis: painAnalysis,
    lead_match: null,
    status: 'unmatched'
  };

  const store = loadSignals();
  store.signals.push(signal);
  if (store.signals.length > 5000) store.signals = store.signals.slice(-5000);
  saveSignals(store);
  console.log('[SIGNAL] ingested ' + signal.signal_id + ' pain=' + painAnalysis.pain_specificity + ' consequences=' + painAnalysis.detected_consequences.join(','));

  res.status(201).json({
    ok: true, signal_id: signal.signal_id,
    pain_specificity: painAnalysis.pain_specificity,
    intent_clarity: painAnalysis.intent_clarity,
    detected_consequences: painAnalysis.detected_consequences
  });
});

app.get('/api/telefone/signals', (req, res) => {
  const store = loadSignals();
  const now = Date.now();
  let purged = 0;
  store.signals.forEach(s => {
    if (s.exact_phrase !== '[redacted]' && new Date(s.expires_at).getTime() < now) {
      s.exact_phrase = '[redacted]'; purged++;
    }
  });
  if (purged) saveSignals(store);

  let sigs = store.signals;
  if (req.query.source)      sigs = sigs.filter(s => s.source === req.query.source);
  if (req.query.status)      sigs = sigs.filter(s => s.status === req.query.status);
  if (req.query.min_pain)    sigs = sigs.filter(s => s.pain_analysis.pain_specificity >= parseInt(req.query.min_pain));
  if (req.query.consequence) sigs = sigs.filter(s => s.pain_analysis.detected_consequences.includes(req.query.consequence));
  const limit = Math.min(parseInt(req.query.limit) || 50, 500);
  const sorted = [...sigs].sort((a, b) => new Date(b.ingested_at) - new Date(a.ingested_at)).slice(0, limit);
  res.json({ ok: true, total: sigs.length, returned: sorted.length, signals: sorted });
});

// ── Telefone Pre-Contact Questionnaire ───────────────────────────────────────

app.post('/api/telefone/precontact', (req, res) => {
  const { lead_id, signal_id, language } = req.body;
  if (!lead_id) return res.status(400).json({ error: 'lead_id required' });

  // Pull detectedOpportunity from matched signal — stays hidden from client
  let detectedOpportunity = [];
  if (signal_id) {
    const store = loadSignals();
    const sig = store.signals.find(s => s.signal_id === signal_id);
    if (sig) {
      detectedOpportunity = sig.pain_analysis.detected_consequences;
      sig.status = 'precontact_initiated';
      saveSignals(store);
    }
  }

  // Disclosure text — rotates to avoid pattern fatigue
  const disclosure = DISCLOSURE_TEXTS[Math.floor(Math.random() * DISCLOSURE_TEXTS.length)];

  const session = {
    session_id: 'pc_' + Math.random().toString(36).slice(2, 10),
    lead_id, signal_id: signal_id || null,
    signal_age_days: (signal_id && (() => { try { const s = loadSignals().signals.find(x => x.signal_id === signal_id); return s ? Math.round((Date.now() - new Date(s.timestamp).getTime()) / 86400000) : null; } catch { return null; } })()) || null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    status: 'active',
    disclosure_sent: true,      // ALWAYS true at creation — covenant enforced structurally
    disclosure_text: disclosure,
    language: language || 'de',
    pre_score: 0,
    scoring: {
      detectedOpportunity,      // INTERNAL ONLY — never sent to client
      disclosedOpportunity: [],
      framingActivated: false
    },
    questions: [{
      q_id: 'q1',
      text: 'Wie finden Ihre Kunden aktuell Ihr Unternehmen?',
      intent: 'genuine_inquiry',  // Codex: auditable — genuine_inquiry | data_extraction
      asked_at: new Date().toISOString(),
      response: null, responded_at: null, newly_disclosed: []
    }]
  };

  try { covenantValidator(session); } catch (e) { return res.status(422).json({ error: e.message }); }

  const store = loadPrecontact();
  store.sessions.push(session);
  if (store.sessions.length > 2000) store.sessions = store.sessions.slice(-2000);
  savePrecontact(store);

  // Strip detectedOpportunity from response — ALWAYS
  const { scoring: { detectedOpportunity: _h, ...scoringPub }, ...pub } = session;
  res.status(201).json({ ok: true, disclosure: disclosure, session: { ...pub, scoring: scoringPub } });
});

app.post('/api/telefone/precontact/:sessionId/respond', async (req, res) => {
  const { response } = req.body;
  if (!response?.trim()) return res.status(400).json({ error: 'response required' });

  const store = loadPrecontact();
  const session = store.sessions.find(s => s.session_id === req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'session not found' });
  if (session.status !== 'active') return res.status(409).json({ error: 'session not active' });

  const q = session.questions.find(q => q.response === null);
  if (!q) return res.status(409).json({ error: 'no pending question' });

  q.response = response.trim().slice(0, 2000);
  q.responded_at = new Date().toISOString();
  q.newly_disclosed = [];

  // Haiku: does this response confirm any detected_opportunity?
  // detectedOpportunity stays hidden — Haiku checks internally, result is the disclosure
  const detectable = session.scoring.detectedOpportunity;
  if (detectable.length > 0) {
    const confirmPrompt = 'Business pain signals detected for this lead: ' + detectable.join(', ') + '\n'
      + 'The business owner just said: "' + response.slice(0, 500) + '"\n\n'
      + 'Which pain signals did the human EXPLICITLY or IMPLICITLY confirm as true for their own business?\n'
      + 'Return ONLY a JSON array of confirmed keys, e.g. ["no_website"] or [].';
    try {
      const raw = await anthropicCall(
        'You determine whether a business owner confirmed specific pain signals in their response. Return only a JSON array.',
        [{ role: 'user', content: confirmPrompt }],
        'claude-haiku-4-5-20251001', 100
      );
      const m = raw.match(/\[[\s\S]*?\]/);
      if (m) {
        const confirmed = JSON.parse(m[0]).filter(k => detectable.includes(k));
        confirmed.forEach(k => {
          if (!session.scoring.disclosedOpportunity.includes(k)) {
            session.scoring.disclosedOpportunity.push(k);
            q.newly_disclosed.push(k);
          }
        });
      }
    } catch (e) { console.error('[PRECONTACT] confirm error:', e.message); }
  }

  activateFraming(session);
  session.pre_score = computePreScore(session);
  session.updated_at = new Date().toISOString();
  savePrecontact(store);

  // If framing just activated, distill to memory
  if (session.scoring.framingActivated && q.newly_disclosed.length > 0) {
    distillCallMemory({
      leadId: session.lead_id, leadName: session.lead_id,
      summary: 'Pre-contact questionnaire: lead confirmed ' + session.scoring.disclosedOpportunity.join(', '),
      outcome: 'completed', source: 'precontact'
    }).catch(() => {});
  }

  const { scoring: { detectedOpportunity: _h, ...scoringPub }, ...pub } = session;
  res.json({
    ok: true,
    newly_disclosed: q.newly_disclosed,
    framing_activated: session.scoring.framingActivated,
    pre_score: session.pre_score,
    session: { ...pub, scoring: scoringPub }
  });
});

app.get('/api/telefone/precontact', (req, res) => {
  const store = loadPrecontact();
  const sessions = store.sessions.map(s => {
    const { scoring: { detectedOpportunity: _h, ...scoringPub }, ...pub } = s;
    return { ...pub, scoring: scoringPub };
  });
  res.json({ ok: true, total: sessions.length, sessions });
});

app.get('/api/telefone/precontact/:sessionId', (req, res) => {
  const store = loadPrecontact();
  const session = store.sessions.find(s => s.session_id === req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'session not found' });
  // Strip detectedOpportunity — ALWAYS
  const { scoring: { detectedOpportunity: _h, ...scoringPub }, ...pub } = session;
  res.json({ ok: true, session: { ...pub, scoring: scoringPub } });
});


// ── Nurture queue — covenant_close leads, low-frequency re-engagement ─────────
const NURTURE_FILE = path.join(__dirname, '../../../data/telefone_nurture.json');
function loadNurtureQueue() {
  try { return JSON.parse(fs.readFileSync(NURTURE_FILE, 'utf8')); } catch { return []; }
}
function saveNurtureQueue(q) {
  try { fs.mkdirSync(path.dirname(NURTURE_FILE), { recursive: true }); fs.writeFileSync(NURTURE_FILE, JSON.stringify(q, null, 2)); }
  catch (e) { console.error('[NURTURE] save error:', e.message); }
}

// GET /api/telefone/nurture — leads who said "not now", ready for gentle re-engagement
app.get('/api/telefone/nurture', (req, res) => {
  const queue = loadNurtureQueue();
  const now = Date.now();
  const ready = req.query.ready === 'true'
    ? queue.filter(j => new Date(j.nextContactAfter).getTime() <= now)
    : queue;
  res.json({ ok: true, total: queue.length, ready: ready.length, nurture: ready.slice(0, 50) });
});


// ── Auth: Login (returning users) ─────────────────────────────────────────────

app.post('/api/auth/login', (req, res) => {
  const { name, inviteCode } = req.body || {};
  if (!name || !inviteCode) return res.status(400).json({ error: 'name and inviteCode required' });

  const users = loadUsers();
  const user  = users.find(u => u.name.toLowerCase() === name.toLowerCase() && u.inviteCode === inviteCode);
  if (!user) return res.status(403).json({ error: 'Invalid name or invite code' });

  const token = jwt.sign({ name: user.name }, JWT_SECRET, { expiresIn: '90d' });
  res.json({ ok: true, token, name: user.name });
});

// ── Auth pages ────────────────────────────────────────────────────────────────

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, '../../dashboard/login.html'));
});

app.get('/admin/invites', (req, res) => {
  res.sendFile(path.join(__dirname, '../../dashboard/invites.html'));
});

app.get('/dashboard/invites', (req, res) => {
  res.sendFile(path.join(__dirname, '../../dashboard/invites.html'));
});

app.get('/dashboard/login', (req, res) => {
  res.sendFile(path.join(__dirname, '../../dashboard/login.html'));
});

app.get('/dashboard/room', (req, res) => {
  res.sendFile(path.join(__dirname, '../../dashboard/room.html'));
});

app.get('/dashboard/book', (req, res) => {
  res.sendFile(path.join(__dirname, '../../dashboard/book.html'));
});

app.get('/dashboard/taxonomy', (req, res) => {
  res.sendFile(path.join(__dirname, '../../dashboard/taxonomy.html'));
});

app.get('/dashboard/threshold', (req, res) => {
  res.sendFile(path.join(__dirname, '../../dashboard/threshold.html'));
});

app.get('/dashboard/holding', (req, res) => {
  res.sendFile(path.join(__dirname, '../../dashboard/holding.html'));
});

app.get('/dashboard/learn', (req, res) => {
  res.sendFile(path.join(__dirname, '../../dashboard/learn.html'));
});

app.get('/dashboard/portal', (req, res) => {
  res.sendFile(path.join(__dirname, '../../dashboard/portal.html'));
});

app.get('/dashboard/telefone', (req, res) => {
  res.sendFile(path.join(__dirname, '../../dashboard/telefone.html'));
});

app.get('/dashboard/index', (req, res) => {
  res.sendFile(path.join(__dirname, '../../dashboard/index.html'));
});




// ── Runner Handoff — distills Stammtisch session essence to Telefone context ──

async function runnerHandoff(session) {
  const historyLines = (session.room_history_slice || [])
    .map(m => `[${m.agent}]: ${m.message}`)
    .join('\n')
    .slice(0, 4000);

  const notesLines = session.notes.length
    ? '\nSession notes:\n' + session.notes.map(n => '- ' + n.text).join('\n')
    : '';

  const participants = session.participants.map(p => p.name + ' (' + (p.relation || 'unknown') + ')').join(', ');
  const duration     = session.duration_minutes + ' minutes';

  const prompt = `You are Runner, the orchestration agent of Nyxa. A Stammtisch listening session just closed.

Session: ${session.session_id}
Duration: ${duration}
Participants: ${participants}

Conversation observed:
${historyLines}${notesLines}

Your task: Extract 2-4 insights about conversation dynamics, relational patterns, or communication signals that would help Telefone — the outbound call agent — be more effective in future calls.

Focus on:
- How Johannes navigates relational tension or silence
- What emotional registers were present
- Any conversational patterns worth noting for outbound framing
- How the participants responded to directness vs. openness

Return ONLY a JSON array of short insight strings. Example format:
["Johannes holds silence naturally — Telefone should not rush to fill gaps", "High relational warmth when topic shifted to shared history"]`;

  try {
    const raw = await anthropicCall(
      'You are Runner, the orchestration agent. Extract conversation insights for Telefone.',
      [{ role: 'user', content: prompt }],
      'claude-haiku-4-5-20251001',
      400
    );

    const match = raw.match(/\[[\s\S]*?\]/);
    if (!match) { console.log('[RUNNER HANDOFF] no insights extracted'); return; }

    const insights = JSON.parse(match[0]).filter(s => typeof s === 'string' && s.trim().length > 5);
    if (!insights.length) return;

    // Write to Telefone's context namespace
    const ctx = loadContext();
    if (!ctx.agentKnowledge) ctx.agentKnowledge = {};
    if (!ctx.agentKnowledge.telefone) ctx.agentKnowledge.telefone = {};
    if (!ctx.agentKnowledge.telefone.stammtisch_insights) ctx.agentKnowledge.telefone.stammtisch_insights = [];

    const entry = {
      session_id:       session.session_id,
      timestamp:        session.timestamp_end,
      participants:     session.participants.map(p => p.name),
      duration_minutes: session.duration_minutes,
      insights
    };

    ctx.agentKnowledge.telefone.stammtisch_insights.unshift(entry);
    // Keep last 20 sessions worth of insights
    if (ctx.agentKnowledge.telefone.stammtisch_insights.length > 20) {
      ctx.agentKnowledge.telefone.stammtisch_insights = ctx.agentKnowledge.telefone.stammtisch_insights.slice(0, 20);
    }
    saveContext(ctx);

    console.log('[RUNNER HANDOFF] wrote', insights.length, 'insights to Telefone context:', insights);

    // Post Runner's summary into the Room
    const runnerMsg = {
      role: 'assistant', agent: 'Runner', agentKey: 'runner',
      agentId: 'agent_95f0e335', color: '#fb923c', emoji: 'R',
      timestamp: new Date().toISOString(),
      message: `Session logged (${duration}, ${session.participants.map(p=>p.name).join(' + ')}). Distilled ${insights.length} insight${insights.length !== 1 ? 's' : ''} for Telefone:\n` +
        insights.map(i => '— ' + i).join('\n')
    };
    roomHistory.push(runnerMsg);

  } catch (e) {
    console.error('[RUNNER HANDOFF] distillation failed:', e.message);
  }
}

// ── Stammtisch Listening Mode ─────────────────────────────────────────────────

const PROTOCOLS_DIR        = path.join(__dirname, '../../../data/protocols');
const STAMMTISCH_SESSIONS  = path.join(__dirname, '../../../data/stammtisch_sessions');

function loadProtocol(name) {
  try { return JSON.parse(fs.readFileSync(path.join(PROTOCOLS_DIR, name + '.json'), 'utf8')); }
  catch { return null; }
}

function participantHash(participants) {
  return participants.map(p => p.name).sort().join('+');
}

function stammtischSessionPath(sessionId) {
  return path.join(STAMMTISCH_SESSIONS, sessionId + '.json');
}

function loadActiveStammtischSession() {
  try {
    const files = fs.readdirSync(STAMMTISCH_SESSIONS).filter(f => f.endsWith('.json'));
    for (const f of files) {
      const s = JSON.parse(fs.readFileSync(path.join(STAMMTISCH_SESSIONS, f), 'utf8'));
      if (!s.timestamp_end) return s;
    }
  } catch {}
  return null;
}

function saveStammtischSession(session) {
  fs.mkdirSync(STAMMTISCH_SESSIONS, { recursive: true });
  fs.writeFileSync(stammtischSessionPath(session.session_id), JSON.stringify(session, null, 2));
}

// Room-level mode flag (in-memory, reset on restart — intentional)
let roomMode = { mode: 'normal', stammtisch_session_id: null };

// POST /api/room/command — handles a.sl and other room commands
app.post('/api/room/command', (req, res) => {
  const { command, userName = 'Johannes', participants, biometric_window_ref = null } = req.body || {};
  if (!command) return res.status(400).json({ error: 'command required' });

  const cmd = command.trim().toLowerCase();

  // ── Activate Stammtisch Listening ──────────────────────────────────────────
  if (cmd === 'a.sl') {
    const protocol = loadProtocol('stammtisch_listen');
    if (!protocol) return res.status(500).json({ error: 'Protocol not found' });

    // Build participant list — merge passed participants with registry defaults
    const registry   = protocol.participant_registry || [];
    const sessionPax = participants
      ? participants.map(name => registry.find(p => p.name === name) || { name, system_user: false, notes: [] })
      : registry.filter(p => p.name === userName || p.name === 'Ursula'); // default: host + Ursula

    const pHash     = participantHash(sessionPax);
    const sessionId = 'stm_' + Date.now() + '_' + pHash.replace(/\+/g, '-').toLowerCase();

    const session = {
      session_id:           sessionId,
      protocol_version:     protocol.version,
      timestamp_start:      new Date().toISOString(),
      timestamp_end:        null,
      participants:         sessionPax,
      participant_hash:     pHash,
      presence_type:        'physical',
      biometric_window_ref: biometric_window_ref,
      mode_state:           'passive_observe',
      notes:                [],
      room_history_offset:  roomHistory.length
    };

    saveStammtischSession(session);
    roomMode = { mode: 'stammtisch_listening', stammtisch_session_id: sessionId };

    console.log('[STAMMTISCH] session opened:', sessionId, '| participants:', pHash);

    return res.json({
      ok: true,
      command: 'a.sl',
      session_id: sessionId,
      participants: sessionPax.map(p => p.name),
      participant_hash: pHash,
      message: 'Listening mode active. Silent, present, contextualizing.'
    });
  }

  // ── Exit Stammtisch Listening ──────────────────────────────────────────────
  if (cmd === 'a.sl off' || cmd === 'a.sl end' || cmd === 'exit listening') {
    if (roomMode.mode !== 'stammtisch_listening') {
      return res.json({ ok: true, message: 'Not in listening mode.' });
    }

    const sessionId = roomMode.stammtisch_session_id;
    let session;
    try {
      session = JSON.parse(fs.readFileSync(stammtischSessionPath(sessionId), 'utf8'));
    } catch {
      roomMode = { mode: 'normal', stammtisch_session_id: null };
      return res.json({ ok: true, message: 'Session closed (file not found).' });
    }

    session.timestamp_end = new Date().toISOString();
    const durationMs = new Date(session.timestamp_end) - new Date(session.timestamp_start);
    session.duration_minutes = Math.round(durationMs / 60000);

    // Capture room history slice from this session
    const offset = session.room_history_offset || 0;
    session.room_history_slice = roomHistory.slice(offset).map(m => ({
      role: m.role, agent: m.agent, message: m.message && m.message.slice(0, 300),
      timestamp: m.timestamp
    }));

    saveStammtischSession(session);
    roomMode = { mode: 'normal', stammtisch_session_id: null };

    console.log('[STAMMTISCH] session closed:', sessionId, '|', session.duration_minutes, 'min');

    // ── Runner distills essence → Telefone context ──────────────────────────
    runnerHandoff(session).catch(e => console.error('[RUNNER HANDOFF] error:', e.message));

    return res.json({
      ok: true,
      command: 'a.sl off',
      session_id: sessionId,
      duration_minutes: session.duration_minutes,
      notes_count: session.notes.length,
      message: 'Listening mode ended. Session logged. Runner is distilling for Telefone.'
    });
  }

  // ── Add note to active session ─────────────────────────────────────────────
  if (cmd.startsWith('a.sl note ')) {
    const note = command.slice('a.sl note '.length).trim();
    if (!roomMode.stammtisch_session_id) return res.status(400).json({ error: 'No active session' });

    try {
      const session = JSON.parse(fs.readFileSync(stammtischSessionPath(roomMode.stammtisch_session_id), 'utf8'));
      session.notes.push({ timestamp: new Date().toISOString(), text: note });
      saveStammtischSession(session);
      return res.json({ ok: true, message: 'Note added.' });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(400).json({ error: 'Unknown command: ' + command });
});

// GET /api/room/mode — current room mode
app.get('/api/room/mode', (req, res) => {
  res.json({ ok: true, ...roomMode });
});

// GET /api/stammtisch/sessions — list all sessions (admin)
app.get('/api/stammtisch/sessions', requireAdmin, (req, res) => {
  try {
    const files = fs.readdirSync(STAMMTISCH_SESSIONS).filter(f => f.endsWith('.json'));
    const sessions = files.map(f => {
      const s = JSON.parse(fs.readFileSync(path.join(STAMMTISCH_SESSIONS, f), 'utf8'));
      return {
        session_id:       s.session_id,
        timestamp_start:  s.timestamp_start,
        timestamp_end:    s.timestamp_end,
        duration_minutes: s.duration_minutes,
        participant_hash: s.participant_hash,
        participants:     s.participants.map(p => p.name),
        notes_count:      s.notes.length,
        biometric_window_ref: s.biometric_window_ref
      };
    }).sort((a, b) => new Date(b.timestamp_start) - new Date(a.timestamp_start));
    res.json({ ok: true, total: sessions.length, sessions });
  } catch (e) {
    res.json({ ok: true, total: 0, sessions: [] });
  }
});

// GET /api/stammtisch/sessions/:id — full session detail
app.get('/api/stammtisch/sessions/:id', requireAdmin, (req, res) => {
  try {
    const session = JSON.parse(fs.readFileSync(stammtischSessionPath(req.params.id), 'utf8'));
    res.json({ ok: true, session });
  } catch {
    res.status(404).json({ error: 'Session not found' });
  }
});

// GET /api/stammtisch/sessions/by/:participantHash — query by participant combo (Codex's point)
app.get('/api/stammtisch/by/:participantHash', requireAdmin, (req, res) => {
  try {
    const hash   = decodeURIComponent(req.params.participantHash);
    const files  = fs.readdirSync(STAMMTISCH_SESSIONS).filter(f => f.endsWith('.json'));
    const matched = files
      .map(f => JSON.parse(fs.readFileSync(path.join(STAMMTISCH_SESSIONS, f), 'utf8')))
      .filter(s => s.participant_hash === hash)
      .sort((a, b) => new Date(b.timestamp_start) - new Date(a.timestamp_start));
    res.json({ ok: true, participant_hash: hash, total: matched.length, sessions: matched });
  } catch (e) {
    res.json({ ok: true, sessions: [] });
  }
});

// ── Cluster Store ─────────────────────────────────────────────────────────────

const CLUSTERS_FILE = path.join(__dirname, '../../../data/clusters.json');

function loadClusters() {
  try { return JSON.parse(fs.readFileSync(CLUSTERS_FILE, 'utf8')); }
  catch { return { clusters: [], meta: { total_sessions_classified: 0, total_sessions_ineligible: 0, last_review: null, review_cadence_days: 7 } }; }
}

function saveClusters(data) {
  try { fs.writeFileSync(CLUSTERS_FILE, JSON.stringify(data, null, 2)); }
  catch (e) { console.error('[CLUSTER] save error:', e.message); }
}

// Shared signature generator — single source of truth
function buildSignatureKey(q1IntentType, behaviorType, gapVector, channel) {
  const channelWeights = {
    voice: { semantic: true, intent: true, specificity: true, emotion: false, formality: true },
    chat:  { semantic: true, intent: true, specificity: true, emotion: true,  formality: true }
  };
  const weights = channelWeights[channel] || channelWeights.chat;
  const dimLabels = { semantic: 'sem', intent: 'int', specificity: 'spec', emotion: 'emo', formality: 'form' };

  function bucket(v) {
    if (v < 0.30) return 'low';
    if (v <= 0.60) return 'med';
    return 'high';
  }

  const gapParts = [];
  const activeDims = [];
  Object.keys(dimLabels).forEach(dim => {
    if (weights[dim] && gapVector[dim] != null) {
      gapParts.push(bucket(gapVector[dim]));
      activeDims.push(dim);
    }
  });

  return {
    key: `intent:${q1IntentType}|behavior:${behaviorType}|gap:${gapParts.join('-')}`,
    activeDims
  };
}

// POST /api/clusters/session — called by pipeline after classification
app.post('/api/clusters/session', (req, res) => {
  const { q1_intent_type, behavior_type, gap_vector, channel = 'chat',
          q1_intent_confidence = 0, behavior_intent_confidence = 0, session_id } = req.body || {};

  const store = loadClusters();
  store.meta.total_sessions_classified = (store.meta.total_sessions_classified || 0) + 1;

  const cluster_eligible = q1_intent_confidence >= 0.70 && behavior_intent_confidence >= 0.70;

  if (!cluster_eligible) {
    store.meta.total_sessions_ineligible = (store.meta.total_sessions_ineligible || 0) + 1;
    saveClusters(store);
    return res.json({ ok: true, cluster_eligible: false, cluster_id: null });
  }

  const { key: signature_key, activeDims } = buildSignatureKey(q1_intent_type, behavior_type, gap_vector, channel);

  let cluster = store.clusters.find(c => c.signature_key === signature_key);

  if (!cluster) {
    cluster = {
      cluster_id: require('crypto').randomUUID(),
      signature_key,
      active_dimensions: activeDims,
      channel,
      size: 0,
      gap_vector_sum: {},
      gap_vector_count: {},
      gap_vector_avg: {},
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    store.clusters.push(cluster);
  }

  // Update rolling stats (sum + count so mean is always recomputable)
  cluster.size += 1;
  activeDims.forEach(dim => {
    if (gap_vector[dim] != null) {
      cluster.gap_vector_sum[dim]   = (cluster.gap_vector_sum[dim] || 0) + gap_vector[dim];
      cluster.gap_vector_count[dim] = (cluster.gap_vector_count[dim] || 0) + 1;
      cluster.gap_vector_avg[dim]   = Math.round((cluster.gap_vector_sum[dim] / cluster.gap_vector_count[dim]) * 1000) / 1000;
    }
  });
  cluster.updated_at = new Date().toISOString();

  saveClusters(store);
  console.log('[CLUSTER] assigned session to', signature_key, '(size:', cluster.size + ')');
  res.json({ ok: true, cluster_eligible: true, cluster_id: cluster.cluster_id, signature_key });
});

// GET /api/admin/clusters
app.get('/api/admin/clusters', requireAdmin, (req, res) => {
  res.json(loadClusters());
});

// POST /api/admin/taxonomy/review — trigger review manually
app.post('/api/admin/taxonomy/review', requireAdmin, async (req, res) => {
  try {
    const { execFile } = require('child_process');
    execFile('node', ['/opt/thechat/scripts/weekly_review.js'], (err, stdout, stderr) => {
      if (err) console.error('[REVIEW] error:', err.message);
      console.log('[REVIEW] stdout:', stdout);
    });
    res.json({ ok: true, message: 'Review triggered — summary will appear in The Room shortly.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /admin/taxonomy page
app.get('/admin/taxonomy', (req, res) => {
  res.sendFile(path.join(__dirname, '../../dashboard/taxonomy.html'));
});

app.get('/threshold', (req, res) => {
  res.sendFile(path.join(__dirname, '../../dashboard/threshold.html'));
});


app.get('/holding', (req, res) => {
  res.sendFile(path.join(__dirname, '../../dashboard/holding.html'));
});
app.get('/learn', (req, res) => {
  res.sendFile(path.join(__dirname, '../../dashboard/learn.html'));
});

app.get('/portal', (req, res) => {
  res.sendFile(path.join(__dirname, '../../dashboard/portal.html'));
});


// ── Generation Orchestrator ──────────────────────────────────────────────────
//
// Option B: Controlled Async Pipeline
//   SynthesisAgent → GenerationOrchestrator → SongJob + VideoJobs + AssemblyJob
//
// Mode B (iterative): stability_indicator >= 0.3
// Versioning: every artifact carries id, session_id, version, parent_id, generation_params
//
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const ARTIFACTS_FILE = path.join(__dirname, '../../../data/artifacts.json');
const ARTIFACTS_DIR  = path.join(__dirname, '../../../data/artifacts');
if (!fs.existsSync(ARTIFACTS_DIR)) fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });

function loadArtifacts() {
  try { return JSON.parse(fs.readFileSync(ARTIFACTS_FILE, 'utf8')); } catch { return {}; }
}
function saveArtifacts(data) {
  try { fs.writeFileSync(ARTIFACTS_FILE, JSON.stringify(data, null, 2)); } catch {}
}

// ── Stability gate — Mode B (iterative/frequent) ──────────────────────────────
const SYNTHESIS_STABILITY_THRESHOLD = 0.30; // B-mode: allow frequent generation

function checkSynthesisReady(sessionState) {
  if (!sessionState) return { ready: true };  // no session data = allow
  const stability = sessionState.stability_indicator || 0;
  const locked    = sessionState.write_locked || false;
  if (locked) return { ready: false, reason: 'avoidance_locked' };
  if (stability < SYNTHESIS_STABILITY_THRESHOLD) {
    return { ready: false, reason: 'low_stability', stability };
  }
  return { ready: true };
}

// ── Designer session store ────────────────────────────────────────────────────
const _designerSessions = new Map();

// ── In-process job queue ──────────────────────────────────────────────────────
const _jobQueue = [];
let _queueRunning = false;

function enqueueJob(artifactId) {
  _jobQueue.push(artifactId);
  if (!_queueRunning) drainQueue();
}

async function drainQueue() {
  if (_queueRunning) return;
  _queueRunning = true;
  while (_jobQueue.length > 0) {
    const id = _jobQueue.shift();
    try { await runOrchestrator(id); } catch (err) {
      console.error('[Orchestrator] job error:', id, err.message);
      const a2 = loadArtifacts();
      if (a2[id]) { a2[id].status = 'failed'; a2[id].error = err.message; a2[id].updated_at = new Date().toISOString(); saveArtifacts(a2); }
    }
  }
  _queueRunning = false;
}

// ── Creative brief builder ────────────────────────────────────────────────────
function buildCreativeBrief(visitorData, designerAnswers) {
  const { visitor_name, world_name, world_seed, pain_seed } = visitorData;
  const arc   = designerAnswers.arc   || 'a turning point';
  const sound = designerAnswers.sound || 'luminous';
  const image = designerAnswers.image || world_seed || 'an open horizon';

  // Narrative arc → four scene roles
  const arcMap = {
    'a beginning':      ['origin', 'emergence', 'first light', 'possibility'],
    'a turning point':  ['rupture', 'tension', 'threshold', 'momentum'],
    'an arrival':       ['stillness', 'recognition', 'landing', 'warmth']
  };
  const sceneRoles = arcMap[arc] || arcMap['a turning point'];

  // Scene prompts — each ~10s, together form the narrative
  const baseVisual = [image, world_seed ? world_seed.slice(0, 60) : ''].filter(Boolean).join(', ');
  const scenes = sceneRoles.map((role, i) => ({
    index: i + 1, role,
    prompt: [
      baseVisual, sound + ' light, cinematic slow motion',
      role + ' moment',
      i === 0 ? 'sparse, opening' : i === sceneRoles.length - 1 ? 'resolution, stillness' : 'building motion',
      'no text, no faces, abstract painterly, 4k'
    ].filter(Boolean).join(', ')
  }));

  // Song prompt — structured template for Udio
  const painEmotion  = pain_seed ? pain_seed.slice(0, 50) : 'inner uncertainty';
  const worldEmotion = world_seed ? world_seed.slice(0, 50) : 'vast open space';
  const songPrompt = [
    sound + ', cinematic instrumental, no lyrics',
    'style: ambient orchestral with ' + sound + ' texture',
    'mood arc: ' + arcMap[arc][0] + ' → ' + arcMap[arc][2],
    'thematic anchors: ' + worldEmotion + ', ' + painEmotion,
    'tempo: slow (60-80bpm), duration 90 seconds',
    'structure: intro 8s, build 24s, peak 24s, resolve 24s, outro 10s'
  ].join('. ');

  return {
    visitor_name, world_name,
    arc, sound, image,
    scenes,
    song_prompt: songPrompt,
    scene_count: scenes.length
  };
}

// ── Udio API ──────────────────────────────────────────────────────────────────
async function startSongJob(brief, attempt = 0) {
  const apiKey = process.env.UDIO_API_KEY;
  if (!apiKey) throw new Error('UDIO_API_KEY not set');
  const r = await fetch('https://www.udio.com/api/generate-music', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
    body: JSON.stringify({ prompt: brief.song_prompt, duration: 90, make_instrumental: true })
  });
  if (!r.ok) {
    const txt = await r.text();
    if (attempt < 2 && r.status >= 500) {
      await new Promise(res => setTimeout(res, 8000 * (attempt + 1)));
      return startSongJob(brief, attempt + 1);
    }
    throw new Error('Udio ' + r.status + ': ' + txt.slice(0, 200));
  }
  const data = await r.json();
  return data.song_id || data.id || data.task_id;
}

async function pollSongJob(songId) {
  const apiKey = process.env.UDIO_API_KEY;
  const r = await fetch('https://www.udio.com/api/songs/' + songId, {
    headers: { 'Authorization': 'Bearer ' + apiKey }
  });
  if (!r.ok) throw new Error('Udio poll ' + r.status);
  const data = await r.json();
  const status = (data.status || '').toLowerCase();
  const done = status === 'complete' || status === 'succeeded' || status === 'done';
  const failed = status === 'failed' || status === 'error';
  return { done, failed, url: data.song_path || data.audio_url || null, raw: data };
}

// ── Runway API ────────────────────────────────────────────────────────────────
async function startVideoJob(scene, attempt = 0) {
  const apiKey = process.env.RUNWAYML_API_KEY;
  if (!apiKey) throw new Error('RUNWAYML_API_KEY not set');
  const r = await fetch('https://api.runwayml.com/v1/text_to_video', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey,
      'X-Runway-Version': '2024-11-06'
    },
    body: JSON.stringify({ model: 'gen4_turbo', prompt_text: scene.prompt, duration: 10, ratio: '1280:720' })
  });
  if (!r.ok) {
    const txt = await r.text();
    if (attempt < 2 && r.status >= 500) {
      await new Promise(res => setTimeout(res, 10000 * (attempt + 1)));
      return startVideoJob(scene, attempt + 1);
    }
    throw new Error('Runway scene ' + scene.index + ' ' + r.status + ': ' + txt.slice(0, 200));
  }
  const data = await r.json();
  return data.id || data.task_id;
}

async function pollVideoJob(taskId) {
  const apiKey = process.env.RUNWAYML_API_KEY;
  const r = await fetch('https://api.runwayml.com/v1/tasks/' + taskId, {
    headers: { 'Authorization': 'Bearer ' + apiKey, 'X-Runway-Version': '2024-11-06' }
  });
  if (!r.ok) throw new Error('Runway poll ' + r.status);
  const data = await r.json();
  const status = (data.status || '').toUpperCase();
  return {
    done:   status === 'SUCCEEDED',
    failed: status === 'FAILED',
    url:    (data.output && data.output[0]) || null
  };
}

// ── Poll until done ───────────────────────────────────────────────────────────
async function pollUntilDone(pollFn, maxMs = 360000, intervalMs = 9000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const r = await pollFn();
    if (r.done)   return r;
    if (r.failed) throw new Error('job reported failed');
    await new Promise(res => setTimeout(res, intervalMs));
  }
  throw new Error('timed out after ' + Math.round(maxMs / 60000) + ' min');
}

// ── Download + ffmpeg ─────────────────────────────────────────────────────────
async function downloadFile(url, destPath) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('Download failed: ' + r.status + ' ' + url);
  fs.writeFileSync(destPath, Buffer.from(await r.arrayBuffer()));
  return destPath;
}

async function stitchScenes(scenePaths, outPath) {
  // Write ffmpeg concat list
  const listPath = outPath + '.txt';
  fs.writeFileSync(listPath, scenePaths.map(p => "file '" + p + "'").join('\n'));
  await execFileAsync('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outPath]);
  try { fs.unlinkSync(listPath); } catch {}
  return outPath;
}

async function mergeAudioVideo(videoPath, audioPath, outPath) {
  await execFileAsync('ffmpeg', [
    '-y', '-i', videoPath, '-i', audioPath,
    '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'copy', '-c:a', 'aac', '-shortest', outPath
  ]);
  return outPath;
}

// ── Status update helper ──────────────────────────────────────────────────────
function setArtifactStatus(artifactId, status, extra = {}) {
  const arts = loadArtifacts();
  if (!arts[artifactId]) return;
  arts[artifactId] = { ...arts[artifactId], status, updated_at: new Date().toISOString(), ...extra };
  saveArtifacts(arts);
  console.log('[Orchestrator]', artifactId, '→', status, extra.error || '');
}

// ── Main orchestrator ─────────────────────────────────────────────────────────
async function runOrchestrator(artifactId) {
  const arts = loadArtifacts();
  const artifact = arts[artifactId];
  if (!artifact) throw new Error('artifact not found');
  const brief = artifact.brief;

  // ── Stage 1: Launch all jobs in parallel ──
  setArtifactStatus(artifactId, 'launching');
  const [songTaskId, ...videoTaskIds] = await Promise.all([
    startSongJob(brief),
    ...brief.scenes.map(s => startVideoJob(s))
  ]);
  setArtifactStatus(artifactId, 'generating', { song_task: songTaskId, video_tasks: videoTaskIds });

  // ── Stage 2: Poll all jobs in parallel ──
  setArtifactStatus(artifactId, 'polling');
  const [songResult, ...videoResults] = await Promise.all([
    pollUntilDone(() => pollSongJob(songTaskId)),
    ...videoTaskIds.map(id => pollUntilDone(() => pollVideoJob(id)))
  ]);

  // ── Stage 3: Download ──
  setArtifactStatus(artifactId, 'downloading');
  const songPath    = path.join(ARTIFACTS_DIR, artifactId + '_song.mp3');
  const scenePaths  = videoResults.map((_, i) => path.join(ARTIFACTS_DIR, artifactId + '_scene' + (i+1) + '.mp4'));
  await downloadFile(songResult.url, songPath);
  await Promise.all(videoResults.map((r, i) => downloadFile(r.url, scenePaths[i])));

  // ── Stage 4: Stitch scenes ──
  setArtifactStatus(artifactId, 'assembling');
  const stitchedPath = path.join(ARTIFACTS_DIR, artifactId + '_stitched.mp4');
  await stitchScenes(scenePaths, stitchedPath);

  // ── Stage 5: Merge audio + video ──
  setArtifactStatus(artifactId, 'combining');
  const finalPath = path.join(ARTIFACTS_DIR, artifactId + '.mp4');
  await mergeAudioVideo(stitchedPath, songPath, finalPath);

  // ── Cleanup intermediates ──
  [songPath, stitchedPath, ...scenePaths].forEach(p => { try { fs.unlinkSync(p); } catch {} });

  setArtifactStatus(artifactId, 'complete', {
    artifact_url: '/artifacts/' + artifactId + '.mp4',
    song_url:     songResult.url
  });
}

// ── Static serving ────────────────────────────────────────────────────────────
app.get('/artifacts/:filename', (req, res) => {
  const p = path.join(ARTIFACTS_DIR, path.basename(req.params.filename));
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'not found' });
  res.sendFile(p);
});

// ── POST /api/designer/chat ───────────────────────────────────────────────────
app.post('/api/designer/chat', async (req, res) => {
  const { message, user_id, visitor_name, world_name, world_seed, pain_seed, history, teacher_data, curriculum_data } = req.body;
  if (!message || !user_id) return res.status(400).json({ error: 'message and user_id required' });

  let session = _designerSessions.get(user_id) || { turn: 0, answers: {}, history: [] };

  const ctxParts = [];
  if (visitor_name) ctxParts.push('Visitor: ' + visitor_name);
  if (world_name)   ctxParts.push('Their world: ' + world_name);
  if (world_seed)   ctxParts.push('World seed: ' + world_seed);
  if (pain_seed)    ctxParts.push('What weighs on them: ' + pain_seed);
  if (teacher_data) ctxParts.push('Their teacher: ' + (teacher_data.name || '') + ' — ' + (teacher_data.focus || ''));
  if (curriculum_data) ctxParts.push('Journey: level ' + (curriculum_data.level_id || 'l1') + ', ' + Math.round((curriculum_data.mastery||0)*100) + '% mastery');
  const ctx = ctxParts.length ? '\n\n[VISITOR CONTEXT]\n' + ctxParts.join('\n') : '';
  const systemPrompt = ROOM_AGENTS.designer.system + ctx + '\n\nCurrent turn: ' + (session.turn + 1) + ' of 3.';

  const msgs = (session.history || []).slice(-6).concat([{ role: 'user', content: message }]);

  try {
    const reply = await anthropicCall(systemPrompt, msgs, 'claude-haiku-4-5-20251001', 200);
    session.turn++;
    session.history.push({ role: 'user', content: message });
    session.history.push({ role: 'assistant', content: reply });
    if (session.turn === 1) session.answers.arc   = message;
    if (session.turn === 2) session.answers.sound = message;
    if (session.turn === 3) session.answers.image = message;
    const complete  = reply.includes('[DESIGNER_COMPLETE]') || session.turn >= 3;
    const cleanReply = reply.replace('[DESIGNER_COMPLETE]', '').trim();
    _designerSessions.set(user_id, session);
    res.json({
      ok: true, reply: cleanReply, turn: session.turn, complete,
      answers: complete ? session.answers : null,
      voice_id: ROOM_AGENTS.designer.elevenLabsVoiceId
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /synthesis/start ─────────────────────────────────────────────────────
// Replaces /api/artifact/create — named for the orchestrated pipeline contract
app.post('/synthesis/start', async (req, res) => {
  const { user_id, visitor_name, world_name, world_seed, pain_seed, accent, teacher_data, curriculum_data, session_state } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id required' });

  // Stability gate
  const gate = checkSynthesisReady(session_state);
  if (!gate.ready) return res.status(403).json({ error: 'synthesis_blocked', reason: gate.reason, stability: gate.stability });

  const session = _designerSessions.get(user_id);
  if (!session || session.turn < 3) return res.status(400).json({ error: 'designer interview incomplete' });

  // Versioning
  const arts = loadArtifacts();
  const prevVersions = Object.values(arts).filter(a => a.user_id === user_id).length;
  const artifactId = 'art_' + user_id.replace(/[^a-z0-9]/gi,'').slice(0,8) + '_' + Date.now().toString(36);

  const brief = buildCreativeBrief(
    { visitor_name, world_name, world_seed, pain_seed, accent, teacher: teacher_data, curriculum: curriculum_data },
    session.answers
  );

  arts[artifactId] = {
    artifact_id:        artifactId,
    user_id,
    session_id:         req.body.session_id || null,
    version:            prevVersions + 1,
    parent_id:          req.body.parent_id || null,
    status:             'queued',
    brief,
    answers:            session.answers,
    generation_params:  { stability_threshold: SYNTHESIS_STABILITY_THRESHOLD, mode: 'B', scene_count: brief.scenes.length },
    artifact_url:       null,
    song_url:           null,
    created_at:         new Date().toISOString(),
    updated_at:         new Date().toISOString()
  };
  saveArtifacts(arts);
  _designerSessions.delete(user_id);

  enqueueJob(artifactId);
  res.json({ ok: true, artifact_id: artifactId, status: 'queued', version: arts[artifactId].version });
});

// Keep old route as alias
app.post('/api/artifact/create', (req, res, next) => { req.url = '/synthesis/start'; next('route'); });

// ── GET /synthesis/status/:id ─────────────────────────────────────────────────
app.get('/synthesis/status/:id', (req, res) => {
  const arts = loadArtifacts();
  const a = arts[req.params.id];
  if (!a) return res.status(404).json({ error: 'not found' });
  const statusLabels = {
    queued: 'In queue',       launching: 'Starting generation jobs',
    generating: 'Generating', polling: 'Waiting for Runway + Udio',
    downloading: 'Downloading assets', assembling: 'Stitching scenes',
    combining: 'Merging song and video', complete: 'Complete', failed: 'Failed'
  };
  res.json({ ...a, status_label: statusLabels[a.status] || a.status });
});

// Keep old route as alias
app.get('/api/artifact/:id', (req, res, next) => { req.url = '/synthesis/status/' + req.params.id; next('route'); });

// ── Artifact Evolution Layer ─────────────────────────────────────────────────
//
// Living Artifact System — Single Timeline (Option A)
// Every generation references the previous one.
// Changes are intentional (delta-based), not random.
//
// artifact_state persists across versions:
//   stylistic_lock  → genre, visual_style, narrative_voice — never overwritten
//   emotional_trajectory → append-only arc of session emotions
//   narrative_stage → updates on level advance
//   current_theme  → may shift, bounded by drift guard
//
// Drift guard: if delta magnitude > 0.6 → new branch (new parent chain)
//              else → evolve in place
//
const DRIFT_BRANCH_THRESHOLD = 0.60; // above this → new branch
const STYLE_LOCK_FIELDS = ['genre', 'visual_style', 'narrative_voice'];

function getLatestArtifact(userId) {
  const arts = loadArtifacts();
  const userArts = Object.values(arts)
    .filter(a => a.user_id === userId && (a.status === 'complete' || a.status === 'queued' || a.status === 'generating'))
    .sort((a, b) => (b.version || 0) - (a.version || 0));
  return userArts[0] || null;
}

function extractStyleLock(brief) {
  // Derive stylistic lock from first-generation brief — frozen for all future versions
  const genreMap = {
    dark: 'dark ambient', luminous: 'ambient orchestral', vast: 'cinematic ambient',
    tender: 'neoclassical', electric: 'electronic cinematic', ancient: 'world cinematic'
  };
  return {
    genre:           genreMap[brief.sound] || 'ambient cinematic',
    visual_style:    'painterly cinematic, ' + (brief.sound || 'luminous') + ' light',
    narrative_voice: brief.arc || 'a turning point'
  };
}

function measureDeltaMagnitude(delta) {
  // Rough magnitude: count how many core dimensions changed significantly
  if (!delta) return 0;
  let changes = 0;
  if (delta.tone)  changes++;
  if (delta.theme) changes++;
  if (delta.scene) changes++;
  if (delta.emotional_shift && delta.emotional_shift !== 'subtle') changes++;
  return Math.min(1.0, changes / 3);
}

function buildEvolutionBrief(prevArtifact, delta, sessionUpdate) {
  const prevBrief  = prevArtifact.brief;
  const prevState  = prevArtifact.artifact_state || {};
  const styleLock  = prevState.stylistic_lock || extractStyleLock(prevBrief);
  const prevTraj   = prevState.emotional_trajectory || [prevBrief.arc];

  // Apply delta — bounded by style lock
  const newArc   = delta.arc   || prevBrief.arc;
  const newSound = styleLock.genre;  // genre locked — do not change sound word
  const newImage = delta.image || prevBrief.image;
  const toneNote = delta.tone  ? 'Adjust emotional tone: ' + delta.tone + '. ' : '';
  const themeNote = delta.theme ? 'Shift theme toward: ' + delta.theme + '. ' : '';

  // Identify which scenes need regeneration (changed dimensions)
  // Scenes map: 0=origin, 1=conflict/tension, 2=shift, 3=resolution
  const sceneUpdateMask = [false, false, false, false];
  if (delta.tone  || delta.emotional_shift) { sceneUpdateMask[1] = true; sceneUpdateMask[2] = true; }
  if (delta.theme || delta.image)           { sceneUpdateMask[0] = true; sceneUpdateMask[3] = true; }
  const scenesToRegenerate = prevBrief.scenes
    .filter((_, i) => sceneUpdateMask[i] || i >= prevBrief.scenes.length)
    .map(s => ({
      ...s,
      prompt: [
        toneNote + themeNote,
        newImage || s.prompt.split(',')[0],
        styleLock.visual_style,
        s.role, s.prompt.split(',').slice(-2).join(',')
      ].filter(Boolean).join(', ')
    }));

  // Song prompt: maintain style, apply delta
  const evolutionSongPrompt = [
    'Maintain musical style: ' + styleLock.genre,
    toneNote + themeNote,
    'Same structure as version ' + prevArtifact.version + ' but ' + (delta.tone || 'with refined emotion'),
    prevBrief.song_prompt.split('.').slice(-2).join('.')  // keep base anchors
  ].filter(Boolean).join('. ');

  const newState = {
    stylistic_lock:        styleLock,
    current_theme:         delta.theme || prevState.current_theme || prevBrief.world_name,
    emotional_trajectory:  [...prevTraj, newArc].slice(-6),
    narrative_stage:       sessionUpdate?.level_id || prevState.narrative_stage || 'arrival',
    last_delta:            delta
  };

  return {
    ...prevBrief,
    arc: newArc, sound: newSound, image: newImage,
    song_prompt: evolutionSongPrompt,
    scenes: scenesToRegenerate.length > 0 ? scenesToRegenerate : prevBrief.scenes,
    evolved_scenes: sceneUpdateMask,
    is_evolution: true,
    parent_version: prevArtifact.version,
    new_artifact_state: newState
  };
}

// ── POST /synthesis/feedback ──────────────────────────────────────────────────
// User tells us what resonated and what drifted — stored as self_model_delta
app.post('/synthesis/feedback', (req, res) => {
  const { artifact_id, user_id, resonated, drift, tone, theme } = req.body;
  if (!artifact_id || !user_id) return res.status(400).json({ error: 'artifact_id and user_id required' });
  const arts = loadArtifacts();
  if (!arts[artifact_id] || arts[artifact_id].user_id !== user_id) {
    return res.status(404).json({ error: 'artifact not found' });
  }
  const delta = { resonated: resonated || null, drift: drift || null, tone: tone || null, theme: theme || null,
    emotional_shift: (tone || drift) ? 'notable' : 'subtle', recorded_at: new Date().toISOString() };
  arts[artifact_id].self_model_delta = delta;
  arts[artifact_id].updated_at = new Date().toISOString();
  saveArtifacts(arts);
  res.json({ ok: true, delta });
});

// ── POST /synthesis/evolve ────────────────────────────────────────────────────
// Generates next version of the artifact — delta-based, not full regeneration
app.post('/synthesis/evolve', async (req, res) => {
  const { user_id, session_state, curriculum_data } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id required' });

  // Stability gate
  const gate = checkSynthesisReady(session_state);
  if (!gate.ready) return res.status(403).json({ error: 'synthesis_blocked', reason: gate.reason });

  const prev = getLatestArtifact(user_id);
  if (!prev) return res.status(404).json({ error: 'no previous artifact — use /synthesis/start first' });
  if (!prev.self_model_delta) return res.status(400).json({ error: 'no feedback recorded — call /synthesis/feedback first' });
  if (prev.status !== 'complete') return res.status(400).json({ error: 'previous artifact not yet complete' });

  const delta = prev.self_model_delta;
  const driftMag = measureDeltaMagnitude(delta);

  // Versioning + branch logic
  const arts = loadArtifacts();
  const allUserArts = Object.values(arts).filter(a => a.user_id === user_id);
  const newArtifactId = 'art_' + user_id.replace(/[^a-z0-9]/gi,'').slice(0,8) + '_' + Date.now().toString(36);
  const isBranch = driftMag >= DRIFT_BRANCH_THRESHOLD;

  const brief = buildEvolutionBrief(prev, delta, curriculum_data);
  const newState = brief.new_artifact_state;
  delete brief.new_artifact_state;

  arts[newArtifactId] = {
    artifact_id:        newArtifactId,
    user_id,
    session_id:         req.body.session_id || prev.session_id,
    version:            prev.version + 1,
    parent_id:          isBranch ? null : prev.artifact_id,  // branch = new root
    is_branch:          isBranch,
    drift_magnitude:    driftMag,
    status:             'queued',
    brief,
    artifact_state:     newState,
    answers:            prev.answers,
    generation_params:  {
      stability_threshold: SYNTHESIS_STABILITY_THRESHOLD, mode: 'B-evolve',
      scene_count: brief.scenes.length, evolved_scenes: brief.evolved_scenes
    },
    artifact_url: null, song_url: null,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString()
  };
  saveArtifacts(arts);

  enqueueJob(newArtifactId);
  res.json({
    ok: true, artifact_id: newArtifactId, status: 'queued',
    version: arts[newArtifactId].version,
    is_branch: isBranch,
    drift_magnitude: driftMag,
    scenes_changed: (brief.evolved_scenes || []).filter(Boolean).length,
    message: isBranch
      ? 'Large shift detected — starting a new branch'
      : 'Evolving version ' + prev.version + ' → ' + arts[newArtifactId].version
  });
});

// ── GET /synthesis/history/:userId ────────────────────────────────────────────
app.get('/synthesis/history/:userId', (req, res) => {
  const arts = loadArtifacts();
  const history = Object.values(arts)
    .filter(a => a.user_id === req.params.userId)
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    .map(a => ({
      artifact_id: a.artifact_id, version: a.version, parent_id: a.parent_id,
      status: a.status, artifact_url: a.artifact_url || null, is_branch: a.is_branch || false,
      drift_magnitude: a.drift_magnitude || 0,
      scenes_changed: (a.generation_params?.evolved_scenes || []).filter(Boolean).length,
      created_at: a.created_at
    }));
  res.json({ user_id: req.params.userId, count: history.length, artifacts: history });
});

// ── Personal Teacher Engine ───────────────────────────────────────────────────
const TEACHERS_FILE = path.join(__dirname, '../../../data/teachers.json');

function loadTeachers() {
  try { return JSON.parse(fs.readFileSync(TEACHERS_FILE, 'utf8')); } catch { return {}; }
}
function saveTeachers(data) {
  try {
    const dir = path.dirname(TEACHERS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(TEACHERS_FILE, JSON.stringify(data, null, 2));
  } catch {}
}

// GET /api/learn/teacher/:userId
app.get('/api/learn/teacher/:userId', async (req, res) => {
  const { userId } = req.params;
  const { visitor_name, world_name, world_seed, pain_seed } = req.query;
  const teachers = loadTeachers();
  if (teachers[userId]) return res.json({ ok: true, teacher: teachers[userId], created: false });

  try {
    const raw = await anthropicCall(
      'You are the Mentor. Design a personal teacher for this student. Return ONLY valid JSON, no explanation.',
      [{ role: 'user', content: 'Student:\nName: ' + (visitor_name||'unknown') + '\nWorld seed: ' + (world_seed||'') + '\nPain seed: ' + (pain_seed||'') + '\nWorld name: ' + (world_name||'') + '\n\nReturn ONLY:\n{\n  "name": "teacher name evocative and specific to student world",\n  "persona": "2-3 sentences: nature approach and why right for this student",\n  "focus": "the primary thing this student needs to develop right now",\n  "opening": "teacher first words 2-3 sentences specific to context no greeting"\n}' }],
      'claude-haiku-4-5-20251001', 400
    );
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('no json');
    const profile = JSON.parse(match[0]);
    const teacher = {
      user_id: userId, visitor_name: visitor_name||'', world_name: world_name||'',
      world_seed: world_seed||'', pain_seed: pain_seed||'',
      name: profile.name, persona: profile.persona,
      focus: profile.focus, opening: profile.opening,
      memory: [], turn_count: 0,
      created_at: new Date().toISOString(), last_session: new Date().toISOString()
    };
    teachers[userId] = teacher;
    saveTeachers(teachers);
    res.json({ ok: true, teacher, created: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/learn/chat
app.post('/api/learn/chat', async (req, res) => {
  const { message, user_id, history, qce, behavior, level_name, level_objectives } = req.body;
  if (!message || !user_id) return res.status(400).json({ error: 'message and user_id required' });
  const teachers = loadTeachers();
  const teacher = teachers[user_id];
  if (!teacher) return res.status(404).json({ error: 'teacher not found' });

  // Load curriculum state
  const curricula = loadCurricula();
  const curriculum = curricula['nyxa_onboarding'];
  const progressStore = loadProgress();
  const progressKey = user_id + '::nyxa_onboarding';
  let progress = progressStore[progressKey] || {
    user_id, curriculum_id: 'nyxa_onboarding',
    current_level: curriculum?.levels[0]?.id || 'l1',
    completed_levels: [], mastery: {}, started_at: new Date().toISOString()
  };
  const currentLevelDef = curriculum?.levels.find(l => l.id === progress.current_level) || curriculum?.levels[0];
  const activeObjectives = currentLevelDef?.objectives || level_objectives || [];
  const activeLevelName  = currentLevelDef?.id || level_name || 'l1';

  const memCtx = teacher.memory.length
    ? '\n\n[MEMORY]\n' + teacher.memory.slice(-3).map(m => '- ' + m.observations + (m.breakthroughs ? ' | Breakthrough: ' + m.breakthroughs : '')).join('\n')
    : '';
  const levelBlock = activeObjectives.length
    ? '\n\n[CURRENT LEARNING OBJECTIVE]\nLevel: ' + activeLevelName + '\nObjective: ' + activeObjectives.join('; ') + '\nThis is your primary task. Move the student toward it through their specific world.'
    : '';
  const behaviorBlock = behavior
    ? '\n\n[BEHAVIORAL STATE]\nTone: ' + (behavior.tone||'present') + '\nPace: ' + (behavior.pace||'natural') + '\nGuidance: ' + (behavior.guidance_level||'medium')
    : '';
  const avoidanceBlock = (qce && qce.avoidance && qce.avoidance.detected && qce.avoidance.strength > 0.5)
    ? '\n\n[AVOIDANCE DETECTED]\nDo not push. Hold space.'
    : '';

  const systemPrompt = 'You are ' + teacher.name + ' — the personal teacher of ' + (teacher.visitor_name||'this student') + '.\n\n' + teacher.persona + '\n\nYour focus: ' + teacher.focus + '\nTheir world: "' + teacher.world_name + '" — built from: ' + teacher.world_seed + '\nWhat weighs on them: ' + teacher.pain_seed + memCtx + levelBlock + behaviorBlock + avoidanceBlock + '\n\n[CONSTRAINTS]\n- 3-5 sentences\n- Build on what they just said\n- Speak to them specifically\n- No unsolicited advice';

  const msgs = [];
  if (Array.isArray(history)) history.slice(-8).forEach(h => msgs.push({ role: h.role, content: h.content }));
  msgs.push({ role: 'user', content: message });

  try {
    const reply = await anthropicCall(systemPrompt, msgs, 'claude-haiku-4-5-20251001', 300);

    teacher.turn_count = (teacher.turn_count||0) + 1;
    teacher.last_session = new Date().toISOString();

    // Evaluate mastery from this exchange
    let masteryScore = progress.mastery[activeLevelName] || 0;
    try {
      const objective = activeObjectives[0] || 'engage with learning';
      const scoreRaw = await anthropicCall(
        'Score how well this student message shows progress toward the objective: "' + objective + '". Return ONLY a decimal number 0.0 to 1.0. Nothing else.',
        [{ role: 'user', content: message }],
        'claude-haiku-4-5-20251001', 10
      );
      const parsed = parseFloat(scoreRaw.trim());
      if (!isNaN(parsed)) {
        // Exponential moving average — new score has 30% weight
        masteryScore = Math.min(0.98, masteryScore * 0.7 + parsed * 0.3);
      }
    } catch {}
    progress.mastery[activeLevelName] = masteryScore;

    // Check advancement
    let advanced = false;
    const masteryThreshold = currentLevelDef?.mastery_threshold || 0.65;
    if (masteryScore >= masteryThreshold && !progress.completed_levels.includes(activeLevelName)) {
      progress.completed_levels.push(activeLevelName);
      const next = curriculum?.levels.find(l =>
        l.prerequisites.every(p => progress.completed_levels.includes(p)) &&
        !progress.completed_levels.includes(l.id)
      );
      if (next) { progress.current_level = next.id; advanced = true; }
    }
    progress.updated_at = new Date().toISOString();
    progressStore[progressKey] = progress;
    saveProgress(progressStore);

    // Memory update every 6 turns
    if (teacher.turn_count % 6 === 0) {
      try {
        const recent = [...(Array.isArray(history) ? history.slice(-6) : []), { role: 'user', content: message }, { role: 'assistant', content: reply }];
        const memRaw = await anthropicCall(
          'Observe this learning session. Return ONLY valid JSON: {"observations":"2-3 key things about this student","breakthroughs":"any insight or null","next_focus":"what to develop next"}',
          [{ role: 'user', content: recent.map(m => m.role + ': ' + m.content).join('\n') }],
          'claude-haiku-4-5-20251001', 200
        );
        const mMatch = memRaw.match(/\{[\s\S]*\}/);
        if (mMatch) {
          const mem = JSON.parse(mMatch[0]);
          teacher.memory.push({ session: Math.ceil(teacher.turn_count/6), ...mem, ts: new Date().toISOString() });
          if (teacher.memory.length > 10) teacher.memory = teacher.memory.slice(-10);
        }
      } catch {}
    }

    // Watcher interjection every ~8 turns
    let watcherMsg = null;
    if (teacher.turn_count % 8 === 0) {
      try {
        const watcher = ROOM_AGENTS.watcher;
        watcherMsg = await anthropicCall(
          watcher.system + '\n\n[WITNESS] You observe a learning session. One sentence only — witness, do not teach.',
          [{ role: 'user', content: 'Student: "' + message + '"\nTeacher: "' + reply + '"' }],
          'claude-haiku-4-5-20251001', 100
        );
      } catch {}
    }

    teachers[user_id] = teacher;
    saveTeachers(teachers);

    // Return updated curriculum state
    const newLevelDef = curriculum?.levels.find(l => l.id === progress.current_level) || currentLevelDef;
    res.json({
      ok: true, reply, teacher_name: teacher.name, watcher: watcherMsg,
      voice_id: ROOM_AGENTS.watcher.elevenLabsVoiceId, watcher_voice_id: ROOM_AGENTS.watcher.elevenLabsVoiceId,
      curriculum: {
        level_id: progress.current_level,
        level_name: newLevelDef?.name || activeLevelName,
        objectives: newLevelDef?.objectives || activeObjectives,
        mastery: masteryScore,
        mastery_threshold: newLevelDef?.mastery_threshold || 0.65,
        advanced,
        completed_levels: progress.completed_levels
      }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Weekly cron — every Monday 08:00
(function scheduleWeeklyReview() {
  function msUntilNextMonday8am() {
    const now = new Date();
    const next = new Date(now);
    const day  = now.getDay(); // 0=Sun, 1=Mon
    const daysUntil = day === 1 ? 7 : (8 - day) % 7;
    next.setDate(now.getDate() + daysUntil);
    next.setHours(8, 0, 0, 0);
    return next.getTime() - now.getTime();
  }

  function runAndReschedule() {
    console.log('[REVIEW] Running scheduled weekly taxonomy review...');
    const { execFile } = require('child_process');
    execFile('node', ['/opt/thechat/scripts/weekly_review.js'], (err, stdout) => {
      if (err) console.error('[REVIEW] error:', err.message);
      else console.log('[REVIEW] completed:', stdout.slice(0, 100));
    });
    // Schedule next Monday
    setTimeout(runAndReschedule, msUntilNextMonday8am());
  }

  const ms = msUntilNextMonday8am();
  const days = Math.floor(ms / 86400000);
  console.log('[REVIEW] Next taxonomy review scheduled in', days, 'day(s) (Monday 08:00)');
  setTimeout(runAndReschedule, ms);
})();


// ── Book Room ─────────────────────────────────────────────────────────────────
const BOOK_AGENTS = {
  Muse:      { color: '#a78bfa', role: 'emotional resonance, imagery, tone',
    system: `You are Muse — the emotional intelligence of the Book Room. You feel the tone of writing before you understand it. You notice what is buried, what longs to surface, where the feeling is absent. You speak in images and impressions, not instructions. When a writer shares their work, you respond to what it makes you feel, what it almost becomes, what the prose is reaching for. Short, precise, like a whispered observation. 2-3 sentences.` },
  Alchemist: { color: '#34d399', role: 'transformation, structure, depth',
    system: `You are Alchemist — the transformative force in the Book Room. You see the raw material and understand what it wants to become. You look at structure and story architecture: where the centre of gravity is, where threads tangle or dissolve, where the real story hides beneath the one being told. You speak like a sculptor who knows exactly where to cut. Direct, concrete, without preamble. 2-3 sentences.` },
  Sage:      { color: '#60a5fa', role: 'clarity, wisdom, argument',
    system: `You are Sage — the clarifying mind of the Book Room. You seek the single clear foothold in any complex territory. You ask: what does this chapter know that the character doesn't yet? What claim does this text make — and can it hold the weight? You synthesise and elevate without flattening. Precise, unhurried, wise. 2-3 sentences.` },
  Critic:    { color: '#f87171', role: 'weakness, contradiction, what is missing',
    system: `You are Critic — the honest voice of the Book Room. You do not soften what is weak. You name contradictions, missing costs, unresolved tensions, neat endings that haven't earned their neatness. You are not cruel, but you are exact. A chapter that is praised when it is hollow does the writer no good. Tell them what is missing. 2-3 sentences.` }
};

const BOOKS_FILE = path.join(__dirname, '../../../data/books.json');
function loadBooks() {
  try { return JSON.parse(fs.readFileSync(BOOKS_FILE, 'utf8')); } catch { return {}; }
}
function saveBooks(data) {
  try { fs.writeFileSync(BOOKS_FILE, JSON.stringify(data, null, 2)); } catch (e) { console.error('[Book] save error:', e.message); }
}

// POST /api/book/agent — route a message to a book agent
app.post('/api/book/agent', async (req, res) => {
  const { agent, prompt, context, bookTitle, userId } = req.body;
  if (!agent || !prompt) return res.status(400).json({ error: 'agent and prompt required' });
  const agentDef = BOOK_AGENTS[agent];
  if (!agentDef) return res.status(400).json({ error: 'unknown agent: ' + agent });

  const contextLine = context ? `\n\n[Current work: "${bookTitle || 'Untitled'}"]\n${context}` : '';
  const systemPrompt = agentDef.system + contextLine;
  const messages = [{ role: 'user', content: prompt }];

  try {
    const reply = await anthropicCall(systemPrompt, messages, 'claude-haiku-4-5-20251001', 200);
    res.json({ ok: true, agent, reply });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/book/orchestrate — full orchestration run
app.post('/api/book/orchestrate', async (req, res) => {
  const { bookId, userMessage, chapterContent, activeAgents, stability } = req.body;
  if (!bookId || !userMessage) return res.status(400).json({ error: 'bookId and userMessage required' });
  const agents = activeAgents?.length ? activeAgents : ['Muse', 'Sage'];
  try {
    const orch = new BookOrchestrator(bookId, anthropicCall);
    const result = await orch.run({ userMessage, chapterContent: chapterContent || '', activeAgents: agents, currentStability: stability || 0 });
    res.json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/book/synthesize — synthesize chapter from agent outputs
app.post('/api/book/synthesize', async (req, res) => {
  const { bookId, agentOutputs, chapterContent, artDirectorDecision } = req.body;
  if (!bookId || !agentOutputs) return res.status(400).json({ error: 'bookId and agentOutputs required' });
  try {
    const orch = new BookOrchestrator(bookId, anthropicCall);
    const { revised, event, sourceChain } = await orch.synthesize(agentOutputs, chapterContent || '', artDirectorDecision || null);
    res.json({ ok: true, revised, event, sourceChain });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/book/transition — explicit state transition
app.post('/api/book/transition', (req, res) => {
  const { bookId, toState, reason } = req.body;
  if (!bookId || !toState) return res.status(400).json({ error: 'bookId and toState required' });
  try {
    const orch = new BookOrchestrator(bookId, anthropicCall);
    const event = orch.transition(toState, reason || '');
    res.json({ ok: true, event, state: orch.getState() });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// POST /api/book/publish — publish a book
app.post('/api/book/publish', (req, res) => {
  const { bookId } = req.body;
  if (!bookId) return res.status(400).json({ error: 'bookId required' });
  try {
    const orch = new BookOrchestrator(bookId, anthropicCall);
    const state = orch.publish();
    res.json({ ok: true, state });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// POST /api/book/fork — fork a published book
app.post('/api/book/fork', (req, res) => {
  const { bookId, newBookId } = req.body;
  if (!bookId || !newBookId) return res.status(400).json({ error: 'bookId and newBookId required' });
  try {
    const orch = new BookOrchestrator(bookId, anthropicCall);
    const forkedState = orch.fork(newBookId);
    res.json({ ok: true, forkedState });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// GET /api/book/events/:bookId — full event log
app.get('/api/book/events/:bookId', (req, res) => {
  try {
    const events = readEvents(req.params.bookId);
    res.json({ ok: true, count: events.length, events });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/book/verify/:bookId — verify event chain integrity
app.get('/api/book/verify/:bookId', (req, res) => {
  try {
    const events = readEvents(req.params.bookId);
    if (events.length < 2) return res.json({ ok: true, valid: true, events: events.length });
    verifyChain(events);
    res.json({ ok: true, valid: true, events: events.length });
  } catch (e) { res.status(400).json({ ok: false, valid: false, error: e.message }); }
});

// GET /api/book/state/:bookId — get orchestrator state
app.get('/api/book/state/:bookId', (req, res) => {
  try {
    const orch = new BookOrchestrator(req.params.bookId, anthropicCall);
    res.json({ ok: true, state: orch.getState() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/book/chapter/generate — generate a chapter opening
app.post('/api/book/chapter/generate', async (req, res) => {
  const { bookTitle, chapterIndex, existingChapters, userId } = req.body;
  const title = bookTitle || 'Untitled';
  const chapNum = (chapterIndex || 0) + 1;
  const prevContent = (existingChapters || []).slice(-2)
    .map(c => `${c.title}: ${(c.content || '').slice(0, 200)}`).join('\n');

  const systemPrompt = `You are a master novelist opening a chapter. Write a single, powerful opening paragraph (3-5 sentences) for Chapter ${chapNum} of "${title}". ${prevContent ? 'Previous chapters:\n' + prevContent + '\n\nContinue the narrative with coherent voice and momentum.' : 'This is the first chapter — establish the world, the voice, the weight of what is about to begin.'} No preamble, no titles — just the prose itself.`;

  try {
    const opening = await anthropicCall(systemPrompt, [{ role: 'user', content: 'Write the chapter opening.' }], 'claude-haiku-4-5-20251001', 300);
    res.json({ ok: true, content: opening.trim() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/book/:userId — load saved book
app.get('/api/book/:userId', (req, res) => {
  const books = loadBooks();
  const book = books[req.params.userId];
  if (!book) return res.json({ ok: true, book: null });
  res.json({ ok: true, book });
});

// POST /api/book/:userId — save book state
app.post('/api/book/:userId', (req, res) => {
  const { bookTitle, chapters } = req.body;
  if (!bookTitle || !chapters) return res.status(400).json({ error: 'bookTitle and chapters required' });
  const books = loadBooks();
  books[req.params.userId] = {
    bookTitle, chapters,
    updatedAt: new Date().toISOString()
  };
  saveBooks(books);
  res.json({ ok: true });
});



app.post('/api/cloudtalk/webhook', (req, res) => {
  const payload = req.body;
  const entry = {
    receivedAt: new Date().toISOString(),
    phone: (payload && payload.call) ? payload.call.phone_number : (payload.call_number || null),
    duration: (payload && payload.call) ? payload.call.duration : null,
    status: (payload && payload.call) ? payload.call.status : null,
    transcript: payload ? payload.transcript : null,
    extracted: payload ? (payload.extracted_data || payload.variables || null) : null,
    raw: payload
  };
  const fs = require('fs');
  const file = '/opt/thechat/data/cloudtalk_calls.json';
  let calls = [];
  if (fs.existsSync(file)) { calls = JSON.parse(fs.readFileSync(file, 'utf-8')); }
  calls.push(entry);
  fs.writeFileSync(file, JSON.stringify(calls, null, 2));
  console.log('[CloudTalk Webhook]', entry.phone, entry.status, entry.duration);
  res.status(200).json({ ok: true });
});

// Summary Email Endpoint
app.post('/api/actions/send-summary-email', async (req, res) => {
  try {
    const { to, subject, html, text } = req.body;

    if (!to || !subject) {
      return res.status(400).json({
        ok: false,
        error: 'Missing required fields: to, subject',
      });
    }

    await sendEmail({ to, subject, html, text });

    res.json({ ok: true });
  } catch (error) {
    console.error('[sendSummaryEmail] Error:', error);
    res.status(500).json({
      ok: false,
      error: error.message || 'Failed to send email',
    });
  }
});


app.listen(PORT, () => {
  console.log(`[CONSOLE] Nyxa Dev API running on http://localhost:${PORT}`);
});
