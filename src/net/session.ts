/**
 * The transport and lobby layer.
 *
 * ── Topology ────────────────────────────────────────────────────────────────
 * Full mesh over WebRTC (Trystero). Signalling goes through public Nostr
 * relays; gameplay data is peer-to-peer, so the game stays a static site —
 * no server to deploy, which is what keeps the "zero external assets" rule
 * intact at the network layer too.
 *
 * ── Authority ───────────────────────────────────────────────────────────────
 * Every client simulates exactly one boat with full physics: its own. A racer
 * slot is therefore either *yours*, *someone else's* (you interpolate their
 * broadcasts), or *AI*. AI slots are simulated by the host alone and broadcast
 * like players, so every client sees the same race without anyone agreeing on
 * an RNG stream. Race progress (laps, gates, standings) is re-derived locally
 * from shared positions — positions are the only thing that needs syncing.
 *
 * Slots are fixed 0–3 and map 1:1 onto hull colours and grid positions. The
 * host takes slot 0; joiners get the next free slot; empty slots stay AI.
 *
 * ── Lifecycle ───────────────────────────────────────────────────────────────
 * Lobby: host maintains the roster and rebroadcasts it on every change.
 * Race start / restart: anyone may broadcast `start`, which carries only a
 * countdown in milliseconds; each receiver anchors it to its own monotonic
 * clock, so machine clock skew never enters the picture. A guest joining
 * mid-race sits in the lobby until the next start message includes them.
 */

import { joinRoom, selfId } from 'trystero/nostr';
import type { JsonValue, Room } from 'trystero/nostr';
import { CONFIG } from '../core/config';

/** Unambiguous alphabet for room codes — no 0/O or 1/I. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Wire types are type aliases, not interfaces: trystero's DataPayload
 *  constraint demands an index signature, which only aliases infer. */
export type LobbyPlayer = {
  /** Racer slot 0–3. Doubles as hull colour and grid position. */
  slot: number;
  name: string;
  /** Trystero peer id; '' for an AI-filled slot. */
  peerId: string;
};

/** Host → everyone: the lobby roster. */
export type RosterMsg = {
  players: LobbyPlayer[];
};

/** Anyone → everyone: begin a race (or restart the current one). */
export type StartMsg = {
  /** Milliseconds until the green light, counted from receipt. */
  cd: number;
  /**
   * Seed of the procedural circuit. Every client regenerates the identical
   * track from this one number — the only way a generated course can be shared
   * without shipping geometry.
   */
  seed?: number;
  /** Roster snapshot so mid-race joiners can start cold. */
  players?: LobbyPlayer[];
};

/** One boat snapshot. Flat array to keep the per-15 Hz payload tiny. */
export type BoatSnap = [
  slot: number,
  x: number,
  y: number,
  z: number,
  heading: number,
  vx: number,
  vy: number,
  vz: number,
  fwdSpeed: number,
  speedFrac: number,
  driftTier: number,
  boostTime: number,
  pitch: number,
  roll: number,
  airborne: 0 | 1,
];

export interface NetHooks {
  /** Roster or connectivity changed while in the lobby. */
  onLobbyChanged(): void;
  /** A start/restart message arrived (and was validated). */
  onStart(msg: StartMsg): void;
  /** A boat snapshot arrived from any peer. */
  onSnapshot(snap: BoatSnap): void;
  /** The host's batched AI snapshots arrived (guests only). */
  onAiBatch(batch: BoatSnap[]): void;
  /** Fatal session problem — caller should drop back to the menu. */
  onError(message: string): void;
}

export type NetRole = 'host' | 'guest';

export class NetSession {
  readonly myPeerId = selfId;
  role: NetRole | null = null;
  active = false;
  roomCode = '';
  /** Mirrored lobby state. Authoritative copy lives on the host. */
  roster: LobbyPlayer[] = [];
  /** True while a race is running somewhere in this room. */
  raceRunning = false;

  private room: Room | null = null;
  private sendHello: ((data: string) => Promise<void>) | null = null;
  private sendRoster: ((data: RosterMsg) => Promise<void>) | null = null;
  private sendStart: ((data: StartMsg) => Promise<void>) | null = null;
  private sendState: ((data: BoatSnap) => Promise<void>) | null = null;
  private sendAi: ((data: BoatSnap[]) => Promise<void>) | null = null;
  /**
   * Names announced before the host has seen the peer join (the two events
   * race across different relays), parked here until the slot is assigned.
   */
  private pendingNames = new Map<string, string>();
  /** This pilot's lobby name; re-announced whenever a peer link comes up. */
  private myName = '';

  /** My slot, resolved from the roster once the host has assigned it. */
  get mySlot(): number {
    const me = this.roster.find((p) => p.peerId === this.myPeerId);
    return me ? me.slot : -1;
  }

  constructor(private hooks: NetHooks) {}

  /** Open a room as host. Slot 0 is yours; later joiners fill 1–3. */
  host(name: string): string {
    const code = this.genCode();
    this.myName = name;
    this.open(code, 'host');
    // The roster starts as just us; peers slot in as they join.
    this.roster = [{ slot: 0, name, peerId: this.myPeerId }];
    void this.sendRoster?.({ players: this.roster });
    this.hooks.onLobbyChanged();
    return code;
  }

  join(code: string, name: string): void {
    this.myName = name;
    this.open(code.toUpperCase(), 'guest');
    // Fire immediately in case a peer is already reachable; the onPeerJoin
    // resend below covers the far more common case of joining an empty room,
    // where this first shot has nobody to reach.
    void this.sendHello?.(name);
  }

  async leave(): Promise<void> {
    this.active = false;
    this.role = null;
    this.raceRunning = false;
    this.roomCode = '';
    this.roster = [];
    const room = this.room;
    this.room = null;
    if (room) await room.leave();
  }

  /** Host only: publish the current roster to the room. */
  publishRoster(): void {
    if (this.role !== 'host') return;
    void this.sendRoster?.({ players: this.roster });
    this.hooks.onLobbyChanged();
  }

  /** Anyone may start a race or restart a finished one. */
  broadcastStart(cd: number, seed?: number): void {
    const players =
      this.role === 'host' ? this.roster : undefined;
    void this.sendStart?.({ cd, seed, players });
  }

  broadcastState(snap: BoatSnap): void {
    void this.sendState?.(snap);
  }

  broadcastAi(batch: BoatSnap[]): void {
    void this.sendAi?.(batch);
  }

  /** Peer count right now (excluding self). */
  peerCount(): number {
    return this.room ? Object.keys(this.room.getPeers()).length : 0;
  }

  // ─────────────────────────────────────────────────────────────────────────

  private open(code: string, role: NetRole): void {
    this.roomCode = code;
    this.role = role;
    this.active = true;
    this.raceRunning = false;

    const room = joinRoom({ appId: CONFIG.net.appId }, code, {
      onJoinError: (details) =>
        this.hooks.onError(`Could not reach the signalling relays (${details.error}).`),
    });
    this.room = room;

    room.onPeerJoin = (peerId) => this.onPeerJoin(peerId);
    room.onPeerLeave = (peerId) => this.onPeerLeave(peerId);

    const helloAction = room.makeAction<string>('hello');
    helloAction.onMessage = (name, { peerId }) => {
      if (this.role !== 'host') return;
      const entry = this.roster.find((p) => p.peerId === peerId);
      if (entry && entry.name !== name) {
        entry.name = name;
        this.publishRoster();
      } else if (!entry) {
        // Join announcement still in flight; park the name for onPeerJoin.
        this.pendingNames.set(peerId, name);
      }
    };
    this.sendHello = helloAction.send;

    const rosterAction = room.makeAction<RosterMsg>('rost');
    rosterAction.onMessage = (data) => {
      // Only the host may define the roster; guards a rogue/mixed-version peer.
      if (this.role === 'guest') {
        this.roster = data.players;
        this.hooks.onLobbyChanged();
      }
    };
    this.sendRoster = rosterAction.send;

    const startAction = room.makeAction<StartMsg>('strt');
    startAction.onMessage = (msg) => {
      if (msg.players) {
        this.roster = msg.players;
        this.raceRunning = true;
      }
      this.hooks.onStart(msg);
    };
    this.sendStart = startAction.send;

    const stateAction = room.makeAction<BoatSnap>('st');
    stateAction.onMessage = (snap) => this.hooks.onSnapshot(snap);
    this.sendState = stateAction.send;

    const aiAction = room.makeAction<BoatSnap[]>('ai');
    aiAction.onMessage = (batch) => this.hooks.onAiBatch(batch);
    this.sendAi = aiAction.send;
  }

  private onPeerJoin(peerId: string): void {
    // The data channel to this peer only just came up, so anything sent at
    // page-load time never reached them. Announce ourselves now.
    if (this.role === 'guest' && this.myName) void this.sendHello?.(this.myName);
    if (this.role === 'host') {
      // First free slot wins; the field is capped at CONFIG.race.racerCount.
      const taken = new Set(this.roster.map((p) => p.slot));
      let slot = -1;
      for (let i = 0; i < CONFIG.race.racerCount; i++) {
        if (!taken.has(i)) {
          slot = i;
          break;
        }
      }
      if (slot >= 0) {
        // A hello may have beaten the join announcement across the relays.
        const name = this.pendingNames.get(peerId) ?? '…';
        this.pendingNames.delete(peerId);
        this.roster.push({ slot, name, peerId });
        this.publishRoster(); // announces the slot; hello fills/refreshed the name
      }
      // A room already racing tells the newcomer via the next start broadcast;
      // nothing else to do here.
    }
    this.hooks.onLobbyChanged();
  }

  private onPeerLeave(peerId: string): void {
    this.pendingNames.delete(peerId);
    if (this.role === 'host') {
      const had = this.roster.some((p) => p.peerId === peerId);
      this.roster = this.roster.filter((p) => p.peerId !== peerId);
      if (had) this.publishRoster(); // freed slot falls back to AI everywhere
    } else {
      const hostPeer = this.roster.find((p) => p.slot === 0);
      // If the host itself vanished, the party is over — nobody else is
      // broadcasting the AI field.
      if (hostPeer && peerId === hostPeer.peerId) {
        void this.leave();
        this.hooks.onError('The host left the room.');
        return;
      }
      this.roster = this.roster.filter((p) => p.peerId !== peerId);
      this.hooks.onLobbyChanged();
    }
    this.hooks.onLobbyChanged();
  }

  private genCode(): string {
    let out = '';
    for (let i = 0; i < 5; i++) {
      out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    }
    return out;
  }
}
