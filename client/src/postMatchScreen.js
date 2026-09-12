// Shows the result of a match that just ended for this player, driven
// entirely by the server's 'match-ended' message (see
// server/src/match/match.js) - never anything decided client-side. Note
// 'extracted' no longer appears here - banking mid-match no longer ends
// the match, see match.js's bankCurrentPot. Versus/Coop/Private all share
// the same 'eliminated' | 'last-standing' | 'time-limit' shape (rank/
// totalPlayers/finalPot); 'survival-ended' is its own shape entirely (no
// rank - solo vs. bots, nothing to rank against - see score/personalBest/
// isNewRecord handling in show() below).
const RESULT_TEXT = {
  eliminated: { label: 'Eliminated', className: 'danger' },
  'last-standing': { label: 'Last Standing', className: 'success' },
  'team-victory': { label: 'Team Victory', className: 'success' },
  'time-limit': { label: 'Time Expired', className: '' },
  'survival-ended': { label: 'Run Ended', className: 'danger' },
};

// Hardcoded default dev port, matching the GAME_CLIENT_URL pattern used in
// the other direction by site/src/dashboard.js.
const DASHBOARD_URL = 'http://127.0.0.1:5175/dashboard.html';

export function createPostMatchScreen(rootElement, { onReturnToLobby }) {
  rootElement.innerHTML = `
    <div class="post-match">
      <header>
        <div class="post-match-title">Match Complete</div>
      </header>

      <section class="panel result-panel">
        <div class="stat">
          <span class="label">Result</span>
          <span class="stat-value" id="result-value">-</span>
        </div>
        <div class="stat">
          <span class="label" id="rank-label">Rank</span>
          <span class="stat-value" id="rank-value">-</span>
        </div>
        <div class="stat">
          <span class="label" id="final-pot-label">Final Pot</span>
          <span class="stat-value" id="final-pot-value">0 <span class="unit">PTS</span></span>
        </div>
        <div class="stat">
          <span class="label">Kills</span>
          <span class="stat-value" id="kills-value">0</span>
        </div>
      </section>

      <div class="post-match-detail" id="post-match-detail"></div>

      <section class="panel team-scoreboard" id="team-scoreboard" hidden>
        <span class="label">Squad Kill Scores</span>
        <ul class="queue-list" id="team-scoreboard-list"></ul>
      </section>

      <section class="panel team-scoreboard" id="full-scoreboard" hidden>
        <span class="label">Match Results</span>
        <ul class="queue-list" id="full-scoreboard-list"></ul>
      </section>

      <div class="post-match-actions">
        <button class="btn btn-primary return-btn" type="button" id="return-btn">Return to Lobby</button>
        <button class="btn dashboard-btn" type="button" id="dashboard-btn">Back to Dashboard</button>
      </div>
    </div>
  `;

  const resultValueEl = rootElement.querySelector('#result-value');
  const rankLabelEl = rootElement.querySelector('#rank-label');
  const rankValueEl = rootElement.querySelector('#rank-value');
  const finalPotLabelEl = rootElement.querySelector('#final-pot-label');
  const finalPotValueEl = rootElement.querySelector('#final-pot-value');
  const killsValueEl = rootElement.querySelector('#kills-value');
  const detailEl = rootElement.querySelector('#post-match-detail');
  const teamScoreboardEl = rootElement.querySelector('#team-scoreboard');
  const teamScoreboardListEl = rootElement.querySelector('#team-scoreboard-list');
  const fullScoreboardEl = rootElement.querySelector('#full-scoreboard');
  const fullScoreboardListEl = rootElement.querySelector('#full-scoreboard-list');
  const returnBtn = rootElement.querySelector('#return-btn');
  const dashboardBtn = rootElement.querySelector('#dashboard-btn');

  // Coop only - message.teamScoreboard (see match.js's buildTeamScoreboard)
  // is a fixed snapshot of the whole team (bots included), so it still
  // shows a teammate who was eliminated earlier in the match, not just
  // whoever's left. Reuses lobbyScreen.css's .queue-list/.queue-row (already
  // loaded on this page via index.html) instead of introducing parallel
  // row styling just for this one list.
  function renderTeamScoreboard(teamScoreboard) {
    if (!teamScoreboard || teamScoreboard.length === 0) {
      teamScoreboardEl.hidden = true;
      return;
    }
    teamScoreboardEl.hidden = false;
    teamScoreboardListEl.innerHTML = '';
    for (const member of teamScoreboard) {
      const row = document.createElement('li');
      row.className = 'queue-row';
      row.innerHTML = `
        <span class="queue-dot"></span>
        <span class="queue-name">${member.callsign}${member.isBot ? ' (Bot)' : ''}</span>
        <span class="queue-status">${member.kills} ${member.kills === 1 ? 'kill' : 'kills'}</span>
      `;
      teamScoreboardListEl.appendChild(row);
    }
  }

  // Battle royale only - message.fullScoreboard (see match.js's
  // buildFullScoreboard) is every participant, not just a team, with each
  // one's final RANK if they'd already finished as of the moment THIS
  // player's own match ended, or null if they were still in the match at
  // that point (see match.js's ranksById comment - a free-for-all match
  // doesn't end for everyone at once, so "still playing" is a genuine,
  // expected state here, not missing data). Finished entries sort by rank
  // (1st first); anyone still in the match sorts after, by kills so far.
  function renderFullScoreboard(fullScoreboard) {
    if (!fullScoreboard || fullScoreboard.length === 0) {
      fullScoreboardEl.hidden = true;
      return;
    }
    fullScoreboardEl.hidden = false;
    const sorted = fullScoreboard.slice().sort((a, b) => {
      if (a.rank !== null && b.rank !== null) return a.rank - b.rank;
      if (a.rank !== null) return -1; // finished entries always sort before still-in-progress ones
      if (b.rank !== null) return 1;
      return b.kills - a.kills;
    });
    fullScoreboardListEl.innerHTML = '';
    for (const entry of sorted) {
      const row = document.createElement('li');
      row.className = 'queue-row';
      const placement = entry.rank !== null ? `#${entry.rank}` : 'In Match';
      row.innerHTML = `
        <span class="queue-dot"></span>
        <span class="queue-name">${entry.callsign}${entry.isBot ? ' (Bot)' : ''}</span>
        <span class="queue-status">${placement} · ${entry.kills} ${entry.kills === 1 ? 'kill' : 'kills'}</span>
      `;
      fullScoreboardListEl.appendChild(row);
    }
  }

  function show(message) {
    const resultInfo = RESULT_TEXT[message.reason] ?? { label: message.reason, className: '' };
    resultValueEl.textContent = resultInfo.label;
    resultValueEl.className = `stat-value ${resultInfo.className}`;
    renderTeamScoreboard(message.teamScoreboard);
    renderFullScoreboard(message.fullScoreboard);
    killsValueEl.textContent = message.kills ?? 0;

    if (message.reason === 'survival-ended') {
      // No rank/finalPot here at all (solo vs. bots - see match.js's
      // endSurvivalRun) - the same two stat slots are relabeled to show the
      // run's score and the stored personal best instead of hiding/adding
      // panels just for this one mode.
      rankLabelEl.textContent = 'Personal Best';
      rankValueEl.textContent = `${message.personalBest} PTS`;
      finalPotLabelEl.textContent = 'Score';
      finalPotValueEl.innerHTML = `${message.score} <span class="unit">PTS</span>`;
      detailEl.textContent = message.isNewRecord
        ? `NEW RECORD - killed by ${message.killedBy}`
        : `Killed by ${message.killedBy}`;
    } else {
      rankLabelEl.textContent = 'Rank';
      rankValueEl.textContent = message.rank && message.totalPlayers ? `#${message.rank} / ${message.totalPlayers}` : '-';
      finalPotLabelEl.textContent = 'Final Pot';
      finalPotValueEl.innerHTML = `${message.finalPot} <span class="unit">PTS</span>`;
      detailEl.textContent = message.reason === 'eliminated' ? `Killed by ${message.killedBy}` : '';
    }
    rootElement.hidden = false;
  }

  function hide() {
    rootElement.hidden = true;
  }

  returnBtn.addEventListener('click', onReturnToLobby);
  // Only real (non-anonymous) accounts have a dashboard to go back to, but
  // anonymous play never got a token in the first place - clicking this
  // with no account just lands on the dashboard's own login redirect.
  dashboardBtn.addEventListener('click', () => {
    window.location.href = DASHBOARD_URL;
  });

  return { show, hide };
}
