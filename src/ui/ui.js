// All 2D UI. The physical store stays the hero — UI is chrome around it.
import { formatAddress } from '../world/layout.js';
import { searchCatalog, clerkRespond, totalRuntime } from '../systems/recommend.js';
import { makeThumb } from '../world/textures.js';
import { SNAPSHOT } from '../data/catalog.js';
import { YT_STATIONS, DEFAULT_STATION } from '../systems/radio/stations-yt.js';
import {
  buildShelfIndex, nextTitle, locate, rowLabel, shelfPosition, nextBrowsableShelf,
} from '../systems/next-title.js';
import {
  customPlaylists, addCustomPlaylist, removeCustomPlaylist, renameCustomPlaylist, setCurrentCustom,
  currentCustomId, parsePlaylistId, rejectionReason,
} from '../systems/radio/custom-playlists.js';
import { ensureDetail, applyDetail, hasDetail } from '../data/detail.js';
// The UI does not decide watchability — it reports the one authoritative
// verdict. Re-deriving it here would be a second answer to the question the
// shelves already answered.
import {
  isCurrentlyWatchable, REASONS, FRESHNESS_POLICY, SUBSCRIPTION_PROVIDERS, accessLabelFor,
  accessKindOf,
} from '../data/watchability.js';

const $ = (id) => document.getElementById(id);

// Placeholder cover for a title with no atlas tile (i.e. not currently shelved).
const NO_THUMB = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 46 64'>"
  + "<rect width='46' height='64' rx='4' fill='%230d1a3d'/>"
  + "<rect x='11' y='19' width='24' height='26' rx='2' fill='%23f2b705' fill-opacity='.10'/>"
  + "<rect x='11.5' y='19.5' width='23' height='25' rx='2' fill='none' stroke='%23f2b705' stroke-opacity='.40'/></svg>";

function fmtMins(mins) {
  if (mins == null || !Number.isFinite(mins) || mins <= 0) return null;
  const h = Math.floor(mins / 60), m = Math.round(mins % 60);
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}
/** Runtime string, or an em dash — never a confident "0m" for unknown data. */
const runtimeStr = (t) => fmtMins(totalRuntime(t)) || '?';
// Fields the sources didn't supply are omitted, never filled with a guess —
// so a metadata line shows what is actually known about that title.
function metaLine(t) {
  const parts = [];
  if (t.type === 'movie') {
    parts.push(String(t.year));
    if (t.rating) parts.push(t.rating);
    if (t.runtime) parts.push(fmtMins(t.runtime));
  } else {
    const span = t.endYear && t.endYear !== t.year ? `${t.year}-${t.endYear}` : String(t.year);
    parts.push(span);
    if (t.rating) parts.push(t.rating);
    if (t.seasons) parts.push(`${t.seasons} season${t.seasons === 1 ? '' : 's'}`);
    if (t.episodes) parts.push(`${t.episodes} eps`);
  }
  if (t.genres?.length) parts.push(t.genres.join(' / '));
  return parts.join(' · ');
}

// ---------------------------------------------------------- WHERE TO WATCH
//
// This block shows what QUALIFIES a title, and nothing more.
//
// The dataset is PRESENCE-ONLY. A row is evidence that a provider carried the
// title at the snapshot date; the absence of a row is evidence of nothing at
// all. 79,631 of 122,948 titles carry no row whatsoever, so a cross, a
// strikethrough or an "unavailable" against a service would manufacture
// negative availability at enormous scale from data that cannot support a
// single instance of it. Nothing here ever renders a cross for a service we
// simply hold no record of — every mark on this card is a positive statement,
// and where there is a gap the card names the gap instead.
//
// Four states have to be told apart, because collapsing any two is the lie:
//   • a row on a service you hold  → Included, or "Free with ads" when every
//                                    service named is ad-supported (see
//                                    includedWord) — this is why it is shelved
//   • a row on a service you don't → carried there, stated without a verdict
//   • rent/buy rows only           → a purchase, never a subscription entitlement
//   • no rows at all               → unknown, which is NOT unavailable
//
// The verdict is NOT computed here. isCurrentlyWatchable() is the single
// authority — it enforces region, access type, provider and the freshness /
// confidence policy — and this block renders only what it returns, including
// its deliberately strict `verified` flag. A UI that re-derived "watchable"
// would be a second opinion competing with the shelves.
const SUBSCRIBABLE = new Set(SUBSCRIPTION_PROVIDERS);
const accessOf = (r) => r.accessType ?? r.access ?? null;

// "Included" asserts an entitlement you pay for. A set that is ENTIRELY free
// services earns the free word instead; a mixed set keeps "Included", because
// at least one named service really is something you subscribe to. Never .some():
// "Free with ads · Netflix · Tubi" would be the opposite error.
//
// This keys off accessKindOf(provider) — a property of the SERVICE — while the
// full-panel per-row state at stateOf() below keys off x.access, a property of
// the ROW. They are two different mechanisms, not one rule read twice. In this
// snapshot they cannot disagree (every free row is a Tubi row and Tubi has no
// non-free rows), but a future free tier on a paid service would separate them.
// Materialised first because the callers hand over arrays today but the
// obvious future caller is myServices, which is a SET: `Set.length` is
// undefined, and an undefined length would send every free-only selection down
// the "Included" path — silently reprinting the paid claim.
export const includedWord = (providers) => {
  const named = [...providers];
  return named.length && named.every(p => accessKindOf(p) === 'free')
    ? 'Free with ads' : 'Included';
};

function servicesBlock(t, compact = false, myServices = null) {
  const mine = myServices?.size ? myServices : null;
  const rows = Array.isArray(t.availability) ? t.availability : [];
  const verdict = isCurrentlyWatchable(t, mine || []);

  // Every subscription provider this title has evidence for, each carrying the
  // authority's own answer for that provider alone — so "Included" on this card
  // means exactly what "eligible" means to the projection, provider by provider.
  // Access types come from the POLICY, not a hardcoded 'subscription'. Tubi is
  // ad-supported and its rows carry access 'free'; testing the literal string
  // made every Tubi row invisible here while the shelves still counted it.
  const INCLUDED = new Set(FRESHNESS_POLICY.accessTypes);
  const providers = [...new Set(rows
    .filter(r => INCLUDED.has(accessOf(r)) && SUBSCRIBABLE.has(r.provider))
    .map(r => r.provider))];
  const subs = providers.map((p) => {
    const v = isCurrentlyWatchable(t, [p]);
    const acc = rows.find(r => r.provider === p && INCLUDED.has(accessOf(r)));
    return { provider: p, yours: !!mine?.has(p), ok: v.eligible, reason: v.reason,
      m: v.matches[0] || null, access: acc ? accessOf(acc) : null };
  });
  subs.sort((a, b) => (b.yours ? 1 : 0) - (a.yours ? 1 : 0) || (b.ok ? 1 : 0) - (a.ok ? 1 : 0));
  // Rent/buy is a PURCHASE. It is never listed as "Included" and never makes a
  // title watchable on a subscription.
  const rent = [...new Set(rows.filter(r => accessOf(r) === 'rent' || accessOf(r) === 'buy').map(r => r.provider))];

  const link = `<a href="https://www.justwatch.com/us/search?q=${encodeURIComponent(t.title)}" target="_blank" rel="noopener">check current ↗</a>`;
  const NO_DATA = 'Availability not verified in this snapshot.';
  const RENT_ONLY = 'Available to rent or buy. Not on any service you hold.';

  if (compact) {
    if (!subs.length) {
      return `<span class="svc-line"><i class="svc-plain">${rent.length ? RENT_ONLY : NO_DATA}</i></span>`;
    }
    const badge = verdict.eligible
      ? `<i class="svc mine">✓ ${includedWord(verdict.providers)} · ${verdict.providers.join(' · ')}</i>` : '';
    const rest = subs.filter(x => !(x.yours && x.ok)).map(x => `<i class="svc">${x.provider}</i>`).join('');
    // No cross and no verdict of absence — just the absence of a tick.
    const gap = mine && !verdict.eligible ? `<i class="svc-plain">no record on your services</i>` : '';
    return `<span class="svc-line">${badge}${rest}${gap}</span>`;
  }

  // A DATE IS PRINTED ONLY WHERE A ROW ACTUALLY CARRIES ONE.
  //
  // The snapshot's file-level date is when the data was BUILT, not when anyone
  // checked a streaming catalogue: 48,126 of 48,425 rows have verifiedAt null,
  // because Wikidata's per-service ids are not time-scoped. Stamping the build
  // date onto those rows would manufacture precisely the freshness this pass
  // exists to remove, so the word "verified" is spent only on the authority's
  // strict flag and a real row date.
  const stampOf = (m) => !m?.verifiedAt ? 'Not independently date-verified'
    : m.freshness === 'verified' ? `Verified ${m.verifiedAt}`
      : `Last verified ${m.verifiedAt}, older than ${FRESHNESS_POLICY.maxAgeDays} days`;

  const line = (provider, state, cls = '') =>
    `<li class="wtw ${cls}"><span class="wtw-svc">${provider}</span><span class="wtw-state">${state}</span></li>`;

  // Per-provider state. A provider we hold evidence for but which does not clear
  // the policy is described by what we actually have ("listed") — never crossed
  // out, never called unavailable.
  const stateOf = (x) => {
    if (!x.ok) {
      return x.reason === REASONS.WRONG_REGION
        ? `Listed outside ${FRESHNESS_POLICY.region}` : 'Listed, evidence below our bar';
    }
    // "Free" is said plainly rather than folded into "Included" — Tubi costs
    // nothing and carries ads, which is a different fact from a subscription
    // the shopper pays for, even though both answer "watchable at no extra cost".
    const kind = x.access === 'free' ? 'Free with ads' : 'Included';
    return x.m?.freshness === 'verified'
      ? `${kind} <em>· verified ${x.m.verifiedAt}</em>` : kind;
  };

  const list = [
    ...subs.map(x => line(`${x.yours && x.ok ? '✓ ' : ''}${x.provider}`, stateOf(x),
      x.yours && x.ok ? 'is-yours' : '')),
    ...rent.map(p => line(p, 'Rent or buy', 'is-rent')),
  ].join('');

  // The one sentence naming what we do NOT know, chosen by the authority's own
  // reason code rather than guessed from the shape of the data.
  const gap =
    !subs.length && !rent.length ? NO_DATA
      : !subs.length ? RENT_ONLY
        : !mine || verdict.eligible ? ''
          : verdict.reason === REASONS.WRONG_REGION
            ? `Streaming listings exist, but none scoped to ${FRESHNESS_POLICY.region} in this snapshot.`
            : verdict.reason === REASONS.FAILED_POLICY
              ? 'Listed on a service you hold, but the evidence does not clear our confidence bar.'
              : 'No record on your services in this snapshot. That is missing data, not a confirmed absence.';

  // The qualifier: region · access type · the verification we actually hold.
  // Never a bare "available", and never a date we did not earn.
  const best = verdict.matches[0] || subs.find(x => x.ok)?.m || null;
  const qualifier = (subs.length || rent.length)
    ? `<p class="wtw-stamp">${[FRESHNESS_POLICY.region,
        subs.length ? accessLabelFor(subs.map(x => x.provider)) : 'Rent or buy', stampOf(best)]
        .filter(Boolean).join(' · ')}</p>`
    : '';

  return `<div class="where-to-watch">
    <b>WHERE TO WATCH</b>
    ${list ? `<ul class="wtw-list">${list}</ul>` : ''}
    ${qualifier}
    ${gap ? `<p class="wtw-gap">${gap}</p>` : ''}
    <p class="svc-note">Snapshot built ${SNAPSHOT.availabilitySnapshotBuiltAt}. That is a build date, not a check of today's catalogue. ${link}</p>
  </div>`;
}

// Credits render only what the sources actually gave us. A film with no known
// director shows its cast; a title with neither shows nothing at all.
// THE SYNOPSIS ANSWERS "WHAT IS IT?", SO IT LEADS EVERY TITLE SURFACE.
//
// The data audit measured 99.1% of the stocked floor carrying a real, sourced
// synopsis (Wikipedia CC BY-SA preferred, TMDB overview otherwise) — yet both
// the card and the inspector buried it mid-panel and rendered NOTHING while
// the lazy detail shard was still in flight, which on a phone is every first
// open. Three states, all honest, none invented:
//   the sourced text · "finding the blurb" while the shard loads · a recorded
//   "no synopsis on file". The application never writes a synopsis of its own.
function synopsisBlock(t) {
  if (t.synopsis) return `<p class="syn syn-lead">${t.synopsis}</p>`;
  if (!hasDetail(t.id)) return `<p class="syn syn-lead syn-soft">Finding the blurb…</p>`;
  return `<p class="syn syn-lead syn-soft">No synopsis on file for this one.</p>`;
}

/**
 * Fold cached detail into a record before anything reads it, and report
 * whether the record is now settled.
 *
 * WHY THIS EXISTS, AND WHY EVERY TITLE SURFACE MUST CALL IT.
 *
 * hasDetail(id) answers "is this id in the detail CACHE", which is not the
 * same question as "does this record carry its blurb". A shard fetch caches
 * every one of its ~1,920 titles, while applyDetail folds only the records it
 * is handed. On a phone — where nothing is bulk-loaded — opening one title
 * therefore made every OTHER title in that shard report hasDetail === true
 * while its own `synopsis` stayed undefined, and the card printed "No synopsis
 * on file for this one." about a blurb sitting in memory one Map lookup away.
 * After a handful of opens that covers a large slice of the floor; after 64
 * shards, all of it.
 *
 * An invented absence is exactly as dishonest as an invented synopsis, so the
 * fold happens on the read path, where it costs a Map lookup.
 */
function hydrateDetail(t) {
  if (!hasDetail(t.id)) return false;
  applyDetail([t]);
  return true;
}

function creditLine(t, compact) {
  const who = t.type === 'movie'
    ? (t.director ? `${compact ? 'Dir.' : 'Directed by'} ${t.director}` : '')
    : (t.creators ? `Created by ${t.creators}` : '');
  const cast = t.cast?.length ? (compact ? t.cast.slice(0, 3).join(', ') : t.cast.join(' · ')) : '';
  if (!who && !cast) return '';
  const sep = compact ? ' · ' : '<br>';
  return `<p class="who">${[who, cast].filter(Boolean).join(sep)}</p>`;
}

// §33 hard assertion: any user-facing list must contain unique canonical ids.
function assertCanonical(titles, context) {
  const ids = titles.map(t => t.id);
  if (new Set(ids).size !== ids.length) {
    const msg = `DUPLICATE CANONICAL TITLES rendered in ${context}: ${ids.join(', ')}`;
    console.error(msg);
    throw new Error(msg);
  }
  return titles;
}

// Record a recoverable failure where the crash forensics already look, rather
// than swallowing it. main.js installs the global error handlers; this is for
// the cases that are CAUGHT and degraded, which no global handler ever sees.
function noteRecoverable(what, err) {
  const msg = `recovered(${what}): ${err?.message ?? String(err)}`;
  console.warn(msg);
  try { localStorage.setItem('tb_lasterror', `${msg} [t=${Math.round(performance.now() / 1000)}s]`); }
  catch { /* storage full — forensics degrade, the store does not */ }
}

// Same sniff main.js uses for isMobileDevice, kept local so ui.js does not
// have to be handed the flag through its constructor.
function isCoarsePointer() {
  try { return matchMedia('(pointer: coarse)').matches && Math.min(innerWidth, innerHeight) < 860; }
  catch { return false; }
}

export class UI {
  constructor({ catalog, curation, layout, atlases, audio, actions, modes, player }) {
    Object.assign(this, { catalog, curation, layout, atlases, audio, actions, modes, player });
    /** render quality: 'auto' sniffs the device, 'smooth' favours frame rate,
     *  'sharp' favours pixels — the user's word beats any heuristic */
    this.quality = localStorage.getItem('tb_quality') || 'auto';
    this.byId = new Map(catalog.map(t => [t.id, t]));
    // BOUNDED. This was an unbounded Map of base64 PNG data URLs, one per
    // title ever surfaced in search, the clerk, the stack or "what can I
    // watch" — with a ceiling of the whole 20,000-title store at ~8-15 KB
    // each, i.e. 150-300 MB of JS heap, and an eviction path that only ran on
    // restock. Insertion-ordered Map + delete-oldest is a true LRU here
    // because `thumb()` re-inserts on every hit.
    this.thumbCache = new Map();
    this.thumbCacheMax = isCoarsePointer() ? 240 : 900;
    this.stack = [];
    this.clerkSession = { suggested: new Set(), n: 0 };
    this.toastTimer = null;
    this.debugOpen = false;
    this.debugFlags = { path: false, grid: false, colliders: false };
    // My Services: the user's actual subscriptions (persisted, no accounts)
    try { this.myServices = new Set(JSON.parse(localStorage.getItem('tb_services') || '[]')); }
    catch (e) { this.myServices = new Set(); noteRecoverable('services', e); }
    this.svcFilter = localStorage.getItem('tb_filter') || 'all'; // 'all' | 'mine'
    this.lastSearchStats = { results: 0, unique: 0 };

    this.loadStack();
    this.bind();
    this.renderStackButton();
    this.renderFilterChip();
  }

  // ------------------------------------------------------------ watchables
  // The searchable universe: the projection's ELIGIBLE set (your services'
  // libraries when personalized; the master catalog in ALL TITLES mode).
  /**
   * The ids the store actually carries right now.
   *
   * ONE SOURCE. isStocked() already reads projection.stockedIds, and deriving
   * a second answer from layout.titles would give the clerk a definition of
   * "in stock" that could drift from the one the search results use. The
   * projection's own Set is reused rather than rebuilt.
   */
  stockedIds() {
    return this.actions.getProjection?.()?.stockedIds ?? null;
  }

  searchPool() {
    return this.actions.getProjection ? this.actions.getProjection().eligible : this.catalog;
  }
  // Every title you can watch AND walk to — the INTERSECTION of the two backend
  // outputs, availability ∩ membership.
  //
  // This used to return `stocked` outright, which was correct only while the two
  // sets were the same set. Post-pivot they are deliberately different, and
  // returning `stocked` put 15,000 rows under a "KNOWN ON NETFLIX · 1,425"
  // headline — the exact collapse this architecture exists to prevent, just in
  // the other direction. Intersecting two given sets is not recomputing
  // watchability: nothing here decides what is watchable, watchability.js already
  // did, and `stockedIds` already decided what is on a shelf.
  watchables() {
    const s = this.storeState();
    if (!s.personal || s.restocking || !s.projection) return [];
    const p = s.projection;
    return p.eligible.filter(t => p.stockedIds.has(t.id));
  }
  // "Show me something I can watch" only ever offers what is physically here AND
  // actually watchable. Personal mode used to hand back all of `stocked`, so the
  // one button that promises watchability was the one place that could hand you
  // a title you cannot watch — while THE STORE mode below got it right.
  surprisePool() {
    const s = this.storeState();
    if (!s.projection || s.restocking) return [];
    if (s.personal) return this.watchables();
    return this.myServices.size
      ? s.projection.stocked.filter(t => isCurrentlyWatchable(t, this.myServices).eligible)
      : [];
  }
  isStocked(id) {
    const p = this.actions.getProjection?.();
    return p ? p.stockedIds.has(id) : true;
  }

  // -------------------------------------------------- THE ONE WATCHABLE COUNT
  //
  // Exactly ONE number in this UI is allowed to answer "how many titles can I
  // watch?", and it is read straight off the projection: `stats.stocked`, the
  // titles that have a physical place in the store right now. It is never
  // recomputed from the catalogue. A second derivation is a second answer, and
  // the number the headline quotes has to be the number the shelves can
  // actually produce — otherwise "WATCHABLE FOR YOU" is a claim about a store
  // that doesn't exist.
  //
  // `restocking` guards the debounced rebuild. Between a service toggle and the
  // new shelves the live projection still describes the PREVIOUS selection, so
  // its number describes a store that is already gone. We detect that by
  // IDENTITY — the projection object we saw when the selection changed is still
  // the live one — and by asking the projection whether it is personalized at
  // all. Neither check recomputes an eligible set, which is precisely the
  // second count this section exists to prevent. While restocking we say so
  // instead of quoting a number we cannot stand behind.
  markRestockPending() {
    this._staleProjection = this.actions.getProjection?.() || null;
  }
  storeState() {
    const p = this.actions.getProjection?.() || null;
    if (p && this._staleProjection && p !== this._staleProjection) this._staleProjection = null;
    // MODE. 'all' = THE STORE, 'mine' = MY SERVICES, or a single provider name.
    // A provider mode with that service unticked, or 'mine' with nothing ticked,
    // degrades to THE STORE rather than showing an empty claim.
    const focus = this.focusServices();
    const personal = focus.length > 0;
    const restocking = !p || !!this._staleProjection || p.personalized !== personal;
    const avail = this.actions.getAvailability?.() || null;
    return {
      projection: p,
      personal,
      restocking,
      mode: this.svcFilter,
      // Who THE STORE's availability number is scoped to. Named so the chip can
      // never print a count without printing what it is a count OF.
      availServices: personal ? focus : (avail ? avail.services : []),
      // TWO NUMBERS, DELIBERATELY SEPARATE. Collapsing them is the overclaim this
      // whole architecture exists to prevent:
      //   watchable = eligible — what the evidence says you can actually watch
      //   shelved   = stocked  — what is physically merchandised in the building
      // These are now different by design (Netflix: 1,425 watchable of 15,000
      // shelved). Reading `stocked` as the watchable count — which this used to
      // do — republishes the merchandising number as an entitlement claim.
      // Focus-scoped when a mode has a focus (NETFLIX -> Netflix's 1,425);
      // otherwise THE STORE's own all-services availability output, so every
      // mode answers "how many of these can I watch?" and none of them answers
      // it with the shelf count.
      watchable: restocking ? null
        : personal ? p.stats.eligible
          : (avail ? avail.count : null),
      shelved: p ? p.stats.stocked : null,
      master: p ? p.stats.master : this.catalog.length,
      services: focus,
      // INTEGRITY CHECK, re-pointed. It used to flag stocked !== eligible, which
      // was the retired membership rule and is now the correct state. What is
      // genuinely broken is the inverse: a personalized store carrying NOTHING
      // but watchable titles means availability has become a filter again.
      broken: !!p && p.personalized && p.stats.stocked > 0
        && p.stats.stocked === p.stats.eligible && p.stats.eligible < p.stats.master,
    };
  }

  /**
   * The services the current mode ranks by. THE STORE ranks by nothing; MY
   * SERVICES ranks by everything you hold; a provider mode ranks by that one —
   * but only if you actually hold it, so the UI cannot promise a focus the
   * projection will not honour.
   */
  focusServices() {
    if (this.svcFilter === 'all') return [];
    if (this.svcFilter === 'mine') return UI.SERVICES.filter(n => this.myServices.has(n));
    return this.myServices.has(this.svcFilter) ? [this.svcFilter] : [];
  }
  static n(v) { return Number(v).toLocaleString(); }

  // The single qualified claim the whole UI renders. Chip, panel banner and
  // Settings all call THIS — there is one of it, so they cannot drift apart.
  //
  //    WATCHABLE FOR YOU · 2,145 titles
  //    Netflix · Max · US · Subscription
  //
  // WHAT "WATCHABLE" IS ALLOWED TO MEAN HERE. It means precisely what
  // watchability.isCurrentlyWatchable() certifies under policy
  // us-subscription-v1: a US row whose access the policy admits — 'subscription'
  // OR 'free', because ad-supported answers "watchable at no extra cost" at
  // least as strongly as a subscription does — on a service you actually hold,
  // from a provider we model as subscribable, clearing the confidence floor.
  // That policy deliberately admits UNDATED rows and labels them, because
  // refusing them would treat "we cannot date this evidence" as "this evidence
  // is false" — the same fallacy as reading a missing row as proof of absence.
  // The claim is therefore exactly as strong as the authority behind it, and no
  // stronger.
  //
  // The evidence STRENGTH is not hidden to buy that word: WHERE TO WATCH prints
  // "Not independently date-verified" on every title whose rows carry no date,
  // and spends "Verified <date>" only on the authority's strict flag. The
  // headline names the entitlement; the card shows the receipts.
  //
  // The qualifier is not decoration: the count is only true for those services,
  // in that region, at the access the last field names — which is DERIVED from
  // the services in hand ("Subscription", "Free with ads", or both), never the
  // hardcoded word it used to be. Dropping it turns a scoped fact into a claim
  // about "everything", which the sources cannot support.
  claim() {
    const s = this.storeState();
    if (!s.personal) return null;
    const on = s.mode !== 'mine' && s.services.length === 1
      ? `KNOWN ON ${s.services[0].toUpperCase()}`
      : 'KNOWN ON YOUR SERVICES';
    if (s.restocking) return { head: on, sub: 'restocking the shelves…', state: 'pending' };
    if (s.broken) {
      return {
        head: '⚠ availability is filtering the store',
        sub: `all ${UI.n(s.shelved)} shelved titles are watchable, so membership should not be filtered`,
        state: 'broken',
      };
    }
    // BOTH numbers, never one. The first is the entitlement claim and is scoped
    // by the qualifier line; the second is the size of the building. A reader
    // who sees only the first would think the store held 1,425 titles; a reader
    // who sees only the second would think they could watch 15,000.
    return {
      head: `${on} · ${UI.n(s.watchable)} titles`,
      shelf: `${UI.n(s.shelved)} in the store`,
      // The access word is DERIVED from the services in hand, not hardcoded:
      // 'Subscription' over Tubi claimed a paid entitlement that does not exist.
      sub: [...s.services, SNAPSHOT.region, accessLabelFor(s.services)].filter(Boolean).join(' · '),
      state: 'ok',
    };
  }

  // The chip is the one always-visible answer to "what am I looking at?". It
  // stays a chip: two short lines, top corner, out of the shop floor's way.
  /**
   * The dock exists only while a YouTube station is on air. The store station
   * needs no player and gets no dock.
   *
   * ONE timer, created once and never replaced — a dock that re-registered its
   * own interval on every render would leave a fan of them behind after a few
   * station changes, and this app is being measured for exactly that kind of
   * accumulation. It is a cheap tick that reads one object, and it returns
   * immediately whenever the dock is hidden.
   */
  /**
   * NOW PLAYING, IN SETTINGS. There is no dock on the shop floor any more, so
   * this renders into the Settings panel and only when that panel is open —
   * a 4 s timer repainting a hidden panel is work nobody can see.
   */
  renderRadioDock() {
    const host = $('st-now');
    if (!host) return;
    const st = this.audio.radioState?.() ?? {};
    const sel = this.audio.stationPlaylists?.();
    $('st-now-station').textContent = sel?.label ?? 'No station';
    $('st-now-track').textContent = this.audio.radioOn
      ? (st.nowPlaying ?? (st.blocked ? 'Paused by your browser. Press PLAY.' : 'Tuning in…'))
      : 'Music is off.';
    const trouble = this.audio.radioTrouble?.() ?? null;
    const tEl = $('st-now-trouble');
    tEl.classList.toggle('hidden', !trouble);
    if (trouble) tEl.textContent = trouble;
    const play = $('st-now-play');
    if (play) play.textContent = st.playing && !st.blocked ? '❚❚ PAUSE' : '▶ PLAY';

    if (!this._dockTimer) {
      this._dockTimer = setInterval(() => {
        const p = $('panel-settings');
        if (p && !p.classList.contains('hidden')) this.renderRadioDock();
      }, 4000);
    }
  }

  /**
   * The shopper's saved playlists, each selectable exactly like a station.
   *
   * THIS METHOD AND addCustomPlaylist() BELOW WERE CALLED BUT NEVER DEFINED.
   * bindSettings() has been calling this.renderCustomPlaylists() since the
   * custom-playlist pass, and a call to an undefined method throws — so every
   * binding AFTER that line never ran. That is why the camera-bob and
   * speed-FOV sliders did nothing on the device: they are bound two lines
   * below, and control never reached them.
   *
   * The gate missed it because it tested the custom-playlists MODULE and
   * grepped the markup for "ADD PLAYLIST". Neither of those touches the wiring.
   */
  renderCustomPlaylists() {
    const host = $('st-custom-list');
    if (!host) return;
    const list = customPlaylists();
    const cur = currentCustomId();
    if (!list.length) {
      host.textContent = '';
      const p = document.createElement('p');
      p.className = 'st-desc';
      p.textContent = 'No saved playlists yet.';
      host.appendChild(p);
      return;
    }
    // BUILT WITH textContent, NOT innerHTML. The name is typed by the shopper
    // and the channel comes back from YouTube; neither belongs in markup.
    host.textContent = '';
    for (const p of list) {
      const row = document.createElement('div');
      row.className = 'st-custom-row' + (p.id === cur ? ' active' : '');
      const nm = document.createElement('span');
      nm.className = 'st-custom-name';
      nm.textContent = p.name;
      const by = document.createElement('span');
      by.className = 'st-custom-by';
      by.textContent = p.author ?? '';
      const play = document.createElement('button');
      play.dataset.play = p.id; play.title = 'Play this playlist'; play.textContent = '▶';
      const ren = document.createElement('button');
      ren.dataset.ren = p.id; ren.title = 'Rename'; ren.textContent = '✎';
      const del = document.createElement('button');
      del.dataset.del = p.id; del.title = 'Remove'; del.textContent = '✕';
      row.append(nm, by, play, ren, del);
      host.appendChild(row);
    }
    host.querySelectorAll('[data-play]').forEach((b) => {
      // Synchronous, inside the tap, for the same reason the station dial is.
      b.onclick = () => {
        this.audio.uiBlip();
        setCurrentCustom(b.dataset.play);
        this.audio.playStation('custom');
        this.renderSettings();
        this.renderRadioDock();
        this.toast('Tuning to your playlist…', 2000);
      };
    });
    // RENAME EDITS THE ROW IN PLACE. A prompt() would be a modal on top of a
    // modal, and on iOS it steals focus from the settings sheet; swapping the
    // label for an input keeps the shopper where they already are.
    host.querySelectorAll('[data-ren]').forEach((b) => {
      b.onclick = () => {
        this.audio.uiBlip();
        const id = b.dataset.ren;
        const row = b.closest('.st-custom-row');
        const label = row.querySelector('.st-custom-name');
        if (!label || row.querySelector('input')) return;
        const box = document.createElement('input');
        box.className = 'st-custom-edit';
        box.value = label.textContent;
        box.maxLength = 48;
        box.setAttribute('aria-label', 'Playlist name');
        const commit = (save) => {
          // DETACH FIRST. Re-rendering removes the focused input, which fires
          // blur — and blur commits. Without this, Escape cancelled the edit
          // and was then immediately undone by its own blur, saving the very
          // text it was pressed to discard.
          box.onblur = null;
          box.onkeydown = null;
          if (save) renameCustomPlaylist(id, box.value);
          this.renderCustomPlaylists();
          this.renderRadioDock();
        };
        box.onkeydown = (e) => {
          // The world listens for keys too. Typing a name must not walk the
          // shopper down an aisle, and Escape must cancel rather than bubble.
          e.stopPropagation();
          if (e.key === 'Enter') commit(true);
          else if (e.key === 'Escape') commit(false);
        };
        box.onblur = () => commit(true);
        label.replaceWith(box);
        box.focus();
        box.select();
      };
    });
    host.querySelectorAll('[data-del]').forEach((b) => {
      b.onclick = () => {
        this.audio.uiBlip();
        // DELETE ASKS ONCE. It sits a few millimetres from PLAY on a phone,
        // and there is no undo for it, so the first tap arms and the second
        // removes. Re-rendering the list disarms every other row, so an armed
        // button cannot be left lying around for a later mis-tap.
        // A DOUBLE-CLICK IS A NORMAL CLICK PATH. Two clicks inside the usual
        // double-click window would otherwise arm and delete in one gesture,
        // with DELETE? never actually seen. The second tap has to be a
        // deliberate one, so it is ignored until the label has been readable.
        const ARM_MS = 350;
        if (b.dataset.armed === '1' && Date.now() - Number(b.dataset.armedAt || 0) < ARM_MS) return;
        if (b.dataset.armed !== '1') {
          host.querySelectorAll('[data-del]').forEach((o) => {
            o.dataset.armed = '0'; o.textContent = '✕'; o.classList.remove('armed');
          });
          b.dataset.armed = '1';
          b.dataset.armedAt = String(Date.now());
          b.textContent = 'DELETE?';
          b.classList.add('armed');
          b.title = 'Tap again to remove';
          return;
        }
        const wasCurrent = currentCustomId() === b.dataset.del;
        removeCustomPlaylist(b.dataset.del);
        // Deleting what is ON AIR has to stop it, or the store keeps playing
        // something the shopper just removed.
        if (wasCurrent) this.audio.playStation(DEFAULT_STATION);
        // THE LIST ITSELF HAS TO BE REDRAWN. renderSettings() updates the
        // mode buttons and the service toggles in place and never touches
        // #st-custom-list, so the removed playlist stayed on screen and the
        // delete looked like it had done nothing. It also left every other
        // row's DELETE? still armed, one stray tap from a second deletion.
        this.renderCustomPlaylists();
        this.renderSettings();
        this.renderRadioDock();
      };
    });
  }

  /**
   * Validate BEFORE saving. The point of the feature is that a bad link is
   * refused here, with a reason, rather than accepted and then failing later
   * as a station that makes no sound. oEmbed is the same official, key-free
   * endpoint the curated registry is verified with.
   *
   * This is the ONE place oEmbed still runs, and it is not on the playback
   * path: it happens when a playlist is ADDED, never when one is played.
   */
  async addCustomPlaylist() {
    const msg = $('st-custom-msg');
    const url = $('st-custom-url').value.trim();
    const name = $('st-custom-name').value.trim();
    const id = parsePlaylistId(url);
    if (!id) { msg.textContent = rejectionReason(url); return; }

    msg.textContent = 'Checking that playlist…';
    let meta = null;
    try {
      const r = await fetch(`https://www.youtube.com/oembed?format=json&url=${
        encodeURIComponent(`https://www.youtube.com/playlist?list=${id}`)}`);
      if (r.ok) meta = await r.json();
    } catch { /* offline: reported below, never saved on a guess */ }
    if (!meta) {
      msg.textContent = 'Could not load that playlist. Check that the URL is a YouTube playlist, '
        + 'that the playlist is public, and that you are online.';
      return;
    }

    const res = addCustomPlaylist({ name, url, title: meta.title, author: meta.author_name });
    if (!res.ok) { msg.textContent = res.reason; return; }
    msg.textContent = `Added “${meta.title}”${meta.author_name ? ` by ${meta.author_name}` : ''}.`;
    $('st-custom-url').value = '';
    $('st-custom-name').value = '';
    this.renderCustomPlaylists();
  }

  /**
   * BROWSE THE SHELF WITHOUT WALKING TO IT.
   *
   * Everything here is SELECTION over the store that already exists. The index
   * is built from this.layout, which was merchandised from the projection long
   * before this panel opened, so browsing cannot add, remove or reorder a
   * single title. See src/systems/next-title.js and qa:nexttitle, which assert
   * that boundary by measurement rather than by comment.
   */
  /**
   * The shop floor indexed by shelf, built once per store.
   *
   * THE CACHE IS KEYED ON THE LAYOUT OBJECT ITSELF, not on a flag somebody has
   * to remember to clear. Changing services rebuilds the store and reassigns
   * ui.layout; a stale index would then offer titles the store no longer
   * carries. Comparing identity makes that unreachable instead of merely
   * handled, and it drops the remembered row at the same moment, because a row
   * from the old store is not a row in the new one.
   *
   * Shared by both browse surfaces — the title card's pickers and the arrows
   * on a case in hand — so the two can never disagree about what is next.
   */
  shelfIndex() {
    if (this._shelfIndexFor !== this.layout) {
      this._shelfIndex = buildShelfIndex(this.layout);
      this._shelfIndexFor = this.layout;
      this._browseRow = null;
    }
    return this._shelfIndex;
  }

  /**
   * The next title along this shelf that the shopper could actually pick up.
   *
   * STEPS OVER WHAT IS NOT THERE. A title whose every copy is already in the
   * shopper's own stack has no case left on the shelf, and trying to open it
   * would do nothing at all — an arrow that visibly does nothing is worse than
   * one that skips. The walk is bounded by the row length, so a shelf that has
   * been emptied into the stack ends in an honest "nothing else here" rather
   * than circling.
   */
  nextOnShelf(t, dir) {
    const idx = this.shelfIndex();
    // Bound and row both come from locate(), the module's own accessor. The
    // index's rowOf map is deliberately not touched here: qa:nexttitle forbids
    // the UI reaching into it, because a second way to read the shelf order is
    // the first half of a second way to select from it.
    const here = locate(idx, t.id);
    const limit = here ? here.of : 1;
    let id = t.id;
    for (let i = 0; i < limit; i++) {
      const r = nextTitle(idx, id, dir);
      if (r.exhausted || r.titleId === t.id) return null;
      if (this.actions.hasShelfCopy(r.titleId)) return r.titleId;
      id = r.titleId;
    }
    return null;
  }

  /**
   * The next SHELF in this section that still has a case on it, and the title
   * to lift off it.
   *
   * A DIFFERENT SCOPE FROM nextOnShelf, DELIBERATELY KEPT APART. That one
   * walks titles along one shelf and wraps at its ends; this walks shelves
   * across one section and stops at its edges. Neither may quietly become the
   * other: an arrow that changes the shelf when it runs out of titles gives
   * the shopper no control whose scope they can state, and makes "4 of 6"
   * count something different from one press to the next.
   *
   * SKIPS SHELVES THAT HAVE NOTHING TO PICK UP. A shelf whose every title is
   * already in the shopper's stack is physically empty of cases, and stopping
   * on it would hand back a title that cannot be lifted. It steps over such a
   * shelf rather than stopping — but it will not take a title that the store's
   * own rules say is not there, which is the difference between skipping and
   * cheating. The walk is bounded by the number of shelves in the section, so
   * a section emptied into the stack ends at a disabled button.
   *
   * @returns {{row: object, titleId: string}|null} null at the section edge
   */
  shelfStep(row, dir) {
    return nextBrowsableShelf(this.shelfIndex(), row, dir,
      (id) => this.actions.hasShelfCopy(id));
  }

  renderNextTitle(t) {
    const host = $('tc-next');
    if (!host) return;
    const idx = this.shelfIndex();
    const here = locate(idx, t.id);
    const row = this._browseRow ?? here?.row ?? idx.rows[0];
    if (!row) { host.textContent = ''; return; }

    const sections = idx.sections;
    const rowsHere = idx.rowsIn(row.section);
    const pos = row.titleIds.indexOf(t.id);

    host.innerHTML = `
      <div class="tc-next-head">NEXT TITLE</div>
      <div class="tc-next-pickers">
        <label>SHELF
          <select id="tc-sec">${sections.map((sec) =>
    `<option value="${sec}"${sec === row.section ? ' selected' : ''}>${sec}</option>`).join('')}</select>
        </label>
        <label>ROW
          <select id="tc-row">${rowsHere.map((r) =>
    `<option value="${r.key}"${r.key === row.key ? ' selected' : ''}>${rowLabel(r)} (${r.titleIds.length})</option>`).join('')}</select>
        </label>
      </div>
      <div class="tc-next-now">${pos >= 0 ? `${pos + 1} of ${row.titleIds.length} on this row` : `${row.titleIds.length} on this row`}</div>
      <div class="tc-next-btns">
        <button id="tc-prev">← PREVIOUS</button>
        <button id="tc-nextb">NEXT →</button>
      </div>`;

    // Each onchange re-renders the panel, which DESTROYS the focused <select>
    // and drops focus to <body>. Restoring focus to the rebuilt picker keeps
    // it operable by keyboard: without this, a keyboard user got exactly one
    // arrow press per mouse click.
    $('tc-sec').onchange = (e) => {
      this._browseRow = idx.rowsIn(e.target.value)[0] ?? null;
      this.renderNextTitle(t);
      $('tc-sec')?.focus();
    };
    $('tc-row').onchange = (e) => {
      this._browseRow = idx.rows.find((r) => r.key === e.target.value) ?? null;
      this.renderNextTitle(t);
      $('tc-row')?.focus();
    };

    // RAPID PRESSES ARE SERIALISED. Each step re-renders the whole card, and a
    // second press landing mid-render would show a poster from one title beside
    // metadata from another. The guard is released only once the new card has
    // been drawn, so a burst of taps becomes a sequence of complete states
    // rather than a race between two half-finished ones.
    const step = (dir) => {
      if (this._browsing) return;
      // A RESTOCK WHILE THE CARD IS OPEN INVALIDATES THIS CLOSURE.
      //
      // `idx` and `row` were captured when the panel was drawn. Changing
      // services rebuilds the store and reassigns ui.layout, and nothing
      // re-renders an open title card — so without this the buttons would go
      // on selecting titles out of the store that no longer exists. The
      // identity check was only ever consulted at render time.
      if (this._shelfIndexFor !== this.layout) { this.renderNextTitle(t); return; }
      this._browsing = true;
      try {
        // THE ROW WE STEP ALONG IS THE ROW WE DREW.
        //
        // `row` resolves to the browsed row, else this title's own row, else
        // the first shelf in the shop. Passing `this._browseRow` instead meant
        // that for a title with no shelf of its own — anything the store knows
        // but does not have out — the panel displayed a real shelf and a real
        // count while both buttons reported "that is the whole row".
        const r = nextTitle(idx, t.id, dir, { row });
        if (r.exhausted) {
          this.toast('That is the whole row.', 1600);
          return;
        }
        // DEFENSE-IN-DEPTH, AND HONESTLY LABELLED AS SUCH. While the identity
        // re-check above holds, this cannot fire: the index was built from
        // this.layout, so every id it returns is in layout.titles, and byId
        // holds the whole master catalogue. It stays because it is the one
        // runtime backstop if a future edit ever lets an index outlive its
        // store — a toast and a re-render instead of a ghost title card.
        const nextT = this.byId.get(r.titleId);
        if (!nextT || !this.layout.titles.has(r.titleId)) {
          this.toast('That title is not on the shelf any more.', 1800);
          this.renderNextTitle(t);
          return;
        }
        this._browseRow = r.row;
        this.audio.uiBlip();
        // ONE canonical id drives the whole card: poster, metadata, address and
        // where-to-watch are all re-derived from nextT, never patched in place.
        this.showTitleCard(nextT, 'browse');
      } finally {
        this._browsing = false;
      }
    };
    $('tc-prev').onclick = () => step(-1);
    $('tc-nextb').onclick = () => step(1);
  }

  renderFilterChip() {
    const chip = $('filter-chip');
    // The chip is gone from the gameplay layer (see index.html). claim() is
    // still the single source for that sentence and Settings still renders it,
    // so this stays as a guarded no-op rather than forcing every caller to
    // learn that the element no longer exists.
    if (!chip) return;
    const s = this.storeState();
    const c = this.claim();
    const verb = this.modes?.isTouchUI ? 'tap' : 'click';
    chip.classList.remove('hidden', 'all-mode', 'chip-error');

    if (c) {
      if (c.state === 'broken') chip.classList.add('chip-error');
      const shelf = c.shelf ? `<i class="chip-shelf">${c.shelf}</i>` : '';
      chip.innerHTML = `<b>${c.head}${c.state === 'ok' ? ' ›' : ''}</b>`
        + `<span class="chip-q">${shelf}${c.sub}</span>`;
    } else {
      // THE STORE. It is legitimately bounded — 122,948 titles cannot be a
      // quarter of a million case meshes — so it is named a sample and nobody
      // can read the shelves as the whole catalogue.
      //
      // It still carries BOTH numbers whenever services are selected. The
      // membership figure is the shelf count; the availability figure comes from
      // getAvailability(), scoped to every service you hold, because THE STORE
      // ranks by no provider in particular. With no services selected there is
      // no availability question to answer, so only membership is shown — an
      // absent number, never a zero or a borrowed one.
      chip.classList.add('all-mode');
      const shelved = !s.restocking && s.shelved != null
        ? `<i class="chip-shelf">${UI.n(s.shelved)} on the shelves</i>` : '';
      const known = s.watchable != null
        ? `${UI.n(s.watchable)} known on your services` : `${verb} to browse`;
      chip.innerHTML = `<b>THE STORE · sample of ${UI.n(s.master)}</b>`
        + `<span class="chip-q">${shelved}${known}</span>`;
    }
    // The access word is DERIVED, never the hardcoded "subscription" this used to
    // print: over Tubi that asserted a paid entitlement that does not exist.
    // accessLabelFor([]) returns null and s.availServices CAN be empty here (the
    // gate above is myServices.size, not availServices.length), so the guard is
    // load-bearing — without it the tooltip would end in "· null".
    const access = accessLabelFor(s.availServices);
    chip.title = this.myServices.size
      ? `${s.shelved != null ? `${UI.n(s.shelved)} titles on the shelves. ` : ''}`
        + `Availability scoped to ${s.availServices.join(' · ')} · ${SNAPSHOT.region}`
        + `${access ? ` · ${access.toLowerCase()}` : ''}`
      : 'No services selected. Pick yours in ⚙ Settings.';
    chip.onclick = () => this.showWatchables();
  }

  // The same claim, as a banner line inside the browser panels — rendered from
  // claim(), so the chip and the panel are literally the same sentence.
  storeBanner() {
    const s = this.storeState();
    const c = this.claim();
    if (!c) {
      const shelved = !s.restocking && s.shelved != null
        ? `. The store shelves a sample of ${UI.n(s.shelved)} of them` : '';
      const known = s.watchable != null
        ? `<br><span class="qual">${UI.n(s.watchable)} known on your services</span>` : '';
      return `<div class="store-truth note">THE STORE · browsing a catalogue of ${UI.n(s.master)}${shelved}${known}</div>`;
    }
    if (c.state === 'pending') return `<div class="store-truth note">Restocking the shelves for your services…</div>`;
    if (c.state === 'broken') return `<div class="store-truth bad">${c.head}. ${c.sub}</div>`;
    return `<div class="store-truth ok">${c.head}<br><span class="qual">${c.sub}</span></div>`;
  }

  // The evidence behind the claim, MEASURED from the snapshot rather than
  // asserted. This counts availability ROWS, not titles, so it can never be
  // mistaken for — or drift against — the one watchable count.
  evidenceNote() {
    const k = SNAPSHOT.counts || {};
    if (!k.availabilityRows) return '';
    return `<div class="store-truth ok">Every title here has a place on a shelf. Evidence: `
      + `${UI.n(k.availabilityRowsWithVerificationDate || 0)} of ${UI.n(k.availabilityRows)} availability rows `
      + `carry a verification date. The rest are sourced but undated, and each card says which it is.</div>`;
  }

  // "WHAT CAN I WATCH?" — every watchable title, one canonical row each, listed
  // from the very array the count is read from.
  showWatchables() {
    const s = this.storeState();
    const pool = this.watchables();
    assertCanonical(pool, 'watchables');
    const panel = $('panel-search');
    const row = (t) => {
      const rec = this.layout.titles.get(t.id);
      // The providers that actually qualify, from the authority — not the raw
      // join, which is a description of the data rather than a verdict.
      const mine = isCurrentlyWatchable(t, this.myServices).providers;
      // Per-row honesty: a watchable title with no shelf says so, so the list
      // can never imply a physical copy the store does not have.
      const shelved = this.isStocked(t.id) && rec;
      return `<div class="result">
        <img src="${this.thumb(t)}" alt="">
        <div class="r-info"><b>${t.title}</b> <i class="badge ${t.type}">${t.type === 'series' ? 'SERIES' : 'MOVIE'}</i>
          <span>${metaLine(t)}</span>
          <span class="addr">${shelved ? formatAddress(rec.address) : 'IN BACK-STOCK, we’ll bring it out for you'}</span>
          <span class="svc-line">${mine.length ? `<i class="svc mine">✓ ${includedWord(mine)} · ${mine.join(' · ')}</i>` : ''}</span></div>
        <div class="r-actions">
          <button class="gold go" data-id="${t.id}">${shelved ? 'TAKE ME THERE' : 'STOCK IT & GO'}</button>
          <button class="ghost open" data-id="${t.id}">DETAILS</button>
        </div>
      </div>`;
    };
    // Not personalized: there is no watchable count to show, and inventing one
    // for a store that isn't filtered would be the second number this UI is not
    // allowed to have. Offer the switch instead.
    const notPersonal = !this.myServices.size
      ? `<div class="empty">Pick your streaming services in ⚙ Settings first.<br>Then this becomes your personal store.</div>`
      : `<div class="empty">You are in <b>THE STORE</b>, which ranks nothing ahead of anything else.<br>
           ${s.watchable != null ? `${UI.n(s.watchable)} titles in the catalogue are known on ${s.availServices.join(' · ')}.` : ''}<br><br>
           <button class="gold" id="ps-mine">BRING THOSE TO THE FRONT</button></div>`;

    const series = pool.filter(t => t.type === 'series');
    const movies = pool.filter(t => t.type === 'movie');
    const c = this.claim();
    panel.innerHTML = `<div class="panel-head"><b>WHAT CAN I WATCH?</b><button class="x" id="ps-close">×</button></div>` +
      (!s.personal ? notPersonal
        : s.restocking ? `<div class="empty">Restocking the shelves for your services…</div>`
          : `<div class="filter-note">${c.head}<span class="qual">${c.sub}</span>`
            // The headline counts the CATALOGUE; this list counts the SHELVES.
            // They match for most services, but a service whose titles crowd into
            // a small department (Tubi: 1,542 known, fewer shelved) leaves a
            // real gap. Stating it beats silently listing fewer rows than the
            // number above — and the missing ones are reachable, not lost.
            + (s.watchable != null && pool.length < s.watchable
              ? `<span class="qual">${UI.n(pool.length)} of them are on the shelves right now · search brings any of the rest out back</span>` : '')
            + `</div>` +
            this.evidenceNote() +
            // Subdivisions of the SAME array — they add up to the one count by
            // construction and can never contradict it.
            `<div class="count-note">SERIES · ${UI.n(series.length)}</div>` + series.map(row).join('') +
            `<div class="count-note">MOVIES · ${UI.n(movies.length)}</div>` + movies.map(row).join(''));
    this.showPanel('panel-search');
    $('ps-close').onclick = () => this.hidePanel('panel-search');
    const mineBtn = $('ps-mine');
    if (mineBtn) mineBtn.onclick = () => { this.setSvcFilter('mine'); this.hidePanel('panel-search'); };
    panel.querySelectorAll('.go').forEach(b => b.onclick = () => {
      this.closeAllPanels();
      this.actions.goToTitle(b.dataset.id);
    });
    panel.querySelectorAll('.open').forEach(b => b.onclick = () => this.showTitleCard(this.byId.get(b.dataset.id)));
  }

  // Cover atlases only carry the STOCKED titles, so a watchable title sitting in
  // back-stock has no tile — makeThumb returns null there. Fall back to a neutral
  // card: a broken-image icon would read as a broken app, not as "not on a shelf".
  thumb(t) {
    const hit = this.thumbCache.get(t.id);
    if (hit !== undefined) {
      // Re-insert so a hit moves to the young end of the insertion order.
      this.thumbCache.delete(t.id);
      this.thumbCache.set(t.id, hit);
      return hit;
    }
    const made = makeThumb(this.atlases, t) || NO_THUMB;
    this.thumbCache.set(t.id, made);
    while (this.thumbCache.size > this.thumbCacheMax) {
      const oldest = this.thumbCache.keys().next();
      if (oldest.done) break;
      this.thumbCache.delete(oldest.value);
    }
    return made;
  }

  // ------------------------------------------------------------ binding
  bind() {
    const searchInput = $('search-input');
    let searchDebounce = null;
    searchInput.addEventListener('input', () => {
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => this.runSearch(searchInput.value), 160);
    });
    searchInput.addEventListener('focus', () => {
      if (searchInput.value.trim()) this.runSearch(searchInput.value);
    });
    $('search-clear').addEventListener('click', () => {
      searchInput.value = '';
      this.hidePanel('panel-search');
    });
    $('btn-stack').addEventListener('click', () => this.toggleStackPanel());
    $('btn-clerk').addEventListener('click', () => this.openClerk());
    $('btn-mute').addEventListener('click', () => {
      this.audio.setMuted(!this.audio.muted);
      $('btn-mute').textContent = this.audio.muted ? '🔇' : '🔊';
    });
    $('btn-mute').textContent = this.audio.muted ? '🔇' : '🔊';
    // Touch has no keyboard, so crouch is a TOGGLE here rather than a hold.
    $('btn-crouch')?.addEventListener('click', () => {
      this.player?.toggleCrouch?.();
      $('btn-crouch').classList.toggle('active', !!this.player?.crouching);
      this.audio.uiBlip();
    });
    $('btn-help').addEventListener('click', () => $('help').classList.toggle('hidden'));
    // CLOSING ON THE BACKDROP IS LATCHED TO WHERE THE PRESS STARTED.
    //
    // Two reasons this is not a plain click handler on the target. First, the
    // card is now a readable document, and a browser retargets a click to the
    // common ancestor of press and release — so selecting a line of text and
    // releasing outside the card reported #help as the target and closed the
    // overlay mid-read. Second, the card fills a phone screen, leaving a
    // ~16px backdrop gutter; the press-latch keeps that gutter working
    // without making an accidental drag destructive.
    let helpPressOnBackdrop = false;
    $('help').addEventListener('pointerdown', (e) => { helpPressOnBackdrop = e.target === $('help'); });
    $('help').addEventListener('click', (e) => {
      if (helpPressOnBackdrop && e.target === $('help')) $('help').classList.add('hidden');
      helpPressOnBackdrop = false;
    });
    // HOW TO PLAY owns the tutorial now. It used to live at the bottom of the
    // settings wall, which is the last place someone lost in the store looks.
    $('ht-tutorial')?.addEventListener('click', async () => {
      this.audio.uiBlip();
      $('help').classList.add('hidden');
      this.closeAllPanels();
      const { showTutorial } = await import('./tutorial.js');
      await showTutorial({
        touch: this.modes?.isTouchUI ?? false,
        onBlip: () => this.audio.uiBlip(),
      });
    });
    $('btn-settings').addEventListener('click', () => this.toggleSettings());

    // stop 3D input when interacting with UI
    for (const el of document.querySelectorAll('#hud, .panel, #panel-inspect, #title-card, #receipt')) {
      el.addEventListener('pointerdown', e => e.stopPropagation());
    }

    // NO TRAPPED STATE (phase-4 §17): a panel must always have more than one
    // exit. Escape closes everything; tapping the store behind the settings
    // drawer closes it too. Panels stop pointer propagation above, so any
    // pointerdown that reaches document level is by definition outside them.
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Escape') this.closeAllPanels();
    });
    document.addEventListener('pointerdown', () => {
      const p = $('panel-settings');
      if (p && !p.classList.contains('hidden')) this.hidePanel('panel-settings');
    });
  }

  setQuality(q) {
    this.quality = q;
    localStorage.setItem('tb_quality', q);
    this.actions.applyQuality?.();
  }

  hidePanel(id) {
    // EVERY WAY OUT, NOT JUST THE × BUTTON. Escape, closeAllPanels() and
    // TAKE ME THERE all dismiss the title card without touching the close
    // handler. `_cardTitleId` is what tells a late detail fetch whether its
    // card is still the one on screen, so if it survives a dismissal that
    // fetch re-opens a panel the shopper deliberately shut. Clearing it in
    // the one funnel every path goes through is the only version of this
    // that cannot be forgotten by the next close route somebody adds.
    if (id === 'title-card') this._cardTitleId = null;
    $(id).classList.add('hidden');
  }
  showPanel(id) { $(id).classList.remove('hidden'); }
  closeAllPanels() {
    // 'help' BELONGS IN THIS LIST. Every Escape route in the app funnels here,
    // and the overlay was missing from it — so Escape looked dead while
    // silently closing the Settings panel hidden BEHIND the help card, and on
    // a phone (where the card leaves a ~16px backdrop gutter and btn-help sits
    // under the overlay's own z-index) there was very nearly no way out at
    // all. A panel must always have more than one exit.
    for (const id of ['panel-search', 'panel-stack', 'panel-clerk', 'title-card', 'receipt', 'panel-settings', 'help']) this.hidePanel(id);
  }

  // ------------------------------------------------------------ HUD
  setZone(label, code) {
    if (this._zone === label + code) return;
    this._zone = label + code;
    $('zone-label').textContent = label;
    $('zone-code').textContent = code;
  }

  setLookAt(found) {
    const el = $('lookat');
    if (!found) { el.classList.add('hidden'); return; }
    const { title, dist, sameLevel } = found;
    const verb = this.modes?.isTouchUI ? 'Tap' : 'Click';
    el.querySelector('b').textContent = title.title;
    el.querySelector('span').textContent = metaLine(title);
    el.querySelector('em').textContent =
      !sameLevel ? (title.type === 'series' ? `${verb} it and I’ll take the escalator up` : `${verb} it, it’s on the other floor`)
        : dist <= 2.05 ? `${verb} to inspect`
          : `Walk closer, or ${verb.toLowerCase()} it and I’ll stroll over`;
    el.classList.remove('hidden');
  }

  toast(msg, ms = 2400) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
  }
  toastWalk(titleName, crossLevel = false) {
    this.toast(crossLevel ? `Taking the escalator up to ${titleName}…` : `Heading to ${titleName}…`, crossLevel ? 2600 : 1800);
  }

  // ------------------------------------------------------------ settings
  static SERVICES = ['Netflix', 'Max', 'Prime Video', 'Disney+', 'Hulu', 'Apple TV+', 'Paramount+', 'Peacock', 'Tubi'];

  // Any change to the selection invalidates the shelves BEFORE they are rebuilt,
  // so the count is marked stale first and re-rendered second — the chip must
  // never pair a new selection with the old store's number.
  // MODE, not filter. Accepts 'all' (THE STORE), 'mine' (MY SERVICES), or a
  // provider name. All three merchandise the SAME universe — the mode changes
  // ranking and labels only. The stored key stays `tb_filter` and the two legacy
  // values ('all', 'mine') keep working, so an existing install is unaffected.
  setSvcFilter(v) {
    const known = v === 'all' || v === 'mine' || UI.SERVICES.includes(v);
    if (!known) v = 'all';
    // A provider mode you do not subscribe to has nothing to rank by; fall back
    // rather than showing a focus the projection will not honour.
    if (UI.SERVICES.includes(v) && !this.myServices.has(v)) v = this.myServices.size ? 'mine' : 'all';
    // With one service held, provider mode and MY SERVICES are the same focus, so
    // Settings hides the provider row. Keeping the provider name selected would
    // leave an active mode with no visible button — normalize to the one shown.
    if (UI.SERVICES.includes(v) && this.myServices.size === 1) v = 'mine';
    const changed = this.svcFilter !== v;
    this.svcFilter = v;
    localStorage.setItem('tb_filter', v);
    if (changed) this.markRestockPending();
    this.renderFilterChip();
    if (changed) this.actions.onServicesChanged?.(); // the STORE restocks, not just the UI
  }
  setMyService(name, on) {
    const hadNone = this.myServices.size === 0;
    if (on) this.myServices.add(name); else this.myServices.delete(name);
    localStorage.setItem('tb_services', JSON.stringify([...this.myServices]));
    this.markRestockPending();
    // first service selected → default to the personalized store (obvious toggle stays)
    if (hadNone && this.myServices.size === 1) this.setSvcFilter('mine');
    else if (this.myServices.size === 0) this.setSvcFilter('all');
    // Dropping the very service the current mode ranks by leaves svcFilter
    // pointing at a service you no longer hold. Re-resolve through setSvcFilter
    // so it falls back to MY SERVICES: focusServices() would read it as THE
    // STORE while main.js still built a personalized projection, and the chip
    // would sit in "restocking…" forever because the two never agree again.
    else if (UI.SERVICES.includes(this.svcFilter) && !this.myServices.has(this.svcFilter)) {
      this.setSvcFilter(this.svcFilter);
    } else this.actions.onServicesChanged?.();
    this.renderFilterChip();
  }

  toggleSettings() {
    const p = $('panel-settings');
    if (!p.dataset.init) {
      p.dataset.init = '1';
      // §18 order: services first, then performance and sound — the things a
      // shopper actually changes. The experience-mode override rides at the
      // bottom with the attribution.
      // FIVE GROUPS, NOT THIRTEEN HEADINGS. The old panel was the tutorial,
      // the controls manual, the camera settings and the store architecture
      // documentation in one scroll, and the player had to read paragraphs of
      // internal terminology before any button made sense. The rule now: a
      // setting gets ONE line, in the voice of a shop, and the architecture
      // is never explained — the store just behaves. How-to-play lives behind
      // the ? button, not here. Native <details> keeps the groups keyboard-
      // accessible with no state to manage.
      p.innerHTML = `
        <div class="panel-head"><b>⚙ SETTINGS</b><button class="x" id="st-close">✕ CLOSE</button></div>
        <div class="settings-body">
          <details class="st-group" open>
            <summary>STORE</summary>
            <h4>MY STREAMING SERVICES</h4>
            <p class="st-note">Free ones count. No accounts, stored on this device only.</p>
            <div class="svc-grid" id="st-services"></div>
            <h4>WHAT SHOULD I SEE?</h4>
            <div class="st-modes">
              <button data-filter="all">THE STORE</button>
              <button data-filter="mine">MY SERVICES</button>
            </div>
            <div class="st-modes st-providers" id="st-provider-modes"></div>
            <p class="st-desc" id="st-filter-desc"></p>
            <div class="st-modes"><button id="st-surprise" class="gold-outline">🎬 SHOW ME SOMETHING I CAN WATCH</button></div>
            <div class="st-modes"><button id="st-watchables" class="gold-outline">WHAT'S ON MY SERVICES</button></div>
            <details class="st-advanced">
              <summary>Advanced: shelf stocking</summary>
              <div class="st-modes st-inv">
                <button data-inv="services">MY SERVICES ONLY</button>
                <button data-inv="full">FULL STORE + DISCOVERY</button>
              </div>
              <p class="st-desc" id="st-inv-desc"></p>
            </details>
          </details>
          <details class="st-group">
            <summary>SOUND &amp; MUSIC</summary>
            <div class="st-modes">
              <button id="st-sound"></button>
              <button id="st-radio"></button>
            </div>
            <div class="st-slider">
              <label for="st-radio-vol">RADIO VOLUME</label>
              <input type="range" id="st-radio-vol" min="0" max="100" step="5">
              <span id="st-radio-vol-val"></span>
            </div>
            <h4>NOW PLAYING</h4>
            <div id="st-now" class="st-now">
              <div id="st-now-station">No station</div>
              <div id="st-now-track">…</div>
              <div id="st-now-trouble" class="hidden"></div>
            </div>
            <div class="st-modes">
              <button id="st-now-prev">⏮ PREV</button>
              <button id="st-now-play">▶ PLAY</button>
              <button id="st-now-next">NEXT ⏭</button>
            </div>
            <div class="st-modes">
              <button id="st-now-shuffle">🔀 SHUFFLE</button>
              <button id="st-prev">⏮ PREVIOUS</button>
              <button id="st-skip">⏭ SKIP TRACK</button>
            </div>
            <h4>STATION</h4>
            <p class="st-note">★ BLOCKBUSTER THROWBACK is the house station. If one can't play, the store says so.</p>
            <div class="st-stations" id="st-stations"></div>
            <p class="st-desc" id="st-stations-desc"></p>
            <h4>YOUR PLAYLISTS</h4>
            <p class="st-note">Paste a YouTube playlist link and it joins the dial.</p>
            <div id="st-custom-list"></div>
            <div class="st-slider" id="st-custom-add" style="flex-wrap:wrap;gap:6px">
              <input type="text" id="st-custom-name" placeholder="Name (optional)"
                style="flex:1 1 110px;min-width:100px;padding:8px;border-radius:6px;border:1px solid rgba(255,255,255,.25);background:rgba(0,0,0,.25);color:inherit">
              <input type="text" id="st-custom-url" placeholder="https://youtube.com/playlist?list=…"
                style="flex:2 1 190px;min-width:150px;padding:8px;border-radius:6px;border:1px solid rgba(255,255,255,.25);background:rgba(0,0,0,.25);color:inherit">
              <button id="st-custom-save" class="gold-outline">+ ADD PLAYLIST</button>
            </div>
            <p class="st-desc" id="st-custom-msg"></p>
          </details>
          <details class="st-group">
            <summary>CONTROLS</summary>
            <p class="st-desc">Each switch has two settings. Tap one to flip it; the button says which
              way it is set right now. Looking and walking are separate, so fixing one never flips the other.</p>
            <h4>LOOKING</h4>
            <p class="st-note" id="st-look-note"></p>
            <div class="st-modes">
              <button id="st-inv-x"></button>
              <button id="st-inv-y"></button>
            </div>
            <h4>WALKING</h4>
            <p class="st-note" id="st-walk-note"></p>
            <div class="st-modes">
              <button id="st-inv-f"></button>
              <button id="st-inv-s"></button>
            </div>
            <h4>COMFORT</h4>
            <div class="st-slider">
              <label for="st-bob">CAMERA BOB</label>
              <input type="range" id="st-bob" min="0" max="100" step="5">
              <span id="st-bob-val"></span>
            </div>
            <div class="st-slider">
              <label for="st-fov">SPEED FOV</label>
              <input type="range" id="st-fov" min="0" max="100" step="5">
              <span id="st-fov-val"></span>
            </div>
          </details>
          <details class="st-group">
            <summary>DISPLAY</summary>
            <h4>GRAPHICS</h4>
            <div class="st-modes st-quality">
              <button data-q="auto">AUTO</button>
              <button data-q="smooth">SMOOTH</button>
              <button data-q="sharp">SHARP</button>
            </div>
            <p class="st-desc">Pick SMOOTH if walking feels laggy.</p>
            <h4>STORE SIZE</h4>
            <div class="st-modes st-size" id="st-size">
              <button data-cap="0">FULL (20,000)</button>
              <button data-cap="8000">LIGHTER (8,000)</button>
              <button data-cap="4000">LIGHTEST (4,000)</button>
            </div>
            <p class="st-desc" id="st-size-desc"></p>
            <h4>INPUT STYLE</h4>
            <div class="st-modes">
              <button data-mode="auto">AUTO</button>
              <button data-mode="mobile">TOUCH</button>
              <button data-mode="desktop">MOUSE &amp; KEYS</button>
            </div>
            <p class="st-desc" id="st-desc"></p>
          </details>
          <details class="st-group">
            <summary>ABOUT</summary>
            <p class="st-note" id="st-attrib">Cover artwork and some synopses from TMDB.
              This product uses the TMDB API but is not endorsed or certified by TMDB.
              Streaming availability data by JustWatch (via TMDB), checked per title
              on the date shown. Synopses otherwise come from English Wikipedia
              (CC BY-SA). Titles with no artwork or no synopsis on file carry a
              printed sleeve or no blurb rather than invented art.</p>
          </details>
        </div>`;
      $('st-close').onclick = () => this.hidePanel('panel-settings');
      $('st-watchables').onclick = () => { this.audio.uiBlip(); this.showWatchables(); };
      p.querySelectorAll('.st-modes button[data-mode]').forEach(b =>
        b.onclick = () => { this.modes.set(b.dataset.mode); this.renderSettings(); this.audio.uiBlip(); });
      p.querySelectorAll('.st-modes button[data-filter]').forEach(b =>
        b.onclick = () => { this.setSvcFilter(b.dataset.filter); this.renderSettings(); this.audio.uiBlip(); });
      p.querySelectorAll('.st-inv button[data-inv]').forEach(b =>
        b.onclick = () => {
          const r = this.actions.setInventoryMode?.(b.dataset.inv);
          this.renderSettings(); this.audio.uiBlip();
          this.toast(b.dataset.inv === 'services'
            ? `Only your services on the shelves. ${UI.n(r?.empty ?? 0)} positions are now honestly empty.`
            : 'Full store: discovery titles join your services on the shelves.', 2600);
        });
      const grid = $('st-services');
      for (const name of UI.SERVICES) {
        const btn = document.createElement('button');
        btn.className = 'svc-toggle';
        btn.dataset.svc = name;
        btn.onclick = () => {
          this.setMyService(name, !this.myServices.has(name));
          this.renderSettings();
          this.audio.uiBlip();
        };
        grid.appendChild(btn);
      }
      $('st-sound').onclick = () => {
        this.audio.setMuted(!this.audio.muted);
        $('btn-mute').textContent = this.audio.muted ? '🔇' : '🔊';
        this.renderSettings();
      };
      $('st-radio').onclick = () => { this.audio.setRadio(!this.audio.radioOn); this.renderSettings(); };
      // Source buttons bind unconditionally — they used to bind only when a
      // playlist was ALREADY configured, and the input below is how one gets
      // configured in the first place. Visibility is renderSettings' job.

      // THE DIAL. Built from the curated registry, so adding a station is a
      // re-run of scripts/radio-curate.mjs and not a UI edit.
      // THE DIAL. Built from the curated registry — there is no longer a
      // "store station" entry, because the generated synth radio has been
      // removed from the runtime entirely.
      const dial = $('st-stations');
      if (dial) {
        dial.innerHTML = YT_STATIONS
          .map(s => `<button data-station="${s.id}">${s.label}</button>`).join('');
        dial.querySelectorAll('[data-station]').forEach(b => {
          // The click IS the gesture that permits playback. Everything this
          // handler needs must happen inside it, not after an await.
          // The tap is the only thing that can start playback, so it calls
          // straight into the already-built player: no await, no import, no
          // fetch on this path. See YouTubeRadio.playStation().
          b.onclick = () => {
            this.audio.uiBlip();
            this.audio.playStation(b.dataset.station);
            this.renderSettings();
            this.renderRadioDock();
            this.toast(`Tuning to ${b.textContent}…`, 2000);
          };
        });
      }
      // Transport lives in Settings now. Every one of these is a real tap,
      // which is also the only context a mobile browser grants playback in.
      $('st-now-prev').onclick = () => { this.audio.uiBlip(); this.audio.previousRadio(); this.renderRadioDock(); };
      $('st-now-next').onclick = () => { this.audio.uiBlip(); this.audio.skipRadio(); this.renderRadioDock(); };
      // PLAY IS THE GESTURE. Everything this calls is synchronous, so the
      // play request happens inside the handler and the user activation still
      // counts. Adding an await here silently breaks the radio on a phone.
      $('st-now-play').onclick = () => {
        this.audio.uiBlip();
        const st = this.audio.radioState?.() ?? {};
        if (st.playing) this.audio.stopRadio();
        else if (!this.audio.startRadio()) this.audio.playStation(this.audio.ytStation());
        this.renderRadioDock();
      };
      $('st-now-shuffle').onclick = () => {
        this.audio.uiBlip();
        if (this.audio.reshuffle?.()) this.toast('Reshuffled. Next track comes from the whole station.', 2200);
        else this.toast('Start a station first.', 1800);
        this.renderRadioDock();
      };
      const pl0 = this.player;
      if (pl0) {
        $('st-inv-x').onclick = () => {
          pl0.setInvert({ x: pl0.invertX > 0 });
          this.audio.uiBlip(); this.renderSettings();
        };
        $('st-inv-y').onclick = () => {
          pl0.setInvert({ y: pl0.invertY > 0 });
          this.audio.uiBlip(); this.renderSettings();
        };
        $('st-inv-f').onclick = () => {
          pl0.setInvert({ moveF: pl0.invertMoveF > 0 });
          this.audio.uiBlip(); this.renderSettings();
        };
        $('st-inv-s').onclick = () => {
          pl0.setInvert({ moveS: pl0.invertMoveS > 0 });
          this.audio.uiBlip(); this.renderSettings();
        };
      }
      this.renderCustomPlaylists();
      $('st-custom-save').onclick = () => this.addCustomPlaylist();
      const pl = this.player;
      if (pl) {
        $('st-bob').value = Math.round((pl.comfortBob ?? 1) * 100);
        $('st-bob-val').textContent = `${Math.round((pl.comfortBob ?? 1) * 100)}%`;
        $('st-fov').value = Math.round((pl.comfortFov ?? 1) * 100);
        $('st-fov-val').textContent = `${Math.round((pl.comfortFov ?? 1) * 100)}%`;
        $('st-bob').oninput = (e) => {
          pl.setComfort({ bob: e.target.value / 100 });
          $('st-bob-val').textContent = `${e.target.value}%`;
        };
        $('st-fov').oninput = (e) => {
          pl.setComfort({ fov: e.target.value / 100 });
          $('st-fov-val').textContent = `${e.target.value}%`;
        };
      }
      $('st-prev').onclick = () => {
        if (this.audio.previousRadio()) this.toast('Bringing the last track back…', 2200);
        else this.toast('Nothing to go back to yet.', 1600);
        this.audio.uiBlip();
      };
      $('st-skip').onclick = () => {
        if (this.audio.skipRadio()) this.toast('Next track…', 1600);
        else this.toast('The radio is off.', 1600);
        this.audio.uiBlip();
      };
      p.querySelectorAll('.st-quality button[data-q]').forEach(b =>
        b.onclick = () => { this.setQuality(b.dataset.q); this.renderSettings(); this.audio.uiBlip(); });
      // STORE SIZE. Rebuilding the building is a reload, not a restock: the
      // fixture plan itself is derived from the stocked count. Say so, and
      // only reload on an explicit click.
      p.querySelectorAll('.st-size button[data-cap]').forEach(b =>
        b.onclick = () => {
          const cap = Number(b.dataset.cap);
          if (cap) localStorage.setItem('tb_capacity', String(cap));
          else localStorage.removeItem('tb_capacity');
          this.audio.uiBlip();
          this.toast('Rebuilding the store at the new size…', 2000);
          setTimeout(() => location.reload(), 400);
        });
      $('st-radio-vol').oninput = (e) => {
        this.audio.setRadioVolume(e.target.value / 100);
        $('st-radio-vol-val').textContent = e.target.value + '%';
      };
      $('st-surprise').onclick = () => {
        const pool = this.surprisePool();
        if (!pool.length) { this.toast('Pick your services first, then I can match you.'); return; }
        const t = pool[(Math.random() * pool.length) | 0];
        this.closeAllPanels();
        this.showTitleCard(t, 'surprise');
      };
    }
    this.renderSettings();
    p.classList.toggle('hidden');
  }
  renderSettings() {
    const p = $('panel-settings');
    p.querySelectorAll('.st-modes button[data-mode]').forEach(b =>
      b.classList.toggle('active', this.modes.mode === b.dataset.mode));
    const eff = this.modes.effective;
    $('st-desc').innerHTML = this.modes.mode === 'auto'
      ? `Detected: <b>${eff.toUpperCase()}</b>. ${eff === 'mobile' ? 'Tap to stroll · drag to look · pinch to zoom.' : 'Click to stroll · drag to look · scroll to zoom · WASD to walk.'}`
      : eff === 'mobile' ? 'Touch-first: tap to stroll · one-finger drag to look · pinch to zoom.'
        : 'Mouse/keyboard: click to stroll · drag to look · scroll to zoom · WASD to walk.';
    p.querySelectorAll('.svc-toggle').forEach(b => {
      const on = this.myServices.has(b.dataset.svc);
      b.textContent = (on ? '☑ ' : '☐ ') + b.dataset.svc;
      b.classList.toggle('active', on);
    });
    p.querySelectorAll('.st-modes button[data-filter]').forEach(b =>
      b.classList.toggle('active', this.svcFilter === b.dataset.filter));
    // Settings renders the SAME claim sentence as the chip, from claim(). The
    // only extra number here is physical COPIES, which is a different quantity
    // (cases on shelves, not titles) and is labelled as one.
    const s = this.storeState();
    const c = this.claim();
    const N = UI.n;
    // Copies, not titles — a third quantity, and labelled as one. The phrase
    // deliberately omits "on the shelves": every sentence below already places
    // the titles there, and repeating it read as two separate shelf counts.
    const copies = `${N(this.layout.slots.length)} physical copies`;
    // Provider mode buttons, rendered from the services you actually hold —
    // ranking by a service you do not subscribe to would be a focus the
    // projection cannot honour.
    const pm = $('st-provider-modes');
    if (pm) {
      const held = UI.SERVICES.filter(n => this.myServices.has(n));
      pm.innerHTML = held.map(n => `<button data-filter="${n}">${n.toUpperCase()}</button>`).join('');
      pm.classList.toggle('hidden', held.length < 2);   // pointless with one service
      // Same handler shape as the static mode buttons above — these are injected
      // after that one-time binding pass, so they must bind here or do nothing.
      pm.querySelectorAll('button[data-filter]').forEach((b) => {
        b.classList.toggle('active', this.svcFilter === b.dataset.filter);
        b.onclick = () => { this.setSvcFilter(b.dataset.filter); this.renderSettings(); this.audio.uiBlip(); };
      });
    }

    // The store is the SAME SIZE in every mode. Each description therefore states
    // the shelf count as well as the entitlement, so no mode can read as "this is
    // all there is".
    // CLERK VOICE, ONE LINE. The old THE STORE sentence explained ranking
    // policy and quoted the master index — architecture the player never
    // asked about. The honest numbers stay; the lecture goes.
    const shelf = !s.restocking && s.shelved != null ? `${N(s.shelved)} titles on the shelves` : 'restocking';
    $('st-filter-desc').textContent = this.svcFilter === 'all'
      ? `Browse the whole store: ${shelf} · ${copies}.`
      : !this.myServices.size
        ? 'Pick at least one service above and we’ll bring what you can watch to the front.'
        : c.state === 'pending' ? 'Restocking the shelves…'
          : c.state === 'broken' ? `${c.head}. ${c.sub}`
            : `${c.head}. ${c.sub}.`;
    // INVENTORY MODE — the distinction must be unmistakable (§3): one line
    // states what the shelves physically hold RIGHT NOW under each choice.
    const inv = this.actions.inventoryMode?.() ?? 'services';
    p.querySelectorAll('.st-inv button[data-inv]').forEach(b =>
      b.classList.toggle('active', inv === b.dataset.inv));
    const invDesc = $('st-inv-desc');
    if (invDesc) {
      const personalized = this.svcFilter !== 'all' && this.myServices.size > 0;
      // Same one-liners as onboarding — the two surfaces must never describe
      // the modes in different words (onboarding-repair directive).
      invDesc.textContent = !personalized
        ? 'Applies when the store is personalized. Pick services and MY SERVICES above.'
        : inv === 'services'
          ? `MY SERVICES ONLY: only stock titles available through your selected services${s.watchable != null ? ` (${N(s.watchable)} right now)` : ''}. Everything else stays out, except your protected STACK.`
          : `FULL STORE + DISCOVERY: fill the store with up to ${N(20000)} titles, prioritizing your services while leaving room for discovery. You'll see more than your services carry, honestly labelled.`;
    }
    {
      const cap = Number(localStorage.getItem('tb_capacity')) || 0;
      p.querySelectorAll('.st-size button[data-cap]').forEach(b =>
        b.classList.toggle('active', Number(b.dataset.cap) === cap));
      const sd = $('st-size-desc');
      if (sd) {
        sd.textContent = cap
          ? `This device is building a ${cap.toLocaleString('en-US')}-title store. Fewer titles, less memory. Pick FULL STORE to go back to 20,000.`
          : 'The full 20,000-title store. If a phone runs out of memory building it, choose a lighter size. Nothing else about the store changes.';
      }
    }
    $('st-sound').textContent = this.audio.muted ? 'ALL SOUND: OFF' : 'ALL SOUND: ON';
    $('st-sound').classList.add('active');
    const plc = this.player;
    if (plc) {
      // A SWITCH MUST SAY WHICH WAY IT IS SET.
      //
      // These four read "LOOK LEFT / RIGHT" and lit up when inverted, and that
      // was the whole of it: nothing named the two settings, nothing said which
      // one you were on, and nothing said what either one DID. A lit button is
      // not a label — you cannot tell "on" from "inverted" by looking at it.
      // So each button now carries its own state as words, and each pair is
      // introduced by a line describing, in the gesture actually being used,
      // what the current setting does. Read the note, decide if that is
      // backwards, tap the switch.
      const drag = this.modes?.isTouchUI ? 'Drag' : 'Move the mouse';
      const set = (id, name, on) => {
        const b = $(id);
        if (!b) return;
        b.classList.toggle('active', on);
        b.textContent = `${name}: ${on ? 'INVERTED' : 'NORMAL'}`;
      };
      set('st-inv-x', 'LOOK LEFT / RIGHT', plc.invertX < 0);
      set('st-inv-y', 'LOOK UP / DOWN', plc.invertY < 0);
      set('st-inv-f', 'WALK FORWARD / BACK', plc.invertMoveF < 0);
      set('st-inv-s', 'STEP LEFT / RIGHT', plc.invertMoveS < 0);
      const look = $('st-look-note');
      if (look) {
        look.textContent =
          `Right now: ${drag} right and you look ${plc.invertX < 0 ? 'LEFT' : 'RIGHT'}. `
          + `${drag} up and you look ${plc.invertY < 0 ? 'DOWN' : 'UP'}. `
          + 'The arrow keys follow these too.';
      }
      const walk = $('st-walk-note');
      if (walk) {
        walk.textContent = this.modes?.isTouchUI
          ? `Right now: push the walk stick up and you go ${plc.invertMoveF < 0 ? 'BACKWARDS' : 'FORWARDS'}. `
            + `Push it right and you step ${plc.invertMoveS < 0 ? 'LEFT' : 'RIGHT'}.`
          : `Right now: W walks ${plc.invertMoveF < 0 ? 'BACKWARDS' : 'FORWARDS'} `
            + `and D steps ${plc.invertMoveS < 0 ? 'LEFT' : 'RIGHT'}.`;
      }
    }
    const nowStation = this.audio.ytStation?.() ?? null;
    $('st-stations')?.querySelectorAll('[data-station]').forEach(b =>
      b.classList.toggle('active', b.dataset.station === nowStation));
    const picked = YT_STATIONS.find(s => s.id === nowStation);
    const desc = $('st-stations-desc');
    if (desc) {
      desc.textContent = picked
        ? `${picked.label} covers ${picked.covers.join(', ')}. Shuffled by the store, not played in playlist order.`
        : 'The store station is composed here from 10 musical families, with no network, no video and nothing to load.';
    }
    $('st-radio').textContent = this.audio.radioOn ? 'RADIO MUSIC: ON' : 'RADIO MUSIC: OFF';

    document.querySelectorAll('.st-quality button[data-q]').forEach(b =>
      b.classList.toggle('active', b.dataset.q === this.quality));

    $('st-radio').classList.toggle('active', this.audio.radioOn);
    $('st-radio-vol').value = Math.round(this.audio.radioVol * 100);
    $('st-radio-vol-val').textContent = Math.round(this.audio.radioVol * 100) + '%';
  }

  // ------------------------------------------------------------ search
  searchOpts() {
    // WHAT IS ON A SHELF RIGHT NOW, handed to search and to the clerk so they
    // can tell the shop from the catalogue. It is a label and a ranking
    // signal there, never a filter: the searchable pool is still the whole
    // eligible catalogue, which is the only reason a shopper can ask about a
    // film the store does not happen to carry this week.
    return {
      myServices: this.myServices,
      myServicesOnly: this.svcFilter === 'mine',
      stockedIds: this.stockedIds(),
      // THE SHELVED TITLES THEMSELVES, not just their ids. Wayfinding has to
      // be able to FIND a title that is physically in the building, and the
      // personalised pools (projection.eligible) are availability-filtered:
      // in a single-service mode 14,205 of the 20,000 titles on the shelves
      // fall outside it, and the clerk denied carrying every one of them.
      //
      // OMITTED IN 'all' MODE, deliberately: there eligible IS the whole
      // catalogue, so every shelved title is already in the search pool and a
      // second 20,000-title scan per question buys nothing — measured, a flat
      // 12.8 ms on the main thread of a renderer, for zero changed answers.
      storeTitles: this.svcFilter === 'all'
        ? null
        : (this.actions.getProjection?.()?.stocked ?? null),
    };
  }

  runSearch(q) {
    if (!q.trim()) { this.hidePanel('panel-search'); return; }
    const { results, counts } = searchCatalog(this.searchPool(), q, 14, this.searchOpts());
    assertCanonical(results.map(r => r.title), `search "${q}"`);
    this.lastSearchStats = { results: results.length, unique: new Set(results.map(r => r.title.id)).size };
    const panel = $('panel-search');
    const pos = this.actions.getPlayerPos();
    const s = this.storeState();
    const filterNote = s.personal
      ? `<div class="filter-note">SHOWING ONLY WHAT YOUR SERVICES CARRY · <button class="linkish" id="ps-all">show all</button></div>`
        + (s.broken ? this.storeBanner() : '')
      : '';
    // The footer names WHAT was searched. When personalized it quotes the ONE
    // count — the same `stats.stocked` the chip quotes — and when the store is
    // mid-restock or broken it names the scope in words rather than inventing a
    // number for a shelf set it cannot vouch for.
    const searchScope = s.personal
      ? (s.watchable != null && !s.broken
        ? `searched ${UI.n(s.watchable)} titles you can watch`
        : 'searched the titles you can watch')
      : `searched ${UI.n(s.master)} catalogue titles · ${UI.n(this.layout.slots.length)} physical copies on shelves`;
    panel.innerHTML = `<div class="panel-head"><b>SEARCH</b><button class="x" id="ps-close">×</button></div>` + filterNote +
      (results.length === 0
        ? `<div class="empty">Nothing ${this.svcFilter === 'mine' ? 'on your services' : 'on the shelves'} for “${q}”.<br>${this.svcFilter === 'mine' ? 'Try THE STORE in Settings, or' : 'Try a genre, an actor, or'} ask the clerk.</div>`
        : results.map(({ title: t }) => {
          const rec = this.layout.titles.get(t.id);
          const info = this.actions.copiesInfo(t.id);
          const stocked = this.isStocked(t.id);
          return `
          <div class="result" data-id="${t.id}">
            <img src="${this.thumb(t)}" alt="">
            <div class="r-info">
              <b>${t.title}</b> <i class="badge ${t.type}">${t.type === 'series' ? 'SERIES' : 'MOVIE'}</i>
              <span>${metaLine(t)}</span>
              <span class="addr">${stocked && rec ? formatAddress(rec.address) : 'IN BACK-STOCK, we’ll bring it out for you'}</span>
              ${stocked ? `<span class="addr">${info.copies} ${info.copies === 1 ? 'copy' : 'copies'} in store · nearest ~${info.nearestFt} ft</span>` : ''}
              ${servicesBlock(t, true, this.myServices)}
            </div>
            <div class="r-actions">
              <button class="gold go" data-id="${t.id}">${stocked ? 'TAKE ME THERE' : 'STOCK IT & GO'}</button>
              <button class="ghost open" data-id="${t.id}">DETAILS</button>
            </div>
          </div>`;
        }).join('') +
        // The footer names WHAT was searched, so a result count is never read as
        // a claim about the whole catalogue or the whole store.
        // The shop and the catalogue are different sets, so the footer says how
        // many of the matches are actually out on a shelf. Without this the
        // per-result IN BACK-STOCK labels were the only hint, and a page of
        // them read as though the store were empty.
        `<div class="count-note">${UI.n(results.length)} of ${UI.n(counts.matched)} match${counts.matched === 1 ? '' : 'es'}`
        + ` · ${UI.n(counts.inStore)} on a shelf right now · ${searchScope}</div>`);
    this.showPanel(panel.id);
    const allBtn = $('ps-all');
    if (allBtn) allBtn.onclick = () => { this.setSvcFilter('all'); this.runSearch(q); };
    $('ps-close').onclick = () => this.hidePanel('panel-search');
    panel.querySelectorAll('.go').forEach(b => b.onclick = () => {
      this.closeAllPanels();
      this.actions.goToTitle(b.dataset.id);
    });
    panel.querySelectorAll('.open').forEach(b => b.onclick = () => {
      this.showTitleCard(this.byId.get(b.dataset.id), 'search');
    });
  }

  // ------------------------------------------------------------ title card
  showTitleCard(t, source = '') {
    // "Already open on this exact title" is read BEFORE _cardTitleId is
    // reassigned. It distinguishes the two ways this method is re-entered:
    // an async repaint of a card still on screen (keep the shopper's picker),
    // and a genuine re-open of a card they closed (reset it). A separate
    // `_cardDrawnFor` flag once tracked this, but nothing ever cleared it, so
    // closing the card and re-opening the SAME title kept a stale picker —
    // parked on an unrelated shelf while the shopper stood in front of the
    // film itself. `_cardTitleId` is cleared by hidePanel on every dismissal
    // route, which makes it the one honest answer to "is this card open?".
    const reopenSameCard = this._cardTitleId === t.id;
    // Detail may still be in an unfetched shard (phones never bulk-preload).
    // Draw immediately with what we have, then redraw once the blurb lands.
    // hydrateDetail FIRST: the record may already be one Map lookup from its
    // blurb, and rendering before folding is what printed a false absence.
    if (!hydrateDetail(t)) {
      ensureDetail([t.id]).then(() => {
        // A resolve WITHOUT the detail (the shard fetch failed) must not
        // re-enter: hasDetail would still be false, the re-entry would fetch
        // again, and the recursion becomes a microtask loop that freezes the
        // tab. No detail, no redraw — the card stays as first drawn.
        if (!hasDetail(t.id)) return;
        applyDetail([t]);
        if (this._cardTitleId === t.id) this.showTitleCard(t, source);
      });
    }
    this._cardTitleId = t.id;
    // Cleared on close, below. Without that, `_cardTitleId` still matched when
    // a blurb landed after the shopper had shut the card, and showTitleCard
    // re-opened a panel they had deliberately dismissed.
    const rec = this.layout.titles.get(t.id);
    const card = $('title-card');
    const inStack = this.stack.some(s => s.titleId === t.id);
    // HIERARCHY: what is it → why care → where to watch → what can I do.
    // The synopsis comes first because it is the one thing that makes a title
    // mean anything; the credits, the shelf address and the copy count are
    // real information but SECONDARY, so they fold into DETAILS instead of
    // pushing the blurb below the fold.
    card.innerHTML = `
      <button class="x" id="tc-close">×</button>
      <div class="tc-body">
        <img src="${this.thumb(t)}" alt="">
        <div>
          <h3>${t.title} <i class="badge ${t.type}">${t.type === 'series' ? 'SERIES' : 'MOVIE'}</i></h3>
          <p class="meta">${metaLine(t)}</p>
          ${synopsisBlock(t)}
          ${servicesBlock(t, false, this.myServices)}
          <details class="sub-details">
            <summary>DETAILS</summary>
            ${creditLine(t, false)}
            ${t.type === 'series' && fmtMins(totalRuntime(t)) ? `<p class="meta">Full series ≈ ${fmtMins(totalRuntime(t))}</p>` : ''}
            <p class="addr">${rec ? formatAddress(rec.address) : ''}</p>
            <p class="addr">${this.actions.copiesInfo(t.id).copies} physical ${this.actions.copiesInfo(t.id).copies === 1 ? 'copy' : 'copies'} of this one title in store</p>
          </details>
        </div>
      </div>
      <div class="tc-actions">
        <button class="gold" id="tc-go">TAKE ME THERE</button>
        <button class="ghost" id="tc-add" ${inStack ? 'disabled' : ''}>${inStack ? 'IN YOUR STACK ✓' : 'ADD TO STACK'}</button>
      </div>
      <div class="tc-next" id="tc-next"></div>`;
    this.showPanel('title-card');
    // FRESH OPEN vs BROWSING. Arriving from a shelf, search or the map means
    // the picker should show where THIS title lives. Only a press of the
    // browse buttons — or an async repaint of a card STILL OPEN on this title
    // (`reopenSameCard`, captured above) — keeps the row the shopper chose.
    if (source !== 'browse' && !reopenSameCard) this._browseRow = null;
    this.renderNextTitle(t);
    $('tc-close').onclick = () => this.hidePanel('title-card');
    $('tc-go').onclick = () => { this.hidePanel('title-card'); this.closeAllPanels(); this.actions.goToTitle(t.id); };
    $('tc-add').onclick = () => {
      // Re-resolved at CLICK time. A restock while the card is open re-shelves
      // every title, and the draw-time `rec` above would hand addToStack a
      // slot id that now belongs to a DIFFERENT film — hiding that film's
      // case instead of this one's. addToStack accepts null and re-resolves
      // dormant entries on the next restock, so a vanished shelf spot is safe.
      const live = this.layout.titles.get(t.id);
      this.addToStack(t.id, live ? live.primarySlotId : null);
      this.hidePanel('title-card');
    };
  }

  // ------------------------------------------------------------ inspect panel
  showInspect(t, slot) {
    // The inspector had the same two failures as the title card: the synopsis
    // buried under the credits, and — worse — no detail fetch at all, so on a
    // phone (where detail loads on demand) the panel NEVER showed a blurb for
    // a title whose shard had not already been pulled. Same fix, same guard
    // shape: draw now, redraw once when the shard lands, and only while this
    // exact title is still the one held.
    if (!hydrateDetail(t)) {
      ensureDetail([t.id]).then(() => {
        // hydrateDetail returns false when the shard fetch failed; keeping the
        // honest "finding the blurb" state beats re-entering forever.
        if (!hydrateDetail(t)) return;
        if (this._inspectTitleId === t.id) this.showInspect(t, slot);
      });
    }
    this._inspectTitleId = t.id;
    // The swap finished: whichever arrow armed the guard has landed.
    this._browsing = false;
    // WHERE THIS CASE SITS, so the arrows can say what they will do.
    //
    // The NEXT TITLE pickers went onto the title card — the card you reach
    // from search, the clerk or the map — and NOT here, which is the one
    // surface a shopper actually reaches by walking up to a stand and picking
    // a case up. So the feature existed and could not be found: "I still
    // don't see the option to click next or back to see through the whole
    // shelf." The pickers stay on the card, where choosing a distant shelf
    // makes sense; standing at a shelf with a case in your hands, the honest
    // control is two arrows and a note of where you are along the row.
    const bIdx = this.shelfIndex();
    const bHere = locate(bIdx, t.id);
    // TWO SCOPES, RESOLVED ONCE AND SHOWN AS TWO CONTROLS.
    //
    // The big arrows browse TITLES ON THIS SHELF. The shelf buttons browse
    // SHELVES IN THIS SECTION. Resolving both targets here rather than on the
    // click does double duty: the button can be disabled when there is nowhere
    // to go, and the press is then instant because the answer is already in
    // hand. A disabled button is how the section boundary is stated — running
    // off the end of ACTION must never drop the shopper into DRAMA.
    const bShelf = bHere ? shelfPosition(bIdx, bHere.row) : null;
    const prevShelf = bHere ? this.shelfStep(bHere.row, -1) : null;
    const nextShelf = bHere ? this.shelfStep(bHere.row, 1) : null;
    const el = $('panel-inspect');
    el.innerHTML = `
      ${bHere ? `<div class="ins-browse">
        <button class="brw brw-prev" id="ins-prev" aria-label="Previous title on this shelf">&#9664;</button>
        <span class="brw-now"><b>${bHere.position + 1} of ${bHere.of}</b>${rowLabel(bHere.row)}</span>
        <button class="brw brw-next" id="ins-next" aria-label="Next title on this shelf">&#9654;</button>
      </div>
      <div class="ins-shelf">
        <button class="shf" id="ins-shelf-prev" ${prevShelf ? '' : 'disabled'}
          aria-label="Previous shelf in this section">&#8249; PREV SHELF</button>
        <button class="shf" id="ins-shelf-next" ${nextShelf ? '' : 'disabled'}
          aria-label="Next shelf in this section">NEXT SHELF &#8250;</button>
      </div>
      <p class="ins-scope">Shelf ${bShelf.position + 1} of ${bShelf.of} in ${bShelf.section}${
  // WHICH edge, not merely that there is one. Saying "end of the section" while
  // standing at its first shelf is worse than saying nothing: it describes the
  // greyed-out button as the opposite of what it is.
  prevShelf && nextShelf ? ''
    : !prevShelf && !nextShelf ? ' &middot; the only shelf here'
      : prevShelf ? ' &middot; last shelf in the section'
        : ' &middot; first shelf in the section'}</p>` : ''}
      <div class="ins-meta">
        <h3>${t.title} <i class="badge ${t.type}">${t.type === 'series' ? 'SERIES' : 'MOVIE'}</i></h3>
        <p class="meta">${metaLine(t)}</p>
        ${synopsisBlock(t)}
        ${servicesBlock(t, false, this.myServices)}
        <details class="sub-details">
          <summary>MORE DETAILS</summary>
          ${creditLine(t, false) || '<p class="who">No credits on file.</p>'}
        </details>
        <p class="hint">Drag to rotate · ${this.modes?.isTouchUI ? 'pinch' : 'scroll'} to zoom · tap the case to flip it</p>
      </div>
      <div class="ins-actions">
        <button class="gold" id="ins-add">ADD TO STACK</button>
        <button class="ghost" id="ins-back">PUT IT BACK</button>
      </div>`;
    this.showPanel('panel-inspect');
    $('vignette').classList.remove('hidden');
    $('ins-add').onclick = () => this.actions.stashCurrent();
    $('ins-back').onclick = () => this.actions.putBack();
    if (bHere) {
      // SERIALISED, like the title card's buttons. A swap is a put-back
      // animation followed by a pick-up, and a second press landing inside it
      // would ask the inspector to open a case while one is still in the air.
      // The guard clears when the new case is in hand (the top of this
      // method); the timer is only a backstop for a press whose walk never
      // arrives, so the arrows can never wedge.
      const step = (dir) => {
        if (this._browsing) return;
        const id = this.nextOnShelf(t, dir);
        if (!id) {
          this.toast(`Nothing else on ${rowLabel(bHere.row).toLowerCase()}.`);
          return;
        }
        this._browsing = true;
        this.audio.uiBlip();
        this.actions.browseTo(id);
        setTimeout(() => { this._browsing = false; }, 900);
      };
      $('ins-prev').onclick = () => step(-1);
      $('ins-next').onclick = () => step(1);

      // SHELF NAVIGATION RIDES THE SAME PRIMITIVE. browseTo() is the one path
      // that puts the held case back, waits for that to finish, and then picks
      // the target up under the ordinary reach/stroll rules. Changing shelf is
      // not a different kind of act — it is the same act, aimed further away —
      // so it must not grow a second held-case state machine or a shortcut
      // past the walk.
      const toShelf = (target) => {
        if (this._browsing || !target) return;
        this._browsing = true;
        this.audio.uiBlip();
        this.actions.browseTo(target.titleId);
        setTimeout(() => { this._browsing = false; }, 900);
      };
      $('ins-shelf-prev').onclick = () => toShelf(prevShelf);
      $('ins-shelf-next').onclick = () => toShelf(nextShelf);
    }
  }
  hideInspect() {
    // Cleared so a late detail shard cannot re-open a put-back case — the
    // same late-fetch trap the title card had.
    this._inspectTitleId = null;
    this.hidePanel('panel-inspect');
    $('vignette').classList.add('hidden');
  }
  requestPutBack() { this.actions.putBack(); }

  // ------------------------------------------------------------ stack
  loadStack() {
    // THE STACK IS THE ONE THING THE USER BUILT. A malformed read used to
    // silently replace it with an empty array and say nothing — the shopper
    // just found their stack gone with no way to know why. It still has to
    // degrade to empty (there is nothing else it could be), but it says so,
    // keeps the unparseable value under a separate key so it is recoverable,
    // and records the reason where the crash forensics already look.
    try {
      this.stack = JSON.parse(localStorage.getItem('tb_stack') || '[]');
      if (!Array.isArray(this.stack)) throw new Error('tb_stack was not an array');
    } catch (e) {
      const raw = (() => { try { return localStorage.getItem('tb_stack'); } catch { return null; } })();
      this.stack = [];
      try { if (raw) localStorage.setItem('tb_stack_corrupt', raw.slice(0, 4000)); } catch { /* full */ }
      noteRecoverable('stack', e);
      // DEFERRED AND GUARDED. loadStack() runs from the constructor, and
      // toast() reaches straight into the DOM — throwing here, inside the
      // handler for a corrupt read, would turn a recoverable problem into a
      // dead boot. The message is worth showing; it is not worth risking.
      setTimeout(() => {
        try { this.toast('Your stack could not be read and has been reset.', 4000); }
        catch { /* the message is best-effort; the recovery already happened */ }
      }, 1500);
    }
  }
  saveStack() { localStorage.setItem('tb_stack', JSON.stringify(this.stack)); }

  addToStack(titleId, slotId) {
    if (this.stack.some(s => s.titleId === titleId)) { this.toast('Already in your stack.'); return false; }
    this.stack.push({ titleId, slotId });
    this.saveStack();
    this.renderStackButton();
    if (slotId) this.actions.hideSlot(slotId);
    // keep the physical shelves in sync with the stack's claimed slots
    this.actions.applyShelfStock?.();
    const t = this.byId.get(titleId);
    this.toast(`${t.title} added to your stack.`);
    return true;
  }
  removeFromStack(titleId) {
    const i = this.stack.findIndex(s => s.titleId === titleId);
    if (i === -1) return;
    const [entry] = this.stack.splice(i, 1);
    this.saveStack();
    if (entry.slotId) this.actions.showSlot(entry.slotId);
    this.actions.applyShelfStock?.();   // protection released with the save
    this.renderStackButton();
    this.renderStackPanel();
  }
  stackTotals() {
    let mins = 0;
    for (const s of this.stack) mins += totalRuntime(this.byId.get(s.titleId)) || 0;
    return { count: this.stack.length, mins };
  }
  renderStackButton() {
    $('stack-count').textContent = this.stack.length;
    $('btn-stack').classList.toggle('has-items', this.stack.length > 0);
  }
  toggleStackPanel() {
    const p = $('panel-stack');
    if (p.classList.contains('hidden')) { this.renderStackPanel(); this.showPanel('panel-stack'); }
    else this.hidePanel('panel-stack');
  }
  renderStackPanel() {
    const p = $('panel-stack');
    assertCanonical(this.stack.map(s => this.byId.get(s.titleId)), 'stack');
    const { count, mins } = this.stackTotals();
    p.innerHTML = `<div class="panel-head"><b>YOUR STACK</b><button class="x" id="pk-close">×</button></div>` +
      (count === 0
        ? `<div class="empty">Empty-handed so far.<br>Grab a case off a shelf and add it.</div>`
        : this.stack.map(s => {
          const t = this.byId.get(s.titleId);
          return `<div class="result">
            <img src="${this.thumb(t)}" alt="">
            <div class="r-info"><b>${t.title}</b> <i class="badge ${t.type}">${t.type === 'series' ? 'SERIES' : 'MOVIE'}</i>
              <span>${metaLine(t)}</span><span class="addr">${runtimeStr(t)}</span></div>
            <div class="r-actions"><button class="ghost rm" data-id="${t.id}">REMOVE</button></div>
          </div>`;
        }).join('') +
        `<div class="stack-total"><b>${count} TITLE${count === 1 ? '' : 'S'}</b> · ${fmtMins(mins)} of movie night
         <button class="gold" id="pk-checkout">CHECK OUT</button></div>`);
    $('pk-close').onclick = () => this.hidePanel('panel-stack');
    p.querySelectorAll('.rm').forEach(b => b.onclick = () => this.removeFromStack(b.dataset.id));
    const co = $('pk-checkout');
    if (co) co.onclick = () => { this.hidePanel('panel-stack'); this.actions.goCheckout(); };
  }

  showReceipt() {
    const { count, mins } = this.stackTotals();
    const lines = this.stack.map(s => {
      const t = this.byId.get(s.titleId);
      return `<tr><td>${t.title}</td><td>${t.type === 'series' ? 'SERIES' : 'MOVIE'}</td><td>${runtimeStr(t)}</td></tr>`;
    }).join('');
    $('receipt').innerHTML = `
      <div class="receipt-paper">
        <h3>TAPEBUSTER</h3>
        <p class="rc-sub">MEMBER #001337 · ${new Date().toLocaleDateString()}</p>
        <table>${lines}</table>
        <p class="rc-total">${count} TITLES · ${fmtMins(mins)}</p>
        <p class="rc-msg">DUE BACK: WHENEVER YOU'RE DONE<br>BE KIND, REWIND</p>
        <button class="gold" id="rc-done">START MOVIE NIGHT</button>
      </div>`;
    this.showPanel('receipt');
    this.audio.checkout();
    $('rc-done').onclick = () => {
      // titles go home with you; shelves quietly restock
      for (const s of this.stack) if (s.slotId) this.actions.showSlot(s.slotId);
      this.stack = [];
      this.saveStack();
      this.renderStackButton();
      this.hidePanel('receipt');
      this.toast('Enjoy your movie night! 🎬');
    };
  }

  offerReturn() {
    if (this.stack.length === 0) {
      this.toast('Nothing to return. Your stack is empty.');
      return;
    }
    const n = this.stack.length;
    for (const s of this.stack) if (s.slotId) this.actions.showSlot(s.slotId);
    this.stack = [];
    this.saveStack();
    this.renderStackButton();
    this.audio.casePut();
    this.toast(`${n} title${n === 1 ? '' : 's'} dropped in the return bin. Thanks!`);
  }

  // ------------------------------------------------------------ clerk
  openClerk() {
    const p = $('panel-clerk');
    if (!p.dataset.init) {
      p.dataset.init = '1';
      p.innerHTML = `
        <div class="panel-head"><b>🎧 STORE CLERK</b><button class="x" id="pc-close">×</button></div>
        <div id="clerk-log"></div>
        <div id="clerk-chips">
          <button>What can I watch tonight?</button>
          <button>Something like Heat</button>
          <button>90 minute horror</button>
          <button>Crime series to binge</button>
          <button>Family night pick</button>
          <button>Surprise me</button>
        </div>
        <form id="clerk-form"><input id="clerk-input" placeholder="Ask for a recommendation…" autocomplete="off"><button class="gold">ASK</button></form>`;
      $('pc-close').onclick = () => this.hidePanel('panel-clerk');
      $('clerk-form').addEventListener('submit', (e) => {
        e.preventDefault();
        const v = $('clerk-input').value.trim();
        if (v) { this.clerkAsk(v); $('clerk-input').value = ''; }
      });
      p.querySelectorAll('#clerk-chips button').forEach(b =>
        b.addEventListener('click', () => this.clerkAsk(b.textContent)));
      this.clerkSay(`Welcome to TapeBuster! Ask me for anything: a mood, a genre, “like <i>some movie</i>”, or “where is <i>a title</i>”.`);
    }
    this.showPanel('panel-clerk');
  }
  clerkSay(html, picks = [], wayfind = false) {
    const log = $('clerk-log');
    const div = document.createElement('div');
    div.className = 'clerk-msg';
    // THE BUTTON MUST MATCH THE BUILDING. TAKE ME THERE on a title the store
    // does not have out walks the shopper to nothing, which is how the clerk
    // used to answer "where is X" for 200 out of 200 unstocked titles. The
    // search panel already got this right; the clerk did not.
    div.innerHTML = `<p>${html}</p>` + picks.map(t => {
      const stocked = this.isStocked(t.id);
      return `
      <div class="clerk-pick">
        <img src="${this.thumb(t)}" alt="">
        <div><b>${t.title}</b><span>${metaLine(t)}</span>${
        stocked ? '' : '<span class="clerk-off">In the catalogue, not on the floor today</span>'}</div>
        <div class="r-actions">
          <button class="gold go" data-id="${t.id}">${stocked ? 'TAKE ME THERE' : 'STOCK IT & GO'}</button>
          <button class="ghost open" data-id="${t.id}">OPEN</button>
        </div>
      </div>`;
    }).join('');
    log.appendChild(div);
    div.querySelectorAll('.go').forEach(b => b.onclick = () => {
      this.closeAllPanels();
      this.actions.goToTitle(b.dataset.id);
    });
    div.querySelectorAll('.open').forEach(b => b.onclick = () => this.showTitleCard(this.byId.get(b.dataset.id), 'clerk'));
    log.scrollTop = log.scrollHeight;
    if (wayfind && picks[0]) {
      setTimeout(() => { this.closeAllPanels(); this.actions.goToTitle(picks[0].id); }, 900);
    }
  }
  clerkAsk(q) {
    const log = $('clerk-log');
    const you = document.createElement('div');
    you.className = 'clerk-you';
    you.textContent = q;
    log.appendChild(you);
    this.audio.uiBlip();
    const resp = clerkRespond(this.searchPool(), this.curation, q, this.clerkSession, this.searchOpts());
    assertCanonical(resp.picks, 'clerk');
    setTimeout(() => this.clerkSay(resp.text, resp.picks, resp.wayfind), 260);
  }

  // ------------------------------------------------------------ debug
  toggleDebug() {
    this.debugOpen = !this.debugOpen;
    $('debug').classList.toggle('hidden', !this.debugOpen);
    if (this.debugOpen && !$('debug').dataset.init) {
      $('debug').dataset.init = '1';
      $('debug').innerHTML = `<pre id="dbg-text"></pre>
        <label><input type="checkbox" id="dbg-path"> nav path</label>
        <label><input type="checkbox" id="dbg-grid"> nav grid</label>
        <label><input type="checkbox" id="dbg-col"> colliders</label>`;
      $('dbg-path').onchange = (e) => { this.debugFlags.path = e.target.checked; };
      $('dbg-grid').onchange = (e) => { this.debugFlags.grid = e.target.checked; };
      $('dbg-col').onchange = (e) => { this.debugFlags.colliders = e.target.checked; };
    }
  }
  setDebugText(txt) {
    if (this.debugOpen) $('dbg-text').textContent = txt;
  }
}
