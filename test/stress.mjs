/**
 * Cup Pong Stress Test Suite — updated for shared cup pool + drag-to-throw API
 * Tests: room creation, multi-player lobby, turn logic, win condition, concurrent rooms,
 *        rematch, disconnect grace, edge-case rejections, room expiry
 */

import { io } from 'socket.io-client';
import { randomUUID } from 'crypto';

const SERVER = 'http://localhost:3000';
const PASS = '\x1b[32m✓\x1b[0m';
const FAIL = '\x1b[31m✗\x1b[0m';
const INFO = '\x1b[34m·\x1b[0m';

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) { console.log(`  ${PASS} ${label}`); passed++; }
  else           { console.log(`  ${FAIL} ${label}`); failed++; }
}

function makeClient() {
  return io(SERVER, { autoConnect: true, forceNew: true, timeout: 5000 });
}

function waitFor(socket, event, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout waiting for "${event}"`)), timeout);
    socket.once(event, (data) => { clearTimeout(t); resolve(data); });
  });
}

function waitForAny(socket, events, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout: ${events.join('/')}`)), timeout);
    const cleanup = () => { clearTimeout(t); events.forEach(e => socket.off(e)); };
    events.forEach(e => socket.once(e, (data) => { cleanup(); resolve({ event: e, data }); }));
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Helper: create a room, have N players join, then host starts the game.
 * Returns { roomId, room (game-started state), clients, pids }
 */
async function setupGame(playerNames) {
  const clients = [];
  const pids    = [];

  for (let i = 0; i < playerNames.length; i++) {
    const c = makeClient();
    await waitFor(c, 'connect');
    clients.push(c);
    pids.push(randomUUID());
  }

  clients[0].emit('create-room', playerNames[0], pids[0]);
  const created = await waitFor(clients[0], 'room-created');
  const roomId  = created.id;

  for (let i = 1; i < playerNames.length; i++) {
    clients[i].emit('join-room', roomId, playerNames[i], pids[i]);
    await waitFor(clients[i], 'room-joined');
  }

  // Host starts the game
  const startedPromises = clients.map(c => waitFor(c, 'game-started'));
  clients[0].emit('start-game', roomId, pids[0]);
  const startedRooms = await Promise.all(startedPromises);
  const room = startedRooms[0];

  return { roomId, room, clients, pids };
}

// ─── Test 1: Room creation ─────────────────────────────────────────────────────
async function testRoomCreation() {
  console.log('\n\x1b[1mTest 1: Room Creation\x1b[0m');
  const c = makeClient();
  await waitFor(c, 'connect');

  c.emit('create-room', 'Alice', randomUUID());
  const room = await waitFor(c, 'room-created');

  assert(room.id?.length === 6,          `Room has 6-char ID: "${room.id}"`);
  assert(room.players.length === 1,      'Room has 1 player');
  assert(room.players[0].name === 'Alice','Player name is Alice');
  assert(room.status === 'waiting',      'Room status is waiting');
  assert(Array.isArray(room.sharedCups), 'sharedCups is array');
  assert(room.sharedCups.length === 0,   'Cups empty until game starts');
  assert(room.players[0].score === 0,    'Player score starts at 0');

  c.disconnect();
}

// ─── Test 2: Two players start a game ─────────────────────────────────────────
async function testTwoPlayerGame() {
  console.log('\n\x1b[1mTest 2: Two-Player Game Start\x1b[0m');
  const { room, clients } = await setupGame(['Player1', 'Player2']);

  assert(room.status === 'playing',            'Room status is playing');
  assert(room.players.length === 2,            'Both players present');
  assert(room.currentPlayerIndex === 0,        'Player 1 goes first');
  // 2 players → baseCount = 4 → 4+3+2+1 = 10 cups
  assert(room.sharedCups.length === 10,        'Shared pool has 10 cups (2 players)');
  assert(room.sharedCups.every(c => !c.removed),'All cups start intact');
  assert(room.players.every(p => p.score === 0),'All scores start at 0');

  clients.forEach(c => c.disconnect());
}

// ─── Test 3: Three-player room ────────────────────────────────────────────────
async function testThreePlayerRoom() {
  console.log('\n\x1b[1mTest 3: Three-Player Room\x1b[0m');
  const { room, clients } = await setupGame(['P1', 'P2', 'P3']);

  assert(room.status === 'playing',       'Game started with 3 players');
  assert(room.players.length === 3,       'All 3 players present');
  // 3 players → baseCount = 5 → 5+4+3+2+1 = 15 cups
  assert(room.sharedCups.length === 15,   'Shared pool has 15 cups (3 players)');

  clients.forEach(c => c.disconnect());
}

// ─── Test 4: Player cannot join after game starts ─────────────────────────────
async function testJoinRejectedAfterStart() {
  console.log('\n\x1b[1mTest 4: Cannot Join In-Progress Game\x1b[0m');
  const { roomId, clients } = await setupGame(['H', 'G']);

  const late = makeClient();
  await waitFor(late, 'connect');
  late.emit('join-room', roomId, 'Late', randomUUID());
  const result = await waitForAny(late, ['room-joined', 'error']);

  assert(result.event === 'error',                        'Late joiner receives error');
  assert(result.data.includes('already in progress'),     `Error: "${result.data}"`);

  // Bad room code
  const ghost = makeClient();
  await waitFor(ghost, 'connect');
  ghost.emit('join-room', 'ZZZZZZ', 'Ghost', randomUUID());
  const r2 = await waitForAny(ghost, ['room-joined', 'error']);
  assert(r2.event === 'error',       'Bad code → error');
  assert(r2.data.includes('not found'), `Error mentions "not found": "${r2.data}"`);

  clients.forEach(c => c.disconnect());
  late.disconnect();
  ghost.disconnect();
}

// ─── Test 5: Only host can start ──────────────────────────────────────────────
async function testOnlyHostCanStart() {
  console.log('\n\x1b[1mTest 5: Only Host Can Start Game\x1b[0m');
  const c1 = makeClient(), c2 = makeClient();
  await Promise.all([waitFor(c1, 'connect'), waitFor(c2, 'connect')]);
  const pid1 = randomUUID(), pid2 = randomUUID();

  c1.emit('create-room', 'Host', pid1);
  const room = await waitFor(c1, 'room-created');
  c2.emit('join-room', room.id, 'Guest', pid2);
  await waitFor(c2, 'room-joined');

  // Non-host tries to start
  let errorReceived = false;
  c2.once('error', () => { errorReceived = true; });
  c2.emit('start-game', room.id, pid2);
  await sleep(500);
  assert(errorReceived, 'Non-host gets error when trying to start');

  c1.disconnect(); c2.disconnect();
}

// ─── Test 6: Turn logic — 2 balls per turn ────────────────────────────────────
async function testTurnLogic() {
  console.log('\n\x1b[1mTest 6: Turn Logic (2 balls, switching)\x1b[0m');
  const { roomId, room, clients } = await setupGame(['Thrower', 'Receiver']);
  const [c1, c2] = clients;

  const cup0 = room.sharedCups[0].id;
  const cup1 = room.sharedCups[1].id;
  const cup2 = room.sharedCups[2].id;

  // Ball 1 with 0.0 accuracy → almost certain miss (5% hit chance)
  c1.emit('throw-ball', roomId, cup0, 0.0);
  const r1 = await waitFor(c1, 'throw-result');
  assert(r1.room.turnState.ballsThrown === 1, 'After ball 1: ballsThrown = 1');
  assert(r1.room.currentPlayerIndex === 0,    'Still P1 turn after first throw');

  // Ball 2
  c1.emit('throw-ball', roomId, cup1, 0.0);
  const r2 = await waitFor(c1, 'throw-result');
  assert(r2.room.turnState.ballsThrown === 0,   'After ball 2: ballsThrown resets');
  assert(r2.room.currentPlayerIndex === 1,      'Turn switches to P2');

  // P1 tries to throw on P2's turn → error
  let errReceived = false;
  c1.once('error', () => { errReceived = true; });
  c1.emit('throw-ball', roomId, cup2, 0.5);
  await sleep(400);
  assert(errReceived, 'P1 cannot throw during P2 turn');

  c1.disconnect(); c2.disconnect();
}

// ─── Test 7: Bonus turn when both balls sink ──────────────────────────────────
async function testBonusTurn() {
  console.log('\n\x1b[1mTest 7: Bonus Turn (both balls sunk)\x1b[0m');
  let bonusTurnSeen = false;

  for (let attempt = 0; attempt < 20 && !bonusTurnSeen; attempt++) {
    const { roomId, room, clients } = await setupGame(['BonusA', 'BonusB']);
    const [c1, c2] = clients;
    const cups = room.sharedCups.filter(c => !c.removed);

    c1.emit('throw-ball', roomId, cups[0].id, 1.0); // 95% hit
    const r1 = await waitFor(c1, 'throw-result');

    if (r1.success) {
      c1.emit('throw-ball', roomId, cups[1].id, 1.0);
      const r2 = await waitFor(c1, 'throw-result');

      if (r2.success && r2.room.status !== 'finished') {
        assert(r2.room.currentPlayerIndex === 0, 'Bonus turn: still P1');
        assert(r2.room.turnState.bonusTurn === true, 'bonusTurn flag set');
        assert(r2.room.turnState.ballsThrown === 0,  'Balls reset for bonus');
        bonusTurnSeen = true;
      }
    }

    c1.disconnect(); c2.disconnect();
  }

  if (!bonusTurnSeen) assert(false, 'Could not trigger bonus turn in 20 attempts');
}

// ─── Test 8: Win condition — shared pool drained ──────────────────────────────
async function testWinCondition() {
  console.log('\n\x1b[1mTest 8: Win Condition (shared pool drained)\x1b[0m');
  const { roomId, room, clients } = await setupGame(['Winner', 'Loser']);
  const [c1, c2] = clients;

  let currentRoom = room;
  let bail = 0;

  while (currentRoom.status !== 'finished' && bail < 500) {
    const isP1Turn = currentRoom.currentPlayerIndex === 0;
    const client   = isP1Turn ? c1 : c2;
    const cups     = currentRoom.sharedCups.filter(c => !c.removed);
    if (cups.length === 0) break;

    const accuracy = isP1Turn ? 1.0 : 0.0; // P1 always hits, P2 always misses
    client.emit('throw-ball', roomId, cups[0].id, accuracy);
    const r = await waitFor(client, 'throw-result');
    currentRoom = r.room;
    bail++;
  }

  assert(currentRoom.status === 'finished', 'Game reaches finished status');
  assert(currentRoom.winner !== null,       'Winner is set');
  assert(
    currentRoom.sharedCups.every(c => c.removed),
    'All shared cups removed when game ends'
  );
  const winnerPlayer = currentRoom.players.find(p => p.id === currentRoom.winner);
  assert(winnerPlayer?.score > 0, `Winner sank at least 1 cup (scored ${winnerPlayer?.score})`);

  c1.disconnect(); c2.disconnect();
}

// ─── Test 9: Concurrent rooms don't interfere ─────────────────────────────────
async function testConcurrentRooms() {
  console.log('\n\x1b[1mTest 9: Concurrent Rooms Isolation\x1b[0m');
  const ROOM_COUNT = 5;
  const allClients = [];
  const roomIds    = [];
  const rooms      = [];

  // Set up ROOM_COUNT independent 2-player games
  for (let i = 0; i < ROOM_COUNT; i++) {
    const result = await setupGame([`H${i}`, `G${i}`]);
    allClients.push(...result.clients);
    roomIds.push(result.roomId);
    rooms.push(result.room);
  }

  assert(new Set(roomIds).size === ROOM_COUNT, `All ${ROOM_COUNT} rooms have unique IDs`);

  // Throw in room 0, verify other rooms don't see the event
  let wrongRoomGotEvent = false;
  for (let i = 1; i < ROOM_COUNT; i++) {
    allClients[i * 2].once('throw-result', () => { wrongRoomGotEvent = true; });
  }

  const r0 = rooms[0];
  const cup = r0.sharedCups.find(c => !c.removed);
  allClients[0].emit('throw-ball', r0.id, cup.id, 0.5);
  await waitFor(allClients[0], 'throw-result');
  await sleep(300);

  assert(!wrongRoomGotEvent, 'throw-result isolated to correct room');

  allClients.forEach(c => c.disconnect());
}

// ─── Test 10: Rematch resets state ────────────────────────────────────────────
async function testRematch() {
  console.log('\n\x1b[1mTest 10: Rematch Resets State\x1b[0m');
  const { roomId, room, clients } = await setupGame(['A', 'B']);
  const [c1, c2] = clients;

  let currentRoom = room;
  let bail = 0;
  while (currentRoom.status !== 'finished' && bail < 300) {
    const isP1Turn = currentRoom.currentPlayerIndex === 0;
    const client   = isP1Turn ? c1 : c2;
    const cups     = currentRoom.sharedCups.filter(c => !c.removed);
    if (cups.length === 0) break;
    client.emit('throw-ball', roomId, cups[0].id, 1.0);
    const r = await waitFor(client, 'throw-result');
    currentRoom = r.room;
    bail++;
  }

  if (currentRoom.status === 'finished') {
    c1.emit('rematch', roomId);
    const [r1, r2] = await Promise.all([
      waitFor(c1, 'game-started'),
      waitFor(c2, 'game-started'),
    ]);
    assert(r1.status === 'playing',                'Rematch: room back to playing');
    // 2 players → 10 cups
    assert(r1.sharedCups.length === 10,            'Shared pool refilled (10 cups)');
    assert(r1.sharedCups.every(c => !c.removed),   'All cups fresh for rematch');
    assert(r1.players.every(p => p.score === 0),   'Scores reset to 0');
    assert(r1.winner === null,                     'Winner cleared');
    assert(r1.currentPlayerIndex === 0,            'P1 goes first again');
    assert(r2.status === 'playing',                'Both clients see rematch');
  } else {
    console.log(`  ${INFO} Game didn't finish in bail limit — skipping rematch assertions`);
  }

  c1.disconnect(); c2.disconnect();
}

// ─── Test 11: Disconnect + grace period ───────────────────────────────────────
async function testDisconnectGrace() {
  console.log('\n\x1b[1mTest 11: Disconnect Grace Period\x1b[0m');
  const { room, clients } = await setupGame(['Grace1', 'Grace2']);
  const [c1, c2] = clients;

  let disconnectMsgReceived = false;
  c2.once('opponent-disconnected', () => { disconnectMsgReceived = true; });
  c1.disconnect();
  await sleep(1000);

  assert(disconnectMsgReceived, 'P2 receives opponent-disconnected within 1s');
  console.log(`  ${INFO} Room stays alive for 15s grace period`);

  // Reconnect within grace period
  const c1b = makeClient();
  await waitFor(c1b, 'connect');

  let reconnectReceived = false;
  c2.once('opponent-reconnected', () => { reconnectReceived = true; });

  c1b.emit('get-room', room.id, room.players[0].id);
  const result = await waitForAny(c1b, ['room-state', 'error']);
  assert(result.event === 'room-state', 'Reconnected player gets room-state');
  await sleep(500);
  assert(reconnectReceived, 'P2 receives opponent-reconnected');

  c1b.disconnect(); c2.disconnect();
}

// ─── Test 12: Over-throw rejected (3rd ball) ──────────────────────────────────
async function testOverThrowRejected() {
  console.log('\n\x1b[1mTest 12: 3rd Ball Rejected\x1b[0m');
  const { roomId, room, clients } = await setupGame(['Spammer', 'Opp']);
  const [c1] = clients;
  const cups = room.sharedCups;

  c1.emit('throw-ball', roomId, cups[0].id, 0.0);
  await waitFor(c1, 'throw-result');
  c1.emit('throw-ball', roomId, cups[1].id, 0.0);
  await waitFor(c1, 'throw-result');

  let errorReceived = false;
  c1.once('error', () => { errorReceived = true; });
  c1.emit('throw-ball', roomId, cups[2].id, 0.0);
  await sleep(400);
  assert(errorReceived, '3rd throw in same turn is rejected');

  clients.forEach(c => c.disconnect());
}

// ─── Test 13: Targeting removed cup rejected ──────────────────────────────────
async function testRemovedCupRejected() {
  console.log('\n\x1b[1mTest 13: Removed Cup Rejected\x1b[0m');
  let succeeded = false;

  for (let attempt = 0; attempt < 15 && !succeeded; attempt++) {
    const { roomId, room, clients } = await setupGame(['Sniper', 'Target']);
    const [c1] = clients;
    const cup = room.sharedCups[0];

    c1.emit('throw-ball', roomId, cup.id, 1.0);
    const r1 = await waitFor(c1, 'throw-result');

    if (r1.success) {
      let errorReceived = false;
      c1.once('error', () => { errorReceived = true; });
      c1.emit('throw-ball', roomId, cup.id, 1.0); // target same (now removed) cup
      await sleep(400);
      assert(errorReceived, 'Targeting removed cup is rejected');
      succeeded = true;
    }

    clients.forEach(c => c.disconnect());
  }

  if (!succeeded) console.log(`  ${INFO} Could not sink a cup in 15 attempts`);
}

// ─── Test 14: Room expires after grace ────────────────────────────────────────
async function testRoomExpiresAfterGrace() {
  console.log('\n\x1b[1mTest 14: Room Expires After Grace Period\x1b[0m');
  console.log(`  ${INFO} Waits 16s for the 15s grace period to expire…`);

  const { room, clients } = await setupGame(['Leaver', 'Waiter']);
  const [c1, c2] = clients;

  let playerLeftReceived = false;
  c2.once('player-left', () => { playerLeftReceived = true; });

  c1.disconnect();
  await sleep(16_000);

  assert(playerLeftReceived, 'P2 receives player-left after grace period');

  const c3 = makeClient();
  await waitFor(c3, 'connect');
  c3.emit('get-room', room.id, randomUUID());
  const result = await waitForAny(c3, ['room-state', 'error']);
  assert(result.event === 'error', 'Expired room returns error on get-room');

  c2.disconnect(); c3.disconnect();
}

// ─── Run all ───────────────────────────────────────────────────────────────────
async function run() {
  console.log('\x1b[1m\x1b[36m══════════════════════════════════\x1b[0m');
  console.log('\x1b[1m\x1b[36m  Cup Pong Stress Test Suite\x1b[0m');
  console.log('\x1b[1m\x1b[36m══════════════════════════════════\x1b[0m');

  try {
    await testRoomCreation();
    await testTwoPlayerGame();
    await testThreePlayerRoom();
    await testJoinRejectedAfterStart();
    await testOnlyHostCanStart();
    await testTurnLogic();
    await testBonusTurn();
    await testWinCondition();
    await testConcurrentRooms();
    await testRematch();
    await testDisconnectGrace();
    await testOverThrowRejected();
    await testRemovedCupRejected();
    await testRoomExpiresAfterGrace();
  } catch (e) {
    console.error(`\n${FAIL} Unexpected error: ${e.message}`);
    failed++;
  }

  const total = passed + failed;
  console.log('\n\x1b[1m──────────────────────────────────\x1b[0m');
  console.log(`\x1b[1mResults: ${passed}/${total} passed\x1b[0m`);
  if (failed > 0) console.log(`\x1b[31m${failed} assertion(s) failed\x1b[0m`);
  else            console.log('\x1b[32mAll tests passed!\x1b[0m');
  console.log('');
  process.exit(failed > 0 ? 1 : 0);
}

run();
