/**
 * Accuracy & Aiming Tuning Simulation
 * Mirrors ThrowMechanic math exactly — no server/socket needed.
 * Runs entirely offline; validates aim difficulty, cup sizing, hit distributions.
 */

// ── Mirror ThrowMechanic constants ─────────────────────────────────────────────
const BASE_CUP_W   = 46;
const BASE_CUP_H   = 55;
const BASE_CUP_GAP = 13;
const FAR_SCALE    = 0.62;
const CUP_AREA_PAD = 18;

// Simulated screen (375×667 — iPhone SE / typical mobile)
const CONTAINER_W  = 375;
const CONTAINER_H  = 580;
const THROW_ZONE_H = 170;
const BALL_X       = CONTAINER_W / 2;
const BALL_Y       = CONTAINER_H - THROW_ZONE_H / 2;

const PASS = '\x1b[32m✓\x1b[0m';
const FAIL = '\x1b[31m✗\x1b[0m';
const WARN = '\x1b[33m⚠\x1b[0m';
const INFO = '\x1b[34m·\x1b[0m';

let passed = 0, failed = 0, warns = 0;

function assert(cond, label, detail = '') {
  if (cond) { console.log(`  ${PASS} ${label}${detail ? ' — ' + detail : ''}`); passed++; }
  else       { console.log(`  ${FAIL} ${label}${detail ? ' — ' + detail : ''}`); failed++; }
}
function warn(label) { console.log(`  ${WARN} ${label}`); warns++; }

// ── Geometry helpers (same as ThrowMechanic) ──────────────────────────────────
function rowScale(row, numRows) {
  return FAR_SCALE + (1 - FAR_SCALE) * (row / Math.max(1, numRows - 1));
}

function buildLayout(numPlayers) {
  const numRows = numPlayers + 2;
  const cups = [];
  let y = CUP_AREA_PAD;
  let id = 0;
  for (let row = 0; row < numRows; row++) {
    const sc  = rowScale(row, numRows);
    const cw  = BASE_CUP_W * sc;
    const ch  = BASE_CUP_H * sc;
    const gap = BASE_CUP_GAP * sc;
    const n   = numRows - row;
    const totalW = n * cw + (n - 1) * gap;
    const startX = (CONTAINER_W - totalW) / 2;
    for (let col = 0; col < n; col++) {
      cups.push({
        id: id++, row, col,
        cx: startX + col * (cw + gap) + cw / 2,
        cy: y + ch / 2,
        w: cw, h: ch, sc,
      });
    }
    y += ch + gap;
  }
  return { cups, numRows };
}

// ── Accuracy curve implementations ─────────────────────────────────────────────
/** CURRENT (v1): single linear falloff — very forgiving */
function accuracyCurrent(perpDist, cupW, sc) {
  const hitZone = cupW * sc * 2.5;                // ≈100 px at closest row
  return Math.max(0, 1 - perpDist / hitZone);
}

/** PROPOSED (v2): tiered zones — must aim through the rim opening */
function accuracyProposed(perpDist, cupW, sc) {
  const cw    = cupW * sc;
  const rimR  = cw * 0.30;  // ~rim opening radius
  const bodyR = cw * 0.52;  // cup body edge (for glancing shots)
  const nearR = cw * 0.80;  // near-miss boundary

  if (perpDist <= rimR) {
    // Clean shot through the opening: 82–100%
    return 0.82 + (1 - perpDist / rimR) * 0.18;
  } else if (perpDist <= bodyR) {
    // Glancing the rim: 20–82%
    const t = (perpDist - rimR) / (bodyR - rimR);
    return 0.82 - Math.pow(t, 0.65) * 0.62;
  } else if (perpDist <= nearR) {
    // Near miss: 1–20%
    const t = (perpDist - bodyR) / (nearR - bodyR);
    return 0.20 - t * 0.19;
  }
  return 0;
}

/** Server hit probability (same in server.js) */
function hitChance(accuracy) {
  return 0.05 + Math.min(0.90, Math.max(0, accuracy) * 0.90);
}

/** Simulate N throws at given accuracy → return actual hit rate */
function simulate(accuracy, n = 8000) {
  const p = hitChance(accuracy);
  let hits = 0;
  for (let i = 0; i < n; i++) if (Math.random() < p) hits++;
  return hits / n;
}

/** Compute perpendicular distance from (ballX,ballY) swipe at angle θ to cup */
function perpToAngle(cup, angleDeg) {
  const rad = (angleDeg * Math.PI) / 180;
  const dir = { x: Math.cos(rad), y: Math.sin(rad) };
  const vx = cup.cx - BALL_X, vy = cup.cy - BALL_Y;
  const t = vx * dir.x + vy * dir.y;
  if (t <= 0) return Infinity;
  return Math.abs(vx * dir.y - vy * dir.x);
}

/** Angle from ball to cup center */
function angleToCup(cup) {
  return Math.atan2(cup.cy - BALL_Y, cup.cx - BALL_X) * 180 / Math.PI;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST SUITE
// ═══════════════════════════════════════════════════════════════════════════════

function section(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

// ── 1. Cup sizing & perspective layout ────────────────────────────────────────
section('Test 1: Cup Sizing & Perspective Layout (2-player, 10 cups)');
{
  const { cups, numRows } = buildLayout(2);
  assert(cups.length === 10, '2-player → 10 cups total');
  assert(numRows === 4, '2-player → 4 rows');

  const far   = cups.filter(c => c.row === 0);
  const close = cups.filter(c => c.row === numRows - 1);

  console.log(`  ${INFO} Far row (row 0):   ${far.length} cups, W=${far[0].w.toFixed(1)}px, scale=${far[0].sc.toFixed(2)}`);
  console.log(`  ${INFO} Close row (row 3): ${close.length} cup,  W=${close[0].w.toFixed(1)}px, scale=${close[0].sc.toFixed(2)}`);

  assert(Math.abs(far[0].sc - FAR_SCALE) < 0.01, `Far row scale = ${FAR_SCALE}`, `got ${far[0].sc.toFixed(3)}`);
  assert(Math.abs(close[0].sc - 1.0) < 0.01,    'Close row scale = 1.0',         `got ${close[0].sc.toFixed(3)}`);
  assert(close[0].w > far[0].w, 'Close cups wider than far cups (perspective)');

  // All cups must fit within container width
  for (const cup of cups) {
    const inBounds = (cup.cx - cup.w / 2) >= 0 && (cup.cx + cup.w / 2) <= CONTAINER_W;
    assert(inBounds, `Cup ${cup.id} (row${cup.row},col${cup.col}) fits within ${CONTAINER_W}px`,
      `x=[${(cup.cx - cup.w/2).toFixed(0)},${(cup.cx + cup.w/2).toFixed(0)}]`);
  }

  // All cups must be above the throw zone
  assert(cups.every(c => c.cy < CONTAINER_H - THROW_ZONE_H),
    'All cups above throw zone divider');
}

// ── 2. Layout for 3 and 4 players ─────────────────────────────────────────────
section('Test 2: Multi-Player Cup Layout Sizing');
for (const n of [3, 4, 6, 8]) {
  const { cups } = buildLayout(n);
  const expectedTotal = (() => { const b = n + 2; return b * (b + 1) / 2; })();
  assert(cups.length === expectedTotal, `${n} players → ${expectedTotal} cups`, `got ${cups.length}`);

  const widest = cups.filter(c => c.row === 0);
  const allFit = cups.every(c => (c.cx - c.w/2) >= 0 && (c.cx + c.w/2) <= CONTAINER_W);
  assert(allFit, `${n}-player layout fits in ${CONTAINER_W}px width`,
    `far row: ${widest.length} cups × ${widest[0].w.toFixed(1)}px`);
}

// ── 3. Swipe angle → perpendicular distance accuracy ─────────────────────────
section('Test 3: Swipe Angle → Perpendicular Distance (perfect aim = 0 px off)');
{
  const { cups } = buildLayout(2);

  for (const cup of [cups[0], cups[4], cups[9]]) { // far, mid, close
    const idealAngle = angleToCup(cup);
    const perp0 = perpToAngle(cup, idealAngle);

    console.log(`  ${INFO} Cup ${cup.id} (row${cup.row}): center at (${cup.cx.toFixed(0)},${cup.cy.toFixed(0)}), W=${cup.w.toFixed(1)}px`);
    console.log(`       ideal angle=${idealAngle.toFixed(2)}°, perp@ideal=${perp0.toFixed(3)}px`);

    assert(perp0 < 0.5, `Perfect aim → perp < 0.5px`, `got ${perp0.toFixed(3)}px`);

    // 1-degree off
    const perp1deg = perpToAngle(cup, idealAngle + 1);
    const dist = Math.hypot(cup.cx - BALL_X, cup.cy - BALL_Y);
    const expected1deg = dist * Math.tan(Math.PI / 180);
    console.log(`       1° off: perp=${perp1deg.toFixed(1)}px (expected≈${expected1deg.toFixed(1)}px)`);
    assert(Math.abs(perp1deg - expected1deg) / expected1deg < 0.05,
      '1° offset → perp matches trigonometry', `${perp1deg.toFixed(1)}px vs ${expected1deg.toFixed(1)}px`);
  }
}

// ── 4. Current accuracy curve analysis ───────────────────────────────────────
section('Test 4: Current Accuracy Curve — How Forgiving Is It?');
{
  const { cups } = buildLayout(2);
  const cup0 = cups[0]; // farthest (hardest)
  const cup9 = cups[9]; // closest (easiest)

  console.log('\n  \x1b[90m[Current formula: hitZone = CUP_W * sc * 2.5]\x1b[0m');
  for (const cup of [cup0, cup9]) {
    const label = cup.row === 0 ? 'FAR cup (row 0)' : 'CLOSE cup (row 3)';
    const cw = cup.w;
    const sc = cup.sc;
    const hitZone = BASE_CUP_W * sc * 2.5;
    const rimR = cw * 0.35;
    
    const accPerfect   = accuracyCurrent(0, BASE_CUP_W, sc);
    const accAtRim     = accuracyCurrent(rimR, BASE_CUP_W, sc);
    const accAt1Width  = accuracyCurrent(cw, BASE_CUP_W, sc);
    const accAt2Width  = accuracyCurrent(cw * 2, BASE_CUP_W, sc);

    console.log(`\n  ${INFO} ${label}: W=${cw.toFixed(1)}px, hitZone=${hitZone.toFixed(1)}px`);
    console.log(`       perfect aim:  acc=${accPerfect.toFixed(2)} → ${(hitChance(accPerfect)*100).toFixed(0)}% hit`);
    console.log(`       at rim edge:  acc=${accAtRim.toFixed(2)} → ${(hitChance(accAtRim)*100).toFixed(0)}% hit`);
    console.log(`       1 cup-width off: acc=${accAt1Width.toFixed(2)} → ${(hitChance(accAt1Width)*100).toFixed(0)}% hit`);
    console.log(`       2 cup-widths off: acc=${accAt2Width.toFixed(2)} → ${(hitChance(accAt2Width)*100).toFixed(0)}% hit`);

    warn(`${label}: still ${(hitChance(accAt1Width)*100).toFixed(0)}% hit chance when 1 full cup-width off-center — too forgiving`);
  }
}

// ── 5. Proposed accuracy curve analysis ──────────────────────────────────────
section('Test 5: Proposed Accuracy Curve — Aim Through the Rim');
{
  const { cups } = buildLayout(2);

  console.log('\n  \x1b[90m[Proposed: tiered zones — rim/body/near-miss]\x1b[0m');
  for (const cup of [cups[0], cups[9]]) {
    const label = cup.row === 0 ? 'FAR cup (row 0)' : 'CLOSE cup (row 3)';
    const cw = cup.w;
    const sc = cup.sc;
    const rimR  = cw * 0.30;
    const bodyR = cw * 0.52;
    const nearR = cw * 0.80;

    const accPerfect   = accuracyProposed(0, BASE_CUP_W, sc);
    const accAtRimEdge = accuracyProposed(rimR, BASE_CUP_W, sc);
    const accAtBody    = accuracyProposed(bodyR, BASE_CUP_W, sc);
    const accAtNear    = accuracyProposed(nearR, BASE_CUP_W, sc);
    const accMiss      = accuracyProposed(cw, BASE_CUP_W, sc);

    console.log(`\n  ${INFO} ${label}: W=${cw.toFixed(1)}px`);
    console.log(`       Zones: rim<${rimR.toFixed(1)}px | body<${bodyR.toFixed(1)}px | near<${nearR.toFixed(1)}px`);
    console.log(`       perfect (0px):    acc=${accPerfect.toFixed(2)} → ${(hitChance(accPerfect)*100).toFixed(0)}% hit`);
    console.log(`       rim edge (${rimR.toFixed(0)}px):  acc=${accAtRimEdge.toFixed(2)} → ${(hitChance(accAtRimEdge)*100).toFixed(0)}% hit`);
    console.log(`       cup body (${bodyR.toFixed(0)}px):  acc=${accAtBody.toFixed(2)} → ${(hitChance(accAtBody)*100).toFixed(0)}% hit`);
    console.log(`       near miss (${nearR.toFixed(0)}px): acc=${accAtNear.toFixed(2)} → ${(hitChance(accAtNear)*100).toFixed(0)}% hit`);
    console.log(`       1 cup-width (${cw.toFixed(0)}px): acc=${accMiss.toFixed(2)} → ${(hitChance(accMiss)*100).toFixed(0)}% hit`);

    assert(hitChance(accPerfect)  > 0.88, 'Perfect aim → >88% hit', `${(hitChance(accPerfect)*100).toFixed(0)}%`);
    assert(hitChance(accAtBody)   < 0.50, 'Glancing body → <50% hit', `${(hitChance(accAtBody)*100).toFixed(0)}%`);
    assert(hitChance(accMiss)     < 0.15, '1 width off → <15% hit', `${(hitChance(accMiss)*100).toFixed(0)}%`);
  }
}

// ── 6. Hit-rate distribution simulation (8000 throws each) ───────────────────
section('Test 6: Hit Rate Monte-Carlo Simulation (8000 throws per accuracy level)');
{
  console.log('  \x1b[90m[Both curves, 8000 throws per level, 2-player layout]\x1b[0m\n');
  const { cups } = buildLayout(2);
  const cup = cups[9]; // closest cup

  const offsets = [0, 4, 8, 12, 16, 24, 32];
  console.log('  Offset(px) | Current hit% | Proposed hit%');
  console.log('  -----------|--------------|---------------');

  for (const off of offsets) {
    const accCur  = accuracyCurrent(off, BASE_CUP_W, cup.sc);
    const accProp = accuracyProposed(off, BASE_CUP_W, cup.sc);
    const hitCur  = simulate(accCur,  8000);
    const hitProp = simulate(accProp, 8000);
    const flag = off === 0 ? ' ← perfect' : off <= cup.w * 0.30 ? ' ← in rim' : off <= cup.w * 0.52 ? ' ← on body' : off <= cup.w ? ' ← near miss' : '           ';
    console.log(`  ${String(off).padStart(7)}px  |   ${(hitCur*100).toFixed(1).padStart(5)}%    |   ${(hitProp*100).toFixed(1).padStart(5)}%${flag}`);
  }

  // Assertions on proposed curve
  const hitPerfect = simulate(accuracyProposed(0, BASE_CUP_W, 1.0), 8000);
  const hitRimEdge = simulate(accuracyProposed(cup.w * 0.30, BASE_CUP_W, 1.0), 8000);
  const hitBody    = simulate(accuracyProposed(cup.w * 0.52, BASE_CUP_W, 1.0), 8000);
  const hitWide    = simulate(accuracyProposed(cup.w, BASE_CUP_W, 1.0), 8000);

  assert(hitPerfect > 0.87, 'Perfect aim → >87% actual hit rate', `${(hitPerfect*100).toFixed(1)}%`);
  assert(hitRimEdge > 0.50, 'Rim edge → >50% hit rate', `${(hitRimEdge*100).toFixed(1)}%`);
  assert(hitBody    < 0.45, 'Cup body → <45% hit rate', `${(hitBody*100).toFixed(1)}%`);
  assert(hitWide    < 0.15, '1 width off → <15% hit rate', `${(hitWide*100).toFixed(1)}%`);
}

// ── 7. Difficulty gradient: far vs close cups ─────────────────────────────────
section('Test 7: Difficulty Gradient — Far Cup (small) vs Close Cup (large)');
{
  const { cups } = buildLayout(2);
  const farCup   = cups[0]; // row 0, smallest
  const closeCup = cups[9]; // row 3, largest

  console.log(`\n  ${INFO} FAR cup:   W=${farCup.w.toFixed(1)}px, rim opening ≈${(farCup.w*0.30).toFixed(1)}px`);
  console.log(`  ${INFO} CLOSE cup: W=${closeCup.w.toFixed(1)}px, rim opening ≈${(closeCup.w*0.30).toFixed(1)}px`);

  // At what angular precision do you hit the rim?
  const farDist   = Math.hypot(farCup.cx - BALL_X, farCup.cy - BALL_Y);
  const closeDist = Math.hypot(closeCup.cx - BALL_X, closeCup.cy - BALL_Y);

  const rimRFar   = farCup.w * 0.30;
  const rimRClose = closeCup.w * 0.30;

  const angFar   = Math.atan(rimRFar / farDist)   * 180 / Math.PI;
  const angClose = Math.atan(rimRClose / closeDist) * 180 / Math.PI;

  console.log(`\n  ${INFO} Far cup   angular tolerance (rim): ±${angFar.toFixed(2)}°`);
  console.log(`  ${INFO} Close cup angular tolerance (rim): ±${angClose.toFixed(2)}°`);

  assert(angFar < angClose, 'Far cup requires more precise angle than close cup',
    `${angFar.toFixed(2)}° vs ${angClose.toFixed(2)}°`);

  // Proposed accuracy for perfect aim on each
  const hitFarPerfect   = hitChance(accuracyProposed(0, BASE_CUP_W, farCup.sc));
  const hitClosePerfect = hitChance(accuracyProposed(0, BASE_CUP_W, closeCup.sc));

  assert(hitFarPerfect > 0.85 && hitClosePerfect > 0.85,
    'Perfect aim on both → >85% hit regardless of distance',
    `far=${(hitFarPerfect*100).toFixed(0)}%, close=${(hitClosePerfect*100).toFixed(0)}%`);

  // But a sloppy 4px offset hurts far cup more
  const hitFarSloppy   = hitChance(accuracyProposed(4, BASE_CUP_W, farCup.sc));
  const hitCloseSloppy = hitChance(accuracyProposed(4, BASE_CUP_W, closeCup.sc));

  assert(hitFarSloppy < hitCloseSloppy,
    '4px offset hurts far cup more than close cup (correct difficulty gradient)',
    `far=${(hitFarSloppy*100).toFixed(0)}%, close=${(hitCloseSloppy*100).toFixed(0)}%`);
}

// ── 8. Velocity penalty simulation ────────────────────────────────────────────
section('Test 8: Velocity Penalty (slow swipe = lower accuracy)');
{
  const MIN_VEL = 0.10;
  const vels    = [0.05, 0.10, 0.20, 0.40, 0.70, 1.20, 2.00];

  console.log('  vel(px/ms) | powerAcc | finalAcc (dir=1.0) | hit%');
  console.log('  -----------|----------|-------------------|-----');
  for (const vel of vels) {
    const powerAcc = Math.min(1, Math.max(0.05, (vel - MIN_VEL) / 0.55));
    const finalAcc = 1.0 * 0.85 + powerAcc * 0.15; // perfect direction aim
    const hit      = hitChance(finalAcc);
    const marker   = vel < MIN_VEL ? ' ← too slow' : vel >= 0.65 ? ' ← good' : ' ← acceptable';
    console.log(`  ${vel.toFixed(2).padStart(7)}    |   ${powerAcc.toFixed(2)}   |       ${finalAcc.toFixed(2)}          | ${(hit*100).toFixed(0)}%${marker}`);
  }

  const powerAtMin = Math.min(1, Math.max(0.05, (MIN_VEL - MIN_VEL) / 0.55));
  const finalAtMin = 1.0 * 0.85 + powerAtMin * 0.15;
  assert(hitChance(finalAtMin) < 0.84, `Min velocity (${MIN_VEL}px/ms) reduces hit chance`,
    `${(hitChance(finalAtMin)*100).toFixed(0)}%`);

  const powerGood = Math.min(1, Math.max(0.05, (0.8 - MIN_VEL) / 0.55));
  const finalGood = 1.0 * 0.85 + powerGood * 0.15;
  assert(hitChance(finalGood) > 0.88, 'Good velocity (0.8px/ms) maintains high hit chance',
    `${(hitChance(finalGood)*100).toFixed(0)}%`);
}

// ── 9. End-to-end: simulate a full game with the proposed curve ────────────────
section('Test 9: Full Game Simulation — Expected Throws to Clear 10 Cups');
{
  function simulateGame(aimSkill, numPlayers = 2) {
    const { cups } = buildLayout(numPlayers);
    let remaining = [...cups];
    let throws = 0, hits = 0;

    // aimSkill: 0=random, 0.5=moderate, 1=perfect (perp = aimSkill * rimR offset)
    while (remaining.length > 0 && throws < 500) {
      const target = remaining[Math.floor(Math.random() * remaining.length)];
      const sc = target.sc;
      const rimR = BASE_CUP_W * sc * 0.30;
      const perpOff = (1 - aimSkill) * BASE_CUP_W * sc; // bad aim = miss by up to 1 cup width
      const acc = accuracyProposed(perpOff, BASE_CUP_W, sc);
      throws++;
      if (Math.random() < hitChance(acc)) {
        hits++;
        remaining = remaining.filter(c => c.id !== target.id);
      }
    }
    return { throws, hits, hitRate: hits / throws };
  }

  const skills = [
    { name: 'Beginner (random aim)',   skill: 0.1 },
    { name: 'Casual (decent aim)',     skill: 0.4 },
    { name: 'Skilled (good aim)',      skill: 0.7 },
    { name: 'Expert (near-perfect)',   skill: 0.95 },
  ];

  console.log('  \x1b[90m[2-player, 10 cups — averaged over 200 games]\x1b[0m\n');
  console.log('  Skill          | Avg throws | Hit rate | Cups left (if stopped at 50T)');
  console.log('  ---------------|------------|----------|-----------------------------');

  for (const { name, skill } of skills) {
    const runs = Array.from({ length: 200 }, () => simulateGame(skill));
    const avgThrows  = runs.reduce((a, r) => a + r.throws, 0) / 200;
    const avgHitRate = runs.reduce((a, r) => a + r.hitRate, 0) / 200;
    console.log(`  ${name.padEnd(22)} |   ${avgThrows.toFixed(0).padStart(4)}     |   ${(avgHitRate*100).toFixed(0)}%    |`);
  }

  // With the proposed curve, even an expert needs skill — not trivial
  const expertGames = Array.from({ length: 500 }, () => simulateGame(0.95));
  const avgExpertThrows = expertGames.reduce((a, r) => a + r.throws, 0) / 500;
  assert(avgExpertThrows > 10, `Expert needs >10 throws to clear 10 cups (not trivial)`,
    `avg ${avgExpertThrows.toFixed(1)} throws`);

  const beginnerGames = Array.from({ length: 500 }, () => simulateGame(0.05));
  const avgBegThrows = beginnerGames.reduce((a, r) => a + r.throws, 0) / 500;
  assert(avgBegThrows > 60, `Beginner needs >60 throws (clearly needs to improve)`,
    `avg ${avgBegThrows.toFixed(1)} throws`);
}

// ── 10. Player view: all cup centers visible and reachable by swipe ───────────
section('Test 10: Player View — Cup Centers Reachable by Upward Swipe');
{
  const { cups } = buildLayout(2);
  for (const cup of cups) {
    const dx = cup.cx - BALL_X;
    const dy = cup.cy - BALL_Y;
    // A valid swipe must go "forward" (toward cups = negative y = upward)
    const isUpward = dy < 0;
    assert(isUpward, `Cup ${cup.id} (row${cup.row}) is above ball — swipe-up aims at it`,
      `dy=${dy.toFixed(0)}px`);

    // The cup's angle from ball: ensure it's in ±45° from straight-up for natural swipe
    const angleFromUp = Math.atan2(Math.abs(dx), Math.abs(dy)) * 180 / Math.PI;
    assert(angleFromUp < 50, `Cup ${cup.id} within ±50° of straight-up for natural swipe`,
      `${angleFromUp.toFixed(1)}° from vertical`);
  }
}

// ── Summary ───────────────────────────────────────────────────────────────────
const total = passed + failed;
console.log('\n\x1b[1m──────────────────────────────────────────────\x1b[0m');
console.log(`\x1b[1mAccuracy Tests: ${passed}/${total} passed, ${warns} warnings\x1b[0m`);
if (failed > 0) console.log(`\x1b[31m${failed} failed\x1b[0m`);
else            console.log('\x1b[32mAll accuracy tests passed!\x1b[0m');

if (warns > 0) {
  console.log(`\x1b[33m${warns} warnings — CURRENT curve needs tuning (see Test 4)\x1b[0m`);
}
console.log('');
process.exit(failed > 0 ? 1 : 0);
