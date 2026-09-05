// Minimal tween runner — enough for case pickup/putback and camera eases.
const active = new Set();

export function tween({ from = 0, to = 1, duration = 0.5, ease = easeInOutCubic, onUpdate, onDone }) {
  const tw = { t: 0, from, to, duration, ease, onUpdate, onDone, cancelled: false };
  active.add(tw);
  return tw;
}

export function cancelTween(tw) {
  if (tw) { tw.cancelled = true; active.delete(tw); }
}

export function updateTweens(dt) {
  for (const tw of [...active]) {
    if (tw.cancelled) continue;
    tw.t += dt;
    const k = Math.min(tw.t / tw.duration, 1);
    const v = tw.from + (tw.to - tw.from) * tw.ease(k);
    tw.onUpdate?.(v, k);
    if (k >= 1) {
      active.delete(tw);
      tw.onDone?.();
    }
  }
}

export function easeInOutCubic(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
export function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
export function easeOutBack(t) {
  const c1 = 1.20158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}
