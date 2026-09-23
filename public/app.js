const $ = (s) => document.querySelector(s);
const app = $('#app');
const AVATARS = ['🏎️', '🚗', '🏁', '🔧', '🛞', '🛻', '🚙', '⚡', '🛠️', '🧰', '🏆', '🛸'];
const STORAGE_KEY = 'carSpec';
const STORAGE_TTL_MS = 2 * 60 * 60 * 1000;
const PLACEHOLDERS = [
  'A 2.0-litre twin-spark that only existed for Group B paper…',
  'Factory code XP-17: a closed-deck block with one spare casting…',
  'Homologation required exactly 200 road cars and a silent plaque…',
  'Press kits claimed a titanium intake plenum and night-shift dyno time…',
  'Internal memos called it a mule with a sealed crankcase stamp…',
];

let ws;
let state;
let me;
let roomCode;
let lastSeq = 0;
let tick;
let bluffLockedLocal = false;
let votePick = null; // pending selection before confirm
let revealStep = 0;
let placeholderIdx = 0;
let bluffDraft = '';
let muted = localStorage.getItem('carSpecMute') === '1';

function loadSaved() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (!raw?.roomCode || !raw?.playerId || !raw?.savedAt) return null;
    if (Date.now() - raw.savedAt > STORAGE_TTL_MS) {
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return raw;
  } catch {
    return null;
  }
}

function persist() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ roomCode, playerId: me, savedAt: Date.now() }));
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function send(event, x = {}) {
  if (ws?.readyState === 1) ws.send(JSON.stringify({ event, roomCode, ...x }));
}

function beep(kind = 'tick') {
  if (muted) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.connect(g);
    g.connect(ctx.destination);
    o.frequency.value = kind === 'reveal' ? 660 : kind === 'lock' ? 520 : 440;
    g.gain.value = 0.03;
    o.start();
    o.stop(ctx.currentTime + 0.07);
  } catch {
    /* ignore */
  }
}

function toast(msg) {
  let el = $('#toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 3200);
}

function shell(body, { inGame = false } = {}) {
  const header =
    inGame && state
      ? `<header class="match-bar">
          <div><span class="chip">Room</span> <b class="mono">${esc(state.code)}</b></div>
          <div><span class="chip">Round</span> <b>${state.roundIndex}/${state.settings.roundCount}</b></div>
          <div><span class="chip">You</span> <b class="score">${(state.you?.score ?? 0).toLocaleString()}</b></div>
          <button type="button" id="mute" class="icon-btn" title="Mute">${muted ? '🔇' : '🔊'}</button>
        </header>`
      : '';
  const brand = inGame
    ? `<div class="brand brand-compact"><div class="eyebrow">Car Spec Bluffing</div></div>`
    : `<div class="brand">
        <div class="eyebrow">A questionable automotive authority</div>
        <h1>Car Spec<br>Bluffing</h1>
        <p>Make it sound factory. Make them believe it.</p>
      </div>`;
  app.innerHTML = `${header}${brand}${body}`;
}

function timeLeftLabel() {
  if (state?.paused) {
    const left = Math.max(0, Math.ceil(((state.pauseEndsAt || 0) - Date.now()) / 1000));
    return `${left}s`;
  }
  const t = state?.round?.timer;
  if (!t) return '';
  // Prefer server endsAt so skew only affects display; phase still ends on server event.
  const ends = t.endsAt ?? t.startedAt + t.durationMs;
  return `${Math.max(0, Math.ceil((ends - Date.now()) / 1000))}s`;
}

function home(msg = '') {
  shell(`
    <section class="card stack">
      <h2>Start a very expensive rumor.</h2>
      ${msg ? `<div class="notice">${esc(msg)}</div>` : ''}
      <div class="grid">
        <button id="create" type="button">Create room</button>
        <button id="join" class="secondary" type="button">Join with code</button>
      </div>
      <div class="divider"></div>
      <button id="rules" class="secondary" type="button">How to play</button>
    </section>`);
  $('#create').onclick = () => identity('create');
  $('#join').onclick = () => identity('join');
  $('#rules').onclick = () => rules({ returnTo: home });
}

function identity(mode) {
  const route = location.pathname.match(/^\/r\/([A-Za-z0-9]{4})$/);
  shell(`
    <section class="card stack">
      <h2>${mode === 'create' ? 'Build the grid' : 'Find the grid'}</h2>
      <label class="field">Display name
        <input id="name" maxlength="16" placeholder="2–16 characters" autocomplete="nickname"/>
      </label>
      <label class="field">Avatar
        <div class="avatars" id="avatars">
          ${AVATARS.map((a, i) => `<button type="button" class="avatar-pick${i === 0 ? ' selected' : ''}" data-a="${a}">${a}</button>`).join('')}
        </div>
      </label>
      ${
        mode === 'join'
          ? `<label class="field">Room code
              <input id="code" maxlength="4" placeholder="ABCD" style="text-transform:uppercase" value="${route ? route[1].toUpperCase() : ''}"/>
            </label>`
          : ''
      }
      <button id="go" type="button">${mode === 'create' ? 'Create room' : 'Join room'}</button>
      <button id="back" class="secondary" type="button">Back</button>
      <p id="err" class="err"></p>
    </section>`);

  let avatar = AVATARS[0];
  document.querySelectorAll('.avatar-pick').forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll('.avatar-pick').forEach((x) => x.classList.remove('selected'));
      b.classList.add('selected');
      avatar = b.dataset.a;
    };
  });

  $('#back').onclick = () => home();
  $('#go').onclick = async () => {
    const body = { name: $('#name').value.trim(), avatar };
    let url = '/api/rooms';
    if (mode === 'join') {
      const code = $('#code').value.trim().toUpperCase();
      if (code.length !== 4) {
        $('#err').textContent = 'Enter a 4-character room code.';
        return;
      }
      url += `/${code}/join`;
    }
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Request failed');
      roomCode = d.roomCode;
      me = d.playerId;
      bluffLockedLocal = false;
      votePick = null;
      persist();
      history.replaceState({}, '', `/r/${roomCode}`);
      connect();
    } catch (e) {
      $('#err').textContent = e.message;
    }
  };
}

function connect() {
  if (ws) {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}`);
  ws.onopen = () => send('identify', { playerId: me });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (typeof m.seq === 'number') {
      if (m.seq < lastSeq) return;
      lastSeq = m.seq;
    }
    if (m.event === 'error') return toast(m.message || 'Something went sideways.');
    if (m.event === 'bluff:rejected') {
      bluffLockedLocal = false;
      toast(m.reason || 'Bluff rejected.');
      if (state) {
        state = { ...state, round: { ...state.round, bluffLocked: false } };
        render();
        const ta = $('#blufftext');
        const err = $('#blufferr');
        if (ta) ta.value = bluffDraft;
        if (err) err.textContent = m.reason || '';
        const c = $('#count');
        if (c && ta) c.textContent = `${ta.value.length} / 280 · min 12`;
      }
      return;
    }
    if (m.event === 'bluff:accepted') {
      bluffLockedLocal = true;
      beep('lock');
      if (m.state) state = m.state;
      return render();
    }
    if (m.event === 'vote:accepted') {
      votePick = null;
      beep('lock');
      if (m.state) state = m.state;
      return render();
    }
    if (m.event === 'round:reveal') {
      revealStep = 0;
      beep('reveal');
    }
    if (m.state) {
      const prevPhase = state?.phase;
      state = m.state;
      if (state.phase !== 'bluff') {
        bluffLockedLocal = false;
        bluffDraft = '';
      }
      if (state.round?.bluffLocked) bluffLockedLocal = true;
      if (state.phase !== 'vote') votePick = null;
      if (prevPhase !== state.phase) revealStep = 0;
      render();
    }
  };
  ws.onclose = () => {
    setTimeout(() => {
      if (me && roomCode) connect();
    }, 1200);
  };
}

function rules({ returnTo } = {}) {
  shell(`
    <section class="card stack">
      <h2>How to play</h2>
      <ul class="rules">
        <li><b>Round action:</b> Invent a fake car spec or spot the real one.</li>
        <li><b>Scoring:</b> Points for tricking others or guessing correctly.</li>
        <li><b>Winning:</b> Highest total score after 3 to 5 rounds.</li>
        <li><b>Room code:</b> Lets players join the exact same lobby.</li>
      </ul>
      <div class="divider"></div>
      <p class="muted">+1,000 for the truth · +500 per rival fooled · +250 perfect lie · +150 streak. House bluffs score no tricks. Echo bluffs score half.</p>
      <button id="back" type="button">Got it</button>
    </section>`);
  $('#back').onclick = () => {
    localStorage.setItem('carSpecRulesSeen', '1');
    if (typeof returnTo === 'function') returnTo();
    else if (state) render();
    else home();
  };
}

function render() {
  clearInterval(tick);
  if (!state) return;

  if (state.paused) {
    shell(
      `<section class="card stack">
        <span class="chip">Paused</span>
        <h2>${esc(state.pauseReason || 'Waiting for players…')}</h2>
        <p class="muted">Need at least two connected devices. Auto-ends in <span class="timer">${timeLeftLabel()}</span>.</p>
      </section>`,
      { inGame: true }
    );
    tick = setInterval(() => {
      const t = $('.timer');
      if (t) t.textContent = timeLeftLabel();
    }, 250);
    bindChrome();
    return;
  }

  let html = '';
  if (state.phase === 'lobby') html = lobby();
  else if (state.phase === 'briefing') html = briefing();
  else if (state.phase === 'bluff') html = bluffView();
  else if (state.phase === 'vote') html = voteView();
  else if (state.phase === 'reveal') html = revealView();
  else html = overView();

  const inGame = state.phase !== 'lobby';
  shell(html, { inGame });
  tick = setInterval(() => {
    const t = $('.timer');
    if (t) t.textContent = timeLeftLabel();
  }, 250);
  bind();
  if (state.phase === 'reveal') runRevealStages();
}

function lobby() {
  const host = state.hostPlayerId === me;
  return `
    <section class="card">
      <div class="row wrap">
        <div>
          <span class="chip">Room code</span>
          <h2 class="code">${esc(state.code)}</h2>
        </div>
        <button class="secondary" id="copy" type="button">Copy invite</button>
      </div>
      <div class="players">
        ${state.players
          .map(
            (p) => `
          <div class="player ${p.id === me ? 'you' : ''}">
            <span>${p.avatar} <b>${esc(p.name)}</b> ${p.id === state.hostPlayerId ? '<span class="chip">Host</span>' : ''}</span>
            <span class="muted">${p.connected ? 'connected' : 'reconnecting'} · ${p.ready ? 'ready' : 'not ready'}</span>
          </div>`
          )
          .join('')}
      </div>
      ${
        host
          ? `<div class="grid">
              <label class="field">Rounds
                <select id="rounds">${[3, 4, 5]
                  .map((n) => `<option ${n === state.settings.roundCount ? 'selected' : ''}>${n}</option>`)
                  .join('')}</select>
              </label>
              <label class="field">Bluff timer
                <select id="blufftime">${[30, 45, 60]
                  .map((n) => `<option ${n === state.settings.bluffSeconds ? 'selected' : ''}>${n}</option>`)
                  .join('')}</select>
              </label>
            </div>
            <p class="muted">2 drivers minimum. 3+ makes the lies better.</p>
            <div class="grid">
              <button id="ready" class="secondary" type="button">Toggle ready</button>
              <button id="start" type="button" ${state.players.length < 2 ? 'disabled' : ''}>Start game</button>
            </div>`
          : `<div class="notice">Waiting for ${esc(state.players.find((p) => p.id === state.hostPlayerId)?.name || 'host')} to start.</div>
            <button id="ready" class="secondary" type="button">Toggle ready</button>`
      }
      <button id="rules" class="secondary" type="button">How to play</button>
    </section>`;
}

function briefing() {
  const canSkip = state.hostPlayerId === me;
  return `
    <section class="card stack">
      <div class="row">
        <span class="chip">Briefing · Round ${state.roundIndex} / ${state.settings.roundCount}</span>
        <span class="timer">${timeLeftLabel()}</span>
      </div>
      <span class="chip">${esc(state.round.category)}</span>
      <p class="question">${esc(state.round.question)}</p>
      <p class="muted">Nobody sees the real answer yet. Prepare your best press-kit lie.</p>
      ${canSkip ? '<button id="skip" class="secondary" type="button">Skip briefing</button>' : ''}
    </section>`;
}

function bluffView() {
  const locked = bluffLockedLocal || state.round?.bluffLocked;
  const lockedIds = new Set(state.round?.lockedPlayerIds || []);
  return `
    <section class="card stack">
      <div class="row">
        <span class="chip">Bluff</span>
        <span class="timer">${timeLeftLabel()}</span>
      </div>
      <p class="question">${esc(state.round.question)}</p>
      ${
        locked
          ? `<div class="notice">Bluff locked. Waiting for others…</div>`
          : `<textarea id="blufftext" maxlength="280" placeholder="${esc(PLACEHOLDERS[placeholderIdx % PLACEHOLDERS.length])}">${esc(bluffDraft)}</textarea>
             <div class="row"><span class="muted" id="count">${bluffDraft.length} / 280 · min 12</span><span id="blufferr" class="err"></span></div>
             <button id="submit" type="button">Lock bluff</button>`
      }
      <div class="divider"></div>
      <div class="lock-row">
        ${state.players
          .map((p) => {
            const done = lockedIds.has(p.id) || (p.id === me && locked);
            return `<span class="lock-pill ${done ? 'done' : ''}">${p.avatar} ${esc(p.name)} ${done ? '✓' : '…'}</span>`;
          })
          .join('')}
      </div>
    </section>`;
}

function voteView() {
  const voted = state.round.myVote;
  const lineup = state.round.lineup || [];
  return `
    <section class="card stack">
      <div class="row">
        <span class="chip">Spot the real one</span>
        <span class="timer">${timeLeftLabel()}</span>
      </div>
      <p class="question">${esc(state.round.question)}</p>
      ${voted ? '<div class="notice">Vote locked. Waiting for the grid…</div>' : ''}
      <div>
        ${lineup
          .map((s, i) => {
            const mine = s.isMine || s.optionId === state.round.ownOptionId;
            const selected = votePick === s.optionId || voted === s.optionId;
            return `<button type="button" class="spec${selected ? ' selected' : ''}${mine ? ' mine' : ''}" data-vote="${s.optionId}" ${
              mine || voted ? 'disabled' : ''
            }>
              <span class="chip">Spec ${String.fromCharCode(65 + i)}${mine ? ' · Your bluff' : ''}</span>
              <div>${esc(s.text)}</div>
            </button>`;
          })
          .join('')}
      </div>
      ${
        !voted
          ? `<button id="confirmvote" type="button" ${votePick ? '' : 'disabled'}>Confirm selection</button>`
          : `<div class="lock-row">${state.players
              .map((p) => {
                const done = (state.round.votedPlayerIds || []).includes(p.id);
                return `<span class="lock-pill ${done ? 'done' : ''}">${p.avatar} ${esc(p.name)} ${done ? '✓' : '…'}</span>`;
              })
              .join('')}</div>`
      }
    </section>`;
}

function revealView() {
  const lineup = state.round.lineup || [];
  return `
    <section class="card stack" id="reveal-root">
      <span class="chip">Reveal</span>
      <p class="question">${esc(state.round.question)}</p>
      <div id="reveal-specs">
        ${lineup
          .map((s, i) => {
            return `<div class="player reveal-card" data-idx="${i}" data-real="${s.isReal ? '1' : '0'}">
              <div class="reveal-head">
                <span class="chip">Spec ${String.fromCharCode(65 + i)}</span>
                <span class="badge-real hidden">FACTORY TRUTH</span>
              </div>
              <div class="reveal-text">${esc(s.text)}</div>
              <div class="reveal-meta muted hidden"></div>
              <div class="reveal-votes hidden"></div>
            </div>`;
          })
          .join('')}
      </div>
      <div class="divider"></div>
      <div id="scoreboard" class="stack hidden">
        <h2>Scoreboard</h2>
        ${(state.round.scores || [])
          .map((q) => {
            const chips = (q.chips || [])
              .map((c) => `<span class="score-chip">${esc(c.label)} +${c.points.toLocaleString()}</span>`)
              .join('') || `<span class="score-chip muted">No points this round</span>`;
            return `<div class="score-block">
              <div class="row"><b>${q.avatar} ${esc(q.name)}</b><span class="score">+${(q.totalDelta || 0).toLocaleString()}</span></div>
              <div class="chip-row">${chips}</div>
              <div class="muted">Total ${q.totalScore.toLocaleString()}</div>
            </div>`;
          })
          .join('')}
        ${
          state.hostPlayerId === me
            ? `<button id="next" type="button">${
                state.roundIndex >= state.settings.roundCount ? 'Final results' : 'Next round'
              }</button>`
            : '<p class="notice">Host is lining up the next round.</p>'
        }
      </div>
    </section>`;
}

function runRevealStages() {
  const cards = [...document.querySelectorAll('.reveal-card')];
  const lineup = state.round.lineup || [];
  if (!cards.length) return;

  // Stage 1: dim fakes
  setTimeout(() => {
    cards.forEach((el, i) => {
      if (!lineup[i]?.isReal) el.classList.add('reveal-fake');
    });
  }, 400);

  // Stage 2: highlight real + badge
  setTimeout(() => {
    cards.forEach((el, i) => {
      if (lineup[i]?.isReal) {
        el.classList.add('reveal-real');
        el.querySelector('.badge-real')?.classList.remove('hidden');
      }
    });
    beep('reveal');
  }, 900);

  // Stage 3: authors
  setTimeout(() => {
    cards.forEach((el, i) => {
      const s = lineup[i];
      const meta = el.querySelector('.reveal-meta');
      if (!meta || !s) return;
      meta.classList.remove('hidden');
      if (s.isReal) meta.textContent = 'The factory truth';
      else meta.textContent = `${s.authorAvatar || ''} ${s.authorName || 'Unknown'}${s.echo ? ' · echo' : ''}`;
    });
  }, 1500);

  // Stage 4: votes
  setTimeout(() => {
    cards.forEach((el, i) => {
      const s = lineup[i];
      const box = el.querySelector('.reveal-votes');
      if (!box || !s) return;
      box.classList.remove('hidden');
      const voters = s.voters || [];
      box.innerHTML = voters.length
        ? voters.map((v) => `<span class="vote-face" title="${esc(v.name)}">${v.avatar}</span>`).join('') +
          `<span class="muted"> ${voters.map((v) => esc(v.name)).join(', ')}</span>`
        : `<span class="muted">No votes</span>`;
    });
  }, 2100);

  // Stage 5: scoreboard
  setTimeout(() => {
    $('#scoreboard')?.classList.remove('hidden');
  }, 2700);
}

function overView() {
  const order = state.podium?.order || [...state.players].sort((a, b) => b.score - a.score);
  const liar = state.podium?.biggestLiar;
  const truth = state.podium?.truthSerum;
  return `
    <section class="card stack">
      <span class="chip">Game over</span>
      <h2>Barstool legends.</h2>
      ${order
        .slice(0, 3)
        .map(
          (p, i) =>
            `<div class="podium">${['🥇', '🥈', '🥉'][i]} ${p.avatar || ''} <b>${esc(p.name)}</b> <span class="score">${(
              p.score || 0
            ).toLocaleString()}</span></div>`
        )
        .join('')}
      <p class="notice">Biggest liar: ${esc(liar?.name || '—')} · Truth serum: ${esc(truth?.name || '—')}</p>
      <div class="grid">
        ${state.hostPlayerId === me ? '<button id="again" type="button">Play again</button>' : '<div class="notice">Waiting for host to restart.</div>'}
        <button id="copy" class="secondary" type="button">Copy invite link</button>
      </div>
    </section>`;
}

function bindChrome() {
  $('#mute')?.addEventListener('click', () => {
    muted = !muted;
    localStorage.setItem('carSpecMute', muted ? '1' : '0');
    render();
  });
}

function bind() {
  bindChrome();
  $('#copy')?.addEventListener('click', async () => {
    const url = `${location.origin}/r/${state.code}`;
    try {
      await navigator.clipboard.writeText(url);
      toast('Invite link copied.');
    } catch {
      toast(url);
    }
  });
  $('#ready')?.addEventListener('click', () => {
    const meP = state.players.find((p) => p.id === me);
    send('player:ready', { ready: !meP?.ready });
  });
  $('#start')?.addEventListener('click', () => {
    send('room:settings', {
      roundCount: +$('#rounds').value,
      bluffSeconds: +$('#blufftime').value,
    });
    setTimeout(() => send('game:start'), 80);
  });
  $('#skip')?.addEventListener('click', () => send('round:skip'));
  $('#submit')?.addEventListener('click', () => {
    const text = $('#blufftext')?.value || '';
    bluffDraft = text;
    send('bluff:submit', { text });
  });
  $('#blufftext')?.addEventListener('input', (e) => {
    bluffDraft = e.target.value;
    const c = $('#count');
    const n = e.target.value.length;
    if (c) c.textContent = `${n} / 280 · min 12`;
    const err = $('#blufferr');
    if (err) err.textContent = '';
  });
  // rotate placeholder occasionally while typing empty
  if ($('#blufftext')) {
    clearInterval(window._ph);
    window._ph = setInterval(() => {
      const ta = $('#blufftext');
      if (!ta || ta.value) return;
      placeholderIdx = (placeholderIdx + 1) % PLACEHOLDERS.length;
      ta.placeholder = PLACEHOLDERS[placeholderIdx];
    }, 4000);
  }
  document.querySelectorAll('[data-vote]').forEach((b) => {
    b.onclick = () => {
      if (state.round?.myVote) return;
      votePick = b.dataset.vote;
      render();
    };
  });
  $('#confirmvote')?.addEventListener('click', () => {
    if (!votePick) return;
    send('vote:submit', { optionId: votePick, submissionId: votePick });
  });
  $('#next')?.addEventListener('click', () => send('round:next'));
  $('#again')?.addEventListener('click', () => send('game:again'));
  $('#rules')?.addEventListener('click', () => rules({ returnTo: () => (state ? render() : home()) }));
}

function boot() {
  const route = location.pathname.match(/^\/r\/([A-Za-z0-9]{4})$/);
  const saved = loadSaved();
  if (saved && (!route || route[1].toUpperCase() === saved.roomCode)) {
    roomCode = saved.roomCode;
    me = saved.playerId;
    connect();
  } else if (route) {
    identity('join');
  } else {
    home();
  }
}

if (!localStorage.getItem('carSpecRulesSeen')) {
  rules({ returnTo: boot });
} else {
  boot();
}
