/**
 * Input. Keyboard + gamepad, normalised into a small analogue struct so the
 * boat physics never has to know where a control came from — the AI drives the
 * exact same struct, which is what keeps player and AI handling identical.
 */

export interface InputState {
  /** -1 (full left) … +1 (full right) */
  steer: number;
  /** 0 … 1 — Shift (or W, or gamepad trigger). Releasing decelerates. */
  throttle: number;
  /** 0 … 1 */
  brake: number;
  /** Powerslide held. Space only on keyboard — Shift is the throttle now. */
  drift: boolean;
  /**
   * Missile aim, normalised device coordinates from the pointer. The weapons
   * subsystem raycasts these onto the water plane.
   */
  aimNx: number;
  aimNy: number;
  /** Gamepad right stick, raw −1…1. Pans the aim heading when there is no mouse. */
  stickRx: number;
  stickRy: number;
  /** Edge + level of the missile-fire action (F / left mouse / pad X). */
  firePressed: boolean;
  fireHeld: boolean;
  /** Edge-triggered, consumed by the race state machine. */
  startPressed: boolean;
  restartPressed: boolean;
  cameraTogglePressed: boolean;
}

export function createInputState(): InputState {
  return {
    steer: 0,
    throttle: 0,
    brake: 0,
    drift: false,
    aimNx: 0,
    aimNy: -0.2,
    stickRx: 0,
    stickRy: 0,
    firePressed: false,
    fireHeld: false,
    startPressed: false,
    restartPressed: false,
    cameraTogglePressed: false,
  };
}

const KEYS = {
  left: ['ArrowLeft', 'KeyA'],
  right: ['ArrowRight', 'KeyD'],
  fwd: ['ArrowUp', 'KeyW'],
  back: ['ArrowDown', 'KeyS'],
  /** The speed-control key. Held = accelerate toward 100 km/h; released = coast down. */
  accel: ['ShiftLeft', 'ShiftRight'],
  /** Powerslide is its own key now that Shift drives the engine. */
  drift: ['Space'],
  fire: ['KeyF'],
  start: ['Enter', 'Space'],
  restart: ['KeyR'],
  camera: ['KeyC'],
};

export class InputManager {
  readonly state = createInputState();
  private down = new Set<string>();
  private pressedThisFrame = new Set<string>();
  /** Smoothed analogue steer so keyboard input doesn't feel binary. */
  private steerSmooth = 0;
  private mouseDown = false;

  constructor(private target: EventTarget = window) {
    target.addEventListener('keydown', this.onKeyDown);
    target.addEventListener('keyup', this.onKeyUp);
    target.addEventListener('blur', this.onBlur);
    target.addEventListener('pointermove', this.onPointerMove);
    target.addEventListener('pointerdown', this.onPointerDown);
    target.addEventListener('pointerup', this.onPointerUp);
  }

  private onKeyDown = (ev: Event) => {
    const e = ev as KeyboardEvent;
    if (e.repeat) return;
    // Stop the page scrolling out from under the game.
    if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
    this.down.add(e.code);
    this.pressedThisFrame.add(e.code);
  };
  private onKeyUp = (ev: Event) => {
    this.down.delete((ev as KeyboardEvent).code);
  };
  private onBlur = () => {
    this.down.clear();
    this.mouseDown = false;
  };
  /**
   * True when a mouse or touch is the primary aim device (no gamepad
   * connected).  The weapons subsystem uses this to choose between a
   * pointer raycast and a gamepad right-stick offset.
   */
  get hasPointer(): boolean {
    return !navigator.getGamepads?.().some((g) => g && g.connected);
  }
  private onPointerMove = (ev: Event) => {
    const e = ev as PointerEvent;
    // Normalised device coordinates for the aim raycast.
    this.state.aimNx = (e.clientX / window.innerWidth) * 2 - 1;
    this.state.aimNy = -(e.clientY / window.innerHeight) * 2 + 1;
  };
  private onPointerDown = (ev: Event) => {
    if ((ev as PointerEvent).button !== 0) return;
    this.mouseDown = true;
    this.pressedThisFrame.add('MouseLeft');
  };
  private onPointerUp = (ev: Event) => {
    if ((ev as PointerEvent).button !== 0) return;
    this.mouseDown = false;
  };

  private any(list: string[]) {
    return list.some((k) => this.down.has(k));
  }
  private anyPressed(list: string[]) {
    return list.some((k) => this.pressedThisFrame.has(k));
  }

  update(dt: number) {
    const s = this.state;
    const pad = navigator.getGamepads?.().find((g) => g && g.connected) ?? null;

    // ── Steering ──────────────────────────────────────────────────────────
    let rawSteer = (this.any(KEYS.right) ? 1 : 0) - (this.any(KEYS.left) ? 1 : 0);
    if (pad) {
      const ax = pad.axes[0] ?? 0;
      if (Math.abs(ax) > 0.12) rawSteer = ax; // analogue stick wins over keys
    }
    // Ramp toward the raw value; snappy to start, slightly slower to centre.
    const rate = rawSteer === 0 ? 12 : 9;
    this.steerSmooth += (rawSteer - this.steerSmooth) * (1 - Math.exp(-rate * dt));
    s.steer = Math.abs(this.steerSmooth) < 1e-3 ? 0 : this.steerSmooth;

    // ── Throttle / brake ──────────────────────────────────────────────────
    // Shift IS the accelerator per the speed-control model: hold to spool up
    // (capped at 100 km/h), release and drag does the decelerating. W stays as
    // a legacy alias so old reflexes still drive the boat.
    s.throttle = this.any(KEYS.fwd) || this.any(KEYS.accel) ? 1 : 0;
    s.brake = this.any(KEYS.back) ? 1 : 0;
    if (pad) {
      s.throttle = Math.max(s.throttle, pad.buttons[7]?.value ?? 0, pad.buttons[0]?.value ?? 0);
      s.brake = Math.max(s.brake, pad.buttons[6]?.value ?? 0);
    }

    // ── Drift + edge-triggered actions ────────────────────────────────────
    s.drift = this.any(KEYS.drift) || !!(pad && (pad.buttons[1]?.pressed || pad.buttons[5]?.pressed));
    s.startPressed = this.anyPressed(KEYS.start) || !!(pad && pad.buttons[9]?.pressed);
    s.restartPressed = this.anyPressed(KEYS.restart);
    s.cameraTogglePressed = this.anyPressed(KEYS.camera);

    // ── Weapons ───────────────────────────────────────────────────────────
    if (pad) {
      const rx = pad.axes[2] ?? 0;
      const ry = pad.axes[3] ?? 0;
      s.stickRx = Math.abs(rx) > 0.15 ? rx : 0;
      s.stickRy = Math.abs(ry) > 0.15 ? ry : 0;
    } else {
      s.stickRx = 0;
      s.stickRy = 0;
    }
    s.firePressed =
      this.anyPressed(KEYS.fire) ||
      this.anyPressed(['MouseLeft']) ||
      !!(pad && pad.buttons[2]?.pressed);
    s.fireHeld = this.any(KEYS.fire) || this.mouseDown || !!(pad && pad.buttons[2]?.pressed);

    this.pressedThisFrame.clear();
  }

  dispose() {
    this.target.removeEventListener('keydown', this.onKeyDown);
    this.target.removeEventListener('keyup', this.onKeyUp);
    this.target.removeEventListener('blur', this.onBlur);
    this.target.removeEventListener('pointermove', this.onPointerMove);
    this.target.removeEventListener('pointerdown', this.onPointerDown);
    this.target.removeEventListener('pointerup', this.onPointerUp);
  }
}
