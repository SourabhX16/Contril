/**
 * The multiplayer sync subsystem.
 *
 * Owns every racer whose `remote` flag is set. Two jobs, both per frame:
 *
 *   1. **Broadcast** the locally-simulated field at CONFIG.net.sendHz — the
 *      player's boat from every client, plus (as host) all AI boats in one
 *      batched message.
 *   2. **Render** remote boats from an interpolation buffer held
 *      `interpDelayMs` behind wall time, so snapshot arrival jitter never
 *      shows as stutter. A starved buffer dead-reckons along the last known
 *      velocity for a bounded window and then holds.
 *
 * Vertical motion gets one special case: every client integrates the same
 * Gerstner field, but each against its own local clock — so a remote hull is
 * seated on the *local* ocean surface whenever the sender says it was wet.
 * Airborne snapshots use their raw y: a ballistic arc survives a few tens of
 * milliseconds of mismatch; wave contact does not.
 */

import type { GameContext, Racer, Subsystem } from '../core/types';
import { CONFIG } from '../core/config';
import { damp } from '../core/mathx';
import type { BoatSnap, NetSession } from './session';

interface Snap {
  /** Local receive time, performance.now() ms. */
  t: number;
  snap: BoatSnap;
}

/** Hull origin height above the local surface at rest draft (see physics). */
const SEAT_OFFSET = 0.12;

export class NetSync implements Subsystem {
  readonly name = 'netSync';
  /** After physics (30) and AI (40), before race progress (50). */
  readonly order = 45;

  private buffers = new Map<number, Snap[]>();
  private sendAcc = 0;
  private aiAcc = 0;

  constructor(
    private racers: Racer[],
    private session: NetSession,
    /** Local ocean height under a world XZ, for seating remote hulls. */
    private surfaceHeight: (x: number, z: number, t: number) => number,
  ) {}

  /** Clear interpolation state. Called on every race reset so remote boats
   *  snap straight back to their grid marks instead of lerping across the map. */
  reset() {
    this.buffers.clear();
    this.sendAcc = 0;
    this.aiAcc = 0;
  }

  update(ctx: GameContext) {
    if (!this.session.active || ctx.race.paused) return;

    // ── Broadcast ──────────────────────────────────────────────────────────
    const period = 1 / CONFIG.net.sendHz;
    this.sendAcc += ctx.dt;
    if (this.sendAcc >= period) {
      this.sendAcc %= period;
      const me = this.racers.find((r) => r.isPlayer);
      if (me) this.session.broadcastState(encode(me));
    }
    if (this.session.role === 'host') {
      this.aiAcc += ctx.dt;
      if (this.aiAcc >= period) {
        this.aiAcc %= period;
        let batch: BoatSnap[] | null = null;
        for (const r of this.racers) {
          // Host-simulated AI only: remote humans broadcast their own boats.
          if (r.remote || r.isPlayer) continue;
          (batch ??= []).push(encode(r));
        }
        if (batch) this.session.broadcastAi(batch);
      }
    }

    // ── Render remotes ─────────────────────────────────────────────────────
    const renderT = performance.now() - CONFIG.net.interpDelayMs;
    for (const r of this.racers) {
      if (!r.remote) continue;
      const buf = this.buffers.get(r.id);
      if (!buf || buf.length === 0) continue;
      this.apply(r, buf, renderT, ctx);
    }
  }

  ingest(snap: BoatSnap) {
    const slot = snap[0];
    let buf = this.buffers.get(slot);
    if (!buf) {
      buf = [];
      this.buffers.set(slot, buf);
    }
    const t = performance.now();
    // A gap longer than two send periods means we lost a stretch (tab switch,
    // burst drop) — old frames would interpolate across the jump in one long
    // smear, so start clean instead.
    const last = buf[buf.length - 1];
    if (last && t - last.t > (2 / CONFIG.net.sendHz) * 1000 + 50) buf.length = 0;
    buf.push({ t, snap });
    // Two seconds at sendHz is far more than interpolation can ever need.
    if (buf.length > 40) buf.splice(0, buf.length - 40);
  }

  // ─────────────────────────────────────────────────────────────────────────

  private apply(r: Racer, buf: Snap[], renderT: number, ctx: GameContext) {
    const newest = buf[buf.length - 1];

    if (newest.t <= renderT) {
      // Everything we have is stale — dead-reckon, bounded, then hold.
      const over = Math.min(renderT - newest.t, CONFIG.net.extrapolateMs) / 1000;
      const s = newest.snap;
      r.root.position.x = s[1] + s[5] * over;
      r.root.position.z = s[3] + s[7] * over;
      this.writeDynamic(r, s, s[4], s[12], s[13], ctx);
      return;
    }

    // Find the pair straddling renderT and blend between them.
    let i = buf.length - 2;
    while (i >= 0 && buf[i].t > renderT) i--;
    const a = buf[Math.max(i, 0)];
    const b = buf[i + 1] ?? newest;
    const span = Math.max(b.t - a.t, 1);
    const alpha = Math.min(Math.max((renderT - a.t) / span, 0), 1);

    const A = a.snap;
    const B = b.snap;
    const x = A[1] + (B[1] - A[1]) * alpha;
    const z = A[3] + (B[3] - A[3]) * alpha;
    r.root.position.x = x;
    r.root.position.z = z;

    // Continuous channels blend; heading takes the short way round.
    const heading = A[4] + shortestArc(A[4], B[4]) * alpha;
    const pitch = A[12] + (B[12] - A[12]) * alpha;
    const roll = A[13] + (B[13] - A[13]) * alpha;
    this.writeDynamic(r, B, heading, pitch, roll, ctx, x, z);
  }

  /**
   * Write everything except XZ position. Discrete state (drift tier, boost)
   * comes from the newer snapshot; `y` is seated on the local ocean unless
   * the sender was airborne, damped so an air→water transition cannot pop.
   */
  private writeDynamic(
    r: Racer,
    newest: BoatSnap,
    heading: number,
    pitch: number,
    roll: number,
    ctx: GameContext,
    x?: number,
    z?: number,
  ) {
    const pos = r.root.position;
    const px = x ?? pos.x;
    const pz = z ?? pos.z;
    const targetY =
      newest[14] === 1 ? pos.y : this.surfaceHeight(px, pz, ctx.time) + SEAT_OFFSET;
    pos.y = damp(pos.y, targetY, 12, ctx.dt);

    r.state.heading = heading;
    r.state.velocity.set(newest[5], newest[6], newest[7]);
    r.state.forwardSpeed = newest[8];
    r.state.speedFrac = newest[9];
    r.state.driftTier = newest[10];
    r.state.boostTime = newest[11];
    r.state.pitch = pitch;
    r.state.roll = roll;
    r.state.airborne = newest[14] === 1;

    // BoatPhysics writes attitude after its step loop; remote racers are
    // skipped there, so the net subsystem owns the transform entirely.
    r.root.rotation.order = 'YXZ';
    r.root.rotation.y = heading;
    r.root.rotation.x = pitch;
    r.root.rotation.z = roll;
  }
}

// ─────────────────────────────────────────────────────────────────────────────

function shortestArc(a: number, b: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Compact a float to a fixed decimal count — halves the wire cost, and the
 *  precision loss is orders of magnitude below anything visible at 60 fps. */
function round(v: number, dp = 2): number {
  const m = 10 ** dp;
  return Math.round(v * m) / m;
}

function encode(r: Racer): BoatSnap {
  const p = r.root.position;
  const v = r.state.velocity;
  return [
    r.id,
    round(p.x),
    round(p.y),
    round(p.z),
    round(r.state.heading, 4),
    round(v.x, 3),
    round(v.y, 3),
    round(v.z, 3),
    round(r.state.forwardSpeed, 3),
    round(r.state.speedFrac, 3),
    r.state.driftTier,
    round(r.state.boostTime, 3),
    round(r.state.pitch, 4),
    round(r.state.roll, 4),
    r.state.airborne ? 1 : 0,
  ];
}
