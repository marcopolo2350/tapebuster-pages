
import { DEFAULT_STATION, STATION_BY_ID } from './radio/stations-yt.js';
import { customPlaylists } from './radio/custom-playlists.js';

// Store audio — HVAC rumble, fluorescent hum, footsteps, case handling and UI
// blips, all synthesized here. The MUSIC is not: it comes from the YouTube
// station dial. The generated in-store station this file used to own has been
// removed from the runtime entirely — see startRadio().
// Was: fully synthesized store audio — HVAC rumble, fluorescent hum, footsteps,
// case handling, UI blips, and a lo-fi in-store radio loop. No audio files,
// no copyrighted music — every note is scheduled from oscillators here.
export class StoreAudio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.muted = localStorage.getItem('tb_muted') === '1';
    this.radioOn = localStorage.getItem('tb_radio') !== '0'; // in-store radio defaults ON
    this.radioVol = Math.min(1, Math.max(0, parseFloat(localStorage.getItem('tb_radio_vol') ?? '0.65')));
    this.started = false;
    this._trouble = null;      // why the music is not playing, for the UI
  }

  /**
   * Where the music sits in the store mix.
   *
   * Every track is normalised to -19 LUFS before it reaches this bus, so this
   * one number is the whole music-versus-store balance. At the default 0.65 it
   * lands roughly 9 dB under a footstep and 6 dB under the checkout chime, so
   * the radio is clearly there and never covers the room. Measured in
   * qa/radio-certification.json.
   */
  radioBusGain() {
    return 0.42 * this.radioVol;
  }

  ensure() {
    if (this.ctx) return true;
    try {
      // iPHONE SILENT SWITCH (the "no clicking noise" report): Web Audio
      // routes through the RINGER channel by default, so the hardware mute
      // switch silences the whole store — clicks, ambience and radio — while
      // every control claims sound is on. Declaring a 'playback' audio
      // session (iOS 16.4+) routes us like a music app, which ignores the
      // switch. Harmless everywhere else.
      try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch { /* older iOS */ }
      // Adopt the context the ONBOARDING click unlocked, if one exists: with
      // auto-entry there is no second in-store click to resume on, so the
      // gesture that builds the store is the gesture that unlocks the sound.
      this.ctx = window.__tbAudioCtx
        ?? new (window.AudioContext || window.webkitAudioContext)();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 1;
      this.master.connect(this.ctx.destination);
      return true;
    } catch { return false; }
  }

  // Call on user gestures. Cheap when already started — but the resume must
  // run EVERY time, because the browser can suspend the context long after the
  // first gesture (tab discarded, output device change) and the old early
  // return made that permanent silence until reload.
  start() {
    if (!this.ensure()) return;
    if (this.ctx.state === 'suspended') this.ctx.resume();
    if (this.started) return;
    this.started = true;
    const ctx = this.ctx;

    // --- HVAC: looped brown noise through a low lowpass
    const len = ctx.sampleRate * 3;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      data[i] = last * 3.2;
    }
    const hvac = ctx.createBufferSource();
    hvac.buffer = buf; hvac.loop = true;
    const hvacFilter = ctx.createBiquadFilter();
    hvacFilter.type = 'lowpass'; hvacFilter.frequency.value = 160;
    const hvacGain = ctx.createGain(); hvacGain.gain.value = 0.06;
    hvac.connect(hvacFilter).connect(hvacGain).connect(this.master);
    hvac.start();

    // slow drift on the vent tone
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.05;
    const lfoGain = ctx.createGain(); lfoGain.gain.value = 30;
    lfo.connect(lfoGain).connect(hvacFilter.frequency);
    lfo.start();

    // --- fluorescent hum: 120Hz + harmonics, extremely quiet
    const humGain = ctx.createGain(); humGain.gain.value = 0.006;
    humGain.connect(this.master);
    for (const [f, g] of [[120, 1], [240, 0.5], [360, 0.22]]) {
      const o = ctx.createOscillator();
      o.type = 'sine'; o.frequency.value = f;
      o.detune.value = Math.random() * 6 - 3;
      const og = ctx.createGain(); og.gain.value = g;
      o.connect(og).connect(humGain);
      o.start();
    }
  }

  // ------------------------------------------------------------------------
  // In-store radio.
  //
  // The engine itself lives in src/systems/radio/. This class only owns the
  // store's mixer: where the radio sits relative to footsteps, NPCs, the
  // escalator and the UI. See radio/player.js for why the PA is distributed
  // mono rather than positional, and radio/compose.js for the musical model.
  //
  // PROVENANCE: every sample is generated by this repository from a seed. No
  // recording is fetched, bundled or imitated, and nothing here is presented
  // as licensed commercial music.
  /**
   * THE RADIO DOES NOT NEED THE WEB AUDIO CONTEXT, AND GATING IT ON ONE KEPT
   * IT SILENT ON THE DEVICE.
   *
   * This read `if (!this.ctx || !this.radioOn) return;` — a guard inherited
   * from the synth station, which genuinely did render through this.ctx and
   * this.master. The YouTube source does not. It is a cross-origin iframe with
   * its own decoder and its own output; the store's mixer is not in that path
   * at all.
   *
   * So on any device where ensure() could not build or resume an AudioContext,
   * startRadio() returned on the first line and the radio never even
   * ATTEMPTED to start. No error, no fallback, no trace entry — the exact
   * reported symptom: nothing plays, ever, however many times you tap.
   *
   * The only thing that gates music now is whether music is switched on.
   */
  // ======================= THE RADIO ========================================
  //
  // ONE production path. The player is built at boot and lives for the
  // session; a tap only ever calls into it synchronously.
  //
  // Nothing here depends on this.ctx. The YouTube player is a cross-origin
  // iframe with its own decoder and its own output, and gating it on our Web
  // Audio context is what kept the phone silent for an entire pass.

  /** dev/QA override: a global for deploy config, or storage for a pasted id */
  ytPlaylist() { return window.TB_RADIO_YT_PLAYLIST || localStorage.getItem('tb_yt_playlist') || null; }

  /** The station on the dial. A first-time visitor gets BLOCKBUSTER THROWBACK. */
  ytStation() {
    const saved = localStorage.getItem('tb_radio_station');
    if (saved === 'custom') return 'custom';
    return saved || DEFAULT_STATION;
  }

  /** The playlists behind whatever the dial points at, known LOCALLY. */
  stationPlaylists(id = this.ytStation()) {
    const override = this.ytPlaylist();
    if (override) return { id: 'custom', label: 'CUSTOM', playlists: [override] };
    if (id === 'custom') {
      const cur = customPlaylists().find((p) => p.id === localStorage.getItem('tb_custom_current'));
      return cur ? { id: 'custom', label: cur.name, playlists: [cur.playlistId] } : null;
    }
    const st = STATION_BY_ID[id];
    return st ? { id: st.id, label: st.label, playlists: st.playlists } : null;
  }

  radioTrouble() { return this._yt?.trouble ?? this._trouble ?? null; }
  radioReady() { return !!this._yt?.ready; }

  /**
   * BOOT. Loads the API and builds the player with the current station CUED,
   * so nothing plays and no gesture is needed. Deliberately not awaited by the
   * caller: the store must open whether or not YouTube is reachable.
   */
  async prewarmRadio() {
    if (this._yt || this._prewarming) return;
    this._prewarming = true;
    try {
      const { YouTubeRadio } = await import('./radio/youtube-radio.js');
      const sel = this.stationPlaylists();
      this._yt = new YouTubeRadio({ onChange: () => this.onRadioChange?.(), volume: this.radioVol });
      await this._yt.prewarm({ playlistId: sel?.playlists?.[0] ?? null, stationId: sel?.id ?? null });
    } catch (e) {
      this._trouble = 'The radio could not start.';
      console.info('radio prewarm failed:', e?.message ?? e);
    } finally {
      this._prewarming = false;
      this.onRadioChange?.();
    }
  }

  /**
   * PLAY A STATION. Called straight from a click handler, and everything it
   * touches is synchronous — no await, no import, no fetch, no oEmbed, no
   * timer. The moment one of those is added here the user activation is spent
   * and the radio goes silent on a phone while still working on a desktop.
   */
  playStation(id) {
    localStorage.setItem('tb_radio_station', id);
    if (id !== 'custom') localStorage.removeItem('tb_yt_playlist');
    this.radioOn = true;
    localStorage.setItem('tb_radio', '1');
    const sel = this.stationPlaylists(id);
    if (!sel) { this._trouble = 'That station has no playlist.'; this.onRadioChange?.(); return false; }
    this._trouble = null;
    if (!this._yt) { this.prewarmRadio(); this._trouble = 'Preparing radio…'; this.onRadioChange?.(); return false; }
    return this._yt.playStation(sel.id, sel.playlists);
  }

  /** Kept for callers that speak the old vocabulary. */
  setRadioStation(id) { return this.playStation(id); }

  /** Resume or start the current station. Synchronous; call from a gesture. */
  startRadio() {
    if (!this.radioOn || !this._yt) return false;
    if (this._yt.lastState) return this._yt.play();
    const sel = this.stationPlaylists();
    return sel ? this._yt.playStation(sel.id, sel.playlists) : false;
  }

  /** WAS: composing a synth library during boot. That station is gone. */
  primeRadio() { /* nothing to prime */ }

  stopRadio() { this._yt?.pause?.(); }
  skipRadio() { return this._yt?.next?.() ?? false; }
  previousRadio() { return this._yt?.previous?.() ?? false; }
  reshuffle() { return this._yt?.shuffle?.() ?? false; }

  setRadio(on) {
    this.radioOn = on;
    localStorage.setItem('tb_radio', on ? '1' : '0');
    if (on) { if (this._yt) this.startRadio(); else this.prewarmRadio(); return; }
    // OFF MEANS OFF. A paused embed still holds its decode pipeline, and this
    // is the device the whole crash effort was about.
    this._trouble = null;
    this._yt?.dispose?.();
    this._yt = null;
    this.onRadioChange?.();
  }

  setRadioVolume(v) {
    this.radioVol = Math.min(1, Math.max(0, v));
    localStorage.setItem('tb_radio_vol', String(this.radioVol));
    this._yt?.setVolume?.(this.radioVol);
  }

  /** Everything the UI and QA need, in one object. */
  radioState() {
    const st = this._yt?.state?.();
    if (st) return st;
    return {
      source: 'youtube', ready: false, playing: false, blocked: false,
      station: this.ytStation(), playlist: null, nowPlaying: null,
      lastState: null, trouble: this._trouble ?? null,
    };
  }

  debugState() {
    const r = this.radioState();
    return {
      ctx: this.ctx ? this.ctx.state : 'none',
      master: this.master ? +this.master.gain.value.toFixed(2) : 0,
      radio: r.playing ? 'playing' : 'stopped',
      radioVol: +this.radioVol.toFixed(2),
      nowPlaying: r.nowPlaying,
      family: r.family ?? null,
      section: r.section ?? null,
      library: r.library,
    };
  }

  // Escalator: quiet motor hum + step ticks while riding
  setRiding(on) {
    if (!this.ctx || this.muted) { this._rideNodes?.stop?.(); this._rideNodes = null; return; }
    if (on && !this._rideNodes) {
      const ctx = this.ctx;
      const g = ctx.createGain(); g.gain.value = 0;
      g.gain.linearRampToValueAtTime(0.035, ctx.currentTime + 0.5);
      g.connect(this.master);
      const o = ctx.createOscillator();
      o.type = 'sawtooth'; o.frequency.value = 48;
      const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 140;
      o.connect(f).connect(g);
      o.start();
      const tick = ctx.createOscillator();
      tick.type = 'square'; tick.frequency.value = 96;
      const tickGain = ctx.createGain(); tickGain.gain.value = 0.006;
      const lfo = ctx.createOscillator(); lfo.frequency.value = 2.1;
      const lfoGain = ctx.createGain(); lfoGain.gain.value = 0.006;
      lfo.connect(lfoGain).connect(tickGain.gain);
      tick.connect(tickGain).connect(g);
      tick.start(); lfo.start();
      this._rideNodes = {
        stop: () => {
          g.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.4);
          setTimeout(() => { o.stop(); tick.stop(); lfo.stop(); }, 500);
        },
      };
    } else if (!on && this._rideNodes) {
      this._rideNodes.stop();
      this._rideNodes = null;
    }
  }

  setMuted(m) {
    this.muted = m;
    localStorage.setItem('tb_muted', m ? '1' : '0');
    if (this.master) this.master.gain.linearRampToValueAtTime(m ? 0 : 1, this.ctx.currentTime + 0.15);
  }

  // ---- one-shots ----
  noiseBurst({ dur = 0.09, freq = 600, q = 1.4, gain = 0.2, type = 'bandpass', pan = 0, rate = 1 }) {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx;
    const len = Math.ceil(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource();
    src.buffer = buf; src.playbackRate.value = rate;
    const f = ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = ctx.createGain(); g.gain.value = gain;
    const p = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (p) { p.pan.value = pan; src.connect(f).connect(g).connect(p).connect(this.master); }
    else src.connect(f).connect(g).connect(this.master);
    src.start();
  }

  tone({ freq = 660, dur = 0.12, gain = 0.08, type = 'triangle', glideTo = null, delay = 0 }) {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    o.type = type; o.frequency.setValueAtTime(freq, t0);
    if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0004, t0 + dur);
    o.connect(g).connect(this.master);
    o.start(t0); o.stop(t0 + dur + 0.05);
  }

  footstep(intensity = 1, side = 1) {
    this.noiseBurst({ dur: 0.07, freq: 380 + Math.random() * 160, gain: 0.05 + intensity * 0.05, pan: side * 0.12, rate: 0.9 + Math.random() * 0.25 });
    this.noiseBurst({ dur: 0.05, freq: 95, type: 'lowpass', gain: 0.10 * intensity });
  }
  casePick() {
    this.noiseBurst({ dur: 0.1, freq: 900, gain: 0.09, rate: 1.3 });
    this.tone({ freq: 300, glideTo: 420, dur: 0.08, gain: 0.02, type: 'sine' });
  }
  casePut() {
    this.noiseBurst({ dur: 0.06, freq: 500, gain: 0.07 });
    this.tone({ freq: 150, dur: 0.1, gain: 0.05, type: 'sine' });
  }
  addStack() {
    this.tone({ freq: 660, dur: 0.1, gain: 0.06 });
    this.tone({ freq: 880, dur: 0.14, gain: 0.06, delay: 0.09 });
  }
  checkout() {
    this.tone({ freq: 523, dur: 0.12, gain: 0.06 });
    this.tone({ freq: 659, dur: 0.12, gain: 0.06, delay: 0.1 });
    this.tone({ freq: 784, dur: 0.22, gain: 0.07, delay: 0.2 });
  }
  uiBlip(v = 1) {
    this.tone({ freq: 1180, dur: 0.05, gain: 0.025 * v, type: 'sine' });
  }
  error() {
    this.tone({ freq: 220, dur: 0.16, gain: 0.05, type: 'square' });
  }
}
