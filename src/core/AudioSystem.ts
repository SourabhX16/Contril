/**
 * AudioSystem — all sounds synthesized via Web Audio API
 * Engine tone (3 layers), water rush, drift screech, impact splash,
 * start horn, boost whoosh, checkpoint ding, finish fanfare, wind rush
 */
export class AudioSystem {
  private ctx: AudioContext | null = null;
  private engineOsc: OscillatorNode | null = null;
  private engineOsc2: OscillatorNode | null = null;
  private engineGain: GainNode | null = null;
  private engineFilter: BiquadFilterNode | null = null;
  private waterGain: GainNode | null = null;
  private windGain: GainNode | null = null;
  private windFilter: BiquadFilterNode | null = null;
  private driftGain: GainNode | null = null;
  private driftFilter: BiquadFilterNode | null = null;
  private driftNoise: AudioBufferSourceNode | null = null;
  private masterGain: GainNode | null = null;
  private running = false;

  init(): void {
    try {
      this.ctx = new AudioContext();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = 0.55;
      this.masterGain.connect(this.ctx.destination);

      this._buildEngine();
      this._buildWater();
      this._buildWind();
      this._buildDrift();
      this.running = true;
    } catch (e) {
      console.warn('Audio init failed:', e);
    }
  }

  private _buildEngine(): void {
    if (!this.ctx || !this.masterGain) return;

    // Layered engine: fundamental sawtooth + harmonic square + sub-bass sine
    this.engineGain = this.ctx.createGain();
    this.engineGain.gain.value = 0;
    this.engineGain.connect(this.masterGain);

    this.engineFilter = this.ctx.createBiquadFilter();
    this.engineFilter.type = 'bandpass';
    this.engineFilter.frequency.value = 300;
    this.engineFilter.Q.value = 1.2;
    this.engineFilter.connect(this.engineGain);

    // Main oscillator (sawtooth for engine growl)
    this.engineOsc = this.ctx.createOscillator();
    this.engineOsc.type = 'sawtooth';
    this.engineOsc.frequency.value = 80;
    this.engineOsc.connect(this.engineFilter);
    this.engineOsc.start();

    // Second harmonic (square, slightly detuned for richness)
    this.engineOsc2 = this.ctx.createOscillator();
    this.engineOsc2.type = 'square';
    this.engineOsc2.frequency.value = 160;
    const g2 = this.ctx.createGain();
    g2.gain.value = 0.25;
    this.engineOsc2.connect(g2);
    g2.connect(this.engineFilter);
    this.engineOsc2.start();

    // Sub-bass sine for low-end punch
    const subOsc = this.ctx.createOscillator();
    subOsc.type = 'sine';
    subOsc.frequency.value = 40;
    const subGain = this.ctx.createGain();
    subGain.gain.value = 0.15;
    subOsc.connect(subGain);
    subGain.connect(this.engineGain);
    subOsc.start();

    // Noise layer for engine texture
    const noiseLen = this.ctx.sampleRate;
    const noiseBuf = this.ctx.createBuffer(1, noiseLen, this.ctx.sampleRate);
    const noiseData = noiseBuf.getChannelData(0);
    for (let i = 0; i < noiseLen; i++) noiseData[i] = Math.random() * 2 - 1;
    const noiseSrc = this.ctx.createBufferSource();
    noiseSrc.buffer = noiseBuf;
    noiseSrc.loop = true;
    const noiseFilter = this.ctx.createBiquadFilter();
    noiseFilter.type = 'bandpass';
    noiseFilter.frequency.value = 400;
    noiseFilter.Q.value = 2;
    const noiseGain = this.ctx.createGain();
    noiseGain.gain.value = 0.06;
    noiseSrc.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(this.engineGain);
    noiseSrc.start();
  }

  private _buildWater(): void {
    if (!this.ctx || !this.masterGain) return;

    const bufferSize = 2 * this.ctx.sampleRate;
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 800;
    filter.Q.value = 0.5;

    this.waterGain = this.ctx.createGain();
    this.waterGain.gain.value = 0;

    source.connect(filter);
    filter.connect(this.waterGain);
    this.waterGain.connect(this.masterGain);
    source.start();
  }

  private _buildWind(): void {
    if (!this.ctx || !this.masterGain) return;

    // High-frequency filtered noise for wind rush
    const bufferSize = 2 * this.ctx.sampleRate;
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;

    this.windFilter = this.ctx.createBiquadFilter();
    this.windFilter.type = 'highpass';
    this.windFilter.frequency.value = 2000;
    this.windFilter.Q.value = 0.3;

    this.windGain = this.ctx.createGain();
    this.windGain.gain.value = 0;

    source.connect(this.windFilter);
    this.windFilter.connect(this.windGain);
    this.windGain.connect(this.masterGain);
    source.start();
  }

  private _buildDrift(): void {
    if (!this.ctx || !this.masterGain) return;

    // Drift screech: filtered noise sweep
    const bufferSize = 2 * this.ctx.sampleRate;
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;

    this.driftNoise = this.ctx.createBufferSource();
    this.driftNoise.buffer = buffer;
    this.driftNoise.loop = true;

    this.driftFilter = this.ctx.createBiquadFilter();
    this.driftFilter.type = 'bandpass';
    this.driftFilter.frequency.value = 1200;
    this.driftFilter.Q.value = 3;

    this.driftGain = this.ctx.createGain();
    this.driftGain.gain.value = 0;

    this.driftNoise.connect(this.driftFilter);
    this.driftFilter.connect(this.driftGain);
    this.driftGain.connect(this.masterGain);
    this.driftNoise.start();
  }

  /** Update all continuous sounds from speed, throttle, drift state */
  updateEngine(
    speed: number,
    throttle: number,
    isAirborne: boolean,
    isDrifting: boolean
  ): void {
    if (!this.ctx || !this.engineOsc || !this.engineGain || !this.waterGain) return;

    const now = this.ctx.currentTime;
    const rpm = 80 + speed * 5.5 + throttle * 45;
    const vol = isAirborne
      ? throttle * 0.12
      : (speed * 0.016 + throttle * 0.22);

    // Smooth engine pitch and volume transitions
    this.engineOsc.frequency.setTargetAtTime(rpm, now, 0.04);
    if (this.engineOsc2) {
      this.engineOsc2.frequency.setTargetAtTime(rpm * 2.01, now, 0.04); // slight detune
    }
    this.engineGain.gain.setTargetAtTime(Math.min(vol, 0.4), now, 0.06);

    // Engine filter tracks RPM for tonal change
    if (this.engineFilter) {
      this.engineFilter.frequency.setTargetAtTime(120 + rpm * 1.8, now, 0.08);
    }

    // Water rush — proportional to speed
    const waterVol = Math.min(speed * 0.01, 0.2);
    this.waterGain.gain.setTargetAtTime(waterVol, now, 0.12);

    // Wind rush at high speed
    if (this.windGain && this.windFilter) {
      const windVol = Math.max((speed - 12) * 0.008, 0);
      this.windGain.gain.setTargetAtTime(Math.min(windVol, 0.15), now, 0.15);
      // Wind pitch rises with speed
      this.windFilter.frequency.setTargetAtTime(1500 + speed * 80, now, 0.1);
    }

    // Drift screech
    if (this.driftGain && this.driftFilter) {
      const driftVol = isDrifting ? Math.min(speed * 0.008, 0.12) : 0;
      this.driftGain.gain.setTargetAtTime(driftVol, now, 0.05);
      // Sweep filter during drift
      if (isDrifting) {
        this.driftFilter.frequency.setTargetAtTime(800 + speed * 30, now, 0.1);
      }
    }
  }

  playImpact(intensity: number): void {
    if (!this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;

    // Low thud
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(intensity * 0.7, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.4);
    g.connect(this.masterGain);

    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(70, now);
    osc.frequency.exponentialRampToValueAtTime(25, now + 0.35);
    osc.connect(g);
    osc.start(now);
    osc.stop(now + 0.4);

    // Splash noise burst (high frequency component)
    const splashLen = Math.floor(this.ctx.sampleRate * 0.2);
    const splashBuf = this.ctx.createBuffer(1, splashLen, this.ctx.sampleRate);
    const d = splashBuf.getChannelData(0);
    for (let i = 0; i < splashLen; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / splashLen, 2);
    }
    const src = this.ctx.createBufferSource();
    src.buffer = splashBuf;

    const splashFilter = this.ctx.createBiquadFilter();
    splashFilter.type = 'bandpass';
    splashFilter.frequency.value = 3000;
    splashFilter.Q.value = 0.8;

    const ng = this.ctx.createGain();
    ng.gain.setValueAtTime(intensity * 0.35, now);
    ng.gain.exponentialRampToValueAtTime(0.001, now + 0.25);

    src.connect(splashFilter);
    splashFilter.connect(ng);
    ng.connect(this.masterGain);
    src.start(now);
  }

  playStartHorn(): void {
    if (!this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;

    // Ascending three-note horn
    const notes = [220, 330, 440];
    notes.forEach((freq, i) => {
      const g = this.ctx!.createGain();
      g.gain.setValueAtTime(0, now + i * 0.25);
      g.gain.linearRampToValueAtTime(0.45, now + i * 0.25 + 0.05);
      g.gain.setValueAtTime(0.45, now + i * 0.25 + 0.2);
      g.gain.linearRampToValueAtTime(0, now + i * 0.25 + 0.3);
      g.connect(this.masterGain!);

      const o = this.ctx!.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = freq;
      o.connect(g);
      o.start(now + i * 0.25);
      o.stop(now + i * 0.25 + 0.3);
    });
  }

  playBoost(): void {
    if (!this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;

    // Whoosh: ascending sine + noise burst
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.25, now);
    g.gain.linearRampToValueAtTime(0.15, now + 0.3);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.9);
    g.connect(this.masterGain);

    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(400, now);
    o.frequency.exponentialRampToValueAtTime(1400, now + 0.5);
    o.connect(g);
    o.start(now);
    o.stop(now + 0.9);

    // Noise whoosh
    const noiseLen = Math.floor(this.ctx.sampleRate * 0.6);
    const noiseBuf = this.ctx.createBuffer(1, noiseLen, this.ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < noiseLen; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / noiseLen, 1.5);
    }
    const nSrc = this.ctx.createBufferSource();
    nSrc.buffer = noiseBuf;
    const nFilter = this.ctx.createBiquadFilter();
    nFilter.type = 'highpass';
    nFilter.frequency.value = 2000;
    const nGain = this.ctx.createGain();
    nGain.gain.value = 0.12;
    nSrc.connect(nFilter);
    nFilter.connect(nGain);
    nGain.connect(this.masterGain);
    nSrc.start(now);
  }

  /** Short ascending ding when passing a checkpoint gate */
  playCheckpoint(): void {
    if (!this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;

    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.3, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
    g.connect(this.masterGain);

    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(880, now);
    o.frequency.linearRampToValueAtTime(1320, now + 0.1);
    o.connect(g);
    o.start(now);
    o.stop(now + 0.3);
  }

  /** Celebration fanfare on race finish */
  playFinish(): void {
    if (!this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;

    // Ascending chord: C5-E5-G5-C6
    const notes = [523, 659, 784, 1047];
    notes.forEach((freq, i) => {
      const delay = i * 0.08;
      const g = this.ctx!.createGain();
      g.gain.setValueAtTime(0, now + delay);
      g.gain.linearRampToValueAtTime(0.3, now + delay + 0.05);
      g.gain.setValueAtTime(0.3, now + delay + 0.4);
      g.gain.exponentialRampToValueAtTime(0.001, now + delay + 1.2);
      g.connect(this.masterGain!);

      const o = this.ctx!.createOscillator();
      o.type = 'triangle';
      o.frequency.value = freq;
      o.connect(g);
      o.start(now + delay);
      o.stop(now + delay + 1.2);
    });
  }

  /** Lap complete ding */
  playLapComplete(): void {
    if (!this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;

    // Two-note ascending
    [660, 880].forEach((freq, i) => {
      const g = this.ctx!.createGain();
      g.gain.setValueAtTime(0.25, now + i * 0.12);
      g.gain.exponentialRampToValueAtTime(0.001, now + i * 0.12 + 0.4);
      g.connect(this.masterGain!);

      const o = this.ctx!.createOscillator();
      o.type = 'sine';
      o.frequency.value = freq;
      o.connect(g);
      o.start(now + i * 0.12);
      o.stop(now + i * 0.12 + 0.4);
    });
  }

  resume(): void {
    if (this.ctx?.state === 'suspended') {
      this.ctx.resume();
    }
  }
}
