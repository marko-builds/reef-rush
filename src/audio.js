// audio.js — v3 STYLED reef audio bus. ADDITIVE feedback only.
//
// Calm, cheerful casual-mobile underwater mix. EVERY sound is SYNTHESIZED with the
// WebAudio API (oscillators / filtered noise / gain envelopes) — there are NO
// external audio files, fully original, tiny. See assets/audio/README.md.
//
// Architecture (mirrors the audio skill: ONE bus, ONE mute, event hooks):
//   AudioContext -> master GainNode -> destination
//   - ambient underwater bed runs continuously UNDER everything (very low gain).
//   - one-shot SFX (pop / plip / park / vacate / win / lose) are built per event
//     from short-lived nodes that disconnect+stop themselves when finished.
//   - a tiny VOICE CAP throttles overlapping cube-pops so a ~7-8/s burst reads as
//     pleasant bubbling, not a machine-gun.
//
// It is driven off the SAME render-safe hooks the VfxLayer uses:
//   - pigs.vfx[]  : DATA events {type:'fire'|'slotFill'|'slotVacate', ...}
//   - pigs.state  : 'playing' | 'won' | 'lost'
// We do NOT drain pigs.vfx ourselves (the VfxLayer owns that and clears it). Instead
// main.js snapshots the queue and hands events to us BEFORE the VfxLayer clears it.
//
// HARD CONSTRAINT: this module is constructed ONLY from main.js. The headless
// harnesses never build it, so it can never affect them. Every method is null-safe:
// if the AudioContext can't start yet (autoplay policy) nothing errors — it silently
// no-ops until the first user gesture resumes it.

// ---- master mix (gentle by default; the game is fully playable muted) ---------
const MASTER_GAIN  = 0.55;   // overall ceiling — leaves headroom, never harsh
const AMBIENT_GAIN = 0.05;   // the underwater bed sits FAR under the sfx

// ---- FILE-BASED voices (Phase 5) ----------------------------------------------
// The player supplied real audio files for the events the synth bus never
// covered (see prompts/AUDIO-SEARCH-LIBRARY.md). They are fetched + decoded
// LAZILY after the first user gesture and play through the SAME master gain
// (one bus, one mute). A missing/failed file silently falls back to the synth
// voice (or to nothing) — exactly the sprite-pipeline philosophy.
const AUDIO_BASE = 'assets/audio/';
const FILE_SFX = {            // id -> playback gain (relative, under master)
  mine_bomb: 0.9,             // mine blast (the board-cracking spike moment)
  leaf_rustle: 0.55,          // seaweed dewrap peel
  golden_launch: 0.7,         // golden pig enters the belt
  golden_pierce: 0.5,         // golden pierce pair (2nd hit of one shot)
  wheel_spin: 0.8,            // bonus wheel launches forward
  spin_settle: 0.7,           // wheel parks on its result
  level_clear: 0.85,          // level 1-4 cleared (before the wheel)
  treasure_reveal: 0.9,       // level-5 pearl pops free (the finale)
};
const FILE_LOOPS = [          // continuous beds, started on the first gesture
  { id: 'bg_music', gain: 0.22 },  // cheerful underwater track
  { id: 'amb_music', gain: 0.30 }, // bubbling sea ambience
];

// ---- cube-pop voice cap -------------------------------------------------------
// Pops fire at the ~130ms cadence (7-8/s) in a burst. Cap concurrent pop voices so
// overlaps don't pile up and clip; extra pops in the same instant are dropped.
const POP_MAX_VOICES = 4;
const POP_MIN_GAP    = 0.012; // s — coalesce pops landing in the exact same tick

export class AudioBus {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.ambient = null;       // { nodes... } once started
    this.muted = false;
    this._popVoices = 0;       // live cube-pop voice count (for the cap)
    this._lastPopAt = -1;      // ctx.currentTime of the last accepted pop
    this._started = false;     // becomes true after the first successful resume
    this._wantAmbient = false; // ambient requested but ctx not ready yet
    this._buffers = {};        // id -> decoded AudioBuffer (file voices)
    this._loadKicked = false;  // file fetch+decode started (once)
    this._loopsLive = new Set(); // loop ids already playing
  }

  // Fetch + decode every file voice once, in the background. When a loop's
  // buffer lands and ambient was requested, start it; if NO loop decodes at
  // all (files absent), fall back to the synthesized bed.
  _loadFiles() {
    if (this._loadKicked || !this.ctx) return;
    this._loadKicked = true;
    const ids = [...Object.keys(FILE_SFX), ...FILE_LOOPS.map((l) => l.id)];
    let pending = ids.length;
    for (const id of ids) {
      fetch(AUDIO_BASE + id + '.mp3')
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(r.status)))
        .then((ab) => this.ctx.decodeAudioData(ab))
        .then((buf) => { this._buffers[id] = buf; this._afterLoad(--pending); })
        .catch(() => this._afterLoad(--pending)); // missing -> silent fallback
    }
  }
  _afterLoad(pending) {
    if (this._wantAmbient) this._maybeStartLoops();
    if (pending === 0 && this._wantAmbient &&
        !FILE_LOOPS.some((l) => this._buffers[l.id])) {
      this._startAmbient(); // no loop files decoded -> synth bed fallback
    }
  }

  // Start any decoded-but-not-yet-playing loop (looping buffer -> gain -> master).
  _maybeStartLoops() {
    if (!this._ready()) return;
    for (const spec of FILE_LOOPS) {
      const buf = this._buffers[spec.id];
      if (!buf || this._loopsLive.has(spec.id)) continue;
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const g = this.ctx.createGain();
      g.gain.value = spec.gain;
      src.connect(g); g.connect(this.master);
      src.start();
      this._loopsLive.add(spec.id);
    }
  }

  // One-shot file voice; falls back to the given synth closure if the buffer
  // isn't available (not yet decoded, fetch failed, or file absent).
  _playFile(id, fallback = null) {
    if (!this._ready() || this.muted) return;
    const buf = this._buffers[id];
    if (!buf) { if (fallback) fallback(); return; }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const g = this.ctx.createGain();
    g.gain.value = FILE_SFX[id] ?? 0.7;
    src.connect(g); g.connect(this.master);
    src.start();
    src.onended = () => { try { src.disconnect(); g.disconnect(); } catch (_) {} };
  }

  // Create the AudioContext lazily on the FIRST user gesture (autoplay policy).
  // Safe to call repeatedly; only the first call builds anything. Returns nothing
  // and never throws — if construction fails we simply stay silent.
  resume() {
    try {
      if (!this.ctx) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;                     // no WebAudio -> silent, never crash
        this.ctx = new Ctx();
        this.master = this.ctx.createGain();
        this.master.gain.value = this.muted ? 0 : MASTER_GAIN;
        this.master.connect(this.ctx.destination);
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
      this._started = true;
      this._loadFiles();                            // kick the file decode once
      if (this._wantAmbient) this._maybeStartLoops(); // loops own the bed now
    } catch (e) {
      // Autoplay rejection or unsupported context: stay silent, keep the game alive.
      this.ctx = null;
    }
  }

  // Ready = we have a running context we can schedule on.
  _ready() {
    return !!(this.ctx && this.master && this.ctx.state === 'running');
  }

  // ---- mute --------------------------------------------------------------------
  setMute(m) {
    this.muted = !!m;
    if (this.master) {
      // smooth the gain change so toggling never clicks.
      const now = this.ctx.currentTime;
      this.master.gain.cancelScheduledValues(now);
      this.master.gain.setTargetAtTime(this.muted ? 0 : MASTER_GAIN, now, 0.02);
    }
  }
  toggleMute() { this.setMute(!this.muted); return this.muted; }

  // ---- ambient underwater bed --------------------------------------------------
  // A soft, gentle water-current loop: two detuned low sine "swells" through a
  // lowpass, plus a whisper of filtered noise, all very quiet. Continuous (no
  // restart cost), modulated slowly so the sea feels alive without drawing focus.
  startAmbient() {
    this._wantAmbient = true;
    // Phase 5: the file loops (bg_music + amb_music) own the bed; the synth bed
    // only starts as the fallback if no loop file decodes (see _afterLoad).
    if (this._ready()) this._maybeStartLoops();
  }
  _startAmbient() {
    if (this.ambient || !this._ready()) return;
    const ctx = this.ctx;
    const bed = ctx.createGain();
    bed.gain.value = AMBIENT_GAIN;
    bed.connect(this.master);

    // Lowpass keeps it dark/underwater.
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 380;
    lp.connect(bed);

    // Two slow detuned swells (a calm "current" drone).
    const oscA = ctx.createOscillator();
    oscA.type = 'sine'; oscA.frequency.value = 64;
    const oscB = ctx.createOscillator();
    oscB.type = 'sine'; oscB.frequency.value = 81; // gentle beating against A
    oscA.connect(lp); oscB.connect(lp);

    // A slow LFO breathes the bed's amplitude so the current ebbs and flows.
    const lfo = ctx.createOscillator();
    lfo.type = 'sine'; lfo.frequency.value = 0.08; // ~12.5 s cycle
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = AMBIENT_GAIN * 0.5;
    lfo.connect(lfoGain); lfoGain.connect(bed.gain);

    // A whisper of filtered noise = water texture, kept extremely quiet.
    const noise = this._makeNoise(2.0);
    const nGain = ctx.createGain(); nGain.gain.value = AMBIENT_GAIN * 0.35;
    const nLp = ctx.createBiquadFilter();
    nLp.type = 'lowpass'; nLp.frequency.value = 500;
    noise.connect(nLp); nLp.connect(nGain); nGain.connect(this.master);

    const t = ctx.currentTime;
    oscA.start(t); oscB.start(t); lfo.start(t); noise.start(t);
    this.ambient = { bed, lp, oscA, oscB, lfo, lfoGain, noise, nGain, nLp };
  }

  // ---- small synth helpers -----------------------------------------------------
  // A reusable short noise buffer source (white noise), created per call (cheap,
  // bounded by event rate). Caller connects + starts/stops.
  _makeNoise(seconds) {
    const ctx = this.ctx;
    const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = seconds >= 1; // long buffers loop (ambient); short ones are one-shot
    return src;
  }

  // Schedule a single oscillator "blip" with an ADSR-ish gain envelope, auto-cleaned.
  // opts: { type, f0, f1, attack, decay, peak, when }
  _blip({ type = 'sine', f0, f1 = f0, attack = 0.005, decay = 0.12, peak = 0.5, when = 0 } = {}) {
    if (!this._ready()) return null;
    const ctx = this.ctx;
    const t = ctx.currentTime + when;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + attack + decay);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    osc.connect(g); g.connect(this.master);
    osc.start(t);
    const stopAt = t + attack + decay + 0.02;
    osc.stop(stopAt);
    osc.onended = () => { try { osc.disconnect(); g.disconnect(); } catch (_) {} };
    return { osc, g, stopAt };
  }

  // ============================================================================
  // EVENT HOOKS (called from main.js — all null-safe, all no-op until resumed)
  // ============================================================================

  // LAUNCH (tap): a light, responsive "plip" when a pig launches onto the belt.
  onLaunch() {
    if (!this._ready() || this.muted) return;
    // a short upward sine chirp — bright but soft.
    this._blip({ type: 'sine', f0: 520, f1: 920, attack: 0.004, decay: 0.10, peak: 0.32 });
  }

  // CUBE POP: a soft bubbly "bloop" on each cube destroy. Very short + slightly
  // pitch-randomized (also nudged by which color popped) so a burst reads as
  // pleasant bubbling. Throttled by the voice cap so overlaps don't clip.
  onPop(colorKey) {
    if (!this._ready() || this.muted) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    // coalesce identical-instant pops + enforce the concurrent-voice cap.
    if (now - this._lastPopAt < POP_MIN_GAP) return;
    if (this._popVoices >= POP_MAX_VOICES) return;
    this._lastPopAt = now;

    // base pitch per color so each of the 4 palette slots bubbles at a distinct
    // note (rising C1->C4), plus a small random jitter so repeats within one
    // color still vary.
    const colorBase = { C1: 320, C2: 470, C3: 560, C4: 660 };
    const base = (colorBase[colorKey] ?? 380) * (0.94 + Math.random() * 0.12);

    // a "bloop": a quick downward pitch drop through a lowpass = a bubble closing.
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(base * 1.7, now);
    osc.frequency.exponentialRampToValueAtTime(base, now + 0.06);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = base * 4;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(0.22, now + 0.004); // soft
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.085); // very short (~85ms)
    osc.connect(lp); lp.connect(g); g.connect(this.master);

    this._popVoices++;
    osc.start(now);
    const stopAt = now + 0.10;
    osc.stop(stopAt);
    osc.onended = () => {
      this._popVoices = Math.max(0, this._popVoices - 1);
      try { osc.disconnect(); lp.disconnect(); g.disconnect(); } catch (_) {}
    };
  }

  // PARK: a soft settle cue when a pig parks in a waiting slot (a gentle low thunk).
  onPark() {
    if (!this._ready() || this.muted) return;
    this._blip({ type: 'sine', f0: 300, f1: 200, attack: 0.006, decay: 0.16, peak: 0.26 });
  }

  // VACATE: a small distinct cue when a seat is freed by a re-tap (a quick up-tick).
  onVacate() {
    if (!this._ready() || this.muted) return;
    this._blip({ type: 'triangle', f0: 440, f1: 660, attack: 0.004, decay: 0.08, peak: 0.18 });
  }

  // WIN: a short cheerful rising arpeggio (C-E-G-C, pentatonic-bright) on board clear.
  onWin() {
    if (!this._ready() || this.muted) return;
    const notes = [523.25, 659.25, 783.99, 1046.5]; // C5 E5 G5 C6
    notes.forEach((f, i) => {
      this._blip({ type: 'triangle', f0: f, f1: f, attack: 0.01, decay: 0.34, peak: 0.30, when: i * 0.10 });
    });
  }

  // LOSE (lockup): a calm, low "jammed" tone — a soft falling two-note, NOT a buzzer.
  onLose() {
    if (!this._ready() || this.muted) return;
    this._blip({ type: 'sine', f0: 220, f1: 175, attack: 0.02, decay: 0.55, peak: 0.30, when: 0.0 });
    this._blip({ type: 'sine', f0: 165, f1: 130, attack: 0.02, decay: 0.70, peak: 0.26, when: 0.12 });
  }

  // ---- Phase 5 FILE voices (each falls back to a synth read if the file is
  // absent — the game keeps its full audio story either way) ------------------

  // MINE BOOM: the area-clear blast — clearly bigger than any pop.
  onMineBoom() {
    this._playFile('mine_bomb', () =>
      this._blip({ type: 'sine', f0: 110, f1: 42, attack: 0.005, decay: 0.5, peak: 0.5 }));
  }

  // DEWRAP: the seaweed peel — armor damage, deliberately NOT a pop.
  onDewrap() {
    this._playFile('leaf_rustle', () =>
      this._blip({ type: 'triangle', f0: 700, f1: 320, attack: 0.004, decay: 0.09, peak: 0.16 }));
  }

  // GOLDEN LAUNCH: the jackpot pig enters the belt — a sparkle over the plip.
  onGoldenLaunch() {
    this._playFile('golden_launch', () => this.onLaunch());
  }

  // GOLDEN PIERCE: the pair's second hit (one shot, two blocks).
  onGoldenPierce() {
    this._playFile('golden_pierce', () => this.onPop('C4'));
  }

  // SPIN START / SETTLE: the level-clear bonus wheel beats.
  onSpinStart()  { this._playFile('wheel_spin'); }
  onSpinSettle() { this._playFile('spin_settle'); }

  // LEVEL CLEAR (levels 1-4) and the LEVEL-5 TREASURE finale.
  onLevelClear() { this._playFile('level_clear', () => this.onWin()); }
  onTreasure()   { this._playFile('treasure_reveal', () => this.onWin()); }

  // ---- teardown ----------------------------------------------------------------
  dispose() {
    try {
      if (this.ambient) {
        const a = this.ambient;
        a.oscA.stop(); a.oscB.stop(); a.lfo.stop(); a.noise.stop();
        for (const k of ['bed', 'lp', 'oscA', 'oscB', 'lfo', 'lfoGain', 'noise', 'nGain', 'nLp']) {
          try { a[k].disconnect(); } catch (_) {}
        }
        this.ambient = null;
      }
      if (this.ctx) this.ctx.close();
    } catch (_) {}
    this.ctx = null; this.master = null;
  }
}
