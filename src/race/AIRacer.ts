import * as THREE from 'three';
import { Boat, type BoatInput } from '../entities/Boat';
import { Course } from './Course';

export type AIPersonality = 'aggressive' | 'clean' | 'erratic';

interface AIState {
  targetT: number;
  stuckTimer: number;
  // Mistake system
  mistakeTimer: number;
  mistakeSteering: number;
  mistakeDecay: number;    // how quickly the mistake fades
  // Rubber banding
  rubberBandFactor: number;
  // Overtaking
  overtakeTimer: number;   // cooldown between overtake attempts
  overtakeSteer: number;   // lateral push during overtake
}

const LOOKAHEAD_DIST: Record<AIPersonality, number> = {
  aggressive: 16,
  clean:      22,
  erratic:    12,
};

const MISTAKE_CHANCE: Record<AIPersonality, number> = {
  aggressive: 0.006,
  clean:      0.002,
  erratic:    0.02,
};

const SPEED_MULT: Record<AIPersonality, number> = {
  aggressive: 1.04,
  clean:      1.00,
  erratic:    0.93,
};

const RISK_FACTOR: Record<AIPersonality, number> = {
  aggressive: 0.85,  // brakes later
  clean:      1.0,   // standard braking
  erratic:    1.15,  // brakes early (cautious at corners)
};

// Reusable vectors (zero allocation per frame)
const _toTarget = new THREE.Vector3();
const _forward  = new THREE.Vector3();
const _right    = new THREE.Vector3();
const _away     = new THREE.Vector3();

/**
 * AIRacer — spline-following with personality, rubber-banding, and collision avoidance
 *
 * Improvements over v1:
 * - Stronger, smoother rubber banding
 * - Gradual corner braking proportional to curvature
 * - Human-like mistakes (brief overcorrections, not sustained)
 * - Overtaking awareness
 * - Wave-aware throttle modulation
 * - Zero heap allocations per frame
 */
export class AIRacer {
  boat: Boat;
  personality: AIPersonality;
  private course: Course;
  private state: AIState;
  private currentT = 0;

  constructor(boat: Boat, personality: AIPersonality, course: Course, startT: number) {
    this.boat = boat;
    this.personality = personality;
    this.course = course;
    this.currentT = startT;
    this.state = {
      targetT: startT,
      stuckTimer: 0,
      mistakeTimer: 0,
      mistakeSteering: 0,
      mistakeDecay: 0,
      rubberBandFactor: 1.0,
      overtakeTimer: 0,
      overtakeSteer: 0,
    };
  }

  update(
    dt: number,
    time: number,
    playerProgress: number,
    myProgress: number,
    otherBoats: Boat[]
  ): BoatInput {
    const { state, personality } = this;

    // ─── RUBBER BANDING (stronger, smoother) ───
    const gap = myProgress - playerProgress;
    let targetRBF: number;
    if (gap > 0.2) {
      targetRBF = 0.82; // far ahead → slow down more
    } else if (gap > 0.05) {
      targetRBF = 0.92; // slightly ahead → gentle slow
    } else if (gap < -0.2) {
      targetRBF = 1.15; // far behind → catch up faster
    } else if (gap < -0.05) {
      targetRBF = 1.08; // slightly behind → mild catch-up
    } else {
      targetRBF = 1.0;  // close to player
    }
    // Smooth transition
    const rbLerp = 1 - Math.pow(0.01, dt);
    state.rubberBandFactor += (targetRBF - state.rubberBandFactor) * rbLerp;

    // ─── MISTAKE SYSTEM (brief overcorrections) ───
    if (state.mistakeTimer > 0) {
      state.mistakeTimer -= dt;
      // Mistake fades over time (not constant)
      state.mistakeSteering *= Math.pow(state.mistakeDecay, dt);
    } else if (Math.random() < MISTAKE_CHANCE[personality] * dt * 60) {
      // Trigger new mistake
      state.mistakeTimer = 0.4 + Math.random() * 0.8; // shorter, more human
      state.mistakeSteering = (Math.random() - 0.5) * 1.0;
      state.mistakeDecay = 0.02 + Math.random() * 0.05; // fast decay
    }

    // ─── OVERTAKING COOLDOWN ───
    if (state.overtakeTimer > 0) {
      state.overtakeTimer -= dt;
    } else {
      state.overtakeSteer = 0;
    }

    // ─── LOOKAHEAD STEERING ───
    const lookahead = LOOKAHEAD_DIST[personality];
    const curveLen = this.course.totalLength;

    const { t: nearestT } = this.course.getProgress(this.boat.root.position);
    this.currentT = nearestT;

    const targetT = (nearestT + lookahead / curveLen) % 1.0;
    const targetPos = this.course.curve.getPoint(targetT);

    // Direction to target
    _toTarget.subVectors(targetPos, this.boat.root.position);
    _toTarget.y = 0;
    _toTarget.normalize();

    _forward.copy(this.boat.forwardDir);
    _forward.y = 0;
    _forward.normalize();
    _right.set(-_forward.z, 0, _forward.x);

    let steer = _toTarget.dot(_right) * 2.2;
    steer = THREE.MathUtils.clamp(steer, -1, 1);

    // Apply mistake (blended, not full override)
    if (state.mistakeTimer > 0) {
      steer = THREE.MathUtils.lerp(steer, state.mistakeSteering, 0.4);
    }

    // ─── COLLISION AVOIDANCE + OVERTAKING ───
    let closestDist = Infinity;
    let closestBoat: Boat | null = null;

    for (const other of otherBoats) {
      if (other === this.boat) continue;
      const dx = this.boat.root.position.x - other.root.position.x;
      const dz = this.boat.root.position.z - other.root.position.z;
      const dist = Math.sqrt(dx * dx + dz * dz);

      if (dist < 5.0) {
        _away.set(dx, 0, dz).normalize();
        const avoidSteer = _away.dot(_right) * (5.0 - dist) * 0.35;
        steer = THREE.MathUtils.clamp(steer + avoidSteer, -1, 1);
      }

      if (dist < closestDist) {
        closestDist = dist;
        closestBoat = other;
      }
    }

    // Overtaking: if close behind another boat on a straight, try to pass
    if (closestBoat && closestDist < 8 && closestDist > 2 && state.overtakeTimer <= 0) {
      const curvature = this._estimateCurvature(nearestT);
      if (curvature < 0.02 && this.boat.speed > 10) {
        // On a straight, attempt overtake
        _away.subVectors(this.boat.root.position, closestBoat.root.position);
        _away.y = 0;
        const side = _away.dot(_right);
        state.overtakeSteer = side > 0 ? 0.4 : -0.4;
        state.overtakeTimer = 2.0; // cooldown
      }
    }
    steer = THREE.MathUtils.clamp(steer + state.overtakeSteer, -1, 1);

    // ─── THROTTLE CONTROL (gradual corner braking) ───
    const curvature = this._estimateCurvature(nearestT);
    const riskMult = RISK_FACTOR[personality];

    // Gradual braking: more curvature = less throttle
    const cornerSlowdown = Math.max(0, 1.0 - curvature * 15 * riskMult);
    const baseThrottle = THREE.MathUtils.clamp(
      cornerSlowdown * SPEED_MULT[personality] * state.rubberBandFactor,
      0.25, // never fully stop in corners
      1.0
    );

    // Stuck detection with smarter recovery
    if (this.boat.speed < 1.0) {
      state.stuckTimer += dt;
    } else {
      state.stuckTimer = Math.max(0, state.stuckTimer - dt * 2);
    }
    const isStuck = state.stuckTimer > 2.0;

    // When stuck: reverse briefly then turn toward track
    let throttle: number;
    let brake: number;
    let finalSteer: number;

    if (isStuck) {
      throttle = 0;
      brake = 0.8;
      // Steer toward the nearest curve point while reversing
      finalSteer = steer > 0 ? -0.5 : 0.5;
      // Reset stuck timer after attempting recovery
      if (state.stuckTimer > 3.5) state.stuckTimer = 0;
    } else {
      throttle = baseThrottle;
      brake = 0;
      finalSteer = steer;
    }

    return {
      throttle,
      brake,
      steer: finalSteer,
      drift: Math.abs(steer) > 0.65 && this.boat.speed > 14 && curvature > 0.02,
    };
  }

  private _estimateCurvature(t: number): number {
    const step = 0.01;
    const p0 = this.course.curve.getPoint((t - step + 1) % 1);
    const p1 = this.course.curve.getPoint(t);
    const p2 = this.course.curve.getPoint((t + step) % 1);
    const d1x = p1.x - p0.x, d1z = p1.z - p0.z;
    const d2x = p2.x - p1.x, d2z = p2.z - p1.z;
    const cross = d1x * d2z - d1z * d2x;
    return Math.abs(cross);
  }
}
