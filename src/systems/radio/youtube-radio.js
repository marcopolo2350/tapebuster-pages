// YOUTUBE RADIO — one persistent player, built before anyone taps.
//
// THE ARCHITECTURE, AND WHY IT IS THIS SHAPE.
//
// A mobile browser grants playback permission to the CALL STACK of a real tap.
// The previous implementation could never satisfy that: between the tap and
// playVideo() sat a dynamic import, a script load from youtube.com, an oEmbed
// round-trip, a manifest read and a player construction. Seconds of async. The
// activation was spent long before anything asked to play, and no retry inside
// that chain gets it back.
//
// So the slow half happens at BOOT, with no gesture needed, because building a
// player and cueing a playlist is not playback:
//
//     page load -> API loads -> YT.Player created -> playlist cued -> idle
//                                                                      |
//     user taps ------------------------------------------------------+
//         -> loadPlaylist() + playVideo()   (synchronous, inside the tap)
//
// Everything reachable from a tap below is synchronous. There is no await, no
// import, no fetch, no oEmbed and no timer on that path, and there must never
// be one: the moment something is added, the gesture is gone and the radio
// goes silent on a phone while working perfectly on a desktop.
//
// YOUTUBE OWNS PLAYBACK. It selects tracks, advances the playlist, buffers and
// shuffles. We used to read the manifest and sequence it ourselves, which
// meant translating a YouTube playlist into a local model and back again at
// the worst possible moment. The player has a playlist engine; it is better
// than ours and it is already running.
//
// THE PLAYER IS A REAL PLAYER. Not 1x1, not display:none, not visibility
// hidden, not parked off the bottom of the viewport. Every one of those was
// tried and every one is a hidden player that iOS declines to start. It is a
// properly sized embed, inside the viewport, that the store's canvas is drawn
// over.
import { rng } from './theory.js';

/** Player states, by the numbers the API actually reports. */
export const STATE = { '-1': 'UNSTARTED', 0: 'ENDED', 1: 'PLAYING', 2: 'PAUSED', 3: 'BUFFERING', 5: 'CUED' };

// A dead video advances; these are the codes that mean "never going to work".
// 2 bad parameter · 5 HTML5 error · 100 gone or private · 101/150 embedding off
const FATAL = new Set([2, 100, 101, 150]);

const LOG_KEY = 'tb_radiolog';
const LOG_MAX = 60;

/**
 * The flight recorder. Kept because "no sound" is otherwise unanswerable: a
 * refused play emits no error at all, and none of it survives a reload. It
 * writes to storage and nowhere near the screen.
 */
export function radioLog(event, detail = {}) {
  try {
    const prev = JSON.parse(localStorage.getItem(LOG_KEY) ?? '[]');
    const next = Array.isArray(prev) ? prev : [];
    next.push({ t: +(performance.now() / 1000).toFixed(1), event, ...detail });
    while (next.length > LOG_MAX) next.shift();
    localStorage.setItem(LOG_KEY, JSON.stringify(next));
  } catch { /* diagnostics must never break playback */ }
}

/** Load the IFrame API once per page. Resolves when YT.Player is constructible. */
let apiPromise = null;
function loadApi() {
  if (window.YT && window.YT.Player) return Promise.resolve(true);
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 15000);
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { clearTimeout(timer); prev?.(); resolve(true); };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => { clearTimeout(timer); resolve(false); };
    document.head.appendChild(s);
  });
  return apiPromise;
}

export class YouTubeRadio {
  /** @param {{ onChange?: () => void }} opts */
  constructor({ onChange = null, volume = 0.65 } = {}) {
    this.player = null;
    this.ready = false;          // the player exists and reported onReady
    this.playing = false;
    this.blocked = false;        // asked to play, the browser declined
    this.trouble = null;         // why there is no music, in words
    this.stationId = null;
    this.playlistId = null;
    this.candidates = [];        // remaining playlists for this station
    // TAKEN FROM THE CALLER, NOT HARDCODED. This was a fixed 0.65 while the
    // shopper's setting lived in audio.radioVol, so after a reload the slider
    // showed one number and the player used another — and because
    // playStation() re-applies this.volume on every station change and track
    // skip, a volume the shopper had just set was overwritten by the stale
    // default the moment the next track started. That is what "the radio
    // volume doesn't work" was.
    this.volume = Math.max(0, Math.min(1, volume));
    this.lastState = null;
    this.onChange = onChange;
    this.rng = rng(0xB1B5 ^ (Date.now() / 864e5 | 0));
    this._blockTimer = null;
  }

  /**
   * THE SLOW HALF, DONE BEFORE ANY GESTURE EXISTS.
   *
   * Loads the API, builds the player and CUES (never loads) the opening
   * playlist so nothing plays. Safe to call during boot; it must not block
   * store entry, so the caller does not await it.
   */
  async prewarm({ playlistId = null, stationId = null } = {}) {
    if (this.player) return true;
    radioLog('prewarm', { station: stationId, list: playlistId });
    const ok = await loadApi();
    radioLog('api', { loaded: ok });
    if (!ok) { this.trouble = 'The radio could not reach YouTube.'; this.onChange?.(); return false; }
    this.stationId = stationId;
    this.playlistId = playlistId;
    return new Promise((resolve) => {
      const host = document.createElement('div');
      host.id = 'yt-radio-host';
      (document.getElementById('radio-embed') ?? document.body).appendChild(host);
      const done = setTimeout(() => resolve(false), 15000);
      this.player = new window.YT.Player('yt-radio-host', {
        width: 200,
        height: 200,
        playerVars: {
          // CUED, not loaded: cuePlaylist prepares without playing, which is
          // the whole point of prewarming. autoplay 0 for the same reason.
          listType: playlistId ? 'playlist' : undefined,
          list: playlistId || undefined,
          autoplay: 0,
          controls: 0,
          playsinline: 1,       // or iOS throws its fullscreen player over the store
          modestbranding: 1,
          rel: 0,
        },
        events: {
          onReady: () => {
            this.ready = true;
            clearTimeout(done);
            try { this.player.setVolume(Math.round(this.volume * 100)); } catch { /* set again on play */ }
            radioLog('ready', { list: this.playlistId });
            this.onChange?.();
            resolve(true);
          },
          onStateChange: (e) => this._onState(e),
          onError: (e) => this._onError(e),
        },
      });
    });
  }

  // ---------------------------------------------------------------- the tap
  //
  // EVERYTHING BELOW THIS LINE IS SYNCHRONOUS. No await, no import, no fetch,
  // no oEmbed, no timer. If any of those ever appear here, the gesture is
  // spent and the radio is silent on a phone.

  /** Play a station's playlist. Called directly from a click handler. */
  playStation(stationId, playlists) {
    this.stationId = stationId;
    this.candidates = playlists.slice(1);
    this.playlistId = playlists[0] ?? null;
    this.trouble = null;
    if (!this.player || !this.ready || !this.playlistId) {
      // Not an error: the player is still being built. Say so rather than
      // pretending playback started.
      this.trouble = 'Preparing radio…';
      radioLog('tap-early', { station: stationId, ready: this.ready });
      this.onChange?.();
      return false;
    }
    radioLog('tap', { station: stationId, list: this.playlistId });
    this.playing = true;
    try {
      // loadPlaylist starts playback; YouTube then owns ordering, advancement
      // and buffering for the whole list.
      this.player.loadPlaylist({ list: this.playlistId, listType: 'playlist', index: 0 });
      this.player.setShuffle(true);       // YouTube's own shuffle, not ours
      this.player.setVolume(Math.round(this.volume * 100));
      this.player.unMute();
      this.player.playVideo();
      radioLog('play-requested', { list: this.playlistId });
    } catch (err) {
      radioLog('play-threw', { message: String(err?.message ?? err) });
      this.trouble = 'The radio could not start.';
    }
    this._watchForBlock();
    this.onChange?.();
    return true;
  }

  /** Resume whatever is loaded. Synchronous; call it from a gesture. */
  play() {
    if (!this.player || !this.ready) return false;
    this.playing = true;
    try {
      this.player.setVolume(Math.round(this.volume * 100));
      this.player.unMute();
      this.player.playVideo();
      radioLog('play-requested', { list: this.playlistId });
    } catch { /* the state events report what happened */ }
    this._watchForBlock();
    return true;
  }

  pause() {
    this.playing = false;
    try { this.player?.pauseVideo?.(); } catch { /* fine */ }
    this.onChange?.();
  }

  next() {
    if (!this.player || !this.ready) return false;
    try { this.player.nextVideo(); radioLog('next', {}); } catch { return false; }
    return true;
  }

  previous() {
    if (!this.player || !this.ready) return false;
    try { this.player.previousVideo(); radioLog('previous', {}); } catch { return false; }
    return true;
  }

  /** Re-shuffle and jump, using YouTube's playlist engine rather than ours. */
  shuffle() {
    if (!this.player || !this.ready) return false;
    try {
      this.player.setShuffle(true);
      this.player.nextVideo();
      radioLog('shuffle', { list: this.playlistId });
    } catch { return false; }
    return true;
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    try { this.player?.setVolume?.(Math.round(this.volume * 100)); } catch { /* fine */ }
  }

  // ------------------------------------------------------------- reporting

  _onState(e) {
    const name = STATE[String(e.data)] ?? `state ${e.data}`;
    this.lastState = name;
    radioLog('state', { s: name });
    if (e.data === 1) {                       // PLAYING
      if (this.blocked) { this.blocked = false; radioLog('unblocked', {}); }
      this.trouble = null;
    }
    this.onChange?.();
  }

  _onError(e) {
    radioLog('error', { code: e.data, list: this.playlistId });
    if (!FATAL.has(e.data)) return;           // a single dead video: YouTube advances
    // The whole playlist is unusable. Fall to the next one this station has.
    const nextList = this.candidates.shift();
    if (nextList) {
      radioLog('failover', { from: this.playlistId, to: nextList });
      this.playlistId = nextList;
      try {
        this.player.loadPlaylist({ list: nextList, listType: 'playlist', index: 0 });
        this.player.playVideo();
      } catch { /* reported by the next error */ }
      return;
    }
    this.playing = false;
    this.trouble = 'Radio unavailable right now.';
    this.onChange?.();
  }

  /**
   * A refused play emits NO error: the state goes unstarted, buffering,
   * unstarted, and nothing throws. Without this the radio would sit there
   * looking fine and making no sound, which is exactly what it did.
   */
  _watchForBlock() {
    clearTimeout(this._blockTimer);
    this._blockTimer = setTimeout(() => {
      let st = -1;
      try { st = this.player?.getPlayerState?.() ?? -1; } catch { /* gone */ }
      const live = st === 1 || st === 3;
      const was = this.blocked;
      this.blocked = this.playing && !live;
      if (this.blocked && !this.trouble) this.trouble = 'Tap a station to start the music.';
      radioLog('playcheck', { state: STATE[String(st)] ?? st, blocked: this.blocked });
      if (this.blocked !== was) this.onChange?.();
    }, 2500);
  }

  /** What the UI shows. Titles come from the player when it has them. */
  state() {
    let title = null;
    try { title = this.player?.getVideoData?.()?.title ?? null; } catch { /* not ready */ }
    return {
      source: 'youtube',
      ready: this.ready,
      playing: this.playing && this.lastState === 'PLAYING',
      blocked: this.blocked,
      station: this.stationId,
      playlist: this.playlistId,
      nowPlaying: title,
      lastState: this.lastState,
      trouble: this.trouble,
    };
  }

  /**
   * Give the memory back. A paused embed still holds a whole browsing context
   * and a video decode pipeline, on the one device this project has spent its
   * whole effort keeping under the jetsam limit.
   */
  dispose() {
    clearTimeout(this._blockTimer);
    this.playing = false;
    this.blocked = false;
    this.ready = false;
    try { this.player?.stopVideo?.(); } catch { /* already gone */ }
    try { this.player?.destroy?.(); } catch { /* already gone */ }
    document.getElementById('yt-radio-host')?.remove();
    this.player = null;
    radioLog('dispose', {});
  }
}
