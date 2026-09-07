// Interaction router: raycasts taps/clicks and the center-of-view "look-at",
// then routes to stroll / ride / inspect / clerk / UI — across both levels.
import * as THREE from 'three';
import { WORLD } from '../config.js';
import { facingOf } from '../world/layout.js';
import { nearestOpen } from './pathfind.js';

// ---------------------------------------------------------------------------
// Click-routing geometry, derived from the layout — NEVER transcribed.
//
// Three instances of the recurring one-bank/literal-coordinate defect lived in
// this file: the checkout and return-bin cases walked the player to the
// hand-authored CORE positions (z 5.9-8.5) while planProps moves both props
// with the front wall (z 71.5 / 73.35 in the shipped store — clicking the
// counter marched the shopper 64 m into the aisles and bowed them at a
// gondola), the escalator case boarded links.find(...) — always the front-WEST
// bank — whichever of the six machines was clicked, and isEscalatorHit was a
// literal box around the west well, so the east and rear machines' cladding
// was not ride-clickable at all. Exported as pure functions so the tests can
// drive them with the real layout, and break-tests can prove they notice.
// ---------------------------------------------------------------------------

/** The escalator whose machine footprint contains the click, or null. */
// How long the crosshair result may be reused while the camera is perfectly
// still. Long enough to remove the idle cost, short enough that a case being
// picked up or a restock still surfaces promptly.
const LOOKAT_STALE_S = 1.0;

export function escalatorAtPoint(layout, p) {
  if (p.y < 0.1 || p.y > WORLD.mezzY + 1.6) return null;
  for (const e of layout.escalators) {
    const zLo = Math.min(e.boardZ, e.exitZ) - 0.4;
    const zHi = Math.max(e.boardZ, e.exitZ) + 0.4;
    if (Math.abs(p.x - e.x) < 1.05 && p.z > zLo && p.z < zHi) return e;
  }
  return null;
}

/** The boarding link for a click at `p`: the clicked machine's own bank. */
export function linkForEscalatorClick(nav, level, p) {
  const mine = nav.links.filter(l => l.fromLevel === level);
  let best = null, bestD = Infinity;
  for (const l of mine) {
    const e = l.escalator;
    const zLo = Math.min(e.boardZ, e.exitZ), zHi = Math.max(e.boardZ, e.exitZ);
    const d = Math.hypot(p.x - e.x, p.z - Math.max(zLo, Math.min(zHi, p.z)));
    if (d < bestD) { bestD = d; best = l; }
  }
  return best;
}

/**
 * Where a shopper stands to use a front-wall prop (counter, return bin): just
 * inside it, on the sales-floor side. The props sit against the front wall at
 * +z, so the approach is always from -z, whatever depth the wall ended up at.
 */
export function approachForProp(layout, kind, gap) {
  const prop = layout.props.find(p => p.kind === kind);
  if (!prop) return null;
  return { prop, x: prop.x, z: prop.z - (prop.d ?? 0.7) / 2 - gap };
}

export class Interactions {
  constructor({ camera, player, nav, layout, caseSystem, inspector, ui, audio, raycastTargets, byId }) {
    Object.assign(this, { camera, player, nav, layout, caseSystem, inspector, ui, audio, raycastTargets, byId });
    this.ray = new THREE.Raycaster();
    this.ray.far = 60;
    this.ndc = new THREE.Vector2();
    this.lookAtTimer = 0;
    this.currentLook = null;
    this.highlight = null;
    this.highlightT = 0;
  }

  screenRay(x, y) {
    this.camera.updateMatrixWorld();
    this.ndc.set((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1);
    this.ray.setFromCamera(this.ndc, this.camera);
    return this.ray;
  }

  allTargets() {
    return [...this.caseSystem.meshes, ...this.raycastTargets];
  }

  standPointForSlot(slot) {
    // spine-out stock faces the shopper along the FIXTURE normal, which is
    // rotated 90° from the case's own rotY
    const dir = facingOf(slot.spineOut ? slot.rotY - Math.PI / 2 : slot.rotY);
    let p = { x: slot.x + dir.x * WORLD.standOff, z: slot.z + dir.z * WORLD.standOff };
    if (slot.lay) p = { x: slot.x, z: slot.z + 0.7 };
    return nearestOpen(this.nav.grids[slot.level], p.x, p.z, 1.6) || p;
  }

  // horizontal distance, but only meaningful on the same level
  reachable(slot) {
    return slot.level === this.player.level &&
      Math.hypot(this.player.x - slot.x, this.player.z - slot.z) <= WORLD.reachDist;
  }

  onTap(x, y) {
    if (this.inspector.active) {
      this.screenRay(x, y);
      if (this.inspector.hitTest(this.ray)) this.inspector.flip();
      else this.ui.requestPutBack();
      return;
    }

    this.screenRay(x, y);
    const hits = this.ray.intersectObjects(this.allTargets(), true);
    if (!hits.length) return;
    const hit = hits[0];
    let obj = hit.object;
    while (obj && !Object.keys(obj.userData).length && obj.parent) obj = obj.parent;

    // 1) a case on a shelf
    if (obj.userData.isCaseBatch) {
      const slotId = this.caseSystem.slotFromIntersect(hit);
      const slot = this.layout.slotById.get(slotId);
      if (!slot || this.caseSystem.isHidden(slotId)) return;
      this.reachOrStroll(slot, this.byId.get(slot.titleId));
      return;
    }

    // 2) checkout counter → clerk. The counter tracks the front wall, so its
    // position is read off the layout — the old literal (8.8, 5.9) was the
    // hand-authored CORE spot, 64 m from where the counter actually stands.
    if (obj.userData.checkout) {
      const at = approachForProp(this.layout, 'counter', 1.1);
      if (!at) return;
      const sp = nearestOpen(this.nav.grids[0], at.x, at.z, 2.0) ?? at;
      const face = { x: at.prop.x, y: 1.3, z: at.prop.z };
      if (this.player.level === 0 && Math.hypot(this.player.x - at.x, this.player.z - at.z) < 2.6) this.ui.openClerk();
      else this.player.strollTo(sp.x, sp.z, {
        level: 0,
        onArrive: () => { this.player.faceToward(face); this.ui.openClerk(); },
      });
      return;
    }

    // 3) return bin — same rule, same reason
    if (obj.userData.returnBin) {
      const at = approachForProp(this.layout, 'returnbin', 1.0);
      if (!at) return;
      const sp = nearestOpen(this.nav.grids[0], at.x, at.z, 1.6) ?? at;
      const go = () => this.ui.offerReturn();
      const face = { x: at.prop.x, y: 0.9, z: at.prop.z };
      if (this.player.level === 0 && Math.hypot(this.player.x - at.x, this.player.z - at.z) < 2.2) go();
      else this.player.strollTo(sp.x, sp.z, { level: 0, onArrive: () => { this.player.faceToward(face); go(); } });
      return;
    }

    // 4) posters / standees with a linked title
    if (obj.userData.titleId) {
      const t = this.byId.get(obj.userData.titleId);
      if (t) this.ui.showTitleCard(t, 'poster');
      return;
    }

    // 5) hanging signs → walk to that section
    if (obj.userData.signFor) {
      const zone = this.layout.zones.find(z => z.label === obj.userData.signFor && z.level === (obj.userData.signLevel || 0));
      if (zone) {
        const sp = nearestOpen(this.nav.grids[zone.level], zone.x, zone.z, 2.0);
        if (sp) this.player.strollTo(sp.x, sp.z, { level: zone.level });
      }
      return;
    }

    // 6) escalator → ride it. The link is the CLICKED machine's own bank —
    // find() returned the first same-level link, which is always front-west, so
    // clicking the east or rear machines marched the shopper across the store to
    // the wrong bank. Same first-match defect pathfind.js already documents.
    //
    // ROUTE TO THE EXIT, NOT TO THE BOARDING PAD.
    //
    // This used to stroll to link.from on the CURRENT level and rely on
    // Player.checkAutoBoard() to notice the shopper and board them. It never
    // did, and that is why the escalators did nothing on PC and phone alike.
    // Measured by scripts/qa/escalator.mjs against the real Player and nav:
    //
    //   clicked esc-up-w   -> walked to (-8.90, 3.01), stopped at speed 0.173
    //   clicked esc-down-w -> walked to (-7.68, -6.95), stopped at speed 0.171
    //
    // checkAutoBoard() requires speed > 0.15 AND the body inside the comb strip
    // (-0.9 < gz < 0.25). An ARRIVING stroll decelerates to ~0.17 and stops
    // about a metre short of the comb — 3.01 against a comb at 1.25 — so both
    // conditions fail together and the shopper is left standing on the pad.
    //
    // Strolling to the machine's EXIT on the FAR level instead makes this a
    // genuine multi-level route, so findPathMulti plans walk -> RIDE -> walk and
    // Player.nextSegment() calls beginRide() explicitly. That is the same path
    // "Take Me There" already uses to send you upstairs, which is proven
    // working, and it needs no change to the movement model: the machine still
    // physically carries the player, with no teleport.
    if (obj.userData.escalator !== undefined || this.isEscalatorHit(hit)) {
      const goingUp = this.player.level === 0;
      const link = linkForEscalatorClick(this.nav, this.player.level, hit.point);
      if (!link) return;
      // THE TOAST FOLLOWS THE ROUTE, IT DOES NOT PROMISE IT.
      //
      // strollTo returns false when the player is frozen or when findPathMulti
      // finds no route, and its result used to be discarded while the toast
      // fired unconditionally above it. That is why this defect survived
      // play-testing for so long: tapping a machine said "Riding up to
      // TV & SERIES…" and felt acknowledged, while the shopper never left the
      // ground floor. The UI must not claim a ride the router refused.
      if (this.player.strollTo(link.to.x, link.to.z, { level: link.toLevel })) {
        this.ui.toast(goingUp ? 'Riding up to TV & SERIES…' : 'Heading back down to MOVIES…', 2000);
      }
      return;
    }

    // 7) floor / anything else → stroll toward the point (level-aware)
    const px = hit.point.x, pz = hit.point.z;
    const targetLevel = obj.userData.level ?? (hit.point.y > WORLD.mezzY - 0.5 ? 1 : 0);
    const sp = nearestOpen(this.nav.grids[targetLevel], px, pz, 2.4);
    if (sp) {
      this.audio?.uiBlip(0.4);
      this.player.strollTo(sp.x, sp.z, { level: targetLevel });
    }
  }

  isEscalatorHit(hit) {
    // clicking anywhere on ANY machine's structure counts as intent to ride —
    // the old literal box wrapped the front-west well alone, so the east and
    // rear machines' cladding clicks fell through to "walk to the point"
    return escalatorAtPoint(this.layout, hit.point) !== null;
  }

  onHover(x, y) {
    const now = performance.now();
    if (now - (this._lastHover || 0) < 30) return;
    this._lastHover = now;
    if (this.inspector.active) { document.body.style.cursor = 'grab'; return; }
    this.screenRay(x, y);
    const hits = this.ray.intersectObjects(this.allTargets(), true);
    const h = hits[0];
    const interactive = h && (h.object.userData.isCaseBatch || h.object.userData.checkout ||
      h.object.userData.returnBin || h.object.userData.titleId || h.object.userData.signFor);
    document.body.style.cursor = interactive ? 'pointer' : 'default';
  }

  // Take Me There resolves to the ONE primary location (the title's home
  // shelf). Only if that copy is checked out do we fall back to the nearest
  // other stocked face-out copy.
  /**
   * Pick this case up, walking to it first if it is out of arm's reach.
   *
   * Lifted verbatim out of onTap so the browse arrows and a tap on the case
   * itself cannot drift apart. Reaching past the shelf you are standing at,
   * the stroll, the turn to face it and the 380 ms settle before the case
   * lifts are one behaviour with one definition; a second copy of these rules
   * for the arrows would be a second thing to get wrong.
   *
   * @returns {boolean} false when there is no floor route to the case.
   */
  reachOrStroll(slot, title) {
    if (!slot || !title) return false;
    if (this.reachable(slot)) { this.inspector.open(slot, title); return true; }
    const sp = this.standPointForSlot(slot);
    if (!sp) return false;
    this.ui.toastWalk(title.title, slot.level !== this.player.level);
    return this.player.strollTo(sp.x, sp.z, {
      level: slot.level,
      onArrive: () => {
        this.player.faceToward({ x: slot.x, y: slot.y, z: slot.z });
        setTimeout(() => {
          if (!this.inspector.active && !this.caseSystem.isHidden(slot.id)) {
            this.inspector.open(slot, title);
          }
        }, 380);
      },
    });
  }

  /**
   * The shelf copy the browse arrows would pick up, or null if the store has
   * none on display right now — every copy in the shopper's own stack, say.
   *
   * SEPARATE FROM openTitle ON PURPOSE. The arrows need to know whether a
   * title can be reached BEFORE committing to it, because a title with no
   * copy on the shelf should be stepped over rather than tried and silently
   * dropped. Answering that question is not the same act as performing it,
   * and folding them together is how "next" would start doing nothing.
   */
  shelfCopySlot(titleId) {
    const slot = this.bestCopySlot(titleId);
    return slot && !this.caseSystem.isHidden(slot.id) ? slot : null;
  }

  /** Pick up a title by id — the physical half of the browse arrows. */
  openTitle(titleId) {
    const slot = this.shelfCopySlot(titleId);
    if (!slot) return false;
    return this.reachOrStroll(slot, this.byId.get(titleId)) !== false;
  }

  bestCopySlot(titleId) {
    const rec = this.layout.titles.get(titleId);
    if (!rec) return null;
    const primary = this.layout.slotById.get(rec.primarySlotId);
    if (primary && !this.caseSystem.isHidden(primary.id)) return primary;
    let best = primary, bestScore = Infinity;
    for (const id of rec.slotIds) {
      const s = this.layout.slotById.get(id);
      if (this.caseSystem.isHidden(id) || s.lay || s.spineOut) continue;
      const d = Math.hypot(this.player.x - s.x, this.player.z - s.z)
        + (s.level !== this.player.level ? 60 : 0);
      if (d < bestScore) { bestScore = d; best = s; }
    }
    return best;
  }

  // Take Me There — cross-level navigation to the nearest stocked copy.
  goToTitle(titleId) {
    const rec = this.layout.titles.get(titleId);
    if (!rec) return false;
    const slot = this.bestCopySlot(titleId);
    const sp = this.standPointForSlot(slot);
    if (!sp) return false;
    const t = this.byId.get(titleId);
    this.ui.toastWalk(t ? t.title : 'the shelf', slot.level !== this.player.level);
    return this.player.strollTo(sp.x, sp.z, {
      level: slot.level,
      onArrive: () => {
        this.player.faceToward({ x: slot.x, y: slot.y, z: slot.z });
        this.flashSlot(slot);
      },
    });
  }

  flashSlot(slot) {
    this.clearHighlight();
    const geo = new THREE.PlaneGeometry(WORLD.caseW + 0.05, WORLD.caseH + 0.05);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffd23d, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false });
    const m = new THREE.Mesh(geo, mat);
    const dir = facingOf(slot.rotY);
    m.position.set(slot.x + dir.x * 0.024, slot.y, slot.z + dir.z * 0.024);
    m.rotation.y = slot.rotY;
    this.camera.parent?.add(m);
    this.highlight = m;
    this.highlightT = 0;
  }

  clearHighlight() {
    if (this.highlight) {
      this.highlight.parent?.remove(this.highlight);
      this.highlight.geometry.dispose();
      this.highlight.material.dispose();
      this.highlight = null;
    }
  }

  update(dt) {
    if (this.highlight) {
      this.highlightT += dt;
      const k = this.highlightT;
      this.highlight.material.opacity = k < 3.2 ? (0.28 + Math.sin(k * 7) * 0.22) * Math.max(0, 1 - k / 3.4) + 0.1 : 0;
      if (k > 3.6) this.clearHighlight();
    }

    this.lookAtTimer -= dt;
    if (this.lookAtTimer <= 0 && !this.inspector.active) {
      this.lookAtTimer = 0.14;
      // THE SINGLE MOST EXPENSIVE THING A MOTIONLESS PLAYER PAYS FOR.
      //
      // This raycast tests all 260 merged case batches — 734,988 triangles,
      // no BVH — and it ran every 0.14 s with no check on whether the camera
      // had moved. Measured over ten simulated minutes of standing perfectly
      // still: 19.9-40.7 ms per call, i.e. 142-291 ms of main-thread CPU for
      // every wall-clock second, recomputing an answer that could not have
      // changed. On a phone that is a quarter of the frame budget spent
      // deciding, repeatedly, that you are still looking at the same case.
      //
      // The crosshair result depends on the camera and on which slots are
      // hidden, so a pure movement gate would miss a case being picked up or a
      // restock. Hence the forced refresh: skip only while the camera is
      // genuinely still, and never for longer than LOOKAT_STALE_MS.
      this.camera.updateMatrixWorld();
      const still = this._lookCamPos
        && this._lookCamPos.distanceToSquared(this.camera.position) < 1e-8
        && Math.abs(this._lookCamQuat.dot(this.camera.quaternion)) > 1 - 1e-9;
      this._lookStale = (this._lookStale ?? 0) + 0.14;
      // Skip the RAYCAST only — never the rest of update(), which still has to
      // run the aisle-zone awareness below.
      if (!still || this._lookStale >= LOOKAT_STALE_S) {
        this._lookStale = 0;
        (this._lookCamPos ??= new THREE.Vector3()).copy(this.camera.position);
        (this._lookCamQuat ??= new THREE.Quaternion()).copy(this.camera.quaternion);
        this.ndc.set(0, 0);
        this.ray.setFromCamera(this.ndc, this.camera);
        const hits = this.ray.intersectObjects(this.caseSystem.meshes, false);
        const h = hits[0];
        let found = null;
        if (h && h.distance <= WORLD.lookAtDist) {
          const slotId = this.caseSystem.slotFromIntersect(h);
          if (slotId && !this.caseSystem.isHidden(slotId)) {
            const slot = this.layout.slotById.get(slotId);
            found = {
              slot, title: this.byId.get(slot.titleId), dist: h.distance,
              sameLevel: slot.level === this.player.level,
            };
          }
        }
        const key = found ? found.slot.id : null;
        if (key !== this.currentLook) {
          this.currentLook = key;
          this.ui.setLookAt(found);
        }
      }
    } else if (this.inspector.active && this.currentLook) {
      this.currentLook = null;
      this.ui.setLookAt(null);
    }

    // aisle awareness — zones on the player's level only
    let best = null, bestD = Infinity;
    for (const z of this.layout.zones) {
      if (z.level !== this.player.level) continue;
      const d = Math.hypot(this.player.x - z.x, this.player.z - z.z);
      if (d < z.r && d < bestD) { bestD = d; best = z; }
    }
    if (this.player.isRiding) {
      best = this.player.ride.up
        ? { label: 'ESCALATOR', code: 'GOING UP ↑' }
        : { label: 'ESCALATOR', code: 'GOING DOWN ↓' };
    }
    if (!best) {
      best = this.player.level === 1
        ? { label: 'TV & SERIES', code: 'MEZZANINE' }
        : this.player.z > 4.6
          ? { label: 'FRONT OF STORE', code: 'WELCOME' }
          : { label: 'CENTER AISLE', code: 'BROWSE' };
    }
    this.ui.setZone(best.label, best.code);
  }
}
