/**
 * Bootstrap and frame loop.
 *
 * Owns the `GameContext`, the ordered subsystem list, resize handling, and the
 * `window.__CONTRIL__` harness API. Nothing here knows how any subsystem works
 * — it only knows the interfaces in core/types.
 */

import { Plane, Raycaster, Scene, Vector2, Vector3 } from 'three';
import { CONFIG } from './core/config';
import { InputManager } from './core/input';
import { clamp } from './core/mathx';
import { setSeaState } from './water/gerstner';
import type { GameContext, Racer, RacerId, Subsystem } from './core/types';

import { AdaptiveResolution, createRenderer } from './render/renderer';
import { InkComposer } from './render/composer';
import { SHARED } from './render/celMaterial';
import { createSky } from './render/sky';
import { Ocean } from './water/ocean';
import { Track, resolveTrackSeed } from './race/track';
import { BoatPhysics, createRacer } from './boat/boat';
import { AiDrivers } from './race/ai';
import { RaceState } from './race/raceState';
import { Weapons } from './race/weapons';
import { Riders } from './rider/rider';
import { ChaseCamera, type CameraPreset } from './camera/chaseCamera';
import { Hud } from './ui/hud';
import { GameAudio } from './audio/audio';
import { NetSession, type StartMsg } from './net/session';
import { FALLBACK_SEED } from './race/track';
import { NetSync } from './net/netSync';
import { Menu } from './ui/menu';

/** Reusable up vector to avoid per-frame allocations in respawn placement. */
const _up = new Vector3(0, 1, 0);
/** Reusable raycaster + water plane for missile aim projection. */
const _raycaster = new Raycaster();
const _aimNdc = new Vector2();
const _waterPlane = new Plane(new Vector3(0, 1, 0), 0);
const _aimPt = new Vector3();

/** Grid names per slot. Humans rename slots 1–3 only by joining them. */
export const SLOT_NAMES = ['YOU', 'KAIRA', 'NOX', 'PIP'];

class Game {
  private scene = new Scene();
  private subsystems: Subsystem[] = [];
  private input: InputManager;
  private adaptive: AdaptiveResolution;
  private composer: InkComposer;
  private cameraRig: ChaseCamera;
  private ocean: Ocean;
  private track: Track;
  private race!: RaceState;
  private hud: Hud;
  private audio = new GameAudio();
  private racers: Racer[] = [];
  private session: NetSession;
  private netSync!: NetSync;
  private weapons!: Weapons;
  private menu!: Menu;

  private ctx: GameContext;
  private lastTime = 0;
  private running = false;

  /** Harness overrides. */
  private forcedControls:
    | Partial<{ steer: number; throttle: number; brake: number; drift: boolean; autopilot: boolean }>
    | null = null;
  private fixedDt: number | null = null;
  /** True while a harness script owns the clock; suppresses the rAF step. */
  private scripted = false;

  constructor(
    private glCanvas: HTMLCanvasElement,
    private hudCanvas: HTMLCanvasElement,
  ) {
    const { renderer } = createRenderer(glCanvas);
    this.adaptive = new AdaptiveResolution(renderer);
    this.input = new InputManager();

    const aspect = window.innerWidth / window.innerHeight;
    this.cameraRig = new ChaseCamera(aspect);

    // ── Scene assembly ──────────────────────────────────────────────────────
    this.scene.add(createSky());

    this.ocean = new Ocean();
    this.scene.add(this.ocean.mesh);

    this.track = new Track();
    this.scene.add(this.track.group);

    for (let i = 0; i < CONFIG.race.racerCount; i++) {
      const grid = this.track.startGrid(i);
      const racer = createRacer(i as RacerId, grid.position, grid.heading);
      this.racers.push(racer);
      this.scene.add(racer.root);
    }

    this.race = new RaceState(this.racers, this.track, () => this.resetRacers());
    this.race.paused = true; // the menu owns the first decision
    this.hud = new Hud(hudCanvas, this.track);
    this.composer = new InkComposer(renderer, this.scene, this.cameraRig.camera);

    // ── Networking ────────────────────────────────────────────────────────────
    this.session = new NetSession({
      onLobbyChanged: () => {
        this.applyRoster();
        this.menu.refreshLobby();
      },
      onStart: (msg) => this.beginNetRace(msg),
      onSnapshot: (snap) => this.netSync.ingest(snap),
      onAiBatch: (batch) => batch.forEach((s) => this.netSync.ingest(s)),
      onMissile: (msg) => {
        // Spawn a remote missile from the firing racer's position toward the target.
        const r = this.racers[msg.slot];
        if (r && this.weapons) {
          this.weapons.spawnRemote(r, msg.ox, msg.oz, msg.tx, msg.tz);
        }
      },
      onError: (message) => {
        void this.backToMenu();
        this.menu.showError(message);
      },
    });
    this.netSync = new NetSync(this.racers, this.session, (x, z, t) =>
      this.ocean.height(x, z, t),
    );

    // ── Context ─────────────────────────────────────────────────────────────
    this.ctx = {
      renderer,
      scene: this.scene,
      camera: this.cameraRig.camera,
      time: 0,
      dt: 0,
      rawDt: 0,
      frame: 0,
      ocean: this.ocean,
      track: this.track,
      race: this.race,
      racers: this.racers,
      player: this.racers[0],
      input: this.input.state,
      audio: this.audio,
      cameraRig: this.cameraRig,
      width: window.innerWidth,
      height: window.innerHeight,
      pixelRatio: 1,
      perf: { fps: 60, frameMs: 16.6, gpuScale: 1, drawCalls: 0, triangles: 0 },
    };

    // ── Subsystems, in execution order ──────────────────────────────────────
    const physics = new BoatPhysics(this.racers);
    this.weapons = new Weapons(this.racers);
    this.ctx.weapons = this.weapons;
    this.subsystems = [
      this.ocean,
      this.track,
      physics,
      this.weapons,
      new AiDrivers(this.racers, this.track, physics),
      this.netSync,
      this.race,
      new Riders(this.racers),
    ].sort((a, b) => a.order - b.order);

    // Restart requests route through the network when one is live. The circuit
    // is kept across restarts — you rerun the course you just raced.
    this.race.onRestartRequest = () => {
      if (!this.session.active) return false;
      const cd = CONFIG.race.countdownSeconds * 1000;
      this.session.broadcastStart(cd, this.trackSeed);
      this.beginNetRace({ cd, seed: this.trackSeed });
      return true;
    };

    // Skip-penalty respawn: teleport the racer to their last completed
    // checkpoint, facing forward, speed zeroed. Works for both player and AI.
    this.race.onRespawnRequest = (racer) => {
      const cps = this.track.checkpoints;
      const idx = racer.nextCheckpoint > 0
        ? (racer.nextCheckpoint - 1 + cps.length) % cps.length
        : cps.length - 1;
      const s = cps[idx].s;
      const p = this.track.sample(s / this.track.length);
      racer.root.position.set(p.position.x, p.position.y + 0.35, p.position.z);
      racer.root.quaternion.setFromAxisAngle(_up, Math.atan2(p.tangent.x, p.tangent.z));
      racer.state.velocity.set(0, 0, 0);
      racer.state.heading = Math.atan2(p.tangent.x, p.tangent.z);
      racer.state.checkpointBoostTime = 0;
    };

    // ── Menu ────────────────────────────────────────────────────────────────
    this.menu = new Menu(
      {
        solo: () => this.startSolo(),
        host: (name) => {
          const code = this.session.host(name);
          this.applyRoster();
          this.menu.showLobby(code, true);
        },
        join: (code, name) => {
          this.session.join(code, name);
          this.menu.showLobby(code.toUpperCase(), false);
        },
        start: () => {
          if (this.session.role !== 'host') return;
          const cd = CONFIG.race.countdownSeconds * 1000;
          const seed = this.nextTrackSeed();
          this.newCircuit(seed);
          this.session.broadcastStart(cd, seed);
          this.beginNetRace({ cd, seed });
        },
        leave: () => void this.backToMenu(),
      },
      this.session,
      () => this.race.phase === 'results',
    );

    this.resize();
    window.addEventListener('resize', () => this.resize());
    // Audio can only start from a gesture; arm it on the first interaction.
    const unlock = () => {
      void this.audio.unlock();
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
  }

  /**
   * Minimal lookahead steering for the harness-driven player.
   *
   * Deliberately lives here rather than in the AI subsystem: the harness must
   * keep working regardless of how the AI is rewritten, and a captured frame is
   * only comparable across rounds if the player's line is reproducible.
   */
  private autopilotSteer(racer: Racer): number {
    const proj = this.track.project(racer.root.position);
    const speed = racer.state.velocity.length();
    const lookahead = 15 + speed * 1.0;
    const target = this.track.sampleDistance(proj.u * this.track.length + lookahead);
    const dx = target.position.x - racer.root.position.x;
    const dz = target.position.z - racer.root.position.z;
    let err = Math.atan2(dx, dz) - racer.state.heading;
    while (err > Math.PI) err -= Math.PI * 2;
    while (err < -Math.PI) err += Math.PI * 2;
    return clamp(-err * 2.0, -1, 1);
  }

  private resetRacers() {
    for (const r of this.racers) {
      const grid = this.track.startGrid(r.id);
      r.root.position.copy(grid.position);
      r.root.rotation.set(0, grid.heading, 0);
      r.state.velocity.set(0, 0, 0);
      r.state.heading = grid.heading;
      r.state.forwardSpeed = 0;
      r.state.speedFrac = 0;
      r.state.boostTime = 0;
      r.state.boostMeter = 0;
      r.state.driftCharge = 0;
      r.state.driftTier = 0;
      r.state.checkpointBoostTime = 0;
      r.lap = 0;
      r.nextCheckpoint = 0;
      r.progress = 0;
      r.place = r.id + 1;
      r.finished = false;
      r.finishTime = 0;
      r.lapTimes = [];
      r.bestLap = Infinity;
      r.wrongWay = false;
      r.missiles = 0;
      r.checkpointStreak = 0;
      r.skippedCheckpoints = 0;
    }
    // Remote snapshots describe the *previous* race; drop them so remote boats
    // hold their grid marks until fresh frames arrive.
    this.netSync?.reset();
    this.cameraRig.snapToTarget();
  }

  // ── Multiplayer flows ──────────────────────────────────────────────────────

  /**
   * Map the lobby roster onto the four racer slots.
   *
   * A slot is *yours* if the roster gave it to you; *remote* (network-driven)
   * if someone else owns it — or, on a guest, if it is an AI slot, since on
   * guests even the AI is simulated by the host and arrives as snapshots.
   * Anything not remote and not yours is locally-simulated AI.
   */
  private applyRoster() {
    const s = this.session;
    for (const r of this.racers) {
      const mine = s.active && r.id === s.mySlot;
      const human = s.roster.find((p) => p.slot === r.id);
      r.isPlayer = mine;
      r.remote = !mine && (s.role === 'guest' || (!!human && human.peerId !== s.myPeerId));
      if (mine) r.name = SLOT_NAMES[0];
      else if (human && human.name && human.name !== '…') r.name = human.name.slice(0, 10);
      else r.name = SLOT_NAMES[r.id];
    }
    if (s.active && s.mySlot >= 0) this.ctx.player = this.racers[s.mySlot];
  }

  /** Classic single-player: slot 0 is you, slots 1–3 are the AI field. */
  private startSolo() {
    this.newCircuit();
    for (const r of this.racers) {
      r.isPlayer = r.id === 0;
      r.remote = false;
      r.name = SLOT_NAMES[r.id];
    }
    this.ctx.player = this.racers[0];
    this.menu.hide();
    this.race.restart();
    this.race.paused = false;
  }

  // ── Procedural circuits ────────────────────────────────────────────────────

  /** Seed of the circuit currently built. Shared over the network per race. */
  trackSeed = FALLBACK_SEED;

  /**
   * Build a fresh circuit in place and rebake the minimap.
   *
   * ?seed= wins (the harness depends on it); the harness otherwise falls back
   * to a fixed default so captured frames stay reproducible; a human solo race
   * draws a new seed every time, which is the point of generating tracks at all.
   */
  private nextTrackSeed(): number {
    return (
      resolveTrackSeed() ??
      (CONFIG.debug.harness
        ? FALLBACK_SEED
        : Math.floor(Math.random() * 2 ** 32) >>> 0)
    );
  }

  private newCircuit(seed: number = this.nextTrackSeed()) {
    this.trackSeed = seed;
    this.track.regenerate(seed);
    this.hud.refreshTrack();
    // Grid marks come from the new centreline; everyone re-seats on it.
    this.resetRacers();
  }

  /** A start (or restart) message arrived — or the host just sent one. */
  private beginNetRace(msg: StartMsg) {
    // The host's seed defines the circuit; guests rebuild before anyone moves.
    if (typeof msg.seed === 'number' && msg.seed !== this.trackSeed) {
      this.newCircuit(msg.seed >>> 0);
    }
    this.applyRoster();
    this.netSync.reset();
    this.session.raceRunning = true;
    this.menu.hide();
    this.race.beginNetRace(msg.cd);
    this.race.paused = false;
  }

  /** Tear the session down and put the title screen back up. */
  private async backToMenu() {
    await this.session.leave();
    for (const r of this.racers) {
      r.isPlayer = false;
      r.remote = false;
      r.name = SLOT_NAMES[r.id];
    }
    this.ctx.player = this.racers[0];
    this.netSync.reset();
    this.race.restart();
    this.race.paused = true;
    this.menu.showTitle();
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.ctx.width = w;
    this.ctx.height = h;

    const dpr = this.adaptive.pixelRatio;
    this.ctx.pixelRatio = dpr;

    this.ctx.renderer.setPixelRatio(dpr);
    this.ctx.renderer.setSize(w, h, false);
    this.cameraRig.resize(w / h);
    this.composer.setSize(w, h, dpr);
    this.hud.resize(w, h, Math.min(window.devicePixelRatio || 1, 2));

    SHARED.uResolution.value.set(w * dpr, h * dpr);
    SHARED.uNear.value = CONFIG.render.near;
    SHARED.uFar.value = CONFIG.render.far;
  }

  start() {
    this.running = true;
    this.lastTime = performance.now();
    const loop = (now: number) => {
      if (!this.running) return;
      // While a scripted harness run is in flight, the rAF loop must not step
      // the simulation. `simulate()` awaits between batches, and those awaits
      // used to let real-dt frames slip in — so the same (phase, controls, t)
      // triple produced different boat state on every run and the harness was
      // not actually deterministic. Keep the loop alive, but let the script own
      // the clock.
      if (!this.scripted) this.frame(now);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  /** One simulation + render step. */
  private frame(now: number, forcedDt?: number) {
    const ctx = this.ctx;
    const rawDt = forcedDt ?? (now - this.lastTime) / 1000;
    this.lastTime = now;

    ctx.rawDt = rawDt;
    // Clamp so a tab-switch or a breakpoint cannot fling the boats into orbit.
    ctx.dt = clamp(rawDt, 0, 1 / 20);
    ctx.time += ctx.dt;
    ctx.frame++;

    const t0 = performance.now();

    // ── Input ───────────────────────────────────────────────────────────────
    this.input.update(ctx.dt);
    // The local player's slot is lobby-dependent in multiplayer.
    const pc = ctx.player.controls;
    if (this.forcedControls) {
      pc.throttle = this.forcedControls.throttle ?? 0;
      pc.brake = this.forcedControls.brake ?? 0;
      pc.drift = this.forcedControls.drift ?? false;
      // A scripted `steer: 0` drives the player dead straight off the circuit —
      // 1.2 km off-line after a minute, which put the WRONG WAY banner in almost
      // every captured frame and pushed the AI pack out of shot. Autopilot steers
      // the player along the spline so shots frame a real racing situation.
      pc.steer = this.forcedControls.autopilot
        ? this.autopilotSteer(ctx.player)
        : this.forcedControls.steer ?? 0;
    } else {
      const s = this.input.state;
      pc.steer = s.steer;
      pc.throttle = s.throttle;
      pc.brake = s.brake;
      pc.drift = s.drift;

      // ── Missile fire ──────────────────────────────────────────────────
      if (s.firePressed && ctx.weapons && ctx.race.phase === 'racing') {
        const me = ctx.player;
        let tx: number;
        let tz: number;
        if (this.input.hasPointer) {
          // Mouse / touch: cast a ray from the camera through the pointer NDC
          // and intersect with the water plane (y ≈ 0).
          _aimNdc.set(s.aimNx, s.aimNy);
          _raycaster.setFromCamera(_aimNdc, this.cameraRig.camera);
          const hit = _raycaster.ray.intersectPlane(_waterPlane, _aimPt);
          if (hit) { tx = hit.x; tz = hit.z; }
          else { tx = me.state.position.x - Math.sin(me.state.heading) * 200; tz = me.state.position.z - Math.cos(me.state.heading) * 200; }
        } else {
          // Gamepad: aim 200 m ahead along current heading, offset by right stick.
          const heading = me.state.heading;
          tx = me.state.position.x - Math.sin(heading) * 200 + s.stickRx * 80;
          tz = me.state.position.z - Math.cos(heading) * 200 + s.stickRy * 80;
        }
        if (ctx.weapons.fire(me, tx, tz)) {
          this.session.broadcastMissile({
            slot: me.id,
            ox: Math.round(me.state.position.x * 10) / 10,
            oz: Math.round(me.state.position.z * 10) / 10,
            tx: Math.round(tx * 10) / 10,
            tz: Math.round(tz * 10) / 10,
          });
        }
      }
    }
    // (Restart input on the results screen is consumed by the race state
    // machine, which routes it through the network when one is live.)

    // ── Shared shader uniforms — written once for the whole scene ────────────
    SHARED.uTime.value = ctx.time;
    SHARED.uCameraPos.value.copy(this.cameraRig.camera.position);
    SHARED.uTanHalfFov.value = Math.tan((this.cameraRig.camera.fov * Math.PI) / 360);

    // ── Subsystems ──────────────────────────────────────────────────────────
    for (const s of this.subsystems) s.update(ctx);

    // Drain AI missile fires for network broadcast.
    if (this.weapons) {
      for (const f of this.weapons.pendingFires) {
        this.session.broadcastMissile(f);
      }
      this.weapons.pendingFires.length = 0;
    }

    // Camera and audio run after everything that can move the boat.
    if (this.race.phase === 'countdown' || this.race.phase === 'results') {
      this.cameraRig.applyCinematicOrbit(ctx);
      this.cameraRig.update(ctx);
    } else {
      this.cameraRig.update(ctx);
    }
    this.audio.update(ctx);

    // ── Render ──────────────────────────────────────────────────────────────
    ctx.renderer.info.reset();
    this.composer.render();
    // Hand the G-buffer depth to the water so its foam ring can read it.
    this.ocean.setSceneDepth(this.composer.gbufferDepth);

    const stats = this.adaptive.drawStats();
    ctx.perf.drawCalls = stats.drawCalls;
    ctx.perf.triangles = stats.triangles;

    this.hud.render(ctx);

    // ── Adaptive resolution ─────────────────────────────────────────────────
    const frameMs = performance.now() - t0;
    if (this.adaptive.update(frameMs, ctx.dt)) this.resize();
    ctx.perf.fps = this.adaptive.fps;
    ctx.perf.frameMs = this.adaptive.frameMs;
    ctx.perf.gpuScale = this.adaptive.scale;
  }

  // ── Harness API ───────────────────────────────────────────────────────────

  /** Boot straight into a solo race (harness / ?quick). */
  harnessSkipMenu() {
    this.menu.hide();
    this.startSolo();
  }

  harness() {
    const self = this;
    return {
      ready: true,

      reset() {
        self.ctx.time = 0;
        self.race.restart();
        self.forcedControls = null;
      },

      setPhase(phase: 'countdown' | 'racing' | 'results') {
        if (phase === 'racing') {
          self.race.phase = 'racing';
          self.race.raceTime = 0;
          self.race.countdownNumber = -1;
        } else if (phase === 'countdown') {
          self.race.phase = 'countdown';
          self.race.raceTime = -CONFIG.race.countdownSeconds;
        } else {
          // Fabricate a plausible finished race so the results board has data.
          self.race.phase = 'results';
          self.racers.forEach((r, i) => {
            r.finished = true;
            r.finishTime = 214.5 + i * 3.4;
            r.lapTimes = [71.2 + i, 70.8 + i, 72.5 + i];
            r.bestLap = Math.min(...r.lapTimes);
            r.place = i + 1;
            r.lap = CONFIG.race.laps;
          });
        }
      },

      setControls(c: Record<string, number | boolean>) {
        self.forcedControls = c as any;
      },

      /** Fixed-step advance — identical output on every machine. */
      async simulate(seconds: number, dt = 1 / 60) {
        self.scripted = true;
        const steps = Math.max(1, Math.round(seconds / dt));
        for (let i = 0; i < steps; i++) {
          self.frame(performance.now(), dt);
          // Yield periodically so the compositor can breathe and WebGL does not
          // build an unbounded command backlog.
          if (i % 30 === 29) await new Promise((r) => setTimeout(r, 0));
        }
      },

      /**
       * Advance until a predicate over stats() holds, or `maxSeconds` elapses.
       *
       * Fixed-t shots are brittle for transient states: the boat physics was
       * retuned and the old `air` timestamp stopped landing on an airborne
       * frame, so a shot that existed to prove the landing crouch was silently
       * proving nothing. Hunting for the state instead survives retuning.
       */
      async simulateUntil(
        predicateSource: string,
        maxSeconds = 90,
        dt = 1 / 60,
      ): Promise<{ found: boolean; t: number }> {
        self.scripted = true;
        // eslint-disable-next-line no-new-func
        const pred = new Function('s', `return (${predicateSource});`) as (s: any) => boolean;
        const steps = Math.round(maxSeconds / dt);
        for (let i = 0; i < steps; i++) {
          self.frame(performance.now(), dt);
          if (i % 30 === 29) await new Promise((r) => setTimeout(r, 0));
          try {
            if (pred(this.stats())) return { found: true, t: self.ctx.time };
          } catch {
            /* a malformed predicate should not wedge the run */
          }
        }
        return { found: false, t: self.ctx.time };
      },

      /** Render N frames so springs and particles settle. Still script-owned. */
      async settle(frames = 6) {
        self.scripted = true;
        for (let i = 0; i < frames; i++) {
          self.frame(performance.now(), 1 / 60);
          await new Promise((r) => requestAnimationFrame(() => r(null)));
        }
      },

      /** Hand the clock back to real time. */
      release() {
        self.scripted = false;
        self.lastTime = performance.now();
      },

      /**
       * Per-racer diagnostic dump. Exists because "the boats are driving the
       * wrong way" is a claim that needs numbers, not a screenshot.
       */
      probe() {
        return self.racers.map((r) => {
          const proj = self.track.project(r.root.position);
          const tp = self.track.sample(proj.u);
          const speed = r.state.velocity.length();
          const fwd = { x: Math.sin(r.state.heading), z: Math.cos(r.state.heading) };
          return {
            id: r.id,
            name: r.name,
            heading: r.state.heading,
            headingFwd: fwd,
            trackTangent: { x: tp.tangent.x, z: tp.tangent.z },
            // >0 means the hull points along the track; <0 means backwards.
            headingDotTangent: fwd.x * tp.tangent.x + fwd.z * tp.tangent.z,
            velDotTangent: speed > 0.01 ? r.state.velocity.dot(tp.tangent) / speed : 0,
            speed,
            u: proj.u,
            lateral: proj.lateral,
            distToLine: proj.distance,
            lap: r.lap,
            nextCheckpoint: r.nextCheckpoint,
            progress: r.progress,
            place: r.place,
            wrongWay: r.wrongWay,
            finished: r.finished,
            pos: r.root.position.toArray().map((v) => +v.toFixed(2)),
          };
        });
      },

      setCameraPreset(name: CameraPreset) {
        self.cameraRig.setPreset(name);
      },

      setSeaState(v: number) {
        setSeaState(v);
      },

      stats() {
        const p = self.ctx.player.state;
        return {
          fps: self.ctx.perf.fps,
          frameMs: self.ctx.perf.frameMs,
          drawCalls: self.ctx.perf.drawCalls,
          triangles: self.ctx.perf.triangles,
          pixelRatio: self.ctx.pixelRatio,
          time: self.ctx.time,
          phase: self.race.phase,
          speed: p.forwardSpeed,
          airborne: p.airborne,
          airTime: p.airTime,
          landingImpact: p.landingImpact,
          drifting: p.drifting,
          driftTier: p.driftTier,
          boostMeter: p.boostMeter,
          boostTime: p.boostTime,
          wrongWay: self.ctx.player.wrongWay,
          position: p.position.toArray(),
          lap: self.ctx.player.lap,
          place: self.ctx.player.place,
        };
      },

      rendererInfo() {
        const gl = self.ctx.renderer.getContext();
        const dbg = gl.getExtension('WEBGL_debug_renderer_info');
        return {
          renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown',
          vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : 'unknown',
        };
      },

      /** Escape hatch for ad-hoc probing from the harness. */
      _game: self,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────────────────────────────────────

const glCanvas = document.getElementById('gl') as HTMLCanvasElement;
const hudCanvas = document.getElementById('hud') as HTMLCanvasElement;
const boot = document.getElementById('boot');

try {
  const game = new Game(glCanvas, hudCanvas);
  game.start();

  // The menu owns the first decision — unless the harness (or ?quick) needs
  // the game to boot straight into a solo race exactly as it always did.
  if (CONFIG.debug.skipMenu) {
    game.harnessSkipMenu();
  }

  // Expose the harness API once the first frame is definitely on screen.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      (window as any).__CONTRIL__ = game.harness();
      boot?.classList.add('gone');
      setTimeout(() => boot?.remove(), 700);
    }),
  );
} catch (err) {
  console.error('[ink-tide] boot failed', err);
  if (boot) {
    boot.textContent = 'Boot failed — see console';
    boot.style.letterSpacing = '0.1em';
  }
  throw err;
}
