import express from 'express';
import { WebSocketServer } from 'ws';
import { randomUUID } from 'crypto';
import { createServer } from 'http';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

const ROOM_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PAUSE_MS = 30_000;
const BRIEFING_MS = 8_000;
const SKIP_AFTER_MS = 3_000;
const REVEAL_HOLD_MS = 12_000;

const rooms = new Map();
const sockets = new Map(); // playerId -> ws

const deck = JSON.parse(readFileSync(join(__dirname, 'content', 'deck.json'), 'utf8'));

const now = () => Date.now();

function makeCode() {
  let code = '';
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += ROOM_CHARS[Math.floor(Math.random() * ROOM_CHARS.length)];
  } while (rooms.has(code));
  return code;
}

function send(ws, event, data = {}) {
  if (ws?.readyState === 1) ws.send(JSON.stringify({ event, ...data }));
}

function norm(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function similar(a, b) {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.includes(y) || y.includes(x)) return Math.min(x.length, y.length) >= 10;
  let dist = levenshtein(x, y);
  const maxLen = Math.max(x.length, y.length);
  return maxLen > 0 && dist / maxLen < 0.15;
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function connectedCount(room) {
  return room.players.filter((p) => p.connected).length;
}

function publicPlayer(p) {
  return {
    id: p.id,
    name: p.name,
    avatar: p.avatar,
    ready: p.ready,
    connected: p.connected,
    score: p.score,
    correctGuesses: p.correctGuesses,
    trickPoints: p.trickPoints,
    joinedAt: p.joinedAt,
  };
}

function timerPayload(round) {
  if (!round?.startedAt) return null;
  return {
    startedAt: round.startedAt,
    durationMs: round.durationMs,
    endsAt: round.startedAt + round.durationMs,
  };
}

function lockedBluffPlayerIds(room) {
  return room.round.submissions
    .filter((s) => s.playerId && (s.kind === 'player' || s.kind === 'house'))
    .map((s) => s.playerId);
}

function publicRoundFor(room, viewerId) {
  const q = room.round;
  if (!q) return null;

  const out = {
    category: q.card.category,
    question: q.card.question,
    timer: timerPayload(q),
    ownOptionId: null,
    bluffLocked: false,
    lockedPlayerIds: [],
    votedPlayerIds: q.votes.map((v) => v.playerId),
    myVote: null,
    pendingVote: null,
    lineup: null,
    scores: null,
    votes: null,
  };

  if (room.phase === 'bluff') {
    const mine = q.submissions.find((s) => s.playerId === viewerId);
    out.bluffLocked = !!(mine && mine.kind === 'player');
    out.lockedPlayerIds = lockedBluffPlayerIds(room).filter((id) =>
      q.submissions.some((s) => s.playerId === id && s.kind === 'player')
    );
  }

  if (room.phase === 'vote' || room.phase === 'reveal') {
    out.lineup = q.lineup.map((s) => {
      const base = { optionId: s.id, text: s.text };
      if (room.phase === 'vote') {
        return { ...base, isMine: s.playerId === viewerId };
      }
      // reveal
      const voters = q.votes
        .filter((v) => v.submissionId === s.id)
        .map((v) => {
          const p = room.players.find((x) => x.id === v.playerId);
          return p ? { id: p.id, name: p.name, avatar: p.avatar } : null;
        })
        .filter(Boolean);
      return {
        ...base,
        isMine: s.playerId === viewerId,
        isReal: s.kind === 'real',
        echo: !!s.echo,
        kind: s.kind,
        authorId: s.playerId || null,
        authorName:
          s.kind === 'real'
            ? null
            : s.kind === 'house'
              ? 'House bluff'
              : s.kind === 'decoy'
                ? 'House decoy'
                : room.players.find((p) => p.id === s.playerId)?.name || 'Unknown',
        authorAvatar:
          s.kind === 'player'
            ? room.players.find((p) => p.id === s.playerId)?.avatar || ''
            : s.kind === 'real'
              ? '✓'
              : '🏭',
        voters,
      };
    });
    out.ownOptionId = q.lineup.find((s) => s.playerId === viewerId)?.id || null;
  }

  if (room.phase === 'vote') {
    out.myVote = q.votes.find((v) => v.playerId === viewerId)?.submissionId || null;
  }

  if (room.phase === 'reveal') {
    out.votes = q.votes.map((v) => ({
      playerId: v.playerId,
      optionId: v.submissionId,
      playerName: room.players.find((p) => p.id === v.playerId)?.name,
      playerAvatar: room.players.find((p) => p.id === v.playerId)?.avatar,
    }));
    out.scores = q.scores;
  }

  return out;
}

function publicRoomFor(room, viewerId) {
  return {
    code: room.code,
    seq: room.seq,
    hostPlayerId: room.hostPlayerId,
    phase: room.phase,
    paused: !!room.paused,
    pauseEndsAt: room.pauseEndsAt || null,
    pauseReason: room.pauseReason || null,
    settings: room.settings,
    roundIndex: room.roundIndex,
    players: room.players.map(publicPlayer),
    round: publicRoundFor(room, viewerId),
    podium: room.podium || null,
    you: publicPlayer(room.players.find((p) => p.id === viewerId) || { id: viewerId, name: '?', avatar: '?', ready: false, connected: false, score: 0, correctGuesses: 0, trickPoints: 0, joinedAt: 0 }),
  };
}

function broadcast(room, event, extra = {}) {
  room.seq += 1;
  for (const p of room.players) {
    const ws = sockets.get(p.id);
    if (ws) {
      send(ws, event, {
        roomCode: room.code,
        seq: room.seq,
        state: publicRoomFor(room, p.id),
        ...extra,
      });
    }
  }
}

function newPlayer(name, avatar) {
  return {
    id: randomUUID(),
    name,
    avatar,
    joinedAt: now(),
    connected: true,
    ready: false,
    score: 0,
    correctGuesses: 0,
    trickPoints: 0,
    previousGuessCorrect: false,
  };
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function newRoom(host) {
  const room = {
    code: makeCode(),
    seq: 0,
    hostPlayerId: host.id,
    players: [host],
    settings: { roundCount: 4, bluffSeconds: 45, voteSeconds: 25 },
    phase: 'lobby',
    roundIndex: 0,
    deck: shuffle(deck),
    usedCardIds: new Set(),
    round: null,
    timer: null,
    pauseTimer: null,
    paused: false,
    pauseEndsAt: null,
    pauseReason: null,
    resumePhase: null,
    podium: null,
  };
  rooms.set(room.code, room);
  return room;
}

function clearTimer(room) {
  if (room.timer) clearTimeout(room.timer);
  room.timer = null;
}

function clearPause(room) {
  if (room.pauseTimer) clearTimeout(room.pauseTimer);
  room.pauseTimer = null;
  room.paused = false;
  room.pauseEndsAt = null;
  room.pauseReason = null;
  room.resumePhase = null;
}

function setPhaseTimer(room, ms, fn) {
  clearTimer(room);
  const startedAt = now();
  if (room.round) {
    room.round.startedAt = startedAt;
    room.round.durationMs = ms;
    room.round.phaseStartedAt = startedAt;
  }
  room.timer = setTimeout(fn, ms);
}

const HOUSE_TEMPLATES = [
  (cat) =>
    `Factory engineers called it a limited-run ${cat.toLowerCase()} package with revised cooling and a badge nobody could decode.`,
  (cat) =>
    `Internal memos labelled it a ${cat.toLowerCase()} mule with a quiet homologation plaque and one spare intake casting.`,
  () => `Press kits whispered about a sealed crankcase, a temporary chassis stamp, and a name that never reached dealers.`,
  (cat) =>
    `The ${cat.toLowerCase()} brief mentioned a one-off calibration map, a stamped spare casting, and zero dealer inventory.`,
];

function houseBluffText(room) {
  const cat = room.round.card.category;
  const t = HOUSE_TEMPLATES[Math.floor(Math.random() * HOUSE_TEMPLATES.length)];
  return t(cat);
}

function decoyFromHint(card) {
  const hint = card.decoyHint || 'sounds like a quiet factory memo';
  return `Programme notes described something that ${hint.replace(/^sounds like\s+/i, '')}: a sealed test stamp, a spare casting, and paperwork that never reached dealers.`;
}

function ensureBluff(room, player) {
  if (!room.round.submissions.some((s) => s.playerId === player.id)) {
    room.round.submissions.push({
      id: randomUUID(),
      playerId: player.id,
      text: houseBluffText(room),
      kind: 'house',
      echo: false,
    });
  }
}

function pickCard(room) {
  const unused = room.deck.filter((c) => !room.usedCardIds.has(c.id));
  const pool = unused.length ? unused : shuffle(deck);
  if (!unused.length) room.usedCardIds.clear();
  const card = pool[0];
  // rotate deck so next picks differ
  room.deck = [...room.deck.filter((c) => c.id !== card.id), card];
  room.usedCardIds.add(card.id);
  return card;
}

function startRound(room) {
  if (room.paused) return;
  room.podium = null;
  room.roundIndex += 1;
  const card = pickCard(room);
  room.round = {
    card,
    submissions: [],
    votes: [],
    lineup: [],
    scores: [],
    startedAt: null,
    durationMs: 0,
    phaseStartedAt: null,
  };
  room.phase = 'briefing';
  setPhaseTimer(room, BRIEFING_MS, () => startBluff(room));
  broadcast(room, 'round:briefing');
}

function startBluff(room) {
  if (room.paused) return;
  if (room.phase !== 'briefing' && room.phase !== 'bluff') return;
  room.phase = 'bluff';
  setPhaseTimer(room, room.settings.bluffSeconds * 1000, () => finishBluff(room));
  broadcast(room, 'round:bluff-start');
}

function finishBluff(room) {
  if (room.paused) return;
  if (room.phase !== 'bluff') return;
  clearTimer(room);
  for (const p of room.players) ensureBluff(room, p);

  const q = room.round;
  q.submissions.push({
    id: randomUUID(),
    playerId: null,
    text: q.card.realAnswer,
    kind: 'real',
    echo: false,
  });

  if (room.players.length === 2) {
    q.submissions.push({
      id: randomUUID(),
      playerId: null,
      text: decoyFromHint(q.card),
      kind: 'decoy',
      echo: false,
    });
  }

  q.lineup = shuffle(q.submissions);
  room.phase = 'vote';
  setPhaseTimer(room, room.settings.voteSeconds * 1000, () => reveal(room));
  broadcast(room, 'round:lineup');
}

function playerName(room, id) {
  return room.players.find((p) => p.id === id)?.name || 'Someone';
}

function reveal(room) {
  if (room.paused) return;
  if (room.phase !== 'vote') return;
  clearTimer(room);
  const q = room.round;
  q.scores = [];

  for (const p of room.players) {
    const vote = q.votes.find((v) => v.playerId === p.id);
    const chosen = q.submissions.find((s) => s.id === vote?.submissionId);
    const correct = chosen?.kind === 'real';
    const chips = [];
    let guess = 0;
    let streak = 0;
    let trick = 0;
    let perfect = 0;

    if (correct) {
      guess = 1000;
      chips.push({ kind: 'spot', label: 'Spotted the real spec', points: 1000 });
      if (p.previousGuessCorrect) {
        streak = 150;
        chips.push({ kind: 'streak', label: 'Streak', points: 150 });
      }
    }

    const own = q.submissions.find((s) => s.playerId === p.id);
    if (own && own.kind === 'player') {
      const fooledVotes = q.votes.filter((v) => v.submissionId === own.id);
      for (const v of fooledVotes) {
        const pts = own.echo ? 250 : 500;
        trick += pts;
        chips.push({
          kind: 'trick',
          label: `Tricked ${playerName(room, v.playerId)}`,
          points: pts,
          targetId: v.playerId,
        });
      }
      if (fooledVotes.length === room.players.length - 1 && fooledVotes.length > 0 && !own.echo) {
        perfect = 250;
        chips.push({ kind: 'perfect', label: 'Perfect lie', points: 250 });
      }
      p.trickPoints += trick + perfect;
    }

    p.previousGuessCorrect = !!correct;
    if (correct) p.correctGuesses += 1;
    const totalDelta = guess + streak + trick + perfect;
    p.score += totalDelta;
    q.scores.push({
      playerId: p.id,
      name: p.name,
      avatar: p.avatar,
      correctGuess: guess,
      streakBonus: streak,
      trickPoints: trick,
      perfectLieBonus: perfect,
      totalDelta,
      totalScore: p.score,
      chips,
    });
  }

  room.phase = 'reveal';
  setPhaseTimer(room, REVEAL_HOLD_MS, () => advance(room));
  broadcast(room, 'round:reveal');
  broadcast(room, 'score:update');
}

function buildPodium(room) {
  const order = [...room.players].sort(
    (a, b) =>
      b.score - a.score ||
      b.correctGuesses - a.correctGuesses ||
      b.trickPoints - a.trickPoints ||
      a.joinedAt - b.joinedAt
  );
  const biggestLiar = [...room.players].sort((a, b) => b.trickPoints - a.trickPoints || a.joinedAt - b.joinedAt)[0];
  const truthSerum = [...room.players].sort((a, b) => b.correctGuesses - a.correctGuesses || a.joinedAt - b.joinedAt)[0];
  return {
    order: order.map((p) => ({
      id: p.id,
      name: p.name,
      avatar: p.avatar,
      score: p.score,
      correctGuesses: p.correctGuesses,
      trickPoints: p.trickPoints,
    })),
    biggestLiar: { id: biggestLiar.id, name: biggestLiar.name, avatar: biggestLiar.avatar, trickPoints: biggestLiar.trickPoints },
    truthSerum: { id: truthSerum.id, name: truthSerum.name, avatar: truthSerum.avatar, correctGuesses: truthSerum.correctGuesses },
  };
}

function advance(room) {
  if (room.paused) return;
  if (room.phase !== 'reveal') return;
  if (room.roundIndex >= room.settings.roundCount) {
    clearTimer(room);
    room.phase = 'gameOver';
    room.podium = buildPodium(room);
    broadcast(room, 'game:over', { podium: room.podium });
  } else {
    startRound(room);
  }
}

function endGameGracefully(room, reason) {
  clearTimer(room);
  clearPause(room);
  room.phase = 'gameOver';
  room.podium = buildPodium(room);
  room.pauseReason = reason;
  broadcast(room, 'game:over', { podium: room.podium, reason });
}

function remainingMs(room) {
  if (!room.round?.startedAt) return 0;
  return Math.max(0, room.round.startedAt + room.round.durationMs - now());
}

function maybePauseForDisconnect(room) {
  if (room.phase === 'lobby' || room.phase === 'gameOver') return;
  if (connectedCount(room) >= 2) {
    if (room.paused) resumeFromPause(room);
    return;
  }
  if (room.paused) return;

  // Freeze: capture remaining time before clearing the timer.
  room.frozenRemainingMs = remainingMs(room);
  clearTimer(room);
  room.paused = true;
  room.resumePhase = room.phase;
  room.pauseEndsAt = now() + PAUSE_MS;
  room.pauseReason = 'Waiting for players…';
  room.pauseTimer = setTimeout(() => {
    if (connectedCount(room) < 2) {
      endGameGracefully(room, 'Not enough players returned.');
    }
  }, PAUSE_MS);
  broadcast(room, 'room:state');
}

function resumeFromPause(room) {
  if (!room.paused) return;
  const leftover = Math.max(3000, room.frozenRemainingMs || 0);
  clearPause(room);
  room.frozenRemainingMs = null;
  const phase = room.phase;
  if (phase === 'briefing') {
    setPhaseTimer(room, leftover, () => startBluff(room));
  } else if (phase === 'bluff') {
    setPhaseTimer(room, leftover, () => finishBluff(room));
  } else if (phase === 'vote') {
    setPhaseTimer(room, leftover, () => reveal(room));
  } else if (phase === 'reveal') {
    setPhaseTimer(room, leftover, () => advance(room));
  }
  broadcast(room, 'room:state');
}

// --- REST ---
app.get('/api/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));
app.get('/api/deck-size', (_req, res) => res.json({ size: deck.length }));

app.post('/api/rooms', (req, res) => {
  const name = String(req.body.name || '').trim();
  const avatar = req.body.avatar || '🏎️';
  if (name.length < 2 || name.length > 16) return res.status(400).json({ error: 'Names need 2–16 characters.' });
  const host = newPlayer(name, avatar);
  const room = newRoom(host);
  res.json({ roomCode: room.code, playerId: host.id });
});

app.post('/api/rooms/:code/join', (req, res) => {
  const room = rooms.get(String(req.params.code || '').toUpperCase());
  const name = String(req.body.name || '').trim();
  const avatar = req.body.avatar || '🚗';
  if (!room) return res.status(404).json({ error: 'Room not found.' });
  if (room.phase !== 'lobby') return res.status(409).json({ error: 'This race has already started.' });
  if (room.players.length >= 8) return res.status(409).json({ error: 'Room is full.' });
  if (name.length < 2 || name.length > 16) return res.status(400).json({ error: 'Names need 2–16 characters.' });
  if (room.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
    return res.status(409).json({ error: 'That display name is already in the lobby.' });
  }
  const player = newPlayer(name, avatar);
  room.players.push(player);
  broadcast(room, 'player:joined');
  res.json({ roomCode: room.code, playerId: player.id });
});

app.get('/r/:code', (_req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

// --- WebSocket ---
wss.on('connection', (ws) => {
  let playerId = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }

    const roomCode = String(msg.roomCode || '').toUpperCase();
    const room = rooms.get(roomCode);

    if (msg.event === 'identify') {
      playerId = msg.playerId;
      const r = rooms.get(roomCode);
      const p = r?.players.find((x) => x.id === playerId);
      if (!p) {
        return send(ws, 'error', {
          code: 'IDENTITY',
          message: 'Player slot expired. Create or join a room again.',
        });
      }
      p.connected = true;
      sockets.set(playerId, ws);
      send(ws, 'room:state', {
        roomCode: r.code,
        seq: r.seq,
        state: publicRoomFor(r, playerId),
      });
      maybePauseForDisconnect(r);
      return;
    }

    if (!room || !playerId) return;
    const player = room.players.find((x) => x.id === playerId);
    if (!player) return;

    if (room.paused && !['identify'].includes(msg.event)) {
      // allow host-less reconnect traffic only via identify; ignore actions while paused
      if (msg.event !== 'player:ready') {
        return send(ws, 'error', { code: 'PAUSED', message: 'Waiting for players to reconnect…' });
      }
    }

    if (msg.event === 'player:ready' && room.phase === 'lobby') {
      player.ready = !!msg.ready;
      broadcast(room, 'player:ready');
      return;
    }

    if (msg.event === 'room:settings' && room.phase === 'lobby' && room.hostPlayerId === player.id) {
      room.settings = {
        roundCount: [3, 4, 5].includes(+msg.roundCount) ? +msg.roundCount : room.settings.roundCount,
        bluffSeconds: [30, 45, 60].includes(+msg.bluffSeconds) ? +msg.bluffSeconds : room.settings.bluffSeconds,
        voteSeconds: 25,
      };
      broadcast(room, 'room:state');
      return;
    }

    if (msg.event === 'game:start' && room.phase === 'lobby') {
      if (room.hostPlayerId !== player.id) return;
      if (room.players.length < 2) {
        return send(ws, 'error', { code: 'START', message: 'Host needs at least two players.' });
      }
      startRound(room);
      return;
    }

    if (msg.event === 'round:skip' && room.phase === 'briefing' && room.hostPlayerId === player.id) {
      if (now() - (room.round?.phaseStartedAt || 0) < SKIP_AFTER_MS) {
        return send(ws, 'error', { code: 'SKIP', message: 'Skip unlocks after 3 seconds.' });
      }
      startBluff(room);
      return;
    }

    if (msg.event === 'bluff:submit' && room.phase === 'bluff') {
      const text = String(msg.text || '').trim();
      if (text.length < 12 || text.length > 280 || !/[a-z0-9]/i.test(text)) {
        return send(ws, 'bluff:rejected', {
          roomCode: room.code,
          seq: room.seq,
          reason: 'Use 12–280 meaningful characters.',
        });
      }
      if (norm(text) === norm(room.round.card.question) || similar(text, room.round.card.question)) {
        return send(ws, 'bluff:rejected', {
          roomCode: room.code,
          seq: room.seq,
          reason: 'That’s just the question. Invent a spec.',
        });
      }
      if (norm(text) === norm(room.round.card.realAnswer) || similar(text, room.round.card.realAnswer)) {
        return send(ws, 'bluff:rejected', {
          roomCode: room.code,
          seq: room.seq,
          reason: 'Too close to the real spec — make it fake.',
        });
      }
      if (room.round.submissions.some((s) => s.playerId === player.id)) {
        return send(ws, 'bluff:rejected', {
          roomCode: room.code,
          seq: room.seq,
          reason: 'Bluff already locked.',
        });
      }

      const dup = room.round.submissions.find(
        (s) => s.kind === 'player' && (norm(s.text) === norm(text) || similar(s.text, text))
      );
      let echo = false;
      if (dup) {
        const remaining = remainingMs(room);
        if (remaining > 3000) {
          return send(ws, 'bluff:rejected', {
            roomCode: room.code,
            seq: room.seq,
            reason: 'Too close to another bluff — rephrase it.',
          });
        }
        echo = true;
      }

      room.round.submissions.push({
        id: randomUUID(),
        playerId: player.id,
        text,
        kind: 'player',
        echo,
      });

      send(ws, 'bluff:accepted', {
        roomCode: room.code,
        seq: room.seq,
        echo,
        state: publicRoomFor(room, player.id),
      });
      broadcast(room, 'room:state');

      if (room.players.every((x) => room.round.submissions.some((s) => s.playerId === x.id))) {
        finishBluff(room);
      }
      return;
    }

    if (msg.event === 'vote:submit' && room.phase === 'vote') {
      const sub = room.round.lineup.find((s) => s.id === msg.submissionId || s.id === msg.optionId);
      if (!sub) return;
      if (sub.playerId === player.id) {
        return send(ws, 'error', { code: 'VOTE', message: 'That’s yours — pick another.' });
      }
      if (room.round.votes.some((v) => v.playerId === player.id)) {
        return send(ws, 'error', { code: 'VOTE', message: 'Vote already locked.' });
      }

      room.round.votes.push({ playerId: player.id, submissionId: sub.id });
      send(ws, 'vote:accepted', {
        roomCode: room.code,
        seq: room.seq,
        optionId: sub.id,
        state: publicRoomFor(room, player.id),
      });
      broadcast(room, 'room:state');

      // Disconnected players count as no-vote; proceed when every connected player has voted.
      const connected = room.players.filter((p) => p.connected);
      if (
        connected.length >= 1 &&
        connected.every((p) => room.round.votes.some((v) => v.playerId === p.id))
      ) {
        reveal(room);
      }
      return;
    }

    if (msg.event === 'round:next' && room.phase === 'reveal' && room.hostPlayerId === player.id) {
      advance(room);
      return;
    }

    if (msg.event === 'game:again' && room.phase === 'gameOver' && room.hostPlayerId === player.id) {
      for (const x of room.players) {
        Object.assign(x, {
          score: 0,
          correctGuesses: 0,
          trickPoints: 0,
          previousGuessCorrect: false,
          ready: false,
        });
      }
      room.roundIndex = 0;
      room.deck = shuffle(deck);
      room.usedCardIds = new Set();
      room.podium = null;
      clearPause(room);
      startRound(room);
    }
  });

  ws.on('close', () => {
    if (!playerId) return;
    const room = [...rooms.values()].find((r) => r.players.some((p) => p.id === playerId));
    const player = room?.players.find((p) => p.id === playerId);
    if (!player || !room) return;
    player.connected = false;
    sockets.delete(playerId);
    if (room.hostPlayerId === playerId) {
      const next = room.players.filter((x) => x.connected).sort((a, b) => a.joinedAt - b.joinedAt)[0];
      if (next) room.hostPlayerId = next.id;
    }
    broadcast(room, 'player:left');
    maybePauseForDisconnect(room);

    // mid-vote: if everyone still connected has voted, finish
    if (room.phase === 'vote' && !room.paused) {
      const need = room.players.filter((p) => p.connected);
      if (need.length >= 2 && need.every((p) => room.round.votes.some((v) => v.playerId === p.id))) {
        reveal(room);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Car Spec Bluffing ready on :${PORT}`));
