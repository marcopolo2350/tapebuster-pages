// Experience Mode: AUTO / MOBILE / DESKTOP. Auto detects the device; the user
// can always override in Settings. Persisted, applied live.
export class ModeManager {
  constructor() {
    this.mode = localStorage.getItem('tb_mode') || 'auto';
    if (!['auto', 'mobile', 'desktop'].includes(this.mode)) this.mode = 'auto';
    this.listeners = new Set();
    addEventListener('resize', () => this.apply());
    this.apply();
  }

  detect() {
    const coarse = matchMedia('(pointer: coarse)').matches;
    const narrow = Math.min(innerWidth, innerHeight) < 860 || innerWidth < 720;
    return (coarse && narrow) || innerWidth < 720 ? 'mobile' : 'desktop';
  }

  get effective() {
    return this.mode === 'auto' ? this.detect() : this.mode;
  }
  get isTouchUI() { return this.effective === 'mobile'; }

  set(mode) {
    this.mode = mode;
    localStorage.setItem('tb_mode', mode);
    this.apply();
  }

  apply() {
    const eff = this.effective;
    document.body.classList.toggle('ui-mobile', eff === 'mobile');
    document.body.classList.toggle('ui-desktop', eff === 'desktop');
    for (const fn of this.listeners) fn(eff, this.mode);
  }

  onChange(fn) { this.listeners.add(fn); }
}
