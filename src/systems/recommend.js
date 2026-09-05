// Local search + recommendation engine. Pure module (Node-testable).
// Powers the search bar AND the deterministic AI clerk — no API keys required.
//
// TWO DIFFERENT SETS, AND THE CLERK HAS TO KNOW WHICH IS WHICH.
//
//   the CATALOGUE  — everything TapeBuster knows about, 122,948 titles.
//   the STORE      — the capacity-bounded selection actually on shelves today.
//
// Measured before this was fixed: in ALL TITLES mode, 102,948 of the 122,948
// searchable titles were not on any shelf, and the clerk answered "where is X"
// with "We've got it on the shelf and I'll walk you over" for 200 out of 200
// unstocked titles. In MY SERVICES mode, 199 of 200. Search returned 9 of 14
// results the shopper could not walk to.
//
// The repair is GROUNDING, not filtering. `opts.stockedIds` tells this module
// what is physically on the floor, so it can rank the store first and say the
// truth about the rest. It does NOT decide what the store carries — membership
// belongs to the projection and nothing here may narrow it, or the catalogue
// would silently shrink to the shelves and the shop would stop knowing about
// the other hundred thousand films.
import { detailOf } from '../data/detail.js';
import { detailEpoch } from '../data/epoch.js';

const GENRE_SYNONYMS = {
  scary: 'Horror', horror: 'Horror', spooky: 'Horror', creepy: 'Horror', slasher: 'Horror',
  funny: 'Comedy', comedy: 'Comedy', comedies: 'Comedy', laugh: 'Comedy', hilarious: 'Comedy',
  action: 'Action', explosions: 'Action', fight: 'Action',
  drama: 'Drama', emotional: 'Drama', sad: 'Drama',
  romance: 'Romance', romantic: 'Romance', love: 'Romance', romcom: 'Romance',
  thriller: 'Thriller', thrillers: 'Thriller', tense: 'Thriller', suspense: 'Thriller',
  'sci-fi': 'Sci-Fi', scifi: 'Sci-Fi', science: 'Sci-Fi', space: 'Sci-Fi', 'mind-bending': 'Sci-Fi',
  fantasy: 'Fantasy', magic: 'Fantasy', wizards: 'Fantasy',
  crime: 'Crime', heist: 'Crime', gangster: 'Crime', mob: 'Crime', noir: 'Crime',
  mystery: 'Mystery', whodunit: 'Mystery', detective: 'Mystery',
  western: 'Western', westerns: 'Western', cowboy: 'Western',
  war: 'War', animation: 'Animation', animated: 'Animation', cartoon: 'Animation',
  anime: 'Anime', family: 'Family', kids: 'Family', documentary: 'Documentary',
  documentaries: 'Documentary', docs: 'Documentary', musical: 'Musical', musicals: 'Musical',
  adventure: 'Adventure',
};

const STOPWORDS = new Set(['a', 'an', 'the', 'me', 'i', 'my', 'we', 'us', 'to', 'for', 'of', 'in', 'on',
  'with', 'and', 'or', 'som', 'some', 'something', 'good', 'great', 'watch', 'tonight', 'find',
  'give', 'want', 'wife', 'husband', 'can', 'that', 'is', 'it', 'about', 'movies', 'films']);

function norm(s) {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

export function parseQuery(raw) {
  const q = norm(raw).trim();
  const intent = {
    text: q, terms: [], genres: new Set(), type: null,
    decade: null, year: null, maxRuntime: null, minRuntime: null,
    likeTitle: null, surprise: false, familySafe: false,
  };

  // "like <title>" / "similar to <title>"
  const like = q.match(/(?:like|similar to)\s+(.+)$/);
  if (like) intent.likeTitle = like[1].replace(/[?.!]/g, '').trim();

  if (/surprise|random|anything|dealer'?s choice/.test(q)) intent.surprise = true;
  if (/family|kid|children/.test(q)) intent.familySafe = true;

  // decades: "90s", "1990s", "nineties"
  const dec = q.match(/\b(19|20)?([2-9]0)s\b/);
  if (dec) intent.decade = (dec[1] ? parseInt(dec[1] + dec[2]) : (parseInt(dec[2]) >= 30 ? 1900 + parseInt(dec[2]) : 2000 + parseInt(dec[2])));
  if (/\bnineties\b/.test(q)) intent.decade = 1990;
  if (/\beighties\b/.test(q)) intent.decade = 1980;
  if (/\bseventies\b/.test(q)) intent.decade = 1970;

  const yr = q.match(/\b(19[3-9]\d|20[0-2]\d)\b/);
  if (yr && !dec) intent.year = parseInt(yr[1]);

  // runtime: "90 minute", "under 100 minutes", "under 2 hours", "short"
  const under = q.match(/under\s+(\d{2,3})\s*min/);
  const underH = q.match(/under\s+(\d(?:\.\d)?)\s*hours?/);
  const around = q.match(/\b(\d{2,3})[-\s]?min/);
  if (under) intent.maxRuntime = parseInt(under[1]);
  else if (underH) intent.maxRuntime = Math.round(parseFloat(underH[1]) * 60);
  else if (around) intent.maxRuntime = parseInt(around[1]) + 12;
  if (/\bshort\b/.test(q) && !intent.maxRuntime) intent.maxRuntime = 100;

  // type
  if (/\b(series|show|shows|tv|season|binge|sitcom)\b/.test(q)) intent.type = 'series';
  else if (/\b(movie|film|flick)\b/.test(q)) intent.type = 'movie';

  // genres + leftover terms
  for (const tok of q.replace(/[^a-z0-9\s'-]/g, ' ').split(/\s+/)) {
    if (!tok) continue;
    const mapped = GENRE_SYNONYMS[tok];
    if (mapped) { intent.genres.add(mapped); continue; }
    if (/^\d+$/.test(tok)) continue;
    if (/^(minute|minutes|min|hour|hours|under|series|show|shows|tv|season|movie|film|flick|like|similar)$/.test(tok)) continue;
    if (STOPWORDS.has(tok)) continue;
    intent.terms.push(tok);
  }
  return intent;
}

function familyOK(t) {
  return ['G', 'PG', 'TV-Y', 'TV-G', 'TV-PG'].includes(t.rating);
}

// null when the sources don't support the claim. `null * 10` is 0 in JS, which
// previously rendered as a confident "Full series ≈ 0m" for the 1,754 series
// with no episode count or episode runtime.
export function totalRuntime(t) {
  if (t.type === 'movie') return t.runtime ?? null;
  if (t.episodes == null || t.episodeRuntime == null) return null;
  return t.episodes * t.episodeRuntime;
}

// ---- personal watchability (My Services) -----------------------------------
// Streaming services are attributes of the ONE canonical title; intersecting
// them with the user's subscriptions never creates or removes records.
export function watchableOn(t, myServices) {
  if (!myServices || myServices.size === 0) return [];
  return (t.services?.stream || []).filter(s => myServices.has(s));
}
export function isWatchable(t, myServices) {
  return watchableOn(t, myServices).length > 0;
}
export function filterByServices(catalog, myServices) {
  return catalog.filter(t => isWatchable(t, myServices));
}

// Cast/crew and synopsis live in lazily-loaded detail shards, so they are read
// through detailOf() and are simply absent until those shards arrive. Title,
// genre, year and type search always work; people/plot matching sharpens once
// the background preload lands.
//
// PERFORMANCE: a query that matches few titles falls through to the people and
// plot branches for nearly all 87k records. Rebuilding those strings per query
// costs ~160 ms — so every normalised haystack is memoised per record. The
// epoch invalidates entries built before a detail shard filled a record in.
const memo = new WeakMap();   // record -> { epoch, title, persons, synopsis }
function fields(t) {
  let m = memo.get(t);
  if (m === undefined || m.epoch !== detailEpoch()) {
    const d = detailOf(t.id);
    const who = t.type === 'movie' ? (d.director || t.director) : (d.creators || t.creators);
    const castArr = d.cast?.length ? d.cast : (t.cast || []);
    const cast = Array.isArray(castArr) ? castArr.join(' ') : String(castArr || '');
    m = {
      epoch: detailEpoch(),
      title: norm(t.title),
      persons: (who || cast) ? norm(`${who || ''} ${cast}`) : '',
      synopsis: norm(d.synopsis || t.synopsis || ''),
    };
    memo.set(t, m);
  }
  return m;
}

const normTitleOf = (t) => fields(t).title;
const personsOf = (t) => fields(t).persons;

/**
 * @param {object} opts
 * @param {Set<string>} [opts.stockedIds] ids physically on a shelf right now.
 *   Omitted means "do not distinguish" — every result is reported inStore,
 *   which is the correct reading for a caller that passed only the store.
 */
export function searchCatalog(catalog, rawQuery, limit = 12, opts = {}) {
  const intent = parseQuery(rawQuery);
  const stocked = opts.stockedIds ?? null;
  if (!intent.text) return { intent, results: [], counts: { matched: 0, inStore: 0 } };
  // MY SERVICES mode (or an explicit "I can watch" request) narrows the
  // CANDIDATE POOL of canonical titles — it never duplicates or splits them.
  const wantsWatchable = /\b(i can watch|can watch tonight|my services|my subscriptions)\b/.test(intent.text);
  if ((opts.myServicesOnly || wantsWatchable) && opts.myServices?.size) {
    catalog = filterByServices(catalog, opts.myServices);
  }

  // "like" and "similar to" are search OPERATORS, but they are also ordinary
  // English that appears inside real titles — Millions Like Us, Like Water for
  // Chocolate, Something Like Summer. Treating those as "find me films similar
  // to Us" made them unfindable by their own name. A query that IS a title in
  // the pool always wins over the operator reading.
  const queryIsATitle = intent.likeTitle
    && catalog.some(t => normTitleOf(t) === norm(rawQuery).trim());

  if (intent.likeTitle && !queryIsATitle) {
    const seed = bestTitleMatch(catalog, intent.likeTitle);
    if (seed) {
      const sim = similarTo(catalog, seed, limit).map(t => ({
        title: t, score: 50, why: `Because you liked ${seed.title}`,
        inStore: stocked ? stocked.has(t.id) : true,
      }));

      return {
        intent,
        seed,
        results: sim,
        counts: { matched: sim.length, inStore: sim.reduce((a, r) => a + (r.inStore ? 1 : 0), 0) },
      };
    }
  }

  const scored = [];
  const rawN = norm(rawQuery).trim();
  for (const t of catalog) {
    let score = 0;
    const why = [];
    const f = fields(t);
    const titleN = f.title;
    // A typed title trumps everything — "cowboy bebop" must find Cowboy Bebop
    // even though "cowboy" reads as a Western genre hint.
    const typedTitle = titleN === rawN || (rawN.length >= 4 && titleN.startsWith(rawN));
    if (titleN === rawN) score += 130;
    else if (typedTitle) score += 70;

    // hard filters (bypassed when the user typed the title itself)
    if (!typedTitle) {
      if (intent.type && t.type !== intent.type) continue;
      if (intent.decade && (t.year < intent.decade || t.year >= intent.decade + 10)) continue;
      // A runtime cap is a promise ("nothing over 90 minutes"). `null > 90` is
      // false, so an unknown runtime used to sail through the filter and break
      // that promise — an unverifiable runtime is excluded instead.
      if (intent.maxRuntime) {
        const rt = t.type === 'movie' ? t.runtime : t.episodeRuntime;
        if (rt == null || rt > intent.maxRuntime) continue;
      }
      if (intent.familySafe && !familyOK(t)) continue;
      if (intent.genres.size) {
        const hits = [...intent.genres].filter(gn => t.genres.includes(gn));
        if (hits.length === 0) continue;
        score += 24 * hits.length;
        why.push(hits.join(' / '));
      }
    }
    if (intent.year && Math.abs(t.year - intent.year) <= 1) { score += 25; why.push(String(t.year)); }

    // term matching
    let allTermsHit = intent.terms.length > 0;
    for (const term of intent.terms) {
      if (titleN === term) { score += 90; }
      else if (titleN.startsWith(term)) { score += 55; }
      else if (titleN.includes(term)) { score += 40; }
      else if (f.persons.includes(term)) { score += 34; why.push('cast/crew match'); }
      else if (f.synopsis.includes(term)) { score += 8; }
      else allTermsHit = false;
    }
    if (intent.terms.length >= 2 && allTermsHit) score += 30;

    // pure-filter queries (genre/decade/type only) still return results
    if (score === 0 && intent.terms.length === 0 &&
        (intent.genres.size || intent.decade || intent.type || intent.maxRuntime || intent.familySafe)) {
      score = 10;
    }
    if (score > 0) {
      // IN STORE IS A RANKING SIGNAL AND A LABEL, NEVER A FILTER. A shopper
      // standing in the shop is usually asking about the shop, so what is on
      // a shelf sorts first — but a catalogue-only title still appears, still
      // scores on its merits, and is simply marked for what it is. Dropping it
      // would turn a search over 122,948 titles into a search over 20,000 and
      // quietly delete the rest of what the store knows.
      scored.push({
        title: t,
        score: score + (t.year >= 1985 && t.year <= 2005 ? 2 : 0),
        why: why.join(' · '),
        // A LABEL, NOT A RANKING SIGNAL. Boosting shelf stock here was
        // tempting and wrong: the search panel already says "IN BACK-STOCK"
        // and offers STOCK IT & GO for anything the store does not have out,
        // so it was honest already — and reordering it would have changed
        // results this repo has tests for, to fix a defect that lives in the
        // clerk. Relevance stays relevance.
        inStore: stocked ? stocked.has(t.id) : true,
      });
    }
  }
  scored.sort((a, b) => b.score - a.score || a.title.title.localeCompare(b.title.title));
  const results = scored.slice(0, limit);
  return {
    intent,
    results,
    // Counted over EVERYTHING that matched, not over the page being shown, so
    // the UI can say "and 340 more in the catalogue we do not have in today"
    // without re-scanning.
    counts: {
      matched: scored.length,
      inStore: scored.reduce((a, r) => a + (r.inStore ? 1 : 0), 0),
    },
  };
}

/**
 * How well one title answers a typed request. 0 means "not a match".
 *
 * THE TWO PREFIX DIRECTIONS ARE DIFFERENT PROBLEMS, AND A SYMMETRIC OVERLAP
 * RATIO GOT ONE OF THEM BADLY WRONG.
 *
 * A first version scored `tn.startsWith(q) || q.startsWith(tn)` with one
 * shared shorter/longer ratio and RETURNED it, short-circuiting the substring
 * fallback. Measured against the real catalogue, that made 8,069 of the 8,749
 * titles with a subtitle unfindable by their own main title: "kill bill"
 * scored 0 against "Kill Bill: Vol. 1" (9/17 = 0.53, under the 0.6 bar) while
 * the same words sitting mid-title anywhere else still scored 50. The clerk
 * answered "where is kill bill" with "I don't think we carry that one" as the
 * search bar, one keystroke away, listed all three Kill Bill records.
 *
 * So the directions are scored separately:
 *
 *   tn.startsWith(q) — the shopper typed the MAIN TITLE and the record carries
 *   a subtitle. That is the single most common way people name films, and it
 *   is safe: the query has to account for the title's own opening. It scores
 *   above a substring match, so "Mission: Impossible" outranks "The Mission"
 *   for the query "mission" instead of losing to it.
 *
 *   q.startsWith(tn) — the TITLE is a prefix of the QUERY, which is how a film
 *   called "W" once answered for "WWJD What Would Jesus Do? The Journey
 *   Continues", and "Bros" for "BROS. Last Call". Here the overlap ratio is
 *   exactly right: the title must account for most of what was asked, or it is
 *   not what was asked for.
 */
/**
 * Punctuation is COMPARED AWAY, in both directions. clerkRespond strips ?.!
 * from what the shopper typed, but titles keep theirs — so "Mrs. Doubtfire"
 * asked verbatim became "mrs doubtfire", diverged from "mrs. doubtfire" at
 * the period, and scored 0 against its own record. Measured: 2,300 catalogue
 * titles (1.9%) were unfindable by their own name. The same rule lets
 * "mission impossible" reach "Mission: Impossible" without special-casing
 * the colon. Hyphens become spaces ("Extra-Terrestrial" -> two words);
 * everything else in the class simply vanishes.
 */
function depunct(s) {
  // '*' is in the vanish class for one film in particular: M*A*S*H, which no
  // shopper has ever asked for with the asterisks. The hyphen class becomes a
  // SPACE (Extra-Terrestrial is two words), and WALL·E's middle dot rides
  // with it, because "wall e" is how that title is typed.
  return s.replace(/[-·]/g, ' ').replace(/[.,:;!?'’"()*]/g, '').replace(/\s+/g, ' ').trim();
}

export function titleMatchScore(t, q0) {
  const tn = depunct(normTitleOf(t));
  const q = depunct(q0);
  if (tn === q) return 100;
  if (tn.replace(/^the\s+/, '') === q.replace(/^the\s+/, '')) return 95;
  // A prefix only counts when it ends at a WORD BOUNDARY. Without this,
  // "seve" was a 60-point prefix of "SEVEnteen Times Cécile Cassard" and tied
  // with "Seve: The Legend", leaving the winner to iteration order. Mid-word
  // agreement is a substring accident and falls through to the 50 tier.
  const boundary = (s, at) => at >= s.length || !/[a-z0-9]/.test(s[at]);
  // THE TWO DIRECTIONS MUST NOT SHARE A SCORE. Both once returned 60, so
  // "halloween h20" TIED 'Halloween H20: 20 Years Later' with 'Halloween' —
  // a different film — and iteration order or the stock tie-break picked the
  // winner; for "barbershop 2" the tie-break actively chose the WRONG film
  // because the right one was in back-stock. Direction 1 is the shopper
  // naming THIS film's own opening, so it outranks direction 2, where the
  // ask has been truncated to some other film's whole name.
  if (q.length >= 2 && tn.startsWith(q) && boundary(tn, q.length)) {
    return q.length / tn.length >= 0.85 ? 72 : 65;
  }
  if (tn.length >= 3 && q.startsWith(tn) && boundary(q, tn.length)) {
    // A DIGIT IN THE UNMATCHED TAIL MEANS A DIFFERENT FILM. "barbershop 2"
    // covers 'Barbershop' at 0.79, "miss congeniality 2" covers 'Miss
    // Congeniality' at 0.89 — high ratios, and both walks would be to the
    // WRONG film, because the shopper said the number. An honest "we don't
    // carry that" beats a confident walk to the predecessor, and the sequel
    // itself, when the catalogue has it under a subtitle, wins through the
    // direction-1 tier above.
    if (/\d/.test(q.slice(tn.length))) return 0;
    const overlap = tn.length / q.length;
    if (overlap >= 0.85) return 70;
    if (overlap >= 0.6) return 60;
    return 0;
  }
  // The substring tier needs a length floor AND a word-boundary start.
  // Unguarded, a two-letter ask cleared bestTitleMatch's >=50 bar against
  // every title CONTAINING the letters — "where is et" answered with a
  // confident walk to The Social Network while E.T. the Extra-Terrestrial sat
  // stocked on a shelf — and even at three-plus letters, "mash" matched the
  // middle of "SapthaMASHree Thaskaraha". A substring is only evidence when
  // it starts where a word starts. (E.T. itself is reached through the
  // prefix tier: depunct turns the title into "et the extra terrestrial".)
  if (q.length >= 3) {
    let at = tn.indexOf(q);
    while (at >= 0) {
      if (at === 0 || !/[a-z0-9]/.test(tn[at - 1])) return 50;
      at = tn.indexOf(q, at + 1);
    }
  }
  return 0;
}

/**
 * The better of two candidate matches, with STOCK AS A TIE-BREAK ONLY.
 *
 * This exists because ordering the pools instead of scoring them is wrong, and
 * measurably so. Searching the shelves first and falling back to the catalogue
 * made an unstocked EXACT match lose to a stocked fuzzy one: wrong-film
 * wayfinding answers went from 4 in 400 to 52 in 400, offering "Sicko" to
 * someone asking for "Sick". A better textual match always wins; equal matches
 * go to the copy the shopper can actually pick up.
 */
export function betterMatch(a, b, text, stockedIds = null) {
  const q = norm(text).trim();
  const sa = a ? titleMatchScore(a, q) : 0;
  const sb = b ? titleMatchScore(b, q) : 0;
  if (sa !== sb) return sa > sb ? a : b;
  if (!a || !b) return a || b;
  const ka = stockedIds ? stockedIds.has(a.id) : false;
  const kb = stockedIds ? stockedIds.has(b.id) : false;
  return (kb && !ka) ? b : a;
}

/**
 * The title a shopper most likely means.
 *
 * TIES ARE BROKEN BY WHAT IS ON THE SHELF. Names repeat — there are several
 * films called The Spy, and Much Ado About Nothing has been made more than
 * once. Whichever the matcher happened to reach first used to win, which
 * produced both halves of the same bug: the clerk saying "we haven't got that
 * out" about a film sitting on a shelf, and saying "it's on the shelf" while
 * meaning a different film of the same name. Measured over 200 stocked titles,
 * 11 were wrongly denied.
 *
 * This is stock used as a TIE-BREAK, which is ranking. It cannot hide a title:
 * a better textual match still wins outright, and with no `stockedIds` the
 * behaviour is exactly what it was.
 *
 * @param {Set<string>} [stockedIds]
 */
export function bestTitleMatch(catalog, text, stockedIds = null) {
  const q = norm(text).trim();
  let best = null, bestScore = 0, bestStocked = false;
  for (const t of catalog) {
    const s = titleMatchScore(t, q);
    if (s === 0) continue;
    const st = stockedIds ? stockedIds.has(t.id) : false;
    // Strictly better score wins. An EQUAL score goes to the copy the shopper
    // could actually pick up.
    if (s > bestScore || (s === bestScore && st && !bestStocked)) {
      bestScore = s; best = t; bestStocked = st;
    }
  }
  return bestScore >= 50 ? best : null;
}

export function similarTo(catalog, seed, limit = 6) {
  const seedPersons = new Set(personsOf(seed).split(/\s+/));
  const scored = [];
  for (const t of catalog) {
    if (t.id === seed.id) continue;
    let s = 0;
    for (const gn of t.genres) if (seed.genres.includes(gn)) s += 3;
    if (t.type === seed.type) s += 1;
    if (Math.abs(t.year - seed.year) <= 8) s += 1.5;
    // Shared cast/crew only refines candidates that already share something
    // cheap — building person strings for all 89k records per query is not worth
    // the handful of extra matches it would surface.
    if (s >= 1) {
      let shared = 0;
      for (const p of personsOf(t).split(/\s+/)) if (p.length > 3 && seedPersons.has(p)) shared++;
      s += Math.min(shared, 4) * 1.2;
    }
    if (s >= 4) scored.push({ t, s });
  }
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, limit).map(e => e.t);
}

// ---------------------------------------------------------------------------
// Deterministic clerk — templated store-clerk responses, no API required.
// ---------------------------------------------------------------------------
const OPENERS = ['Solid choice of night for it.', 'Oh, I got you.', 'Say less.', 'Good call coming to the counter.', 'Let me think… yep.'];

export function clerkRespond(catalog, curation, rawQuery, session = { suggested: new Set(), n: 0 }, opts = {}) {
  const intent = parseQuery(rawQuery);
  const opener = OPENERS[session.n % OPENERS.length];
  session.n++;

  // Clerk honors the user's subscriptions: explicit "I can watch" requests, or
  // MY SERVICES mode, restrict the canonical candidate pool.
  const wantsWatchable = /\b(i can watch|can i watch|can watch tonight|on my services|my subscriptions|only things i can watch)\b/i.test(rawQuery);
  if (wantsWatchable && (!opts.myServices || opts.myServices.size === 0)) {
    return {
      // "which services you use", not "what you subscribe to": Tubi is free and
      // ad-supported, so asking only about subscriptions hides a service the
      // shopper already has. The word "services" is load-bearing —
      // tests/services.test.mjs asserts /services/i against this exact string.
      text: `Happy to! First tell me which services you use. Open ⚙ Settings → MY STREAMING SERVICES. Free ones count. Then I'll only pull things you can actually watch.`,
      picks: [], intent,
    };
  }
  const pool = ((opts.myServicesOnly || wantsWatchable) && opts.myServices?.size)
    ? filterByServices(catalog, opts.myServices)
    : catalog;
  if (pool !== catalog && pool.length === 0) {
    return { text: `None of your selected services carry a match right now. Want me to search the whole store instead?`, picks: [], intent };
  }
  // WAYFINDING IS PHYSICAL, AND THIS IS WHAT THAT ACTUALLY REQUIRES.
  //
  // This line used to read `const fullCatalog = catalog` with a comment
  // claiming wayfinding was never service-filtered. It was. The caller passes
  // `projection.eligible`, which in a single-service mode is the AVAILABILITY
  // -filtered set: measured, 14,205 of the 20,000 titles physically on the
  // shelves fell outside it, so the clerk answered "I don't think we carry
  // that one" about films sitting on its own shelves. That is availability
  // deciding what the shop admits it has, which is the one thing this project
  // forbids.
  //
  // `opts.storeTitles` is the shelved set. Searching it FIRST, then the
  // knowledge universe, is what makes the promise in the old comment true.
  // Two ORDERED lookups rather than one concatenated pool: the shelves are
  // ~20,000 titles and the knowledge universe is up to 122,948, and building a
  // merged array on every question would allocate the larger one each time.
  const storeTitles = opts.storeTitles ?? null;
  const fullCatalog = catalog;
  const poolNote = pool !== fullCatalog ? ' All of these are on your services.' : '';
  catalog = pool;

  // WHAT IS ACTUALLY ON A SHELF. Without this the clerk cannot tell the
  // difference between a film the shop has and a film the shop merely knows
  // about, and it defaults to the flattering answer.
  const stocked = opts.stockedIds ?? null;
  const onShelf = (t) => (stocked ? stocked.has(t.id) : true);

  const exclude = session.suggested;
  const finish = (lead, picks) => {
    const fresh = picks.filter(t => !exclude.has(t.id));
    const usable = fresh.length ? fresh : picks;
    // The clerk points at shelves. Something it can walk you to is a better
    // recommendation than something it can only describe, so stock ORDERS the
    // picks — it does not remove any, and if nothing is stocked the clerk
    // still answers rather than pretending it has nothing to say.
    const chosen = [...usable].sort((a, b) => (onShelf(b) ? 1 : 0) - (onShelf(a) ? 1 : 0)).slice(0, 3);
    chosen.forEach(t => exclude.add(t.id));
    const offShelf = chosen.filter((t) => !onShelf(t)).length;
    const note = offShelf === 0 ? ''
      : offShelf === chosen.length
        ? ` None of these are in the shop this week, but I can tell you about them.`
        : ` The last ${offShelf === 1 ? 'one is' : `${offShelf} are`} in the catalogue rather than on a shelf today.`;
    return { text: lead + note, picks: chosen, intent };
  };

  // "where is X" → wayfinding, and ONLY when there is somewhere to walk to.
  const whereM = norm(rawQuery).match(/where(?:'s| is| can i find)\s+(.+)$/);
  if (whereM) {
    const wanted = whereM[1].replace(/[?.!]/g, '');
    // BOTH POOLS ARE SEARCHED AND THE BETTER MATCH WINS. The shelves are
    // consulted because `catalog` here is availability-filtered and would
    // otherwise deny titles physically in the building; the catalogue is
    // consulted because the shop knows more than it stocks. Neither ordering
    // is allowed to beat a better textual match.
    const t = betterMatch(
      storeTitles ? bestTitleMatch(storeTitles, wanted, stocked) : null,
      bestTitleMatch(fullCatalog, wanted, stocked),
      wanted, stocked,
    );
    if (t && onShelf(t)) {
      return { text: `${t.title}? We've got it on the shelf and I'll walk you over.`, picks: [t], wayfind: true, intent };
    }
    if (t) {
      // WE KNOW IT, WE DO NOT HAVE IT OUT.
      //
      // The old answer promised a walk to a case that was not in the building.
      // The fix is not to refuse: goToTitle() can pull a title from back-stock
      // and shelve it, so the shopper still gets the film. What changes is
      // that the clerk stops claiming the copy is already there, and offers
      // what is genuinely on the floor alongside it. The requested title leads
      // the picks, so the answer is still about what was asked.
      const near = similarTo(fullCatalog, t, 12).filter(onShelf).slice(0, 2);
      exclude.add(t.id);
      near.forEach((x) => exclude.add(x.id));
      const lead = `${t.title} is one of ours, but we haven't got a copy out on the floor today. `
        + `I can fetch it from the back, though that takes a moment`;
      return {
        text: near.length ? `${lead}, or these are already on a shelf:` : `${lead}.`,
        picks: [t, ...near], intent,
      };
    }
    return { text: `Hmm, I don't think we carry that one. Want me to look up something similar?`, picks: [], intent };
  }

  if (intent.likeTitle) {
    const seed = bestTitleMatch(catalog, intent.likeTitle);
    if (seed) {
      return finish(`${opener} If ${seed.title} worked for you, these live in the same neighborhood:`, similarTo(catalog, seed, 8));
    }
  }

  if (intent.surprise) {
    const pool = [...(curation.hiddenGems || []), ...(curation.cultClassics || [])]
      .map(id => catalog.find(t => t.id === id)).filter(Boolean);
    const pick = pool[(session.n * 7) % Math.max(pool.length, 1)];
    if (pick) return finish(`${opener} Staff secret, people sleep on this one:`, [pick, ...pool.slice(0, 4)]);
  }

  const { results } = searchCatalog(catalog, rawQuery, 10, { stockedIds: stocked });
  if (results.length) {
    let lead = opener + ' ';
    if (intent.familySafe) lead += 'All of these are safe for the whole couch:';
    else if (intent.type === 'series') lead += 'Here’s what I’d binge:';
    else if (intent.maxRuntime) lead += `Nothing over ${intent.maxRuntime} minutes, promise:`;
    else lead += 'Here’s what I’d grab off the shelf:';
    return finish(lead + poolNote, results.map(r => r.title));
  }

  // fallback → staff picks (restricted to the active pool); if none of the
  // staff wall is watchable, pull straight from the watchable pool instead
  const staff = (curation.staffPicks || []).map(id => catalog.find(t => t.id === id)).filter(Boolean);
  const fallback = staff.length ? staff : catalog.slice(0, 8);
  const lead = staff.length
    ? `Couldn't quite place that request, but the staff wall never misses:`
    : `Here's what's on your services tonight:`;
  return finish(lead, fallback);
}
