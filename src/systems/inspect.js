// Case inspection: the case physically leaves its shelf slot, floats to the
// player, can be rotated/zoomed, then returns to the exact same slot.
import * as THREE from 'three';
import { loadArtwork, loadBackdropImage } from '../world/textures.js';
import { ensureDetail, applyDetail, hasDetail } from '../data/detail.js';
import { WORLD } from '../config.js';
import { tween, cancelTween, easeInOutCubic, easeOutCubic } from './tween.js';

export class Inspector {
  constructor(scene, camera, caseSystem, layout, { onOpen, onClose, audio }) {
    this.scene = scene;
    this.camera = camera;
    this.cases = caseSystem;
    this.layout = layout;
    this.onOpen = onOpen;
    this.onClose = onClose;
    this.audio = audio;

    this.state = 'idle'; // idle | picking | holding | returning | stashing
    this.mesh = null;
    this.slot = null;
    this.title = null;
    this.dist = 0.5;
    this.rotOffY = 0; this.rotOffX = 0;
    this.baseYaw = 0;
    this.anchor = new THREE.Vector3();
    this.floatT = 0;
    this.activeTween = null;
  }

  get active() { return this.state !== 'idle'; }

  // horizontal camera-forward (ignores pitch)
  holdDirection() {
    const yaw = this.camera.rotation.y;
    return new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
  }

  /**
   * How far the held case floats above (or below) eye level.
   *
   * THE SHEET AND THE CASE HAVE TO AGREE ABOUT WHERE THE FREE SPACE IS.
   * On a phone the detail sheet is a BOTTOM sheet in portrait and a SIDE
   * sheet in landscape, so the space left for the object is in a different
   * place in each. Measured with the real camera, the case at the default
   * hold distance covers y 49.3%-75.2% of a portrait viewport — dead centre
   * of what a bottom sheet occupies, which is why picking a title up hid the
   * very thing being picked up.
   *
   * The lift is expressed as a FRACTION OF THE FRUSTUM, never as pixels: the
   * visible height at the hold distance is 2*dist*tan(fov/2), so the same
   * fraction lands in the same place on every screen, at every zoom level,
   * and at whatever FOV the device is using. Landscape keeps the natural
   * slight drop, because there the sheet sits beside the case rather than
   * under it.
   *
   * Called every frame from update(), so a rotation repositions the case on
   * the next frame with no resize listener to get out of step.
   */
  holdRise() {
    const NATURAL_DROP = -0.09;
    if (typeof document === 'undefined' || typeof matchMedia !== 'function') return NATURAL_DROP;
    // Only the phone UI uses a sheet at all; the desktop card is a right-hand
    // column that never covered the case.
    if (!document.body?.classList?.contains('ui-mobile')) return NATURAL_DROP;
    // ASK THE SAME QUESTION THE STYLESHEET ASKS. The side sheet is selected by
    // this exact media query in index.html, so reading it here keeps ONE
    // definition of the breakpoint. Testing `innerHeight > innerWidth` instead
    // would have missed a tall landscape tablet, which still gets the BOTTOM
    // sheet and therefore still needs the lift.
    const sideSheet = matchMedia('(orientation: landscape) and (max-height: 460px)').matches;
    if (sideSheet) return NATURAL_DROP;
    const visibleH = 2 * this.dist * Math.tan((this.camera.fov * Math.PI / 180) / 2);
    // Puts the case centre near 32% of viewport height, clear of a sheet that
    // starts at 54%, with room to spare at both ends.
    return 0.18 * visibleH;
  }

  slotQuaternion(slot) {
    const e = slot.lay
      ? new THREE.Euler(-Math.PI / 2 + slot.tilt, slot.rotY, 0, 'YXZ')
      : new THREE.Euler(0, slot.rotY, 0, 'YXZ');
    return new THREE.Quaternion().setFromEuler(e);
  }

  open(slot, title) {
    if (this.active) return;
    this.slot = slot;
    this.title = title;
    this.state = 'picking';
    this.rotOffY = 0; this.rotOffX = 0;
    this.dist = 0.5;
    this.floatT = 0;

    this.cases.hideSlot(slot.id);
    this.mesh = this.cases.makeInspectMesh(title);
    // THE HELD CASE FINISHES DRESSING ITSELF WHILE IT FLOATS OVER. Three
    // things can be missing at pick-up time and each used to leave a hole:
    //   the poster    (released after its shelf texture committed),
    //   the synopsis  (the lazy detail shard — on a phone, EVERY first
    //                  pick-up, which is why the back read as blank), and
    //   the backdrop  (the real landscape still for the reverse).
    // All three are fetched together and the texture is swapped ONCE when
    // they land — if the shopper is still holding this exact case.
    {
      // The owner is captured BEFORE the await. The guard used to check only
      // `this.title` and `this.mesh`, not which CaseSystem built the mesh — and
      // restock disposes the old CaseSystem and assigns a new one. A poster
      // landing across a restock would build a fresh texture on the wrong (or
      // a disposed) generation and then dispose a map belonging to the live
      // streamer.
      const ownerCases = this.cases;
      // FOLD BEFORE DECIDING TO FETCH. hasDetail means "the shard is cached",
      // not "this record carries its blurb" — a shard load caches ~1,920
      // titles and folds none of them. Short-circuiting on hasDetail alone
      // drew the case BACK without the synopsis for every co-shard title, on
      // exactly the mobile path where nothing is bulk-loaded.
      const hydrate = () => {
        if (!hasDetail(title.id)) return false;
        applyDetail([title]);
        return true;
      };
      const waits = [
        loadArtwork([title]) ?? Promise.resolve(),
        hydrate() ? Promise.resolve() : ensureDetail([title.id]).then(hydrate),
        loadBackdropImage(title),
      ];
      Promise.all(waits).then(([, , backdrop]) => {
        // STILL IN HAND, not merely still referenced. putBack() and stash()
        // leave `title` and `mesh` set for the whole 0.55s return tween, so
        // this guard used to pass for a case already flying back to its slot
        // — building a fresh hi-res texture for something about to be
        // disposed, at the exact moment a phone is least able to afford it.
        if (this.state !== 'holding' && this.state !== 'picking') return;
        if (this.title !== title || !this.mesh || this.cases !== ownerCases) return;
        const fresh = this.cases.makeInspectMesh(title, { backdrop });
        const old = this.mesh.material.map;
        this.mesh.material.map = fresh.material.map;
        this.mesh.material.needsUpdate = true;
        old?.dispose?.();
        // the throwaway carrier: drop its geometry and material, but NOT the
        // map — that is the texture now mounted on the live mesh
        fresh.geometry.dispose();
        fresh.material.dispose();
      }).catch(() => { /* every branch degrades to the treatment already shown */ });
    }
    this.mesh.position.set(slot.x, slot.y, slot.z);
    this.startQuat = this.slotQuaternion(slot);
    this.mesh.quaternion.copy(this.startQuat);
    this.scene.add(this.mesh);

    // anchor in front of the camera — yaw only, at a comfortable chest height,
    // so a case grabbed from the bottom shelf still presents like a hero prop
    const camDir = this.holdDirection();
    this.anchor.copy(this.camera.position).addScaledVector(camDir, this.dist);
    this.anchor.y = this.camera.position.y + this.holdRise();
    this.baseYaw = Math.atan2(this.camera.position.x - this.anchor.x, this.camera.position.z - this.anchor.z);
    const targetQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, this.baseYaw, 0, 'YXZ'));

    const startPos = this.mesh.position.clone();
    const startQuat = this.startQuat.clone();
    this.audio?.casePick();
    this.activeTween = tween({
      duration: 0.62, ease: easeInOutCubic,
      onUpdate: (v, k) => {
        if (!this.mesh) return;
        this.mesh.position.lerpVectors(startPos, this.anchor, k);
        this.mesh.position.y += Math.sin(k * Math.PI) * 0.1; // small arc
        this.mesh.quaternion.slerpQuaternions(startQuat, targetQuat, k);
      },
      onDone: () => { this.state = 'holding'; },
    });
    this.onOpen?.(title, slot);
  }

  /**
   * Case rotation from a drag. Named for what the arguments ARE: the first is
   * the HORIZONTAL drag and it spins the case about Y; the second is the
   * VERTICAL drag and it tilts about X.
   *
   * They used to be declared `(dy, dx)` while the only caller passed
   * `(dx, dy)`. The behaviour was right and the names were backwards, which is
   * worse than a plain bug — it reads as an axis swap to anyone auditing the
   * look controls, and it cost real time during exactly that audit.
   */
  addRotate(dragX, dragY) {
    if (this.state !== 'holding') return;
    this.rotOffY += dragX;
    this.rotOffX = Math.max(-1.0, Math.min(1.0, this.rotOffX + dragY));
    this.floatT = 0;
  }
  adjustDistance(d) {
    if (this.state !== 'holding') return;
    this.dist = Math.max(0.32, Math.min(0.8, this.dist + d));
  }
  flip() {
    if (this.state !== 'holding') return;
    const start = this.rotOffY;
    const target = Math.round((start + Math.PI) / Math.PI) * Math.PI;
    tween({ duration: 0.4, ease: easeOutCubic, onUpdate: (v, k) => { this.rotOffY = start + (target - start) * k; } });
  }

  putBack(cb) {
    if (this.state !== 'holding' && this.state !== 'picking') return;
    cancelTween(this.activeTween);
    this.state = 'returning';
    const startPos = this.mesh.position.clone();
    const startQuat = this.mesh.quaternion.clone();
    const endPos = new THREE.Vector3(this.slot.x, this.slot.y, this.slot.z);
    const endQuat = this.slotQuaternion(this.slot);
    this.audio?.casePut();
    this.activeTween = tween({
      duration: 0.55, ease: easeInOutCubic,
      onUpdate: (v, k) => {
        if (!this.mesh) return;
        this.mesh.position.lerpVectors(startPos, endPos, k);
        this.mesh.position.y += Math.sin(k * Math.PI) * 0.08;
        this.mesh.quaternion.slerpQuaternions(startQuat, endQuat, k);
      },
      onDone: () => {
        this.cases.showSlot(this.slot.id);
        this.cleanup();
        cb?.();
      },
    });
    this.onClose?.();
  }

  // Fly the case toward the stack button corner, keep the slot empty.
  stash(cb) {
    if (this.state !== 'holding') return;
    this.state = 'stashing';
    const startPos = this.mesh.position.clone();
    // fly toward the on-screen Stack button (bottom-right), 0.55m out
    const target = new THREE.Vector3(0.65, -0.72, 0.5).unproject(this.camera);
    const dir = target.clone().sub(this.camera.position).normalize();
    target.copy(this.camera.position).addScaledVector(dir, 0.55);
    const startScale = this.mesh.scale.x;
    this.audio?.addStack();
    this.activeTween = tween({
      duration: 0.5, ease: easeInOutCubic,
      onUpdate: (v, k) => {
        if (!this.mesh) return;
        this.mesh.position.lerpVectors(startPos, target, k);
        const s = startScale * (1 - k * 0.85);
        this.mesh.scale.set(s, s, s);
      },
      onDone: () => { this.cleanup(); cb?.(); },
    });
    this.onClose?.();
  }

  cleanup() {
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.cases.disposeInspectMesh(this.mesh);
      this.mesh = null;
    }
    this.state = 'idle';
    this.slot = null;
    this.title = null;
  }

  hitTest(raycaster) {
    if (!this.mesh) return false;
    return raycaster.intersectObject(this.mesh, false).length > 0;
  }

  update(dt) {
    if (!this.mesh) return;
    if (this.state === 'holding') {
      this.floatT += dt;
      // follow zoom distance in front of the camera (yaw only, steady height)
      const camDir = this.holdDirection();
      const target = new THREE.Vector3().copy(this.camera.position).addScaledVector(camDir, this.dist);
      target.y = this.camera.position.y + this.holdRise() + Math.sin(this.floatT * 1.4) * 0.006;
      this.baseYaw = Math.atan2(-camDir.x, -camDir.z);
      this.mesh.position.lerp(target, Math.min(1, 9 * dt));
      // baseYaw keeps the FRONT (+z) toward the camera; offsets come from drags
      const e = new THREE.Euler(this.rotOffX, this.baseYaw + this.rotOffY + Math.sin(this.floatT * 0.9) * 0.02, 0, 'YXZ');
      const q = new THREE.Quaternion().setFromEuler(e);
      this.mesh.quaternion.slerp(q, Math.min(1, 12 * dt));
    }
  }
}
