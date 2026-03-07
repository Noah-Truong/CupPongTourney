'use client';

import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import {
  useRef, useState, useCallback, useMemo, useEffect,
  forwardRef, useImperativeHandle,
} from 'react';
import { Cup } from '@/types/game';

// ── Scene geometry constants ──────────────────────────────────────────────────
const TABLE_HW     = 2.0;
const TABLE_DEPTH  = 11.0;
const TABLE_THICK  = 0.10;
const TABLE_Y      = 0;

const CUP_FAR_Z    = -3.4;
const CUP_NEAR_Z   = -1.0;
const CUP_SPACING  = 0.52;
const CUP_H        = 0.46;
const CUP_TOP_R    = 0.185;
const CUP_BOT_R    = 0.115;
const CUP_SEGS     = 24;

const BALL_R       = 0.105;
const BALL_START   = new THREE.Vector3(0, TABLE_Y + BALL_R + 0.01, 4.0);
const ARC_HEIGHT   = 2.3;
const FLIGHT_S     = 0.90;
const BOUNCE_S     = 0.65;

const CAM_POS      = [0, 2.5, 5.8] as const;
const CAM_TARGET   = [0, 0.15, -1.0] as const;
const CAM_FOV      = 58;

// ── Swipe tuning ──────────────────────────────────────────────────────────────
// Larger MIN_SWIPE = must make a deliberate gesture (reduces accidental throws)
const MIN_SWIPE    = 45;   // px — increased from 18 for better control
const MIN_VEL      = 0.08; // px/ms

// ── Props ─────────────────────────────────────────────────────────────────────
interface Props {
  cups: Cup[];
  isMyTurn: boolean;
  onThrow: (cupId: number, accuracy: number) => void;
  lastThrow?: { cupId: number; hit: boolean } | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function numRowsFromCups(cups: Cup[]) {
  return cups.length > 0 ? Math.max(...cups.map(c => c.row)) + 1 : 4;
}

function cupWorldPos(cup: Cup, numRows: number): THREE.Vector3 {
  const rowT = numRows <= 1 ? 0 : cup.row / (numRows - 1);
  const z    = CUP_FAR_Z + (CUP_NEAR_Z - CUP_FAR_Z) * rowT;
  const n    = numRows - cup.row;
  const x    = -(n - 1) * CUP_SPACING / 2 + cup.col * CUP_SPACING;
  return new THREE.Vector3(x, TABLE_Y + CUP_H / 2, z);
}

function project2D(
  v: THREE.Vector3, camera: THREE.Camera, w: number, h: number,
): { x: number; y: number } {
  const s = v.clone().project(camera);
  return { x: (s.x + 1) / 2 * w, y: (-s.y + 1) / 2 * h };
}

function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }
function easeInOut(t: number) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

// ── Scene handle exposed via forwardRef ───────────────────────────────────────
interface SceneHandle {
  /** Begin ball flight to a cup. Safe to call while idle. */
  startFlight: (cupId: number, targetPos: THREE.Vector3) => void;
  /** Queues the throw outcome — consumed when ball reaches cup. */
  notifyResult: (hit: boolean, cupId: number) => void;
}

// ── Cup mesh with fly-away animation ─────────────────────────────────────────
function CupMesh({ pos, sinking }: { pos: THREE.Vector3; sinking: boolean }) {
  const groupRef = useRef<THREE.Group>(null!);
  const flyT     = useRef(0);
  // Randomise fly direction once on mount
  const side     = useRef(Math.random() > 0.5 ? 1 : -1);

  useFrame((_, dt) => {
    if (!sinking || !groupRef.current) return;
    flyT.current = Math.min(flyT.current + dt / 0.55, 1);
    const t = flyT.current;
    const s = side.current;
    groupRef.current.position.set(
      pos.x + s * t * 1.5,
      pos.y + Math.sin(t * Math.PI) * 1.0 - t * 0.3,
      pos.z + t * 0.6,
    );
    groupRef.current.rotation.z = s * t * Math.PI * 1.3;
    groupRef.current.scale.setScalar(1 - t * 0.95);
  });

  return (
    <group ref={groupRef} position={pos}>
      {/* Main cone body */}
      <mesh castShadow>
        <cylinderGeometry args={[CUP_TOP_R, CUP_BOT_R, CUP_H, CUP_SEGS]} />
        <meshStandardMaterial color="#dc2626" roughness={0.42} metalness={0.08} />
      </mesh>
      {/* ── Interior disc — white, recessed just inside the rim ── */}
      <mesh position={[0, CUP_H / 2 - 0.01, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[CUP_TOP_R - 0.012, CUP_SEGS]} />
        <meshStandardMaterial color="#ffffff" roughness={0.6} />
      </mesh>
      {/* Bottom cap */}
      <mesh position={[0, -CUP_H / 2, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <circleGeometry args={[CUP_BOT_R, CUP_SEGS]} />
        <meshStandardMaterial color="#b91c1c" roughness={0.5} />
      </mesh>
    </group>
  );
}

// ── Ball + shadow + cups (inside Canvas) ─────────────────────────────────────
interface BallState {
  phase: 'idle' | 'flying' | 'result';
  elapsed: number;
  targetPos: THREE.Vector3;
  isHit: boolean;
}

const BallRenderer = forwardRef<
  SceneHandle,
  { cups: Cup[]; onLanded: (hit: boolean) => void }
>(({ cups, onLanded }, ref) => {
  const ballRef   = useRef<THREE.Mesh>(null!);
  const shadowRef = useRef<THREE.Mesh>(null!);
  const stateRef  = useRef<BallState>({
    phase: 'idle', elapsed: 0,
    targetPos: BALL_START.clone(), isHit: false,
  });
  const resultRef    = useRef<{ hit: boolean; cupId: number } | null>(null);
  const onLandedRef  = useRef(onLanded);
  const [sinkSet, setSinkSet] = useState<Set<number>>(new Set());

  useEffect(() => { onLandedRef.current = onLanded; }, [onLanded]);

  useImperativeHandle(ref, () => ({
    startFlight(cupId, targetPos) {
      // Ignore if ball is already mid-air — prevents double-start
      if (stateRef.current.phase === 'flying') return;
      stateRef.current = {
        phase: 'flying', elapsed: 0,
        targetPos: targetPos.clone(), isHit: false,
      };
      resultRef.current = null;
      if (ballRef.current) ballRef.current.position.copy(BALL_START);
    },
    notifyResult(hit, cupId) {
      resultRef.current = { hit, cupId };
    },
  }));

  // Restore ball to rest when idle
  useEffect(() => {
    if (ballRef.current) ballRef.current.position.copy(BALL_START);
  }, []);

  useFrame((_, dt) => {
    const s = stateRef.current;

    // Keep shadow hidden when idle
    if (s.phase === 'idle') {
      if (shadowRef.current) (shadowRef.current.material as THREE.MeshBasicMaterial).opacity = 0;
      if (ballRef.current) ballRef.current.position.copy(BALL_START);
      return;
    }

    s.elapsed += dt;

    if (s.phase === 'flying') {
      const raw  = Math.min(s.elapsed / FLIGHT_S, 1);
      const ease = easeInOut(raw);
      const x    = lerp(BALL_START.x, s.targetPos.x, ease);
      const z    = lerp(BALL_START.z, s.targetPos.z, ease);
      // Parabolic arc: peak at midpoint, lands at cup height
      const arcY = BALL_START.y
        + ARC_HEIGHT * 4 * raw * (1 - raw)
        + (s.targetPos.y - BALL_START.y) * ease;

      if (ballRef.current) ballRef.current.position.set(x, arcY, z);

      // Shadow shrinks as ball rises, grows as it falls
      const height = arcY - TABLE_Y;
      const shadowSc = Math.max(0.05, 1 - height / (ARC_HEIGHT * 1.5));
      if (shadowRef.current) {
        shadowRef.current.position.set(x, TABLE_Y + 0.001, z);
        shadowRef.current.scale.setScalar(shadowSc);
        (shadowRef.current.material as THREE.MeshBasicMaterial).opacity = shadowSc * 0.4;
      }

      if (raw >= 1) {
        // Ball has arrived — consume result or timeout
        const result = resultRef.current;
        const timedOut = s.elapsed > FLIGHT_S + 0.2;
        if (result !== null || timedOut) {
          const hit = result?.hit ?? false;
          const cupId = result?.cupId ?? -1;
          s.isHit   = hit;
          s.phase   = 'result';
          s.elapsed = 0;
          onLandedRef.current(hit);            // ← result text shown NOW (ball just landed)
          if (hit) {
            setSinkSet(prev => new Set([...prev, cupId]));
            if (ballRef.current) ballRef.current.position.copy(BALL_START); // snap back
          }
        }
      }
      return;
    }

    if (s.phase === 'result') {
      if (s.isHit) {
        // Cup fly-away plays; ball snapped back to rest — just wait
        if (s.elapsed > 0.65) {
          stateRef.current.phase = 'idle';
          if (shadowRef.current) (shadowRef.current.material as THREE.MeshBasicMaterial).opacity = 0;
        }
      } else {
        // Bounce: roll toward camera and lose height
        const raw = Math.min(s.elapsed / BOUNCE_S, 1);
        const bx  = s.targetPos.x + raw * 0.5;
        const bz  = s.targetPos.z + raw * 1.3;
        const by  = TABLE_Y + BALL_R + Math.max(0,
          0.50 * Math.sin(raw * Math.PI) * (1 - raw * 0.65),
        );
        if (ballRef.current) ballRef.current.position.set(bx, by, bz);
        const ss = Math.max(0, (1 - raw) * 0.6);
        if (shadowRef.current) {
          shadowRef.current.position.set(bx, TABLE_Y + 0.001, bz);
          shadowRef.current.scale.setScalar(ss);
          (shadowRef.current.material as THREE.MeshBasicMaterial).opacity = ss * 0.4;
        }
        if (raw >= 1) {
          stateRef.current.phase = 'idle';
        }
      }
    }
  });

  const numRows = numRowsFromCups(cups);

  return (
    <>
      {cups.map(cup => (
        <CupMesh
          key={cup.id}
          pos={cupWorldPos(cup, numRows)}
          sinking={sinkSet.has(cup.id) || cup.removed}
        />
      ))}

      {/* Ball — always visible; rests at BALL_START when idle */}
      <mesh ref={ballRef} position={BALL_START} castShadow>
        <sphereGeometry args={[BALL_R, 32, 16]} />
        <meshStandardMaterial color="#f2f2ee" roughness={0.22} metalness={0.04} />
      </mesh>

      {/* Shadow */}
      <mesh ref={shadowRef} rotation={[-Math.PI / 2, 0, 0]} position={[0, TABLE_Y + 0.001, 4]}>
        <circleGeometry args={[BALL_R * 1.3, 16]} />
        <meshBasicMaterial color="#000" transparent opacity={0} depthWrite={false} />
      </mesh>
    </>
  );
});
BallRenderer.displayName = 'BallRenderer';

// ── Green table ───────────────────────────────────────────────────────────────
function Table() {
  return (
    <group>
      <mesh receiveShadow position={[0, TABLE_Y - TABLE_THICK / 2, 0]}>
        <boxGeometry args={[TABLE_HW * 2, TABLE_THICK, TABLE_DEPTH]} />
        <meshStandardMaterial color="#1e6b14" roughness={0.85} metalness={0} />
      </mesh>
      {/* Center line */}
      <mesh position={[0, TABLE_Y + 0.002, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[0.03, TABLE_DEPTH * 0.95]} />
        <meshBasicMaterial color="#fff" opacity={0.18} transparent />
      </mesh>
      {/* Player-end circle */}
      <mesh position={[0, TABLE_Y + 0.002, 3.5]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.55, 0.58, 32]} />
        <meshBasicMaterial color="#fff" opacity={0.12} transparent />
      </mesh>
    </group>
  );
}

// ── Camera & renderer setup ───────────────────────────────────────────────────
function SceneSetup() {
  const { camera, gl } = useThree();
  useEffect(() => {
    const cam = camera as THREE.PerspectiveCamera;
    cam.fov = CAM_FOV;
    cam.position.set(...CAM_POS);
    cam.lookAt(...CAM_TARGET);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    gl.shadowMap.enabled = true;
    gl.shadowMap.type = THREE.PCFSoftShadowMap;
  }, [camera, gl]);
  return null;
}

// ── Scene root ────────────────────────────────────────────────────────────────
const SceneContents = forwardRef<
  SceneHandle,
  { cups: Cup[]; onLanded: (hit: boolean) => void }
>(({ cups, onLanded }, ref) => (
  <>
    <SceneSetup />
    <ambientLight intensity={0.55} />
    <directionalLight
      intensity={1.1} position={[2, 6, 4]} castShadow
      shadow-mapSize={[1024, 1024]}
      shadow-camera-near={0.1} shadow-camera-far={30}
      shadow-camera-left={-5} shadow-camera-right={5}
      shadow-camera-top={5}  shadow-camera-bottom={-5}
    />
    <pointLight intensity={0.3} position={[-2, 3, 2]} color="#fff8e1" />
    <Table />
    <BallRenderer ref={ref} cups={cups} onLanded={onLanded} />
  </>
));
SceneContents.displayName = 'SceneContents';

// ── Outer component: swipe handling + canvas ──────────────────────────────────
export default function GameScene3D({ cups, isMyTurn, onThrow, lastThrow }: Props) {
  const containerRef  = useRef<HTMLDivElement>(null);
  const sweepRef      = useRef<{ x: number; y: number; t: number } | null>(null);
  const sceneRef      = useRef<SceneHandle>(null);
  const localThrowRef = useRef(false);   // true when THIS player started the current throw
  const [size, setSize] = useState({ w: 375, h: 500 });
  const [throwing, setThrowing] = useState(false);
  const [showResult, setShowResult] = useState<'hit' | 'miss' | null>(null);

  // ── Result flash: shown only when ball lands (via onLanded callback) ──────
  const onLanded = useCallback((hit: boolean) => {
    setShowResult(hit ? 'hit' : 'miss');
    setTimeout(() => setShowResult(null), 1300);
  }, []);

  // ── Spectator ball animation + result for ALL players ─────────────────────
  const prevThrowRef = useRef<typeof lastThrow>(null);
  useEffect(() => {
    if (!lastThrow || lastThrow === prevThrowRef.current) return;
    prevThrowRef.current = lastThrow;

    const numRows = numRowsFromCups(cups);
    const targetCup = cups.find(c => c.id === lastThrow.cupId);
    if (!targetCup) return;
    const targetPos = cupWorldPos(targetCup, numRows);

    if (!localThrowRef.current) {
      // Spectating player: start the full animation now
      sceneRef.current?.startFlight(lastThrow.cupId, targetPos);
    }
    // Both throwing and spectating: queue the result (consumed when ball lands)
    sceneRef.current?.notifyResult(lastThrow.hit, lastThrow.cupId);
    localThrowRef.current = false;
  }, [lastThrow, cups]);

  // ── Resize observer ───────────────────────────────────────────────────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(e => {
      const { width: w, height: h } = e[0].contentRect;
      setSize({ w, h });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ── Projection camera (matches scene camera) for 2D hit-testing ──────────
  const projCam = useMemo(() => {
    const cam = new THREE.PerspectiveCamera(CAM_FOV, size.w / size.h, 0.1, 100);
    cam.position.set(...CAM_POS);
    cam.lookAt(new THREE.Vector3(...CAM_TARGET));
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    return cam;
  }, [size.w, size.h]);

  // ── Aim calculation ───────────────────────────────────────────────────────
  const computeAim = useCallback((dx: number, dy: number) => {
    const d = Math.hypot(dx, dy);
    if (d < MIN_SWIPE) return null;
    const dir   = { x: dx / d, y: dy / d };
    const avail = cups.filter(c => !c.removed);
    if (!avail.length) return null;
    const numRows = numRowsFromCups(cups);
    const { w, h } = size;

    const b2d = project2D(BALL_START, projCam, w, h);

    let best = avail[0];
    let bestPerp = Infinity;
    for (const cup of avail) {
      const c2d = project2D(cupWorldPos(cup, numRows), projCam, w, h);
      const vx  = c2d.x - b2d.x, vy = c2d.y - b2d.y;
      const t   = vx * dir.x + vy * dir.y;
      if (t <= 0) continue;
      const perp = Math.abs(vx * dir.y - vy * dir.x);
      if (perp < bestPerp) { bestPerp = perp; best = cup; }
    }

    // Projected cup rim width → hit-zone tiers
    const bestPos = cupWorldPos(best, numRows);
    const s0 = project2D(bestPos.clone().sub(new THREE.Vector3(CUP_TOP_R, 0, 0)), projCam, w, h);
    const s1 = project2D(bestPos.clone().add(new THREE.Vector3(CUP_TOP_R, 0, 0)), projCam, w, h);
    const rimPx = Math.abs(s1.x - s0.x) / 2;

    const rimR  = rimPx * 0.60;
    const bodyR = rimPx * 1.05;
    const nearR = rimPx * 1.65;

    let accuracy: number;
    if      (bestPerp <= rimR)  accuracy = 0.82 + (1 - bestPerp / rimR) * 0.18;
    else if (bestPerp <= bodyR) accuracy = 0.82 - Math.pow((bestPerp - rimR) / (bodyR - rimR), 0.65) * 0.62;
    else if (bestPerp <= nearR) accuracy = 0.20 - ((bestPerp - bodyR) / (nearR - bodyR)) * 0.19;
    else                        accuracy = 0;

    return { cup: best, accuracy, targetPos: bestPos };
  }, [cups, projCam, size]);

  // ── Swipe handlers ────────────────────────────────────────────────────────
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (!isMyTurn || throwing) return;
    sweepRef.current = { x: e.clientX, y: e.clientY, t: performance.now() };
  }, [isMyTurn, throwing]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    if (!isMyTurn || throwing || !sweepRef.current) return;
    const { x: sx, y: sy, t: st } = sweepRef.current;
    sweepRef.current = null;

    const dx  = e.clientX - sx;
    const dy  = e.clientY - sy;
    const dt  = Math.max(1, performance.now() - st);
    // Velocity contributes only 10% — direction is what matters for accuracy
    const vel      = Math.hypot(dx, dy) / dt;
    const powerAcc = Math.min(1, Math.max(0.1, (vel - MIN_VEL) / 0.80));

    const aim = computeAim(dx, dy);
    if (!aim) return;

    const finalAcc = aim.accuracy * 0.90 + powerAcc * 0.10;

    localThrowRef.current = true;              // mark: WE started this throw
    setThrowing(true);
    sceneRef.current?.startFlight(aim.cup.id, aim.targetPos);
    onThrow(aim.cup.id, finalAcc);

    setTimeout(() => setThrowing(false), (FLIGHT_S + BOUNCE_S + 0.4) * 1000);
  }, [isMyTurn, throwing, computeAim, onThrow]);

  return (
    <div
      ref={containerRef}
      className="relative flex-1 w-full overflow-hidden touch-none select-none"
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerCancel={() => { sweepRef.current = null; }}
    >
      <Canvas
        shadows
        gl={{ antialias: true, alpha: false }}
        style={{ background: '#0f1117', width: '100%', height: '100%' }}
      >
        <SceneContents ref={sceneRef} cups={cups} onLanded={onLanded} />
      </Canvas>

      {/* Status hints */}
      {!isMyTurn && !throwing && (
        <div className="absolute inset-0 pointer-events-none flex items-end justify-center pb-8">
          <div className="bg-black/50 text-white text-sm px-4 py-2 rounded-full">
            Watching opponent…
          </div>
        </div>
      )}
      {isMyTurn && !throwing && (
        <div className="absolute inset-0 pointer-events-none flex items-end justify-center pb-8">
          <div className="bg-white/90 text-gray-700 text-sm px-4 py-2 rounded-full shadow">
            Swipe toward a cup to throw
          </div>
        </div>
      )}

      {/* Result flash — only appears once ball lands */}
      {showResult && (
        <div
          key={showResult + Date.now()}
          className={`absolute left-1/2 top-1/3 -translate-x-1/2 pointer-events-none
            font-black text-2xl tracking-wider
            animate-[resultPop_1.3s_ease_forwards]
            ${showResult === 'hit' ? 'text-green-400' : 'text-white/60'}`}
        >
          {showResult === 'hit' ? 'SANK IT' : 'miss'}
        </div>
      )}
    </div>
  );
}
