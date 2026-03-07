/**
 * Cup Pong Stress Test Suite
 * Tests: 3+ players per room, turn logic, win conditions, concurrent rooms, reconnection
 */

import { io } from 'socket.io-client';
import { v4 as uuidv4 } from 'uuid';

const SERVER = 'http://localhost:3000';
const PASS = '\x1b[32m✓\x1b[0m';
const FAIL = '\x1b[31m✗\x1b[0m';
const INFO = '\x1b[34m·\x1b[0m';

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ${PASS} ${label}`);
    passed++;
  } else {
    console.log(`  ${FAIL} ${label}`);
    failed++;
  }
}

function makeClient() {
  return io(SERVER, { autoConnect: true, forceNew: true, timeout: 5000 });
}

function waitFor(socket, event, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout waiting for "${event}"`)), timeout);
    socket.once(event, (data) => { clearTimeout(t); resolve(data); });
  });
}

function waitForAny(socket, events, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout waiting for ${events.join('/')}`)), timeout);
    const cleanup = () => { clearTimeout(t); events.forEach(e => socket.off(e)); };
    events.forEach(e => socket.once(e, (data) => { cleanup(); resolve({ event: e, data }); }));
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Test 1: Basic room creation ──────────────────────────────────────────────
async function testRoomCreation() {
  console.log('\n\x1b[1mTest 1: Room Creation\x1b[0m');
  const c = makeClient();
  await waitFor(c, 'connect');

  const pid = uuidv4();
  c.emit('create-room', 'Alice', pid);
  const room = await waitFor(c, 'room-created');

  assert(room.id && room.id.length === 6, `Room has 6-char ID: "${room.id}"`);
  assert(room.players.length === 1, 'Room has exactly 1 player');
  assert(room.players[0].name === 'Alice', 'Player name is Alice');
  assert(room.status === 'waiting', 'Room status is waiting');
  assert(room.players[0].cups.length === 10, 'Player has 10 cups');

  c.disconnect();
  return room.id;
}

// ─── Test 2: Two players start a game ─────────────────────────────────────────
async function testTwoPlayerGame() {
  console.log('\n\x1b[1mTest 2: Two-Player Game Start\x1b[0m');
  const c1 = makeClient();
  const c2 = makeClient();
  await Promise.all([waitFor(c1, 'connect'), waitFor(c2, 'connect')]);

  const pid1 = uuidv4();
  const pid2 = uuidv4();

  c1.emit('create-room', 'Player1', pid1);
  const room = await waitFor(c1, 'room-created');
  const roomId = room.id;

  c2.emit('join-room', roomId, 'Player2', pid2);
  const [started1, started2] = await Promise.all([
    waitFor(c1, 'game-started'),
    waitFor(c2, 'game-started'),
  ]);

  assert(started1.status === 'playing', 'Room status is playing (P1 view)');
  assert(started2.status === 'playing', 'Room status is playing (P2 view)');
  assert(started1.players.length === 2, 'Both players present');
  assert(started1.currentPlayerIndex === 0, 'Player 1 goes first');
  assert(started1.players[0].cups.length === 10, 'P1 has 10 cups');
  assert(started1.players[1].cups.length === 10, 'P2 has 10 cups');

  c1.disconnect();
  c2.disconnect();
  return { roomId, pid1, pid2 };
}

// ─── Test 3: Third player rejected ────────────────────────────────────────────
async function testThirdPlayerRejected() {
  console.log('\n\x1b[1mTest 3: Third Player Cannot Join Full Room\x1b[0m');
  const c1 = makeClient();
  const c2 = makeClient();
  const c3 = makeClient();
  await Promise.all([waitFor(c1, 'connect'), waitFor(c2, 'connect'), waitFor(c3, 'connect')]);

  c1.emit('create-room', 'P1', uuidv4());
  const room = await waitFor(c1, 'room-created');
  const roomId = room.id;

  c2.emit('join-room', roomId, 'P2', uuidv4());
  await waitFor(c2, 'game-started');

  // Third player tries to join
  c3.emit('join-room', roomId, 'P3', uuidv4());
  const result = await waitForAny(c3, ['game-started', 'error']);

  assert(result.event === 'error', 'Third player receives error');
  assert(result.data === 'Room is full.', `Error message is "Room is full." (got: "${result.data}")`);

  // Fourth player tries with a fake room code
  const c4 = makeClient();
  await waitFor(c4, 'connect');
  c4.emit('join-room', 'ZZZZZZ', 'P4', uuidv4());
  const r4 = await waitForAny(c4, ['game-started', 'error']);
  assert(r4.event === 'error', 'Player with bad code receives error');
  assert(r4.data.includes('not found'), `Error mentions "not found" (got: "${r4.data}")`);

  c1.disconnect(); c2.disconnect(); c3.disconnect(); c4.disconnect();
}

// ─── Test 4: Turn logic — 2 balls per turn, correct switching ─────────────────
async function testTurnLogic() {
  console.log('\n\x1b[1mTest 4: Turn Logic (2 balls, turn switching)\x1b[0m');
  const c1 = makeClient();
  const c2 = makeClient();
  await Promise.all([waitFor(c1, 'connect'), waitFor(c2, 'connect')]);

  const pid1 = uuidv4();
  c1.emit('create-room', 'Thrower', pid1);
  const room = await waitFor(c1, 'room-created');
  c2.emit('join-room', room.id, 'Receiver', uuidv4());
  const started = await waitFor(c1, 'game-started');
  const roomId = started.id;

  // Get opponent's first available cup
  const opponentCups = started.players[1].cups.filter(c => !c.removed);
  const cup0 = opponentCups[0].id;
  const cup1 = opponentCups[1].id;

  // Throw ball 1 (miss intentionally with high meter value)
  c1.emit('throw-ball', roomId, cup0, 99);
  const r1 = await waitFor(c1, 'throw-result');
  assert(r1.room.turnState.ballsThrown === 1, 'After ball 1: ballsThrown = 1');
  assert(r1.room.currentPlayerIndex === 0, 'Still P1 turn after first throw');

  // Throw ball 2
  c1.emit('throw-ball', roomId, cup1, 99);
  const r2 = await waitFor(c1, 'throw-result');
  assert(r2.room.turnState.ballsThrown === 0, 'After ball 2: ballsThrown resets to 0');
  assert(r2.room.currentPlayerIndex === 1, 'Turn switches to P2 after 2 throws');

  // P1 tries to throw on P2's turn — should get error
  let errorReceived = false;
  c1.once('error', () => { errorReceived = true; });
  c1.emit('throw-ball', roomId, cup0, 50);
  await sleep(500);
  assert(errorReceived, 'P1 cannot throw during P2 turn — gets error');

  c1.disconnect(); c2.disconnect();
}

// ─── Test 5: Bonus turn when both balls go in ─────────────────────────────────
async function testBonusTurn() {
  console.log('\n\x1b[1mTest 5: Bonus Turn (both balls sunk)\x1b[0m');

  // We force success by throwing at meterValue=1 repeatedly until we get 2 makes in a turn
  // Try up to 20 games to hit a bonus turn
  let bonusTurnSeen = false;

  for (let attempt = 0; attempt < 20 && !bonusTurnSeen; attempt++) {
    const c1 = makeClient();
    const c2 = makeClient();
    await Promise.all([waitFor(c1, 'connect'), waitFor(c2, 'connect')]);

    c1.emit('create-room', 'BonusTest', uuidv4());
    const room = await waitFor(c1, 'room-created');
    c2.emit('join-room', room.id, 'Opp', uuidv4());
    const started = await waitFor(c1, 'game-started');
    const roomId = started.id;
    const cups = started.players[1].cups;

    c1.emit('throw-ball', roomId, cups[0].id, 1); // near-perfect (95% chance)
    const r1 = await waitFor(c1, 'throw-result');

    if (r1.success) {
      c1.emit('throw-ball', roomId, cups[1].id, 1);
      const r2 = await waitFor(c1, 'throw-result');

      if (r2.success) {
        // Both made — should be bonus turn, still P1's turn
        assert(r2.room.currentPlayerIndex === 0, 'Bonus turn: still P1 after sinking both');
        assert(r2.room.turnState.bonusTurn === true, 'bonusTurn flag is true');
        assert(r2.room.turnState.ballsThrown === 0, 'Balls reset for bonus turn');
        bonusTurnSeen = true;
      }
    }

    c1.disconnect(); c2.disconnect();
  }

  if (!bonusTurnSeen) {
    assert(false, 'Could not trigger bonus turn in 20 attempts (probability issue?)');
  }
}

// ─── Test 6: Win condition ─────────────────────────────────────────────────────
async function testWinCondition() {
  console.log('\n\x1b[1mTest 6: Win Condition\x1b[0m');
  const c1 = makeClient();
  const c2 = makeClient();
  await Promise.all([waitFor(c1, 'connect'), waitFor(c2, 'connect')]);

  c1.emit('create-room', 'Winner', uuidv4());
  const room = await waitFor(c1, 'room-created');
  c2.emit('join-room', room.id, 'Loser', uuidv4());
  const started = await waitFor(c1, 'game-started');
  const roomId = started.id;

  // Manually drain all 10 of P2's cups by throwing with meterValue=1 until each sinks
  let currentRoom = started;
  let ballsInTurn = 0;

  while (true) {
    const remaining = currentRoom.players[1].cups.filter(c => !c.removed);
    if (remaining.length === 0) break;

    const cup = remaining[0];
    c1.emit('throw-ball', roomId, cup.id, 1);
    const result = await waitFor(c1, 'throw-result');
    currentRoom = result.room;
    ballsInTurn++;

    if (currentRoom.status === 'finished') break;

    // If turn ended (ballsThrown reset and still has cups), it's P2's turn — skip their balls
    if (currentRoom.currentPlayerIndex === 1 && currentRoom.turnState.ballsThrown === 0) {
      const p1cups = currentRoom.players[0].cups.filter(c => !c.removed);
      // P2 throws into a removed or nonexistent cup — just throw and let server handle
      if (p1cups.length > 0) {
        c2.emit('throw-ball', roomId, p1cups[0].id, 99);
        const pr1 = await waitFor(c2, 'throw-result');
        currentRoom = pr1.room;
        if (currentRoom.status === 'finished') break;
        if (currentRoom.currentPlayerIndex === 1) {
          c2.emit('throw-ball', roomId, p1cups[p1cups.length > 1 ? 1 : 0].id, 99);
          const pr2 = await waitFor(c2, 'throw-result');
          currentRoom = pr2.room;
          if (currentRoom.status === 'finished') break;
        }
      }
    }

    // Safety: bail after many rounds
    if (ballsInTurn > 200) break;
  }

  assert(currentRoom.status === 'finished', 'Game reaches finished status');
  assert(currentRoom.winner !== null, 'Winner is set');

  c1.disconnect(); c2.disconnect();
}

// ─── Test 7: Concurrent rooms don't interfere ─────────────────────────────────
async function testConcurrentRooms() {
  console.log('\n\x1b[1mTest 7: Concurrent Rooms Isolation\x1b[0m');
  const ROOM_COUNT = 5;
  const clients = [];
  const rooms = [];

  for (let i = 0; i < ROOM_COUNT * 2; i++) {
    const c = makeClient();
    await waitFor(c, 'connect');
    clients.push(c);
  }

  // Create ROOM_COUNT rooms — set up each listener before emitting to avoid race
  for (let i = 0; i < ROOM_COUNT; i++) {
    const p = waitFor(clients[i * 2], 'room-created');
    clients[i * 2].emit('create-room', `Host${i}`, uuidv4());
    const room = await p;
    rooms.push(room.id);
  }

  assert(new Set(rooms).size === ROOM_COUNT, `All ${ROOM_COUNT} rooms have unique IDs`);

  // Join all rooms simultaneously
  const joinPromises = [];
  for (let i = 0; i < ROOM_COUNT; i++) {
    clients[i * 2 + 1].emit('join-room', rooms[i], `Guest${i}`, uuidv4());
    joinPromises.push(waitFor(clients[i * 2], 'game-started'));
  }

  const startedRooms = await Promise.all(joinPromises);
  assert(startedRooms.every(r => r.status === 'playing'), `All ${ROOM_COUNT} rooms started independently`);

  // Throw in room 0, verify only room 0 sees the throw-result
  let wrongRoomGotEvent = false;
  for (let i = 1; i < ROOM_COUNT; i++) {
    clients[i * 2].once('throw-result', () => { wrongRoomGotEvent = true; });
  }

  const room0 = startedRooms[0];
  const cup = room0.players[1].cups[0];
  clients[0].emit('throw-ball', room0.id, cup.id, 50);
  await waitFor(clients[0], 'throw-result');
  await sleep(300);

  assert(!wrongRoomGotEvent, 'throw-result is isolated to the correct room');

  clients.forEach(c => c.disconnect());
}

// ─── Test 8: Rematch resets state ─────────────────────────────────────────────
async function testRematch() {
  console.log('\n\x1b[1mTest 8: Rematch Resets Game State\x1b[0m');
  const c1 = makeClient();
  const c2 = makeClient();
  await Promise.all([waitFor(c1, 'connect'), waitFor(c2, 'connect')]);

  c1.emit('create-room', 'A', uuidv4());
  const room = await waitFor(c1, 'room-created');
  c2.emit('join-room', room.id, 'B', uuidv4());
  const started = await waitFor(c1, 'game-started');
  const roomId = started.id;

  // Drain all P2 cups quickly
  let currentRoom = started;
  let bail = 0;
  while (currentRoom.status !== 'finished' && bail < 300) {
    const isP1Turn = currentRoom.currentPlayerIndex === 0;
    const client = isP1Turn ? c1 : c2;
    const targetPlayerIdx = isP1Turn ? 1 : 0;
    const cups = currentRoom.players[targetPlayerIdx].cups.filter(c => !c.removed);
    if (cups.length === 0) break;
    client.emit('throw-ball', roomId, cups[0].id, isP1Turn ? 1 : 99);
    const r = await waitFor(isP1Turn ? c1 : c2, 'throw-result');
    currentRoom = r.room;
    bail++;
  }

  if (currentRoom.status === 'finished') {
    c1.emit('rematch', roomId);
    const [r1, r2] = await Promise.all([waitFor(c1, 'game-started'), waitFor(c2, 'game-started')]);
    assert(r1.status === 'playing', 'Rematch: room back to playing');
    assert(r1.players[0].cups.length === 10, 'P1 cups reset to 10');
    assert(r1.players[1].cups.length === 10, 'P2 cups reset to 10');
    assert(r1.winner === null, 'Winner cleared');
    assert(r1.currentPlayerIndex === 0, 'P1 goes first again');
    assert(r2.status === 'playing', 'Both clients see rematch start');
  } else {
    console.log(`  ${INFO} Game didn't finish in bail limit — skipping rematch assertions`);
  }

  c1.disconnect(); c2.disconnect();
}

// ─── Test 9: Disconnect + grace period ────────────────────────────────────────
async function testDisconnectGrace() {
  console.log('\n\x1b[1mTest 9: Disconnect Grace Period\x1b[0m');
  const c1 = makeClient();
  const c2 = makeClient();
  await Promise.all([waitFor(c1, 'connect'), waitFor(c2, 'connect')]);

  c1.emit('create-room', 'Grace1', uuidv4());
  const room = await waitFor(c1, 'room-created');
  c2.emit('join-room', room.id, 'Grace2', uuidv4());
  await waitFor(c1, 'game-started');

  // Disconnect P1 suddenly
  let disconnectMsgReceived = false;
  c2.once('opponent-disconnected', () => { disconnectMsgReceived = true; });
  c1.disconnect();
  await sleep(1000);

  assert(disconnectMsgReceived, 'P2 receives opponent-disconnected event within 1s');
  console.log(`  ${INFO} Room should stay alive for 15s grace period`);

  // Reconnect P1 within grace period
  const c1b = makeClient();
  await waitFor(c1b, 'connect');

  let reconnectMsgReceived = false;
  c2.once('opponent-reconnected', () => { reconnectMsgReceived = true; });

  c1b.emit('get-room', room.id, room.players[0].id);
  const roomState = await waitForAny(c1b, ['room-state', 'error']);

  assert(roomState.event === 'room-state', 'Reconnected player gets room-state');
  await sleep(500);
  assert(reconnectMsgReceived, 'P2 receives opponent-reconnected event');

  c1b.disconnect(); c2.disconnect();
}

// ─── Run all tests ─────────────────────────────────────────────────────────────
async function run() {
  console.log('\x1b[1m\x1b[36m══════════════════════════════════\x1b[0m');
  console.log('\x1b[1m\x1b[36m  Cup Pong Stress Test Suite\x1b[0m');
  console.log('\x1b[1m\x1b[36m══════════════════════════════════\x1b[0m');

  try {
    await testRoomCreation();
    await testTwoPlayerGame();
    await testThirdPlayerRejected();
    await testTurnLogic();
    await testBonusTurn();
    await testWinCondition();
    await testConcurrentRooms();
    await testRematch();
    await testDisconnectGrace();
  } catch (e) {
    console.error(`\n${FAIL} Unexpected error: ${e.message}`);
    failed++;
  }

  const total = passed + failed;
  console.log('\n\x1b[1m──────────────────────────────────\x1b[0m');
  console.log(`\x1b[1mResults: ${passed}/${total} passed\x1b[0m`);
  if (failed > 0) {
    console.log(`\x1b[31m${failed} assertion(s) failed\x1b[0m`);
  } else {
    console.log('\x1b[32mAll tests passed!\x1b[0m');
  }
  console.log('');
  process.exit(failed > 0 ? 1 : 0);
}

run();
