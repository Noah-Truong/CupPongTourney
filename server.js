const { createServer } = require('http');
const { parse } = require('url');
const { randomUUID } = require('crypto');
const next = require('next');
const { Server } = require('socket.io');

const dev = process.env.NODE_ENV !== 'production';
const port = parseInt(process.env.PORT || '3000', 10);
const BIND_ADDRESS = '0.0.0.0';

console.log(`> Starting Cup Pong server (NODE_ENV=${process.env.NODE_ENV || 'development'}, PORT=${port})`);

const nextApp = next({ dev });
const handle = nextApp.getRequestHandler();

// ─── Game state ───────────────────────────────────────────────────────────────

const rooms = new Map();        // roomId → room
const reconnectMap = new Map(); // persistentId → { roomId, timer }

const RECONNECT_GRACE_MS = 15_000;
const WAITING_GRACE_MS   =  5_000; // shorter grace for lobby disconnects
const MAX_PLAYERS = 8;

// ─── Cup pool: ▽ triangle (wide at top, apex at bottom) ──────────────────────
// N players → baseCount = N+2 rows → (N+2)(N+3)/2 total cups
// 2 players: 4 rows → 10 cups
// 3 players: 5 rows → 15 cups
// 4 players: 6 rows → 21 cups
function createSharedCups(numPlayers) {
  const baseCount = Math.max(4, numPlayers + 2);
  const cups = [];
  let id = 0;
  for (let row = 0; row < baseCount; row++) {
    const cupsInRow = baseCount - row; // row 0 widest, last row has 1 cup
    for (let col = 0; col < cupsInRow; col++) {
      cups.push({ id: id++, row, col, removed: false });
    }
  }
  return cups;
}

function createRoom(playerName, socketId, persistentId) {
  const roomId = randomUUID().substring(0, 6).toUpperCase();
  const player = { socketId, persistentId, name: playerName || 'Player 1', score: 0 };
  const room = {
    id: roomId,
    players: [player],
    sharedCups: [],
    status: 'waiting',
    currentPlayerIndex: 0,
    turnState: { ballsThrown: 0, ballsMade: 0, bonusTurn: false },
    winner: null,
    winnerPersistentId: null,
    gameLog: [`${player.name} created the room. Waiting for players...`],
  };
  rooms.set(roomId, room);
  reconnectMap.set(persistentId, { roomId, timer: null });
  return room;
}

function joinRoom(roomId, playerName, socketId, persistentId) {
  const room = rooms.get(roomId);
  if (!room) return { error: 'Room not found. Check the code and try again.' };
  if (room.players.length >= MAX_PLAYERS) return { error: `Room is full (max ${MAX_PLAYERS} players).` };
  if (room.status === 'playing')  return { error: 'Game already in progress.' };
  if (room.status === 'finished') return { error: 'Game is over. Ask the host for a rematch.' };

  const player = {
    socketId, persistentId,
    name: playerName || `Player ${room.players.length + 1}`,
    score: 0,
  };
  room.players.push(player);
  room.gameLog.push(`${player.name} joined.`);
  reconnectMap.set(persistentId, { roomId, timer: null });
  return { room };
}

function serializeRoom(room) {
  return {
    ...room,
    players: room.players.map(p => ({ id: p.persistentId, name: p.name, score: p.score })),
    winner:      room.winnerPersistentId,
    tied:        room.tied        ?? false,
    tiedPlayers: room.tiedPlayers ?? [],
  };
}

// accuracy: 0.0–1.0 from client drag precision → 5%–95% hit chance
function handleThrow(room, throwingSocketId, targetCupId, accuracy) {
  if (room.status !== 'playing') return { error: 'Game is not active.' };

  const currentPlayer = room.players[room.currentPlayerIndex];
  if (currentPlayer.socketId !== throwingSocketId) return { error: 'Not your turn.' };
  if (room.turnState.ballsThrown >= 2) return { error: 'No more balls this turn.' };

  const targetCup = room.sharedCups.find(c => c.id === targetCupId);
  if (!targetCup || targetCup.removed) return { error: 'Invalid cup target.' };

  const hitChance = 0.05 + Math.min(0.90, Math.max(0, accuracy) * 0.90);
  const success = Math.random() < hitChance;
  let removedCupId = null;

  if (success) {
    targetCup.removed = true;
    removedCupId = targetCupId;
    currentPlayer.score++;
    room.turnState.ballsMade++;
    const remaining = room.sharedCups.filter(c => !c.removed).length;
    room.gameLog.push(
      `${currentPlayer.name} sank a cup! ${remaining} cup${remaining !== 1 ? 's' : ''} left.`
    );

    if (remaining === 0) {
      room.status = 'finished';
      const maxScore  = Math.max(...room.players.map(p => p.score));
      const topPlayers = room.players.filter(p => p.score === maxScore);
      if (topPlayers.length === 1) {
        room.winnerPersistentId = topPlayers[0].persistentId;
        room.tied        = false;
        room.tiedPlayers = [];
        room.gameLog.push(`${topPlayers[0].name} wins with ${maxScore} cup${maxScore !== 1 ? 's' : ''}!`);
      } else {
        room.winnerPersistentId = null;
        room.tied        = true;
        room.tiedPlayers = topPlayers.map(p => p.persistentId);
        const names = topPlayers.map(p => p.name).join(' & ');
        room.gameLog.push(`It's a tie! ${names} both sank ${maxScore} cup${maxScore !== 1 ? 's' : ''}.`);
      }
    }
  } else {
    room.gameLog.push(`${currentPlayer.name} missed.`);
  }

  room.turnState.ballsThrown++;

  if (room.status !== 'finished') {
    if (room.turnState.ballsThrown >= 2) {
      if (room.turnState.ballsMade >= 2) {
        room.gameLog.push(`${currentPlayer.name} sank both — bonus turn!`);
        room.turnState = { ballsThrown: 0, ballsMade: 0, bonusTurn: true };
      } else {
        room.currentPlayerIndex = (room.currentPlayerIndex + 1) % room.players.length;
        room.turnState = { ballsThrown: 0, ballsMade: 0, bonusTurn: false };
        room.gameLog.push(`${room.players[room.currentPlayerIndex].name}'s turn.`);
      }
    }
  }

  return { success, removedCupId, room };
}

// ─── HTTP server — starts listening IMMEDIATELY ───────────────────────────────

let nextReady = false;

const httpServer = createServer((req, res) => {
  if (!nextReady) {
    if (req.url === '/' || req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('Starting...');
    } else {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end('Starting...');
    }
    return;
  }
  const parsedUrl = parse(req.url, true);
  handle(req, res, parsedUrl);
});

const io = new Server(httpServer, { cors: { origin: '*' } });

io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  // ── Room creation ─────────────────────────────────────────────────────────
  socket.on('create-room', (playerName, persistentId) => {
    const room = createRoom(playerName, socket.id, persistentId);
    socket.join(room.id);
    socket.emit('room-created', serializeRoom(room));
  });

  // ── Join existing room (waiting room) ─────────────────────────────────────
  socket.on('join-room', (roomId, playerName, persistentId) => {
    const result = joinRoom(roomId.trim().toUpperCase(), playerName, socket.id, persistentId);
    if (result.error) { socket.emit('error', result.error); return; }
    socket.join(result.room.id);
    socket.emit('room-joined', serializeRoom(result.room));           // → joiner only
    socket.to(result.room.id).emit('room-updated', serializeRoom(result.room)); // → others
  });

  // ── Host starts the game ──────────────────────────────────────────────────
  socket.on('start-game', (roomId, persistentId) => {
    const room = rooms.get(roomId);
    if (!room) return;
    if (room.players[0].persistentId !== persistentId) {
      socket.emit('error', 'Only the host can start the game.');
      return;
    }
    if (room.players.length < 2) {
      socket.emit('error', 'Need at least 2 players to start.');
      return;
    }
    if (room.status !== 'waiting') return;

    room.sharedCups = createSharedCups(room.players.length);
    room.players.forEach(p => { p.score = 0; });
    room.status = 'playing';
    room.currentPlayerIndex = 0;
    room.turnState = { ballsThrown: 0, ballsMade: 0, bonusTurn: false };
    room.winner = null;
    room.winnerPersistentId = null;
    const total = room.sharedCups.length;
    room.gameLog.push(`Game started! ${room.players.length} players, ${total} cups in the pool.`);
    room.gameLog.push(`${room.players[0].name}'s turn.`);
    io.to(roomId).emit('game-started', serializeRoom(room));
  });

  // ── Reconnect / page refresh ──────────────────────────────────────────────
  socket.on('get-room', (roomId, persistentId) => {
    const room = rooms.get(roomId);
    if (!room) { socket.emit('error', 'Room not found. It may have expired.'); return; }

    const playerIdx = room.players.findIndex(p => p.persistentId === persistentId);
    if (playerIdx !== -1) {
      room.players[playerIdx].socketId = socket.id;
      const entry = reconnectMap.get(persistentId);
      if (entry?.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
        socket.to(room.id).emit('opponent-reconnected');
      }
    }

    socket.join(roomId);
    socket.emit('room-state', serializeRoom(room));
  });

  // ── Throw a ball ──────────────────────────────────────────────────────────
  // accuracy: 0.0–1.0 (computed client-side from drag precision)
  socket.on('throw-ball', (roomId, targetCupId, accuracy) => {
    const room = rooms.get(roomId);
    if (!room) { socket.emit('error', 'Room not found.'); return; }
    const result = handleThrow(room, socket.id, targetCupId, accuracy);
    if (result.error) { socket.emit('error', result.error); return; }
    io.to(roomId).emit('throw-result', {
      success: result.success,
      removedCupId: result.removedCupId,
      room: serializeRoom(result.room),
    });
  });

  // ── Rematch ───────────────────────────────────────────────────────────────
  socket.on('rematch', (roomId) => {
    const room = rooms.get(roomId);
    if (!room || room.status !== 'finished') return;
    room.sharedCups = createSharedCups(room.players.length);
    room.players.forEach(p => { p.score = 0; });
    room.status = 'playing';
    room.currentPlayerIndex = 0;
    room.turnState = { ballsThrown: 0, ballsMade: 0, bonusTurn: false };
    room.winner = null;
    room.winnerPersistentId = null;
    room.tied        = false;
    room.tiedPlayers = [];
    const total = room.sharedCups.length;
    room.gameLog = [`Rematch! ${total} cups back in play.`, `${room.players[0].name}'s turn.`];
    io.to(roomId).emit('game-started', serializeRoom(room));
  });

  // ── Disconnect handling ───────────────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log('Disconnected:', socket.id);

    for (const [roomId, room] of rooms.entries()) {
      const playerIdx = room.players.findIndex(p => p.socketId === socket.id);
      if (playerIdx === -1) continue;

      const player = room.players[playerIdx];

      if (room.status === 'finished') {
        rooms.delete(roomId);
        reconnectMap.delete(player.persistentId);
        break;
      }

      if (room.status === 'waiting') {
        // Short grace for lobby navigation; on expiry remove from player list
        const entry = reconnectMap.get(player.persistentId);
        if (entry) {
          entry.timer = setTimeout(() => {
            if (!rooms.has(roomId)) return;
            const idx = room.players.indexOf(player);
            if (idx !== -1) room.players.splice(idx, 1);
            room.gameLog.push(`${player.name} left.`);
            if (room.players.length === 0) {
              rooms.delete(roomId);
            } else {
              io.to(roomId).emit('room-updated', serializeRoom(room));
            }
            reconnectMap.delete(player.persistentId);
          }, WAITING_GRACE_MS);
        }
        break;
      }

      // During active game: 15-second grace period
      io.to(roomId).emit('opponent-disconnected', 'A player disconnected. Waiting to reconnect...');
      const entry = reconnectMap.get(player.persistentId);
      if (entry) {
        entry.timer = setTimeout(() => {
          if (rooms.has(roomId)) {
            io.to(roomId).emit('player-left', 'A player failed to reconnect. Game over.');
            rooms.delete(roomId);
          }
          reconnectMap.delete(player.persistentId);
        }, RECONNECT_GRACE_MS);
      }
      break;
    }
  });
});

httpServer.listen(port, BIND_ADDRESS, () => {
  console.log(`> Listening on ${BIND_ADDRESS}:${port} — preparing Next.js...`);
});

nextApp.prepare().then(() => {
  nextReady = true;
  console.log(`> Next.js ready — fully operational on port ${port}`);
}).catch((err) => {
  console.error('> Next.js prepare() failed:', err);
  process.exit(1);
});
