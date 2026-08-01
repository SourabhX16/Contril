import { Boat } from '../entities/Boat';
import { Course, TOTAL_LAPS } from './Course';
import * as THREE from 'three';

export type RacePhase = 'countdown' | 'racing' | 'finished';

export interface RacerState {
  boat: Boat;
  name: string;
  lap: number;           // current lap (1-based, starts at 1)
  progress: number;      // 0..1 within current lap
  totalProgress: number; // laps + progress (for ranking)
  lapTimes: number[];
  lapStartTime: number;
  finished: boolean;
  finishTime: number;
  checkpointsPassed: Set<number>;
  lastT: number;         // last curve t, for lap crossing detection
  position: number;      // current race position (1-based)
  lastPosition: number;  // previous position (for change detection)
  positionChangedAt: number; // timestamp of last position change
}

// Required checkpoint fraction to validate a lap (must pass enough gates)
const MIN_CHECKPOINTS_FOR_LAP = 8; // out of 12 gates

export class RaceManager {
  phase: RacePhase = 'countdown';
  countdownValue = 3;
  private countdownTimer = 0;
  raceTime = 0;

  /** Racers in their original registration order (stable indices) */
  racers: RacerState[] = [];
  /** Racers sorted by position (updated each frame during racing) */
  private rankedRacers: RacerState[] = [];
  private course: Course;

  // Events for HUD/audio
  lastCheckpointHit = -1;  // index of last checkpoint any racer hit
  lastLapCompleted = false; // true for one frame when player completes a lap
  private finishSoundPlayed = false;

  constructor(course: Course) {
    this.course = course;
  }

  addRacer(boat: Boat, name: string): RacerState {
    const state: RacerState = {
      boat,
      name,
      lap: 1,             // start at lap 1
      progress: 0,
      totalProgress: 1,
      lapTimes: [],
      lapStartTime: 0,
      finished: false,
      finishTime: 0,
      checkpointsPassed: new Set(),
      lastT: 0,
      position: this.racers.length + 1,
      lastPosition: this.racers.length + 1,
      positionChangedAt: 0,
    };
    this.racers.push(state);
    this.rankedRacers.push(state);
    return state;
  }

  update(dt: number): void {
    this.lastLapCompleted = false;

    if (this.phase === 'countdown') {
      this.countdownTimer += dt;
      if (this.countdownTimer >= 1.0) {
        this.countdownTimer -= 1.0;
        this.countdownValue--;
        if (this.countdownValue <= 0) {
          this.phase = 'racing';
          this.racers.forEach(r => { r.lapStartTime = 0; });
        }
      }
      return;
    }

    if (this.phase === 'racing') {
      this.raceTime += dt;
    }

    for (const racer of this.racers) {
      if (racer.finished) continue;

      const { t } = this.course.getProgress(racer.boat.root.position);
      racer.progress = t;

      // Lap crossing: detect wraparound (t goes from >0.92 back to <0.08)
      if (racer.lastT > 0.92 && t < 0.08) {
        // Validate: must have passed enough checkpoints to count the lap
        const passedEnough = racer.checkpointsPassed.size >= MIN_CHECKPOINTS_FOR_LAP;

        if (passedEnough) {
          if (racer.lap > 1) {
            // Completed a lap (lap 1 is the starting lap)
            const lapTime = this.raceTime - racer.lapStartTime;
            racer.lapTimes.push(lapTime);
            racer.lapStartTime = this.raceTime;

            // Check if player completed a lap
            if (racer === this.racers[0]) {
              this.lastLapCompleted = true;
            }
          } else {
            // First crossing — lap 1 complete, start counting lap 2
            racer.lapStartTime = this.raceTime;
          }

          racer.lap++;
          racer.checkpointsPassed.clear();

          if (racer.lap > TOTAL_LAPS && this.phase === 'racing') {
            racer.finished = true;
            racer.finishTime = this.raceTime;
            // Check if all done
            if (this.racers.every(r => r.finished)) {
              this.phase = 'finished';
            }
          }
        }
        // If not enough checkpoints, don't advance lap (anti-shortcut)
      }
      racer.lastT = t;

      // Checkpoint detection
      const gateCount = this.course.gates.length;
      for (let i = 0; i < gateCount; i++) {
        const gatePos = this.course.gates[i].position;
        const dx = racer.boat.root.position.x - gatePos.x;
        const dz = racer.boat.root.position.z - gatePos.z;
        const distSq = dx * dx + dz * dz;
        if (distSq < 64 && !racer.checkpointsPassed.has(i)) { // 8² = 64
          racer.checkpointsPassed.add(i);
          // Track for audio
          if (racer === this.racers[0]) {
            this.lastCheckpointHit = i;
          }
        }
      }

      // Total progress for ranking
      racer.totalProgress = racer.lap + racer.progress;
    }

    // Sort rankings (separate array — doesn't affect racer indices)
    this.rankedRacers.sort((a, b) => b.totalProgress - a.totalProgress);

    // Update position numbers and track changes
    for (let i = 0; i < this.rankedRacers.length; i++) {
      const r = this.rankedRacers[i];
      const newPos = i + 1;
      if (newPos !== r.position) {
        r.lastPosition = r.position;
        r.position = newPos;
        r.positionChangedAt = this.raceTime;
      }
    }

    // Timeout: if a racer is stuck for too long, auto-finish them
    if (this.phase === 'racing' && this.raceTime > 300) { // 5 minute timeout
      for (const racer of this.racers) {
        if (!racer.finished) {
          racer.finished = true;
          racer.finishTime = this.raceTime;
        }
      }
      this.phase = 'finished';
    }
  }

  getPosition(boat: Boat): number {
    const racer = this.racers.find(r => r.boat === boat);
    return racer?.position ?? 1;
  }

  getState(boat: Boat): RacerState | undefined {
    return this.racers.find(r => r.boat === boat);
  }

  getRankings(): RacerState[] {
    return [...this.rankedRacers];
  }

  formatTime(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 100);
    return `${m}:${s.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
  }
}
