// Unified input: mouse + touch + keyboard.
// One-finger drag = look. Tap/click = interact or stroll. Pinch/wheel = zoom.
// On touch, a thumb landing in the lower-left corner is a WALK STICK instead.
// While inspecting a case, drags rotate the case and pinch/wheel dollies it.
// Radians per second of camera turn from a held arrow key. Slow enough to aim
// with, fast enough to cross the store without holding it forever.
const KEY_LOOK_RATE = 1.9;

export class Input {
  constructor(canvas, { player, onTap, onHover, getMode, inspect, modes }) {
    this.canvas = canvas;
    this.player = player;
    this.onTap = onTap;
    this.onHover = onHover;
    this.getMode = getMode; // () => 'world' | 'inspect'
    this.inspect = inspect;
    this.modes = modes;

    this.pointers = new Map();
    this.dragging = false;
    // The stick is tracked OUTSIDE this.pointers on purpose. If its finger
    // were in that map, a thumb on the stick plus a finger looking around
    // would read as two pointers and trigger the pinch-zoom branch.
    this.stickId = null;
    this.stickOrigin = null;
    this.downInfo = null;
    this.pinchDist = 0;
    this.keys = new Set();

    // touch-first sensitivity in MOBILE experience mode
    const sens = () => (this.modes?.isTouchUI ? 0.0042 : 0.0028);

    canvas.style.touchAction = 'none';
    canvas.addEventListener('contextmenu', e => e.preventDefault());

    canvas.addEventListener('pointerdown', (e) => {
      try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic pointers */ }
      if (this.claimStick(e)) return;
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size === 1) {
        this.downInfo = { x: e.clientX, y: e.clientY, t: performance.now(), moved: 0 };
        this.dragging = false;
      } else if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        this.pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
        this.downInfo = null; // two fingers: never a tap
      }
    });

    canvas.addEventListener('pointermove', (e) => {
      if (e.pointerId === this.stickId) { this.moveStick(e); return; }
      const p = this.pointers.get(e.pointerId);
      if (!p) {
        this.onHover?.(e.clientX, e.clientY);
        return;
      }
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX; p.y = e.clientY;

      if (this.pointers.size === 2) {
        // pinch = zoom only; ignore average movement so pinch never rotates the view
        const [a, b] = [...this.pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const delta = (d - this.pinchDist) / 260;
        this.pinchDist = d;
        if (this.getMode() === 'inspect') this.inspect.adjustDistance(-delta * 0.4);
        else this.player.adjustZoom(delta);
        return;
      }

      if (this.downInfo) {
        this.downInfo.moved += Math.abs(dx) + Math.abs(dy);
        if (this.downInfo.moved > 7) this.dragging = true;
      }
      if (this.dragging) {
        if (this.getMode() === 'inspect') this.inspect.addRotate(dx * 0.011, dy * 0.011);
        else this.player.addLook(dx * sens(), dy * sens());
      }
    });

    const endPointer = (e) => {
      if (e.pointerId === this.stickId) { this.releaseStick(); return; }
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) this.pinchDist = 0;
      if (this.downInfo && !this.dragging && this.pointers.size === 0) {
        const dt = performance.now() - this.downInfo.t;
        if (dt < 450 && this.downInfo.moved <= 7) {
          this.onTap?.(this.downInfo.x, this.downInfo.y);
        }
      }
      if (this.pointers.size === 0) { this.dragging = false; this.downInfo = null; }
    };
    canvas.addEventListener('pointerup', endPointer);
    canvas.addEventListener('pointercancel', endPointer);

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const d = -Math.sign(e.deltaY) * 0.09;
      if (this.getMode() === 'inspect') this.inspect.adjustDistance(-d * 0.5);
      else this.player.adjustZoom(d);
    }, { passive: false });

    window.addEventListener('keydown', (e) => {
      // ESCAPE FIRST, BEFORE EVERY GUARD. Putting a held case back has to
      // work wherever focus happens to sit — an earlier version dispatched it
      // after the overlay guard below, so Escape pressed with focus inside
      // the inspect sheet could never put the case back.
      if (e.code === 'Escape') { this.onEscape?.(); return; }
      // Typing must never walk the player or swing the camera. The search box
      // is a text input inside the same document as the store. SELECT is in
      // the list because a <select> is OPERATED with the arrow keys.
      const t = e.target;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT'
        || t.isContentEditable) return;
      if (e.code.startsWith('Arrow')) {
        // AN OPEN OVERLAY OWNS THE ARROWS — decided by what is ON SCREEN, not
        // by where focus sits. The previous guard used e.target.closest(),
        // and the shelf pickers' own onchange re-renders the card, which
        // destroys the focused <select> and drops focus to <body>; from the
        // second arrow press onward the closest() test saw nothing and the
        // camera swung behind the open card. A visibility test has no such
        // hole. Only the ARROWS are ceded: WASD keeps working with a panel
        // open, exactly as it always has.
        if (this.overlayOpen()) return;
        // Arrows scroll a page by default; here they are the camera.
        e.preventDefault();
      }
      this.keys.add(e.code);
      this.syncKeys();
      if (e.code === 'Backquote') this.onDebugToggle?.();
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      this.syncKeys();
    });
    window.addEventListener('blur', () => { this.keys.clear(); this.syncKeys(); });
  }

  /**
   * Is any overlay on screen? ONE list, consulted by the keydown guard AND by
   * the per-frame look in update() — two hand-maintained copies would drift
   * exactly the way every hand-written selector list in this repo has.
   * #panel-inspect carries no .panel class, and #help was the overlay the
   * previous list forgot (arrows panned the camera behind the help screen).
   */
  overlayOpen() {
    return !!document.querySelector(
      '.panel:not(.hidden), #panel-inspect:not(.hidden), #title-card:not(.hidden), '
      + '#tutorial:not(.hidden), #receipt:not(.hidden), #help:not(.hidden)');
  }

  /**
   * Where a thumb may start a walk: the lower-left corner.
   *
   * GATED ON THE POINTER, NOT ON THE UI PREFERENCE.
   *
   * This asked `modes.isTouchUI`, which is a SETTING — Experience Mode,
   * persisted in tb_mode. Anyone whose phone was in (or was ever switched to)
   * DESKTOP mode therefore had no continuous walk control at all: the store
   * fell back to drag-to-look and tap-to-stroll, which is exactly the "all
   * looking, tap to walk, no walk controls" a phone was reported with. A
   * preference about how the UI should LOOK was silently deciding whether the
   * hardware could be used.
   *
   * A finger is a finger whatever the menu says, so the stick now answers to
   * `pointerType`. A mouse in the same corner is still a mouse and still
   * strolls; a phone forced to desktop mode can still walk.
   */
  stickZone(x, y, pointerType = null) {
    const touching = pointerType ? pointerType !== 'mouse' : !!this.modes?.isTouchUI;
    if (!touching) return false;
    if (this.getMode() !== 'world') return false;      // never over an open case
    return x < innerWidth * 0.42 && y > innerHeight * 0.52;
  }

  claimStick(e) {
    if (this.stickId !== null || !this.stickZone(e.clientX, e.clientY, e.pointerType)) return false;
    this.stickId = e.pointerId;
    this.stickOrigin = { x: e.clientX, y: e.clientY };
    const el = document.getElementById('stick');
    if (el) {
      el.style.left = `${e.clientX}px`;
      el.style.top = `${e.clientY}px`;
      el.classList.remove('hidden');
      const k = document.getElementById('stick-knob');
      if (k) k.style.transform = 'translate(0px, 0px)';
    }
    return true;
  }

  moveStick(e) {
    const o = this.stickOrigin;
    if (!o) return;
    const R = 52;                                   // full deflection, px
    let dx = e.clientX - o.x, dy = e.clientY - o.y;
    const len = Math.hypot(dx, dy);
    // Clamp the KNOB to the ring but keep the input proportional, so the stick
    // reads like a stick rather than a switch that is either off or full speed.
    const k = document.getElementById('stick-knob');
    if (k) {
      const c = len > R ? R / len : 1;
      k.style.transform = `translate(${dx * c}px, ${dy * c}px)`;
    }
    const dead = 6;                                 // ignore the thumb resting
    if (len < dead) { this.player.setMove(0, 0, false); return; }
    const mag = Math.min(1, (len - dead) / (R - dead));
    const nx = dx / len, ny = dy / len;
    // Screen y grows downward, so pushing UP the screen is forward.
    this.player.setMove(-ny * mag, nx * mag, mag > 0.92);
  }

  releaseStick() {
    this.stickId = null;
    this.stickOrigin = null;
    document.getElementById('stick')?.classList.add('hidden');
    this.player.setMove(0, 0, false);
  }

  /**
   * WASD MOVES THE BODY. ARROWS MOVE THE VIEW.
   *
   * Both used to feed setMove(), so the arrow keys walked you around and there
   * was no keyboard way to look at anything. They are separate systems and
   * they now read as separate systems:
   *
   *   W A S D   -> physical movement through the store
   *   arrows    -> camera, the same axis a drag or the mouse controls
   *   mouse     -> camera
   *
   * Arrow look is applied per FRAME rather than per keydown, in update(dt):
   * a key event fires once and then repeats at the OS repeat rate, which would
   * make turning stutter and vary by machine.
   */
  syncKeys() {
    const k = this.keys;
    const f = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0);
    const s = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
    this.player.setMove(f, s, k.has('ShiftLeft') || k.has('ShiftRight'));
    // CROUCH IS HELD, like running. C or either Ctrl drops the eye to the
    // bottom shelf; releasing stands back up. Read here so it follows the
    // same keydown/keyup bookkeeping as movement and can never stick down.
    this.player.setCrouch?.(k.has('KeyC') || k.has('ControlLeft') || k.has('ControlRight'));
  }

  /** Per-frame keyboard look. Called from the frame loop with real dt. */
  update(dt) {
    // LOOKING BELONGS TO THE WORLD. Every other look input in this file is
    // routed on getMode() — drag, pinch and wheel all hand off to the
    // inspector while a case is held. The arrows were the one path that was
    // not, so holding ArrowUp while inspecting pitched the camera off the case
    // still nominally in the shopper's hands, and there is no keyboard route
    // that rotates a held case.
    if (this.getMode() !== 'world') return;
    // ...AND THE OVERLAY CHECK MUST RUN PER FRAME, not only per keydown. An
    // arrow already held when an overlay opens is already in this.keys, every
    // later repeat returns at the keydown guard BEFORE keys.add, and nothing
    // ever removes it — so the camera kept panning behind the open card for
    // as long as the key was down.
    if (this.overlayOpen()) return;
    const k = this.keys;
    const x = (k.has('ArrowRight') ? 1 : 0) - (k.has('ArrowLeft') ? 1 : 0);
    const y = (k.has('ArrowDown') ? 1 : 0) - (k.has('ArrowUp') ? 1 : 0);
    if (!x && !y) return;
    // addLook takes SCREEN-SPACE deltas, the same units a drag produces, so
    // the invert switches in Settings apply to the arrows for free. Screen y
    // grows downward, which is why ArrowDown is positive here.
    const rate = KEY_LOOK_RATE * (dt || 0.016);
    this.player.addLook(x * rate, y * rate);
  }
}
