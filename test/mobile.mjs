/**
 * Mobile Responsiveness + Cup Scaling Stress Test
 * Tests layout math, cup pool growth, and screen-fit guarantees
 * across every player count and a broad matrix of real device sizes.
 * No server or socket connection needed — all offline math.
 */

// ── Mirror ThrowMechanic + server.js constants exactly ────────────────────────
const BASE_CUP_W   = 46;
const BASE_CUP_H   = 55;
const BASE_CUP_GAP = 13;
const FAR_SCALE    = 0.62;
const CUP_AREA_PAD = 18;
const THROW_ZONE_H = 170;
const BALL_D       = 40;
const MAX_PLAYERS  = 8;

// Chrome heights (header + scores bar + game log)
const HEADER_H   = 38;
const SCORES_H   = 42;
const GAME_LOG_H = 96;  // h-24
const CHROME_H   = HEADER_H + SCORES_H + GAME_LOG_H;

// ── Helpers ───────────────────────────────────────────────────────────────────
const PASS = '\x1b[32m✓\x1b[0m';
const FAIL = '\x1b[31m✗\x1b[0m';
const INFO = '\x1b[34m·\x1b[0m';

let passed = 0, failed = 0;

function assert(cond, label, detail = '') {
  if (cond) { console.log(`  ${PASS} ${label}${detail ? ' — ' + detail : ''}`); passed++; }
  else       { console.log(`  ${FAIL} ${label}${detail ? ' — ' + detail : ''}`); failed++; }
}
function section(t) { console.log(`\n\x1b[1m${t}\x1b[0m`); }

// ── Mirror server.js: createSharedCups ────────────────────────────────────────
function createSharedCups(numPlayers) {
  const baseCount = Math.max(4, numPlayers + 2);
  const cups = [];
  let id = 0;
  for (let row = 0; row < baseCount; row++) {
    const cupsInRow = baseCount - row;
    for (let col = 0; col < cupsInRow; col++) {
      cups.push({ id: id++, row, col, removed: false });
    }
  }
  return cups;
}

// ── Mirror ThrowMechanic layout math ──────────────────────────────────────────
function rowScale(row, numRows) {
  return FAR_SCALE + (1 - FAR_SCALE) * (row / Math.max(1, numRows - 1));
}

/**
 * Mirrors ThrowMechanic's layoutScale useMemo exactly.
 * componentH = measured component height (screen height minus chrome bars).
 */
function computeLayoutScale(screenW, componentH, numRows) {
  let fullH = 0;
  for (let r = 0; r < numRows; r++) {
    const sc = rowScale(r, numRows);
    fullH += (BASE_CUP_H + BASE_CUP_GAP) * sc;
  }
  const availH  = componentH - THROW_ZONE_H - CUP_AREA_PAD;
  const scaleH  = availH / fullH;

  const topN  = numRows;
  const topSc = FAR_SCALE;
  const fullW = topN * BASE_CUP_W * topSc + (topN - 1) * BASE_CUP_GAP * topSc;
  const scaleW = screenW / fullW;

  return Math.min(1.0, scaleH, scaleW);
}

// Convenience: derive component height from raw screen height
function throwMechH(screenH) { return screenH - CHROME_H; }

// screenH here = full device screen height; function derives componentH internally
function buildLayout(cups, screenW, screenH) {
  if (cups.length === 0) return { map: new Map(), numRows: 0, layoutScale: 1 };
  const numRows    = Math.max(...cups.map(c => c.row)) + 1;
  const compH      = throwMechH(screenH);
  const ls         = computeLayoutScale(screenW, compH, numRows);
  const map        = new Map();
  let y = CUP_AREA_PAD;

  for (let row = 0; row < numRows; row++) {
    const sc  = rowScale(row, numRows);
    const cw  = BASE_CUP_W  * sc * ls;
    const ch  = BASE_CUP_H  * sc * ls;
    const gap = BASE_CUP_GAP * sc * ls;
    const rowCups = cups.filter(c => c.row === row);
    const totalW  = rowCups.length * cw + (rowCups.length - 1) * gap;
    const startX  = (screenW - totalW) / 2;
    rowCups.forEach(cup => {
      map.set(cup.id, { x: startX + cup.col * (cw + gap), y, w: cw, h: ch });
    });
    y += ch + gap;
  }
  return { map, numRows, layoutScale: ls };
}

// Real device profiles [name, cssW, cssH]
const DEVICES = [
  ['iPhone SE 1st gen',    320, 568],
  ['iPhone SE 2nd/3rd',    375, 667],
  ['iPhone 12 mini',       360, 780],
  ['iPhone 12/13/14',      390, 844],
  ['iPhone 15 Pro Max',    430, 932],
  ['Samsung Galaxy S22',   360, 780],
  ['Pixel 7',              412, 915],
  ['iPad mini (portrait)', 768, 1024],
];

const PLAYER_COUNTS = [2, 3, 4, 5, 6, 7, 8];

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 1: Server-side cup count formula
// ═══════════════════════════════════════════════════════════════════════════════
section('Test 1: Server — Cup Count Formula (N players → triangle pool)');
{
  const expected = { 2:10, 3:15, 4:21, 5:28, 6:36, 7:45, 8:55 };
  for (const [n, exp] of Object.entries(expected)) {
    const cups = createSharedCups(Number(n));
    assert(cups.length === exp, `${n} players → ${exp} cups`, `got ${cups.length}`);
  }
  // Formula: baseCount = n+2, total = baseCount*(baseCount+1)/2
  for (const n of PLAYER_COUNTS) {
    const base  = Math.max(4, n + 2);
    const formula = base * (base + 1) / 2;
    const actual  = createSharedCups(n).length;
    assert(actual === formula, `Formula matches server for ${n}p`, `${formula} cups`);
  }
  // Cup count strictly increases with each player added
  let prev = 0;
  for (const n of PLAYER_COUNTS) {
    const count = createSharedCups(n).length;
    assert(count > prev, `${n}p (${count} cups) > ${n-1}p (${prev} cups)`, '');
    prev = count;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 2: Server — Cup structure integrity (IDs, rows, cols)
// ═══════════════════════════════════════════════════════════════════════════════
section('Test 2: Server — Cup Triangle Structure Integrity');
{
  for (const n of PLAYER_COUNTS) {
    const cups = createSharedCups(n);
    const numRows = Math.max(4, n + 2);

    // All IDs unique and sequential
    const ids = cups.map(c => c.id);
    assert(new Set(ids).size === ids.length, `${n}p: all cup IDs unique`, `${ids.length} cups`);
    assert(ids[0] === 0 && ids[ids.length-1] === ids.length-1,
      `${n}p: IDs 0..${ids.length-1} sequential`);

    // Correct number of cups per row (triangle shape)
    for (let row = 0; row < numRows; row++) {
      const inRow    = cups.filter(c => c.row === row).length;
      const expected = numRows - row;  // row 0 widest
      assert(inRow === expected, `${n}p row${row}: ${expected} cups`, `got ${inRow}`);
    }

    // Columns are 0-indexed within each row
    for (let row = 0; row < numRows; row++) {
      const cols = cups.filter(c => c.row === row).map(c => c.col).sort((a,b) => a-b);
      const validCols = cols.every((col, i) => col === i);
      assert(validCols, `${n}p row${row}: cols 0..${cols.length-1}`, `[${cols}]`);
    }

    // All cups start not removed
    assert(cups.every(c => !c.removed), `${n}p: all cups start intact`);

    // Row count matches numRows-1 (0-indexed max)
    const maxRow = Math.max(...cups.map(c => c.row));
    assert(maxRow === numRows - 1, `${n}p: max row = ${numRows-1}`, `got ${maxRow}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 3: Client layout scale — every device × every player count fits
// ═══════════════════════════════════════════════════════════════════════════════
section('Test 3: Layout Scale — All Cups Fit on Every Device × Player Count');
{
  console.log(`\n  ${'Device'.padEnd(22)} ${'2P'.padEnd(6)} ${'3P'.padEnd(6)} ${'4P'.padEnd(6)} ${'5P'.padEnd(6)} ${'6P'.padEnd(6)} ${'7P'.padEnd(6)} ${'8P'}`);
  console.log(`  ${'─'.repeat(22)} ${'─'.repeat(6)} ${'─'.repeat(6)} ${'─'.repeat(6)} ${'─'.repeat(6)} ${'─'.repeat(6)} ${'─'.repeat(6)} ${'─'.repeat(6)}`);

  for (const [name, w, h] of DEVICES) {
    const compH     = throwMechH(h);
    const availCupH = compH - THROW_ZONE_H;
    const scales = PLAYER_COUNTS.map(n => {
      const cups    = createSharedCups(n);
      const numRows = Math.max(...cups.map(c => c.row)) + 1;
      return computeLayoutScale(w, compH, numRows);
    });
    const row = [name.padEnd(22), ...scales.map(s => (s.toFixed(2)+'×').padEnd(6))].join(' ');
    console.log(`  ${row}`);

    for (let i = 0; i < PLAYER_COUNTS.length; i++) {
      const n      = PLAYER_COUNTS[i];
      const cups   = createSharedCups(n);
      const { map, layoutScale: ls } = buildLayout(cups, w, h);

      // All cups within horizontal bounds [0, screenW]
      let hOk = true, vOk = true;
      for (const [, l] of map) {
        if (l.x < -0.5 || l.x + l.w > w + 0.5) hOk = false;
        if (l.y + l.h > availCupH + 0.5) vOk = false;
      }
      assert(hOk, `${n}p on ${w}px wide: no horizontal overflow`);
      assert(vOk, `${n}p on ${name} (${h}px): no vertical overflow`);
      assert(ls > 0.1, `${n}p on ${name}: layoutScale not too small (>${0.1})`, `${ls.toFixed(3)}`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 4: Minimum cup sizes — always legible
// ═══════════════════════════════════════════════════════════════════════════════
section('Test 4: Minimum Cup Size — Cups Never Shrink Below Legible Threshold');
{
  const MIN_CUP_PX = 8; // absolute minimum legible cup width in pixels
  for (const [name, w, h] of DEVICES) {
    for (const n of PLAYER_COUNTS) {
      const cups = createSharedCups(n);
      const numRows = Math.max(...cups.map(c => c.row)) + 1;
      const ls = computeLayoutScale(w, h, numRows);
      // Farthest cup (smallest)
      const farSc  = FAR_SCALE;
      const farCupW = BASE_CUP_W * farSc * ls;
      assert(farCupW >= MIN_CUP_PX,
        `${n}p far cup on ${name}: ≥${MIN_CUP_PX}px wide`,
        `${farCupW.toFixed(1)}px`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 5: Ball position — always inside throw zone
// ═══════════════════════════════════════════════════════════════════════════════
section('Test 5: Ball Position — Always Inside Throw Zone');
{
  for (const [name, w, h] of DEVICES) {
    const compH        = throwMechH(h);
    const ballX        = w / 2;
    const ballY        = compH - THROW_ZONE_H / 2;
    const throwZoneTop = compH - THROW_ZONE_H;

    assert(ballY > throwZoneTop, `${name}: ball Y above throw zone top`, `ballY=${ballY.toFixed(0)}, zoneTop=${throwZoneTop.toFixed(0)}`);
    assert(ballY < compH,        `${name}: ball Y below screen bottom`, `ballY=${ballY.toFixed(0)}`);
    assert(ballX > 0 && ballX < w, `${name}: ball X within screen width`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 6: All cups above the throw zone (no cup/ball overlap)
// ═══════════════════════════════════════════════════════════════════════════════
section('Test 6: No Cup/Ball Zone Overlap on Any Device');
{
  for (const [name, w, h] of DEVICES) {
    const compH        = throwMechH(h);
    const throwZoneTop = compH - THROW_ZONE_H;

    for (const n of PLAYER_COUNTS) {
      const cups = createSharedCups(n);
      const { map } = buildLayout(cups, w, h);
      let overlap = false;
      for (const [, l] of map) {
        if (l.y + l.h > throwZoneTop) { overlap = true; break; }
      }
      assert(!overlap, `${n}p on ${name}: all cups above throw zone divider`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 7: Horizontal centering — symmetric layout
// ═══════════════════════════════════════════════════════════════════════════════
section('Test 7: Horizontal Centering — Layout is Symmetric per Row');
{
  for (const n of PLAYER_COUNTS) {
    const cups    = createSharedCups(n);
    const numRows = Math.max(...cups.map(c => c.row)) + 1;
    const { map } = buildLayout(cups, 375, 667);

    for (let row = 0; row < numRows; row++) {
      const rowCups = cups.filter(c => c.row === row);
      const layouts = rowCups.map(c => map.get(c.id));
      const leftEdge  = Math.min(...layouts.map(l => l.x));
      const rightEdge = Math.max(...layouts.map(l => l.x + l.w));
      const center    = (leftEdge + rightEdge) / 2;
      const diff      = Math.abs(center - 375 / 2);
      assert(diff < 1, `${n}p row${row}: centered within 1px`, `center=${center.toFixed(1)}, mid=${(375/2).toFixed(1)}`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 8: Perspective scaling — far rows always smaller than close rows
// ═══════════════════════════════════════════════════════════════════════════════
section('Test 8: Perspective — Far Cups Always Smaller Than Close Cups');
{
  for (const n of PLAYER_COUNTS) {
    const cups    = createSharedCups(n);
    const { map } = buildLayout(cups, 375, 667);
    const numRows = Math.max(...cups.map(c => c.row)) + 1;

    for (let row = 0; row < numRows - 1; row++) {
      const thisRow = cups.filter(c => c.row === row && c.col === 0);
      const nextRow = cups.filter(c => c.row === row + 1 && c.col === 0);
      if (!thisRow.length || !nextRow.length) continue;
      const thisW = map.get(thisRow[0].id).w;
      const nextW = map.get(nextRow[0].id).w;
      assert(thisW < nextW, `${n}p: row${row} cups smaller than row${row+1}`,
        `${thisW.toFixed(1)}px < ${nextW.toFixed(1)}px`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 9: Cup/layout count agreement — server vs client
// ═══════════════════════════════════════════════════════════════════════════════
section('Test 9: Server-Client Agreement — Same Cup Count and Structure');
{
  for (const n of PLAYER_COUNTS) {
    const serverCups = createSharedCups(n);       // server creates
    const { map }    = buildLayout(serverCups, 390, 844); // client lays out

    assert(map.size === serverCups.length,
      `${n}p: client lays out all ${serverCups.length} server cups`,
      `map.size=${map.size}`);

    // Every server cup ID has a layout entry
    const allMapped = serverCups.every(c => map.has(c.id));
    assert(allMapped, `${n}p: every cup ID has a layout position`);

    // No layout entry for IDs that don't exist
    assert(map.size === serverCups.length, `${n}p: no phantom layout entries`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 10: Stress matrix — all devices × all player counts (summary)
// ═══════════════════════════════════════════════════════════════════════════════
section('Test 10: Stress Matrix — 8 Devices × 7 Player Counts (56 scenarios)');
{
  let scenarios = 0, scenariosFailed = 0;
  const errors = [];

  for (const [name, w, h] of DEVICES) {
    const compH = throwMechH(h);
    for (const n of PLAYER_COUNTS) {
      scenarios++;
      const cups    = createSharedCups(n);
      const { map, layoutScale: ls } = buildLayout(cups, w, h);
      const throwZoneTop = compH - THROW_ZONE_H;

      let ok = true;
      const issues = [];

      // 1. Every cup has a layout
      if (map.size !== cups.length) { ok = false; issues.push(`map.size=${map.size}≠${cups.length}`); }

      // 2. No horizontal overflow
      for (const [, l] of map) {
        if (l.x < -0.5 || l.x + l.w > w + 0.5) { ok = false; issues.push('hOverflow'); break; }
      }

      // 3. No vertical overflow into throw zone
      for (const [, l] of map) {
        if (l.y + l.h > throwZoneTop + 0.5) { ok = false; issues.push('vOverflow'); break; }
      }

      // 4. layoutScale positive
      if (ls <= 0) { ok = false; issues.push('ls≤0'); }

      // 5. Far cup visible (not zero size)
      const farSc  = FAR_SCALE;
      const farW   = BASE_CUP_W * farSc * ls;
      if (farW < 4) { ok = false; issues.push(`farCup=${farW.toFixed(1)}px<4px`); }

      if (!ok) { scenariosFailed++; errors.push(`${name} ${n}p: ${issues.join(', ')}`); }
    }
  }

  assert(scenariosFailed === 0,
    `All ${scenarios} scenarios pass (${DEVICES.length} devices × ${PLAYER_COUNTS.length} player counts)`,
    scenariosFailed > 0 ? `${scenariosFailed} failed: ${errors.join(' | ')}` : '');

  if (errors.length) {
    for (const e of errors) console.log(`    ${FAIL} ${e}`);
  }

  // Summary table
  console.log(`\n  ${'Players →'.padEnd(14)} ${PLAYER_COUNTS.map(n => String(n+'P').padEnd(6)).join('')}`);
  console.log(`  ${'Cups →'.padEnd(14)} ${PLAYER_COUNTS.map(n => String(createSharedCups(n).length).padEnd(6)).join('')}`);
  console.log(`  ${'─'.repeat(14 + PLAYER_COUNTS.length * 6)}`);
  for (const [name, w, h] of DEVICES) {
    const compH = throwMechH(h);
    const scales = PLAYER_COUNTS.map(n => {
      const cups = createSharedCups(n);
      const numRows = Math.max(...cups.map(c => c.row)) + 1;
      return computeLayoutScale(w, compH, numRows);
    });
    const fits = scales.map(s => (s >= 0.99 ? ' 1.0× ' : s.toFixed(2)+'×').padEnd(6));
    console.log(`  ${name.padEnd(14)} ${fits.join('')}`);
  }
  console.log(`\n  (1.0× = full size, <1.0 = auto-shrunk to fit)`);
}

// ─── Summary ──────────────────────────────────────────────────────────────────
const total = passed + failed;
console.log('\n\x1b[1m──────────────────────────────────────────────\x1b[0m');
console.log(`\x1b[1mMobile + Cup Scaling Tests: ${passed}/${total} passed\x1b[0m`);
if (failed > 0) {
  console.log(`\x1b[31m${failed} failed\x1b[0m`);
  process.exit(1);
} else {
  console.log('\x1b[32mAll tests passed!\x1b[0m');
}
console.log('');
