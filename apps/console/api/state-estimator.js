function estimateState({ userMessage, recentMessages = [] }) {
  if (!userMessage || typeof userMessage !== 'string') return 'calm';
  const normalized = userMessage.toLowerCase();
  const stressPatterns = [
    /\b(help|urgent|stuck|broken|error|fail|can't|won't|impossible|frustrated)\b/gi,
    /[!]{2,}/g,
  ];
  const stressScore = stressPatterns.reduce((s, p) => s + (normalized.match(p) || []).length, 0);
  const currentTopic = (normalized.match(/\b([a-z]{3,})\b/) || [])[1];
  const recentTopics = recentMessages.slice(-5).map(m => (typeof m === 'string' ? m : m.content || '').toLowerCase().match(/\b([a-z]{3,})\b/)?.[1]);
  const isLooping = currentTopic && recentTopics.filter(t => t === currentTopic).length >= 3;
  const engagementPatterns = [/\b(cool|awesome|great|amazing|love|yes|let's)\b/gi, /\b(how|why|what|tell me|show me)\b/gi];
  const engagementScore = engagementPatterns.reduce((s, p) => s + (normalized.match(p) || []).length, 0);
  const wordCount = userMessage.trim().split(/\s+/).length;
  if (stressScore >= 2) return 'stressed';
  if (isLooping) return 'looping';
  if (engagementScore >= 2 || wordCount > 20) return 'engaged';
  return 'calm';
}
module.exports = { estimateState };
