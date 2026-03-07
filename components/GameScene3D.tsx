'use client';

import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import {
  useRef, useState, useCallback, useMemo, useEffect,
  forwardRef, useImperativeHandle,
} from 'react';
import { Cup } from '@/types/game';

// ── Scene geometry constants ──────────────────────────────────────────────────
const TABLE_HW     = 2.0;    // table half-width
const TABLE_DEPTH  = 11.0;   // table total depth
const TABLE_THICK  = 0.10;
const TABLE_Y      = 0;

const CUP_FAR_Z    = -3.4;   // farthest row Z (row 0)
const CUP_NEAR_Z   = -1.0;   // closest row Z  (row numRows-1)
const CUP_SPACING  = 0.52;
const CUP_H        = 0.46;
const CUP_TOP_R    = 0.185;
const CUP_BOT_R    = 0.115;
const CUP_SEGS     = 20;

const BALL_R       = 0.105;
const BALL_START   = new THREE.Vector3(0, TABLE_Y + BALL_R + 0.01, 4.0);
const ARC_HEIGHT   = 2.3;
const FLIGHT_S     = 0.85;   // seconds
const BOUNCE_S     = 0.60;

const CAM_POS      = [0, 2.5, 5.8] as const;
const CAM_TARGET   = [0, 0.15, -1.0] as const;
const CAM_FOV      = 58;

const MIN_SWIPE    = 18;     // px
const MIN_VEL      = 0.10;   // px/ms

// ── Props ─────────────────────────────────────────────────────────────────────
interface Props {
  cups: Cup[];
  isMyTurn: boolean;
  onThrow: (cupId: number, accuracy: number) => void;
  lastResult?: 'hit' | 'miss' | null;
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

// ── Scene handle (exposed to outer swipe layer) ───────────────────────────────
interface SceneHandle {
  startFlight: (targetCupId: number, targetPos: THREE.Vector3) => void;
  notifyResult: (hit: boolean, cupId: number) => void;
}

// ── Individual animated cup ───────────────────────────────────────────────────
function CupMesh({ pos, sinking }: { pos: THREE.Vector3; sinking: boolean }) {
  const groupRef = useRef<THREE.Group>(null!);
  const flyT     = useRef(0);

  useFrame((_, dt) => {
    if (!sinking || !groupRef.current) return;
    flyT.current = Math.min(flyT.current + dt / 0.55, 1);
    const t = flyT.current;
    const side = Math.random() > 0.5 ? 1 : -1; // set once, jitter is fine
    groupRef.current.position.set(
      pos.x + side * t * 1.4,
      pos.y + Math.sin(t * Math.PI) * 0.9 - t * 0.3,
      pos.z + t * 0.5,
    );
    groupRef.current.rotation.z = side * t * Math.PI * 1.2;
    groupRef.current.scale.setScalar(1 - t * 0.9);
  });

  return (
    <group ref={groupRef} position={pos}>
      {/* Main body */}
      <mesh castShadow>
        <cylinderGeometry args={[CUP_TOP_R, CUP_BOT_R, CUP_H, CUP_SEGS]} />
        <meshStandardMaterial color="#dc2626" roughness={0.45} metalness={0.08} />
      </mesh>
      {/* Rim ring */}
      <mesh position={[0, CUP_H / 2, 0]}>
        <torusGeometry args={[CUP_TOP_R, 0.013, 8, CUP_SEGS]} />
        <meshStandardMaterial color="#b91c1c" roughness={0.3} metalness={0.2} />
      </mesh>
      {/* Interior (dark opening) */}
      <mesh position={[0, CUP_H / 2 - 0.01, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[CUP_TOP_R - 0.015, CUP_SEGS]} />
        <meshStandardMaterial color="#7f1d1d" roughness={1} />
      </mesh>
      {/* Bottom disc */}
      <mesh position={[0, -CUP_H / 2, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <circleGeometry args={[CUP_BOT_R, CUP_SEGS]} />
        <meshStandardMaterial color="#b91c1c" roughness={0.5} />
      </mesh>
    </group>
  );
}

// ── Ball + shadow ─────────────────────────────────────────────────────────────
interface BallState {
  phase: 'idle' | 'flying' | 'result';
  elapsed: number;
  targetPos: THREE.Vector3;
  isHit: boolean;
}

const BallRenderer = forwardRef<SceneHandle, { cups: Cup[] }>(({ cups }, ref) => {
  const ballRef    = useRef<THREE.Mesh>(null!);
  const shadowRef  = useRef<THREE.Mesh>(null!);
  const stateRef   = useRef<BallState>({
    phase: 'idle', elapsed: 0,
    targetPos: BALL_START.clone(), isHit: false,
  });
  const resultRef  = useRef<{ hit: boolean; cupId: number } | null>(null);
  const [sinkSet, setSinkSet] = useState<Set<number>>(new Set());

  useImperativeHandle(ref, () => ({
    ballRef,
    startFlight(targetCupId, targetPos) {
      stateRef.current = {
        phase: 'flying',
        elapsed: 0,
        targetPos: targetPos.clone(),
        isHit: false,
      };
      resultRef.current = null;
      if (ballRef.current) {
        ballRef.current.position.copy(BALL_START);
        ballRef.current.visible = true;
      }
    },
    notifyResult(hit, cupId) {
      resultRef.current = { hit, cupId };
    },
  }));

  useFrame((_, dt) => {
    const s = stateRef.current;
    if (s.phase === 'idle') return;

    s.elapsed += dt;

    if (s.phase === 'flying') {
      const raw  = Math.min(s.elapsed / FLIGHT_S, 1);
      const ease = easeInOut(raw);
      const x    = lerp(BALL_START.x, s.targetPos.x, ease);
      const z    = lerp(BALL_START.z, s.targetPos.z, ease);
      const arcY = BALL_START.y + ARC_HEIGHT * 4 * raw * (1 - raw)
                 + (s.targetPos.y - BALL_START.y) * ease;

      if (ballRef.current)   ballRef.current.position.set(x, arcY, z);

      // Shadow on table
      const shadowScale = Math.max(0.1, 1 - (arcY - TABLE_Y) / (ARC_HEIGHT * 1.4));
      if (shadowRef.current) {
        shadowRef.current.position.set(x, TABLE_Y + 0.001, z);
        shadowRef.current.scale.setScalar(shadowScale);
        (shadowRef.current.material as THREE.MeshBasicMaterial).opacity = shadowScale * 0.45;
      }

      if (raw >= 1) {
        // Wait for server result or timeout
        const result = resultRef.current;
        if (result !== null) {
          s.isHit    = result.hit;
          s.phase    = 'result';
          s.elapsed  = 0;
          if (result.hit) {
            setSinkSet(prev => new Set([...prev, result.cupId]));
            if (ballRef.current) ballRef.current.visible = false;
          }
        } else if (s.elapsed > FLIGHT_S + 0.15) {
          // Timeout — assume miss
          s.isHit   = false;
          s.phase   = 'result';
          s.elapsed = 0;
        }
      }
      return;
    }

    if (s.phase === 'result') {
      if (s.isHit) {
        // Ball already hidden; just wait for animation to finish
        if (s.elapsed > 0.6) {
          stateRef.current.phase = 'idle';
          if (ballRef.current) ballRef.current.visible = false;
          if (shadowRef.current) (shadowRef.current.material as THREE.MeshBasicMaterial).opacity = 0;
        }
      } else {
        // Bounce animation
        const raw = Math.min(s.elapsed / BOUNCE_S, 1);
        const bx  = s.targetPos.x + (raw * 0.5);
        const bz  = s.targetPos.z + (raw * 1.2);
        const by  = TABLE_Y + BALL_R + Math.max(0,
          0.55 * Math.sin(raw * Math.PI) * (1 - raw * 0.6),
        );
        if (ballRef.current) ballRef.current.position.set(bx, by, bz);
        if (shadowRef.current) {
          const ss = Math.max(0, 0.7 - raw * 0.7);
          shadowRef.current.position.set(bx, TABLE_Y + 0.001, bz);
          shadowRef.current.scale.setScalar(ss);
          (shadowRef.current.material as THREE.MeshBasicMaterial).opacity = ss * 0.45;
        }
        if (raw >= 1) {
          stateRef.current.phase = 'idle';
          if (ballRef.current) ballRef.current.visible = false;
          if (shadowRef.current) (shadowRef.current.material as THREE.MeshBasicMaterial).opacity = 0;
        }
      }
    }
  });

  const numRows = numRowsFromCups(cups);

  return (
    <>
      {/* Cups */}
      {cups.map(cup => (
        <CupMesh
          key={cup.id}
          pos={cupWorldPos(cup, numRows)}
          sinking={sinking(cup.id, sinkSet, cup.removed)}
        />
      ))}

      {/* Ball sphere */}
      <mesh ref={ballRef} position={BALL_START} castShadow visible={false}>
        <sphereGeometry args={[BALL_R, 32, 16]} />
        <meshStandardMaterial
          color="#f0f0f0"
          roughness={0.25}
          metalness={0.05}
          envMapIntensity={0.5}
        />
      </mesh>

      {/* Ball shadow on table surface */}
      <mesh ref={shadowRef} rotation={[-Math.PI / 2, 0, 0]} position={[0, TABLE_Y + 0.001, 0]}>
        <circleGeometry args={[BALL_R * 1.2, 16]} />
        <meshBasicMaterial color="#000" transparent opacity={0} depthWrite={false} />
      </mesh>
    </>
  );
});
BallRenderer.displayName = 'BallRenderer';

// Helper: should a cup fly?
function sinking(id: number, set: Set<number>, removed: boolean) {
  return set.has(id) || removed;
}

// ── Table ─────────────────────────────────────────────────────────────────────
function Table() {
  return (
    <group>
      {/* Table surface */}
      <mesh receiveShadow position={[0, TABLE_Y - TABLE_THICK / 2, 0]}>
        <boxGeometry args={[TABLE_HW * 2, TABLE_THICK, TABLE_DEPTH]} />
        <meshStandardMaterial color="#1e6b14" roughness={0.85} metalness={0} />
      </mesh>
      {/* Center line */}
      <mesh position={[0, TABLE_Y + 0.002, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[0.03, TABLE_DEPTH * 0.95]} />
        <meshBasicMaterial color="#ffffff" opacity={0.18} transparent />
      </mesh>
      {/* Near-side circle (player end) */}
      <mesh position={[0, TABLE_Y + 0.002, 3.5]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.55, 0.58, 32]} />
        <meshBasicMaterial color="#ffffff" opacity={0.12} transparent />
      </mesh>
    </group>
  );
}

// ── Camera setup inside Canvas ────────────────────────────────────────────────
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

// ── Main scene contents ───────────────────────────────────────────────────────
const SceneContents = forwardRef<SceneHandle, { cups: Cup[] }>(({ cups }, ref) => {
  return (
    <>
      <SceneSetup />
      {/* Lighting */}
      <ambientLight intensity={0.55} />
      <directionalLight
        intensity={1.1}
        position={[2, 6, 4]}
        castShadow
        shadow-mapSize={[1024, 1024]}
        shadow-camera-near={0.1}
        shadow-camera-far={30}
        shadow-camera-left={-5}
        shadow-camera-right={5}
        shadow-camera-top={5}
        shadow-camera-bottom={-5}
      />
      <pointLight intensity={0.3} position={[-2, 3, 2]} color="#fff8e1" />
      <Table />
      <BallRenderer ref={ref} cups={cups} />
    </>
  );
});
SceneContents.displayName = 'SceneContents';

// ── Outer: swipe handling + canvas ───────────────────────────────────────────
export default function GameScene3D({ cups, isMyTurn, onThrow, lastResult }: Props) {
  const containerRef   = useRef<HTMLDivElement>(null);
  const sweepRef       = useRef<{ x: number; y: number; t: number } | null>(null);
  const sceneRef       = useRef<SceneHandle>(null);
  const pendingCupRef  = useRef<number | null>(null);
  const [size, setSize] = useState({ w: 375, h: 500 });
  const [throwing, setThrowing] = useState(false);
  const [showResult, setShowResult] = useState<'hit' | 'miss' | null>(null);

  // Track newly removed cups (for syncing sinkSet)
  const prevResultRef = useRef<typeof lastResult>(null);
  useEffect(() => {
    if (lastResult && lastResult !== prevResultRef.current) {
      sceneRef.current?.notifyResult(lastResult === 'hit', pendingCupRef.current ?? -1);
      setShowResult(lastResult);
      setTimeout(() => setShowResult(null), 1400);
    }
    prevResultRef.current = lastResult;
  }, [lastResult]);

  // Resize observer
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      const { width: w, height: h } = entries[0].contentRect;
      setSize({ w, h });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Build a projection camera matching the scene camera (for swipe accuracy)
  const projCam = useMemo(() => {
    const cam = new THREE.PerspectiveCamera(CAM_FOV, size.w / size.h, 0.1, 100);
    cam.position.set(...CAM_POS);
    cam.lookAt(new THREE.Vector3(...CAM_TARGET));
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    return cam;
  }, [size.w, size.h]);

  // Compute aim target from swipe vector
  const computeAim = useCallback((dx: number, dy: number) => {
    const d = Math.hypot(dx, dy);
    if (d < MIN_SWIPE) return null;
    const dir  = { x: dx / d, y: dy / d };
    const avail = cups.filter(c => !c.removed);
    if (!avail.length) return null;
    const numRows = numRowsFromCups(cups);
    const { w, h } = size;

    // 2D screen pos of ball (swipe origin)
    const b2d = project2D(BALL_START, projCam, w, h);

    let best = avail[0];
    let bestPerp = Infinity;

    for (const cup of avail) {
      const cPos = cupWorldPos(cup, numRows);
      const c2d  = project2D(cPos, projCam, w, h);
      const vx = c2d.x - b2d.x, vy = c2d.y - b2d.y;
      const t  = vx * dir.x + vy * dir.y;
      if (t <= 0) continue;
      const perp = Math.abs(vx * dir.y - vy * dir.x);
      if (perp < bestPerp) { bestPerp = perp; best = cup; }
    }

    // Cup projected width → hit zone sizes
    const bestPos = cupWorldPos(best, numRows);
    const cLeft   = bestPos.clone().sub(new THREE.Vector3(CUP_TOP_R, 0, 0));
    const cRight  = bestPos.clone().add(new THREE.Vector3(CUP_TOP_R, 0, 0));
    const s0 = project2D(cLeft, projCam, w, h);
    const s1 = project2D(cRight, projCam, w, h);
    const rimPx  = Math.abs(s1.x - s0.x) / 2;  // radius of rim in screen px

    const rimR  = rimPx * 0.60;
    const bodyR = rimPx * 1.05;
    const nearR = rimPx * 1.65;

    let accuracy: number;
    if (bestPerp <= rimR) {
      accuracy = 0.82 + (1 - bestPerp / rimR) * 0.18;
    } else if (bestPerp <= bodyR) {
      const t2 = (bestPerp - rimR) / (bodyR - rimR);
      accuracy = 0.82 - Math.pow(t2, 0.65) * 0.62;
    } else if (bestPerp <= nearR) {
      const t2 = (bestPerp - bodyR) / (nearR - bodyR);
      accuracy = 0.20 - t2 * 0.19;
    } else {
      accuracy = 0;
    }

    return { cup: best, accuracy, targetPos: cupWorldPos(best, numRows) };
  }, [cups, projCam, size]);

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

    const aim = computeAim(dx, dy);
    if (!aim) return;

    const powerAcc = Math.min(1, Math.max(0.05, (vel - MIN_VEL) / 0.55));
    const finalAcc = aim.accuracy * 0.85 + powerAcc * 0.15;

    pendingCupRef.current = aim.cup.id;
    setThrowing(true);
    sceneRef.current?.startFlight(aim.cup.id, aim.targetPos);
    onThrow(aim.cup.id, finalAcc);

    setTimeout(() => setThrowing(false), (FLIGHT_S + BOUNCE_S + 0.3) * 1000);
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
        <SceneContents ref={sceneRef} cups={cups} />
      </Canvas>

      {/* Turn overlay */}
      {!isMyTurn && (
        <div className="absolute inset-0 pointer-events-none flex items-end justify-center pb-8">
          <div className="bg-black/50 text-white text-sm px-4 py-2 rounded-full">
            Waiting for opponent…
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

      {/* Hit / miss flash */}
      {showResult && (
        <div
          key={showResult}
          className={`absolute left-1/2 top-1/3 -translate-x-1/2 pointer-events-none
            font-black text-2xl tracking-wider animate-[resultPop_1.4s_ease_forwards]
            ${showResult === 'hit' ? 'text-green-400' : 'text-white/60'}`}
        >
          {showResult === 'hit' ? 'SANK IT' : 'miss'}
        </div>
      )}
    </div>
  );
}
