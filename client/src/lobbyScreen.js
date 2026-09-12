// Renders the pre-match lobby using REAL queue state from the server -
// step 2 replaced step 1's fake trickling player names and cosmetic
// countdown with the actual 'queue-update' / 'match-start' messages the
// server's lobby/queue.js sends. This module still doesn't decide anything
// itself; it only renders whatever the server reports and forwards
// onMatchStart when told a match has begun.
//
// Which MODE to enter (Versus/Coop/Private/Survival - see
// server/src/index.js/match/modes.js) is decided upstream, on the
// dashboard's Play Mode dock (site/src/dashboard.js's
// wirePlayModeSelector) - it rides along on the game client's URL (see
// client/src/app.js) and is handed to show(mode) below. This screen has no
// mode-picking UI of its own; it just executes whichever mode it's told:
// Versus/Coop share the public-queue UI (a different queue instance
// server-side, same client rendering), Private swaps to a room code
// create/join form, and Survival skips all matchmaking UI - it starts
// immediately, with only a brief "Deploying..." holding state shown while
// waiting for the match to actually begin.
const MODE_SUBTITLES = {
  versus: 'Standard Operations',
  coop: 'Team Deployment - 2 Squads',
  private: 'Invite-Only Room',
  survival: 'Solo vs. Endless Hostiles',
};

export function createLobbyScreen(rootElement, network, { onMatchStart }) {
  let localPlayerId = null;
  let currentRoomCode = null;

  rootElement.innerHTML = `
    <div class="lobby">
      <header class="lobby-header">
        <div class="lobby-title">Deployment Queue</div>
        <div class="lobby-subtitle" id="lobby-subtitle">${MODE_SUBTITLES.versus}</div>
      </header>

      <section class="stake-panel" id="stake-panel">
        <div class="stat">
          <span class="label">Entry Stake</span>
          <span class="stat-value">100 <span class="unit">PTS</span></span>
        </div>
        <div class="stat">
          <span class="label">Potential Earnings</span>
          <span class="stat-value success">+450 <span class="unit">PTS</span></span>
        </div>
        <div class="stat">
          <span class="label">Current Risk</span>
          <span class="stat-value danger">HIGH</span>
        </div>
      </section>

      <section class="tier-select" id="tier-select">
        <button class="btn tier-btn active" type="button">
          <span class="tier-name">Standard</span>
          <span class="tier-stake">100 PTS</span>
        </button>
        <button class="btn tier-btn" type="button" disabled>
          <span class="tier-name">High Stakes</span>
          <span class="tier-stake">Coming Soon</span>
        </button>
      </section>

      <section class="panel queue-panel" id="queue-panel">
        <div class="queue-header">
          <span class="label">Players Queued</span>
          <span class="queue-count"><span id="queue-count-value">0</span>/<span id="queue-capacity-value">-</span></span>
        </div>
        <ul class="queue-list" id="queue-list"></ul>
      </section>

      <section class="panel countdown-panel" id="countdown-panel">
        <span class="label">Next Deployment Window</span>
        <div class="countdown" id="countdown-value">--:--</div>
        <div class="countdown-note" id="countdown-note">Connecting to server...</div>
      </section>

      <section class="panel private-panel" id="private-panel" hidden>
        <div class="private-actions" id="private-actions">
          <div class="private-stake-row">
            <label for="room-stake-input" class="label">Room Stake (optional)</label>
            <input type="number" id="room-stake-input" min="0" step="10" placeholder="0" />
          </div>
          <button class="btn btn-primary" id="create-room-btn" type="button">Create Room</button>
          <div class="private-join">
            <input type="text" id="room-code-input" maxlength="6" placeholder="ROOM CODE" />
            <button class="btn" id="join-room-btn" type="button">Join</button>
          </div>
        </div>
        <div class="room-error" id="room-error" hidden></div>
        <div class="room-info" id="room-info" hidden>
          <div class="room-code-display">Room Code: <span id="room-code-value"></span></div>
          <div class="room-pool-display" id="room-pool-display" hidden></div>
          <ul class="queue-list" id="room-member-list"></ul>
          <button class="btn btn-primary" id="start-room-btn" type="button" hidden>Start Match</button>
        </div>
      </section>

      <section class="panel survival-panel" id="survival-panel" hidden>
        <div class="survival-note">Deploying into Survival...</div>
      </section>
    </div>
  `;

  const subtitleEl = rootElement.querySelector('#lobby-subtitle');
  const stakePanelEl = rootElement.querySelector('#stake-panel');
  const tierSelectEl = rootElement.querySelector('#tier-select');
  const queuePanelEl = rootElement.querySelector('#queue-panel');
  const countdownPanelEl = rootElement.querySelector('#countdown-panel');
  const privatePanelEl = rootElement.querySelector('#private-panel');
  const survivalPanelEl = rootElement.querySelector('#survival-panel');

  const queueListEl = rootElement.querySelector('#queue-list');
  const queueCountEl = rootElement.querySelector('#queue-count-value');
  const queueCapacityEl = rootElement.querySelector('#queue-capacity-value');
  const countdownEl = rootElement.querySelector('#countdown-value');
  const countdownNoteEl = rootElement.querySelector('#countdown-note');

  const privateActionsEl = rootElement.querySelector('#private-actions');
  const roomStakeInputEl = rootElement.querySelector('#room-stake-input');
  const roomCodeInputEl = rootElement.querySelector('#room-code-input');
  const roomErrorEl = rootElement.querySelector('#room-error');
  const roomInfoEl = rootElement.querySelector('#room-info');
  const roomCodeValueEl = rootElement.querySelector('#room-code-value');
  const roomPoolDisplayEl = rootElement.querySelector('#room-pool-display');
  const roomMemberListEl = rootElement.querySelector('#room-member-list');
  const startRoomBtnEl = rootElement.querySelector('#start-room-btn');

  function formatSeconds(totalSeconds) {
    const clamped = Math.max(totalSeconds, 0);
    const minutes = Math.floor(clamped / 60).toString().padStart(2, '0');
    const seconds = (clamped % 60).toString().padStart(2, '0');
    return `${minutes}:${seconds}`;
  }

  function renderQueue({ players, capacity, secondsRemaining }) {
    queueCountEl.textContent = players.length;
    queueCapacityEl.textContent = capacity;
    countdownEl.textContent = formatSeconds(secondsRemaining);
    countdownNoteEl.textContent = players.length > 0
      ? 'Match starts automatically when the timer hits zero or the room fills'
      : 'Waiting for players to queue';

    queueListEl.innerHTML = '';
    for (const player of players) {
      const isLocalPlayer = player.id === localPlayerId;
      const row = document.createElement('li');
      row.className = 'queue-row';
      row.innerHTML = `
        <span class="queue-dot"></span>
        <span class="queue-name">${player.callsign}${isLocalPlayer ? ' (you)' : ''}</span>
        <span class="queue-status">READY</span>
      `;
      queueListEl.appendChild(row);
    }
  }

  function renderRoom({
    code, hostId, stake, pool, members,
  }) {
    currentRoomCode = code;
    roomErrorEl.hidden = true;
    privateActionsEl.hidden = true;
    roomInfoEl.hidden = false;
    roomCodeValueEl.textContent = code;
    startRoomBtnEl.hidden = hostId !== localPlayerId;

    // stake/pool are only present on 'room-update' (see privateRooms.js's
    // broadcastRoomUpdate) - 'room-created' doesn't know the pool yet
    // (nobody but the host has joined/paid in), so this just stays hidden
    // until the first real room-update arrives, which happens immediately
    // after creation anyway (broadcastRoomUpdate fires right after create()).
    if (typeof pool === 'number' && stake > 0) {
      roomPoolDisplayEl.hidden = false;
      roomPoolDisplayEl.textContent = `Stake: ${stake} PTS · Pool: ${pool} PTS`;
    } else {
      roomPoolDisplayEl.hidden = true;
    }

    roomMemberListEl.innerHTML = '';
    for (const member of members) {
      const isLocalPlayer = member.id === localPlayerId;
      const isHost = member.id === hostId;
      const row = document.createElement('li');
      row.className = 'queue-row';
      row.innerHTML = `
        <span class="queue-dot"></span>
        <span class="queue-name">${member.callsign}${isLocalPlayer ? ' (you)' : ''}${isHost ? ' - Host' : ''}</span>
        <span class="queue-status">READY</span>
      `;
      roomMemberListEl.appendChild(row);
    }
  }

  function resetPrivatePanel() {
    currentRoomCode = null;
    roomCodeInputEl.value = '';
    roomErrorEl.hidden = true;
    privateActionsEl.hidden = false;
    roomInfoEl.hidden = true;
  }

  // Shows only the panels relevant to the given mode - Versus/Coop share
  // the public-queue UI (queue list + countdown + the stake panel, since
  // both have real stakes), Private swaps to the room code form (no stake
  // panel - Private isn't matched via a stake-based queue), and Survival
  // shows only a brief holding message while its instant solo match spins
  // up server-side.
  function applyModeVisibility(mode) {
    const isQueueMode = mode === 'versus' || mode === 'coop';
    stakePanelEl.hidden = mode === 'private' || mode === 'survival';
    tierSelectEl.hidden = mode === 'private' || mode === 'survival';
    queuePanelEl.hidden = !isQueueMode;
    countdownPanelEl.hidden = !isQueueMode;
    privatePanelEl.hidden = mode !== 'private';
    survivalPanelEl.hidden = mode !== 'survival';
    subtitleEl.textContent = MODE_SUBTITLES[mode] ?? MODE_SUBTITLES.versus;
  }

  rootElement.querySelector('#create-room-btn').addEventListener('click', () => {
    const stake = Math.max(0, Number.parseInt(roomStakeInputEl.value, 10) || 0);
    network.createRoom(stake);
  });
  rootElement.querySelector('#join-room-btn').addEventListener('click', () => {
    const code = roomCodeInputEl.value.trim();
    if (code) network.joinRoom(code);
  });
  startRoomBtnEl.addEventListener('click', () => {
    if (currentRoomCode) network.startRoom(currentRoomCode);
  });

  function activateHandlers() {
    network.setHandlers({
      'joined-queue': ({ id }) => {
        localPlayerId = id;
      },
      'queue-update': (message) => {
        renderQueue(message);
      },
      'room-created': ({ code, stake }) => {
        // A 'room-update' with the real pool/member list arrives right
        // behind this (privateRooms.js's create() broadcasts immediately
        // after sending this) - this is just the brief initial render.
        renderRoom({
          code, hostId: localPlayerId, stake, pool: stake, members: [{ id: localPlayerId, callsign: 'You' }],
        });
      },
      'room-update': (message) => {
        renderRoom(message);
      },
      'room-error': ({ reason, required }) => {
        roomErrorEl.hidden = false;
        if (reason === 'full') {
          roomErrorEl.textContent = 'That room is full.';
        } else if (reason === 'insufficient-balance') {
          roomErrorEl.textContent = `Not enough points - this room needs a ${required} PTS stake to join.`;
        } else if (reason === 'server-error') {
          roomErrorEl.textContent = 'Something went wrong - try again.';
        } else {
          roomErrorEl.textContent = 'Room not found - check the code.';
        }
      },
      // Versus/Coop's flat entry stake (see modes.js) couldn't be charged -
      // never joined that queue at all, see index.js's 'join-queue' handler.
      // Reuses the countdown panel's note line rather than a whole separate
      // error element - no further queue-update will arrive for a queue
      // they were never actually added to, so this stays visible until they
      // pick a different mode or retry.
      'queue-error': ({ reason, required }) => {
        countdownNoteEl.textContent = reason === 'insufficient-balance'
          ? `Not enough points - this mode needs a ${required} PTS stake to enter.`
          : 'Could not join - try again.';
      },
      'match-start': ({ players, teamId }) => {
        onMatchStart({ players, teamId });
      },
    });
  }

  activateHandlers();

  // Called both on first load and whenever the player returns from a
  // finished match. The game screen took over `network`'s handlers while
  // the match was running, so they need to be re-activated here - and the
  // server only auto-queues a connection once (on initial connect), so a
  // returning player has to explicitly re-enter matchmaking. `mode` comes
  // from app.js, sourced from the dashboard's Play Mode pick (see the
  // module comment above) - defaults to 'versus' so a direct/bookmarked
  // visit to the game client with no `?mode=` still behaves like before
  // these other modes existed.
  function show(mode = 'versus') {
    rootElement.hidden = false;
    activateHandlers();
    applyModeVisibility(mode);
    resetPrivatePanel();

    if (mode === 'versus' || mode === 'coop') {
      // Clear stale data from before the last match started - fresh state
      // arrives with the next 'queue-update', which join-queue below prompts.
      queueListEl.innerHTML = '';
      queueCountEl.textContent = '0';
      countdownEl.textContent = '--:--';
      countdownNoteEl.textContent = 'Connecting to server...';
      network.joinQueue(mode);
    } else if (mode === 'survival') {
      network.startSurvival();
    }
    // Private shows its create/join form and waits for the player to act -
    // nothing to send yet.
  }

  function hide() {
    rootElement.hidden = true;
  }

  return { show, hide };
}
