'use strict';

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

const PHASE_IDS = {
  lobby: 'phase-lobby',
  why: 'phase-why',
  because: 'phase-because',
  reveal: 'phase-reveal',
  vote: 'phase-vote',
  roundEnd: 'phase-roundEnd',
  final: 'phase-final',
};

let me = null;
let state = null;
let config = { aiEnabled: false };
let toastTimer = null;

// ---------- toast ----------

function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

// ---------- screens ----------

function showScreen(name) {
  for (const s of ['screen-auth', 'screen-home', 'screen-game']) {
    $(s).classList.toggle('hidden', s !== 'screen-' + name);
  }
}

function showPhase(phase) {
  for (const id of Object.values(PHASE_IDS)) $(id).classList.add('hidden');
  const id = PHASE_IDS[phase];
  if (id) $(id).classList.remove('hidden');
}

// ---------- auth ----------

async function init() {
  try {
    const cfgRes = await fetch('/api/config');
    config = await cfgRes.json();
  } catch (_) {}

  if (!config.xEnabled) $('btn-x').classList.add('hidden');
  if (config.devLoginEnabled) $('devLogin').classList.remove('hidden');

  const params = new URLSearchParams(location.search);
  if (params.get('error')) {
    showScreen('auth');
    $('authError').textContent = params.get('error');
    return;
  }

  try {
    const res = await fetch('/api/me');
    if (!res.ok) return showScreen('auth');
    me = (await res.json()).user;
    renderMe();
    connect();
  } catch (_) {
    showScreen('auth');
  }
}

function renderMe() {
  $('meName').textContent = me.name;
  const av = $('meAvatar');
  av.innerHTML = me.avatar
    ? `<img src="${esc(me.avatar)}" alt="" />`
    : esc(me.name.slice(0, 1).toUpperCase());
  showScreen('home');
}

$('btnDev').addEventListener('click', async () => {
  const name = $('devName').value.trim();
  $('authError').textContent = '';
  const res = await fetch('/auth/dev', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const data = await res.json();
  if (!res.ok) {
    $('authError').textContent = data.error || 'Login failed.';
    return;
  }
  me = data.user;
  renderMe();
  connect();
});

$('devName').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('btnDev').click();
});

$('btnLogout').addEventListener('click', async () => {
  await fetch('/auth/logout', { method: 'POST' });
  location.reload();
});

// ---------- socket ----------

let socket = null;

function connect() {
  if (socket) socket.disconnect();
  socket = io();

  socket.on('connect_error', (err) => {
    if (String(err.message).includes('unauthorized')) {
      showScreen('auth');
    }
  });

  socket.on('hello', () => {});
  socket.on('toast', toast);

  socket.on('state', (s) => {
    state = s;
    showScreen('game');
    renderState();
  });

  socket.on('disconnect', () => {
    if (state) toast('Connection lost — reconnecting…');
  });
}

// ---------- home ----------

$('btnCreate').addEventListener('click', () => {
  socket.emit('createRoom', (resp) => {
    if (!resp || !resp.ok) toast((resp && resp.error) || 'Could not create room.');
  });
});

$('btnJoin').addEventListener('click', () => {
  const code = $('joinCode').value.trim().toUpperCase();
  if (!code) return toast('Enter a room code.');
  socket.emit('joinRoom', { code }, (resp) => {
    if (!resp || !resp.ok) toast((resp && resp.error) || 'Could not join.');
  });
});

$('joinCode').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('btnJoin').click();
});

// ---------- render ----------

function renderState() {
  $('roomCode').textContent = state.code;
  $('roundPill').textContent =
    state.phase === 'lobby' ? 'Lobby' : `Round ${state.round}/${state.totalRounds}`;
  document.querySelectorAll('.roundNow').forEach((el) => (el.textContent = state.round));

  renderLeaderboard();
  showPhase(state.phase || 'lobby');

  if (state.phase === 'lobby') renderLobby();
  else if (state.phase === 'why') renderWhy();
  else if (state.phase === 'because') renderBecause();
  else if (state.phase === 'reveal') renderReveal();
  else if (state.phase === 'vote') renderVote();
  else if (state.phase === 'roundEnd') renderRoundEnd();
  else if (state.phase === 'final') renderFinal();
}

function renderLeaderboard() {
  const top = Math.max(0, ...state.players.map((p) => p.score));
  const sorted = [...state.players].sort((a, b) => b.score - a.score);
  $('leaderboard').innerHTML = sorted
    .map((p) => {
      const crown = top > 0 && p.score === top ? '<span class="crown">👑</span>' : '';
      const off = p.connected ? '' : ' offline';
      return `<div class="lb-chip${off}">${crown}${esc(p.name)}${
        p.isHost ? ' ⭐' : ''
      }<span class="score">${p.score}</span></div>`;
    })
    .join('');
}

function playerRow(p, extra) {
  const av = p.avatar
    ? `<span class="avatar"><img src="${esc(p.avatar)}" alt="" /></span>`
    : `<span class="avatar">${esc(p.name.slice(0, 1).toUpperCase())}</span>`;
  const right =
    extra || `<span class="online-dot${p.connected ? '' : ' off'}"></span>`;
  const host = p.isHost ? `<span class="host-badge">⭐</span>` : '';
  return `<div class="player-row">${av}<span>${esc(p.name)}</span>${host}${right}</div>`;
}

function renderLobby() {
  $('lobbyPlayers').innerHTML = state.players.map((p) => playerRow(p)).join('');
  const amHost = state.players.find((p) => p.id === state.meId && p.isHost);
  $('roundsRow').style.display = amHost ? 'flex' : 'none';
  $('btnStart').style.display = amHost ? '' : 'none';
  $('rounds').value = state.totalRounds;
  const n = state.players.length;
  $('lobbyHint').textContent =
    n < state.minPlayers
      ? `Waiting for players… ${n}/${state.minPlayers} minimum (${state.code} to join).`
      : amHost
      ? 'Enough players — hit start!'
      : 'Waiting for the host to start…';
}

function renderWhy() {
  const input = $('whyInput');
  const done = state.myDone;
  input.disabled = done;
  $('btnSubmitWhy').disabled = done;
  if (config.aiEnabled) $('btnInspire').classList.remove('hidden');
  else $('btnInspire').classList.add('hidden');
  $('whyStatus').textContent = done
    ? `Submitted! Waiting on ${state.totalCount - state.doneCount} more… (${state.doneNames.join(', ')} done)`
    : `${state.doneCount}/${state.totalCount} players have submitted.`;
}

function renderBecause() {
  const q = $('receivedQuestion');
  const input = $('becauseInput');
  const btn = $('btnSubmitBecause');
  if (!state.myQuestion) {
    q.textContent = "Your WHY didn't find a home this round — sit tight! 😄";
    q.classList.add('hidden');
    input.classList.add('hidden');
    btn.classList.add('hidden');
    $('becauseStatus').textContent = 'Waiting for the others…';
    return;
  }
  q.classList.remove('hidden');
  input.classList.remove('hidden');
  btn.classList.remove('hidden');
  q.textContent = 'Why ' + stripWhy(state.myQuestion);
  const done = state.myDone;
  input.disabled = done;
  btn.disabled = done;
  $('becauseStatus').textContent = done
    ? `Submitted! Waiting on ${state.totalCount - state.doneCount} more…`
    : `${state.doneCount}/${state.totalCount} answers in.`;
}

function stripWhy(text) {
  return String(text).replace(/^\s*why\s*/i, '').trim();
}

function renderReveal() {
  $('revealList').innerHTML = (state.combos || [])
    .map(
      (c) => `<div class="combo">
        <div class="why-line">Why ${esc(stripWhy(c.question))}</div>
        <div class="because-line">Because ${esc(stripBecause(c.answer))}</div>
      </div>`
    )
    .join('');
}

function stripBecause(text) {
  return String(text).replace(/^\s*because\s*/i, '').trim();
}

function renderVote() {
  const list = $('voteList');
  list.className = 'combo-list vote-list';
  list.innerHTML = (state.combos || [])
    .map((c) => {
      const mine = c.isMine;
      const sel = state.myVote === c.id ? ' selected' : '';
      return `<button class="vote-btn${sel}${mine ? ' mine' : ''}" data-id="${esc(c.id)}" ${
        mine ? 'disabled' : ''
      }>
        <div class="why-line">Why ${esc(stripWhy(c.question))}</div>
        <div class="because-line">Because ${esc(stripBecause(c.answer))}</div>
        ${mine ? '<div class="mine-tag">yours — can’t vote for this one</div>' : ''}
      </button>`;
    })
    .join('');
  list.querySelectorAll('.vote-btn:not(.mine)').forEach((btn) => {
    btn.addEventListener('click', () => {
      socket.emit('submitVote', btn.dataset.id);
    });
  });
  $('voteStatus').textContent = state.myDone
    ? `Vote locked in! ${state.doneCount}/${state.totalCount} voted.`
    : `${state.doneCount}/${state.totalCount} players have voted.`;
}

function renderRoundEnd() {
  const winners = state.roundWinners || [];
  $('roundEndTitle').textContent = winners.length
    ? `Round ${state.round}: ${winners.join(' & ')} win${winners.length > 1 ? '' : 's'}! 🏆`
    : `Round ${state.round}: no votes — tragic. 😅`;
  $('resultList').innerHTML = (state.results || [])
    .map(
      (r) => `<div class="combo${r.won ? ' winner' : ''}">
        <div class="why-line">Why ${esc(stripWhy(r.question))}</div>
        <div class="because-line">Because ${esc(stripBecause(r.answer))}</div>
        <div class="byline">asked by ${esc(r.questionAuthor)} · answered by ${esc(r.answerAuthor)}</div>
        <div class="votes">${r.votes} vote${r.votes === 1 ? '' : 's'}${r.won ? ' 🏆' : ''}</div>
      </div>`
    )
    .join('');
  const amHost = state.players.find((p) => p.id === state.meId && p.isHost);
  $('roundEndActions').innerHTML = amHost
    ? `<button id="btnNext" class="btn btn-primary big">${
        state.isLastRound ? 'See final scores 🏁' : 'Next round ▶'
      }</button>`
    : `<p class="hint">Waiting for the host…</p>`;
  const btn = $('btnNext');
  if (btn) btn.addEventListener('click', () => socket.emit('nextRound'));
}

function renderFinal() {
  const top = Math.max(0, ...state.players.map((p) => p.score));
  const sorted = [...state.players].sort((a, b) => b.score - a.score);
  $('finalBoard').innerHTML = sorted
    .map((p, i) => {
      const medal = i === 0 && top > 0 ? '👑' : '';
      const av = p.avatar
        ? `<span class="avatar"><img src="${esc(p.avatar)}" alt="" /></span>`
        : `<span class="avatar">${esc(p.name.slice(0, 1).toUpperCase())}</span>`;
      return `<div class="player-row${top > 0 && p.score === top ? ' winner' : ''}">
        ${av}<span>${medal} ${esc(p.name)}</span><span class="p-score">${p.score} pt${p.score === 1 ? '' : 's'}</span>
      </div>`;
    })
    .join('');
  const winners = state.winners || [];
  $('finalWinner').textContent = winners.length
    ? winners.length === 1
      ? `🏆 ${winners[0]} is the funniest human alive!`
      : `🏆 It's a tie: ${winners.join(' & ')} take the crown!`
    : 'Nobody scored. Comedy is hard. 😄';
  const amHost = state.players.find((p) => p.id === state.meId && p.isHost);
  $('btnPlayAgain').classList.toggle('hidden', !amHost);
}

// ---------- inputs / actions ----------

$('btnStart').addEventListener('click', () => socket.emit('startGame'));

$('rounds').addEventListener('change', () => {
  socket.emit('setRounds', Number($('rounds').value));
});

$('btnLeaveLobby').addEventListener('click', () => {
  socket.emit('leaveRoom');
  state = null;
  showScreen('home');
});

$('btnLeaveFinal').addEventListener('click', () => {
  socket.emit('leaveRoom');
  state = null;
  showScreen('home');
});

$('btnPlayAgain').addEventListener('click', () => socket.emit('playAgain'));

$('btnSubmitWhy').addEventListener('click', () => {
  const text = $('whyInput').value.trim();
  if (!text) return toast('Write a WHY first!');
  socket.emit('submitWhy', text);
});

$('btnSubmitBecause').addEventListener('click', () => {
  const text = $('becauseInput').value.trim();
  if (!text) return toast('Write a BECAUSE first!');
  socket.emit('submitBecause', text);
});

$('whyInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('btnSubmitWhy').click();
  }
});

$('becauseInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('btnSubmitBecause').click();
  }
});

$('btnInspire').addEventListener('click', async () => {
  const btn = $('btnInspire');
  btn.disabled = true;
  btn.textContent = '✨ Thinking…';
  try {
    const res = await fetch('/api/inspire', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'No idea right now.');
    const input = $('whyInput');
    input.value = data.idea;
    input.dispatchEvent(new Event('input'));
    input.focus();
  } catch (e) {
    toast(e.message || 'AI is on a coffee break. Your brain works great too!');
  } finally {
    btn.disabled = false;
    btn.textContent = '✨ Inspire me';
  }
});

$('roomPill').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(state ? state.code : '');
    toast('Room code copied — send it to your friends!');
  } catch (_) {
    toast('Room code: ' + (state ? state.code : ''));
  }
});

// Clear inputs when a fresh writing phase begins.
let lastPhaseRound = '';
setInterval(() => {
  if (!state) return;
  const key = state.phase + ':' + state.round;
  if (key !== lastPhaseRound) {
    lastPhaseRound = key;
    if (state.phase === 'why') $('whyInput').value = '';
    if (state.phase === 'because') $('becauseInput').value = '';
  }
}, 400);

// ---------- countdown timer ----------

(function tick() {
  const el = $('timer');
  if (!state || !state.phaseEndsAt) {
    el.textContent = '';
  } else {
    const left = Math.max(0, Math.ceil((state.phaseEndsAt - Date.now()) / 1000));
    el.textContent = left > 0 ? `${left}s` : '';
    el.classList.toggle('urgent', left > 0 && left <= 10);
  }
  setTimeout(tick, 250);
})();

init();