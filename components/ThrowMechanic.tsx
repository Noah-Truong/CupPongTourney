'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Cup } from '@/types/game';

// ─── Layout constants ─────────────────────────────────────────────────────────
const BASE_CUP_W   = 40;   // px at closest row (scale = 1.0)
const BASE_CUP_H   = 48;   // px
const BASE_CUP_GAP = 7;    // px
const FAR_SCALE    = 0.62; // scale at farthest row (row 0)
const CUP_AREA_PAD = 18;   // px from top of component
const THROW_ZONE_H = 170;  // px
const BALL_D       = 40;   // ball diameter at rest

const MIN_SWIPE_DIST = 16; // px — ignore tiny taps
const MIN_VEL        = 0.10; // px/ms — below = "too slow" penalty

// ─── Types ────────────────────────────────────────────────────────────────────
interface CupLayout { x: number; y: number; w: number; h: number }

interface FlightState {
  x: number; y: number;
  scale: number; opacity: number;
  shadowX: number; shadowOpacity: number;
}

interface Props {
  cups: Cup[];
  isMyTurn: boolean;
  onThrow: (cupId: number, accuracy: number) => void;
  lastResult?: 'hit' | 'miss' | null;
}

// ─── Main component ───────────────────────────────────────────────────────────
export default function ThrowMechanic({
  cups, isMyTurn, onThrow, lastResult,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize]       = useState({ w: 360, h: 540 });
  const sweepRef              = useRef<{ x: number; y: number; t: number } | null>(null);
  const [flight, setFlight]   = useState<FlightState | null>(null);
  const [throwing, setThrowing] = useState(false);
  const [sunkCups, setSunkCups] = useState<Set<number>>(new Set());
  const [resultKey, setResultKey] = useState(0); // force re-mount for repeated results
  const [showResult, setShowResult] = useState<'hit' | 'miss' | null>(null);
  const rafRef       = useRef<number>(0);
  const prevCupsRef  = useRef<Cup[]>(cups);

  // Resize observer
  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver(([e]) => {
      setSize({ w: e.contentRect.width, h: e.contentRect.height });
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  // Detect newly-sunk cups → trigger fly-away animation
  useEffect(() => {
    const fresh = cups.filter(
      c => c.removed && !prevCupsRef.current.find(p => p.id === c.id)?.removed
    );
    if (fresh.length > 0) {
      setSunkCups(prev => new Set([...prev, ...fresh.map(c => c.id)]));
      const ids = fresh.map(c => c.id);
      setTimeout(() => {
        setSunkCups(prev => { const n = new Set(prev); ids.forEach(id => n.delete(id)); return n; });
      }, 950);
    }
    prevCupsRef.current = cups;
  }, [cups]);

  // Show result text flash on each throw
  useEffect(() => {
    if (!lastResult) return;
    setShowResult(lastResult);
    setResultKey(k => k + 1);
    const t = setTimeout(() => setShowResult(null), 1600);
    return () => clearTimeout(t);
  }, [lastResult]);

  // Clean up RAF on unmount
  useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); }, []);

  // ── Cup layout: manual perspective (far rows smaller, close rows larger) ────
  const numRows = useMemo(
    () => cups.length > 0 ? Math.max(...cups.map(c => c.row)) + 1 : 4,
    [cups]
  );

  /**
   * rowScale(r): r=0 (top, farthest) → FAR_SCALE, r=numRows-1 (bottom, closest) → 1.0
   * Linear interpolation gives a nice "table receding" perspective look.
   */
  const rowScale = useCallback(
    (row: number) => FAR_SCALE + (1 - FAR_SCALE) * (row / Math.max(1, numRows - 1)),
    [numRows]
  );

  /**
   * Compute layout for every cup. Returns a Map<cupId → {x,y,w,h}>.
   * The widest row (row 0, farthest) is at the top with small cups;
   * the single-cup row (row numRows-1, closest) is at the bottom with big cups.
   */
  const cupLayout = useMemo((): Map<number, CupLayout> => {
    const map = new Map<number, CupLayout>();
    let y = CUP_AREA_PAD;
    for (let row = 0; row < numRows; row++) {
      const sc   = rowScale(row);
      const cw   = BASE_CUP_W * sc;
      const ch   = BASE_CUP_H * sc;
      const gap  = BASE_CUP_GAP * sc;
      const cupsInRow = numRows - row;
      const totalW = cupsInRow * cw + (cupsInRow - 1) * gap;
      const startX = (size.w - totalW) / 2;
      cups.filter(c => c.row === row).forEach(cup => {
        map.set(cup.id, {
          x: startX + cup.col * (cw + gap),
          y,
          w: cw,
          h: ch,
        });
      });
      y += ch + gap;
    }
    return map;
  }, [cups, numRows, rowScale, size.w]);

  const getCupCenter = useCallback((cup: Cup) => {
    const l = cupLayout.get(cup.id);
    return l ? { x: l.x + l.w / 2, y: l.y + l.h / 2 } : { x: size.w / 2, y: 0 };
  }, [cupLayout, size.w]);

  // Ball home position (center of throw zone)
  const ballX = size.w / 2;
  const ballY = size.h - THROW_ZONE_H / 2;
  // Y-coordinate of table "edge" divider
  const tableEdgeY = size.h - THROW_ZONE_H;

  // ── Aim: swipe vector → nearest cup by perpendicular ray distance ────────
  const computeAim = useCallback((dx: number, dy: number) => {
    const dist = Math.hypot(dx, dy);
    if (dist < 1) return null;
    const dir = { x: dx / dist, y: dy / dist };
    const available = cups.filter(c => !c.removed);
    if (available.length === 0) return null;

    let best = available[0];
    let bestPerp = Infinity;
    for (const cup of available) {
      const { x: cx, y: cy } = getCupCenter(cup);
      const vx = cx - ballX, vy = cy - ballY;
      const t = vx * dir.x + vy * dir.y;
      if (t <= 0) continue; // behind the swipe direction
      const perp = Math.abs(vx * dir.y - vy * dir.x);
      if (perp < bestPerp) { bestPerp = perp; best = cup; }
    }
    // Cup width at that row gives the effective "hit zone" radius
    const sc = rowScale(best.row);
    const hitZone = BASE_CUP_W * sc * 2.5;
    const accuracy = Math.max(0, 1 - bestPerp / hitZone);
    return { cup: best, accuracy };
  }, [cups, getCupCenter, ballX, ballY, rowScale]);

  // ── RAF ball arc animation ────────────────────────────────────────────────
  const startFlight = useCallback((
    toX: number, toY: number, dur: number, onDone: () => void
  ) => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    const fromX = ballX, fromY = ballY;
    const arcH  = Math.max(90, (fromY - toY) * 0.55 + 40);
    const t0    = performance.now();

    function tick(now: number) {
      const raw  = Math.min(1, (now - t0) / dur);
      // ease: cubic in-out
      const ease = raw < 0.5 ? 4 * raw * raw * raw : 1 - Math.pow(-2 * raw + 2, 3) / 2;

      const x     = fromX + (toX - fromX) * ease;
      const baseY = fromY + (toY - fromY) * ease;
      const y     = baseY - arcH * Math.sin(Math.PI * raw); // parabolic arc
      const scale = 1 - raw * 0.65;                         // shrinks as it recedes
      const opacity = raw > 0.87 ? 1 - (raw - 0.87) / 0.13 * 0.45 : 1;

      // Shadow follows ball's X but stays at table-edge level
      const shadowX = fromX + (toX - fromX) * ease;
      // Shadow fades in as ball approaches cups, out when near end
      const shadowOpacity = Math.sin(Math.PI * raw) * 0.55;

      setFlight({ x, y, scale, opacity, shadowX, shadowOpacity });

      if (raw < 1) rafRef.current = requestAnimationFrame(tick);
      else { setFlight(null); onDone(); }
    }
    rafRef.current = requestAnimationFrame(tick);
  }, [ballX, ballY]);

  // ── Swipe gesture (no visual guide) ──────────────────────────────────────
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (!isMyTurn || throwing || cups.filter(c => !c.removed).length === 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const rect = containerRef.current!.getBoundingClientRect();
    sweepRef.current = {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      t: e.timeStamp,
    };
  }, [isMyTurn, throwing, cups]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    const sw = sweepRef.current;
    sweepRef.current = null;
    if (!sw || !isMyTurn || throwing) return;

    const rect = containerRef.current!.getBoundingClientRect();
    const dx   = e.clientX - rect.left - sw.x;
    const dy   = e.clientY - rect.top  - sw.y;
    const dist = Math.hypot(dx, dy);
    const dt   = Math.max(1, e.timeStamp - sw.t);
    const vel  = dist / dt; // px/ms

    if (dist < MIN_SWIPE_DIST) return;

    const aim = computeAim(dx, dy);
    if (!aim) return;

    // Power accuracy: slow swipe penalizes accuracy
    const powerAcc   = Math.min(1, Math.max(0.05, (vel - MIN_VEL) / 0.55));
    const finalAcc   = aim.accuracy * 0.78 + powerAcc * 0.22;

    // Fast swipe = snappier ball flight
    const animDur    = Math.max(460, Math.min(830, 620 / Math.max(vel, 0.22)));

    setThrowing(true);
    const target = getCupCenter(aim.cup);
    startFlight(target.x, target.y, animDur, () => setThrowing(false));
    onThrow(aim.cup.id, finalAcc);
  }, [isMyTurn, throwing, computeAim, getCupCenter, startFlight, onThrow]);

  // ── Render a single 3D cup ────────────────────────────────────────────────
  const renderCup = useCallback((cup: Cup) => {
    const l = cupLayout.get(cup.id);
    if (!l) return null;

    const isSinking  = sunkCups.has(cup.id);
    const flyRight   = (cup.col + cup.row) % 2 === 0;
    const rimH       = l.h * 0.26;
    const shineW     = l.w * 0.2;
    const shineH     = l.h * 0.44;

    return (
      <div
        key={cup.id}
        style={{
          position: 'absolute',
          left: l.x,
          top:  l.y,
          width: l.w,
          height: l.h,
          animation: isSinking
            ? `${flyRight ? 'cupFlyRight' : 'cupFlyLeft'} 0.88s cubic-bezier(0.2,0,0.8,1) forwards`
            : undefined,
        }}
      >
        {!cup.removed && (
          <>
            {/* Ground shadow */}
            <div style={{
              position: 'absolute',
              bottom: -5,
              left: '8%',
              width: '84%',
              height: l.h * 0.14,
              background: 'rgba(0,0,0,0.28)',
              borderRadius: '50%',
              filter: `blur(${Math.max(2, l.w * 0.08)}px)`,
              transform: 'scaleY(0.35)',
            }} />

            {/* Cup body — tapered trapezoid with cylindrical gradient */}
            <div style={{
              position: 'absolute',
              bottom: 0,
              left: 0,
              width: '100%',
              height: '87%',
              background: `linear-gradient(
                to right,
                #6B0000 0%, #B71C1C 11%, #D32F2F 20%,
                #F44336 32%, #FF7070 45%, #FF8585 50%, #FF7070 55%,
                #F44336 68%, #D32F2F 80%, #B71C1C 89%, #6B0000 100%
              )`,
              clipPath: 'polygon(13% 0%, 87% 0%, 77% 100%, 23% 100%)',
            }}>
              {/* Subtle horizontal ridges */}
              <div style={{
                position: 'absolute',
                inset: 0,
                background: `repeating-linear-gradient(
                  to bottom,
                  transparent 0px,
                  transparent 28%,
                  rgba(0,0,0,0.06) 28%,
                  rgba(0,0,0,0.06) 30%,
                  transparent 30%,
                  transparent 55%,
                  rgba(0,0,0,0.06) 55%,
                  rgba(0,0,0,0.06) 57%,
                  transparent 57%,
                  transparent 100%
                )`,
              }} />
            </div>

            {/* Rim — ellipse opening with interior depth */}
            <div style={{
              position: 'absolute',
              top: 0,
              left: '5%',
              width: '90%',
              height: rimH,
              borderRadius: '50%',
              background: 'radial-gradient(ellipse at 50% 38%, rgba(255,180,180,0.25) 0%, #C62828 52%, #7B0000 100%)',
              border: `${Math.max(1, l.w * 0.035)}px solid rgba(255,140,140,0.55)`,
              overflow: 'hidden',
            }}>
              {/* Interior dark cavity */}
              <div style={{
                position: 'absolute',
                top: '30%',
                left: '8%',
                right: '8%',
                bottom: 0,
                background: 'rgba(0,0,0,0.5)',
                borderRadius: '50%',
              }} />
            </div>

            {/* Left-side shine / highlight */}
            <div style={{
              position: 'absolute',
              top: rimH * 0.8,
              left: '13%',
              width: shineW,
              height: shineH,
              background: 'linear-gradient(155deg, rgba(255,255,255,0.38) 0%, rgba(255,255,255,0) 100%)',
              borderRadius: '60% 60% 50% 50%',
            }} />
          </>
        )}

        {/* Faded outline for removed cups (empty slot) */}
        {cup.removed && !isSinking && (
          <div style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            width: '100%',
            height: '87%',
            background: 'rgba(220,220,220,0.1)',
            clipPath: 'polygon(13% 0%, 87% 0%, 77% 100%, 23% 100%)',
          }} />
        )}
      </div>
    );
  }, [cupLayout, sunkCups]);

  // ── Render ────────────────────────────────────────────────────────────────
  // Height of cup area (all rows stacked)
  const cupAreaH = useMemo(() => {
    let h = CUP_AREA_PAD;
    for (let row = 0; row < numRows; row++) {
      const sc = rowScale(row);
      h += BASE_CUP_H * sc + BASE_CUP_GAP * sc;
    }
    return h;
  }, [numRows, rowScale]);

  return (
    <div
      ref={containerRef}
      className="relative flex-1 w-full touch-none select-none bg-white overflow-hidden"
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerCancel={() => { sweepRef.current = null; }}
    >
      {/* ── Cup pool (absolutely positioned for correct hit-testing) ────── */}
      <div style={{ position: 'absolute', inset: 0, bottom: THROW_ZONE_H }}>
        {cups.map(renderCup)}

        {/* Table edge shadow at bottom of cup area */}
        <div style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          height: 18,
          background: 'linear-gradient(to bottom, rgba(0,0,0,0.06) 0%, rgba(0,0,0,0.0) 100%)',
        }} />
        {/* Table-edge line */}
        <div style={{
          position: 'absolute',
          bottom: 0,
          left: '8%',
          right: '8%',
          height: 1,
          background: 'rgba(0,0,0,0.08)',
        }} />
      </div>

      {/* ── Flying ball + shadow ─────────────────────────────────────────── */}
      {flight && (
        <>
          {/* Shadow projected on "table" near cup area */}
          <div style={{
            position: 'absolute',
            left:  flight.shadowX - 13,
            top:   tableEdgeY - 7,
            width: 26,
            height: 10,
            background: 'rgba(0,0,0,0.25)',
            borderRadius: '50%',
            filter: 'blur(3px)',
            opacity: flight.shadowOpacity,
            pointerEvents: 'none',
          }} />

          {/* Ball sphere */}
          <div style={{
            position: 'absolute',
            left:   flight.x - (BALL_D / 2) * flight.scale,
            top:    flight.y - (BALL_D / 2) * flight.scale,
            width:  BALL_D * flight.scale,
            height: BALL_D * flight.scale,
            borderRadius: '50%',
            // Sphere shading: bright highlight top-left, dark bottom-right
            background: 'radial-gradient(circle at 33% 28%, rgba(255,255,255,0.97) 0%, rgba(255,255,255,0.72) 17%, rgba(238,238,238,0.35) 38%, rgba(195,195,195,0.12) 65%, rgba(140,140,140,0.04) 85%)',
            backgroundColor: '#ebebeb',
            boxShadow: [
              `${flight.scale * 5}px ${flight.scale * 6}px ${flight.scale * 16}px rgba(0,0,0,0.55)`,
              `inset -${flight.scale * 3}px -${flight.scale * 3}px ${flight.scale * 8}px rgba(0,0,0,0.22)`,
              `inset ${flight.scale * 2}px ${flight.scale * 2}px ${flight.scale * 5}px rgba(255,255,255,0.95)`,
            ].join(', '),
            opacity: flight.opacity,
            pointerEvents: 'none',
          }} />
        </>
      )}

      {/* ── Throw zone ─────────────────────────────────────────────────── */}
      <div style={{
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        height: THROW_ZONE_H,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
      }}>
        {isMyTurn && !throwing && (
          /* The stationary ball — swipe anywhere to throw */
          <div style={{ position: 'relative' }}>
            {/* Ball ground shadow */}
            <div style={{
              position: 'absolute',
              bottom: -6,
              left: '12%',
              width: '76%',
              height: 10,
              background: 'rgba(0,0,0,0.22)',
              borderRadius: '50%',
              filter: 'blur(4px)',
            }} />
            {/* 3D ball sphere */}
            <div style={{
              width: BALL_D,
              height: BALL_D,
              borderRadius: '50%',
              background: 'radial-gradient(circle at 33% 28%, rgba(255,255,255,0.97) 0%, rgba(255,255,255,0.72) 17%, rgba(238,238,238,0.35) 38%, rgba(195,195,195,0.12) 65%, rgba(140,140,140,0.04) 85%)',
              backgroundColor: '#ebebeb',
              boxShadow: [
                '4px 6px 16px rgba(0,0,0,0.55)',
                'inset -3px -3px 8px rgba(0,0,0,0.22)',
                'inset 2px 2px 5px rgba(255,255,255,0.95)',
              ].join(', '),
            }} />
          </div>
        )}

        {!isMyTurn && (
          <p style={{ color: '#9ca3af', fontSize: 13, textAlign: 'center' }}>
            Waiting for your turn…
          </p>
        )}
      </div>

      {/* ── Result flash ─────────────────────────────────────────────────── */}
      {showResult && (
        <div
          key={resultKey}
          style={{
            position: 'absolute',
            top: '42%',
            left: '50%',
            transform: 'translateX(-50%)',
            animation: 'resultPop 1.55s ease-out forwards',
            pointerEvents: 'none',
            zIndex: 20,
          }}
        >
          <span style={{
            display: 'block',
            fontSize: showResult === 'hit' ? 30 : 20,
            fontWeight: 900,
            letterSpacing: '-0.5px',
            color: showResult === 'hit' ? '#16a34a' : '#9ca3af',
            textShadow: '0 2px 10px rgba(0,0,0,0.18)',
          }}>
            {showResult === 'hit' ? 'SANK IT' : 'miss'}
          </span>
        </div>
      )}
    </div>
  );
}
