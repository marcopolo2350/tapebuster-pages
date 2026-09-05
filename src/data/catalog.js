// TapeBuster catalog — loader for the versioned local snapshot.
//
// CANONICAL CONTENT MODEL: one record per real movie/series, identified by its
// stable external id (IMDb tconst, with TMDB id where Wikidata bridges them).
// A streaming provider NEVER creates a record: availability is a separate
// dataset (snapshot/availability.json) joined in here, so Breaking Bad is one
// title whether it sits on one service or five.
//
// The snapshot is built offline by scripts/ingest/* from IMDb's published
// datasets, Wikidata (CC0) and English Wikipedia. The running store needs ZERO
// API keys — it reads static local files and nothing else.
//
// Heavy per-title detail (cast, synopsis, creators) lives in snapshot/detail/*
// and is loaded lazily by ./detail.js so boot stays fast.

import { SUBSCRIPTION_PROVIDERS, FRESHNESS_POLICY } from './watchability.js';

const BASE = new URL('./snapshot/', import.meta.url);

async function loadJSON(name) {
  if (typeof window === 'undefined') {
    const [{ readFile }, { fileURLToPath }] = await Promise.all([
      import('node:fs/promises'), import('node:url'),
    ]);
    return JSON.parse(await readFile(fileURLToPath(new URL(name, BASE)), 'utf8'));
  }
  const r = await fetch(new URL(name, BASE));
  if (!r.ok) throw new Error(`catalog: cannot load ${name} (HTTP ${r.status})`);
  return r.json();
}

// SEQUENTIAL ON PURPOSE (iPhone pre-entry crash work). Promise.all parsed
// all three snapshots concurrently, so their raw-text buffers and freshly
// built object trees coexisted at one instant — the boot's single highest
// memory point, on the device class that jetsam-kills tabs for it. In
// sequence, each JSON's transient releases before the next begins; the only
// cost is the fetch latency no longer overlapping (~100-200ms).
const cat = await loadJSON('catalog.json');
const avail = await loadJSON('availability.json');
const alias = await loadJSON('aliases.json').catch(() => ({ aliases: {} }));

// ---------------------------------------------------------------- availability
// Rows are columnar. Positions are looked up from `columns` and never assumed —
// the schema grew from 5 fields to 7 when provenance moved onto the row.
//
// Each decoded row carries its OWN provenance:
//   { titleId, provider, region, accessType, verifiedAt, source, confidence }
// `verifiedAt` is null for every row nobody actually verified on a known date,
// which is the great majority of them. It is never back-filled from the build
// date — see scripts/ingest/04-build.mjs. `access` is kept as a deprecated
// alias of `accessType` for consumers written against the v1 shape.
const ai = Object.fromEntries(avail.columns.map((c, i) => [c, i]));
const availByTitle = new Map();
for (const row of avail.rows) {
  const titleId = row[ai.titleId];
  const accessType = row[ai.accessType != null ? ai.accessType : ai.access];
  let list = availByTitle.get(titleId);
  if (!list) { list = []; availByTitle.set(titleId, list); }
  list.push({
    titleId,
    provider: row[ai.provider],
    // v2 carries region per row. A v1 file only declared it once for the whole
    // dataset, so fall back to that declaration rather than inventing one — and
    // to null if even that is absent, because unknown region must stay unknown.
    region: ai.region != null ? row[ai.region] : (avail.region ?? null),
    accessType,
    access: accessType,
    // Absent column ⇒ we do not know when (or whether) this was verified. Null,
    // not the snapshot date.
    verifiedAt: ai.verifiedAt != null ? (row[ai.verifiedAt] ?? null) : null,
    source: ai.source != null ? row[ai.source] : null,
    confidence: ai.confidence != null ? row[ai.confidence] : null,
  });
}

/**
 * Provider names that represent a subscription the user can hold.
 * Re-exported from watchability.js so there is exactly one definition of what
 * "a subscription" means; eligibility and the services join cannot drift apart.
 */
export { SUBSCRIPTION_PROVIDERS };
const SUBSCRIBABLE = new Set(SUBSCRIPTION_PROVIDERS);
const INCLUDED_ACCESS = new Set(FRESHNESS_POLICY.accessTypes);

// ------------------------------------------------------------------- decoding
const col = Object.fromEntries(cat.columns.map((c, i) => [c, i]));
const G = cat.genres, D = cat.depts, C = cat.certs;

export const CATALOG = cat.rows.map((r) => {
  const isSeries = r[col.type] === 1;
  const imdb = r[col.imdb];
  const id = r[col.id] || `${isSeries ? 'tv' : 'mv'}-${imdb}`;

  const rows = availByTitle.get(id) || [];
  // The access types come from the POLICY. This read 'subscription' literally
  // until Tubi arrived carrying access 'free': the join then omitted every Tubi
  // row while isCurrentlyWatchable() counted it, so two parts of the system
  // disagreed about the same title. What the join excludes is RENT/BUY, which
  // is a purchase and not an entitlement — that has not changed.
  //
  // `services.stream` is the RAW JOIN of no-extra-cost rows onto the record — a
  // description of the data, not a watchability verdict. Whether the user can
  // watch a title is decided ONLY by watchability.isCurrentlyWatchable, which
  // additionally enforces region and the freshness/confidence policy. Keeping
  // this join raw is deliberate: it lets tests assert that the join and the
  // availability table agree without the policy silently hiding a row.
  const stream = [];
  let rentBuy = false;
  for (const a of rows) {
    if (INCLUDED_ACCESS.has(a.accessType) && SUBSCRIBABLE.has(a.provider)) {
      if (!stream.includes(a.provider)) stream.push(a.provider);
    } else if (a.accessType === 'rent' || a.accessType === 'buy') {
      rentBuy = true;
    }
  }

  const rec = {
    id,
    imdb,
    tmdb: r[col.tmdb] ?? null,
    type: isSeries ? 'series' : 'movie',
    title: r[col.title],
    originalTitle: r[col.origTitle] ?? null,
    year: r[col.year],
    genres: r[col.genres].map(i => G[i]),
    dept: D[r[col.dept]],
    pop: r[col.pop],
    votes: r[col.votes],
    score: r[col.score],
    rating: r[col.cert] == null ? null : C[r[col.cert]],
    services: { stream, rentBuy },
    availability: rows,
  };
  if (isSeries) {
    rec.seasons = r[col.seasons];
    rec.episodes = r[col.episodes];
    rec.episodeRuntime = r[col.runtime];
    rec.endYear = r[col.endYear] ?? null;
  } else {
    rec.runtime = r[col.runtime];
  }
  return rec;
});

export const BY_ID = new Map(CATALOG.map(t => [t.id, t]));

/** Ids from older snapshots (hand-authored slugs) still resolve. */
export const ALIASES = alias.aliases || {};
export function resolveId(id) {
  if (BY_ID.has(id)) return id;
  const a = ALIASES[id];
  return a && BY_ID.has(a) ? a : null;
}

export const SNAPSHOT = {
  version: cat.version,
  date: cat.snapshotDate,
  region: cat.region,
  sources: cat.sources,
  // WARNING for UI code: this is the snapshot BUILD date, not a verification of
  // any row. `availabilityVerifiedAtIsPerRow` is true for v2 snapshots, where
  // most rows carry verifiedAt: null. Do not render this as "availability
  // verified <date>" — read the per-row verifiedAt, or the `verified` flag on
  // the isCurrentlyWatchable() result, which is true only for real dated rows.
  availabilityVerifiedAt: avail.verifiedAt,
  availabilityVerifiedAtIsPerRow: avail.verifiedAtIsPerRow === true,
  availabilitySnapshotBuiltAt: avail.snapshotBuiltAt ?? avail.verifiedAt,
  availabilityDisclaimer: avail.disclaimer,
  availabilityProvenance: avail.provenance ?? null,
  availabilityProvenanceTiers: avail.provenanceTiers ?? [],
  rejectedSources: avail.rejectedSources || [],
  counts: {
    titles: CATALOG.length,
    movies: CATALOG.filter(t => t.type === 'movie').length,
    series: CATALOG.filter(t => t.type === 'series').length,
    availabilityRows: avail.rows.length,
    availabilityRowsWithVerificationDate: avail.provenance?.withVerificationDate ?? 0,
    availabilityRowsUndated: avail.provenance?.withoutVerificationDate ?? avail.rows.length,
  },
};
