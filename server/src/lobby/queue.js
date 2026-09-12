const DEFAULT_matchSize = 8;
const COUNTDOWN_SECONDS = 15;

// Simple "fill the room, or start when the timer elapses" queue - no
// skill-based matchmaking. Bots aren't wired in yet (that's the next build
// step), so right now a match can start with just 1 real player once the
// countdown elapses - that's intentional, it's what makes this step
// testable solo before bot fill-in exists.
//
// `matchSize` defaults to the original single (Versus) queue's capacity -
// index.js runs a second instance of this same factory for the Coop queue,
// which is why this is a parameter rather than the module-level constant it
// used to be.
export function createQueue({ onMatchStart, matchSize = DEFAULT_matchSize }) {
  const entries = new Map(); // id -> { socket, callsign, userId, characterVariant }
  let secondsRemaining = COUNTDOWN_SECONDS;

  // userId is null for anonymous play - see server/src/index.js's
  // 'connection' handler and auth/playTokens.js for how a real one gets
  // here. characterVariant is the dashboard loadout selector's pick (see
  // index.js's ?character= query param) - null falls back to
  // characterModel.js's default client-side.
  function join(id, socket, callsign, userId = null, characterVariant = null) {
    entries.set(id, {
      socket, callsign, userId, characterVariant,
    });
    broadcast();
  }

  function leave(id) {
    if (entries.delete(id)) {
      broadcast();
    }
  }

  function broadcast() {
    const players = Array.from(entries.entries()).map(([id, entry]) => ({ id, callsign: entry.callsign }));
    const message = JSON.stringify({
      type: 'queue-update',
      players,
      capacity: matchSize,
      secondsRemaining,
    });
    for (const { socket } of entries.values()) {
      if (socket.readyState === socket.OPEN) socket.send(message);
    }
  }

  function tick() {
    secondsRemaining -= 1;
    const countdownElapsed = secondsRemaining <= 0;
    const roomFull = entries.size >= matchSize;
    const shouldStartMatch = entries.size > 0 && (countdownElapsed || roomFull);

    if (shouldStartMatch) {
      const taken = Array.from(entries.entries()).slice(0, matchSize);
      for (const [id] of taken) entries.delete(id);
      onMatchStart(taken.map(([id, entry]) => ({
        id,
        socket: entry.socket,
        callsign: entry.callsign,
        userId: entry.userId,
        characterVariant: entry.characterVariant,
      })));
    }

    if (shouldStartMatch || countdownElapsed) {
      secondsRemaining = COUNTDOWN_SECONDS;
    }

    broadcast();
  }

  setInterval(tick, 1000);

  // Read-only headcount for the admin dashboard's live stats (see
  // server/src/liveStats.js) - never used by any matchmaking logic itself.
  function getSize() {
    return entries.size;
  }

  return { join, leave, getSize };
}
