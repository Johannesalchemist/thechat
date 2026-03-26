/**
 * ResonanceEngine v1
 * future24 / Nyxa — March 2026
 *
 * Detects behavioral patterns and generates signals.
 * Replaces stub with real pattern recognition.
 *
 * Design principles:
 * - No diagnosis, no labels
 * - Responds to patterns, not interpretations
 * - When in doubt: no signal (Trust > Coverage)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CALLS_FILE = '/opt/thechat/data/cloudtalk_calls.json';
const SIGNALS_FILE = '/opt/thechat/data/telefone_signals.json';

// ── Signal Types ──────────────────────────────────────────────────────────────

export const SIGNAL_TYPES = {
  ATTENTION:   { id: 'attention',   vibration: 1, description: 'Notice something' },
  DEVIATION:   { id: 'deviation',   vibration: 2, description: 'Pattern off-track' },
  ESCALATION:  { id: 'escalation',  vibration: 3, description: 'Strong intervention needed' }
};

// ── Pattern Detectors ─────────────────────────────────────────────────────────

/**
 * Detects repeated short calls (< threshold seconds)
 * Indicates: contact strategy not working
 */
export function detectShortCallPattern(calls, thresholdSeconds = 30, minCount = 5) {
  if (!calls || calls.length < minCount) return null;

  const recent = calls.slice(-20); // analyze last 20 calls
  const shortCalls = recent.filter(c => {
    const duration = c.duration || 0;
    return duration < thresholdSeconds;
  });

  const ratio = shortCalls.length / recent.length;

  if (ratio >= 0.7) {
    return {
      pattern: 'short_call_dominance',
      signal: SIGNAL_TYPES.DEVIATION,
      severity: ratio >= 0.9 ? 'high' : 'medium',
      data: {
        shortCallCount: shortCalls.length,
        totalAnalyzed: recent.length,
        ratio: Math.round(ratio * 100) + '%',
        avgDuration: Math.round(recent.reduce((s, c) => s + (c.duration || 0), 0) / recent.length) + 's'
      },
      recommendation: 'Strategy change needed. Consider: email outreach, different timing, value-first approach.',
      detectedAt: new Date().toISOString()
    };
  }

  return null;
}

/**
 * Detects conversation loops — same topics repeating without resolution
 */
export function detectConversationLoop(history, windowSize = 10) {
  if (!history || history.length < windowSize) return null;

  const recent = history.slice(-windowSize);
  const words = recent.join(' ').toLowerCase().split(/\s+/);

  // Count word frequency
  const freq = {};
  words.forEach(w => {
    if (w.length > 4) freq[w] = (freq[w] || 0) + 1;
  });

  // Find dominant repeated terms
  const dominant = Object.entries(freq)
    .filter(([, count]) => count >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([word]) => word);

  if (dominant.length >= 3) {
    return {
      pattern: 'conversation_loop',
      signal: SIGNAL_TYPES.ATTENTION,
      severity: 'low',
      data: {
        dominantTopics: dominant,
        windowSize,
        messagesAnalyzed: recent.length
      },
      recommendation: 'Recurring topics detected. A shift in perspective or approach may help.',
      detectedAt: new Date().toISOString()
    };
  }

  return null;
}

/**
 * Detects inactivity — no calls or interactions for N days
 */
export function detectInactivity(calls, inactiveDays = 3) {
  if (!calls || calls.length === 0) return null;

  const lastCall = calls[calls.length - 1];
  if (!lastCall?.calledAt) return null;

  const lastDate = new Date(lastCall.calledAt);
  const now = new Date();
  const daysSince = (now - lastDate) / (1000 * 60 * 60 * 24);

  if (daysSince >= inactiveDays) {
    return {
      pattern: 'inactivity',
      signal: SIGNAL_TYPES.ATTENTION,
      severity: daysSince >= 7 ? 'high' : 'low',
      data: {
        daysSinceLastCall: Math.round(daysSince),
        lastCallAt: lastCall.calledAt,
        lastContact: lastCall.contact
      },
      recommendation: `No outreach for ${Math.round(daysSince)} days. Consider resuming contact.`,
      detectedAt: new Date().toISOString()
    };
  }

  return null;
}

/**
 * Main analysis function — replaces stub
 * Runs all detectors and returns active signals
 */
export function analyzeConversation(history) {
  const results = [];

  // Conversation loop detection
  const loop = detectConversationLoop(history);
  if (loop) results.push(loop);

  // Reflection summary (kept from original, upgraded)
  if (history && history.length >= 5) {
    const recent = history.slice(-5).join(' ');
    results.push({
      pattern: 'reflection',
      signal: null, // informational only, no vibration
      data: {
        summary: 'Recent topics: ' + recent.slice(0, 200)
      },
      detectedAt: new Date().toISOString()
    });
  }

  return results.length > 0 ? results : null;
}

/**
 * Full system analysis — call patterns + conversation + inactivity
 */
export function analyzeSystem() {
  const results = [];

  // Load call data
  let calls = [];
  if (fs.existsSync(CALLS_FILE)) {
    try {
      calls = JSON.parse(fs.readFileSync(CALLS_FILE, 'utf-8'));
    } catch (e) {
      console.error('[ResonanceEngine] Failed to load calls:', e.message);
    }
  }

  // Run detectors
  const shortCall = detectShortCallPattern(calls);
  if (shortCall) results.push(shortCall);

  const inactive = detectInactivity(calls);
  if (inactive) results.push(inactive);

  // Persist signals
  if (results.length > 0) {
    let existing = [];
    if (fs.existsSync(SIGNALS_FILE)) {
      try {
        existing = JSON.parse(fs.readFileSync(SIGNALS_FILE, 'utf-8'));
      } catch (e) { existing = []; }
    }
    const updated = [...existing, ...results];
    fs.writeFileSync(SIGNALS_FILE, JSON.stringify(updated, null, 2));
    console.log(`[ResonanceEngine] ${results.length} signal(s) detected and stored`);
  }

  return results;
}

// ── CLI runner ────────────────────────────────────────────────────────────────
// Run directly: node resonanceEngine.js
if (process.argv[1] && process.argv[1].endsWith('resonanceEngine.js')) {
  const signals = analyzeSystem();
  if (signals.length === 0) {
    console.log('[ResonanceEngine] No patterns detected. System nominal.');
  } else {
    console.log('[ResonanceEngine] Active signals:');
    signals.forEach(s => {
      console.log(`  [${s.signal?.id || 'info'}] ${s.pattern} — ${s.recommendation}`);
    });
  }
}
