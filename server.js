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

const rooms = new Map();       // roomId → room
const reconnectMap = new Map(); // persistentId → { roomId, timer }
const RECONNECT_GRACE_MS = 15_000;

function createCups() {
  const cups = [];
  let id = 0;
  for (let row = 0; row < 4; row++) {
    const cupsInRow = 4 - row;
    for (let col = 0; col < cupsInRow; col++) {
      cups.push({ id: id++, row, col, removed: false });
    }
  }
  return cups; // 10 cups total: 4+3+2+1
}

function calculateSuccess(meterValue) {
  if (meterValue <= 10) return Math.random() < 0.95;
  if (meterValue <= 25) return Math.random() < 0.78;
  if (meterValue <= 40) return Math.random() < 0.55;
  if (meterValue <= 60) return Math.random() < 0.30;
  return Math.random() < 0.10;
}

function createRoom(playerName, socketId, persistentId) {
  const roomId = randomUUID().substring(0, 6).toUpperCase();
  const player = {
    socketId,
    persistentId,
    name: playerName || 'Player 1',
    cups: createCups(),
  };
  const room = {
    id: roomId,
    players: [player],
    status: 'waiting',
    currentPlayerIndex: 0,
    turnState: { ballsThrown: 0, ballsMade: 0, bonusTurn: false },
    winner: null,
    winnerPersistentId: null,
    gameLog: [`${player.name} created the room. Waiting for opponent...`],
  };
  rooms.set(roomId, room);
  reconnectMap.set(persistentId, { roomId, timer: null });
  return room;
}

function joinRoom(roomId, playerName, socketId, persistentId) {
  const room = rooms.get(roomId);
  if (!room) return { error: 'Room not found. Check the code and try again.' };
  if (room.players.length >= 2) return { error: 'Room is full.' };
  if (room.status !== 'waiting') return { error: 'Game already in progress.' };

  const player = {
    socketId,
    persistentId,
    name: playerName || 'Player 2',
    cups: createCups(),
  };
  room.players.push(player);
  room.status = 'playing';
  room.gameLog.push(`${player.name} joined! Game is starting...`);
  room.gameLog.push(`${room.players[0].name}'s turn.`);
  reconnectMap.set(persistentId, { roomId, timer: null });
  return { room };
}

function serializeRoom(room) {
  return {
    ...room,
    players: room.players.map(p => ({
      id: p.persistentId,
      name: p.name,
      cups: p.cups,
    })),
    winner: room.winnerPersistentId,
  };
}

function handleThrow(room, throwingSocketId, targetCupId, meterValue) {
  if (room.status !== 'playing') return { error: 'Game is not active.' };

  const currentPlayer = room.players[room.currentPlayerIndex];
  if (currentPlayer.socketId !== throwingSocketId) return { error: 'Not your turn.' };
  if (room.turnState.ballsThrown >= 2) return { error: 'No more balls this turn.' };

  const opponentIndex = 1 - room.currentPlayerIndex;
  const opponent = room.players[opponentIndex];
  const targetCup = opponent.cups.find(c => c.id === targetCupId);

  if (!targetCup || targetCup.removed) return { error: 'Invalid cup target.' };

  const success = calculateSuccess(meterValue);
  let removedCupId = null;

  if (success) {
    targetCup.removed = true;
    removedCupId = targetCupId;
    room.turnState.ballsMade++;
    const remaining = opponent.cups.filter(c => !c.removed).length;
    room.gameLog.push(`${currentPlayer.name} sank a cup. ${opponent.name} has ${remaining} cup${remaining !== 1 ? 's' : ''} left.`);

    if (remaining === 0) {
      room.winnerPersistentId = currentPlayer.persistentId;
      room.status = 'finished';
      room.gameLog.push(`${currentPlayer.name} wins the game!`);
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
        room.currentPlayerIndex = opponentIndex;
        room.turnState = { ballsThrown: 0, ballsMade: 0, bonusTurn: false };
        room.gameLog.push(`${room.players[room.currentPlayerIndex].name}'s turn.`);
      }
    }
  }

  return { success, removedCupId, room };
}

// ─── HTTP server — starts listening IMMEDIATELY ───────────────────────────────
// This ensures Railway's healthcheck can connect as soon as the process starts,
// even while app.prepare() is still running in the background.

let nextReady = false;

const httpServer = createServer((req, res) => {
  if (!nextReady) {
    // Next.js is still warming up. Return 200 for the healthcheck path so Railway
    // knows the process is alive; everything else gets a temporary 503.
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

// Socket.io attaches to the raw HTTP server — independent of Next.js readiness.
const io = new Server(httpServer, {
  cors: { origin: '*' },
});

io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  socket.on('create-room', (playerName, persistentId) => {
    const room = createRoom(playerName, socket.id, persistentId);
    socket.join(room.id);
    socket.emit('room-created', serializeRoom(room));
  });

  socket.on('join-room', (roomId, playerName, persistentId) => {
    const result = joinRoom(roomId.trim().toUpperCase(), playerName, socket.id, persistentId);
    if (result.error) {
      socket.emit('error', result.error);
      return;
    }
    socket.join(result.room.id);
    io.to(result.room.id).emit('game-started', serializeRoom(result.room));
  });

  socket.on('get-room', (roomId, persistentId) => {
    const room = rooms.get(roomId);
    if (!room) {
      socket.emit('error', 'Room not found. It may have expired.');
      return;
    }

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

  socket.on('throw-ball', (roomId, targetCupId, meterValue) => {
    const room = rooms.get(roomId);
    if (!room) { socket.emit('error', 'Room not found.'); return; }
    const result = handleThrow(room, socket.id, targetCupId, meterValue);
    if (result.error) { socket.emit('error', result.error); return; }
    io.to(roomId).emit('throw-result', {
      success: result.success,
      removedCupId: result.removedCupId,
      room: serializeRoom(result.room),
    });
  });

  socket.on('rematch', (roomId) => {
    const room = rooms.get(roomId);
    if (!room || room.status !== 'finished') return;
    room.players.forEach(p => { p.cups = createCups(); });
    room.status = 'playing';
    room.currentPlayerIndex = 0;
    room.turnState = { ballsThrown: 0, ballsMade: 0, bonusTurn: false };
    room.winner = null;
    room.winnerPersistentId = null;
    room.gameLog = ['Rematch started!', `${room.players[0].name}'s turn.`];
    io.to(roomId).emit('game-started', serializeRoom(room));
  });

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

      io.to(roomId).emit('opponent-disconnected', 'Opponent disconnected. Waiting for them to reconnect...');

      const entry = reconnectMap.get(player.persistentId);
      if (entry) {
        entry.timer = setTimeout(() => {
          if (rooms.has(roomId)) {
            io.to(roomId).emit('player-left', 'Opponent failed to reconnect. Game over.');
            rooms.delete(roomId);
          }
          reconnectMap.delete(player.persistentId);
        }, RECONNECT_GRACE_MS);
      }
      break;
    }
  });
});

// Listen immediately — don't wait for Next.js.
httpServer.listen(port, BIND_ADDRESS, () => {
  console.log(`> Listening on ${BIND_ADDRESS}:${port} — preparing Next.js...`);
});

// Prepare Next.js in the background. Once ready, swap in the real handler.
nextApp.prepare().then(() => {
  nextReady = true;
  console.log(`> Next.js ready — fully operational on port ${port}`);
}).catch((err) => {
  console.error('> Next.js prepare() failed:', err);
  process.exit(1);
});
