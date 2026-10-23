/**
 * Sound, all of it synthesised.
 *
 * There are no audio files: the score, the ambience and every effect are generated
 * with WebAudio, so the install stays tiny and nothing here is anyone else's recording.
 *
 *  - The score is generative but structured. It plays in the maqamat Egyptian music
 *    still uses — Hijaz, Kurd, Nahawand, Rast — with harp and oud, a breathy ney, frame
 *    drum and darbuka in the maqsum rhythm, and sistrum. Instruments join as the city
 *    grows, and the mode, tempo and density follow its state: calm, prosperous, the
 *    flood, or danger. Melodies are built from short motifs that repeat and vary, the
 *    way a player would, rather than from random notes.
 *  - Plucked strings are Karplus–Strong physical models, rendered once per pitch when
 *    sound is first unlocked and then played back as buffers. They sound like strings,
 *    and playback costs the phone almost nothing.
 *  - Ambience comes from what is on screen: the river, wind over the desert, birds over
 *    the green land, and a murmur that grows with the town.
 *  - As in Pharaoh, you hear the building nearest the centre of the screen: chatter
 *    and coins at the bazaar, chant at a temple, hammers at a forge, water at a well.
 *  - Effects mark what happened: houses improving, taxes coming in, fire, invasion, a
 *    god's favour or anger, a monument stage complete.
 *
 * iOS needs a user gesture before an AudioContext will run, so `unlock()` must be called
 * from a real touch. The audio session is set to 'ambient', so the game respects the
 * silent switch and plays alongside the player's own music rather than stopping it.
 */

import { RNG, clamp } from './core';

// ---------------------------------------------------------------------------
// Musical material
// ---------------------------------------------------------------------------

/** Scales in semitones from the tonic. Quarter tones are rounded to the nearest semitone. */
const MODES = {
  hijaz:    [0, 1, 4, 5, 7, 8, 10],   // the sound most ears hear as "Egypt"
  kurd:     [0, 1, 3, 5, 7, 8, 10],   // dark, still
  nahawand: [0, 2, 3, 5, 7, 8, 11],   // wistful
  rast:     [0, 2, 4, 5, 7, 9, 10],   // bright, festive
  saba:     [0, 2, 3, 4, 7, 8, 10],   // tense, unresolved
} as const;
type ModeName = keyof typeof MODES;

type Mood = 'calm' | 'prosper' | 'flood' | 'tension';

const MOOD_SETTINGS: Record<Mood, { modes: ModeName[]; bpm: number; density: number }> = {
  calm:    { modes: ['kurd', 'nahawand', 'hijaz'], bpm: 66, density: 0.55 },
  prosper: { modes: ['rast', 'hijaz', 'nahawand'], bpm: 82, density: 0.75 },
  flood:   { modes: ['hijaz', 'nahawand'], bpm: 72, density: 0.6 },
  tension: { modes: ['saba', 'hijaz'], bpm: 96, density: 0.8 },
};

/** Rhythmic cells for melodies, in beats. */
const CELLS: number[][] = [
  [1, 1, 2], [0.5, 0.5, 1, 2], [1.5, 0.5, 2], [2, 2], [1, 0.5, 0.5, 2], [0.5, 0.5, 0.5, 0.5, 2], [3, 1],
];

/**
 * Maqsum, the backbone of Egyptian percussion: dum-tak - - tak - dum - tak - -.
 * Eighth-note steps across one 4/4 bar; 'D' is the low dum, 'T' the bright tak.
 */
const MAQSUM = ['D', 'T', '', 'T', '', 'D', 'T', ''];
const SPARSE = ['D', '', '', '', '', '', 'T', ''];

const midiToHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

// ---------------------------------------------------------------------------
// What the camera is looking at, supplied by the game
// ---------------------------------------------------------------------------

export interface AudioListener {
  /** Fractions of the visible land, 0..1. */
  water: number;
  green: number;
  desert: number;
  /** How busy the visible streets are, 0..1. */
  crowd: number;
  zoom: number;
  /** The building nearest the centre of the screen, and how close it is (0..1). */
  focus: string | null;
  focusGain: number;
  /** Something is burning on screen. */
  fire: number;
}

export interface CityMood {
  population: number;
  season: string;
  danger: number;
  sentiment: number;
  floodLevel: number;
}

type FocusKind =
  | 'market' | 'storage' | 'water' | 'temple' | 'forge' | 'workshop' | 'brewery' | 'farm'
  | 'ranch' | 'camp' | 'entertain' | 'military' | 'monument' | 'civic';

/** Which family of sound a building makes. */
function focusKind(id: string): FocusKind | null {
  if (id === 'bazaar' || id === 'trading_post') return 'market';
  if (id === 'granary' || id === 'storage_yard') return 'storage';
  if (id === 'well' || id === 'water_supply' || id === 'fishing_wharf' || id === 'dock' || id === 'ferry') return 'water';
  if (id.startsWith('temple_') || id.startsWith('complex_') || id.startsWith('shrine_') || id === 'festival_square' || id === 'oracle') return 'temple';
  if (id === 'weaponsmith' || id === 'chariot_maker' || id === 'jeweler' || id.endsWith('_mine') || id.startsWith('quarry_') || id === 'stonemason_guild') return 'forge';
  if (id === 'brewery') return 'brewery';
  if (id === 'cattle_ranch') return 'ranch';
  if (id.startsWith('farm_') || id === 'hunting_lodge') return 'farm';
  if (id === 'work_camp') return 'camp';
  if (id.startsWith('mon_')) return 'monument';
  if (['potter', 'weaver', 'brickworks', 'papyrus_maker', 'cabinet_maker', 'clay_pit', 'reed_gatherer', 'timber_yard',
    'carpenter_guild', 'bricklayer_guild', 'artisan_guild'].includes(id)) return 'workshop';
  if (['booth', 'bandstand', 'pavilion', 'juggler_school', 'conservatory', 'dance_school', 'senet_house'].includes(id)) return 'entertain';
  if (id.startsWith('fort_') || id === 'recruiter' || id === 'academy' || id === 'tower' || id === 'gatehouse') return 'military';
  if (['tax_collector', 'courthouse', 'scribal_school', 'library', 'mansion', 'physician', 'apothecary', 'dentist', 'mortuary'].includes(id)) return 'civic';
  return null;
}

// ---------------------------------------------------------------------------

export class AudioEngine {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private musicBus!: GainNode;
  private ambientBus!: GainNode;
  private sfxBus!: GainNode;
  private focusBus!: GainNode;
  private reverbSend!: GainNode;
  private noise!: AudioBuffer;

  private rng = new RNG(0xc0ffee);
  private started = false;
  private scheduler: number | null = null;

  // Rendered instruments, keyed by MIDI note.
  private harp = new Map<number, { buf: AudioBuffer; hz: number }>();
  private oud = new Map<number, { buf: AudioBuffer; hz: number }>();
  private drum: { dum?: AudioBuffer; tak?: AudioBuffer; sistrum?: AudioBuffer; zill?: AudioBuffer } = {};
  private renderQueue: (() => void)[] = [];

  // Mix levels from settings.
  enabled = true;
  musicVolume = 0.55;
  sfxVolume = 0.8;
  ambientVolume = 0.6;

  // Live state.
  private listener: AudioListener = { water: 0, green: 0, desert: 0, crowd: 0, zoom: 1, focus: null, focusGain: 0, fire: 0 };
  private mood: CityMood = { population: 0, season: 'peret', danger: 0, sentiment: 60, floodLevel: 0 };

  // Ambience nodes.
  private riverGain!: GainNode;
  private windGain!: GainNode;
  private crowdGain!: GainNode;
  private crowdFilter!: BiquadFilterNode;
  private fireGain!: GainNode;
  private droneGain!: GainNode;
  private droneOscs: OscillatorNode[] = [];

  // Score position.
  private beatTime = 0;
  private beat = 0;
  private sectionMood: Mood = 'calm';
  private mode: ModeName = 'kurd';
  private tonic = 50; // D3
  private bpm = 66;
  private phrase: { deg: number; dur: number }[] = [];
  private phraseVoice: 'harp' | 'oud' | 'ney' = 'harp';
  private phraseAt = 0;
  private motif: { step: number; dur: number }[] = [];

  // Ambient event timers, in context seconds.
  private nextBird = 0;
  private nextLap = 0;
  private nextVoice = 0;
  private nextFocus = 0;
  private nextCrackle = 0;

  // -------------------------------------------------------------------------
  // Start-up
  // -------------------------------------------------------------------------

  /** Must be called from inside a user gesture. */
  async unlock(): Promise<void> {
    if (this.started) {
      if (this.ctx && this.ctx.state !== 'running') await this.ctx.resume();
      return;
    }
    const AC: typeof AudioContext = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!AC) return;
    // Respect the silent switch, and mix with the player's own music instead of
    // stopping it. Supported from iOS 17; elsewhere it is simply absent.
    try { (navigator as any).audioSession && ((navigator as any).audioSession.type = 'ambient'); } catch { /* ignore */ }

    const ctx = new AC({ latencyHint: 'interactive' });
    this.ctx = ctx;
    this.started = true;
    await ctx.resume();
    // iOS can 'interrupt' a context for a call or an alarm; pick it back up afterwards.
    ctx.onstatechange = () => {
      if ((ctx.state as string) === 'interrupted' || ctx.state === 'suspended') {
        if (!document.hidden) ctx.resume().catch(() => {});
      }
    };

    this.master = ctx.createGain();
    this.master.gain.value = this.enabled ? 0.9 : 0;
    this.master.connect(ctx.destination);

    // A gentle limiter keeps stacked voices from clipping on a phone speaker.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 16;
    comp.ratio.value = 6;
    comp.attack.value = 0.004;
    comp.release.value = 0.25;
    comp.connect(this.master);

    // Make-up gain per bus, ahead of the compressor. The voices are written at
    // comfortable headphone levels; a phone speaker held at arm's length needs
    // roughly four times that, and the compressor keeps the peaks in check.
    const trim = (g: number) => { const n = ctx.createGain(); n.gain.value = g; n.connect(comp); return n; };
    const musicTrim = trim(3.6);
    const ambientTrim = trim(3.2);
    const sfxTrim = trim(2.0);

    // A short synthetic room, shared by the music: plucks without it sound like a
    // phone ringtone; with it, like a courtyard.
    const reverb = ctx.createConvolver();
    reverb.buffer = this.makeImpulse(ctx, 2.4, 2.8);
    const wet = ctx.createGain();
    wet.gain.value = 0.32;
    reverb.connect(wet).connect(musicTrim);
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 1;
    this.reverbSend.connect(reverb);

    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = this.musicVolume;
    this.musicBus.connect(musicTrim);
    this.musicBus.connect(this.reverbSend);

    this.ambientBus = ctx.createGain();
    this.ambientBus.gain.value = this.ambientVolume;
    this.ambientBus.connect(ambientTrim);

    this.focusBus = ctx.createGain();
    this.focusBus.gain.value = 0;
    this.focusBus.connect(this.ambientBus);

    this.sfxBus = ctx.createGain();
    this.sfxBus.gain.value = this.sfxVolume;
    this.sfxBus.connect(sfxTrim);

    this.noise = this.makeNoise(ctx, 4);
    this.renderPercussion(ctx);
    this.startAmbience();
    this.startDrone();
    this.queueStringRenders();

    this.beatTime = ctx.currentTime + 1.2;
    this.scheduler = window.setInterval(() => this.tick(), 90);
  }

  /** Apply the player's mix. Values are 0..1. */
  setMix(music: number, effects: number, ambience: number, muted: boolean): void {
    this.musicVolume = music;
    this.sfxVolume = effects;
    this.ambientVolume = ambience;
    this.enabled = !muted;
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const t = ctx.currentTime;
    this.master.gain.setTargetAtTime(muted ? 0 : 0.9, t, 0.08);
    this.musicBus.gain.setTargetAtTime(music, t, 0.1);
    this.sfxBus.gain.setTargetAtTime(effects, t, 0.1);
    this.ambientBus.gain.setTargetAtTime(ambience, t, 0.1);
  }

  /** Kept for older callers. */
  setEnabled(on: boolean): void {
    this.setMix(this.musicVolume, this.sfxVolume, this.ambientVolume, !on);
  }
  setMusicVolume(v: number): void {
    this.setMix(v, this.sfxVolume, this.ambientVolume, !this.enabled);
  }

  suspend(): void { this.ctx?.suspend(); }
  resume(): void { this.ctx?.resume(); }

  // -------------------------------------------------------------------------
  // Synthesis building blocks
  // -------------------------------------------------------------------------

  private makeNoise(ctx: BaseAudioContext, seconds: number): AudioBuffer {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = this.rng.float(-1, 1);
    return buf;
  }

  /** Exponentially decaying stereo noise: a cheap, convincing small-room reverb. */
  private makeImpulse(ctx: BaseAudioContext, seconds: number, decay: number): AudioBuffer {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        d[i] = (this.rng.float(-1, 1)) * Math.pow(1 - t, decay) * (i < 40 ? i / 40 : 1);
      }
    }
    return buf;
  }

  /**
   * Karplus–Strong plucked string. A burst of filtered noise circulates in a delay line
   * one period long, losing a little energy and brightness each pass — which is what a
   * real string does. 'bright' sets how much high end the pluck starts with; 'decay'
   * how long it rings; 'body' adds a low resonance for the oud's bowl.
   */
  private renderString(ctx: BaseAudioContext, hz: number, seconds: number, bright: number, decay: number, body: number): { buf: AudioBuffer; hz: number } {
    const sr = ctx.sampleRate;
    const N = Math.max(2, Math.round(sr / hz - 0.5));
    const len = Math.floor(sr * seconds);
    const buf = ctx.createBuffer(1, len, sr);
    const out = buf.getChannelData(0);
    const line = new Float32Array(N);
    // Excitation: noise smoothed by a one-pole low-pass, softer for darker strings.
    let lp = 0;
    for (let i = 0; i < N; i++) {
      lp += (this.rng.float(-1, 1) - lp) * bright;
      line[i] = lp;
    }
    let idx = 0;
    let prev = 0;
    // Body resonance: a gentle two-pole band-pass around 180 Hz.
    const f = 2 * Math.sin(Math.PI * 180 / sr);
    let bpLow = 0, bpBand = 0;
    let peak = 0;
    for (let i = 0; i < len; i++) {
      const cur = line[idx];
      const next = decay * 0.5 * (cur + prev);
      prev = cur;
      line[idx] = next;
      idx = (idx + 1) % N;
      let y = cur;
      if (body > 0) {
        bpLow += f * bpBand;
        const high = y - bpLow - 0.6 * bpBand;
        bpBand += f * high;
        y = y + bpBand * body;
      }
      // Fade the very end so the buffer never clicks off.
      if (i > len - 600) y *= (len - i) / 600;
      out[i] = y;
      peak = Math.max(peak, Math.abs(y));
    }
    const k = peak > 0 ? 0.9 / peak : 1;
    for (let i = 0; i < len; i++) out[i] *= k;
    // The loop's true pitch is sr / (N + 0.5); playback rate corrects the remainder.
    return { buf, hz: sr / (N + 0.5) };
  }

  /**
   * Render the harp and oud a few notes at a time between frames, so unlocking sound
   * never stalls the game. Until a note exists, the score simply skips it.
   */
  private queueStringRenders(): void {
    const ctx = this.ctx!;
    for (let m = 45; m <= 81; m++) {
      this.renderQueue.push(() => this.harp.set(m, this.renderString(ctx, midiToHz(m), 2.6, 0.55, 0.9965, 0)));
    }
    for (let m = 38; m <= 69; m++) {
      this.renderQueue.push(() => this.oud.set(m, this.renderString(ctx, midiToHz(m), 1.6, 0.35, 0.992, 0.35)));
    }
    const step = () => {
      for (let i = 0; i < 4 && this.renderQueue.length; i++) this.renderQueue.shift()!();
      if (this.renderQueue.length) setTimeout(step, 16);
    };
    setTimeout(step, 50);
  }

  /** Frame drum, darbuka tak, sistrum and finger cymbal, each rendered once. */
  private renderPercussion(ctx: BaseAudioContext): void {
    const sr = ctx.sampleRate;
    const make = (seconds: number, fn: (t: number, i: number) => number): AudioBuffer => {
      const len = Math.floor(sr * seconds);
      const buf = ctx.createBuffer(1, len, sr);
      const d = buf.getChannelData(0);
      let peak = 0;
      for (let i = 0; i < len; i++) { d[i] = fn(i / sr, i); peak = Math.max(peak, Math.abs(d[i])); }
      const k = peak > 0 ? 0.9 / peak : 1;
      for (let i = 0; i < len; i++) d[i] *= k;
      return buf;
    };
    // Dum: a low skin, pitch falling as the head relaxes, with a soft thump of noise.
    let phase = 0;
    this.drum.dum = make(0.5, (t) => {
      const hz = 58 + 70 * Math.exp(-t * 28);
      phase += (2 * Math.PI * hz) / sr;
      return Math.sin(phase) * Math.exp(-t * 7) + this.rng.float(-1, 1) * 0.25 * Math.exp(-t * 60);
    });
    // Tak: the rim — a bright click and a short ring.
    let ph2 = 0;
    let lp = 0;
    this.drum.tak = make(0.18, (t) => {
      ph2 += (2 * Math.PI * 420) / sr;
      const n = this.rng.float(-1, 1);
      lp += (n - lp) * 0.6;
      return (n - lp) * Math.exp(-t * 55) * 0.9 + Math.sin(ph2) * 0.35 * Math.exp(-t * 30);
    });
    // Sistrum: a shake of small metal discs — many short inharmonic jingles.
    const jingles = Array.from({ length: 14 }, () => ({ at: this.rng.float(0, 0.22), hz: this.rng.float(3800, 7200), amp: this.rng.float(0.4, 1) }));
    this.drum.sistrum = make(0.45, (t) => {
      let s = 0;
      for (const j of jingles) {
        if (t < j.at) continue;
        const u = t - j.at;
        s += Math.sin(2 * Math.PI * j.hz * u) * Math.exp(-u * 38) * j.amp;
      }
      return s;
    });
    // Zill: a finger cymbal, inharmonic partials with a long shimmer.
    const partials = [2430, 3710, 5160, 6890];
    this.drum.zill = make(1.6, (t) => partials.reduce((a, hz, k) => a + Math.sin(2 * Math.PI * hz * t) * Math.exp(-t * (2.2 + k * 0.9)) / (k + 1), 0));
  }

  /** Play a rendered buffer through a bus, with gain, rate and optional stereo pan. */
  private playBuf(buf: AudioBuffer | undefined, at: number, gain: number, bus: AudioNode, rate = 1, pan = 0): void {
    const ctx = this.ctx;
    if (!ctx || !buf) return;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = gain;
    let node: AudioNode = src.connect(g);
    if (pan && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = clamp(pan, -1, 1);
      node = node.connect(p);
    }
    node.connect(bus);
    src.start(at);
  }

  /** A filtered burst of noise: the raw material of splashes, thumps, rustles and fire. */
  private noiseHit(at: number, dur: number, type: BiquadFilterType, freq: number, q: number, gain: number, bus: AudioNode, sweepTo = 0): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, at);
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, at + dur);
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(gain, at + Math.min(0.01, dur * 0.2));
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    src.connect(f).connect(g).connect(bus);
    src.start(at, this.rng.float(0, 3));
    src.stop(at + dur + 0.05);
  }

  /** A simple enveloped tone. */
  private tone(at: number, hz: number, dur: number, gain: number, bus: AudioNode, type: OscillatorType = 'sine', glideTo = 0): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(hz, at);
    if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, at + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(gain, at + Math.min(0.015, dur * 0.3));
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g).connect(bus);
    o.start(at);
    o.stop(at + dur + 0.05);
  }

  /** A plucked note from the rendered strings. */
  private pluck(inst: 'harp' | 'oud', midi: number, at: number, gain: number, pan = 0, bus: AudioNode = this.musicBus): void {
    const bank = inst === 'harp' ? this.harp : this.oud;
    // Use the nearest rendered note and bend it the rest of the way.
    let m = Math.round(midi);
    let s = bank.get(m);
    if (!s) {
      while (m > 30 && !bank.get(m)) m -= 12;
      s = bank.get(m);
      if (!s) return;
    }
    const rate = midiToHz(midi) / s.hz;
    this.playBuf(s.buf, at, gain, bus, rate, pan);
  }

  /**
   * The ney: a reed flute, mostly breath. A soft sine and triangle carry the pitch, a
   * band of noise at the same pitch carries the air, and vibrato grows into the note.
   */
  private ney(midi: number, at: number, dur: number, gain: number, glideFrom = 0, bus: AudioNode = this.musicBus): void {
    const ctx = this.ctx!;
    const hz = midiToHz(midi);
    const out = ctx.createGain();
    out.gain.setValueAtTime(0, at);
    out.gain.linearRampToValueAtTime(gain, at + 0.09);
    out.gain.setValueAtTime(gain, at + Math.max(0.1, dur - 0.18));
    out.gain.linearRampToValueAtTime(0, at + dur);
    out.connect(bus);

    const vib = ctx.createOscillator();
    vib.frequency.value = 5.2;
    const vibDepth = ctx.createGain();
    vibDepth.gain.setValueAtTime(0, at);
    vibDepth.gain.linearRampToValueAtTime(hz * 0.012, at + Math.min(0.5, dur * 0.6));
    vib.connect(vibDepth);

    for (const [type, mul, lvl] of [['sine', 1, 0.7], ['triangle', 2, 0.12]] as [OscillatorType, number, number][]) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(glideFrom ? midiToHz(glideFrom) * mul : hz * mul, at);
      if (glideFrom) o.frequency.exponentialRampToValueAtTime(hz * mul, at + 0.08);
      vibDepth.connect(o.frequency);
      const g = ctx.createGain();
      g.gain.value = lvl;
      o.connect(g).connect(out);
      o.start(at);
      o.stop(at + dur + 0.05);
    }
    // Breath.
    const n = ctx.createBufferSource();
    n.buffer = this.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = hz * 2;
    bp.Q.value = 2.5;
    const ng = ctx.createGain();
    ng.gain.value = 0.55;
    n.connect(bp).connect(ng).connect(out);
    n.start(at, this.rng.float(0, 3));
    n.stop(at + dur + 0.05);
    vib.start(at);
    vib.stop(at + dur + 0.05);
  }

  // -------------------------------------------------------------------------
  // Ambience and drone
  // -------------------------------------------------------------------------

  private loopNoise(type: BiquadFilterType, freq: number, q: number, bus: AudioNode): [GainNode, BiquadFilterNode] {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const filt = ctx.createBiquadFilter();
    filt.type = type;
    filt.frequency.value = freq;
    filt.Q.value = q;
    const g = ctx.createGain();
    g.gain.value = 0;
    src.connect(filt).connect(g).connect(bus);
    src.start(0, this.rng.float(0, 3));
    return [g, filt];
  }

  private startAmbience(): void {
    const ctx = this.ctx!;
    [this.riverGain] = this.loopNoise('lowpass', 520, 0.5, this.ambientBus);
    let windFilter: BiquadFilterNode;
    [this.windGain, windFilter] = this.loopNoise('bandpass', 700, 0.8, this.ambientBus);
    // The wind's pitch wanders slowly, like gusts.
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoAmt = ctx.createGain();
    lfoAmt.gain.value = 260;
    lfo.connect(lfoAmt).connect(windFilter.frequency);
    lfo.start();
    [this.crowdGain, this.crowdFilter] = this.loopNoise('bandpass', 850, 0.9, this.ambientBus);
    [this.fireGain] = this.loopNoise('lowpass', 900, 0.6, this.ambientBus);
  }

  /** A low drone under the score: tonic and fifth, softly filtered, breathing slowly. */
  private startDrone(): void {
    const ctx = this.ctx!;
    this.droneGain = ctx.createGain();
    this.droneGain.gain.value = 0;
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = 340;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.05;
    const lfoAmt = ctx.createGain();
    lfoAmt.gain.value = 120;
    lfo.connect(lfoAmt).connect(filt.frequency);
    lfo.start();
    this.droneGain.connect(filt).connect(this.musicBus);
    for (const [mul, lvl, det] of [[0.5, 0.05, -4], [0.75, 0.025, 3], [1, 0.012, 6]] as [number, number, number][]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = midiToHz(this.tonic) * mul;
      o.detune.value = det;
      const g = ctx.createGain();
      g.gain.value = lvl;
      o.connect(g).connect(this.droneGain);
      o.start();
      this.droneOscs.push(o);
    }
    this.droneGain.gain.linearRampToValueAtTime(0.55, ctx.currentTime + 8);
  }

  // -------------------------------------------------------------------------
  // The game feeds these
  // -------------------------------------------------------------------------

  /** What the camera sees, a few times a second. */
  setListener(l: AudioListener): void {
    this.listener = l;
    const ctx = this.ctx;
    if (!ctx || !this.riverGain) return;
    const t = ctx.currentTime;
    const near = clamp((l.zoom - 0.35) / 0.9, 0.2, 1);
    this.riverGain.gain.setTargetAtTime(l.water * (0.10 + this.mood.floodLevel * 0.10) * (0.6 + near * 0.4), t, 0.8);
    const dry = this.mood.season === 'shemu' ? 1.3 : this.mood.season === 'akhet' ? 0.6 : 1;
    this.windGain.gain.setTargetAtTime((0.025 + l.desert * 0.09) * dry, t, 1.2);
    this.crowdGain.gain.setTargetAtTime(l.crowd * 0.07 * near, t, 0.6);
    this.fireGain.gain.setTargetAtTime(l.fire * 0.16, t, 0.3);
    this.focusBus.gain.setTargetAtTime(l.focus ? l.focusGain * near : 0, t, 0.35);
  }

  /** The city's state, which steers the score. */
  update(m: CityMood): void {
    this.mood = m;
  }

  // -------------------------------------------------------------------------
  // The scheduler: music, ambient events, building sounds
  // -------------------------------------------------------------------------

  private tick(): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    const horizon = now + 0.35;
    // If the app was suspended the beat clock may be far behind; jump forward.
    if (this.beatTime < now - 1) this.beatTime = now + 0.1;
    let guard = 0;
    while (this.beatTime < horizon && guard++ < 16) {
      this.playBeat(this.beatTime);
      this.beatTime += 60 / this.bpm / 2; // eighth notes
      this.beat++;
    }
    this.ambientEvents(now, horizon);
  }

  private chooseMood(): Mood {
    const m = this.mood;
    if (m.danger > 0.15 || m.sentiment < 25) return 'tension';
    if (m.season === 'akhet' && m.floodLevel > 0.2) return 'flood';
    if (m.sentiment > 68 && m.population > 300) return 'prosper';
    return 'calm';
  }

  /** One eighth-note step of the score. 64 eighths make a section. */
  private playBeat(at: number): void {
    const step = this.beat % 64;
    if (step === 0) this.newSection(at);
    const pop = this.mood.population;
    const set = MOOD_SETTINGS[this.sectionMood];
    const scale = MODES[this.mode];
    const degToMidi = (deg: number, octave = 0): number => {
      const n = scale.length;
      const o = Math.floor(deg / n);
      const i = ((deg % n) + n) % n;
      return this.tonic + 12 * (o + octave) + scale[i];
    };

    // Accompaniment: a broken chord from the harp on the first beat of each bar.
    if (step % 8 === 0) {
      const root = step % 32 === 0 ? 0 : step % 32 === 16 ? 3 : this.rng.pick([0, 4, 3]);
      const chord = [root, root + 2, root + 4, root + 7];
      chord.forEach((d, k) => this.pluck('harp', degToMidi(d, 1), at + k * 0.09, 0.08 - k * 0.012, k % 2 ? 0.25 : -0.25));
    }

    // Melody: motif-based phrases with breathing room between them.
    if (at >= this.phraseAt) {
      if (!this.phrase.length && this.rng.chance(set.density)) this.buildPhrase();
      const note = this.phrase.shift();
      if (note) {
        const beatSec = 60 / this.bpm;
        const dur = note.dur * beatSec;
        if (note.deg !== -99) {
          const midi = degToMidi(note.deg, 1);
          if (this.phraseVoice === 'ney') this.ney(midi + 12, at, Math.max(0.25, dur * 0.95), 0.06);
          else this.pluck(this.phraseVoice, this.phraseVoice === 'oud' ? midi : midi + 12, at, this.phraseVoice === 'oud' ? 0.16 : 0.12, 0.1);
          // A grace note now and then, the ornament that makes a line sound sung.
          if (this.phraseVoice !== 'ney' && dur > beatSec * 0.9 && this.rng.chance(0.18)) {
            this.pluck(this.phraseVoice, degToMidi(note.deg + 1, 1) + (this.phraseVoice === 'oud' ? 0 : 12), at - 0.07, 0.05);
          }
        }
        this.phraseAt = at + dur;
      } else {
        // A rest of one to three beats before the next phrase.
        this.phraseAt = at + (60 / this.bpm) * this.rng.pick([1, 2, 2, 3]);
      }
    }

    // Percussion joins once there is a town to play for.
    if (pop > 60) {
      const pattern = (pop > 500 || this.sectionMood !== 'calm') ? MAQSUM : SPARSE;
      const hit = pattern[step % 8];
      const lvl = clamp(0.05 + pop / 6000, 0.05, 0.12) * (this.sectionMood === 'tension' ? 1.4 : 1);
      if (hit === 'D') this.playBuf(this.drum.dum, at, lvl * 1.3, this.musicBus);
      if (hit === 'T') this.playBuf(this.drum.tak, at, lvl * 0.7, this.musicBus, 1, 0.2);
    }
    // Sistrum on the downbeat of every other bar in a prosperous or festive city.
    if ((this.sectionMood === 'prosper' || this.sectionMood === 'flood') && step % 16 === 0 && pop > 200) {
      this.playBuf(this.drum.sistrum, at, 0.05, this.musicBus, this.rng.float(0.95, 1.05), -0.3);
    }
    // A finger cymbal to close the section.
    if (step === 60 && pop > 120) this.playBuf(this.drum.zill, at, 0.035, this.musicBus, 1, 0.3);
  }

  private newSection(at: number): void {
    const prevMood = this.sectionMood;
    this.sectionMood = this.chooseMood();
    const set = MOOD_SETTINGS[this.sectionMood];
    if (prevMood !== this.sectionMood || this.rng.chance(0.4)) this.mode = this.rng.pick(set.modes);
    // Move the tonic occasionally, between D, E, G and A.
    if (this.rng.chance(0.3)) this.tonic = this.rng.pick([50, 52, 55, 57]);
    this.bpm = set.bpm;
    // Which voice leads this section: the ney arrives with a bigger city.
    const pop = this.mood.population;
    const voices: ('harp' | 'oud' | 'ney')[] = ['harp'];
    if (pop > 150) voices.push('oud');
    if (pop > 400 || this.sectionMood === 'prosper') voices.push('ney');
    this.phraseVoice = this.rng.pick(voices);
    this.motif = [];
    this.phrase = [];
    // Retune the drone smoothly.
    const ctx = this.ctx!;
    const muls = [0.5, 0.75, 1];
    this.droneOscs.forEach((o, i) => o.frequency.setTargetAtTime(midiToHz(this.tonic) * muls[i], at, 1.5));
    this.droneGain.gain.setTargetAtTime(this.sectionMood === 'tension' ? 0.75 : 0.5, ctx.currentTime, 2);
  }

  /**
   * A phrase is a motif stated and then varied: transposed by a step, or with its end
   * turned toward the tonic. That repetition is what makes a line feel composed.
   */
  private buildPhrase(): void {
    if (!this.motif.length || this.rng.chance(0.25)) {
      const cell = this.rng.pick(CELLS);
      let deg = 0;
      this.motif = cell.map((dur, k) => {
        const step = k === 0 ? this.rng.pick([0, 2, 4, 4, 5]) : this.rng.pick([-1, 1, 1, -1, 2, -2, 0, 3]);
        deg = k === 0 ? step : deg + step;
        return { step: deg, dur };
      });
    }
    const shift = this.rng.pick([0, 0, 1, -1, 2]);
    const out: { deg: number; dur: number }[] = [];
    for (const n of this.motif) out.push({ deg: n.step, dur: n.dur });
    for (const n of this.motif) out.push({ deg: n.step + shift, dur: n.dur });
    // Resolve: the last note falls to the tonic or fifth.
    out[out.length - 1] = { deg: this.rng.pick([0, 0, 4, 7]), dur: Math.max(2, out[out.length - 1].dur) };
    this.phrase = out;
  }

  // -------------------------------------------------------------------------
  // Ambient events and the focus building
  // -------------------------------------------------------------------------

  private ambientEvents(now: number, horizon: number): void {
    const l = this.listener;
    const amb = this.ambientBus;
    // Birds over the green land: short trills, and now and then a dove.
    if (l.green > 0.15 && now >= this.nextBird) {
      const at = now + this.rng.float(0.05, 0.3);
      if (this.rng.chance(0.75)) {
        const base = this.rng.float(2600, 4200);
        const n = this.rng.range(2, 6);
        for (let k = 0; k < n; k++) this.tone(at + k * 0.07, base * this.rng.float(0.92, 1.12), 0.06, 0.012 * l.green, amb, 'sine', base * 1.25);
      } else {
        for (let k = 0; k < 3; k++) this.tone(at + k * 0.42, 420, 0.32, 0.02 * l.green, amb, 'sine', 370);
      }
      this.nextBird = now + this.rng.float(1.2, 4.5) / Math.max(0.3, l.green);
    }
    // Water lapping at the bank.
    if (l.water > 0.1 && now >= this.nextLap) {
      this.noiseHit(now + 0.05, this.rng.float(0.25, 0.5), 'bandpass', this.rng.float(500, 1100), 1.2, 0.05 * l.water, amb, 260);
      this.nextLap = now + this.rng.float(0.6, 1.8);
    }
    // Voices in a busy town: a vowel here and there inside the murmur.
    if (l.crowd > 0.15 && now >= this.nextVoice) {
      this.voice(now + 0.05, this.rng.float(110, 230), 0.25, 0.018 * l.crowd, amb);
      this.nextVoice = now + this.rng.float(0.3, 1.4) / Math.max(0.3, l.crowd);
    }
    // Fire: crackles over the roar.
    if (l.fire > 0 && now >= this.nextCrackle) {
      this.noiseHit(now + 0.02, 0.04, 'highpass', 2500, 0.7, 0.12 * l.fire, amb);
      this.nextCrackle = now + this.rng.float(0.04, 0.25);
    }
    // The building at the centre of the screen.
    const kind = l.focus ? focusKind(l.focus) : null;
    if (kind && now >= this.nextFocus) {
      this.nextFocus = this.focusSound(kind, now + 0.05);
    }
    void horizon;
  }

  /** A short sung vowel: a buzzy source through two formant filters. */
  private voice(at: number, hz: number, dur: number, gain: number, bus: AudioNode): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(hz, at);
    o.frequency.linearRampToValueAtTime(hz * this.rng.float(0.9, 1.15), at + dur);
    const vowels = [[730, 1090], [570, 840], [300, 870], [440, 1020]];
    const [f1, f2] = this.rng.pick(vowels);
    const out = ctx.createGain();
    out.gain.setValueAtTime(0, at);
    out.gain.linearRampToValueAtTime(gain, at + 0.04);
    out.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    for (const f of [f1, f2]) {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = f;
      bp.Q.value = 7;
      o.connect(bp).connect(out);
    }
    out.connect(bus);
    o.start(at);
    o.stop(at + dur + 0.05);
  }

  /** Metal struck: inharmonic partials that ring briefly. */
  private clank(at: number, hz: number, gain: number, bus: AudioNode): void {
    for (const [mul, k] of [[1, 1], [2.76, 0.6], [5.4, 0.35], [8.9, 0.2]]) {
      this.tone(at, hz * mul, 0.25 / (0.6 + mul * 0.15), gain * k, bus, 'sine');
    }
    this.noiseHit(at, 0.03, 'highpass', 3000, 0.7, gain * 0.8, bus);
  }

  /** Play one beat of the focus building's sound; returns when to play the next. */
  private focusSound(kind: FocusKind, at: number): number {
    const bus = this.focusBus;
    const r = this.rng;
    switch (kind) {
      case 'market':
        this.voice(at, r.float(140, 260), 0.3, 0.05, bus);
        if (r.chance(0.35)) this.clank(at + 0.1, r.float(2200, 3200), 0.025, bus);
        return at + r.float(0.25, 0.7);
      case 'storage':
        if (r.chance(0.5)) this.tone(at, 90, 0.18, 0.12, bus, 'sine', 55);
        else this.noiseHit(at, 0.35, 'bandpass', 600, 6, 0.06, bus, 420);
        return at + r.float(0.8, 2);
      case 'water':
        this.noiseHit(at, r.float(0.15, 0.35), 'bandpass', r.float(900, 1800), 2, 0.09, bus, 400);
        if (r.chance(0.2)) this.clank(at + 0.2, 700, 0.03, bus);
        return at + r.float(0.5, 1.6);
      case 'temple': {
        // Two or three voices sustaining tones of the current mode.
        const scale = MODES[this.mode];
        const hz = midiToHz(this.tonic - 12 + scale[r.pick([0, 0, 2, 4])]);
        for (let v = 0; v < 2; v++) this.voice(at + v * 0.05, hz * (v ? 1.5 : 1), 1.8, 0.035, bus);
        if (r.chance(0.3)) this.playBuf(this.drum.sistrum, at + 0.6, 0.06, bus);
        return at + r.float(1.6, 2.4);
      }
      case 'forge':
        this.clank(at, r.float(420, 620), 0.07, bus);
        return at + r.pick([0.45, 0.45, 0.9]);
      case 'workshop':
        this.noiseHit(at, 0.05, 'bandpass', r.float(700, 1200), 4, 0.12, bus);
        this.tone(at, r.float(180, 260), 0.08, 0.05, bus, 'triangle');
        return at + r.pick([0.35, 0.35, 0.7]);
      case 'brewery':
        for (let k = 0; k < r.range(3, 7); k++) this.tone(at + k * r.float(0.04, 0.12), r.float(300, 700), 0.05, 0.03, bus, 'sine', r.float(800, 1400));
        return at + r.float(0.5, 1.2);
      case 'ranch':
        if (r.chance(0.4)) {
          this.tone(at, 140, 1.1, 0.06, bus, 'sawtooth', 110);
          return at + r.float(2.5, 5);
        }
        this.noiseHit(at, 0.12, 'lowpass', 400, 1, 0.06, bus);
        return at + r.float(0.8, 2);
      case 'farm':
        this.noiseHit(at, 0.18, 'bandpass', 1400, 1.5, 0.05, bus, 900);
        return at + r.float(0.7, 1.6);
      case 'camp':
      case 'monument':
        this.clank(at, r.float(900, 1300), 0.04, bus);
        return at + r.pick([0.3, 0.6, 0.6, 1.2]);
      case 'entertain':
        this.playBuf(this.drum.tak, at, 0.06, bus);
        if (r.chance(0.5)) this.playBuf(this.drum.dum, at + 0.25, 0.07, bus);
        return at + 0.25 * r.pick([1, 2]);
      case 'military':
        this.playBuf(this.drum.dum, at, 0.09, bus, 0.8);
        return at + 0.55;
      case 'civic':
        this.noiseHit(at, 0.12, 'highpass', 3000, 0.7, 0.02, bus);
        return at + r.float(1, 2.5);
    }
  }

  // -------------------------------------------------------------------------
  // Effects
  // -------------------------------------------------------------------------

  private get ready(): boolean {
    return !!this.ctx && this.started && !!this.sfxBus;
  }

  tap(): void {
    if (!this.ready) return;
    const t = this.ctx!.currentTime;
    this.noiseHit(t, 0.03, 'bandpass', 2600, 3, 0.05, this.sfxBus);
    this.tone(t, 1400, 0.04, 0.03, this.sfxBus);
  }

  /** A soft whoosh for panels opening. */
  panel(): void {
    if (!this.ready) return;
    this.noiseHit(this.ctx!.currentTime, 0.18, 'bandpass', 900, 1.2, 0.04, this.sfxBus, 2600);
  }

  /** Something set down: a thud, a scatter of grit, a little dust. */
  build(pan = 0): void {
    if (!this.ready) return;
    const t = this.ctx!.currentTime;
    this.tone(t, 150, 0.16, 0.18, this.sfxBus, 'sine', 62);
    this.noiseHit(t + 0.01, 0.2, 'highpass', 1600, 0.7, 0.07, this.sfxBus);
    this.noiseHit(t + 0.05, 0.35, 'lowpass', 900, 0.7, 0.05, this.sfxBus, 300);
    void pan;
  }

  /** Laying road: a quick scrape. */
  road(): void {
    if (!this.ready) return;
    this.noiseHit(this.ctx!.currentTime, 0.12, 'bandpass', 1800, 1.5, 0.06, this.sfxBus, 900);
  }

  demolish(): void {
    if (!this.ready) return;
    const t = this.ctx!.currentTime;
    this.noiseHit(t, 0.5, 'lowpass', 2400, 0.7, 0.2, this.sfxBus, 260);
    for (let k = 0; k < 5; k++) this.noiseHit(t + 0.05 + k * 0.06, 0.08, 'bandpass', this.rng.float(500, 1500), 2, 0.06, this.sfxBus);
  }

  error(): void {
    if (!this.ready) return;
    const t = this.ctx!.currentTime;
    this.tone(t, 180, 0.12, 0.1, this.sfxBus, 'square', 150);
    this.tone(t + 0.13, 150, 0.16, 0.09, this.sfxBus, 'square', 120);
  }

  /** Coins: a few bright clinks, more for more money. */
  coins(amount: number, gain = 1): void {
    if (!this.ready) return;
    const t = this.ctx!.currentTime;
    const n = clamp(Math.round(Math.log2(Math.max(2, amount))), 2, 7);
    for (let k = 0; k < n; k++) this.clank(t + k * this.rng.float(0.04, 0.09), this.rng.float(2600, 3600), 0.03 * gain, this.sfxBus);
  }

  /** A house rose a level: a rising harp figure, higher for grander houses. */
  evolve(level: number, gain = 1, pan = 0): void {
    if (!this.ready) return;
    const t = this.ctx!.currentTime;
    const scale = MODES.rast;
    const base = 62 + Math.min(12, Math.floor(level / 2));
    [0, 2, 4].forEach((d, k) => this.pluck('harp', base + scale[d], t + k * 0.07, 0.09 * gain, pan, this.sfxBus));
  }

  /** A house fell a level: a falling, minor figure. */
  devolve(gain = 1, pan = 0): void {
    if (!this.ready) return;
    const t = this.ctx!.currentTime;
    [7, 3, 0].forEach((s, k) => this.pluck('harp', 60 + s, t + k * 0.09, 0.07 * gain, pan, this.sfxBus));
  }

  /** A house grew onto a larger plot: a wider arpeggio and a shimmer. */
  grow(gain = 1, pan = 0): void {
    if (!this.ready) return;
    const t = this.ctx!.currentTime;
    [0, 4, 7, 12, 16].forEach((s, k) => this.pluck('harp', 62 + s, t + k * 0.06, 0.09 * gain, pan, this.sfxBus));
    this.playBuf(this.drum.zill, t + 0.3, 0.05 * gain, this.sfxBus);
  }

  /** A message arrived: the tone says whether it is good or bad before you read it. */
  chime(good = true): void {
    if (!this.ready) return;
    const t = this.ctx!.currentTime;
    const notes = good ? [0, 4, 7] : [0, 1, -4];
    notes.forEach((n, i) => this.pluck('harp', 69 + n, t + i * 0.11, 0.1, 0, this.sfxBus));
  }

  /** Fire: an alarm of struck bronze. */
  fireAlarm(): void {
    if (!this.ready) return;
    const t = this.ctx!.currentTime;
    for (let k = 0; k < 4; k++) this.clank(t + k * 0.22, 880, 0.07, this.sfxBus);
  }

  /** Something collapsed: a deep crumble. */
  collapse(): void {
    if (!this.ready) return;
    const t = this.ctx!.currentTime;
    this.tone(t, 80, 0.6, 0.18, this.sfxBus, 'sine', 40);
    this.noiseHit(t, 0.9, 'lowpass', 1200, 0.7, 0.18, this.sfxBus, 120);
  }

  /** Enemy at the border: a war horn. */
  horn(): void {
    if (!this.ready) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    for (const [at, hz, dur] of [[0, 147, 0.7], [0.8, 147, 0.35], [1.2, 165, 1.3]] as [number, number, number][]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(hz * 0.97, t + at);
      o.frequency.linearRampToValueAtTime(hz, t + at + 0.12);
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.setValueAtTime(400, t + at);
      f.frequency.linearRampToValueAtTime(1400, t + at + 0.15);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t + at);
      g.gain.linearRampToValueAtTime(0.13, t + at + 0.1);
      g.gain.setValueAtTime(0.13, t + at + dur - 0.15);
      g.gain.linearRampToValueAtTime(0, t + at + dur);
      o.connect(f).connect(g).connect(this.sfxBus);
      o.start(t + at);
      o.stop(t + at + dur + 0.05);
    }
  }

  /** A god's favour: a harp glissando and the sistrum. */
  blessing(): void {
    if (!this.ready) return;
    const t = this.ctx!.currentTime;
    const scale = MODES.rast;
    for (let k = 0; k < 10; k++) this.pluck('harp', 57 + scale[k % 7] + 12 * Math.floor(k / 7), t + k * 0.05, 0.07, 0, this.sfxBus);
    this.playBuf(this.drum.sistrum, t + 0.5, 0.09, this.sfxBus);
  }

  /** A god's anger: thunder. */
  thunder(): void {
    if (!this.ready) return;
    const t = this.ctx!.currentTime;
    this.noiseHit(t, 2.6, 'lowpass', 300, 0.7, 0.3, this.sfxBus, 60);
    this.noiseHit(t + 0.1, 0.5, 'lowpass', 1800, 0.7, 0.15, this.sfxBus, 300);
  }

  /** A monument stage done: drums and a rising call. */
  fanfare(big = false): void {
    if (!this.ready) return;
    const t = this.ctx!.currentTime;
    for (let k = 0; k < (big ? 6 : 3); k++) this.playBuf(this.drum.dum, t + k * 0.18, 0.12, this.sfxBus);
    const notes = big ? [0, 4, 7, 12, 7, 12] : [0, 4, 7];
    notes.forEach((n, k) => this.ney(62 + n + 12, t + 0.5 + k * 0.22, 0.4, 0.07, 0, this.sfxBus));
  }
}
