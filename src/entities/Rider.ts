import * as THREE from 'three';
import { CelPipeline } from '../rendering/CelPipeline';

/**
 * Rider — procedurally rigged cel-shaded character
 * Built from box/cylinder primitives, animated via bone-like Object3D hierarchy
 *
 * Rig structure:
 *  root
 *   └─ hips (yaw + vertical bob)
 *       ├─ torso (lean fwd/back + roll)
 *       │   ├─ head
 *       │   ├─ leftArm (throttle work)
 *       │   └─ rightArm
 *       ├─ leftLeg
 *       └─ rightLeg
 */
export class Rider {
  root: THREE.Group;
  private hips: THREE.Group;
  private torso: THREE.Group;
  private head: THREE.Group;
  private leftArm: THREE.Group;
  private rightArm: THREE.Group;
  private leftLeg: THREE.Group;
  private rightLeg: THREE.Group;

  // Animation state
  private phase = 0;
  celebratingTimer = 0;

  // Smoothed values for organic motion
  private smoothLean = 0;
  private smoothFwd = 0;
  private smoothCrouch = 0;
  private smoothDrift = 0;

  constructor(cel: CelPipeline, color: THREE.Color) {
    this.root = new THREE.Group();
    this.hips = new THREE.Group();
    this.torso = new THREE.Group();
    this.head = new THREE.Group();
    this.leftArm = new THREE.Group();
    this.rightArm = new THREE.Group();
    this.leftLeg = new THREE.Group();
    this.rightLeg = new THREE.Group();

    this.buildRig(cel, color);
  }

  private makeLimb(
    cel: CelPipeline,
    w: number, h: number, d: number,
    color: THREE.Color,
    parent: THREE.Group,
    offsetY = 0
  ): THREE.Mesh {
    const geo = new THREE.BoxGeometry(w, h, d);
    const mat = cel.createMaterial({ baseColor: color });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = offsetY;
    parent.add(mesh);
    cel.addOutline(geo, parent, 0.04);
    return mesh;
  }

  private buildRig(cel: CelPipeline, color: THREE.Color): void {
    const skinColor = new THREE.Color(0xf5c3a0);
    const darkColor = new THREE.Color(color.r * 0.5, color.g * 0.5, color.b * 0.5);

    this.root.add(this.hips);

    // Hips / lower body
    this.makeLimb(cel, 0.28, 0.18, 0.22, color, this.hips, 0);

    // Torso
    this.torso.position.y = 0.28;
    this.hips.add(this.torso);
    this.makeLimb(cel, 0.32, 0.35, 0.24, color, this.torso, 0.17);

    // Head
    this.head.position.y = 0.52;
    this.torso.add(this.head);
    this.makeLimb(cel, 0.26, 0.26, 0.26, skinColor, this.head, 0.13);
    // Helmet
    const helmetGeo = new THREE.SphereGeometry(0.16, 8, 6);
    const helmetMat = cel.createMaterial({ baseColor: darkColor });
    const helmet = new THREE.Mesh(helmetGeo, helmetMat);
    helmet.position.y = 0.19;
    this.head.add(helmet);
    cel.addOutline(helmetGeo, this.head, 0.03);

    // Left arm
    this.leftArm.position.set(-0.22, 0.42, 0);
    this.torso.add(this.leftArm);
    this.makeLimb(cel, 0.10, 0.28, 0.10, skinColor, this.leftArm, -0.14);

    // Right arm
    this.rightArm.position.set(0.22, 0.42, 0);
    this.torso.add(this.rightArm);
    this.makeLimb(cel, 0.10, 0.28, 0.10, skinColor, this.rightArm, -0.14);

    // Left leg
    this.leftLeg.position.set(-0.10, 0, 0);
    this.hips.add(this.leftLeg);
    this.makeLimb(cel, 0.12, 0.30, 0.14, color, this.leftLeg, -0.15);

    // Right leg
    this.rightLeg.position.set(0.10, 0, 0);
    this.hips.add(this.rightLeg);
    this.makeLimb(cel, 0.12, 0.30, 0.14, color, this.rightLeg, -0.15);
  }

  /**
   * Animate rider per frame
   * @param dt delta time
   * @param turnInput -1..1 (negative = left turn)
   * @param throttle 0..1
   * @param brake 0..1
   * @param isAirborne
   * @param isDrifting
   * @param waveHeight for idle bob sync
   */
  update(
    dt: number,
    turnInput: number,
    throttle: number,
    brake: number,
    isAirborne: boolean,
    isDrifting: boolean,
    waveHeight: number
  ): void {
    this.phase += dt;
    const lerpRate = 1 - Math.pow(0.0001, dt); // frame-rate independent lerp

    if (this.celebratingTimer > 0) {
      this.celebratingTimer -= dt;
      this._animateCelebration(this.phase);
      return;
    }

    // ─── SMOOTH INTERMEDIATES ───
    // Lean into turns (smoothed for organic feel)
    const targetLean = -turnInput * 0.3;
    this.smoothLean += (targetLean - this.smoothLean) * lerpRate;

    // Forward lean: throttle leans forward, brake leans back
    const fwdTarget = throttle * 0.22 - brake * 0.15 - 0.06;
    this.smoothFwd += (fwdTarget - this.smoothFwd) * lerpRate;

    // Drift lateral shift
    const driftTarget = isDrifting ? turnInput * 0.12 : 0;
    this.smoothDrift += (driftTarget - this.smoothDrift) * lerpRate;

    // Landing crouch (smooth transition, not instant)
    const crouchTarget = isAirborne ? 1.0 : 0.0;
    const crouchSpeed = isAirborne ? 0.0001 : 0.01; // snap into crouch, ease out
    this.smoothCrouch += (crouchTarget - this.smoothCrouch) * (1 - Math.pow(crouchSpeed, dt));

    // ─── HIPS ───
    // Idle bob synced to wave height
    const idleBob = Math.sin(this.phase * 1.2) * 0.02 + waveHeight * 0.03;
    this.hips.position.y = idleBob - this.smoothCrouch * 0.12;
    this.hips.position.x = this.smoothDrift; // lateral shift during drift
    this.hips.rotation.y = THREE.MathUtils.lerp(
      this.hips.rotation.y,
      -turnInput * 0.15,
      lerpRate * 0.5
    );

    // ─── TORSO ───
    this.torso.rotation.z = this.smoothLean;
    this.torso.rotation.x = -this.smoothFwd - this.smoothCrouch * 0.25;

    // ─── ARMS ───
    // Throttle working animation — bigger amplitude, more visible
    const armSwing = Math.sin(this.phase * 6) * throttle * 0.25;
    // Wind buffet at high speed adds extra arm movement
    const speedJitter = Math.sin(this.phase * 11) * 0.04;

    this.leftArm.rotation.x  = -0.4 + armSwing + speedJitter;
    this.rightArm.rotation.x = -0.4 - armSwing - speedJitter;

    // Turn arms: steering lean
    this.leftArm.rotation.z  = 0.3 + turnInput * 0.25;
    this.rightArm.rotation.z = -0.3 + turnInput * 0.25;

    // Brake: arms pull back
    if (brake > 0.1) {
      this.leftArm.rotation.x  += brake * 0.3;
      this.rightArm.rotation.x += brake * 0.3;
    }

    // ─── LEGS ───
    // Slight spread during drift for stability
    if (isDrifting) {
      this.leftLeg.rotation.z  = -0.1;
      this.rightLeg.rotation.z = 0.1;
    } else {
      this.leftLeg.rotation.z  *= 0.9;
      this.rightLeg.rotation.z *= 0.9;
    }

    // ─── HEAD ───
    // Look toward turn direction
    this.head.rotation.y = THREE.MathUtils.lerp(
      this.head.rotation.y,
      turnInput * 0.35,
      lerpRate * 0.3
    );
    // Idle head bob
    this.head.rotation.x = Math.sin(this.phase * 0.8) * 0.04;
  }

  celebrate(): void {
    this.celebratingTimer = 5.0;
  }

  private _animateCelebration(t: number): void {
    // Varied celebration: arms pump + body bounce + head look around
    const pumpSpeed = 8;
    this.leftArm.rotation.x  = Math.sin(t * pumpSpeed) * 0.9 - 0.5;
    this.rightArm.rotation.x = Math.cos(t * pumpSpeed) * 0.9 - 0.5;
    this.leftArm.rotation.z  = 0.9 + Math.sin(t * 3) * 0.15;
    this.rightArm.rotation.z = -0.9 - Math.sin(t * 3) * 0.15;
    this.hips.position.y = Math.abs(Math.sin(t * pumpSpeed)) * 0.14;
    this.torso.rotation.z = Math.sin(t * 4) * 0.12; // body sway
    this.head.rotation.y = Math.sin(t * 4) * 0.5;
    this.head.rotation.x = Math.sin(t * 6) * 0.1 - 0.1; // look up
  }
}
