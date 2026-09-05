// THE PRODUCT CORE: master catalog → user-store projection.
//
//   MY SERVICES  →  ELIGIBLE (everything watchable)  →  STOCKED (what the
//   physical shelves carry, capacity-bounded, rank-selected)
//
// The renderer NEVER receives the master catalog — it receives the stocked
// list. Search/clerk/discovery see the full ELIGIBLE set; any eligible title
// that isn't currently on a shelf can be brought to the front via restock.
// Pure module (Node-testable).
import { isCurrentlyWatchable } from './watchability.js';
export { isCurrentlyWatchable, FRESHNESS_POLICY } from './watchability.js';

// Physical shelf capacity per department group (face-out display slots).
// Conservative vs the geometric maximum so spine inventory stays believable.
export const SHELF_CAPS = {
  'action|': 48, 'comedy|': 48, 'drama|': 48, 'horror|': 40, 'scifi|': 40,
  'thriller|': 40, 'classics|': 36, 'family|': 36, 'newreleases|': 24,
  'documentary|movie': 16, 'anime|movie': 16,
  'documentary|series': 8, 'anime|series': 10,
  'tvdrama|': 80, 'tvcomedy|': 56,
};

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// PHYSICAL CAPACITY
//
// The store is a capacity-bounded sample of the WHOLE catalogue — 122,948 titles
// cannot be ~270,000 case meshes. What changed is HOW the sample is chosen.
//
// SHELF_CAPS above were hand-tuned for a 546-slot boutique and are wildly uneven
// relative to what the catalogue actually contains: comedy is 16.5% of the
// catalogue but only 8.8% of that slot budget, classics 12.9% vs 6.6%. Reaching
// 15,000 faces by multiplying those constants would have scaled the DISTORTION,
// not the store — you would walk into sections whose sizes bear no relationship
// to the library behind them. So allocation is now proportional to catalogue
// composition, and SHELF_CAPS is retained only for the legacy boutique layout.
export const STORE_CAPACITY = 20000;

// Every section gets at least this many faces before proportional shares are
// handed out, so a genuinely small department (newreleases is 0.48% of the
// catalogue) is never rounded out of existence.
export const MIN_SECTION_FACES = 40;

/**
 * Divide `totalFaces` between department groups in proportion to how much of the
 * catalogue each one holds.
 *
 * Deterministic by construction: floors first, then the remainder by the
 * largest-remainder method with ties broken on the group key, so the same
 * catalogue always produces the same allocation. No group is ever given more
 * faces than it has titles, and the leftover from that clamp is redistributed
 * rather than silently lost.
 */
export function allocateCapacity(counts, totalFaces) {
  const keys = [...counts.keys()].sort();
  const alloc = new Map();
  let budget = totalFaces;

  // 1. floor for every non-empty group, never exceeding what it actually holds
  for (const k of keys) {
    const take = Math.min(counts.get(k), MIN_SECTION_FACES);
    alloc.set(k, take);
    budget -= take;
  }

  // 2. proportional share of what is left, over the titles beyond the floor
  const room = new Map(keys.map(k => [k, Math.max(0, counts.get(k) - alloc.get(k))]));
  let pool = keys.reduce((a, k) => a + room.get(k), 0);
  while (budget > 0 && pool > 0) {
    const exact = keys.map(k => ({ k, want: (room.get(k) / pool) * budget }));
    let handed = 0;
    for (const e of exact) {
      const give = Math.min(Math.floor(e.want), room.get(e.k));
      alloc.set(e.k, alloc.get(e.k) + give);
      room.set(e.k, room.get(e.k) - give);
      handed += give;
    }
    // largest remainder mops up the fractional part; without this the loop can
    // stall when every `want` is below 1.
    if (handed === 0) {
      const order = exact
        .filter(e => room.get(e.k) > 0)
        .sort((a, b) => (b.want - Math.floor(b.want)) - (a.want - Math.floor(a.want)) || a.k.localeCompare(b.k));
      for (const e of order) {
        if (handed >= budget) break;
        alloc.set(e.k, alloc.get(e.k) + 1);
        room.set(e.k, room.get(e.k) - 1);
        handed++;
      }
    }
    budget -= handed;
    pool = keys.reduce((a, k) => a + room.get(k), 0);
    if (handed === 0) break;      // nothing left that can absorb capacity
  }
  return alloc;
}

// Retained for the legacy boutique layout and for tests that assert the old
// section shape. NOT used by the capacity allocator.
export const ALL_TITLES_SCALE = 4;

// ELIGIBILITY IS NOT DEFINED HERE. It has exactly one definition, in
// ./watchability.js, and this module calls it. The old one-liner here
// (`services.stream ∩ myServices`) was a second, weaker implementation that
// skipped region, access type and provenance entirely — so the shelves and the
// "WATCHABLE FOR YOU" headline were answering a question nobody had audited.
export function isEligible(t, myServices) {
  return isCurrentlyWatchable(t, myServices).eligible;
}

/** The structured verdict — reason, providers, freshness — for UI and tests. */
export function watchabilityOf(t, myServices, options) {
  return isCurrentlyWatchable(t, myServices, options);
}

// Exported since phase 4: the merchandising engine (rotation.selectVisitStock)
// quotas its selection by the SAME department groups and the SAME allocator as
// this module, so the mix it hands back through `include` is exactly the mix
// the fixture pour was sized for. Two definitions of the grouping would let
// the two layers disagree again — the disagreement the 4A census caught.
export function deptGroupKey(t) {
  if (t.dept === 'documentary' || t.dept === 'anime') return `${t.dept}|${t.type}`;
  return `${t.dept}|`;
}

// Rank within a department, then take what the section's capacity allows.
//
// THE ARCHITECTURAL RULE LIVES HERE: availability is a RANKING key, never a
// filter. `relevant` moves subscription-matching titles toward the front of the
// section so a Netflix subscriber meets Netflix titles first — but a title that
// is unknown, unavailable or on somebody else's service is still in `titles` and
// can still be stocked. Availability decides WHERE a title appears; it never
// decides WHETHER it appears.
//
// FORCED-NESS DECIDES MEMBERSHIP; RANKING DECIDES ORDER (phase-4 §7). The
// forced list is sorted by the same key as the rest — it used to pass through
// in catalogue order, which meant that once the merchandising engine forced
// the whole visit's stock, the "Netflix titles first" ordering silently
// stopped applying to anything.
function rankAndCap(titles, cap, rng, forceIds, relevant = null) {
  const jitter = new Map(titles.map(t => [t.id, rng()]));
  const key = (a, b) =>
    // 1. subscription relevance — ordering only, and absent in THE STORE mode
    (relevant ? (relevant.has(b.id) ? 1 : 0) - (relevant.has(a.id) ? 1 : 0) : 0)
    // 2. iconic before deep cut
    || (a.pop ?? 2) - (b.pop ?? 2)
    // 3. seeded shuffle within a tier, so rotation feels fresh but reproduces
    || jitter.get(a.id) - jitter.get(b.id);
  const forced = titles.filter(t => forceIds.has(t.id)).sort(key);
  const rest = titles.filter(t => !forceIds.has(t.id)).sort(key);
  return [...forced, ...rest].slice(0, cap);
}

// mode: 'mine' (services determine the store) | 'all' (browse the master catalog)
export function buildProjection(catalog, myServices, mode, opts = {}) {
  const seed = opts.seed ?? 7;
  // include: one id or a LIST of ids. The single-id form fed the special-order
  // flow; the session-H living-inventory directive routes protected STACK
  // titles and the persistent rotation core through here too, and an array
  // wrapped as [array] silently forced nothing — the Set held the array
  // object, matching no id. Array-aware, backward compatible.
  const forceIds = new Set(opts.include
    ? (Array.isArray(opts.include) ? opts.include : [opts.include])
    : []);
  // MEMBERSHIP IS THE WHOLE CATALOGUE. Availability is not consulted here and
  // must never be: selecting Netflix used to delete every Max-only title from
  // the building, which made the store a filtered database view rather than a
  // video store. THE STORE, MY SERVICES and single-provider mode all merchandise
  // the same universe; the mode changes ORDER and LABELS, not membership.
  const candidates = catalog;

  // `eligible` is the INTELLIGENCE LAYER's answer — "what can this user actually
  // watch?" — kept for the headline count, search relevance and labels. It is
  // deliberately NOT the membership set any more, and the two numbers differing
  // is now correct rather than a leak.
  const personalized = mode === 'mine' && myServices.size > 0;
  const eligible = personalized ? catalog.filter(t => isEligible(t, myServices)) : catalog;
  const relevant = personalized ? new Set(eligible.map(t => t.id)) : null;

  // Derive the shuffle seed from WHICH services are selected, not how many
  // characters their names happen to total. `join('').length` collided freely —
  // {Netflix} and {Max, Hulu} both sum to 7 — so unrelated subscriptions shared
  // a shuffle order. Sorted so selection ORDER cannot change the store.
  const svcSeed = personalized
    ? [...myServices].sort().join('|').split('').reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 0)
    : 0;
  const rng = mulberry((seed + svcSeed) >>> 0);
  const byDept = new Map();
  for (const t of candidates) {
    const k = deptGroupKey(t);
    if (!byDept.has(k)) byDept.set(k, []);
    byDept.get(k).push(t);
  }
  // THE PRODUCT INVARIANT, and the reason SHELF_CAPS no longer applies here:
  //
  //   personalized  ->  stocked === eligible.  Every title the user can watch
  //                     gets a physical place in the store. The building is
  //                     generated to fit the projection; the projection is
  //                     never trimmed to fit the building. "1,425 watchable"
  //                     used to mean 258 on shelves, which made the headline
  //                     count a lie.
  //
  //   all titles    ->  still bounded. 122,948 titles cannot be ~270,000 case
  //                     meshes, so ALL TITLES is a browsable sample of the
  //                     master catalogue and the UI has to say so rather than
  //                     imply the shelves hold everything.
  // Sections sized in proportion to what the catalogue holds, then filled by
  // rank. Identical code path for every mode — only `relevant` differs.
  //
  // THE INCLUDE LIST IS AUTHORITATIVE (phase-4 §7, and the leak it repairs).
  // The proportional allocator used to size every section from the WHOLE
  // catalogue's composition and then `.slice(0, cap)` the ranked list —
  // forced ids included. Two allocators disagreed about department mix and
  // the projection quietly won: of a 20,000-id visit selection it dropped
  // 3,767 (782 of them titles the user could actually watch) and backfilled
  // sub-500-vote classics. Now every forced id is guaranteed its place — a
  // department's capacity is its forced count plus a proportional share of
  // whatever budget the forced ids leave over. Membership belongs to the
  // merchandising engine; this module shelves and ranks what it is handed.
  // With no include list the arithmetic reduces exactly to the old behaviour.
  const forcedByDept = new Map();
  if (forceIds.size) {
    for (const [k, list] of byDept) {
      const c = list.reduce((a, t) => a + (forceIds.has(t.id) ? 1 : 0), 0);
      if (c) forcedByDept.set(k, c);
    }
  }
  const totalForced = [...forcedByDept.values()].reduce((a, b) => a + b, 0);
  const freeBudget = Math.max(0, (opts.capacity ?? STORE_CAPACITY) - totalForced);
  const counts = new Map([...byDept].map(([k, list]) =>
    [k, list.length - (forcedByDept.get(k) ?? 0)]));
  // allocateCapacity's per-section floors assume the budget can cover them —
  // with a fully-forced store the free budget is zero and the floors would
  // conjure ~600 extra titles out of nothing.
  const freeAlloc = freeBudget > 0 ? allocateCapacity(counts, freeBudget) : new Map();
  const stocked = [];
  for (const [k, list] of byDept) {
    const cap = (forcedByDept.get(k) ?? 0) + (freeAlloc.get(k) ?? 0);
    stocked.push(...rankAndCap(list, cap, rng, forceIds, relevant));
  }
  return {
    personalized,
    eligible,
    stocked,
    stockedIds: new Set(stocked.map(t => t.id)),
    stats: {
      master: catalog.length,
      eligible: eligible.length,
      stocked: stocked.length,
      eligibleMovies: eligible.filter(t => t.type === 'movie').length,
      eligibleSeries: eligible.filter(t => t.type === 'series').length,
    },
  };
}

// Curation for the projection: computed from what's actually in the store.
//
// `relevant` (phase-4 §8): when the store is personalized, the curated
// front-of-store displays are where "MY SERVICES means something" is most
// visible — so a watchable title beats a discovery title for every curated
// spot, and discovery only tops up when watchable candidates run out. The
// shuffle still runs first, so WHICH watchable titles appear keeps rotating;
// the partition is stable so determinism is untouched.
export function buildCuration(stocked, seed = 11, relevant = null) {
  const rng = mulberry(seed);
  const sample = (list, n) => {
    const arr = [...list];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = (rng() * (i + 1)) | 0;
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    const picked = relevant
      ? [...arr.filter(t => relevant.has(t.id)), ...arr.filter(t => !relevant.has(t.id))]
      : arr;
    return picked.slice(0, n).map(t => t.id);
  };
  const pop = (n) => stocked.filter(t => (t.pop ?? 2) <= n);
  const movies = stocked.filter(t => t.type === 'movie');
  return {
    staffPicks: sample(pop(2), 16),
    hiddenGems: sample(stocked.filter(t => (t.pop ?? 2) >= 3), 14).length
      ? sample(stocked.filter(t => (t.pop ?? 2) >= 3), 14) : sample(stocked, 14),
    cultClassics: sample(stocked.filter(t => t.year >= 1968 && t.year <= 1999 &&
      t.genres.some(g => ['Horror', 'Sci-Fi', 'Comedy', 'Fantasy'].includes(g))), 14),
    ninetiesFavorites: sample(pop(2).filter(t => t.year >= 1990 && t.year <= 1999), 16),
    bingeWorthy: sample(pop(2).filter(t => t.type === 'series'), 14),
    familyNight: sample(stocked.filter(t => ['G', 'PG', 'TV-Y', 'TV-G', 'TV-PG'].includes(t.rating)), 12),
    criticallyAcclaimed: sample(pop(1), 16),
    leavingSoon: sample(stocked, 12),
    weekendMarathon: sample(stocked.filter(t =>
      (t.type === 'movie' && t.runtime >= 150) || (t.type === 'series' && t.seasons >= 5)), 10),
    oneNightWatch: sample(movies.filter(t => t.runtime <= 100), 12),
    // ROMANCE & ROM-COM — APPENDED LAST, AND THAT IS LOAD-BEARING.
    //
    // Every list above draws from ONE seeded rng stream, in source order.
    // Inserting a sample() call anywhere higher would re-roll every list
    // defined after it and silently re-merchandise half the store — a change
    // nobody asked for, showing up as "the staff picks are different now".
    // Appending leaves all ten existing lists byte-identical.
    //
    // SELECTION, NEVER MEMBERSHIP. The population is `stocked` — titles the
    // store has already chosen to carry. This cannot add a title to the store
    // or remove one, and it never consults availability; a curated shelf
    // decides what is DISPLAYED, not what is stocked.
    //
    // Both halves are drawn explicitly rather than trusting one blind sample
    // over all Romance: the shelf is called ROMANCE & ROM-COM, and a random
    // 14 out of 2,892 could easily come back with no comedies in it at all.
    // Straight romance leads, rom-coms follow, matching the label's own order.
    romanceRomCom: (() => {
      const N = 14, HALF = 7;
      const romance = stocked.filter(t => t.genres.includes('Romance'));
      const romCom = romance.filter(t => t.genres.includes('Comedy'));
      const straight = romance.filter(t => !t.genres.includes('Comedy'));
      const a = sample(straight, HALF);
      const b = sample(romCom, N - a.length);
      // A thin half must not leave holes in the shelf: the other one fills it.
      const seen = new Set([...a, ...b]);
      const short = N - a.length - b.length;
      const fill = short > 0 ? sample(romance.filter(t => !seen.has(t.id)), short) : [];
      return [...a, ...b, ...fill];
    })(),
  };
}
