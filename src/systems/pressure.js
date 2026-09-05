// FRAME GOVERNOR — the thing that makes the app slow down instead of dying.
//
// Every bound in this codebase before now was a bound on a QUANTITY: bytes of
// texture, posters in flight, commits per frame. None of them was a bound on
// what the DEVICE was actually coping with, so under real pressure the app
// kept pushing exactly as much work as its static budgets allowed, right up
// until Safari killed the tab.
//
// The priority order this enforces, in the order the directive states it:
//
//   1. the application stays responsive
//   2. the render loop stays healthy
//   3. player movement stays responsive
//   4. store geometry stays stable
//   5. cover hydration
//   6. visual quality upgrades
//
// Cover hydration is item 5. When frames degrade it is the first thing cut,
// and it is cut to ZERO rather than merely trimmed — a late poster is a
// non-event, a 500 ms frame is not.
//
// WHAT THIS IS NOT: a cache. Nothing here retains anything. It observes frame
// times and answers one question — how much secondary work may run right now.

const OK = 'ok', STRAINED = 'strained', CRITICAL = 'critical';

export class FrameGovernor {
  /**
   * @param {object} o
   * @param {boolean} o.mobile
   * @param {number} [o.targetMs] frame budget to aim for (16.7 = 60fps)
   */
  constructor({ mobile = false, targetMs = 16.7 } = {}) {
    this.mobile = mobile;
    this.targetMs = targetMs;
    // Secondary-work budget when everything is healthy. Deliberately small on
    // a phone: this is time spent NOT rendering, inside a frame we already
    // want to finish in 16.7 ms.
    this.baseBudgetMs = mobile ? 2 : 4;

    this.ema = targetMs;          // smoothed frame time
    this.worst = 0;               // worst frame in the current window
    this.lastMs = targetMs;
    this.frames = 0;
    this._level = OK;
    // Hysteresis: recovering takes sustained good frames, so one lucky frame
    // cannot re-open the taps and re-trigger the stall we just escaped.
    this._goodRun = 0;
    this._sinceLevelChange = 0;
    this._worstEver = 0;
    this._criticalFrames = 0;
    this._strainedFrames = 0;
  }

  /** Feed one measured frame time. Call once per rendered frame. */
  sample(ms) {
    if (!(ms >= 0) || ms > 5000) return this._level;   // tab-switch gaps are not pressure
    this.frames++;
    this.lastMs = ms;
    if (ms > this.worst) this.worst = ms;
    if (ms > this._worstEver) this._worstEver = ms;
    // Asymmetric smoothing: react fast to a spike, recover slowly. A single
    // 300 ms frame IS the signal we care about; averaging it away is how a
    // stall becomes invisible to its own governor.
    const a = ms > this.ema ? 0.5 : 0.06;
    this.ema += (ms - this.ema) * a;

    const t = this.targetMs;
    let next = this._level;
    if (this.ema > t * 3 || ms > 250) next = CRITICAL;
    else if (this.ema > t * 1.8 || ms > 120) next = STRAINED;
    else this._goodRun++;

    if (next !== this._level && next !== OK) {
      this._level = next; this._goodRun = 0; this._sinceLevelChange = 0;
    } else if (this._level !== OK) {
      this._sinceLevelChange++;
      // 45 consecutive healthy frames (~0.75 s) before easing back one step.
      if (this._goodRun >= 45) {
        this._level = this._level === CRITICAL ? STRAINED : OK;
        this._goodRun = 0;
      }
    }
    if (this._level === CRITICAL) this._criticalFrames++;
    else if (this._level === STRAINED) this._strainedFrames++;
    return this._level;
  }

  level() { return this._level; }
  underPressure() { return this._level !== OK; }

  /**
   * Milliseconds of SECONDARY work permitted this frame.
   * Zero means "do nothing but render" — the caller must honour it by not
   * starting the work at all, not by starting it and stopping early.
   */
  budgetMs() {
    if (this._level === CRITICAL) return 0;
    if (this._level === STRAINED) return Math.min(1, this.baseBudgetMs);
    return this.baseBudgetMs;
  }

  /** Reset the rolling worst — call after reading it into telemetry. */
  takeWorst() { const w = this.worst; this.worst = 0; return w; }

  stats() {
    return {
      level: this._level,
      emaMs: +this.ema.toFixed(1),
      lastMs: +this.lastMs.toFixed(1),
      worstEverMs: +this._worstEver.toFixed(1),
      frames: this.frames,
      criticalFrames: this._criticalFrames,
      strainedFrames: this._strainedFrames,
      budgetMs: this.budgetMs(),
    };
  }
}

/**
 * A cooperative work pump for LOADING-TIME work (shelf dressing).
 *
 * requestAnimationFrame is NOT a workload budget: a callback that does 500 ms
 * of work is still a 500 ms freeze, and that is exactly what the pre-entry
 * dressing loop was. This runs a caller-supplied step function repeatedly
 * until a hard per-tick CPU budget is spent, then yields to the browser so it
 * can render, take input, run timers and collect garbage before the next tick.
 *
 * @param {object} o
 * @param {() => boolean} o.step   one unit of work; return false when finished
 * @param {number} o.budgetMs      hard CPU cap per tick
 * @param {number} o.deadlineMs    absolute wall-clock stop (never block entry)
 * @param {(ms:number)=>void} [o.onTick] observed cost of each tick
 * @returns {Promise<{ticks:number, worstTickMs:number, finished:boolean}>}
 */
export function cooperativePump({ step, budgetMs, deadlineMs, onTick, yieldMs = 0 }) {
  return new Promise((resolve) => {
    let ticks = 0, worstTickMs = 0, finished = false, stopped = false;
    const stop = (done) => { finished = done; stopped = true; resolve({ ticks, worstTickMs, finished }); };
    const tick = () => {
      if (stopped) return;
      if (performance.now() >= deadlineMs) return stop(false);
      const t0 = performance.now();
      ticks++;
      let more = true;
      // THE BUDGET IS CHECKED BETWEEN STEPS, and a step is sized so that one
      // of them cannot blow the budget on its own. That is the difference
      // between a budget and a hope.
      do {
        more = step();
        if (!more) break;
      } while (performance.now() - t0 < budgetMs);
      const cost = performance.now() - t0;
      if (cost > worstTickMs) worstTickMs = cost;
      onTick?.(cost);
      if (!more) return stop(true);
      // YIELD. setTimeout(0) rather than rAF: rAF is throttled to the display
      // and, on a backgrounded or struggling tab, can stop firing entirely —
      // which would strand the loading screen forever. This is preparation
      // work, not animation, so it should not be paced by the compositor.
      setTimeout(tick, yieldMs);
    };
    tick();
  });
}
