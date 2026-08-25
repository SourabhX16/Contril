/**
 * Weapons — the missile subsystem.
 *
 * Missiles are cheap: one sphere, one velocity vector, one age counter.  No
 * mesh, no particles — the explosion is a tidal wave that shoves nearby hulls
 * and an audio one-shot.  Visuals are the HUD's job (reticle, pips, flash).
 *
 * The launcher lives on `GameContext.weapons` so the AI can fire through the
 * exact same door the player does — an archetype never touches a hull it does
 * not own.
 */

import { Vector3 } from 'three';
import { CONFIG } from '../core/config';
import { clamp01 } from '../core/mathx';
import type { GameContext, Racer, Subsystem, WeaponsAPI } from '../core/types';

/** Internal missile representation. */
export interface Missile {
  pos: Vector3;
  vel: Vector3;
  owner: Racer;
  age: number;
  /** True once `armDelay` has elapsed — the owner is no longer safe. */
  armed: boolean;
  alive: boolean;
}

const _tmp = new Vector3();

export class Weapons implements Subsystem, WeaponsAPI {
  readonly name = 'weapons';
  readonly order = 35; // after boatPhysics (30), before AI (40)

  /** Live missiles — read by the HUD for pip / reticle drawing. */
  readonly active: Missile[] = [];

  /**
   * Pending explosion events from this frame.  Consumed by main after all
   * subsystems run so the audio and camera shake fire once per blast, not once
   * per missile-contact.
   */
  readonly booms: { x: number; z: number; strength: number; owner: Racer }[] = [];

  /**
   * Missile fires that need network broadcast.  AI fires are pushed here;
   * main.ts drains and broadcasts them each frame.
   */
  readonly pendingFires: { slot: number; ox: number; oz: number; tx: number; tz: number }[] = [];

  private cfg = CONFIG.weapons;

  constructor(private racers: Racer[]) {}

  // ── Launcher ─────────────────────────────────────────────────────────────

  /**
   * Fire a missile from `owner` aimed at world-space target (tx, tz) on the
   * water surface.  Returns false when the owner has no stock or the cap is
   * reached.
   */
  fire(owner: Racer, tx: number, tz: number): boolean {
    if (owner.missiles <= 0) return false;
    if (this.active.length >= 64) return false; // absolute backstop

    owner.missiles--;

    // Spawn at the hull centre, 1 m above the water so the first frame does
    // not clip the swell.
    const s = owner.state;
    const spawn = _tmp.copy(s.position);
    spawn.y += 1;

    const dir = new Vector3(tx - spawn.x, 0, tz - spawn.z);
    const len = dir.length();
    if (len < 0.1) {
      // Target is on top of us — fire straight ahead.
      dir.set(-Math.sin(s.heading), 0, -Math.cos(s.heading));
    } else {
      dir.divideScalar(len);
    }

    this.active.push({
      pos: spawn.clone(),
      vel: dir.multiplyScalar(this.cfg.speed),
      owner,
      age: 0,
      armed: false,
      alive: true,
    });

    // Queue for network broadcast (main drains this each frame).
    this.pendingFires.push({
      slot: owner.id,
      ox: Math.round(spawn.x * 10) / 10,
      oz: Math.round(spawn.z * 10) / 10,
      tx: Math.round(tx * 10) / 10,
      tz: Math.round(tz * 10) / 10,
    });

    return true;
  }

  /**
   * Spawn a remote missile from a network broadcast.  Same visual and
   * physics as a local fire, but does not deduct stock or broadcast.
   */
  spawnRemote(owner: Racer, ox: number, oz: number, tx: number, tz: number): boolean {
    if (this.active.length >= 64) return false;
    const spawn = new Vector3(ox, 1, oz);
    const dir = new Vector3(tx - ox, 0, tz - oz);
    const len = dir.length();
    if (len < 0.1) {
      dir.set(-Math.sin(owner.state.heading), 0, -Math.cos(owner.state.heading));
    } else {
      dir.divideScalar(len);
    }
    this.active.push({
      pos: spawn,
      vel: dir.multiplyScalar(this.cfg.speed),
      owner,
      age: 0,
      armed: false,
      alive: true,
    });
    return true;
  }

  // ── Subsystem ────────────────────────────────────────────────────────────

  update(ctx: GameContext) {
    if (ctx.race.paused) return;

    const dt = ctx.dt;
    this.booms.length = 0;

    for (const m of this.active) {
      if (!m.alive) continue;

      m.age += dt;
      if (m.age > this.cfg.armDelay) m.armed = true;

      // Integrate position.
      m.pos.x += m.vel.x * dt;
      m.pos.z += m.vel.z * dt;

      // Arm-delay and range check.
      if (m.age > this.cfg.maxRange / this.cfg.speed) {
        this.detonate(m, ctx, false);
        continue;
      }

      // Proximity check against every hull (including the owner, once armed).
      for (const r of this.racers) {
        if (!m.armed && r === m.owner) continue;
        if (r.finished) continue;
        const dx = r.state.position.x - m.pos.x;
        const dz = r.state.position.z - m.pos.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < this.cfg.killRadius * this.cfg.killRadius) {
          this.detonate(m, ctx, true);
          break;
        }
      }
    }

    // Garbage-collect dead missiles.
    let w = 0;
    for (let i = 0; i < this.active.length; i++) {
      if (this.active[i].alive) this.active[w++] = this.active[i];
    }
    this.active.length = w;
  }

  // ── Detonation ───────────────────────────────────────────────────────────

  /**
   * `kill` is true for a direct hit (anyone inside `killRadius` is dead),
   * false for a range-exhaustion blast that only produces a tidal wave.
   */
  private detonate(m: Missile, ctx: GameContext, kill: boolean) {
    m.alive = false;

    const waveR = this.cfg.waveRadius;
    const waveI = this.cfg.waveImpulse;
    const killR = this.cfg.killRadius;

    // Tidal wave: push every hull away from the blast centre.
    for (const r of this.racers) {
      if (r.finished) continue;
      const dx = r.state.position.x - m.pos.x;
      const dz = r.state.position.z - m.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > waveR) continue;

      const frac = 1 - d / waveR;
      const impulse = waveI * frac;
      // Direction normalised (or zero if exactly coincident).
      const nx = d > 0.01 ? dx / d : 0;
      const nz = d > 0.01 ? dz / d : 0;
      r.state.velocity.x += nx * impulse;
      r.state.velocity.z += nz * impulse;

      // Direct kill: any hull inside `killRadius` is stopped cold.
      if (kill && d < killR) {
        r.state.velocity.set(0, 0, 0);
      }
    }

    // Record the boom for audio / camera shake (consumed by main).
    this.booms.push({
      x: m.pos.x,
      z: m.pos.z,
      strength: clamp01(1 - Math.hypot(m.pos.x, m.pos.z) / 500),
      owner: m.owner,
    });

    if (m.owner.isPlayer) {
      ctx.audio.explosion(0.9);
      ctx.cameraRig.addShake(0.5);
    }
  }
}
