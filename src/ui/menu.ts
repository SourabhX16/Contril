/**
 * The title / lobby menu.
 *
 * DOM, not canvas: the HUD canvas is a hand-composed instrument panel, but a
 * menu needs text entry and buttons, and the ink aesthetic survives the trip
 * to CSS fine — skewed plates, paper type, one vermilion accent, no gradients.
 *
 * The menu owns *decisions*, the Game owns *consequences*: this module turns
 * clicks into controller calls and renders whatever state the NetSession
 * reports. It never touches racers or the race directly.
 */

import { css, HEX } from '../core/palette';
import type { NetSession } from '../net/session';

export interface MenuController {
  /** Classic single-player race. */
  solo(): void;
  /** Open a room as host; returns when the lobby is live. */
  host(name: string): void;
  /** Join an existing room by code. */
  join(code: string, name: string): void;
  /** Host pressed START. */
  start(): void;
  /** Leave the current room / abandon the lobby. */
  leave(): void;
}

const NAME_KEY = 'contril-name';

export class Menu {
  private root: HTMLElement;
  private views = new Map<string, HTMLElement>();
  private nameInput: HTMLInputElement;
  private codeInput: HTMLInputElement;
  private soloBtn: HTMLButtonElement;
  private hostBtn: HTMLButtonElement;
  private joinBtn: HTMLButtonElement;
  private backBtn: HTMLButtonElement;
  private startBtn: HTMLButtonElement;
  private roomCodeEl: HTMLElement;
  private rosterEl: HTMLElement;
  private lobbyStatusEl: HTMLElement;

  private view: 'title' | 'lobby' | 'none' = 'title';
  private isHost = false;
  private roomCode = '';

  constructor(
    private controller: MenuController,
    private session: NetSession,
    /** When true, Escape may pull the player out of a finished race. */
    private escapeAllowed: () => boolean,
  ) {
    const $ = <T extends HTMLElement>(id: string) => {
      const el = document.getElementById(id);
      if (!el) throw new Error(`menu: missing #${id}`);
      return el as T;
    };

    this.root = $('menu');
    for (const v of Array.from(this.root.querySelectorAll('[data-view]')) as HTMLElement[]) {
      this.views.set(v.dataset.view!, v);
    }
    this.nameInput = $<HTMLInputElement>('m-name');
    this.codeInput = $<HTMLInputElement>('m-code');
    this.soloBtn = $<HTMLButtonElement>('m-solo');
    this.hostBtn = $<HTMLButtonElement>('m-host');
    this.joinBtn = $<HTMLButtonElement>('m-join');
    this.backBtn = $<HTMLButtonElement>('m-back');
    this.startBtn = $<HTMLButtonElement>('m-start');
    this.roomCodeEl = $('m-room-code');
    this.rosterEl = $('m-roster');
    this.lobbyStatusEl = $('m-lobby-status');

    // Remember the pilot name across sessions.
    this.nameInput.value = localStorage.getItem(NAME_KEY) ?? '';

    this.soloBtn.addEventListener('click', () => {
      this.persistName();
      this.controller.solo();
    });
    this.hostBtn.addEventListener('click', () => {
      this.persistName();
      this.controller.host(this.name());
    });
    this.joinBtn.addEventListener('click', () => {
      const code = this.codeInput.value.trim().toUpperCase();
      if (code.length < 3) {
        this.codeInput.focus();
        return;
      }
      this.persistName();
      this.controller.join(code, this.name());
    });
    this.startBtn.addEventListener('click', () => this.controller.start());
    this.backBtn.addEventListener('click', () => this.controller.leave());
    this.roomCodeEl.addEventListener('click', () => {
      void navigator.clipboard?.writeText(this.roomCode).then(
        () => this.showLobbyStatus(`${this.roomCode} copied`, true),
        () => {},
      );
    });

    // Enter submits whichever field is focused on the title view.
    this.nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.hostBtn.click();
    });
    this.codeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.joinBtn.click();
      // Room codes are letters and digits only.
      e.stopPropagation();
    });

    // A shareable link (?room=CODE) pre-fills and focuses the join code.
    const roomParam = new URLSearchParams(location.search).get('room');
    if (roomParam) {
      this.codeInput.value = roomParam.toUpperCase();
      this.codeInput.focus();
      this.codeInput.select();
    }

    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (this.view === 'lobby') this.controller.leave();
      else if (this.view === 'none' && this.escapeAllowed()) this.controller.leave();
    });

    this.showTitle();
  }

  // ── States ────────────────────────────────────────────────────────────────

  showTitle() {
    this.view = 'title';
    this.isHost = false;
    this.root.classList.remove('hidden');
    for (const [name, el] of this.views) el.classList.toggle('on', name === 'title');
    this.soloBtn.disabled = false;
    this.hostBtn.disabled = false;
    this.joinBtn.disabled = false;
  }

  showLobby(code: string, isHost: boolean) {
    this.view = 'lobby';
    this.isHost = isHost;
    this.roomCode = code;
    this.root.classList.remove('hidden');
    for (const [name, el] of this.views) el.classList.toggle('on', name === 'lobby');
    this.roomCodeEl.textContent = code;
    this.refreshLobby();
  }

  hide() {
    this.view = 'none';
    this.root.classList.add('hidden');
  }

  showError(message: string) {
    // Errors arrive while the title is up (or should return to it).
    if (this.view !== 'title') this.showTitle();
    let status = this.root.querySelector('.status:not(.info)') as HTMLElement | null;
    if (!status) {
      status = document.createElement('div');
      status.className = 'status';
      this.views.get('title')!.appendChild(status);
    }
    status.textContent = message;
  }

  /**
   * Re-render the lobby from the session's roster. Called by the game whenever
   * the roster or connectivity changes.
   */
  refreshLobby() {
    if (this.view !== 'lobby') return;
    const s = this.session;
    const slots: { slot: number; name: string; human: boolean; mine: boolean }[] = [];
    for (let i = 0; i < 4; i++) {
      const entry = s.roster.find((p) => p.slot === i);
      slots.push({
        slot: i,
        name: entry ? (entry.peerId === s.myPeerId ? `${entry.name} (you)` : entry.name || '…') : 'AI',
        human: !!entry,
        mine: !!entry && entry.peerId === s.myPeerId,
      });
    }

    this.rosterEl.replaceChildren(
      ...slots.map(({ slot, name, human, mine }) => {
        const li = document.createElement('li');
        const chip = document.createElement('span');
        chip.className = 'chip';
        const hulls = [HEX.hull0, HEX.hull1, HEX.hull2, HEX.hull3];
        chip.style.background = css(hulls[slot]);
        const nm = document.createElement('span');
        nm.className = 'slot-name';
        nm.textContent = name;
        const tag = document.createElement('span');
        tag.className = 'slot-tag';
        // AI slots already say "AI" in the name column; only human rows carry
        // a readiness tag.
        tag.textContent = mine ? '' : human ? 'READY' : '';
        li.append(chip, nm, tag);
        return li;
      }),
    );

    if (this.isHost) {
      const waiting = s.roster.some((p) => !p.name || p.name === '…');
      this.startBtn.disabled = s.roster.length < 1 || waiting;
      this.showLobbyStatus(
        waiting
          ? 'Waiting for pilots…'
          : s.roster.length === 4
            ? 'Room full'
            : `${s.roster.length} of 4 slots taken`,
        true,
      );
    } else {
      this.startBtn.disabled = true;
      this.showLobbyStatus('Joined — waiting for the host to start', true);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────

  private name(): string {
    const n = this.nameInput.value.trim().toUpperCase();
    return (n || 'PILOT').slice(0, 10);
  }

  private persistName() {
    try {
      localStorage.setItem(NAME_KEY, this.name());
    } catch {
      /* private mode etc. — the default name still works */
    }
  }

  private showLobbyStatus(text: string, info: boolean) {
    this.lobbyStatusEl.textContent = text;
    this.lobbyStatusEl.classList.toggle('info', info);
  }
}
