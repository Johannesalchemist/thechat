function decideIntervention(state) {
  const map = {
    stressed:  { mode: 'decompress', messageStyle: 'supportive',   audioCue: 'calm_01',       suggestDoor: 'pause-room',  priority: 'high' },
    looping:   { mode: 'pivot',      messageStyle: 'redirect',     audioCue: 'transition_01', suggestDoor: 'change-room', priority: 'high' },
    engaged:   { mode: 'accelerate', messageStyle: 'encouraging',  audioCue: 'success_01',    suggestDoor: null,          priority: 'low'  },
    calm:      { mode: 'normal',     messageStyle: 'neutral',      audioCue: null,            suggestDoor: null,          priority: 'none' },
  };
  return map[state] || map.calm;
}
function buildSystemPromptPrefix(intervention) {
  const styles = {
    supportive:  'Respond with empathy and patience. Offer concrete next steps.',
    redirect:    'Gently redirect the conversation to a new topic or approach.',
    encouraging: 'Respond with enthusiasm and momentum. Build on their progress.',
    neutral:     'Respond naturally and helpfully.',
  };
  return styles[intervention.messageStyle] || styles.neutral;
}
module.exports = { decideIntervention, buildSystemPromptPrefix };
