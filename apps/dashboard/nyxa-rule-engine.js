// ── Nyxa Rule Engine v2 + QCE ──────────────────────────────────────────────
// Deterministic behavioral profile evaluator + Question Cluster Engine

/***********************
 * State Normalizer
 ***********************/
function flattenState(state) {
  return {
    ...state.session_state,
    ...state.user_state,
    cluster: state.session_state.cluster
  };
}

/***********************
 * Expression Evaluator
 * No eval. Supports: == != < > <= >=  AND  OR
 ***********************/
function evaluateCondition(condition, state) {
  if (condition.includes(' AND ')) {
    return condition.split(' AND ').every(c => evaluateCondition(c.trim(), state));
  }
  if (condition.includes(' OR ')) {
    return condition.split(' OR ').some(c => evaluateCondition(c.trim(), state));
  }
  const operators = ['<=', '>=', '!=', '==', '<', '>'];
  for (const op of operators) {
    if (condition.includes(op)) {
      const [leftRaw, rightRaw] = condition.split(op).map(s => s.trim());
      const left  = resolveValue(leftRaw,  state);
      const right = resolveValue(rightRaw, state);
      switch (op) {
        case '==': return left == right;
        case '!=': return left != right;
        case '<':  return left <  right;
        case '>':  return left >  right;
        case '<=': return left <= right;
        case '>=': return left >= right;
      }
    }
  }
  return false;
}

function resolveValue(token, state) {
  if ((token.startsWith("'") && token.endsWith("'")) ||
      (token.startsWith('"') && token.endsWith('"'))) {
    return token.slice(1, -1);
  }
  if (!isNaN(token)) return parseFloat(token);
  return token.split('.').reduce((acc, key) => acc?.[key], state);
}

/***********************
 * Rule Engine
 ***********************/
function applyRules(profile, flatState) {
  const actions = [];
  if (!profile.rules) return actions;
  for (const rule of profile.rules) {
    if (evaluateCondition(rule.condition, flatState)) actions.push(rule.action);
  }
  return actions;
}

function applyAction(config, action) {
  switch (action) {
    case 'increase_guidance':          return { ...config, guidance_level: 'high' };
    case 'decrease_guidance':          return { ...config, guidance_level: 'low' };
    case 'simplify_environment':       return { ...config, visual_density: 'low',  focus_level: 'narrow' };
    case 'increase_complexity':        return { ...config, visual_density: 'high', focus_level: 'wide' };
    case 'unlock_complexity':          return { ...config, complexity_mode: 'expanded' };
    case 'stabilize':                  return { ...config, transition_style: 'smooth' };
    case 'trigger_stabilization_mode': return { ...config, transition_style: 'smooth', visual_density: 'low', tone: 'grounding' };
    case 'reduce_narrative_scope':     return { ...config, structure: 'linear',    focus_level: 'narrow' };
    case 'expand_narrative_scope':     return { ...config, structure: 'branching', focus_level: 'wide' };
    default: return config;
  }
}

function mergeProfile(profile, flatState) {
  const depthConfig = profile.depth?.[flatState.depth] || {};
  let finalConfig = {
    ...profile.interaction,
    ...profile.narrative,
    ...profile.environment,
    ...depthConfig
  };
  applyRules(profile, flatState).forEach(a => { finalConfig = applyAction(finalConfig, a); });
  return finalConfig;
}

function evaluateBehavior(profile, state) {
  const flatState = flattenState(state);
  const config    = mergeProfile(profile, flatState);
  return {
    cluster: profile.cluster,
    config,
    video: {
      visual_density:   config.visual_density,
      focus_level:      config.focus_level,
      pace:             config.pace,
      tone:             config.tone,
      transition_style: config.transition_style,
      guidance_level:   config.guidance_level,
      response_style:   config.response_style
    }
  };
}

/***********************
 * Cold-Start Prior
 ***********************/
function inferSessionType(session) {
  const msg = (session?.firstMessage || '').toLowerCase();
  if (!msg) return 'exploratory';
  if (['learn','study','understand','explain','teach','guide','how do i','show me'].some(w => msg.includes(w))) return 'learning';
  if (['do','make','create','build','help me with','i need to','i want to','task','work','finish'].some(w => msg.includes(w))) return 'task';
  if (['wonder','explore','what if','curious','imagine','possibilities'].some(w => msg.includes(w)) || msg.includes('?')) return 'exploratory';
  return 'exploratory';
}

function getColdStartBehavior(session) {
  const sessionType = inferSessionType(session);
  const priorMap = {
    learning: {
      tone: 'calm', pace: 'slow', guidance_level: 'high', response_style: 'mentor',
      visual_density: 'low', focus_level: 'narrow', transition_style: 'smooth'
    },
    exploratory: {
      tone: 'neutral', pace: 'moderate', guidance_level: 'medium', response_style: 'reflective',
      visual_density: 'medium', focus_level: 'wide', transition_style: 'fluid'
    },
    task: {
      tone: 'neutral', pace: 'fast', guidance_level: 'medium', response_style: 'directive',
      visual_density: 'medium', focus_level: 'narrow', transition_style: 'sharp'
    },
    uncertain: {
      tone: 'calm', pace: 'slow', guidance_level: 'high', response_style: 'stabilizing',
      visual_density: 'low', focus_level: 'narrow', transition_style: 'smooth'
    }
  };
  const config = priorMap[sessionType] || priorMap.exploratory;
  return { sessionType, config, video: config };  // video mirrors config for orb init
}

/***********************
 * QCE — Question Cluster Engine
 * Output: strict typed schema v2
 * Backward-compat: still emits cluster, depth, confidence, stability
 ***********************/

// Module-level avoidance state machine (persists across turns)
const _qce = {
  recentClusters: [],
  avoidanceState: 'NORMAL',  // NORMAL | AVOIDANCE_ACTIVE | RESOLVING | STABLE
  writeLocked: false,
  lockBreachCount: 0
};

function detectCluster(text, previousState, clusterLog) {
  const t = text.toLowerCase();
  const words = t.split(/\s+/).filter(Boolean);
  const len = words.length;

  // Handle legacy call where previousState is just the cluster string
  const prevCluster = (typeof previousState === 'string') ? previousState : previousState?.cluster || null;
  const prevAvoidance = (typeof previousState === 'object') ? previousState?.avoidance : null;

  // ── 1. Cluster keyword scoring ─────────────────────────────────────────────
  const scores = { exploration: 0, friction: 0, analytical: 0, reflective: 0 };

  ['wonder','curious','explore','maybe','what if','could','discover','imagine',
   'possibilities','open','freedom','try','new','interesting'].forEach(w => { if (t.includes(w)) scores.exploration += 2; });
  scores.exploration += (t.match(/\?/g) || []).length;

  ["can't","hard","difficult","struggle","fear","afraid","stuck","overwhelmed",
   "lost","confused","don't know","help","heavy","sad","scared","anxious","blocked"].forEach(w => { if (t.includes(w)) scores.friction += 2; });

  ['how','why','because','structure','system','logic','plan','analyze','understand',
   'process','step','define','clear','specific','exactly','measure','data'].forEach(w => { if (t.includes(w)) scores.analytical += 1.5; });
  if (len > 30) scores.analytical += 2;

  ['feel','feeling','think','believe','life','meaning','sense','journey','looking back',
   'myself','my life','have been','realize','truth','memory','remember','always'].forEach(w => { if (t.includes(w)) scores.reflective += 2; });

  const sorted = Object.entries(scores).sort((a,b) => b[1]-a[1]);
  const topCluster = sorted[0][0];
  const topScore = sorted[0][1];
  const totalScore = Object.values(scores).reduce((a,b) => a+b, 0) || 1;
  const rawConfidence = Math.min(0.95, topScore / totalScore);

  // ── 2. Depth ───────────────────────────────────────────────────────────────
  const depth = len < 8 ? 'low' : len < 25 ? 'medium' : 'high';

  // ── 3. Behavior signals ────────────────────────────────────────────────────
  const verbosity = Math.min(1.0, len / 50);

  const hedgeWords = ["maybe","perhaps","i think","i guess","i don't know","not sure",
                      "possibly","probably","kind of","sort of","i feel like","i suppose"];
  const hesitationCount = hedgeWords.reduce((n,w) => n + (t.includes(w) ? 1 : 0), 0);
  const hesitation = Math.min(1.0, hesitationCount / 3);

  const certainWords = ['definitely','clearly','exactly','certainly','absolutely','i know','always','never','i am','it is'];
  const uncertainWords = ['um','uh','hmm','err','like','just','whatever','nevermind'];
  const certaintyDelta = certainWords.reduce((n,w) => n + (t.includes(w)?1:0), 0)
                       - uncertainWords.reduce((n,w) => n + (t.includes(w)?1:0), 0);
  const certainty = Math.max(0, Math.min(1.0, 0.5 + certaintyDelta * 0.15));

  // Repetition: check recent cluster log for same cluster
  let repetition = 0;
  if (clusterLog && clusterLog.length) {
    const recentC = clusterLog.slice(-4).filter(e => !e.type).map(e => e.cluster);
    repetition = Math.min(1.0, recentC.filter(c => c === topCluster).length / 4);
  }

  // ── 4. Intent ──────────────────────────────────────────────────────────────
  let intent = 'exploration';
  if (/^(how|what|why|when|where|who)\b/.test(t) || /\?$/.test(t.trim())) intent = 'query';
  else if (/^(please|help|can you|could you|i need|i want|give me)\b/.test(t)) intent = 'request';
  else if (/\b(what do you mean|clarify|i don't understand|explain again)\b/.test(t)) intent = 'clarification';
  else if (/\b(meta|off.?topic|about this|how does this work|what is this)\b/.test(t)) intent = 'meta';
  else if (topCluster === 'friction' && hesitation > 0.5) intent = 'avoidance';

  // ── 5. Avoidance detection ─────────────────────────────────────────────────
  let avoidType = 'none', avoidStrength = 0, avoidPattern = 'none';

  if (len <= 3) {
    avoidType = 'passive'; avoidStrength = 0.75; avoidPattern = 'silence_equivalent';
  } else if (['later','not now','not yet','let me think','i\'ll think','give me a moment',
              'not sure yet','maybe later'].some(w => t.includes(w))) {
    avoidType = 'passive'; avoidStrength = 0.65; avoidPattern = 'delay';
  } else if (['but what about','let\'s talk about','speaking of','anyway','moving on',
              'never mind','forget it','actually'].some(w => t.includes(w))) {
    avoidType = 'active'; avoidStrength = 0.72; avoidPattern = 'deflection';
  } else if (topCluster === 'exploration' && prevCluster === 'friction' && prevAvoidance?.detected) {
    // Cluster jumped exploration-ward while avoidance was active → topic shift
    avoidType = 'active'; avoidStrength = 0.68; avoidPattern = 'topic_shift';
  } else if (hesitation >= 0.5) {
    avoidType = 'passive'; avoidStrength = Math.min(0.9, hesitation * 0.85); avoidPattern = 'ambiguity';
  } else if (hesitation >= 0.25 && len > 10) {
    avoidType = 'mixed'; avoidStrength = hesitation * 0.65; avoidPattern = 'ambiguity';
  }

  const avoidanceDetected = avoidType !== 'none';

  // ── 6. Stability from recent cluster history ───────────────────────────────
  _qce.recentClusters.push(topCluster);
  if (_qce.recentClusters.length > 6) _qce.recentClusters.shift();
  const recent = _qce.recentClusters.slice(-5);
  const uniqueClusters = new Set(recent).size;
  const stability_indicator = Math.max(0, Math.min(1.0, 1 - (uniqueClusters - 1) / 4));

  // ── 7. Avoidance state machine ─────────────────────────────────────────────
  if (!_qce.writeLocked) {
    if (avoidanceDetected && avoidStrength > 0.5) {
      _qce.avoidanceState = 'AVOIDANCE_ACTIVE';
    } else if (_qce.avoidanceState === 'AVOIDANCE_ACTIVE' && stability_indicator > 0.6 && rawConfidence > 0.5) {
      _qce.avoidanceState = 'RESOLVING';
      _qce.writeLocked = true;
    } else if (_qce.avoidanceState === 'RESOLVING' && stability_indicator > 0.75) {
      _qce.avoidanceState = 'STABLE';
    } else if (_qce.avoidanceState === 'STABLE' && !avoidanceDetected && stability_indicator > 0.8) {
      _qce.avoidanceState = 'NORMAL';
      _qce.writeLocked = false;
    }
  }

  // Lock-breach: sustained strong avoidance can break write-lock
  if (_qce.writeLocked && avoidStrength > 0.85) {
    _qce.lockBreachCount++;
    if (_qce.lockBreachCount >= 2) { _qce.writeLocked = false; _qce.lockBreachCount = 0; }
  } else {
    _qce.lockBreachCount = 0;
  }

  // ── 8. Subtype mapping ─────────────────────────────────────────────────────
  const subtypeMap = { exploration:'cluster_1', friction:'cluster_2', analytical:'cluster_3', reflective:'cluster_4' };
  let subtype;
  if (rawConfidence < 0.35) {
    subtype = (_qce.avoidanceState === 'RESOLVING' || _qce.avoidanceState === 'STABLE')
      ? 'cluster_5_resolving' : 'cluster_5_split';
  } else if (_qce.avoidanceState === 'RESOLVING') {
    subtype = 'cluster_5_resolving';
  } else {
    subtype = subtypeMap[topCluster] || 'cluster_1';
  }

  // ── 9. Environment tone ────────────────────────────────────────────────────
  let environment_tone = 'neutral';
  if      (topCluster === 'exploration' && rawConfidence > 0.45) environment_tone = 'exploratory';
  else if (topCluster === 'reflective')                          environment_tone = 'calm';
  else if (topCluster === 'friction' && avoidType === 'active')  environment_tone = 'defensive';
  else if (topCluster === 'friction')                            environment_tone = 'stressed';
  else if (len <= 5)                                             environment_tone = 'calm';

  // ── 10. tick_rate_modifier ─────────────────────────────────────────────────
  const tickMap = {
    cluster_1: 1.2, cluster_2: 0.8, cluster_3: 1.0, cluster_4: 0.7,
    cluster_5_split: 0.6, cluster_5_resolving: 0.85
  };
  const tick_rate_modifier = tickMap[subtype] || 1.0;

  // ── 11. Legacy compat fields ───────────────────────────────────────────────
  const stability = prevCluster && prevCluster !== topCluster ? 'volatile' : 'stable';

  return {
    // ── Legacy (backward-compat) ──────────────────────────────────────────
    cluster:    topCluster,
    depth,
    confidence: rawConfidence,
    stability,
    // ── QCE v2 contract ───────────────────────────────────────────────────
    environment_tone,
    stability_indicator,
    subtype,
    tick_rate_modifier,
    intent,
    behavior_signals: { verbosity, certainty, repetition, hesitation },
    avoidance: {
      detected: avoidanceDetected,
      type:     avoidType,
      strength: avoidStrength,
      pattern:  avoidPattern
    },
    classification_metadata: {
      model_confidence: rawConfidence,
      fallback_used:    rawConfidence < 0.35
    },
    // ── State machine output ───────────────────────────────────────────────
    avoidance_state: _qce.avoidanceState,
    write_locked:    _qce.writeLocked
  };
}

/***********************
 * Export
 ***********************/
if (typeof module !== 'undefined') {
  module.exports = { evaluateBehavior, evaluateCondition, flattenState, detectCluster,
                     getColdStartBehavior, inferSessionType };
}
