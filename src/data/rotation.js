// SESSION MERCHANDISING — the layer between service eligibility and physical
// occupancy (session-H2 directive). Decides which titles occupy the store's
// inventory capacity THIS visit, with memory:
//
//   protected (STACK)   always, before everything
//   watchable-eligible  all of them, in MY SERVICES mode
//   persistent core     the familiar 60% — also the poster-covered slice
//   scored remainder    quality + discovery + freshness − repetition
//
// The scorer is deliberately a pure exported function: the "remembers what
// you've seen" behaviour is the product here, so it has to be testable and
// break-provable, not folded into a closure.
//
// PHYSICAL-STABILITY GUARANTEE: the remainder is filled per department-bucket
// with quotas taken from the core's own mix. The fixture pour derives unit
// counts from genre shares, so a selection that drifted the mix would quietly
// re-plan the furniture between visits — the one thing the directive forbids.
// Quota-filling pins the shares, and tests/rotation.test.mjs proves two
// arbitrary ledgers produce byte-identical fixture plans.
//
// No title disappears forever: every penalty decays to zero within
// REMEMBER_VISITS, after which a title competes on quality alone.
import { isCurrentlyWatchable } from './watchability.js';
import { allocateCapacity, deptGroupKey, STORE_CAPACITY } from './projection.js';

export const ROTATION = {
  REMEMBER_VISITS: 10,     // how long "recently seen" haunts a title
  RECENCY_PENALTY: 3.0,    // seen this visit ago: full weight, decays linearly
  UNSEEN_BOOST: 1.5,       // grows as a title stays off the floor
  DISCOVERY_BONUS: 2.0,    // never recorded at all — strongest draw
  FACEOUT_TAX: 0.6,        // was face-out within the last 3 visits
  JITTER: 0.8,             // per-visit deterministic wobble
  LEDGER_MAX_AGE: 60,      // prune entries not seen for this many visits
  LEDGER_KEY: 'tb_ledger_v1',
};

// ---------------------------------------------------------------------------
// ledger: id -> { seen: lastSeenVisit, times, face: lastFaceOutVisit|0 }
// stored as a compact string — 50k entries stay near a megabyte
// ---------------------------------------------------------------------------
export function loadLedger(storage) {
  const out = new Map();
  try {
    const raw = storage.getItem(ROTATION.LEDGER_KEY);
    if (!raw) return out;
    for (const row of raw.split(';')) {
      const [id, seen, times, face] = row.split(':');
      if (id) out.set(id, { seen: +seen || 0, times: +times || 0, face: +face || 0 });
    }
  } catch { /* unreadable ledger = fresh memory */ }
  return out;
}

export function saveLedger(storage, ledger, visitN) {
  const rows = [];
  for (const [id, e] of ledger) {
    if (visitN - e.seen > ROTATION.LEDGER_MAX_AGE) continue;   // prune
    rows.push(`${id}:${e.seen}:${e.times}:${e.face}`);
  }
  try { storage.setItem(ROTATION.LEDGER_KEY, rows.join(';')); }
  catch { /* storage full — memory degrades gracefully to shorter recall */ }
}

/** Record this visit's exposure: every stocked title was walkable; face-outs
 *  were unmissable. Called once per boot, after the layout exists. */
export function recordExposure(ledger, stockedIds, faceOutIds, visitN) {
  const faces = faceOutIds instanceof Set ? faceOutIds : new Set(faceOutIds);
  for (const id of stockedIds) {
    const e = ledger.get(id) ?? { seen: 0, times: 0, face: 0 };
    e.seen = visitN;
    e.times += 1;
    if (faces.has(id)) e.face = visitN;
    ledger.set(id, e);
  }
}

// deterministic per-(seed,id) wobble in [0,1)
function jitter(seed, id) {
  let h = seed | 0;
  for (let i = 0; i < id.length; i++) { h = (h * 31 + id.charCodeAt(i)) | 0; }
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12;
  return ((h >>> 0) % 10000) / 10000;
}

/**
 * The memory-aware score. Higher = more likely on the floor this visit.
 * Pure: (title, ledgerEntry|undefined, visitN, seed) -> number.
 */
export function rotationScore(title, entry, visitN, seed) {
  const base = Math.log10((title.votes ?? 0) + 10);          // quality: ~1..6.5
  const wob = jitter(seed, title.id) * ROTATION.JITTER;
  if (!entry) return base + ROTATION.DISCOVERY_BONUS + wob;  // never seen here
  const gap = Math.max(0, visitN - entry.seen);
  const R = ROTATION.REMEMBER_VISITS;
  const recency = ROTATION.RECENCY_PENALTY * Math.max(0, 1 - gap / R);
  const unseen = ROTATION.UNSEEN_BOOST * Math.min(1, gap / R);
  const faceTax = entry.face && (visitN - entry.face) < 3 ? ROTATION.FACEOUT_TAX : 0;
  return base - recency + unseen - faceTax + wob;
}

/**
 * Choose this visit's full stocked membership (exactly `capacity` titles,
 * plus any protected/eligible overflow a department cannot contain).
 * Deterministic for (ledger, visitN, seed).
 *
 * PHASE-4 SHAPE (§7): the quotas come from the SAME allocator and the SAME
 * department groups the projection and the fixture pour use, so the mix this
 * engine hands back through `include` is exactly the mix the building was
 * sized for. The old version quota'd by the CORE's first-genre mix — a
 * different partition entirely — and relied on the projection re-normalising
 * the disagreement, which is precisely how 3,767 selected titles (782 of
 * them watchable) were silently swapped for allocator filler. Now membership
 * is decided HERE, once:
 *
 *   per department:  protected > watchable (mine mode) > core > scored rest
 *
 * The ledger can only reorder the scored remainder WITHIN a department's
 * fixed quota, so the department mix — and therefore the fixture plan — is a
 * constant of the catalogue, ledger-independent and service-independent.
 */
export function selectVisitStock({ catalog, coreIds, protectedIds, services, strict, ledger, visitN, seed, capacity = STORE_CAPACITY }) {
  const picked = new Set();
  const byId = new Map(catalog.map(t => [t.id, t]));

  // Protected inventory ignores quotas entirely (§12): a stack does not lose
  // a title because its department is popular. Overflow is absorbed by the
  // projection's forced-aware caps.
  for (const id of protectedIds) if (byId.has(id)) picked.add(id);

  const byDept = new Map();
  for (const t of catalog) {
    const k = deptGroupKey(t);
    if (!byDept.has(k)) byDept.set(k, []);
    byDept.get(k).push(t);
  }
  const quotas = allocateCapacity(
    new Map([...byDept].map(([k, list]) => [k, list.length])), capacity);

  const scored = (list) => list
    .map(t => [rotationScore(t, ledger.get(t.id), visitN, seed), t.id])
    .sort((a, b) => b[0] - a[0]);
  const coreSet = new Set(coreIds);
  const wantStrict = !!(strict && services && services.size);

  for (const [k, list] of byDept) {
    const quota = quotas.get(k) ?? 0;
    let taken = list.reduce((a, t) => a + (picked.has(t.id) ? 1 : 0), 0);
    // 1. watchable titles first — up to the department's quota, ROTATION-
    //    SCORED. The unconditional version crashed the layout the day the
    //    tmdb-justwatch evidence landed: 29,918 eligible titles for three
    //    services overflowed every department past what the fixture pour can
    //    place ("3,542 horror titles had nowhere to go"). When a service
    //    pool is BIGGER than the store, MY SERVICES ONLY becomes what the
    //    user specified for exactly this case: a 20,000-title rotating
    //    sample of their services' catalogue — the never-seen bonus and
    //    recency penalty decide which eligible titles take this visit's
    //    shelf space, so the store is different every time while everything
    //    on it stays watchable. Departments whose pool fits their quota
    //    still admit every watchable title before any filler.
    if (wantStrict && taken < quota) {
      const eligible = list.filter(t => !picked.has(t.id) && isCurrentlyWatchable(t, services).eligible);
      for (const [, id] of scored(eligible)) {
        if (taken >= quota) break;
        picked.add(id); taken++;
      }
    }
    if (taken >= quota) continue;
    // 2. the persistent core — the familiar 60%.
    for (const t of list) {
      if (taken >= quota) break;
      if (coreSet.has(t.id) && !picked.has(t.id)) { picked.add(t.id); taken++; }
    }
    // 3. rotation-scored discovery fills the department to its quota.
    if (taken < quota) {
      for (const [, id] of scored(list.filter(t => !picked.has(t.id)))) {
        if (taken >= quota) break;
        picked.add(id); taken++;
      }
    }
  }
  return [...picked];
}
