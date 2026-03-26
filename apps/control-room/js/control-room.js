// Nyxa Control Room — Runtime v1.2
'use strict';

// ─── Three.js Scene ─────────────────────────────────────────────────────────

const canvas   = document.getElementById('scene');
const scene    = new THREE.Scene();
const camera   = new THREE.PerspectiveCamera(60, window.innerWidth / 320, 0.1, 1000);
const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });

renderer.setSize(window.innerWidth, 320);
renderer.setClearColor(0x000000, 0);

const coreMat  = new THREE.MeshBasicMaterial({ color: 0x00ffcc, wireframe: true });
const coreGeo  = new THREE.SphereGeometry(1.0, 24, 24);
const core     = new THREE.Mesh(coreGeo, coreMat);
scene.add(core);

const ringGeo  = new THREE.TorusGeometry(1.8, 0.02, 8, 64);
const ringMat  = new THREE.MeshBasicMaterial({ color: 0x00ffcc44 });
const ring     = new THREE.Mesh(ringGeo, ringMat);
ring.rotation.x = Math.PI / 2;
scene.add(ring);

const nodes = [];
const nodeColors = [0x00ffcc, 0x00ff88, 0x4488ff, 0xff8800];

for (let i = 0; i < 16; i++) {
  const size  = 0.05 + Math.random() * 0.08;
  const geo   = new THREE.SphereGeometry(size, 8, 8);
  const mat   = new THREE.MeshBasicMaterial({ color: nodeColors[i % nodeColors.length] });
  const node  = new THREE.Mesh(geo, mat);
  const ang   = (i / 16) * Math.PI * 2;
  const radius = 2.2 + (Math.random() - 0.5) * 0.8;
  node.position.set(Math.cos(ang) * radius, (Math.random() - 0.5) * 1.2, Math.sin(ang) * radius);
  scene.add(node);
  nodes.push({ mesh: node, angle: ang, radius, speed: 0.002 + Math.random() * 0.004, yOff: Math.random() * Math.PI * 2 });
}

camera.position.set(0, 1.5, 5.5);
camera.lookAt(0, 0, 0);

let t = 0;
function animate() {
  requestAnimationFrame(animate);
  t += 0.01;
  core.rotation.y += 0.003;
  core.rotation.x += 0.001;
  ring.rotation.z += 0.001;
  nodes.forEach(n => {
    n.angle += n.speed;
    n.mesh.position.x = Math.cos(n.angle) * n.radius;
    n.mesh.position.z = Math.sin(n.angle) * n.radius;
    n.mesh.position.y = Math.sin(t + n.yOff) * 0.3;
  });
  renderer.render(scene, camera);
}
animate();

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, 320);
  camera.aspect = window.innerWidth / 320;
  camera.updateProjectionMatrix();
});

// ─── Clock ───────────────────────────────────────────────────────────────────

function updateClock() {
  document.getElementById('clock').textContent =
    new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
setInterval(updateClock, 1000);
updateClock();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function set(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

async function apiFetch(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(r.status);
  return r.json();
}

// ─── Kernel Status ───────────────────────────────────────────────────────────

async function loadStatus() {
  try {
    const d = await apiFetch('/api/status');
    set('kernel-status', `Kernel: ${d.kernel || 'standby'} | v${d.version || '1.0'}`);
    document.getElementById('kernel-dot').style.background = '#00ff88';
  } catch {
    set('kernel-status', 'Kernel: Offline');
    document.getElementById('kernel-dot').style.background = '#ff4444';
  }
}

// ─── World Model ─────────────────────────────────────────────────────────────

async function loadWorld() {
  try {
    const [w, g] = await Promise.all([apiFetch('/api/world'), apiFetch('/api/graph')]);
    set('entity-count',   w.entities  ?? '—');
    set('relation-count', w.relations ?? '—');
    set('event-count',    w.events    ?? '—');
    set('graph-nodes',    g.nodes     ?? '—');
    set('graph-edges',    g.edges     ?? '—');
  } catch { /* keep previous values */ }
}

// ─── Agent Network ───────────────────────────────────────────────────────────

async function loadAgents() {
  const el = document.getElementById('agent-list');
  try {
    const d = await apiFetch('/api/agents');
    set('agent-count-badge', `[${d.count}]`);
    if (!d.agents || d.agents.length === 0) {
      el.innerHTML = '<span class="dim">No agents registered</span>';
      return;
    }
    el.innerHTML = d.agents.map(a => `
      <div class="agent-row">
        <span class="agent-status-dot ${a.status === 'active' ? 'dot-on' : 'dot-off'}"></span>
        <span class="agent-name">${a.name}</span>
        <span class="agent-type">${a.type}</span>
        <span class="agent-domain dim">${a.domain}</span>
      </div>
    `).join('');
  } catch {
    el.innerHTML = '<span class="dim">API not reachable</span>';
  }
}

// ─── Lead Engine ─────────────────────────────────────────────────────────────

async function loadLeads() {
  try {
    const d = await apiFetch('/api/leads/stats');
    set('lead-total', d.total    ?? '—');
    set('lead-hot',   d.hot      ?? '—');
    set('lead-avg',   d.avg_score ?? '—');
    set('lead-conv',  (d.conversion ?? '—') + '%');

    const row = document.getElementById('lead-status-row');
    if (d.by_status) {
      row.innerHTML = Object.entries(d.by_status)
        .filter(([, v]) => v > 0)
        .map(([k, v]) => `<span class="status-chip">${k} <b>${v}</b></span>`)
        .join('');
    }
  } catch { /* keep */ }
}

// ─── Event Monitor (auto-poll) ────────────────────────────────────────────────

let lastEventId = null;

async function pollEvents() {
  const dot = document.getElementById('poll-dot');
  const log  = document.getElementById('event-log');
  if (dot) { dot.style.opacity = '1'; setTimeout(() => { dot.style.opacity = '0.2'; }, 300); }

  try {
    const d = await apiFetch('/api/events?limit=12');
    if (!d.events || d.events.length === 0) {
      if (log.querySelector('.dim')) return; // already showing placeholder
      return;
    }
    const newest = d.events[0]?.id ?? d.events[0]?.timestamp;
    if (newest === lastEventId) return;
    lastEventId = newest;

    log.innerHTML = d.events.map(ev => {
      const time = ev.timestamp ? new Date(ev.timestamp).toLocaleTimeString('de-DE') : '';
      const src  = ev.source ? ` <span class="dim">[${ev.source}]</span>` : '';
      return `<div class="event-row"><span class="ev-time">${time}</span><span class="ev-type">${ev.type}</span>${src}</div>`;
    }).join('');
  } catch { /* keep */ }
}

// ─── Command Console ─────────────────────────────────────────────────────────

async function sendCommand() {
  const input  = document.getElementById('cmd-input').value.trim();
  const output = document.getElementById('cmd-output');
  if (!input) return;

  output.textContent = `> ${input}\n[executing...]`;
  document.getElementById('cmd-input').value = '';

  try {
    const d = await fetch('/api/command', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ command: input })
    }).then(r => r.json());

    output.textContent = `> ${input}\n${d.result}`;
    const time = new Date().toLocaleTimeString('de-DE');
    const log  = document.getElementById('event-log');
    log.innerHTML = `<div class="event-row"><span class="ev-time">${time}</span><span class="ev-type">CMD</span> <span class="dim">${input}</span></div>` + log.innerHTML;
  } catch {
    output.textContent = `> ${input}\n[Standalone — API not connected]`;
  }
}

document.getElementById('cmd-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') sendCommand();
});

// ─── Boot + Polling ───────────────────────────────────────────────────────────

async function refresh() {
  await Promise.allSettled([loadWorld(), loadAgents(), loadLeads()]);
}

loadStatus();
refresh();
pollEvents();

setInterval(pollEvents, 5000);   // events every 5s
setInterval(refresh,   30000);   // world/agents/leads every 30s
