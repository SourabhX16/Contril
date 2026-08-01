import * as THREE from 'three';
import { CelPipeline } from '../rendering/CelPipeline';
import { sampleGerstnerHeight, sampleGerstnerNormal, sampleWaveSlope } from '../physics/WaveQuery';
import { Rider } from './Rider';

// ─── HULL SAMPLE POINTS ──────────────────────────────────────────────────────
// 5 local XZ offsets from boat center for multi-point buoyancy
const HULL_POINTS: [number, number][] = [
  [ 0,    0.6],  // bow
  [ 0,   -0.6],  // stern
  [ 0.3,  0  ],  // starboard mid
  [-0.3,  0  ],  // port mid
  [ 0,    0  ],  // center
];
const HULL_COUNT = HULL_POINTS.length;

// ─── PHYSICS CONSTANTS ───────────────────────────────────────────────────────
// All damping values are expressed as the per-second decay factor.
// Applied as: value *= Math.pow(factor, dt) — frame-rate independent.
const BUOYANCY_STIFFNESS = 160;
const BUOYANCY_DAMPING   = 20;

// Damping per second (lower = more drag). At 60fps, pow(0.005, 1/60) ≈ 0.92
const DRAG_LINEAR_PS     = 0.005;    // horizontal velocity decay/second
const DRAG_ANGULAR_PS    = 0.0005;   // angular velocity decay/second
const DRAG_VERTICAL_PS   = 0.04;     // vertical velocity decay/second

const ENGINE_FORCE       = 95;
const BRAKE_FORCE        = 65;
const MAX_SPEED          = 34;
const GRAVITY            = 20;       // m/s² while airborne

// Steering
const STEER_TORQUE       = 2.8;      // base turning torque
const STEER_SPEED_FALLOFF = 0.006;   // steering tightens with speed
const COUNTER_STEER_FORCE = 1.2;     // force pushing against oversteering

// Drift
const DRIFT_GRIP         = 0.55;     // lateral grip reduction during drift
const DRIFT_LATERAL_PUSH = 3.5;      // lateral slide momentum when drifting
const DRIFT_MIN_SPEED    = 5;

// Boost
const BOOST_MULTIPLIER   = 1.65;
const BOOST_DURATION     = 2.2;
const DRIFT_BOOST_CHARGE = 1.4;      // seconds of drift for full charge

// Wave riding
const WAVE_RIDE_FORCE    = 6.0;      // bonus force riding downhill on waves

// Throttle response
const THROTTLE_RISE_RATE = 4.0;      // seconds to reach full throttle (smoothed)
const THROTTLE_FALL_RATE = 6.0;      // seconds to release throttle

// ─── EXPORTS ──────────────────────────────────────────────────────────────────

export interface BoatInput {
  throttle: number;   // 0..1
  brake: number;      // 0..1
  steer: number;      // -1..1 (negative = left)
  drift: boolean;
}

export type BoatColor = {
  hull: THREE.Color;
  accent: THREE.Color;
};

// ─── REUSABLE VECTORS (zero allocation in update loop) ────────────────────────
const _tempVec = new THREE.Vector3();
const _wakeRight = new THREE.Vector3();

/**
 * Boat — arcade physics + buoyancy + cel visuals + rider
 *
 * All physics are frame-rate independent:
 * - Forces use dt multiplication
 * - Damping uses exponential decay: pow(decayPerSecond, dt)
 */
export class Boat {
  root: THREE.Group;
  hullGroup: THREE.Group;

  // Physics state
  velocity: THREE.Vector3 = new THREE.Vector3();
  angularVelocity = 0;   // world Y axis only
  heading = 0;           // radians
  isAirborne = false;
  airTime = 0;
  isDrifting = false;
  driftCharge = 0;
  boostTimer = 0;
  speed = 0;

  // Smoothed throttle for analog feel
  private smoothThrottle = 0;

  // Animation
  private pitchAngle = 0;
  private rollAngle = 0;
  private landingShake = 0;
  private landingCompress = 0; // visual squash on landing

  // Outline meshes for camera-distance scaling
  private outlineMeshes: THREE.Mesh[] = [];
  private rider: Rider;

  // Wake ribbon — pre-allocated buffers
  private readonly WAKE_MAX_POINTS = 80;
  private wakePoints: Float32Array;  // x,y,z per point
  private wakeCount = 0;
  private wakeMesh: THREE.Mesh;
  private wakeGeo: THREE.BufferGeometry;
  private wakePosAttr: THREE.BufferAttribute;
  private wakeIndexArray: Uint16Array;

  constructor(
    scene: THREE.Scene,
    cel: CelPipeline,
    colors: BoatColor,
    startPos: THREE.Vector3,
    startHeading: number
  ) {
    this.root = new THREE.Group();
    this.hullGroup = new THREE.Group();
    this.root.add(this.hullGroup);
    this.heading = startHeading;
    this.root.position.copy(startPos);

    this.buildHull(cel, colors);
    this.rider = new Rider(cel, colors.hull);
    this.rider.root.position.set(0, 0.55, -0.1);
    this.hullGroup.add(this.rider.root);

    // Pre-allocate wake geometry buffers
    const maxVerts = this.WAKE_MAX_POINTS * 2; // left + right per point
    const maxTris  = (this.WAKE_MAX_POINTS - 1) * 2;
    this.wakePoints = new Float32Array(this.WAKE_MAX_POINTS * 3);

    const posArray = new Float32Array(maxVerts * 3);
    this.wakePosAttr = new THREE.BufferAttribute(posArray, 3);
    this.wakePosAttr.setUsage(THREE.DynamicDrawUsage);

    this.wakeIndexArray = new Uint16Array(maxTris * 3);

    this.wakeGeo = new THREE.BufferGeometry();
    this.wakeGeo.setAttribute('position', this.wakePosAttr);
    this.wakeGeo.setIndex(new THREE.BufferAttribute(this.wakeIndexArray, 1));

    const wakeMat = new THREE.MeshBasicMaterial({
      color: 0xf0f8ff,
      transparent: true,
      opacity: 0.5,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.wakeMesh = new THREE.Mesh(this.wakeGeo, wakeMat);
    this.wakeMesh.frustumCulled = false;
    scene.add(this.wakeMesh);

    scene.add(this.root);
  }

  private buildHull(cel: CelPipeline, colors: BoatColor): void {
    // Main hull — tapered box
    const hullGeo = this.makeHullGeometry();
    const hullMat = cel.createMaterial({ baseColor: colors.hull });
    const hull = new THREE.Mesh(hullGeo, hullMat);
    this.hullGroup.add(hull);
    cel.addOutline(hullGeo, this.hullGroup, 0.07);

    // Cockpit / deck
    const deckGeo = new THREE.BoxGeometry(0.45, 0.14, 0.7);
    const deckMat = cel.createMaterial({ baseColor: colors.accent });
    const deck = new THREE.Mesh(deckGeo, deckMat);
    deck.position.set(0, 0.28, -0.05);
    this.hullGroup.add(deck);
    cel.addOutline(deckGeo, this.hullGroup, 0.04);

    // Engine cowl
    const cowlGeo = new THREE.CylinderGeometry(0.12, 0.15, 0.35, 8);
    const cowlMat = cel.createMaterial({ baseColor: new THREE.Color(0x222233) });
    const cowl = new THREE.Mesh(cowlGeo, cowlMat);
    cowl.position.set(0, 0.28, -0.45);
    cowl.rotation.x = 0.15;
    this.hullGroup.add(cowl);
    cel.addOutline(cowlGeo, this.hullGroup, 0.04);

    // Windshield
    const windGeo = new THREE.BoxGeometry(0.38, 0.18, 0.06);
    const windMat = cel.createMaterial({ baseColor: new THREE.Color(0x88ccff) });
    const wind = new THREE.Mesh(windGeo, windMat);
    wind.position.set(0, 0.45, 0.18);
    wind.rotation.x = -0.3;
    this.hullGroup.add(wind);
  }

  private makeHullGeometry(): THREE.BufferGeometry {
    const points: THREE.Vector2[] = [
      new THREE.Vector2(-0.28, -0.65),
      new THREE.Vector2(-0.32, -0.20),
      new THREE.Vector2(-0.22,  0.50),
      new THREE.Vector2( 0,     0.75),
      new THREE.Vector2( 0.22,  0.50),
      new THREE.Vector2( 0.32, -0.20),
      new THREE.Vector2( 0.28, -0.65),
    ];

    const shape = new THREE.Shape(points);
    shape.lineTo(0, -0.75);
    shape.lineTo(-0.28, -0.65);

    const extrudeSettings: THREE.ExtrudeGeometryOptions = {
      depth: 0.32,
      bevelEnabled: true,
      bevelThickness: 0.04,
      bevelSize: 0.04,
      bevelSegments: 1,
    };
    const geo = new THREE.ExtrudeGeometry(shape, extrudeSettings);
    geo.rotateX(Math.PI / 2);
    geo.rotateY(Math.PI);
    geo.translate(0, -0.08, 0);
    geo.computeVertexNormals();
    return geo;
  }

  update(dt: number, input: BoatInput, time: number): void {
    const worldPos = this.root.position;

    // ─── SMOOTHED THROTTLE (analog response curve) ───
    const targetThrottle = input.throttle;
    if (targetThrottle > this.smoothThrottle) {
      this.smoothThrottle = Math.min(
        this.smoothThrottle + THROTTLE_RISE_RATE * dt,
        targetThrottle
      );
    } else {
      this.smoothThrottle = Math.max(
        this.smoothThrottle - THROTTLE_FALL_RATE * dt,
        targetThrottle
      );
    }

    // ─── BUOYANCY (5-point hull sampling) ───
    const cosH = Math.cos(this.heading);
    const sinH = Math.sin(this.heading);
    let totalBuoyForce = 0;
    let bowHeight = 0, sternHeight = 0;
    let portHeight = 0, starHeight = 0;

    for (let i = 0; i < HULL_COUNT; i++) {
      const lx = HULL_POINTS[i][0];
      const lz = HULL_POINTS[i][1];
      const wx = worldPos.x + lx * cosH - lz * sinH;
      const wz = worldPos.z + lx * sinH + lz * cosH;
      const waveY = sampleGerstnerHeight(wx, wz, time);
      const depth = worldPos.y - waveY;
      const buoyForce = -BUOYANCY_STIFFNESS * depth - BUOYANCY_DAMPING * this.velocity.y;
      totalBuoyForce += buoyForce / HULL_COUNT;

      // Track individual hull point heights for pitch/roll
      if (i === 0) bowHeight = waveY;    // bow
      if (i === 1) sternHeight = waveY;  // stern
      if (i === 2) starHeight = waveY;   // starboard
      if (i === 3) portHeight = waveY;   // port
    }

    // Apply buoyancy
    this.velocity.y += totalBuoyForce * dt;

    // Proper pitch/roll from hull differential heights
    const targetPitch = Math.atan2(bowHeight - sternHeight, 1.2) * 0.6;
    const targetRoll  = Math.atan2(starHeight - portHeight, 0.6) * 0.6;
    // Faster response for snappy wave interaction (lerp rate is frame-independent via dt)
    const tiltSpeed = 1 - Math.pow(0.001, dt);
    this.pitchAngle += (THREE.MathUtils.clamp(targetPitch, -0.4, 0.4) - this.pitchAngle) * tiltSpeed;
    this.rollAngle  += (THREE.MathUtils.clamp(targetRoll,  -0.35, 0.35) - this.rollAngle) * tiltSpeed;

    // ─── AIRBORNE CHECK ───
    const waveAtCenter = sampleGerstnerHeight(worldPos.x, worldPos.z, time);
    const heightAboveWave = worldPos.y - waveAtCenter;
    this.isAirborne = heightAboveWave > 0.35;

    if (this.isAirborne) {
      this.airTime += dt;
      this.velocity.y -= GRAVITY * dt;
    } else {
      if (this.airTime > 0.3) {
        // Landing impact — absorb some horizontal and vertical speed
        this.landingShake = Math.min(this.airTime * 0.6, 1.5);
        this.landingCompress = Math.min(this.airTime * 0.4, 1.0);
        // Dampen velocity on impact
        this.velocity.y *= 0.3;
        const impactDampen = Math.max(0.7, 1.0 - this.airTime * 0.15);
        this.velocity.x *= impactDampen;
        this.velocity.z *= impactDampen;
      }
      this.airTime = 0;
    }

    // Decay landing effects
    this.landingShake    = Math.max(0, this.landingShake - dt * 3);
    this.landingCompress = Math.max(0, this.landingCompress - dt * 4);

    // ─── ENGINE & STEERING ───
    const boostActive = this.boostTimer > 0;
    if (boostActive) this.boostTimer -= dt;

    const fwdX = sinH;
    const fwdZ = cosH;

    // Forward force with acceleration curve
    let force = 0;
    if (!this.isAirborne) {
      if (this.smoothThrottle > 0) {
        // Acceleration curve: more force at low speed, less at high speed (diminishing returns)
        const speedRatio = this.speed / MAX_SPEED;
        const accelCurve = 1.0 - speedRatio * speedRatio * 0.6; // quadratic falloff
        force = ENGINE_FORCE * this.smoothThrottle * accelCurve * (boostActive ? BOOST_MULTIPLIER : 1.0);
      } else if (input.brake > 0) {
        force = -BRAKE_FORCE * input.brake;
      }
    }

    this.velocity.x += fwdX * force * dt;
    this.velocity.z += fwdZ * force * dt;

    // ─── WAVE RIDING MOMENTUM ───
    if (!this.isAirborne && this.speed > 2) {
      const [slopeX, slopeZ] = sampleWaveSlope(worldPos.x, worldPos.z, time);
      // Dot product of forward direction with downhill slope = positive when riding downhill
      const slopeDot = fwdX * slopeX + fwdZ * slopeZ;
      if (slopeDot > 0) {
        this.velocity.x += fwdX * slopeDot * WAVE_RIDE_FORCE * dt;
        this.velocity.z += fwdZ * slopeDot * WAVE_RIDE_FORCE * dt;
      }
    }

    // ─── DRIFT HANDLING ───
    if (input.drift && this.speed > DRIFT_MIN_SPEED && !this.isAirborne) {
      this.isDrifting = true;
      this.driftCharge = Math.min(this.driftCharge + dt, DRIFT_BOOST_CHARGE + 0.5);
    } else {
      if (this.isDrifting) {
        if (this.driftCharge >= DRIFT_BOOST_CHARGE) {
          this.boostTimer = BOOST_DURATION;
        }
        this.driftCharge = 0;
        this.isDrifting = false;
      }
    }

    // ─── STEERING (speed-dependent, frame-rate independent) ───
    const steerAmount = input.steer * STEER_TORQUE / (1.0 + this.speed * STEER_SPEED_FALLOFF);
    if (!this.isAirborne) {
      this.angularVelocity -= steerAmount * dt;

      // Counter-steering force: reduces angular velocity when not actively steering
      if (Math.abs(input.steer) < 0.1 && Math.abs(this.angularVelocity) > 0.001) {
        const counterForce = -this.angularVelocity * COUNTER_STEER_FORCE;
        this.angularVelocity += counterForce * dt;
      }
    }

    // Frame-rate independent angular damping
    this.angularVelocity *= Math.pow(DRAG_ANGULAR_PS, dt);
    this.heading += this.angularVelocity * dt * 60; // scale to match expected rotation rate

    // ─── LATERAL FRICTION (grip vs drift) ───
    const rightX =  cosH;
    const rightZ = -sinH;
    const lateralSpeed = this.velocity.x * rightX + this.velocity.z * rightZ;
    const grip = this.isDrifting ? DRIFT_GRIP : 1.0;
    const lateralDamping = grip * 0.85;
    this.velocity.x -= rightX * lateralSpeed * lateralDamping;
    this.velocity.z -= rightZ * lateralSpeed * lateralDamping;

    // During drift, add visible lateral push for slide feel
    if (this.isDrifting && Math.abs(input.steer) > 0.1) {
      const pushDir = input.steer > 0 ? -1 : 1;
      this.velocity.x += rightX * pushDir * DRIFT_LATERAL_PUSH * dt;
      this.velocity.z += rightZ * pushDir * DRIFT_LATERAL_PUSH * dt;
    }

    // ─── FRAME-RATE INDEPENDENT DRAG ───
    const linearDamp = Math.pow(DRAG_LINEAR_PS, dt);
    this.velocity.x *= linearDamp;
    this.velocity.z *= linearDamp;
    this.velocity.y *= Math.pow(DRAG_VERTICAL_PS, dt);

    // Speed cap
    const hSpeed = Math.sqrt(this.velocity.x ** 2 + this.velocity.z ** 2);
    if (hSpeed > MAX_SPEED) {
      const factor = MAX_SPEED / hSpeed;
      this.velocity.x *= factor;
      this.velocity.z *= factor;
    }
    this.speed = Math.min(hSpeed, MAX_SPEED);

    // ─── APPLY TRANSFORMS ───
    worldPos.x += this.velocity.x * dt;
    worldPos.y += this.velocity.y * dt;
    worldPos.z += this.velocity.z * dt;

    // Clamp above water
    if (worldPos.y < waveAtCenter - 0.1) {
      worldPos.y = waveAtCenter - 0.1;
    }

    this.root.rotation.y = -this.heading;

    // Drift roll feedback + landing compression
    const driftRoll = this.isDrifting ? input.steer * 0.15 : 0;
    const compressY = -this.landingCompress * 0.08;
    this.hullGroup.rotation.x = this.pitchAngle - this.landingCompress * 0.12;
    this.hullGroup.rotation.z = this.rollAngle + driftRoll;

    // Landing shake (applied via slight extra Y offset)
    const shakeY = Math.sin(time * 60) * this.landingShake * 0.05 + compressY;
    this.hullGroup.position.y = shakeY;

    // ─── UPDATE RIDER ───
    const turnInput = input.steer + this.angularVelocity * 2;
    this.rider.update(
      dt, turnInput, this.smoothThrottle, input.brake,
      this.isAirborne, this.isDrifting, waveAtCenter
    );

    // ─── UPDATE WAKE ───
    this.updateWake();
  }

  private updateWake(): void {
    // Shift wake points forward, add new point at stern
    if (this.wakeCount < this.WAKE_MAX_POINTS) {
      this.wakeCount++;
    }

    // Shift all points back by 3 (x,y,z)
    for (let i = (this.wakeCount - 1) * 3; i >= 3; i--) {
      this.wakePoints[i] = this.wakePoints[i - 3];
    }

    // New point at boat's rear
    const sinH = Math.sin(this.heading);
    const cosH = Math.cos(this.heading);
    this.wakePoints[0] = this.root.position.x - sinH * 0.7;
    this.wakePoints[1] = this.root.position.y + 0.05;
    this.wakePoints[2] = this.root.position.z - cosH * 0.7;

    if (this.wakeCount < 3) return;

    // Build wake ribbon — write directly into pre-allocated buffer
    _wakeRight.set(cosH, 0, -sinH);
    const posArr = this.wakePosAttr.array as Float32Array;
    let idxCount = 0;

    for (let i = 0; i < this.wakeCount - 1; i++) {
      const t = i / this.wakeCount;
      const spread = (0.4 + t * 1.2) * this.speed * 0.06;
      const base = i * 3;
      const px = this.wakePoints[base];
      const py = this.wakePoints[base + 1];
      const pz = this.wakePoints[base + 2];

      const vi = i * 6; // 2 verts per point, 3 floats each
      posArr[vi]     = px + _wakeRight.x * spread;
      posArr[vi + 1] = py;
      posArr[vi + 2] = pz + _wakeRight.z * spread;
      posArr[vi + 3] = px - _wakeRight.x * spread;
      posArr[vi + 4] = py;
      posArr[vi + 5] = pz - _wakeRight.z * spread;

      if (i < this.wakeCount - 2) {
        const b = i * 2;
        this.wakeIndexArray[idxCount++] = b;
        this.wakeIndexArray[idxCount++] = b + 1;
        this.wakeIndexArray[idxCount++] = b + 2;
        this.wakeIndexArray[idxCount++] = b + 1;
        this.wakeIndexArray[idxCount++] = b + 3;
        this.wakeIndexArray[idxCount++] = b + 2;
      }
    }

    this.wakePosAttr.needsUpdate = true;
    this.wakeGeo.setDrawRange(0, idxCount);
    (this.wakeGeo.index as THREE.BufferAttribute).needsUpdate = true;

    // Fade wake opacity by speed
    (this.wakeMesh.material as THREE.MeshBasicMaterial).opacity = Math.min(this.speed * 0.025, 0.55);
  }

  get forwardDir(): THREE.Vector3 {
    return _tempVec.set(Math.sin(this.heading), 0, Math.cos(this.heading));
  }

  celebrate(): void {
    this.rider.celebrate();
  }

  dispose(): void {
    this.wakeGeo.dispose();
  }
}
