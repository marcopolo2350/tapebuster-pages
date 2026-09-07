// Per-title detail (cast, synopsis, director/creators) — loaded lazily.
//
// The boot payload carries only what browsing and search-by-title need. Cover
// art, the inspector and cast/synopsis search all pull from here, so a 89k-title
// catalogue costs ~9 MB at boot instead of ~35 MB.
//
// A title with no detail is a title whose source had none. It renders without a
// blurb rather than with an invented one.

import { bumpDetailEpoch } from './epoch.js';

const BASE = new URL('./snapshot/detail/', import.meta.url);
const SHARDS = 64;
const EMPTY = Object.freeze({ cast: [], director: null, creators: null, synopsis: null, provenance: null });

const cache = new Map();                 // titleId -> detail
const shardPromises = new Array(SHARDS); // idx -> Promise

/** Must match the shard function in scripts/ingest/04-build.mjs. */
function shardOf(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % SHARDS;
}

async function loadJSON(name) {
  if (typeof window === 'undefined') {
    const [{ readFile }, { fileURLToPath }] = await Promise.all([
      import('node:fs/promises'), import('node:url'),
    ]);
    return JSON.parse(await readFile(fileURLToPath(new URL(name, BASE)), 'utf8'));
  }
  const r = await fetch(new URL(name, BASE));
  if (!r.ok) throw new Error(`detail: cannot load ${name} (HTTP ${r.status})`);
  return r.json();
}

function loadShard(i) {
  if (!shardPromises[i]) {
    shardPromises[i] = loadJSON(`${String(i).padStart(2, '0')}.json`)
      .then((obj) => {
        for (const [id, d] of Object.entries(obj)) {
          cache.set(id, {
            cast: d.c || [],
            director: d.d || null,
            creators: d.k || null,
            synopsis: d.s || null,
            provenance: d.p || null,
          });
        }
      })
      .catch((e) => { console.warn('detail shard failed', i, e.message); });
  }
  return shardPromises[i];
}

/** Resolve every shard the given title ids live in. */
export async function ensureDetail(ids) {
  const need = new Set();
  for (const id of ids) if (!cache.has(id)) need.add(shardOf(id));
  if (!need.size) return;
  await Promise.all([...need].map(loadShard));
}

/** Warm every shard in the background so search and inspection never block. */
export function preloadDetail() {
  const all = [];
  for (let i = 0; i < SHARDS; i++) all.push(loadShard(i));
  return Promise.all(all);
}

export function detailOf(id) {
  return cache.get(id) || EMPTY;
}

/**
 * Drop every cached record except the ones named, and allow the shards they
 * came from to be fetched again.
 *
 * WHY THIS EXISTS. shardOf() hashes the id STRING, so any reasonably sized set
 * of ids is spread across all 64 shards: measured, the 2,473 titles within 28 m
 * of the spawn touch 64/64, which means `await ensureDetail(nearIds)` pulls the
 * ENTIRE 55,097,625-byte corpus — 122,948 records — before anything else runs.
 * Gating the later bulk drain on mobile therefore saved nothing at all; the
 * near-field await had already loaded everything.
 *
 * Of that corpus only the stocked titles are ever displayed: 20,000 of 122,948,
 * 9,096,679 B of 55,097,625 B. The other 83.5% — about 46 MB — sat in this Map
 * for the lifetime of the tab and was never read, on the device that dies.
 *
 * Safe because applyDetail() has already copied what the store needs onto the
 * title records themselves, and anything pruned can be fetched again on demand.
 * That last part is why shardPromises is reset: loadShard() memoises, so
 * deleting cache entries WITHOUT clearing it would make ensureDetail() resolve
 * instantly against a settled promise and never re-populate — the pruned titles
 * would be permanently detail-less.
 */
export function pruneDetail(keepIds) {
  const keep = keepIds instanceof Set ? keepIds : new Set(keepIds);
  let dropped = 0;
  for (const id of cache.keys()) {
    if (!keep.has(id)) { cache.delete(id); dropped++; }
  }
  if (dropped) shardPromises.fill(undefined);
  return dropped;
}

/**
 * Copy any resident detail onto the catalog records themselves.
 *
 * Cover art, the inspector and the clerk all read t.cast / t.synopsis /
 * t.director directly. Rather than thread a second object through every one of
 * them, the detail is folded back onto the one shared record instance once its
 * shard is in — so those call sites need no knowledge of sharding at all.
 */
export function applyDetail(records) {
  let n = 0;
  // Search memoises normalised cast/plot strings per record; folding new detail
  // in has to invalidate those synchronously or the freshly-loaded blurbs stay
  // unsearchable until something else happens to bump the epoch.
  bumpDetailEpoch();
  for (const t of records) {
    const d = cache.get(t.id);
    if (!d) continue;
    if (d.cast?.length) t.cast = d.cast;
    if (d.synopsis) t.synopsis = d.synopsis;
    if (d.director) t.director = d.director;
    if (d.creators) t.creators = Array.isArray(d.creators) ? d.creators.join(', ') : d.creators;
    if (d.provenance) t.provenance = d.provenance;
    n++;
  }
  return n;
}

/** True once a shard covering this id is resident. */
export function hasDetail(id) {
  return cache.has(id);
}

export const detailStats = () => ({
  shardsLoaded: shardPromises.filter(Boolean).length,
  shards: SHARDS,
  titles: cache.size,
});
