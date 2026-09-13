// ~20 position updates/sec - plenty smooth for a prototype. Exported so
// remotePlayers.js can size its own network-interpolation window off the
// same number rather than duplicating it - the two must stay in sync (if
// this got slower, remote players would visibly pause between updates
// before the interpolation catches up).
export const SEND_INTERVAL_MS = 50;

// A single WebSocket connection that lives for the whole browser tab, from
// the moment you land in the lobby through however many matches you play.
// It stays open across the lobby -> game screen transition (step 2 change:
// previously the game screen made its own fresh connection every time it
// started, but the SERVER now needs to track "this connection is in the
// queue" before a match even exists, so the connection has to exist first).
//
// Which messages matter changes depending on which screen is active (the
// lobby cares about queue updates, the game screen cares about hits/moves),
// so handlers aren't fixed at creation time - call setHandlers() whenever
// the active screen changes.
export function createNetworkClient(url, { onOpen } = {}) {
  const socket = new WebSocket(url);
  let handlers = {};

  // The WebSocket handshake is genuinely asynchronous - even to 127.0.0.1,
  // readyState is still CONNECTING for at least one event-loop tick after
  // `new WebSocket()`. app.js calls lobbyScreen.show(playMode) synchronously
  // right after creating this client, so a non-default mode's very first
  // joinQueue('coop')/createRoom()/startSurvival() etc. call was landing
  // BEFORE the socket opened and silently no-op'ing (readyState !== OPEN).
  // sendWhenReady queues a message if the socket isn't open yet and
  // flushes the queue once it is, instead of dropping it - used only by
  // the one-time mode-entry senders below, NOT by sendPosition/sendShot (a
  // continuous per-frame stream should still just drop while disconnected,
  // not build up a backlog). The server no longer auto-joins a connection
  // into any queue on its own (see index.js's 'connection' handler) -
  // every mode, Versus included, only ever enters matchmaking via one of
  // these explicit sends, which is exactly why this queueing matters for
  // every mode now, not just the non-default ones.
  let pendingWhenReady = [];
  function sendWhenReady(message) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    } else {
      pendingWhenReady.push(message);
    }
  }

  socket.addEventListener('open', () => {
    console.log('Connected to server');
    for (const message of pendingWhenReady) socket.send(JSON.stringify(message));
    pendingWhenReady = [];
    if (onOpen) onOpen();
  });

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    const handler = handlers[message.type];
    if (handler) handler(message);
  });

  socket.addEventListener('close', () => {
    console.log('Disconnected from server');
  });

  socket.addEventListener('error', (event) => {
    console.error('WebSocket error - is the server running?', event);
  });

  function setHandlers(newHandlers) {
    handlers = newHandlers;
  }

  let lastSentAt = 0;

  function sendPosition(position, yaw) {
    if (socket.readyState !== WebSocket.OPEN) return;

    const now = performance.now();
    if (now - lastSentAt < SEND_INTERVAL_MS) return;
    lastSentAt = now;

    socket.send(JSON.stringify({
      type: 'move',
      position: { x: position.x, y: position.y, z: position.z },
      yaw,
    }));
  }

  function sendShot(origin, direction) {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({
      type: 'shoot',
      origin: { x: origin.x, y: origin.y, z: origin.z },
      direction: { x: direction.x, y: direction.y, z: direction.z },
    }));
  }

  // Voluntarily leaves the CURRENT match early (see gameScreen.js's
  // hamburger-menu Quit Match button) - server-side this is handled exactly
  // like a disconnect (see index.js's 'quit-match' handler, which calls the
  // same match.handleDisconnect this player's socket closing would've
  // triggered anyway), just without actually closing the connection, since
  // the player is expected to keep using this same tab afterward (back to
  // the lobby, not the whole page reloading). No sendWhenReady queueing
  // needed - this can only ever be sent while already mid-match, i.e. long
  // after the socket is open.
  function quitMatch() {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: 'quit-match' }));
  }

  // Enters matchmaking - both the initial call from lobbyScreen.js's
  // show() and re-entering after a match ends (eliminated, last-standing,
  // time-limit/survival-ended). The server never joins a connection to
  // any queue on its own, so this always has to be sent explicitly, for
  // every mode. `mode` should be 'versus' or 'coop'.
  function joinQueue(mode) {
    sendWhenReady({ type: 'join-queue', mode });
  }

  // Private mode (see server/src/lobby/privateRooms.js) - create a new
  // room (server replies with a 'room-created' message carrying the code),
  // join one by code, or (host only) start the match with whoever's
  // currently in the room. `stake` (PTS) is optional - "by choice,
  // depending on the setting of the room" - 0/omitted means a free room;
  // every joiner pays this same amount into a pool the eventual winner
  // claims (see match.js's endMatchForSurvivor).
  function createRoom(stake = 0) {
    sendWhenReady({ type: 'create-room', stake });
  }

  function joinRoom(code) {
    sendWhenReady({ type: 'join-room', code });
  }

  function startRoom(code) {
    sendWhenReady({ type: 'start-room', code });
  }

  // Survival mode - no queue/room involved, starts a solo-vs-bots match
  // immediately (see server/src/index.js's 'start-survival' handler).
  function startSurvival() {
    sendWhenReady({ type: 'start-survival' });
  }

  return {
    setHandlers, sendPosition, sendShot, quitMatch, joinQueue, createRoom, joinRoom, startRoom, startSurvival,
  };
}
