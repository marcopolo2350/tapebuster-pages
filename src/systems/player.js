// First-person player across two levels: click-to-stroll along pathfound
// routes, WASD, and a scripted-but-look-free escalator ride between floors.
// The escalator physically carries the player — no teleports, no cuts.
import { WORLD } from '../config.js';
import { findPathMulti, pathLength } from './pathfind.js';
import { resolveMove, pushOut, PLAYER_RADIUS } from './collide.js';
import { escalatorProfile, escalatorLength } from '../world/layout.js';

const levelY = (level) => (level ? WORLD.mezzY : 0);

export class Player {
  constructor(camera, nav, spawn) {
    this.camera = camera;
    this.nav = nav;
    this.x = spawn.x; this.z = spawn.z;
    this.level = spawn.level || 0;
    this.y = levelY(this.level);
    this.yaw = spawn.yaw; this.pitch = 0;
    this.vel = { x: 0, z: 0 };
    this.speed = 0;

    this.segments = null;       // remaining route segments
    this.walkPoints = null;     // active walk segment points
    this.pathIdx = 0;
    this.onArrive = null;
    this.ride = null;           // { esc, link, s, sEnd, dir, startX }
    this.moveInput = { f: 0, s: 0, run: false };
    this.frozen = false;

    this.baseFov = WORLD.baseFov;
    this.zoom = 0;
    this.fov = this.baseFov;

    this.bobPhase = 0;
    this.lastStepSide = 1;
    this.onStep = null;
    this.onRideChange = null;   // (ridingBool) => {} for audio
    this.lastUserLook = -10;
    this.time = 0;
    this.faceTarget = null;

    camera.rotation.order = 'YXZ';
    // Comfort defaults: reduced on touch devices, full on desktop. Settings
    // can override either independently; see applyCamera().
    const touch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    // try/catch, not a typeof guard: storage can EXIST and still throw on
    // access (Safari private browsing, disabled site data, a headless stub).
    // A preference lookup must never be able to stop the player being built.
    const num = (k, d) => {
      try {
        const v = parseFloat(localStorage.getItem(k));
        return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : d;
      } catch { return d; }
    };
    this.comfortBob = num('tb_bob', touch ? 0.35 : 1);
    this.comfortFov = num('tb_speedfov', touch ? 0 : 1);
    // +1 = measured-correct default, -1 = inverted. Read the same guarded way.
    const sign = (k) => { try { return localStorage.getItem(k) === '1' ? -1 : 1; } catch { return 1; } };
    this.invertX = sign('tb_invert_x');      // vision, horizontal
    this.invertY = sign('tb_invert_y');      // vision, vertical
    // MOVEMENT INVERSION IS A SEPARATE AXIS PAIR. Folding it into the vision
    // switches would mean a shopper who wants forward/back flipped has to
    // accept an inverted camera as well, and they are different complaints.
    this.invertMoveF = sign('tb_invert_move_f');   // forward / back
    this.invertMoveS = sign('tb_invert_move_s');   // strafe left / right
    // Crouch: 0 = standing. CROUCH_DROP puts the eye at ~0.72 m, which is
    // level with the bottom shelf row rather than merely angled at it.
    this.crouch = 0;
    this.crouchTarget = 0;
    this.applyCamera(0);
  }

  get grid() { return this.nav.grids[this.level]; }
  get isRiding() { return !!this.ride; }
  get isStrolling() { return !!(this.segments || this.walkPoints || this.ride); }
  get path() { return this.walkPoints; } // debug overlay

  setBaseFov(fov) { this.baseFov = fov; }

  /** Bend down to read the bottom row, or stand back up. */
  setCrouch(on) { this.crouchTarget = on ? WORLD.crouchDrop : 0; }
  toggleCrouch() { this.setCrouch(this.crouchTarget === 0); }
  get crouching() { return this.crouchTarget !== 0; }

  /**
   * Put the player at a known-good point, cancelling any motion.
   *
   * Needed because the building is now generated from the projection: dropping
   * from nine services to one moves the front wall ~12m inward, and whoever was
   * standing in the old entrance would be left outside the new one.
   */
  placeAt(spawn) {
    this.cancelStroll();
    this.ride = null;
    this.x = spawn.x; this.z = spawn.z;
    this.level = spawn.level || 0;
    this.y = levelY(this.level);
    if (spawn.yaw != null) this.yaw = spawn.yaw;
    this.vel.x = 0; this.vel.z = 0;
    this.speed = 0;
  }

  // ---- look ----
  //
  // DRAG RIGHT LOOKS RIGHT. DRAG UP LOOKS UP. The view follows the finger.
  //
  // Both signs are derived from this file's own convention rather than picked:
  //   faceToward() computes targetYaw = atan2(-dx, -dz), so facing +x — the
  //   player's right when facing -z — needs a NEGATIVE yaw. Looking right
  //   therefore DECREASES yaw, and a rightward drag (dx > 0) must subtract.
  //   faceToward() computes targetPitch = atan2(dy, horizontal), which is
  //   positive for a target above eye level, so positive pitch is UP. Screen
  //   dy is negative when the finger moves up, so subtracting raises the view.
  //
  // I inverted both of these on a guess in an earlier pass and made the
  // controls worse; the derivation above is why they are what they are.
  addLook(dx, dy) {
    // INVERT TOGGLES. Measured against the camera's own world matrix, the
    // defaults below are correct: swipe right looks right, swipe up looks up
    // (scripts/qa/controls.mjs asserts all four directions off the world
    // matrix, not off this file's trigonometry). But the report from the
    // device has been the opposite, repeatedly, and I would rather hand over
    // the switch than keep insisting — some people also simply prefer the
    // "drag the world" convention, where right pulls the scene right and the
    // view left. One tap either way, and it persists.
    this.yaw -= dx * this.invertX;
    this.pitch = Math.max(WORLD.pitchMin, Math.min(WORLD.pitchMax, this.pitch - dy * this.invertY));
    this.lastUserLook = this.time;
    this.faceTarget = null;
  }
  /**
   * Flip a look or movement axis. Persisted so it survives a reload.
   * Vision and movement are independent on purpose: "the camera goes the wrong
   * way" and "forward walks backwards" are different problems, and a single
   * combined switch cannot fix one without breaking the other.
   */
  setInvert({ x, y, moveF, moveS }) {
    if (x != null) this.invertX = x ? -1 : 1;
    if (y != null) this.invertY = y ? -1 : 1;
    if (moveF != null) this.invertMoveF = moveF ? -1 : 1;
    if (moveS != null) this.invertMoveS = moveS ? -1 : 1;
    // Re-apply through the SAME funnel, to whatever is held right now.
    if (moveF != null || moveS != null) {
      this.moveInput.f = (this._rawMoveF ?? 0) * this.invertMoveF;
      this.moveInput.s = (this._rawMoveS ?? 0) * this.invertMoveS;
    }
    try {
      if (x != null) localStorage.setItem('tb_invert_x', x ? '1' : '0');
      if (y != null) localStorage.setItem('tb_invert_y', y ? '1' : '0');
      if (moveF != null) localStorage.setItem('tb_invert_move_f', moveF ? '1' : '0');
      if (moveS != null) localStorage.setItem('tb_invert_move_s', moveS ? '1' : '0');
    } catch { /* still applies this session */ }
  }

  /** Live comfort update from Settings; persisted so it survives a reload. */
  setComfort({ bob, fov }) {
    if (bob != null) this.comfortBob = bob;
    if (fov != null) this.comfortFov = fov;
    try {
      if (bob != null) localStorage.setItem('tb_bob', String(bob));
      if (fov != null) localStorage.setItem('tb_speedfov', String(fov));
    } catch { /* the setting still applies this session */ }
  }
  adjustZoom(d) { this.zoom = Math.max(0, Math.min(1, this.zoom + d)); }

  faceToward(point, dur = 0.55) {
    const dx = point.x - this.x, dz = point.z - this.z;
    const dy = (point.y ?? (this.y + WORLD.eyeH)) - (this.y + WORLD.eyeH);
    const targetYaw = Math.atan2(-dx, -dz);
    const targetPitch = Math.max(WORLD.pitchMin, Math.min(WORLD.pitchMax,
      Math.atan2(dy, Math.hypot(dx, dz))));
    let fromYaw = this.yaw % (Math.PI * 2);
    let delta = targetYaw - fromYaw;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    this.faceTarget = { fromYaw, fromPitch: this.pitch, dYaw: delta, dPitch: targetPitch - this.pitch, t: 0, dur };
  }

  // ---- routing ----
  strollTo(tx, tz, { level = null, onArrive = null } = {}) {
    if (this.frozen) return false;
    const target = { x: tx, z: tz, level: level ?? this.level };
    if (this.ride) {
      // finish the ride, then continue from its exit
      const exit = { x: this.ride.link.to.x, z: this.ride.link.to.z, level: this.ride.link.toLevel };
      const segs = findPathMulti(this.nav, exit, target);
      if (!segs) return false;
      this.ride.resume = segs;
      this.onArrive = onArrive;
      return true;
    }
    const segs = findPathMulti(this.nav, { x: this.x, z: this.z, level: this.level }, target);
    if (!segs) return false;
    const flat = segs.filter(s => s.type === 'walk');
    if (segs.length === 1 && flat.length === 1 && pathLength(flat[0].points) < 0.12) {
      onArrive?.();
      return true;
    }
    this.segments = segs;
    this.onArrive = onArrive;
    this.nextSegment();
    return true;
  }

  nextSegment() {
    this.walkPoints = null;
    if (!this.segments || this.segments.length === 0) {
      this.segments = null;
      const cb = this.onArrive; this.onArrive = null;
      cb?.();
      return;
    }
    const seg = this.segments.shift();
    if (seg.type === 'walk') {
      this.walkPoints = seg.points;
      this.pathIdx = 1;
    } else {
      this.beginRide(seg.link);
    }
  }

  cancelStroll() {
    this.segments = null;
    this.walkPoints = null;
    if (this.ride) this.ride.resume = null;
    this.onArrive = null;
  }

  setMove(f, s, run) {
    // Applied HERE, at the one place every input path funnels through: the
    // thumbstick, the keyboard and anything added later all call setMove, so
    // there is exactly one place the preference can be honoured and exactly
    // one place it can be got wrong.
    // The RAW request is kept so the switch below can be re-applied to an
    // input that is already held. Baking only the signed value meant a
    // shopper holding W while flipping the movement-invert switch kept
    // walking the old way until they released the key and pressed it again.
    this._rawMoveF = f;
    this._rawMoveS = s;
    this.moveInput.f = f * this.invertMoveF;
    this.moveInput.s = s * this.invertMoveS;
    this.moveInput.run = run;
    if ((f || s) && (this.walkPoints || this.segments) && !this.ride) this.cancelStroll();
  }

  setFrozen(v) {
    this.frozen = v;
    if (v && !this.ride) { this.cancelStroll(); this.vel.x = 0; this.vel.z = 0; this.speed = 0; }
  }

  // ---- escalator ----
  beginRide(link) {
    const esc = link.escalator;
    const total = escalatorLength(esc);
    const up = link.toLevel > link.fromLevel;
    this.ride = {
      esc, link, up,
      s: up ? 0 : total,
      sEnd: up ? total : 0,
      dir: up ? 1 : -1,
      startX: this.x,
      // z and y as well as x. Only x used to be eased, so boarding ASSIGNED
      // the profile's z and the body jumped 0.163 m sideways in one frame —
      // twelve times a normal frame's travel, which is a visible snap.
      startZ: this.z,
      startY: this.y,
      t: 0,
      resume: this.segments,
    };
    this.segments = null;
    this.walkPoints = null;
    this.vel.x = 0; this.vel.z = 0;
    // FACE THE WAY THE MACHINE IS ACTUALLY CARRYING YOU.
    //
    // This was `z: this.z + (up ? -4 : 4)`, i.e. "riding up means travelling
    // toward -z" — true of the two FRONT banks and false of the rear one, which
    // climbs toward +z. Boarding the central escalator therefore spun the
    // player round to face back down it. Exactly the defect already fixed for
    // NPC riders (`r.dir > 0 ? 0 : Math.PI`); sampling the profile a little way
    // along the ride derives the heading from the ride itself, so every bank is
    // right and none of them is special-cased.
    const here = escalatorProfile(esc, this.ride.s);
    const ahead = escalatorProfile(esc, Math.max(0, Math.min(this.ride.s + this.ride.dir * 4, total)));
    this.faceToward({
      x: esc.x + (ahead.x - here.x) * 4,
      y: this.y + WORLD.eyeH + (up ? 1.2 : -1.2),
      z: this.z + (ahead.z - here.z) * 4,
    }, 0.7);
    this.onRideChange?.(true);
  }

  endRide() {
    const { link } = this.ride;
    this.level = link.toLevel;
    this.y = levelY(this.level);
    // Exact, and free: the ride has already eased onto this point over its
    // final metre (see the convergence in update()), so this assignment moves
    // the player by ~0 and the pop it used to cause is gone. It stays because
    // "the exit is exactly the validated cell" is a safety invariant, not a
    // formality — collide.test.mjs asserts pushOut() below is a no-op.
    this.x = link.to.x; this.z = link.to.z;
    const out = pushOut(this.nav.colliders[this.level], this.x, this.z);
    this.x = out.x; this.z = out.z;
    // Carry the machine's speed into the first steps so the rider walks off
    // rather than arriving at a dead stop.
    const away = Math.hypot(link.to.x - this.x, link.to.z - this.z) || 1;
    this.vel.x = ((link.to.x - this.x) / away) * WORLD.escSpeed;
    this.vel.z = ((link.to.z - this.z) / away) * WORLD.escSpeed;
    this.speed = WORLD.escSpeed;
    const resume = this.ride.resume;
    this.ride = null;
    this.onRideChange?.(false);
    if (resume) {
      this.segments = resume;
      this.nextSegment();
    }
  }

  // Walking into a comb strip boards the escalator naturally.
  //
  // Derived per escalator rather than hardcoded to one bank. The original tested
  // literal coordinates around x=-8.5, which was fine when the building had a
  // single bank — but the store now has one per side plus a third at the back of
  // the balcony, and those were unboardable on foot: you could ride them only by
  // asking the clerk to route you. zSign carries the rear bank's opposite climb.
  checkAutoBoard() {
    if (this.ride || this.frozen) return;
    if (this.speed <= 0.15) return;
    for (const link of this.nav.links) {
      if (link.fromLevel !== this.level) continue;
      const e = (this.nav.escalators || []).find(x => x.id === link.esc);
      if (!e) continue;
      const s = e.zSign ?? 1;
      if (Math.abs(this.x - e.x) > 0.58) continue;      // off this track's centreline
      // BOTH sides of the comb are bounded. The one-sided test relied on the
      // machine collider to close the far side, which is true for the front
      // banks — but mirrored by zSign on the rear bank the open side faced the
      // sales floor, so the trigger zone was a 1.16 m corridor running the
      // whole store north of the rear well: a checkout stroll leaving the
      // rear-down landing was shanghaied onto the up machine and dumped on the
      // mezzanine with its errand dead. (Found by the production feature
      // sweep; the recurring one-bank defect class, instance 18.)
      const gz = (this.z - e.lowCombZ) * s;             // ground comb offset, climb-signed
      const mz = (this.z - e.topCombZ) * s;             // top comb offset, climb-signed
      const boarding = this.level === 0
        // ground: within the comb strip, moving against the climb direction
        ? gz < 0.25 && gz > -0.9 && this.vel.z * s < -0.05
        // mezzanine: within the top strip, moving with the climb, to ride down
        : mz > -0.55 && mz < 0.9 && this.vel.z * s > 0.05;
      if (!boarding) continue;
      this.cancelStroll();
      this.beginRide(link);
      return;
    }
  }

  // ---- update ----
  /**
   * A point `dist` metres ahead of the walker ALONG THE REMAINING POLYLINE.
   *
   * Walking the route rather than interpolating a curve is what keeps this
   * collision-safe: every metre of the returned path is a metre the navigator
   * already declared legal. The walker may clip a corner slightly between two
   * nodes, which is exactly the rounding that makes a turn look human, and
   * resolveMove() is still the authority on what the body can pass through.
   */
  lookAheadPoint(dist) {
    const pts = this.walkPoints;
    if (!pts) return { x: this.x, z: this.z };
    let px = this.x, pz = this.z, remain = dist;
    for (let i = this.pathIdx; i < pts.length; i++) {
      const dx = pts[i].x - px, dz = pts[i].z - pz;
      const d = Math.hypot(dx, dz);
      if (d >= remain) return { x: px + (dx / d) * remain, z: pz + (dz / d) * remain };
      remain -= d;
      px = pts[i].x; pz = pts[i].z;
    }
    return { x: px, z: pz };          // shorter than the look-ahead: aim at the end
  }

  /** Distance still to walk, measured ALONG the route rather than as the crow
   *  flies — a straight-line estimate under-reads every corner and made the
   *  walker start braking while a turn was still between it and the door. */
  pathRemaining() {
    const pts = this.walkPoints;
    if (!pts) return 0;
    let total = 0, px = this.x, pz = this.z;
    for (let i = this.pathIdx; i < pts.length; i++) {
      total += Math.hypot(pts[i].x - px, pts[i].z - pz);
      px = pts[i].x; pz = pts[i].z;
    }
    return total;
  }

  update(dt) {
    this.time += dt;

    if (this.ride) {
      const r = this.ride;
      r.t += dt;
      r.s += r.dir * WORLD.escSpeed * dt;
      const done = r.dir > 0 ? r.s >= r.sEnd : r.s <= r.sEnd;
      const p = escalatorProfile(r.esc, Math.max(0, Math.min(r.s, escalatorLength(r.esc))));
      // ease onto the centerline during the first moments of the ride
      // Smoothstep rather than linear: a linear blend starts and stops with a
      // velocity discontinuity of its own, which is the same defect one level
      // down. This eases in and out of the correction.
      const b = Math.min(1, r.t / 0.45);
      const blend = b * b * (3 - 2 * b);
      let px = r.startX + (p.x - r.startX) * blend;
      let pz = r.startZ + (p.z - r.startZ) * blend;
      this.y = r.startY + (p.y - r.startY) * blend;

      // CONVERGE ON THE EXIT INSTEAD OF JUMPING TO IT.
      //
      // The profile's top sits 0.10-0.15 m from the link's exit cell, and
      // endRide() used to close that gap by assignment — a 0.107 m step in one
      // frame, eight times a rider's normal frame, which is the pop at the top.
      // Simply not closing it is not an option either: collide.test.mjs asserts
      // the ride ends EXACTLY on link.to so that pushOut() is a no-op and
      // nobody is ever set down a hand's width inside a shelf. That invariant
      // is worth keeping.
      //
      // So the gap is walked, not jumped: over the final metre the position
      // eases from the step band onto the exit cell, and by the time the ride
      // ends the two are the same point. The assignment in endRide() then
      // changes nothing, which is exactly what that test is checking.
      const remain = Math.abs(r.sEnd - r.s);
      const OUT = 1.0;
      if (remain < OUT) {
        const k = 1 - remain / OUT;
        const e = k * k * (3 - 2 * k);
        px += (r.link.to.x - px) * e;
        pz += (r.link.to.z - pz) * e;
      }
      this.x = px;
      this.z = pz;
      this.speed = WORLD.escSpeed;
      if (done) this.endRide();
      this.updateFaceTween(dt);
      this.applyCamera(dt, true);
      return;
    }

    let desired = { x: 0, z: 0 };
    let maxSpeed = this.moveInput.run ? WORLD.runSpeed : WORLD.walkSpeed;

    if (!this.frozen && this.walkPoints) {
      // ------------------------------------------------ LOOK-AHEAD STEERING
      //
      // This used to steer straight AT pts[pathIdx] and swap to the next node
      // once inside 0.28 m. The velocity model underneath was already smooth,
      // but the TARGET was not: at every corner the desired direction changed
      // discontinuously, so the walker braked into the node, turned, and
      // accelerated out of it. Over a long route that reads as
      // step -> turn -> step -> turn, and it is what was making people sick.
      //
      // Now the steering target is a point a short distance AHEAD ALONG THE
      // SAME POLYLINE. As the walker nears a corner that point slides around
      // it continuously, so the heading eases through the turn and speed on
      // the straights stays constant.
      //
      // COLLISION SAFETY IS UNCHANGED, and this is the reason to steer along
      // the route rather than spline it: the look-ahead point is always ON the
      // legal path the navigator produced, never a curve invented through
      // whatever happens to be between two nodes. resolveMove() still runs on
      // every step, so the body can no more walk through a shelf than before.
      const pts = this.walkPoints;
      const last = pts[pts.length - 1];
      const wp = pts[this.pathIdx] || last;
      const isFinal = this.pathIdx >= pts.length - 1;
      const dWp = Math.hypot(wp.x - this.x, wp.z - this.z);

      // Advance past a node on proximity OR on having gone by it. The second
      // test matters now: a smoothed corner is cut slightly, so the walker may
      // never pass within the old radius of the node and would steer at a
      // waypoint behind itself forever.
      if (!isFinal) {
        const prev = pts[this.pathIdx - 1];
        let passed = false;
        if (prev) {
          const sx = wp.x - prev.x, sz = wp.z - prev.z;
          passed = ((this.x - wp.x) * sx + (this.z - wp.z) * sz) >= 0;
        }
        if (dWp < 0.28 || passed) this.pathIdx++;
      } else if (dWp < 0.09) {
        this.walkPoints = null;
        this.nextSegment();
      }

      if (this.walkPoints) {
        const remaining = this.pathRemaining();
        // Look further ahead the faster we are going — a fixed distance is
        // twitchy at walking pace and sluggish at a run.
        const L = Math.max(0.55, Math.min(1.5, 0.5 + this.speed * 0.55));
        const aim = this.lookAheadPoint(L);
        let dx = aim.x - this.x, dz = aim.z - this.z;
        let d = Math.hypot(dx, dz) || 1;
        // keep pace if a ride (or more walking) follows this segment
        const more = this.segments && this.segments.length > 0;
        const arriveSpeed = more ? WORLD.walkSpeed
          : Math.min(WORLD.walkSpeed, Math.sqrt(2 * WORLD.decel * Math.max(remaining - 0.05, 0)) + 0.18);
        maxSpeed = arriveSpeed;
        desired.x = (dx / d) * maxSpeed;
        desired.z = (dz / d) * maxSpeed;
      }
    } else if (!this.frozen && (this.moveInput.f || this.moveInput.s)) {
      const sinY = Math.sin(this.yaw), cosY = Math.cos(this.yaw);
      const fx = -sinY, fz = -cosY;
      const rx = cosY, rz = -sinY;
      let mx = fx * this.moveInput.f + rx * this.moveInput.s;
      let mz = fz * this.moveInput.f + rz * this.moveInput.s;
      const ml = Math.hypot(mx, mz) || 1;
      // ANALOG. Dividing by the input length normalises every input to full
      // speed, which is right for a key (held or not) and wrong for a thumb
      // stick, where a small push has to mean a slow walk. Clamping at 1 keeps
      // the keyboard exactly as it was — a diagonal is length 1.41 and still
      // saturates — while a half-deflected stick now gives half speed.
      const analog = Math.min(1, ml);
      desired.x = (mx / ml) * maxSpeed * analog;
      desired.z = (mz / ml) * maxSpeed * analog;
    }

    const ax = desired.x - this.vel.x, az = desired.z - this.vel.z;
    const al = Math.hypot(ax, az);
    const accel = (desired.x || desired.z) ? WORLD.accel : WORLD.decel;
    if (al > 0.0001) {
      const step = Math.min(al, accel * dt);
      this.vel.x += (ax / al) * step;
      this.vel.z += (az / al) * step;
    }
    this.speed = Math.hypot(this.vel.x, this.vel.z);
    if (this.speed < 0.01 && !desired.x && !desired.z) { this.vel.x = 0; this.vel.z = 0; this.speed = 0; }

    if (this.speed > 0) {
      // analytic world collision: flush stops, natural sliding, substepped
      const colliders = this.nav.colliders[this.level];
      const intendedX = this.vel.x * dt, intendedZ = this.vel.z * dt;
      const res = resolveMove(colliders, this.x, this.z, intendedX, intendedZ, PLAYER_RADIUS);
      const gotX = res.x - this.x, gotZ = res.z - this.z;
      this.x = res.x; this.z = res.z;
      // bleed off velocity pressed into a surface
      if (Math.abs(intendedX) > 1e-6 && Math.abs(gotX) < Math.abs(intendedX) * 0.2) this.vel.x *= 0.1;
      if (Math.abs(intendedZ) > 1e-6 && Math.abs(gotZ) < Math.abs(intendedZ) * 0.2) this.vel.z *= 0.1;
    }
    this.y = levelY(this.level);

    this.checkAutoBoard();

    if (this.walkPoints && this.speed > 0.3 && this.time - this.lastUserLook > 1.4 && !this.faceTarget) {
      const travelYaw = Math.atan2(-this.vel.x, -this.vel.z);
      let delta = travelYaw - this.yaw;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      this.yaw += delta * Math.min(1, WORLD.turnRate * 0.55 * dt);
      this.pitch += (0 - this.pitch) * Math.min(1, 0.8 * dt);
    }

    this.updateFaceTween(dt);
    this.applyCamera(dt);
  }

  updateFaceTween(dt) {
    if (!this.faceTarget) return;
    const ft = this.faceTarget;
    ft.t += dt;
    const k = Math.min(ft.t / ft.dur, 1);
    const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
    this.yaw = ft.fromYaw + ft.dYaw * e;
    this.pitch = ft.fromPitch + ft.dPitch * e;
    if (k >= 1) this.faceTarget = null;
  }

  applyCamera(dt, riding = false) {
    const speedRatio = riding ? 0 : Math.min(this.speed / WORLD.walkSpeed, 1.3);
    if (!riding && this.speed > 0.12) {
      const prev = this.bobPhase;
      this.bobPhase += this.speed * dt * WORLD.bobFreq;
      if (Math.floor(prev / Math.PI) !== Math.floor(this.bobPhase / Math.PI)) {
        this.lastStepSide *= -1;
        this.onStep?.(Math.min(speedRatio, 1), this.lastStepSide);
      }
    } else {
      this.bobPhase *= 0.9;
    }
    // COMFORT. Head bob and speed-driven FOV are the two things in this
    // function that make people motion-sick: bob moves the horizon on a cycle
    // the body did not initiate, and a FOV that widens as you speed up is
    // textbook vection. Neither is load-bearing for anything, so both are
    // scalable and both default to reduced on a phone, where the screen is
    // close to the face and there is no peripheral reference to anchor to.
    const bobK = this.comfortBob;
    const bob = Math.sin(this.bobPhase * 2) * WORLD.bobAmp * speedRatio * bobK;
    const sway = Math.sin(this.bobPhase) * WORLD.bobAmp * 0.35 * speedRatio * bobK;

    // CROUCH. The bottom shelf sits near the floor and there was no way to get
    // your eyes down to it — you could look down, but from 1.62 m a bottom row
    // is still edge-on. `crouch` eases toward its target rather than snapping,
    // so it reads as bending down instead of teleporting, and it is applied
    // HERE, at the single place camera height is decided, so bob, sway and the
    // escalator ride all keep working unchanged.
    this.crouch += (this.crouchTarget - this.crouch) * Math.min(1, 10 * dt);
    this.camera.position.set(
      this.x + Math.cos(this.yaw) * sway,
      this.y + WORLD.eyeH - this.crouch + bob,
      this.z - Math.sin(this.yaw) * sway
    );
    this.camera.rotation.y = this.yaw;
    this.camera.rotation.x = this.pitch;

    const zoomFov = this.baseFov - (this.baseFov - WORLD.minFov) * this.zoom;
    const target = Math.min(WORLD.maxFov, zoomFov + speedRatio * 2.2 * this.comfortFov);
    this.fov += (target - this.fov) * Math.min(1, 8 * (dt || 0.016));
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }
}
