'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Cup } from '@/types/game';

// ─── Layout constants ─────────────────────────────────────────────────────────
const CUP_GAP        = 6;
const THROW_ZONE_H   = 170;
const BALL_SIZE      = 38;
const MAX_CUP_SIZE   = 40;
const MIN_CUP_SIZE   = 26;

// ─── Geometry helpers ─────────────────────────────────────────────────────────
function normalize(v: { x: number; y: number }) {
  const len = Math.hypot(v.x, v.y);
  return len < 1e-6 ? { x: 0, y: -1 } : { x: v.x / len, y: v.y / len };
}

// Perpendicular distance from point p to ray (origin o, direction d)
function rayPointDist(
  o: { x: number; y: number },
  d: { x: number; y: number },
  p: { x: number; y: number }
) {
  const t = (p.x - o.x) * d.x + (p.y - o.y) * d.y;
  if (t < 0) return Math.hypot(p.x - o.x, p.y - o.y);
  return Math.hypot(p.x - (o.x + t * d.x), p.y - (o.y + t * d.y));
}

// ─── Props ────────────────────────────────────────────────────────────────────
interface Props {
  cups: Cup[];
  isMyTurn: boolean;
  ballsThrown: number;    // 0 or 1
  onThrow: (cupId: number, accuracy: number) => void;
  lastResult?: 'hit' | 'miss' | null;
}

interface DragState {
  cx: number; // current pointer x in container coords
  cy: number; // current pointer y
}

interface AimResult {
  cupId: number;
  accuracy: number; // 0–1
}

export default function ThrowMechanic({ cups, isMyTurn, ballsThrown, onThrow, lastResult }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 360, h: 520 });
  const [drag, setDrag] = useState<DragState | null>(null);
  const [throwing, setThrowing] = useState(false);

  // Track container size
  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver(([e]) => {
      setSize({ w: e.contentRect.width, h: e.contentRect.height });
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  // ── Cup layout math ────────────────────────────────────────────────────────
  // The cup triangle has `numRows` rows (row 0 is widest with numRows cups).
  const numRows = useMemo(
    () => (cups.length > 0 ? Math.max(...cups.map(c => c.row)) + 1 : 4),
    [cups]
  );

  // Cup size: fill width for the widest row, clamped to [MIN, MAX]
  const cupSize = useMemo(() => {
    const availW = size.w * 0.90;
    const byWidth = Math.floor(availW / numRows) - CUP_GAP;
    // Also constrain by available height above the throw zone
    const availH = size.h - THROW_ZONE_H - 24; // top padding
    const byHeight = Math.floor(availH / numRows) - CUP_GAP;
    return Math.min(MAX_CUP_SIZE, Math.max(MIN_CUP_SIZE, Math.min(byWidth, byHeight)));
  }, [size.w, size.h, numRows]);

  // Ball position (center of throw zone)
  const ballX = size.w / 2;
  const ballY = size.h - THROW_ZONE_H / 2;

  // Cup center in container coordinates
  const getCupCenter = useCallback(
    (cup: Cup) => {
      const cupsInRow = numRows - cup.row; // row 0 has numRows cups
      const totalW = cupsInRow * cupSize + (cupsInRow - 1) * CUP_GAP;
      const startX = (size.w - totalW) / 2;
      return {
        x: startX + cup.col * (cupSize + CUP_GAP) + cupSize / 2,
        y: 20 + cup.row * (cupSize + CUP_GAP) + cupSize / 2,
      };
    },
    [size.w, numRows, cupSize]
  );

  // ── Aim calculation ────────────────────────────────────────────────────────
  // The throw vector is from the ball toward the current drag position.
  // We cast a ray from ball in that direction and find the nearest cup.
  const computeAim = useCallback(
    (cx: number, cy: number): AimResult | null => {
      const dx = cx - ballX;
      const dy = cy - ballY;
      if (Math.hypot(dx, dy) < 10) return null;

      const dir = normalize({ x: dx, y: dy });
      const available = cups.filter(c => !c.removed);
      if (available.length === 0) return null;

      let best = available[0];
      let bestDist = Infinity;
      for (const cup of available) {
        const center = getCupCenter(cup);
        const dist = rayPointDist({ x: ballX, y: ballY }, dir, center);
        if (dist < bestDist) { bestDist = dist; best = cup; }
      }

      // accuracy: 1.0 if ray passes through cup center, 0 if >2.5 cup-widths away
      const accuracy = Math.max(0, 1 - bestDist / (cupSize * 2.5));
      return { cupId: best.id, accuracy };
    },
    [cups, ballX, ballY, getCupCenter, cupSize]
  );

  const aimResult = useMemo(
    () => (drag ? computeAim(drag.cx, drag.cy) : null),
    [drag, computeAim]
  );

  // ── Pointer events ─────────────────────────────────────────────────────────
  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!isMyTurn || throwing || cups.filter(c => !c.removed).length === 0) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      const rect = containerRef.current!.getBoundingClientRect();
      setDrag({ cx: e.clientX - rect.left, cy: e.clientY - rect.top });
    },
    [isMyTurn, throwing, cups]
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!drag) return;
      const rect = containerRef.current!.getBoundingClientRect();
      setDrag({ cx: e.clientX - rect.left, cy: e.clientY - rect.top });
    },
    [drag]
  );

  const handlePointerUp = useCallback(() => {
    if (!drag) return;
    const aim = computeAim(drag.cx, drag.cy);
    setDrag(null);
    if (!aim || aim.accuracy < 0.01) return;
    setThrowing(true);
    onThrow(aim.cupId, aim.accuracy);
    setTimeout(() => setThrowing(false), 700);
  }, [drag, computeAim, onThrow]);

  // ── SVG trajectory arc ─────────────────────────────────────────────────────
  const svgArc = useMemo(() => {
    if (!drag) return null;
    const dx = drag.cx - ballX;
    const dy = drag.cy - ballY;
    if (Math.hypot(dx, dy) < 10) return null;
    const dir = normalize({ x: dx, y: dy });
    const projLen = Math.min(size.h * 1.5, Math.hypot(dx, dy) * 3.5);
    const ex = ballX + dir.x * projLen;
    const ey = ballY + dir.y * projLen;
    // Control point: perpendicular offset for a gentle arc
    const mx = (ballX + ex) / 2 - dir.y * 50;
    const my = (ballY + ey) / 2 + dir.x * 50;
    return { path: `M ${ballX} ${ballY} Q ${mx} ${my} ${ex} ${ey}`, ex, ey };
  }, [drag, ballX, ballY, size.h]);

  // ── Aim label ──────────────────────────────────────────────────────────────
  const aimLabel = aimResult
    ? aimResult.accuracy > 0.75 ? 'Perfect aim!'
    : aimResult.accuracy > 0.45 ? 'Good aim'
    : aimResult.accuracy > 0.15 ? 'Rough aim'
    : 'Aim at a cup'
    : 'Drag toward a cup to aim';

  const aimColor = aimResult
    ? aimResult.accuracy > 0.75 ? 'text-green-600'
    : aimResult.accuracy > 0.45 ? 'text-orange-500'
    : 'text-red-400'
    : 'text-gray-400';

  const ballNum = ballsThrown + 1; // 1 or 2

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div
      ref={containerRef}
      className="relative flex-1 w-full overflow-hidden touch-none select-none"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={() => setDrag(null)}
    >
      {/* ── Cup pool ▽ ─────────────────────────────────────────────────── */}
      <div className="flex flex-col items-center" style={{ paddingTop: 20 }}>
        {Array.from({ length: numRows }, (_, row) => {
          const rowCups = cups.filter(c => c.row === row).sort((a, b) => a.col - b.col);
          const isTarget = (cup: Cup) => aimResult?.cupId === cup.id;
          return (
            <div key={row} className="flex" style={{ gap: CUP_GAP, marginBottom: CUP_GAP }}>
              {rowCups.map(cup => (
                <div
                  key={cup.id}
                  className={`
                    rounded-full border-2 flex items-center justify-center
                    transition-all duration-150
                    ${cup.removed
                      ? 'border-gray-200 bg-gray-50 opacity-20'
                      : isTarget(cup)
                        ? 'border-red-600 bg-red-500 shadow-lg shadow-red-200'
                        : 'border-red-400 bg-red-50'
                    }
                  `}
                  style={{
                    width: cupSize,
                    height: cupSize,
                    transform: isTarget(cup) && !cup.removed ? 'scale(1.18)' : 'scale(1)',
                  }}
                >
                  {!cup.removed && (
                    <div
                      className={`rounded-full ${isTarget(cup) ? 'bg-white' : 'bg-red-300'}`}
                      style={{ width: cupSize * 0.28, height: cupSize * 0.28 }}
                    />
                  )}
                </div>
              ))}
            </div>
          );
        })}
      </div>

      {/* ── SVG overlay: trajectory arc + target ring ──────────────────── */}
      {svgArc && (
        <svg
          className="absolute inset-0 pointer-events-none"
          width={size.w}
          height={size.h}
          style={{ overflow: 'visible' }}
        >
          <path
            d={svgArc.path}
            stroke="#ef4444"
            strokeWidth="2.5"
            strokeDasharray="10 6"
            fill="none"
            opacity="0.55"
          />
          {aimResult && (() => {
            const center = getCupCenter(cups.find(c => c.id === aimResult.cupId)!);
            return (
              <circle
                cx={center.x}
                cy={center.y}
                r={cupSize / 2 + 7}
                stroke="#ef4444"
                strokeWidth="2"
                fill="none"
                opacity="0.5"
                strokeDasharray="5 3"
              />
            );
          })()}
        </svg>
      )}

      {/* ── Divider ────────────────────────────────────────────────────── */}
      <div
        className="absolute left-6 right-6 border-t border-dashed border-gray-200"
        style={{ bottom: THROW_ZONE_H }}
      />

      {/* ── Throw zone ─────────────────────────────────────────────────── */}
      <div
        className="absolute bottom-0 left-0 right-0 flex flex-col items-center justify-center gap-2"
        style={{ height: THROW_ZONE_H }}
      >
        {isMyTurn ? (
          <>
            {/* Ball */}
            <div
              className={`
                rounded-full border-4 bg-white shadow-md flex items-center justify-center
                transition-all duration-200
                ${drag ? 'border-red-600 shadow-red-300 shadow-lg' : 'border-red-400'}
                ${throwing ? 'opacity-0 scale-0' : 'opacity-100 scale-100'}
              `}
              style={{ width: BALL_SIZE, height: BALL_SIZE }}
            >
              <div className="rounded-full bg-red-200" style={{ width: BALL_SIZE * 0.33, height: BALL_SIZE * 0.33 }} />
            </div>

            {/* Aim / instruction label */}
            <p className={`text-xs font-medium transition-colors ${aimColor}`}>
              {drag ? aimLabel : `Ball ${ballNum} of 2 — drag toward a cup to throw`}
            </p>

            {/* Last result (shown briefly when not dragging) */}
            {!drag && lastResult && (
              <p className={`text-sm font-semibold ${lastResult === 'hit' ? 'text-green-600' : 'text-gray-400'}`}>
                {lastResult === 'hit' ? 'Sank it!' : 'Missed.'}
              </p>
            )}
          </>
        ) : (
          <p className="text-sm text-gray-400 text-center px-4 leading-relaxed">
            Waiting for your turn…
          </p>
        )}
      </div>
    </div>
  );
}
