import { RaceManager, type RacerState } from '../race/RaceManager';
import { Boat } from '../entities/Boat';
import { Course } from '../race/Course';
import * as THREE from 'three';

/**
 * HUD — canvas-based cel-style overlay
 * Draws: speedometer, lap, position (animated), split times, boost meter,
 * minimap, countdown with scale animation, wrong-way warning
 *
 * All animations are time-based (not frame-count).
 */
export class HUD {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;

  // Cel palette
  private readonly C = {
    bg:       'rgba(10, 5, 22, 0.75)',
    panel:    'rgba(10, 5, 22, 0.85)',
    outline:  '#0a0516',
    accent:   '#00ff88',
    accentDim:'#005533',
    text:     '#f0f8ff',
    textDim:  '#7099bb',
    speed:    '#7dd8f7',
    warn:     '#ff4040',
    boost:    '#ffd700',
    boostBg:  '#332200',
    posUp:    '#00ff88',  // position improved
    posDown:  '#ff4040',  // position worsened
  };

  private wrongWayTimer = 0;
  private gameTime = 0;

  // Animation state
  private goAnimTimer = 0;       // GO! text scale animation
  private posAnimTimer = 0;      // position change flash
  private posAnimDir = 0;        // +1 = gained, -1 = lost
  private lapAnimTimer = 0;      // lap transition flash
  private lastDisplayedPos = 0;
  private lastDisplayedLap = 0;

  // Cached minimap bounds
  private mapBounds: { minX: number; maxX: number; minZ: number; maxZ: number } | null = null;

  constructor() {
    this.canvas = document.getElementById('hud-canvas') as HTMLCanvasElement;
    this.ctx = this.canvas.getContext('2d')!;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width  = window.innerWidth  * dpr;
    this.canvas.height = window.innerHeight * dpr;
    this.canvas.style.width  = window.innerWidth  + 'px';
    this.canvas.style.height = window.innerHeight + 'px';
    this.ctx.scale(dpr, dpr);
    this.width  = window.innerWidth;
    this.height = window.innerHeight;
  }

  /** Draw one frame of HUD */
  draw(
    dt: number,
    race: RaceManager,
    playerBoat: Boat,
    playerState: RacerState | undefined,
    course: Course,
    allBoats: Boat[],
    isWrongWay: boolean
  ): void {
    const c = this.ctx;
    c.clearRect(0, 0, this.width, this.height);
    this.gameTime += dt;

    if (!playerState) return;

    // Cache minimap bounds on first draw
    if (!this.mapBounds) {
      this.mapBounds = course.getBounds();
    }

    // WRONG WAY warning (time-synced, not Date.now)
    if (isWrongWay) {
      this.wrongWayTimer = 0.5;
    }
    if (this.wrongWayTimer > 0) {
      this.wrongWayTimer -= dt;
      const flash = Math.sin(this.gameTime * 10) * 0.5 + 0.5;
      c.fillStyle = `rgba(255, 40, 40, ${0.7 * flash})`;
      c.font = 'bold 64px monospace';
      c.textAlign = 'center';
      c.fillText('WRONG WAY!', this.width / 2, this.height * 0.35);
    }

    // Countdown
    if (race.phase === 'countdown') {
      this._drawCountdown(race.countdownValue, dt);
      return;
    }

    // Decay animation timers
    this.goAnimTimer = Math.max(0, this.goAnimTimer - dt);
    this.posAnimTimer = Math.max(0, this.posAnimTimer - dt);
    this.lapAnimTimer = Math.max(0, this.lapAnimTimer - dt);

    // Detect position changes
    const currentPos = race.getPosition(playerBoat);
    if (this.lastDisplayedPos > 0 && currentPos !== this.lastDisplayedPos) {
      this.posAnimTimer = 0.8;
      this.posAnimDir = currentPos < this.lastDisplayedPos ? 1 : -1;
    }
    this.lastDisplayedPos = currentPos;

    // Detect lap changes
    if (this.lastDisplayedLap > 0 && playerState.lap !== this.lastDisplayedLap) {
      this.lapAnimTimer = 1.0;
    }
    this.lastDisplayedLap = playerState.lap;

    // Racing HUD
    this._drawSpeedometer(playerBoat.speed);
    this._drawLapInfo(playerState, race);
    this._drawPosition(currentPos, race.racers.length);
    this._drawBoostMeter(playerBoat);
    this._drawMinimap(course, allBoats, playerBoat);

    // GO! fade-out animation
    if (this.goAnimTimer > 0) {
      this._drawGoAnimation();
    }

    // Finished screen
    if (race.phase === 'finished') {
      this._drawResults(race);
    }
  }

  private _drawCountdown(value: number, dt: number): void {
    const c = this.ctx;
    const w = this.width, h = this.height;

    // Dark vignette
    const grad = c.createRadialGradient(w/2, h/2, 0, w/2, h/2, w*0.7);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, 'rgba(0,0,0,0.6)');
    c.fillStyle = grad;
    c.fillRect(0, 0, w, h);

    if (value > 0) {
      // Count number with pulse animation
      const pulse = 1.0 + Math.max(0, 0.3 - (this.gameTime % 1) * 0.6) * 0.5;
      const size = Math.round(180 * pulse);
      c.font = `bold ${size}px monospace`;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      // Outline
      c.strokeStyle = '#0a0516';
      c.lineWidth = 12;
      c.strokeText(String(value), w/2, h/2);
      c.fillStyle = '#7dd8f7';
      c.fillText(String(value), w/2, h/2);
    } else {
      // GO! with scale-up animation
      this.goAnimTimer = 1.5;
      this._drawGoAnimation();
    }

    // Game title at top
    c.font = 'bold 28px monospace';
    c.textAlign = 'center';
    c.textBaseline = 'top';
    c.fillStyle = '#7dd8f7';
    c.fillText('WAVE DASH', w/2, 24);
  }

  private _drawGoAnimation(): void {
    const c = this.ctx;
    const w = this.width, h = this.height;
    const t = this.goAnimTimer;

    // Scale up and fade out
    const scale = 1.0 + (1.5 - t) * 0.3;
    const alpha = Math.min(t * 2, 1);
    const size = Math.round(120 * scale);

    c.save();
    c.globalAlpha = alpha;
    c.font = `bold ${size}px monospace`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.strokeStyle = '#0a0516';
    c.lineWidth = 8;
    c.strokeText('GO!', w/2, h/2);
    c.fillStyle = '#00ff88';
    c.fillText('GO!', w/2, h/2);
    c.restore();
  }

  private _drawSpeedometer(speed: number): void {
    const c = this.ctx;
    const w = this.width, h = this.height;
    const x = w - 150, y = h - 100;
    const maxSpeed = 34;
    const pct = speed / maxSpeed;

    // Background panel
    this._roundRect(c, x - 10, y - 60, 140, 90, 8);
    c.fillStyle = this.C.panel;
    c.fill();
    c.strokeStyle = this.C.accent;
    c.lineWidth = 2;
    c.stroke();

    // Speed arc
    const cx = x + 55, cy = y + 20;
    const radius = 38;
    const startAngle = Math.PI * 0.75;
    const endAngle = Math.PI * 2.25;
    const totalArc = endAngle - startAngle;

    // Track
    c.beginPath();
    c.arc(cx, cy, radius, startAngle, endAngle);
    c.strokeStyle = this.C.accentDim;
    c.lineWidth = 8;
    c.stroke();

    // Fill — banded segments
    const bands = 5;
    const colors = ['#1e7fa8', '#00cc88', '#ffd700', '#ff8800', '#ff3333'];
    for (let i = 0; i < bands; i++) {
      if (pct >= i / bands) {
        const fill = Math.min(pct - i / bands, 1 / bands);
        const sa = startAngle + (i / bands) * totalArc;
        const ea = startAngle + (i / bands + fill) * totalArc;
        c.beginPath();
        c.arc(cx, cy, radius, sa, ea);
        c.strokeStyle = colors[i];
        c.lineWidth = 8;
        c.stroke();
      }
    }

    // Speed number
    c.font = 'bold 22px monospace';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillStyle = this.C.speed;
    c.fillText(Math.round(speed * 4).toString(), cx, cy);
    c.font = '10px monospace';
    c.fillStyle = this.C.textDim;
    c.fillText('KM/H', cx, cy + 15);
  }

  private _drawLapInfo(state: RacerState, race: RaceManager): void {
    const c = this.ctx;
    const x = 16, y = 16;

    // Lap flash animation
    const lapFlash = this.lapAnimTimer > 0;

    this._roundRect(c, x, y, 210, 85, 8);
    c.fillStyle = this.C.panel;
    c.fill();
    c.strokeStyle = lapFlash ? this.C.boost : this.C.accent;
    c.lineWidth = lapFlash ? 3 : 2;
    c.stroke();

    // Lap
    c.font = 'bold 14px monospace';
    c.textAlign = 'left';
    c.textBaseline = 'top';
    c.fillStyle = this.C.textDim;
    c.fillText('LAP', x + 12, y + 10);

    c.font = 'bold 36px monospace';
    c.fillStyle = lapFlash ? this.C.boost : this.C.text;
    const lapNum = race.phase === 'countdown' ? '-' : String(Math.min(Math.max(state.lap, 1), 3));
    c.fillText(`${lapNum}/3`, x + 50, y + 6);

    // Race time
    c.font = 'bold 13px monospace';
    c.fillStyle = this.C.textDim;
    c.fillText('TIME', x + 12, y + 50);
    c.fillStyle = this.C.text;
    c.fillText(race.formatTime(race.raceTime), x + 55, y + 50);

    // Best lap time
    if (state.lapTimes.length > 0) {
      const bestLap = Math.min(...state.lapTimes);
      c.font = '11px monospace';
      c.fillStyle = this.C.textDim;
      c.fillText('BEST', x + 12, y + 68);
      c.fillStyle = this.C.accent;
      c.fillText(race.formatTime(bestLap), x + 55, y + 68);
    }
  }

  private _drawPosition(pos: number, total: number): void {
    const c = this.ctx;
    const w = this.width;
    const x = w / 2 - 55, y = 16;
    const isAnimating = this.posAnimTimer > 0;
    const gained = this.posAnimDir > 0;

    this._roundRect(c, x, y, 110, 65, 8);
    c.fillStyle = this.C.panel;
    c.fill();

    // Flash border on position change
    let borderColor = pos === 1 ? '#ffd700' : this.C.accent;
    if (isAnimating) {
      const flash = Math.sin(this.gameTime * 15) * 0.5 + 0.5;
      borderColor = gained ? this.C.posUp : this.C.posDown;
      c.lineWidth = 2 + flash * 2;
    } else {
      c.lineWidth = 2;
    }
    c.strokeStyle = borderColor;
    c.stroke();

    c.textAlign = 'center';
    c.textBaseline = 'top';
    c.font = '11px monospace';
    c.fillStyle = this.C.textDim;
    c.fillText('POSITION', w / 2, y + 8);

    const suffix = ['st', 'nd', 'rd'][pos - 1] ?? 'th';
    c.font = 'bold 32px monospace';

    // Position text color: gold for 1st, flash color during animation
    if (isAnimating) {
      c.fillStyle = gained ? this.C.posUp : this.C.posDown;
    } else {
      c.fillStyle = pos === 1 ? '#ffd700' : this.C.text;
    }
    // Slide animation offset
    const slideY = isAnimating ? Math.sin(this.posAnimTimer * 10) * 3 * this.posAnimDir : 0;
    c.fillText(`${pos}${suffix}`, w / 2, y + 24 + slideY);
  }

  private _drawBoostMeter(boat: Boat): void {
    const c = this.ctx;
    const w = this.width, h = this.height;
    const x = 16, y = h - 80;

    this._roundRect(c, x, y, 160, 60, 8);
    c.fillStyle = this.C.panel;
    c.fill();
    c.strokeStyle = this.C.accent;
    c.lineWidth = 2;
    c.stroke();

    c.font = 'bold 10px monospace';
    c.fillStyle = this.C.textDim;
    c.textAlign = 'left';
    c.textBaseline = 'top';
    c.fillText('BOOST CHARGE', x + 8, y + 8);

    // Boost bar
    const barX = x + 8, barY = y + 26;
    const barW = 144, barH = 18;
    const charge = boat.driftCharge / 1.4;

    // BG
    c.fillStyle = this.C.boostBg;
    this._roundRect(c, barX, barY, barW, barH, 4);
    c.fill();

    // Fill (banded)
    if (charge > 0) {
      const fillW = Math.min(charge, 1) * barW;
      const color = boat.boostTimer > 0
        ? '#ff8800'
        : charge >= 1 ? '#ffd700' : '#aa7700';
      c.fillStyle = color;
      this._roundRect(c, barX, barY, fillW, barH, 4);
      c.fill();

      // Shimmer effect when fully charged
      if (charge >= 1) {
        const shimmer = Math.abs(Math.sin(this.gameTime * 5));
        c.fillStyle = `rgba(255, 255, 255, ${0.3 * shimmer})`;
        c.fill();
      }
    }

    // Active boost: pulsing bar
    if (boat.boostTimer > 0) {
      const pulse = Math.sin(this.gameTime * 12) * 0.15 + 0.85;
      c.fillStyle = `rgba(255, 136, 0, ${pulse * 0.4})`;
      this._roundRect(c, barX, barY, barW, barH, 4);
      c.fill();

      c.font = 'bold 11px monospace';
      c.fillStyle = '#ffd700';
      c.textAlign = 'center';
      c.fillText('BOOST!', barX + barW / 2, barY + 3);
    }

    // "DRIFT!" label when drifting (not boosting)
    if (boat.isDrifting && boat.boostTimer <= 0) {
      c.font = 'bold 11px monospace';
      c.fillStyle = '#ffd700';
      c.textAlign = 'right';
      c.fillText('DRIFT!', x + 152, barY + 3);
    }
  }

  private _drawMinimap(
    course: Course,
    boats: Boat[],
    playerBoat: Boat
  ): void {
    const c = this.ctx;
    const w = this.width, h = this.height;
    const mx = w - 150, my = h - 175;
    const mw = 130, mh = 130;

    // Background
    this._roundRect(c, mx - 5, my - 5, mw + 10, mh + 10, 8);
    c.fillStyle = this.C.panel;
    c.fill();
    c.strokeStyle = this.C.accent;
    c.lineWidth = 2;
    c.stroke();

    // Use auto-computed bounds
    const bounds = this.mapBounds!;
    const scaleX = mw / (bounds.maxX - bounds.minX);
    const scaleZ = mh / (bounds.maxZ - bounds.minZ);

    // Draw course spline on minimap
    const pts = course.curve.getPoints(100);
    c.beginPath();
    pts.forEach((pt, i) => {
      const px = mx + (pt.x - bounds.minX) * scaleX;
      const pz = my + (pt.z - bounds.minZ) * scaleZ;
      if (i === 0) c.moveTo(px, pz);
      else c.lineTo(px, pz);
    });
    // Close it
    const fp = pts[0];
    c.lineTo(mx + (fp.x - bounds.minX) * scaleX, my + (fp.z - bounds.minZ) * scaleZ);
    c.strokeStyle = this.C.accentDim;
    c.lineWidth = 2;
    c.stroke();

    // Draw all boats
    const BOAT_COLORS = ['#ff4040', '#40ff80', '#ffd700', '#c040ff'];
    boats.forEach((boat, i) => {
      const bx = mx + (boat.root.position.x - bounds.minX) * scaleX;
      const bz = my + (boat.root.position.z - bounds.minZ) * scaleZ;
      const isPlayer = boat === playerBoat;

      // Direction arrow
      c.save();
      c.translate(bx, bz);
      c.rotate(-boat.heading);
      c.fillStyle = BOAT_COLORS[i] ?? '#ffffff';
      c.beginPath();
      c.moveTo(0, -6);
      c.lineTo(3.5, 3);
      c.lineTo(-3.5, 3);
      c.closePath();
      c.fill();
      if (isPlayer) {
        c.strokeStyle = '#ffffff';
        c.lineWidth = 1.5;
        c.stroke();
      }
      c.restore();
    });
  }

  private _drawResults(race: RaceManager): void {
    const c = this.ctx;
    const w = this.width, h = this.height;

    // Dark overlay
    c.fillStyle = 'rgba(10, 5, 22, 0.85)';
    c.fillRect(0, 0, w, h);

    const rankings = race.getRankings();
    const panelW = 500, panelH = 380;
    const px = (w - panelW) / 2, py = (h - panelH) / 2;

    // Panel
    this._roundRect(c, px, py, panelW, panelH, 12);
    c.fillStyle = 'rgba(10, 5, 22, 0.95)';
    c.fill();
    c.strokeStyle = '#ffd700';
    c.lineWidth = 3;
    c.stroke();

    // Title with glow
    c.font = 'bold 42px monospace';
    c.textAlign = 'center';
    c.textBaseline = 'top';
    c.fillStyle = '#ffd700';
    c.fillText('RACE OVER', w / 2, py + 20);

    c.font = '14px monospace';
    c.fillStyle = '#7099bb';
    c.fillText('FINAL STANDINGS', w / 2, py + 72);

    const BOAT_COLORS = ['#ff4040', '#40ff80', '#ffd700', '#c040ff'];
    rankings.forEach((r, i) => {
      const ry = py + 100 + i * 60;
      const isFirst = i === 0;

      // Row
      c.fillStyle = isFirst ? 'rgba(255, 215, 0, 0.1)' : 'rgba(255,255,255,0.03)';
      this._roundRect(c, px + 20, ry, panelW - 40, 48, 6);
      c.fill();
      c.strokeStyle = isFirst ? '#ffd700' : '#1e3050';
      c.lineWidth = 1;
      c.stroke();

      // Position medal
      const medalColors = ['#ffd700', '#c0c0c0', '#cd7f32', '#7099bb'];
      c.fillStyle = medalColors[i] ?? '#7099bb';
      c.font = 'bold 22px monospace';
      c.textAlign = 'left';
      c.textBaseline = 'middle';
      c.fillText(`${i + 1}.`, px + 36, ry + 24);

      // Color dot — use racer's actual boat index
      const boatIndex = race.racers.indexOf(r);
      c.fillStyle = BOAT_COLORS[boatIndex % BOAT_COLORS.length];
      c.beginPath();
      c.arc(px + 76, ry + 24, 8, 0, Math.PI * 2);
      c.fill();

      // Name
      c.fillStyle = '#f0f8ff';
      c.font = 'bold 18px monospace';
      c.fillText(r.name, px + 94, ry + 24);

      // Time
      c.fillStyle = '#7dd8f7';
      c.font = '16px monospace';
      c.textAlign = 'right';
      c.fillText(
        r.finished ? race.formatTime(r.finishTime) : 'DNF',
        px + panelW - 36,
        ry + 24
      );
    });

    // Restart hint
    c.font = '14px monospace';
    c.textAlign = 'center';
    c.fillStyle = '#7099bb';
    c.fillText('Press R to restart', w / 2, py + panelH - 24);
  }

  private _roundRect(
    c: CanvasRenderingContext2D,
    x: number, y: number,
    w: number, h: number,
    r: number
  ): void {
    c.beginPath();
    c.moveTo(x + r, y);
    c.lineTo(x + w - r, y);
    c.arcTo(x + w, y, x + w, y + r, r);
    c.lineTo(x + w, y + h - r);
    c.arcTo(x + w, y + h, x + w - r, y + h, r);
    c.lineTo(x + r, y + h);
    c.arcTo(x, y + h, x, y + h - r, r);
    c.lineTo(x, y + r);
    c.arcTo(x, y, x + r, y, r);
    c.closePath();
  }
}
