// TapeBuster bootstrap — master catalog → user-store projection → world.
// The building is permanent; the STOCK is a projection of the user's selected
// streaming services, and changing services restocks the shelves in place.
import * as THREE from 'three';
import { WORLD } from './config.js';
import { CATALOG, BY_ID, SNAPSHOT } from './data/catalog.js';
import { ensureDetail, applyDetail, preloadDetail, pruneDetail, detailStats } from './data/detail.js';
import { validateCatalog, validateLayout } from './data/validate.js';
import { buildProjection, buildCuration, isEligible } from './data/projection.js';
import { buildLayout, spatialCoverOrder } from './world/layout.js';
import { buildNav } from './systems/pathfind.js';
import { CoverStreamer, TileCache } from './world/covers.js';
import { setArtworkManifest, mergeArtworkManifest, hasArtwork, preloadPosterArt, setMaxAnisotropy, artworkStats, artworkMetrics, setArtworkEnabled } from './world/textures.js';
import { buildStore } from './world/store.js';
import { configureTextureBudget, textureBudgetStats } from './world/texture-budget.js';
import { deviceProfile } from './systems/device.js';
import { buildMezzanine } from './world/mezzanine.js';
import { buildLighting, enableShadows, fitShadowToStore } from './world/lighting.js';
import { CaseSystem } from './world/cases.js';
import { Player } from './systems/player.js';
import { Input } from './systems/input.js';
import { Inspector } from './systems/inspect.js';
import { Interactions } from './systems/interact.js';
import { StoreAudio } from './systems/audio.js';
import { slotVisible } from './systems/occupancy.js';
import { loadLedger, saveLedger, recordExposure, selectVisitStock } from './data/rotation.js';
import { ModeManager } from './systems/modes.js';
import { FrameGovernor, cooperativePump } from './systems/pressure.js';
import { RING_COLS, C } from './systems/crash-schema.js';
import { NPCSystem } from './world/npc.js';
import { UI } from './ui/ui.js';

// Crash breadcrumb (see onboard.js): Safari's jetsam kill leaves no trace,
// so the last stamp BEFORE the kill is the diagnosis, delivered by the next
// load. Cheap enough to stamp everywhere.
const crumb = (s) => {
  try { localStorage.setItem('tb_bootcrumb', `${s}@${Math.round(performance.now() / 1000)}s`); }
  catch { /* storage full — forensics degrade silently */ }
};
// GLOBAL ERROR CAPTURE — installed at module scope, before boot() runs.
//
// There was no window.onerror and no unhandledrejection handler anywhere in
// src/ or index.html. boot().catch() covers boot and nothing else, so every
// rejection after frame() started vanished silently — and 24 of the 38 catch
// blocks in src/ are comment-only swallows. When the user said "find the
// actual error", there was no mechanism that could have recorded one.
//
// Persisted, because the session that sees the error is the one AFTER the
// tab was killed. Bounded to the last error and truncated: this must never be
// the reason storage fills.
const NEWLINE_RE = new RegExp('\r?\n');
const recordError = (kind, msg, where) => {
  try {
    const line = `${kind}: ${String(msg ?? '').slice(0, 300)}${where ? ` @ ${where}` : ''} ` +
      `[t=${Math.round(performance.now() / 1000)}s]`;
    localStorage.setItem('tb_lasterror', line);
    const n = (+localStorage.getItem('tb_errcount') || 0) + 1;
    localStorage.setItem('tb_errcount', String(n));
  } catch { /* storage full — forensics degrade, the store does not */ }
};
addEventListener('error', (e) => {
  recordError('error', e.message || e.error?.message, e.filename ? `${e.filename}:${e.lineno}` : '');
});
addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  const at = typeof r?.stack === 'string' ? r.stack.split(/\r?\n/)[1]?.trim() : '';
  recordError('unhandledrejection', r?.message ?? r?.toString?.() ?? String(r), at);
});
// A lost WebGL context is not an exception but it is the same class of event.
addEventListener('webglcontextlost', () => recordError('webglcontextlost', 'renderer context lost'), true);

// THE LOADING SCREEN ANSWERS ONE QUESTION: how close am I to playing?
//
// It used to answer a different one — "what is the engine doing" — with lines
// like "Dressing the aisle you are standing in 0 of 35". Nobody outside this
// repository knows what an atlas is, and a counter that starts at 0 of 35 and
// moves slowly reads as broken rather than busy.
//
// So: one number, one short sentence, and a note about first load. The
// percentage is the SAME value that drives the bar, so the two can never
// disagree, and it is monotonic by construction below.
let lastPct = 0;
let lastPctAt = 0;
const status = (t, pct) => {
  document.getElementById('load-status').textContent = t;
  if (pct != null) {
    // Never let the bar go backwards. Two boot paths can report out of order
    // on a fast machine, and a bar that retreats is worse than one that pauses.
    const p = Math.max(lastPct, Math.min(1, pct));
    if (p > lastPct) { lastPct = p; lastPctAt = performance.now(); }
    document.getElementById('load-fill').style.width = `${Math.round(p * 100)}%`;
    const el = document.getElementById('load-pct');
    if (el) el.textContent = ` ${Math.round(p * 100)}%`;
  }
  // BOOT INSTRUMENTATION (phase-3 directive §20-21): every stage stamps time
  // and heap, so time-to-walk and startup memory are measured, never guessed.
  // Read via TB.bootStages() or window.__stages in QA.
  (window.__stages ??= []).push({
    stage: t || 'gate',
    t: +(performance.now() / 1000).toFixed(2),
    heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : null,
  });
  crumb(t || 'gate');
};
const nextFrame = () => new Promise(r => {
  const t = setTimeout(r, 90);
  requestAnimationFrame(() => { clearTimeout(t); r(); });
});

async function boot() {
  const isMobileDevice = matchMedia('(pointer: coarse)').matches && Math.min(innerWidth, innerHeight) < 860;
  // DIAGNOSTIC ISOLATION KNOBS — default off, nothing permanent, read once.
  //   ?radio=off  no automatic radio start
  //   ?drain=off  no cover hydration at all
  //   ?tiers=base base covers only: no mid/detail, the tiers that churn as
  //               you WALK. Reported symptom is "dies after a few steps",
  //               which is exactly when the near field changes and those
  //               tiers allocate and evict GPU textures.
  //   ?art=off     posters are never fetched or decoded, but atlases are still
  //                drawn and uploaded — the difference from ?drain=off, which
  //                stops hydration entirely. Together they separate network +
  //                decode from canvas drawing + GL upload.
  //   ?npc=off     no customers
  //   ?shadows=off no shadow map at all
  //   ?detail=off  no cast/synopsis corpus (55 MB of JSON)
  const diag = new URLSearchParams(location.search);
  const noRadio = diag.get('radio') === 'off';
  const noDrain = diag.get('drain') === 'off';
  const baseTiersOnly = diag.get('tiers') === 'base';
  const noArt = diag.get('art') === 'off';
  const noNpc = diag.get('npc') === 'off';
  const noShadows = diag.get('shadows') === 'off';
  const noDetail = diag.get('detail') === 'off';
  if (noArt) setArtworkEnabled(false);
  const diagFlags = { noRadio, noDrain, baseTiersOnly, noArt, noNpc, noShadows, noDetail };
  const modes = new ModeManager();
  // COVER RESOLUTION TIERS (see world/covers.js for the full ledger).
  //   detail = the shelf you are standing at and reading
  //   mid    = the shelves you are walking past — this is the tier that fixed
  //            "everything is blurry until you click it"
  //   base   = every other case in the building
  // Phones get half the detail resolution and much smaller counts.
  //
  // THE BUDGET IS REBALANCED, AND NO DISTANCE IS WORSE THAN BEFORE.
  //
  // The first cut of this spent base down to 64 MiB (0.125, a 13.5-texel cover
  // front) to fund mid and detail. Near the player that was a huge win, but a
  // 13.5-texel cover is only adequate beyond 16 m while the old 0.1875 base was
  // adequate beyond 10.7 m — so everything from MID_R out to ~16 m came back
  // SOFTER than before the LOD work. That is the complaint relocated, not fixed,
  // and it is why TILE.h is now 176: it restores 0.1875 as a legal base scale.
  //
  //   distance          before        first cut      now
  //   0-2 m (reading)   20.3 texels   108            108
  //   2-4 m (aisle)     20.3          54             54
  //   4-6 m             20.3          54             54
  //   6-16 m (down)     20.3          13.5  WORSE    20.3
  //   16 m+             adequate      adequate       adequate
  //
  //   base       260 x 384^2 x 4  = 146.3 MiB   (chooseBaseScale(260, 220 MiB) === 0.1875)
  //   mid         24 x 1024^2 x 4 =  96.0 MiB
  //   detail       6 x 2048^2 x 4 =  96.0 MiB
  //   tileCache                     48.0 MiB
  //   placeholder                    0.25 MiB
  //                                ---------
  //                                386.5 MiB in covers.stats() terms
  // Mips apply to the three TEXTURE tiers (+1/3), not to the tile cache, which
  // is canvases on the JS heap: ~451 MiB of GPU texture plus 48 MiB of heap.
  // Against 374.7 MiB in the same stats() terms before any of this — i.e.
  // +11.8 MiB for a tier system that is 5x sharper at reading distance and no
  // worse at any distance. covers.stats() reports every line, so the ceiling is
  // checkable rather than asserted, and it has been measured equal to it.
  const detailScale = isMobileDevice ? 0.5 : 1;
  const maxDetail = baseTiersOnly ? 0 : (isMobileDevice ? 2 : 6);
  const midScale = isMobileDevice ? 0.25 : 0.5;
  const maxMid = baseTiersOnly ? 0 : (isMobileDevice ? 8 : 24);
  // Base resolution is chosen from this budget rather than fixed, so raising
  // STORE_CAPACITY trades distant sharpness instead of blowing the ceiling.
  const baseBudgetBytes = (isMobileDevice ? 68 : 220) * 1024 * 1024;
  // Bounded by BYTES. The old unbounded Map held one tile canvas per title
  // forever — 2.4 GB of JS heap at 15,000 titles, invisible to any GPU-side
  // accounting.
  const tileCache = new TileCache(isMobileDevice ? 16 * 1024 * 1024 : 48 * 1024 * 1024);

  status('Preparing the store', 0.06);
  await nextFrame();
  const validation = validateCatalog(CATALOG);
  if (validation.errors.length) {
    console.error('CATALOG VALIDATION FAILED:', validation.errors);
    throw new Error(`catalog validation: ${validation.errors.length} error(s). ${validation.errors[0]}`);
  }
  console.info(`master catalog: ${validation.stats.titles} canonical titles (${validation.stats.movies} movies, ${validation.stats.series} series) · ${validation.stats.duplicates} duplicates`);

  // persisted personalization (read before the UI exists)
  let myServices;
  try { myServices = new Set(JSON.parse(localStorage.getItem('tb_services') || '[]')); }
  catch { myServices = new Set(); }
  // NOT const: restock re-reads the live UI state, otherwise the store would
  // rebuild forever with the boot-time mode and never personalize.
  let svcFilter = localStorage.getItem('tb_filter') || 'all';
  // INVENTORY MODE (inventory-mode directive §3): 'services' = MY SERVICES
  // ONLY (eligibility constrains the active inventory), 'full' = FULL STORE +
  // DISCOVERY (the phase-4 dense store). Defaults to 'services' because that
  // is what the onboarding promises — "Your store stocks what you can watch"
  // (§15) — and the user can flip it in Settings at any time.
  let invMode = localStorage.getItem('tb_inv_mode') === 'full' ? 'full' : 'services';
  // Titles the shopper special-ordered this session (STOCK IT & GO). They
  // ride the protected path: forced into every subsequent selection and
  // visible even in MY SERVICES ONLY — the clerk promised to bring them out.
  const sessionOrders = new Set();

  // ---- world-state: everything that changes when the projection changes
  const world = {};
  world.diag = diagFlags;                   // declared above; published here
  // QA override for physical capacity, alongside the existing ?debug flag. Boot
  // cost scales with the STOCKED count (cover atlases, case meshes, colliders),
  // so being able to raise the building at a smaller size is what makes the shop
  // floor testable at all — and lets capacity be measured rather than guessed.
  // Capacity override: the ?capacity= QA param, or the LIGHTER STORE the
  // shopper chose after a crash (tb_capacity). The store's scale is never
  // reduced silently — this value only exists because a human picked it on
  // the welcome screen after their device ran out of memory, and Settings
  // offers the full build back.
  const capacityOverride = Number(new URLSearchParams(location.search).get('capacity'))
    || Number(localStorage.getItem('tb_capacity')) || null;
  const buildWorldData = (include = null, seedBump = 0) => {
    // MODE -> RANKING FOCUS. 'all' is THE STORE (no focus); 'mine' ranks by every
    // service you hold; a provider name ranks by that one alone. All three
    // merchandise the same universe — focus only reorders within capacity, which
    // is why a provider mode can pass a single-service set without shrinking the
    // building. Mapping a provider name to 'all' (as this once did) silently
    // threw the focus away and made provider mode identical to THE STORE.
    const focus = svcFilter === 'all' ? new Set()
      : svcFilter === 'mine' ? myServices
        : (myServices.has(svcFilter) ? new Set([svcFilter]) : myServices);
    world.projection = buildProjection(CATALOG, focus, focus.size ? 'mine' : 'all',
      { include, seed: 7 + seedBump, ...(capacityOverride ? { capacity: capacityOverride } : {}) });
    // Curated endcaps prefer titles the user can actually watch (§8 —
    // MY SERVICES is placement priority now that every stocked tier renders).
    const curationRelevant = world.projection.personalized
      ? new Set(world.projection.eligible.map(t => t.id)) : null;
    world.curation = buildCuration(world.projection.stocked, 11, curationRelevant);
    world.layout = buildLayout(world.projection.stocked, world.curation);
    const lv = validateLayout(world.layout, world.projection.stocked);
    if (lv.errors.length) {
      console.error('LAYOUT VALIDATION FAILED:', lv.errors);
      throw new Error(`layout validation: ${lv.errors[0]}`);
    }
    world.layoutStats = lv.stats;

    // BOOT GATE — MEMBERSHIP CORRECTNESS.
    //
    // This replaces the old "projection leakage" gate, which refused to boot if
    // a physical case existed for a title the user could not watch. That gate
    // enforced the obsolete architecture: it made availability decide membership,
    // so selecting Netflix deleted every Max-only title from the building. A
    // case for an unwatchable title is now INTENTIONAL MERCHANDISING, not a leak.
    //
    // What is worth gating is the opposite direction: every physical case must
    // reference a real catalogue record. That catches orphaned stock, which is a
    // genuine corruption, without asserting anything about watchability.
    const orphan = world.layout.slots.find(s => !BY_ID.has(s.titleId));
    if (orphan) {
      throw new Error(`orphaned physical case: slot ${orphan.id} references ${orphan.titleId}, which is not in the catalogue`);
    }

    world.nav = buildNav(world.layout);
    world.byId = new Map(CATALOG.map(t => [t.id, t]));

    // AVAILABILITY AS A SEPARATE OUTPUT FROM MEMBERSHIP.
    //
    // THE STORE ranks by nothing, so its projection is unpersonalized and its
    // `stats.eligible` is the whole catalogue — a membership figure, NOT an
    // availability answer. The chip still owes the user both numbers in that
    // mode, so the availability count is produced here, against every service
    // they hold, from the same single authority the projection uses
    // (watchability.js, via isEligible).
    //
    // It is computed HERE and not in the UI on purpose: the UI consumes
    // membership and availability as two given values and reconstructs neither.
    // Memoized on the service set because that is its only input — remounting
    // the building must not re-walk 122,948 rows.
    const key = [...myServices].sort().join('|');
    if (myServices.size === 0) world.availability = null;
    else if (world.availability?.key !== key) {
      let count = 0;
      for (const t of CATALOG) if (isEligible(t, myServices)) count++;
      world.availability = { key, services: [...myServices], count };
    }
  };

  // REAL COVER ARTWORK, OFF THE BLOCKING PATH.
  //
  // This used to be `await fetch(manifest.json)` — the whole catalogue's image
  // ids, ~2.9 MB gzipped, downloaded and parsed before the loading bar reached
  // 16%, serialized ahead of every later boot step. But nothing READS the
  // manifest until the wall-poster preload, and the first heavy consumer is
  // the dressing pump — both far past seconds of pure CPU (catalogue decode,
  // projection, layout, meshes) that the download can hide behind.
  //
  // So both fetches are KICKED here and awaited never-or-later:
  //   manifest-boot.json  the certified seed-7 stock slice, ~0.5 MB gz —
  //                       awaited (artBootReady) just before the wall-poster
  //                       preload, by which point it has usually long landed.
  //   manifest.json       the full catalogue, downloading alongside worldgen;
  //                       on arrival it MERGES, and covers.rescanArtwork
  //                       re-queues any atlas already blitted with a sleeve
  //                       where a real poster now exists.
  //
  // Dev serves src/ verbatim, where only the full manifest exists: the boot
  // fetch 404s and artBootReady falls back to awaiting the full one — the
  // old behaviour, on the one environment where the file is local anyway.
  // Absent both = the artwork pass has not run; covers fall back to the
  // generated treatment rather than failing.
  // EVERY APPLICATION IS A MERGE, NEVER A REPLACEMENT. The two fetches race,
  // and the order is not guaranteed: a cached full manifest can resolve
  // BEFORE the boot slice. With plain setArtworkManifest here, that ordering
  // installed the full 107k-id map and then OVERWROTE it with the 18k slice —
  // and since the full fetch's merge had already fired, nothing would ever
  // restore it. mergeArtworkManifest sets when empty and only ADDS otherwise,
  // so both orders converge on the same final map.
  const fetchJson = (url) => fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  // ONE RETRY FOR THE FULL MANIFEST, WITH A BREADCRUMB. Without it, a single
  // transient 500 or a truncated body silently stranded the whole session on
  // the 18k boot slice — no log line, no second attempt, nothing for a bug
  // report to contain.
  const fetchFull = async () => {
    let m = await fetchJson('src/data/artwork/manifest.json');
    if (!m?.ids) {
      console.warn('cover artwork: full manifest failed to load, retrying once in 15s');
      await new Promise((r) => setTimeout(r, 15000));
      m = await fetchJson('src/data/artwork/manifest.json?retry=1');
    }
    if (!m?.ids) console.warn('cover artwork: full manifest unavailable, running on the boot slice for this session');
    return m?.ids ? m : null;
  };
  const fullArt = fetchFull();
  // EVERY HANDLER BODY IS GUARDED. artBootReady is awaited on the serial boot
  // path, so a rejection here — a 200 serving an error page as JSON, a shape
  // surprise — would take the whole boot down for a cosmetic subsystem.
  const artBootReady = fetchJson('src/data/artwork/manifest-boot.json').then(async (boot) => {
    try {
      if (boot?.ids) {
        mergeArtworkManifest(boot);
        console.info(`cover artwork: ${Object.keys(boot.ids).length.toLocaleString()} boot posters (${boot.source}), full catalogue merging in background`);
        return boot;
      }
      const m = await fullArt;
      if (m) {
        mergeArtworkManifest(m);
        console.info(`cover artwork: ${Object.keys(m.ids).length.toLocaleString()} real posters (${m.source})`);
      } else console.info('cover artwork: no manifest, using generated covers');
      return null;
    } catch (e) { console.warn('cover artwork: boot manifest failed, covers degrade gracefully', e); return null; }
  });
  // BACKDROPS ARE NOT FETCHED HERE AT ALL. The index for the case backs is
  // 2.64 MB gzipped and answers one question — what goes on the reverse of a
  // case in the shopper's HANDS — so textures.js pulls it on the first
  // pick-up and never before. Downloading it during worldgen would have it
  // racing the poster manifest for bandwidth to dress a face nobody has
  // looked at yet, and a shopper who only ever walks the aisles would pay for
  // it and never see it.
  Promise.all([fullArt, artBootReady]).then(async ([m, boot]) => {
    try {
      if (!m) return;
      // CROSS-DEPLOY SKEW. Pages caches both files for up to 10 minutes, so
      // just after a deploy one of the two can be a different build than the
      // other — and an add-only merge of a STALE full manifest would
      // resurrect ids the new build deliberately removed (a newly-ambiguous
      // mapping, for instance: precisely the confidently-wrong cover the
      // ambiguity system exists to refuse). On a generation mismatch, refetch
      // the full manifest around the cache once and treat what returns as the
      // whole truth.
      if (boot?.generation && m.generation && boot.generation !== m.generation) {
        console.warn(`cover artwork: manifest generations differ (${boot.generation} vs ${m.generation}), refetching around the cache`);
        m = (await fetchJson(`src/data/artwork/manifest.json?g=${encodeURIComponent(m.generation)}`)) ?? m;
        // WHOLESALE, because either file may have been the stale one: if the
        // BOOT slice was cached from the previous build, its merge already
        // planted ids the new build removed, and an add-only merge cannot
        // take them back. The refetched full manifest is the one document
        // known current, so it becomes the entire truth: replace the map and
        // re-queue every drawn atlas against it.
        setArtworkManifest(m);
        const requeuedAll = world.covers?.rescanArtwork(Object.keys(m.ids)) ?? 0;
        console.info(`cover artwork: reconciled to generation ${m.generation}${requeuedAll ? `, ${requeuedAll} atlases re-queued` : ''}`);
        return;
      }
      const gained = mergeArtworkManifest(m);
      // covers may not exist yet — then there is nothing drawn to re-queue,
      // and everything drawn later reads the merged map anyway.
      const requeued = gained.length ? (world.covers?.rescanArtwork(gained) ?? 0) : 0;
      if (gained.length) console.info(`cover artwork: full manifest merged, +${gained.length.toLocaleString()} titles${requeued ? `, ${requeued} atlases re-queued` : ''}`);
    } catch (e) { console.warn('cover artwork: full-manifest merge failed', e); }
  });

  status('Preparing the store', 0.16);
  await nextFrame();
  // ---- LIVING INVENTORY (session-H design, user-specified) -----------------
  // The building is permanent; the INVENTORY rotates. Each visit bumps a
  // counter whose value seeds the discretionary remainder of the stock, while
  // a persistent core — the certified seed-7 selection's head, which is also
  // exactly the slice the shipped poster subset covers — keeps ~60% of the
  // shelves familiar. Same walk, different discoveries, stable mental map.
  const visitN = (+(localStorage.getItem('tb_visit') ?? 0) + 1) | 0;
  localStorage.setItem('tb_visit', String(visitN));
  let rotationCore = null;
  try {
    const cached = localStorage.getItem('tb_core_v1');
    if (cached) rotationCore = cached.split(',');
  } catch { /* storage full or absent — recompute below */ }
  if (!rotationCore || rotationCore.length < 1000) {
    const base = buildProjection(CATALOG, new Set(), 'all', { seed: 7 });
    rotationCore = base.stocked.slice(0, 12000).map(t => t.id);
    try { localStorage.setItem('tb_core_v1', rotationCore.join(',')); } catch { /* best effort */ }
  }
  // PROTECTED INVENTORY (hard requirement): anything in the persisted stack
  // is pinned into stock ahead of everything else — service filtering,
  // rotation, and reseeding may never evict a title the user deliberately
  // saved. Access labels stay honest; protection keeps it IN THE STORE, it
  // does not pretend you can watch it.
  const stackProtectedIds = () => {
    try { return (JSON.parse(localStorage.getItem('tb_stack') || '[]')).map(e => e.titleId).filter(Boolean); }
    catch { return []; }
  };
  // Session merchandising with MEMORY: the exposure ledger penalises what you
  // saw recently, promotes what has been off the floor, and gives never-seen
  // titles a discovery bonus — the whole visit membership is computed here and
  // FORCED through include, so the frozen librarian only shelves and ranks it.
  //
  // ONE MEMBERSHIP FUNCTION FOR BOOT AND RESTOCK (inventory-mode audit
  // finding): restock() used to call buildWorldData(include=null), which
  // dropped the visit selection, the ledger AND stack protection on every
  // in-store service change — after which a stack title survived by
  // allocator rank-luck. Both paths now route through here; within a visit
  // the seed is fixed, so a restock is deterministic and continuous rather
  // than a reshuffle.
  const ledger = loadLedger(localStorage);
  const computeVisitStock = () => selectVisitStock({
    catalog: CATALOG, coreIds: rotationCore,
    protectedIds: [...stackProtectedIds(), ...sessionOrders],
    services: myServices, strict: svcFilter !== 'all' && myServices.size > 0,
    ledger, visitN, seed: visitN * 131,
  });
  buildWorldData(computeVisitStock(), visitN * 131);
  // this visit is now on the record — face-outs count double for freshness.
  // Only VISIBLE titles are recorded: in MY SERVICES ONLY the hidden
  // discovery slice was never on the floor, and "remembering" it would
  // wrongly tax its freshness for future FULL STORE visits.
  {
    const faceIds = new Set();
    for (const slot of world.layout.slotById.values()) if (!slot.spineOut) faceIds.add(slot.titleId);
    const expOpt = {
      strict: svcFilter !== 'all' && myServices.size > 0, services: myServices,
      protectedIds: new Set(stackProtectedIds()), inventoryMode: invMode,
    };
    const exposed = world.projection.stocked.filter(t => slotVisible(t, expOpt)).map(t => t.id);
    recordExposure(ledger, exposed, faceIds, visitN);
    saveLedger(localStorage, ledger, visitN);
  }
  console.info(`projection: ${world.projection.stats.eligible} eligible → ${world.projection.stats.stocked} stocked (${world.projection.personalized ? [...myServices].join('+') : 'ALL TITLES'})`);

  status('Preparing the store', 0.26);
  await nextFrame();
  const canvas = document.getElementById('scene');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  // Shadows are what stop the store reading as a diagram of a store: without a
  // contact shadow under each case, nothing sits ON anything. One directional
  // caster, soft-filtered; phones get a smaller map rather than none, because
  // losing grounding costs more than the fill rate saves.
  renderer.shadowMap.enabled = !(new URLSearchParams(location.search).get('shadows') === 'off');
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // Fill rate is the single biggest frame cost on a large canvas: DPR 2 is
  // 2.56x the pixels of DPR 1.25. AUTO keeps the old sniffed caps; SMOOTH is
  // the explicit escape hatch for machines where the store feels laggy.
  // reads STORAGE, not the ui object: this runs at renderer construction,
  // long before `let ui` initialises, and setQuality persists before applying
  const quality = () => localStorage.getItem('tb_quality') || 'auto';
  const dprCap = () => {
    const q = quality();
    return q === 'smooth' ? 1.25 : q === 'sharp' ? 2 : (isMobileDevice ? 1.8 : 2);
  };
  renderer.setPixelRatio(Math.min(devicePixelRatio, dprCap()));
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // ANISOTROPY, DECIDED ONCE FROM THE REAL HARDWARE. A shelf is seen down an
  // aisle at a grazing angle, which is the case isotropic mip selection handles
  // worst — it picks a level sized for the compressed axis and the covers go to
  // mush. Capped at 8: beyond that the sampling cost climbs and the return on a
  // 2:3 poster is nil. Set before any cover texture exists, so every one of them
  // (shelf batches and the inspector mesh alike) is built with it.
  setMaxAnisotropy(Math.min(8, renderer.capabilities.getMaxAnisotropy()));

  // THE STATIC TEXTURE BUDGET, DECIDED BEFORE ANY WORLD GEOMETRY EXISTS.
  //
  // Measured with scripts/qa/scene-census.mjs: the generated (non-cover)
  // texture set was 134.4 MiB on mobile and 134.6 MiB on desktop — bigger than
  // the phone's entire metered cover budget, and with no device profile at all.
  // It also contained a 5920 x 252 wall texture, which simply does not upload
  // on a device whose MAX_TEXTURE_SIZE is 4096. Both facts are policy, so both
  // are decided here, once, from the real hardware.
  world.textureBudget = configureTextureBudget({
    mobile: isMobileDevice,
    maxTextureSize: renderer.capabilities.maxTextureSize,
  });

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(WORLD.baseFov, innerWidth / innerHeight, 0.05, 90);
  scene.add(camera);
  const lights = buildLighting(scene);

  status('Building the shelves', 0.40);
  await nextFrame();
  // The shell is rebuilt whenever the projection changes the building's SIZE.
  // Since layout.js began generating aisles (and the store depth) from the
  // stocked list, the walls, floor, ceiling and slab are projection-dependent
  // too — leaving them at boot size while colliders and navigation moved would
  // put solid geometry where the player can walk and open walls onto the void.
  const disposeTree = (root) => root.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
      if (!m) continue;
      for (const k of ['map', 'emissiveMap', 'normalMap', 'roughnessMap', 'alphaMap']) m[k]?.dispose?.();
      m.dispose();
    }
  });

  let shell = null;
  const buildShell = () => {
    if (shell) for (const o of shell.roots) { scene.remove(o); disposeTree(o); }
    // store.js and mezzanine.js add straight to the scene, so the shell's roots
    // are whatever they appended — diffing avoids threading a group through two
    // files that are otherwise none of this change's business.
    const before = new Set(scene.children);
    const built = buildStore(scene, world.layout, world.projection.stocked, world.curation);
    const m = buildMezzanine(scene, world.layout);
    fitShadowToStore(lights.key);
    shell = {
      halfD: WORLD.halfD,
      roots: scene.children.filter(c => !before.has(c)),
      raycastTargets: [...built.raycastTargets, ...m.raycastTargets],
      flickerPanel: built.flickerPanel,
      // The escalator steps and handrails animate, and they are REBUILT with the
      // shell — so the frame loop has to reach the current mezzanine through
      // `shell`, never a binding captured once at boot.
      mezz: m,
    };
    return shell;
  };
  // Wall posters and standees are PRINTED AT SHELL-BUILD TIME, so their artwork
  // has to be decoded before the shell goes up — otherwise the walls fall back
  // while the shelves in front of them show the real thing. Only a few dozen
  // spots exist, but they are picked from the curated lists, so the curated ids
  // are what gets preloaded.
  {
    // FIRST MANIFEST CONSUMER. The boot slice was kicked at the top of boot
    // and has been downloading behind seconds of worldgen CPU; this await is
    // the one place the boot path genuinely needs it.
    await artBootReady;
    const ids = new Set(Object.values(world.curation || {}).flat());
    const wanted = world.projection.stocked.filter(t => ids.has(t.id));
    // WALL POSTERS ARE ONE-SHOT: printed at shell build, never repainted. On
    // a rotated visit some curated picks sit outside the boot slice, and
    // without this they would wear the generated treatment for the WHOLE
    // session even though the full manifest landed seconds later. So when the
    // slice does not cover every wall pick, give the full manifest a bounded
    // moment to arrive - it usually already has - and never more than 1.5 s:
    // walls must not re-grow the very stall this split removed.
    if (wanted.some(t => !hasArtwork(t.id))) {
      await Promise.race([fullArt, new Promise(r => setTimeout(r, 1500))]);
    }
    const wait = preloadPosterArt(wanted);
    if (wait) await wait;
  }
  // flickerPanel is deliberately NOT destructured: buildShell() replaces it on
  // every size-changing restock and disposes the old one's material, so a
  // binding captured here would animate a dead material while the new panel
  // never flickered. Read shell.flickerPanel at use. raycastTargets is safe —
  // buildShell mutates that array in place.
  const { raycastTargets } = buildShell();

  // Cheap guard: only re-fit when the player has actually moved a few metres.
  let lastShadowFocus = { x: Infinity, z: Infinity };
  const refitShadow = () => {
    if (Math.hypot(player.x - lastShadowFocus.x, player.z - lastShadowFocus.z) < 3) return;
    lastShadowFocus = { x: player.x, z: player.z };
    fitShadowToStore(lights.key, lastShadowFocus, { low: quality() === 'smooth' });
  };

  status('Building the shelves', 0.52);
  await nextFrame();
  // Cover art prints cast, director and the back-of-box blurb, so the detail
  // shards for everything on a shelf must be resident first. Only the stocked
  // titles are needed — a few hundred, not the whole catalogue.
  // PROGRESSIVE HYDRATION (phase-3 §14): the old line here awaited detail
  // shards for all 20,000 stocked titles before anyone could enter. Measured:
  // 1.4 s and ~60 MB on desktop, several times that on a phone. Now only the
  // spawn neighbourhood hydrates before entry; the rest streams in idle
  // chunks after the player is already walking, and the title card hydrates
  // any straggler on demand.
  const spawn = world.layout.spawn;
  const nearIds = [], farIds = [];
  for (const [titleId, rec] of world.layout.titles) {
    const s0 = world.layout.slotById.get(rec.primarySlotId);
    const near = s0 && s0.level === 0 && Math.hypot(s0.x - spawn.x, s0.z - spawn.z) < 28;
    (near ? nearIds : farIds).push(titleId);
  }
  // PHONES DO NOT LOAD THE DETAIL CORPUS BEFORE ENTRY.
  //
  // shardOf() hashes the id, so the 2,473 near titles touch 64 of 64 shards:
  // this one await pulls all 122,948 records. Measured on the mobile profile
  // (scripts/qa/tmp/boot-peak.mjs), at the exact moment the device reported
  // "dressing the shelves @ 4s":
  //
  //     catalogue snapshots     111.3 MiB heap
  //     layout (61k slots)      145.4
  //     detail corpus           248.0   <- +102.5 MiB, the boot PEAK
  //     after pruneDetail       164.9   <- -83.7, but the spike already happened
  //
  // Pruning afterwards fixes the floor and does nothing for the peak, and the
  // peak is what a jetsam kill measures. This is also what this file's own
  // policy already said phones should do — see the preloadDetail() call, which
  // skips the bulk warm-up because "~20 MB of blurbs is not worth the memory
  // there" and relies on ensureDetail() fetching on demand for whatever the
  // shopper actually opens.
  //
  // The cost is cosmetic and small: cast and blurb are printed onto the
  // FALLBACK sleeve, which is only drawn for a title with no real poster, and
  // the deployment ships 74,538 of those for a 20,000-title store.
  if (!noDetail && !isMobileDevice) await ensureDetail(nearIds);
  applyDetail(world.projection.stocked);
  // RECLAIM THE 83.5% THAT IS NEVER READ.
  //
  // The await above cannot be narrowed: shardOf() hashes the id, so the 2,473
  // near titles touch 64/64 shards and pull all 122,948 records. Rather than
  // fight that, keep the 20,000 stocked ones — applyDetail has already copied
  // what the store reads onto the records — and drop the rest. Measured at
  // ~46 MB on a device whose entire cover budget is 68 MB.
  if (isMobileDevice) {
    const dropped = pruneDetail(new Set(world.projection.stocked.map(t => t.id)));
    if (dropped) console.info(`detail: pruned ${dropped} unstocked records to reclaim heap`);
  }
  // PHONES DO NOT DRAIN THE REST. This block contradicted the policy this same
  // file states 600 lines further down, where preloadDetail() is skipped
  // because "~20 MB of blurbs is not worth the memory there" — the phone opted
  // out of the bulk warm-up and then did the equivalent anyway, one 2,500-id
  // chunk at a time, 1.5 s after entry.
  //
  // NOTE ON WHAT THIS GATE DOES AND DOES NOT DO. It stops the phone walking
  // 17,527 far ids and re-running applyDetail every 400 ms, and it stops that
  // JSON competing with the poster stream. It does NOT by itself save the
  // +103 MB: the `await ensureDetail(nearIds)` above already pulls all 64
  // shards, because shardOf() hashes the id. The memory is reclaimed by the
  // pruneDetail() call up there, not by this gate. Both are needed.
  //
  // ensureDetail() still fetches on demand for whatever the shopper actually
  // opens, which is exactly what the comment at the preloadDetail() call says
  // phones should rely on.
  if (!isMobileDevice) {
    let i = 0;
    const CHUNK = 2500;
    const drain = () => {
      if (i >= farIds.length) return;
      const slice = farIds.slice(i, i + CHUNK);
      i += CHUNK;
      ensureDetail(slice).then(() => {
        applyDetail(world.projection.stocked);
        setTimeout(drain, 400);           // idle-paced, never blocks a frame
      });
    };
    setTimeout(drain, 1500);              // begin after the player is inside
  }
  // PLANNING IS INSTANT; PRINTING IS STREAMED. The atlas layout — which title
  // occupies which tile of which atlas — is pure arithmetic and is ready here,
  // so the cases can bake their UVs and the store is walkable straight away.
  // The artwork itself arrives over the following seconds, nearest cases first,
  // in <=4ms slices that never block a frame. This is what used to be a
  // 239-atlas, 4 GB, minutes-long synchronous stall.
  //
  // budgetMs is 4, not the default 6: at 144 Hz the whole frame is 6.9 ms. Until
  // now that never bit, because pump spent almost all of its time parked on
  // poster decodes rather than drawing — with the near-field tiers actually
  // engaging it has real work to do every frame, and 4 ms keeps the drain above
  // 100 FPS.
  // PACKED BY SHELF POSITION. See spatialCoverOrder() — a permutation of the
  // same stocked set that puts neighbouring shelves in the same atlas, so the
  // first view costs 2 atlas hydrations instead of 11. CaseSystem builds an
  // id map and is order-independent, so only the streamer needs this array.
  world.coverOrder = spatialCoverOrder(world.projection.stocked, world.layout);
  world.covers = new CoverStreamer(world.coverOrder,
    { baseBudgetBytes, detailScale, maxDetail, midScale, maxMid, budgetMs: 4, tileCache, conserveImages: isMobileDevice, maxCommitsPerFrame: isMobileDevice ? 1 : 3 });
  world.atlases = world.covers.plan;   // UI reads `tiles` from this for thumbnails
  status('Stocking the shelves', 0.68);
  await nextFrame();
  world.caseSystem = new CaseSystem(scene, world.layout, world.projection.stocked,
    world.covers.plan, (a) => world.covers.textureFor(a));
  world.covers.attach(world.caseSystem);

  status('Stocking the shelves', 0.76);
  await nextFrame();
  // Head-count is derived from the generated building's walkable area (see
  // npc.js) — a nine-service store is deeper, not proportionally busier.
  // `count` is NPCSystem's documented QA override; `max` is not a key it reads,
  // so passing that would have built the full crowd and only silenced it.
  const npcs = new NPCSystem(scene, world.layout, world.nav,
    { mobile: isMobileDevice, ...(noNpc ? { count: 0 } : {}) });

  // Grounding pass — run after every mesh exists so nothing is left floating.
  if (isMobileDevice) renderer.shadowMap.type = THREE.PCFShadowMap;
  world.shadowStats = enableShadows(scene, { mobile: isMobileDevice });

  status('Setting up the entrance', 0.82);
  await nextFrame();

  const audio = new StoreAudio();
  // Start rendering the first track NOW, while the shell is still being built.
  // The browser will not let us create an AudioContext until the STEP INSIDE
  // gesture, but nothing stops us synthesising the samples, so the station is
  // ready the instant it is allowed to be heard.
  audio.primeRadio();
  const player = new Player(camera, world.nav, world.layout.spawn);
  player.onStep = (i, side) => audio.footstep(i, side);
  player.onRideChange = (on) => audio.setRiding(on);

  const updateFov = () => {
    player.setBaseFov(innerHeight > innerWidth ? 74 : WORLD.baseFov);
  };
  updateFov();

  let ui, interactions, inspector;
  let restockTimer = null;

  // ---- RESTOCK: same building, new stock — the product's core loop
  // RESTOCK IS SINGLE-FLIGHT.
  //
  // It is `async` with two awaits in the middle, and it disposes the streamer
  // and the case system before rebuilding both. Nothing guarded re-entry:
  // requestRestock() debounces only itself, while actions.goToTitle() and the
  // TB.restock QA hook call this directly. Two overlapping calls both reached
  // covers.dispose() and then each built a replacement, so the loser's whole
  // atlas generation was orphaned with world.covers pointing at the winner —
  // one full generation of GPU textures leaked, at the moment of peak memory.
  //
  // The epoch is checked after every await: a superseded call abandons its
  // work instead of writing it over a newer world.
  let restockEpoch = 0;
  let restockRetry = null;
  const restock = async (include = null) => {
    if (inspector.active) {
      actions.putBack();
      // ONE shared retry, not one chain per caller. Every restock request that
      // arrived while a case was held used to arm its own 700 ms self-retry
      // with no cap and no cancellation, so N requests became N forever-chains.
      clearTimeout(restockRetry);
      restockRetry = setTimeout(() => { restockRetry = null; restock(include); }, 700);
      return;
    }
    const gen = ++restockEpoch;
    const veil = document.getElementById('restock-veil');
    veil.classList.remove('hidden');
    await nextFrame(); await nextFrame();
    if (gen !== restockEpoch) return;          // superseded before any teardown
    try {
      // read the latest personalization from the UI
      myServices = ui.myServices;
      svcFilter = ui.svcFilter;
      const wasStock = world.projection?.stats.stocked ?? 0;
      // A special order joins the session's protected set BEFORE membership
      // is recomputed, so the ordered title is forced into stock and stays
      // visible even in MY SERVICES ONLY.
      if (include != null) for (const id of (Array.isArray(include) ? include : [include])) sessionOrders.add(id);
      buildWorldData(computeVisitStock(), visitN * 131);
      await ensureDetail(world.projection.stocked.map(t => t.id));
      // Superseded across the detail fetch: stop BEFORE covers.dispose(), so
      // the newer call owns the teardown and only one generation ever exists.
      if (gen !== restockEpoch) return;
      applyDetail(world.projection.stocked);
      // Plan the new stock's atlases now (instant); the artwork streams in after
      // the veil lifts. The old streamer is released BEFORE the new one exists,
      // so restock no longer holds two full generations of atlases at once —
      // which used to double peak texture memory at the worst possible moment.
      world.covers?.dispose();
      // Re-derived from the REBUILT layout: a restock can move every shelf, so
      // the packing order has to be recomputed with it or the new atlases would
      // be laid out for the old building. See spatialCoverOrder().
      world.coverOrder = spatialCoverOrder(world.projection.stocked, world.layout);
      world.covers = new CoverStreamer(world.coverOrder,
        { baseBudgetBytes, detailScale, maxDetail, midScale, maxMid, budgetMs: 4, tileCache, conserveImages: isMobileDevice, maxCommitsPerFrame: isMobileDevice ? 1 : 3 });
      world.atlases = world.covers.plan;
      // If the projection changed how big the building is, the building has to
      // be rebuilt with it — otherwise walls, floor and ceiling stay at the old
      // depth while the colliders and nav grid have already moved.
      if (Math.abs(shell.halfD - WORLD.halfD) > 1e-6) {
        const grew = WORLD.halfD > shell.halfD;
        const rebuilt = buildShell();
        raycastTargets.length = 0;
        raycastTargets.push(...rebuilt.raycastTargets);
        interactions.raycastTargets = raycastTargets;
        // Shrinking the store can strand the player OUTSIDE the new front wall —
        // dropping from nine services to one pulls the entrance ~12m closer, and
        // anyone standing in what used to be the entrance lobby would be left in
        // the void. Put them back at the door rather than leaving them outside it.
        if (!grew) {
          const sp = world.layout.spawn;
          const outside = Math.abs(player.z) > WORLD.halfD - 0.6 || Math.abs(player.x) > WORLD.halfW - 0.6;
          if (outside) {
            player.placeAt(sp);
            ui.toast('Your store resized. Back to the entrance.');
          }
        }
      }
      world.caseSystem.dispose(scene);
      world.caseSystem = new CaseSystem(scene, world.layout, world.projection.stocked,
        world.covers.plan, (a) => world.covers.textureFor(a));
      world.covers.attach(world.caseSystem);
      // Restock builds brand-new case meshes, which default to casting nothing.
      // Without this the shelves quietly lose their contact shadows the first
      // time the user changes services.
      world.shadowStats = enableShadows(scene, { mobile: isMobileDevice });
      // re-wire every consumer of the projection
      interactions.layout = world.layout;
      interactions.caseSystem = world.caseSystem;
      interactions.nav = world.nav;
      interactions.clearHighlight();
      inspector.cases = world.caseSystem;
      inspector.layout = world.layout;
      player.nav = world.nav;
      player.cancelStroll();
      npcs.rewire(world.layout, world.nav);
      ui.layout = world.layout;
      ui.atlases = world.atlases;
      ui.curation = world.curation;
      ui.thumbCache.clear();
      // stack entries keep their canonical titles; slots re-resolve or go dormant
      for (const entry of ui.stack) {
        const rec = world.layout.titles.get(entry.titleId);
        entry.slotId = rec ? rec.primarySlotId : null;
        if (entry.slotId) world.caseSystem.hideSlot(entry.slotId);
      }
      ui.renderFilterChip();
      actions.applyShelfStock();
      console.info(`restocked: ${wasStock} → ${world.projection.stats.stocked} titles (${world.projection.stats.eligible} eligible)`);
    } finally {
      veil.classList.add('hidden');
    }
  };
  const requestRestock = () => {
    clearTimeout(restockTimer);
    restockTimer = setTimeout(() => restock(), 650);
  };

  const actions = {
    goToTitle: (id) => {
      if (!world.projection.stockedIds.has(id)) {
        // eligible but in back-stock: bring it to the front, then walk
        restock(id).then(() => setTimeout(() => interactions.goToTitle(id), 250));
        return true;
      }
      return interactions.goToTitle(id);
    },
    putBack: () => { inspector.putBack(); player.setFrozen(false); },
    /**
     * Is there a copy of this title on a shelf to walk to right now?
     *
     * Asked BEFORE browsing so the arrows can step over a title whose every
     * copy is already in the shopper's stack, instead of trying it, failing
     * quietly and looking like a dead button.
     */
    hasShelfCopy: (id) => !!interactions.shelfCopySlot(id),
    /**
     * Swap the case in hand for another title's.
     *
     * THE PUT-BACK MUST FINISH FIRST, and that is the whole reason this is an
     * action rather than two UI calls. `inspector.open()` refuses outright
     * while a case is held, and the slot being vacated is very often the one
     * standing next to the slot about to be opened — returning the case is
     * what makes the shelf whole again. So the pick-up rides putBack's own
     * completion callback, and the shopper is unfrozen in between because the
     * next title may be far enough along the aisle to need a walk.
     */
    browseTo: (id) => {
      const take = () => { player.setFrozen(false); interactions.openTitle(id); };
      if (inspector.active) inspector.putBack(take);
      else take();
    },
    stashCurrent: () => {
      const t = inspector.title, s = inspector.slot;
      if (!t) return;
      if (ui.stack.some(e => e.titleId === t.id)) {
        ui.toast('Already in your stack, putting this copy back.');
        inspector.putBack();
        player.setFrozen(false);
        return;
      }
      inspector.stash(() => {
        ui.stack.push({ titleId: t.id, slotId: s.id });
        ui.saveStack();
        ui.renderStackButton();
        ui.toast(`${t.title} added to your stack.`);
        player.setFrozen(false);
      });
    },
    hideSlot: (slotId) => slotId && world.caseSystem.hideSlot(slotId),
    showSlot: (slotId) => slotId && world.caseSystem.showSlot(slotId),
    getPlayerPos: () => ({ x: player.x, z: player.z, level: player.level }),
    getProjection: () => world.projection,
    // Membership and availability handed to the UI as two independent values.
    getAvailability: () => world.availability,
    onServicesChanged: () => requestRestock(),
    copiesInfo: (titleId) => {
      const rec = world.layout.titles.get(titleId);
      if (!rec) return { copies: 0, nearestFt: 0, stocked: false };
      let nearest = Infinity;
      for (const id of rec.slotIds) {
        const s = world.layout.slotById.get(id);
        if (world.caseSystem.isHidden(id)) continue;
        const d = Math.hypot(player.x - s.x, player.z - s.z) + (s.level !== player.level ? 18 : 0);
        nearest = Math.min(nearest, d);
      }
      return { copies: rec.copies, nearestFt: nearest === Infinity ? 0 : Math.round(nearest * 3.3), stocked: true };
    },
    // OCCUPANCY, phase-4 model: every stocked tier renders (occupancy.js is
    // the seam that decides — and currently decides "visible" for all of
    // them; see the census that retired the old binary). Slots the STACK
    // physically holds stay collapsed, and the batch culling below still
    // covers whatever ends up fully dark. Services mean placement priority
    // and honest labels now, not presence.
    applyShelfStock: () => {
      const strict = svcFilter !== 'all' && myServices.size > 0;
      const cs = world.caseSystem;
      const stackHidden = new Set(ui.stack.map(e => e.slotId).filter(Boolean));
      const protectedIds = new Set([...ui.stack.map(e => e.titleId), ...sessionOrders]);
      const opt = { strict, services: myServices, protectedIds, inventoryMode: invMode };
      let empty = 0, shown = 0;
      for (const [slotId, slot] of world.layout.slotById) {
        if (stackHidden.has(slotId)) continue;          // the stack owns these
        const visible = slotVisible(world.byId.get(slot.titleId), opt);
        if (!visible) { if (!cs.isHidden(slotId)) cs.hideSlot(slotId); empty++; }
        else if (cs.isHidden(slotId)) { cs.showSlot(slotId); shown++; }
      }
      // EMPTY SLOTS MUST NOT RENDER (directive §21): a batch whose every slot
      // is hidden still cost a draw call and its full vertex work — measured:
      // 206 of 260 case batches were fully empty under Netflix+Tubi and every
      // one was still submitted. Culling them is invisible by construction
      // (all their geometry is already sunk) and removes ~200 draws in
      // MY SERVICES mode.
      let culled = 0;
      if (cs.meshes && cs.slotInfo) {
        const byMesh = new Map();
        for (const [slotId, info] of cs.slotInfo) {
          let b = byMesh.get(info.meshIdx);
          if (!b) { b = { total: 0, hidden: 0 }; byMesh.set(info.meshIdx, b); }
          b.total++;
          if (cs.hidden.has(slotId)) b.hidden++;
        }
        for (const [meshIdx, b] of byMesh) {
          const dead = b.total > 0 && b.hidden === b.total;
          const mesh = cs.meshes[meshIdx];
          if (mesh) { mesh.visible = !dead; if (dead) culled++; }
        }
      }
      return { strict, empty, shown, culledBatches: culled, inventoryMode: invMode };
    },
    // Mode switching is occupancy-only: both modes share the same physical
    // stock, so it is instant — no restock, no reload, no ghost inventory
    // (§9), and switching back re-empties exactly the discovery slots.
    setInventoryMode: (mode) => {
      invMode = mode === 'full' ? 'full' : 'services';
      localStorage.setItem('tb_inv_mode', invMode);
      return actions.applyShelfStock();
    },
    inventoryMode: () => invMode,
    applyQuality: () => {
      renderer.setPixelRatio(Math.min(devicePixelRatio, dprCap()));
      renderer.setSize(innerWidth, innerHeight);
      fitShadowToStore(lights.key, lastShadowFocus, { low: quality() === 'smooth' });
    },
    goCheckout: () => {
      // the counter tracks the front wall; the old (8.8, 5.75) literal was its
      // CORE position, and 'Riding down to the checkout' delivered a mezzanine
      // shopper to open floor 64 m short of it
      const counter = world.layout.props.find(p => p.kind === 'counter');
      const sp = counter
        ? { x: counter.x, z: counter.z - (counter.d ?? 0.7) / 2 - 1.1 }
        : { x: 8.8, z: 5.75 };
      const face = counter ? { x: counter.x, y: 1.2, z: counter.z } : { x: 8.8, y: 1.2, z: 7.0 };
      ui.toast(player.level === 1 ? 'Riding down to the checkout…' : 'Heading to the checkout…', 1800);
      const arrive = () => { player.faceToward(face); setTimeout(() => ui.showReceipt(), 500); };
      if (player.level === 0 && Math.hypot(player.x - sp.x, player.z - sp.z) < 1.2) arrive();
      else if (!player.strollTo(sp.x, sp.z, { level: 0, onArrive: arrive })) arrive();
    },
  };

  ui = new UI({
    catalog: CATALOG, curation: world.curation, layout: world.layout,
    atlases: world.atlases, audio, actions, modes,
    // Settings owns the camera-comfort sliders, and those write straight
    // through to the player. Without this the sliders bind to nothing and
    // silently do nothing at all.
    player,
  });

  inspector = new Inspector(scene, camera, world.caseSystem, world.layout, {
    audio,
    onOpen: (t, s) => {
      player.setFrozen(true);
      player.faceToward({ x: s.x, y: player.y + WORLD.eyeH - 0.12, z: s.z }, 0.5);
      ui.showInspect(t, s);
      dimTo(0.92);
    },
    onClose: () => { ui.hideInspect(); dimTo(1.12); },
  });

  interactions = new Interactions({
    camera, player, nav: world.nav, layout: world.layout,
    caseSystem: world.caseSystem, inspector, ui, audio, raycastTargets, byId: world.byId,
  });

  const input = new Input(canvas, {
    player, modes,
    inspect: inspector,
    getMode: () => (inspector.active ? 'inspect' : 'world'),
    onTap: (x, y) => { audio.start(); interactions.onTap(x, y); },
    onHover: (x, y) => interactions.onHover(x, y),
  });
  input.onEscape = () => {
    if (inspector.active) actions.putBack();
    else ui.closeAllPanels();
  };
  input.onDebugToggle = () => ui.toggleDebug();
  if (new URLSearchParams(location.search).has('debug')) ui.toggleDebug();

  for (const entry of ui.stack) {
    const rec = world.layout.titles.get(entry.titleId);
    entry.slotId = rec ? rec.primarySlotId : null;
    if (entry.slotId) world.caseSystem.hideSlot(entry.slotId);
  }

  let expoTarget = 1.12;
  const dimTo = (v) => { expoTarget = v; };

  // debug helpers
  let pathLine = null;
  const drawPathDebug = () => {
    if (pathLine) { scene.remove(pathLine); pathLine.geometry.dispose(); pathLine.material.dispose(); pathLine = null; }
    if (ui.debugFlags.path && player.walkPoints) {
      const y = player.y + 0.06;
      const pts = [{ x: player.x, z: player.z }, ...player.walkPoints.slice(player.pathIdx)];
      const geo = new THREE.BufferGeometry().setFromPoints(pts.map(p => new THREE.Vector3(p.x, y, p.z)));
      pathLine = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0x33ff77 }));
      scene.add(pathLine);
    }
  };
  let colGroup = null, colLevel = -1;
  const COL_COLORS = { wall: 0x8888ff, shelf: 0xff8844, table: 0xff8844, bin: 0xff8844, railing: 0x33ddff, void: 0xff33aa, escalator: 0xffdd33 };
  const drawColliderDebug = () => {
    if (ui.debugFlags.colliders && (!colGroup || colLevel !== player.level)) {
      if (colGroup) { scene.remove(colGroup); disposeTree(colGroup); colGroup = null; }
      colLevel = player.level;
      colGroup = new THREE.Group();
      for (const c of world.layout.colliders[player.level]) {
        const w = c.maxX - c.minX, d = c.maxZ - c.minZ;
        if (w > 30 || d > 30) continue;
        const h = Math.min(c.h ?? 2, 3);
        const m = new THREE.Mesh(
          new THREE.BoxGeometry(w, h, d),
          new THREE.MeshBasicMaterial({ color: COL_COLORS[c.kind] ?? 0xff4444, transparent: true, opacity: 0.24, depthWrite: false })
        );
        m.position.set((c.minX + c.maxX) / 2, (c.yBase ?? 0) + h / 2, (c.minZ + c.maxZ) / 2);
        colGroup.add(m);
      }
      const capsule = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.30, 1.15, 4, 12),
        new THREE.MeshBasicMaterial({ color: 0x33ff77, transparent: true, opacity: 0.35, depthWrite: false })
      );
      capsule.name = 'player-capsule';
      colGroup.add(capsule);
      scene.add(colGroup);
    } else if (!ui.debugFlags.colliders && colGroup) {
      // These two paths removed the group and dropped the reference without
      // disposing anything — ~1,100 GPU objects leaked per toggle, and the
      // level check re-toggles on every escalator ride.
      scene.remove(colGroup); disposeTree(colGroup); colGroup = null;
    }
    const cap = colGroup?.getObjectByName('player-capsule');
    if (cap) cap.position.set(player.x, player.y + 0.875, player.z);
  };
  let gridMesh = null, gridLevel = -1, gridToken = 0;
  const drawGridDebug = () => {
    if (ui.debugFlags.grid && (!gridMesh || gridLevel !== player.level)) {
      if (gridMesh) { scene.remove(gridMesh); disposeTree(gridMesh); gridMesh = null; }
      gridLevel = player.level;
      // The mesh is only assigned inside the .then() below, so `!gridMesh`
      // stayed true for every frame until the dynamic import resolved and the
      // whole per-cell geometry array was rebuilt each of those frames. This
      // token makes the build single-flight AND lets a stale completion drop
      // its result instead of adding an unreachable mesh to the scene.
      const myGrid = ++gridToken;
      const grid = world.nav.grids[player.level];
      const y = (player.level ? WORLD.mezzY : 0) + 0.03;
      const geos = [];
      for (let cz = 0; cz < grid.rows; cz++) for (let cx = 0; cx < grid.cols; cx++) {
        if (!grid.blocked[grid.idx(cx, cz)]) continue;
        const w = grid.cellToWorld(cx, cz);
        const g = new THREE.PlaneGeometry(grid.cell * 0.9, grid.cell * 0.9);
        g.rotateX(-Math.PI / 2);
        g.translate(w.x, y, w.z);
        geos.push(g);
      }
      import('../vendor/BufferGeometryUtils.js').then(({ mergeGeometries }) => {
        const merged = new THREE.Mesh(mergeGeometries(geos),
          new THREE.MeshBasicMaterial({ color: 0xff3344, transparent: true, opacity: 0.28 }));
        for (const g of geos) g.dispose();
        if (myGrid !== gridToken || !ui.debugFlags.grid) {   // superseded or turned off
          merged.geometry.dispose(); merged.material.dispose();
          return;
        }
        gridMesh = merged;
        scene.add(gridMesh);
      });
    } else if (!ui.debugFlags.grid && gridMesh) {
      gridToken++;
      scene.remove(gridMesh); disposeTree(gridMesh); gridMesh = null;
    }
  };

  // WEBGL CONTEXT LOSS. iOS drops the context under memory pressure or when a
  // backgrounded tab is reclaimed, and nothing here used to handle it: the
  // streamer would keep handing the renderer texture objects whose GPU
  // handles no longer existed. Preventing the default lets the browser
  // restore, and invalidating the streamer's bookkeeping (without disposing
  // dead handles) means covers simply redraw — a lost context degrades to a
  // few seconds of redrawing instead of taking the store down.
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    world.__ctxLost = (world.__ctxLost ?? 0) + 1;
    crumb('webgl-context-lost');
    world.covers?.invalidateGpuState();
  });
  canvas.addEventListener('webglcontextrestored', () => {
    crumb('webgl-context-restored');
    if (world.covers && world.caseSystem) world.covers.attach(world.caseSystem);
  });

  addEventListener('resize', () => {
    renderer.setSize(innerWidth, innerHeight);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    updateFov();
  });

  // SPAWN-AREA DRESSING (phase-4 §20-21). Measured before this existed: the
  // player stepped into a store where 0 of the spawn area's atlases carried
  // any real artwork, and watched posters appear one by one for the better
  // part of a minute. The gate screen is idle user time, so the streamer
  // pumps AT THE SPAWN POSITION with a boosted budget while the STEP INSIDE
  // button waits — by the time a human reads the screen and clicks, the
  // first view is usually finished. If they beat it, the click holds on
  // "Dressing the shelves…" briefly, hard-capped so a slow network can delay
  // entry by seconds at most, never block it (§25). Completeness is judged
  // per-CASE (nearestAtlasDistance), not per-AABB — curated front-of-store
  // copies smear atlas boxes across the whole building.
  let fpsSmooth = 60;
  let ringSample = () => {}, ringFrame = () => {}, ringPhase = 0;

  // CRASH RING BUFFER — continuous state, not milestone crumbs.
  //
  // A stage marker only says which milestone was passed; it saturated at
  // 'covers-draining' and told us nothing about what the device was doing
  // when it died. This keeps the last 20 s of primitive numbers in a fixed
  // array and writes them to localStorage every 1.6 s, so the session AFTER
  // an iOS tab kill can show what was happening at 22.8 s, 22.4 s, 22.0 s...
  //
  // It must never be the reason the crash changes: 50 rows of integers, no
  // retained objects, sampled 2.5x a second, one small write per 1.6 s.
  // Measured cost: 0.04 ms and 3.1 KB per write.
  //
  // INSTALLED BEFORE SHELF DRESSING, ON PURPOSE. It used to start at entry, so
  // a death during the pre-entry dressing phase - which is exactly what
  // "dressing the shelves @ 2s" was - recorded nothing at all. Column 0 is the
  // phase, so a dressing-phase row is never mistaken for an in-store one.
  //
  // WHAT CHANGED AFTER THE BUILD THAT STILL DIED
  //
  // 1. WRITTEN EVERY SAMPLE, not every fourth. The old cadence left a 1.6 s
  //    blind spot and a jetsam kill lands inside it more often than not. At
  //    0.04 ms and ~4 KB a write, the cost is not worth measuring.
  // 2. CUMULATIVE TOTALS, not only residency. Every previous pass proved the
  //    RESIDENT set bounded and concluded the app was safe; the device kept
  //    dying. Totals say how much work the browser was actually asked to do —
  //    bytes decoded, textures created, texels uploaded.
  // 3. A SEPARATE MONOTONIC RECORD (tb_hwm). If the ring is truncated by a kill
  //    mid-write, the high-water marks and totals still stand on their own key.
  //
  // WHAT THIS STILL CANNOT SEE, and no amount of JS will fix — all verified
  // against WebKit source rather than assumed:
  //
  //   performance.memory            Chrome-only. Absent in every Safari, so the
  //                                 heap column reads -1 on the device that
  //                                 matters. Recorded honestly, not guessed.
  //   PerformanceObserver longtask  Not supported in ANY Safari, ever. The
  //                                 frame-drift timing below is the substitute.
  //   Resource Timing byte sizes    WebKit returns 0 for EVERY cross-origin
  //                                 resource, even with Timing-Allow-Origin
  //                                 (it is deliberately stricter than the spec).
  //                                 65% of posters are TMDB, so network bytes
  //                                 are unmeasurable from JS — which is exactly
  //                                 why decoded bytes are ledgered by hand from
  //                                 naturalWidth/naturalHeight instead.
  //   GPU memory                    No WebGL extension in any browser reports
  //                                 it. Not obtainable.
  //   memory-pressure event         Unimplemented everywhere. webglcontextlost
  //                                 is the nearest signal and is recorded.
  //
  // And the reason this must be written CONTINUOUSLY rather than on an exit
  // hook: a jetsam kill is a SIGKILL to the WebContent process. No JavaScript
  // runs, and no event fires — not pagehide, not visibilitychange, nothing.
  // localStorage survives it because that data lives in the NETWORK process.
  {
    const RING = 60, EVERY = 400;
    const LEVELS = { ok: 0, strained: 1, critical: 2 };
    const rows = new Array(RING).fill(null);
    let head = 0, maxFrame = 0, longFrames = 0;
    const entered = performance.now();
    const hwm = { fps: 999, frame: 0, held: 0, inFlight: 0, tex: 0, calls: 0, heap: 0 };
    // CURRENT *AND* HIGH-WATER, for every resource that can plausibly retain.
    //
    // Cumulative counters cannot distinguish the three shapes we actually need
    // to tell apart: state that grows and never returns (a leak), state that
    // rises and plateaus (bounded caching), and state that spikes during work
    // and falls back (transient pressure). Only current-vs-peak separates them,
    // and only across repeated traversals of the same ground.
    //
    // Cheap by construction: ~16 integers, sampled 2.5x a second. covers.stats()
    // walks 260 base slots, which is the most expensive part and still trivial.
    const resMax = {};
    const peak = (o) => {
      for (const k in o) if (!(k in resMax) || o[k] > resMax[k]) resMax[k] = o[k];
      return o;
    };
    const EMPTY_COV = {
      mid: 0, detail: 0, pooled: 0, job: 0, commits: 0, frameCommits: 0,
      fails: 0, backlog: 0, texCreated: 0, texDisposed: 0, uploadedTexels: 0,
    };
    ringSample = () => {
      const now = performance.now();
      const info = renderer.info;
      const art = artworkStats();
      const am = artworkMetrics();
      const cov = world.covers ? world.covers.telemetry() : EMPTY_COV;
      const heap = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : -1;
      const fps = Math.round(fpsSmooth);
      const moving = player.speed > 0.15 ? 1 : 0;
      // ADDRESSED BY NAME, not by position. A positional literal here is what
      // let the reader drift out of alignment with the recorder — see
      // systems/crash-schema.js.
      const row = new Array(RING_COLS.length).fill(0);
      row[C.phase] = ringPhase;
      row[C.gov] = LEVELS[world.governor?.level()] ?? 0;
      row[C.t] = Math.round((now - entered) / 100);
      row[C.fps] = fps;
      row[C.frame] = Math.round(maxFrame);
      row[C.longF] = longFrames;
      row[C.x] = Math.round(player.x);
      row[C.z] = Math.round(player.z);
      row[C.level] = player.level | 0;
      row[C.moving] = moving;
      row[C.mid] = cov.mid;
      row[C.detail] = cov.detail;
      row[C.pooled] = cov.pooled;
      row[C.job] = cov.job;
      row[C.fcmt] = cov.frameCommits;
      row[C.cmt] = cov.commits;
      row[C.fails] = cov.fails;
      row[C.backlog] = cov.backlog;
      row[C.tex] = info.memory.textures;
      row[C.geo] = info.memory.geometries;
      row[C.calls] = info.render.calls;
      row[C.ktris] = Math.round(info.render.triangles / 1000);
      row[C.inflight] = art.inFlight;
      row[C.held] = art.held;
      row[C.heap] = heap;
      row[C.ctxLost] = world.__ctxLost ?? 0;
      row[C.fetched] = am.fetchStarted;
      row[C.fok] = am.fetchOk;
      row[C.ffail] = am.fetchFailed;
      row[C.decMiB] = Math.round(am.decodedBytes / 1048576);
      row[C.rel] = am.released;
      row[C.uneviq] = am.evictable;
      row[C.texC] = cov.texCreated;
      row[C.texD] = cov.texDisposed;
      row[C.mtex] = Math.round(cov.uploadedTexels / 1e6);
      row[C.uniq] = am.uniqueTitles;
      row[C.vis] = document.visibilityState === 'visible' ? 1 : 0;
      rows[head] = row;
      head = (head + 1) % RING;
      if (maxFrame > hwm.frame) hwm.frame = maxFrame;
      if (fps < hwm.fps) hwm.fps = fps;
      if (art.held > hwm.held) hwm.held = art.held;
      if (art.inFlight > hwm.inFlight) hwm.inFlight = art.inFlight;
      if (info.memory.textures > hwm.tex) hwm.tex = info.memory.textures;
      if (info.render.calls > hwm.calls) hwm.calls = info.render.calls;
      if (heap > hwm.heap) hwm.heap = heap;
      maxFrame = 0;
      const st = world.covers ? world.covers.stats() : null;
      const ds = detailStats();
      const res = peak({
        base: st ? st.baseCount : 0,
        mid: cov.mid, detail: cov.detail, pooled: cov.pooled,
        baseMiB: st ? Math.round(st.baseBytes / 1048576) : 0,
        midMiB: st ? Math.round(st.midBytes / 1048576) : 0,
        detailMiB: st ? Math.round(st.detailBytes / 1048576) : 0,
        tileMiB: st ? Math.round(st.tileCacheBytes / 1048576) : 0,
        coverMiB: st ? Math.round(st.totalBytes / 1048576) : 0,
        inFlight: art.inFlight, held: art.held, claimed: art.claimed,
        job: cov.job, backlog: cov.backlog,
        npcs: npcs?.npcs?.length ?? 0,
        geometries: info.memory.geometries, textures: info.memory.textures,
        programs: renderer.info.programs?.length ?? -1,
        detailShards: ds.shardsLoaded, detailTitles: ds.titles,
      });
      try {
        const out = [];
        for (let i = 0; i < RING; i++) {
          const r = rows[(head + i) % RING];
          if (r) out.push(r.join(','));
        }
        localStorage.setItem('tb_ring', out.join(';'));
        localStorage.setItem('tb_hwm', JSON.stringify({
          alive: Math.round((now - entered) / 1000),
          worstFrameMs: Math.round(hwm.frame * 10) / 10, minFps: hwm.fps, longFrames,
          peakHeld: hwm.held, peakInFlight: hwm.inFlight,
          peakTextures: hwm.tex, peakDrawCalls: hwm.calls, peakHeapMiB: hwm.heap,
          fetches: am.fetchStarted, ok: am.fetchOk, failed: am.fetchFailed,
          decodedMiB: am.decodedMiB, released: am.released,
          // Structurally equal to `released` — every decode here is an
          // HTMLImageElement and none of them has close(). Kept only so the
          // equality is visible rather than mysterious. It is NOT a memory figure.
          unfreeable: am.evictable,
          uniqueTitles: am.uniqueTitles, refetchRatio: am.refetchRatio,
          decodes: am.decodes,
          texCreated: cov.texCreated, texDisposed: cov.texDisposed,
          // The reconciliation, so "created N / disposed 0" can never again be
          // read as a leak without checking what is actually resident. Base
          // textures are a PERMANENT tier by design and mid/detail evictions are
          // PARKED in the pool for reuse rather than disposed.
          texResident: cov.mid + cov.detail + (world.covers?.base.filter(Boolean).length ?? 0),
          texPooled: cov.pooled,
          megatexels: Math.round(cov.uploadedTexels / 1e6),
          backlog: cov.backlog, ctxLost: world.__ctxLost ?? 0,
          diag: world.diag,
          // WEBKIT REPORTS "Apple GPU" FOR EVERY iPHONE EVER MADE, so the
          // WebGL renderer string cannot tell an SE from a 15 Pro. Screen
          // dimensions x devicePixelRatio is the only usable device proxy.
          dev: `${screen.width}x${screen.height}@${devicePixelRatio}`,
          res, resMax,
        }));
      } catch { /* storage full — telemetry degrades, the store does not */ }
    };
    ringFrame = (frameMs) => {
      if (frameMs > maxFrame) maxFrame = frameMs;
      if (frameMs > 120) longFrames++;
    };
    setInterval(ringSample, EVERY);
  }


  const spawnView = { x: player.x, y: 1.6, z: player.z };
  // Allocated ONCE. This used to be a fresh Float32Array(260) on every call and
  // it is called every dressing tick.
  const dressScratch = world.covers ? new Float32Array(world.covers.plan.count) : null;
  // How much of the spawn area is dressed — "17 of 23" for the loading bar.
  //
  // Declared HERE, above the only thing that writes it: spawnDressed() is
  // called during boot, and a `let` declared below its first call is a
  // temporal-dead-zone crash waiting for someone to move one line. This file
  // has already shipped that bug once.
  //
  // It is filled as a SIDE EFFECT of the check that already walks the atlases.
  // The first version counted them in a second pass of its own, every 120 ms,
  // while the dressing pump did the same walk on its own schedule — qa:runtime
  // caught a dressing tick at 19.1 ms against a 9 ms budget. Honest progress
  // reporting must not steal the frame budget from the work it reports on.
  // THE MINIMUM VIABLE STOREFRONT.
  //
  // How far "the shelves in front of you" reaches. Small enough that a phone
  // can finish it in a few seconds, large enough that the aisle you are
  // standing in is populated when the door opens. The full 14 m sweep is what
  // the progress bar reports; this is what the door waits for.
  const NEAR_RING_M = 7.5;
  // ...and how much of that ring has to be dressed. Not all of it: one slow
  // poster on the edge of the ring should not hold the door, and 85% of the
  // near shelves carrying art already reads as a stocked store.
  const NEAR_READY_FRACTION = 0.85;
  let lastProgress = { done: 0, total: 1, nearDone: 0, nearTotal: 1 };
  const spawnDressed = () => {
    const cv = world.covers, cs = world.caseSystem;
    if (!cv || !cs?.nearestAtlasDistance || !dressScratch) return true;
    dressScratch.fill(Infinity);
    cs.nearestAtlasDistance(spawnView, 14, dressScratch);
    // Count while we are already here. The loading bar needs "n of N" and this
    // loop is the only place that knows it; computing it separately cost a
    // whole second walk of the atlas set on every tick.
    //
    // TWO NUMBERS, NOT ONE, AND THEY ANSWER DIFFERENT QUESTIONS.
    //
    // Device QA entered the store at "6 of 32" with the shelves around it
    // still blank. That was not readiness, it was the 15 s cap expiring:
    // "every visible atlas within 14 m" is far more than anyone can see from
    // the door, so on a phone the wait never completed and the timeout became
    // the real gate.
    //
    // So the ENTRY decision now uses the NEAR ring only, the shelves actually
    // in front of you, while the bar keeps reporting the full set so the
    // number does not jump when the door opens. Everything beyond the ring
    // carries on dressing after entry, which is what the streamer is for.
    let done = 0, total = 0, all = true;
    let nearDone = 0, nearTotal = 0;
    for (let a = 0; a < dressScratch.length; a++) {
      const d = dressScratch[a];
      if (d === Infinity || !cs.atlasVisible(a)) continue;
      const dressed = !!cv.base[a];
      total++;
      if (dressed) done++; else all = false;
      if (d <= NEAR_RING_M) { nearTotal++; if (dressed) nearDone++; }
    }
    lastProgress = { done, total: total || 1, nearDone, nearTotal: nearTotal || 1 };
    return all;
  };
  const spawnProgress = () => lastProgress;
  let dressingDone = spawnDressed();
  let dressReport = { ticks: 0, worstTickMs: 0, finished: dressingDone };

  // TB:DRESSING-LOOP-START  (scripts/qa/render-loop-gate.mjs asserts on this
  // region by name — do not rename or remove the markers)
  // ------------------------------------------------- COOPERATIVE SHELF DRESSING
  //
  // Two things were wrong here and they are different problems.
  //
  // 1. THE LOOP RENDERED THE STORE. To stop every pre-entry atlas becoming
  //    upload-pending and then uploading ~40-75 at once on the first real
  //    frame, an earlier fix called renderer.render(scene, camera) every tick.
  //    That is 1,100+ draw calls plus a shadow pass, up to 60x a second, for
  //    the whole of loading — far worse than the burst it avoided, and it is
  //    what "dressing the shelves @ 2s" was. renderer.initTexture() uploads
  //    exactly the one texture just committed: no traversal, no shadow pass,
  //    no second render loop. There remains exactly ONE production render
  //    loop, in frame(), and it does not exist yet at this point in boot.
  //
  // 2. requestAnimationFrame IS NOT A WORKLOAD BUDGET. rAF paced the
  //    SCHEDULING and nothing paced the WORK, so a tick was free to spend as
  //    long as it liked; budgetMs was even RAISED to 12 ms here on the theory
  //    that "nobody is rendering yet". Nobody rendering is precisely why a
  //    long tick is invisible until the tab dies. cooperativePump enforces a
  //    hard CPU cap per tick and then yields via setTimeout, so the browser
  //    gets to render the loading screen, take input, run timers and collect
  //    garbage between batches.
  //
  // A later cover is acceptable. A frozen browser is not.
  {
    const cv = world.covers;
    const normalBudget = cv ? cv.budgetMs : null;
    // One pump call per step, at the NORMAL budget. On a phone this is 4 ms of
    // drawing inside a 6 ms tick, yielding after every tick.
    const tickBudget = isMobileDevice ? 6 : 10;
    const step = () => {
      if (dressingDone || spawnDressed()) return false;
      world.covers?.pump(spawnView);
      const fresh = world.covers?._lastCommitted;
      if (fresh) {
        try { renderer.initTexture(fresh); } catch { /* upload retries at first render */ }
        world.covers._lastCommitted = null;
      }
      return true;
    };
    cooperativePump({
      step,
      budgetMs: tickBudget,
      deadlineMs: performance.now() + 30000,
      yieldMs: isMobileDevice ? 8 : 0,
      onTick: (ms) => ringFrame(ms),
    }).then((r) => {
      dressReport = r;
      dressingDone = true;
      if (world.covers && normalBudget != null) world.covers.budgetMs = normalBudget;
      world.dressReport = r;
    });
  }
  // TB:DRESSING-LOOP-END

  // AUTO-ENTRY (user report: "ENTER STORE and STEP INSIDE is the same thing
  // twice"). The onboarding click was already the decision AND the audio
  // gesture (onboard.js unlocks the context there; audio.ensure adopts it),
  // so once the spawn shelves are dressed the store simply fades in. The cap
  // keeps a slow network from holding the door (§25); the ?onboard=skip QA
  // flow has no gesture, so audio waits for the first in-store tap — which
  // audio.start() on onTap already handles.
  // THE BAR USED TO REACH 100% HERE — before a wait of up to fifteen seconds.
  //
  // That is not a cosmetic complaint. status('Dressing the shelves…', 1) fired
  // and THEN the loop below began, so the honest reading of the old loading
  // screen was "finished, now hang for a quarter of a minute". The fix is not
  // to slow the bar down, which would only move the lie: this stretch is real
  // work with a real denominator, so it gets the 85..97 band and reports the
  // spawn atlases as they actually land. 100% now means the door is opening.
  {
    // Without a gate screen there is no free idle time, so the dressing wait
    // IS the budget: 15s covers the spawn set on typical connections, and a
    // slower one enters with whatever is dressed rather than holding the
    // door (§25 — artwork delays entry by seconds, never blocks it).
    const cap = performance.now() + 15000;
    const start = performance.now();
    const p0 = spawnProgress();
    status('Loading nearby artwork', 0.85);
    // THE DOOR OPENS ON THE NEAR RING, NOT ON EVERYTHING, AND NOT ON A TIMEOUT.
    //
    // Waiting for every visible atlas meant the 15 s cap was what actually
    // released the player on a phone, at 6 dressed out of 32. Waiting for the
    // ring in front of them instead is reached in a fraction of that, and it
    // is the thing that decides whether the store looks stocked when it fades
    // in. The cap stays as a floor for a bad network, not as the mechanism.
    const nearReady = () => {
      const p = spawnProgress();
      return p.nearDone >= Math.ceil(p.nearTotal * NEAR_READY_FRACTION);
    };
    while (!dressingDone && !nearReady() && performance.now() < cap) {
      await new Promise(r => setTimeout(r, 120));
      const p = spawnProgress();
      // REPORT THE THING THAT OPENS THE DOOR. The bar used to count every
      // visible atlas while the gate waited on the near ring, so it crawled
      // toward a number that was not the one being waited for. It counts the
      // ring now, and reaching it IS entry.
      const frac = Math.min(p.nearDone / p.nearTotal, 1);
      const elapsed = (performance.now() - start) / 15000;
      // NO COUNTER. The fraction still drives the bar, but "17 of 23 atlases"
      // is developer language and reads as a stall when the number is small.
      // After a while the sentence acknowledges the wait rather than repeating.
      const slow = performance.now() - start > 8000;
      status(slow ? 'Still loading nearby artwork' : 'Loading nearby artwork',
        0.85 + 0.12 * Math.max(frac, Math.min(elapsed, 0.9)));
    }
    // Ends the BOOT pump only. The frame loop keeps streaming covers around
    // the player under the governor's budget, so the shelves beyond the near
    // ring carry on dressing after the door opens. That is the whole point of
    // entering on the ring rather than on the full sweep.
    dressingDone = true;
    const p = spawnProgress();
    world.__entryReadiness = { near: p.nearDone, nearOf: p.nearTotal, all: p.done, allOf: p.total };
    console.info(`entry: aisle ${p.nearDone}/${p.nearTotal} dressed, ${p.done}/${p.total} of the wider view; the rest continue in the background`);
  }
  status('Opening the doors', 0.99);
  crumb('entry-auto');
  audio.start();
  // Two crumbs from the same phone — radio-started@21s and entered@17s —
  // proved the second death happened BEFORE the radio ever started, so the
  // marker named a position, not a cause. The knobs above remove one
  // subsystem at a time from an otherwise identical build. Safari re-uses
  // the URL on reload, so a flag survives a crash without being persisted.
  // The radio reports its own state changes — blocked by autoplay policy,
  // recovered, or a station that could not load — and the dock is what shows
  // them. Without this the dock could only ever learn on its 4 s tick.
  audio.onRadioChange = () => { try { ui.renderRadioDock(); } catch { /* pre-UI */ } };
  // BUILD THE PLAYER NOW, PLAY IT ON THE FIRST TAP.
  //
  // startRadio() from here can never produce sound on a phone: there is no
  // user gesture behind boot, and the path to playVideo() runs through a
  // dynamic import, a script load and a network round-trip. Even with a
  // gesture, that much async spends it.
  //
  // prewarmRadio() does the slow half with no gesture required — it builds the
  // embed and reads the manifest but does not play. Once the player exists,
  // _startYouTube() takes its synchronous branch, so the first tap reaches
  // playVideo() inside the gesture, which is what iOS actually requires.
  if (noRadio) {
    crumb('radio-suppressed');
  } else {
    audio.prewarmRadio().then(() => { crumb('radio-ready'); ui.renderRadioDock(); });
    // ANY first tap starts it. The shopper taps to walk within a second or two
    // anyway, and that tap is a real gesture, so it costs them nothing.
    const kick = () => {
      window.removeEventListener('pointerdown', kick, true);
      try { audio.start(); audio.startRadio(); } catch { /* reported by the dock */ }
    };
    window.addEventListener('pointerdown', kick, true);
  }
  actions.applyShelfStock();
  // 100% MEANS THE STORE IS INTERACTIVE — this line and the one below it are
  // adjacent on purpose. Anything that needs doing before the player can walk
  // belongs ABOVE this call, accounted for in the bar, not hidden behind it.
  status('Ready', 1);
  document.getElementById('loading').classList.add('done');

  // THE TUTORIAL RUNS *AFTER* THE DOOR OPENS. THIS ORDER IS THE WHOLE POINT.
  //
  // It used to be awaited at 99%, before this line — and #loading is z-index
  // 100 while #tutorial is z-index 90. So the cards rendered BEHIND the still
  // visible loading screen: invisible, untappable, and the await never
  // resolved. That is not a slow startup, it is a permanent deadlock, and it
  // is what left the device sitting on "Opening the doors…" until the shopper
  // gave up. A promise that waits on a click nobody can reach waits forever.
  //
  // So the store opens first and the cards sit over the top of it, which is
  // also the better introduction: you can see the shop you are being shown
  // around. The player is frozen while they are up so nothing moves behind
  // them, and NOTHING on the boot path is allowed to await user input again.
  (async () => {
    try {
      const { showTutorial, tutorialSeen, maybeHint } = await import('./ui/tutorial.js');
      const touch = modes?.isTouchUI ?? isMobileDevice;
      if (tutorialSeen()) return;
      player.setFrozen(true);
      const completed = await showTutorial({
        touch,
        onBlip: () => { try { audio.uiBlip(); } catch { /* pre-audio */ } },
      });
      player.setFrozen(false);
      if (!completed) maybeHint((m, ms) => ui.toast(m, ms), touch);
    } catch (e) {
      // A tutorial that fails to load must never strand the shopper.
      console.warn('tutorial skipped:', e?.message ?? e);
      try { player.setFrozen(false); } catch { /* already walking */ }
    }
  })();
  // STARTUP TIMING, REPORTED SEPARATELY — the four moments that decide whether
  // the loading screen felt honest. The gap that mattered was PROGRESS COMPLETE
  // -> WORLD READY: it used to be the whole dressing wait, up to fifteen
  // seconds spent behind a finished bar. They are now the same instant by
  // construction, and this records it rather than asserting it.
  // COLD vs WARM. The browser HTTP cache is what makes a second visit faster,
  // and "was anything already cached" is answerable without adding a caching
  // layer of our own: a resource served from cache reports transferSize 0.
  const cacheHits = (() => {
    try {
      const rs = performance.getEntriesByType('resource');
      const hit = rs.filter((r) => r.transferSize === 0 && r.decodedBodySize > 0).length;
      return { of: rs.length, cached: hit, warm: rs.length > 0 && hit / rs.length > 0.5 };
    } catch { return null; }
  })();
  window.__tbBoot = {
    cache: cacheHits,
    firstScreen: +(window.__stages?.[0]?.t ?? 0).toFixed(2),
    progressComplete: +(performance.now() / 1000).toFixed(2),
    worldReady: +(performance.now() / 1000).toFixed(2),
    firstPlayableFrame: null,          // stamped by the first frame() below
  };
  ringPhase = 1;
  crumb(baseTiersOnly ? 'entered (base tiers only)' : 'entered');
  // TIME OF DEATH, not last-thing-scheduled. A stage crumb only says which
  // milestone was passed; a heartbeat on its own key says how many seconds
  // the tab actually survived, so a subsystem marker can never again be
  // mistaken for a cause. Separate key: the stage crumb stays readable.
  {
    let sec = 0;
    const beat = setInterval(() => {
      sec += 2;
      try { localStorage.setItem('tb_alive', `${sec}s after entry`); } catch { /* full */ }
      if (sec >= 300) clearInterval(beat);
    }, 2000);
  }
  setTimeout(() => crumb('stable-30s'), 30000);
  setTimeout(() => crumb('stable-2min'), 120000);


  const clock = new THREE.Clock();
  // Frame governor: the authority on how much secondary work a struggling
  // device may be asked to do. See systems/pressure.js.
  const governor = new FrameGovernor({ mobile: isMobileDevice });
  world.governor = governor;
  const shadowHz = deviceProfile().shadowHz;
  let lastShadowRender = 0;
  if (shadowHz > 0) renderer.shadowMap.autoUpdate = false;
  let flickerT = 0;
  const tweens = await import('./systems/tween.js');

  // Once the player is inside, quietly pull the remaining detail shards so that
  // searching by actor or plot, and inspecting a back-stock title, never waits.
  // Phones skip the bulk warm-up — ~20 MB of blurbs is not worth the memory
  // there; ensureDetail() still fetches on demand for whatever they open.
  const detailReady = isMobileDevice
    ? Promise.resolve(0)
    : preloadDetail().then(() => applyDetail(CATALOG));

  window.TB = {
    scene, camera, renderer, player, modes, npcs, ui, inspector, interactions,
    catalog: CATALOG, validation, snapshot: SNAPSHOT, detailReady,
    detailStats, audio, visitN,
    bootStages: () => window.__stages ?? [],
    shelfStock: () => actions.applyShelfStock(),
    inventoryMode: () => invMode,
    setInventoryMode: (m) => actions.setInventoryMode(m),
    // QA: the session's special-order set, so a title-level occupancy audit
    // can attribute every visible title to eligible/protected/ordered exactly.
    sessionOrders: () => new Set(sessionOrders),
    // The station, for audio QA: what is playing, what is queued, what the
    // loudness meters saw, and whether the render is off the main thread.
    radio: () => audio.radioState(),
    get nav() { return world.nav; },
    get layout() { return world.layout; },
    get caseSystem() { return world.caseSystem; },
    // Cover residency, for QA: covers.stats() is how the memory ceiling is
    // PROVEN rather than assumed.
    get covers() { return world.covers; },
    // THE OTHER HALF OF THE MEMORY LEDGER. covers.stats() only ever described
    // the streamer; the generated scene textures were 134 MiB with no budget
    // and no mobile profile, and nothing could see them from here.
    textureBudget: () => textureBudgetStats(),
    device: () => deviceProfile(),
    // Frame health: the authority that decides whether cover hydration runs
    // at all this frame. level 'critical' means secondary work is at zero.
    governor: () => world.governor?.stats() ?? null,
    // What the pre-entry cooperative dressing pump actually cost.
    dressing: () => world.dressReport ?? null,
    renderInfo: () => ({
      calls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
      textures: renderer.info.memory.textures,
      geometries: renderer.info.memory.geometries,
      shadowAutoUpdate: renderer.shadowMap.autoUpdate,
    }),
    get projection() { return world.projection; },
    // Membership and availability exposed as the two separate values they are,
    // so QA can assert the chip never derives one from the other.
    get availability() { return world.availability; },
    restock,
    step: (dt = 0.016) => {
      player.update(dt); tweens.updateTweens(dt);
      input.update(dt);   // arrow-key look, per frame rather than per keydown
      inspector.update(dt); interactions.update(dt); shell.mezz.update(dt);
      npcs.update(dt, player);
    },
    render: () => renderer.render(scene, camera),
  };

  // THE ONE AND ONLY PRODUCTION RENDER LOOP.
  // Asserted permanently by scripts/qa/render-loop-gate.mjs — nothing else in
  // src/ may call renderer.render(scene, camera) from a self-rescheduling
  // callback, and no second loop may exist.
  function frame() {
    requestAnimationFrame(frame);
    const frameStart = performance.now();
    const dt = Math.min(clock.getDelta(), 0.05);
    fpsSmooth += (1 / Math.max(dt, 1e-4) - fpsSmooth) * 0.04;
    ringFrame(dt * 1000);
    // Feed the governor the INTERVAL, which is what the user experiences as a
    // stutter, and let it decide how much secondary work this frame may do.
    governor.sample(dt * 1000);

    if (window.__tbBoot && window.__tbBoot.firstPlayableFrame == null) {
      window.__tbBoot.firstPlayableFrame = +(performance.now() / 1000).toFixed(2);
    }
    player.update(dt);
    tweens.updateTweens(dt);
    inspector.update(dt);
    input.update(dt);   // arrow-key look, per frame rather than per keydown
    interactions.update(dt);
    shell.mezz.update(dt);
    // Slide the shadow window with the player so texel density never depends on
    // how large the projection made the building.
    refitShadow();
    // THE SHADOW PASS WAS RE-RENDERING EVERY FRAME. shadowMap.autoUpdate was
    // never touched, so the full caster set went through the depth pass 60x a
    // second for a static key light over a static store. With the case batches
    // no longer casting (see lighting.js) the caster count is already down from
    // 603 to 343 on mobile; this cuts the remaining passes to shadowHz.
    if (shadowHz > 0) {
      if (frameStart - lastShadowRender >= 1000 / shadowHz) {
        lastShadowRender = frameStart;
        renderer.shadowMap.needsUpdate = true;
      }
    }
    npcs.update(dt, player);
    // Print a slice of cover art. Time-budgeted, so a frame is never held up by
    // it, and prioritized by distance so the shelves you are standing at resolve
    // first: near cases get a base texture, then the shelf in front of you gets
    // detail and the ones you are walking past get mid, and the rest of the
    // building drains in the gaps. All three tiers are bounded (covers.stats()).
    //
    // ADAPTIVE DRAIN BUDGET (title-loading repair). Profiled: 77% of the
    // initial drain the streamer had art in hand and was BUDGET-bound at
    // 6 ms/frame — the store populated slowly by throttle, not by network.
    // The window merge freed ~38% of render submission, so that headroom is
    // reinvested here, gated on the MEASURED frame rate: a machine holding
    // 55+ fps drains at double budget, one at 42+ gets half the boost, and a
    // struggling one keeps the old pace. Self-regulating — if the bigger
    // budget costs frames, fpsSmooth dips and the budget backs off. No
    // resolution, tier, or LOD change anywhere: same art, sooner.
    // COVER HYDRATION IS PRIORITY 5 OF 6, AND IS GOVERNED, NOT GUESSED.
    //
    // This used to set budgetMs from a smoothed fps reading: 12 ms above
    // 55 fps, 9 above 42, else 6. That is a throughput heuristic, and it has
    // two defects. It only ever moved between 6 and 12 — it could not reach
    // zero, so a device in trouble still did 6 ms of texture work every frame
    // on top of whatever was already too much. And a smoothed average hides
    // exactly the spikes that kill a tab.
    //
    // The governor reacts to spikes fast, recovers slowly, and CAN return
    // zero. Zero means the pump is not called at all this frame, not called
    // and stopped early.
    if (world.covers && !noDrain) {
      const budget = governor.budgetMs();
      if (budget > 0) {
        world.covers.budgetMs = world.covers.baseComplete ? budget : budget * 1.5;
        if (!world.__drainMarked) { world.__drainMarked = true; crumb('covers-draining'); }
        world.covers.pump(player);
      }
    }

    if (Math.abs(renderer.toneMappingExposure - expoTarget) > 0.002) {
      renderer.toneMappingExposure += (expoTarget - renderer.toneMappingExposure) * Math.min(1, 6 * dt);
    }
    if (shell.flickerPanel) {
      flickerT += dt;
      const f = Math.sin(flickerT * 31) * Math.sin(flickerT * 7.3) > 0.965 ? 0.55 : 1;
      shell.flickerPanel.material.color.setScalar(0.96 * f);
    }

    if (ui.debugOpen) {
      drawPathDebug();
      drawGridDebug();
      drawColliderDebug();
      const ss = ui.lastSearchStats;
      const pj = world.projection;
      ui.setDebugText(
        `fps      ${fpsSmooth.toFixed(0)}\n` +
        `pos      ${player.x.toFixed(2)}, ${player.z.toFixed(2)}  y ${player.y.toFixed(2)}\n` +
        `level    ${player.level ? 'MEZZANINE' : 'GROUND'}${player.isRiding ? '  (riding)' : ''}\n` +
        `mode     ${modes.mode}(${modes.effective})  fov ${player.fov.toFixed(0)}\n` +
        `zone     ${document.getElementById('zone-label').textContent}\n` +
        `─ projection ─\n` +
        `master   ${CATALOG.length}  eligible ${pj.stats.eligible}  stocked ${pj.stats.stocked}\n` +
        `store    ${pj.personalized ? 'WATCHABLE FOR ME' : 'ALL TITLES'}  svcs ${[...ui.myServices].length}\n` +
        `copies   ${world.layoutStats.copies} (${world.layoutStats.faceOut} face / ${world.layoutStats.spineStock} spine)\n` +
        `search   ${ss.results} results / ${ss.unique} unique / ${ss.results - ss.unique} dupes\n` +
        `audio    ${(() => { const a = audio.debugState(); return `ctx:${a.ctx} radio:${a.radio}@${Math.round(a.radioVol * 100)}% lib:${a.library}`; })()}\n` +
        `station  ${(() => { const r = audio.radioState(); return r.nowPlaying ? `${r.nowPlaying} · ${r.family} · ${r.bpm}bpm · ${r.section} · ${r.elapsed}/${r.duration}s` : 'idle'; })()}\n` +
        `draws    ${renderer.info.render.calls}  tris ${(renderer.info.render.triangles / 1000).toFixed(0)}k`
      );
    }

    renderer.render(scene, camera);
  }
  frame();
}

boot().catch(err => {
  // A HANDLED rejection never reaches the unhandledrejection listener, so the
  // one failure path that always existed was also the one the new global
  // capture could not see. Record it here explicitly — a boot that dies at
  // "Booting the projector" must leave the reason behind for the next load.
  const at = typeof err?.stack === 'string' ? err.stack.split(NEWLINE_RE)[1]?.trim() : '';
  recordError('boot', err?.message ?? String(err), at);
  console.error(err);
  status('Something jammed in the VCR. Check the console.', 0);
  const el = document.getElementById('load-status');
  el.style.color = '#ff8888';
  el.textContent = `Error: ${err.message}`;
});
