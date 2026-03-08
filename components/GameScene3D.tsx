'use client';

import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import {
  useRef, useState, useCallback, useMemo, useEffect,
  forwardRef, useImperativeHandle,
} from 'react';
import { Cup } from '@/types/game';

// ── Scene geometry ────────────────────────────────────────────────────────────
const TABLE_HW    = 2.0;
const TABLE_DEPTH = 11.0;
const TABLE_THICK = 0.10;
const TABLE_Y     = 0;

const CUP_FAR_Z   = -3.4;
const CUP_NEAR_Z  = -1.0;
const CUP_SPACING = 0.52;
const CUP_H       = 0.46;
const CUP_TOP_R   = 0.185;
const CUP_BOT_R   = 0.115;
const CUP_SEGS    = 24;
const CUP_RIM_Y   = TABLE_Y + CUP_H;   // absolute Y of the cup's rim opening

const BALL_R      = 0.105;
const BALL_START  = new THREE.Vector3(0, TABLE_Y + BALL_R + 0.01, 4.0);
const ARC_HEIGHT  = 2.3;
const FLIGHT_S    = 0.90;   // ball flight to cup rim
const ENTER_S     = 0.22;   // ball sinks into cup
const BOUNCE_S    = 0.65;   // ball rolls away on miss

const CAM_POS     = [0, 2.5, 5.8] as const;
const CAM_TARGET  = [0, 0.15, -1.0] as const;
const CAM_FOV     = 58;

const MIN_SWIPE   = 80;     // px  — requires a committed throw gesture
const MIN_VEL     = 0.18;   // px/ms — slow drags rejected (ball has weight)
const MAX_VEL     = 2.00;   // px/ms — full-power throw velocity (wider range = more granularity)

// ── Props ─────────────────────────────────────────────────────────────────────
interface Props {
  cups: Cup[];
  isMyTurn: boolean;
  onThrow: (cupId: number, accuracy: number) => void;
  lastThrow?: { cupId: number; hit: boolean } | null;
}

// ── Geometry helpers ──────────────────────────────────────────────────────────
function numRowsFromCups(cups: Cup[]) {
  return cups.length > 0 ? Math.max(...cups.map(c => c.row)) + 1 : 4;
}

/** Returns the cup's 3D center position (XZ are cup center, Y is mid-height). */
function cupWorldPos(cup: Cup, numRows: number): THREE.Vector3 {
  const rowT = numRows <= 1 ? 0 : cup.row / (numRows - 1);
  const z    = CUP_FAR_Z + (CUP_NEAR_Z - CUP_FAR_Z) * rowT;
  const n    = numRows - cup.row;
  const x    = -(n - 1) * CUP_SPACING / 2 + cup.col * CUP_SPACING;
  return new THREE.Vector3(x, TABLE_Y + CUP_H / 2, z);
}

/** Returns the position at the TOP OPENING of a cup (where ball enters). */
function cupRimPos(cup: Cup, numRows: number): THREE.Vector3 {
  const center = cupWorldPos(cup, numRows);
  return new THREE.Vector3(center.x, CUP_RIM_Y + BALL_R * 0.2, center.z);
}

function project2D(
  v: THREE.Vector3, cam: THREE.Camera, w: number, h: number,
): { x: number; y: number } {
  const s = v.clone().project(cam);
  return { x: (s.x + 1) / 2 * w, y: (-s.y + 1) / 2 * h };
}

/**
 * Cast a ray through the swipe direction and find where it lands on a
 * horizontal plane at y = planeY.  Returns null when the ray is nearly
 * parallel to the plane (shouldn't happen for forward swipes).
 */
function swipeRayToPlane(
  dir: { x: number; y: number },
  b2d: { x: number; y: number },
  cam: THREE.Camera,
  w: number,
  h: number,
  planeY: number,
): THREE.Vector3 | null {
  // Project a point that is PROJ_SCALE * screen-height ahead of the ball
  // along the swipe direction. This gives us a 2D "aim point" on screen
  // whose 3D ray we intersect with the cup-rim plane.
  const PROJ_SCALE = 0.72;
  const projDist = h * PROJ_SCALE;
  const ax = b2d.x + dir.x * projDist;
  const ay = b2d.y + dir.y * projDist;

  // Convert to NDC [-1, 1]
  const ndcX = (ax / w) * 2 - 1;
  const ndcY = -(ay / h) * 2 + 1;

  // Unproject two depths to get a ray
  const near = new THREE.Vector3(ndcX, ndcY, 0).unproject(cam);
  const far  = new THREE.Vector3(ndcX, ndcY, 1).unproject(cam);
  const rayDir = far.sub(near).normalize();

  // Intersect y = planeY:  origin.y + t * rayDir.y = planeY
  if (Math.abs(rayDir.y) < 1e-6) return null;
  const t = (planeY - cam.position.y) / rayDir.y;
  if (t < 0) return null;

  return new THREE.Vector3(
    cam.position.x + rayDir.x * t,
    planeY,
    cam.position.z + rayDir.z * t,
  );
}

function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }
function easeInOut(t: number) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

// ── Scene handle ──────────────────────────────────────────────────────────────
interface SceneHandle {
  /** landingPos: raw 3D point (power-scaled). flightDuration/arcHeight driven by swipe speed. */
  startFlight: (
    cupId: number,
    landingPos: THREE.Vector3,
    flightDuration?: number,
    arcHeight?: number,
  ) => void;
  notifyResult: (hit: boolean, cupId: number) => void;
}

// ── Hollow cup mesh with fly-away ─────────────────────────────────────────────
function CupMesh({ pos, sinking }: { pos: THREE.Vector3; sinking: boolean }) {
  const groupRef = useRef<THREE.Group>(null!);
  const flyT     = useRef(0);
  const side     = useRef(Math.random() > 0.5 ? 1 : -1);

  useFrame((_, dt) => {
    if (!groupRef.current) return;
    if (!sinking) {
      // Cup is active (or rematch reset) — restore transform and reset timer
      groupRef.current.position.copy(pos);
      groupRef.current.rotation.set(0, 0, 0);
      groupRef.current.scale.setScalar(1);
      flyT.current = 0;
      return;
    }
    flyT.current = Math.min(flyT.current + dt / 0.55, 1);
    const t = flyT.current;
    const s = side.current;
    groupRef.current.position.set(
      pos.x + s * t * 1.5,
      pos.y + Math.sin(t * Math.PI) * 1.1 - t * 0.3,
      pos.z + t * 0.6,
    );
    groupRef.current.rotation.z = s * t * Math.PI * 1.3;
    groupRef.current.scale.setScalar(1 - t * 0.95);
  });

  return (
    <group ref={groupRef} position={pos}>
      {/* ── Outer wall: open-top truncated cone ── */}
      <mesh castShadow>
        {/* openEnded=true → no top/bottom caps → cup is hollow */}
        <cylinderGeometry args={[CUP_TOP_R, CUP_BOT_R, CUP_H, CUP_SEGS, 1, true]} />
        <meshStandardMaterial
          color="#dc2626" roughness={0.40} metalness={0.08}
          side={THREE.DoubleSide}   // shows red inner wall when looking in from top
        />
      </mesh>

      {/* ── Inner walls: slightly smaller cylinder, BackSide renders inward face ── */}
      <mesh>
        <cylinderGeometry args={[CUP_TOP_R - 0.010, CUP_BOT_R - 0.006, CUP_H - 0.015, CUP_SEGS, 1, true]} />
        <meshStandardMaterial color="#8b0000" roughness={0.95} side={THREE.BackSide} />
      </mesh>

      {/* ── White base — visible when peering into the cup ── */}
      <mesh position={[0, -CUP_H / 2 + 0.008, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[CUP_BOT_R - 0.006, CUP_SEGS]} />
        <meshStandardMaterial color="#ffffff" roughness={0.6} />
      </mesh>

      {/* ── Bottom exterior cap ── */}
      <mesh position={[0, -CUP_H / 2, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <circleGeometry args={[CUP_BOT_R, CUP_SEGS]} />
        <meshStandardMaterial color="#b91c1c" roughness={0.5} />
      </mesh>

      {/* ── Rim lip: very thin flat ring at top opening ── */}
      <mesh position={[0, CUP_H / 2, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[CUP_TOP_R - 0.010, CUP_TOP_R + 0.004, CUP_SEGS]} />
        <meshStandardMaterial color="#b91c1c" roughness={0.3} metalness={0.15} />
      </mesh>
    </group>
  );
}

// ── Ball + shadow ─────────────────────────────────────────────────────────────
type BallPhase = 'idle' | 'flying' | 'entering' | 'result';

interface BallState {
  phase: BallPhase;
  elapsed: number;
  /** Raw 3D landing point (power-scaled, where ball arc terminates). */
  targetPos: THREE.Vector3;
  /** Cup center XZ — ball converges here during the 'entering' descent. */
  cupCenterPos: THREE.Vector3;
  targetCupId: number;
  isHit: boolean;
  flightDuration: number;   // seconds — shorter for fast throws, longer for weak
  arcHeight: number;        // world units — low flat arc for weak, high arc for strong
}

const BallRenderer = forwardRef<
  SceneHandle,
  { cups: Cup[]; onLanded: (hit: boolean) => void }
>(({ cups, onLanded }, ref) => {
  const ballRef    = useRef<THREE.Mesh>(null!);
  const shadowRef  = useRef<THREE.Mesh>(null!);
  const stateRef   = useRef<BallState>({
    phase: 'idle', elapsed: 0,
    targetPos: BALL_START.clone(), cupCenterPos: BALL_START.clone(),
    targetCupId: -1, isHit: false,
    flightDuration: FLIGHT_S, arcHeight: ARC_HEIGHT,
  });
  const resultRef   = useRef<{ hit: boolean; cupId: number } | null>(null);
  const onLandedRef = useRef(onLanded);
  // Pre-seed with cups already removed (reconnect / spectator join mid-game).
  // During active play we ONLY add to sinkSet from the 'entering' phase so the
  // cup never flies away before the ball physically lands inside it.
  const [sinkSet, setSinkSet] = useState<Set<number>>(
    () => new Set(cups.filter(c => c.removed).map(c => c.id)),
  );

  useEffect(() => { onLandedRef.current = onLanded; }, [onLanded]);

  // ── Sync sinkSet with server state ──────────────────────────────────────
  const prevRemovedCountRef = useRef(0);
  useEffect(() => {
    const removedCount = cups.filter(c => c.removed).length;

    // Rematch: server reset all cups → clear local animation state
    if (removedCount === 0 && prevRemovedCountRef.current > 0) {
      setSinkSet(new Set());
      stateRef.current.phase = 'idle';
      prevRemovedCountRef.current = 0;
      return;
    }
    prevRemovedCountRef.current = removedCount;

    // Safety reconcile: if the ball timed-out and we missed adding a cup to
    // sinkSet, catch it here once the phase is idle so the cup still flies away.
    if (stateRef.current.phase === 'idle') {
      setSinkSet(prev => {
        const next = new Set(prev);
        let changed = false;
        cups.forEach(c => { if (c.removed && !prev.has(c.id)) { next.add(c.id); changed = true; } });
        return changed ? next : prev;
      });
    }
  }, [cups]);

  useImperativeHandle(ref, () => ({
    startFlight(cupId, landingPos, flightDuration = FLIGHT_S, arcHeight = ARC_HEIGHT) {
      if (stateRef.current.phase === 'flying' || stateRef.current.phase === 'entering') return;
      const numRows   = numRowsFromCups(cups);
      const cup       = cups.find(c => c.id === cupId);
      const center3d  = cup ? cupWorldPos(cup, numRows) : landingPos.clone();
      const cupCenter = new THREE.Vector3(center3d.x, CUP_RIM_Y + BALL_R * 0.15, center3d.z);
      const rawLand   = new THREE.Vector3(landingPos.x, CUP_RIM_Y + BALL_R * 0.15, landingPos.z);
      stateRef.current = {
        phase: 'flying', elapsed: 0,
        targetPos: rawLand, cupCenterPos: cupCenter,
        targetCupId: cupId, isHit: false,
        flightDuration, arcHeight,
      };
      resultRef.current = null;
      if (ballRef.current) ballRef.current.position.copy(BALL_START);
    },
    notifyResult(hit, cupId) {
      resultRef.current = { hit, cupId };
    },
  }));

  useFrame((_, dt) => {
    const s = stateRef.current;

    if (s.phase === 'idle') {
      // Ball rests at start position, shadow hidden
      if (ballRef.current) ballRef.current.position.copy(BALL_START);
      if (shadowRef.current) (shadowRef.current.material as THREE.MeshBasicMaterial).opacity = 0;
      return;
    }

    s.elapsed += dt;

    // ── Phase 1: arc flight to cup rim ──────────────────────────────────────
    if (s.phase === 'flying') {
      const raw  = Math.min(s.elapsed / s.flightDuration, 1);
      const ease = easeInOut(raw);
      const x    = lerp(BALL_START.x, s.targetPos.x, ease);
      const z    = lerp(BALL_START.z, s.targetPos.z, ease);
      const arcY = BALL_START.y
        + s.arcHeight * 4 * raw * (1 - raw)
        + (s.targetPos.y - BALL_START.y) * ease;

      if (ballRef.current) ballRef.current.position.set(x, arcY, z);

      const height   = arcY - TABLE_Y;
      const shadowSc = Math.max(0.05, 1 - height / (s.arcHeight * 1.5));
      if (shadowRef.current) {
        shadowRef.current.position.set(x, TABLE_Y + 0.001, z);
        shadowRef.current.scale.setScalar(shadowSc);
        (shadowRef.current.material as THREE.MeshBasicMaterial).opacity = shadowSc * 0.4;
      }

      if (raw >= 1) {
        const result   = resultRef.current;
        const timedOut = s.elapsed > s.flightDuration + 0.50;
        if (result !== null || timedOut) {
          const hit   = result?.hit ?? false;
          const cupId = result?.cupId ?? s.targetCupId;
          s.isHit      = hit;
          s.targetCupId = cupId;
          s.elapsed    = 0;

          if (hit) {
            // Transition to "entering cup" phase
            s.phase = 'entering';
          } else {
            // Miss — bounce off and show result
            s.phase = 'result';
            onLandedRef.current(false);
          }
        }
      }
      return;
    }

    // ── Phase 2a: ball sinks into cup (hit only) ─────────────────────────────
    if (s.phase === 'entering') {
      const raw  = Math.min(s.elapsed / ENTER_S, 1);
      const ease = easeInOut(raw);
      // Smoothly converge from landing point to cup center while descending
      const entryEndY = TABLE_Y + CUP_BOT_R + BALL_R * 0.5;
      const x  = lerp(s.targetPos.x, s.cupCenterPos.x, ease);
      const z  = lerp(s.targetPos.z, s.cupCenterPos.z, ease);
      const ey = lerp(CUP_RIM_Y + BALL_R * 0.15, entryEndY, ease);
      if (ballRef.current) ballRef.current.position.set(x, ey, z);

      // Shadow fades as ball sinks below rim
      if (shadowRef.current) {
        const ss = Math.max(0, (1 - raw) * 0.3);
        (shadowRef.current.material as THREE.MeshBasicMaterial).opacity = ss;
      }

      if (raw >= 1) {
        // Ball is fully inside — now trigger cup fly-away
        setSinkSet(prev => new Set([...prev, s.targetCupId]));
        onLandedRef.current(true);
        s.phase   = 'result';
        s.elapsed = 0;
        // Snap ball back to start (out of sight while cup flies)
        if (ballRef.current) ballRef.current.position.copy(BALL_START);
        if (shadowRef.current) (shadowRef.current.material as THREE.MeshBasicMaterial).opacity = 0;
      }
      return;
    }

    // ── Phase 2b: result wrap-up ─────────────────────────────────────────────
    if (s.phase === 'result') {
      if (s.isHit) {
        // Cup fly-away is playing; ball already snapped to rest. Just wait.
        if (s.elapsed > 0.65) stateRef.current.phase = 'idle';
      } else {
        // Bounce off table surface
        const raw = Math.min(s.elapsed / BOUNCE_S, 1);
        const bx  = s.targetPos.x + raw * 0.5;
        const bz  = s.targetPos.z + raw * 1.3;
        const by  = TABLE_Y + BALL_R + Math.max(0, 0.50 * Math.sin(raw * Math.PI) * (1 - raw * 0.65));
        if (ballRef.current) ballRef.current.position.set(bx, by, bz);
        const ss = Math.max(0, (1 - raw) * 0.5);
        if (shadowRef.current) {
          shadowRef.current.position.set(bx, TABLE_Y + 0.001, bz);
          shadowRef.current.scale.setScalar(ss);
          (shadowRef.current.material as THREE.MeshBasicMaterial).opacity = ss * 0.4;
        }
        if (raw >= 1) stateRef.current.phase = 'idle';
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
          sinking={sinkSet.has(cup.id)}
        />
      ))}

      {/* Ball — always visible; at rest when idle */}
      <mesh ref={ballRef} position={BALL_START} castShadow>
        <sphereGeometry args={[BALL_R, 32, 16]} />
        <meshStandardMaterial color="#f2f2ee" roughness={0.22} metalness={0.04} />
      </mesh>

      {/* Ground shadow */}
      <mesh ref={shadowRef} rotation={[-Math.PI / 2, 0, 0]} position={[0, TABLE_Y + 0.001, 4]}>
        <circleGeometry args={[BALL_R * 1.3, 16]} />
        <meshBasicMaterial color="#000" transparent opacity={0} depthWrite={false} />
      </mesh>
    </>
  );
});
BallRenderer.displayName = 'BallRenderer';

// ── Table ─────────────────────────────────────────────────────────────────────
function Table() {
  return (
    <group>
      <mesh receiveShadow position={[0, TABLE_Y - TABLE_THICK / 2, 0]}>
        <boxGeometry args={[TABLE_HW * 2, TABLE_THICK, TABLE_DEPTH]} />
        <meshStandardMaterial color="#1e6b14" roughness={0.85} metalness={0} />
      </mesh>
      <mesh position={[0, TABLE_Y + 0.002, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[0.03, TABLE_DEPTH * 0.95]} />
        <meshBasicMaterial color="#fff" opacity={0.18} transparent />
      </mesh>
      <mesh position={[0, TABLE_Y + 0.002, 3.5]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.55, 0.58, 32]} />
        <meshBasicMaterial color="#fff" opacity={0.12} transparent />
      </mesh>
    </group>
  );
}

// ── Camera + renderer setup ───────────────────────────────────────────────────
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

// ── Outer: swipe handling + projection ───────────────────────────────────────
export default function GameScene3D({ cups, isMyTurn, onThrow, lastThrow }: Props) {
  const containerRef  = useRef<HTMLDivElement>(null);
  const sweepRef      = useRef<{ x: number; y: number; t: number } | null>(null);
  const sceneRef      = useRef<SceneHandle>(null);
  const localThrowRef = useRef(false);
  const [size, setSize]       = useState({ w: 375, h: 500 });
  const [throwing, setThrowing] = useState(false);
  const [showResult, setShowResult] = useState<'hit' | 'miss' | null>(null);

  // Result fires via onLanded — only after ball physically reaches cup
  const onLanded = useCallback((hit: boolean) => {
    setShowResult(hit ? 'hit' : 'miss');
    setTimeout(() => setShowResult(null), 1300);
  }, []);

  // Resize observer
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

  // Projection camera (mirrors Canvas camera exactly)
  const projCam = useMemo(() => {
    const cam = new THREE.PerspectiveCamera(CAM_FOV, size.w / size.h, 0.1, 100);
    cam.position.set(...CAM_POS);
    cam.lookAt(new THREE.Vector3(...CAM_TARGET));
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    return cam;
  }, [size.w, size.h]);

  // ── Aim + throw-power computation ───────────────────────────────────────────
  // - Swipe direction: ray-cast onto cup-rim plane → raw 3D landing point.
  // - Throw power: derived from swipe velocity. Weak throws physically fall short
  //   (effective landing scaled toward ball start), so far cups need real effort.
  // - Arc / flight speed: fast swipe = high arc + quick flight; slow = flat + slow.
  // - No aim assist: accuracy is purely how close the landing lands to a cup.
  const computeAim = useCallback((dx: number, dy: number, vel: number) => {
    const d = Math.hypot(dx, dy);
    if (d < MIN_SWIPE) return null;

    // Only accept upward throws: the upward component must be at least 50% of
    // the horizontal component. Prevents sideways flicks from registering.
    if (dy > -Math.abs(dx) * 0.5) return null;

    const dir   = { x: dx / d, y: dy / d };
    const avail = cups.filter(c => !c.removed);
    if (!avail.length) return null;
    const numRows = numRowsFromCups(cups);
    const { w, h } = size;

    const b2d    = project2D(BALL_START, projCam, w, h);
    const rawLnd = swipeRayToPlane(dir, b2d, projCam, w, h, CUP_RIM_Y);
    if (!rawLnd) return null;

    // Quadratic velocity → power curve (exponent 2.0).
    // Unlike sub-linear curves, quadratic gives small gains for small speed
    // increases and large gains only when you really commit to the throw.
    // This creates granular, predictable control across the full velocity range:
    //   0.18 px/ms →  0%   0.80 → 13%   1.20 → 33%
    //   1.40 px/ms → 46%   1.60 → 61%   1.80 → 77%   2.00 → 100%
    const throwPower = Math.min(1, Math.max(0,
      Math.pow((vel - MIN_VEL) / (MAX_VEL - MIN_VEL), 2.0),
    ));

    // Distance scales linearly with power — no hidden multipliers.
    const effX = lerp(BALL_START.x, rawLnd.x, throwPower);
    const effZ = lerp(BALL_START.z, rawLnd.z, throwPower);

    // Nearest cup to the power-adjusted landing
    let best = avail[0], bestDist = Infinity;
    for (const cup of avail) {
      const cp   = cupWorldPos(cup, numRows);
      const dist = Math.hypot(effX - cp.x, effZ - cp.z);
      if (dist < bestDist) { bestDist = dist; best = cup; }
    }

    // Geometric accuracy — dead center = 1.0, rim edge = 0, outside = 0
    const accuracy = Math.max(0, 1 - bestDist / CUP_TOP_R);

    // Physics driven by power: weak = flat slow arc, strong = high fast arc
    const flightDuration = lerp(1.40, 0.60, throwPower);
    const arcHeight      = lerp(0.85, 2.70, throwPower);

    return {
      cup: best, accuracy,
      targetPos: new THREE.Vector3(effX, CUP_RIM_Y, effZ),
      flightDuration, arcHeight,
    };
  }, [cups, projCam, size]);

  // ── Spectator ball animation ─────────────────────────────────────────────
  const prevThrowRef = useRef<typeof lastThrow>(null);
  useEffect(() => {
    if (!lastThrow || lastThrow === prevThrowRef.current) return;
    prevThrowRef.current = lastThrow;

    const numRows   = numRowsFromCups(cups);
    const targetCup = cups.find(c => c.id === lastThrow.cupId);
    if (!targetCup) return;
    const targetPos = cupWorldPos(targetCup, numRows);

    if (!localThrowRef.current) {
      // This player is a spectator — start the animation now
      sceneRef.current?.startFlight(lastThrow.cupId, targetPos);
    }
    // Both thrower and spectator: queue the outcome (consumed when ball lands)
    sceneRef.current?.notifyResult(lastThrow.hit, lastThrow.cupId);
    localThrowRef.current = false;
  }, [lastThrow, cups]);

  // ── Swipe handlers ───────────────────────────────────────────────────────
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
    const vel = Math.hypot(dx, dy) / dt;
    if (vel < MIN_VEL) return;

    const aim = computeAim(dx, dy, vel);
    if (!aim) return;

    localThrowRef.current = true;
    setThrowing(true);
    sceneRef.current?.startFlight(aim.cup.id, aim.targetPos, aim.flightDuration, aim.arcHeight);
    onThrow(aim.cup.id, aim.accuracy);

    setTimeout(() => setThrowing(false), (aim.flightDuration + ENTER_S + BOUNCE_S + 0.5) * 1000);
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

      {/* Result flash — fires via onLanded, only when ball reaches cup */}
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
