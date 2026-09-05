// THE ONE AUTHORITATIVE ANSWER TO "CAN THIS PERSON WATCH THIS TITLE RIGHT NOW?"
//
// Every part of the product that decides whether a title is watchable must call
// isCurrentlyWatchable(). Nothing else may re-derive it. Before this module the
// rule was a one-liner in projection.js (`services.stream` ∩ myServices) with
// the region, access type, and provenance checks living nowhere at all — which
// meant "WATCHABLE FOR YOU" was an unaudited claim.
//
// Pure module: no snapshot import, no DOM, no clock unless you pass one.
// Node-testable and safe to import from the ingest scripts.
//
// ---------------------------------------------------------------------------
// WHAT THIS MODULE WILL AND WILL NOT CLAIM
//
//   * A title with NO availability row is UNKNOWN, never "unavailable", and
//     unknown is NEVER eligible. Absence of evidence is not evidence.
//   * Rent/buy is not a subscription. Ever. A row that says you can pay $4.99
//     to rent a film is not the same fact as "your Hulu covers it".
//   * `verified: true` in the result is the ONLY signal a UI may present as
//     verification. Most rows are unverified-but-sourced and say so.
//   * This module measures rows against a stated policy. It cannot measure
//     whether the rows are externally correct — no licensed feed, no such
//     claim. Do not let a caller turn "passes our policy" into "is on Netflix".
// ---------------------------------------------------------------------------

/**
 * Providers a user can actually hold and which therefore make a title watchable
 * at NO EXTRA COST. Deliberately excludes the Apple TV storefront (rent/buy
 * only) even though it produces the single largest block of availability rows.
 *
 * Tubi is in this list but is ad-supported rather than subscribed — it is a
 * provider you "have" by definition, with access type 'free'. The distinction is
 * preserved in the data and the labels; only the eligibility question ("can they
 * watch it without paying more?") treats them alike.
 */
export const SUBSCRIPTION_PROVIDERS = Object.freeze(['Netflix', 'Max', 'Hulu', 'Disney+',
  'Prime Video', 'Paramount+', 'Peacock', 'Apple TV+', 'Tubi']);
const SUBSCRIBABLE = new Set(SUBSCRIPTION_PROVIDERS);

/**
 * Ad-supported services. This is a property of the SERVICE, not of any one
 * title's evidence row: Tubi costs nothing for everything it carries, so a
 * label built from the provider is as honest as one built from a row — and it
 * is available where no row is in hand (the mode chip names services, not
 * titles). Saying "Subscription" over a free service would assert a paid
 * entitlement the shopper does not need.
 */
export const FREE_PROVIDERS = Object.freeze(['Tubi']);
const FREE_SET = new Set(FREE_PROVIDERS);

/** 'free' | 'subscription' — what holding this service costs the shopper. */
export function accessKindOf(provider) {
  return FREE_SET.has(provider) ? 'free' : 'subscription';
}

/** Human label for a set of services, honest when they are mixed. */
export function accessLabelFor(providers) {
  const kinds = new Set([...providers].map(accessKindOf));
  if (kinds.size === 0) return null;
  if (kinds.size > 1) return 'Subscription · free with ads';
  return kinds.has('free') ? 'Free with ads' : 'Subscription';
}

/** Ordered weakest → strongest. A row's confidence must clear the policy floor. */
export const CONFIDENCE_ORDER = Object.freeze(['low', 'medium', 'high']);
const confidenceRank = (c) => {
  const i = CONFIDENCE_ORDER.indexOf(c);
  return i < 0 ? -1 : i;                 // an unrecognised label is BELOW 'low'
};

// ---------------------------------------------------------------------------
// THE FRESHNESS / CONFIDENCE POLICY
//
// One frozen constant, not literals scattered through the call site, because
// this is a product decision that has to be arguable and reversible in one
// place. Every field below is a choice somebody has to defend.
//
// THE SITUATION IT HAS TO HANDLE: in the shipped snapshot roughly 99% of
// availability rows have `verifiedAt: null`. They come from Wikidata's
// per-service catalogue-id properties, which record that a work HAS A PAGE in a
// service's catalogue. Those properties are not time-scoped and an id is rarely
// removed when a title leaves. There is no date on which anyone checked, so the
// ingest emits null rather than inheriting the build date — a build date would
// be a record of us running a script, dressed up as evidence.
//
// SO WHAT DOES THE POLICY DO WITH THEM?
//
//   admitUndated: true — undated rows ARE eligible, and are reported as
//   unverified. The alternative was considered and rejected: refusing them
//   would drop the watchable set from ~8,400 titles to the ~250 covered by the
//   hand audit, and, more importantly, it would treat "we cannot date this
//   evidence" as "this evidence is false". That is the same fallacy as treating
//   a missing row as proof of absence, which this codebase forbids everywhere
//   else. An undated row is still positive evidence from a source that was
//   itself audited (see docs/DATA-SOURCES.md for the sources rejected outright).
//   The honest handling is to admit it and label it, not to silently promote it
//   and not to silently destroy it.
//
//   The cost of that choice, stated plainly: an undated row can be out of date,
//   and the aggregate is known to overstate — 43 titles claim three or more
//   simultaneous subscriptions. Flip admitUndated to false and the store
//   collapses to the audited rows; that is the lever, and it is one line.
//
//   admitStale: true — a DATED row past maxAgeDays is demoted to the same tier
//   as an undated one, not rejected. Rejecting it would rank "a human verified
//   this eight months ago" BELOW "nobody ever verified this", which is
//   incoherent. Staleness downgrades the claim; it does not delete it.
//
//   Consequence worth knowing: because both undated and stale rows are
//   admitted, ELIGIBILITY DOES NOT DEPEND ON THE CLOCK under this policy — only
//   the freshness LABEL does. The projection is therefore reproducible. Set
//   either flag to false and eligibility becomes time-dependent, and a snapshot
//   that passed tests in March will fail them in June. That is a legitimate
//   thing to want; it is not free.
//
//   maxAgeDays: 90 — a streaming licence window is commonly a quarter, so a
//   check older than that is no longer a current-state claim. This is a
//   judgement, not a measurement; it is here so it can be argued with.
//
//   minConfidence: 'medium' — 'high' is reserved by the ingest for rows a human
//   verified on a known date, so requiring it would be the same as
//   admitUndated: false. 'medium' admits the audited Wikidata sources and
//   excludes anything a future ingest cannot vouch for at least that much.
export const FRESHNESS_POLICY = Object.freeze({
  id: 'us-subscription-v1',
  region: 'US',
  // 'free' is Tubi's access type, and it is NOT a synonym for subscription —
  // Tubi is ad-supported and costs nothing, so calling its rows 'subscription'
  // would assert a paid entitlement that does not exist. It is admitted here
  // because the QUESTION the policy answers is "can this person watch it at no
  // extra cost", and free-with-ads answers yes at least as strongly as a
  // subscription does. The label vocabulary keeps them distinct.
  accessTypes: Object.freeze(['subscription', 'free']),
  minConfidence: 'medium',
  maxAgeDays: 90,
  admitUndated: true,
  admitStale: true,
  // Coarse dates resolve to the EARLIEST instant they could mean, so a
  // month-precision '2026-08' is never allowed to look fresher than it is.
  coarseDateResolution: 'earliest',
});

/** Why a title is or is not watchable. Stable codes — UIs may switch on these. */
export const REASONS = Object.freeze({
  ELIGIBLE: 'ELIGIBLE',
  NO_SERVICES_SELECTED: 'NO_SERVICES_SELECTED',
  UNKNOWN_AVAILABILITY: 'UNKNOWN_AVAILABILITY',
  NO_SUBSCRIPTION_ROW: 'NO_SUBSCRIPTION_ROW',
  WRONG_REGION: 'WRONG_REGION',
  NOT_ON_YOUR_SERVICES: 'NOT_ON_YOUR_SERVICES',
  FAILED_POLICY: 'FAILED_POLICY',
});

const DAY_MS = 86400000;

/**
 * Parse a verifiedAt into an epoch ms, preserving the precision it was written
 * with. 'YYYY-MM-DD' is that day; 'YYYY-MM' is the FIRST of that month, because
 * the earliest reading is the one that cannot overstate freshness.
 * Returns null for null/absent, NaN-safe.
 */
export function parseVerifiedAt(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const s = String(value);
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
  m = /^(\d{4})-(\d{2})$/.exec(s);
  if (m) return Date.UTC(+m[1], +m[2] - 1, 1);
  m = /^(\d{4})$/.exec(s);
  if (m) return Date.UTC(+m[1], 0, 1);
  return null;                            // unparseable is not a date
}

/**
 * Classify one row's verification age.
 * 'verified' — dated and within maxAgeDays.
 * 'stale'    — dated but older.
 * 'undated'  — no verification date was ever recorded (the common case).
 * 'unparseable' — a verifiedAt we cannot read; treated as undated, never as fresh.
 */
export function classifyFreshness(verifiedAt, nowMs, policy = FRESHNESS_POLICY) {
  if (verifiedAt == null || verifiedAt === '') return { state: 'undated', ageDays: null };
  const t = parseVerifiedAt(verifiedAt);
  if (t == null) return { state: 'unparseable', ageDays: null };
  const ageDays = Math.floor((nowMs - t) / DAY_MS);
  return { state: ageDays <= policy.maxAgeDays ? 'verified' : 'stale', ageDays };
}

const FRESHNESS_ADMITTED = {
  verified: () => true,
  stale: (p) => p.admitStale,
  undated: (p) => p.admitUndated,
  unparseable: (p) => p.admitUndated,
};

// Best-first, for reporting the strongest thing we can honestly say.
const FRESHNESS_STRENGTH = { verified: 3, stale: 2, undated: 1, unparseable: 0 };

const toSet = (services) => {
  if (services instanceof Set) return services;
  if (Array.isArray(services)) return new Set(services);
  if (services == null) return new Set();
  return new Set([services]);
};

const accessOf = (row) => row.accessType ?? row.access ?? null;

function result(eligible, reason, extra) {
  return {
    eligible,
    reason,
    policy: FRESHNESS_POLICY.id,
    region: FRESHNESS_POLICY.region,
    verified: false,
    freshness: null,
    providers: [],
    matches: [],
    rentBuyOnly: false,
    ...extra,
  };
}

/**
 * THE authoritative eligibility function.
 *
 * @param {object} title        a catalogue record; its `availability` array is
 *                              the evidence. A title with no such array is
 *                              UNKNOWN, not unavailable.
 * @param {Set<string>|string[]} userServices  subscriptions the user holds.
 * @param {object} [options]
 * @param {number|Date|string} [options.now]   clock for freshness, for tests.
 * @param {object} [options.policy]            override FRESHNESS_POLICY.
 * @returns {{eligible:boolean, reason:string, providers:string[], matches:object[],
 *            verified:boolean, freshness:string|null, rentBuyOnly:boolean,
 *            policy:string, region:string, detail:string}}
 *
 * Eligible is true ONLY when some availability row satisfies ALL of:
 *   region === policy.region  AND  accessType is a subscription access
 *   AND the provider is a real subscription provider the user holds
 *   AND the row clears the confidence floor and the freshness policy.
 */
export function isCurrentlyWatchable(title, userServices, options = {}) {
  const policy = options.policy ?? FRESHNESS_POLICY;
  const mine = toSet(userServices);
  const nowMs = options.now == null ? Date.now()
    : (options.now instanceof Date ? options.now.getTime()
      : (typeof options.now === 'number' ? options.now : Date.parse(options.now)));

  const rows = Array.isArray(title?.availability) ? title.availability : null;

  // No availability data at all is UNKNOWN. It is reported as unknown and it is
  // never eligible — the two halves of the same honesty rule.
  if (!rows || rows.length === 0) {
    return result(false, REASONS.UNKNOWN_AVAILABILITY,
      { detail: 'no availability data for this title in the snapshot: unknown, not unavailable' });
  }

  if (mine.size === 0) {
    return result(false, REASONS.NO_SERVICES_SELECTED,
      { detail: 'no subscriptions selected' });
  }

  const subAccess = new Set(policy.accessTypes);
  let sawSubscriptionRow = false;         // a real subscription row, any region
  let sawInRegion = false;                // ...in our region
  let sawRentBuy = false;
  let failedPolicy = 0;
  let matches = null;

  for (const row of rows) {
    const access = accessOf(row);
    if (access === 'rent' || access === 'buy') { sawRentBuy = true; continue; }
    // Rent/buy is never subscription watchability, and a provider we do not
    // model as subscribable cannot make anything watchable either.
    if (!subAccess.has(access) || !SUBSCRIBABLE.has(row.provider)) continue;
    sawSubscriptionRow = true;

    // A row whose region we do not know is not a US row. We refuse to assume.
    if (row.region !== policy.region) continue;
    sawInRegion = true;

    if (!mine.has(row.provider)) continue;

    if (confidenceRank(row.confidence) < confidenceRank(policy.minConfidence)) { failedPolicy++; continue; }
    const fresh = classifyFreshness(row.verifiedAt, nowMs, policy);
    if (!FRESHNESS_ADMITTED[fresh.state](policy)) { failedPolicy++; continue; }

    (matches ??= []).push({
      provider: row.provider,
      region: row.region,
      accessType: access,
      verifiedAt: row.verifiedAt ?? null,
      source: row.source ?? null,
      confidence: row.confidence ?? null,
      freshness: fresh.state,
      ageDays: fresh.ageDays,
    });
  }

  if (matches) {
    matches.sort((a, b) => FRESHNESS_STRENGTH[b.freshness] - FRESHNESS_STRENGTH[a.freshness]
      || confidenceRank(b.confidence) - confidenceRank(a.confidence)
      || a.provider.localeCompare(b.provider));
    const best = matches[0].freshness;
    return result(true, REASONS.ELIGIBLE, {
      providers: [...new Set(matches.map(m => m.provider))],
      matches,
      // `verified` is deliberately strict: only a real, in-policy verification
      // date earns it. Undated and stale rows are eligible but unverified, and
      // a UI must not print "verified" for them.
      verified: best === 'verified',
      freshness: best,
      rentBuyOnly: false,
      detail: best === 'verified'
        ? `verified on ${matches[0].verifiedAt} (${matches[0].source})`
        : `sourced but ${best === 'stale' ? 'last verified outside the freshness window' : 'never externally verified'}, via ${matches[0].source}`,
    });
  }

  if (!sawSubscriptionRow) {
    return result(false, REASONS.NO_SUBSCRIPTION_ROW, {
      rentBuyOnly: sawRentBuy,
      detail: sawRentBuy
        ? 'only rent/buy rows exist, and renting is not subscription watchability'
        : 'no subscription row from a provider we model as subscribable',
    });
  }
  if (!sawInRegion) {
    return result(false, REASONS.WRONG_REGION, {
      rentBuyOnly: sawRentBuy,
      detail: `subscription rows exist but none is scoped to ${policy.region}`,
    });
  }
  if (failedPolicy > 0) {
    return result(false, REASONS.FAILED_POLICY, {
      rentBuyOnly: sawRentBuy,
      detail: `${failedPolicy} matching row(s) failed policy ${policy.id} (confidence floor ${policy.minConfidence}, max age ${policy.maxAgeDays}d)`,
    });
  }
  return result(false, REASONS.NOT_ON_YOUR_SERVICES, {
    rentBuyOnly: sawRentBuy,
    detail: 'this title has US subscription rows, but not on a service you hold',
  });
}

/** Convenience for hot loops that only need the boolean. Same rule, no prose. */
export function isWatchable(title, userServices, options) {
  return isCurrentlyWatchable(title, userServices, options).eligible;
}
