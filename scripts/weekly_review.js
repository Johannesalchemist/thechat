'use strict';
// Weekly taxonomy review — runs every Monday, posts summary to The Room
// Usage: node weekly_review.js

require('dotenv').config({ path: '/opt/thechat/.env' });

const fs   = require('fs');
const path = require('path');

const CLUSTERS_FILE = '/opt/thechat/data/clusters.json';
const API_URL       = 'http://localhost:3000';

function loadClusters() {
  try { return JSON.parse(fs.readFileSync(CLUSTERS_FILE, 'utf8')); }
  catch { return { clusters: [], meta: {} }; }
}

function saveClusters(data) {
  fs.writeFileSync(CLUSTERS_FILE, JSON.stringify(data, null, 2));
}

function computeStats(clusters) {
  if (!clusters.length) return null;

  const total      = clusters.reduce((s, c) => s + c.size, 0);
  const byIntent   = {};
  const byBehavior = {};
  const gapTotals  = { semantic: 0, intent: 0, specificity: 0, emotion: 0, formality: 0 };
  let   gapCount   = 0;

  clusters.forEach(c => {
    // Intent breakdown
    const intentMatch = c.signature_key.match(/intent:([^|]+)/);
    if (intentMatch) {
      const k = intentMatch[1];
      byIntent[k] = (byIntent[k] || 0) + c.size;
    }
    // Behavior breakdown
    const behMatch = c.signature_key.match(/behavior:([^|]+)/);
    if (behMatch) {
      const k = behMatch[1];
      byBehavior[k] = (byBehavior[k] || 0) + c.size;
    }
    // Gap vector avg
    if (c.gap_vector_avg) {
      Object.keys(gapTotals).forEach(dim => {
        if (c.gap_vector_avg[dim] != null) {
          gapTotals[dim] += c.gap_vector_avg[dim] * c.size;
        }
      });
      gapCount += c.size;
    }
  });

  const gapAvg = {};
  if (gapCount > 0) {
    Object.keys(gapTotals).forEach(dim => {
      gapAvg[dim] = Math.round((gapTotals[dim] / gapCount) * 100) / 100;
    });
  }

  // Top 5 clusters by size
  const top5 = clusters
    .slice()
    .sort((a, b) => b.size - a.size)
    .slice(0, 5);

  // Singleton clusters (size == 1) — taxonomy fragmentation signal
  const singletons  = clusters.filter(c => c.size === 1).length;
  const fragPct     = Math.round((singletons / clusters.length) * 100);

  // Dominant intent
  const topIntent   = Object.entries(byIntent).sort((a,b) => b[1]-a[1])[0];
  const topBehavior = Object.entries(byBehavior).sort((a,b) => b[1]-a[1])[0];

  return {
    totalClusters: clusters.length,
    totalSessions: total,
    singletons,
    fragPct,
    topIntent:    topIntent   ? { name: topIntent[0],   count: topIntent[1]   } : null,
    topBehavior:  topBehavior ? { name: topBehavior[0], count: topBehavior[1] } : null,
    gapAvg,
    byIntent,
    byBehavior,
    top5
  };
}

function buildMessage(stats, meta) {
  const week = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

  if (!stats) {
    return `**[Weekly Taxonomy Review — ${week}]**\n\nNo cluster data yet. The clustering pipeline hasn't processed sessions. Once live, this report will show intent distribution, gap patterns, and fragmentation signals.\n\n*Next review: ${nextMonday()}*`;
  }

  const fragFlag = stats.fragPct > 40
    ? `⚠️ High fragmentation (${stats.fragPct}% singletons) — intent taxonomy may need consolidation.`
    : stats.fragPct > 20
    ? `↗ Moderate fragmentation (${stats.fragPct}% singletons) — watch for emerging patterns.`
    : `✓ Low fragmentation (${stats.fragPct}% singletons) — taxonomy holding well.`;

  const gapLine = Object.entries(stats.gapAvg)
    .map(([k, v]) => `${k.slice(0,3)}:${v}`)
    .join(' · ');

  const top5Lines = stats.top5
    .map((c, i) => {
      const sig = c.signature_key.replace('intent:', '').replace('|behavior:', ' → ').replace(/\|gap:.*/, '');
      return `  ${i+1}. ${sig} (${c.size} sessions)`;
    })
    .join('\n');

  const ineligible = meta.total_sessions_ineligible || 0;
  const classified  = meta.total_sessions_classified || 0;
  const eligPct     = classified > 0 ? Math.round(((classified - ineligible) / classified) * 100) : 0;

  return `**[Weekly Taxonomy Review — ${week}]**

📊 **Cluster snapshot**
• ${stats.totalClusters} active clusters · ${stats.totalSessions} sessions classified
• ${classified} total · ${ineligible} ineligible (${100 - eligPct}% filtered by confidence gate)
• ${fragFlag}

🎯 **Intent distribution**
• Dominant intent: ${stats.topIntent ? `${stats.topIntent.name} (${stats.topIntent.count} sessions)` : 'n/a'}
• Dominant behavior: ${stats.topBehavior ? `${stats.topBehavior.name} (${stats.topBehavior.count})` : 'n/a'}

📐 **Average gap vector** (platform-wide)
${gapLine}

🏆 **Top 5 clusters by volume**
${top5Lines}

⚙️ **Action required:** Review whether the intent taxonomy still reflects reality. Promote any cluster-derived patterns back into the classifier.
*Next review: ${nextMonday()}*`;
}

function nextMonday() {
  const d = new Date();
  const day = d.getDay();
  const daysUntil = (8 - day) % 7 || 7;
  d.setDate(d.getDate() + daysUntil);
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: '2-digit', month: 'short' });
}

async function postToRoom(message) {
  const res = await fetch(`${API_URL}/api/room/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      userName: 'System',
      agentId:  'none',
      systemMessage: true
    })
  });
  return res.json();
}

async function main() {
  console.log('[REVIEW] Running weekly taxonomy review...');

  const store  = loadClusters();
  const stats  = computeStats(store.clusters);
  const msg    = buildMessage(stats, store.meta);

  console.log('[REVIEW] Summary built. Posting to The Room...');

  try {
    const r = await postToRoom(msg);
    console.log('[REVIEW] Posted:', JSON.stringify(r).slice(0, 120));
  } catch (e) {
    console.error('[REVIEW] Post failed:', e.message);
  }

  // Update last_review timestamp
  store.meta.last_review = new Date().toISOString();
  saveClusters(store);

  console.log('[REVIEW] Done. Last review updated.');
}

main().catch(console.error);
