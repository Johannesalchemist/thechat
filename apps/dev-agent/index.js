'use strict';

/**
 * Nyxa Dev Agent (nyxa-dev-agent)
 * - Registers itself in the agent registry on startup
 * - Polls the task queue for dev tasks
 * - Executes commandlets via run-command.php
 * - Exposes HTTP endpoint on port 3001 for direct task dispatch
 * - Reports results back to the event system
 */

import http       from 'http';
import fs         from 'fs';
import path       from 'path';
import { exec }   from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.join(__dirname, '../..');

const TASK_FILE   = path.join(ROOT, 'data/dev-agent/tasks.json');
const EVENTS_FILE = path.join(ROOT, 'data/events/events.json');
const AGENTS_FILE = path.join(ROOT, 'codex/agent-factory/storage/agents.json');
const CMD_SCRIPT  = path.join(ROOT, 'run-command.php');
const PORT        = 3001;
const POLL_MS     = 4000;

// ── Helpers ───────────────────────────────────────────────────────────────────

function readJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { return fallback; }
}

function writeJson(file, data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function runPhp(command, data = {}) {
    return new Promise((resolve, reject) => {
        const args   = `'${command}' '${JSON.stringify(data).replace(/'/g, "\\'")}'`;
        const cmd    = `php ${CMD_SCRIPT} ${args}`;
        exec(cmd, { cwd: ROOT, timeout: 30000 }, (err, stdout, stderr) => {
            if (err) return reject(new Error(stderr || err.message));
            try {
                const lines  = stdout.trim().split('\n');
                const last   = lines[lines.length - 1];
                const parsed = JSON.parse(last);
                resolve(parsed);
            } catch {
                resolve({ ok: true, raw: stdout.trim() });
            }
        });
    });
}

function emitEvent(type, payload) {
    try {
        const store = readJson(EVENTS_FILE, { events: [] });
        if (!store.events) store.events = [];
        store.events.push({
            id:        'evt_' + Math.random().toString(36).slice(2, 10),
            type,
            payload,
            source:    'nyxa-dev-agent',
            timestamp: new Date().toISOString(),
            ts:        Date.now()
        });
        if (store.events.length > 10000) store.events = store.events.slice(-10000);
        writeJson(EVENTS_FILE, store);
    } catch (e) {
        console.error('[DEV-AGENT] Event emit failed:', e.message);
    }
}

function getOwnAgentId() {
    const registry = readJson(AGENTS_FILE, { agents: [] });
    const agent    = (registry.agents || []).find(a => a.name === 'NyxaDev');
    return agent ? agent.id : null;
}

// ── Task Queue ────────────────────────────────────────────────────────────────

function ensureTaskFile() {
    const dir = path.dirname(TASK_FILE);
    if (!fs.existsSync(dir))  fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(TASK_FILE)) writeJson(TASK_FILE, { tasks: [] });
}

function getPendingTasks() {
    const store = readJson(TASK_FILE, { tasks: [] });
    return (store.tasks || []).filter(t => t.status === 'pending');
}

function updateTaskStatus(taskId, status, result = null) {
    const store = readJson(TASK_FILE, { tasks: [] });
    const task  = (store.tasks || []).find(t => t.id === taskId);
    if (task) {
        task.status    = status;
        task.updatedAt = new Date().toISOString();
        if (result !== null) task.result = result;
        writeJson(TASK_FILE, store);
    }
}

function enqueueTask(task) {
    ensureTaskFile();
    const store = readJson(TASK_FILE, { tasks: [] });
    if (!store.tasks) store.tasks = [];
    const t = {
        id:        'task_' + Math.random().toString(36).slice(2, 10),
        status:    'pending',
        createdAt: new Date().toISOString(),
        ...task
    };
    store.tasks.push(t);
    writeJson(TASK_FILE, store);
    return t;
}

// ── Task Execution ────────────────────────────────────────────────────────────

async function executeTask(task) {
    console.log(`[DEV-AGENT] Executing task: ${task.command} (${task.id})`);
    updateTaskStatus(task.id, 'running');

    try {
        let result;

        switch (task.command) {
            case 'run_commandlet':
                result = await runPhp(task.data.commandlet, task.data.args || {});
                break;

            case 'spawn_agent':
                result = await runPhp('create_agent', task.data);
                break;

            case 'add_concept':
                result = await runPhp('add_concept', task.data);
                break;

            case 'system_check':
                result = await runPhp('agent_stats', {});
                break;

            case 'run_flow':
                result = await runPhp('run_flow', task.data);
                break;

            case 'graph_query':
                result = await runPhp('search_graph', task.data);
                break;

            case 'list_agents':
                result = await runPhp('list_agents', {});
                break;

            default:
                // Pass through to PHP commandlet
                result = await runPhp(task.command, task.data || {});
        }

        updateTaskStatus(task.id, 'completed', result);
        emitEvent('task_completed', { task_id: task.id, command: task.command, result });
        console.log(`[DEV-AGENT] Task completed: ${task.id}`);
        return result;

    } catch (err) {
        updateTaskStatus(task.id, 'failed', { error: err.message });
        emitEvent('task_failed', { task_id: task.id, command: task.command, error: err.message });
        console.error(`[DEV-AGENT] Task failed: ${task.id} — ${err.message}`);
    }
}

// ── Poll Loop ─────────────────────────────────────────────────────────────────

async function poll() {
    const tasks = getPendingTasks();
    for (const task of tasks) {
        await executeTask(task);
    }
}

// ── HTTP Server ───────────────────────────────────────────────────────────────

function startHttpServer() {
    const server = http.createServer((req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        if (req.method === 'OPTIONS') {
            res.writeHead(200);
            return res.end();
        }

        // GET /status
        if (req.method === 'GET' && req.url === '/status') {
            const agentId = getOwnAgentId();
            res.writeHead(200);
            return res.end(JSON.stringify({
                agent:   'nyxa-dev-agent',
                name:    'NyxaDev',
                agentId,
                status:  'running',
                port:    PORT,
                uptime:  process.uptime()
            }));
        }

        // GET /tasks
        if (req.method === 'GET' && req.url === '/tasks') {
            const store = readJson(TASK_FILE, { tasks: [] });
            res.writeHead(200);
            return res.end(JSON.stringify(store));
        }

        // POST /task  { command, data }
        if (req.method === 'POST' && req.url === '/task') {
            let body = '';
            req.on('data', chunk => { body += chunk; });
            req.on('end', () => {
                try {
                    const payload = JSON.parse(body);
                    if (!payload.command) {
                        res.writeHead(400);
                        return res.end(JSON.stringify({ error: 'command required' }));
                    }
                    const task = enqueueTask(payload);
                    res.writeHead(201);
                    res.end(JSON.stringify({ ok: true, task }));
                    // Execute immediately
                    executeTask(task).catch(console.error);
                } catch {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'Invalid JSON' }));
                }
            });
            return;
        }

        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Not found' }));
    });

    server.listen(PORT, () => {
        console.log(`[DEV-AGENT] HTTP server listening on http://localhost:${PORT}`);
    });
}

// ── Startup ───────────────────────────────────────────────────────────────────

async function start() {
    console.log('[DEV-AGENT] NyxaDev Agent starting...');
    ensureTaskFile();

    const agentId = getOwnAgentId();
    if (agentId) {
        console.log(`[DEV-AGENT] Identified as agent: ${agentId}`);
        emitEvent('agent_online', { agent_id: agentId, name: 'NyxaDev', port: PORT });
    } else {
        console.warn('[DEV-AGENT] NyxaDev not found in registry — run init-agents.php first');
    }

    startHttpServer();

    console.log(`[DEV-AGENT] Polling every ${POLL_MS}ms for tasks...`);
    setInterval(poll, POLL_MS);
    poll(); // immediate first poll
}

start().catch(console.error);
