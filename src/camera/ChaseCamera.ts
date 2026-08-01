import * as THREE from 'three';

// ─── REUSABLE VECTORS (zero allocation) ────────────────────────────────────
const _desired = new THREE.Vector3();
const _force   = new THREE.Vector3();
const _lookAhead = new THREE.Vector3();
const _fwd     = new THREE.Vector3();
const _headingQ = new THREE.Quaternion();
const _up      = new THREE.Vector3(0, 1, 0);

/**
 * Spring-damped chase camera with:
 * - Critically-damped spring (no oscillation, fast convergence)
 * - Smooth FOV easing with speed
 * - Drift framing (widens camera during drift)
 * - Landing compression (camera dips on impact)
 * - Damped sine screenshake (not random)
 * - Speed-dependent look-ahead
 * - Cinematic orbit for countdown + results
 * - Zero heap allocations per frame
 */
export class ChaseCamera {
  camera: THREE.PerspectiveCamera;

  // Chase spring parameters
  private offset: THREE.Vector3 = new THREE.Vector3(0, 4.5, -10.5);
  private currentPos: THREE.Vector3 = new THREE.Vector3(0, 8, -15);
  private velocity: THREE.Vector3 = new THREE.Vector3();
  private currentLook: THREE.Vector3 = new THREE.Vector3();
  private initialized = false;

  // Shake
  private shakeIntensity = 0;
  private shakePhase = 0;

  // FOV
  private readonly baseFOV = 65;
  private currentFOV = 65;

  // Landing
  private landingDip = 0;

  // Drift framing
  private driftOffset = 0;

  // Orbit state
  private orbitAngle = 0;
  private orbitTarget: THREE.Vector3 = new THREE.Vector3();
  isOrbiting = false;

  // Spring constants (critically damped: ζ = 1)
  private readonly SPRING_STIFFNESS = 50;   // ω² — higher = snappier
  private readonly SPRING_DAMPING = 14;     // 2ω — critical damping
  private readonly LOOK_SPEED = 10;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(this.baseFOV, aspect, 0.5, 2000);
    this.camera.position.set(0, 8, -15);
  }

  triggerShake(intensity: number): void {
    this.shakeIntensity = Math.min(intensity * 0.5, 0.6);
    this.shakePhase = 0;
  }

  triggerLandingDip(intensity: number): void {
    this.landingDip = Math.min(intensity * 0.6, 1.0);
  }

  startOrbit(center: THREE.Vector3): void {
    this.isOrbiting = true;
    this.orbitTarget.copy(center);
    this.orbitAngle = 0;
  }

  stopOrbit(): void {
    this.isOrbiting = false;
  }

  update(
    dt: number,
    target: THREE.Vector3,
    targetHeading: number,
    speed: number,
    isDrifting = false,
    steerInput = 0
  ): void {
    if (this.isOrbiting) {
      this._updateOrbit(dt, target);
      return;
    }

    // Initialize position on first real update
    if (!this.initialized) {
      _headingQ.setFromAxisAngle(_up, -targetHeading);
      _desired.copy(this.offset).applyQuaternion(_headingQ).add(target);
      this.currentPos.copy(_desired);
      this.currentLook.copy(target);
      this.velocity.set(0, 0, 0);
      this.initialized = true;
    }

    // ─── DRIFT FRAMING ───
    // Smoothly shift camera sideways during drift
    const driftTarget = isDrifting ? steerInput * 2.5 : 0;
    this.driftOffset += (driftTarget - this.driftOffset) * (1 - Math.pow(0.001, dt));

    // ─── DESIRED POSITION ───
    _headingQ.setFromAxisAngle(_up, -targetHeading);
    _desired.copy(this.offset);
    _desired.x += this.driftOffset; // lateral offset during drift
    _desired.applyQuaternion(_headingQ);
    _desired.add(target);
    // Landing dip — camera drops slightly on impact
    _desired.y -= this.landingDip * 0.8;
    _desired.y = Math.max(_desired.y, target.y + 2.0); // never below target

    // ─── CRITICALLY-DAMPED SPRING ───
    // F = -k(x - x₀) - c·v
    // where k = stiffness, c = damping, x₀ = desired
    _force.subVectors(_desired, this.currentPos).multiplyScalar(this.SPRING_STIFFNESS);
    _force.addScaledVector(this.velocity, -this.SPRING_DAMPING);

    this.velocity.addScaledVector(_force, dt);
    this.currentPos.addScaledVector(this.velocity, dt);

    // ─── LOOK-AT (speed-dependent look-ahead) ───
    const lookDist = 5.0 + speed * 0.15; // look further ahead at speed
    _fwd.set(Math.sin(-targetHeading), 0, Math.cos(-targetHeading));
    _lookAhead.copy(target).addScaledVector(_fwd, lookDist);
    _lookAhead.y += 1.5 - this.landingDip * 0.3;

    // Smooth look-at tracking
    const lookLerp = 1 - Math.pow(0.0001, dt * this.LOOK_SPEED);
    this.currentLook.lerp(_lookAhead, lookLerp);

    // ─── SMOOTH FOV (continuous, not banded) ───
    const speedPct = Math.min(speed / 34, 1);
    const targetFOV = this.baseFOV + speedPct * speedPct * 14; // quadratic curve
    const fovLerp = 1 - Math.pow(0.01, dt);
    this.currentFOV += (targetFOV - this.currentFOV) * fovLerp;
    this.camera.fov = this.currentFOV;
    this.camera.updateProjectionMatrix();

    // ─── SCREENSHAKE (damped sine, not random) ───
    let shakeX = 0, shakeY = 0;
    if (this.shakeIntensity > 0.001) {
      this.shakePhase += dt * 45; // high frequency
      const decay = this.shakeIntensity;
      shakeX = Math.sin(this.shakePhase) * decay * 0.3;
      shakeY = Math.cos(this.shakePhase * 1.3) * decay * 0.2;
      this.shakeIntensity *= Math.pow(0.001, dt); // exponential decay
    }

    // ─── DECAY EFFECTS ───
    this.landingDip *= Math.pow(0.005, dt);

    // ─── APPLY ───
    this.camera.position.copy(this.currentPos);
    this.camera.position.x += shakeX;
    this.camera.position.y += shakeY;
    this.camera.lookAt(this.currentLook);
  }

  private _updateOrbit(dt: number, center: THREE.Vector3): void {
    // Smooth orbit target tracking
    this.orbitTarget.lerp(center, 1 - Math.pow(0.01, dt));

    this.orbitAngle += dt * 0.5;
    const radius = 20;
    const height = 8;
    this.camera.position.set(
      this.orbitTarget.x + Math.sin(this.orbitAngle) * radius,
      this.orbitTarget.y + height,
      this.orbitTarget.z + Math.cos(this.orbitAngle) * radius
    );
    this.camera.lookAt(
      this.orbitTarget.x,
      this.orbitTarget.y + 2,
      this.orbitTarget.z
    );
    this.camera.fov = 50;
    this.camera.updateProjectionMatrix();
  }

  onResize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }
}
