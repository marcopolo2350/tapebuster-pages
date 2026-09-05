// COVER RESIDENCY: how a 20,000-title store gets its artwork without a 2.5 GB
// startup allocation, and still shows a LEGIBLE cover at browsing distance.
//
// THE DEFECT THIS REPLACES. buildCoverAtlases() drew every atlas at full
// resolution in one unyielding loop. At STORE_CAPACITY that is 260 atlases of
// 2048x2048 — ~4 GB of canvas plus the same again as GPU textures — built before
// the first frame. The main thread blocked for minutes and the tab never became
// interactive. World generation was never the problem; the renderer was.
//
// THE INVARIANT EVERYTHING RESTS ON. An atlas's normalized UVs are identical at
// every scale, because atlasSize is always 2048*scale and the tile grid is
// therefore 7x11 (77 tiles) regardless (see planCoverAtlases). A case mesh can be
// handed a 256px, 512px, 1024px or 2048px build of ITS OWN atlas index and its
// baked UVs stay exactly correct. This is what lets residency change RESOLUTION
// rather than presence, and it is why a case can never end up wearing another
// title's artwork: the tile a title occupies is fixed by the plan, and the plan
// is pure arithmetic over catalog order that no streaming decision can touch.
//
// THE THREE TIERS. There used to be two, and that was the bug: BASE was the only
// tier a walking player ever saw, because _pick returned unconditionally during
// the base drain and never emitted a detail job, so the detail tier stayed
// EMPTY for the entire session. Every case in the building rendered from a
// 20x28-texel cover front. Picking one up spawns a separate hi-res mesh, which
// is exactly why clicking looked sharp and browsing did not.
//
// The cover front each tier gives you, in texels (the region is 108x152 at
// scale 1):
//     base   0.1875 →  20.3 x 28.5  adequate beyond 10.7 m
//     mid    0.5    →  54   x 76    adequate beyond  4.0 m
//     detail 1      → 108   x 152   adequate beyond  2.0 m
// Those three overlap deliberately: MID_R (6 m) sits inside the distance the
// base tier is already adequate at, so there is no band the player can stand in
// where every tier is under-sampled. The first cut of this had base at 0.125
// (adequate only beyond 16 m) and left exactly such a band from 6 to 16 m.
//
//   BASE   every atlas, permanently resident once drawn, 260 x 384px = 146.3 MiB.
//          This is what makes "placeholders never become permanent" structural
//          rather than hopeful — the queue drains completely, and once drained
//          every case in the building is wearing its own real cover.
//   MID    a bounded set at 1024px for the atlases within MID_R of the player —
//          the shelves you are walking past. 24 x 4.0 MiB = 96.0 MiB.
//   DETAIL a bounded set at 2048px for the atlases within DETAIL_R — the shelf
//          you are standing at and can read. 6 x 16.0 MiB = 96.0 MiB.
//
// Both bounded tiers are HARD CAPS that do not grow with store capacity. Only
// BASE scales, and its RESOLUTION is chosen from a byte budget so it cannot,
// either (chooseBaseScale).
//
// THE MEMORY LEDGER, in stats() terms (raw texel bytes, no mip allowance):
//     base       260 x 384^2 x 4   = 146.3 MiB
//     mid         24 x 1024^2 x 4  =  96.0 MiB
//     detail       6 x 2048^2 x 4  =  96.0 MiB
//     tileCache  bounded by bytes  =  48.0 MiB
//     placeholder     256^2 x 4    =   0.25 MiB
//                                    ---------
//                                    386.5 MiB   (~451 MiB of GPU texture once
//                                    mips are allocated; the 48 MiB tile cache
//                                    is canvases on the JS heap, and unmipped)
// The figure this replaces was written down as "~350 MB" and the code under it
// was already 374.7 MiB — so this costs +11.9 MiB over the ORIGINAL ceiling, not
// over a number that was never true. Keep this ledger honest: stats() reports
// every line, and covers.stats() is the QA hook that proves it rather than
// assuming it. It has been measured equal to the figure above, not estimated.
//
// WHY NOT PROXIMITY ALONE. Measured on the real layout: even a 4 m view radius
// touches most of the atlases, because ~230 titles keep a curated copy at the
// front of store which stretches their atlas across the whole building.
// Evicting on distance alone would leave gigabytes resident. Resolution, not
// presence, is the lever that works — and that same smearing is why proximity is
// ranked here from a per-SLOT proximity index (cases.nearestAtlasDistance) and
// not from the per-atlas AABB: the boxes are up to 145 m long, so dozens of
// atlases tie at the identical minimum distance and the ranking is noise.
import * as THREE from 'three';
import {
  planCoverAtlases, createAtlasCanvas, drawAtlasTiles, atlasTileCount, makeCasePlaceholder,
  TileCache, BASE_SCALES, chooseBaseScale, loadArtwork, releaseArtwork, MAX_ANISO,
} from './textures.js';

// Re-exported so callers have one import for the residency layer. These live in
// textures.js because that module is free of any Three.js import and can
// therefore be exercised under `node --test`, which they need to be.
export { TileCache, BASE_SCALES, chooseBaseScale };

const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());


// Tiles drawn between deadline checks. Small enough that one chunk cannot
// overrun the frame budget on a slow machine, large enough that the check
// itself is not the cost.
const CHUNK_TILES = 8;

// How far ahead of the draw cursor an atlas's artwork is fetched. Decoupled
// from CHUNK_TILES on purpose: the DRAW chunk decides how often we yield to
// the renderer, this decides the transient decode peak and how well the
// network is pipelined. Fetching a whole atlas (77) peaked at 51.5 MiB of
// decoded posters; fetching only a draw-chunk cut that to 5 MiB but cost a
// round trip every 8 tiles and hydration slowed to a crawl. 24 matches the
// global image semaphore: one saturated batch in flight, ~16 MiB, four
// round trips per atlas instead of ten.
const ART_WINDOW = 24;

// PROXIMITY RADII, in metres, all measured in XZ on the player's own floor.
//   NEAR_R   the radius the proximity query itself covers, and the radius the
//            trim ranks against. Must be >= every radius below it: outside it
//            nearestAtlasDistance reports Infinity, and an atlas that reads as
//            Infinity is skipped by step (a) — which would silently starve a
//            nearby atlas of its BASE texture, the exact bug being removed.
//   DETAIL_R the shelf you are standing at and reading.
//   MID_R    the shelves you are walking past.
// One pick in every BASE_SHARE is reserved for the far-field base drain while
// any atlas still lacks one, so near-field churn can never starve it.
const BASE_SHARE = 4;
const NEAR_R = 6;
const DETAIL_R = 2.0;
const MID_R = 6.0;

// HYSTERESIS, in metres — the churn brake.
//
// The bounded tiers hold far fewer atlases than sit inside their radius (a
// median of ~26 candidates inside DETAIL_R against a cap of 6, or 2 on a
// phone), so ranking by raw distance made every step reshuffle the winners:
// promote, evict, promote the same atlas again. Measured on the real
// streamer, a 75 m walk allocated 1,500 mid and 600 detail textures against
// caps of 8 and 2 — 3.9 GB of GPU allocate/upload/free churned through, which
// is what iOS kills a tab for. A candidate must now beat the WORST resident
// by this margin before it is worth a new upload, so crossing a boundary no
// longer destroys and recreates GPU resources.
const DETAIL_HYST = 0.6;
const MID_HYST = 1.5;

/**
 * Point a texture at a canvas. Used both when a texture is created and when a
 * POOLED one is reused, which is why it is separate: the release hook closes
 * over the canvas it must shrink, so a reused texture that kept its old hook
 * would free the wrong canvas and leak the new one — the 81 MiB duplicate
 * coming straight back for exactly the textures that churn most.
 */
function bindCanvas(t, canvas) {
  t.image = canvas;
  t.userData.bytes = canvas.width * canvas.height * 4;
  t.onUpdate = () => { canvas.width = 1; canvas.height = 1; };
  t.needsUpdate = true;
  return t;
}

// CUMULATIVE GPU COUNTERS. Module-level and monotonic on purpose: the resident
// set has been proven bounded several times over, and the device kept dying
// anyway. What was never measured is the TOTAL — how many GL textures this
// session has created and destroyed, and how many texels it has uploaded. A
// bounded cache with a high turnover still asks the driver to do unbounded
// work, and that work is not visible to any JS heap measurement.
export const gpuMetrics = {
  texCreated: 0, texDisposed: 0, uploads: 0, uploadedTexels: 0,
};

function makeTexture(canvas) {
  gpuMetrics.texCreated++;
  // Must match what CaseSystem used to build inline — colour space and mip
  // settings are part of what makes the baked UVs render correctly.
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = MAX_ANISO;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  // EVERY ATLAS COST DOUBLE, AND THE LEDGER COULD NOT SEE IT.
  //
  // CanvasTexture holds a hard reference to its source canvas for the life of
  // the texture, so each committed atlas retained a GPU texture AND an
  // identical CPU backing store — 68 MB of hidden duplicate on a phone, 153 MB
  // on desktop, none of it in covers.stats(). The drain commits atlases
  // continuously in the first seconds after entry, which is exactly where the
  // reported crash landed (crumb: entered@20s, dead before stable-30s).
  //
  // onUpdate fires once, immediately after WebGL uploads the pixels, so
  // shrinking the canvas here frees the copy the GPU no longer needs. The
  // byte count is recorded FIRST — the ledger reads userData.bytes precisely
  // because tex.image stops being able to answer.
  return bindCanvas(t, canvas);
}

const bytesOf = (tex) => {
  // Recorded at creation: the source canvas is released after upload (see
  // makeTexture), so tex.image can no longer report the real size.
  if (tex?.userData?.bytes) return tex.userData.bytes;
  const img = tex?.image;
  if (!img?.width) return 0;
  return img.width * img.height * 4;
};

export class CoverStreamer {
  /**
   * @param catalog the STOCKED titles, in the exact order the layout was built
   *                from — plan positions are indices into this array.
   */
  constructor(catalog, opts = {}) {
    this.catalog = catalog;
    // Plan once to learn the atlas count (tile assignment is scale-invariant, so
    // this pass is thrown away only for its scale-dependent fields), size the
    // base tier to the budget, then plan for real.
    const probe = planCoverAtlases(catalog, 1);
    this.baseScale = opts.baseScale
      ?? chooseBaseScale(probe.count, opts.baseBudgetBytes ?? 220 * 1024 * 1024);
    this.detailScale = opts.detailScale ?? 1;
    // Default matches the ledger in the header. It was 12, so a caller that
    // omitted the option silently bought +96 MiB of detail atlases and the
    // written-down ceiling quietly stopped being true.
    this.maxDetail = opts.maxDetail ?? 6;
    // The MID tier is what a walking player actually reads. It is deliberately
    // large in COUNT and small in BYTES: 1024px is a quarter of a detail atlas,
    // so 40 of them cost less than 10 detail atlases would.
    this.midScale = opts.midScale ?? 0.5;
    this.maxMid = opts.maxMid ?? 40;
    this.budgetMs = opts.budgetMs ?? 6;
    // conserveImages now governs only the one-atlas-ahead PREFETCH (off on
    // phones — an extra 77 decoded posters is residency Safari cannot
    // spare). Image RELEASE after commit is unconditional on every platform:
    // see _commit for the renderer-OOM this closed.
    this.conserveImages = opts.conserveImages ?? false;
    this.tileCache = opts.tileCache ?? new TileCache();

    // Pure and instant — every stocked title has a tile before a single pixel is
    // drawn, which is what lets CaseSystem bake its UVs and the store be
    // walkable immediately.
    this.plan = planCoverAtlases(catalog, this.baseScale);

    this.placeholder = makeTexture(makeCasePlaceholder(0.125));
    this.base = new Array(this.plan.count).fill(null);
    this.mid = new Map();             // atlasIdx -> THREE.Texture
    this.detail = new Map();          // atlasIdx -> THREE.Texture
    this.job = null;
    this.cases = null;
    this.baseRemaining = this.plan.count;
    this._pickTick = 0;
    this._rank = [];
    this._near = [];
    this._nearBuf = new Float32Array(this.plan.count);
    // GPU TEXTURE POOL, keyed by pixel size. An evicted tier texture is parked
    // here instead of destroyed, and the next commit of the same size reuses
    // the SAME GL object — the driver re-uploads into the existing allocation
    // rather than creating and deleting one per boundary crossing. Bounded:
    // never more than a tier's cap plus a little slack can be parked, so the
    // pool cannot become a second, invisible residency tier.
    this._pool = new Map();          // px -> Texture[]
    this._poolMax = 3;
    // A size-keyed pool is only bounded if the number of SIZES is bounded.
    // A streamer uses at most three (base/mid/detail all resolve to
    // 2048*scale), but "in practice" is how an unbounded cache gets built:
    // past this many classes a texture is destroyed rather than parked, so
    // the pool can never hold more than _poolMax * _poolClasses textures.
    this._poolClasses = 4;
    this._failures = new Map();      // atlas -> consecutive draw/upload failures
    this._rescanDirty = new Set();   // atlases drawn before late-merged artwork arrived
    this._frame = 0;
    // UPLOAD PERMITS (transient backpressure). budgetMs bounds DRAWING time,
    // not textures created — and the GPU upload happens later inside
    // renderer.render(), where that budget has no jurisdiction. Measured: up
    // to 5 commits in a single frame once posters are cached, i.e. five
    // texture uploads plus mipmap generation in one frame. A phone gets one
    // per frame; a cover arriving a frame later is invisible, an iOS GPU
    // spike is not. Render stability outranks hydration speed.
    this.maxCommitsPerFrame = opts.maxCommitsPerFrame ?? 3;
    this._commits = 0;               // cumulative texture creations/uploads
    this._lastFrameCommits = 0;
    this._lastCommitted = null;      // for initTexture during pre-entry dressing
    this._distScratch = new Map();
    this._disposed = false;
  }

  /**
   * Compact runtime state for the crash ring buffer. Numbers only, no
   * allocation beyond the returned object — this is sampled a couple of times
   * a second on a device that is dying, so it must never be the reason.
   */
  telemetry() {
    let pooled = 0;
    for (const list of this._pool.values()) pooled += list.length;
    return {
      mid: this.mid.size, detail: this.detail.size, pooled,
      job: this.job ? (this.job.waiting ? 2 : 1) : 0,
      commits: this._commits, frameCommits: this._lastFrameCommits,
      fails: this._failures.size, backlog: this.baseRemaining,
      texCreated: gpuMetrics.texCreated, texDisposed: gpuMetrics.texDisposed,
      uploadedTexels: gpuMetrics.uploadedTexels,
    };
  }

  /** The case meshes whose materials this streamer drives. */
  attach(caseSystem) {
    this.cases = caseSystem;
    for (let a = 0; a < this.plan.count; a++) this._apply(a);
  }

  get baseComplete() { return this.baseRemaining === 0; }
  get progress() { return 1 - this.baseRemaining / Math.max(1, this.plan.count); }

  /** Best texture available for an atlas: detail > mid > base > placeholder. */
  textureFor(atlasIdx) {
    return this.detail.get(atlasIdx)
      || this.mid.get(atlasIdx)
      || this.base[atlasIdx]
      || this.placeholder;
  }

  _apply(atlasIdx) {
    this.cases?.setAtlasTexture(atlasIdx, this.textureFor(atlasIdx));
  }

  /**
   * Rank EVERY atlas by AABB distance from the player, nearest first. This is
   * the FAR-FIELD ordering only — it decides which of the atlases nobody is
   * standing near gets drawn next, where being roughly right is enough.
   *
   * It is not good enough for the near field, and that is not a bug in the box
   * test: a title with a curated copy at the front of store stretches its
   * atlas's box across the whole building, so dozens of atlases report the
   * identical minimum distance and the sort has nothing to separate them.
   * _rankedNear exists for that. Cheap enough to redo per pump (239 box tests),
   * and doing it fresh each time means there is no stale-priority state to get
   * out of sync with where the player actually is.
   */
  _ranked(pos) {
    const out = this._rank;
    out.length = 0;
    for (let a = 0; a < this.plan.count; a++) {
      out.push({ a, d: this.cases ? this.cases.atlasDistance(a, pos) : a });
    }
    out.sort((p, q) => p.d - q.d);
    return out;
  }

  /**
   * The NEAR field: atlases with an actual case standing within NEAR_R of the
   * player, on the player's own floor, ranked by that case's real distance.
   * Empty before attach() and empty when the player is out in the lobby, in
   * which case _pick falls straight through to the far-field base drain.
   */
  _rankedNear(pos) {
    const out = this._near;
    out.length = 0;
    if (!this.cases?.nearestAtlasDistance) return out;
    const d = this._nearBuf;
    this.cases.nearestAtlasDistance(pos, NEAR_R, d);
    for (let a = 0; a < d.length; a++) if (d[a] !== Infinity) out.push({ a, d: d[a] });
    out.sort((p, q) => p.d - q.d);
    return out;
  }

  _pick(ranked, near) {
    // A CULLED BATCH STREAMS NOTHING. applyShelfStock hides whole batches whose
    // every slot is empty (206 of 260 under a two-service store); an invisible
    // mesh samples no texture, so drawing its atlas is pure wasted memory —
    // most of the base budget, on a mobile heap that cannot afford it. The
    // check is against LIVE mesh visibility on every pump, never cached, so
    // restocking a batch (service change, ALL mode) re-enters the drain by
    // itself and "placeholders never become permanent" still holds: a VISIBLE
    // case can never be skipped by this line. baseRemaining consequently stays
    // >0 while batches are culled — only stats() reads it, and an idle drain
    // scan is ~260 boolean checks.
    const live = (a) => (!this.cases?.atlasVisible || this.cases.atlasVisible(a))
      && !this._backedOff(a);
    // (a) NEAR BASE FIRST. A case within arm's reach with no texture at all is
    //     wearing a placeholder, and clearing that beats sharpening anything.
    //     This step — not a blanket "drain base before anything else" — is what
    //     keeps "placeholders never become permanent" true. The old code
    //     returned unconditionally while baseRemaining > 0, which meant _pick
    //     never produced a detail job during the drain; and since _commit is the
    //     only writer of this.detail and _pick is its only source, the detail
    //     tier was written by nothing and stayed empty forever. Every case in
    //     the building rendered from the base tier, at a few dozen texels.
    for (const { a, d } of near) {
      if (d > NEAR_R) break;
      if (!this.base[a] && live(a)) return this._startJob(a, this.baseScale, 'base');
    }
    // A FORCED SHARE FOR THE BASE DRAIN. Steps (b) and (c) below can re-arm
    // themselves forever — move, and a fresh set of atlases wants detail — so a
    // drain that only ran when they declined was starvable in principle rather
    // than in practice: measured, teleporting to a new shelf every frame left 32
    // atlases (8,399 slots, the whole mezzanine) with NO base after 20,000 pumps,
    // permanently blank and visible from the floor below. Human motion always
    // drained fine, but "structural rather than hopeful" has to mean structural.
    // Every BASE_SHARE-th pick belongs to the drain while any atlas lacks a base.
    if (this.baseRemaining > 0 && (this._pickTick = (this._pickTick + 1) % BASE_SHARE) === 0) {
      for (const { a } of ranked) if ((!this.base[a] || this._rescanDirty.has(a)) && live(a)) return this._startJob(a, this.baseScale, 'base');
    }
    // (b) DETAIL for the shelf being read, capped at maxDetail candidates.
    let n = 0;
    const worstDetail = this._worstResident(this.detail, near);
    for (const { a, d } of near) {
      if (d > DETAIL_R || n >= this.maxDetail) break;
      if (!live(a)) continue;              // a culled batch must not consume a candidate slot
      n++;
      if (this.detail.has(a)) continue;
      // Only worth a new GPU upload if it BEATS the worst resident by the
      // margin. Without this the same two atlases trade places every step.
      if (this.detail.size >= this.maxDetail && d > worstDetail - DETAIL_HYST) continue;
      return this._startJob(a, this.detailScale, 'detail');
    }
    // (c) MID for the shelves being walked past.
    //
    // MID IS BUILT UNDER DETAIL ON PURPOSE. The obvious optimisation — skip an
    // atlas that already has detail, since textureFor prefers detail and the mid
    // texture would never be sampled — is what makes eviction violent. maxDetail
    // is 6 while a median of ~26 atlases sit inside DETAIL_R, so walking a shelf
    // reshuffles detail constantly; with nothing underneath, every eviction drops
    // that atlas from 108x152 straight to the 13.5x19 base, an 8x snap, in the
    // exact scenario this whole change exists to fix. Holding mid underneath
    // makes it a 2x step instead. Bounded cost: 6 x 4 MiB = 24 MiB.
    let m = 0;
    const worstMid = this._worstResident(this.mid, near);
    for (const { a, d } of near) {
      if (d > MID_R || m >= this.maxMid) break;
      if (!live(a)) continue;
      m++;
      if (this.mid.has(a)) continue;
      if (this.mid.size >= this.maxMid && d > worstMid - MID_HYST) continue;
      return this._startJob(a, this.midScale, 'mid');
    }
    // (d) FAR-FIELD BASE DRAIN. Every case in the building ends up wearing its
    //     own real cover — see the forced share above for why this cannot be
    //     left to "whenever nothing nearer is outstanding".
    if (this.baseRemaining > 0) {
      for (const { a } of ranked) if ((!this.base[a] || this._rescanDirty.has(a)) && live(a)) return this._startJob(a, this.baseScale, 'base');
    }
    return null;
  }

  /** Reuse a parked texture of this exact size, or make a new one. */
  _acquire(canvas) {
    const free = this._pool.get(canvas.width);
    const tex = free && free.pop();
    return tex ? bindCanvas(tex, canvas) : makeTexture(canvas);
  }

  /** Park a texture for reuse, or destroy it when the pool is full. */
  _release(tex) {
    if (!tex) return;
    const px = Math.round(Math.sqrt((tex.userData?.bytes ?? 0) / 4));
    let free = this._pool.get(px);
    if (!px || (!free && this._pool.size >= this._poolClasses)) { gpuMetrics.texDisposed++; tex.dispose(); return; }
    if (!free) { free = []; this._pool.set(px, free); }
    if (free.length >= this._poolMax) { gpuMetrics.texDisposed++; tex.dispose(); return; }
    // A texture evicted before the renderer ever uploaded it still holds a
    // full-size canvas, because its release hook never fired. Parking that
    // would re-import the duplicate-residency bug through the pool — and
    // reuse rebinds a fresh canvas anyway, so shrink it now.
    const img = tex.image;
    if (img && img.width > 1) { img.width = 1; img.height = 1; }
    free.push(tex);
  }

  /**
   * Artwork arrived AFTER some atlases were already drawn — re-queue exactly
   * those atlases, and only those.
   *
   * This is the merge half of the boot-manifest split: the small boot slice
   * is applied before the first blit, the full manifest lands mid-session,
   * and any atlas blitted in between holds printed sleeves where real posters
   * now exist. Nulling its base and bumping baseRemaining hands it back to
   * the SAME pump that drew it — same pacing, same caps, same backpressure —
   * so a late merge costs a few re-draws, never a new code path. Mid/detail
   * for a re-queued atlas are dropped too (promotion re-resolves through
   * textureFor), and its failure backoff is cleared: the world has changed,
   * so the atlas has earned a fresh try.
   *
   * @param {string[]} gainedIds titles that JUST gained artwork (from
   *   mergeArtworkManifest). Ids drawn nowhere yet cost nothing — their
   *   atlases simply draw correctly when the pump reaches them.
   */
  rescanArtwork(gainedIds) {
    if (!gainedIds?.length) return 0;
    // STEP 1 — POISON CONTROL, FOR EVERY GAINED ID, DRAWN OR NOT. The base
    // TileCache is write-once and keyed scale|id, so the sleeve tile cached
    // for a title before its artwork arrived would be blitted back by every
    // future draw of that title — the redraw below, a context-loss recovery,
    // a restock — forever. Reviewed and reproduced: without this, the whole
    // rescan was a visual no-op that fetched the new posters and then lost
    // them to a cache hit. Undrawn atlases matter here too: an in-flight job
    // caches tiles as it goes.
    if (this.tileCache) {
      for (const id of gainedIds) {
        for (const s of BASE_SCALES) this.tileCache.drop(`${s}|${id}`);
      }
    }
    let queued = 0;
    for (const id of gainedIds) {
      const tile = this.plan.tiles.get(id);
      if (!tile) continue;
      // STEP 2 — AN IN-FLIGHT JOB ON THIS ATLAS IS ALREADY STALE. Tiles it
      // blitted before the merge used the old map, and committing it would
      // install a half-sleeved texture that nothing re-queues (its base was
      // null, so the drawn test below saw "undrawn — will draw right").
      // Abandoning the job costs one partial draw; the pump restarts the
      // atlas from scratch with the merged map, exactly as it restarts a
      // failed job. Counters are untouched: an abandoned first draw is still
      // owed through its null base, an abandoned REdraw through its dirty bit.
      if (this.job && this.job.atlas === tile.atlas) this.job = null;
      if (!this.base[tile.atlas] || this._rescanDirty.has(tile.atlas)) continue;
      // STEP 3 — THE OLD BASE TEXTURE STAYS ON THE MESH. Nulling it here and
      // applying would drop whole shelves to the grey placeholder until the
      // redraw lands — a flash strictly worse than the sleeves already
      // showing. The dirty bit hands the atlas back to the SAME pump, and the
      // commit path releases the stale texture the way it releases any
      // texture it replaces.
      this._rescanDirty.add(tile.atlas);
      this.baseRemaining++;
      this._failures.delete(tile.atlas);
      queued++;
      // STEP 4 — RESIDENT MID/DETAIL WOULD SHADOW THE REDRAW. textureFor
      // prefers detail over mid over base, and _pick never re-draws a tier an
      // atlas is already resident in — so with these left in place, the
      // shelf the player is STANDING AT (the only place a cover is readable)
      // would be the last to show the merged posters, healing only on a long
      // walk. Dropping them falls back to the base texture — same artwork,
      // lower resolution, no placeholder — and the normal promotion path
      // re-draws them from the merged map within a few pump ticks.
      const mid = this.mid.get(tile.atlas);
      if (mid) { this._release(mid); this.mid.delete(tile.atlas); }
      const det = this.detail.get(tile.atlas);
      if (det) { this._release(det); this.detail.delete(tile.atlas); }
      if (mid || det) this._apply(tile.atlas);
    }
    return queued;
  }

  /**
   * The GPU objects are gone (WebGL context loss) — forget them WITHOUT
   * calling dispose, which would try to free handles that no longer exist.
   * The streamer then rebuilds from nothing, bounded by the same caps, so a
   * lost context degrades to "covers redraw" instead of taking the store out.
   */
  invalidateGpuState() {
    // The placeholder needs REBUILDING, not just forgetting: its canvas was
    // shrunk to 1x1 after its one upload, so letting three.js re-upload it
    // into a restored context would paint every undrawn case a single pixel
    // until its atlas is redrawn.
    this.placeholder = makeTexture(makeCasePlaceholder(0.125));
    this.base.fill(null);
    this.mid.clear();
    this.detail.clear();
    this._pool.clear();
    this.job = null;
    this.baseRemaining = this.plan.count;
    this._failures.clear();
    this._rescanDirty.clear();
  }

  /**
   * Distance of the FARTHEST atlas a tier is currently holding. Infinity when
   * it holds something outside the near field — that resident is dead weight
   * and should always lose its slot, with no margin required.
   */
  _worstResident(tier, near) {
    const d = this._distScratch;
    d.clear();
    for (const n of near) d.set(n.a, n.d);
    let worst = 0;
    for (const a of tier.keys()) {
      const dist = d.has(a) ? d.get(a) : Infinity;
      if (dist > worst) worst = dist;
    }
    return worst;
  }

  /**
   * Is this atlas serving a failure backoff? After repeated draw/upload
   * failures it is skipped for exponentially longer, and after 5 strikes for
   * the rest of the session — a missing cover, never a retry storm and never
   * a stalled streamer. Used as a CANDIDATE FILTER so a backed-off atlas
   * cannot block the frame's other candidates.
   */
  _backedOff(atlas) {
    const fails = this._failures.get(atlas) ?? 0;
    if (fails === 0) return false;
    if (fails >= 5) return true;
    return this._frame % (1 << Math.min(fails, 6)) !== 0;
  }

  _startJob(atlas, scale, tier) {
    return {
      atlas, scale, tier,
      canvas: createAtlasCanvas(scale),
      next: 0,
      total: atlasTileCount(this.catalog, this.plan, atlas),
    };
  }

  _commit(job, near) {
    this._commits++;
    gpuMetrics.uploads++;
    gpuMetrics.uploadedTexels += (job.canvas?.width ?? 0) * (job.canvas?.height ?? 0);
    this._lastFrameCommits++;
    // MAKE ROOM BEFORE ALLOCATING. Trimming used to happen at the END of the
    // pump, so every commit hit an empty pool and allocated, and every later
    // eviction hit a full one and destroyed — measured under rapid movement:
    // 1,616 pool misses and 1,611 forced disposals over 600 pumps. Freeing
    // the slot first hands the outgoing texture straight to _acquire, which
    // is the entire point of pooling.
    if (near) {
      if (job.tier === 'mid') this._trimTier(this.mid, Math.max(0, this.maxMid - 1), near);
      else if (job.tier === 'detail') this._trimTier(this.detail, Math.max(0, this.maxDetail - 1), near);
    }
    const tex = this._acquire(job.canvas);
    if (job.tier === 'base') {
      if (!this.base[job.atlas] || this._rescanDirty.delete(job.atlas)) this.baseRemaining--;
      this._release(this.base[job.atlas]);
      this.base[job.atlas] = tex;
    } else if (job.tier === 'mid') {
      this._release(this.mid.get(job.atlas));
      this.mid.set(job.atlas, tex);
    } else {
      this._release(this.detail.get(job.atlas));
      this.detail.set(job.atlas, tex);
    }
    this._lastCommitted = tex;
    this._apply(job.atlas);
    // RELEASE ON EVERY PLATFORM. This was mobile-only ("desktop keeps the
    // habit — it makes promotions instant") and that rationale died the day
    // the CDN fallback made the ENTIRE catalogue fetchable: a desktop drain
    // then retained ~20k decoded posters and the renderer died of it ~1-2
    // minutes in — caught live by the crash breadcrumb ("stable-30s"). A
    // promotion refetches through the HTTP cache, which is near-free; a
    // renderer OOM is not.
    {
      const from = job.atlas * this.plan.perAtlas;
      releaseArtwork(this.catalog.slice(from, from + this.plan.perAtlas));
    }
  }

  /**
   * Called once per frame. Spends at most budgetMs drawing, then trims the
   * bounded tiers. Safe to call before attach().
   */
  pump(pos) {
    if (this._disposed) return;
    this._frame++;
    this._lastFrameCommits = 0;
    const ranked = this._ranked(pos);
    const near = this._rankedNear(pos);
    const deadline = nowMs() + this.budgetMs;
    do {
      // AN IN-FLIGHT JOB IS NEVER ABANDONED. Dropping a partly-drawn atlas
      // because the player turned around is exactly how a placeholder becomes
      // permanent — the work is lost and nothing re-queues it. Finishing costs
      // at most one atlas of wasted drawing and removes that whole bug class.
      if (!this.job) this.job = this._pick(ranked, near);
      if (!this.job) break;
      // REAL POSTERS ARE DECODED, NOT DRAWN, so they cannot be produced inside a
      // synchronous chunk. Each atlas's images are kicked off once and the job
      // waits — parked, not spinning — until they have all settled. Parking is
      // what stops a tile being drawn from a half-loaded image and then never
      // corrected: nothing is committed until its art is final.
      // ART IS FETCHED PER CHUNK, NOT PER ATLAS.
      //
      // The job used to loadArtwork() all perAtlas titles and park until
      // EVERY one settled, so all 77 posters were decoded and held before a
      // single tile was blitted — measured at 51.5 MiB of transient decoded
      // artwork, on top of a resident set that was already bounded. Bounding
      // the cache never touched it.
      //
      // Now only the next CHUNK_TILES titles are fetched, drawn, and
      // released, so the transient peak is a chunk plus whatever is still in
      // flight. The property the original parking existed to guarantee is
      // unchanged: a tile is still never drawn from a half-loaded image,
      // because its own chunk is final before it is blitted.
      // ART IS FETCHED IN A SLIDING WINDOW AHEAD OF THE DRAW CURSOR.
      //
      // The job used to loadArtwork() every title in the atlas and park until
      // ALL of them settled, so 77 posters were decoded and held before a
      // single tile was blitted — measured at 51.5 MiB of transient decoded
      // artwork sitting on top of an already-bounded resident set. Bounding
      // the cache never touched it, which is why the phone still died.
      //
      // Now at most ART_WINDOW titles are outstanding, and each is released
      // as soon as its tile is blitted. The guarantee the original parking
      // existed for is unchanged: a tile is never drawn from a half-loaded
      // image, because its own window is final before it is used.
      if (this.job.fetchedTo === undefined) this.job.fetchedTo = this.job.next;
      if (this.job.fetchedTo - this.job.next < CHUNK_TILES && this.job.fetchedTo < this.job.total) {
        const base = this.job.atlas * this.plan.perAtlas;
        const upto = Math.min(this.job.fetchedTo + ART_WINDOW, this.job.total);
        const wait = loadArtwork(this.catalog.slice(base + this.job.fetchedTo, base + upto));
        this.job.fetchedTo = upto;
        // Captured LOCALLY, not read back off `this.job`: dispose() nulls
        // that field, and a stale completion must never touch a newer job.
        const job = this.job;
        if (wait) { job.waiting = true; wait.then(() => { if (!this._disposed && job === this.job) job.waiting = false; }); }
      }
      if (this.job.waiting) break;

      // SAFETY VALVE (hardening §9). A bad poster, an out-of-memory canvas or
      // a failed upload must degrade to "this atlas keeps its lower tier",
      // never throw out of the frame loop. Failures are counted per atlas and
      // backed off, so one unhappy atlas cannot become a retry storm either.
      let drew = 0;
      try {
        drew = drawAtlasTiles(
          this.catalog, this.plan, this.job.atlas, this.job.scale,
          this.job.canvas, this.job.next, CHUNK_TILES,
        // THE TILE CACHE IS A BASE-TIER CACHE ONLY. At base scale 0.125 a tile
        // is 36x21x4 = 3,024 B, so 48 MiB holds 16,644 of the 20,000 — ~83% of
        // the store, which is what makes a restock cheap. One detail tile is
        // 288x168x4 = 193,536 B: caching a single one would evict 64 base tiles
        // to keep a texture that is thrown away the moment the player walks on.
          this.job.tier === 'base' ? this.tileCache : null);
        this.job.next += drew;
        // RELEASE AS WE DRAW, not at commit. Holding a whole atlas's posters
        // until its texture was built peaked at 77 decoded images — 51.5 MiB
        // measured — for the entire time that atlas took to draw. A tile's
        // source is dead the moment it has been blitted, so the peak becomes
        // a chunk plus whatever is still in flight (~32 images, ~21 MiB).
        if (drew > 0) {
          const from = this.job.atlas * this.plan.perAtlas + (this.job.next - drew);
          releaseArtwork(this.catalog.slice(from, from + drew));
        }
        if (drew === 0 || this.job.next >= this.job.total) {
          this._commit(this.job, near);
          this._failures.delete(this.job.atlas);
          this.job = null;
          // Spend one upload permit and yield: the renderer must get the
          // frame back before another texture becomes upload-pending.
          if (this._lastFrameCommits >= this.maxCommitsPerFrame) break;
        }
      } catch (err) {
        const a = this.job?.atlas ?? -1;
        const n = (this._failures.get(a) ?? 0) + 1;
        this._failures.set(a, n);
        if (n === 1) console.warn(`cover atlas ${a}: ${this.job?.tier} failed, keeping the lower tier`, err);
        this.job = null;
        break;                       // yield the frame; the backoff decides when to retry
      }
    } while (nowMs() < deadline);

    // PIPELINE OVERLAP (title-loading repair). Profiled: 16% of the initial
    // drain the pump sat parked on the CURRENT atlas's art because fetching
    // only began when the atlas became the job. Warming exactly ONE atlas
    // ahead — the next live base candidate — lets its posters fetch and
    // decode while the current atlas draws. loadArtwork claims each id once,
    // so this can never double-fetch, and one atlas of Image handles (~77)
    // is the entire extra residency.
    if (!this.conserveImages && this.baseRemaining > 0 && (!this.job || !this.job.waiting)) {
      for (const { a } of ranked) {
        // A dirty atlas HAS a base texture and still needs a draw, so the
        // resident-base skip must not hide it — without the exception, every
        // late-merge redraw lost the pipeline overlap and re-paid the
        // parked-on-fetch stall this prefetch was measured to remove.
        if ((this.base[a] && !this._rescanDirty.has(a)) || (this.job && this.job.atlas === a)) continue;
        if (this.cases?.atlasVisible && !this.cases.atlasVisible(a)) continue;
        // AND NOT BACKED OFF. _pick's live() filters on visibility AND backoff;
        // this filtered on visibility alone, so a visible atlas that had failed
        // its five strikes was prefetched and then never picked to draw. Its
        // whole window — 77 decoded posters, ~51.5 MiB — was held for the rest
        // of the session with nothing left to release it, and baseRemaining
        // could never reach zero.
        if (this._backedOff(a)) continue;
        if (a !== this._prefetchedAtlas) {
          this._prefetchedAtlas = a;
          const from = a * this.plan.perAtlas;
          loadArtwork(this.catalog.slice(from, from + this.plan.perAtlas));
        }
        break;
      }
    }

    this._trim(near);
  }

  /**
   * Trim BOTH bounded tiers to STRICT caps. maxDetail and maxMid are real
   * ceilings, not targets the sets may overshoot: letting detail drift even a
   * few atlases over costs 16 MiB each, which is exactly the kind of "bounded in
   * principle" accounting that produced the 2.5 GB defect in the first place.
   * The stated ceiling and the observed peak are therefore the same number.
   *
   * Ranked against the NEAR field, on the same NEAR_R the query used, so trim
   * and _pick agree about what "far" means. Anything outside that radius has no
   * near rank at all and is treated as farthest.
   *
   * THE TILE CACHE NO LONGER ABSORBS THRASH HERE. It is base-tier only now (see
   * pump), so an atlas re-entering mid or detail is redrawn from scratch. What
   * bounds the cost instead is the frame budget: a re-entering atlas is drawn
   * CHUNK_TILES at a time inside budgetMs like anything else, so churn while
   * walking costs throughput, never a hitch, and the sets settle the moment the
   * player stops. Measured on the real layout there are ~25 atlases inside
   * DETAIL_R and ~31-46 inside MID_R, so detail (cap 6) does reshuffle as you
   * move along a shelf and mid (cap 40) is close to saturated and mostly does
   * not. Raising maxDetail to cover the whole DETAIL_R ring would cost 25 x
   * 16 MiB and is not on the table; this is the deliberate trade.
   */
  _trim(near) {
    this._trimTier(this.detail, this.maxDetail, near);
    this._trimTier(this.mid, this.maxMid, near);
  }

  _trimTier(tier, cap, near) {
    if (tier.size <= cap) return;
    const rankIdx = new Map();
    for (let i = 0; i < near.length; i++) rankIdx.set(near[i].a, i);
    // A finite sentinel, not Infinity: Infinity - Infinity is NaN and a
    // comparator that returns NaN has no defined ordering.
    const FAR = near.length + 1;
    const rankOf = (a) => (rankIdx.has(a) ? rankIdx.get(a) : FAR);
    const farthestFirst = [...tier.keys()].sort((a, b) => rankOf(b) - rankOf(a));
    for (const a of farthestFirst) {
      if (tier.size <= cap) break;
      // NEVER EVICT AN ATLAS WITH NO BASE TEXTURE. Eviction is supposed to lower
      // RESOLUTION; with nothing underneath it the case would drop back to the
      // placeholder, which is the "placeholder becomes permanent" failure the
      // tiers exist to prevent. Step (a) of _pick makes this unreachable in
      // practice — it is here so it stays unreachable.
      if (!this.base[a]) continue;
      const tex = tier.get(a);
      // _apply re-resolves through textureFor, so dropping mid falls back to
      // base and dropping detail falls back to mid if it is still resident.
      tier.delete(a);
      // _apply FIRST: the mesh must stop pointing at this texture before it is
      // parked, or a later reuse would repaint a shelf that still references it.
      this._apply(a);
      this._release(tex);
    }
  }

  /** Resident bytes, for proving the memory target rather than assuming it. */
  stats() {
    let baseBytes = 0, baseCount = 0;
    for (const t of this.base) if (t) { baseBytes += bytesOf(t); baseCount++; }
    let detailBytes = 0;
    for (const t of this.detail.values()) detailBytes += bytesOf(t);
    // MID IS COUNTED. A tier missing from stats() is a tier missing from the
    // ceiling, and the ceiling is only worth anything if every resident byte is
    // in it — see the ledger at the top of this file.
    let midBytes = 0;
    for (const t of this.mid.values()) midBytes += bytesOf(t);
    return {
      atlases: this.plan.count,
      baseCount, baseBytes,
      midCount: this.mid.size, midBytes,
      detailCount: this.detail.size, detailBytes,
      tileCacheBytes: this.tileCache.bytes,
      totalBytes: baseBytes + midBytes + detailBytes + this.tileCache.bytes + bytesOf(this.placeholder),
      baseComplete: this.baseComplete,
      inFlight: this.job ? { atlas: this.job.atlas, tier: this.job.tier, done: this.job.next, of: this.job.total } : null,
    };
  }

  dispose() {
    if (this._disposed) return;      // double-dispose would re-dispose freed textures
    this._disposed = true;
    // COUNTED. texDisposed previously incremented at only the two pool-overflow
    // sites in _release(), so a teardown disposing hundreds of textures was
    // invisible to the ledger — and "created 52 / disposed 0" then read as a
    // leak when it was the intended resident set. Every dispose is counted now,
    // so created - disposed - pooled must equal what is resident.
    for (const t of this.base) if (t) { gpuMetrics.texDisposed++; t.dispose(); }
    for (const t of this.mid.values()) { gpuMetrics.texDisposed++; t.dispose(); }
    for (const t of this.detail.values()) { gpuMetrics.texDisposed++; t.dispose(); }
    for (const list of this._pool.values()) for (const t of list) { gpuMetrics.texDisposed++; t.dispose(); }
    this._pool.clear();
    gpuMetrics.texDisposed++;
    this.placeholder.dispose();
    this.base.length = 0;
    this.mid.clear();
    this.detail.clear();
    // RELEASE THE IN-FLIGHT DECODE WINDOW. dispose() freed every GPU texture
    // but left this generation's decoded posters held in the module-global
    // artwork map, where they kept both heap and slots in the image semaphore
    // that the REPLACEMENT streamer immediately needs. A restock therefore
    // paid for two generations of decoded artwork at the one moment it was
    // trying hardest not to.
    if (this.job) {
      const base = this.job.atlas * this.plan.perAtlas;
      const upto = this.job.fetchedTo ?? this.job.next ?? 0;
      if (upto > 0) releaseArtwork(this.catalog.slice(base, base + upto));
    }
    this.job = null;
    this.cases = null;
  }
}
