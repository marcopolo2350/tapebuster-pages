// The in-store PA: playback, crossfades and the room the music sits in.
//
// Design notes that are not obvious from the code:
//
// * MONO, DISTRIBUTED. A Blockbuster-era ceiling array is a 70-volt line of
//   identical drivers in the tiles; the music is the same everywhere and does
//   not pan as you walk. Positional panners were tried and rejected — several
//   PannerNodes fed from one source comb-filter against each other as the
//   listener moves, which sounds like a flanger, not like a shop. The sense of
//   place comes from the room instead: a generated store reverb and a PA
//   band-limit, both of which are what you actually hear in a big retail box.
//
// * ONE BUFFER PER TRACK. The old engine scheduled every note as live Web
//   Audio nodes, so hundreds of oscillators existed at any moment forever.
//   Here a track is one AudioBufferSourceNode.
//
// * NO SEAM AT THE START. Rendering begins during store boot, well before the
//   first user gesture that is allowed to create an AudioContext, so the
//   station is ready by the time anyone can hear it, and it fades in over a
//   couple of seconds rather than snapping on mid-bar.

import { buildLibrary } from './compose.js';
import { renderTrack } from './synth.js';
import { masterTrack, trimTail } from './master.js';
import { Station } from './station.js';

export const RENDER_SR = 22050;

/** Generated impulse response: a wide, dark, medium-sized retail room. */
function storeImpulse(ctx, seconds = 1.5) {
  const n = Math.floor(ctx.sampleRate * seconds);
  const ir = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = ir.getChannelData(c);
    let lp = 0;
    // a handful of early reflections, then an exponential diffuse tail
    const early = [0.011, 0.019, 0.029, 0.041, 0.058, 0.077].map((t, i) => [Math.floor(t * ctx.sampleRate) + c * 37, 0.5 / (i + 1)]);
    for (let i = 0; i < n; i++) {
      const t = i / n;
      const white = Math.random() * 2 - 1;
      lp += (white - lp) * 0.22;                 // dark tail: a shop is soft-furnished
      d[i] = lp * Math.pow(1 - t, 2.6) * 0.5;
    }
    for (const [i, g] of early) if (i < n) d[i] += g * (c ? -1 : 1);
  }
  return ir;
}

export class RadioPlayer {
  constructor({ seed = 7, sr = RENDER_SR, queueDepth = 2 } = {}) {
    this.queueDepth = queueDepth;      // phones carry one prepared track (~25 MB less)
    this.sr = sr;
    this.library = buildLibrary({ light: true });
    this.station = new Station(this.library, { seed });
    this.ctx = null;
    this.bus = null;
    this.volume = 1;
    this.playing = false;
    this.jobs = new Map();
    this.nextJobId = 1;
    this.pending = null;       // { track, promise } render in flight
    // RENDER-AHEAD QUEUE, depth 2. One prepared track made a single skip
    // instant and a second skip wait ~6 s for the renderer — the transport
    // must answer the button, not the render pipeline. Two buffers cost
    // ~25 MB and make skip-skip instant; further skips queue against the
    // PLAYLIST (pendingSkips) and consume renders the moment they land, so
    // the current track keeps playing and there is never dead air.
    this.queue = [];           // [{ track, samples, meters }] max queueDepth
    this.pendingSkips = 0;
    this.current = null;       // { track, source, gain, startedAt, endsAt, xfadeOut }
    this.lastMeters = null;
    this.renderMsTotal = 0;
    this.rendered = 0;
    this._worker = null;
    this._timer = null;
  }

  // -- rendering ------------------------------------------------------------
  _worker_() {
    if (this._worker !== null) return this._worker;
    try {
      this._worker = new Worker(new URL('./render-worker.js', import.meta.url), { type: 'module' });
      this._worker.onmessage = (e) => {
        const job = this.jobs.get(e.data.jobId);
        if (!job) return;
        this.jobs.delete(e.data.jobId);
        if (e.data.ok) job.resolve({ samples: new Float32Array(e.data.buffer), meters: e.data.meters });
        else job.reject(new Error(e.data.error));
      };
      this._worker.onerror = () => {
        // A worker that fails to LOAD (404, CSP, import error) reports here
        // asynchronously — after jobs may already be queued. Strand those and
        // the promise chain that refills the queue never settles: the radio
        // dies silently. Reject them all so _render's fallback takes over.
        this._worker = false;
        for (const job of this.jobs.values()) job.reject(new Error('render worker failed'));
        this.jobs.clear();
      };
    } catch { this._worker = false; }
    return this._worker;
  }

  _render(track) {
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const done = (res) => {
      this.renderMsTotal += (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
      this.rendered++;
      this.lastMeters = res.meters;
      return res;
    };
    // fallback: no module workers, or the worker died. Deferred to a macrotask
    // so it never lands inside an animation frame; the store is minutes ahead
    // of itself. try/catch matters: a throw inside setTimeout otherwise
    // escapes the promise, pending never clears, and the queue deadlocks.
    const inline = () => new Promise((resolve, reject) => setTimeout(() => {
      try {
        const full = renderTrack(track, this.sr);
        const meters = masterTrack(full, this.sr);
        resolve(done({ samples: trimTail(full, this.sr), meters }));
      } catch (err) { reject(err); }
    }, 0));
    const w = this._worker_();
    if (w) {
      const jobId = this.nextJobId++;
      return new Promise((resolve, reject) => {
        this.jobs.set(jobId, { resolve, reject });
        w.postMessage({ seed: track.seed, family: track.family, sr: this.sr, jobId });
      }).then(done, () => inline());   // worker died mid-job -> render inline
    }
    return inline();
  }

  /** Begin producing the first track. Safe to call before any user gesture. */
  prime() { this._ensureQueue(); }

  _ensureQueue() {
    if (this.pending || this.queue.length >= this.queueDepth) return;
    const track = this.station.next();
    const p = this._render(track).then((res) => {
      this.pending = null;
      const item = { track, ...res };
      if (this.pendingSkips > 0 && this.ctx && this.playing) {
        // a skip was owed while the queue was dry — honour it right now
        this.pendingSkips--;
        this._begin(item, this.ctx.currentTime);
      } else {
        this.queue.push(item);
      }
      this._ensureQueue();
    }).catch(() => { this.pending = null; });
    this.pending = { track, promise: p };
  }

  // -- audio graph ----------------------------------------------------------
  attach(ctx, destination) {
    if (this.ctx) return;
    this.ctx = ctx;
    const bus = ctx.createGain();
    bus.gain.value = 0;

    // PA voicing is already baked into the rendered buffer; this stage is the
    // ROOM between the ceiling and the listener, not the speaker.
    const air = ctx.createBiquadFilter();
    air.type = 'lowpass'; air.frequency.value = 6200; air.Q.value = 0.6;

    const dry = ctx.createGain(); dry.gain.value = 0.82;
    const wet = ctx.createGain(); wet.gain.value = 0.3;
    let verb = null;
    try {
      verb = ctx.createConvolver();
      verb.buffer = storeImpulse(ctx);
    } catch { verb = null; }

    bus.connect(air);
    air.connect(dry).connect(destination);
    if (verb) { air.connect(verb).connect(wet).connect(destination); }

    this.bus = bus;
    this._nodes = { air, dry, wet, verb };
  }

  play() {
    if (!this.ctx || this.playing) return;
    this.playing = true;
    this.bus.gain.cancelScheduledValues(this.ctx.currentTime);
    this.bus.gain.setValueAtTime(this.bus.gain.value, this.ctx.currentTime);
    this.bus.gain.linearRampToValueAtTime(this.volume, this.ctx.currentTime + 2.5);
    this.prime();
    this._timer = setInterval(() => this.tick(), 250);
    this.tick();
  }

  stop() {
    if (!this.playing) return;
    this.playing = false;
    clearInterval(this._timer); this._timer = null;
    const t = this.ctx.currentTime;
    this.bus.gain.cancelScheduledValues(t);
    this.bus.gain.setValueAtTime(this.bus.gain.value, t);
    this.bus.gain.linearRampToValueAtTime(0, t + 1.2);
    const cur = this.current;
    this.current = null;
    if (cur) {
      // fade the TRACK gain too, not just the bus: play() ramps the bus back
      // up, and an off->on inside 1.4 s would otherwise resurrect the old
      // track underneath the new one until its kill timer fired
      try {
        cur.gain.gain.cancelScheduledValues(t);
        cur.gain.gain.setValueAtTime(cur.gain.gain.value, t);
        cur.gain.gain.linearRampToValueAtTime(0, t + 1.1);
      } catch { /* node may already be gone */ }
      setTimeout(() => { try { cur.source.stop(); } catch { /* already ended */ } }, 1400);
    }
  }

  /**
   * Skip to the next track. Pulls the current track's end to ~1 s out and lets
   * tick() run the exact same schedule-ahead crossfade path every normal join
   * uses — the skip is just an early ending, so it cannot introduce a new
   * transition code path. If the next track is still rendering, the current
   * one fades and the join fires the moment the render lands.
   */
  skip() {
    if (!this.playing || !this.ctx) return false;
    const now = this.ctx.currentTime;
    if (this.queue.length) {
      const c = this.current;
      if (c) { c.xfadeOut = Math.min(c.xfadeOut, 1.0); c.endsAt = Math.min(c.endsAt, now + 1.05); }
      this._begin(this.queue.shift(), now);
    } else if (this.pendingSkips < 2) {
      // the playlist advances NOW; the audio follows the moment the render
      // lands — meanwhile the current track keeps playing, never silence
      this.pendingSkips++;
      this._ensureQueue();
    }
    return true;
  }

  /**
   * Replay the previous track. The buffer was released at the join, so it is
   * re-rendered (a few seconds off-thread) and slides in through the normal
   * crossfade path; the scheduler's anti-repeat history does not apply to a
   * replay the user explicitly asked for.
   */
  previous() {
    if (!this.playing || !this.ctx || !this.lastTrack) return false;
    const t = this.lastTrack;
    this._render(t).then((res) => {
      this.queue.unshift({ track: t, ...res });
      if (this.queue.length > this.queueDepth) this.queue.pop();
      this.skip();
    }).catch(() => { /* render failed — stay on the current track */ });
    return true;
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.bus && this.playing) {
      // cancel the start-up ramp first — a linearRamp scheduled by play()
      // would otherwise override this and drag the bus to the OLD volume
      const t = this.ctx.currentTime;
      this.bus.gain.cancelScheduledValues(t);
      this.bus.gain.setValueAtTime(this.bus.gain.value, t);
      this.bus.gain.setTargetAtTime(this.volume, t, 0.12);
    }
  }

  /** Drives the queue. Cheap: it only ever looks at the clock. */
  tick() {
    if (!this.playing || !this.ctx) return;
    const now = this.ctx.currentTime;

    // Start the next track the moment it is rendered, scheduled on the AUDIO
    // clock at the exact crossfade point. The timer only has to fire once
    // anywhere before the join — important because hidden or muted tabs
    // throttle setInterval as far as once per minute, and a join driven by a
    // late tick would land late. AudioBufferSource.start(at) is sample-
    // accurate no matter what the timer thread is doing.
    const due = this.current ? this.current.endsAt - this.current.xfadeOut : now;
    if (this.queue.length && due - now < 60) this._begin(this.queue.shift(), Math.max(now, due));

    this._ensureQueue();
    if (this.current && now > this.current.endsAt + 1) this.current = null;
  }

  _begin({ track, samples, meters }, at) {
    const ctx = this.ctx;
    const buf = ctx.createBuffer(1, samples.length, this.sr);
    buf.copyToChannel(samples, 0);

    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    src.connect(g).connect(this.bus);

    const xin = this.station.crossfadeFor(track);
    const dur = samples.length / this.sr;
    const start = Math.max(at, ctx.currentTime + 0.02);

    // equal-power fade in; a linear fade of two uncorrelated tracks dips ~3 dB
    // in the middle, which reads as a hole between songs
    const N = 32;
    const curve = new Float32Array(N);
    for (let i = 0; i < N; i++) curve[i] = Math.sin((i / (N - 1)) * Math.PI / 2);
    g.gain.setValueAtTime(0, start);
    g.gain.setValueCurveAtTime(curve, start, xin);

    // fade the outgoing track down over the same window. The outgoing gain is
    // 1 by the time a scheduled-ahead join arrives (its own fade-in is long
    // over), so the curve starts from 1 — reading .value here would sample the
    // gain NOW, which for an ahead-of-time schedule is mid-fade-in.
    if (this.current) {
      const from = (ctx.currentTime - this.current.startedAt) > 8 ? 1 : Math.max(this.current.gain.gain.value, 0.001);
      const out = new Float32Array(N);
      for (let i = 0; i < N; i++) out[i] = Math.cos((i / (N - 1)) * Math.PI / 2) * from;
      try {
        this.current.gain.gain.cancelScheduledValues(start);
        this.current.gain.gain.setValueCurveAtTime(out, start, xin);
      } catch { this.current.gain.gain.setTargetAtTime(0, start, xin / 3); }
      const old = this.current.source;
      setTimeout(() => { try { old.stop(); } catch { /* ended */ } }, (start - ctx.currentTime + xin + 0.3) * 1000);
    }

    src.start(start);
    // remember what we are replacing, so PREVIOUS can bring it back
    if (this.current) this.lastTrack = this.current.track;
    const xout = this.station.crossfadeFor(track);
    this.current = { track, source: src, gain: g, startedAt: start, endsAt: start + dur, xfadeOut: xout, meters };
    this._ensureQueue();
  }

  /** For the debug HUD and the browser QA harness. */
  state() {
    const c = this.current;
    const now = this.ctx ? this.ctx.currentTime : 0;
    return {
      playing: this.playing,
      library: this.library.length,
      nowPlaying: c ? c.track.name : null,
      family: c ? c.track.familyLabel : null,
      bpm: c ? c.track.bpm : null,
      grammar: c ? c.track.grammar : null,
      groove: c ? c.track.groove : null,
      section: c ? (c.track.sections.filter(s => s.startSec <= now - c.startedAt).pop()?.name ?? null) : null,
      elapsed: c ? +(now - c.startedAt).toFixed(1) : 0,
      duration: c ? +(c.endsAt - c.startedAt).toFixed(1) : 0,
      lufs: c && c.meters ? +c.meters.lufs.toFixed(1) : null,
      peakDb: c && c.meters ? +c.meters.peakDb.toFixed(1) : null,
      readyNext: this.queue[0] ? this.queue[0].track.name : null,
      queued: this.queue.map(q => q.track.name),
      pendingSkips: this.pendingSkips,
      rendering: this.pending ? this.pending.track.name : null,
      renderedTracks: this.rendered,
      avgRenderMs: this.rendered ? Math.round(this.renderMsTotal / this.rendered) : 0,
      offThread: this._worker !== false,
      station: this.station.state(),
    };
  }
}
