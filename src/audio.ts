/**
 * Procedural audio.
 *
 * There are no sound files. Ambience, music and effects are all synthesised with
 * WebAudio, which keeps the install tiny and lets the score follow the simulation —
 * the drone shifts with the season, and the river gets louder during the inundation.
 *
 * iOS will not start an AudioContext without a user gesture, so `unlock()` must be
 * called from a real touch handler.
 */

import { RNG, clamp } from './core';

/** A double-harmonic ("Egyptian") scale in semitones from the root. */
const SCALE = [0, 1, 4, 5, 7, 8, 11];

export class AudioEngine {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private musicBus!: GainNode;
  private ambientBus!: GainNode;
  private sfxBus!: GainNode;
  private noiseBuffer!: AudioBuffer;

  private windGain!: GainNode;
  private riverGain!: GainNode;
  private droneGain!: GainNode;

  private rng = new RNG(0xc0ffee);
  private nextNoteAt = 0;
  private schedulerTimer: number | null = null;
  private root = 55; // A1

  enabled = true;
  musicVolume = 0.34;
  sfxVolume = 0.6;
  ambientVolume = 0.5;

  private started = false;

  /** Must be called from inside a user gesture. */
  async unlock(): Promise<void> {
    if (this.started) {
      if (this.ctx?.state === 'suspended') await this.ctx.resume();
      return;
    }
    const AC: typeof AudioContext = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC({ latencyHint: 'interactive' });
    this.ctx = ctx;
    await ctx.resume();

    this.master = ctx.createGain();
    this.master.gain.value = this.enabled ? 0.9 : 0;
    this.master.connect(ctx.destination);

    // A gentle limiter keeps stacked plucks from clipping on phone speakers.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 18;
    comp.ratio.value = 5;
    comp.attack.value = 0.005;
    comp.release.value = 0.22;
    comp.connect(this.master);

    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = this.musicVolume;
    this.musicBus.connect(comp);

    this.ambientBus = ctx.createGain();
    this.ambientBus.gain.value = this.ambientVolume;
    this.ambientBus.connect(comp);

    this.sfxBus = ctx.createGain();
    this.sfxBus.gain.value = this.sfxVolume;
    this.sfxBus.connect(comp);

    this.noiseBuffer = this.makeNoise(ctx, 3);
    this.startAmbience();
    this.startMusic();
    this.started = true;
  }

  private makeNoise(ctx: AudioContext, seconds: number): AudioBuffer {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      // Brown-ish noise: smoother and far less fatiguing than white.
      const white = this.rng.float(-1, 1);
      last = (last + 0.02 * white) / 1.02;
      d[i] = last * 3.2;
    }
    return buf;
  }

  private loopNoise(filterType: BiquadFilterType, freq: number, q: number, gain: number): GainNode {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const filt = ctx.createBiquadFilter();
    filt.type = filterType;
    filt.frequency.value = freq;
    filt.Q.value = q;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(filt).connect(g).connect(this.ambientBus);
    src.start();
    return g;
  }

  private startAmbience(): void {
    const ctx = this.ctx!;
    // Desert wind: filtered noise with a slow, wandering cutoff.
    this.windGain = this.loopNoise('bandpass', 620, 0.7, 0.10);
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    lfo.frequency.value = 0.06;
    lfoGain.gain.value = 0.05;
    lfo.connect(lfoGain).connect(this.windGain.gain);
    lfo.start();

    // The river: a lower, steadier band.
    this.riverGain = this.loopNoise('lowpass', 340, 0.6, 0.0);
  }

  private startMusic(): void {
    const ctx = this.ctx!;
    // A sustained drone under everything, the way a ney or a bowed string would sit.
    this.droneGain = ctx.createGain();
    this.droneGain.gain.value = 0.0;
    this.droneGain.connect(this.musicBus);

    for (const mul of [1, 1.5, 2]) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = this.root * mul;
      const g = ctx.createGain();
      g.gain.value = mul === 1 ? 0.05 : 0.018;
      const filt = ctx.createBiquadFilter();
      filt.type = 'lowpass';
      filt.frequency.value = 420;
      // A slight detune per voice keeps the drone from sounding like a test tone.
      osc.detune.value = (mul - 1) * 6;
      osc.connect(filt).connect(g).connect(this.droneGain);
      osc.start();
    }
    this.droneGain.gain.linearRampToValueAtTime(0.5, ctx.currentTime + 6);

    this.nextNoteAt = ctx.currentTime + 1;
    this.schedulerTimer = window.setInterval(() => this.scheduleMusic(), 120);
  }

  /**
   * Sparse, meandering melody. Notes are scheduled a little ahead of time so that a
   * busy frame never causes an audible stutter.
   */
  private scheduleMusic(): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const horizon = ctx.currentTime + 0.6;
    let guard = 0;
    while (this.nextNoteAt < horizon && guard++ < 8) {
      if (this.rng.chance(0.62)) {
        const octave = this.rng.pick([2, 2, 3, 3, 4]);
        const degree = SCALE[this.rng.int(SCALE.length)];
        const freq = this.root * Math.pow(2, octave - 1 + degree / 12);
        this.pluck(freq, this.nextNoteAt, this.rng.float(0.5, 1.4), this.rng.float(0.05, 0.12));
      }
      if (this.rng.chance(0.22)) {
        this.frameDrum(this.nextNoteAt + this.rng.float(0, 0.1));
      }
      this.nextNoteAt += this.rng.pick([0.5, 0.5, 0.75, 1.0, 1.5]);
    }
  }

  /** A plucked-string voice: fast attack, filtered decay. */
  private pluck(freq: number, at: number, dur: number, vol: number): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = freq;

    const osc2 = ctx.createOscillator();
    osc2.type = 'sine';
    osc2.frequency.value = freq * 2.01;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(vol, at + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);

    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.setValueAtTime(freq * 6, at);
    filt.frequency.exponentialRampToValueAtTime(Math.max(200, freq * 1.4), at + dur);

    const g2 = ctx.createGain();
    g2.gain.value = 0.25;

    osc.connect(filt);
    osc2.connect(g2).connect(filt);
    filt.connect(g).connect(this.musicBus);
    osc.start(at);
    osc2.start(at);
    osc.stop(at + dur + 0.05);
    osc2.stop(at + dur + 0.05);
  }

  private frameDrum(at: number): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(180, at);
    osc.frequency.exponentialRampToValueAtTime(52, at + 0.16);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.16, at);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.22);
    osc.connect(g).connect(this.musicBus);
    osc.start(at);
    osc.stop(at + 0.26);

    // A little skin noise on top of the tone.
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 900;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.05, at);
    ng.gain.exponentialRampToValueAtTime(0.0001, at + 0.08);
    src.connect(f).connect(ng).connect(this.musicBus);
    src.start(at, this.rng.float(0, 2));
    src.stop(at + 0.1);
  }

  // -------------------------------------------------------------------------
  // Reactive mix
  // -------------------------------------------------------------------------

  /** Called each frame with simulation state so the mix follows the city. */
  update(opts: { floodLevel: number; population: number; season: string; danger: number }): void {
    const ctx = this.ctx;
    if (!ctx || !this.started) return;
    const t = ctx.currentTime;

    // The river swells audibly during the inundation.
    this.riverGain.gain.setTargetAtTime(0.04 + opts.floodLevel * 0.16, t, 1.5);
    // Wind is strongest in the dry season.
    const windTarget = opts.season === 'shemu' ? 0.14 : opts.season === 'akhet' ? 0.06 : 0.10;
    this.windGain.gain.setTargetAtTime(windTarget, t, 2.0);
    // Music thins out when the city is under threat.
    this.musicBus.gain.setTargetAtTime(this.musicVolume * (1 - clamp(opts.danger, 0, 0.7)), t, 1.0);
  }

  // -------------------------------------------------------------------------
  // Effects
  // -------------------------------------------------------------------------

  private blip(freq: number, dur: number, vol: number, type: OscillatorType = 'triangle'): void {
    const ctx = this.ctx;
    if (!ctx || !this.started) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(this.sfxBus);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  tap(): void {
    this.blip(880, 0.06, 0.10, 'sine');
  }

  build(): void {
    const ctx = this.ctx;
    if (!ctx || !this.started) return;
    // A short thud plus a scatter of grit — reads as "something was set down".
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(150, t);
    osc.frequency.exponentialRampToValueAtTime(70, t + 0.12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.2, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    osc.connect(g).connect(this.sfxBus);
    osc.start(t);
    osc.stop(t + 0.2);

    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 1800;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.10, t);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    src.connect(f).connect(ng).connect(this.sfxBus);
    src.start(t, this.rng.float(0, 2));
    src.stop(t + 0.18);
  }

  demolish(): void {
    const ctx = this.ctx;
    if (!ctx || !this.started) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(2400, t);
    f.frequency.exponentialRampToValueAtTime(300, t + 0.4);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.24, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
    src.connect(f).connect(g).connect(this.sfxBus);
    src.start(t, this.rng.float(0, 2));
    src.stop(t + 0.5);
  }

  error(): void {
    this.blip(160, 0.14, 0.16, 'square');
  }

  chime(good = true): void {
    const ctx = this.ctx;
    if (!ctx || !this.started) return;
    const base = this.root * 4;
    const notes = good ? [0, 4, 7] : [0, 1, 0];
    notes.forEach((n, i) => {
      this.pluck(base * Math.pow(2, n / 12), ctx.currentTime + i * 0.11, 0.9, 0.10);
    });
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(on ? 0.9 : 0, this.ctx.currentTime, 0.08);
    }
  }

  setMusicVolume(v: number): void {
    this.musicVolume = v;
    if (this.musicBus && this.ctx) this.musicBus.gain.setTargetAtTime(v, this.ctx.currentTime, 0.1);
  }

  suspend(): void {
    this.ctx?.suspend();
  }
  resume(): void {
    this.ctx?.resume();
  }
}
