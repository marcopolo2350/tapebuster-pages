// PROVIDER-AGNOSTIC RADIO SOURCE CORE — the pure half of the YouTube upgrade.
//
// The directive's architecture:
//
//      RadioEngine (transport: queue/skip/previous/anti-repeat)
//          ↓ RadioTrack[]
//      RadioSource (built-in synth · YouTube playlist · future licensed)
//
// The certified BUILT-IN radio keeps its own engine untouched (its render-
// ahead queue is load-bearing certified behaviour). What lives here is the
// provider-agnostic layer every OTHER source shares: the generic track model,
// the sequencing policy (anti-repeat + skip-exclusion + availability), and
// the fallback decision. All pure functions — CI never touches YouTube, and
// the break-proofs can bend them without a browser.
//
// LEGAL NOTE (directive §23): a YouTube playlist is a technical content
// source, not a licence. Public/commercial deployments need appropriately
// licensed audio; nothing in this file or its consumers assumes otherwise.

/** @typedef {{ id:string, title:string|null, source:'youtube'|'builtin',
 *              sourceId:string, duration:number|null, position:number,
 *              available:boolean }} RadioTrack */

export const SOURCE_POLICY = {
  /** a played track cannot return within this many subsequent plays */
  repeatWindow: 8,
  /** ...but never exclude more than this, however large the station grows */
  repeatWindowMax: 200,
  /** a SKIPPED track is excluded for this many plays (skips express dislike) */
  skipWindow: 12,
  /** consecutive player/source errors before the radio falls back */
  fallbackAfterErrors: 5,
  /** ms to wait for the external player API before falling back */
  apiTimeoutMs: 12000,
};

/** Normalise one YouTube playlist entry to the generic track model. */
export function normalizeYouTubeItem(videoId, position, meta = {}) {
  return {
    id: `yt-${videoId}`,
    title: meta.title ?? null,          // resolved lazily via the official player
    source: 'youtube',
    sourceId: videoId,
    duration: meta.duration ?? null,
    position,
    available: meta.available !== false,
  };
}

/**
 * Pick the next track. Sequencing authority stays with US, not the playlist's
 * upload order: available tracks minus the anti-repeat window minus recently
 * skipped, chosen with seeded randomness. Falls back tier by tier when the
 * playlist is smaller than the windows — a two-track playlist alternates
 * rather than dying (directive §10: never silent, never corrupt).
 *
 * @param {RadioTrack[]} tracks
 * @param {string[]} history   played ids, most recent LAST
 * @param {string[]} skipped   skipped ids, most recent LAST
 * @param {() => number} rng
 * @returns {RadioTrack|null}
 */
export function pickNextTrack(tracks, history, skipped, rng = Math.random) {
  const avail = tracks.filter(t => t.available);
  if (!avail.length) return null;
  // THE WINDOW HAS TO SCALE WITH THE LIBRARY.
  //
  // A flat 8 was right when a station WAS one playlist of ~100 tracks. A
  // station now merges all of its playlists — BLOCKBUSTER THROWBACK is twelve
  // of them, around a thousand tracks — and "cannot return within 8 plays" is
  // no protection at all across a pool that size: it is barely a rounding
  // error. A quarter of the library, capped so the exclusion set stays cheap.
  //
  // Small playlists are UNCHANGED: for anything up to 32 tracks the floor of 8
  // still wins, and the length-1 clamp below still degrades a two-track
  // playlist to alternation rather than silence.
  const repeatN = Math.min(
    Math.max(SOURCE_POLICY.repeatWindow, Math.floor(avail.length * 0.25)),
    Math.max(0, avail.length - 1),
    SOURCE_POLICY.repeatWindowMax,
  );
  const recent = new Set(history.slice(-repeatN));
  const noSkip = new Set(skipped.slice(-SOURCE_POLICY.skipWindow));
  const current = history[history.length - 1];

  const tiers = [
    avail.filter(t => !recent.has(t.id) && !noSkip.has(t.id)),
    avail.filter(t => !recent.has(t.id)),
    avail.filter(t => t.id !== current),
    avail,
  ];
  for (const tier of tiers) {
    if (tier.length) return tier[Math.floor(rng() * tier.length) % tier.length];
  }
  return avail[0];
}

/** Record an external player error against a track; returns true when the
 *  track should be marked unavailable (dead videos advance, never break). */
export function isFatalPlayerError(code) {
  // official IFrame error codes: 2 invalid param, 5 HTML5 error,
  // 100 not found/private, 101/150 embedding disallowed
  return code === 2 || code === 100 || code === 101 || code === 150;
}

/**
 * The fallback decision (§16): the store must always have music, and a remote
 * dependency may never disable it. Pure so the threshold is testable.
 */
export function shouldFallback({ apiLoaded, manifestSize, consecutiveErrors }) {
  if (!apiLoaded) return 'player API unavailable';
  if (manifestSize === 0) return 'playlist empty or unreadable';
  if (consecutiveErrors >= SOURCE_POLICY.fallbackAfterErrors) return `${consecutiveErrors} consecutive player errors`;
  return null;
}
