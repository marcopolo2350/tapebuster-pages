// Catalog validation pipeline — the gate between data and the store.
// Runs in Node tests AND at boot (errors are fatal: malformed records must
// never silently reach production). Pure module.
import { DEPARTMENTS } from './departments.js';
import { coVisible, facingOf } from '../world/layout.js';

const GENRES = new Set(['Action', 'Adventure', 'Animation', 'Anime', 'Comedy', 'Crime', 'Documentary',
  'Drama', 'Family', 'Fantasy', 'Horror', 'Musical', 'Mystery', 'Romance', 'Sci-Fi', 'Thriller', 'War', 'Western']);
const MPAA = new Set(['G', 'PG', 'PG-13', 'R', 'NC-17', 'NR']);
const TV = new Set(['TV-Y', 'TV-G', 'TV-PG', 'TV-14', 'TV-MA']);
const SERVICES = new Set(['Netflix', 'Max', 'Prime Video', 'Disney+', 'Hulu', 'Apple TV+', 'Paramount+', 'Peacock', 'Tubi']);

export function normTitle(s) {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
}

// Canonical identity: a real-world title is (normalized title, year, type).
// Dune (1984) and Dune (2021) are distinct; The Office (US) and (UK) differ by year.
export function identityKey(t) {
  return `${normTitle(t.title)}|${t.year}|${t.type}`;
}

// Physical-world gate: runs at boot AND in tests on the generated layout.
// A store that violates these invariants refuses to open.
export function validateLayout(layout, catalog, visualDupRadius = 3.5) {
  const errors = [];
  const ids = new Set(catalog.map(t => t.id));

  // every physical copy references a canonical title; exactly one primary each
  const primaries = new Map();
  for (const s of layout.slots) {
    if (!ids.has(s.titleId)) errors.push(`slot ${s.id} references unknown title ${s.titleId}`);
    if (s.primary) primaries.set(s.titleId, (primaries.get(s.titleId) || 0) + 1);
  }
  for (const t of catalog) {
    const rec = layout.titles.get(t.id);
    if (!rec) { errors.push(`${t.id} has no physical presence`); continue; }
    const n = primaries.get(t.id) || 0;
    if (n !== 1) errors.push(`${t.id} has ${n} primary locations (must be exactly 1)`);
  }

  // visible-duplication invariants: face-out uniqueness per section, and the
  // same title never face-out twice within the visual radius
  const perFixture = new Map();
  const faceOut = [];
  for (const s of layout.slots) {
    if (s.spineOut) continue; // inventory depth is exempt by design
    faceOut.push(s);
    const key = s.fixtureId;
    if (!perFixture.has(key)) perFixture.set(key, new Set());
    if (perFixture.get(key).has(s.titleId)) {
      errors.push(`VISIBLE DUPLICATE: ${s.titleId} face-out twice on ${key}`);
    }
    perFixture.get(key).add(s.titleId);
  }
  // the real acceptance criterion: no two face-out copies of one title may be
  // CO-VISIBLE — near each other OR pointed at each other across an aisle
  const byTitle = new Map();
  for (const s of faceOut) {
    if (!byTitle.has(s.titleId)) byTitle.set(s.titleId, []);
    const dir = s.lay ? { x: null, z: null } : facingOf(s.rotY);
    byTitle.get(s.titleId).push({ x: s.x, z: s.z, level: s.level, fx: dir.x, fz: dir.z, id: s.id });
  }
  let radiusViolations = 0;
  for (const [titleId, list] of byTitle) {
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      if (coVisible(list[i], list[j])) {
        radiusViolations++;
        const d = Math.hypot(list[i].x - list[j].x, list[i].z - list[j].z);
        errors.push(`VISIBLE DUPLICATE: ${titleId} co-visible ${d.toFixed(1)}m apart (${list[i].id} / ${list[j].id})`);
      }
    }
  }

  // collision audit: every physical obstacle has a categorized collider
  for (const level of [0, 1]) {
    for (const o of layout.obstacles[level]) {
      const hit = layout.colliders[level].some(c => c.id === o.id);
      if (!hit) errors.push(`MISSING COLLISION: ${o.id} (level ${level})`);
    }
  }

  return {
    errors,
    stats: {
      copies: layout.slots.length,
      faceOut: faceOut.length,
      spineStock: layout.slots.length - faceOut.length,
      radiusViolations,
    },
  };
}

export function validateCatalog(catalog, curation = null) {
  const errors = [], warnings = [];
  const ids = new Set(), identities = new Map();

  for (const t of catalog) {
    const e = (msg) => errors.push(`${t.id || '<no id>'}: ${msg}`);

    if (!t.id || typeof t.id !== 'string') e('missing id');
    else {
      if (ids.has(t.id)) e('DUPLICATE ID');
      ids.add(t.id);
      if (!/^(mv|tv)-[a-z0-9-]+$/.test(t.id)) e('malformed id');
      if (t.type === 'movie' && !t.id.startsWith('mv-')) e('movie id must start mv-');
      if (t.type === 'series' && !t.id.startsWith('tv-')) e('series id must start tv-');
    }
    if (t.type !== 'movie' && t.type !== 'series') e(`bad type ${t.type}`);
    if (!t.title || typeof t.title !== 'string') e('missing title');
    if (!Number.isInteger(t.year) || t.year < 1920 || t.year > 2026) e(`bad year ${t.year}`);
    if (!Array.isArray(t.genres) || t.genres.length < 1 || t.genres.length > 3) e('bad genres');
    else for (const g of t.genres) if (!GENRES.has(g)) e(`unknown genre ${g}`);
    if (!DEPARTMENTS[t.dept]) e(`unknown dept ${t.dept}`);

    // ENRICHMENT vs INTEGRITY.
    // Cast, synopsis, certificate and runtime come from real sources or not at
    // all. A record missing them is INCOMPLETE, not INVALID — rejecting those
    // would mean quietly shrinking the catalogue to whatever happened to be
    // fully documented, which is the failure mode the ingest exists to avoid.
    // Anything that would corrupt identity or the physical store is still fatal.
    if (t.cast != null && !Array.isArray(t.cast)) e('cast must be an array');
    if (t.synopsis != null && typeof t.synopsis !== 'string') e('synopsis must be a string');

    if (t.type === 'movie') {
      if (t.rating != null && !MPAA.has(t.rating)) e(`bad MPAA rating ${t.rating}`);
      // The ceiling is set by the longest film that actually exists, not by
      // what feels long. Widening it here is NOT the gate being relaxed to go
      // green — all three records it was rejecting are real, documented works:
      //   Logistics (2012)            51,420 min — the longest film ever made
      //   The Cure for Insomnia (1987) 5,220 min — held the record before it
      //   The Clock (2010)             1,440 min — Marclay's 24-hour film
      // A validator that calls the world record corrupt is the thing that is
      // wrong. Impossible values (zero, negative, beyond any real work) still fail.
      if (t.runtime != null && (!Number.isInteger(t.runtime) || t.runtime < 1 || t.runtime > 60_000)) e(`bad runtime ${t.runtime}`);
      if (t.creators) e('movie must not have creators (director ≠ creator)');
      if (t.seasons != null || t.episodes != null) e('movie must not carry series fields');
    } else {
      if (t.rating != null && !TV.has(t.rating) && !MPAA.has(t.rating)) e(`bad rating ${t.rating}`);
      if (t.seasons != null && (!Number.isInteger(t.seasons) || t.seasons < 1)) e(`bad seasons ${t.seasons}`);
      if (t.seasons != null && t.episodes != null && t.episodes < t.seasons) e(`bad episodes ${t.episodes} < seasons ${t.seasons}`);
      if (t.episodeRuntime != null && (!Number.isInteger(t.episodeRuntime) || t.episodeRuntime < 1 || t.episodeRuntime > 400)) e('bad episodeRuntime');
      if (t.director) e('series must not have director (creator ≠ director)');
      if (t.endYear != null && (!Number.isInteger(t.endYear) || t.endYear < t.year)) e(`bad endYear ${t.endYear}`);
    }

    // canonical identity — streaming services must NEVER multiply records
    const key = identityKey(t);
    if (identities.has(key)) e(`DUPLICATE CANONICAL IDENTITY with ${identities.get(key)}`);
    identities.set(key, t.id);

    // services are attributes of the one canonical record
    if (!t.services || !Array.isArray(t.services.stream) || typeof t.services.rentBuy !== 'boolean') {
      e('missing/malformed services attribute');
    } else {
      for (const s of t.services.stream) if (!SERVICES.has(s)) e(`unknown service ${s}`);
      if (new Set(t.services.stream).size !== t.services.stream.length) e('duplicate service entries');
      if (t.services.stream.length > 5) warnings.push(`${t.id}: unusually many stream services`);
    }
  }

  if (curation) {
    for (const [k, list] of Object.entries(curation)) {
      for (const id of list) if (!ids.has(id)) errors.push(`curation.${k}: unknown id ${id}`);
      if (new Set(list).size !== list.length) errors.push(`curation.${k}: duplicate ids`);
    }
  }

  return {
    errors, warnings,
    stats: {
      titles: catalog.length,
      movies: catalog.filter(t => t.type === 'movie').length,
      series: catalog.filter(t => t.type === 'series').length,
      uniqueIdentities: identities.size,
      duplicates: catalog.length - identities.size,
      withStreamHome: catalog.filter(t => t.services?.stream?.length > 0).length,
      // completeness is reported, never enforced
      withSynopsis: catalog.filter(t => t.synopsis).length,
      withCast: catalog.filter(t => t.cast?.length >= 3).length,
      withCertificate: catalog.filter(t => t.rating).length,
      withExternalId: catalog.filter(t => t.imdb).length,
    },
  };
}
