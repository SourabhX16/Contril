/**
 * WAVE DASH — Cel-Shaded Arcade Boat Racer
 * main.ts — game bootstrap and main loop
 *
 * Changes from v1:
 * - Pre-allocated racing line geometry (zero GC in update)
 * - No per-frame allocations (reusable vectors)
 * - Pause/resume support (P key)
 * - Camera receives drift/steer state
 * - Audio receives drift state + new events
 * - Proper landing camera dip + impact sound
 * - Checkpoint and lap audio events
 */

import * as THREE from 'three';
import { Engine } from './core/Engine';
import { AudioSystem } from './core/AudioSystem';
import { WaterSystem } from './rendering/WaterSystem';
import { Sky } from './rendering/Sky';
import { CelPipeline } from './rendering/CelPipeline';
import { Boat, type BoatInput } from './entities/Boat';
import { Course } from './race/Course';
import { RaceManager } from './race/RaceManager';
import { AIRacer, type AIPersonality } from './race/AIRacer';
import { ChaseCamera } from './camera/ChaseCamera';
import { HUD } from './hud/HUD';
import { sampleGerstnerHeight } from './physics/WaveQuery';

// ─── CONSTANTS ───────────────────────────────────────────────────────────────
const BOAT_CONFIGS = [
  { color: new THREE.Color(0xff4040), accent: new THREE.Color(0xffffff), name: 'PLAYER' },
  { color: new THREE.Color(0x40ff80), accent: new THREE.Color(0x003322), name: 'BLAZE' },
  { color: new THREE.Color(0xffd700), accent: new THREE.Color(0x332200), name: 'NOVA' },
  { color: new THREE.Color(0xc040ff), accent: new THREE.Color(0x1a0030), name: 'VORTEX' },
];

const AI_PERSONALITIES: AIPersonality[] = ['aggressive', 'clean', 'erratic'];

// ─── SETUP ───────────────────────────────────────────────────────────────────
const engine = new Engine();
const audio  = new AudioSystem();
const hud    = new HUD();
const clock  = new THREE.Clock();
let fps = 60;

// Sun direction (shared across all systems)
const SUN_DIR = new THREE.Vector3(0.5, 0.8, 0.3).normalize();

// ─── SCENE ───────────────────────────────────────────────────────────────────
const scene = engine.scene;
const sky   = new Sky(scene);
const water = new WaterSystem(scene);
const cel   = new CelPipeline(SUN_DIR);

// ─── COURSE ──────────────────────────────────────────────────────────────────
const course = new Course(scene, cel);

// ─── BOATS ───────────────────────────────────────────────────────────────────
const GRID_OFFSETS: [number, number][] = [
  [0, 0], [3, -2], [-3, -2], [0, -5],
];

const boats: Boat[] = [];
const startTransform = course.getStartTransform();
const startDir = startTransform.direction;
const startPos = startTransform.position;
const startHeading = Math.atan2(startDir.x, startDir.z);

BOAT_CONFIGS.forEach((cfg, i) => {
  const [ox, oz] = GRID_OFFSETS[i];
  const right = new THREE.Vector3(-startDir.z, 0, startDir.x);
  const pos = startPos.clone()
    .addScaledVector(right, ox)
    .addScaledVector(startDir, oz);
  pos.y = sampleGerstnerHeight(pos.x, pos.z, 0) + 0.5;

  const boat = new Boat(scene, cel, { hull: cfg.color, accent: cfg.accent }, pos, startHeading);
  boats.push(boat);
});

const playerBoat = boats[0];

// ─── RACE MANAGER ────────────────────────────────────────────────────────────
const race = new RaceManager(course);
boats.forEach((boat, i) => race.addRacer(boat, BOAT_CONFIGS[i].name));

// ─── AI RACERS ───────────────────────────────────────────────────────────────
const aiRacers: AIRacer[] = AI_PERSONALITIES.map((personality, i) =>
  new AIRacer(boats[i + 1], personality, course, 0)
);

// ─── CAMERA ──────────────────────────────────────────────────────────────────
const camera = new ChaseCamera(window.innerWidth / window.innerHeight);
camera.startOrbit(playerBoat.root.position);

// ─── INPUT ───────────────────────────────────────────────────────────────────
const keys: Record<string, boolean> = {};
let paused = false;

window.addEventListener('keydown', (e) => {
  keys[e.code] = true;
  audio.resume();
  if (e.code === 'KeyR' && race.phase === 'finished') location.reload();
  if (e.code === 'KeyP' && race.phase === 'racing') {
    paused = !paused;
    if (paused) clock.stop();
    else clock.start();
  }
});
window.addEventListener('keyup', (e) => { keys[e.code] = false; });

function getPlayerInput(): BoatInput {
  return {
    throttle: (keys['ArrowUp']    || keys['KeyW']) ? 1 : 0,
    brake:    (keys['ArrowDown']  || keys['KeyS']) ? 1 : 0,
    steer:    ((keys['ArrowRight'] || keys['KeyD']) ? 1 : 0)
            - ((keys['ArrowLeft']  || keys['KeyA']) ? 1 : 0),
    drift:    !!(keys['ShiftLeft'] || keys['ShiftRight'] || keys['Space']),
  };
}

// ─── GAME STATE ───────────────────────────────────────────────────────────────
let orbitDone = false;
let boostWasActive = false;
let lastAirTime = 0;
let frameCount = 0;
let lastFPSTime = 0;
let lastCheckpointIdx = -1;
let finishSoundPlayed = false;

// ─── REUSABLE VECTORS (zero per-frame allocation) ─────────────────────────
const _orbitCenter = new THREE.Vector3();

// ─── RACING LINE (pre-allocated buffers) ──────────────────────────────────
const RACING_LINE_SEGMENTS = 150;
const rlPositions = new Float32Array((RACING_LINE_SEGMENTS + 1) * 2 * 3);
const rlIndices   = new Uint16Array(RACING_LINE_SEGMENTS * 6);
const rlPosAttr   = new THREE.BufferAttribute(rlPositions, 3);
rlPosAttr.setUsage(THREE.DynamicDrawUsage);

// Pre-build index buffer (static)
for (let i = 0; i < RACING_LINE_SEGMENTS; i++) {
  const b = i * 2;
  const idx = i * 6;
  rlIndices[idx]     = b;
  rlIndices[idx + 1] = b + 1;
  rlIndices[idx + 2] = b + 2;
  rlIndices[idx + 3] = b + 1;
  rlIndices[idx + 4] = b + 3;
  rlIndices[idx + 5] = b + 2;
}
course.racingLineMesh.geometry.setAttribute('position', rlPosAttr);
course.racingLineMesh.geometry.setIndex(new THREE.BufferAttribute(rlIndices, 1));

// Pre-compute curve points and tangents for racing line (static per curve)
const rlCurvePoints: THREE.Vector3[] = [];
const rlCurveRights: THREE.Vector3[] = [];
const RIBBON_WIDTH = 1.2;

for (let i = 0; i <= RACING_LINE_SEGMENTS; i++) {
  const t = i / RACING_LINE_SEGMENTS;
  rlCurvePoints.push(course.curve.getPoint(t));
  const tangent = course.curve.getTangent(t);
  rlCurveRights.push(new THREE.Vector3(-tangent.z, 0, tangent.x).normalize());
}

function updateRacingLine(time: number): void {
  for (let i = 0; i <= RACING_LINE_SEGMENTS; i++) {
    const point = rlCurvePoints[i];
    const right = rlCurveRights[i];

    const lx = point.x - right.x * RIBBON_WIDTH * 0.5;
    const lz = point.z - right.z * RIBBON_WIDTH * 0.5;
    const rx = point.x + right.x * RIBBON_WIDTH * 0.5;
    const rz = point.z + right.z * RIBBON_WIDTH * 0.5;

    const vi = i * 6;
    rlPositions[vi]     = lx;
    rlPositions[vi + 1] = sampleGerstnerHeight(lx, lz, time) + 0.12;
    rlPositions[vi + 2] = lz;
    rlPositions[vi + 3] = rx;
    rlPositions[vi + 4] = sampleGerstnerHeight(rx, rz, time) + 0.12;
    rlPositions[vi + 5] = rz;
  }
  rlPosAttr.needsUpdate = true;
}

// ─── MAIN LOOP ────────────────────────────────────────────────────────────────
function gameLoop(): void {
  requestAnimationFrame(gameLoop);

  if (paused) return;

  const dt = Math.min(clock.getDelta(), 0.05);
  const time = clock.elapsedTime;

  // FPS tracking + adaptive pixel ratio
  frameCount++;
  if (time - lastFPSTime > 0.5) {
    fps = frameCount / (time - lastFPSTime);
    frameCount = 0;
    lastFPSTime = time;
    engine.adaptPixelRatio(fps);
  }

  // ─── COUNTDOWN ORBIT ──────────────
  if (race.phase === 'countdown') {
    _orbitCenter.copy(playerBoat.root.position);
    _orbitCenter.y += 2;
    camera.startOrbit(_orbitCenter);
    race.update(dt);

    if (race.countdownValue <= 0 && !orbitDone) {
      orbitDone = true;
      camera.stopOrbit();
      audio.init();
      audio.playStartHorn();
    }
  }

  // ─── RACING ──────────────────────
  if (race.phase === 'racing' || race.phase === 'finished') {
    const input = race.phase === 'racing'
      ? getPlayerInput()
      : { throttle: 0.05, brake: 0, steer: 0, drift: false };

    playerBoat.update(dt, input, time);

    // Audio — engine + drift
    audio.updateEngine(playerBoat.speed, input.throttle, playerBoat.isAirborne, playerBoat.isDrifting);

    // Landing impact
    const wasAirborne = lastAirTime > 0.4;
    if (wasAirborne && !playerBoat.isAirborne) {
      const impact = Math.min(lastAirTime * 0.8, 1.5);
      camera.triggerShake(impact);
      camera.triggerLandingDip(impact);
      audio.playImpact(impact);
    }
    lastAirTime = playerBoat.isAirborne ? playerBoat.airTime : 0;

    // Boost audio
    if (playerBoat.boostTimer > 0 && !boostWasActive) audio.playBoost();
    boostWasActive = playerBoat.boostTimer > 0;

    // Checkpoint audio
    if (race.lastCheckpointHit >= 0 && race.lastCheckpointHit !== lastCheckpointIdx) {
      audio.playCheckpoint();
      lastCheckpointIdx = race.lastCheckpointHit;
    }

    // Lap complete audio
    if (race.lastLapCompleted) {
      audio.playLapComplete();
    }

    // AI
    if (race.phase === 'racing') {
      const playerState = race.getState(playerBoat);
      const playerProgress = playerState?.totalProgress ?? 0;

      aiRacers.forEach((ai, i) => {
        const aiState = race.getState(boats[i + 1]);
        const aiProgress = aiState?.totalProgress ?? 0;
        const aiInput = ai.update(dt, time, playerProgress, aiProgress, boats);
        boats[i + 1].update(dt, aiInput, time);
      });
    }

    race.update(dt);

    // Celebrate finish
    if (race.phase === 'finished') {
      boats.forEach(b => b.celebrate());
      if (!finishSoundPlayed) {
        audio.playFinish();
        finishSoundPlayed = true;
      }
      _orbitCenter.copy(playerBoat.root.position);
      _orbitCenter.y += 2;
      camera.startOrbit(_orbitCenter);
    }
  }

  // ─── CAMERA ──────────────────────
  camera.update(
    dt,
    playerBoat.root.position,
    playerBoat.heading,
    playerBoat.speed,
    playerBoat.isDrifting,
    getPlayerInput().steer
  );
  const camPos = camera.camera.position;

  // ─── SCENE UPDATES ───────────────
  water.update(time, camPos);
  sky.update(time, camPos);
  course.update(time);
  updateRacingLine(time);
  cel.updateCamPos(scene, camPos);

  // ─── RENDER ──────────────────────
  engine.renderer.render(scene, camera.camera);

  // ─── HUD ─────────────────────────
  const playerState2 = race.getState(playerBoat);
  const wrongWay = race.phase === 'racing'
    ? course.isWrongWay(playerBoat.root.position, playerBoat.velocity)
    : false;
  hud.draw(dt, race, playerBoat, playerState2, course, boats, wrongWay);
}

// ─── START ───────────────────────────────────────────────────────────────────
window.addEventListener('resize', () => {
  camera.onResize(window.innerWidth / window.innerHeight);
});

// Hide loading screen on first render
const loadingEl = document.getElementById('loading');
let firstFrame = true;
(function startGame() {
  const dt = clock.getDelta();
  const time = clock.elapsedTime;
  water.update(time, new THREE.Vector3(0, 10, 0));
  sky.update(time, new THREE.Vector3(0, 10, 0));
  engine.renderer.render(scene, camera.camera);

  if (firstFrame && loadingEl) {
    firstFrame = false;
    loadingEl.style.transition = 'opacity 0.5s';
    loadingEl.style.opacity = '0';
    setTimeout(() => { loadingEl.style.display = 'none'; }, 600);
  }

  requestAnimationFrame(gameLoop);
})();
