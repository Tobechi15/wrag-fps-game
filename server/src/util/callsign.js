// Shared by index.js (anonymous real players) and bots/bot.js (bot names) -
// one pool so a bot reads as just another combatant instead of an obviously
// templated "Sentinel-1"/"Drone-2" label.
const ADJECTIVES = ['Silent', 'Iron', 'Night', 'Ghost', 'Rogue', 'Shadow'];
const NOUNS = ['Fox', 'Wolf', 'Hawk', 'Viper', 'Reaper', 'Wraith'];

export function generateCallsign() {
  const adjective = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  const suffix = Math.floor(Math.random() * 90 + 10); // 2-digit number
  return `${adjective}${noun}_${suffix}`;
}
